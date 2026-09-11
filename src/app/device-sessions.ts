/**
 * In-memory pairing store and use cases for remote device access (AMENDMENT 1, FR-004..FR-026).
 *
 * **In-memory by construction (AMENDMENT 1).** Holds exactly two pieces of mutable state:
 * - The outstanding `PairingCode` ({plaintext, expiresAt, usedBy?, failures})
 * - A `Map<deviceId, DeviceSession>` where a session is {deviceId, label, secret, pairedAt, lastSeenAt, streams}
 *
 * Nothing is written to disk: no append-only event log entry, no file under `.agent-flow/`
 * or `~/.agent-flow/`, no configuration key, no keychain. With no persisted records, there is
 * no log reader, no fold over persisted files, no `serializeStateWrite`, and no burn-counter
 * file (NFR-005, NFR-007, NFR-008 withdrawn by construction).
 *
 * Constructed once by `buildServer` and dies with the process (FR-024).
 *
 * Five use cases returning outcome values rather than throwing:
 * 1. `issuePairingCode(host, clock)` — mints single-use 12-char code via `host.randomHex(6)`
 * 2. `pairDevice({code, label, now})` — validates presentation, mints secret via `host.randomHex(32)`
 * 3. `listSessions(now)` — lists live sessions, most-recently-seen first, omitting secret
 * 4. `revokeSession(deviceId)` — closes open event streams and deletes session
 * 5. `touchSession(deviceId, now)` — updates lastSeenAt for active, unexpired session
 *
 * All policy verdicts delegate to `src/core/device-session.ts` pure folds.
 */

import type { DeviceSessionView } from '../contracts/index.js';
import type { Clock, Host } from '../ports/index.js';
import {
  DEFAULT_SESSION_IDLE_TTL_MS,
  pairingCodeVerdict,
  sessionVerdict,
  type PairingCodeVerdict,
} from '../core/device-session.js';

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes (FR-004)
export const MAX_LIVE_SESSIONS = 16; // 16 live sessions limit (FR-026)
export const PAIRING_CODE_BYTES = 6; // 12 hex characters (SEC-001)
export const SESSION_SECRET_BYTES = 32; // 64 hex characters (SEC-001)
export const DEVICE_ID_BYTES = 8; // 16 hex characters

/** Outstanding pairing code state in memory. */
export interface PairingCode {
  readonly plaintext: string;
  readonly expiresAt: number;
  usedBy?: string;
  failures: number;
}

/** In-memory device session. */
export interface DeviceSession {
  readonly deviceId: string;
  readonly label: string;
  /**
   * The in-memory secret is stored unhashed and that choice is recorded in a
   * comment naming SEC-002: hashing would defend a store this design does not
   * have, at the cost of putting node:crypto into a layer with no other use for it.
   */
  readonly secret: string;
  readonly pairedAt: number;
  lastSeenAt: number;
  readonly streams: Set<() => void>;
}

export interface IssuePairingCodeOutcome {
  readonly ok: true;
  readonly code: string;
  readonly expiresAt: number;
}

export interface PairDeviceInput {
  readonly code: string;
  readonly label: string;
  readonly now: number;
  readonly deviceId?: string;
  readonly host?: Host;
}

export type PairDeviceRefusal = PairingCodeVerdict | 'too_many_sessions';

export interface PairDeviceSuccess {
  readonly ok: true;
  readonly deviceId: string;
  readonly label: string;
  readonly secret: string;
  readonly pairedAt: number;
  readonly session: DeviceSession;
}

export interface PairDeviceFailure {
  readonly ok: false;
  readonly refusal: PairDeviceRefusal;
}

export type PairDeviceOutcome = PairDeviceSuccess | PairDeviceFailure;

export interface RevokeSessionSuccess {
  readonly ok: true;
  readonly deviceId: string;
  readonly label: string;
  readonly session: {
    readonly deviceId: string;
    readonly label: string;
  };
}

export interface RevokeSessionFailure {
  readonly ok: false;
  readonly refusal: 'unknown';
}

