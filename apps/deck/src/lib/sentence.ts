import type { RunEvent } from '@contracts/index.js';
import { formatDuration, ms } from './time';
import { word, type Dictionary } from './i18n';
import { taskTone, type Tone } from './tone';

/**
 * One audit line, said in a sentence.
 *
 * Presentation only: the words are chosen from the fields the line already carries, and a
 * line whose type this file does not know is rendered from its type name and its scalar
 * fields rather than dropped. Nothing here infers anything the line did not say.
 *
 * **The dictionary is an argument**, for the reason `time.ts` takes one: this is a pure
 * fold over a log, and a module-level locale would make it a function of when it ran.
 * It also puts the sentences where the language is — `TASK-004 concluída` agrees with a
 * noun that a `${task} ${status}` template cannot see.
 */
export interface Sentence {
  readonly title: string;
  readonly detail?: string | undefined;
  readonly tone: Tone;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

function clip(value: string | undefined, max = 160): string | undefined {
  if (value === undefined) return undefined;
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function joined(parts: (string | undefined)[], separator = ' · '): string | undefined {
  const present = parts.filter((part): part is string => part !== undefined && part !== '');
  return present.length === 0 ? undefined : present.join(separator);
}

function scalarsOf(detail: Record<string, unknown>): string | undefined {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      pairs.push(`${key}: ${clip(String(value), 60) ?? ''}`);
    }
    if (pairs.length === 4) break;
  }
  return pairs.length === 0 ? undefined : pairs.join(' · ');
}

