# TODO

Fila executável do [`plan.md`](plan.md), em ordem. O porquê de cada item está lá; aqui é o
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

## Achados do dogfood de 10/09/2026 — `docs/specs/live-dogfood-remote-control.md`

O agent-flow planejou uma feature para o agent-flow: pareamento de dispositivo para o Deck,
em `high-risk`, `agy` planejando e `claude` revisando. A feature não saiu — a revisão entre
provedores recusou o plano com 11 achados e a revisão seguinte morreu por um defeito que eu
mesmo tinha introduzido uma hora antes. Os cinco itens abaixo são o resíduo, e quatro deles
são o mesmo defeito de roupa diferente: **um resultado que foi calculado e depois jogado
fora.**

- [x] **D1 · A porta ocupada responde com stack trace de Node** — `src/cli/ui.ts`
      `Error: listen EADDRINUSE` mais quatro linhas de `node:internal`. O produto sabe que
      a 4782 está tomada, que o dono é quase certamente outro `agent-flow ui`, e que
      `--port` existe. **Custou:** a falha foi silenciosa, o servidor antigo continuou
      respondendo servindo um workspace de `%TEMP%`, e a feature quase foi planejada contra
      o repositório errado.
      **Pronto quando:** a mensagem nomeia a porta, o provável dono e a saída, e um teste
      falha se voltar a ser um `throw` cru.

- [x] **D2 · `cross_provider_required` recusa depois de criar a run** — `src/app/run-actions.ts`
      `AF-2026-001` existe, sem plano, com 2,2 s de vida. A recusa em si é boa — rápida,
      nomeia os dois papéis e o provedor, e diz o que mudar. O defeito é *quando* ela
      dispara: os papéis configurados e a classe de workflow são ambos conhecidos no
      `POST`, antes de qualquer coisa ser criada. Mesma forma do C-19 que o `start` já
      corrigiu ("refused before the lock, not inside it") num caminho que não recebeu o
      tratamento.
      **Pronto quando:** a combinação impossível é recusada sem criar run, e um teste
      afirma que o histórico não ganhou entrada.

- [x] **D3 · O orçamento de cerimônia anuncia um limite de tarefas e não aplica** — `src/app/planning-pipeline.ts:346`
      O maior dos cinco, porque a run declara o limite e então o ignora. O log de
      `AF-2026-002` registra `budget.maxTasks: 8` em `workflow_classified`; o plano aceito
      tem **12 tarefas**, o portão reporta `taskCount: 12`, e nada recusou, avisou ou
      registrou degradação. `trivial` aplica 1 e `simple` aplica 3; `standard` e
      `high-risk` passam `ceremonyProblems: () => []`.
      **O custo não é teórico:** o terceiro achado da revisão foi uma tarefa com seis
      responsabilidades independentes — que é o que um plano faz quando nada empurra de
      volta no tamanho dele.
      **Pronto quando:** um plano acima do limite é recusado como os outros dois já são, e
      o planner é perguntado de novo com o problema anexado.

- [x] **D4 · `doctor` vaza uma worktree por invocação** — `src/app/diagnostics.ts`
      Seis diretórios em `~/.agent-flow/worktrees/doctor-install-probe-pid-*` depois de
      seis `doctor`, cada um com `node_modules` e nenhum registrado no Git. A sonda do §8.4
      é ligada por padrão no terminal, então cinco `doctor` pagam cinco `npm ci` e guardam
      cinco cópias.
      **A causa não é o que parece.** Medido: `git worktree remove --force` **apaga**
      arquivo ignorado. Então essas seis são remoções que *falharam* — e
      `probeInstallCleanliness` descarta o `GitResult` de `removeWorktree`, então ninguém
      foi avisado.
      **Pronto quando:** a sonda lê a resposta do Git, e um teste falha se o resultado for
      descartado.

- [x] **D5 · Nada recupera um diretório órfão sob a raiz própria** — `src/app/namespace-reclaim.ts`
      É por isso que o D4 acumula em vez de se resolver. `agent-flow clean --worktrees
      --dry-run` responde `Nothing to remove — 2 run(s), keeping 5.`: o escopo é *worktrees
      retidas de runs removidas*, derivado de estado de run. Essas não pertencem a run
      nenhuma — as da sonda são nomeadas por pid — e o Git já as desregistrou, então
      `worktree prune` também não as vê. Nenhum comando do produto as recupera.
      **Pronto quando:** `clean` nomeia e recupera um diretório sob a raiz própria que
      nenhuma run reivindica, e o dry-run o mostra antes.

