# Agent Flow — Especificação de Implementação

> **Documento histórico — Implementation Spec v3 (MVP 1), concluída.**
>
> Esta especificação descreve o que foi desenhado e entregue no MVP 1, e é mantida como
> foi escrita. **O código é a verdade atual**, e onde os dois divergem, o código vence.
>
> Para o desenvolvimento em andamento, a autoridade normativa é
> [`mvp2-safe-parallel-execution.md`](mvp2-safe-parallel-execution.md), que **substitui
> §19 e §47–§48 deste documento**: a colocação de worktrees sob `.agent-flow/worktrees/`
> e um scheduler que os cria foram ambas rejeitadas com base em evidência empírica.
> Veja também [`../roadmap.md`](../roadmap.md) para o estado por milestone.

## 1. Objetivo

Construir um workflow padronizado e reutilizável para desenvolvimento assistido por agentes de IA, aplicável a múltiplos projetos e stacks, usando:

- TypeScript como linguagem do orquestrador.
- Codex CLI e Claude Code CLI como executores de primeira classe no MVP.
- Uso preferencial das autenticações locais das assinaturas ChatGPT/Codex e Claude Team, sem exigir API keys.
- Model/runner routing por papel, estágio, risco e complexidade.
- Git worktrees para isolamento de tarefas.
- SDD (Software Design Document) como contrato entre planejamento e execução.
- Tasks persistidas em arquivos estruturados.
- Gates obrigatórios entre planejamento, implementação e revisão.
- Configuração global compartilhada + configuração específica por projeto.
- Abstração de runner independente de provider/modelo.
- Cross-provider review configurável, evitando que o mesmo modelo produza e aprove etapas críticas.
- Fallback controlado entre runners apenas para indisponibilidade, quota ou autenticação.
- Execução determinística e auditável.

A ferramenta deve funcionar como uma camada de orquestração acima do agente de código.

O agente não deve decidir livremente o workflow inteiro. O workflow deve ser definido pelo orquestrador.

---

# 2. Princípios

## 2.1. Separação entre planejamento e execução

Nenhuma implementação deve começar antes de:

1. analisar o projeto;
2. produzir o SDD;
3. quebrar o SDD em tasks;
4. revisar o plano;
5. obter aprovação explícita.

Fluxo:

```text
Feature Request
      ↓
Discovery
      ↓
Architecture Analysis
      ↓
SDD
      ↓
Task Breakdown
      ↓
Plan Review
      ↓
Human Approval
      ↓
Implementation
      ↓
Verification
      ↓
Final SDD Review
```

---

## 2.2. Contextos independentes

Cada estágio deve executar em um novo contexto do agente.

Não reutilizar o contexto completo do estágio anterior.

O compartilhamento entre estágios deve ocorrer exclusivamente por artefatos persistidos no projeto.

Exemplo:

```text
Discovery Agent
      ↓
.agent-flow/architecture.md

SDD Agent
      ↓
.agent-flow/sdd.md

Planning Agent
      ↓
.agent-flow/plan.json
```

Isso evita:

- contaminação de contexto;
- decisões implícitas;
- perda de rastreabilidade;
- acúmulo desnecessário de tokens.

---

## 2.3. Routing determinístico

O LLM pode classificar uma task.

O LLM não deve escolher diretamente qual modelo executará a task.

Exemplo:

```json
{
  "complexity": "normal",
  "risk": "medium",
  "crossModule": false
}
```

O orquestrador transforma isso em:

```text
normal → GPT-5.6 Terra / medium
```

---

# 3. Runner and Model Routing

O Agent Flow não deve ser orientado a modelos específicos no core.

O core trabalha com papéis lógicos:

```text
architect
sdd
planner
planReviewer
executor.trivial
executor.normal
executor.complex
verification
finalReviewer
```

A configuração global resolve cada papel para:

```text
runner + model + reasoning level
```

Configuração padrão inicial recomendada:

| Papel | Runner | Modelo | Effort |
|---|---|---|---|
| Discovery / Architecture | Claude Code | Opus | xhigh |
| SDD | Claude Code | Opus | high |
| Planning | Codex | GPT-5.6 Sol | high |
| Plan Review | Claude Code | Opus | high |
| Task trivial | Codex | GPT-5.6 Luna | medium |
| Task normal | Codex | GPT-5.6 Terra | medium |
| Task complex | Codex | GPT-5.6 Sol | high |
| Verification | Codex | GPT-5.6 Terra | medium |
| Final Review | Claude Code | Opus | xhigh |

A motivação da configuração padrão é:

```text
Claude/Opus
    ↓
arquitetura e especificação

Codex/Sol
    ↓
planejamento

Claude/Opus
    ↓
crítica independente do plano

Codex
    ↓
implementação

Claude/Opus
    ↓
revisão final independente
```

Essa separação deve ser configurável.

Exemplo:

```yaml
roles:
  architect:
    runner: claude-code
    model: opus
    effort: xhigh

  sdd:
    runner: claude-code
    model: opus
    effort: high

  planner:
    runner: codex
    model: gpt-5.6-sol
    effort: high

  planReviewer:
    runner: claude-code
    model: opus
    effort: high

  executors:
    trivial:
      runner: codex
      model: gpt-5.6-luna
      effort: medium

    normal:
      runner: codex
      model: gpt-5.6-terra
      effort: medium

    complex:
      runner: codex
      model: gpt-5.6-sol
      effort: high

  verification:
    runner: codex
    model: gpt-5.6-terra
    effort: medium

  finalReviewer:
    runner: claude-code
    model: opus
    effort: xhigh
```

Nenhuma stage deve depender diretamente de nomes de modelos.

O LLM pode classificar a task, mas não deve escolher livremente o runner/modelo.

Exemplo:

```json
{
  "complexity": "normal",
  "risk": "medium",
  "crossModule": false
}
```

O orquestrador transforma isso em uma role:

```text
executor.normal
```

E a configuração resolve:

```text
executor.normal
    ↓
CodexRunner
    ↓
GPT-5.6 Terra / medium
```

Isso permite trocar posteriormente:

```text
executor.normal → Claude Code / Sonnet
```

sem alterar prompts ou o core.

---

## 3.1. Reasoning abstraction

O core não deve espalhar valores específicos como:

```text
high
max
xhigh
```

por toda a aplicação.

Definir uma abstração lógica:

```typescript
type ReasoningLevel =
  | "low"
  | "medium"
  | "high"
  | "very_high";
```

Cada runner traduz para o valor suportado pelo executor físico.

Exemplo conceitual:

```text
ReasoningLevel.high
  Codex       → high
  Claude Code → high

ReasoningLevel.very_high
  Codex       → max
  Claude Code → xhigh
```

Essa tradução deve ficar dentro do adapter/capabilities do runner.

---

## 3.2. Cross-provider review

O Agent Flow deve permitir configurar que um artefato crítico seja revisado por um runner diferente daquele que o produziu.

Exemplo padrão:

```text
SDD
Claude Code / Opus
        ↓

Plan
Codex / Sol
        ↓

Plan Review
Claude Code / Opus
```

E:

```text
Implementation
Codex
        ↓

Final Review
Claude Code / Opus
```

A finalidade é reduzir auto-confirmação e reutilização de uma mesma hipótese incorreta.

Não tornar cross-provider review obrigatório no core.

Deve ser uma política configurável.

---

# 4. Arquitetura da solução

A ferramenta deve ser independente dos projetos.

Estrutura recomendada:

```text
agent-flow/
├── package.json
├── src/
│   ├── cli/
│   ├── core/
│   ├── config/
│   ├── workflow/
│   ├── runners/
│   ├── routing/
│   ├── git/
│   ├── codex/
│   ├── schemas/
│   ├── state/
│   └── utils/
│
├── prompts/
│   ├── discovery.md
│   ├── architecture.md
│   ├── sdd.md
│   ├── planning.md
│   ├── plan-review.md
│   ├── implementation.md
│   ├── verification.md
│   └── final-review.md
│
├── templates/
│   ├── project-config.yaml
│   ├── AGENTS.md
│   └── agent-flow.gitignore
│
└── bin/
    └── agent-flow
```

