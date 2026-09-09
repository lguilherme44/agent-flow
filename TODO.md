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

## Portabilidade, e um contrato que o código contradiz

Levantado em 08/09/2026, numa revisão no Windows: 121 de 4500 testes vermelhos, nenhum
deles defeito do produto. Fechado no mesmo dia, com medição contra `agy 1.1.27` no 6.1 e
controle positivo no 6.2 e no 6.3.

- [x] **6.1 · `agy` roda read-only com o terminal aberto** — `src/adapters/runners/agy-runner.ts`
      `6b47fe0` trocou `supportsReadOnly: false` → `true` e deixou a justificativa para
      trás: 30 linhas de comentário concluindo o contrário, outro comentário afirmando que
      o valor era `false`, e um teste assertando `true` sob a prosa *"the one that has no
      such mode"*. A tabela daquele comentário, completada por medição:

      | invocação | responde inline | bloqueia escrita por shell | bloqueia escrita por editor |
      |---|---|---|---|
      | `--mode plan` | não — ponteiro para `~/.gemini/…/brain/` | — | — |
      | `--mode accept-edits` (± `--sandbox`) | sim | não | não |
      | sem `--mode` — o que o adapter mandava | sim | **não** — sobrescreveu `target.txt` | não |
      | `--sandbox`, task read-only | **sim**, resposta completa | **sim** — `denied_actions: [command]` | não |

      A linha que faltava é a última, e ela desfaz meia conclusão: `--sandbox` **é**
      contenção — do terminal, e só dele. Uma stage de discovery real (quatro arquivos,
      estrutura resumida) respondeu inteira sob `--sandbox --disable-slash-commands`, sem
      escrever nada. O que ele não impede é o modelo alcançar a ferramenta de edição, o
      que foi medido acontecendo quando pedido.

      **Feito:** `isolationArgs` passa `--sandbox --disable-slash-commands` nas stages
      read-only — antes passava `[]`, que é o vetor exato do finding #8 do dogfood
      (`.atl/` e 56 KB dentro do repositório sob julgamento). O comentário de
      `capabilities()` agora diz que `true` é uma decisão de roteamento e não uma garantia
      de contenção, `runner-isolation.test.ts` fixa `readOnlyToo: true`, e um teste novo
      falha se os dois flags pararem de ser mandados.

      **Não voltar para `false`:** barra o runner de 6 dos 9 roles e quebra o operador com
      um agente só, que é caso suportado por projeto.

- [ ] **6.1b · Contenção de verdade para read-only: uma árvore descartável**
      O resíduo medido do 6.1. Nenhum flag do `agy` impede a ferramenta de edição, então a
      única contenção honesta é uma árvore que a stage pode estragar sem consequência — a
      máquina de worktree já existe, o roteamento de stage read-only é que não a usa.
      **Pronto quando:** uma stage read-only em `agy` escreve num arquivo e o repositório
      sob julgamento continua idêntico.

- [x] **6.2 · A suíte não passava no Windows, e nenhum CI via** — `.github/workflows/ci.yml`
      Duas rodadas que não concordavam — 101 falhas em 16 arquivos (342s) e 121 em 23
      (680s), a segunda com a máquina ocupada — porque parte do vermelho era **tempo**.

      **Duas causas-raiz mecânicas respondiam por 76 delas.** *Separador de path*: o gate
      comparava `'src\app\scheduler.ts'` com `'src/app/scheduler.ts'`, e nenhuma das 59
      falhas de `architecture.test.ts` era violação de arquitetura — era o guarda incapaz
      de rodar. Fechado num ponto só (`repoPath`), com uma regra nova que falha se o
      vocabulário voltar ao separador do host. *Backslash não escapado em código gerado*:
      `run-execution-lock.race.test.ts` não compilava, e vitest reportava seus 8 testes
      como `skipped` — a prova de exclusão mútua que o README anuncia não existia no
      Windows, na forma que mais parece deliberada.

      **Feito, por família:**
      - separador de path — `repoPath` em `architecture.test.ts`, normalização de chave no
        `InMemoryFileSystem`, e `flavour` propagado até o walk de `discoverProjects` (o
        seam que `within` e `normalise` já tinham e que não chegava no meio)
      - harness do lock — o root vai com `/`, e os 8 testes rodam
      - `node-process-runner` — `taskkill /pid <pid> /T /F` no win32, que é o gancho que
        `SUPPORTS_PROCESS_GROUPS` estava esperando desde o MVP; os testes de árvore
        deixaram de depender de `/bin/sh` e de `/tmp`
      - `git-client` — nome de arquivo com caractere de controle (ilegal no Win32) trocado
        por não-ASCII, que Git escapa igual; caminho passado ao `sh` do textconv com `/`
      - fixture — `core.autocrlf false` por repositório, para a máquina não decidir o que
        o teste mede

      **Job `check-windows` no CI**, `windows-latest`, `timeout-minutes: 45`. O gate de
      drift pegou o passo de setup e recusou — trabalho dele —, e pegar isso revelou uma
      segunda cópia do contrato: `m8-acceptance.test.ts` tinha `npm ci` hardcoded num
      regex em vez de ler `INFRASTRUCTURE`. Agora lê.

