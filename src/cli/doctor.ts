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
import { describeRoleRoutes, type RoleRoute } from '../app/role-routes.js';
import { PromptLoader } from '../app/prompt-loader.js';
import { resolvePromptsDir } from '../app/prompt-paths.js';
import {
  capabilitiesOf,
  permissionReadiness,
  type PermissionFinding,
  type RunnerCapabilitiesMap,
} from '../core/role.js';
import { NodeHost } from '../adapters/host/node-host.js';
import { createGitCommand } from '../adapters/git/git-command.js';
import { runCommands } from '../app/verification-commands.js';
import { compareReasoning } from '../core/reasoning.js';
import {
  ALL_WORKFLOW_ROLES,
  roleConfigOf,
  type EffectiveConfig,
  type GlobalConfig,
  type ReasoningLevel,
  type WorkflowRole,
} from '../contracts/index.js';
import {
  createGitWorkspaces,
  MINIMUM_SUPPORTED_GIT_VERSION,
  compareGitVersions,
  formatGitVersion,
} from '../adapters/git/git-workspaces.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { fileURLToPath } from 'node:url';
import { renderError } from './render/errors.js';
import { renderStageRouting, renderUnusedRunners } from './render/routing.js';
import type { GlobalOptions } from './index.js';
import type { FileSystem } from '../ports/file-system.js';
import type { Host } from '../ports/host.js';
import type { ProcessRunner } from '../ports/process-runner.js';

export interface DoctorOptions {
  /** Runs a real prompt against each runner. Opt-in: it consumes quota. */
  readonly deep?: boolean;
}

const TICK = '✓';
const CROSS = '✗';
const DASH = '·';
const WARN = '⚠';

/**
 * What one role's configured (runner, model) pair can actually do (AR-01).
 *
 * Every field here is read from declarations and configuration — no process is spawned and
 * no quota is spent. That is the whole point: the configuration that cost the AF-2026-002
 * dogfood a task attempt was visibly wrong on disk, and nothing looked at it.
 */
export type CapabilityObservation =
  | {
      readonly kind: 'resolved';
      readonly role: WorkflowRole;
      readonly runner: string;
      readonly model?: string;
      /** What the role's `effort` asks for. */
      readonly requestedReasoning: ReasoningLevel;
      /** What the pair would actually be invoked at. */
      readonly effectiveReasoning: ReasoningLevel;
      readonly supportedReasoningLevels: readonly ReasoningLevel[];
      readonly reasoningClamped: boolean;
      /** What this role's prompts declare, read from the prompts rather than assumed. */
      readonly permissions: 'read-only' | 'write';
      /** Present when a write role's runner cannot exercise a tool class it needs (C-04). */
      readonly permissionFinding?: PermissionFinding;
    }
  | {
      /**
       * The role cannot be resolved at all: its runner is unknown, disabled, or cannot do
       * something the role's prompts require.
       *
       * A distinct variant rather than an optional field, so the renderer has to handle it.
       * The first version of this section skipped these roles on the assumption that
       * `assessHealth` already reported them — it does not. That function asks whether the
       * *runner* is usable (installed, authenticated); this asks whether the runner can do
       * what the role needs. A perfectly healthy CLI with no read-only mode fails the
       * second question and passes the first, and the result was a role that vanished from
       * the report under an `OK` verdict.
       */
      readonly kind: 'unresolvable';
      readonly role: WorkflowRole;
      readonly runner: string;
      readonly model?: string;
      readonly requestedReasoning: ReasoningLevel;
      /** `RoleResolutionErrorKind` — `unknown_runner`, `runner_disabled`, `missing_capability`. */
      readonly errorKind: string;
      readonly reason: string;
    };

/**
 * Reads what each role's pair declares, mechanically (AR-01).
 *
 * Every configured role produces exactly one observation, including the ones that cannot
 * run. Silence about a role is the one answer this section may never give.
 */
