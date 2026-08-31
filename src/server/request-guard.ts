/**
 * Who is allowed to talk to the local control plane (§93, PRI-05).
 *
 * The dashboard binds to loopback and has no authentication, and for a long time the
 * argument for that was "only this machine can reach it". That argument is wrong in one
 * specific way: **the operator's own browser is on this machine**, and every page it has
 * open can issue requests to `127.0.0.1`. Measured against the server before this module
 * existed, from a foreign origin:
 *
 * ```
 * POST /api/v1/runs/:id/start   (no body)  →  202  {"status":"running"}
 * ```
 *
 * `start` spawns coding agents with write permission inside the operator's repository.
 * A bodyless `POST` is a CORS *simple request*: no preflight is sent, the browser
 * delivers it, and only the response is withheld from the attacker. Withholding the
 * response does not undo the run.
 *
 * Two vectors, closed by two independent guards, because each one is blind to the other:
 *
 *  1. **Cross-origin write.** Closed by {@link checkWrite}: a write must either carry an
 *     `Origin` equal to this server's own, or carry a header a cross-origin simple
 *     request cannot set without triggering a preflight this server never answers.
 *
 *  2. **DNS rebinding.** A hostile domain whose DNS answer flips to `127.0.0.1` becomes
 *     *same-origin* to the browser — which removes the first guard from the picture
 *     entirely, and opens every read endpoint as well. Closed by {@link checkHost}.
 *
 * Pure functions over header values. No Fastify, no sockets, no config loading — so the
 * decision table can be tested exhaustively without binding a port.
 */

/** A refusal, in the shape the rest of the API already answers errors in (§95). */
export interface GuardRefusal {
  readonly status: number;
  readonly error: string;
  readonly message: string;
  readonly action: string;
}

export type GuardOutcome = { readonly ok: true } | { readonly ok: false; readonly refusal: GuardRefusal };

const ALLOWED: GuardOutcome = { ok: true };

/**
 * The header that stands in for `Origin` when there is no browser.
 *
 * Deliberately a *custom* header, because that is the whole mechanism: a cross-origin
 * `fetch` that sets one stops being a simple request and earns a preflight, and this
 * server answers no preflight. A page cannot set it and reach a handler; `curl` sets it
 * with one flag.
 */
export const CLIENT_HEADER = 'x-agent-flow-client';

/**
 * Hostnames that are not DNS names, plus the one DNS name that cannot be pointed
 * elsewhere by an attacker's zone.
 *
 * `localhost` is special-cased rather than treated as an ordinary name: it is resolved to
 * loopback by the operating system on every platform Agent Flow supports, and browsers
 * treat it as a trustworthy origin. A name an attacker controls resolves wherever they
 * say, which is the entire rebinding attack.
 */
const LOOPBACK_NAMES = new Set(['localhost']);

/**
 * The hostname out of a `Host` header, without its port.
 *
 * `[::1]:4782` is the case that makes this more than a `split(':')`: an IPv6 literal
 * carries colons of its own and is bracketed precisely so the port stays unambiguous.
 * Returns `undefined` for anything that is not a well-formed authority, and an
 * unparseable `Host` is refused rather than guessed at.
 */
export function hostnameOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;

  const value = header.trim();
  if (value === '') return undefined;

  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close < 0) return undefined;
    const inner = value.slice(1, close);
    const rest = value.slice(close + 1);
    if (rest !== '' && !/^:\d{1,5}$/.test(rest)) return undefined;
    return inner.length === 0 ? undefined : inner.toLowerCase();
  }

  const colon = value.indexOf(':');
  if (colon < 0) return value.toLowerCase();

  // A bare IPv6 literal with no brackets is not a legal `Host`, and treating the
  // text before its first colon as a hostname would read `::1` as the empty string.
  if (value.indexOf(':', colon + 1) >= 0) return undefined;
  if (!/^\d{1,5}$/.test(value.slice(colon + 1))) return undefined;

  const host = value.slice(0, colon);
  return host.length === 0 ? undefined : host.toLowerCase();
}

/**
 * Whether a hostname is a literal address rather than a name.
 *
 * This is the load-bearing distinction for rebinding, and it is worth stating plainly:
 * **an attacker cannot rebind an IP literal.** Rebinding works by giving two different
 * answers to the same DNS question; a literal asks no DNS question. So a `Host` that is
 * an address is safe whatever the address is, and a `Host` that is a name is only safe
 * if the operator said so.
 */
