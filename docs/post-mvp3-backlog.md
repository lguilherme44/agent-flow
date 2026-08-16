# Post-MVP3 Backlog

This document captures non-normative enhancement ideas, UX improvements, and future milestone candidates identified during MVP3 development and audit. These items are strictly out of scope for MVP3 closure and are preserved here for future planning.

---

## 1. UI & Observability Enhancements

- **Final Review Visual Disambiguation (M3-09-F04)**:
  - Differentiate clearly in the Web UI between intermediate diagnostic review (evaluated during task execution or pre-integration) and authoritative final review (evaluated at the final `integrationHead` before Definition of Done closure).
- **Real-Time Streaming Tokens Visualization**:
  - Live token throughput and latency charts in the Analytics panel when streaming adapters are enabled.
- **Context Telemetry Historical Trends**:
  - Longitudinal metrics across multiple runs showing token reduction ratios and cache hit rates.

## 2. Configuration & Control Plane

- **Web UI Configuration Editor / Visual Settings Mutation**:
  - Safe, schema-validated visual editor for project and global `.agent-flow.json` configuration files with atomic disk writes.
- **Dynamic UtilityModel Selector**:
  - Runtime selection of local utility model profiles (e.g. fast triage model vs deep reasoning model).

## 3. Extended Integrations & Workflows

- **Extended Multi-Provider Utility Model Integrations**:
  - Native adapters for additional local/offline inference runtimes (e.g. llama.cpp direct bindings, vLLM endpoints).
- **Automated Pull Request & Remote Git Synchronization**:
  - Optional post-DoD workflow step to create structured PRs with deterministic receipts and telemetry summaries attached as diagnostic trailers.
- **Monorepo-Aware Context Partitioning**:
  - Workspace-level candidate discovery filters and scoped advisory packets for large monorepos.
