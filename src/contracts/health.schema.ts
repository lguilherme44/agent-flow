import { z } from 'zod';
import { DegradationSchema } from './state.schema.js';

/**
 * Environment health is ternary, not boolean (AD-15, C-2).
 *
 * A broken runner should not stop work when every configured role still has a
 * valid route to some healthy runner. `FAIL` is reserved for the case where a
 * role has nowhere to run at all.
 */
export const HEALTH_STATUSES = ['OK', 'DEGRADED', 'FAIL'] as const;
export const HealthStatusSchema = z.enum(HEALTH_STATUSES);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

/**
 * `installed` and `executable` are separate on purpose: an npm package can be
 * present while its native binary is missing, which is exactly how the Codex
 * CLI fails on the development machine this was written on.
 */
export const RunnerHealthSchema = z.object({
  id: z.string().min(1),
  installed: z.boolean(),
  executable: z.boolean(),
  /** Shallow by default; `unknown` until `doctor --deep` probes for real (R-14). */
  auth: z.enum(['configured', 'not_configured', 'available', 'unknown']).default('unknown'),
  version: z.string().optional(),
  detail: z.string().optional(),
});
export type RunnerHealthReport = z.infer<typeof RunnerHealthSchema>;

export const HealthReportSchema = z.object({
  status: HealthStatusSchema,
  runners: z.array(RunnerHealthSchema).default([]),
  degradations: z.array(DegradationSchema).default([]),
  /** Configured roles with no healthy primary and no healthy fallback. */
  orphanRoles: z.array(z.string()).default([]),
});
export type HealthReport = z.infer<typeof HealthReportSchema>;