- [ ] **D8 · O timeout default por papel é um sorteio para Opus neste repositório** — `src/contracts/config.schema.ts:28`
      `DEFAULT_TIMEOUT_SECONDS = 900`. Medido duas vezes, no mesmo estágio, no mesmo
      repositório, com o mesmo modelo: `AF-2026-003` fez o SDD em **15min03 e passou**;
      `AF-2026-004` fez em **15min02 e estourou**. Não é margem de segurança — é a linha
      exatamente onde o trabalho cai.
      **O que isso custa:** o estágio morre com `runner_timeout` e `rawExcerpt: ""` — não há
      saída para mostrar, porque não houve resposta. Discovery e impacto sobrevivem (os dois
      honram o ponto de retomada), então são ~20 min de Opus preservados e ~15 min jogados
      fora, por invocação, sem nada dizer que o limite estava perto.
      **Pronto quando:** ou o default cabe o pior caso medido de um repositório real, ou o
      estágio avisa antes de morrer — "este estágio está em 80% do limite" é um fato que o
      produto tem e não conta. O `doctor` sabe o `timeoutSeconds` de cada papel e nunca o
      compara com nada.

- [ ] **D13 · Obedecer o produto invalida a run** — `src/app/workspace-preparation.ts` + `src/app/run-git-identity.ts`
      Medido de ponta a ponta num projeto novo, em 10/09/2026. A sequência, cada passo
      correto sozinho:
      1. `run` recusa: *"the install command changed files that are tracked or not ignored:
         package-lock.json"* — antes de gastar qualquer chamada de modelo, nomeando o
         arquivo. Recusa exemplar.
      2. Commito o lockfile, que é o que ela pede.
      3. `run` recusa de novo: *"this run was planned against 2757f498 and HEAD is now
         446ced23"*. O §6.2 está certo: uma run isolada não constrói sobre árvore que se
         moveu.
      **Obedecer o passo 1 causa o passo 3, e nada avisa.** O plano de US$ 0,44 é perdido.
      **Pronto quando:** a recusa da preparação diz que commitar vai mover o HEAD e que o
      plano terá de ser refeito — ou, melhor, o `init` recusa terminar com o lockfile
      ausente em vez de avisar no rodapé de vinte linhas.

- [ ] **D12 · `run` manda começar uma run nova quando a resposta é `retry`** — `src/app/run-actions.ts`
      `refuseUnrunnable` trata `review_required` e `blocked` e não trata `failed`: uma
      tarefa falhada cai no ramo genérico *"Start a new run, or check `agent-flow status`"*.
      O `status`, olhando o mesmo estado, diz a coisa certa: *"Fix what stopped TASK-001,
      then `agent-flow retry` it."*
      O produto sabe a resposta e uma das duas superfícies não a dá — e é a superfície que
      a pessoa acabou de usar.
      **Pronto quando:** `run` e `status` dão a mesma instrução para o mesmo estado, e um
      teste falha se divergirem.

- [ ] **D11 · O `feature` imprime o caminho de um SDD que não existe** — `src/cli/feature.ts`
      No workflow `simple` não há estágio de SDD — e a mensagem final imprime
      `SDD  …/runs/AF-2026-001/sdd.md` mesmo assim. O arquivo não existe; `ls` no diretório
      da run mostra `plan.json` e nenhum `sdd.md`. Quem seguir a linha abre um arquivo que
      nunca foi escrito.
      **Pronto quando:** a mensagem lista os artefatos que a run produziu, lidos do
      diretório, e um teste roda os quatro workflows conferindo que cada caminho impresso
      existe.

- [ ] **D10 · Uma entrada de telemetria que não valida some sem dizer nada** — `src/app/telemetry.ts:99`
      `const parsed = TelemetryEntrySchema.safeParse(candidate); if (parsed.success)
      entries.push(parsed.data);` — sem `else`. Uma entrada que não valida não é reportada,
      não é contada, não vira evento: ela deixa de existir.
      **Medido:** consertar o D6 fez `repairs` virar 0 numa primeira tentativa; o campo
      `attempts` do schema é `min(1)`; o parse falhou; e a **página de telemetria inteira
      ficou vazia**. Nenhuma mensagem, nenhum aviso, nenhum log. Cinco testes caíram e
      nenhum deles dizia *por quê* — o diagnóstico exigiu ler o fold.
      É a mesma família dos outros: um resultado calculado e jogado fora. E é a pior
      variante, porque o descarte é de *evidência*.
      **Pronto quando:** uma entrada recusada aparece em algum lugar — contada no relatório,
      num evento, ou numa linha de log com o motivo do Zod — e um teste falha se voltar a
      sumir em silêncio.