export function isAddressLiteral(hostname: string): boolean {
  // IPv4 dotted quad. Deliberately strict: `127.1` is a valid address to `connect(2)`
  // and would be a name-shaped hole here.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return hostname.split('.').every((part) => Number(part) <= 255);
  }

  // IPv6. The zone id comes off first: `fe80::1%25eth0` is a legal authority and the
  // `%25` is a percent-encoded `%`, neither of which makes it a name.
  const withoutZone = hostname.split('%')[0] ?? '';
  if (!withoutZone.includes(':')) return false;

  // Hex groups and colons, optionally ending in a dotted quad — the IPv4-mapped form
  // `::ffff:127.0.0.1`, which reaches loopback and would otherwise be read as a name and
  // refused. Refusing it fails closed, which is safe and still wrong: it locks out a
  // client that addressed this server correctly.
  const tail = withoutZone.slice(withoutZone.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    return (
      /^[0-9a-f:]*:$/i.test(withoutZone.slice(0, withoutZone.lastIndexOf(':') + 1)) &&
      isAddressLiteral(tail)
    );
  }

  return /^[0-9a-f:]+$/i.test(withoutZone);
}

export interface HostPolicy {
  /**
   * Extra hostnames the operator declared, for the reverse-proxy case.
   *
   * Empty by default and only ever grown deliberately: the entire value of this guard is
   * that a name nobody named is refused.
   */
  readonly allowedHosts?: readonly string[];
}

/**
 * Every request, read or write.
 *
 * Applied to reads as well because rebinding does not need a write to be worth doing:
 * `GET /api/v1/projects` returns the absolute path of every repository on the machine,
 * and the artifact endpoints return plans, SDDs and diffs.
 */
export function checkHost(header: string | undefined, policy: HostPolicy = {}): GuardOutcome {
  const hostname = hostnameOf(header);

  if (hostname === undefined) {
    return refuse(
      400,
      'invalid_host',
      'This request carries no usable Host header.',
      'Reach the dashboard at the address the server printed when it started.',
    );
  }

  if (isAddressLiteral(hostname)) return ALLOWED;
  if (LOOPBACK_NAMES.has(hostname)) return ALLOWED;
  if ((policy.allowedHosts ?? []).some((allowed) => allowed.toLowerCase() === hostname)) {
    return ALLOWED;
  }

  return refuse(
    403,
    'host_not_allowed',
    `This server does not answer to the host name "${hostname}".`,
    'Use the address the server printed, or add the name to ui.allowedHosts if you put a proxy in front of it.',
  );
}

export interface WritePolicy extends HostPolicy {
  /**
   * The request's own `Host`, already validated by {@link checkHost}.
   *
   * Passing it rather than the bound address is the point: after the host guard has run,
   * the request's `Host` *is* this server's identity for that request, and a same-origin
   * check against it is exactly right whether the operator typed `localhost`, `127.0.0.1`
   * or the machine's LAN address.
   */
  readonly host: string | undefined;
}

/**
 * Writes only: `POST`, `PUT`, `PATCH`, `DELETE`.
 *
 * Reads are left to {@link checkHost} alone, and that is a considered position rather
 * than an omission. A cross-origin read is already useless to a page — the browser
 * withholds the response body for want of `Access-Control-Allow-Origin`, and this server
 * sends none — so the only read worth defending against is the rebound one, which the
 * host guard catches. Adding an origin check to reads would break nothing and prove
 * nothing.
 */
export function checkWrite(
  headers: { readonly origin?: string; readonly client?: string },
  policy: WritePolicy,
): GuardOutcome {
  const origin = headers.origin?.trim();

  if (origin !== undefined && origin !== '' && origin.toLowerCase() !== 'null') {
    return matchesHost(origin, policy.host)
      ? ALLOWED
      : refuse(
          403,
          'origin_not_allowed',
          `A page at ${origin} tried to change this run.`,
          'Only the dashboard this server serves may write. Nothing was changed.',
        );
  }

  // No `Origin`. Every current browser sends one on a cross-origin write, so this is
  // almost always a script or a terminal — but "almost always" is not a security
  // argument, and the header below is one: a cross-origin request that sets it is no
  // longer simple, earns a preflight, and this server answers none.
  if (headers.client !== undefined && headers.client.trim() !== '') return ALLOWED;

  return refuse(
    403,
    'origin_missing',
    'This write carries neither an Origin this server serves nor a client header.',
    `Send ${CLIENT_HEADER}: 1 if you are calling the API directly. Nothing was changed.`,
  );
}

/**
 * Whether an `Origin` names the same authority as the request's `Host`.
 *
 * Both schemes are accepted because the authority is what carries the security here, and
 * an operator who put TLS termination in front of the dashboard has not thereby made a
 * foreign page trustworthy. The scheme is checked at all only to refuse the exotic ones —
 * `file://` and extension schemes serialise as an origin and are not this dashboard.
 */
function matchesHost(origin: string, host: string | undefined): boolean {
  if (host === undefined) return false;

  const normalised = host.trim().toLowerCase();
  const value = origin.toLowerCase();

  return value === `http://${normalised}` || value === `https://${normalised}`;
}

function refuse(status: number, error: string, message: string, action: string): GuardOutcome {
  return { ok: false, refusal: { status, error, message, action } };
}

/** The methods {@link checkWrite} applies to. */
export function isWriteMethod(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === 'POST' || upper === 'PUT' || upper === 'PATCH' || upper === 'DELETE';
}
