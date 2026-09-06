/**
 * Process-local serialization for configuration read/compare/write sections.
 *
 * This closes races between Deck and CLI requests handled by this process. It
 * intentionally is not an inter-process lock: an external editor can still
 * write between our final read and the adapter's atomic rename. The exact-source
 * digest makes such changes visible before the rename whenever they happen
 * before the final read; a lease would be required to close the remaining gap.
 */
const tails = new Map<string, Promise<void>>();

export async function serializeConfigWrite<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(path) ?? Promise.resolve();
  const running = previous.then(work);
  const settled = running.then(() => undefined, () => undefined);
  tails.set(path, settled);
  try {
    return await running;
  } finally {
    if (tails.get(path) === settled) tails.delete(path);
  }
}

/** Number of source paths with active or queued writes; diagnostics/tests only. */
export function pendingConfigWrites(): number {
  return tails.size;
}
