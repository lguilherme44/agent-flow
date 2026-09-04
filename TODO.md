# TODO

Fila executável do [`PLAN.md`](PLAN.md), em ordem. O porquê de cada item está lá; aqui é o
que fazer e como saber que fechou.

**Definição de pronto, para todos:** teste cobrindo o comportamento · controle positivo
(reverter o fix e ver o teste ficar vermelho) · verificação rodando o comando de verdade e
lendo a saída · suíte inteira verde.

---

## Silêncio

- [x] **1.1 · `run` anuncia a task ao iniciar** — `src/cli/run.ts:41`
      Extrair `writeStageProgress` de `src/cli/feature.ts` para um módulo compartilhado
      (`src/cli/render/progress.ts`) e usar nos dois. `→` ao iniciar; em TTY a linha final
      sobrescreve com `\r`, em log ficam as duas.
      **Pronto quando:** `agent-flow task <id>` imprime a task antes de executá-la, sem
      `--verbose`, e um log redirecionado tem uma linha por evento.

- [x] **1.2 · `doctor` anuncia o probe de install** — `src/cli/doctor.ts:274`
      `→ probing install (npm ci in a fresh checkout)…` antes, resultado depois.
      **Pronto quando:** `agent-flow doctor` num projeto Node não fica mais de 5s sem saída.

## Mensagens que afirmam o falso

- [x] **2.1 · "Its findings are in `agent-flow status`"** — `src/cli/feature.ts:384`
      Uma linha. Hoje diz "above" e não há nada acima.
      **Pronto quando:** a mensagem nomeia um comando que existe e mostra os findings.

- [x] **2.2 · `status` distingue review reprovado de falha técnica** — `src/cli/status.ts:400`
      `PLAN_REJECTED_REVISABLE` → sugerir `revise`. Run encerrada após falha → sugerir
      `--from <stage>`, e dizer que preserva os artefatos e não gasta ciclo de revisão.
      **Pronto quando:** uma run morta por erro de runner não menciona review.

- [x] **2.3 · `status` de run falhada oferece `--from`**
- [ ] **`agent-flow retry-stage <stage>`** — não feito, e fica como candidato.
      Simétrico ao `retry <taskId>` que já existe. Hoje tarefa se repete e stage de
      planejamento não, embora o núcleo saiba fazer as duas. Não entrou porque `--from`
      já resolve o caso que doía, e um segundo comando para a mesma coisa precisa de
      motivo melhor que simetria.

## Documentação que faz desistir de um caminho que funciona

- [x] **4.1 · README: quatro adapters, não três** — `README.md:323`
      A frase contradiz a tabela de `README.md:503`, 180 linhas abaixo. Trocar por algo como
      *"Three drive a coding CLI; a fourth serves an OpenAI-compatible endpoint for the
      stages that need no filesystem."*

- [x] **4.3 · São três prompts com `workingDirectory`, não dois** — `openai-runner.ts:27`
      `discovery`, `implementation` e **`code-review`**. Corrigir o comentário e, de
      preferência, derivar a lista do frontmatter.
      **Pronto quando:** existe um teste que falha se um prompt novo declarar
      `workingDirectory: true` sem a documentação acompanhar.

## Vocabulário

- [x] **3.1 · `plan_rejected_by_checks`** — `src/core/failure-classification.ts:185`
      Separar de `malformed_runner_output`: parseou, validou o schema, reprovou numa regra de
      plano. É o único caso em que `revise` é a ferramenta certa.
      **Pronto quando:** um plano válido reprovado por regra não é mais descrito como saída
      malformada.

## Modelo local

- [x] **4.2 · Timeouts que não assumem CLI de fronteira**
      `DEFAULT_TIMEOUT_SECONDS = 900` (`config.schema.ts:16`) e `300` no `openai-runner.ts:36`.
      Documentar `timeoutSeconds` por role; avaliar default maior quando o runner do role é
      `openai-compatible`.

