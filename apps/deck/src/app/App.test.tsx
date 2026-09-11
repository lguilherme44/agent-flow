import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearStore } from '../lib/store';
import { App } from './App';
import { I18nProvider, en } from '../lib/i18n';

afterEach(() => {
  vi.unstubAllGlobals();
  clearStore();
});

describe('App 401 and pairing flow (FR-021)', () => {
  it('renders pairing screen on 401, issues no further read of failed key, and resumes on successful pair', async () => {
    let paired = false;
    let workspaceReadCount = 0;

    const eventSourceInstances: { close: ReturnType<typeof vi.fn> }[] = [];
    const EventSourceMock = vi.fn().mockImplementation(() => {
      const instance = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        close: vi.fn(),
        onopen: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onmessage: null as (() => void) | null,
      };
      eventSourceInstances.push(instance);
      return instance;
    });
    vi.stubGlobal('EventSource', EventSourceMock);

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const target = String(input);

      if (target.includes('/health')) {
        return new Response(JSON.stringify({ status: 'ok', version: '1.0.0', projects: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (target.includes('/pair') && init?.method === 'POST') {
        paired = true;
        return new Response(JSON.stringify({ deviceId: 'dev_1', label: 'Browser', pairedAt: 1000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (target.includes('/projects')) {
        if (!paired) {
          return new Response(
            JSON.stringify({
              error: 'session_required',
              message: 'This server requires an active device session for remote access.',
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify([{ id: 'demo', name: 'Demo Project' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (target.includes('/workspace')) {
        workspaceReadCount++;
        if (!paired) {
          return new Response(
            JSON.stringify({
              error: 'session_required',
              message: 'This server requires an active device session for remote access.',
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Initial render: on default route '/' (deck page), which fetches /workspace and /projects
    render(
      <I18nProvider locale="en">
        <App />
      </I18nProvider>,
    );

    // Because /workspace returns 401, parse() throws 401 ApiError and notifies onUnauthorized
    // App switches to pairing screen
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: en.pairing.title })).toBeDefined();
    });

    // The EventSource that was opened should be closed when AuthenticatedApp unmounted
    expect(eventSourceInstances.length).toBeGreaterThanOrEqual(1);
    expect(eventSourceInstances[0]?.close).toHaveBeenCalled();

    // No further read of /workspace happens while on the pairing screen
    const readCountBeforePair = workspaceReadCount;
    expect(readCountBeforePair).toBeGreaterThanOrEqual(1);

    // Wait a short moment to confirm no refetch loop occurs
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(workspaceReadCount).toBe(readCountBeforePair);

    // Now pair the device
    const codeInput = screen.getByPlaceholderText(en.pairing.codePlaceholder);
    const pairBtn = screen.getByRole('button', { name: en.pairing.pairButton });

    fireEvent.change(codeInput, { target: { value: '1234-5678-9012' } });
    fireEvent.click(pairBtn);

    // Once pairing succeeds, the AuthenticatedApp remounts:
    // Event stream reconnects (new EventSource constructed)
    // Workspace read resumes!
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: en.pairing.title })).toBeNull();
      expect(eventSourceInstances.length).toBeGreaterThan(1);
      expect(workspaceReadCount).toBeGreaterThan(readCountBeforePair);
    });
  });
});
