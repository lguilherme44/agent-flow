# Agent Flow — Validation Review Checklist

> Documento de validação técnica pós-MVP  
> Base: implementação atual do `lguilherme44/agent-flow`, spec v3 e plano aprovado.  
> Objetivo: **validar os findings antes de implementar correções**.

---

## 1. Instruções para o revisor

Você está revisando a implementação atual do **Agent Flow**.

Não assuma que os findings abaixo estão corretos só porque foram levantados por outro revisor.

Para cada item:

1. leia o código envolvido;
2. confira testes existentes;
3. tente reproduzir quando aplicável;
4. compare com a spec/plano;
5. classifique como:
   - `CONFIRMED`
   - `PARTIAL`
   - `NOT REPRODUCED`
   - `BY DESIGN`
6. explique a evidência;
7. somente para itens confirmados/parciais, proponha a correção mínima;
8. identifique risco de regressão;
9. diga quais testes devem ser adicionados ou ajustados.

Não refatore partes não relacionadas.

Não implemente nada antes de terminar a revisão completa.

---

# 2. Gate geral

A arquitetura base foi avaliada como boa e **não deve ser reescrita** sem evidência forte.

Aspectos que devem ser preservados:

- core provider-agnostic;
- `AgentRunner` como port;
- adapters específicos para Claude Code/Codex;
- DAG determinístico;
- approval ligado ao hash do plano;
- `state.json` como fonte de verdade;
- `events.jsonl` como audit trail;
- artefatos por run;
- verification commands executados pelo orchestrator;
- fallback somente para falhas de infraestrutura;
- final review em contexto independente;
- Definition of Done avaliada por código;
- prompts versionados como assets;
- stack-specific logic isolada em stack detection/config.

A Web UI da spec v3 **não deve começar ainda** se os itens críticos/high abaixo continuarem abertos.

---

# 3. CRITICAL — Validation commands controlados pelo LLM

## Hipótese

`Task.validation` aceita comandos arbitrários produzidos pelo planner e o orchestrator executa esses comandos por shell.

Fluxo suspeito:

```text
repository content
    ↓
planning prompt
    ↓
LLM-generated task.validation
    ↓
plan.json
    ↓
TaskExecutor
    ↓
runVerification
    ↓
/bin/sh -c <model-controlled-string>
```

Isso criaria uma quebra da trust boundary, porque o comando deixa o sandbox do runner e passa a ser executado pelo processo do Agent Flow.

## Arquivos a revisar

```text
src/contracts/task.schema.ts
src/app/stages/planning-checks.ts
src/app/task-executor.ts
src/app/verification-commands.ts
prompts/planning.md
```

## Validar

- `Task.validation` é realmente `string[]`?
- existe allowlist determinística?
- o planner pode emitir um comando que não está no project config?
- `checkPlan()` rejeita comandos desconhecidos?
- `runVerification()` usa `/bin/sh -c`?
- existe qualquer caminho onde texto produzido pelo modelo se torne shell command?

## Teste sugerido

Criar um plano com algo como:

```json
{
  "validation": [
    "echo MALICIOUS > /tmp/agent-flow-validation-test"
  ]
}
```

**Não executar esse teste em ambiente sensível.**

Idealmente, testar com fake `ProcessRunner` e verificar apenas qual comando seria invocado.

## Correção candidata

Trocar comandos livres por IDs confiáveis:

```yaml
validationCommands:
  unit-tests: npm test
  recurrence-tests: npm test -- recurrence
```

Plano:

```json
{
  "validation": [
    "recurrence-tests"
  ]
}
```

O orchestrator resolve o ID para o comando real.

## Acceptance criteria

- [ ] Nenhum shell command arbitrário pode vir do planner.
- [ ] Plan aceita somente IDs existentes na config.
- [ ] `checkPlan()` rejeita IDs desconhecidos.
- [ ] `TaskExecutor` resolve command IDs via trusted config.
- [ ] Teste prova que payload malicioso nunca chega ao `ProcessRunner`.

---

# 4. HIGH — Fallback existe, mas pode não estar conectado ao runtime

## Hipótese

`FallbackRunner` existe e é testado isoladamente, porém o execution graph de produção retorna diretamente runners do registry.

