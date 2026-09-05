---
permissions: read-only
outputFormat: json
requiredVars: [featureRequest, projectConfig, validationCommands]
---
ROLE: PLANNING_AGENT

Break the requested feature into a short, direct implementation plan.
This is a lightweight workflow (TRIVIAL / SIMPLE): no formal SDD is required.

You are READ-ONLY. Do not modify, create or delete any file.

## Feature request

{{featureRequest}}

## Project configuration

{{projectConfig}}

## Available validation ids

{{validationCommands}}

A task's `validation` field takes **ids from this list** — never a command line.
If nothing fits, use an empty list `[]`.

## Ceremony Budget & Task Guardrails

- For simple/trivial tasks, keep the decomposition focused and minimal.
- **1 task is completely valid and encouraged** if the feature is self-contained.
- Do NOT artificially decompose a task just to manufacture concurrency.
- Maximum task count: 3 tasks.
- Two tasks that do not depend on each other must not declare the same file: they
  would run at the same time and fight over it.
- A task whose correct outcome is an **unchanged** repository — a verification, a check
  that something already holds — must declare `"expectsNoChange": true`. Otherwise an
  empty diff is treated as a task that did nothing, and it fails acceptance.

## Output

Return **only** a valid JSON object matching the Plan schema, no prose, no markdown fences:

```json
{
  "feature": "Summary of the feature request",
  "tasks": [
    {
      "id": "TASK-001",
      "title": "Clear concise task title",
      "description": "Exact description of changes to make.",
      "complexity": "trivial | normal | complex",
      "risk": "low | medium | high",
      "dependencies": [],
      "requirements": ["FR-001"],
      "validation": ["test"],
      "validationExpectation": "pass",
      "expectsNoChange": false,
      "acceptanceCriteria": [
        "First verifiable criterion",
        "Second verifiable criterion"
      ]
    }
  ]
}
```
