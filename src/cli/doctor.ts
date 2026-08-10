import { loadConfig } from '../config/loader.js';
import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { NodeProcessRunner } from '../adapters/process/node-process-runner.js';
import { buildRegistry, type RunnerRegistry } from '../adapters/runners/registry.js';
import {
  assessHealth,
  referencedRunners,
  withProbeEvidence,
  type ObservedRunner,
} from '../core/health.js';
import { probeRunner, type ProbeResult } from '../app/runner-probe.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import type { GlobalOptions } from './index.js';
import type { ProcessRunner } from '../ports/process-runner.js';

export interface DoctorOptions {
  /** Runs a real prompt against each runner. Opt-in: it consumes quota. */
  readonly deep?: boolean;
}

const TICK = '✓';
const CROSS = '✗';
const DASH = '·';

/**
 * `agent-flow doctor` — is this environment able to work?
 *
 * The verdict is ternary (AD-15). A broken runner only fails the check when some
 * role genuinely has nowhere to run; otherwise the environment is DEGRADED and
 * still usable, with the lost capability named explicitly.
 */
export async function runDoctorCommand(
  options: DoctorOptions,
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  const fs = new NodeFileSystem();
  const processRunner = new NodeProcessRunner();

  try {
    const config = await loadConfig({
      fs,
      globalConfigPath: globals.globalConfigPath,
      projectDir: globals.cwd,
    });

    const lines: string[] = ['Agent Flow Doctor', ''];

    const node = await checkTool(processRunner, 'node', ['--version']);
    const git = await checkTool(processRunner, 'git', ['--version']);
    lines.push(renderTool('Node', node), renderTool('Git', git), '');

    const registry = buildRegistry(config.global, { processRunner, fs });
    const health = await registry.health();

    const shallow: ObservedRunner[] = referencedRunners(config.global).map((id) => {
      const reported = health[id];
      return reported === undefined
        ? { id, installed: false, executable: false, auth: 'not_configured' as const }
        : {
            id,
            installed: reported.installed,
            executable: reported.executable,
            auth: reported.auth,
          };
    });

    // ---- Live probe, only when asked for. It spends quota on every runner,
    // which is the entire reason the shallow check exists as the default.
    const probes = options.deep === true ? await probeAll(registry, shallow, globals.cwd) : [];
    const observed = withProbeEvidence(shallow, probes);

    for (const runner of observed) {
      const reported = health[runner.id];
      lines.push(runner.id);
      lines.push(`  installed          ${runner.installed ? TICK : CROSS}`);
      lines.push(`  executable         ${runner.executable ? TICK : CROSS}`);
      lines.push(`  auth               ${renderAuth(runner.auth)}`);
      if (reported?.version) lines.push(`  version            ${reported.version}`);
      // Distinguishing "not on PATH" from "present but will not run" is the
      // difference between installing something and repairing it.
      if (reported?.detail && !runner.executable) {
        lines.push(`  detail             ${reported.detail}`);
      }
      lines.push('');
    }

    if (probes.length > 0) {
      lines.push('Live probe:');
      for (const probe of probes) {
        const detail = probe.detail === undefined ? '' : ` — ${probe.detail}`;
        lines.push(
          `  ${probe.outcome === 'healthy' ? TICK : CROSS} ${probe.id.padEnd(18)}` +
            `${probe.outcome} (${String(probe.durationMs)}ms)${detail}`,
        );
      }
      // Stated rather than left to be worked out from the verdict below.
      lines.push(
        '',
        '  Quota and failed calls are reported but do not change the verdict:',
        '  a spent budget is a billing window, and a bad answer is not a broken',
        '  environment. Missing credentials do change it — that is what --deep',
        '  was for.',
        '',
      );
    }

    const verdict = assessHealth(config.global, observed);

    if (verdict.orphanRoles.length > 0) {
      lines.push('Roles with nowhere to run:');
      for (const role of verdict.orphanRoles) {
        const route = verdict.routes.find((candidate) => candidate.role === role);
        lines.push(`  ${CROSS} ${role} → "${route?.primary ?? '?'}" is unusable and has no fallback`);
      }
      lines.push('');
    }

    if (verdict.degradations.length > 0) {
      lines.push('Degraded:');
      for (const degradation of verdict.degradations) {
        // Never a bare "degraded": the point is what was lost (R-16).
        lines.push(`  ${DASH} ${degradation.reason}`);
        lines.push(`    ${degradation.impact}`);
      }
      lines.push('');
    }

    if (verdict.notes.length > 0) {
      for (const note of verdict.notes) lines.push(`Note: ${note}`);
      lines.push('');
    }

    lines.push(verdict.status);

    if (verdict.status === 'DEGRADED' && !globals.strict) {
      lines.push('');
      lines.push('Work is still possible. Use --strict to treat this as a failure in CI.');
    }

    process.stdout.write(`${lines.join('\n')}\n`);

    if (globals.json) {
      process.stdout.write(`${JSON.stringify({ ...verdict, probes }, null, 2)}\n`);
    }

    if (verdict.status === 'FAIL') return ExitCode.EXECUTION_ERROR;
    if (verdict.status === 'DEGRADED' && globals.strict) return ExitCode.DEGRADED_STRICT;
    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

/**
 * Probes every runner a role could actually be sent to.
 *
 * A runner the shallow check already found missing is skipped: spawning a binary
 * that is not on PATH tells nobody anything new, and the probe would report
 * `runner_unavailable` for a fact already on the screen.
 *
 * Sequential on purpose. These are real invocations against real quota, and
 * firing them all at once is how a health check turns into a rate limit.
 */
async function probeAll(
  registry: RunnerRegistry,
  observed: readonly ObservedRunner[],
  workingDirectory: string,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];

  for (const runner of observed) {
    if (!runner.installed || !runner.executable) continue;
    if (!registry.has(runner.id)) continue;

    results.push(await probeRunner(registry.get(runner.id), { workingDirectory }));
  }

  return results;
}

interface ToolStatus {
  readonly present: boolean;
  readonly version?: string;
}

async function checkTool(
  processRunner: ProcessRunner,
  command: string,
  args: string[],
): Promise<ToolStatus> {
  const result = await processRunner.run({ command, args, cwd: process.cwd(), timeoutSeconds: 10 });
  return result.spawnFailed || result.exitCode !== 0
    ? { present: false }
    : { present: true, version: result.stdout.trim().split('\n')[0] ?? '' };
}

function renderTool(name: string, status: ToolStatus): string {
  return `${name}\n  installed          ${status.present ? TICK : CROSS}${
    status.version ? `\n  version            ${status.version}` : ''
  }`;
}

/**
 * Reports whether credentials exist, never what they are. Nothing here reads
 * or echoes the contents of an auth file (§7.1).
 */
function renderAuth(auth: ObservedRunner['auth']): string {
  switch (auth) {
    case 'configured':
      return 'configured';
    case 'available':
      return 'available';
    case 'not_configured':
      return `${CROSS} not configured`;
    default:
      return 'not verified (use --deep)';
  }
}