Fluxo suspeito:

```text
buildRegistry()
   ↓
ClaudeCodeRunner / CodexRunner

buildExecutionContext()
   ↓
StageRunner
   ↓
getRunner(id) => registry.get(id)
```

sem decorator de fallback.

## Arquivos a revisar

```text
src/adapters/runners/fallback-runner.ts
src/adapters/runners/registry.ts
src/app/execution-context.ts
src/app/stage-runner.ts
src/core/health.ts
src/contracts/config*.ts
test/adapters/fallback-runner.test.ts
test/e2e/full-flow.test.ts
```

## Validar

- O `FallbackRunner` é usado em produção?
- `buildRegistry()` cria runner decorado?
- `StageFailure.fallbackEligible` é consumido por algum caller?
- `doctor` pode considerar uma role recuperável via fallback enquanto o runtime não consegue executar esse fallback?
- fallback resolve apenas runner ou resolve também model/reasoning/timeout?

## Caso importante

Config:

```yaml
planner:
  runner: codex
  model: gpt-5.6-sol
  effort: high

fallback:
  roles:
    planner:
      runner: claude
      model: opus
      effort: high
```

Validar se um fallback não carrega incorretamente:

```text
model = gpt-5.6-sol
```

para o Claude runner.

## Correção candidata

Fallback deve resolver uma **nova configuração efetiva da role**:

```ts
{
  runner,
  model,
  reasoning,
  timeoutSeconds
}
```

e não simplesmente executar o mesmo `AgentRunInput` em outra instância.

## Acceptance criteria

- [ ] Runtime usa fallback real.
- [ ] `doctor` e runtime compartilham a mesma semântica de rotas.
- [ ] Fallback dispara apenas para:
  - quota_exceeded
  - auth_required
  - runner_unavailable
- [ ] Não dispara para:
  - execution_failed
  - invalid_output
  - timeout
  - blocked
- [ ] Model/reasoning são recalculados para o runner fallback.
- [ ] Apenas uma tentativa de fallback.
- [ ] Evento/degradation registra a substituição.

---

# 5. HIGH — Resume após kill real pode deixar task permanentemente `running`

## Hipótese

O scheduler persiste a task como `running` antes de executar.

Se o processo Agent Flow morrer depois disso, o próximo `run` carrega a task ainda como `running`.

O DAG considera ready apenas estados elegíveis, e uma task `running` órfã pode nunca voltar para a fila.

## Arquivos

```text
src/app/scheduler.ts
src/core/dag.ts
src/app/state-store.ts
src/cli/run.ts
test/e2e/full-flow.test.ts
```

## Validar

O teste existente chamado algo como:

```text
resume after process is killed
```

realmente mata/interrompe entre:

```text
persist running
```

e:

```text
persist result
```

ou apenas simula runner retornando `timeout`/`failed`?

## Reprodução conceitual

Estado antes da queda:

```json
{
  "id": "TASK-003",
  "state": "running"
}
```

Reabrir:

```bash
agent-flow run
```

Validar se TASK-003 volta a ser executada, fica travada, ou o scheduler encerra sem progresso.

## Correção candidata

Introduzir recuperação explícita:

```text
running
  ↓ process restart
interrupted
  ↓ explicit resume policy
queued/ready
```

ou converter `running → queued` no bootstrap do resume, registrando evento.

Preferência: estado auditável `interrupted`.

## Acceptance criteria

- [ ] Kill real entre persistência e resultado é recuperável.
- [ ] Task completed nunca reexecuta.
- [ ] Task orphan `running` não fica permanentemente travada.
- [ ] Recovery gera evento explícito.
- [ ] Attempt count continua coerente.
- [ ] E2E cobre interrupção realista.

---

# 6. HIGH — Test-first/TDD contradiz validation semantics

## Hipótese

Uma task RED pode ter validation cujo resultado esperado é falhar.

Hoje:

```text
validation exit != 0
        ↓
review_required
```

Isso é correto para implementação normal, mas incorreto para uma task explicitamente RED.

## Arquivos

```text
docs/engineering/findings.md
prompts/planning.md
src/contracts/task.schema.ts
src/app/task-executor.ts
src/app/verification-commands.ts
```

