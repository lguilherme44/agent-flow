# TODO

Fila executável do [`roadmap.md`](roadmap.md), em ondas. O porquê de cada
frente está lá; aqui é o que fazer e como saber que fechou.

**Definição de pronto, para todos:** teste cobrindo o
comportamento · controle positivo (reverter o fix e ver o teste ficar vermelho, conferindo
que a reversão foi aplicada de fato) · verificação rodando o comando de verdade e lendo a
saída · suíte inteira verde. Itens de **F1b** somam: uma rodada registrada, com o custo dela.

**Como marcar:** `[x]` e, no fim da linha do título, `— <commit>, <data>`. Item que uma
medição derrubar também vira `[x]`, com **descartado —** e o motivo numa linha. Nada é
apagado: o histórico de por que algo não foi feito vale tanto quanto o que foi — quando a
fila fica longa demais para ler, o item fechado **muda de arquivo**, para
[`todo-done.md`](todo-done.md), com o texto intacto.

**Itens marcados "(dono)"** gastam dinheiro de modelo ou exigem acesso a código de terceiros;
não são tarefas para um agente começar sozinho.

Cada item cabe numa run do próprio Agent Flow: o texto do item, mais o trecho da frente no
roadmap, serve de pedido para `feature --file`.

---

# Onda da bancada de 04/11 — o que a medição dos quatro harnesses deixou

Contexto numa linha: a mesma task do Beahub, o mesmo modelo local, quatro harnesses. O que
separou os resultados não foi o código que cada um produziu — foi o portão que julgou. Os
três primeiros itens saíram dessa medição e estão feitos; os dois últimos são o que ela
mostrou e ainda não foi atacado.

- [x] **B1 · A falha é da task seguinte, e o registro diz isso** — `src/core/review/downstream-work.ts`, `src/core/review/runner-output.ts`, `src/app/task-executor.ts`
      Medido: a TASK-001 do Beahub acrescenta uma chave a `PLAN_FEATURE_FLAG_KEYS` e deixa
      vermelho um spec que a TASK-002 conserta — e que a TASK-002 declara no próprio
      `files.likely`, com `dependencies: ['TASK-001']`. Com a suíte inteira como portão, a
      task era **insatisfazível por construção**: cinco tentativas em dois prompts provaram
      isso e nada mais. `verification.baseline` não alcança o caso, porque a base é verde.
      **O veredito não muda** — o teste ficou vermelho de verdade. O que entra é uma nota na
      tentativa dizendo de quem é o vermelho, para o operador ler "a TASK-002 é dona disto"
      em vez de "o modelo falhou de novo".
      **Pronto quando:** a atribuição é transitiva (A → B → C), o arquivo que a própria task
      declara nunca é atribuído adiante, e uma suíte verde não produz nota.

- [x] **B2 · O `doctor` avisa quando o portão da task é a suíte inteira** — `src/app/diagnostics.ts`
      `validationCommands` existe para julgar a task pelo que ela toca e `commands` para
      julgar a review por tudo. Apontados para a mesma linha, há um portão vestindo dois
      chapéus — e foi o que tornou a TASK-001 impossível. Nota, não degradação: rodar a suíte
      inteira por task é lento e estrito, nunca errado por si.

- [x] **B3 · O `.agent-flow/config.yaml` deixa de travar a run isolada** — `src/app/run-git-identity.ts`
      Corrigir um portão no meio da run não tinha saída: commitar a config movia o HEAD para
      `planning_base_moved`, não commitar ficava em `working_tree_dirty`, e o único caminho
      era `git update-index --skip-worktree`. A config do harness não é produto, e nenhum
      worktree a lê. **Um arquivo, não o diretório:** o que mais o projeto versionar sob
      `.agent-flow/` continua sendo produto.

- [ ] **B4 · O review de plano recusa o fatiamento que separa mudança e consequência** — `prompts/plan-review.md`, `src/app/stages/plan-review.ts`
      O par TASK-001/TASK-002 passou pelo review de plano. A informação para pegá-lo já está
      no plano: uma task cujo `files.likely` contém um arquivo de teste que uma task anterior
      da qual ela depende vai tornar vermelho. O B1 diagnostica depois de gastar uma
      tentativa; isto evita antes.
      **Pronto quando:** um plano com esse par é recusado nomeando as duas tasks, e um plano
      que só compartilha arquivos de produção passa.

- [ ] **B5 · O plano também em Markdown, no repositório** — `src/app/planning-pipeline.ts`
      O Spec Kit versiona `spec.md`, `plan.md`, `tasks.md` e um checklist no repo; o
      Agent Flow tem `sdd.md` e `architecture-impact.md` em Markdown e o plano em
      `plan.json`. Para o regime de conferir depois, Markdown versionado ganha de JSON em
      `.agent-flow/runs/`. Derivado do `plan.json`, nunca uma segunda fonte de verdade.
      **Pronto quando:** o arquivo é gerado do plano aprovado e um teste mostra que ele e o
      JSON não podem divergir.

