import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearStore } from '../../lib/store';
import { PairingPage, maskPairingCode } from './PairingPage';
import { I18nProvider, ptBR, en } from '../../lib/i18n';

afterEach(() => {
  vi.unstubAllGlobals();
  clearStore();
});

describe('PairingPage', () => {
  it('renders pairing inputs and submits code with hyphens', async () => {
    const onPaired = vi.fn();
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { code: string; label: string };
      expect(body.code).toBe('1234-5678-9012');
      expect(body.label).toBe('My Laptop');
      return new Response(
        JSON.stringify({ deviceId: 'dev_1', label: 'My Laptop', pairedAt: 1000 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <I18nProvider locale="en">
        <PairingPage onPaired={onPaired} />
      </I18nProvider>,
    );

    expect(screen.getByRole('heading', { name: en.pairing.title })).toBeDefined();

    const codeInput = screen.getByPlaceholderText(en.pairing.codePlaceholder);
    const labelInput = screen.getByPlaceholderText(en.pairing.devicePlaceholder);
    const submitBtn = screen.getByRole('button', { name: en.pairing.pairButton });

    fireEvent.change(codeInput, { target: { value: '1234-5678-9012' } });
    fireEvent.change(labelInput, { target: { value: 'My Laptop' } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onPaired).toHaveBeenCalledTimes(1);
    });
  });

  it('accepts code typed without hyphens', async () => {
    // Asserted over what the *server* will make of it, not over the literal string posted.
    // The field now masks as it is typed, so a person typing twelve bare digits sends
    // `1234-5678-9012` — and `DeviceSessionStore.pairDevice` normalises with
    // `.trim().replace(/-/g, '').toLowerCase()` before any comparison, so both forms reach
    // the same code. Pinning the exact bytes made this test fail for a change that
    // improved the thing the test is named after.
    const onPaired = vi.fn();
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { code: string; label: string };
      expect(body.code.replace(/-/g, '')).toBe('123456789012');
      return new Response(
        JSON.stringify({ deviceId: 'dev_2', label: 'Deck Browser', pairedAt: 1000 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <I18nProvider locale="en">
        <PairingPage onPaired={onPaired} />
      </I18nProvider>,
    );

    const codeInput = screen.getByPlaceholderText(en.pairing.codePlaceholder);
    const submitBtn = screen.getByRole('button', { name: en.pairing.pairButton });

    fireEvent.change(codeInput, { target: { value: '123456789012' } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onPaired).toHaveBeenCalledTimes(1);
    });
  });

  it('displays refusal error message when pairing fails with 401', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: 'pairing_code_unknown',
          message: 'The pairing code is invalid.',
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <I18nProvider locale="en">
        <PairingPage />
      </I18nProvider>,
    );

    const codeInput = screen.getByPlaceholderText(en.pairing.codePlaceholder);
    const submitBtn = screen.getByRole('button', { name: en.pairing.pairButton });

    fireEvent.change(codeInput, { target: { value: '0000-0000-0000' } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('The pairing code is invalid.')).toBeDefined();
    });
  });

  it('renders Portuguese copy under pt-BR locale (NFR-006)', () => {
    render(
      <I18nProvider locale="pt-BR">
        <PairingPage />
      </I18nProvider>,
    );

    expect(screen.getByRole('heading', { name: ptBR.pairing.title })).toBeDefined();
    expect(screen.getByText(ptBR.pairing.description)).toBeDefined();
    expect(screen.getByText(ptBR.pairing.codeLabel)).toBeDefined();
    expect(screen.getByText(ptBR.pairing.deviceLabel)).toBeDefined();
    expect(screen.getByRole('button', { name: ptBR.pairing.pairButton })).toBeDefined();
    expect(screen.getByText(ptBR.pairing.restartWarning)).toBeDefined();
  });
});

/**
 * The field formats as it is typed, because the operator is reading the code off a
 * terminal on another screen and typing it on a phone. Measured live: three codes
 * expired before one was entered, and the friction was entirely in this loop.
 */
describe('maskPairingCode', () => {
  it('groups digits in fours as they arrive', () => {
    expect(maskPairingCode('b')).toBe('b');
    expect(maskPairingCode('bed2')).toBe('bed2');
    expect(maskPairingCode('bed21')).toBe('bed2-1');
    expect(maskPairingCode('bed21f32ca23')).toBe('bed2-1f32-ca23');
  });

  it('absorbs the dashes on a paste, rather than doubling them', () => {
    // The line the terminal prints, pasted whole.
    expect(maskPairingCode('bed2-1f32-ca23')).toBe('bed2-1f32-ca23');
    expect(maskPairingCode('bed2 1f32 ca23')).toBe('bed2-1f32-ca23');
  });

  it('drops what a pairing code cannot contain, including a typed dash mid-group', () => {
    expect(maskPairingCode('BED2-1F32-CA23')).toBe('bed2-1f32-ca23');
    expect(maskPairingCode('zzbed2')).toBe('bed2');
  });

  it('stops at twelve digits instead of quietly keeping a thirteenth', () => {
    expect(maskPairingCode('bed21f32ca23ffff')).toBe('bed2-1f32-ca23');
  });

  it('stays empty on empty, so the submit button keeps its disabled rule', () => {
    expect(maskPairingCode('')).toBe('');
    expect(maskPairingCode('---')).toBe('');
  });
});
