import { loadConfig } from '../config/loader.js';
import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { NodeProcessRunner } from '../adapters/process/node-process-runner.js';
import { NodeHost } from '../adapters/host/node-host.js';
import { resolvePromptsDir } from '../app/prompt-paths.js';
import {
  diagnose,
  type CapabilityObservation,
  type Diagnosis,
  type InstallProbe,
  type ObservedRunnerReport,
  type ToolCheck,
} from '../app/diagnostics.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import { renderStageRouting, renderUnusedRunners } from './render/routing.js';
import { en, type Phrases } from '../core/phrases/index.js';
import type { GlobalOptions } from './index.js';

export interface DoctorOptions {
  /** Runs a real prompt against each runner. Opt-in: it consumes quota. */
  readonly deep?: boolean;
}

const TICK = '✓';
const CROSS = '✗';
const DASH = '·';
const WARN = '⚠';

/**
 * `agent-flow doctor` — is this environment able to work?
 *
 * The verdict is ternary (AD-15). A broken runner only fails the check when some
 * role genuinely has nowhere to run; otherwise the environment is DEGRADED and
 * still usable, with the lost capability named explicitly.
 *
 * **This function decides nothing.** Every check, every judgement and every
 * widening of the verdict lives in `app/diagnostics.ts`, because the Deck asks
 * the same question through `GET /api/v1/doctor` and two implementations of
 * "is this machine able to work" would answer differently the first time either
 * was edited. What is left here is the terminal: an order, a column width, and
 * the sentences that turn a finding into something a person can act on.
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

    const diagnosis = await diagnose({
      fs,
      processRunner,
      host: new NodeHost(),
      config,
      projectDir: globals.cwd,
      promptsDir: resolvePromptsDir(),
      // The CLI may read the environment; the server may not (§93). Passing it here is
      // what makes a runner authenticated by `apiKeyEnv` report `configured` in a
      // terminal, and what the report's `readsEnvironment` flag is telling a reader.
      env: (name) => process.env[name],
      ...(options.deep === undefined ? {} : { deep: options.deep }),
      // Announced before it runs, because it is the slowest thing `doctor` does by an
      // order of magnitude: a throwaway checkout plus the project's own install command.
      // Measured on a Vue project, it spent minutes with zero bytes of output and was
      // taken for a hang and killed. Everything else here buffers into `lines` and prints
      // at the end, which is right for fast checks and wrong for this one.
      onInstallProbe: (command) => {
        process.stdout.write(`  → probing install (\`${command}\` in a fresh checkout)…\n`);
      },
    });

    process.stdout.write(`${renderDiagnosis(diagnosis, globals.strict).join('\n')}\n`);

    if (globals.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            status: diagnosis.status,
            orphanRoles: diagnosis.orphanRoles,
            degradations: diagnosis.degradations,
            notes: diagnosis.notes,
            unresolvableRoles: diagnosis.unresolvableRoles,
            probes: diagnosis.probes,
            remoteAccess: diagnosis.remoteAccess,
          },
          null,
          2,
        )}\n`,
      );
    }

    if (diagnosis.status === 'FAIL') return ExitCode.EXECUTION_ERROR;
    if (diagnosis.status === 'DEGRADED' && globals.strict) return ExitCode.DEGRADED_STRICT;
    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

/** The whole report, in the order a person reads it. */
export function renderDiagnosis(diagnosis: Diagnosis, strict = false, say: Phrases = en): string[] {
  const lines: string[] = ['Agent Flow Doctor', ''];

  for (const tool of diagnosis.tools) lines.push(renderTool(tool));
  lines.push('');

  for (const line of renderInstallProbe(diagnosis.install)) lines.push(line);
  for (const line of renderCapabilityReport(diagnosis.capabilities)) lines.push(line);

  lines.push('', ...renderStageRouting(diagnosis.stageRouting));
  const unused = renderUnusedRunners(diagnosis.unusedRunners);
  if (unused.length > 0) lines.push('', ...unused);

  for (const runner of diagnosis.runners) {
    lines.push(runner.id);
    lines.push(`  installed          ${runner.installed ? TICK : CROSS}`);
    lines.push(`  executable         ${runner.executable ? TICK : CROSS}`);
    lines.push(`  auth               ${renderAuth(runner.auth)}`);
    if (runner.version !== undefined) lines.push(`  version            ${runner.version}`);
    // Distinguishing "not on PATH" from "present but will not run" is the
    // difference between installing something and repairing it.
    if (runner.detail !== undefined && !runner.executable) {
      lines.push(`  detail             ${runner.detail}`);
    }
    lines.push('');
  }

  if (diagnosis.probes.length > 0) {
    lines.push('Live probe:');
    for (const probe of diagnosis.probes) {
      const detail = probe.detail === undefined ? '' : ` — ${probe.detail}`;
      lines.push(
        `  ${probe.outcome === 'healthy' ? TICK : CROSS} ${probe.id.padEnd(18)}` +
          `${probe.outcome} (${String(probe.durationMs)}ms)${detail}`,
      );

      // Per effort, because "this runner is broken" and "this pair cannot do medium"
      // have different fixes, and the second is the one AF-2026-002 needed.
      for (const effort of probe.efforts ?? []) {
        const why = effort.detail === undefined ? '' : ` — ${effort.detail}`;
        lines.push(
          `      ${effort.outcome === 'healthy' ? TICK : CROSS} effort ${effort.reasoning.padEnd(10)}` +
            `${effort.outcome}${why}`,
        );
      }

      if (probe.toolUse !== undefined) {
        const why = probe.toolUse.detail === undefined ? '' : ` — ${probe.toolUse.detail}`;
        lines.push(
          `      ${probe.toolUse.outcome === 'healthy' ? TICK : WARN} tool use   ` +
            `${probe.toolUse.outcome}${why}`,
        );
        if (probe.toolUse.outcome !== 'healthy') {
          // Actionable, and it stops there. Granting the tool is the user's; AR-01
          // neither edits configuration nor escalates permissions to work around it.
          lines.push(
            `        The probe ran read-only and could not use a tool. Grant the runner`,
            `        non-interactive tool access in its own CLI configuration.`,
          );
        }
      }
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

  if (diagnosis.orphanRoles.length > 0) {
    lines.push('Roles with nowhere to run:');
    for (const orphan of diagnosis.orphanRoles) {
      lines.push(`  ${CROSS} ${orphan.role} → "${orphan.primary}" is unusable and has no fallback`);
    }
    lines.push('');
  }

  if (diagnosis.unresolvableRoles.length > 0) {
    lines.push(
      'Roles whose configuration cannot run:',
      ...diagnosis.unresolvableRoles.map((role) => `  ${CROSS} ${role} — see Capabilities above`),
      '',
      '  These are configuration errors, not degradations: the stage fails on contact,',
      '  every time. Point the role at a runner that can do what its prompts require.',
      '',
    );
  }

  if (diagnosis.degradations.length > 0) {
    lines.push('Degraded:');
    for (const degradation of diagnosis.degradations) {
      // Never a bare "degraded": the point is what was lost (R-16).
      lines.push(`  ${DASH} ${degradation.reason}`);
      lines.push(`    ${degradation.impact}`);
    }
    lines.push('');
  }

  if (diagnosis.notes.length > 0) {
    for (const note of diagnosis.notes) lines.push(`Note: ${note}`);
    lines.push('');
  }

  if (diagnosis.remediations.length > 0) {
    lines.push('Remediation:');
    for (const rem of diagnosis.remediations) {
      lines.push(`  → ${rem.problem}`);
      lines.push(`    Fix: ${rem.fix}`);
    }
    lines.push('');
  }

  for (const line of renderRemoteAccess(diagnosis.remoteAccess, say)) lines.push(line);

  lines.push(renderVerdict({ status: diagnosis.status, notes: diagnosis.notes }));

  if (diagnosis.status === 'DEGRADED' && !strict) {
    lines.push('');
    lines.push('Work is still possible. Use --strict to treat this as a failure in CI.');
  }

  return lines;
}

/**
 * Remote access status, as lines (FR-023).
 *
 * Unknown when diagnosed from the standalone CLI command (`agent-flow doctor`),
 * because in-memory pairing state lives in the `agent-flow ui` process and nowhere
 * else. The honest answer is to report that remote access cannot be determined from
 * the terminal and to name the running server as where to ask, rather than guessing
 * "off" for a server it cannot see.
 */
export function renderRemoteAccess(
  remoteAccess: Diagnosis['remoteAccess'],
  say: Phrases = en,
): string[] {
  if (!remoteAccess.known) {
    return [
      'Remote access:',
      `  ${DASH} ${say.doctor.remoteAccessUndetermined}`,
      '',
    ];
  }

  const lines: string[] = ['Remote access:'];
  if (remoteAccess.enabled) {
    lines.push(
      `  ${TICK} enabled (${String(remoteAccess.liveSessions)} live session${remoteAccess.liveSessions === 1 ? '' : 's'})`,
    );
    if (remoteAccess.admittedAddresses.length > 0) {
      lines.push(`    admitted addresses: ${remoteAccess.admittedAddresses.join(', ')}`);
    }
  } else {
    lines.push(`  ${DASH} off`);
  }
  lines.push('');
  return lines;
}

/**
 * The mechanical capability section, as lines.
 *
 * Reports the clamp **before** it happens, which is the entire deliverable: `medium`
 * against a pair offering `low` and `high` is a fact available at configuration time, and
 * discovering it cost a task attempt.
 *
 * A permission gap is a warning and never a verdict. `false` on a tool grant means nobody
 * declared it, execution is not blocked by it, and the response is a person granting
 * something — so this section names the grant and stops there. Repairing it belongs to a
 * later milestone (AR-02 classifies the runtime denial; nothing here edits configuration).
 */
export function renderCapabilityReport(
  observations: readonly CapabilityObservation[],
): string[] {
  if (observations.length === 0) return [];

  const lines: string[] = ['Capabilities (declared — no runner was invoked)'];

  for (const observation of observations) {
    const model = observation.model ?? '(runner default)';
    lines.push(`  ${observation.role.padEnd(20)} ${observation.runner.padEnd(10)} ${model}`);

    if (observation.kind === 'unresolvable') {
      // A cross, not a dash: this role has nowhere to run, and every stage it serves will
      // fail on contact. Rendering it as a degradation would say work is still possible.
      lines.push(
        `    ${CROSS} cannot run: ${observation.errorKind}`,
        ...observation.reason.split('\n').map((line) => `      ${line.trim()}`),
      );
      continue;
    }

    const supported = observation.supportedReasoningLevels.join(', ');
    if (observation.reasoningClamped) {
      lines.push(
        `    ${DASH} effort ${observation.requestedReasoning} is not offered by this pair ` +
          `(supported: ${supported})`,
        `      it will be clamped to ${observation.effectiveReasoning}, recorded on the run`,
      );
    } else {
      lines.push(`    ${TICK} effort ${observation.effectiveReasoning} (supported: ${supported})`);
    }

    const finding = observation.permissionFinding;
    if (finding !== undefined) {
      lines.push(
        `    ${WARN} ${finding.failureClass}: "${finding.runner}" does not declare ` +
          `${finding.toolClass}, which this role's prompts need`,
        `      ${finding.action}`,
      );
    }
  }

  lines.push(
    '',
    '  Declared capabilities are read from the adapters, never inferred from a run that',
    '  happened to succeed. A missing grant is a warning: it does not stop execution.',
    '',
  );

  return lines;
}

/**
 * The install probe, as lines.
 *
 * Silent when the probe was skipped: `doctor` has other checks for a project with no
 * install command, for one that is not a repository, and for a Git that cannot answer, and
 * a second voice saying the same thing is noise.
 */
export function renderInstallProbe(probe: InstallProbe): string[] {
  switch (probe.outcome) {
    case 'skipped':
      return [];
    case 'dirty_before':
      return [
        'Install probe',
        `  ${CROSS} a fresh checkout of this repository is not clean before installing`,
        ...probe.entries.map((path) => `      ${path}`),
        '  Worktree mode refuses a task whose checkout is dirty (phase: checkout).',
        '',
      ];
    case 'install_failed':
      return [
        'Install probe',
        `  ${CROSS} \`${probe.command}\` failed in a fresh checkout`,
        '  Worktree mode runs it before every task, so every task would fail here.',
        '',
      ];
    case 'clean':
      return ['Install probe', `  ${TICK} \`${probe.command}\` leaves a fresh checkout clean`, ''];
    case 'dirties_checkout':
      return [
        'Install probe',
        `  ${CROSS} \`${probe.command}\` modifies files that are tracked or not ignored:`,
        ...probe.entries.map((path) => `      ${path}`),
        '  Worktree mode will refuse every task in this project (phase: setup).',
        '  Use a lockfile-respecting install — for npm, `commands.install: npm ci`.',
        '',
      ];
  }
}

function renderTool(tool: ToolCheck): string {
  const name = tool.name === 'node' ? 'Node' : 'Git';
  const version =
    tool.version === undefined
      ? undefined
      : tool.floor === undefined
        ? tool.version
        : tool.belowFloor === true
          ? `${tool.version}  ⚠ below the ${tool.floor} worktree-mode floor`
          : `${tool.version}  (worktree mode needs ${tool.floor} or newer)`;

  return `${name}\n  installed          ${tool.present ? TICK : CROSS}${
    version ? `\n  version            ${version}` : ''
  }`;
}

/**
 * Reports whether credentials exist, never what they are. Nothing here reads
 * or echoes the contents of an auth file (§7.1).
 */
function renderAuth(auth: ObservedRunnerReport['auth']): string {
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

/**
 * The last line on screen, and the only one most readers keep.
 *
 * A bare `OK` has to mean what it says, and on a shallow check it does not: authentication
 * is never probed, so a run started from an `OK` can die on its first model call — after
 * discovery has already read the repository. Measured on a live run.
 *
 * `assessHealth` refuses to call that DEGRADED, and is right to: "we did not check" would
 * be true on every healthy machine, and a DEGRADED that is always on is worth nothing. So
 * the status is unchanged and the sentence stops overstating it. Anything other than a
 * clean `OK` is left exactly as it was — a FAIL needs no softening.
 */
export function renderVerdict(verdict: { readonly status: string; readonly notes: readonly string[] }): string {
  return verdict.status === 'OK' && verdict.notes.length > 0
    ? 'OK — nothing here blocks a run, but see the note above'
    : verdict.status;
}
