# Plano de melhoria — legibilidade, modelo local e precisão de contrato

Levantado durante o uso real do Agent Flow para construir um editor de canvas do zero
(`~/wk/flowcanvas`, 11 tasks, 9 delas executadas por um modelo local numa RTX 3060 Ti de
8 GB). O relatório com a evidência de cada item está em
[`~/wk/flowcanvas/docs/agent-flow-feedback.md`](../flowcanvas/docs/agent-flow-feedback.md).

Cinco achados já foram corrigidos (`08c66c2`, `034ee4a`, `1e263a8`, `6b8abff`). O que segue
é o que continua aberto, verificado contra o código de hoje.

---

## A tese: o produto sabe e não conta

Dos dezessete achados daquela sessão, **nenhum era de lógica de negócio**. Todos de
**projeção** — o núcleo apura a informação certa e ela não chega a quem opera, ou chega
descrita como outra coisa.

Isso é um bom lugar para estar: a parte difícil está certa. Mas é também o que decide se a
ferramenta é confiável no dia a dia, porque um operador que não sabe se a run está viva
para de confiar nela antes de encontrar qualquer defeito real.

O `events.jsonl` já registra tudo com carimbo de tempo. **Nenhum item deste plano precisa
de dado novo.**

---

## Frente 1 — Silêncio

O sintoma que mais custa: três comandos diferentes, minutos sem saída, e nenhuma forma de
distinguir trabalho lento de processo morto.

### 1.1 · `run` só anuncia a task com `--verbose` — BLOQUEANTE

`src/cli/run.ts:41`

```ts
if (globals.verbose) process.stdout.write(`  → ${taskId}\n`);
```

É o mesmo defeito já corrigido em `feature` (`1e263a8`), na terceira superfície. Medido:
45 minutos de terminal vazio numa task que estourou timeout, sem nenhuma forma de saber se
o agente trabalhava.

**Correção:** extrair o `writeStageProgress` de `feature.ts` para um módulo compartilhado e
usá-lo aqui. `→` ao iniciar; em TTY a linha final sobrescreve, em log ficam as duas.

### 1.2 · `doctor` instala o projeto inteiro em silêncio

`src/cli/doctor.ts:274`

O probe de checkout limpo roda o comando de install do projeto. Num projeto Node real são
minutos com **zero bytes de saída** — foi confundido com travamento e morto à mão.

**Correção:** anunciar antes (`→ probing install (npm ci in a fresh checkout)…`) e o
resultado depois. O probe é bom e documentado; só não se apresenta.

---

## Frente 2 — Mensagens que afirmam o falso

### 2.1 · "Its findings are above" — e não estão

`src/cli/feature.ts:384`

Os findings existem e `agent-flow status` os mostra, completos e por severidade. Só a
palavra "above" aponta para o lugar errado.

**Por que não é cosmético:** a instrução seguinte é `agent-flow revise "<instruction>"`, que
**exige exatamente o conteúdo não mostrado** — e cada `revise` consome orçamento (um
workflow `standard` tem dois). Quem acredita no "above" gasta uma tentativa às cegas.

**Correção:** *"Its findings are in `agent-flow status`."*

### 2.2 · `status` culpa o review por uma falha que não foi dele

`src/cli/status.ts:400`

Depois de uma run morrer em `planning` por erro de runner, o status respondeu *"The review
rejected this plan"* — e a stage `plan-review` nunca chegou a rodar.

**Correção:** distinguir `PLAN_REJECTED_REVISABLE` (o review reprovou → `revise`) de run
encerrada após falha técnica (→ `--from <stage>`, que preserva os artefatos e **não** gasta
ciclo de revisão).

### 2.3 · A recuperação existe e não é oferecida onde a falha acontece

`agent-flow feature --from <stage>` retoma preservando tudo o que veio antes, e o núcleo
suporta bem (`planning-pipeline.ts`, com `skipUntil` e status `cached`). Nada no caminho da
falha menciona. O único comando oferecido era `revise`, que é a ferramenta errada duas
vezes: prepende *"Revision requested by the reviewer"* quando nenhum revisor pediu nada, e
gasta um dos dois ciclos.

