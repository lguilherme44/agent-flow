import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceSessionView } from '@contracts/index.js';
import { clearStore } from '../../lib/store';
import { DevicesPage } from './DevicesPage';
import { I18nProvider, ptBR, en } from '../../lib/i18n';

afterEach(() => {
  vi.unstubAllGlobals();
  clearStore();
});

const SESSIONS: DeviceSessionView[] = [
  {
    deviceId: 'dev_iphone_1',
    label: 'iPhone Safari',
    pairedAt: 1726000000000,
    lastSeenAt: 1726001000000,
  },
  {
    deviceId: 'dev_android_2',
    label: 'Pixel Chrome',
    pairedAt: 1726002000000,
    lastSeenAt: 1726003000000,
  },
];

describe('DevicesPage', () => {
  it('renders empty state when no sessions are paired', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <I18nProvider locale="en">
        <DevicesPage />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(en.devices.noSessions)).toBeDefined();
    });
  });

  it('lists live sessions with a revoke control per row', async () => {
    let sessionsList = [...SESSIONS];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const target = String(input);
      if (target.includes('/revoke') && init?.method === 'POST') {
        sessionsList = sessionsList.filter((s) => !target.includes(s.deviceId));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target.includes('/sessions')) {
        return new Response(JSON.stringify(sessionsList), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <I18nProvider locale="en">
        <DevicesPage />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('iPhone Safari')).toBeDefined();
      expect(screen.getByText('Pixel Chrome')).toBeDefined();
      expect(screen.getByText('dev_iphone_1')).toBeDefined();
      expect(screen.getByText('dev_android_2')).toBeDefined();
    });

    const revokeButtons = screen.getAllByRole('button', { name: en.devices.revoke });
    expect(revokeButtons).toHaveLength(2);

    // Revoke the first device
    fireEvent.click(revokeButtons[0]!);

    await waitFor(() => {
      expect(screen.queryByText('iPhone Safari')).toBeNull();
      expect(screen.getByText('Pixel Chrome')).toBeDefined();
    });
  });

  it('renders Portuguese copy under pt-BR locale (NFR-006)', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify(SESSIONS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <I18nProvider locale="pt-BR">
        <DevicesPage />
      </I18nProvider>,
    );

    expect(screen.getByText(ptBR.devices.title)).toBeDefined();
    expect(screen.getByText(ptBR.devices.description)).toBeDefined();

    await waitFor(() => {
      expect(screen.getByText('iPhone Safari')).toBeDefined();
      expect(screen.getAllByRole('button', { name: ptBR.devices.revoke })).toHaveLength(2);
    });
  });
});