## Validar

- O finding já documentado continua reproduzível?
- O planner consegue representar expected failure?
- Existe diferença entre:
  - validation deve passar;
  - validation deve falhar;
  - validation não se aplica?

## Correção candidata

Adicionar:

```ts
validationExpectation:
  | "pass"
  | "fail"
  | "none"
```

ou modelo equivalente mais explícito.

## Acceptance criteria

- [ ] RED task pode declarar expected fail.
- [ ] GREEN/refactor continuam expected pass.
- [ ] Uma falha inesperada continua `review_required`.
- [ ] Um teste que deveria falhar mas passa também é sinalizado.
- [ ] Planner prompt explica a semântica.
- [ ] E2E cobre RED → GREEN.

---

# 7. MEDIUM — `agent-flow task TASK-X` com dependencies

## Hipótese

A CLI primeiro valida dependencies usando o estado completo, mas depois reduz o plano para apenas a task alvo.

Exemplo:

```text
TASK-004
depends on:
  TASK-001
  TASK-002
```

Depois:

```ts
selected.tasks = [TASK-004]
```

e `Scheduler`/`buildDag()` recebe dependency IDs que não existem no mini-plan.

## Arquivos

```text
src/cli/run.ts
src/app/scheduler.ts
src/core/dag.ts
```

## Validar

Cenário:

```text
TASK-001 completed
TASK-002 completed
TASK-004 queued
```

Executar:

```bash
agent-flow task TASK-004
```

## Correção candidata

Opção A:

- fazer dependency precheck;
- chamar `TaskExecutor` diretamente para single-task execution.

Opção B:

- preservar DAG completo;
- marcar nodes não-alvo conforme estado real.

Preferência: solução que não duplique regras de scheduler.

## Acceptance criteria

- [ ] Task isolada com deps completed executa.
- [ ] Task com dep incompleta é recusada.
- [ ] Unknown dependency continua erro de plano.
- [ ] Não cria mini-DAG inconsistente.

---

# 8. MEDIUM — Provenance de runner/model/reasoning não representa execução real

## Hipótese

`TaskResult` possui campos de provenance, porém o executor persiste `reasoning: "medium"` de forma fixa em alguns caminhos e pode não persistir `model`.

Isso torna analytics/futura UI incorretos.

## Arquivos

```text
src/contracts/task-result*.ts
src/app/stage-runner.ts
src/app/task-executor.ts
src/core/role.ts
```

## Validar

Para uma task roteada como:

```text
executor.complex
Codex
GPT-5.6 Sol
high
```

confirmar o `result.json`.

## Correção candidata

`StageResult` deve carregar provenance completa:

```ts
execution: {
  runner: string;
  model?: string;
  reasoning: ReasoningLevel;
  reasoningClamped: boolean;
  fallback?: {
    from: string;
    errorCode: RunnerErrorCode;
  };
}
```

TaskExecutor persiste o que realmente recebeu.

## Acceptance criteria

- [ ] `result.json` mostra runner real.
- [ ] model real quando configurado.
- [ ] reasoning real.
- [ ] clamp aparece.
- [ ] fallback provenance aparece.
- [ ] nenhum valor hardcoded.

---

# 9. MEDIUM — Discovery cache sem invalidation real

## Hipótese

`cache/architecture.md` é reutilizado simplesmente por existir.

Pode existir `architectureCacheKey()`, mas a chave não participa efetivamente da decisão.

## Arquivos

```text
src/app/planning-pipeline.ts
src/app/paths.ts
src/adapters/git/git-client.ts
```

## Validar

1. Rodar Discovery.
2. Alterar arquitetura/repo.
3. Rodar nova feature.
4. Confirmar se Discovery roda novamente ou usa cache antigo.

## Fingerprint sugerido

```ts
{
  headCommit,
  gitStatusHash,
  agentsMdHash,
  projectConfigHash
}
```

Pode ser persistido em metadata separada.

## Acceptance criteria

- [ ] Repo inalterado reutiliza cache.
- [ ] HEAD alterado invalida.
- [ ] working tree relevante alterada invalida.
- [ ] AGENTS.md alterado invalida.
- [ ] project config alterado invalida.
- [ ] `--no-cache` sempre força execução.

