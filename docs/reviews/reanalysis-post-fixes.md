# Agent Flow — Reanálise Técnica Pós-Correções

**Repositório:** `lguilherme44/agent-flow`  
**HEAD analisado:** `8b0357c7b3bc739d5f36497f8de4d12e5b480e2a`  
**Data da revisão:** 2026-08-09  
**Base de comparação:** implementação atual, spec v3, plano aprovado e validation review anterior.

---

# 1. Resumo Executivo

A reanálise confirma que a implementação evoluiu significativamente após o ciclo de correções.

Os principais problemas levantados na revisão anterior foram, em sua maioria, corrigidos corretamente no código. Em especial:

- o boundary entre modelo e shell foi corrigido;
- fallback passou a existir de fato no runtime;
- resume após interrupção passou a recuperar tasks órfãs;
- TDD/test-first ganhou semântica explícita;
- single-task execution deixou de amputar o DAG;
- provenance passou a registrar melhor a execução real;
- Discovery ganhou fingerprint/invalidation;
- validation deixou de rodar duas vezes;
- timeout passou a matar a process tree em POSIX;
- `approvedAt` passou a ser persistido;
- metadata de prompt que funcionava como falsa constraint foi removida;
- mensagens de CLI foram atualizadas.

A arquitetura geral continua aprovada.

Porém, a reanálise encontrou novos gaps importantes, principalmente relacionados a:

1. **independência real de reviews sob fallback**;
2. **semântica de sucesso de `agent-flow task`**;
3. **provenance incompleta em falhas**;
4. **auditabilidade de fallback em todos os fluxos**;
5. **coerência entre `validationExpectation` e `validation[]`**;
6. **state machine declarada mas não aplicada como gate de produção**.

Portanto:

```text
Architecture: PASS

Security boundary:
PASS

Runtime reliability:
PASS with remaining gaps

MVP 1.1 gate:
CHANGES REQUIRED

Web UI gate:
CLOSED
```

---

# 2. Veredito Atual

```text
Architecture                    PASS
Provider abstraction            PASS
Model → shell trust boundary    PASS
Process timeout POSIX           PASS
Resume/interruption             PASS
TDD semantics                   PASS with edge case
Fallback execution              PASS
Fallback audit/provenance       CHANGES REQUIRED
Review independence             FAIL under fallback
Single-task execution           PARTIAL
Execution provenance            PARTIAL on failures
Discovery cache                 PASS with minor issue
Human approval                  PASS
Web UI gate                     CLOSED
```

---

# 3. Status dos Findings Anteriores

| Finding | Status atual |
|---|---|
| V-01 — model text reaches shell | FIXED |
| V-02 — fallback not connected to runtime | PARTIAL / functionally fixed |
| V-03 — resume after process kill | FIXED |
| V-04 — TDD RED/GREEN semantics | FIXED with edge case |
| V-05 — `agent-flow task` dependency graph | PARTIAL |
| V-06 — execution provenance | PARTIAL |
| V-07 — Discovery cache invalidation | FIXED |
| V-08 — duplicated validation execution | FIXED |
| V-09 — process tree timeout | FIXED on POSIX |
| V-10 — `approvedAt` | FIXED |
| V-11 — prompt role metadata | FIXED |
| V-12 — stale CLI copy | FIXED / minor cleanup may remain |

---

# 4. V-01 — Model Output → Shell Boundary

## Status

```text
FIXED
```

## O que foi corrigido

Antes:

```text
Task.validation
    ↓
free-form model string
    ↓
/bin/sh -c
```

Agora:

```text
Task.validation
    ↓
ValidationId
    ↓
ValidationRegistry
    ↓
trusted project config
    ↓
shell command
```

`Task.validation` deixou de ser uma lista arbitrária de shell commands e passou a aceitar apenas identificadores.

Exemplo:

```json
{
  "validation": ["test"]
}
```

A configuração humana/trusted resolve:

```yaml
commands:
  test: npm test
```

Além disso:

- `ValidationIdSchema` restringe o formato;
- `checkPlan()` rejeita ids inexistentes;
- `TaskExecutor` resolve os ids antes da execução;
- architecture tests impedem shell invocation fora da camada autorizada.

## Avaliação

Esse finding pode ser considerado encerrado.

## Invariante arquitetural resultante

```text
No model-authored string may directly become a shell command.
```

