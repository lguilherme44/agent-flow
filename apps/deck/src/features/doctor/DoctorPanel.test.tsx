import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DoctorView } from '@contracts/index.js';
import { DoctorPanel } from './DoctorPanel';
import { ptBR as t } from '../../lib/i18n';

/**
 * 7.5 — the answer, on the screen.
 *
 * Every assertion reads the DOM, because the defects this panel is built against were all
 * of that kind: a field the server sent and nobody rendered (`AttentionFocus`), a card
 * wearing a class nobody defined, a count folded into a header. A rule about the source
 * text would have passed straight through all three.
 *
 * The panel decides nothing — `app/diagnostics.ts` does — so what is tested here is that
 * each finding the server can send actually reaches a reader, and that the two findings
 * which must never be shown as fine are not shown as fine.
 */

const REPORT: DoctorView = {
  status: 'OK',
  tools: [
    { name: 'node', present: true, version: 'v22.23.2' },
    { name: 'git', present: true, version: 'git version 2.55.0', floor: '2.33.0', belowFloor: false },
  ],
  install: { outcome: 'clean', command: 'npm ci' },
  capabilities: [
    {
      kind: 'resolved',
      role: 'architect',
      runner: 'agy',
      requestedReasoning: 'high',
      effectiveReasoning: 'high',
      supportedReasoningLevels: ['low', 'medium', 'high'],
      reasoningClamped: false,
      permissions: 'write',
    },
    {
      kind: 'resolved',
      role: 'finalReviewer',
      runner: 'agy',
      requestedReasoning: 'very_high',
      effectiveReasoning: 'high',
      supportedReasoningLevels: ['low', 'medium', 'high'],
      reasoningClamped: true,
      permissions: 'read-only',
    },
  ],
  stageRouting: [
    { stage: 'discovery', role: 'architect', runner: 'agy', runnerType: 'agy-cli', readsRepository: true, overpowered: false },
    { stage: 'sdd', role: 'sdd', runner: 'agy', runnerType: 'agy-cli', readsRepository: false, overpowered: true },
  ],
  unusedRunners: [{ id: 'claude', type: 'claude-code-cli' }],
  runners: [{ id: 'agy', installed: true, executable: true, auth: 'unknown', version: '1.1.28' }],
  probes: [],
  orphanRoles: [],
  degradations: [],
  notes: ['authentication not verified for: agy (use `doctor --deep` to check for real)'],
  unresolvableRoles: [],
  remediations: [],
  readsEnvironment: false,
  remoteAccess: { known: false },
};

const withReport = (over: Partial<DoctorView>): DoctorView => ({ ...REPORT, ...over });

