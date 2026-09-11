import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoctorView, ProjectView } from '@contracts/index.js';
import { clearStore } from '../lib/store';
import { DoctorPage } from '../features/doctor/DoctorPage';
import { CleanPage } from '../features/clean/CleanPage';
import { AnalyticsPage } from '../features/analytics/AnalyticsPage';
import { CrewPage } from '../features/crew/CrewPage';
import { ptBR as t } from '../lib/i18n';

/**
 * The first day, which nothing tested and every screen got wrong.
 *
 * Found by pointing `agent-flow ui` at a directory holding one Git repository that had
 * never been through `init` — the shape of somebody's first five minutes. The deck was
 * fine. Every page below it guarded with `projects.loading || project === undefined` and
 * returned a skeleton, so three of them span forever, and the fourth fetched an aggregate
 * the server could not scope and reported "could not be read" — a failure, for an absence.
 *
 * **Loading and having none are different answers.** One spinner served both, which is why
 * these tests exist as a set: the defect was not in any one page, it was in a shape all
 * four had copied.
 */

const DOCTOR = {
  status: 'OK',
  tools: [],
  install: { outcome: 'skipped', reason: 'not_requested' },
  capabilities: [],
  stageRouting: [],
  unusedRunners: [],
  runners: [],
  probes: [],
  orphanRoles: [],
  degradations: [],
  notes: [],
  unresolvableRoles: [],
  remediations: [],
  readsEnvironment: false,
  remoteAccess: { known: false },
} satisfies DoctorView;

const serve = (projects: ProjectView[]) => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const target = String(input);
      // A minimal but *valid* report: a stub that answered `{}` made the panel throw
      // reading `tools`, which is the fixture failing rather than the page.
      const body = target.includes('/projects')
        ? projects
        : target.includes('/doctor')
          ? DOCTOR
          : {};
      // Anything project-scoped answers 404 with no project to scope it to, exactly as the
      // server does — a page must not depend on that call being made at all.
      const status = target.includes('/projects') || projects.length > 0 ? 200 : 404;
      return Promise.resolve(
        new Response(JSON.stringify(status === 404 ? { error: 'not_found', message: 'no such project' } : body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
};

/**
 * Longer than the one-second default, and for the reason this whole session kept
 * finding: a deadline that clears the work on an idle machine is an assumption about
 * the scheduler, and the suite runs these beside two other files. What is asserted is
 * what the page settles on, never how quickly it got there.
 */
const FOUND = 10_000;

/*
  The verb each page names itself with, taken from the dictionary rather than retyped:
  the sentence a person reads is `nothing to <verb>`, and a test spelling the verb in a
  literal would keep passing after somebody changed the page and not the wording.
*/
const PAGES = [
  ['Doctor', <DoctorPage key="doctor" />, t.doctor.diagnoseVerb],
  ['Clean', <CleanPage key="clean" />, t.clean.reclaimVerb],
  ['Analytics', <AnalyticsPage key="analytics" />, t.analytics.aggregateVerb],
  ['Crew', <CrewPage key="crew" />, t.crew.configureVerb],
] as const;

describe('a workspace with no project yet', () => {
  beforeEach(() => clearStore());
  afterEach(() => vi.unstubAllGlobals());

  for (const [name, element, verb] of PAGES) {
    it(`${name} says so instead of spinning`, async () => {
      serve([]);
      render(element);

      expect(await screen.findByText(t.common.noProjectsYet(verb), {}, { timeout: FOUND })).toBeInTheDocument();
      // The defect itself: a skeleton that never resolves, because the page cannot tell
      // "still loading" from "there is none".
      expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    });

    it(`${name} points at the thing that ends it`, async () => {
      // An empty state that does not name the next move is a dead end with better manners.
      serve([]);
      render(element);

      expect(await screen.findByText(t.common.noProjectsHintAction, {}, { timeout: FOUND })).toBeInTheDocument();
    });
  }

  it('is not what a page shows once a project exists — the control', async () => {
    // Without this, every assertion above would pass on a page that had learned to say
    // "no project" and nothing else.
    serve([
      { id: 'fresh-app', name: 'fresh-app', path: '/wk/fresh-app', currentRunId: null, status: null, runCount: 0 },
    ]);
    render(<DoctorPage />);

    expect(await screen.findByText(t.doctor.title, {}, { timeout: FOUND })).toBeInTheDocument();
    expect(screen.queryByText(t.common.noProjectsYet(t.doctor.diagnoseVerb))).toBeNull();
  });
});
