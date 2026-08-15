# Prompt para Claude — Revisão da Implementation Spec v4

Você está revisando uma nova proposta arquitetural do projeto **Agent Flow**.

## Contexto

Repositório:

```text
lguilherme44/agent-flow
```

Starting point atual:

```text
master contém MVP1 + Web UI estabilizados
MVP2 Safe Parallel Execution está em andamento
M2-00..M2-03: PASS FINAL
M2-04: implementação landed; existe/está sendo fechado um follow-up test-only de CI
```

A v3 existe em:

```text
docs/specs/implementation-spec-v3.md
```

A autoridade normativa atual para MVP2 é:

```text
docs/specs/mvp2-safe-parallel-execution.md
```

A nova proposta está no arquivo fornecido:

```text
implementation-spec-v4-draft.md
```

## Objetivo da revisão

Não implemente nada.

Não edite arquivos.

Faça uma revisão arquitetural adversarial da **v4 como plano de produto e arquitetura**.

A pergunta principal é:

> A v4 representa corretamente o Agent Flow atual, preserva as invariantes já
> conquistadas e introduz o modelo local opcional sem criar uma segunda fonte de
> verdade, um segundo runner semântico ou um caminho de segurança paralelo?

## 1. Compare v3 → v4

Identifique:

- premissas da v3 que ficaram obsoletas;
- regras importantes da v3 que a v4 perdeu por acidente;
- detalhes que a v4 corrigiu corretamente;
- duplicações desnecessárias;
- conceitos com nomes diferentes para a mesma coisa;
- conceitos da v3 que deveriam continuar explicitamente fora de escopo.

Não exija preservar um detalhe da v3 apenas por compatibilidade histórica se o código
e a spec MVP2 já provaram que o desenho mudou.

## 2. Compare v4 → código atual

Inspecione o repositório atual.

Cheque pelo menos:

```text
src/app/state-store.ts
src/app/scheduler.ts
src/app/task-executor.ts
src/app/run-execution-lock.ts
src/app/run-git-identity.ts
src/app/execution-context.ts
src/adapters/git/git-command.ts
src/adapters/git/git-workspaces.ts
src/contracts/**
src/server/**
apps/web/src/**
```

Classifique cada afirmação importante da v4 como:

```text
ALIGNED
FUTURE / INTENTIONAL
STALE
CONTRADICTED BY CODE
AMBIGUOUS
```

Não proponha reescrever produção para “fazer o código bater com o documento” sem antes
dizer qual dos dois parece estar correto.

## 3. Compare v4 → MVP2 spec

`docs/specs/mvp2-safe-parallel-execution.md` continua sendo autoridade para MVP2.

Procure qualquer ponto em que a v4:

- enfraqueça uma invariante;
- contradiga worktree layout;
- antecipe concurrency > 1;
- altere receipt/marker trust;
- reintroduza integration validation;
- mude recovery para inferência;
- permita browser-controlled Git facts;
- confunda TaskAttemptResult com TaskResult;
- mude semantics de completed;
- duplique StateStore/scheduler;
- permita Git fora de git-command.ts.

Qualquer conflito real com a spec MVP2 é blocker da v4.

## 4. Review do Utility Model / Context Worker

A parte mais nova da v4 é o **Optional Local Context Worker**.

Avalie se é correto mantê-lo separado de `AgentRunner`.

Procure especialmente:

### Authority

O local model pode influenciar retrieval/compression sem virar source of truth?

Existe algum caminho em que um summary poderia silenciosamente substituir raw evidence?

### Security

Pode model output escolher:

- path?
- shell command?
- Git ref?
- URL?
- SSH command?

Se sim, FAIL.

### Failure semantics

Utility model offline realmente pode ser bypassado sem alterar workflow semantics?

Há algum risco de um fluxo gerar resultado diferente porque o utility model estava
indisponível?

Diferencie:

```text
context optimization affects what evidence is presented
```

de:

```text
workflow truth changes
```

### Context window

A policy de 64k + target ~48k é suficiente?

Avalie hierarchical chunking:

- termination;
- bounded recursion;
- output growth;
- loss of critical evidence;
- tokenizer mismatch;
- very large repos/logs.

### Structured output

Precisamos exigir JSON schema / structured output no primeiro MVP3?

Ou parser + retry bounded é suficiente?

Justifique.

### Retrieval

