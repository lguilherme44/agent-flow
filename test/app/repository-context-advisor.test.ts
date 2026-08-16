import { describe, expect, it } from 'vitest';
import { RepositoryContextAdvisor } from '../../src/app/repository-context-advisor.js';
import {
  RepositoryRetriever,
  StaticCandidateDiscovery,
} from '../../src/core/repository-retriever.js';
import { FakeUtilityModel } from '../fakes/fake-utility-model.js';
import { ContextTelemetryRecorder } from '../../src/app/context-telemetry-recorder.js';
import { StateStore } from '../../src/app/state-store.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import type { StageAdvisoryRequest, StageDefinition } from '../../src/app/stage-runner.js';

const STAGE: StageDefinition = {
  name: 'implementation',
  role: 'executor.normal',
  prompt: 'implementation',
};

function request(overrides: Partial<StageAdvisoryRequest> = {}): StageAdvisoryRequest {
  return {
    stage: STAGE,
    runId: 'AF-2026-001',
    renderedPrompt: 'Write the retry budget fix.\n',
    objective: 'Fix the retry budget bug',
    ...overrides,
  };
}

function advisor(model: FakeUtilityModel, telemetry?: ContextTelemetryRecorder) {
  const retriever = new RepositoryRetriever({
    utilityModel: model,
    candidateDiscovery: new StaticCandidateDiscovery(['src/app/task-executor.ts', 'src/app/stage-runner.ts']),
    projectDir: '/repo',
  });
  return new RepositoryContextAdvisor({ retriever, telemetry });
}

async function recorderHarness() {
  const fs = new InMemoryFileSystem();
  const store = new StateStore({ fs, clock: new FixedClock(), projectDir: '/repo' });
  const run = await store.createRun('context telemetry');
  return {
    fs,
    store,
    recorder: new ContextTelemetryRecorder(store),
    runId: run.runId,
  };
}

describe('RepositoryContextAdvisor', () => {
  it('returns an advisory block when retrieval succeeds', async () => {
    const model = new FakeUtilityModel().pushStructured(
      '{}',
      {
        objective: 'Fix the retry budget bug',
        relevantFiles: [{ path: 'src/app/task-executor.ts', reason: 'holds the repair loop' }],
        relevantSymbols: [],
        constraints: [],
        architectureNotes: [],
        risks: [],
        evidence: [],
      },
    );
    const result = await advisor(model).advise(request());
    expect(result).toBeDefined();
    expect(result!).toContain('ADVISORY CONTEXT');
    expect(result!).toContain('src/app/task-executor.ts');
  });

  it('bypasses silently when the model is not configured', async () => {
    const retriever = new RepositoryRetriever({
      candidateDiscovery: new StaticCandidateDiscovery(['src/app/task-executor.ts']),
      projectDir: '/repo',
    });
    const result = await new RepositoryContextAdvisor({ retriever }).advise(request());
    expect(result).toBeUndefined();
  });

  it('bypasses silently when the model is unavailable', async () => {
    const model = new FakeUtilityModel('m', undefined, { status: 'unavailable' });
    const result = await advisor(model).advise(request());
    expect(result).toBeUndefined();
  });

  it('bypasses silently when the model fails', async () => {
    const model = new FakeUtilityModel().pushFailure('execution_failed', 'boom');
    const result = await advisor(model).advise(request());
    expect(result).toBeUndefined();
  });

  it('bypasses silently when the model invents a path outside the candidates', async () => {
    const model = new FakeUtilityModel().pushStructured(
      '{}',
      {
        objective: 'Fix the retry budget bug',
        relevantFiles: [{ path: 'src/evil/escape.ts', reason: 'invented' }],
        relevantSymbols: [],
        constraints: [],
        architectureNotes: [],
        risks: [],
        evidence: [],
      },
    );
    const result = await advisor(model).advise(request());
    expect(result).toBeUndefined();
  });

  it('never throws to the stage: a broken retriever degrades to no advisory', async () => {
    const throwing = new RepositoryContextAdvisor({
      retriever: {
        retrieve: async () => {
          throw new Error('repository went away');
        },
      } as unknown as RepositoryRetriever,
    });
    const result = await throwing.advise(request());
    expect(result).toBeUndefined();
  });

  it('records a mechanical projection observation for an advisory success', async () => {
    const { recorder, store, runId } = await recorderHarness();
    const model = new FakeUtilityModel().pushStructured('{}', {
      objective: 'Fix the retry budget bug',
      relevantFiles: [{ path: 'src/app/task-executor.ts', reason: 'holds the repair loop' }],
      relevantSymbols: [],
      constraints: [],
      architectureNotes: [],
      risks: [],
      evidence: [],
    });
    await advisor(model, recorder).advise(request({ runId }));

    const observed = (await store.readEvents(runId)).filter(
      (event) => event.type === 'context_telemetry_observed',
    );
    expect(observed).toHaveLength(1);
    const observation = observed[0]!.detail.observation as Record<string, unknown>;
    expect(observation).toMatchObject({
      stage: 'retrieval',
      source: 'repository_retrieval',
      provenance: 'mechanical_projection',
      candidatesBefore: 2,
      candidatesAfter: 1,
      filesAfter: 1,
      utilityCalls: 1,
      utilityFailures: 0,
      structuredOutputFailures: 0,
    });
  });

  it('records a bypass projection when the model is absent', async () => {
    const { recorder, store, runId } = await recorderHarness();
    const retriever = new RepositoryRetriever({
      candidateDiscovery: new StaticCandidateDiscovery(['src/app/task-executor.ts']),
      projectDir: '/repo',
    });
    await new RepositoryContextAdvisor({ retriever, telemetry: recorder }).advise(
      request({ runId }),
    );

    const observed = (await store.readEvents(runId)).filter(
      (event) => event.type === 'context_telemetry_observed',
    );
    expect(observed).toHaveLength(1);
    const observation = observed[0]!.detail.observation as Record<string, unknown>;
    expect(observation).toMatchObject({
      stage: 'retrieval',
      source: 'repository_retrieval',
      provenance: 'mechanical_projection',
      bypassReason: 'utility_model_missing',
      candidatesAfter: 0,
    });
  });
});