export function observeCapabilities(
  routes: readonly RoleRoute[],
  capabilities: RunnerCapabilitiesMap,
): CapabilityObservation[] {
  const observations: CapabilityObservation[] = [];

  for (const route of routes) {
    const resolved = route.resolved;

    if (resolved === undefined) {
      observations.push({
        kind: 'unresolvable',
        role: route.role,
        runner: route.configured.runner,
        ...(route.configured.model === undefined ? {} : { model: route.configured.model }),
        requestedReasoning: route.configured.reasoning,
        errorKind: route.error?.kind ?? 'unknown',
        reason: route.error?.message ?? 'the configured runner could not be resolved',
      });
      continue;
    }

    const declared = capabilitiesOf(capabilities, resolved.runner, resolved.model);
    if (declared === undefined) continue;

    // Read from the prompts, exactly as `StageRunner` reads them. A table here would be a
    // second opinion, and the two would eventually disagree.
    const permissions = route.requirements.readOnly === true ? 'read-only' : 'write';

    observations.push({
      kind: 'resolved',
      role: route.role,
      runner: resolved.runner,
      ...(resolved.model === undefined ? {} : { model: resolved.model }),
      requestedReasoning: route.configured.reasoning,
      effectiveReasoning: resolved.reasoning,
      supportedReasoningLevels: declared.supportedReasoningLevels,
      reasoningClamped: resolved.reasoningClamped,
      permissions,
      ...(() => {
        const finding = permissionReadiness({
          capabilities: declared,
          permissions,
          runner: resolved.runner,
          ...(resolved.model === undefined ? {} : { model: resolved.model }),
        });
        return finding === undefined ? {} : { permissionFinding: finding };
      })(),
    });
  }

  return observations;
}

/**
 * The roles that cannot run, by name.
 *
 * Separate from the rendering so the command can turn them into a verdict. A role that
 * cannot resolve is not a degradation to work around — the stage it serves dies every
 * time it is reached — so it fails the check outright.
 */