O modelo local nunca deve inventar files. Candidate paths devem vir de deterministic
repository discovery.

Confira se a v4 deixa isso forte o suficiente.

### Telemetry

Os números de tokens são defensáveis quando tokenizer local e cloud diferem?

A nomenclatura `estimated` está suficiente?

### Privacy

A deny list proposta é suficiente como baseline?

É necessário um allowlist/size/binary/generated-file policy antes do M3-04?

### Prompt injection

Considere código/repo/logs maliciosos contendo instruções para o utility model.

Como impedir que conteúdo do repositório se torne instrução e faça o worker tentar
ampliar escopo ou exfiltrar conteúdo?

O worker não terá shell, mas ainda pode selecionar conteúdo indevido.

## 5. OpenAI-compatible boundary

Revise a proposta de:

```text
OpenAICompatibleUtilityModel
```

Verifique:

- baseUrl trusted config;
- model trusted config;
- timeout;
- max input/output;
- structured parsing;
- health;
- no mandatory API key;
- optional auth without storing secrets;
- streaming necessity;
- `/v1/models` trust level.

Diga o mínimo que precisa entrar no contrato antes de implementar.

## 6. SSH

A v4 coloca SSH fora do caminho de inferência.

Verifique se isso é suficientemente isolado.

A regra obrigatória é:

```text
LLM output NEVER becomes SSH command
```

Se o futuro diagnóstico SSH for desnecessário ou perigoso, diga para remover do
roadmap em vez de sofisticá-lo.

## 7. Roadmap

Revise a ordem:

```text
M3-00 probes
M3-01 UtilityModel port
M3-02 OpenAI adapter
M3-03 ContextPacket
M3-04 retrieval
M3-05 compression
M3-06 log/diff triage
M3-07 telemetry
M3-08 primary-runner integration
M3-09 dogfood
M3-10 optional SSH diagnostics
```

Procure dependency inversion incorreta.

Em particular:

- telemetry deveria vir antes para termos baseline?
- ContextPacket deveria vir antes do adapter?
- retrieval precisa de deterministic indexing antes do LLM?
- benchmark precisa começar em M3-00?
- precisamos de a/b shadow mode antes de o ContextPacket afetar prompts reais?

Proponha nova ordem somente se houver justificativa concreta.

## 8. Scope discipline

A v4 diz que MVP3 começa somente após MVP2 PASS FINAL.

Confirme se essa é a decisão correta.

Não proponha colocar UtilityModel dentro de M2-05...M2-12 só porque é tecnicamente
possível.

## 9. Saída obrigatória

Retorne exatamente esta estrutura:

```markdown
# Agent Flow v4 Architecture Review

## Executive verdict
V4: PASS | PASS WITH CHANGES | FAIL
MVP2 compatibility: PASS | FAIL
Utility Model direction: PASS | PASS WITH CHANGES | FAIL
Ready to commit v4 as normative plan: YES | NO

## A. v3 → v4
Preserved correctly:
Lost requirements:
Correctly removed/replaced:
Stale v3 concepts that must NOT return:

## B. v4 → current code
Aligned:
Future but coherent:
Stale:
Contradictions:

## C. v4 → MVP2
Invariants preserved:
Conflicts:
Blockers:

## D. Utility Model
Port separation:
Authority:
Failure semantics:
Context budgeting:
Chunking:
Structured output:
Retrieval:
Telemetry:
Privacy:
Prompt injection:
Verdict:

## E. OpenAI-compatible adapter
Minimum contract:
Missing:
Over-designed:
Verdict:

## F. SSH
Keep | Defer | Remove
Reason:

## G. Roadmap
Current ordering verdict:
Required reorderings:
Dependencies missing:

## H. Required changes before commit
1.
2.
3.

## I. Non-blocking improvements
1.
2.
3.

## J. Final gate
V4 ARCHITECTURE REVIEW: PASS | FAIL
READY TO COMMIT implementation-spec-v4.md: YES | NO
READY TO IMPLEMENT MVP3: NO
```

## Regras da revisão

- Seja adversarial.
- Não aprove por intenção.
- Cite arquivos/linhas do repo para findings importantes.
- Não implemente.
- Não faça commit.
- Não altere a v4.
- Não inicie MVP3.
- Um conflito com uma invariante já estabilizada do MVP2 é blocker.
- Uma ideia útil que pode ser adiada não é blocker.
