import { describe, expect, it } from 'vitest';
import { href, parseRoute } from './router';

describe('parseRoute', () => {
  it('knows its seven screens', () => {
    expect(parseRoute('/', '')).toEqual({ name: 'deck' });
    expect(parseRoute('/runs', '')).toEqual({ name: 'runs' });
    expect(parseRoute('/runs', '?project=flowcanvas')).toEqual({ name: 'runs', projectId: 'flowcanvas' });
    expect(parseRoute('/crew', '')).toEqual({ name: 'crew' });
    expect(parseRoute('/doctor', '')).toEqual({ name: 'doctor' });
    expect(parseRoute('/doctor', '?project=flowcanvas')).toEqual({ name: 'doctor', projectId: 'flowcanvas' });
    expect(parseRoute('/clean', '')).toEqual({ name: 'clean' });
    expect(parseRoute('/clean', '?project=flowcanvas')).toEqual({ name: 'clean', projectId: 'flowcanvas' });
    expect(parseRoute('/analytics', '')).toEqual({ name: 'analytics' });
    expect(parseRoute('/analytics', '?project=flowcanvas')).toEqual({ name: 'analytics', projectId: 'flowcanvas' });
    expect(parseRoute('/devices', '')).toEqual({ name: 'devices' });
    expect(parseRoute('/pairing', '')).toEqual({ name: 'pairing' });
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
      { name: 'doctor' as const },
      { name: 'doctor' as const, projectId: 'flowcanvas' },
      { name: 'clean' as const },
      { name: 'clean' as const, projectId: 'flowcanvas' },
      { name: 'analytics' as const },
      { name: 'analytics' as const, projectId: 'flowcanvas' },
      { name: 'devices' as const },
      { name: 'pairing' as const },
      { name: 'run' as const, projectId: 'flowcanvas', runId: 'AF-2026-002', task: 'TASK-004' },
    ]) {
      const to = href(route);
      const [pathname, search = ''] = to.split('?');
      expect(parseRoute(pathname ?? '/', search === '' ? '' : `?${search}`)).toEqual(route);
    }
  });
});