export function describe(event: RunEvent, t: Dictionary): Sentence {
  const d = event.detail;
  const e = t.events;
  const task = text(d['task']) ?? text(d['taskId']);
  const named = task ?? e.aTask;
  const stage = word(t, text(d['stage']));

  switch (event.type) {
    case 'run_created':
      return { title: e.runCreated, detail: clip(text(d['feature'])), tone: 'idle' };
    case 'run_git_identity_assigned':
      return {
        title: e.gitIdentityAssigned,
        detail: joined([
          text(d['isolationMode']) === undefined ? undefined : e.isolation(word(t, text(d['isolationMode']))),
          text(d['planningBase'])?.slice(0, 10),
        ]),
        tone: 'idle',
      };
    case 'workflow_classified':
      return { title: e.classifiedAs(text(d['workflow']) ?? e.aWorkflow), detail: clip(text(d['rationale'])), tone: 'idle' };
    case 'discovery_cache_invalidated':
      return {
        title: e.discoveryCacheInvalidated,
        detail: Array.isArray(d['changed']) ? (d['changed'] as unknown[]).map(String).join(', ') : undefined,
        tone: 'idle',
      };
    case 'stage_started':
      return {
        title: e.stageStarted(stage),
        detail: joined([text(d['role']), text(d['runner']), text(d['model']), text(d['reasoning'])]),
        tone: 'live',
      };
    case 'stage_output_received':
      return { title: e.stageAnswered(stage), detail: joined([text(d['runner']), text(d['model'])]), tone: 'live' };
    case 'stage_completed': {
      const started = ms(text(d['startedAt']));
      const finished = ms(text(d['finishedAt'])) ?? ms(event.at);
      const duration = started !== undefined && finished !== undefined ? formatDuration(finished - started) : undefined;
      const repairs = num(d['repairs']) ?? num(d['attempts']);
      return {
        title: e.stageCompleted(stage),
        detail: joined([
          duration,
          text(d['runner']),
          text(d['model']),
          repairs !== undefined && repairs > 0 ? e.repairs(repairs) : undefined,
        ]),
        tone: 'ok',
      };
    }
    case 'stage_failed': {
      const problems = Array.isArray(d['problems']) ? (d['problems'] as unknown[]).map(String) : [];
      return { title: e.stageFailed(stage), detail: clip(problems[0] ?? text(d['errorCode']) ?? text(d['reason'])), tone: 'bad' };
    }
    case 'stage_reused':
      return { title: e.stageReused(stage), detail: word(t, text(d['reason'])), tone: 'ghost' };
    case 'stage_context_measured': {
      const bytes = num(d['totalBytes']);
      return {
        title: e.stageContextMeasured(stage),
        detail: joined([
          bytes === undefined ? undefined : e.kilobytes((bytes / 1024).toFixed(1)),
          d['overCeiling'] === true ? e.overTheCeiling : undefined,
        ]),
        tone: d['overCeiling'] === true ? 'warn' : 'ghost',
      };
    }
    case 'task_started':
      return { title: e.taskStarted(named), detail: text(d['role']), tone: 'live' };
    case 'task_finished': {
      const status = text(d['status']);
      const validation = d['validationPassed'];
      return {
        title: e.taskFinished(named, status),
        detail: joined([
          text(d['runner']),
          typeof validation === 'boolean' ? (validation ? e.validationPassed : e.validationFailed) : undefined,
        ]),
        tone: taskTone(status),
      };
    }
    case 'task_interrupted':
      return {
        title: e.taskInterrupted(named),
        detail: joined([
          clip(text(d['reason'])),
          d['requeued'] === true ? e.requeuedYes : d['requeued'] === false ? e.requeuedNo : undefined,
        ]),
        tone: 'bad',
      };
    case 'task_assigned':
      return {
        title: e.taskAssigned(named, text(d['agentName']) ?? text(d['agent']) ?? text(d['agentId']) ?? e.anAgent),
        detail: clip(text(d['reason']) ?? text(d['detail'])),
        tone: 'idle',
      };
    case 'reviewer_assigned':
      return { title: e.reviewerAssigned(named, text(d['reviewerName']) ?? text(d['reviewer']) ?? e.assigned), tone: 'idle' };
    case 'task_workspace_created':
    case 'workspace_prepared':
      return { title: e.workspaceReady(named), tone: 'idle' };
    case 'task_workspace_preparation_failed':
      return { title: e.workspaceFailed(named), detail: clip(text(d['reason']) ?? text(d['error'])), tone: 'bad' };
    case 'task_attempt_validated':
      return {
        title: e.attemptValidated(named),
        detail: num(d['attempt']) === undefined ? undefined : e.attemptN(num(d['attempt']) ?? 0),
        tone: 'ok',
      };
    case 'task_attempt_marker_created':
      return { title: e.markerWritten(named), tone: 'ok' };
    case 'task_integrated':
      return { title: e.taskIntegrated(named), detail: text(d['mergeCommit'])?.slice(0, 10), tone: 'ok' };
    case 'task_requeued':
      return { title: e.taskRequeued(named), detail: d['forced'] === true ? e.forcedByAPerson : undefined, tone: 'idle' };
    case 'task_unblocked':
      return { title: e.taskUnblocked(named), detail: word(t, text(d['reason'])), tone: 'idle' };
    case 'recovery_started':
      return { title: e.recoveryStarted(named, word(t, text(d['step']))), detail: clip(text(d['reason'])), tone: 'warn' };
    case 'recovery_step_completed':
      return { title: e.recoveryStep(named, word(t, text(d['step'])), word(t, text(d['outcome']))), tone: 'warn' };
    case 'failure_context_built':
      return {
        title: e.failureContextBuilt(named),
        detail: joined([
          word(t, text(d['failureClass'])),
          num(d['attempt']) === undefined ? undefined : e.forAttempt(num(d['attempt']) ?? 0),
        ]),
        tone: 'warn',
      };
    case 'recovery_exhausted':
      return { title: e.recoveryExhausted(named), detail: clip(text(d['humanAction']) ?? text(d['reason'])), tone: 'bad' };
    case 'corrective_task_created':
      return {
        title: e.correctiveCreated(task ?? e.aCorrectiveTask),
        detail: clip(text(d['reason']) ?? text(d['findingType'])),
        tone: 'warn',
      };
    case 'corrective_plan_created':
      return {
        title: e.correctivePlanCreated,
        detail: num(d['taskCount']) === undefined ? undefined : e.taskCount(num(d['taskCount']) ?? 0),
        tone: 'warn',
      };
    case 'corrective_envelope_evaluated':
      return { title: e.correctiveEnvelope, detail: word(t, text(d['verdict']) ?? text(d['outcome'])), tone: 'idle' };
    case 'finding_raised':
      return {
        title: e.findingOn(task ?? e.theChange, text(d['severity']) === undefined ? e.noted : word(t, text(d['severity']))),
        detail: clip(text(d['description']) ?? text(d['title'])),
        tone: 'warn',
      };
    case 'review_started':
      return { title: e.reviewStarted(task ?? e.theChangeShort), detail: text(d['reviewerName']) ?? text(d['reviewer']), tone: 'live' };
    case 'review_completed':
      return {
        title: e.reviewCompleted(task ?? e.theChangeShort, word(t, text(d['verdict']) ?? text(d['status']))),
        detail: num(d['findings']) === undefined ? undefined : e.findingCount(num(d['findings']) ?? 0),
        tone: 'idle',
      };
    case 'quality_gate_evaluated': {
      const status = text(d['status']);
      return {
        title: e.gateEvaluated(text(d['gate']) ?? text(d['name']) ?? '', word(t, status)),
        detail: clip(text(d['detail'])),
        tone: status === 'passed' ? 'ok' : status === 'failed' ? 'bad' : 'idle',
      };
    }
    case 'run_approved':
      return {
        title: d['forced'] === true ? e.planApprovedForced : e.planApproved,
        detail: joined([num(d['taskCount']) === undefined ? undefined : e.taskCount(num(d['taskCount']) ?? 0), text(d['planHash'])]),
        tone: d['forced'] === true ? 'warn' : 'ok',
      };
    case 'run_rejected':
      return { title: e.planRejected, detail: clip(text(d['reason'])), tone: 'bad' };
    case 'revision_requested':
      return { title: e.revisionRequested(num(d['attemptedRevision'])), detail: clip(text(d['instruction'])), tone: 'warn' };
    case 'revision_completed':
      return { title: e.revisionCompleted(num(d['revisionCount'])), tone: 'ok' };
    case 'planning_refused':
      return { title: e.planningRefused, detail: clip(text(d['reason'])), tone: 'bad' };
    case 'planning_repair_requested': {
      const problems = Array.isArray(d['problems']) ? (d['problems'] as unknown[]).map(String) : [];
      return { title: e.planningRepair(num(d['repair']), num(d['maxRepairs'])), detail: clip(problems[0]), tone: 'warn' };
    }
    case 'degradation_detected':
      return { title: e.degraded(word(t, text(d['kind']))), detail: clip(text(d['reason'])), tone: 'warn' };
    case 'execution_lock_acquired':
      return { title: e.lockTaken(text(d['operation'])), detail: text(d['owner']), tone: 'ghost' };
    case 'execution_lock_released':
      return { title: e.lockReleased(text(d['operation'])), tone: 'ghost' };
    case 'worktree_mode_refused':
      return { title: e.worktreeModeRefused, detail: clip(text(d['reason'])), tone: 'warn' };
    case 'integration_branch_created':
      return { title: e.integrationBranchCreated, detail: text(d['branch']), tone: 'idle' };
    case 'wave_deferred_for_ownership':
    case 'wave_deferred_for_capacity':
      return {
        title: e.waveDeferred(named, word(t, event.type.replace('wave_deferred_for_', ''))),
        detail: clip(text(d['detail']) ?? text(d['reason'])),
        tone: 'idle',
      };
    case 'collaboration_outbox_refused':
      return { title: e.collaborationRefused, detail: clip(text(d['reason'])), tone: 'warn' };
    default:
      if (event.type.startsWith('forge_')) {
        return {
          title: e.forge(word(t, event.type.replace(/^forge_/, ''))),
          detail: joined([
            text(d['url']),
            text(d['branch']),
            num(d['number']) === undefined ? undefined : `#${String(num(d['number']))}`,
          ]),
          tone: /fail|refus|diverg|red/.test(event.type) ? 'bad' : 'idle',
        };
      }
      // A line this file has never seen. Its type, in whatever words the table has, and
      // its scalars — which is more than dropping it and more honest than guessing.
      return { title: word(t, event.type), detail: scalarsOf(d), tone: 'ghost' };
  }
}