describe('the doctor panel', () => {
  it('leads with the verdict', () => {
    render(<DoctorPanel report={REPORT} />);

    expect(screen.getByText('OK')).toBeTruthy();
  });

  it('does not let a bare OK overstate itself', () => {
    // A shallow check never probes authentication, so a run started from an `OK` can die
    // on its first model call — measured on a live run. The note is the whole point of
    // showing it beside the word rather than below the fold.
    render(<DoctorPanel report={REPORT} />);

    expect(screen.getByText(/authentication not verified/)).toBeTruthy();
  });

  it('names Node and Git with the versions found', () => {
    render(<DoctorPanel report={REPORT} />);

    expect(screen.getByText('v22.23.2')).toBeTruthy();
    expect(screen.getByText('git version 2.55.0')).toBeTruthy();
  });

  it('warns when Git is below the worktree-mode floor', () => {
    render(
      <DoctorPanel
        report={withReport({
          tools: [
            { name: 'node', present: true, version: 'v22.23.2' },
            { name: 'git', present: true, version: 'git version 2.20.0', floor: '2.33.0', belowFloor: true },
          ],
        })}
      />,
    );

    expect(screen.getByText(t.doctor.below('2.33.0'))).toBeTruthy();
  });

  it('reports a clamped effort before it happens', () => {
    // The check whose absence let a `medium` effort reach a model offering only `low` and
    // `high`, at the cost of a task attempt. It is a fact available at configuration time.
    render(<DoctorPanel report={REPORT} />);

    expect(screen.getByText(new RegExp(t.doctor.effortNotOffered(t.levels.very_high, t.levels.high)))).toBeTruthy();
    expect(screen.getByText(t.inspector.clamped)).toBeTruthy();
  });

  it('marks a stage served by more than it needs', () => {
    render(<DoctorPanel report={REPORT} />);

    expect(screen.getByText(new RegExp(t.doctor.overpoweredNote))).toBeTruthy();
    expect(screen.getByText(t.doctor.overServed)).toBeTruthy();
  });

  it('names a runner that is configured and routed nowhere', () => {
    // Configuring one is not enough — a role has to point at it — and nothing said so:
    // the runner simply did not appear, which reads as a broken configuration.
    render(<DoctorPanel report={REPORT} />);

    expect(screen.getByText(t.doctor.routedNowhere('claude'))).toBeTruthy();
  });

  it('qualifies auth rather than repeating an answer the server could not know', () => {
    // §93: the server reads no credential, so a runner keyed by an environment variable
    // answers 401 to a health check made without it. Reporting that as a finding would
    // send somebody to fix credentials that are already in place.
    render(<DoctorPanel report={REPORT} />);

    expect(screen.getByText(t.doctor.envNotChecked)).toBeTruthy();
  });

  it('offers the install probe rather than waiting for it', async () => {
    // The page found this, and the page is where it matters: everything else here answers
    // in under a second, and one check that takes minutes was holding all of it hostage.
    const onRun = vi.fn();
    render(
      <DoctorPanel
        report={withReport({ install: { outcome: 'skipped', reason: 'not_requested' } })}
        onRunInstallProbe={onRun}
      />,
    );

    expect(screen.getByLabelText(t.doctor.installProbe).textContent).toContain(t.doctor.probeNotRun);
    fireEvent.click(screen.getByRole('button', { name: t.doctor.runProbe }));
    expect(onRun).toHaveBeenCalledOnce();
  });

  it('says nothing about the install probe when it was skipped', () => {
    // The positive control for the case above: the same panel, one field different, and
    // the section is gone. A placeholder reading "not checked" would read as a finding.
    render(<DoctorPanel report={withReport({ install: { outcome: 'skipped', reason: 'no_install_command' } })} />);

    expect(screen.queryByLabelText(t.doctor.installProbe)).toBeNull();
  });

  it('names the files an install rewrote, and what that costs', () => {
    render(
      <DoctorPanel
        report={withReport({
          install: { outcome: 'dirties_checkout', command: 'npm install', entries: ['package-lock.json'] },
        })}
      />,
    );

    expect(screen.getByLabelText(t.doctor.installProbe)).toBeTruthy();
    expect(screen.getByText('package-lock.json')).toBeTruthy();
    expect(screen.getByText(t.doctor.probeDirties('npm install'))).toBeTruthy();
  });

  it('shows a role that cannot run as a failure, never as a degradation', () => {
    // The stage it serves dies on contact, every time. Rendering it as something to work
    // around would say work is still possible.
    render(
      <DoctorPanel
        report={withReport({
          status: 'FAIL',
          unresolvableRoles: ['architect'],
          notes: [],
          capabilities: [
            {
              kind: 'unresolvable',
              role: 'architect',
              runner: 'local',
              requestedReasoning: 'high',
              errorKind: 'missing_capability',
              reason: 'the runner has no working directory and this role reads the repository',
            },
          ],
        })}
      />,
    );

    expect(screen.getByText('FAIL')).toBeTruthy();
    expect(screen.getByText(t.doctor.cannotRun)).toBeTruthy();
    expect(screen.getByText(/no working directory/)).toBeTruthy();
  });

  it('names what a degradation lost, never a bare "degraded"', () => {
    render(
      <DoctorPanel
        report={withReport({
          status: 'DEGRADED',
          notes: [],
          degradations: [
            { kind: 'runner_unavailable', reason: 'codex is not installed', impact: 'plan review falls back to the same provider that wrote the plan' },
          ],
        })}
      />,
    );

    expect(screen.getByText(/plan review falls back to the same provider/)).toBeTruthy();
  });

  it('hides the fix-list entirely when there is nothing to fix', () => {
    render(<DoctorPanel report={REPORT} />);

    expect(screen.queryByLabelText(t.doctor.whatToFix)).toBeNull();
  });

  it('gives a concrete command for a runner that is missing', () => {
    render(
      <DoctorPanel
        report={withReport({
          status: 'DEGRADED',
          notes: [],
          runners: [{ id: 'codex', installed: false, executable: false, auth: 'not_configured' }],
          remediations: [
            { problem: 'Runner "codex" is not installed or executable', fix: 'npm install -g @openai/codex' },
          ],
        })}
      />,
    );

    expect(screen.getByLabelText(t.doctor.whatToFix)).toBeTruthy();
    expect(screen.getByText('npm install -g @openai/codex')).toBeTruthy();
  });
});