export function unresolvableRoles(
  observations: readonly CapabilityObservation[],
): WorkflowRole[] {
  return observations
    .filter((observation) => observation.kind === 'unresolvable')
    .map((observation) => observation.role);
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
    // Through the wrapper, not through `checkTool`. `git --version` runs no
    // hooks and could not have hurt anything, but "only one module spawns git"
    // (§26.1 rule 1) is worth exactly as much as its least-defended exception,
    // and a probe is the easiest place for the next one to appear.
    const host = new NodeHost();
    const git = await checkGit(processRunner, fs, host.homeDir);
    lines.push(renderTool('Node', node), renderTool('Git', git), '');

    // §8.4, before a run rather than after. The default Node install rewrites
    // `package-lock.json` when the lock drifts from `package.json`, which is a
    // tracked modification, which fails the post-setup cleanliness assertion,
    // which refuses every task in worktree mode. That is the gate working
    // correctly and it is also a wall most Node projects walk into on their
    // first run, so it is worth one throwaway checkout to say so in advance.
    // Announced before it runs, because it is the slowest thing `doctor` does by
    // an order of magnitude: a throwaway checkout plus the project's own install
    // command. Measured on a Vue project, it spent minutes with zero bytes of
    // output and was taken for a hang and killed. Everything else here buffers
    // into `lines` and prints at the end, which is right for fast checks and
    // wrong for this one.
    const installCommand = config.project?.commands?.install;
    if (installCommand !== undefined) {
      process.stdout.write(`  → probing install (\`${installCommand}\` in a fresh checkout)…\n`);
    }

    for (const line of await probeInstallCleanliness({
      fs,
      processRunner,
      config,
      projectDir: globals.cwd,
      host,
    })) {
      lines.push(line);
    }

    const registry = buildRegistry(config.global, {
      processRunner,
      fs,
      env: (name) => process.env[name],
    });
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

    // ---- Mechanical capability discovery (AR-01). Free: it reads what the adapters
    // declare for each role's configured (runner, model) pair and compares it with what
    // the role asks for. This is the check whose absence let a `medium` effort reach a
    // model that offers only `low` and `high`, at the cost of a task attempt.
    const routes = await describeRoleRoutes({
      config: config.global,
      capabilities: registry.capabilities(),
      promptLoader: new PromptLoader({ fs, promptsDir: resolvePromptsDir() }),
    });
    const capabilityReport = observeCapabilities(routes, registry.capabilities());
    for (const line of renderCapabilityReport(capabilityReport)) lines.push(line);

    // The capability report is by role, which is how configuration is written.
    // These two are by stage and by runner, which is how routing actually lands —
    // see `render/routing.ts` for why the two views disagree.
    const promptsDir = fileURLToPath(new URL('../../prompts', import.meta.url));
    lines.push('', ...renderStageRouting(config.global, promptsDir));
    const unused = renderUnusedRunners(config.global);
    if (unused.length > 0) lines.push('', ...unused);

    // ---- Live probe, only when asked for. It spends quota on every runner,
    // which is the entire reason the shallow check exists as the default.
    const probes =
      options.deep === true
        ? await probeAll(registry, shallow, globals.cwd, effortsByRunner(config.global))
        : [];
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

    const verdict = assessHealth(config.global, observed);

    // A capability gap is not a health question, and `assessHealth` is right not to answer
    // it: that function asks whether each runner is *usable* — installed, executable,
    // authenticated — and a runner can be all three and still be unable to do what a role
    // needs. Pointing a read-only stage at a CLI with no read-only mode produced a healthy
    // runner, a role that could never run, and an `OK` verdict.
    const cannotRun = unresolvableRoles(capabilityReport);

    if (verdict.orphanRoles.length > 0) {
      lines.push('Roles with nowhere to run:');
      for (const role of verdict.orphanRoles) {
        const route = verdict.routes.find((candidate) => candidate.role === role);
        lines.push(`  ${CROSS} ${role} → "${route?.primary ?? '?'}" is unusable and has no fallback`);
      }
      lines.push('');
    }

    if (cannotRun.length > 0) {
      lines.push(
        'Roles whose configuration cannot run:',
        ...cannotRun.map((role) => `  ${CROSS} ${role} — see Capabilities above`),
        '',
        '  These are configuration errors, not degradations: the stage fails on contact,',
        '  every time. Point the role at a runner that can do what its prompts require.',
        '',
      );
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

    const remediations = generateRemediations(observed, verdict, node, git);
    if (remediations.length > 0) {
      lines.push('Remediation:');
      for (const rem of remediations) {
        lines.push(`  → ${rem.problem}`);
        lines.push(`    Fix: ${rem.fix}`);
      }
      lines.push('');
    }

    // A role that cannot resolve fails the check outright, whatever the runners' health
    // says. `assessHealth` never sees this fault, so the verdict is widened here rather
    // than misreported there.
    const status = cannotRun.length > 0 ? 'FAIL' : verdict.status;
    lines.push(renderVerdict({ status, notes: verdict.notes }));

    if (status === 'DEGRADED' && !globals.strict) {
      lines.push('');
      lines.push('Work is still possible. Use --strict to treat this as a failure in CI.');
    }

    process.stdout.write(`${lines.join('\n')}\n`);

    if (globals.json) {
      process.stdout.write(
        `${JSON.stringify({ ...verdict, status, unresolvableRoles: cannotRun, probes }, null, 2)}\n`,
      );
    }

    if (status === 'FAIL') return ExitCode.EXECUTION_ERROR;
    if (status === 'DEGRADED' && globals.strict) return ExitCode.DEGRADED_STRICT;
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
  efforts: ReadonlyMap<string, readonly ReasoningLevel[]>,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];

  for (const runner of observed) {
    if (!runner.installed || !runner.executable) continue;
    if (!registry.has(runner.id)) continue;

    results.push(
      await probeRunner(registry.get(runner.id), {
        workingDirectory,
        // Every effort this configuration would actually ask for (AR-01). The old probe
        // used the cheapest level the runner supported, so a pair that could not do
        // `medium` looked perfectly healthy right up until a task tried it.
        efforts: efforts.get(runner.id) ?? [],
        // And a question that cannot be answered without a tool — read-only, and never
        // escalated. Non-interactive is not the same as permitted, and the difference is
        // what the evidence run spent an attempt discovering.
        toolUse: true,
      }),
    );
  }

  return results;
}

/**
 * The distinct efforts each runner is configured to be asked for.
 *
 * From the configuration rather than from the runner's declared set: probing a level no
 * role uses spends quota to learn nothing, and probing only the cheapest one — which is
 * what happened before — learns nothing about the level that breaks.
 */