export type RevokeSessionOutcome = RevokeSessionSuccess | RevokeSessionFailure;

export interface TouchSessionSuccess {
  readonly ok: true;
  readonly session: DeviceSession;
}

export interface TouchSessionFailure {
  readonly ok: false;
  readonly refusal: 'unknown' | 'idle_expired';
}

export type TouchSessionOutcome = TouchSessionSuccess | TouchSessionFailure;

/**
 * In-memory pairing store holding two mutable pieces of state:
 * - `outstanding`: outstanding pairing code
 * - `sessions`: map of active device sessions
 */
export class DeviceSessionStore {
  private outstanding: PairingCode | null = null;
  private readonly sessions: Map<string, DeviceSession> = new Map();
  private host?: Host;

  constructor(host?: Host) {
    this.host = host;
  }

  /**
   * Issues a fresh pairing code valid for 10 minutes (FR-004, SEC-001, SEC-011).
   *
   * The code is minted strictly via `host.randomHex(6)` through the Host port.
   */
  issuePairingCode(host?: Host, clock?: Clock): IssuePairingCodeOutcome {
    const effectiveHost = host ?? this.host;
    if (!effectiveHost) {
      throw new Error('Host port is required to issue pairing code');
    }
    this.host = effectiveHost;

    const plaintext = effectiveHost.randomHex(6).toLowerCase();
    const nowMs = clock ? Date.parse(clock.now()) : Date.now();
    const expiresAt = nowMs + PAIRING_CODE_TTL_MS;

    this.outstanding = {
      plaintext,
      expiresAt,
      failures: 0,
    };

    return {
      ok: true,
      code: plaintext,
      expiresAt,
    };
  }

  /**
   * Evaluates a pairing presentation and mints a session if valid (FR-004, FR-006, FR-007, FR-026).
   *
   * Synchronous throughout: single-use enforcement is atomic by construction because
   * Node's event loop executes `pairDevice` synchronously with no window between
   * checking `usedBy` and writing it.
   */
  pairDevice(input: PairDeviceInput): PairDeviceOutcome {
    const normalized = input.code.trim().replace(/-/g, '').toLowerCase();

    const verdict = pairingCodeVerdict({
      presented: normalized,
      outstanding: this.outstanding
        ? {
            code: this.outstanding.plaintext,
            expiresAt: this.outstanding.expiresAt,
            usedBy: this.outstanding.usedBy,
            failures: this.outstanding.failures,
          }
        : null,
      now: input.now,
    });

    if (verdict !== 'ok') {
      if (this.outstanding) {
        this.outstanding.failures = (this.outstanding.failures ?? 0) + 1;
      }
      return { ok: false, refusal: verdict };
    }

    // Check capacity: max 16 live sessions (FR-026)
    let liveCount = 0;
    for (const s of this.sessions.values()) {
      if (sessionVerdict({ session: s, now: input.now, idleTtlMs: DEFAULT_SESSION_IDLE_TTL_MS }) === 'live') {
        liveCount++;
      }
    }
    if (liveCount >= MAX_LIVE_SESSIONS) {
      return { ok: false, refusal: 'too_many_sessions' };
    }

    const effectiveHost = input.host ?? this.host;
    if (!effectiveHost) {
      throw new Error('Host port is required to mint device session secret');
    }

    const deviceId = input.deviceId ?? effectiveHost.randomHex(8).toLowerCase();
    const secret = effectiveHost.randomHex(32).toLowerCase();

    // Atomically claim single-use slot before returning
    this.outstanding!.usedBy = deviceId;

    // SEC-002: The in-memory secret is stored unhashed. Hashing would defend a store
    // this design does not have, at the cost of putting node:crypto into a layer with
    // no other use for it.
    const session: DeviceSession = {
      deviceId,
      label: input.label,
      secret,
      pairedAt: input.now,
      lastSeenAt: input.now,
      streams: new Set<() => void>(),
    };

    this.sessions.set(deviceId, session);

    return {
      ok: true,
      deviceId,
      label: input.label,
      secret,
      pairedAt: input.now,
      session,
    };
  }