- [x] **D6 · `repairs` reporta 1 quando não houve reparo nenhum** — `src/app/stage-runner.ts:626`
      O contador é incrementado no **topo** do loop, então `repairs: 1` significa uma
      tentativa e zero re-prompts. O docblock do campo diz que ele conta "how many times
      the stage had to re-prompt for a well-formed answer" e insiste, em parágrafo próprio,
      na distinção entre *repair* e *attempt* — enquanto reporta 1 para zero reparos.
      **Custou:** eu li `repairs: 1` como "o loop de reparo disparou" e escrevi isso no
      relatório de dogfood como um resultado positivo. Estava errado nas duas runs. O
      leitor que ele enganou foi quem escreveu o campo de leitura dele.
      **Pronto quando:** `repairs` é zero numa primeira tentativa bem-sucedida, e um teste
      fixa os três valores (0 sem reparo, 1 com um, 2 com dois) contra
      `MAX_REPAIR_ATTEMPTS`.

- [ ] **D7 · "The stages before X are kept" é falso para dois dos três** — `src/app/planning-pipeline.ts:301,315,328`
      O `skipUntil` chega em exatamente dois estágios — `architecture-impact` e `sdd` — via
      `stageOrExisting`. Os outros dois nunca o veem:

      | estágio | honra `--from` | por quê |
      |---|---|---|
      | discovery | **não** em `high-risk` | `useDiscoveryCache = workflow === 'high-risk' ? false : …`, e o discovery não passa pelo `stageOrExisting` |
      | architecture-impact | sim | `stageOrExisting` |
      | sdd | sim | `stageOrExisting` |
      | planning | **não** | chama `planUntilChecksPass` direto |

      **Medido, não lido.** `AF-2026-004` estourou o tempo no SDD e foi retomada com
      `--from sdd`; o log mostra `stage_started` para **discovery** sete segundos depois da
      retomada. A ação da própria recusa promete o contrário: *"The stages before sdd are
      kept."* Em `high-risk`, dos três estágios antes do SDD, um é preservado e um é
      refeito ao custo cheio — 10min17 de Opus, ~US$ 3,68.
      **Custou:** eu afirmei ao operador, duas vezes, que a retomada preservava o trabalho.
      A segunda vez foi depois de ler o código, e ainda estava errada — porque eu li o
      `stageOrExisting` e não o ramo do cache do discovery.
      **Pronto quando:** a frase enumera o que de fato sobrevive, ou os quatro estágios
      honram o ponto de retomada. E um teste falha se a frase e o comportamento voltarem a
      discordar — a frase é gerada de uma lista, não escrita à mão.

---

- [ ] **D9 · O gate pisca: `bornDirty` falha ~1 em 2 execuções da lane completa** — `test/fixtures/temp-repo.ts`
      Medido em 10/09/2026 com a máquina ociosa: uma execução completa da lane de
      subprocesso falhou em *"names the checkout phase when a fresh checkout is born
      dirty"*; a execução seguinte, também completa, passou (2657 ms); e o arquivo passou
      quatro vezes isolado. Não consegui capturar o texto da asserção — o reporter resumido
      corta o corpo — então a causa segue desconhecida.
      O fixture já foi diagnosticado duas vezes nesta base (a segunda vez corrigiu o
      `git add -A` que reestagiava a normalização), e o `vitest.lanes.ts` escreve a frase
      que torna isto grave: *"a timeout that reports contention teaches people to re-run
      the suite until it is green"*. Um gate que pisca é um gate em que ninguém confia.
      **Pronto quando:** a lane completa roda dez vezes seguidas verde, ou a causa está
      nomeada e fixada. Rodar com `--reporter=verbose` e guardar a saída inteira é o
      primeiro passo — foi o que faltou aqui.

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