---
# Onda 1 — barato, já

## F7 — O operador sozinho destrava a run

Pedido completo, com a evidência de cada item, em `~/.agent-flow/requests/operator-gaps.md`
(fora do repositório). Estados antigos em disco continuam legíveis, e runs sem resposta nem
emenda se comportam exatamente como hoje.

**Entregue em `1841fc7` (26/09):** P7.1, P7.4 e P7.5 (run AF-2026-002). Ficaram dois achados
baixos da revisão: a fila do dashboard clássico (`apps/web`) passa a dizer "Answer TASK-NNN" sem
ter formulário de resposta; e as frases `fixSddOrForce` e `readWhatAsked` ficaram sem uso. O P7.3
terá run própria.

- [ ] **P7.3 · `revise` preserva o concluído** — `src/app/run-actions.ts` (revise), scheduler
      Tarefas concluídas mantêm id e estado por padrão; reabrir exige pedido explícito. A tarefa
      BLOCKED cuja decisão entrou no plano novo volta à fila depois do `approve`.
      **Pronto quando:** teste com três concluídas e uma bloqueada: depois de `revise` + `approve`,
      as três continuam concluídas e a quarta roda com o plano novo.

- [ ] **P7.7 · Uma run termina de verdade** — `src/app/run-actions.ts:2451-2464`, `src/core/attention.ts:207-221`, `src/core/run-projection.ts:407-413`
      Hoje o único caminho para `completed` é `review` com a Definição de Pronto inteira
      verde. Run entregue fora do Agent Flow (merge feito à mão, sem `review`), ou cuja revisão
      final deu FAIL e a pessoa aceitou mesmo assim, fica no gate `final_acceptance` **para
      sempre**, marcada "parado, esperando por você" no hub. Medido em 24/09: uma run 7/7 sem
      `review` e uma 8/8 com revisão final FAIL e verificação PASS, as duas já entregues.
      Entregar: `agent-flow close --reason <entregue-fora|aceito-com-achados|abandonado>`
      (e o mesmo no Deck), registrado como emenda (P7.4), levando a run a um estado terminal
      que diz o motivo; o hub separa "concluída" de "encerrada pelo operador".
      **Pronto quando:** as duas situações medidas saem do "esperando por você" com um
      comando, a emenda aparece no estado, e uma run que passou pelo `review` verde continua
      terminando como hoje.

- [ ] **P7.8 · Lista do hub, fila e revisão em andamento concordam** — projeção do hub, `src/core/attention.ts:207-221`
      Dois desencontros medidos em 24/09: (1) durante o `review`, a lista mostrou a run como
      "parado, esperando por você" e o cabeçalho "0 em movimento"; (2) uma run com revisão final
      FAIL aparece como "esperando por você" na lista, mas não gera item na fila "Precisa de
      você" — a pessoa é chamada e não recebe ação nenhuma.
      **Pronto quando:** revisão em andamento conta como "em movimento" (teste), e toda run que a
      lista marca como esperando por alguém tem um item com ação na fila (teste).

## F0 — Legível e visível para quem opera

- [ ] **P0.1 · Runner e modelo na sidebar desde o início da tarefa** — `apps/deck/src/features/run/Inspector.tsx`, projeção da run no servidor
      Hoje a sidebar de uma tarefa em andamento mostra "RUNNER –", "MODELO não registrado",
      "RACIOCÍNIO –", embora o início da tarefa já esteja nos eventos (`task_started` traz o
      papel; `stage_started` traz runner, modelo e raciocínio). Ler dali, não do resultado final.
      **Pronto quando:** uma tarefa em execução mostra runner, modelo e raciocínio no Deck
      (teste do Deck com uma run cujo único evento da tarefa é o de início).

- [ ] **P0.2 · Separar o texto para humano do texto para agente** — `src/contracts/task.schema.ts`, schema das revisões, prompts de planejamento e revisão, Deck
      Cada coisa que o Deck mostra ganha um resumo para gente: tarefa (`summary`: o que muda e por
      que, uma ou duas frases, sem caminho de arquivo); achado de revisão (`headline` curto,
      `impact` — o que quebra para quem —, e `fix`); resumo de revisão idem. O texto técnico
      atual continua, para o agente, e o Deck o põe atrás de "ver detalhes técnicos". Gate
      mecânico no schema: limite de tamanho, sem crase nem caminho no resumo.
      **Pronto quando:** o Deck mostra o resumo por padrão e o detalhe ao expandir; o schema
      recusa um resumo que viola o gate (teste); uma run antiga, sem os campos novos, continua
      mostrando o texto de antes.

