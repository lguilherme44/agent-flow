import { useLive } from '../lib/live';
import { useResource } from '../lib/store';
import { getJson } from '../lib/api';
import type { HealthResponse } from '@contracts/index.js';
import { DeckPage } from '../features/deck/DeckPage';
import { RunPage } from '../features/run/RunPage';
import { RunsPage } from '../features/runs/RunsPage';
import { CrewPage } from '../features/crew/CrewPage';
import { Empty } from '../components/ui';
import { Shell } from './Shell';
import { href, onLinkClick, useRoute } from './router';

export function App() {
  const route = useRoute();
  // One stream for the whole workspace. Filtering by project would mean reopening it on
  // every navigation, and the deck page wants everything anyway.
  const connection = useLive();
  const health = useResource<HealthResponse>('/api/v1/health', () => getJson<HealthResponse>('/health'), { refreshMs: 60_000 });

  return (
    <Shell route={route} connection={connection} {...(health.data?.version === undefined ? {} : { version: health.data.version })}>
      {route.name === 'deck' ? <DeckPage /> : null}
      {route.name === 'runs' ? <RunsPage {...(route.projectId === undefined ? {} : { projectId: route.projectId })} /> : null}
      {route.name === 'crew' ? <CrewPage {...(route.projectId === undefined ? {} : { projectId: route.projectId })} /> : null}
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
                Back to the deck
              </a>
            }
          >
            Nothing lives at <code>{route.path}</code>. A run is addressed with its project: <code>/p/&lt;project&gt;/runs/&lt;run&gt;</code>.
          </Empty>
        </main>
      ) : null}
    </Shell>
  );
}