Essa regra deve permanecer protegida por testes arquiteturais.

---

# 5. V-09 — Timeout e Process Tree

## Status

```text
FIXED ON POSIX
```

## O que foi corrigido

`NodeProcessRunner` passou a spawnar children em process group em plataformas POSIX.

O timeout agora:

```text
SIGTERM process group
        ↓
grace period
        ↓
SIGKILL process group
```

Isso resolve o caso em que:

```text
parent
  └── child
       └── grandchild
```

mantinha stdout/stderr abertos e impedia a Promise do runner de finalizar.

Há testes reais de process tree comprovando:

- timeout retorna no tempo esperado;
- grandchild não sobrevive;
- processo normal continua funcionando.

## Limitação

Windows continua sem process-tree kill completo.

Isso está documentado e é aceitável enquanto Windows não for plataforma oficialmente suportada no MVP.

---

# 6. V-03 — Resume após Interrupção Real

## Status

```text
FIXED
```

Foi adicionado:

```text
interrupted
```

como estado explícito.

Fluxo:

```text
running
   ↓ process dies
orphan running
   ↓ scheduler restart
interrupted
   ↓ within retry budget
queued
   ↓
run again
```

Se o limite de tentativas já foi atingido:

```text
interrupted
```

permanece visível para intervenção humana.

Isso é melhor do que reutilizar:

```text
failed
```

porque uma máquina/processo interrompido não equivale semanticamente a uma implementação que falhou.

Também existe evento:

```text
task_interrupted
```

para auditabilidade.

Esse finding está resolvido adequadamente.

---

# 7. V-04 — Test-First / RED-GREEN

## Status

```text
FIXED WITH EDGE CASE
```

Foi criado:

```ts
validationExpectation:
  | "pass"
  | "fail"
  | "none"
```

Semântica:

```text
pass:
  validation deve passar

fail:
  validation deve falhar

none:
  validation não deve rodar
```

Isso permite:

```text
RED task:
expected fail

GREEN task:
expected pass
```

O judge também cobre corretamente o caso inverso:

```text
expected fail + validation passed
→ review_required
```

Isso evita aceitar um RED test que não testa nada ou um comportamento que já existia.

---

# 8. NOVO MEDIUM — `fail` sem validation commands

## Problema

Atualmente é possível representar:

```json
{
  "validation": [],
  "validationExpectation": "fail"
}
```

O judge considera:

```text
ran === 0
```

como `completed`.

Portanto uma task pode declarar:

```text
"a validação deveria falhar"
```

sem executar validação alguma e ainda assim terminar como concluída.

## Correção recomendada

Adicionar invariantes no TaskSchema.

### Regra 1

```text
validationExpectation === "fail"
→ validation.length > 0
```

### Regra 2

Preferencialmente:

```text
validationExpectation === "none"
→ validation.length === 0
```

### Regra 3

```text
validation.length === 0
→ expectation deve ser none ou pass
```

A semântica exata pode ser simplificada, desde que estados contraditórios sejam rejeitados no schema.

## Acceptance criteria

- [ ] `fail` sem validation ids é rejeitado.
- [ ] `none` não executa command.
- [ ] RED task com validation configurada continua funcionando.
- [ ] Existing normal tasks continuam default `pass`.

---

# 9. V-02 — Runtime Fallback

## Status

```text
FUNCTIONALLY FIXED
AUDITABILITY PARTIAL
```

Agora existe `createRunnerFactory()`.

O runtime deixa de retornar sempre um adapter puro e passa a criar o decorator de fallback por role.

Isso é importante porque fallback pertence à role, não ao runner.

Exemplo:

```text
executor.normal
  primary:
    codex / terra / medium

  fallback:
    claude / opus / high
```

O fallback resolve:

```text
runner
model
reasoning
timeout
```

da configuração secundária.

Isso corrige o bug anterior de potencialmente enviar:

```text
gpt-5.6-terra
```

ao Claude Code.

---

# 10. NOVO HIGH — Review Independence usa intenção, não execução real

Esse é o finding mais importante da reanálise atual.

## Problema

A independência do Plan Review é calculada aproximadamente como:

```text
configured planner runner
vs
configured planReviewer runner
```

Porém, fallback pode alterar quem executou realmente.

Exemplo:

```text
planner configured:
Codex

planReviewer configured:
Claude
```

Configuração implica:

```text
cross-provider
```

Mas:

```text
Claude unavailable
      ↓
planReviewer falls back
      ↓
Codex runs review
```

Execução real:

```text
planner  = Codex
reviewer = Codex
```

Logo:

```text
same-provider-fresh-context
```

Mas o artefato pode continuar registrando:

```text
cross-provider
```

## Impacto

HIGH.

Cross-provider review é uma garantia explícita do desenho do Agent Flow.

Registrar independência inexistente cria uma falsa garantia de qualidade.

## Root cause

A provenance real agora existe em:

```text
StageResult.execution
```

mas Plan Review e Final Review ainda reconstruem parte da identidade a partir de:

```text
resolveRole(...)
```

ou configuração estática.

## Correção recomendada

### Planning

Persistir provenance real do Planning stage:

```ts
planningExecution: {
  runner,
  model,
  reasoning,
  fallback?
}
```

Ao executar Plan Review:

```text
actual planning runner
vs
actual review runner
```

determina independence.

### Final Review

A independência deve considerar os runners que realmente implementaram as tasks:

```text
actual task result runners
vs
actual final-review runner
```

Não os executor roles configurados.

## Atenção adicional

O conceito ideal não deveria depender somente de `runner id`.

Dois aliases diferentes podem representar o mesmo provider.

Exemplo:

```yaml
runners:
  claudePrimary:
    type: claude-code-cli

  claudeBackup:
    type: claude-code-cli
```

Comparar ids diria:

```text
different runner
```

mas continuam sendo o mesmo provider.

Recomendação futura:

```ts
providerIdentity
```

ou:

```text
runner family/provider
```

exposto pelo adapter/registry.

## Acceptance criteria

- [ ] Plan Review independence usa execution provenance real.
- [ ] Final Review independence usa actual executor provenance.
- [ ] Fallback para o mesmo provider gera `same-provider-fresh-context`.
- [ ] Fallback para provider diferente gera `cross-provider`.
- [ ] Review artifact grava reviewer real.
- [ ] Regression test cobre fallback durante review.

---

# 11. NOVO HIGH/MEDIUM — Fallback audit não é end-to-end

## Problema 1

Em `buildExecutionContext`, o callback de fallback chama algo equivalente a:

```ts
void store.recordDegradation(...)
```

Apesar do FallbackRunner fazer:

```ts
await onFallback(...)
```

o callback retorna imediatamente porque descartou a Promise.

Consequência:

```text
fallback occurred
   ↓
execution continues
   ↓
state write may still be pending
```

Isso pode criar race ou lost update.

## Correção

Retornar a Promise:

```ts
onFallback: event =>
  store.recordDegradation(...)
```

sem `void`.

---

## Problema 2

No fluxo:

```text
agent-flow feature
```

o `createRunnerFactory()` é usado sem `onFallback`.

Assim fallback em:

```text
Discovery
Architecture Impact
SDD
Planning
Plan Review
```

pode ocorrer funcionalmente, porém sem registrar degradation no run.

## Impacto

A execução funciona, mas o histórico pode esconder uma perda de capability.

## Acceptance criteria

- [ ] Todo fallback grava degradation.
- [ ] Planning-stage fallbacks também são persistidos.
- [ ] Event/state update é awaited.
- [ ] Degradation não duplica indefinidamente.
- [ ] Approval mostra a degradação.

---

# 12. V-05 — `agent-flow task TASK-X`

## Status

```text
PARTIAL
```

A correção do DAG está correta.

Antes:

```text
full plan
↓
filter to TASK-004
↓
TASK-004 depends on missing nodes
↓
unknown_dependency
```

Agora:

```text
full DAG preserved
+
only = TASK-004
```

Dependências continuam avaliadas pelo DAG oficial.

Isso é bom.

---

# 13. NOVO MEDIUM — Single-task command pode executar com sucesso e retornar failure

## Problema

O scheduler define:

```text
outcome.complete
```

como:

```text
todas as tasks do plano == completed
```

Isso é correto para:

```bash
agent-flow run
```

mas não para:

```bash
agent-flow task TASK-004
```

Exemplo:

```text
TASK-001 completed
TASK-002 completed
TASK-003 queued
TASK-004 queued
TASK-005 queued
```

Executar:

```bash
agent-flow task TASK-004
```

pode resultar:

```text
TASK-004 completed
```

mas:

```text
outcome.complete = false
```