- [ ] **P0.3 · Uma regra de escrita compartilhada pelos prompts** — `prompts/`
      Um trecho único, incluído em todo prompt que produz texto que uma pessoa lê: comece pelo
      resultado; uma ideia por frase; resumo sem caminho de arquivo nem jargão do código; diga a
      incerteza em vez de escondê-la; português quando `language` for `pt-BR`. Até a F1b existir,
      a verificação é humana: três runs lidas antes e depois, registradas em `docs/engineering/`.
      **Pronto quando:** o teste de requisitos de prompt prova que todo prompt voltado a humano
      inclui o trecho, e o registro das três runs está escrito.

- [ ] **P0.4 · Passo a passo ao vivo na sidebar** — `src/adapters/runners/claude-code-runner.ts:418`, ponte de eventos do servidor, `apps/deck/src/features/run/`
      Medido no Claude 2.1.280: `--output-format stream-json --verbose` emite ao vivo `tool_use`
      (nome e entrada), `tool_result`, texto intermediário e o `result` final — o mesmo envelope
      de hoje, então o parse final não muda de fonte. O runner repassa cada ação como evento; a
      sidebar lista **verbo e alvo** ("leu `x.ts`", "rodou `npm test`", "editou `y.ts`"),
      **nunca conteúdo** (o Deck pode estar na rede local com pareamento). codex: itens do
      `exec --json`; agy: medir. A mesma trilha persistida é o P1.4.
      **Pronto quando:** numa tarefa real em andamento, a sidebar mostra as últimas ações em até
      poucos segundos; o resultado estruturado final é parseado igual a antes (teste com stream
      real gravado); um segredo plantado numa entrada de ferramenta não aparece no Deck nem em
      disco.

- [ ] **P0.6 · Ver o navegador do e2e ao vivo** — `prompts/e2e.md:54-87`, estágio e2e, Deck
      O `agent-browser` tem um dashboard local (`agent-browser dashboard start`, porta 4848) que
      mostra o viewport ao vivo e o feed de comandos de **todas** as sessões. Hoje o Deck não
      sabe qual é a sessão, porque o prompt manda o modelo escolher um nome. Passa a ser
      determinístico:
      1. o Agent Flow escolhe a sessão (`af-<run>-e2e`) e a injeta como `AGENT_BROWSER_SESSION`
         no ambiente do runner — medir se chega aos comandos que o Claude roda (Bash e
         PowerShell); o prompt continua pedindo `--session` como segunda linha;
      2. antes do estágio, sobe o dashboard (idempotente) e grava um evento com sessão e URL;
      3. o card e a sidebar do estágio e2e mostram "Ver navegador ao vivo", abrindo o dashboard
         numa aba nova — iframe no Deck provavelmente é recusado, porque o dashboard rejeita
         origem cruzada; medir antes de tentar;
      4. cada cenário grava vídeo (`agent-browser record start <arquivo>.webm --contact-sheet`)
         como artefato da run, que o Deck mostra depois e a revisão final pode citar.
      O dashboard só escuta em loopback: num dispositivo pareado, o botão diz "só nesta
      máquina". Expor pela rede exige origem HTTPS explícita e não é padrão. O executor precisa
      de `Bash(agent-browser:*)` e `PowerShell(agent-browser:*)` liberados.
      **Pronto quando:** durante um e2e real, o botão abre o dashboard já na sessão da run; o
      vídeo de cada cenário aparece nos artefatos; sem `agent-browser` instalado, o estágio diz
      isso em claro em vez de mostrar um botão morto.

## F1a — Trajetória e resultado em uso real

- [ ] **P1.1 · Confirmar o que o envelope de cada CLI entrega** — `src/adapters/runners/claude-code-runner.ts:418`, `agy-runner.ts:318`, `codex-runner.ts`
      A documentação do Claude promete, no `--output-format json`, `num_turns`,
      `permission_denials`, `duration_api_ms` e `modelUsage`. O `codex exec --json` emite
      eventos (`turn.completed` com `usage`, `item.*` para comando, arquivo e chamada de MCP),
      sem contador de negações documentado. O agy manda `num_turns`. Confirmar cada um rodando
      o CLI com **os mesmos args** que o Agent Flow usa, numa tarefa que chame ferramentas e
      provoque ao menos uma negação.
      **Pronto quando:** a tabela está em [`runner-capabilities.md`](runner-capabilities.md)
      com a versão de cada CLI, e há uma decisão escrita: o envelope basta, ou P1.4 é necessário.

