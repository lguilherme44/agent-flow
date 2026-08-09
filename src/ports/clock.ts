/**
 * Time, behind a port.
 *
 * Every persisted artifact carries timestamps, so without this the state tests
 * would either assert on moving values or skip them entirely.
 */
export interface Clock {
  /** ISO-8601, the only format persisted anywhere. */
  now(): string;
  monotonicMs(): number;
}