**Correção:** já aplicada em `feature` (`1e263a8`). Falta o mesmo em `status` de uma run
falhada, e considerar um `retry-stage <stage>` simétrico ao `retry <taskId>` que já existe
para execução.

---

## Frente 3 — Vocabulário que colapsa estados distintos

### 3.1 · `malformed_runner_output` para saída perfeitamente formada

`src/core/failure-classification.ts:185`

Uma run falhou assim com JSON válido, satisfazendo o `PlanSchema` inteiro e descrevendo seis
tarefas coerentes. O que não passou foi uma regra **semântica** (duas tarefas paralelas
declarando o mesmo arquivo). O código manda procurar problema de formato; o texto logo
abaixo explica um problema de conteúdo.

**Correção:** separar `plan_rejected_by_checks` — parseou, validou o schema, e reprovou numa
regra de plano. É o único caso em que `revise` é a ferramenta certa, e hoje ele é
indistinguível de um runner que devolveu lixo.

### 3.2 · A mesma stage aparece concluída e falhada

`src/app/stage-runner.ts:576`

`stage_completed` e `stage_failed` para `planning`, no mesmo carimbo de tempo. O `status`
então mostra `Task Planning ✓` numa run `FAILED`.

Faz sentido internamente — o runner completou, a verificação posterior reprovou — mas o
vocabulário não distingue "o agente terminou" de "o resultado foi aceito", e é a segunda
coisa que a pessoa está lendo.

**Correção:** `stage_output_received` para o primeiro, reservando `stage_completed` para
quando o resultado passou. **Único item com risco de regressão**: o dashboard lê esses
eventos.

### 3.3 · `state.stage` é lido como se fosse a verdade, e ele atrasa

Quatro módulos ainda o consultam: `run-projection.ts` (7×), `stage-timeline.ts` (5×),
`run-reader.ts` (2×), `event-bridge.ts` (1×).

O campo é ambíguo por construção — inicializado como `discovery` antes de discovery rodar e
escrito de novo como `discovery` quando termina — e o comentário de `buildStageTimeline` diz
isso em prosa, acima da linha que o usava assim mesmo. Já corrigido em dois pontos
(`034ee4a`, `1e263a8`); os demais seguem.

**Correção:** auditar os quatro. Onde o log responde, derivar do log e manter o campo apenas
como fallback para a janela antes do primeiro evento.

---

## Frente 4 — Modelo local como cidadão de primeira classe

O `openai-compatible` é um adapter de primeira classe no `registry.ts`, e quase tudo em volta
assume um CLI de fronteira.

### 4.1 · O README nega o adapter que o código registra

`README.md:323` afirma *"Those three are the coding-agent adapters that exist"* — e a tabela
de `README.md:503` lista **quatro**. Quem lê a seção de requisitos conclui que modelo local
só serve como `UtilityModel` advisory e não tenta configurá-lo como runner.

### 4.2 · Os defaults de timeout matam qualquer modelo local

`DEFAULT_TIMEOUT_SECONDS = 900` (`config.schema.ts:16`) para roles de CLI, e **300s** dentro
do `openai-runner.ts:36` para as stages de texto.

Medido: uma task morreu com `errorCode: 'timeout'` em **exatamente 900 segundos**; a mesma
task, depois de liberar contexto, fechou em **248s**. Ambos os números são normais para um
modelo local e absurdos para um CLI de fronteira — os defaults são calibrados só para o
segundo.

**Correção:** documentar a necessidade de `timeoutSeconds` por role ao usar
`openai-compatible`, e considerar um default maior quando o runner do role é esse tipo.

### 4.3 · O comentário do `openai-runner` conta errado

`openai-runner.ts:27` diz *"The two that do are `discovery` and `implementation`"*. São
**três** — `code-review` também declara `workingDirectory: true`, e é o menos óbvio, porque
cai no `finalReviewer` e só falha no fim da run.

**Correção:** derivar a lista do frontmatter em vez de escrevê-la à mão, ou um teste que
falhe quando um prompt novo declarar `workingDirectory: true` sem atualizar a documentação.

