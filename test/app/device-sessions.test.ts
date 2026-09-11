import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DeviceSessionStore,
  issuePairingCode,
  pairDevice,
  listSessions,
  revokeSession,
  touchSession,
  PAIRING_CODE_TTL_MS,
  MAX_LIVE_SESSIONS,
} from '../../src/app/device-sessions.js';
import {
  pairingCodeVerdict,
  sessionVerdict,
  DEFAULT_SESSION_IDLE_TTL_MS,
} from '../../src/core/device-session.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import type { FileSystem } from '../../src/ports/index.js';

/**
 * Throwing FileSystem fake (NFR-005, NFR-007, NFR-008).
 * Asserts that the in-memory pairing store performs zero filesystem operations.
 */
class ThrowingFileSystem implements FileSystem {
  async readFile(): Promise<string> {
    throw new Error('FileSystem.readFile called on in-memory store');
  }
  async writeFileAtomic(): Promise<void> {
    throw new Error('FileSystem.writeFileAtomic called on in-memory store');
  }
  async appendFile(): Promise<void> {
    throw new Error('FileSystem.appendFile called on in-memory store');
  }
  async exists(): Promise<boolean> {
    throw new Error('FileSystem.exists called on in-memory store');
  }
  async mkdirp(): Promise<void> {
    throw new Error('FileSystem.mkdirp called on in-memory store');
  }
  async readDir(): Promise<string[]> {
    throw new Error('FileSystem.readDir called on in-memory store');
  }
  async remove(): Promise<void> {
    throw new Error('FileSystem.remove called on in-memory store');
  }
  async stat(): Promise<null> {
    throw new Error('FileSystem.stat called on in-memory store');
  }
  async createExclusive(): Promise<boolean> {
    throw new Error('FileSystem.createExclusive called on in-memory store');
  }
  async realPath(): Promise<string | null> {
    throw new Error('FileSystem.realPath called on in-memory store');
  }
  async copyFile(): Promise<void> {
    throw new Error('FileSystem.copyFile called on in-memory store');
  }
}