---

# 10. MEDIUM — Validation duplicada entre agent e orchestrator

## Hipótese

`prompts/implementation.md` manda o agente executar validation commands.

Depois `TaskExecutor` roda validation novamente através de `ProcessRunner`.

## Arquivos

```text
prompts/implementation.md
src/app/task-executor.ts
```

## Validar

- quantas vezes um comando é executado numa task normal?
- execução via agente é realmente necessária?
- isso aumenta quota/contexto/tempo?
- existe risco de efeitos colaterais duplicados?

## Correção candidata

Prompt:

```text
Do not execute the task validation commands yourself.
Agent Flow runs them deterministically after implementation.

You may run narrow diagnostic commands when necessary to understand or implement the task.
```

## Acceptance criteria

- [ ] Validation oficial roda uma vez pelo orchestrator.
- [ ] Agent pode executar diagnóstico necessário sem fingir que isso é o gate.
- [ ] Result/DoD usa somente output do ProcessRunner controlado.

---

# 11. MEDIUM — Process timeout pode não matar subprocess tree

## Hipótese

`NodeProcessRunner` envia:

```text
SIGTERM
↓
SIGKILL
```

ao child process direto.

CLIs podem iniciar subprocessos próprios:

```text
claude/codex
  └── test runner
      └── build/compiler
```

Matar apenas o parent pode deixar processos órfãos.

## Arquivo

```text
src/adapters/process/node-process-runner.ts
```

## Validar

- child é spawnado como process group?
- `kill()` atinge descendentes?
- existe comportamento diferente macOS/Linux/Windows?
- MVP pretende suportar Windows diretamente?

## Correção candidata

POSIX:

- spawn detached/process group;
- kill group com `-pid`.

Windows:

- estratégia explícita/documentada, possivelmente `taskkill /T`.

## Acceptance criteria

- [ ] Timeout encerra process tree.
- [ ] Grace period continua existindo.
- [ ] Tests simulam child + grandchild.
- [ ] Comportamento cross-platform documentado.

---

# 12. LOW — `approvedAt` não é persistido corretamente

## Hipótese

Approval grava:

```ts
approvedAt: undefined
```

mesmo com `Clock` já disponível no `StateStore`.

Isso afeta auditoria e futura Web UI.

## Arquivos

```text
src/app/approval.ts
src/app/state-store.ts
src/contracts/run-state*.ts
```

## Acceptance criteria

- [ ] Approval registra timestamp ISO.
- [ ] Revisão invalida approval e timestamp anterior.
- [ ] Reapproval gera timestamp novo.
- [ ] Evento e state permanecem coerentes.

---

# 13. LOW — `PromptMeta.role` pode ser uma falsa constraint

## Hipótese

Exemplo:

```yaml
role: executor.normal
```

no `implementation.md`.

Mas o mesmo prompt pode ser usado por:

```text
executor.trivial
executor.normal
executor.complex
```

e StageRunner resolve a role vinda da `StageDefinition`, não do front matter.

## Arquivos

```text
src/app/prompt-loader.ts
src/app/stage-runner.ts
prompts/implementation.md
```

## Validar

- `prompt.meta.role` é validado contra `stage.role`?
- existe algum uso real além do parse?
- implementation prompt pode declarar uma role incompatível sem erro?

## Opções

A:

```text
remover role do front-matter
```

B:

```text
permitir role family:
executor.*
```

C:

```text
stage usa prompt.meta.role como source of truth
```

Escolher uma única semântica.

## Acceptance criteria

- [ ] Metadata não contradiz execução.
- [ ] Prompt misuse falha cedo.
- [ ] Não impede executor routing por complexidade.

---

# 14. LOW — Mensagens CLI desatualizadas

## Hipótese

Algumas mensagens ainda falam:

```text
implementation arrives in the next milestone
```

ou equivalente, apesar do implementation pipeline já existir.

## Arquivos prováveis

```text
src/cli/feature.ts
src/cli/approve.ts
README.md
README.pt-BR.md
```

## Acceptance criteria

