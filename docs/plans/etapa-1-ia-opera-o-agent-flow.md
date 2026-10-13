# Etapa 1 — a IA opera o agent-flow (plano)

Objetivo geral: o Luis conversa com uma IA que opera o agent-flow e só é chamado para três decisões — escopo, "resolveu de verdade" e PRD.
Esta etapa entrega a base: **qualquer modelo consegue operar o agent-flow sozinho, sem o humano digitar comando**, e o projeto aparece no hub sem passo manual.

Critério de pronto da etapa: numa sessão nova do Claude Code, no abastecepro, o Luis cola o link de uma story e a IA — sem ajuda — descobre o fluxo, inicia o run, acompanha, apresenta o gate de plano e aprova quando ele disser "aprovado". O projeto aparece no Deck sem `projects add`.

## Checklist — antes do PRIMEIRO commit do fork (pedido do Luis, 08/10)

- [ ] `.gitattributes` na raiz do toolkit: `* text=auto eol=lf` + scripts com shebang/`*.sh`/`*.mjs` em LF (cópia do Windows quebrou os e2e no Mac com `env: node\r`).
- [ ] Rodar a verificação de referência no Mac (procedimento na memória `agent-flow-kit-handoff-estado`): unit 100% e e2e só com as 5 falhas da base.
- [ ] Decidir com o Luis: `answer` usa o texto da resposta como "palavras" por padrão (ver dogfood-log).
- [ ] Revisão adversarial do diff inteiro com contexto limpo.
- [ ] Commit só quando o Luis pedir (decisão dele: ver funcionando no dia a dia antes).

## Requisito transversal — máquina virgem

O teste de aceitação do kit é numa **máquina Windows virgem**: sem git/node/az/SDKs, sem o repo do kit clonado, sem as memórias e skills pessoais do Luis. Tudo desta etapa precisa funcionar a partir de `git clone` + um comando de bootstrap, e o `doctor` tem que dizer, em português e em uma linha por item, o que falta e como resolver. Nada pode depender de `~/.ssh/config`, memória do Claude ou skill pessoal do Luis.

## Passo 0 — chão firme (antes de qualquer código novo)

1. Rodar de novo os gates do fork (`npm run check`, `test:deck`, `typecheck:deck`): o último verde é de 05/10.
2. Registrar o vermelho da base, se houver, antes de mexer (censo de baseline).

## Passo 1 — registro automático que não falha

Hoje já existe: `postAction` em `src/cli/index.ts:452` chama `rememberCurrentProject` depois de todo comando, e o `ui` faz scan do workspace. Falha nos casos reais do piloto:

| Caso | Hoje | Mudança |
|---|---|---|
| Comando rodado em subpasta | não registra (checa só o cwd) | subir até a raiz do repo (`git rev-parse --show-toplevel`) antes de checar `.agent-flow/config.yaml` |
| Worktree (`_wt/...`) sem `.agent-flow/config.yaml` | invisível — no piloto foi preciso copiar o config | worktree herda o config do repo principal (`git rev-parse --git-common-dir`) e é registrada como do mesmo projeto |
| Repo nunca usado | só aparece se o scan do `ui` alcançar | sem mudança nesta etapa — o MCP (passo 3) registra ao primeiro uso |

Testes: subpasta, worktree sem config, home (continua excluída), path inexistente (continua descartado).

**Resultado da investigação (07/10): sem mudança de código.** Toda a CLI trata `cwd` como raiz do projeto (`status`, `timeline` etc. procuram `.agent-flow` ali mesmo — `src/cli/index.ts:64`), então registrar a partir de subpasta não teria efeito útil, e fazer a CLI inteira subir até a raiz é mudança ampla, fora desta etapa. O caso real do piloto era a worktree **sem** `.agent-flow/config.yaml` porque o arquivo não está commitado no abastecepro — resolve-se commitando o config (decisão pendente do Luis), e cada worktree passa a se registrar sozinha pelo `postAction` que já existe. O MCP (passo 3) ganha `project_ensure` para registro explícito.

## Passo 2 — `agent-flow instructions <fluxo>`

Um registro único de guias (padrão do Backlog.md, MIT — copiar o registro com atribuição) servido por três canais: CLI (`agent-flow instructions [fluxo]`), tool MCP `flow_instructions` e resource `agent-flow://flows/<fluxo>`.

Guias, curtos (estado → comando/endpoint → onde o humano entra):
- `overview` — o que é cada fluxo e qual usar para qual ticket
- `feature` — link da story → run → gate de plano → implementação → revisão
- `gate` — como apresentar o plano ao humano e registrar aprovar/ajustar/rejeitar
- `blocked` — task bloqueada: o que perguntar ao humano e como responder (`answer`)
- `recover` — retry, revalidate, pause/resume/cancel

`AGENTS.md`/`CLAUDE.md` dos projetos recebem só um bloco curto entre marcadores (`<!-- AGENT-FLOW START/END -->`) mandando consultar `instructions overview`; a injeção preserva o conteúdo do usuário (padrão do Backlog.md).