- [x] **6.1b · Contenção de verdade para read-only: uma árvore descartável** — `src/app/read-only-workspace.ts`
      O resíduo medido do 6.1. Nenhum flag do `agy` impede a ferramenta de edição, então a
      única contenção honesta é uma árvore que a stage pode estragar sem consequência.

      **Um gêmeo da árvore que a stage ia ler, não um checkout do HEAD** — e essa
      distinção é o desenho inteiro. `git.useWorktrees` é `false` por padrão, então a
      instalação padrão planeja contra uma árvore de trabalho que pode ter trabalho não
      commitado (a deviation declarada do §6.2). Uma stage a quem mostrássemos o HEAD
      descreveria um repositório que não existe. Então: corta no HEAD da *fonte* e espelha
      os caminhos sujos dela — modificado e não rastreado copiados, apagado apagado, o
      caminho antigo de um rename removido. Arquivo ignorado não atravessa, porque
      `status --untracked-files=all` não o reporta — é o que mantém a cópia proporcional à
      mudança e não ao repositório.

      **A fonte é o diretório em que a stage ia rodar**, não o projeto: o diretório do
      projeto para uma stage de planejamento, a worktree da tentativa para um code review,
      a árvore de integração para a revisão final. Cortar o gêmeo *daquela* árvore é o que
      mantém uma revisão lendo o código que ela revisa. Os comandos de validação continuam
      onde sempre rodaram — `runCommands` não é stage.

      **Cortada por invocação e destruída num `finally`.** Medido neste repositório, 1107
      arquivos, Windows: ~3,4 s para abrir e ~0,6 s para soltar, **19,9 s para as cinco
      stages read-only de uma fase de planejamento**. Um cache com chave de fingerprint
      economizaria isso e, no dia em que a chave errasse, mostraria à stage o código da
      fase anterior — um defeito que ninguém acha lendo a saída. E a chave sonhada não
      existe: `status --porcelain` diz que um arquivo mudou, não *o que* mudou, então duas
      árvores diferentes produzem a mesma chave.

      **Falha para trás, e diz.** Sem HEAD, sem repositório, `worktree add` recusado — a
      stage roda onde rodaria e a run registra `read_only_uncontained` (R-16). Uma defesa
      que vira indisponibilidade é uma troca pior.

      **Pronto:** `test/app/read-only-containment.test.ts` dirige o `StageRunner` real com
      um runner que escreve dois arquivos no cwd que recebeu — o comportamento que o 6.1
      mediu — e o repositório sob julgamento fica byte a byte idêntico. O controle
      positivo é a mesma stage com `permissions: write`, que continua escrevendo no
      projeto; sem ele as outras asserções passariam também se o fake tivesse simplesmente
      parado de escrever. `test/app/read-only-workspace.test.ts` cobre a fidelidade
      (modificado, não rastreado, apagado), a remoção de uma árvore suja, e dois gêmeos
      concorrentes.

      **Três guardas de arquitetura tiveram de ser editadas**, que era o propósito delas:
      `addWorktree`, `removeWorktree` e `force: true` estavam presas a um módulo cada, com
      um comentário mandando o próximo milestone vir se justificar. A justificativa é a
      distinção do §7.4: a worktree de uma tentativa é a única cópia do que um agente
      produziu, e esta contém uma cópia de código que existe em outro lugar.

      **O que isto não é:** uma garantia de que o runner obedece. Continua sendo `--sandbox
      --disable-slash-commands` para o terminal e um diretório descartável para o resto.

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

- [x] **7.4 · Telemetria e analytics em tela — no Deck** — aba `Telemetry`, `/analytics`
      Duas telas: a telemetria da run entrou como quarta aba do painel de desfecho (é onde
      as outras respostas de fim de run já vivem), e `/analytics` é a agregação sobre as
      runs recentes.
      **Um achado no caminho.** O dashboard antigo declarava a resposta de
      `/runs/:id/telemetry` à mão — e **perdeu o `context`** ao fazer isso. A telemetria de
      contexto do AR-09 é justamente a metade que responde "por que essa stage custou
      tanto": servida, e sem leitor nenhum, em nenhuma superfície. Agora existe
      `RunTelemetryView` no contrato, o handler é tipado por ele, e um campo que se mexer é
      erro de compilação em vez de um campo que some.
      **Ausente não é zero**, e a tela diz isso: uma run cujo log foi truncado, ou anterior
      ao recorder, não observou nada — e um zero confortável ali seria mentira. Controle
      positivo no teste.
      A janela do `/analytics` é declarada na tela ("50 de 200"), porque um gráfico que
      descreve vinte de duzentas em silêncio está mentindo sobre o próprio assunto. E
      **nenhuma cifra aparece, em nível nenhum** — decisão do contrato, agora asserida.

- [x] **7.5 · `doctor` não tem rota** — `src/app/diagnostics.ts`, `GET /api/v1/doctor`, `/doctor`
      O comando calculava cada fato e o imprimia no mesmo fôlego, então o CLI era o único
      chamador **possível**. A extração é o item inteiro: `diagnose()` decide — Node, Git
      contra o piso de worktree, o probe §8.4, capacidades declaradas por role, roteamento
      por stage, veredito e remediações — e as duas superfícies só desenham. O
      `render/routing.ts` virou renderizador puro, e o teste passa pelas duas metades para
      que um achado sem frase (ou uma frase sem achado) fique vermelho.
      **Uma diferença é honesta e está declarada:** o servidor não lê o ambiente (§93), então
      runner com `apiKeyEnv` responde 401 ao health e sai `not configured`. O relatório
      carrega `readsEnvironment: false` e a tela qualifica em vez de repetir um falso
      negativo como achado. A rota é **sempre rasa** — `--deep` gasta cota por runner, e uma
      página que pudesse pedir pediria a cada refresh.
      Verificado rodando `agent-flow doctor` de verdade: saída idêntica à anterior.

