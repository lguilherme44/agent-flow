import type { RunEvent } from '@contracts/index.js';
import { formatDuration, ms } from './time';
import { taskTone, words, type Tone } from './tone';

/**
 * One audit line, said in a sentence.
 *
 * Presentation only: the words are chosen from the fields the line already carries, and a
 * line whose type this file does not know is rendered from its type name and its scalar
 * fields rather than dropped. Nothing here infers anything the line did not say.
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

export function describe(event: RunEvent): Sentence {
  const d = event.detail;
  const task = text(d['task']) ?? text(d['taskId']);
  const stage = text(d['stage']);

  switch (event.type) {
    case 'run_created':
      return { title: 'Run created', detail: clip(text(d['feature'])), tone: 'idle' };
    case 'run_git_identity_assigned':
      return {
        title: 'Git identity assigned',
        detail: joined([text(d['isolationMode']) === undefined ? undefined : `${words(text(d['isolationMode']))} isolation`, text(d['planningBase'])?.slice(0, 10)]),
        tone: 'idle',
      };
    case 'workflow_classified':
      return { title: `Classified as ${text(d['workflow']) ?? 'a workflow'}`, detail: clip(text(d['rationale'])), tone: 'idle' };
    case 'discovery_cache_invalidated':
      return { title: 'Discovery cache invalidated', detail: Array.isArray(d['changed']) ? (d['changed'] as unknown[]).map(String).join(', ') : undefined, tone: 'idle' };
    case 'stage_started':
      return {
        title: `${words(stage)} started`,
        detail: joined([text(d['role']), text(d['runner']), text(d['model']), text(d['reasoning'])]),
        tone: 'live',
      };
    case 'stage_output_received':
      return { title: `${words(stage)} answered`, detail: joined([text(d['runner']), text(d['model'])]), tone: 'live' };
    case 'stage_completed': {
      const started = ms(text(d['startedAt']));
      const finished = ms(text(d['finishedAt'])) ?? ms(event.at);
      const duration = started !== undefined && finished !== undefined ? formatDuration(finished - started) : undefined;
      const repairs = num(d['repairs']) ?? num(d['attempts']);
      return {
        title: `${words(stage)} completed`,
        detail: joined([duration, text(d['runner']), text(d['model']), repairs !== undefined && repairs > 0 ? `${String(repairs)} repair${repairs === 1 ? '' : 's'}` : undefined]),
        tone: 'ok',
      };
    }
    case 'stage_failed': {
      const problems = Array.isArray(d['problems']) ? (d['problems'] as unknown[]).map(String) : [];
      return { title: `${words(stage)} failed`, detail: clip(problems[0] ?? text(d['errorCode']) ?? text(d['reason'])), tone: 'bad' };
    }
    case 'stage_reused':
      return { title: `${words(stage)} reused`, detail: words(text(d['reason'])), tone: 'ghost' };
    case 'stage_context_measured': {
      const bytes = num(d['totalBytes']);
      return {
        title: `${words(stage)} context measured`,
        detail: joined([bytes === undefined ? undefined : `${(bytes / 1024).toFixed(1)} KB`, d['overCeiling'] === true ? 'over the ceiling' : undefined]),
        tone: d['overCeiling'] === true ? 'warn' : 'ghost',
      };
    }
    case 'task_started':
      return { title: `${task ?? 'task'} started`, detail: text(d['role']), tone: 'live' };
    case 'task_finished': {
      const status = text(d['status']);
      const validation = d['validationPassed'];
      return {
        title: `${task ?? 'task'} ${words(status) ?? 'finished'}`,
        detail: joined([text(d['runner']), typeof validation === 'boolean' ? (validation ? 'validation passed' : 'validation failed') : undefined]),
        tone: taskTone(status),
      };
    }
    case 'task_interrupted':
      return {
        title: `${task ?? 'task'} interrupted`,
        detail: joined([clip(text(d['reason'])), d['requeued'] === true ? 'requeued' : d['requeued'] === false ? 'not requeued' : undefined]),
        tone: 'bad',
      };
    case 'task_assigned':
      return {
        title: `${task ?? 'task'} → ${text(d['agentName']) ?? text(d['agent']) ?? text(d['agentId']) ?? 'an agent'}`,
        detail: clip(text(d['reason']) ?? text(d['detail'])),
        tone: 'idle',
      };
    case 'reviewer_assigned':
      return { title: `${task ?? 'task'} reviewer: ${text(d['reviewerName']) ?? text(d['reviewer']) ?? 'assigned'}`, tone: 'idle' };
    case 'task_workspace_created':
    case 'workspace_prepared':
      return { title: `${task ?? 'task'} workspace ready`, tone: 'idle' };
    case 'task_workspace_preparation_failed':
      return { title: `${task ?? 'task'} workspace failed`, detail: clip(text(d['reason']) ?? text(d['error'])), tone: 'bad' };
    case 'task_attempt_validated':
      return { title: `${task ?? 'task'} attempt validated`, detail: num(d['attempt']) === undefined ? undefined : `attempt ${String(num(d['attempt']))}`, tone: 'ok' };
    case 'task_attempt_marker_created':
      return { title: `${task ?? 'task'} marker written`, tone: 'ok' };
    case 'task_integrated':
      return { title: `${task ?? 'task'} integrated`, detail: text(d['mergeCommit'])?.slice(0, 10), tone: 'ok' };
    case 'task_requeued':
      return { title: `${task ?? 'task'} requeued`, detail: d['forced'] === true ? 'by a person, forced' : undefined, tone: 'idle' };
    case 'task_unblocked':
      return { title: `${task ?? 'task'} unblocked`, detail: words(text(d['reason'])), tone: 'idle' };
    case 'recovery_started':
      return { title: `${task ?? 'task'}: recovery · ${words(text(d['step']))}`, detail: clip(text(d['reason'])), tone: 'warn' };
    case 'recovery_step_completed':
      return { title: `${task ?? 'task'}: ${words(text(d['step']))} → ${words(text(d['outcome']))}`, tone: 'warn' };
    case 'failure_context_built':
      return { title: `${task ?? 'task'}: failure context built`, detail: joined([words(text(d['failureClass'])), num(d['attempt']) === undefined ? undefined : `for attempt ${String(num(d['attempt']))}`]), tone: 'warn' };
    case 'recovery_exhausted':
      return { title: `${task ?? 'task'}: recovery exhausted`, detail: clip(text(d['humanAction']) ?? text(d['reason'])), tone: 'bad' };
    case 'corrective_task_created':
      return { title: `${task ?? 'a corrective task'} created`, detail: clip(text(d['reason']) ?? text(d['findingType'])), tone: 'warn' };
    case 'corrective_plan_created':
      return { title: 'Corrective plan created', detail: num(d['taskCount']) === undefined ? undefined : `${String(num(d['taskCount']))} tasks`, tone: 'warn' };
    case 'corrective_envelope_evaluated':
      return { title: 'Corrective envelope evaluated', detail: words(text(d['verdict']) ?? text(d['outcome'])), tone: 'idle' };
    case 'finding_raised':
      return { title: `Finding on ${task ?? 'the change'} · ${text(d['severity']) ?? 'noted'}`, detail: clip(text(d['description']) ?? text(d['title'])), tone: 'warn' };
    case 'review_started':
      return { title: `${task ?? 'change'} review started`, detail: text(d['reviewerName']) ?? text(d['reviewer']), tone: 'live' };
    case 'review_completed':
      return { title: `${task ?? 'change'} review · ${words(text(d['verdict']) ?? text(d['status']))}`, detail: num(d['findings']) === undefined ? undefined : `${String(num(d['findings']))} findings`, tone: 'idle' };
    case 'quality_gate_evaluated': {
      const status = text(d['status']);
      return { title: `Gate ${text(d['gate']) ?? text(d['name']) ?? ''} · ${words(status)}`, detail: clip(text(d['detail'])), tone: status === 'passed' ? 'ok' : status === 'failed' ? 'bad' : 'idle' };
    }
    case 'run_approved':
      return {
        title: d['forced'] === true ? 'Plan approved · forced' : 'Plan approved',
        detail: joined([num(d['taskCount']) === undefined ? undefined : `${String(num(d['taskCount']))} tasks`, text(d['planHash'])]),
        tone: d['forced'] === true ? 'warn' : 'ok',
      };
    case 'run_rejected':
      return { title: 'Plan rejected', detail: clip(text(d['reason'])), tone: 'bad' };
    case 'revision_requested':
      return { title: `Revision ${String(num(d['attemptedRevision']) ?? '')} requested`.replace('  ', ' '), detail: clip(text(d['instruction'])), tone: 'warn' };
    case 'revision_completed':
      return { title: `Revision ${String(num(d['revisionCount']) ?? '')} completed`.replace('  ', ' '), tone: 'ok' };
    case 'planning_refused':
      return { title: 'Planning refused', detail: clip(text(d['reason'])), tone: 'bad' };
    case 'planning_repair_requested': {
      const problems = Array.isArray(d['problems']) ? (d['problems'] as unknown[]).map(String) : [];
      return {
        title: `Plan refused by the checks · asking the planner again${num(d['repair']) === undefined ? '' : ` (${String(num(d['repair']))}/${String(num(d['maxRepairs']) ?? '?')})`}`,
        detail: clip(problems[0]),
        tone: 'warn',
      };
    }
    case 'degradation_detected':
      return { title: `Degraded · ${words(text(d['kind']))}`, detail: clip(text(d['reason'])), tone: 'warn' };
    case 'execution_lock_acquired':
      return { title: `Lock taken · ${text(d['operation']) ?? ''}`.trim(), detail: text(d['owner']), tone: 'ghost' };
    case 'execution_lock_released':
      return { title: `Lock released · ${text(d['operation']) ?? ''}`.trim(), tone: 'ghost' };
    case 'worktree_mode_refused':
      return { title: 'Worktree mode refused', detail: clip(text(d['reason'])), tone: 'warn' };
    case 'integration_branch_created':
      return { title: 'Integration branch created', detail: text(d['branch']), tone: 'idle' };
    case 'wave_deferred_for_ownership':
    case 'wave_deferred_for_capacity':
      return { title: `${task ?? 'task'} deferred · ${words(event.type.replace('wave_deferred_for_', ''))}`, detail: clip(text(d['detail']) ?? text(d['reason'])), tone: 'idle' };
    case 'collaboration_outbox_refused':
      return { title: 'Collaboration message refused', detail: clip(text(d['reason'])), tone: 'warn' };
    default:
      if (event.type.startsWith('forge_')) {
        return {
          title: `Forge · ${words(event.type.replace(/^forge_/, ''))}`,
          detail: joined([text(d['url']), text(d['branch']), num(d['number']) === undefined ? undefined : `#${String(num(d['number']))}`]),
          tone: /fail|refus|diverg|red/.test(event.type) ? 'bad' : 'idle',
        };
      }
      return { title: words(event.type), detail: scalarsOf(d), tone: 'ghost' };
  }
}