function effortsByRunner(config: GlobalConfig): Map<string, readonly ReasoningLevel[]> {
  const byRunner = new Map<string, Set<ReasoningLevel>>();

  for (const role of ALL_WORKFLOW_ROLES) {
    const roleConfig = roleConfigOf(config.roles, role);
    const existing = byRunner.get(roleConfig.runner) ?? new Set<ReasoningLevel>();
    existing.add(roleConfig.effort);
    byRunner.set(roleConfig.runner, existing);
  }

  return new Map(
    [...byRunner].map(([id, levels]) => [
      id,
      // Cheapest first, so a runner that is simply broken fails on the cheap call.
      [...levels].sort((a, b) => compareReasoning(a, b)),
    ]),
  );
}

interface ToolStatus {
  readonly present: boolean;
  readonly version?: string;
}

/**
 * Git's version, read through the one wrapper that may spawn it.
 *
 * Reports the floor alongside the installed version so the answer to "is my Git
 * new enough for worktree mode" is on the same screen as the version itself
 * (§23). It is **information, not a gate**: M2-02 pins the floor and offers the
 * probe, and M2-03 is the milestone that turns a version below it into
 * `git_version_unsupported` on a run.
 */
/**
 * Does the configured install leave a fresh checkout clean? (§8.4)
 *
 * Diagnostic only: it reports and **never edits configuration**. A warning here
 * is the difference between "worktree mode refused every task and I do not know
 * why" and one line naming the file the install rewrote.
 *
 * Runs in a throwaway worktree under Agent Flow's own root — never in the user's
 * working tree — and removes it afterwards. That removal is the *only* one in
 * this milestone: a **failed attempt's** worktree is retained for diagnosis
 * (§7.4), and this one holds nothing anybody needs.
 *
 * Silent unless there is something to say. Nothing is reported for a project
 * with no install command, for one that is not a repository, or for a Git that
 * cannot answer — `doctor` has other checks for all three, and a second voice
 * saying the same thing is noise.
 */
export async function probeInstallCleanliness(options: {
  fs: FileSystem;
  processRunner: ProcessRunner;
  config: EffectiveConfig;
  projectDir: string;
  host: Host;
}): Promise<string[]> {
  const install = options.config.project?.commands?.install;
  if (install === undefined || install.trim().length === 0) return [];

  const homeDir = options.host.homeDir;
  const git = await createGitCommand({
    processRunner: options.processRunner,
    fs: options.fs,
    homeDir,
  });
  const workspaces = await createGitWorkspaces({ git, fs: options.fs, homeDir });

  const head = await workspaces.resolveHead(options.projectDir);
  if (!head.ok || head.value === null) return [];

  // A single segment under the owned root, named so it cannot collide with a
  // run's workspace. Flat on purpose: `git worktree remove` deletes the worktree
  // directory and not its parent, so a nested layout would leave an empty
  // directory behind on every `doctor`.
  // Through the `Host` port rather than `process.pid`, for the reason the port's
  // own doc-comment gives: a use case that reads the process table directly is a
  // use case a test cannot pin down.
  const probeDirectory = `doctor-install-probe-pid-${String(options.host.pid)}`;
  const location = { segments: [probeDirectory], relativePath: probeDirectory };

  const added = await workspaces.addWorktree({
    cwd: options.projectDir,
    location,
    base: head.value,
    reason: 'agent-flow doctor install probe',
  });
  if (!added.ok) return [];

  try {
    const before = await workspaces.status({ cwd: added.value });
    if (!before.ok) return [];
    if (!before.value.clean) {
      return [
        'Install probe',
        `  ${CROSS} a fresh checkout of this repository is not clean before installing`,
        ...before.value.entries.slice(0, 5).map((entry) => `      ${entry.path}`),
        '  Worktree mode refuses a task whose checkout is dirty (phase: checkout).',
        '',
      ];
    }

    const ran = await runCommands({
      processRunner: options.processRunner,
      commands: [install],
      cwd: added.value,
    });
    if (!ran.passed) {
      return [
        'Install probe',
        `  ${CROSS} \`${install}\` failed in a fresh checkout`,
        '  Worktree mode runs it before every task, so every task would fail here.',
        '',
      ];
    }

    const after = await workspaces.status({ cwd: added.value });
    if (!after.ok) return [];
    if (after.value.clean) {
      return ['Install probe', `  ${TICK} \`${install}\` leaves a fresh checkout clean`, ''];
    }

    return [
      'Install probe',
      `  ${CROSS} \`${install}\` modifies files that are tracked or not ignored:`,
      ...after.value.entries.slice(0, 5).map((entry) => `      ${entry.path}`),
      '  Worktree mode will refuse every task in this project (phase: setup).',
      '  Use a lockfile-respecting install — for npm, `commands.install: npm ci`.',
      '',
    ];
  } finally {
    // The probe's own worktree, and only it. Unlocked first because it was
    // created locked, and removed through Git rather than with `rm -rf` (§20.2).
    //
    // Forced, and this is the one place in the milestone where that is right.
    // The probe's whole job is to find out whether the install dirties a fresh
    // checkout, so on the path that matters it has *just made one dirty* — and
    // Git refuses to reclaim a worktree holding a modified tracked file or an
    // untracked non-ignored one. Without `force` a `doctor` run would leak a
    // worktree every time it had something to warn about. Nothing here is
    // evidence: the report already names the changed paths, and a *failed
    // attempt's* worktree is retained precisely because it is evidence (§7.4).
    await workspaces.unlockWorktree({ cwd: options.projectDir, location });
    await workspaces.removeWorktree({ cwd: options.projectDir, location, force: true });
  }
}