- [x] **7.6 · Não há como registrar um projeto pela tela** — `POST /api/v1/projects`
      A nota do §68 dizia que faltava rota "porque adicionar significa escrever no
      registry". Diagnóstico errado do obstáculo certo: o registry é uma **caminhada**, não
      um arquivo — o que faltava era um **id**. Toda rota nomeia projeto por id que o
      servidor emitiu (§93), e um diretório sem `.agent-flow/` não tinha nenhum, então
      nenhuma requisição podia nomeá-lo. A caminhada agora emite id para candidatos também,
      sob os mesmos roots, a mesma profundidade e a mesma regra de contenção — nenhum path
      atravessa a fronteira, nos dois sentidos.
      Marcador é `.git`, não `package.json`: agent-flow precisa de worktree, branch e
      `planningBase`, e oferecer todo diretório seria um navegador de arquivos pior.
      O guarda de arquitetura pegou a primeira versão — o handler chamava `appendEvent`
      direto, que é a máquina de estado paralela do §60 — e forçou a forma certa:
      `registerProject()` em `app/init-project.ts`, com o gate AR-01 **antes** da escrita,
      chamado igual pelo CLI e pela rota. O aviso PRI-25 (`npm install` sem lockfile
      versionado recusa toda task) virou dado no `InitResult`, então chega às duas telas.
      O registry aprendeu a re-varrer: sem isso a escrita passa e a lista continua errada.

- [x] **7.7 · `clean` não tem rota** — `POST /api/v1/clean`, `/clean`
      `namespace-reclaim` já era o dono da metade perigosa — o que pode ser apagado, e em
      que ordem. O que estava no CLI era a metade de cima: quais runs são candidatas, se
      alguém está executando uma agora, e a regra §20.1 de que o diretório de estado vai
      por último e só se a metade Git deu certo. Isso virou `app/workspace-cleanup.ts`.
      **O preview é a mesma função.** `dryRun` desce pelo mesmo caminho e não escreve nada
      — um preview calculado por outro código é o preview de outra operação, e essa é a
      única coisa que um preview não pode ser. Na tela: nada é reclamado antes de um
      preview, e o preview **morre** no instante em que as opções dele mudam (com controle
      positivo). A única opção que apaga trabalho (`branches`, §20.4) não parece com as
      outras — nunca implícita, nunca default.
      O guarda de arquitetura foi ajustado junto: a leitura do lock (`.describe`) saiu dos
      dois adapters e passou a viver uma vez no caso de uso, e a regra agora falha se
      qualquer um dos dois voltar a perguntar por conta própria.

- [x] **7.8 · `/team` e `/collaboration` sem tela no Deck**
      Servidos desde o M5 e o M4, e o Deck não desenhava nenhum dos dois — então *"por que
      essa tarefa foi para esse agente"* só tinha resposta no `--classic`. Duas abas novas
      no registro da run, e **nada nelas é derivado**: score, `excludedBy`, status de
      membro, status de thread e de entrada vêm de `core/team/view.ts` e das projeções de
      colaboração. Um browser que reordenasse candidatos seria uma segunda autoridade de
      atribuição, e a primeira discordância colocaria na tela uma decisão que ninguém
      tomou (I-33, I-34).
      O ranking fica atrás de um disclosure por tarefa — a linha fechada é quem pegou e a
      frase que a política gravou; "por que não o outro" é pergunta real e rara.
      **Achado ao ligar os fios:** o `focus: 'team'` da fila de atenção existe desde o M8 e
      caía num `default: return undefined` — o item dizia "nenhum membro pôde pegar" e não
      abria nada. O mapa virou um `Record<AttentionFocus, …>`: um foco novo agora **não
      compila** até alguém decidir onde ele cai. Teste exaustivo sobre o union, mais os
      dois estados vazios que a M4 torna o caso comum (desligado ≠ ligado e quieto).

---

## O que só apareceu abrindo a tela

