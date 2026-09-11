/**
 * Session guard and peer classification for remote device access (FR-008..FR-017, SEC-003, SEC-013, SEC-014).
 *
 * Evaluated in `onRequest` between `checkHost` and `checkWrite`.
 *
 * Peer classification:
 * - Reads `request.socket.remoteAddress` and never headers (SEC-013).
 * - A loopback peer is admitted unconditionally on every route with no cookie (FR-010, NFR-001).
 * - A loopback peer carrying any Forwarded or X-Forwarded-* header is refused the bypass (SEC-014).
 *
 * Session validation:
 * - Cookie format: agent-flow-session=<deviceId>.<secret>; HttpOnly; SameSite=Strict; Path=/ (SEC-004, SEC-009).
 * - Plain HTTP: no Secure attribute (SEC-009).
 * - Constant-time secret comparison via core's `secretsEqual` (SEC-002).
 * - Device sessions are forbidden from machine-modifying routes (POST /api/v1/clean, PATCH /api/v1/config/editor) (FR-017, SEC-010).
 *
 * Purely synchronous: no await, no promise, runs synchronously with done() in the onRequest hook (NFR-010).
 */

import {
  DEFAULT_SESSION_IDLE_TTL_MS,
  isLoopbackHost,
  secretsEqual,
  sessionVerdict,
} from '../core/device-session.js';
import type { DeviceSessionStore, DeviceSession } from '../app/device-sessions.js';
import type { Clock } from '../ports/index.js';
import type { GuardOutcome } from './request-guard.js';

export const SESSION_COOKIE_NAME = 'agent-flow-session';

const ALLOWED: GuardOutcome = { ok: true };

function refuse(status: number, error: string, message: string, action: string): GuardOutcome {
  return { ok: false, refusal: { status, error, message, action } };
}

/**
 * Parses the agent-flow-session cookie from the Cookie header.
 *
 * Format: agent-flow-session=<deviceId>.<secret>
 */
export function parseSessionCookie(
  cookieHeader: string | undefined,
): { readonly deviceId: string; readonly secret: string } | undefined {
  if (cookieHeader === undefined) return undefined;

  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${SESSION_COOKIE_NAME}=`)) {
      const value = trimmed.slice(SESSION_COOKIE_NAME.length + 1);
      const dot = value.indexOf('.');
      if (dot <= 0) return undefined;
      const deviceId = value.slice(0, dot);
      const secret = value.slice(dot + 1);
      if (deviceId.length === 0 || secret.length === 0) return undefined;
      return { deviceId, secret };
    }
  }

  return undefined;
}

/**
 * Serializes the session Set-Cookie header.
 *
 * agent-flow-session=<deviceId>.<secret>; HttpOnly; SameSite=Strict; Path=/
 * Plain HTTP transport: no Secure flag (SEC-009).
 */
export function serializeSessionCookie(deviceId: string, secret: string): string {
  return `${SESSION_COOKIE_NAME}=${deviceId}.${secret}; HttpOnly; SameSite=Strict; Path=/`;
}

/**
 * Detects presence of proxy forwarding headers.
 *
 * Used to refuse the loopback bypass for forwarded requests (SEC-014).
 */
export function hasForwardedHeaders(headers: Record<string, unknown>): boolean {
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'forwarded' || lower.startsWith('x-forwarded-')) {
      return true;
    }
  }
  return false;
}

/**
 * Classifies whether the peer is a trusted local loopback connection (FR-010, SEC-013, SEC-014).
 *
 * Evaluated strictly from `request.socket.remoteAddress` and never from request headers (SEC-013).
 * Refused if any Forwarded or X-Forwarded-* header is present (SEC-014).
 */
export function isPeerLoopback(
  remoteAddress: string | undefined,
  headers: Record<string, unknown>,
): boolean {
  if (remoteAddress === undefined) return false;
  if (hasForwardedHeaders(headers)) return false;
  return isLoopbackHost(remoteAddress);
}

/**
 * Determines whether a route is exempt from session authentication when remote access is active.
 *
 * - Non-API routes (static bundle and SPA shell fallback) are served to allow loading the pairing UI (FR-009).
 * - POST /api/v1/pair is exempt so an unpaired device can present a pairing code (FR-008).
 * - All other /api/v1/* routes require an authenticated session.
 */
export function isSessionExempt(method: string, url: string): boolean {
  const path = url.split('?')[0] ?? url;
  if (!path.startsWith('/api/')) return true;
  if (method.toUpperCase() === 'POST' && path === '/api/v1/pair') return true;
  return false;
}

export interface SessionRequestLike {
  readonly socket?: { readonly remoteAddress?: string };
  readonly raw?: { readonly socket?: { readonly remoteAddress?: string } };
  readonly headers: Record<string, unknown>;
  readonly method: string;
  readonly url: string;
  deviceSession?: DeviceSession;
}

/**
 * Evaluates session authentication and authorization in Fastify's onRequest hook (FR-008..FR-017).
 *
 * Synchronous throughout: no await, no promise.
 */
export function checkSession(
  request: SessionRequestLike,
  store: DeviceSessionStore,
  clock?: Clock,
): GuardOutcome {
  const remoteAddress = request.socket?.remoteAddress ?? request.raw?.socket?.remoteAddress;

  // Loopback peer bypass (FR-010, NFR-001): no session lookup and no cookie parsing
  if (isPeerLoopback(remoteAddress, request.headers)) {
    return ALLOWED;
  }

  // Exempt routes (FR-008, FR-009)
  if (isSessionExempt(request.method, request.url)) {
    return ALLOWED;
  }

  // Remote peer requires active session
  const cookieHeader = typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined;
  const sessionToken = parseSessionCookie(cookieHeader);
  if (sessionToken === undefined) {
    return refuse(
      401,
      'session_required',
      'This server requires an active device session for remote access.',
      'Pair this device using the code printed in the server terminal.',
    );
  }

  const session = store.getSession(sessionToken.deviceId);
  if (!session) {
    return refuse(
      401,
      'session_invalid',
      'This device session is no longer active.',
      'Pair this device again using the code printed in the server terminal.',
    );
  }

  if (!secretsEqual(sessionToken.secret, session.secret)) {
    return refuse(
      401,
      'session_invalid',
      'This device session is not valid.',
      'Pair this device again using the code printed in the server terminal.',
    );
  }

  const now = clock ? Date.parse(clock.now()) : Date.now();
  const verdict = sessionVerdict({
    session,
    now,
    idleTtlMs: DEFAULT_SESSION_IDLE_TTL_MS,
  });

  if (verdict !== 'live') {
    return refuse(
      401,
      'session_expired',
      'This device session has expired from inactivity.',
      'Pair this device again using the code printed in the server terminal.',
    );
  }

  // Live session: update lastSeenAt
  store.touchSession(session.deviceId, now);

  // Machine-wide modification restriction (FR-017, SEC-010)
  const method = request.method.toUpperCase();
  const path = request.url.split('?')[0] ?? request.url;
  if (
    (method === 'POST' && (path === '/api/v1/clean' || path.startsWith('/api/v1/clean/'))) ||
    (method === 'PATCH' && (path === '/api/v1/config/editor' || path.startsWith('/api/v1/config/editor/')))
  ) {
    return refuse(
      403,
      'device_session_restricted',
      'Device sessions are not permitted to change machine-level configuration or state.',
      'Perform this action directly from the local machine.',
    );
  }

  // Expose session on request for downstream handlers (e.g. SSE stream registration)
  request.deviceSession = session;

  return ALLOWED;
}