- [ ] Nenhuma mensagem fala de milestone já entregue.
- [ ] Após approve, próximo comando correto é mostrado.
- [ ] Após feature, fluxo real atual é mostrado.

---

# 15. Known gaps já declarados pelo próprio projeto

Esses itens não são necessariamente bugs descobertos nesta revisão, mas devem ser considerados no gate de MVP 1.1.

## 15.1 `doctor --deep`

Hoje existe UX/flag, mas live auth probing está declarado como não implementado.

Validar se permanece assim.

### Aceite futuro

- probe explícito opt-in;
- aviso de consumo de quota;
- nunca imprimir credential;
- distinguir auth failure de runner unavailable.

---

## 15.2 `review --fix`

Hoje pode gerar representation de FIX tasks, mas confirmar se realmente:

```text
finding
↓
FIX-XXX
↓
plan/run state
↓
router
↓
executor
↓
verification
↓
review novamente
```

Se apenas imprime “would be created”, continuar marcado incompleto.

---

## 15.3 Telemetria local

Validar se há schema sem writer.

Telemetria mínima desejável:

```text
run
stage
task
runner
model
reasoning
duration
retry
fallback
status
```

Sem billing oficial.

---

## 15.4 Live final review

Validar em execução real:

```text
implementation
↓
lint/typecheck/test/build
↓
verification agent
↓
final reviewer
↓
Definition of Done
```

contra CLI real, não FakeRunner.

---

## 15.5 Segunda stack

Node já foi usado.

Validar pelo menos uma segunda stack real, idealmente:

```text
Flutter
```

sem alterar o orchestrator.

Somente config/AGENTS.md devem mudar.

---

# 16. Testes arquiteturais que devem continuar passando

Não aceitar correção que quebre:

```text
src/core imports no Node built-ins
src/core imports no adapters
src/core conhece zero provider/model names
stack-specific frameworks não vazam para core/app
DAG logic permanece em um único módulo
```

Adicionar regras semelhantes se novas invariantes forem introduzidas.

---

# 17. Ordem recomendada para validação

```text
V-01  arbitrary validation command
V-02  fallback wiring
V-03  resume interrupted task
V-04  TDD validation semantics
V-05  single-task execution
V-06  provenance
V-07  discovery cache
V-08  duplicated validation
V-09  process tree timeout
V-10  approvedAt
V-11  prompt role metadata
V-12  stale CLI copy
V-13  doctor --deep
V-14  review --fix
V-15  telemetry
V-16  live final review
V-17  second stack
```

---

# 18. Prioridade de correção se confirmados

```text
BLOCKER / CRITICAL
1. Arbitrary validation command execution

HIGH
2. Runtime fallback
3. Resume after real interruption
4. TDD RED/GREEN semantics

MEDIUM
5. agent-flow task
6. execution provenance
7. cache fingerprint
8. duplicated validation
9. process-tree cancellation

LOW
10. approvedAt
11. prompt metadata semantics
12. stale CLI messages
```

Depois:

```text
known gaps
↓
real-world validation
↓
MVP 1.1 PASS
↓
Web UI gate open
```

---

# 19. Formato obrigatório do relatório de revisão

Ao terminar, responda com:

```markdown
# Validation Result

## Summary

Architecture: PASS | CHANGES REQUIRED
MVP 1.1 gate: PASS | FAIL

Confirmed:
Partial:
Not reproduced:
By design:

## Findings

### V-01 — ...
Status: CONFIRMED
Severity: CRITICAL

Evidence:
- ...

Reproduction:
- ...

Root cause:
- ...

Recommended correction:
- ...

Files:
- ...

Tests:
- ...

Risk:
- ...

---

(repetir para todos)

## Proposed implementation order

1. ...
2. ...

## Dependency graph

...

## Regression risks

...

## Spec/plan changes required

...

## Final recommendation

...
```

---

# 20. Regra final

Não otimizar para “fechar issues”.

O objetivo é validar as garantias centrais do Agent Flow:

```text
safe
deterministic
auditable
provider-agnostic
resumable
human-gated
quality-visible
```

Uma correção que faça o happy path passar, mas esconda erro, rerouteie qualidade ruim silenciosamente ou reduza auditabilidade deve ser rejeitada.