Levantado em 09/09/2026, rodando `agent-flow ui` de verdade contra dois workspaces: o real
(`wk/particular`, dois projetos e um repositório não registrado) e um descartável com **um**
repositório e nenhum projeto — a forma exata de um primeiro dia. Suíte verde nas duas
ocasiões; nada disto era visível de dentro dela.

- [x] **9.1 · O Doctor não abria: a sonda de install segurava a página inteira**
      `GET /doctor` rodava a sonda §8.4 — checkout descartável mais o install do projeto —
      **antes** de responder. Contra este repositório isso é minutos, o deadline de leitura
      do browser disparou primeiro, e a tela dizia *"This machine could not be diagnosed:
      signal timed out"*. Tudo o mais que o `doctor` sabe é lido de declarações e responde
      em menos de um segundo; **uma** checagem mantinha o resto refém.
      A sonda virou opt-in na rota (`?install=true`) e um botão na tela, com o custo dito
      na frase. Medido depois: **1,9 s** para a página, e a sonda quando alguém pede.
      Os dois opt-ins agora são separados porque custam coisas diferentes: `--deep` gasta
      **cota**, este gasta **tempo**. No terminal a sonda continua sendo o padrão — lá dá
      para bloquear, e o comando já anuncia antes de rodar.

- [x] **9.2 · Dia um: quatro telas girando para sempre**
      Workspace com zero projetos — que o 7.6 acabou de tornar um estado normal. O deck
      estava certo. **Doctor, Clean e Crew** guardavam com
      `projects.loading || project === undefined` e devolviam skeleton: duas respostas
      diferentes vestindo uma só. Carregando é temporário; não ter nenhum é permanente até
      alguém agir. **Analytics** era pior — buscava um agregado que o servidor não tem como
      escopar, levava 404, e reportava *"could not be read"*: uma falha, para uma ausência.
      Um estado vazio compartilhado (`NoProjectsYet`) que diz qual dos dois é e aponta para
      **Add project**. Teste em `first-day.test.tsx` cobre as quatro de uma vez, porque o
      defeito não era de nenhuma delas — era de uma forma que as quatro tinham copiado.

- [x] **9.3 · Duas coisas que só a captura de tela mostrou, nas abas novas do 7.8**
      `<small>` é inline, então a linha do membro saiu **`Backendpinned-model-id ·
      configured`** e quebrava no meio da frase — e nenhuma asserção pegou, porque toda
      elas casam um trecho e um trecho é exatamente o que uma falta de espaço continua
      contendo. `.doctor-row__name small { display: block }`, verificado na captura
      seguinte (é layout: o jsdom da suíte roda com `css: false` e não computa nenhum).
      E o handoff mostrava `backend → frontend` ao lado de uma thread que dizia
      `Backend, Frontend` — uma tela, dois vocabulários para os mesmos dois agentes.
      `HandoffView` carrega **ids** onde a mensagem carrega `fromName`; os nomes agora
      saem do roster que veio na *mesma* resposta, com o id como fallback e um controle
      positivo para ele.
      Verificado com o navegador de verdade contra uma run montada à mão em um projeto
      descartável (nenhum runner invocado, nenhuma cota gasta) — e o clique no item de
      atenção `focus: 'team'` **abre a aba Team**: `REVIEW` → `TEAM`, medido na página.

**O que foi verificado ponta a ponta pela tela**, num repositório descartável: registrar um
projeto (arquivos no disco conferidos, e o aviso PRI-25 disparou porque não havia lockfile
versionado), a sonda de install rodando sob demanda, o dry-run do `clean` e o plano
**morrendo** quando as opções mudam, a aba de telemetria, e `/analytics`. Sem erro de
console e sem requisição falha em nenhuma delas.

---

## O Deck em português

- [x] **10.1 · Toda a interface do Deck em pt-BR, com o inglês ainda disponível**
      Pedido: *"falta traduzir toda a interface do deck para pt-br, 100%"*. Escolhida a
      forma que o repo já usa em dois lugares — `apps/web` tem i18n com `en` + `pt-BR`, e
      existe um `README.pt-BR.md` ao lado do inglês: **dicionário por idioma, pt-BR como
      padrão**, seletor no cabeçalho, escolha lembrada por navegador.
      `en.ts` **é** o contrato: `Dictionary = typeof en`, e `pt-BR.ts` é anotado com ele —
      chave que falte, sobre ou mude de nome é **erro de compilação**, não uma tela meio
      traduzida que ninguém percebe. O teste de paridade cobre o que o compilador não vê:
      aridade das funções, formato dos arrays, e uma asserção de que nenhum valor foi
      **copiado** em vez de traduzido (com a lista curta do que é igual de propósito).
      **Funções, não `{n}`.** Contagem entra como argumento porque as duas línguas
      discordam do que uma contagem muda: `1 task` → `2 tasks` é sufixo, `1 tarefa` →
      `2 tarefas` concorda com um substantivo que o modelo não enxerga. É o mesmo motivo
      que `formatRelative`, `describe` (as frases do log) e `sectionFields` passaram a
      **receber** o dicionário: são folds puros, e um locale de módulo os tornaria função
      de quando rodaram.
      `words()` saiu de `lib/tone.ts` — aquele arquivo diz de si mesmo que é "o único
      lugar onde um status vira cor", e virar *linguagem* é outro trabalho que morava lá
      só porque os dois começam na mesma string.

