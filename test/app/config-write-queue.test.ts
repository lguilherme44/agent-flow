import { describe, expect, it } from 'vitest';
import { pendingConfigWrites, serializeConfigWrite } from '../../src/app/config-write-queue.js';

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

describe('serializeConfigWrite', () => {
  it('runs one writer at a time for the same source path', async () => {
    const firstGate = deferred();
    const order: string[] = [];
    const first = serializeConfigWrite('/config.yaml', async () => {
      order.push('first:start');
      await firstGate.promise;
      order.push('first:end');
    });
    const second = serializeConfigWrite('/config.yaml', async () => { order.push('second'); });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    expect(pendingConfigWrites()).toBe(1);
    firstGate.release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    expect(pendingConfigWrites()).toBe(0);
  });

  it('does not make writes to different source paths wait for each other', async () => {
    const gate = deferred();
    const order: string[] = [];
    const first = serializeConfigWrite('/one.yaml', async () => { await gate.promise; order.push('one'); });
    const second = serializeConfigWrite('/two.yaml', async () => { order.push('two'); });

    await second;
    expect(order).toEqual(['two']);
    gate.release();
    await first;
    expect(order).toEqual(['two', 'one']);
  });

  it('continues the queue after an earlier writer fails', async () => {
    const failed = serializeConfigWrite('/config.yaml', async () => { throw new Error('write failed'); });
    const next = serializeConfigWrite('/config.yaml', async () => 'saved');

    await expect(failed).rejects.toThrow('write failed');
    await expect(next).resolves.toBe('saved');
    expect(pendingConfigWrites()).toBe(0);
  });
});
