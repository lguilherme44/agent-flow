import { describe, it, expect } from 'vitest';
import { deriveAgentRoster } from '../../../src/core/collaboration/roster.js';
import {
  ALL_WORKFLOW_ROLES,
  AgentIdentitySchema,
  GlobalConfigSchema,
  HUMAN_AGENT_ID,
  ORCHESTRATOR_AGENT_ID,
  type GlobalConfig,
} from '../../../src/contracts/index.js';

function config(overrides: Record<string, unknown> = {}): GlobalConfig {
  return GlobalConfigSchema.parse({
    runners: { claude: { type: 'claude-code-cli' }, codex: { type: 'codex-cli' } },
    roles: {
      architect: { runner: 'claude', effort: 'very_high', model: 'opus' },
      sdd: { runner: 'claude', effort: 'high' },
      planner: { runner: 'codex', effort: 'high' },
      planReviewer: { runner: 'claude', effort: 'high' },
      executors: {
        trivial: { runner: 'codex', effort: 'low' },
        normal: { runner: 'codex', effort: 'medium' },
        complex: { runner: 'claude', effort: 'high' },
      },
      verification: { runner: 'codex', effort: 'medium' },
      finalReviewer: { runner: 'claude', effort: 'very_high' },
    },
    ...overrides,
  });
}

describe('deriveAgentRoster (M4-01)', () => {
  it('derives one agent per configured role, with no collaboration block present', () => {
    // The whole of M4's backward compatibility: a config.yaml written before this
    // milestone existed yields a roster on the first run after the upgrade, with no
    // migration, no new block and no edit.
    const roster = deriveAgentRoster(config());

    expect(roster.agents).toHaveLength(ALL_WORKFLOW_ROLES.length);
    expect(roster.agents.map((agent) => agent.id)).toEqual([...ALL_WORKFLOW_ROLES]);
  });

  it('produces identities that satisfy the contract', () => {
    for (const agent of deriveAgentRoster(config()).agents) {
      expect(AgentIdentitySchema.safeParse(agent).success, agent.id).toBe(true);
    }
  });

  it('takes each agent’s runner and model from its role’s configuration', () => {
    const roster = deriveAgentRoster(config());

    expect(roster.byId('architect')?.runner).toBe('claude');
    expect(roster.byId('architect')?.model).toBe('opus');
    expect(roster.byId('executor.normal')?.runner).toBe('codex');
    // Omitted rather than null: a role that pins no model lets the CLI apply whatever
    // the user already configured for it (AD-13).
    expect(roster.byId('sdd')).not.toHaveProperty('model');
  });

  it('keeps id and role as separate fields even while they are equal', () => {
    // M5's teams introduce a member whose id is `frontend` and whose role is
    // `executor.normal`. Everything written under M4 keeps resolving because none of
    // it was ever keyed on the role.
    for (const agent of deriveAgentRoster(config()).agents) {
      expect(agent.id).toBe(agent.role);
    }
  });

  it('gives every agent an empty skill list, because nothing measured one', () => {
    // A plausible-looking derived list would be read as a measurement by the
    // assignment logic M5 builds on top of it.
    for (const agent of deriveAgentRoster(config()).agents) {
      expect(agent.skills, agent.id).toEqual([]);
      expect(agent.specializations, agent.id).toEqual([]);
    }
  });

  it('names every role in a way a person can read', () => {
    for (const agent of deriveAgentRoster(config()).agents) {
      expect(agent.displayName.length, agent.id).toBeGreaterThan(0);
      // Not the role string echoed back — a name whose only content is the key is a
      // field that should not exist.
      expect(agent.displayName, agent.id).not.toBe(agent.role);
    }
  });

  it('resolves the two reserved participants by id', () => {
    const roster = deriveAgentRoster(config());

    expect(roster.has(HUMAN_AGENT_ID)).toBe(true);
    expect(roster.has(ORCHESTRATOR_AGENT_ID)).toBe(true);
    expect(roster.byId(ORCHESTRATOR_AGENT_ID)?.displayName).toBe('Agent Flow');
  });

  it('leaves the reserved participants out of the dispatchable roster', () => {
    // Addressable by id and by nothing else. A role-addressed message that reached the
    // human would be addressed to a participant no wave can dispatch.
    const roster = deriveAgentRoster(config());

    expect(roster.agents.map((agent) => agent.id)).not.toContain(HUMAN_AGENT_ID);
    expect(roster.byRole('planReviewer').map((agent) => agent.id)).toEqual(['planReviewer']);
  });

  it('answers byRole with every agent serving that role', () => {
    const roster = deriveAgentRoster(config());

    for (const role of ALL_WORKFLOW_ROLES) {
      expect(roster.byRole(role).map((agent) => agent.role), role).toEqual([role]);
    }
  });

  it('is deterministic — two derivations of one config are identical', () => {
    // Every projection downstream is keyed on this. A roster that reordered itself
    // would make a rendered context block differ between two reads of one run.
    expect(deriveAgentRoster(config()).agents).toEqual(deriveAgentRoster(config()).agents);
  });

  it('answers undefined for an id nobody configured', () => {
    expect(deriveAgentRoster(config()).byId('frontend')).toBeUndefined();
    expect(deriveAgentRoster(config()).has('frontend')).toBe(false);
  });
});