porque outras tasks permanecem queued.

A CLI pode então imprimir:

```text
Stopped: not all tasks completed
```

e retornar gate/failure exit code.

## Correção recomendada

Separar:

```text
plan completion
```

de:

```text
requested execution success
```

Exemplo:

```ts
interface SchedulerOutcome {
  complete: boolean;
  requestedComplete?: boolean;
}
```

ou resolver no CLI:

```ts
if (target) {
  success = outcome.states[target.id] === "completed";
}
```

## Acceptance criteria

- [ ] `agent-flow task TASK-X` retorna success quando TASK-X completa.
- [ ] Não exige que o restante do plano esteja completed.
- [ ] Dependencies continuam exigidas.
- [ ] Whole-plan `agent-flow run` mantém semântica atual.
- [ ] Regression test cobre task intermediária com outras tasks ainda queued.

---

# 14. V-06 — Provenance

## Status

```text
PARTIAL
```

Para execução bem-sucedida, a solução ficou boa.

Agora existem campos reais como:

```text
runner
model
reasoning
reasoningClamped
fallback
```

e `StageResult.execution` prefere provenance do runner quando houve substituição.

Isso é exatamente o comportamento esperado.

---

# 15. NOVO MEDIUM — Failure provenance continua incompleta

## Problema

Quando o runner falha antes de existir um `StageResult` válido, o TaskExecutor começa com placeholders como:

```text
runner: unknown
reasoning: medium
```

`StageFailure` não carrega a execution provenance.

Assim:

```text
executor.complex
configured:
Codex / Sol / high

runner failure
```

pode produzir result incompleto/inexato.

## Correção recomendada

Estender failure result.

Possibilidade:

```ts
interface AgentRunFailure {
  ok: false;
  errorCode: RunnerErrorCode;
  raw: string;
  durationMs: number;

  provenance?: {
    runner: string;
    model?: string;
    reasoning: ReasoningLevel;
    reasoningClamped: boolean;
    substitutedFor?: ...
  };
}
```

Ou fazer StageFailure carregar:

```ts
execution?: StageExecution
```

e TaskExecutor persiste essa informação.

## Acceptance criteria

- [ ] Failure registra runner real.
- [ ] Failure registra model quando aplicável.
- [ ] Failure registra reasoning real.
- [ ] Fallback failure mostra primary + secondary path.
- [ ] Nenhum `medium` hardcoded representa execução desconhecida.
- [ ] Analytics futuros distinguem `unknown` de valores reais.

---

# 16. V-07 — Discovery Cache

## Status

```text
FIXED WITH MINOR BUG
```

O fingerprint agora considera:

```text
HEAD
tracked dirty state
AGENTS.md
project config
```

A cache só é reutilizada quando o fingerprint corresponde.

Também existe evento:

```text
discovery_cache_invalidated
```

com informação sobre o que mudou.

A abordagem é adequada para o MVP.

---

# 17. NOVO LOW — Corrupted fingerprint JSON pode quebrar em vez de invalidar

O código pretende tratar fingerprint ilegível como:

```text
cache cannot be trusted
→ rerun discovery
```

Porém:

```ts
JSON.parse(...)
```

não está necessariamente protegido por `try/catch`.

Se o arquivo estiver corrompido, a função pode lançar antes do:

```text
safeParse
```

## Correção

```ts
try {
  parsed = JSON.parse(raw);
} catch {
  return null;
}
```

## Acceptance criteria

- [ ] JSON corrompido retorna null.
- [ ] Discovery reruns.
- [ ] Run não quebra por metadata de cache corrompida.

---

# 18. V-08 — Validation duplicada

## Status

```text
FIXED
```

O implementation prompt agora instrui:

```text
Do not run the task's validation commands.
Agent Flow runs them itself.
```

O agente ainda pode executar comandos diagnósticos específicos enquanto trabalha, mas:

```text
official validation gate
```

pertence exclusivamente ao orchestrator.

Também foi removida a seção de VALIDATION do response block do agente.

Essa correção está alinhada à arquitetura.

---

# 19. V-10 — Approval Timestamp

## Status

```text
FIXED
```

Approval agora grava:

```text
approvedAt
```

com Clock injetado.

Também registra o timestamp no evento de aprovação.

Isso permite futura UI mostrar:

```text
Approved at 19:12
```

com dado auditável.

---

# 20. V-11 — Prompt Role Metadata