- [x] **4.4 · `contextWindow` opcional em `RunnerConfig`**
      `stage_context_measured` já mede os bytes de cada stage. Falta o teto para comparar e
      avisar antes de o servidor recusar.
      **Pronto quando:** uma stage que se aproxima do teto declarado gera um aviso, não uma
      falha no meio do trabalho.

- [x] **4.5 · `args: string[]` em `RunnerConfig`**
      Hoje apontar um CLI para outro endpoint exige um wrapper de shell fora do controle de
      versão. Anexar ao argv que o adapter monta.

## Roteamento inspecionável

- [x] **5.2 · `doctor` reporta por stage, não só por role**
      Uma linha por stage, marcando as que estão num runner mais caro do que precisariam.

- [x] **5.3 · `doctor` lista runner configurado e não roteado**
      Hoje ele simplesmente não aparece — configurar não basta, é preciso apontar um role, e
      nada diz isso.

## Mecânicos e de maior risco (por último)

- [x] **3.3 · Auditar os quatro módulos que leem `state.stage`**
      `run-projection.ts` (7×), `stage-timeline.ts` (5×), `run-reader.ts` (2×),
      `event-bridge.ts` (1×). Onde o log responde, derivar do log; manter o campo só como
      fallback para a janela antes do primeiro evento.

- [x] **3.2 · `stage_output_received` emitido** — `stage-runner.ts`
      Aditivo: o evento novo é emitido quando o runner responde, e `stage_completed`
      **continua como está**.
- [ ] **3.2b · NÃO estreitar `stage_completed` para "aceito"** — decidido contra, com motivo.
      Revisão do `agent-flow-redesign` mostrou que ele tem **sete** leitores e um não é
      tela: `stageRunnersOf` (`plan-review-service.ts`) colhe `detail.runner` só de
      `stage_completed`, e `correctivePlanAuthors` usa essa lista como o conjunto de quem
      o review corretivo precisa ser **independente**. Estreitar faria um planning
      rejeitado sair da lista — e o runner que escreveu o plano ficaria elegível para
      revisá-lo, com o artefato afirmando independência que não existe. **Silenciosamente.**
      Teste em `test/app/stage-event-vocabulary.test.ts` fixa isso.

- [x] **5.1 · Override de runner por stage**
      `roles.architect.stages.architecture-impact.runner`, ou separar `architect` em dois
      roles. Maior mudança de contrato da lista.

---

## Já fechado nesta frente

- [x] `\d` nos schemas travava toda stage estruturada com modelo local — `08c66c2`
- [x] pipeline dizia `pending` para cache, para stage em execução e para implementação em
      curso — `034ee4a`, `6b8abff`
- [x] `feature` silencioso por 4 minutos; `…` que não disparava; linha de retomada na
      falha — `1e263a8`
- [x] ~~dashboard ignora `--config`~~ — retirado: o `ui` aceita, era erro de operação


---

## Fechado

Cinco commits, 14 itens, tudo com teste e controle positivo:

| commit | o que |
|---|---|
| `5246077` | `run` anuncia a task · `doctor` anuncia o install · findings apontam pro `status` · `status` distingue review de falha técnica · `plan_rejected_by_checks` · README e comentário dos prompts |
| `d53e3b2` | `args` e `contextWindow` em `RunnerConfig` · aviso a 80% da janela · os dois timeouts documentados |
| `5d2138b` | `doctor` reporta por stage · lista runner não roteado |
| `df7ea8f` | `stage_output_received` · `currentStage` derivado do log · vocabulário de eventos declarado |
| `b37bc0b` | override de runner por stage |

**Suíte:** 4361 testes, typecheck, lint, build.

**Dois itens ficaram abertos de propósito**, e ambos com motivo escrito: `retry-stage`
(simetria não é motivo suficiente) e estreitar `stage_completed` (quebraria uma decisão
de independência, em silêncio).