A ferramenta deve poder ser instalada globalmente:

```bash
npm install -g agent-flow
```

ou usada via:

```bash
npx agent-flow
```

---

# 5. Estrutura por projeto

Cada projeto deve possuir apenas arquivos de configuração e estado local.

Exemplo:

```text
meu-projeto/
├── .agent-flow/
│   ├── config.yaml
│   ├── state.json
│   ├── architecture.md
│   ├── sdd.md
│   ├── plan.json
│   ├── reviews/
│   ├── tasks/
│   ├── logs/
│   └── runs/
│
├── AGENTS.md
├── src/
└── ...
```

A lógica do workflow não deve ser duplicada em cada projeto.

---

# 6. Configuração global vs configuração do projeto

A ferramenta deve possuir dois níveis de configuração.

## Configuração global

Exemplo:

```text
~/.agent-flow/config.yaml
```

Responsável por:

- runners instalados;
- roles;
- modelos;
- reasoning levels;
- limites de paralelismo;
- fallback;
- defaults;
- caminhos;
- preferências do usuário.

Exemplo:

```yaml
version: 1

runners:
  codex:
    type: codex-cli
    enabled: true

  claude:
    type: claude-code-cli
    enabled: true

roles:
  architect:
    runner: claude
    model: opus
    effort: very_high

  sdd:
    runner: claude
    model: opus
    effort: high

  planner:
    runner: codex
    model: gpt-5.6-sol
    effort: high

  planReviewer:
    runner: claude
    model: opus
    effort: high

  executors:
    trivial:
      runner: codex
      model: gpt-5.6-luna
      effort: medium

    normal:
      runner: codex
      model: gpt-5.6-terra
      effort: medium

    complex:
      runner: codex
      model: gpt-5.6-sol
      effort: high

  verification:
    runner: codex
    model: gpt-5.6-terra
    effort: medium

  finalReviewer:
    runner: claude
    model: opus
    effort: very_high

fallback:
  enabled: true

  on:
    - quota_exceeded
    - runner_unavailable
    - auth_required

  roles:
    architect:
      runner: codex
      model: gpt-5.6-sol
      effort: high

    finalReviewer:
      runner: codex
      model: gpt-5.6-sol
      effort: high

parallelism:
  maxTasks: 3

git:
  useWorktrees: true

approval:
  requiredBeforeImplementation: true
```

O fallback nunca deve ser usado automaticamente para:

```text
execution_failed
validation_failed
bad_output
```

nesses casos o problema deve permanecer visível.

---

## Configuração local

Arquivo:

```text
.agent-flow/config.yaml
```

Responsável por diferenças específicas do projeto.

Exemplo para NestJS:

```yaml
project:
  name: api-beahub
  type: nestjs

commands:
  install: npm install
  lint: npm run lint
  typecheck: npm run typecheck
  test: npm test
  build: npm run build

paths:
  source:
    - src
  tests:
    - test
    - src/**/*.spec.ts

rules:
  architecture:
    - "Controllers não devem acessar Prisma diretamente"
    - "Business rules devem permanecer em services/use-cases"
```

Exemplo para Flutter:

```yaml
project:
  name: beahub-app
  type: flutter

commands:
  install: flutter pub get
  lint: flutter analyze
  test: flutter test
  build: flutter build apk --debug

paths:
  source:
    - lib
  tests:
    - test

rules:
  architecture:
    - "Não colocar regra de negócio em Widgets"
    - "Manter navegação usando GoRouter"
```

---

# 7. Comando init

A ferramenta deve possuir:

```bash
agent-flow init
```

O comando deve:

1. detectar a stack do projeto;
2. criar `.agent-flow/`;
3. gerar `.agent-flow/config.yaml`;
4. criar ou complementar `AGENTS.md`;
5. detectar scripts existentes;
6. sugerir comandos de validação;
7. nunca sobrescrever arquivos existentes sem confirmação.

Detecção inicial:

```text
package.json      → Node / React / Nest
pubspec.yaml      → Flutter / Dart
pyproject.toml    → Python
go.mod            → Go
Cargo.toml        → Rust
```

---

# 7.1. Command `doctor`

A ferramenta deve possuir:

```bash
agent-flow doctor
```

Objetivo:

validar o ambiente local antes de iniciar workflows.

Deve verificar:

```text
Node
Git
Codex CLI
Claude Code CLI
```

E, quando possível, identificar se os runners conseguem executar comandos autenticados.

Exemplo:

```text
Agent Flow Doctor

Node
  installed          ✓

Git
  installed          ✓

Codex CLI
  installed          ✓
  executable         ✓
  auth status        available

Claude Code
  installed          ✓
  executable         ✓
  auth status        available

Ready.
```

O comando não deve exigir API keys.

A implementação inicial deve assumir que a autenticação é gerenciada pelas próprias CLIs.

O Agent Flow apenas invoca os executores locais.

O comando `doctor` não deve exibir ou armazenar tokens, cookies, credentials ou secrets.

---

# 8. Feature workflow

O comando principal será:

```bash
agent-flow feature "descrição da feature"
```

Exemplo:

```bash
agent-flow feature \
  "Adicionar agendamentos recorrentes permitindo repetição semanal"
```

Esse comando inicia um novo workflow.

---

# 9. Stage 1 — Discovery

Objetivo:

entender o projeto sem modificar nenhum arquivo.

Permissões:

```text
READ ONLY
```

Saída:

```text
.agent-flow/architecture.md
```

O agente deve analisar:

- estrutura de diretórios;
- stack;
- módulos;
- domínio;
- dependências;
- banco;
- integrações;
- padrões arquiteturais;
- testes;
- convenções;
- arquivos relacionados à feature.

O agente não deve produzir solução detalhada ainda.

---

# 10. Stage 2 — Architecture Analysis

Entrada:

```text
feature request
architecture.md
project config
AGENTS.md
```

Objetivo:

descobrir quais componentes existentes serão afetados.

Saída incorporada ao SDD ou:

```text
.agent-flow/architecture-impact.md
```

Deve identificar:

- módulos afetados;
- entidades;
- banco;
- endpoints;
- UI;
- serviços;
- filas;
- jobs;
- integrações;
- risco de regressão;
- dependências entre módulos.

---

# 11. Stage 3 — SDD

Arquivo:

```text
.agent-flow/sdd.md
```

Formato obrigatório:

```markdown
# Software Design Document

## Context

## Problem

## Current Behavior

## Desired Behavior

## Functional Requirements

## Non-Functional Requirements

## Architecture

## Components Affected

## Database Changes

## API Changes

## Frontend Changes

## Domain Changes

## Contracts and Interfaces

## Security

## Observability

## Migration Strategy

## Testing Strategy

## Edge Cases

## Risks

## Alternatives Considered

## Acceptance Criteria
```

O SDD deve ser considerado o contrato principal da implementação.

---

# 12. Stage 4 — Task Breakdown

Gerar:

```text
.agent-flow/plan.json
```

Schema:

```json
{
  "feature": "recurring-bookings",
  "tasks": []
}
```

Cada task:

```json
{
  "id": "TASK-003",
  "title": "Implement recurring booking generation",
  "description": "...",

  "scope": "backend",

  "complexity": "complex",
  "risk": "high",

  "dependencies": [
    "TASK-001",
    "TASK-002"
  ],

  "files": {
    "likely": [
      "src/modules/booking/booking.service.ts"
    ]
  },

  "flags": {
    "databaseChange": false,
    "crossModule": true,
    "architectureDecision": true,
    "externalIntegration": false
  },

  "acceptanceCriteria": [
    "...",
    "..."
  ],

  "validation": [
    "npm test -- booking"
  ]
}
```

---

# 13. Task sizing

As tasks devem ser pequenas.

Uma task ideal deve:

- ter objetivo único;
- ser implementável isoladamente;
- possuir acceptance criteria;
- indicar dependências;
- evitar mudanças em muitas responsabilidades ao mesmo tempo.

Evitar:

```text
TASK-01 Implement recurring bookings
```

Preferir:

```text
TASK-01 Add recurrence domain types
TASK-02 Add recurrence database fields
TASK-03 Add recurrence repository methods
TASK-04 Implement recurrence generator
TASK-05 Expose recurrence API
TASK-06 Integrate Flutter repository
TASK-07 Create recurrence form
TASK-08 Add recurrence tests
```

---

# 14. Complexidade

O planejador deve classificar:

```text
trivial
normal
complex
```

## trivial

Exemplos:

- DTO simples;
- enum;
- alteração de texto;
- pequeno componente visual;
- ajuste isolado;
- teste unitário simples.

## normal

Exemplos:

- CRUD;
- endpoint;
- repository;
- migration;
- formulário;
- service;
- integração interna.

## complex

Exemplos:

- concorrência;
- transações críticas;
- arquitetura;
- múltiplos módulos;
- segurança;
- integração externa;
- sincronização;
- migração sensível;
- regras de negócio complexas.

---

# 15. Router

O router deve ser código determinístico.

Exemplo:

```typescript
export function routeTask(task: Task): ModelConfig {
  if (
    task.flags.architectureDecision ||
    task.risk === "high" ||
    task.flags.crossModule ||
    task.flags.externalIntegration
  ) {
    return models.execution.complex;
  }

  if (
    task.complexity === "trivial" &&
    task.risk === "low"
  ) {
    return models.execution.trivial;
  }

  return models.execution.normal;
}
```

O router deve permitir configuração futura.

---

# 16. Stage 5 — Plan Review

Um novo agente deve revisar:

```text
architecture.md
sdd.md
plan.json
```

Role padrão:

```text
planReviewer
```

Configuração inicial recomendada:

```text
Claude Code / Opus / high
```

O reviewer deve procurar:

- requisitos sem task;
- task sem requisito;
- dependência faltando;
- ordem incorreta;
- arquitetura inconsistente;
- migração insegura;
- ausência de testes;
- edge cases ignorados;
- tasks grandes demais.

Saída:

```text
.agent-flow/reviews/plan-review.md
```

Resultado obrigatório:

```text
PASS
```

ou:

```text
FAIL
```

Se FAIL, retornar findings estruturados.

---

# 17. Human Gate

Antes da implementação:

```bash
agent-flow status
```

Exemplo:

```text
Feature: recurring-bookings

Discovery       ✓
Architecture    ✓
SDD             ✓
Planning        ✓
Plan Review     ✓

14 tasks

Status:
WAITING_FOR_APPROVAL
```

Usuário executa:

```bash
agent-flow approve
```

Somente então iniciar implementação.

Também permitir:

```bash
agent-flow reject
```

e:

```bash
agent-flow revise "dividir TASK-004 em tasks menores"
```

---

# 18. Stage 6 — Implementation

Depois de aprovado, executar tasks respeitando o DAG.

Exemplo:

```text
TASK-001 ─┐
          ├── TASK-003 ─── TASK-005
TASK-002 ─┘
```

Tasks independentes podem executar em paralelo.

---

# 19. Git Worktrees

Cada task deve receber seu próprio worktree.

Exemplo:

```text
.agent-flow/worktrees/TASK-001
.agent-flow/worktrees/TASK-002
.agent-flow/worktrees/TASK-003
```

Branches:

```text
agent-flow/recurring-bookings/TASK-001
agent-flow/recurring-bookings/TASK-002
```

Criar via:

```bash
git worktree add ...
```

Benefícios:

- isolamento;
- paralelismo;
- menor chance de conflito;
- rollback simples;
- rastreabilidade por task.

---

# 20. Task Executor

Cada task deve executar em um novo processo do runner resolvido para sua role.

Na configuração inicial, tasks de implementação usam Codex, mas o core não deve assumir isso.

Entrada:

```text
SDD
task
AGENTS.md
project config
relevant files
```

Prompt base:

```text
ROLE: IMPLEMENTATION_AGENT

Implement only the assigned task.

The approved SDD is the source of truth.

Do not modify functionality outside the task scope.

Respect AGENTS.md and project rules.

Before editing:
1. inspect related code;
2. confirm existing patterns;
3. identify exact files to change.

After implementation:
1. execute task validation;
2. report changed files;
3. report tests;
4. report deviations from SDD.

If the task requires an architecture change not covered by the SDD,
STOP and return BLOCKED.
```

---

# 21. Task result

Persistir:

```text
.agent-flow/runs/TASK-003/result.json
```

Exemplo:

```json
{
  "task": "TASK-003",
  "status": "completed",
  "runner": "codex",
  "model": "gpt-5.6-sol",
  "effort": "high",

  "filesChanged": [
    "src/modules/booking/booking.service.ts"
  ],

  "validation": {
    "passed": true
  },

  "notes": []
}
```

---

# 22. Estados de task

Estados permitidos:

```text
queued
ready
running
completed
failed
blocked
review_required
```

Uma task só entra em:

```text
ready
```

quando todas as suas dependências estiverem:

```text
completed
```

---

# 22.1. Normalização de erros dos runners

Cada adapter deve traduzir erros específicos de sua CLI para um conjunto comum:

```typescript
type AgentRunnerErrorCode =
  | "quota_exceeded"
  | "auth_required"
  | "runner_unavailable"
  | "timeout"
  | "execution_failed"
  | "invalid_output"
  | "blocked";
```

O core não deve analisar mensagens textuais específicas de Claude ou Codex.

Essa responsabilidade pertence ao adapter.

Exemplo:

```text
ClaudeCodeRunner
"usage limit reached"
        ↓
quota_exceeded
```

```text
CodexRunner
authentication/session failure
        ↓
auth_required
```

Guardar também a mensagem original nos logs para diagnóstico, mas decisões de workflow devem usar o código normalizado.

---

# 23. Falha e retry

O orchestrator deve possuir retry limitado.

Exemplo:

```yaml
retry:
  maxAttempts: 2
```

Não fazer retry automático quando:

```text
BLOCKED
```

BLOCKED deve exigir análise.

---

# 24. Escalonamento automático de modelo

Opcionalmente, permitir escalation.

Exemplo:

```text
Terra Medium
    ↓ falhou 2 vezes
Sol High
```

Config:

```yaml
routing:
  escalation:
    enabled: true
    afterFailures: 2
```

Importante:

o modelo/reasoning level pode ser escalado.

O runner pode mudar somente quando uma política de fallback explicitamente permitir.

O escopo da task não pode ser ampliado automaticamente.

---

# 25. Stage 7 — Verification

Após implementar todas as tasks:

executar os comandos configurados no projeto.

Exemplo NestJS:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Flutter:

```bash
flutter analyze
flutter test
flutter build apk --debug
```

Salvar:

```text
.agent-flow/reviews/verification.md
```

---

# 26. Verification Agent

Além dos comandos, usar a role:

```text
verification
```

Configuração inicial recomendada:

```text
Codex / GPT-5.6 Terra / medium
```

para revisar:

- erros óbvios;
- inconsistências;
- testes ausentes;
- imports;
- código morto;
- aderência aos padrões do projeto.

---

# 27. Stage 8 — Final Review

Usar a role:

```text
finalReviewer
```

Configuração inicial recomendada:

```text
Claude Code / Opus / very_high
```

Entrada:

```text
approved SDD
plan
git diff
test results
```

Não fornecer todo histórico dos agentes.

Prompt:

```text
Compare the final implementation against the approved SDD.

Check:

- missing requirements
- implementation outside scope
- architectural deviations
- missing tests
- edge cases
- security regressions
- database risks
- API contract inconsistencies

Do not implement fixes.

Return PASS or FAIL.

When FAIL, produce structured findings.
```

---

# 28. Finding format

```json
{
  "severity": "high",
  "type": "missing_requirement",
  "requirement": "FR-04",
  "description": "...",
  "suggestedAction": "..."
}
```

---

# 29. Correções pós-review

Se Final Review retornar FAIL:

criar tasks corretivas.

Exemplo:

```text
FIX-001
FIX-002
```

Essas tasks entram novamente no mesmo pipeline:

```text
route
↓
execute
↓
verify
↓
final review
```