## Status

```text
FIXED
```

A metadata `role` foi removida do frontmatter.

Isso é melhor do que manter uma constraint falsa, porque:

```text
implementation.md
```

serve:

```text
executor.trivial
executor.normal
executor.complex
```

e nenhuma role única poderia representá-lo corretamente.

A role permanece no StageDefinition, que é a verdadeira source of truth.

---

# 21. V-12 — CLI Copy

## Status

```text
FIXED
```

Mensagens principais agora apontam para comandos realmente existentes, como:

```text
Then: agent-flow approve
```

e:

```text
Next: agent-flow review
```

Podem existir pequenos comentários/textos históricos a limpar, mas não é mais um problema funcional.

---

# 22. NOVO MEDIUM — Task State Machine declarada, mas não aplicada como gate

Existe uma state machine formal em core:

```text
queued
ready
running
interrupted
completed
failed
blocked
review_required
```

com funções como:

```ts
canTransition(...)
transition(...)
```

Isso é positivo.

Porém, runtime como scheduler/retry continua escrevendo states diretamente em vários pontos.

Consequência:

```text
state machine documentation/tests
```

não garantem necessariamente:

```text
state machine enforcement
```

## Risco

Uma mudança futura pode introduzir:

```text
completed → running
```

ou outra transição ilegal diretamente no estado sem passar pelo contrato formal.

## Recomendações

Criar uma API única:

```ts
StateStore.transitionTask(...)
```

Exemplo:

```ts
await store.transitionTask(runId, taskId, "running")
```

Internamente:

```ts
transition(current, target)
```

valida o movimento.

Alternativa aceitável:

remover a pretensão de enforcement e assumir que a state machine é somente documental.

Mas isso seria arquiteturalmente inferior.

## Acceptance criteria

- [ ] Produção usa transition guard.
- [ ] Illegal transitions falham.
- [ ] Scheduler não escreve state arbitrário.
- [ ] Retry usa transition guard.
- [ ] Recovery usa transition guard.
- [ ] Tests cobrem runtime transitions.

---

# 23. Known Gaps que Continuam Abertos

Os seguintes gaps continuam declarados pelo próprio projeto.

---

## 23.1 `doctor --deep`

Ainda não executa live auth probe.

Hoje ele apenas informa:

```text
--deep was requested but live probing is not implemented yet.
```

### Futuro esperado

```text
opt-in
consome quota
testa runner real
não revela credential
```

---

## 23.2 `review --fix`

Hoje:

```text
finding
↓
findingsToTasks
↓
"would be created"
```

Ainda não existe:

```text
FIX-XXX
↓
persist plan/state
↓
scheduler
↓
implementation
↓
verification
↓
review
```

Esse pipeline precisa ser finalizado.

---

## 23.3 Telemetria

Existe schema.

Ainda falta writer.

Mínimo recomendado:

```text
runId
stage
task
role
runner
model
reasoning
fallback
startedAt
finishedAt
status
duration
retry
```

Não chamar de billing.

---

## 23.4 Final Review com CLI real

A suíte usa FakeRunner.

Ainda falta validar:

```text
real implementation
↓
real deterministic validation
↓
real verification agent
↓
real final reviewer
↓
DoD
```

---

## 23.5 Segunda stack real

Node já foi exercitado.

Ainda falta validar stack independente, preferencialmente:

```text
Flutter
```

Sem alterar core/orchestrator.

Apenas:

```text
config
AGENTS.md
stack detection
```

devem mudar.

---

# 24. Test Suite

O README atual declara:

```text
628 tests
```

Porém essa revisão não executou a suíte de forma independente.

O repositório atualmente não apresenta status de CI associado ao HEAD analisado através da integração consultada.

Portanto:

```text
628 tests
=
declaração do repositório

não
=
execução independente desta revisão
```

Antes de marcar MVP 1.1 como PASS, executar:

```bash
npm ci
npm run check
npm run build
```

e preferencialmente publicar CI no GitHub.

---

# 25. Novo Backlog Recomendado

## AF-R01 — Actual review independence

Severity:

```text
HIGH
```

Corrigir Plan Review e Final Review para usar actual execution provenance.

---

## AF-R02 — Await and persist fallback degradations everywhere

Severity:

```text
HIGH / MEDIUM
```

- await `recordDegradation`;
- registrar fallback também em planning pipeline.

---

