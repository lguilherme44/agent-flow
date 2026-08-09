export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Logging, behind a port.
 *
 * Nothing that reaches a logger may contain credential material (§7.1) —
 * runner output is captured for diagnosis, and that output must be scrubbed
 * before it gets here rather than after.
 */
export interface Logger {
  log(level: LogLevel, message: string, detail?: Record<string, unknown>): void;
  debug(message: string, detail?: Record<string, unknown>): void;
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
  error(message: string, detail?: Record<string, unknown>): void;
}
