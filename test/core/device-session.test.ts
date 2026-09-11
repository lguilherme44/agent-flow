import { describe, it, expect } from 'vitest';
import {
  pairingCodeVerdict,
  sessionVerdict,
  secretsEqual,
  admitsHost,
  isAddressLiteral,
  isLoopbackHost,
  MAX_PAIRING_CODE_FAILURES,
  DEFAULT_SESSION_IDLE_TTL_MS,
  type PairingCodeVerdict,
  type OutstandingPairingCode,
} from '../../src/core/device-session.js';
import { checkHost } from '../../src/server/request-guard.js';

describe('pairingCodeVerdict', () => {
  const code = 'abcd1234efgh';
  const expiresAt = 1000;
  const nowBefore = 500;
  const nowAfter = 1500;

  type CodeCondition = 'unknown' | 'expired' | 'used' | 'burned' | 'ok';

  function makeOutstanding(condition: CodeCondition): OutstandingPairingCode | undefined {
    switch (condition) {
      case 'unknown':
        return { code, expiresAt, failures: 0 };
      case 'expired':
        // A code whose expiresAt is in the past relative to both nowBefore and nowAfter
        return { code, expiresAt: 200, failures: 0 };
      case 'used':
        return { code, expiresAt, usedBy: 'dev-001', failures: 0 };
      case 'burned':
        return { code, expiresAt, failures: MAX_PAIRING_CODE_FAILURES };
      case 'ok':
        return { code, expiresAt, failures: 0 };
    }
  }

  function presentedFor(condition: CodeCondition): string {
    return condition === 'unknown' ? 'wrongcode999' : code;
  }

  // Cross-product of {unknown, expired, used, burned, ok} × {now before expiresAt, now after expiresAt}
  const testMatrix: {
    condition: CodeCondition;
    timing: 'before' | 'after';
    now: number;
    expected: PairingCodeVerdict;
  }[] = [
    { condition: 'unknown', timing: 'before', now: nowBefore, expected: 'unknown' },
    { condition: 'unknown', timing: 'after', now: nowAfter, expected: 'unknown' },
    { condition: 'expired', timing: 'before', now: nowBefore, expected: 'expired' },
    { condition: 'expired', timing: 'after', now: nowAfter, expected: 'expired' },
    { condition: 'used', timing: 'before', now: nowBefore, expected: 'used' },
    { condition: 'used', timing: 'after', now: nowAfter, expected: 'used' },
    { condition: 'burned', timing: 'before', now: nowBefore, expected: 'burned' },
    { condition: 'burned', timing: 'after', now: nowAfter, expected: 'burned' },
    { condition: 'ok', timing: 'before', now: nowBefore, expected: 'ok' },
    { condition: 'ok', timing: 'after', now: nowAfter, expected: 'expired' },
  ];

  it.each(testMatrix)(
    'returns $expected for condition=$condition when now is $timing expiresAt',
    ({ condition, now, expected }) => {
      const outstanding = makeOutstanding(condition);
      const presented = presentedFor(condition);
      const verdict = pairingCodeVerdict({ presented, outstanding, now });

      expect(verdict).toBe(expected);
      // Asserts verdict is strictly one of the 5 allowed union members
      expect(['ok', 'unknown', 'expired', 'used', 'burned']).toContain(verdict);
    },
  );

  it('returns unknown when no outstanding pairing code exists', () => {
    expect(pairingCodeVerdict({ presented: code, outstanding: undefined, now: nowBefore })).toBe('unknown');
    expect(pairingCodeVerdict({ presented: code, outstanding: null, now: nowBefore })).toBe('unknown');
  });

  it('treats now equal to expiresAt as expired (boundary condition)', () => {
    const outstanding = { code, expiresAt: 1000, failures: 0 };
    expect(pairingCodeVerdict({ presented: code, outstanding, now: 1000 })).toBe('expired');
  });

  it('positive control: single-use enforcement', () => {
    const usedOutstanding: OutstandingPairingCode = { code, expiresAt, usedBy: 'dev-1', failures: 0 };
    // With usedBy present, verdict must be 'used'
    expect(pairingCodeVerdict({ presented: code, outstanding: usedOutstanding, now: nowBefore })).toBe('used');
    // Without usedBy, verdict would be 'ok'
    const cleanOutstanding = { ...usedOutstanding, usedBy: undefined };
    expect(pairingCodeVerdict({ presented: code, outstanding: cleanOutstanding, now: nowBefore })).toBe('ok');
  });

  it('positive control: burn threshold enforcement', () => {
    const burned = { code, expiresAt, failures: 10 };
    expect(pairingCodeVerdict({ presented: code, outstanding: burned, now: nowBefore })).toBe('burned');
    const nineFailures = { code, expiresAt, failures: 9 };
    expect(pairingCodeVerdict({ presented: code, outstanding: nineFailures, now: nowBefore })).toBe('ok');
  });
});

describe('sessionVerdict', () => {
  const idleTtlMs = DEFAULT_SESSION_IDLE_TTL_MS;

  it('returns live when the session was seen recently', () => {
    const session = { lastSeenAt: 1000 };
    const now = 1000 + idleTtlMs - 1;
    expect(sessionVerdict({ session, now, idleTtlMs })).toBe('live');
  });

  it('returns idle_expired when lastSeenAt exceeds the idle TTL', () => {
    const session = { lastSeenAt: 1000 };
    const now = 1000 + idleTtlMs + 1;
    expect(sessionVerdict({ session, now, idleTtlMs })).toBe('idle_expired');
  });

  it('returns idle_expired at exact TTL boundary', () => {
    const session = { lastSeenAt: 1000 };
    const now = 1000 + idleTtlMs;
    expect(sessionVerdict({ session, now, idleTtlMs })).toBe('idle_expired');
  });
});