async function checkGit(
  processRunner: ProcessRunner,
  fs: FileSystem,
  homeDir: string,
): Promise<ToolStatus> {
  const git = await createGitCommand({ processRunner, fs, homeDir });
  const workspaces = await createGitWorkspaces({ git, fs, homeDir });

  const version = await workspaces.version(process.cwd());
  if (!version.ok) return { present: false };

  const floor = formatGitVersion(MINIMUM_SUPPORTED_GIT_VERSION);
  const supported = compareGitVersions(version.value, MINIMUM_SUPPORTED_GIT_VERSION) >= 0;

  return {
    present: true,
    version: supported
      ? `${version.value.raw}  (worktree mode needs ${floor} or newer)`
      : `${version.value.raw}  ⚠ below the ${floor} worktree-mode floor`,
  };
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

export interface DoctorRemediation {
  readonly problem: string;
  readonly fix: string;
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

export function generateRemediations(
  observed: readonly ObservedRunner[],
  _verdict: ReturnType<typeof assessHealth>,
  node: ToolStatus,
  git: ToolStatus,
): DoctorRemediation[] {
  const remediations: DoctorRemediation[] = [];

  if (!node.present) {
    remediations.push({
      problem: 'Node.js is missing from PATH',
      fix: 'Install Node.js 20+ (https://nodejs.org or via fnm/nvm)',
    });
  }

  if (!git.present) {
    remediations.push({
      problem: 'Git is missing or older than 2.38',
      fix: 'Install Git 2.38+ (https://git-scm.com or via your package manager)',
    });
  }

  for (const runner of observed) {
    if (!runner.installed || !runner.executable) {
      const guide = getRunnerInstallGuide(runner.id);
      if (guide) {
        remediations.push({
          problem: `Runner "${runner.id}" is not installed or executable`,
          fix: guide,
        });
      }
    } else if (runner.auth === 'not_configured') {
      const guide = getRunnerAuthGuide(runner.id);
      if (guide) {
        remediations.push({
          problem: `Runner "${runner.id}" is missing credentials`,
          fix: guide,
        });
      }
    }
  }

  return remediations;
}

function getRunnerInstallGuide(runnerId: string): string | undefined {
  switch (runnerId) {
    case 'claude':
      return 'npm install -g @anthropic-ai/claude-code';
    case 'codex':
      return 'npm install -g @openai/codex';
    case 'cursor':
      return 'Install Cursor CLI and ensure `cursor` is available in PATH';
    case 'agy':
      return 'curl -fsSL https://antigravity.run/install.sh | bash';
    default:
      return undefined;
  }
}

function getRunnerAuthGuide(runnerId: string): string | undefined {
  switch (runnerId) {
    case 'claude':
      return 'Run `claude login` or export ANTHROPIC_API_KEY';
    case 'codex':
      return 'Run `codex login` or export OPENAI_API_KEY';
    case 'cursor':
      return 'Run `cursor auth login` in your terminal';
    case 'agy':
      return 'Run `agy auth login` or export ANTIGRAVITY_API_KEY';
    default:
      return undefined;
  }
}