---

# 30. CLI

Comandos mínimos:

```bash
agent-flow doctor
```

Valida runners e dependências locais.

```bash
agent-flow init
```

Inicializa projeto.

```bash
agent-flow feature "description"
```

Cria novo workflow.

```bash
agent-flow status
```

Exibe status.

```bash
agent-flow approve
```

Aprova SDD e plano.

```bash
agent-flow reject
```

Rejeita.

```bash
agent-flow revise "instruction"
```

Solicita revisão.

```bash
agent-flow run
```

Executa tasks aprovadas.

```bash
agent-flow task TASK-004
```

Executa task específica.

```bash
agent-flow retry TASK-004
```

Refaz task.

```bash
agent-flow review
```

Executa revisão final.

```bash
agent-flow clean
```

Remove worktrees temporários.

---

# 31. Saída do status

Exemplo:

```text
Feature: recurring-bookings
Run: AF-2026-001

PLANNING

Discovery       ✓
Architecture    ✓
SDD             ✓
Task Planning   ✓
Plan Review     ✓
Approval        ✓

IMPLEMENTATION

TASK-001  Luna   medium  completed
TASK-002  Terra  medium  completed
TASK-003  Sol    high    running
TASK-004  Terra  medium  queued
TASK-005  Terra  medium  queued

Progress: 2 / 14

Verification    pending
Final Review    pending
```

---

# 32. Persistência de estado

Arquivo:

```text
.agent-flow/state.json
```

Exemplo:

```json
{
  "runId": "AF-2026-001",
  "feature": "recurring-bookings",

  "stage": "implementation",

  "approved": true,

  "createdAt": "...",
  "updatedAt": "..."
}
```

O processo deve ser retomável.

Se o terminal for fechado:

```bash
agent-flow status
agent-flow run
```

deve continuar do último estado válido.

---

# 33. Logs

Salvar:

```text
.agent-flow/logs/
```

Estrutura:

```text
discovery.log
sdd.log
planning.log
TASK-001.log
TASK-002.log
verification.log
final-review.log
```

Nunca depender apenas da saída do terminal.

---

# 34. Run history

Cada feature deve possuir histórico.

Exemplo:

```text
.agent-flow/runs/
├── AF-2026-001/
├── AF-2026-002/
└── AF-2026-003/
```

O estado atual pode apontar para um run específico.

---

# 35. Segurança

Discovery, Architecture, SDD e Planning:

```text
READ ONLY
```

Implementation:

```text
WRITE PROJECT FILES
```

Não permitir automaticamente:

- push;
- deploy;
- acesso a produção;
- migration em produção;
- alteração de secrets;
- comandos destrutivos.

Essas ações devem exigir aprovação explícita.

---

# 36. Comandos proibidos por padrão

Bloquear:

```text
rm -rf /
git push --force
terraform destroy
kubectl delete namespace
DROP DATABASE
```

Criar camada configurável de command guard.

---

# 37. Integração com AGENTS.md

O `AGENTS.md` deve conter regras permanentes específicas do projeto.

Exemplo:

```markdown
# Project Instructions

## Architecture

- Controllers only handle transport concerns.
- Business logic belongs to services/use-cases.
- Repositories encapsulate persistence.
- Do not access Prisma from controllers.

## Tests

Every business rule change requires tests.

## Database

Never modify production data directly.

## Flutter

Widgets must not contain business rules.
```

O workflow deve sempre fornecer `AGENTS.md` aos agentes.

---

# 38. Configuração padrão reutilizável

A ferramenta deve funcionar imediatamente após:

```bash
agent-flow init
```

O usuário só deve customizar quando necessário.

Objetivo:

```text
80% global
20% project-specific
```

Evitar configuração extensa em cada repositório.

---

# 39. Suporte a monorepo

Configuração:

```yaml
project:
  type: monorepo

workspaces:
  api:
    path: apps/api
    type: nestjs

  mobile:
    path: apps/mobile
    type: flutter

  web:
    path: apps/web
    type: react
```

Cada task deve indicar:

```json
{
  "workspace": "api"
}
```

ou múltiplos:

```json
{
  "workspaces": [
    "api",
    "mobile"
  ]
}
```

Tasks cross-workspace devem ser consideradas no mínimo:

```text
normal
```

e frequentemente:

```text
complex
```

---

# 40. SDD IDs

Requisitos devem possuir IDs.

Exemplo:

```text
FR-001
FR-002
NFR-001
SEC-001
```

Tasks devem referenciar requisitos:

```json
{
  "requirements": [
    "FR-001",
    "FR-003"
  ]
}
```

Isso permite validar cobertura.

---

# 41. Coverage check

O planner deve garantir:

```text
Requirement → Task
```

E o reviewer deve detectar:

```text
FR-004 has no implementation task
```

---

# 42. Definition of Done

Feature concluída apenas quando:

```text
SDD approved
+
all tasks completed
+
tests passing
+
lint passing
+
build passing
+
final SDD review PASS
```

Não considerar apenas:

```text
agent said completed
```

---

# 43. Arquitetura multi-runner

A arquitetura deve abstrair completamente o executor.

Interface:

```typescript
interface AgentRunner {
  id: string;

  capabilities(): RunnerCapabilities;

  run(input: AgentRunInput): Promise<AgentRunResult>;

  healthCheck(): Promise<RunnerHealth>;
}
```

Implementações obrigatórias no MVP:

```text
CodexRunner
ClaudeCodeRunner
```

Futuras:

```text
OpenCodeRunner
ClineRunner
LocalModelRunner
ApiRunner
```

O core do workflow não deve depender diretamente do Codex nem do Claude Code.

---

## 43.1. Runner capabilities

Nem todos os runners possuem os mesmos recursos.

Definir capabilities:

```typescript
interface RunnerCapabilities {
  supportedReasoningLevels: ReasoningLevel[];
  supportsReadOnly: boolean;
  supportsStructuredOutput: boolean;
  supportsNonInteractive: boolean;
  supportsWorkingDirectory: boolean;
}
```

Antes de executar uma role, validar se o runner configurado possui capabilities compatíveis.

Não espalhar condições como:

```typescript
if (runner === "claude") ...
if (runner === "codex") ...
```

fora dos adapters/configuration resolution.

---

## 43.2. CodexRunner

Responsável exclusivamente por:

```text
Codex CLI invocation
Codex arguments
reasoning translation
working directory
stdout/stderr
exit codes
auth/quota error translation
structured result parsing
```

O runner deve reutilizar a autenticação local existente do Codex CLI.

Não armazenar credenciais.

---

## 43.3. ClaudeCodeRunner

Responsável exclusivamente por:

```text
Claude Code CLI invocation
Claude arguments
reasoning translation
working directory
stdout/stderr
exit codes
auth/quota error translation
structured result parsing
```

O runner deve reutilizar a autenticação local existente do Claude Code.

Não armazenar credenciais.

---

## 43.4. Runner resolver

Adicionar:

```typescript
interface RunnerResolver {
  resolve(role: WorkflowRole): ResolvedAgentConfig;
}
```

Saída:

```typescript
interface ResolvedAgentConfig {
  runner: string;
  model: string;
  reasoning: ReasoningLevel;
}
```

Stages trabalham com roles.

Nunca com nomes físicos de modelos.

---

# 44. Integração futura com gateways

Opcional e fora do MVP inicial:

```text
LiteLLM
OpenRouter
LM Studio
Ollama
```

A camada de routing deve escolher o papel lógico:

```text
architect
normal_executor
complex_executor
```

O provider resolve o modelo físico.

---

# 45. Estrutura TypeScript sugerida

```text
src/

core/
  orchestrator.ts
  stage.ts
  task.ts
  workflow.ts

config/
  config-loader.ts
  config-merger.ts

workflow/
  discovery-stage.ts
  architecture-stage.ts
  sdd-stage.ts
  planning-stage.ts
  review-stage.ts
  implementation-stage.ts
  verification-stage.ts

routing/
  model-router.ts
  escalation.ts

runners/
  agent-runner.ts
  runner-capabilities.ts
  runner-resolver.ts
  codex-runner.ts
  claude-code-runner.ts

git/
  worktree-manager.ts
  branch-manager.ts

state/
  state-store.ts
  run-store.ts

schemas/
  task.schema.ts
  plan.schema.ts
  config.schema.ts

cli/
  init.ts
  feature.ts
  approve.ts
  status.ts
  run.ts
  retry.ts
  review.ts
```

