# Agent Flow — Especificação de Implementação v4

> **Status:** draft para revisão arquitetural.
>
> **Escopo:** consolida a arquitetura já estabilizada do Agent Flow, corrige premissas
> que ficaram antigas na v3 e adiciona o roadmap pós-MVP2 para um modelo local opcional
> como worker de contexto.
>
> **Precedência:** esta v4 é o documento estratégico/arquitetural de alto nível. Durante
> o MVP2, `docs/specs/mvp2-safe-parallel-execution.md` continua sendo a autoridade
> normativa para detalhes de Safe Parallel Execution. Em caso de conflito, a spec do
> milestone prevalece até a v4 ser atualizada deliberadamente.

---

# 1. Objetivo

O Agent Flow é um orquestrador local-first para desenvolvimento assistido por agentes
de IA.

O produto coordena:

```text
Feature Request
      ↓
Discovery
      ↓
Architecture
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
Final Review / Definition of Done
```

O Agent Flow não é um agente de código único e não entrega o controle do workflow ao
modelo.

O orquestrador define a máquina de estados, os gates, os artefatos, a política de
routing, a validação, o isolamento Git e a integração. Os modelos executam papéis
delimitados dentro desse protocolo.

---

# 2. Princípios não negociáveis

## 2.1 Workflow pertence ao orquestrador

Model output nunca decide livremente:

- qual comando de shell executar;
- qual runner usar;
- qual modelo usar;
- quando uma task está validada;
- quando uma task está integrada;
- quando uma run está aprovada;
- quando a feature está concluída.

Essas decisões pertencem a código determinístico e configuração confiável.

## 2.2 Model output nunca vira shell diretamente

Validation IDs resolvem comandos definidos por configuração do projeto.

```text
model
  ↓
validation id
  ↓
trusted project configuration
  ↓
command
```

Nenhum texto arbitrário gerado por LLM é promovido a comando.

## 2.3 Artefatos, não contexto implícito

Cada estágio usa contexto independente.

O compartilhamento entre estágios ocorre por artefatos persistidos e contratos
estruturados.

Isso reduz:

- contaminação de contexto;
- auto-confirmação;
- dependência de histórico conversacional;
- custo de contexto;
- ambiguidade em recovery.

## 2.4 Verdade mecânica vence alegação do modelo

São fontes de verdade:

```text
StateStore
Git
exit codes
validation results
approved plan hash
attempt receipt
marker tree
integration ancestry
final verification
```

Não são fontes de verdade:

```text
"o agente disse que terminou"
"o resumo disse que os testes passaram"
"o modelo local disse que o arquivo é irrelevante"
```

## 2.5 Provenance real > intenção configurada

Persistência e observabilidade devem registrar o que efetivamente executou.

Fallback, clamping, tentativa, modelo e runner reais não podem ser substituídos pelo
que estava originalmente configurado.

## 2.6 Fallback é infraestrutura, não correção de qualidade

Permitido, quando configurado:

```text
quota_exceeded
runner_unavailable
auth_required
capacity / infrastructure failure equivalente
```

Não permitido automaticamente:

```text
bad implementation
validation_failed
review_failed
unexpected output sem classificação de infraestrutura
```

Uma falha de qualidade permanece visível.

## 2.7 Review independente quando possível

O autor e o reviewer devem preferencialmente usar contextos independentes e, quando
disponível/configurado, providers diferentes.

A independência é baseada no runner efetivamente usado, não somente no runner
pretendido.

## 2.8 Local-first

O fluxo principal deve funcionar sem serviço cloud próprio do Agent Flow.

Codex CLI e Claude Code CLI reutilizam suas autenticações locais.

O Agent Flow não armazena credenciais desses produtos.

---

# 3. Arquitetura atual

```text
                    ┌─────────────────────┐
                    │   Agent Flow Core   │
                    └──────────┬──────────┘
                               │
                  ┌────────────┴────────────┐
                  │                         │
                CLI                  Local Server
                                            │
                                          Web UI
```

Regra de dependência:

```text
Core ← CLI
Core ← Server ← Web UI
```

Nunca:

```text
Core → Web
Core → Server transport
```

A Web UI é control plane e observabilidade. Não possui uma segunda máquina de
estados.

---

# 4. Estado e auditoria

## 4.1 StateStore

