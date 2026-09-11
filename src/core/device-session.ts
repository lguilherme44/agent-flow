/**
 * Pure folds for device pairing and remote session access (FR-004..FR-018, SEC-006).
 *
 * **Pure by construction.** No Node built-in, no clock, no filesystem, no randomness,
 * and no crypto module. Every fact — including `now`, the candidate string, and the
 * outstanding pairing state — arrives as an argument.
 *
 * This purity is what keeps pairing testable across its entire truth table in the fast
 * test lane without spawning a process or mocking a global clock.
 */

export const MAX_PAIRING_CODE_FAILURES = 10;
export const DEFAULT_SESSION_IDLE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days (FR-025)

export type PairingCodeVerdict = 'ok' | 'unknown' | 'expired' | 'used' | 'burned';

export interface OutstandingPairingCode {
  readonly code: string;
  readonly expiresAt: number;
  readonly usedBy?: string;
  readonly failures?: number;
}

export interface PairingCodeVerdictInput {
  readonly presented: string;
  readonly outstanding?: OutstandingPairingCode | null;
  readonly now: number;
}

/**
 * Evaluates whether a presented pairing code grants a new session (FR-004, FR-006, FR-007).
 *
 * Order of evaluation is deliberate and defends against timing leaks and probe enumeration:
 * 1. An absent outstanding code means no code has been issued or it was already cleared: 'unknown'.
 * 2. An outstanding code whose failure count reached the threshold is burned permanently for
 *    the life of the process (FR-007, SEC-012). It rejects further attempts as 'burned'.
 * 3. Secret comparison runs in constant time over character codes. Mismatched code yields 'unknown'
 *    without revealing whether a code was issued or has expired.
 * 4. A matching code that was already claimed by a device cannot be re-used (FR-004): 'used'.
 * 5. A matching code whose lifetime elapsed (`now >= expiresAt`) is rejected as 'expired'.
 * 6. Only a matching, unclaimed, unexpired code on an unburned slot answers 'ok'.
 */
export function pairingCodeVerdict(input: PairingCodeVerdictInput): PairingCodeVerdict {
  const { presented, outstanding, now } = input;

  if (!outstanding) {
    return 'unknown';
  }

  if ((outstanding.failures ?? 0) >= MAX_PAIRING_CODE_FAILURES) {
    return 'burned';
  }

  if (!secretsEqual(presented, outstanding.code)) {
    return 'unknown';
  }

  if (outstanding.usedBy !== undefined) {
    return 'used';
  }

  if (now >= outstanding.expiresAt) {
    return 'expired';
  }

  return 'ok';
}

export type SessionVerdict = 'live' | 'idle_expired';

export interface SessionVerdictInput {
  readonly session: { readonly lastSeenAt: number };
  readonly now: number;
  readonly idleTtlMs: number;
}

/**
 * Checks whether an existing device session is still active or has expired from inactivity (FR-025).
 *
 * A session whose last request is older than `idleTtlMs` (default 14 days) is refused 401
 * and excluded from session listings.
 */
export function sessionVerdict(input: SessionVerdictInput): SessionVerdict {
  if (input.now - input.session.lastSeenAt >= input.idleTtlMs) {
    return 'idle_expired';
  }
  return 'live';
}

/**
 * Constant-time string equality over character codes, independent of length (SEC-002).
 *
 * Pure: avoids importing `node:crypto` into `src/core`, adhering to core purity rules
 * (test/architecture.test.ts:150-168).
 *
 * Operates over `max(a.length, b.length)` iterations. Length differences are accumulated
 * in the bitwise diff accumulator rather than short-circuiting, preventing timing attacks
 * that deduce secret length from comparison duration.
 */
export function secretsEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;

  for (let i = 0; i < maxLen; i++) {
    const charA = i < a.length ? a.charCodeAt(i) : 0;
    const charB = i < b.length ? b.charCodeAt(i) : 0;
    diff |= charA ^ charB;
  }

  return diff === 0;
}