- [ ] **P1.3 · Resultado em uso real por run** — `src/core/outcomes.ts` (novo, puro), `src/cli/`
      Gravar na criação da run o commit do Agent Flow e um hash da configuração efetiva, se
      ainda não é gravado. Um comando `agent-flow outcomes [--since <data>]` lista, por run:
      a saída virou merge (sim, não, pendente)? quantas linhas a pessoa mudou nos arquivos da
      run até o merge? quantos achados de revisão foram descartados? quantas revisões e
      retries? quanto custou? Merge por **squash** muda os hashes: a detecção compara conteúdo
      (patch-id ou conteúdo dos arquivos), não ancestralidade. Antes de contar descartes,
      medir onde a decisão do operador sobre cada achado já aparece (`revise`, `approve` com
      achado aberto, `--force`); se não aparece, registrar.
      **Pronto quando:** testes com um repo fixture cobrem merge normal, merge por squash e run
      abandonada; o retrabalho é contado só nos arquivos da run; o comando imprime a tabela e
      a agregação por commit do Agent Flow.

- [ ] **P1.4 · Trilha por tool call** (não é mais condicional: é a mesma trilha do P0.4, persistida) — `claude-code-runner.ts:418`
      `stream-json` gravando `logs/<nome>.trajectory.jsonl`, com o caminho declarado em
      `src/app/paths.ts` (regra *"a path has one spelling"*, `test/architecture.test.ts:2127`).
      Argumentos passam pela redação de evidência que já existe. Antes de inventar formato,
      olhar o log do inspect_ai (deduplicado e compactado) e o histórico linear do
      mini-swe-agent.
      **Pronto quando:** o resultado estruturado final é parseado exatamente como antes
      (teste com um envelope real gravado); a trilha lista ferramenta, status e duração; um
      segredo plantado num argumento não aparece no arquivo.

## F3a — Teto de gasto

- [ ] **P3.1 · Teto de gasto por run, que pausa** — `src/core/telemetry.ts:136-177`, `src/contracts/state.schema.ts:601-616`
      **Opt-in, desligado por padrão** (decisão de 24/09: quem usa assinatura não quer travar
      por custo; sem teto, nada de aviso, flag ou degradação). Visível e editável no Deck — tela
      Equipe com o estado "desligado" escrito, e a run mostrando "Teto: desligado" ou o gasto
      contra o teto. `limits.maxCostUsd` e `limits.maxTokens` (global, sobrescrevível pelo
      projeto e por `feature --max-cost`). Checado ao fim de cada estágio e de cada tarefa; se cruzou,
      `run_paused` com motivo `budget` e entrada na fila "Precisa de você". Com
      `pricedAny: false`, o teto em USD é declarado **inaplicável** no início da run.
      **Pronto quando:** um runner roteirizado que reporta custo cruza o teto e a run pausa
      antes da tarefa seguinte; `resume` com teto maior continua; um runner sem custo gera o
      aviso.
      **Tentado e adiado (24/09, run AF-2026-001):** duas revisões de plano reprovaram, sempre
      na máquina de estados do teto. Achados que o próximo desenho tem de evitar por construção:
      um teto por run (`--max-cost`) vencia a config para sempre, então subir o valor no Deck
      não destravava a pausa; nada limpava o "atingido" depois de uma re-entrada em
      planejamento ou revisão; uma revisão de tarefa parada pelo teto virava "revisor sem saída
      válida" na trilha; e dividir o saldo pela onda criava pausa sem teto atingido. Desenho para
      a próxima tentativa: **só config** (editável no Deck), sem override por run, qualquer
      re-entrada limpa o "atingido", sem fatia por onda.