`StateStore` é a fonte de verdade para o estado corrente da run.

Eventos são audit trail, não event sourcing.

## 4.2 Aprovação

A aprovação humana é vinculada ao hash exato do plano aprovado.

Mudança relevante no plano invalida a aprovação.

Browser nunca fornece um plan hash autoritativo; o servidor o calcula a partir do
artefato confiável.

## 4.3 Run execution lock

Somente um processo pode mover uma run por vez.

O mesmo lock coordena:

- CLI;
- Local Server;
- aprovação/rejeição;
- execução;
- review quando aplicável.

O lock é coordenação, não workflow state.

---

# 5. Runner abstraction

O core trabalha com roles lógicas.

Exemplos:

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

A configuração resolve:

```text
role
  ↓
runner
  ↓
model
  ↓
reasoning
```

Interface conceitual:

```ts
interface AgentRunner {
  id: string;
  capabilities(): RunnerCapabilities;
  healthCheck(): Promise<RunnerHealth>;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
```

Adapters de primeira classe:

```text
CodexRunner
ClaudeCodeRunner
```

O core não possui condicionais de provider.

---

# 6. Reasoning abstraction

O core usa níveis lógicos, traduzidos pelo adapter.

```ts
type ReasoningLevel =
  | "low"
  | "medium"
  | "high"
  | "very_high";
```

O adapter decide a representação física suportada pelo runner.

Quando o runner não suporta exatamente o nível solicitado, o resultado deve registrar
o clamping real.

---

# 7. Configuração

Dois níveis:

```text
~/.agent-flow/config.yaml     global
.agent-flow/config.yaml       projeto
```

Config global:

- runners;
- roles;
- modelos;
- reasoning;
- fallback;
- retry;
- paralelismo;
- Git/worktrees;
- UI;
- futura otimização de contexto.

Config do projeto:

- stack;
- comandos;
- validation IDs;
- paths;
- regras arquiteturais;
- AGENTS.md;
- peculiaridades do repositório.

A ferramenta deve preservar a regra:

```text
80% global
20% project-specific
```

---

# 8. Project commands

`project.commands.*` é configuração humana confiável.

Exemplos:

```yaml
project:
  commands:
    install: npm ci
    lint: npm run lint
    typecheck: npm run typecheck
    test: npm test
    build: npm run build
```

Nenhum segundo mecanismo como `git.worktreeSetup` deve duplicar `install`.

Para novos projetos Node com `package-lock.json`, stack detection deve preferir
`npm ci`.

Configuração já existente nunca é silenciosamente reescrita.

---

# 9. Git boundary

## 9.1 Um único spawner

Todo Git interno do Agent Flow passa por:

```text
src/adapters/git/git-command.ts
```

Sem shell.

Args são construídos e validados.

## 9.2 Hook isolation

Todo Git interno injeta um `core.hooksPath` Agent Flow-owned e vazio.

Isso vale somente para Git emitido pelo Agent Flow.

Não vale para:

- comandos do projeto;
- Git executado pelo usuário;
- Git disparado internamente por ferramentas do projeto.

## 9.3 Nenhum Git config persistente

Agent Flow não escreve configuração Git global/local para implementar seu protocolo.

## 9.4 Browser boundary

Requests HTTP nunca aceitam do browser:

- absolute path;
- worktree path;
- branch;
- ref;
- OID;
- shell command;
- plan hash autoritativo.

Responses podem expor provenance confiável quando necessário, mas não absolute
worktree paths.

---

# 10. Safe Parallel Execution — MVP2

MVP2 transforma a implementação sequencial em execução paralela isolada sem mudar as
fontes de verdade.

Detalhes normativos permanecem em:

```text
docs/specs/mvp2-safe-parallel-execution.md
```

## 10.1 Invariantes

- wave-based bounded parallelism;
- barreira por wave;
- um worktree por task attempt;
- integration branch por run;
- integration worktree separado;
- marker commit construído de tree validada;
- integração serial e determinística;
- `completed` somente após integração;
- final verification e final review no integration tree;
- retry cria novo attempt/worktree;
- recovery é receipt-first;
- user working tree permanece intocado;
- `RunExecutionLock` engloba os workers;
- StateStore continua único.

## 10.2 Isolation mode imutável

Ao criar uma run são capturados juntos:

```text
planningBase
gitRunKey
isolationMode
```

A configuração posterior não muda a identidade daquela run.

## 10.3 Worktree placement

Worktrees vivem fora do repositório:

```text
~/.agent-flow/worktrees/<repoKey>/<gitRunKey>/...
```

Nunca:

```text
.git/agent-flow/...
<project>/.agent-flow/worktrees/...
qualquer diretório dentro do working tree do usuário
```

## 10.4 Task workspace preparation

Sequência:

```text
worktree add --lock
↓
assert clean
↓
project.commands.install (quando configurado)
↓
assert clean
↓
agent
```

Clean é exatamente:

```text
git status --porcelain=v1 --untracked-files=all
```

Falha de preparação:

- gasta o attempt;
- task vira `failed`;
- agente não executa;
- worktree permanece locked para diagnóstico;
- nenhum `TaskResult` falso é fabricado.

## 10.5 Validation

RED/GREEN é julgado exatamente uma vez no worktree da task.

Não existe integration validation gate.

A autoridade de “everything green” continua sendo final verification.

## 10.6 Marker

Após validação satisfeita:

```text
git add -A
git write-tree
receipt persistido
git commit-tree <validatedTree> -p <base>
git update-ref <attempt-ref> <marker>
```

Marker é uma função determinística do artefato persistido.

Coding-agent commits são implementação intermediária, não provenance de validação.

## 10.7 Integração

Markers são integrados serialmente em ordem topológica.

Nenhum task fica `completed` antes de seu marker integrar com sucesso.

## 10.8 Recovery

Recovery nunca deduz verdade apenas pela forma do Git.

A ordem de confiança é:

```text
persisted attempt artifact
↓
receipt / nonce
↓
tree
↓
marker
↓
ancestry
```

## 10.9 Paralelismo

`effectiveConcurrency > 1` só é ativado no milestone dedicado após todas as garantias
de isolamento, marker, integração, recovery, retry e observabilidade.

Performance nunca antecede segurança.

---

# 11. Web UI

A Web UI continua opcional.

Princípios:

- local-first;
- render-only para regras de workflow;
- StateStore/read models como fonte;
- SSE para atualização;
- sem credenciais no browser;
- sem path/ref/command controlado pelo browser;
- sem merge/scheduler logic em React.

A UI deve tornar explícitos:

- run stage;
- tasks;
- attempts;
- runner/model reais;
- fallback;
- degradação;
- worktree/isolation mode;
- awaiting integration;
- conflito;
- artifacts;
- approval;
- verification;
- final review.

---

# 12. Definition of Done

Feature concluída somente quando:

```text
approved SDD/plan
+
all required tasks integrated
+
final verification satisfied
+
final review satisfied
+
Definition of Done code-evaluated
```

Nunca:

```text
agent said completed
```

---

# 13. Roadmap

## MVP1 — Local orchestrator

Inclui:

- CLI;
- config;
- runners;
- workflow;
- SDD;
- planning;
- approval;
- execução sequencial;
- verification;
- final review;
- persistence;
- resume;
- controlled fallback.

## UI — Local control plane

Inclui:

- Local Server;
- Web UI;
- read models;
- write actions;
- SSE;
- DAG;
- visual regression;
- E2E.

## MVP2 — Safe Parallel Execution

Milestones independentes e auditáveis.

Princípio:

```text
isolation → evidence → integration → recovery → retry → observability → activation
```

Nenhum milestone posterior pode “atalhar” uma garantia de um anterior.

## MVP3 — Context Intelligence

Objetivo:

> usar um modelo local opcional para trabalho volumoso/barato de contexto, preservando
> Claude/Codex (ou outros primary runners) para reasoning e coding de maior valor.

MVP3 só começa após MVP2 PASS FINAL.

---

# 14. MVP3 — Optional Local Context Worker

## 14.1 Motivação

Coding agents gastam contexto caro em tarefas que nem sempre exigem o melhor modelo:

- descobrir arquivos relevantes;
- resumir módulos;
- comprimir código candidato;
- reduzir logs;
- resumir diffs;
- classificar falhas;
- preparar contexto para um primary runner.

Um modelo local pode executar essas funções sem alterar a autoridade do workflow.

## 14.2 Não é `AgentRunner` por padrão

