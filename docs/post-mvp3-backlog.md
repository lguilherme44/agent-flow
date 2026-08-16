# Post-MVP3 Backlog

This document captures non-normative enhancement ideas, future architecture topics, and roadmap candidates identified during MVP3 and subsequent product readiness phases. These items are strictly out of scope for current product polish and are preserved here for future planning.

---

## 1. Metrics & Observability Depth

- **Historical Run Comparison & Long-Term Trends**:
  - Longitudinal metrics across multiple runs showing token reduction ratios, cache hit rates, and stage duration drift over time.
- **Advanced Context Savings Metrics**:
  - Mechanically measurable context avoided/saved metrics when multi-attempt counterfactual baselines are captured.
- **Critical-Path Analytics Enhancements**:
  - Automated detection and rendering of execution bottlenecks and dependency wave latency distributions.

---

## 2. DAG & Graph UX Enhancements

- **Large-Scale Graph Optimizations**:
  - Node clustering, interactive sub-graph filtering, and virtualization for plans exceeding 100+ tasks.
- **Visual Edge Crossing Minimization**:
  - Advanced barycentric vertical heuristics and interactive edge-highlighting on hover/focus while strictly maintaining left-to-right topological progression.

---

## 3. Artifact Localization

- **Generation-Language Propagation**:
  - Propagate user/UI language setting (`en` vs `pt-BR`) into the trusted prompt and config layer so that Plan, SDD, Architecture Impact, and Review findings are generated in the operator's preferred language.
  - Architectural constraint: Language selection must only affect presentation/content language and must NEVER alter validation semantics, plan hash calculation, authority, task status, or Git behavior.

---

## 4. Agents & Models Depth

- **Deeper Provider Quota & Capacity Detection**:
  - Dynamic rate-limit and quota interrogation where provider CLIs or APIs expose machine-readable capacity contracts.
- **Dynamic UtilityModel Selector**:
  - Runtime switching between multiple configured local utility model profiles (e.g. lightweight triage model vs high-capacity code model).

---

## 5. Forge Integrations & Remote Git Synchronization

- **Opt-in Forge Architecture**:
  - Disabled by default. Explicit provider choice: `none` (default), `github`, or `azure-devops`.
  - Remote Git detection may suggest a forge provider but must NEVER automatically enable network actions without explicit configuration.
- **GitHub Forge Toggles**:
  - Granular opt-in switches for PR creation, Issue tracking, and GitHub Actions workflow status inspection.
- **Azure DevOps Forge Toggles**:
  - Granular opt-in switches for Azure Repos pull requests, Azure Boards work items, and Azure Pipelines build status.
- **ForgeProvider Seam**:
  - Keep `ForgeProvider` completely separate from `GitClient`. `GitClient` remains local-only and deterministic; `ForgeProvider` handles remote API interactions and diagnostic metadata attachment.

---

## 6. Azure DevOps Compatibility Suite

- **Repository Compatibility**:
  - Tested workflows against Azure Repos clones, local Git worktrees, retry/recovery loops, AGY runner, and local UtilityModel.
- **Azure Pipelines Execution**:
  - CI pipeline definitions that execute canonical package scripts (`npm run check`, `npm run test:coverage`, etc.) as executors without altering local authority.

---

## 7. CI Provider Neutrality

- **Canonical Package Scripts as Truth**:
  - The repository's npm package scripts (`npm run check`, `npm test`, `npm run test:coverage`, `npm run test:visual`, `npm run test:e2e`) remain the single authoritative quality gate.
  - GitHub Actions, Azure Pipelines, and local git hooks are transport executors only and must never define parallel gate logic.

---

## 8. Control Plane & Engine Extensions

- **Pause, Resume, and Cancel Execution Control**:
  - Core state machine support for interrupting execution between tasks and resuming gracefully (referencing `docs/pause-resume-cancel-design.md`).
- **Web UI Configuration Editor / Visual Settings Mutation**:
  - Safe, schema-validated visual editor for project and global `.agent-flow.json` / `config.yaml` configuration files with atomic disk writes (referencing `docs/config-write-design.md`).
- **Remote Workers & Distributed Execution**:
  - Multi-host worker pooling and remote task execution while preserving receipt-first marker verification.
