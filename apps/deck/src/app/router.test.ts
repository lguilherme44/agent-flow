import { describe, expect, it } from 'vitest';
import { href, parseRoute } from './router';

describe('parseRoute', () => {
  it('knows its four screens', () => {
    expect(parseRoute('/', '')).toEqual({ name: 'deck' });
    expect(parseRoute('/runs', '')).toEqual({ name: 'runs' });
    expect(parseRoute('/runs', '?project=flowcanvas')).toEqual({ name: 'runs', projectId: 'flowcanvas' });
    expect(parseRoute('/crew', '')).toEqual({ name: 'crew' });
    expect(parseRoute('/p/flowcanvas/runs/AF-2026-002', '?task=TASK-004&at=2026-09-04T14:31:21.212Z')).toEqual({
      name: 'run',
      projectId: 'flowcanvas',
      runId: 'AF-2026-002',
      task: 'TASK-004',
      at: '2026-09-04T14:31:21.212Z',
    });
  });

  it('still understands the previous dashboard’s run links', () => {
    expect(parseRoute('/runs/AF-2026-001', '?project=booking-api')).toEqual({
      name: 'run',
      projectId: 'booking-api',
      runId: 'AF-2026-001',
    });
  });

  it('never invents a project for a run', () => {
    expect(parseRoute('/runs/AF-2026-001', '')).toEqual({ name: 'missing', path: '/runs/AF-2026-001' });
    expect(parseRoute('/nope', '')).toEqual({ name: 'missing', path: '/nope' });
  });
});

describe('href', () => {
  it('round-trips every route', () => {
    for (const route of [
      { name: 'deck' as const },
      { name: 'runs' as const, projectId: 'a-b' },
      { name: 'crew' as const },
      { name: 'run' as const, projectId: 'flowcanvas', runId: 'AF-2026-002', task: 'TASK-004' },
    ]) {
      const to = href(route);
      const [pathname, search = ''] = to.split('?');
      expect(parseRoute(pathname ?? '/', search === '' ? '' : `?${search}`)).toEqual(route);
    }
  });
});