- [ ] **P3.2 · `--max-budget-usd` como segunda linha** — `claude-code-runner.ts:417-429`, `src/contracts/common.schema.ts:120-152`
      Quando há teto, cada invocação do Claude recebe `--max-budget-usd` com o saldo restante
      da run. Só a partir do Claude 2.1.217, decidido pela costura de capacidades
      (`test/architecture.test.ts:3511`). O CLI **encerra** ao estourar (*"Budget limit
      reached"*): isso vira a classe de falha `budget_exhausted`, dentro do vocabulário único
      (`test/architecture.test.ts:3151`), e pausa a run em vez de gastar tentativa.
      **Pronto quando:** teste de argv; uma saída real de estouro gravada é classificada como
      `budget_exhausted` e não é retentada como falha de runner.

## F4a — Sandbox nativo dos CLIs

- [ ] **P4.1 · Medir o sandbox do codex no Windows, no modo do Agent Flow** — `src/adapters/runners/codex-runner.ts:174-217`
      Com `-s workspace-write` e `--ignore-user-config`, como o Agent Flow invoca: escrever
      fora do worktree e acessar a rede — o que acontece? Depois, repetir passando o modo de
      sandbox do Windows por `-c` (a chave `[windows] sandbox` do `config.toml` não é lida com
      `--ignore-user-config`; confirmar o nome exato na referência de configuração).
      **Pronto quando:** o resultado, com a versão do codex, está em
      [`runner-capabilities.md`](runner-capabilities.md), com a decisão de qual modo usar.

- [ ] **P4.2 · Medir o sandbox do Claude por `--settings`** — `claude-code-runner.ts:394-415`
      No Linux, no macOS e no WSL2: `--settings '{"sandbox":{...}}'` junto com
      `--setting-sources ''`. Escrever fora do worktree, acessar um domínio fora da allowlist,
      e confirmar que os comandos liberados (`npm test`, por exemplo) continuam funcionando.
      No Windows nativo não há sandbox do Claude: registrar isso, não contornar.
      **Pronto quando:** números e decisão em `runner-capabilities.md`.

- [ ] **P4.3 · Medir o `srt` com a toolchain real** — `src/ports/process-runner.ts:125-127`
      [`anthropics/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime) embrulhando
      um comando de validação real (`npm test` num worktree) no Windows nativo (alfa) e no
      Linux. Esperado no Windows: falhar com Node instalado por usuário (nvm), que a conta do
      sandbox não alcança — medir, e medir com Node instalado para a máquina.
      **Pronto quando:** o resultado e a decisão estão em `docs/engineering/`.

- [ ] **P4.3b · Medir o ai-jail nas máquinas Linux e macOS**
      [`akitaonrails/ai-jail`](https://github.com/akitaonrails/ai-jail) (GPL-3.0: invocar como
      binário externo, nunca copiar código) embrulhando um runner e um comando de validação num
      worktree: home privada, sem credencial do agente por padrão, rede desligada ou por
      `--allow-host`. Não roda no Windows (só no WSL2).
      **Pronto quando:** o resultado e a decisão estão em `docs/engineering/`, comparados com o
      P4.2 e o P4.3.

- [ ] **P4.4 · Ligar o sandbox que a medição aprovar** (depende de P4.1–P4.3b)
      Um `execution.sandbox` por runner (`none` | `native`), aplicado às invocações do runner
      **e** aos comandos de validação que o próprio Agent Flow roda, pela mesma porta
      `ProcessRunner`. O `doctor` diz o sandbox **efetivamente** aplicado por runner e
      plataforma — nunca anuncia sandbox onde ele não existe.
      **Pronto quando:** numa plataforma suportada, uma escrita fora do worktree numa run real
      falha e é classificada; numa plataforma sem suporte, o `doctor` diz "sem sandbox" em
      claro (teste).

---

# Onda 2

## F1b — Corpus e evals offline

- [ ] **P1.5 · Contrato do caso de eval** — `src/contracts/eval.schema.ts` (novo)
      Copiar a estrutura do Harbor (instrução, config, ambiente, solução de referência,
      testes) e a divisão do SWE-bench: `failToPass` (checagens que têm de virar) e
      `passToPass` (checagens que não podem quebrar). Campos: `id`, `repo`, `baseRef`,
      `request`, `failToPass`, `passToPass`, `reference` (ref do fix mergeado), `limits`
      (custo máximo, caminhos proibidos), `expectedWorkflow` (opcional), `set`
      (`regression` | `capability`). A raiz das suítes é configurável (padrão
      `~/.agent-flow/evals/`), **fora** do repositório.
      **Pronto quando:** o schema tem testes de aceitação e recusa, e existe um fixture
      sintético (repo mínimo + dois casos) em `test/fixtures/eval/`.

- [ ] **P1.6 · Executor `agent-flow eval run <suite> [--repeat N]`** — `src/cli/`, `src/app/eval/` (novos)
      Para cada caso × N: clone descartável em `baseRef` → `createFeatureRun` →
      `planFeature` → `approve` → `start` → `review` (`src/app/run-actions.ts:1929,1987,635,1086,2167`)
      → checagens no ref final → registro em
      `<evalHome>/results/<suite>/<timestamp>/<caso>-<n>.json`. Cada repetição tem **id
      próprio** (o SWE-bench reaproveita resultado por `run_id`); cada registro carrega o commit
      do Agent Flow, a configuração e o modelo por papel, como o benchmark do Aider.
      A aprovação automática é o **único** bypass de gate do produto: só existe dentro de
      `eval`, é registrada com um ator próprio (`RunActor` ganha `{ kind: 'eval' }`,
      `src/contracts/state.schema.ts:646-654`), e `feature`/`approve` recusam esse ator.
      **Pronto quando:** o CI roda a suíte sintética contra runner roteirizado e produz os
      registros; um teste prova que `approve` fora de `eval` recusa o ator `eval`; os testes de
      arquitetura seguem verdes, em especial *"a review proposes and a gate decides"*
      (`test/architecture.test.ts:4046`).

- [ ] **P1.7 · Métricas por caso** — `src/core/eval/metrics.ts` (novo, puro)
      **Portão:** `failToPass` virou, `passToPass` continua verde, nenhuma ação proibida
      (caminho fora do escopo, comando negado tentado repetidamente). **Diagnóstico, nunca
      portão:** histograma de `failureClass` (`src/contracts/common.schema.ts:120-152`),
      rounds de reparo, negações, turnos, veredito da revisão final, classe de workflow
      atribuída vs esperada, custo, duração, chamadas de planejamento.
      **Pronto quando:** função pura com testes sobre runs gravadas; métrica sem dado sai
      como "não medido", não como zero.

- [ ] **P1.8 · `agent-flow eval compare <a> <b>`** — `src/cli/`, `src/core/eval/`
      Por caso: **pass@k** e **pass^k**, custo mediano, duração mediana; depois o agregado,
      separado entre regressão e capacidade. Qualquer limiar de "inconclusivo" aparece no
      relatório como heurística nossa, não como teste estatístico. Os casos que divergiram
      entre `a` e `b` vêm com o caminho das transcrições, para serem lidas.
      **Pronto quando:** teste com dois resultados sintéticos cobrindo melhora, piora e
      divergência.

- [ ] **P1.9 · Corpus inicial** (dono) — fora do repositório
      Começar com 10 a 15 tarefas reais já resolvidas e mirar 20 a 50. Pelo menos: uma de cada
      classe (trivial, simple, standard, high-risk); uma com base vermelha (o caso do D-12);
      uma que já produziu planos divergentes (o caso do D-6); uma com port para outra branch.
      Um caso que falha em todas as versões provavelmente está quebrado, não o agente.
      **Pronto quando:** cada caso tem `failToPass` que **falha** na base e **passa** no fix de
      referência, e `passToPass` verde nos dois — o controle positivo do próprio caso.

- [ ] **P1.10 · Baseline** (dono) — custa dinheiro
      `eval run --repeat 3` na versão atual, com o custo total anotado.
      **Pronto quando:** o resultado está arquivado na raiz de evals e resumido em
      `docs/engineering/`, sem nomes de projeto.

- [ ] **P1.11 · Regra de regressão** — definição de pronto, no topo deste arquivo
      Mudança em `prompts/`, `src/core/adaptive-workflow.ts` ou `src/app/planning-pipeline.ts`
      anexa um `eval compare` contra a baseline. Para iterar o corpus, o ciclo
      *sample-tune-sweep*. Primeiros usos: medir de novo o `--grounded` com N=3 e julgar o
      P2.6 (EARS).
      **Pronto quando:** a definição de pronto foi atualizada e o `--grounded` tem um número
      com N=3.

## F3b — MCP por ferramenta e por estágio

- [ ] **P3.4 · MCP por ferramenta, pelos mecanismos nativos** — `src/contracts/config.schema.ts:109-126`, `claude-code-runner.ts:410-412`, `codex-runner.ts`
      `servers` aceita `"nome"` (como hoje) ou `{ name, allow?: [tool], deny?: [tool] }`. No
      Claude: `--allowedTools mcp__<name>__<tool>` e `--disallowedTools`, com o
      `--strict-mcp-config` continuando **depois** da lista variádica, como terminador. No
      codex, que hoje não recebe MCP nenhum: `-c mcp_servers.<id>...` com
      `enabled_tools`/`disabled_tools`. Sem gateway.
      **Pronto quando:** testes de argv nos dois runners; uma probe real com servidor-stub de
      duas ferramentas mostra só a permitida respondendo; o `doctor` avisa quando um servidor
      é concedido inteiro.

- [ ] **P3.5 · MCP por estágio** — `StageOverrideSchema`, `src/contracts/config.schema.ts:149-181`
      `mcp?` no override de estágio, para um estágio só-leitura de investigação ter o MCP de
      consulta sem que a implementação o receba.
      **Pronto quando:** um teste prova que a invocação de implementação não recebe o
      servidor que a de impacto recebe.

- [ ] **P3.6 · Recusar MCP declarado que o runner não aplica** — `src/app/diagnostics.ts`, preflight
      Papel ou estágio com MCP declarado, resolvido para um runner que não aplica a
      declaração (o agy até P3.3 dizer o contrário; o `openai-compatible`) → `doctor` e
      preflight recusam, nomeando o papel e o runner.
      **Pronto quando:** há teste, e o controle positivo (remover a checagem) o deixa vermelho.

- [ ] **P3.7 · Regra da trifeta no preflight** (depende de P2.4) — `src/app/diagnostics.ts`, preflight
      Em run com origem externa (work item), nenhum estágio pode ter ao mesmo tempo um MCP de
      dado privado e uma ferramenta com saída de rede (`WebFetch`, `WebSearch`, `curl`
      liberado). Anotações `readOnlyHint` só contam para servidores declarados como confiáveis.
      **Pronto quando:** a combinação proibida é recusada com mensagem que diz qual perna
      remover (teste), e uma run sem origem externa não muda.

---

# Onda 3

## F2 — Entrada por work item, identidade e critério testável

- [ ] **P2.1 · Porta `WorkItemSource`** — `src/ports/work-item-source.ts` (novo)
      Só leitura: `getWorkItem(id)` → título, descrição, critério de aceite, links, nomes de
      anexos, url. **Separada** do `ForgeProvider` de entrega (`src/ports/forge.ts:51-99`).
      **Pronto quando:** porta e fake existem; o teste *"the forge is a destination, never an
      authority"* (`test/architecture.test.ts:4788`) segue verde e ganha um caso: nada em
      `src/app/` cria run a partir de `WorkItemSource`.

- [ ] **P2.2 · Adaptador Azure Boards** — `src/adapters/work-items/azure-boards.ts` (novo)
      REST do Azure DevOps. Credencial pelo mesmo caminho do forge GitHub do M7, nunca
      gravada em state nem em events. Descrição em HTML convertida para texto.
      **Pronto quando:** testes com respostas gravadas (sem rede) passam, e um work item real
      foi lido de verdade.

- [ ] **P2.3 · `agent-flow intake <id> --out <arquivo>`** — `src/cli/`
      Escreve um rascunho de pedido com as seções: sintoma, evidência, critério de aceite, o
      que não pode mudar, baseline, branches de port, clientes antigos/plataformas. Seção que
      o item não trouxe vem marcada `PREENCHER`. O texto do work item entra **delimitado, como
      dado citado**: é conteúdo externo.
      **Pronto quando:** o comando gera o arquivo e **não** cria run; `feature --file` aceita o
      arquivo; um item sem critério de aceite produz o `PREENCHER` (teste).

- [ ] **P2.4 · Origem gravada na run** — `src/app/planning-pipeline.ts:282`, `src/contracts/state.schema.ts`
      `feature` aceita a origem (`--source work-item:<provider>:<id>`, ou um cabeçalho do
      rascunho); o state guarda `{ provider, id, url }`; a revisão final e a entrega citam.
      **Pronto quando:** `status` e Deck mostram a origem, e uma run sem origem se comporta
      como antes.

- [ ] **P2.5 · Aprovação com a identidade que já existe** — `src/app/run-actions.ts:284-291,748`, `src/contracts/state.schema.ts:646-654`
      O ator `keyboard` ganha `name?` e `email?`, lidos de `git config user.name` e
      `user.email` pelo `GitClient` (o único módulo que roda git,
      `test/architecture.test.ts:1135`; o I-7 proíbe escrever na configuração, não ler), com
      `config.operator.name` como sobrescrita. Dispositivo pareado continua com `label`.
      **Pronto quando:** o `operator_action` de approve carrega o nome; o Deck mostra "aprovado
      por"; um state antigo, sem nome, é lido sem erro.

- [ ] **P2.6 · Critério de aceite em EARS no SDD** — `prompts/sdd.md`
      Cada requisito funcional ganha critérios no formato `WHEN <evento> THE SYSTEM SHALL
      <comportamento>`, sem traduzir os `FR-NNN`. É mudança de prompt: entra pela regra do
      P1.11.
      **Pronto quando:** o teste de requisitos de prompt cobre a instrução, e um `eval compare`
      anexado não mostra regressão.

- [ ] **P2.7 · Entrega no Azure Repos** (depois, e só se o time pedir)
      O `ForgeProvider` deixa de ser GitHub-literal (`src/ports/forge.ts:52`) e ganha uma
      fábrica no lugar de `src/app/forge-actions.ts:108`.

## F6 — Memória entre runs (depende da F3b)

- [ ] **P6.1 · Medir o ai-memory neste ambiente**
      [`akitaonrails/ai-memory`](https://github.com/akitaonrails/ai-memory) (MIT): servidor no
      WSL2 ou em Docker (o Windows nativo é experimental), API HTTP e MCP, e o que ele guarda de
      uma sessão. Confirmar que os hooks instalados no Claude Code **não** disparam dentro das
      runs do Agent Flow (`--setting-sources ''`, `--safe-mode`) — é o que obriga a integração
      explícita.
      **Pronto quando:** as medições e a decisão estão em `docs/engineering/`.

- [ ] **P6.2 · Página de fim de run, determinística** — `src/app/` (novo), porta de memória em `src/ports/`
      Ao fim de cada run, o Agent Flow grava uma página sem chamar LLM: o que foi pedido, a
      origem, as classes de falha e o porquê, quais achados de revisão foram acatados ou
      descartados, os comandos que não existiam, os testes instáveis. Atrás de uma porta, com o
      ai-memory como primeiro adaptador; desligado por padrão.
      **Pronto quando:** uma run fixture produz a página esperada (teste), e desligado nada é
      gravado nem chamado.

- [ ] **P6.3 · Planejamento lê um resumo limitado** (depende de P3.4 e P3.5)
      Os estágios de planejamento recebem o MCP da memória com **só as ferramentas de leitura**,
      e o resumo entra como fonte própria no orçamento de prompt (`src/core/prompt-budget.ts`).
      **Pronto quando:** um teste prova que a implementação não recebe o servidor e que o
      planejamento não recebe as ferramentas de escrita.

- [ ] **P6.4 · Medir o efeito** (dono) — pela F1b
      `eval compare` do mesmo corpus com e sem o resumo de memória. Sem ganho medido, a memória
      fica desligada.
      **Pronto quando:** o comparativo está registrado.

---

# Condicional

## F4b — Container (só quando F5 for aprovada)

- [ ] **P4.5 · Medir container no Windows e no Linux**
      Latência por invocação; autenticação dos CLIs dentro do container (montar credencial é
      privilégio — medir o mínimo necessário); rede desligada vs allowlist; comparação com o
      sandbox nativo de P4.4.
      **Pronto quando:** os números e a decisão estão em `docs/engineering/`.

- [ ] **P4.6 · `ContainerProcessRunner`** — `src/ports/process-runner.ts:125-127`
      Adaptador da porta `ProcessRunner`: worktree montado, env pela mesma allowlist, rede
      desligada por padrão. A regra de spawn único (`test/architecture.test.ts:1233,5029-5056`)
      é **estendida de propósito**, não contornada.
      **Pronto quando:** uma tarefa roda dentro do container com os mesmos gates, e uma
      tentativa de acesso à rede falha e é classificada.

---

# Avulsos

- [ ] **N3 · Paralelismo visível e medido** — `src/contracts/config.schema.ts:240-253,383-400`, `src/core/concurrency.ts`, Deck
      Hoje `git.useWorktrees: false` e `parallelism.maxTasks: 1` por padrão: tarefas prontas
      esperam na fila. Mostrar no Deck o modo da run ("sequencial" ou "paralelo: N ao mesmo
      tempo"), com o custo dito (um worktree e um install por tarefa). Depois, uma run medida:
      a mesma run nos dois modos, comparando tempo total e conflitos na integração.
      **Pronto quando:** o Deck mostra o modo e o limite da run, e a medição está em
      `docs/engineering/` com a decisão sobre o padrão.

- [ ] **N5 · Pendências das revisões da run dos avulsos (`72bda11`)**
      Achados que a revisão do plano e a revisão final deixaram abertos, nenhum bloqueante:
      1. **[médio]** Duas decisões da composição sem teste: `readOnlyCopy` só com
         `worktree.copyToReadOnly: true` e `copy` não vazio, e `isIgnoredDirectory` passado ao
         `ChangeReviewAdapter`. Nenhum teste via `buildExecutionContext` pega a remoção de qualquer
         uma das duas.
      2. **[médio]** No modo sequencial o revisor lê as regras aninhadas de `projectDir`, a árvore
         que a tarefa acabou de editar: "a tarefa não escreve as regras do próprio revisor" só vale
         em modo worktree. Documentar o limite ou ler do commit base.
      3. **[médio]** A prova de "prompt byte a byte igual" compara dois caminhos que passam pelo
         código novo; falta uma renderização capturada do `master` anterior.
      4. **[baixo]** Cópia recusada (a checagem de ignorado falhou) deixa o arquivo não ignorado no
         worktree retido: remover a cópia na recusa.
      5. **[baixo]** `trust.projectConfig` aceita caminho relativo e o descarta calado: o schema
         deveria recusar, ou o `doctor` nomear o que pulou.
      6. **[baixo]** Duplicações: `MAX_INSTRUCTIONS_BYTES`/`bounded()` copiam o limite do
         `readAgentsMd`; `resolveQuietly` e `isRecord` repetidos em três arquivos.
      **Pronto quando:** cada item tem teste (ou decisão escrita) e controle positivo.

---

# Herdados da fila anterior

A fila de 04/09 (legibilidade, modelo local e precisão de contrato) fechou 62 itens e saiu do
repositório; o histórico dela está no git. Dois itens ficaram abertos e valem até hoje.

- [ ] **`agent-flow retry-stage <stage>`** — candidato, não decidido.
      Simétrico ao `retry <taskId>` que já existe: hoje uma tarefa se repete e um stage de
      planejamento não, embora o núcleo saiba fazer as duas. Não entrou porque `--from` já
      resolve o caso que doía, e um segundo comando para a mesma coisa precisa de motivo
      melhor que simetria.
- [ ] **Não está no npm, e o uso diário é um checkout** — `package.json`
      Sem pacote publicado e sem release: instalar é clonar e `npm run build` a cada
      `git pull`. O item é decidir entre publicar e documentar o checkout como o caminho
      suportado.
      **Pronto quando:** existe `npm i -g agent-flow`, ou uma seção de instalação que não
      pressupõe o checkout de desenvolvimento.

---

# F5 — Fora de escopo

Nenhum item. (A memória entre runs saiu daqui: é a F6, na onda 3.) Gatilho automático,
planejamento disparado pelo tracker, loop até produção,
agente de limpeza recorrente, A2A com autoridade e RBAC só entram nesta fila quando a
condição de reabertura do [`roadmap.md`](roadmap.md) for cumprida.