  /**
   * Lists live sessions, most-recently-seen first (FR-011, FR-025).
   *
   * Sessions whose last request is older than 14 days are excluded.
   * No secret or hash of a secret appears in the view (SEC-003).
   */
  listSessions(now: number): readonly DeviceSessionView[] {
    const live: DeviceSessionView[] = [];
    for (const session of this.sessions.values()) {
      if (sessionVerdict({ session, now, idleTtlMs: DEFAULT_SESSION_IDLE_TTL_MS }) === 'live') {
        live.push({
          deviceId: session.deviceId,
          label: session.label,
          pairedAt: session.pairedAt,
          lastSeenAt: session.lastSeenAt,
        });
      }
    }
    live.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    return live;
  }

  /**
   * Revokes a session and terminates any attached event streams before returning (FR-012, FR-015).
   */
  revokeSession(deviceId: string): RevokeSessionOutcome {
    const session = this.sessions.get(deviceId);
    if (!session) {
      return { ok: false, refusal: 'unknown' };
    }

    for (const close of session.streams) {
      try {
        close();
      } catch {
        // Guard against stream closure callback errors
      }
    }
    session.streams.clear();
    this.sessions.delete(deviceId);

    return {
      ok: true,
      deviceId: session.deviceId,
      label: session.label,
      session: {
        deviceId: session.deviceId,
        label: session.label,
      },
    };
  }

  /**
   * Touches an active session, updating its lastSeenAt timestamp if still live (FR-025).
   */
  touchSession(deviceId: string, now: number): TouchSessionOutcome {
    const session = this.sessions.get(deviceId);
    if (!session) {
      return { ok: false, refusal: 'unknown' };
    }

    const verdict = sessionVerdict({
      session,
      now,
      idleTtlMs: DEFAULT_SESSION_IDLE_TTL_MS,
    });

    if (verdict !== 'live') {
      return { ok: false, refusal: 'idle_expired' };
    }

    session.lastSeenAt = now;
    return { ok: true, session };
  }

  /** Gets session by device id if present. */
  getSession(deviceId: string): DeviceSession | undefined {
    return this.sessions.get(deviceId);
  }

  /** Reads outstanding pairing code details if any has been issued. */
  getOutstandingCode(): PairingCode | null {
    return this.outstanding ? { ...this.outstanding } : null;
  }

  /** Registers an active SSE or stream closer callback under the session (FR-015). */
  registerStream(deviceId: string, close: () => void): boolean {
    const session = this.sessions.get(deviceId);
    if (!session) return false;
    session.streams.add(close);
    return true;
  }

  /** Unregisters an active stream closer callback. */
  unregisterStream(deviceId: string, close: () => void): boolean {
    const session = this.sessions.get(deviceId);
    if (!session) return false;
    return session.streams.delete(close);
  }

  /** Counts currently active live sessions (FR-023). */
  countLiveSessions(now: number): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (sessionVerdict({ session, now, idleTtlMs: DEFAULT_SESSION_IDLE_TTL_MS }) === 'live') {
        count++;
      }
    }
    return count;
  }
}

export { DeviceSessionStore as DeviceSessions };

// Standalone use-case functions delegating to store instance
export function issuePairingCode(
  store: DeviceSessionStore,
  host: Host,
  clock: Clock,
): IssuePairingCodeOutcome {
  return store.issuePairingCode(host, clock);
}

export function pairDevice(
  store: DeviceSessionStore,
  input: PairDeviceInput,
): PairDeviceOutcome {
  return store.pairDevice(input);
}

export function listSessions(
  store: DeviceSessionStore,
  now: number,
): readonly DeviceSessionView[] {
  return store.listSessions(now);
}

export function revokeSession(
  store: DeviceSessionStore,
  deviceId: string,
): RevokeSessionOutcome {
  return store.revokeSession(deviceId);
}

export function touchSession(
  store: DeviceSessionStore,
  deviceId: string,
  now: number,
): TouchSessionOutcome {
  return store.touchSession(deviceId, now);
}
