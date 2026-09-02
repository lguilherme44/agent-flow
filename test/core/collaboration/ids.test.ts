import { describe, it, expect } from 'vitest';
import {
  allocateMessageIds,
  nextEntryId,
  nextThreadId,
} from '../../../src/core/collaboration/ids.js';
import {
  BLACKBOARD_ENTRY_KINDS,
  EntryIdSchema,
  MessageIdSchema,
  ThreadIdSchema,
} from '../../../src/contracts/index.js';

describe('id allocation', () => {
  it('starts each sequence at one', () => {
    expect(allocateMessageIds([], 1)[0]).toBe('MSG-0001');
    expect(nextThreadId([])).toBe('THR-0001');
    expect(nextEntryId('decision', [])).toBe('DEC-001');
  });

  it('continues from what is on disk', () => {
    expect(allocateMessageIds(['MSG-0001', 'MSG-0002'], 1)[0]).toBe('MSG-0003');
  });

  it('takes the maximum, not the count', () => {
    // A skipped malformed line leaves a gap. Counting would allocate into it and
    // collide with an id a surviving message may already cite.
    expect(allocateMessageIds(['MSG-0001', 'MSG-0007'], 1)[0]).toBe('MSG-0008');
    expect(nextEntryId('risk', ['RSK-001', 'RSK-042'])).toBe('RSK-043');
  });

  it('ignores ids belonging to another sequence', () => {
    // The prefix is the kind, so a run with four decisions and one risk must not
    // number the next risk `RSK-005`.
    expect(nextEntryId('risk', ['DEC-001', 'DEC-002', 'DEC-003'])).toBe('RSK-001');
    expect(allocateMessageIds(['THR-0009'], 1)[0]).toBe('MSG-0001');
  });

  it('ignores anything that is not an id at all', () => {
    expect(allocateMessageIds(['', 'MSG-', 'MSG-abc', 'nonsense'], 1)[0]).toBe('MSG-0001');
  });

  it('gives every kind its own prefix, and every prefix a valid id', () => {
    for (const kind of BLACKBOARD_ENTRY_KINDS) {
      expect(EntryIdSchema.safeParse(nextEntryId(kind, [])).success, kind).toBe(true);
    }
  });

  it('produces ids the schemas accept', () => {
    expect(MessageIdSchema.safeParse(allocateMessageIds(['MSG-0099'], 1)[0]).success).toBe(true);
    expect(ThreadIdSchema.safeParse(nextThreadId(['THR-0099'])).success).toBe(true);
  });

  it('pads so ids sort lexicographically in the order they were issued', () => {
    // The log is read in file order and rendered in id order in places; two orders that
    // disagree would make a rendered thread look shuffled.
    const ids = allocateMessageIds([], 12);
    expect([...ids].sort()).toEqual(ids);
  });

  it('allocates a run of ids in one pass, without re-scanning', () => {
    expect(allocateMessageIds(['MSG-0003'], 3)).toEqual(['MSG-0004', 'MSG-0005', 'MSG-0006']);
  });

  it('allocates nothing for a count of zero', () => {
    expect(allocateMessageIds(['MSG-0003'], 0)).toEqual([]);
  });
});