- [x] **10.2 · Três defeitos que só a captura de tela mostrou**
      **`esforço alta`.** `low/medium/high` são gravidade *e* esforço; uma tabela só não
      concorda com *gravidade* e *esforço* ao mesmo tempo. Virou `levels` (masculino, para
      esforço e risco) ao lado de `words` (feminino, para gravidade). O inglês escreve as
      duas iguais — que é exatamente por que a separação tinha de ficar visível.
      **`autenticação desconhecido`.** Mesma classe, tabela própria (`authState`).
      **`verificação` no meio de oito ids de papel.** `verification` é id de papel *e*
      nome de estágio; o id é o que se digita no `config.yaml`, e traduzi-lo quebrou a
      regra que o próprio cabeçalho do `pt-BR.ts` enuncia. Ids não passam mais por
      `word()`; o estágio de mesmo nome continua traduzido na tabela de roteamento, porque
      lá ele é vocabulário e não chave.
      Achado de tabela: `sectionFields` era indexado pelo **rótulo**, e o `CrewPage` abria
      duas seções por padrão comparando com `'Runners'` e `'Parallelism'` — em pt-BR
      nenhuma das duas abria. Agora é indexado pela chave da configuração, que não é
      idioma.
      Verificado no navegador de verdade: `html lang` acompanha, a escolha **sobrevive ao
      reload**, e as seis telas abrem em português.

- [x] **10.3 · A regra de arquitetura que a tradução acordou**
      Mover a prosa do `doctor` para o dicionário transformou texto JSX em *string
      literal*, e a regra do Issue #21 — "nenhum nome de provider decide uma questão de
      modelo no browser" — passou a ver `openai-compatible` numa frase que ela nunca tinha
      lido. A frase não mudou; as aspas em volta dela mudaram.
      Os dois dicionários viraram exceção **como arquivos**, e a exceção é limitada por
      uma regra nova ao lado: nenhuma comparação contra um *provider* dentro deles.
      Estreita de propósito — o `taskFinished` do pt-BR compara `status` para concordar
      (`TASK-004 concluída`), e isso é fato sobre o português, não decisão sobre a run.

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