O worker local não deve ser tratado como coding runner apenas porque usa um LLM.

Separar:

```text
AgentRunner
  → produz/revisa trabalho do workflow

UtilityModel / ContextWorker
  → produz contexto advisory
```

Isso evita misturar:

- fallback de execução;
- routing de roles;
- provenance de coding;
- otimização de contexto.

## 14.3 Regra de autoridade

```text
Local model output = advisory context
Raw evidence       = source of truth
```

O worker local pode dizer:

```text
"estes 8 arquivos parecem relevantes"
```

Não pode estabelecer:

```text
"testes passaram"
"task está completed"
"marker é válido"
"merge está seguro"
```

## 14.4 Port conceitual

```ts
interface UtilityModel {
  id: string;

  capabilities(): UtilityModelCapabilities;

  healthCheck(): Promise<UtilityModelHealth>;

  run(input: UtilityModelInput): Promise<UtilityModelResult>;
}
```

Capabilities possíveis:

```ts
interface UtilityModelCapabilities {
  contextWindow: number;
  supportsStructuredOutput: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
}
```

Tool calling não é obrigatório para o primeiro MVP3.

Structured output confiável e bom instruction following já são suficientes para os
primeiros casos de uso.

---

# 15. OpenAI-compatible adapter

Primeiro adapter:

```text
OpenAICompatibleUtilityModel
```

Compatível com endpoints locais que exponham `/v1`.

Exemplos de servidores possíveis:

- LM Studio;
- llama.cpp server;
- Ollama via endpoint compatível/proxy;
- LiteLLM;
- outros servidores OpenAI-compatible.

Exemplo de configuração genérica:

```yaml
context:
  utilityModel:
    enabled: true
    type: openai-compatible
    baseUrl: http://local-model-host:8080/v1
    model: moe
    contextWindow: 65536
    targetInputTokens: 48000
    maxOutputTokens: 6000
    timeoutSeconds: 120
```

O Agent Flow deve funcionar normalmente quando `enabled: false`.

---

# 16. Context window policy

Nunca planejar uso em 100% do context window.

Para uma janela de 64k:

```text
hard cap              65536
target input          ~45k–50k
reserved output       ~4k–8k
system/harness margin restante
```

A policy deve ser configurável e conservadora.

Não confiar cegamente em `/v1/models` para descobrir context window; permitir valor
explícito em config.

---

# 17. ContextPacket

O produto do worker local deve ser estruturado.

Exemplo:

```ts
interface ContextPacket {
  taskId?: string;
  objective: string;

  relevantFiles: Array<{
    path: string;
    reason: string;
  }>;

  relevantSymbols: Array<{
    symbol: string;
    path: string;
    reason: string;
  }>;

  constraints: string[];
  architectureNotes: string[];
  risks: string[];

  evidence: Array<{
    kind: "file" | "diff" | "log" | "artifact";
    id: string;
  }>;
}
```

O packet nunca substitui os arquivos/logs brutos.

Ele é uma camada de seleção e compressão.

---

# 18. Retrieval local

Primeiro caso de uso:

```text
Task
 ↓
deterministic repository candidate discovery
 ↓
local model ranks/explains candidates
 ↓
ContextPacket
 ↓
primary runner
```

O modelo local não deve receber autoridade para inventar paths.

Paths candidatos vêm do repositório e são validados pelo Agent Flow.

Saída com path inexistente deve ser descartada.

---

# 19. Hierarchical context compression

Se o conteúdo exceder o target local:

```text
candidate set
  ↓
bounded chunks
  ↓
local summaries
  ↓
summary consolidation
  ↓
ContextPacket
```

Cada estágio possui budgets explícitos.

Nenhum chunk pode crescer sem limite por recursão.

Raw inputs permanecem disponíveis para reconsulta.

---

# 20. Log triage

Logs grandes podem ser processados localmente.

Exemplo:

```text
18k lines
 ↓
local triage
 ↓
failure groups
relevant excerpts
suspected common cause
locations
 ↓
primary runner
```

Mas:

```text
exit code / raw log = truth
local diagnosis      = advisory
```

Nunca transformar o resumo em validation result.

---

# 21. Diff summary

Antes de review, um diff grande pode produzir:

- módulos alterados;
- símbolos alterados;
- possíveis áreas de risco;
- relação com requisitos;
- trechos candidatos a revisão aprofundada.