---

# 46. Core interfaces

```typescript
export type ReasoningLevel =
  | "low"
  | "medium"
  | "high"
  | "very_high";

export interface AgentRoleConfig {
  runner: string;
  model: string;
  effort: ReasoningLevel;
}

export interface ResolvedAgentConfig {
  runner: string;
  model: string;
  reasoning: ReasoningLevel;
}

export interface RunnerCapabilities {
  supportedReasoningLevels: ReasoningLevel[];
  supportsReadOnly: boolean;
  supportsStructuredOutput: boolean;
  supportsNonInteractive: boolean;
  supportsWorkingDirectory: boolean;
}

export interface Task {
  id: string;
  title: string;
  description: string;

  complexity: "trivial" | "normal" | "complex";
  risk: "low" | "medium" | "high";

  dependencies: string[];

  requirements: string[];

  flags: {
    databaseChange: boolean;
    crossModule: boolean;
    architectureDecision: boolean;
    externalIntegration: boolean;
  };

  acceptanceCriteria: string[];
  validation: string[];
}

export interface AgentRunner {
  id: string;

  capabilities(): RunnerCapabilities;

  healthCheck(): Promise<RunnerHealth>;

  run(input: AgentRunInput): Promise<AgentRunResult>;
}
```

---

# 47. Scheduler

O scheduler deve:

1. carregar `plan.json`;
2. identificar tasks sem dependências pendentes;
3. marcar como `ready`;
4. respeitar `maxParallelTasks`;
5. criar worktrees;
6. executar agentes;
7. persistir resultados;
8. liberar tasks dependentes;
9. interromper pipeline em falhas críticas.

Pseudo:

```typescript
while (!workflow.finished()) {
  const readyTasks = workflow.getReadyTasks();

  const batch = readyTasks.slice(
    0,
    config.parallelism.maxTasks
  );

  await Promise.all(
    batch.map(task => executor.execute(task))
  );

  await state.persist();
}
```

---

# 48. MVP

Não implementar tudo inicialmente.

## MVP 1

Construir:

- CLI;
- config global/local;
- role resolver;
- reasoning abstraction;
- `doctor`;
- `init`;
- `feature`;
- discovery;
- SDD;
- planning;
- plan review;
- approve;
- `AgentRunner`;
- `CodexRunner`;
- `ClaudeCodeRunner`;
- runner capabilities;
- error normalization;
- fallback básico para quota/auth/unavailable;
- routing;
- execução sequencial;
- verification;
- final review;
- state persistence.

O MVP 1 deve funcionar usando apenas CLIs locais autenticadas.

Não exigir:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
```

para o fluxo baseado em assinaturas locais.

---

## MVP 2

Adicionar:

- worktrees;
- paralelismo;
- DAG scheduler;
- retry;
- escalation.

---

## MVP 3

Adicionar:

- monorepo;
- dashboards;
- métricas;
- LiteLLM;
- múltiplos executores;
- GitHub Issues;
- Linear;
- Symphony.

---

# 49. Primeiro caso de uso

Validar o MVP em dois projetos diferentes.

Exemplo:

```text
Projeto A
NestJS + PostgreSQL
```

e:

```text
Projeto B
Flutter
```

Antes dos testes, validar:

```bash
agent-flow doctor
```

O mesmo CLI deve funcionar:

```bash
agent-flow init

agent-flow feature \
  "Adicionar funcionalidade X"
```

Sem alterar o código do orquestrador.

Apenas `.agent-flow/config.yaml` pode variar.

---

# 50. Critério principal de sucesso

A implementação será considerada bem-sucedida se:

1. o workflow puder ser instalado globalmente;
2. funcionar em projetos diferentes;
3. não exigir copiar scripts entre projetos;
4. o projeto possuir apenas configuração local;
5. modelos forem roteados automaticamente;
6. planning e coding forem contextos independentes;
7. nenhuma implementação iniciar sem approval;
8. tasks puderem ser retomadas;
9. execução e decisões forem auditáveis;
10. troca de runner/modelo não exigir reescrever o core;
11. Codex CLI e Claude Code CLI funcionarem como runners de primeira classe;
12. autenticação local permanecer responsabilidade das CLIs;
13. o Agent Flow não armazenar credenciais;
14. roles poderem usar providers diferentes;
15. plan review e final review poderem ser cross-provider;
16. fallback ocorrer apenas para categorias explicitamente configuradas.

---

# 51. Ordem recomendada de implementação

```text
TASK-001
Criar estrutura base TypeScript + CLI.

TASK-002
Implementar config loader global/local.

TASK-003
Criar schemas de config, roles, task e plan.

TASK-004
Criar ReasoningLevel e abstração de role.

TASK-005
Criar state store.

TASK-006
Definir AgentRunner e RunnerCapabilities.

TASK-007
Implementar RunnerResolver.

TASK-008
Implementar CodexRunner.

TASK-009
Implementar ClaudeCodeRunner.

TASK-010
Implementar normalização de erros dos runners.

TASK-011
Implementar agent-flow doctor.

TASK-012
Implementar prompt loader.

TASK-013
Implementar Discovery stage.

TASK-014
Implementar SDD stage.

TASK-015
Implementar Planning stage.

TASK-016
Implementar Plan Review cross-provider.

TASK-017
Implementar Human Approval gate.

TASK-018
Implementar Model/Role Router.

TASK-019
Implementar task executor sequencial.

TASK-020
Implementar fallback controlado.

TASK-021
Implementar verification commands.

TASK-022
Implementar Final Review cross-provider.

TASK-023
Implementar resume/retry.

TASK-024
Implementar WorktreeManager.

TASK-025
Implementar DAG Scheduler.

TASK-026
Implementar execução paralela.

TASK-027
Implementar stack detection no init.

TASK-028
Validar em projeto NestJS.

TASK-029
Validar em projeto Flutter.

TASK-030
Documentar instalação, autenticação e uso.
```

---

# 52. Instrução principal para o Codex

Ao implementar este projeto:

```text
Não trate este documento como uma sugestão de arquitetura.

Ele é a especificação funcional e arquitetural inicial do Agent Flow.

Implemente primeiro um MVP funcional e pequeno.

Priorize:
- separação de responsabilidades;
- adaptadores;
- persistência simples;
- CLI previsível;
- execução determinística;
- facilidade de manutenção.

Não introduza:
- banco externo;
- servidor web;
- dashboard;
- filas distribuídas;
- Kubernetes;
- serviços adicionais;
- dependência obrigatória de API key para Codex ou Claude Code;
- LiteLLM/OpenRouter no MVP inicial;

antes que o workflow local básico esteja validado.

O produto inicial deve ser uma ferramenta CLI local.
```

---

# 53. Resultado esperado

Ao final, o usuário deve poder validar seu ambiente:

```bash
agent-flow doctor
```

E depois entrar em qualquer projeto e executar:

```bash
agent-flow init
```

Depois:

```bash
agent-flow feature \
  "Implementar recorrência de agendamentos"
```

Receber:

```text
✓ Repository analyzed
✓ Architecture mapped
✓ SDD generated
✓ 14 tasks generated
✓ Plan reviewed

WAITING FOR APPROVAL
```

Executar:

```bash
agent-flow approve
agent-flow run
```

E acompanhar:

```text
TASK-001  Luna   medium  ✓
TASK-002  Terra  medium  ✓
TASK-003  Sol    high    running
TASK-004  Terra  medium  queued
```

Até:

```text
✓ Implementation complete
✓ Tests passing
✓ Build passing
✓ SDD compliance PASS

FEATURE COMPLETE
```

O workflow deve ser o mesmo independentemente de o repositório ser Flutter, NestJS, React, Node.js ou outra stack suportada.


---

# 54. Decisão arquitetural — assinaturas locais como runners

O MVP deve priorizar os executores locais já autenticados pelo usuário:

```text
Claude Team
   ↓