- [x] **8.3 · O vermelho que sobra não era "tempo" — era um arquivo na lane errada**
      A separação em duas lanes (`8960c2d`) resolveu as famílias de Git. O que restou não
      era contenção difusa: era **um** arquivo, e o predicado de lane não conseguia vê-lo.

      `run-execution-lock.race.test.ts` empacota o lock com esbuild e sobe **oito**
      processos Node. Não se chama `.integration.`, não importa a fixture de repositório e
      não importa `NodeProcessRunner` — alcança `node:child_process` pelo harness ao lado.
      Nenhuma das três propriedades o pegava, então o arquivo mais pesado da suíte rodava
      na lane apertada, e num gate com a máquina ocupada ele reprovou duas vezes. É
      literalmente o defeito que o comentário do `vitest.lanes.ts` previa: *"o próximo
      teste que ganhar um subprocesso não entra em lista nenhuma, cai na lane apertada, e
      fica vermelho na máquina de outra pessoa meses depois."*

      **Três correções, e nenhuma é afrouxar asserção:**
      - o predicado passou a seguir **um** nível de import local e a tratar
        `node:child_process` como marcador — derivado, não soletrado. Regra nova em
        `architecture.test.ts` que falha se um teste alcançar um filho por um helper e
        ficar na lane rápida, com o arquivo nomeado como controle.
      - `refuses a second process while the first is still holding` dormia 300 ms e
        **torcia**. Sob carga o primeiro filho ainda não tinha adquirido, o segundo pegou o
        lock legitimamente, e a asserção leu isso como falha de exclusão. Virou handshake:
        espera o arquivo de lock existir. Mesma classe de suposição que a barreira do teste
        acima já tinha removido — e que continuava aqui.
      - `leaves no grandchild running behind it` tinha a mesma forma de suposição: matava
        aos 300 ms e torcia. Medido sob carga, o kill chegava **durante a criação** do
        neto — `taskkill /T` andou uma árvore que ainda não o continha, e a segunda
        tentativa tinha raiz morta e não alcança nada. O órfão era real; o defeito que
        parecia, não. Orçamento de 3 s e um marcador `alive` que transforma o orçamento em
        **evidência**: se o neto nunca existiu, o teste diz isso em vez de passar sobre uma
        árvore que nunca foi construída.
        Duas medições viraram controle, porque cada uma é uma afirmação sobre a plataforma:
        desligar o kill em árvore **não** deixa o teste vermelho no Windows (um neto já
        iniciado morre junto com o pai de qualquer jeito), e `detached: true` também não
        escapa (`taskkill /T` anda por **pid do pai**, e destacar muda o console, não a
        parentela). Quem escapa é o processo cujo pai já saiu: foi re-parenteado, não está
        na árvore de ninguém, e nenhum kill ancorado em pid o alcança. Esse é o **limite
        honesto** do mecanismo, não um defeito dele — e é o sobrevivente que o teste
        precisa conseguir enxergar para não ser vácuo.
      - `expect(held).toHaveLength(1)` saiu. **Não é a propriedade**, e este arquivo já
        tinha escrito isso duas vezes: a barreira remove a suposição de *start-up*, não a
        de *escalonamento* — um contender desescalonado por mais que os 250 ms de posse
        acorda, acha o lock livre e o toma, o que é correto. Medido: duas aquisições, com
        `overlaps` vazio. Ficam a exclusão exata (`overlaps`, `maxSimultaneous`) e a
        completude (`held + refused === 8`), mais um **controle** novo sobre o detector,
        porque agora ele carrega a afirmação inteira e um detector cego passaria sempre.

- [x] **8.4 · `SHELL` morto travando o lint** — `test/app/verification-commands.test.ts`
      A prosa sobre "o shell que o produto realmente spawna" já vive onde a asserção
      acontece (`shellInvocation` no lugar, comparando `command` e `args`). O const acima
      não era usado por ninguém.

- [x] **8.5 · O gate ficou vermelho numa fixture que depende de um `spawn` dar certo**
      `doctor-install-probe` > *"names the checkout phase when a fresh checkout is born
      dirty"* falhou uma vez sob a lane cheia e passa sozinho — quatro gates anteriores
      verdes. A mensagem acusava o produto: *"expected … to contain 'not clean before
      installing'"*, ou seja, o checkout saiu **limpo**.
      Medido, não deduzido. A fixture nascia suja com `.gitattributes` +
      `filter.dirtier.smudge = sed …`, e um filtro **não-`required`** que não consegue
      subir é *ignorado* pelo Git:
      ```
      error: cannot fork to run external filter 'this-command-does-not-exist'
      $ git status --porcelain     # (nada)
      ```
      Sob a lane paralela no Windows, um `spawn` que falha apaga a condição sob teste e a
      asserção morre como se fosse regressão. Controle positivo: neutralizando a fixture
      nova, o erro reproduz **a mesma frase** do gate.
      Uma fixture só (`bornDirty`, usada pelos dois call sites — o outro era
      `task-workspaces`) e sem processo nenhum: o blob é commitado com CRLF **antes** de
      `.gitattributes` declarar `*.txt text`, então o checkout escreve aqueles bytes e o
      `status` limpa para LF antes de comparar.
      **E a primeira versão dela falhou no gate seguinte, pelo mesmo sintoma e por outro
      mecanismo** — o que desmentiu o "sempre" que eu tinha escrito aqui. O segundo commit
      usava `commitAll`, e `git add -A` **re-lê** um arquivo cujo stat parece sujo, aplica
      o atributo que ele mesmo acabou de declarar, e versiona a normalização:
      ```
      $ git add -A && git commit -m 'declare text'
      $ git cat-file -p :content.txt | od -c
      0000000   o   r   i   g   i   n   a   l  
      # normalizado, e a premissa foi embora
      ```
      Ou seja: se o índice guardava CRLF dependia de como o relógio caía entre dois
      commits. Agora o `.gitattributes` é staged **por nome**, o que não pode tocar no
      outro arquivo — medido nos dois lados, com e sem o stat sujo.
      E a fixture **verifica a própria premissa**: se o índice não tiver mais CRLF ela
      lança dizendo isso. As duas falhas chegaram à suíte como "o produto regrediu" quando
      a verdade era "a fixture não produziu nada para testar", e isso é o que a asserção
      corrige de vez.

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