export interface AdmitsHostInput {
  readonly hostname: string;
  readonly boundAddresses?: readonly string[];
  readonly allowedHosts?: readonly string[];
}

/**
 * Extracts and normalizes the host authority portion, stripping brackets and port if present.
 * Returns undefined for malformed or empty authorities.
 */
export function extractHostname(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;

  // Bracketed IPv6 literal: [::1] or [::1]:4782
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    if (close < 0) return undefined;
    const inner = trimmed.slice(1, close);
    const rest = trimmed.slice(close + 1);
    if (rest !== '' && !/^:\d{1,5}$/.test(rest)) return undefined;
    return inner.length === 0 ? undefined : inner.toLowerCase();
  }

  const colon = trimmed.indexOf(':');
  if (colon < 0) return trimmed.toLowerCase();

  // Bare IPv6 with colons but no brackets is not a legal Host header
  if (trimmed.indexOf(':', colon + 1) >= 0) return undefined;
  if (!/^\d{1,5}$/.test(trimmed.slice(colon + 1))) return undefined;

  const host = trimmed.slice(0, colon);
  return host.length === 0 ? undefined : host.toLowerCase();
}

/**
 * Determines whether a hostname is an IP address literal rather than a domain name.
 *
 * An address literal asks no DNS question and therefore cannot be rebound to a third-party IP.
 */
export function isAddressLiteral(hostname: string): boolean {
  // IPv4 dotted quad. Strict check: octets must be 0-255.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return hostname.split('.').every((part) => Number(part) <= 255);
  }

  // IPv6: strip zone identifier if present
  const withoutZone = hostname.split('%')[0] ?? '';
  if (!withoutZone.includes(':')) return false;

  // IPv4-mapped IPv6 literal (e.g. ::ffff:127.0.0.1)
  const tail = withoutZone.slice(withoutZone.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    return (
      /^[0-9a-f:]*:$/i.test(withoutZone.slice(0, withoutZone.lastIndexOf(':') + 1)) &&
      isAddressLiteral(tail)
    );
  }

  return /^[0-9a-f:]+$/i.test(withoutZone);
}

/**
 * Whether a hostname points to loopback.
 */
export function isLoopbackHost(hostname: string): boolean {
  const extracted = extractHostname(hostname) ?? hostname;
  const lower = extracted.toLowerCase();
  if (lower === 'localhost') return true;
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  if (/^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(lower)) return true;
  if (lower.startsWith('::ffff:127.')) {
    const tail = lower.slice('::ffff:'.length);
    return isAddressLiteral(tail) && /^127\./.test(tail);
  }
  return false;
}

/**
 * Evaluates whether a Host header or hostname is admitted under the current host policy (FR-018, SEC-006).
 *
 * Written as a separable pure fold:
 * - When `boundAddresses` is absent (remote access off), preserves today's rule byte-for-byte:
 *   any IP literal, `localhost`, or declared `allowedHosts` is admitted.
 * - When `boundAddresses` is present (remote access on), narrows the rule for reachability:
 *   only loopback, the server's actual bound interface addresses, or declared `allowedHosts`
 *   are admitted. Any other address literal is refused.
 */
export function admitsHost(input: AdmitsHostInput): boolean {
  const host = extractHostname(input.hostname);
  if (host === undefined) return false;

  // Declared allowedHosts are always admitted (e.g. reverse proxy names)
  if (input.allowedHosts?.some((allowed) => allowed.toLowerCase() === host)) {
    return true;
  }

  // When boundAddresses is absent, today's rebinding rule admits all address literals
  if (input.boundAddresses === undefined) {
    if (isAddressLiteral(host)) return true;
    if (host === 'localhost') return true;
    return false;
  }

  // Remote access on: narrow to loopback or the actual bound addresses
  if (isLoopbackHost(host)) return true;
  return input.boundAddresses.some((addr) => {
    const normalized = extractHostname(addr) ?? addr.toLowerCase();
    return normalized === host;
  });
}