## Passo 3 — servidor MCP (stdio), cliente fino do hub

**Desenho fechado (07/10, depois do `decidedBy`):**
- Cliente HTTP do hub (`127.0.0.1:4782` por padrão, configurável; header `x-agent-flow-client`), nunca chama os use cases direto: um dono só do estado; toda decisão via MCP sai gravada com canal `api` (o Deck já marca em tom de alerta); reaproveita validação, limites e locks da API.
- Se o hub não responder: a tool devolve erro acionável ("hub fora do ar — rode `agent-flow ui --no-open` ou verifique o autostart") — não sobe processo por conta própria.
- Tools (nome → rota existente):
  - `flow_instructions(key?)` → registro local `src/core/flow-guides.ts` (sem HTTP) · resources `agent-flow://flows/<key>`
  - `project_list()` → `GET /projects`
  - `run_start(projectId, description | file, grounded?)` → `POST /runs` (texto longo: ler o arquivo local e respeitar o teto de 8000; acima disso, erro dizendo para usar a CLI `--file`)
  - `run_list(projectId)`, `run_status(runId)` (inclui `gateDecision`), `run_timeline(runId)`, `job_status(jobId)`
  - `gate_get(runId)` → `GET /runs/:id/approval`
  - `gate_decide(runId, decision: approve|revise|reject, decidedBy {by, words}, instruction?)` → `POST approve|revise|reject` — `decidedBy` obrigatório no schema da tool; descrição da tool repete a regra "nome e palavras do humano, nunca inventados"
  - `task_answer(runId, taskId, answer, …)`, `task_retry(runId, taskId)`
  - `run_control(runId, action: pause|resume|cancel)`
  - `review_run(runId, fix?, e2eObserved?, observedBy?, e2eHead?)` → `POST /runs/:id/review`
- Descrições curtas, com pré-condição e próximo passo provável; todo texto de saída escrito para a IA (sem "você mesmo", sempre "peça ao humano").
- SDK: `@modelcontextprotocol/sdk` (`McpServer` + zod), entrada `agent-flow mcp` (stdio), adapter de entrada na camada da CLI (respeitar `test/architecture.test.ts`).
- Fora desta etapa: modo rígido "só Deck pareado decide"; recursos de eventos ao vivo (SSE) — a IA consulta `run_status`/`job_status`.

- Dependência nova: `@modelcontextprotocol/sdk` (+ zod, já usado no repo?).
- O MCP **não** tem estado próprio: chama a API HTTP do hub (`127.0.0.1:4782`, header `x-agent-flow-client`). Se o hub não estiver no ar, sobe ou orienta.
- Tools (mapeadas para endpoints que já existem):

| Tool | Endpoint |
|---|---|
| `flow_instructions` | registro do passo 2 |
| `project_ensure` | registra o repo atual (passo 1) |
| `run_start` | `POST /api/v1/runs` |
| `run_list` / `run_status` | `GET /runs`, `GET /runs/:id` (+ `timeline`) |
| `gate_get` / `gate_decide` | `GET /runs/:id/approval`, `POST approve` / `reject` / `revise` |
| `task_answer` / `task_retry` | `POST /runs/:id/tasks/:taskId/answer` / `retry` |
| `run_control` | `pause` / `resume` / `cancel` |

- Descrição de cada tool curta e com pré-condição ("só depois de `gate_get`"), para o modelo não chutar a ordem.
- Arquitetura: respeitar a camada hexagonal (`test/architecture.test.ts`) — MCP como adapter de entrada, igual à CLI.

## Fora desta etapa

Gate de runtime e entrega (`ship`) → etapa 2. Deck por ação humana → etapa 3. Triagem por custo → etapa 4 (o custo por tentativa já é registrado em `RunUsageSchema`; falta orçamento).

## Riscos

- Aprovar plano por tool dá à IA o poder de pular o humano. **Decidido (Luis, 07/10): o hub exige `decidedBy` em approve/reject/revise** — quem decidiu (humano identificado) e a frase da decisão; sem o campo, a API recusa (400). A regra fica no código, não só no guia `gate`. Registrar `decidedBy` no `events.jsonl` do run. ~~A CLI preenche com o usuário local~~ — revisto (Luis, 07/10): a CLI exige `--decided-by` + `--words` e NÃO usa git/usuário do SO (faria a aprovação da IA parecer humana); o canal (`deck`/`api`/`cli`) é derivado no servidor/CLI e gravado junto. O MCP só preenche com o que o humano disse. [feito, sem commit]
- O hub não tem autenticação (só loopback + guarda de Origin). O MCP roda local, então não muda a superfície — mas não expor o hub em `--host 0.0.0.0` com o MCP ligado.

## Ordem e tamanho

Passo 0 (S) → 1 (S) → 2 (S/M) → 3 (M). Cada passo com testes e os gates verdes antes do próximo. Nada é commitado até o Luis pedir.
