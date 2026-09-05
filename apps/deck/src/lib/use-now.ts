import { useEffect, useState } from 'react';

/**
 * The wall clock, ticking once a second while `running`.
 *
 * Off when the run is finished: a completed run's timeline has a fixed right edge, and a
 * page that re-rendered every second to move nothing would be spending the battery on a
 * number nobody reads.
 */
export function useNow(running = true, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [running, intervalMs]);

  return now;
}