O reviewer principal continua podendo acessar o diff bruto.

O resumo nunca é a única entrada do final review.

---

# 22. Utility failure semantics

Utility model é uma otimização.

Se falhar:

```text
connection refused
timeout
bad structured output
model unavailable
context overflow
```

default:

```text
bypass optimization
continue primary workflow
```

Não classificar isso como fallback de coding runner.

Registrar uma degradação/telemetria própria.

O local worker nunca deve bloquear uma run por padrão.

Políticas futuras podem permitir `required: true`, mas não é o default e não faz parte
do primeiro MVP3.

---

# 23. Context telemetry

Objetivo: provar se a otimização realmente ajuda.

Exemplo:

```text
candidate context estimated:  52,840 tokens
local model input:             47,390 tokens
local model output:             5,840 tokens
primary context sent:          11,180 tokens
estimated avoided context:     41,660 tokens
```

Usar o termo `estimated` quando tokenizers diferirem.

Registrar também:

- local latency;
- bypass count;
- structured-output failures;
- number of files before/after;
- local context overflows;
- primary runner context size quando observável.

Nunca apresentar isso como billing oficial.

---

# 24. Segurança do Utility Model

## 24.1 Sem comandos model-authored

Nenhuma saída do utility model vira:

- shell;
- Git argv;
- SSH command;
- filesystem path sem validação;
- network target.

## 24.2 Endpoint

`baseUrl` vem de configuração confiável.

O modelo não escolhe host/porta.

## 24.3 Secrets

Por padrão, não enviar:

- auth files;
- env secrets;
- known credential paths;
- `.git` internals;
- Agent Flow private state que não seja necessário;
- arquivos explicitamente negados pela configuração.

Adicionar deny patterns configuráveis.

## 24.4 Raw evidence

Context optimization não altera artefatos de evidência nem apaga logs brutos.

---

# 25. SSH — separado de inferência

Acesso SSH ao host do modelo pode ser útil para diagnóstico, mas não pertence ao
caminho de inferência.

Futuro componente opcional:

```text
LocalModelHostDiagnostics
```

Usos permitidos, com comandos fixos/allowlisted:

- verificar serviço;
- consultar GPU/RAM;
- consultar modelo carregado;
- reiniciar um serviço explicitamente configurado;
- coletar diagnóstico.

Nunca:

```text
LLM output → SSH command
```

Credenciais SSH não são armazenadas pelo Agent Flow.

Preferir:

```text
~/.ssh/config
ssh-agent
```

Esse componente fica fora do primeiro MVP3.

---

# 26. MVP3 milestones

## M3-00 — Architecture and probes

- medir endpoint OpenAI-compatible real;
- confirmar `/v1/models`;
- confirmar structured output;
- medir 64k real;
- medir latência;
- documentar tokenizer/budget assumptions;
- nenhum uso no workflow ainda.

## M3-01 — UtilityModel port

- contracts;
- capabilities;
- health;
- no dependency from core workflow decisions;
- fake adapter for CI.

## M3-02 — OpenAI-compatible adapter

- configurable baseUrl/model;
- timeout;
- bounded request;
- structured output parsing;
- error normalization;
- no required API key.

## M3-03 — ContextPacket

- schema;
- validation;
- path validation;
- budgets;
- artifact/evidence references.

## M3-04 — Repository retrieval

- deterministic candidate discovery;
- local ranking;
- relevant file/symbol packet;
- fallback/bypass.

## M3-05 — Hierarchical compression

- chunking;
- bounded recursive consolidation;
- context window enforcement;
- raw evidence retention.

## M3-06 — Log and diff triage

- log grouping;
- diff map;
- no replacement of mechanical verification.

## M3-07 — Context telemetry

- estimated input/output/context avoided;
- latency;
- bypass reasons;
- UI/read-model exposure sem secrets.

## M3-08 — Primary-runner context integration

- consume `ContextPacket`;
- primary runner can request raw follow-up context;
- packet never becomes exclusive evidence source;
- benchmark cloud-context reduction.

## M3-09 — Dogfood and benchmark

Matriz mínima:

```text
small task
medium task
large cross-module task
large failing test log
large diff review
utility model offline
utility model malformed output
context > 64k candidate set
```

Comparar:

```text
without local utility
vs
with local utility
```

Medir:

- correctness;
- primary context sent;
- latency;
- retries;
- review findings;
- bypass behavior.

## M3-10 — Optional SSH diagnostics

Somente depois do caminho HTTP estar estável.

Não é requisito para MVP3 PASS.

---

# 27. MVP3 acceptance

MVP3 é PASS quando:

```text
[ ] Agent Flow continua funcional com utilityModel disabled
[ ] utility model offline não impede fluxo principal
[ ] nenhuma saída local vira shell/Git/SSH
[ ] path inventado pelo modelo não é aceito
[ ] raw evidence permanece acessível
[ ] ContextPacket é validado estruturalmente
[ ] 64k é respeitado por budget/chunking
[ ] log summary nunca vira validation truth
[ ] diff summary nunca substitui final review evidence
[ ] telemetry diferencia estimativa de billing
[ ] benchmark mostra ganho mensurável em pelo menos um cenário relevante
[ ] benchmark não mostra regressão de correctness aceitável
[ ] CI usa fake utility model e não depende da LAN
[ ] dogfood real usa endpoint local OpenAI-compatible
```

---

# 28. Configuração futura completa

Exemplo:

```yaml
context:
  utilityModel:
    enabled: true

    adapter:
      type: openai-compatible
      baseUrl: http://local-model-host:8080/v1
      model: moe

    limits:
      contextWindow: 65536
      targetInputTokens: 48000
      maxOutputTokens: 6000
      timeoutSeconds: 120

    capabilities:
      retrieval: true
      compression: true
      logTriage: true
      diffSummary: true

    policy:
      bypassOnFailure: true
      minCandidateTokensForCompression: 12000

    security:
      deny:
        - "**/.env"
        - "**/.env.*"
        - "**/*secret*"
        - "**/*credential*"
```

Config names são propostos; devem ser validados durante M3-00 antes de congelar schema.

---

# 29. O que o utility model não faz

Primeiro MVP3 não usa o modelo local como:

- architect principal;
- planner principal;
- plan reviewer final;
- implementation runner;
- verification authority;
- final reviewer;
- integration decider;
- retry decider;
- command generator;
- Git operator.

Isso pode ser estudado futuramente como outra capability, mas não deve ser misturado
com Context Intelligence.

---

# 30. Evolução futura

Após MVP3, candidatos:

## MVP4 — Integrations / ecosystem

- monorepo aprofundado;
- GitHub Issues;
- Linear;
- OpenRouter/LiteLLM como providers opcionais;
- mais AgentRunner adapters;
- import/export de plans;
- richer repository indexing.

## MVP5 — Advanced orchestration

Somente se houver evidência real de necessidade:

- distributed workers;
- remote execution;
- policy-based model economics;
- richer pause/resume/cancel;
- multi-machine coordination.

Não antecipar complexidade distribuída antes do fluxo local provar necessidade.

---

# 31. Critério principal de sucesso

Agent Flow é bem-sucedido se:

1. o workflow é determinístico e retomável;
2. modelos não controlam o protocolo;
3. artefatos persistidos carregam as decisões entre contextos;
4. aprovação está vinculada ao plano exato;
5. provenance registra execução real;
6. fallback não mascara falha de qualidade;
7. tasks isoladas não escrevem no working tree do usuário;
8. integração é determinística e auditável;
9. final verification/review observam a mesma árvore;
10. UI não cria uma segunda state machine;
11. provider/model podem mudar sem reescrever o core;
12. local utility model é opcional e nunca uma fonte de verdade;
13. otimização de contexto é mensurada, não presumida;
14. o produto permanece local-first.

---

# 32. Decisão v4 sobre modelo local

A v4 formaliza a seguinte direção:

```text
Primary agents
Claude / Codex / outros AgentRunner
         ↓
reasoning + coding + review

Optional local utility model
OpenAI-compatible
         ↓
retrieval + compression + triage + summaries

Mechanical authorities
Git + StateStore + validation + receipts + markers
         ↓
truth
```

A meta não é “substituir Claude/Codex por um modelo local”.

A meta é:

> **reservar contexto e reasoning caros para decisões que realmente exigem isso,
> usando computação local para reduzir, organizar e selecionar evidência.**

Esse desenho deve permanecer opcional, mensurável e reversível.