describe('secretsEqual', () => {
  it('returns true for identical strings', () => {
    expect(secretsEqual('abcdef', 'abcdef')).toBe(true);
    expect(secretsEqual('', '')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(secretsEqual('abcdef', 'abcdeg')).toBe(false);
    expect(secretsEqual('123456', '654321')).toBe(false);
  });

  it('returns false for strings of different length without short-circuiting', () => {
    expect(secretsEqual('abcdef', 'abcde')).toBe(false);
    expect(secretsEqual('abc', 'abcdef')).toBe(false);
    expect(secretsEqual('', 'a')).toBe(false);
    expect(secretsEqual('a', '')).toBe(false);
  });
});

describe('admitsHost', () => {
  // Every case from test/server/request-guard.test.ts:179-214
  const existingCases: {
    header: string;
    policy?: { allowedHosts?: string[] };
    description: string;
  }[] = [
    { header: '127.0.0.1:4782', description: 'IPv4 loopback literal with port' },
    { header: '[::1]:4782', description: 'IPv6 loopback literal with port' },
    { header: '192.168.1.9:4782', description: 'LAN IP literal with port' },
    { header: '10.0.0.4', description: 'Private IP literal without port' },
    { header: 'localhost:4782', description: 'localhost with port' },
    { header: 'evil.example:4782', description: 'undeclared name' },
    { header: 'flow.internal:4782', policy: { allowedHosts: ['flow.internal'] }, description: 'declared name' },
    { header: 'FLOW.INTERNAL:4782', policy: { allowedHosts: ['flow.internal'] }, description: 'declared name uppercase' },
    { header: 'flow.internal.evil.example:4782', policy: { allowedHosts: ['flow.internal'] }, description: 'subdomain suffix lookalike' },
    { header: 'evil.example:4782', policy: { allowedHosts: ['flow.internal'] }, description: 'unrelated domain with policy' },
  ];

  it('asserts absent-boundAddresses results are byte-identical to checkHost table', () => {
    for (const { header, policy } of existingCases) {
      const legacyOutcome = checkHost(header, policy).ok;
      const admitsHostOutcome = admitsHost({
        hostname: header,
        allowedHosts: policy?.allowedHosts,
        boundAddresses: undefined,
      });

      expect(admitsHostOutcome, `admitsHost mismatch for header "${header}"`).toBe(legacyOutcome);
    }
  });

  it('refuses unparseable or empty host headers', () => {
    for (const header of ['', '[::1:4782']) {
      expect(admitsHost({ hostname: header })).toBe(false);
    }
  });

  describe('with boundAddresses (remote access on - FR-018, SEC-006)', () => {
    const boundAddresses = ['192.168.1.9'];
    const policy = { allowedHosts: ['flow.internal'], boundAddresses };

    it('admits loopback unconditionally', () => {
      expect(admitsHost({ hostname: '127.0.0.1:4782', boundAddresses })).toBe(true);
      expect(admitsHost({ hostname: '[::1]:4782', boundAddresses })).toBe(true);
      expect(admitsHost({ hostname: 'localhost:4782', boundAddresses })).toBe(true);
    });

    it('admits the LAN address the server is actually bound to', () => {
      expect(admitsHost({ hostname: '192.168.1.9:4782', boundAddresses })).toBe(true);
      expect(admitsHost({ hostname: '192.168.1.9', boundAddresses })).toBe(true);
    });

    it('refuses other IP literals not in boundAddresses', () => {
      // 10.0.0.4 was admitted under legacy checkHost, but must be refused under boundAddresses
      expect(admitsHost({ hostname: '10.0.0.4', boundAddresses })).toBe(false);
      expect(admitsHost({ hostname: '192.168.1.10:4782', boundAddresses })).toBe(false);
    });

    it('refuses undeclared domain names', () => {
      expect(admitsHost({ hostname: 'evil.example:4782', boundAddresses })).toBe(false);
    });

    it('admits declared names in allowedHosts even when boundAddresses is present', () => {
      expect(admitsHost({ hostname: 'flow.internal:4782', ...policy })).toBe(true);
      expect(admitsHost({ hostname: 'FLOW.INTERNAL:4782', ...policy })).toBe(true);
      expect(admitsHost({ hostname: 'flow.internal.evil.example:4782', ...policy })).toBe(false);
    });
  });

  describe('pure address helpers', () => {
    it('isAddressLiteral recognizes IPv4 and IPv6', () => {
      expect(isAddressLiteral('127.0.0.1')).toBe(true);
      expect(isAddressLiteral('192.168.1.1')).toBe(true);
      expect(isAddressLiteral('256.0.0.1')).toBe(false);
      expect(isAddressLiteral('::1')).toBe(true);
      expect(isAddressLiteral('fe80::1')).toBe(true);
      expect(isAddressLiteral('example.com')).toBe(false);
    });

    it('isLoopbackHost recognizes loopback forms', () => {
      expect(isLoopbackHost('localhost')).toBe(true);
      expect(isLoopbackHost('127.0.0.1')).toBe(true);
      expect(isLoopbackHost('127.0.1.1')).toBe(true);
      expect(isLoopbackHost('::1')).toBe(true);
      expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(true);
      expect(isLoopbackHost('192.168.1.1')).toBe(false);
      expect(isLoopbackHost('example.com')).toBe(false);
    });
  });
});