### 4.4 · A janela de contexto do modelo não é assunto de ninguém

Um endpoint local tem janela pequena (49k no caso medido) e o produto não pergunta nem
declara. O harness assume um modelo de fronteira e o limite só aparece quando o servidor
recusa — no meio da task, com o trabalho perdido.

**Correção:** um campo opcional `contextWindow` em `RunnerConfig`, usado para avisar quando
o contexto medido de uma stage se aproxima do teto. `stage_context_measured` **já mede** os
bytes; falta o teto para comparar.

### 4.5 · `RunnerConfig` não tem como passar argumentos ao CLI

`RunnerConfigSchema` aceita `type`, `enabled`, `command`, `baseUrl`, `apiKeyEnv`, `model`.
Apontar um CLI para um endpoint alternativo exige um wrapper de shell na máquina de cada um
— funciona, e é script solto fora do controle de versão.

**Correção:** um `args: string[]` opcional, anexado ao argv que o adapter monta.

---

## Frente 5 — Granularidade role × stage

### 5.1 · Um role serve stages com requisitos diferentes

`architect` serve `discovery` (exige filesystem) e `architecture-impact` (não exige). Como a
configuração associa runner a *role*, o `discovery` obriga o `architect` inteiro a ser uma
CLI, e o `architecture-impact` vai junto — mesmo sendo uma das stages que um endpoint
serviria.

Custo medido numa run: 22.370 bytes de contexto num CLI de fronteira que um modelo local
absorveria sem consumir quota.

**Correção:** override por stage (`roles.architect.stages.architecture-impact.runner`), ou
separar o role em dois.

### 5.2 · O `doctor` valida roles; o operador roteia stages

O relatório do `doctor` é bom — capabilities lidas dos adapters, effort conferido, e a frase
certa sobre não inferir de uma run que passou. Mas reporta por **role**, e a decisão é por
**stage**. Nada nele diz *"architecture-impact não precisa de filesystem e está indo para uma
CLI"*.

**Correção:** uma linha por stage, marcando as que estão num runner mais caro do que
precisariam.

### 5.3 · O `doctor` não lista runner que nenhum role usa

Um runner configurado e não roteado simplesmente não aparece no relatório. Configurar não
basta; é preciso apontar um role — e nada diz isso.

**Correção:** listar os configurados e não usados, como informação e não como erro.

---

## Ordem sugerida

| # | item | por quê primeiro |
|---|---|---|
| 1 | 1.1 · `run` anuncia a task | o mais caro em uso diário, e o padrão já existe pronto |
| 2 | 2.1 · "findings are above" | uma linha, e evita gastar revisão às cegas |
| 3 | 2.2 · `status` após falha técnica | fecha o par com 2.1 |
| 4 | 1.2 · `doctor` anuncia o install | mesmo sintoma, terceiro comando |
| 5 | 4.1 + 4.3 · README e comentário | documentação que faz desistir de um caminho que funciona |
| 6 | 3.1 · `plan_rejected_by_checks` | vocabulário, sem risco de regressão |
| 7 | 4.2 + 4.4 · timeouts e janela | tira o modelo local do campo minado |
| 8 | 5.2 + 5.3 · `doctor` por stage | torna o roteamento inspecionável |
| 9 | 3.3 · auditar `state.stage` | mecânico, muitos pontos |
| 10 | 3.2 · `stage_output_received` | único com risco de regressão no dashboard |
| 11 | 4.5 · `args` em `RunnerConfig` | mata o wrapper de shell |
| 12 | 5.1 · override por stage | maior mudança de contrato |

## Como cada item fecha

- teste que cobre o comportamento novo;
- **controle positivo** — reverter o fix e ver o teste ficar vermelho;
- verificação por **execução real**, não só asserção: rodar o comando e ler a saída;
- suíte inteira verde antes do commit.

## Restrição de coordenação

Os itens tocam `src/cli/` e `src/core/`. O item **3.2 muda um evento que o dashboard lê** —
avisar quem estiver em `apps/web/` antes de aplicar.