Claude Code CLI
   ↓
ClaudeCodeRunner

ChatGPT / Codex entitlement
   ↓
Codex CLI
   ↓
CodexRunner
```

O Agent Flow não deve assumir que possuir uma assinatura equivale a possuir uma API key.

São mecanismos independentes.

O modo CLI deve funcionar sem API key quando a própria ferramenta oficial já estiver autenticada.

API providers poderão ser adicionados no futuro através de novos runners/adapters.

---

# 55. Política de fallback

Fallback é infraestrutura, não estratégia de correção.

Permitido:

```text
quota_exceeded
runner_unavailable
auth_required
```

Exemplo:

```text
architect
Claude Opus very_high
       ↓ quota_exceeded

fallback
Codex Sol high
```

Não permitido automaticamente:

```text
modelo gerou implementação ruim
       ↓
tentar outro modelo
```

Nesse caso:

```text
validation_failed
review_required
```

A falha deve permanecer visível.

---

# 56. Política de independência entre autor e reviewer

Quando houver dois runners disponíveis, a configuração padrão deve preferir:

```text
Author != Reviewer
```

Exemplos:

```text
Claude cria SDD
Codex cria plano
Claude revisa plano
```

e:

```text
Codex implementa
Claude revisa implementação
```

Não é requisito rígido.

Se apenas um runner estiver disponível, o workflow deve continuar funcionando.

O sistema deve degradar de forma previsível:

```text
2 runners
→ cross-provider review

1 runner
→ same-provider independent context review
```

Mesmo usando o mesmo provider, o reviewer deve receber um contexto novo contendo apenas os artefatos necessários para a revisão.

---

# 57. Não objetivos do MVP

Não fazem parte do MVP:

- gerenciamento de billing das assinaturas;
- descoberta exata da cota restante do usuário;
- scraping de interfaces de ChatGPT ou Claude;
- armazenamento de tokens OAuth;
- interceptação de credentials;
- automação de login;
- integração obrigatória com API oficial;
- balanceamento por custo monetário real;
- dashboard remoto.

O Agent Flow pode registrar sua própria telemetria local de execuções:

```json
{
  "runner": "codex",
  "model": "gpt-5.6-terra",
  "role": "executor.normal",
  "startedAt": "...",
  "finishedAt": "...",
  "status": "completed"
}
```

Essa telemetria é operacional e não deve ser apresentada como billing oficial.

---

# 58. Compatibilidade universal entre projetos

O fato de o MVP possuir dois runners não altera o requisito principal:

```text
Agent Flow é instalado uma vez
        ↓
qualquer repositório
        ↓
agent-flow init
```

Nenhum adapter pode conter regras específicas de:

```text
Flutter
NestJS
React
BeaHub
```

Regras de stack continuam pertencendo a:

```text
stack detection
project config
AGENTS.md
plugins/adapters futuros
```

Os runners apenas executam agentes.

---

# 59. Web UI — Visão Geral

A Web UI é uma camada visual opcional sobre o mesmo core do Agent Flow.

Ela NÃO substitui o CLI.

Arquitetura:

```text
@agent-flow/core
      ↑
 ┌────┴─────┐
 │          │
CLI      Local Server
            │
         Web UI
```

Objetivo:

```text
Agent Flow Core + CLI + Local API + Dashboard Web
```

A interface deve ser iniciada por:

```bash
agent-flow ui
```

e disponibilizada, por padrão, em:

```text
http://localhost:4782
```

A UI é uma superfície de controle e observabilidade. Toda regra de workflow continua pertencendo ao core.

---

# 60. Princípios da Web UI

A interface deve:

1. ser local-first;
2. não exigir login no MVP;
3. não depender de cloud;
4. reutilizar o core existente;
5. nunca duplicar regras de negócio do CLI;
6. consumir o estado persistido do Agent Flow;
7. receber atualizações em tempo real;
8. permitir gates humanos de aprovação/revisão;
9. tornar routing, execução e findings visíveis;
10. funcionar em múltiplos projetos locais.

A UI não deve:

- chamar Claude ou Codex diretamente do browser;
- acessar credenciais;
- implementar state machine paralela;
- substituir o StateStore;
- aceitar paths arbitrários sem validação;
- mover lógica de workflow para React.

---

# 61. Referência Visual Oficial

Arquivo de referência:

```text
docs/assets/agent-flow-ui-reference.png
```

A implementação deve reproduzir a mesma linguagem visual:

```text
dark mode
sidebar fixa
topbar compacta
cards com bordas suaves
accent roxo
status em verde/azul/amarelo/vermelho
pipeline horizontal
tabela principal
painel lateral de detalhes
cards inferiores de métricas
```

Estrutura:

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Topbar                                                               │
├───────────────┬──────────────────────────────────────────────────────┤
│               │ Run Header                                           │
│               ├──────────────────────────────────────────────────────┤
│ Sidebar       │ Stage Pipeline                                       │
│               ├──────────────────────────────┬───────────────────────┤
│               │ Task Table                   │ Task Inspector        │
│               │                              │                       │
│               ├──────────────┬───────────────┴─────────────┬─────────┤
│               │ Artifacts    │ Approval / Execution Summary│ Models  │
└───────────────┴──────────────┴─────────────────────────────┴─────────┘
```

---

# 62. Stack Web Recomendada

Frontend:

```text
React
TypeScript
Vite
Tailwind CSS
Radix UI
Lucide Icons
TanStack Query
React Router
React Flow
Recharts
```

Backend local:

```text
Fastify
TypeScript
SSE
Zod
```

Motivos:

- Vite: bundle local simples e rápido;
- React: composição forte para dashboard;
- Tailwind: precisão de layout e tokens;
- Radix: primitives acessíveis;
- TanStack Query: server-state;
- React Flow: DAG;
- Recharts: métricas e donut;
- Fastify: API local leve;
- SSE: suficiente para eventos server → browser.

WebSocket fica fora do MVP.

---

# 63. Estrutura Após Introdução da UI

```text
agent-flow/
├── apps/
│   ├── cli/
│   ├── server/
│   │   └── src/
│   │       ├── http/
│   │       ├── routes/
│   │       ├── sse/
│   │       └── server.ts
│   └── web/
│       └── src/
│           ├── app/
│           ├── components/
│           ├── features/
│           ├── pages/
│           ├── hooks/
│           ├── lib/
│           └── styles/
├── packages/
│   ├── core/
│   ├── contracts/
│   ├── config/
│   ├── adapters/
│   └── shared/
└── prompts/
```

Regra:

```text
Web e Server podem depender do Core.
Core nunca depende de Web ou Server.
```

Se a migração para monorepo introduzir risco, ela pode ocorrer incrementalmente.

---

# 64. Comando `agent-flow ui`

```bash
agent-flow ui
agent-flow ui --port 4782
agent-flow ui --host 127.0.0.1
agent-flow ui --no-open
agent-flow ui ~/wk
```

Comportamento:

1. resolve o diretório/projeto atual;
2. inicializa Local Server;
3. serve o frontend;
4. registra o projeto atual;
5. opcionalmente abre o browser.

---

# 65. Workspace Mode

```bash
agent-flow ui ~/wk
```

Descobre projetos com:

```text
.agent-flow/config.yaml
```

Exemplo:

```text
BeaHub API
  AF-104 running

BeaHub Web
  idle

BFlow
  waiting approval

Company Project
  final review
```

Config:

```yaml
ui:
  workspaceDepth: 2
```

Não fazer scan recursivo ilimitado.

---

# 66. Layout Global

Alvo visual principal:

```text
1440 × 900
```

Dimensões:

```text
Sidebar: 216px
Topbar: 56px
Page padding: 18px
Inspector: ~480px
Card radius: 10–12px
```

Breakpoints:

```text
>= 1440   layout completo
1200-1439 inspector reduzido
1024-1199 inspector como drawer
< 1024    funcional, não prioridade visual
```

---

# 67. Design Tokens

