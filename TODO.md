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