- [x] **6.3 · O preparo do workspace desligado, e o evento mentindo** — `src/app/run-actions.ts`
      O diff não commitado pulava `prepareWorkspace` fora de worktree, e estava **certo**:
      `prepareWorkspace` abre com `assert clean`, e uma run sequencial revisa o checkout do
      operador, que carrega a implementação como mudança não commitada — asserti-lo limpo
      é recusar o trabalho que a review foi chamada para julgar. Toda run sequencial
      terminaria em `workspace_preparation_failed`, verificação `NOT_RUN`, e um Definition
      of Done inalcançável.

      O que estava errado era o registro: `workspace_prepared` com
      `install: 'none configured'` para um projeto que configura `npm ci`. Agora o evento
      diz qual dos dois caminhos rodou (`workspace: 'integration' | 'checkout'`), nomeia o
      install configurado e declara `installRan: false`. Teste em
      `review-run.integration.test.ts`, com controle positivo.

- [ ] **6.4 · Não está no npm, e o uso diário é um checkout** — `package.json`
      Sem pacote publicado e sem release: instalar é clonar e `npm run build` a cada
      `git pull`. `README.md:88` e `README.md:342` já dizem isso — o item é decidir entre
      publicar e documentar o checkout como o caminho suportado.
      **Pronto quando:** existe `npm i -g agent-flow`, ou uma seção de instalação que não
      pressupõe o checkout de desenvolvimento.

---

## O Deck como superfície única

Levantado em 09/09/2026. O uso pretendido é `agent-flow ui`, Deck, e **nada de CLI** — o
que muda a ordem da lista acima, porque a lacuna não é de núcleo: o servidor expõe 45
rotas e o Deck consumia 28. A frente tem duas camadas, e vale distinguir: **7.1 a 7.4** são
telas para respostas que o servidor já dá; **7.5 a 7.7** precisam de rota nova antes de
qualquer tela.

- [x] **7.1 · O fim da run não estava no Deck** — `apps/deck/src/features/run/Outcome.tsx`
      O que o review achou, para onde a run foi e o que ela escreveu — `/review`,
      `/delivery`, `/artifacts` — eram alcançáveis só pelo `--classic`. Um painel novo com
      três abas embaixo do recorder: threads e findings com severidade, lifecycle,
      independência (§19) e a árvore revisada contra a integrada (§4); gates com
      `not_run` que nunca é verde (I-24); branch, PR e os checks do forge; e os sete
      artefatos lidos **como texto**, nunca como markup. `unsatisfiedGates` chega
      respondido — o painel não recalcula `required && status !== 'passed'`.
      Dez testes lendo o DOM, com controle positivo em três deles.

- [x] **7.2 · `AttentionFocus` não era lido por ninguém** — `RunPage.tsx`
      A projeção emite um `focus` por item desde o M8 e o Deck ignorava o campo inteiro:
      toda linha que não *agia* selecionava uma task e parava, então "Review the findings"
      e "os checks do remoto ficaram vermelhos" caíam no mesmo painel, e nenhum dos dois
      tinha a resposta. É a mesma forma exata do `?panel=` do dashboard antigo, que passou
      dois milestones sem leitor. **Um campo que ninguém lê não quebra compilador nem
      asserção.**

- [x] **7.3 · Uma segunda lista de artefatos, na rota** — `api.schema.ts`
      `ArtifactParamsSchema` tinha uma cópia à mão de `ARTIFACT_NAMES`. As duas
      concordavam só porque ninguém tinha acrescentado artefato desde então: o próximo
      parsearia em todo o produto e seria recusado por essa rota só, como
      `unknown artifact` — um 400 culpando o chamador pela omissão do servidor, na única
      superfície que não tem outro jeito de ler o que a run escreveu. Teste com controle
      positivo em `contracts.test.ts`.

- [ ] **7.4 · Telemetria e analytics em tela — no Deck**
      `/analytics` e `/runs/:id/telemetry` são servidos e o Deck não desenha nenhum dos
      dois. Duração por stage, uso por modelo, desfechos, e a telemetria de contexto do
      AR-09 (que é o que responde "por que essa stage custou tanto"). Hoje: `--classic`.
      **Nota de escopo:** `AnalyticsView` não tem cifra e não vai ter — *"No monetary
      figure appears, at any level"* é decisão declarada no contrato. Custo em dinheiro é
      outro item, se for para existir.
      **Pronto quando:** uma run fechada mostra, no Deck, quanto cada stage levou e de que
      o prompt dela foi feito, por fonte.