Não usar cores soltas nos componentes.

Exemplo:

```css
:root {
  --af-bg: #08111f;
  --af-surface: #0f1a2a;
  --af-surface-2: #131f31;
  --af-border: rgba(148, 163, 184, 0.14);

  --af-text: #f8fafc;
  --af-text-muted: #94a3b8;

  --af-primary: #7c3aed;
  --af-primary-soft: rgba(124, 58, 237, 0.18);

  --af-success: #34d399;
  --af-info: #3b82f6;
  --af-warning: #fbbf24;
  --af-danger: #f87171;

  --af-radius-sm: 8px;
  --af-radius-md: 10px;
  --af-radius-lg: 12px;

  --af-sidebar-width: 216px;
}
```

Tipografia:

```text
Inter / system sans-serif
body 13–14px
labels 12px
titles 16–22px
metrics 18–24px
```

---

# 68. Sidebar

Conteúdo:

```text
AGENT FLOW

Dashboard
Runs
Projects
Agents & Models
Prompts
Analytics
Settings

PROJECTS
beahub-api
beahub-web
bflow
company-project

+ Add Project
```

Componentes:

```text
Sidebar
SidebarLogo
SidebarNavItem
ProjectList
ProjectStatusDot
AddProjectButton
```

Projeto ativo: background roxo discreto.

---

# 69. Topbar

Conteúdo:

```text
workspace / project / Runs / AF-104

Agent Flow is running
Docs
Theme
Local/User indicator
```

---

# 70. Run Header

Conteúdo:

```text
AF-104
RUNNING
Implementar Agendamentos Recorrentes

Iniciado por você
Hoje às 19:34
Duração 41m22s

Progresso geral 78%

[View as DAG]
[Logs]
[Actions]
```

Actions:

```text
Pause
Resume
Cancel
Retry failed
Open artifacts folder
```

---

# 71. Pipeline Horizontal

Stages:

```text
Discovery
Architecture Impact
SDD
Planning
Plan Review
Approval
Implementation
Verification
Final Review
```

Estados:

```text
pending
running
completed
failed
blocked
waiting_approval
```

Cores:

```text
completed -> success
running -> primary
pending -> muted
failed -> danger
waiting -> warning
```

Clique no stage abre metadata/artifact/log.

---

# 72. Task Table

Resumo superior:

```text
Total 14
Concluídas 7
Em andamento 2
Aguardando 3
Falharam 0
```

Colunas:

```text
ID
Task
Complexity
Agent / Model
Status
Duration
Actions
```

Filtros:

```text
status
complexity
runner
model
workspace
requirement
```

Busca:

```text
task id
title
requirement id
```

---

# 73. Task Inspector

Painel direito.

Header:

```text
TASK-003
EM ANDAMENTO

Recurrence Repository
Implementar repositório para recorrências
```

Metadata:

```text
Agente: Codex CLI
Modelo: GPT-5.6 Terra
Esforço: Medium
Iniciado em: 19:56:42
Duração: 3m42s
Tentativas: 1
```

Tabs:

```text
Logs
Arquivos
Testes
Contexto
```

---

# 74. Logs Tab

Exemplo:

```text
[19:56:42] Task started
[19:56:43] Analyzing codebase...
[19:56:45] Reading recurrence entity...
[19:57:01] Adding methods...
[19:59:02] Running tests...
[19:59:12] All tests passed
```

Requisitos:

```text
SSE live updates
auto-scroll opcional
pause scroll
copy
download
stdout/stderr/events filter
```

Sanitizar ANSI.

---

# 75. Arquivos Tab

Mostrar:

```text
Files changed (4)
```

Com status:

```text
added
modified
deleted
```

MVP:

```text
lista + git diff --stat
```

Inline diff fica para evolução posterior.

---

# 76. Tests Tab

Exemplo:

```text
18 tests
18 passed
0 failed
0 skipped
```

Mostrar:

```text
command
exit code
duration
stdout summary
stderr
```

---

# 77. Context Tab

Mostrar somente metadata segura:

```text
Requirements
Dependencies
Acceptance Criteria
Working Directory
Runner
Model
Reasoning
```

Nunca secrets ou auth.

---

# 78. Cards Inferiores

## Artifacts

```text
SDD                  v1.2.0 ✓
Plan                 v1.3.0 ✓
Architecture Impact  v1.0.0 ✓
```

## Approval

```text
Aprovado por você em 19:12
Hash: a1b2c3d4

[Ver plano aprovado]
[Solicitar revisão]
```

## Execution Summary

```text
Tasks concluídas  7 / 14
Tests passando   32 / 32
Cobertura FRs    100%
Issues              2
```

## Model Usage

```text
GPT-5.6 Sol      32%
GPT-5.6 Terra    53%
GPT-5.6 Luna     15%
```

Também mostrar:

```text
runs
tempo
retries
fallbacks
```

Nunca chamar isso de billing oficial.

---

# 79. Página Runs

Rota:

```text
/runs
```

Tabela:

```text
AF-104 Recurring appointments   Running
AF-103 Fix WhatsApp webhook     Completed
AF-102 Product recommendations  Failed
AF-101 Official stores          Completed
```

---

# 80. Página Run Detail

Rota:

```text
/projects/:projectId/runs/:runId
```

Composição:

```text
RunHeader
StagePipeline
TaskTable
TaskInspector
ArtifactsCard
ApprovalCard
ExecutionSummaryCard
ModelUsageCard
```

Essa é a tela prioritária e deve corresponder à referência visual.

---

# 81. Página Projects

Rota:

```text
/projects
```

Cards:

```text
name
path
stack
current run
last run
status
```

---

# 82. Página Agents & Models

Rota:

```text
/agents
```

Editar roles:

```text
architect
sdd
planner
planReviewer
executor.trivial
executor.normal
executor.complex
verification
finalReviewer
```

Exemplo:

```text
Planner
Runner: Codex
Model: GPT-5.6 Sol
Reasoning: High
Fallback: Claude Code / Opus / High
```

Mostrar runner health.

---

# 83. Página Prompts

Rota:

```text
/prompts
```

MVP:

```text
viewer read-only
```

Mostrar versão dos prompts.

Futuro:

```text
editor
history
evaluations
```

---

# 84. Página Analytics

Rota:

```text
/analytics
```

Métricas:

```text
runs por projeto
tasks por status
model distribution
fallbacks
retries
tempo por stage
tempo por complexity
```

---

# 85. Página Settings

Rota:

```text
/settings
```

Seções:

```text
General
Workspace
Runners
Models
Execution
UI
Retention
```

---

# 86. API Local

Prefixo:

```text
/api/v1
```

Endpoints:

```text
GET  /health
GET  /projects
POST /projects
GET  /projects/:id

GET  /runs
GET  /runs/:runId
GET  /runs/:runId/stages
GET  /runs/:runId/tasks
GET  /runs/:runId/tasks/:taskId
GET  /runs/:runId/artifacts

POST /runs/:runId/approve
POST /runs/:runId/reject
POST /runs/:runId/revise
POST /runs/:runId/start
POST /runs/:runId/pause
POST /runs/:runId/resume
POST /runs/:runId/cancel

POST /runs/:runId/tasks/:taskId/retry

GET   /config
PATCH /config

GET /runners
GET /runners/health
```

---

# 87. SSE

Endpoint:

```text
GET /api/v1/events
```

Eventos:

```text
run.created
run.updated
run.completed
run.failed

stage.started
stage.completed
stage.failed

task.queued
task.started
task.updated
task.completed
task.failed
task.blocked

approval.requested
approval.completed

runner.health_changed
log.appended
```

Envelope:

```json
{
  "type": "task.updated",
  "projectId": "beahub-api",
  "runId": "AF-104",
  "timestamp": "2026-08-09T19:56:43-03:00",
  "payload": {}
}
```

---

# 88. Estado do Frontend

TanStack Query para:

```text
projects
runs
tasks
artifacts
config
health
```

Estado local somente para:

```text
selected task
sidebar state
filters
tabs
UI preferences
```

Não duplicar `RunState`.

---

# 89. Atualização em Tempo Real

