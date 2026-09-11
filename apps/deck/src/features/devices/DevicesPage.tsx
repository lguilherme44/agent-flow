import { useState } from 'react';
import type { DeviceSessionView } from '@contracts/index.js';
import { api, keys } from '../../lib/api';
import { invalidate, useResource } from '../../lib/store';
import { Empty, Notice, Skeleton } from '../../components/ui';
import { useT } from '../../lib/i18n';
import { formatStamp } from '../../lib/time';

/**
 * 7.9 — Connected devices and session management (FR-022).
 *
 * Lists all live device sessions from GET /api/v1/sessions.
 * Provides one revoke control per row. Revocation goes strictly through api.revokeSession
 * followed by invalidate(keys.sessions), preserving DECK-A03 (the store has no write API).
 */
export function DevicesPage() {
  const t = useT();
  const sessions = useResource<DeviceSessionView[]>(keys.sessions(), api.sessions);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | undefined>(undefined);

  const handleRevoke = async (deviceId: string) => {
    setRevokingId(deviceId);
    setRevokeError(undefined);
    try {
      await api.revokeSession(deviceId);
      invalidate((key) => key.includes('/sessions'));
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <main className="page">
      <div className="page-head crew-head">
        <div>
          <span className="eyebrow">{t.nav.devices}</span>
          <h1 className="page-head__title">{t.devices.title}</h1>
          <p className="page-head__sub">{t.devices.description}</p>
        </div>
      </div>

      {revokeError !== undefined ? (
        <div style={{ maxWidth: 800, margin: '0 auto 16px' }}>
          <Notice tone="bad" k={t.common.refused}>
            {t.devices.couldNotRevoke(revokeError)}
          </Notice>
        </div>
      ) : null}

      {sessions.loading ? (
        <Skeleton rows={4} />
      ) : sessions.error !== undefined ? (
        <Empty error>{t.devices.couldNotLoad}</Empty>
      ) : (sessions.data ?? []).length === 0 ? (
        <Empty>{t.devices.noSessions}</Empty>
      ) : (
        <div style={{ maxWidth: 800, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="eyebrow">{t.devices.activeSessions(sessions.data!.length)}</span>
          </div>

          <div style={{ border: '1px solid var(--line-2)', borderRadius: 'var(--r-2)', overflow: 'hidden', background: 'var(--bg-2)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 'var(--fs-1)' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line-2)', background: 'var(--bg)' }}>
                  <th style={{ padding: '10px 14px', fontWeight: 600 }}>{t.devices.deviceLabel}</th>
                  <th style={{ padding: '10px 14px', fontWeight: 600 }}>{t.devices.deviceId}</th>
                  <th style={{ padding: '10px 14px', fontWeight: 600 }}>{t.devices.pairedAt}</th>
                  <th style={{ padding: '10px 14px', fontWeight: 600 }}>{t.devices.lastSeenAt}</th>
                  <th style={{ padding: '10px 14px', fontWeight: 600, textAlign: 'right' }}>{t.devices.actions}</th>
                </tr>
              </thead>
              <tbody>
                {sessions.data!.map((session) => (
                  <tr key={session.deviceId} style={{ borderBottom: '1px solid var(--line-2)' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 500 }}>{session.label}</td>
                    <td style={{ padding: '10px 14px' }}>
                      <code className="mono">{session.deviceId}</code>
                    </td>
                    <td style={{ padding: '10px 14px', color: 'var(--ink-2)' }}>
                      {formatStamp(session.pairedAt, t.time)}
                    </td>
                    <td style={{ padding: '10px 14px', color: 'var(--ink-2)' }}>
                      {formatStamp(session.lastSeenAt, t.time)}
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                      <button
                        type="button"
                        className="btn btn--danger btn--sm"
                        disabled={revokingId === session.deviceId}
                        onClick={() => void handleRevoke(session.deviceId)}
                      >
                        {revokingId === session.deviceId ? t.devices.revoking : t.devices.revoke}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}