- [ ] **7.5 · `doctor` não tem rota**
      "Essa máquina consegue trabalhar?" é a primeira pergunta de todo dia e só o CLI pode
      ser perguntado. Versão do Git contra o piso, o probe de install em checkout limpo, o
      pareamento (runner, model) por role, e o `permission_not_ready` do AR-01. Lacuna de
      servidor antes de ser de tela.
      **Pronto quando:** o Deck reporta `OK`/`DEGRADED`/`FAIL` com as mesmas seções que o
      `agent-flow doctor` imprime.

- [ ] **7.6 · Não há como registrar um projeto pela tela**
      O botão existe desabilitado no `--classic` desde o §68, e o Deck não tem nem o botão.
      `init` detecta stack, lê os scripts reais e escreve `.agent-flow/config.yaml` — é
      escrita no repositório do operador, então o cuidado é o do `--force` e não a
      ausência de rota.
      **Pronto quando:** um repositório sem `.agent-flow/` vira um projeto do workspace sem
      ninguém digitar nada.

- [ ] **7.7 · `clean` não tem rota**
      Reclamação de worktree e de ref é a operação que mais assusta e a que mais precisa de
      `--dry-run` numa tela. O núcleo já responde as duas coisas (`namespace-reclaim`, com
      retenção do que é a única cópia).
      **Pronto quando:** o Deck mostra o que seria removido e o que seria retido, e por quê,
      antes de remover.

- [ ] **7.8 · `/team` e `/collaboration` sem tela no Deck**
      Servidos, e o M4 sai desligado — normalmente não há o que desenhar. Último da fila
      por isso, e não por ser menos verdade.

---

## A suíte no Windows, medida de novo

- [x] **8.1 · Duas portas de `GitWorkspaces` respondendo em vocabulários diferentes**
      `workspacePath` resolvia com `path.resolve` e devolvia `\`; `listWorktrees` devolve o
      que o Git imprimiu e `ownWorktrees` o que o `realPath` normalizou — os dois `/`. Uma
      porta, dois vocabulários, e quem compara um contra o outro decide que nada está
      dentro de nada. `namespace-reclaim` é esse chamador: sobreviveu só porque também
      pergunta ao `realPath` e testa as duas formas, sob um comentário sobre symlink que
      não menciona separador — e o fallback `?? path.value` volta para a forma `\`, onde o
      teste de pertinência falha e um worktree que devia ser reclamado é **silenciosamente
      retido**. Normalizado em `workspacePath`; `resolveWithinRoot` ficou intacto, porque é
      a checagem de contenção e as regras dela são asseridas para win32 desde o Linux
      (§26.2). Teste novo fixa o contrato, com controle positivo.

- [x] **8.2 · A cópia do defeito de separador que o 6.2 não pegou** — `apps/web/src/lib/architecture.test.ts`
      Cinco regras comparando `'lib\api.ts'` com `'lib/api.ts'`, um diretório ao lado do
      suite que o 6.2 fechou. Mesmo seam (`srcPath`) e o mesmo guarda que falha se o
      vocabulário voltar ao separador do host.

- [ ] **8.3 · O vermelho que sobra é tempo, e o 6.2 não fechou isso**
      Medido em 09/09: ~40 falhas na suíte cheia, **todas verdes isoladas**.
      `parallel-wave.integration.test.ts` são 10 testes em 101s; `node-process-runner`, 30
      em 33s. Sob a suíte inteira em paralelo no Windows, as famílias de integração de Git
      estouram as próprias janelas — inclusive `leaves no grandchild running behind it`,
      que é uma afirmação de contenção real e que passa sozinha.
      O 6.2 registrou que "parte do vermelho era tempo" e mediu duas causas mecânicas; a
      causa de tempo ficou sem correção. Uma suíte vermelha por contenção é uma suíte que o
      mantenedor para de rodar, que é exatamente o que aquele item diz.
      **Pronto quando:** `npm run gate:node` fecha verde no Windows, duas vezes seguidas,
      numa máquina em uso — por isolamento de pool, orçamento por família, ou seriação
      declarada das lanes de integração.

- [x] **8.4 · `SHELL` morto travando o lint** — `test/app/verification-commands.test.ts`
      A prosa sobre "o shell que o produto realmente spawna" já vive onde a asserção
      acontece (`shellInvocation` no lugar, comparando `command` e `args`). O const acima
      não era usado por ninguém.

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