```text
Agent Flow Core
       ↓
StateStore / EventStore
       ↓
Server
       ↓ SSE
Browser
       ↓
TanStack Query cache
```

Fallback:

```text
polling 10s
```

apenas quando SSE estiver desconectado.

---

# 90. Human Gates na UI

Approval modal:

```text
Plan Review: PASS

SDD version: ...
Plan version: ...
Plan hash: a1b2c3d4

[Request revision]
[Approve Plan]
```

O servidor recalcula o hash.

Nunca confiar em hash vindo do browser.

---

# 91. Revision UX

Modal:

```text
O que deve mudar?

[ textarea ]

[Cancelar] [Solicitar revisão]
```

Approval anterior é invalidado.

---

# 92. DAG View

Botão:

```text
View as DAG
```

React Flow nodes:

```text
task
status
complexity
model
duration
```

Edges = dependencies.

Controls:

```text
fit view
zoom
filter
highlight selected path
```

Critical path fica para versão posterior.

---

# 93. Segurança da UI Local

Default:

```text
127.0.0.1
```

Nunca `0.0.0.0` por padrão.

Se exposto:

```bash
agent-flow ui --host 0.0.0.0
```

mostrar warning.

Validar project roots.

Nunca expor:

```text
~/.codex/auth.json
Claude credentials
environment secrets
```

---

# 94. Empty States

Sem projeto:

```text
No Agent Flow project found.

[Initialize current directory]
[Add project]
```

Sem run:

```text
No runs yet.

[Create feature]
```

Waiting approval:

```text
Plan ready for review.

[Review SDD]
[Review Plan]
```

Runner offline:

```text
Codex unavailable.
Workflow can continue using Claude fallback.
```

---

# 95. Error UX

Mostrar:

```text
what happened
where
whether workflow stopped
suggested action
```

Exemplo:

```text
TASK-004 failed validation

Command:
npm test -- recurrence

Exit code: 1

[View logs]
[Retry]
[Open task]
```

---

# 96. Performance

Metas:

```text
first paint < 1.5s local
navigation instantânea
500 tasks sem travar
SSE update < 500ms percebido
```

---

# 97. Acessibilidade

```text
keyboard navigation
visible focus
ARIA
AA contrast
status = icon + text
```

---

# 98. Testes da Web UI

Frontend:

```text
Vitest
Testing Library
Playwright
```

Server:

```text
Fastify inject
fake core services
```

E2E:

```text
Playwright
+
FakeAgentRunner
+
temporary project
```

Zero consumo de quota no CI.

---

# 99. Plano Detalhado de Implementação da Web UI

A UI só começa após o CLI/core ser funcionalmente validado.

## UI-00 — Gate de entrada

Pré-condição:

```text
CLI validado
pipeline real executando
state/artifacts estáveis
```

---

## UI-01 — Preparar packages compartilhados

Extrair/organizar core e contracts para consumo pelo server.

Aceite:

```text
CLI continua funcionando
testes existentes verdes
```

---

## UI-02 — Criar Local Server

Fastify.

Aceite:

```text
GET /api/v1/health -> 200
```

---

## UI-03 — Project Registry

Descoberta/registro de projetos.

Aceite:

```text
GET /projects
```

retorna projetos conhecidos.

---

## UI-04 — Run Read API

Implementar endpoints read-only de runs/tasks/artifacts.

---

## UI-05 — Event Bridge + SSE

State/Event store → SSE.

Aceite:

mudança de task aparece no browser sem refresh.

---

## UI-06 — Bootstrap Web

Criar:

```text
React
Vite
Tailwind
React Router
TanStack Query
```

---

## UI-07 — Design System

Primitives:

```text
Card
Badge
Button
Progress
Tabs
Tooltip
Dialog
Dropdown
StatusDot
```

Aceite:

página de demonstração reproduz os tokens da referência.

---

## UI-08 — App Shell

Implementar:

```text
Sidebar
Topbar
Content area
```

Aceite:

layout equivalente à referência.

---

## UI-09 — Projects Sidebar

Lista + status + active project.

---

## UI-10 — Run Header

Status, tempo, progresso e actions.

---

## UI-11 — Stage Pipeline

Todos os stages/estados visuais.

---

## UI-12 — Task Metrics

```text
Total
Completed
Running
Waiting
Failed
```

---

## UI-13 — Task Table

```text
sorting
filters
search
selection
status
model
duration
```

---

## UI-14 — Task Inspector

Tabs:

```text
Logs
Files
Tests
Context
```

---

## UI-15 — Live Logs

SSE → visual terminal.

---

## UI-16 — Artifacts Card

```text
SDD
Plan
Architecture Impact
```

---

## UI-17 — Approval Card

```text
approve
request revision
show hash
approval timestamp
```

---

## UI-18 — Execution Summary

```text
tasks
tests
FR coverage
issues
```

---

## UI-19 — Model Usage

Donut + legenda.

Dados:

```text
executions
percentage
runner
retries
fallbacks
```

---

## UI-20 — Run Detail Composition

Montar exatamente a composição da referência:

```text
Run Header
Stage Pipeline
Task Table + Inspector
Bottom Cards
```

Aceite visual:

```text
screenshot test 1440×900
sem overflow
inspector alinhado
bottom cards mesma altura
densidade próxima da referência
```

---

## UI-21 — Runs Page

Histórico e filtros.

---

## UI-22 — Projects Page

Cards e ações.

---

## UI-23 — Agents & Models

Editor visual de role routing.

---

## UI-24 — Prompts Page

Viewer read-only.

---

## UI-25 — Analytics Page

Métricas operacionais.

---

## UI-26 — Settings Page

Editar config.

---

## UI-27 — Write API

Ações:

```text
approve
reject
revise
start
pause
resume
cancel
retry
```

---

## UI-28 — DAG View

React Flow.

---

## UI-29 — Workspace Mode

```bash
agent-flow ui ~/wk
```

---

## UI-30 — Empty/Error/Degraded States

Implementar todos os estados definidos.

---

## UI-31 — E2E

Fluxo:

```text
open project
open run
watch task update
open inspector
approve plan
retry task
review final result
```

FakeRunner apenas.

---

## UI-32 — Visual Regression

Baselines:

```text
1440×900
1280×800
```

---

## UI-33 — Integrar `agent-flow ui`

CLI sobe server + web.

---

## UI-34 — Documentação

Documentar:

```text
UI architecture
routes
API
security
workspace mode
troubleshooting
```

---

# 100. Critério de Aceite Visual

A tela principal deve conter:

```text
✓ sidebar fixa
✓ projeto ativo em roxo
✓ breadcrumb superior
✓ run header grande
✓ progress bar
✓ stage pipeline horizontal
✓ task summary
✓ tabela escura
✓ status badges
✓ model/effort visíveis
✓ inspector lateral
✓ terminal logs
✓ artifact card
✓ approval card
✓ execution summary
✓ model usage donut
```

Não é necessário pixel-perfect absoluto.

É obrigatório preservar:

```text
hierarquia
densidade
espaçamento
proporções
contraste
linguagem visual
```

---

# 101. Ordem de Entrega da Interface

```text
Phase UI-A
Shell + Read-only Run Dashboard
UI-01 → UI-20

Phase UI-B
Actions / Approval / Retry
UI-21 → UI-27

Phase UI-C
DAG + Workspace + Analytics
UI-28 → UI-30

Phase UI-D
E2E + Visual Regression + Packaging
UI-31 → UI-34
```

Primeiro marco útil:

```text
agent-flow ui
      ↓
dashboard
      ↓
run atual
      ↓
task inspector + live logs
```

Segundo marco:

```text
approve / revise / retry
```

Terceiro marco:

```text
multi-project control plane
```

---

# 102. Resultado Final Esperado

```bash
cd qualquer-projeto
agent-flow ui
```

A aplicação abre:

```text
Dashboard
Runs
Projects
Agents & Models
Prompts
Analytics
Settings
```

A tela principal funciona como control plane visual de:

```text
planejamento
+
aprovação
+
execução
+
observabilidade
+
review
+
routing
```

sem duplicar o core.
