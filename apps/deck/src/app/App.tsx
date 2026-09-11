import { useCallback, useEffect, useState } from 'react';
import { useLive } from '../lib/live';
import { clearStore, invalidate, useResource } from '../lib/store';
import { ApiError, getJson, onUnauthorized } from '../lib/api';
import type { HealthResponse } from '@contracts/index.js';
import { DeckPage } from '../features/deck/DeckPage';
import { RunPage } from '../features/run/RunPage';
import { RunsPage } from '../features/runs/RunsPage';
import { CrewPage } from '../features/crew/CrewPage';
import { DoctorPage } from '../features/doctor/DoctorPage';
import { CleanPage } from '../features/clean/CleanPage';
import { AnalyticsPage } from '../features/analytics/AnalyticsPage';
import { DevicesPage } from '../features/devices/DevicesPage';
import { PairingPage } from '../features/pairing/PairingPage';
import { Empty } from '../components/ui';
import { useT } from '../lib/i18n';
import { Shell } from './Shell';
import { href, onLinkClick, useRoute, type Route } from './router';

function AuthenticatedApp({
  route,
  version,
  onPaired,
}: {
  readonly route: Route;
  readonly version?: string;
  readonly onPaired: () => void;
}) {
  const t = useT();
  // One stream for the whole workspace. Filtering by project would mean reopening it on
  // every navigation, and the deck page wants everything anyway.
  const connection = useLive();

  return (
    <Shell route={route} connection={connection} {...(version === undefined ? {} : { version })}>
      {route.name === 'deck' ? <DeckPage /> : null}
      {route.name === 'runs' ? <RunsPage {...(route.projectId === undefined ? {} : { projectId: route.projectId })} /> : null}
      {route.name === 'crew' ? <CrewPage {...(route.projectId === undefined ? {} : { projectId: route.projectId })} /> : null}
      {route.name === 'doctor' ? <DoctorPage {...(route.projectId === undefined ? {} : { projectId: route.projectId })} /> : null}
      {route.name === 'clean' ? <CleanPage {...(route.projectId === undefined ? {} : { projectId: route.projectId })} /> : null}
      {route.name === 'analytics' ? <AnalyticsPage {...(route.projectId === undefined ? {} : { projectId: route.projectId })} /> : null}
      {route.name === 'devices' ? <DevicesPage /> : null}
      {route.name === 'pairing' ? <PairingPage onPaired={onPaired} /> : null}
      {route.name === 'run' ? (
        <RunPage
          key={`${route.projectId}/${route.runId}`}
          projectId={route.projectId}
          runId={route.runId}
          {...(route.task === undefined ? {} : { task: route.task })}
          {...(route.at === undefined ? {} : { at: route.at })}
        />
      ) : null}
      {route.name === 'missing' ? (
        <main className="page">
          <Empty
            hint={
              <a href={href({ name: 'deck' })} onClick={onLinkClick} style={{ textDecoration: 'underline' }}>
                {t.missing.backToDeck}
              </a>
            }
          >
            {t.missing.before}
            <code>{route.path}</code>
            {t.missing.after}
            <code>/p/&lt;project&gt;/runs/&lt;run&gt;</code>.
          </Empty>
        </main>
      ) : null}
    </Shell>
  );
}

export function App() {
  const route = useRoute();
  const [unauthorized, setUnauthorized] = useState(false);

  // When unauthorized, pass null so no fetch is issued
  const health = useResource<HealthResponse>(
    unauthorized ? null : '/api/v1/health',
    () => getJson<HealthResponse>('/health'),
    { refreshMs: 60_000 },
  );

  useEffect(() => {
    return onUnauthorized(() => {
      setUnauthorized(true);
    });
  }, []);

  useEffect(() => {
    if (health.error instanceof ApiError && health.error.status === 401) {
      setUnauthorized(true);
    }
  }, [health.error]);

  const handlePaired = useCallback(() => {
    setUnauthorized(false);
    clearStore();
    invalidate();
  }, []);

  if (unauthorized) {
    return (
      <Shell
        route={{ name: 'pairing' }}
        connection="connecting"
        {...(health.data?.version === undefined ? {} : { version: health.data.version })}
      >
        <PairingPage onPaired={handlePaired} />
      </Shell>
    );
  }

  return (
    <AuthenticatedApp
      route={route}
      {...(health.data?.version === undefined ? {} : { version: health.data.version })}
      onPaired={handlePaired}
    />
  );
}