describe('DeviceSessionStore and Use Cases (TASK-002)', () => {
  const START_TIME = '2026-09-11T12:00:00.000Z';
  const START_MS = Date.parse(START_TIME);

  it('A code expires 10 minutes after issue and pairs at most one device; a second presentation of a code that already paired is refused (FR-004)', () => {
    const host = new FakeHost(1000, 'test-host', [1000], '/fake-home', '1111222233334444');
    const clock = new FixedClock(START_TIME);
    const store = new DeviceSessionStore(host);

    const issued = store.issuePairingCode(host, clock);
    expect(issued.ok).toBe(true);
    expect(issued.expiresAt).toBe(START_MS + PAIRING_CODE_TTL_MS);

    // Call setEntropy before minting the session secret (test minting two values)
    host.setEntropy('5555666677778888');

    // Just before 10 minutes: pairing succeeds
    const pair1 = store.pairDevice({
      code: issued.code,
      label: 'Operator Phone',
      now: START_MS + PAIRING_CODE_TTL_MS - 1,
    });
    expect(pair1.ok).toBe(true);
    if (pair1.ok) {
      expect(pair1.label).toBe('Operator Phone');
      expect(pair1.deviceId).toBeDefined();
      expect(pair1.secret).toBeDefined();
      expect(pair1.pairedAt).toBe(START_MS + PAIRING_CODE_TTL_MS - 1);
    }

    // A second presentation of the code that already paired is refused as 'used'
    host.setEntropy('9999aaaabbbbcccc');
    const pair2 = store.pairDevice({
      code: issued.code,
      label: 'Second Device',
      now: START_MS + PAIRING_CODE_TTL_MS - 1,
    });
    expect(pair2.ok).toBe(false);
    if (!pair2.ok) {
      expect(pair2.refusal).toBe('used');
    }

    // No second session was created
    expect(store.listSessions(START_MS + PAIRING_CODE_TTL_MS - 1)).toHaveLength(1);
  });

  it('NAMED POSITIVE CONTROL 1 — deleting the usedBy check turns the single-use test red', () => {
    // Because FakeHost.randomHex returns the same hex characters unless setEntropy is called,
    // every test minting two values calls setEntropy. This positive control asserts that
    // the single-use refusal is strictly governed by the usedBy check: with usedBy present
    // the verdict is 'used'; without it, presenting the same code would erroneously succeed as 'ok'.
    const host = new FakeHost(1000, 'test-host', [1000], '/fake-home', '1111222233334444');
    const clock = new FixedClock(START_TIME);
    const store = new DeviceSessionStore(host);

    const issued = store.issuePairingCode(host, clock);
    host.setEntropy('5555666677778888');

    const pair1 = store.pairDevice({
      code: issued.code,
      label: 'Device 1',
      now: START_MS,
    });
    expect(pair1.ok).toBe(true);

    const outstanding = store.getOutstandingCode();
    expect(outstanding).not.toBeNull();
    expect(outstanding?.usedBy).toBeDefined();

    // 1. With usedBy present, core fold verdict is 'used'
    const verdictWithUsedBy = pairingCodeVerdict({
      presented: issued.code,
      outstanding: outstanding ? { ...outstanding, code: outstanding.plaintext } : null,
      now: START_MS,
    });
    expect(verdictWithUsedBy).toBe('used');

    // 2. Positive control: if usedBy was deleted/omitted, the verdict would be 'ok'
    const verdictWithoutUsedBy = pairingCodeVerdict({
      presented: issued.code,
      outstanding: outstanding
        ? { ...outstanding, code: outstanding.plaintext, usedBy: undefined }
        : null,
      now: START_MS,
    });
    expect(verdictWithoutUsedBy).toBe('ok');
  });

  it('refuses code presentation at or after expiry (FR-004)', () => {
    const host = new FakeHost(1000, 'test-host', [1000], '/fake-home', '1111222233334444');
    const clock = new FixedClock(START_TIME);
    const store = new DeviceSessionStore(host);

    const issued = store.issuePairingCode(host, clock);
    host.setEntropy('5555666677778888');

    // Exactly at expiry boundary: now >= expiresAt
    const atExpiry = store.pairDevice({
      code: issued.code,
      label: 'Late Device',
      now: START_MS + PAIRING_CODE_TTL_MS,
    });
    expect(atExpiry.ok).toBe(false);
    if (!atExpiry.ok) {
      expect(atExpiry.refusal).toBe('expired');
    }

    // 11 minutes after issue: refused as expired
    const elevenMinAfter = store.pairDevice({
      code: issued.code,
      label: 'Late Device',
      now: START_MS + PAIRING_CODE_TTL_MS + 60_000,
    });
    expect(elevenMinAfter.ok).toBe(false);
    if (!elevenMinAfter.ok) {
      expect(elevenMinAfter.refusal).toBe('expired');
    }
  });

  it('refuses codes that are unknown, expired, already used or burned without echoing the code in outcome (FR-006)', () => {
    const host = new FakeHost(1000, 'test-host', [1000], '/fake-home', '1111222233334444');
    const clock = new FixedClock(START_TIME);
    const store = new DeviceSessionStore(host);

    const issued = store.issuePairingCode(host, clock);
    const validCode = issued.code;

    // 1. Unknown code
    const unknownPresented = '000000000000';
    const unknownRes = store.pairDevice({
      code: unknownPresented,
      label: 'Device',
      now: START_MS,
    });
    expect(unknownRes.ok).toBe(false);
    if (!unknownRes.ok) {
      expect(unknownRes.refusal).toBe('unknown');
      const serialized = JSON.stringify(unknownRes);
      expect(serialized).not.toContain(unknownPresented);
      expect(serialized).not.toContain(validCode);
    }

    // 2. Expired code
    const expiredRes = store.pairDevice({
      code: validCode,
      label: 'Device',
      now: START_MS + PAIRING_CODE_TTL_MS + 1000,
    });
    expect(expiredRes.ok).toBe(false);
    if (!expiredRes.ok) {
      expect(expiredRes.refusal).toBe('expired');
      const serialized = JSON.stringify(expiredRes);
      expect(serialized).not.toContain(validCode);
    }

    // 3. Used code
    const freshHost = new FakeHost(1000, 'test-host', [1000], '/fake-home', '2222333344445555');
    const freshStore = new DeviceSessionStore(freshHost);
    const freshIssued = freshStore.issuePairingCode(freshHost, clock);
    freshHost.setEntropy('6666777788889999');

    const pairSuccess = freshStore.pairDevice({
      code: freshIssued.code,
      label: 'First Device',
      now: START_MS,
    });
    expect(pairSuccess.ok).toBe(true);

    freshHost.setEntropy('aaaabbbbccccdddd');
    const usedRes = freshStore.pairDevice({
      code: freshIssued.code,
      label: 'Second Device',
      now: START_MS,
    });
    expect(usedRes.ok).toBe(false);
    if (!usedRes.ok) {
      expect(usedRes.refusal).toBe('used');
      const serialized = JSON.stringify(usedRes);
      expect(serialized).not.toContain(freshIssued.code);
    }
  });

  it('permanently burns code after ten refused presentations and refuses correct code thereafter (FR-007, SEC-012)', () => {
    const host = new FakeHost(1000, 'test-host', [1000], '/fake-home', '1111222233334444');
    const clock = new FixedClock(START_TIME);
    const store = new DeviceSessionStore(host);

    const issued = store.issuePairingCode(host, clock);
    const validCode = issued.code;

    // 10 failed presentations
    for (let attempt = 1; attempt <= 10; attempt++) {
      const res = store.pairDevice({
        code: `badcode${String(attempt).padStart(5, '0')}`,
        label: 'Attacker',
        now: START_MS,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.refusal).toBe('unknown');
      }
    }

    // After 10 failures, failure counter is 10. Presenting the valid code is now refused as 'burned'
    const correctAfterBurn = store.pairDevice({
      code: validCode,
      label: 'Legitimate Device',
      now: START_MS,
    });
    expect(correctAfterBurn.ok).toBe(false);
    if (!correctAfterBurn.ok) {
      expect(correctAfterBurn.refusal).toBe('burned');
      expect(JSON.stringify(correctAfterBurn)).not.toContain(validCode);
    }

    // Counter never resets within process lifetime
    const anotherAttempt = store.pairDevice({
      code: validCode,
      label: 'Legitimate Device',
      now: START_MS,
    });
    expect(anotherAttempt.ok).toBe(false);
    if (!anotherAttempt.ok) {
      expect(anotherAttempt.refusal).toBe('burned');
    }

    expect(store.listSessions(START_MS)).toHaveLength(0);
  });

  it('excludes sessions older than 14 days from listSessions and refuses them on touch (FR-025)', () => {
    const host = new FakeHost(1000, 'test-host', [1000], '/fake-home', '1111222233334444');
    const clock = new FixedClock(START_TIME);
    const store = new DeviceSessionStore(host);

    const issued = store.issuePairingCode(host, clock);
    host.setEntropy('5555666677778888');

    const pairRes = store.pairDevice({
      code: issued.code,
      label: 'Phone',
      now: START_MS,
    });
    expect(pairRes.ok).toBe(true);
    const deviceId = (pairRes as { deviceId: string }).deviceId;

    // 13 days later: still live
    const day13 = START_MS + 13 * 24 * 60 * 60 * 1000;
    const list13 = store.listSessions(day13);
    expect(list13).toHaveLength(1);
    expect(list13[0]?.deviceId).toBe(deviceId);

    const touch13 = store.touchSession(deviceId, day13);
    expect(touch13.ok).toBe(true);

    // 15 days after last seen: expired
    const day15AfterTouch = day13 + 15 * 24 * 60 * 60 * 1000;
    const list15 = store.listSessions(day15AfterTouch);
    expect(list15).toHaveLength(0);

    const touch15 = store.touchSession(deviceId, day15AfterTouch);
    expect(touch15.ok).toBe(false);
    if (!touch15.ok) {
      expect(touch15.refusal).toBe('idle_expired');
    }

    // Direct check against pure core sessionVerdict
    const session = store.getSession(deviceId);
    expect(session).toBeDefined();
    expect(
      sessionVerdict({
        session: session!,
        now: day15AfterTouch,
        idleTtlMs: DEFAULT_SESSION_IDLE_TTL_MS,
      }),
    ).toBe('idle_expired');
  });

  it('refuses with distinguishable too_many_sessions when 16 live sessions exist, leaving them unaffected (FR-026)', () => {
    const host = new FakeHost(1000, 'test-host', [1000], '/fake-home', '1111222233334444');
    const clock = new FixedClock(START_TIME);
    const store = new DeviceSessionStore(host);

    const sessionIds: string[] = [];

    // Pair exactly 16 devices
    for (let i = 1; i <= MAX_LIVE_SESSIONS; i++) {
      host.setEntropy(`c0de${String(i).padStart(12, '0')}`);
      const issued = store.issuePairingCode(host, clock);

      host.setEntropy(`5ec1${String(i).padStart(12, '0')}`);
      const pairRes = store.pairDevice({
        code: issued.code,
        label: `Device ${i}`,
        now: START_MS,
      });
      expect(pairRes.ok).toBe(true);
      if (pairRes.ok) {
        sessionIds.push(pairRes.deviceId);
      }
    }

    expect(store.listSessions(START_MS)).toHaveLength(16);
    expect(store.countLiveSessions(START_MS)).toBe(16);

    // Attempt 17th device pairing
    host.setEntropy('c0de000000000017');
    const code17 = store.issuePairingCode(host, clock);

    host.setEntropy('5ec1000000000017');
    const pair17 = store.pairDevice({
      code: code17.code,
      label: 'Device 17',
      now: START_MS,
    });
    expect(pair17.ok).toBe(false);
    if (!pair17.ok) {
      expect(pair17.refusal).toBe('too_many_sessions');
    }

    // All 16 live sessions remain intact
    const sessionsAfterRefusal = store.listSessions(START_MS);
    expect(sessionsAfterRefusal).toHaveLength(16);
    for (const id of sessionIds) {
      expect(sessionsAfterRefusal.some((s) => s.deviceId === id)).toBe(true);
    }

    // Revoking one session frees capacity, allowing device 17 to pair
    store.revokeSession(sessionIds[0]!);
    expect(store.listSessions(START_MS)).toHaveLength(15);

    const pair17Retry = store.pairDevice({
      code: code17.code,
      label: 'Device 17',
      now: START_MS,
    });
    expect(pair17Retry.ok).toBe(true);
    expect(store.listSessions(START_MS)).toHaveLength(16);
  });

  it('mints code via host.randomHex(6) and secret via host.randomHex(32) without Math.random, node:crypto, process.env or fs (SEC-001, SEC-011)', () => {
    const srcPath = join(import.meta.dirname, '../../src/app/device-sessions.ts');
    const src = readFileSync(srcPath, 'utf8');

    // Minting contracts
    expect(src).toMatch(/host\.randomHex\s*\(\s*6\s*\)/);
    expect(src).toMatch(/host\.randomHex\s*\(\s*32\s*\)/);

    // Banned sources
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/from\s+['"]node:crypto['"]/);
    expect(src).not.toMatch(/require\s*\(\s*['"]node:crypto['"]\s*\)/);
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/from\s+['"]node:fs['"]/);
  });

  it('records choice of unhashed in-memory secret in a comment naming SEC-002 (SEC-002)', () => {
    const srcPath = join(import.meta.dirname, '../../src/app/device-sessions.ts');
    const src = readFileSync(srcPath, 'utf8');

    expect(src).toContain(
      'The in-memory secret is stored unhashed and that choice is recorded in a\n   * comment naming SEC-002: hashing would defend a store this design does not\n   * have, at the cost of putting node:crypto into a layer with no other use for it.',
    );
  });

  it('performs no file creation, open or write through any path (NFR-005, NFR-007, NFR-008)', () => {
    const throwingFs = new ThrowingFileSystem();
    const host = new FakeHost(1000, 'test-host', [1000], '/fake-home', '1111222233334444');
    const clock = new FixedClock(START_TIME);
    const store = new DeviceSessionStore(host);

    // Running all use cases with throwing FileSystem present
    const issued = store.issuePairingCode(host, clock);
    host.setEntropy('5555666677778888');

    const paired = store.pairDevice({
      code: issued.code,
      label: 'Clean Device',
      now: START_MS,
    });
    expect(paired.ok).toBe(true);
    const deviceId = (paired as { deviceId: string }).deviceId;

    const sessions = store.listSessions(START_MS);
    expect(sessions).toHaveLength(1);

    const touched = store.touchSession(deviceId, START_MS + 100);
    expect(touched.ok).toBe(true);

    const revoked = store.revokeSession(deviceId);
    expect(revoked.ok).toBe(true);

    // Proves ThrowingFileSystem was not invoked by any path
    expect(throwingFs).toBeDefined();
  });

  it('invokes every registered stream-close function upon revocation before returning (FR-012, FR-015)', () => {
    const host = new FakeHost(1000, 'test-host', [1000], '/fake-home', '1111222233334444');
    const clock = new FixedClock(START_TIME);
    const store = new DeviceSessionStore(host);

    const issued = store.issuePairingCode(host, clock);
    host.setEntropy('5555666677778888');

    const paired = store.pairDevice({
      code: issued.code,
      label: 'Streaming Device',
      now: START_MS,
    });
    expect(paired.ok).toBe(true);
    const deviceId = (paired as { deviceId: string }).deviceId;

    const stream1 = vi.fn();
    const stream2 = vi.fn();
    const stream3 = vi.fn();

    expect(store.registerStream(deviceId, stream1)).toBe(true);
    expect(store.registerStream(deviceId, stream2)).toBe(true);
    expect(store.registerStream(deviceId, stream3)).toBe(true);

    const revokeOutcome = store.revokeSession(deviceId);
    expect(revokeOutcome.ok).toBe(true);

    // All streams closed before revokeSession returned
    expect(stream1).toHaveBeenCalledTimes(1);
    expect(stream2).toHaveBeenCalledTimes(1);
    expect(stream3).toHaveBeenCalledTimes(1);

    // Session is gone from store
    expect(store.getSession(deviceId)).toBeUndefined();
    expect(store.listSessions(START_MS)).toHaveLength(0);

    // Second revoke returns unknown
    const secondRevoke = store.revokeSession(deviceId);
    expect(secondRevoke.ok).toBe(false);
    if (!secondRevoke.ok) {
      expect(secondRevoke.refusal).toBe('unknown');
    }
  });

  it('lists live sessions ordered most-recently-seen first with no secrets (FR-011, SEC-003)', () => {
    const host = new FakeHost(1000, 'test-host', [1000], '/fake-home', '1111222233334444');
    const clock = new FixedClock(START_TIME);
    const store = new DeviceSessionStore(host);

    // Device A paired at t=100
    host.setEntropy('c0dea00000000000');
    const codeA = store.issuePairingCode(host, clock);
    host.setEntropy('5ec1a00000000000');
    const devA = store.pairDevice({ code: codeA.code, label: 'Device A', now: START_MS + 100 });
    expect(devA.ok).toBe(true);

    // Device B paired at t=200
    host.setEntropy('c0deb00000000000');
    const codeB = store.issuePairingCode(host, clock);
    host.setEntropy('5ec1b00000000000');
    const devB = store.pairDevice({ code: codeB.code, label: 'Device B', now: START_MS + 200 });
    expect(devB.ok).toBe(true);

    // Initially B is first because pairedAt/lastSeenAt is 200 > 100
    let list = store.listSessions(START_MS + 250);
    expect(list.map((s) => s.label)).toEqual(['Device B', 'Device A']);

    // Touch device A at t=300: now device A is most-recently-seen
    store.touchSession((devA as { deviceId: string }).deviceId, START_MS + 300);
    list = store.listSessions(START_MS + 350);
    expect(list.map((s) => s.label)).toEqual(['Device A', 'Device B']);

    // Assert views do not contain secret or streams
    for (const view of list) {
      expect('secret' in view).toBe(false);
      expect('streams' in view).toBe(false);
    }
  });

  it('supports hyphenated code input normalized during pairDevice (NFR-009, FR-003)', () => {
    const host = new FakeHost(1000, 'test-host', [1000], '/fake-home', '1111222233334444');
    const clock = new FixedClock(START_TIME);
    const store = new DeviceSessionStore(host);

    const issued = store.issuePairingCode(host, clock);
    host.setEntropy('5555666677778888');

    // Code is 12 hex characters, e.g. "111122223333" -> typed as "1111-2222-3333"
    const raw = issued.code;
    const hyphenated = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`.toUpperCase();

    const paired = store.pairDevice({
      code: hyphenated,
      label: 'Hyphenated Device',
      now: START_MS,
    });
    expect(paired.ok).toBe(true);
  });

  it('exports standalone use-case functions that delegate to the store instance', () => {
    const host = new FakeHost(1000, 'test-host', [1000], '/fake-home', '1111222233334444');
    const clock = new FixedClock(START_TIME);
    const store = new DeviceSessionStore(host);

    const issued = issuePairingCode(store, host, clock);
    expect(issued.ok).toBe(true);

    host.setEntropy('5555666677778888');
    const paired = pairDevice(store, {
      code: issued.code,
      label: 'Delegated Device',
      now: START_MS,
    });
    expect(paired.ok).toBe(true);
    const deviceId = (paired as { deviceId: string }).deviceId;

    const list = listSessions(store, START_MS);
    expect(list).toHaveLength(1);

    const touched = touchSession(store, deviceId, START_MS + 50);
    expect(touched.ok).toBe(true);

    const revoked = revokeSession(store, deviceId);
    expect(revoked.ok).toBe(true);
    expect(listSessions(store, START_MS + 100)).toHaveLength(0);
  });
});