## AF-R03 — Single-task success semantics

Severity:

```text
MEDIUM
```

`agent-flow task TASK-X` deve retornar sucesso quando a task alvo termina corretamente.

---

## AF-R04 — Failure provenance

Severity:

```text
MEDIUM
```

Persistir runner/model/reasoning reais mesmo quando a execução falha.

---

## AF-R05 — Validation expectation invariants

Severity:

```text
MEDIUM
```

Rejeitar combinações contraditórias como:

```text
fail + []
```

---

## AF-R06 — Enforce task state machine

Severity:

```text
MEDIUM
```

Todas as transições de produção devem passar pela policy formal.

---

## AF-R07 — Cache fingerprint parse resilience

Severity:

```text
LOW
```

Fingerprint JSON inválido deve apenas invalidar cache.

---

# 26. Ordem Recomendada de Implementação

```text
1. AF-R01 — actual review independence
2. AF-R02 — fallback audit everywhere
3. AF-R03 — single-task success semantics
4. AF-R04 — failure provenance
5. AF-R05 — validation expectation invariants
6. AF-R06 — state transition enforcement
7. AF-R07 — cache parse resilience
```

Depois:

```text
doctor --deep
review --fix
telemetry
live final-review validation
Flutter validation
```

---

# 27. Dependências

```text
AF-R02
   ↓
AF-R01
```

Motivo:

independence depende de execution/fallback provenance confiável.

```text
AF-R04
   ↓
telemetry
   ↓
Web UI model usage
```

```text
AF-R06
   ↓
MVP2 parallel execution
```

A state machine deve estar realmente enforceada antes de aumentar concurrency.

---

# 28. Gate para a Web UI

A Web UI da spec v3 continua tecnicamente viável.

Mas o gate:

```text
UI-00
```

não deve abrir ainda.

Pré-condições mínimas:

```text
✓ shell trust boundary
✓ resumability
✓ fallback execution
✓ process timeout
✓ deterministic validation

✗ trustworthy review independence
✗ complete provenance
✗ single-task semantics
✗ live final review validation
✗ second real stack
```

Portanto:

```text
Web UI Gate: CLOSED
```

---

# 29. Condição para MVP 1.1 PASS

Eu consideraria o MVP 1.1 aprovado quando:

```text
AF-R01 PASS
AF-R02 PASS
AF-R03 PASS
AF-R04 PASS
AF-R05 PASS
AF-R06 PASS
AF-R07 PASS
```

e:

```text
npm run check PASS
npm run build PASS
```

seguido de:

```text
real Claude/Codex flow PASS
Node repository PASS
Flutter repository PASS
Final Review PASS
Definition of Done PASS
```

Fluxo esperado:

```text
feature
  ↓
Discovery
  ↓
Architecture Impact
  ↓
SDD
  ↓
Planning
  ↓
Plan Review
  ↓
Human Approval
  ↓
Implementation
  ↓
Verification
  ↓
Final Review
  ↓
Definition of Done
  ↓
FEATURE COMPLETE
```

---

# 30. Conclusão

A implementação atual está consideravelmente mais madura que na primeira revisão.

Os problemas mais perigosos já foram resolvidos:

```text
model → shell
process-tree timeout
orphan running tasks
dead runtime fallback
TDD contradiction
stale discovery cache
```

Não há evidência que justifique reescrever o core.

A arquitetura continua sendo o ponto forte do projeto.

O próximo ciclo deve ser pequeno e focado em **truthfulness/auditability**:

```text
what actually ran
who actually reviewed
which provider actually executed
what state transition actually occurred
what command actually determined success
```

Esse é o último tipo de hardening necessário antes de o Agent Flow sair de:

```text
"arquiteturalmente correto"
```

para:

```text
"operacionalmente confiável"
```

Depois disso, o desenvolvimento da Web UI pode começar sobre uma base muito mais estável.

---

# 31. Regra de Revisão para o Próximo Ciclo

Nenhuma correção deve:

- esconder fallback;
- fabricar provenance;
- tratar quality failure como infrastructure failure;
- reroutear silently;
- relaxar a model→shell boundary;
- duplicar DAG logic;
- duplicar state machines;
- fazer UI virar source of truth;
- permitir que uma execução parcial seja registrada como completa.

Prioridades:

```text
safe
deterministic
auditable
provider-agnostic
resumable
human-gated
truthful
```
