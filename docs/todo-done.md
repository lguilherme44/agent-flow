# Concluído

O que saiu da fila do [`todo.md`](todo.md), com o texto exato que estava lá: o pedido, o
critério de pronto e o que a implementação de fato encontrou.

**Nada é apagado** — a regra do `todo.md` vale aqui. Um item que uma medição derrubou é tão
útil quanto um entregue: é o registro de por que não se tenta de novo.

---

<!-- F7 — O operador sozinho destrava a run -->
- [x] **P7.1 · Responder uma tarefa BLOCKED** — `1841fc7`, 26/09 — `src/app/run-actions.ts:915`, `src/core/phrases/en.ts:440`
      `agent-flow answer <task> "<texto>" | --file <arquivo>` e o mesmo no Deck. A resposta fica
      na tarefa, entra no prompt do próximo attempt, e a tarefa respondida volta à fila **sem
      `--force`**. A frase que hoje manda "responder" passa a nomear o comando que existe.
      **Pronto quando:** uma tarefa bloqueada é respondida e reexecutada sem `revise` nem
      `--force`, e o prompt do attempt seguinte contém a resposta (teste).

<!-- F7 — O operador sozinho destrava a run -->
- [x] **P7.2 · O executor roda os comandos declarados** — `0eab98d`, 26/09 — `src/adapters/runners/claude-code-runner.ts:146-231`, prompts de planejamento
      Os comandos de `commands`/`validationCommands` viram regras de `--allowedTools`
      automaticamente, nos dois shells no Windows, sem abrir nada além do declarado. O
      planejador e o revisor recebem a lista do que o executor pode rodar; medição que ele não
      pode fazer vira **verificação do operador**, não tarefa.
      **Pronto quando:** teste de argv com e sem regras manuais (sem duplicar); um plano que pede
      ao executor um comando não declarado é recusado pela checagem ou convertido em verificação.

<!-- F7 — O operador sozinho destrava a run -->
- [x] **P7.4 · Decisões do operador como emendas registradas** — `1841fc7`, 26/09 — `src/contracts/state.schema.ts`, artefato ao lado do SDD
      Resposta a BLOCKED, `revise` e aprovação por cima de achado viram emendas: quem (identidade
      do P2.5), quando, sobre qual tarefa ou achado, e o texto. Visíveis no Deck; lidas pela
      revisão final.
      **Pronto quando:** cada um dos três tipos gera uma emenda (teste), e o prompt da revisão
      final as inclui.

<!-- F7 — O operador sozinho destrava a run -->
- [x] **P7.5 · O orçamento separa replanejamento de decisão** — `1841fc7`, 26/09 — `src/app/run-actions.ts:1772`, `src/core/adaptive-workflow.ts:99-134`
      Resposta a BLOCKED e ajuste pedido pelo operador não gastam ciclo de revisão por qualidade.
      No teto, dois caminhos explícitos e registrados: elevar a classe, ou aprovar **anexando os
      achados abertos às tarefas afetadas** (que chegam aos executores).
      **Pronto quando:** teste do teto nos dois caminhos; os achados anexados aparecem no prompt
      das tarefas afetadas.

<!-- F7 — O operador sozinho destrava a run -->
- [x] **P7.6 · Classificação sem palavra solta** — `0eab98d`, 26/09 — `src/core/adaptive-workflow.ts:30-64,143`
      Menção negada ou incidental não eleva a classe; o motivo mostra o trecho que pesou; o
      operador corrige a classe (para cima ou para baixo) pela CLI e pelo Deck, e a correção fica
      registrada.
      **Pronto quando:** "não trafega token nem dado de sessão" não vira HIGH-RISK (teste), um
      pedido de migration de verdade continua virando, e a correção manual aparece no estado.

<!-- F7 — O operador sozinho destrava a run -->
- [x] **P7.9 · "Completo" não sai com gate exigido sem rodar** — `0eab98d`, 26/09 — `src/core/definition-of-done.ts:55-80`, `src/app/read-only-workspace.ts:24-31`, `src/app/run-actions.ts:2451-2464`
      Na AF-2026-001 o SDD exigia `typecheck:deck` e `test:deck` (NFR-005/NFR-007) e a run saiu
      "FEATURE COMPLETE" sem eles terem rodado em lugar nenhum: a verificação mecânica só roda o
      que está em `commands`, e os revisores trabalham num checkout descartável que **não leva
      `node_modules`** por desenho — leram o código e registraram "não pude rodar" como achado
      baixo. Três correções:
      1. a Definição de Pronto conhece os gates que o SDD exige; gate exigido e não executado é
         `NOT_RUN`, e `NOT_RUN` não é pronto;
      2. "não pude rodar X" num revisor vira achado **bloqueante** quando X é exigido, não baixo;
      3. o planejador só pode exigir gates que existem como nome de validação (liga com A-05), e
         a ausência é recusada na checagem do plano, antes do gate humano.
      **Pronto quando:** uma run fixture cujo SDD exige um gate não declarado não termina como
      completa (teste), e a mensagem diz qual gate faltou e como declará-lo.

<!-- F0 — Legível e visível para quem opera -->
- [x] **P0.5 · Medir se o raciocínio pode ser exposto** — 992608e, 24/09
      **Resultado:** não pode, no Claude 2.1.281 headless — `thinking` vazio com Sonnet 5 e Opus 5.5,
      inclusive em `--include-partial-messages`; nenhuma configuração mudou isso. O P0.4 mostra
      ações e o texto que o modelo escreve (ao vivo com `text_delta`), não o raciocínio.
      No stream do Claude o bloco `thinking` veio vazio (só assinatura), medido uma vez com o
      Sonnet 5. Repetir com o Opus e procurar uma configuração que exponha resumos de raciocínio
      no modo headless; o codex entrega resumos no `exec --json`.
      **Pronto quando:** o resultado, com versões e modelos, está em
      [`runner-capabilities.md`](runner-capabilities.md), e o P0.4 mostra o raciocínio onde ele
      existir.

<!-- F1a — Trajetória e resultado em uso real -->
- [x] **P1.2 · Ler turnos e negações que hoje são descartados** — `claude-code-runner.ts:36-45`, `src/ports/agent-runner.ts:96-112`, `agy-runner.ts:329-341` — e110140, 24/09
      Feito pela run AF-2026-001 do próprio Agent Flow, com a remoção do `tool_input` dos textos
      brutos de falha (SEC-002) e a aba Telemetria do Deck (field report de 24/09, no
      histórico do git).
      Declarar `num_turns` e `permission_denials` no tipo do envelope do Claude; campos
      opcionais `turns` e `permissionDenials` (contagem e nomes de ferramenta) em
      `AgentRunUsage`; o `num_turns` do agy deixa de cair; no codex, contar `turn.completed` se
      o runner usar `--json`. Dado ausente é `undefined`, **nunca `0`**.
      **Pronto quando:** `tasks/<id>/result.json` e `stage_completed` carregam os campos; a
      projeção (`src/app/telemetry.ts:58`) os expõe; um runner que não reporta aparece como
      "não reportado" no `status` e no Deck.

<!-- F3b — MCP por ferramenta e por estágio -->
- [x] **P3.3 · Medir o MCP global do agy** — 992608e, 24/09
      **Resultado:** carrega. Um MCP-marcador registrado com `agy mcp add` apareceu no modo
      só-leitura exato do adapter e o modelo tentou chamá-lo; só não rodou porque o headless não
      pede permissão — com `dangerouslySkipPermissions` rodaria. O P3.6 passa a recusar MCP
      declarado em papel servido pelo agy **e** a avisar que o agy herda os MCPs globais. — `src/adapters/runners/agy-runner.ts`
      O codex já está resolvido: roda com `--ignore-user-config` (`codex-runner.ts:174-198`).
      Falta o agy: com um MCP-marcador na configuração global, rodar no modo exato em que o
      Agent Flow invoca e ver se o modelo enxerga a ferramenta. Não há documentação pública —
      só medição.
      **Pronto quando:** o resultado, com versão, está em
      [`runner-capabilities.md`](runner-capabilities.md); se carrega, o item de isolamento
      foi aberto aqui.

<!-- Avulsos -->
- [x] **N1 · Medir se regras por diretório chegam ao executor** — 72bda11, 25/09
      **Medido em 24/09 (Claude 2.1.281): não chegam.** Com `sub/CLAUDE.md` mandando terminar a
      resposta com uma palavra-marcador, a leitura de `sub/data.txt` obedeceu sem flags (controle) e
      **ignorou** com `--setting-sources '' --safe-mode`, as flags do adapter. Falta a injeção. — `src/app/project-instructions.ts:33-72`, `claude-code-runner.ts:394-395`
      Num repo fixture com `sub/AGENTS.md` e `sub/CLAUDE.md` contendo uma instrução-marcador,
      rodar o estágio de implementação sobre um arquivo em `sub/` com os args exatos
      (`--setting-sources ''`). Se o marcador não chega: injetar as instruções aninhadas dos
      diretórios em `files.likely` da tarefa, como fonte própria no orçamento de prompt
      (`src/core/prompt-budget.ts`).
      **Pronto quando:** a medição está registrada; se implementado, um teste mostra as
      instruções aninhadas no prompt de uma tarefa que toca o diretório, e ausentes numa que
      não toca.
      **Feito.** Lido no código antes: implementação (`TaskExecutor.readAgentsMd`) e code review
      (`ChangeReviewAdapter.agentsMd`) liam só o `AGENTS.md` da raiz; nenhum leitor via
      `<dir>/AGENTS.md` ou `<dir>/CLAUDE.md`. Agora os dois prompts recebem um bloco
      `## Directory instructions`, um `### <dir>/<arquivo>` por diretório ancestral das entradas de
      `files.likely` (da raiz para baixo, a raiz nunca), anexado depois do template e medido como a
      fonte `directoryInstructions`. Mesma regra da raiz (AGENTS.md, senão CLAUDE.md), 64 KiB por
      arquivo, sem seguir symlink para fora da árvore, diretório ignorado pulado
      (`git check-ignore --no-index`), e diretório ilegível pulado com aviso em
      `stage_context_measured.detail.directoryInstructionsSkipped` — o leitor nunca lança. O code
      review lê de `projectDir`, nunca da árvore revisada: uma tarefa não escreve as regras do
      próprio revisor. Sem arquivo aninhado, os dois prompts são byte a byte os de antes.

<!-- Avulsos -->
- [x] **N2 · Lista explícita de arquivos ignorados copiados para o worktree** — `src/app/task-workspaces.ts:128-208` — 72bda11, 25/09
      `worktree.copy: [globs]`, vazio por padrão, aplicado logo depois do `git worktree add`.
      O `doctor` avisa quando um padrão casa com `.env*`: o que é copiado fica legível pelo
      modelo. O checkout descartável só-leitura só recebe o que também estiver declarado para
      ele.
      **Pronto quando:** teste com um arquivo ignorado declarado (aparece no worktree, nunca
      entra em commit) e outro não declarado (não aparece).
      **Feito.** Lido no código antes: `prepareIsolated` fazia `git worktree add` e seguia direto
      para `prepareWorkspace`; nada copiava arquivo ignorado. Agora `worktree.copy` (global,
      sobrescrevível pelo projeto, lista substituída inteira) usa a semântica de pathspec
      `:(glob)` do Git: uma listagem `ls-files --others --ignored --exclude-standard` no checkout
      do operador, cópia byte a byte, e a tentativa é recusada (`phase: 'checkout'`, detalhe sem
      caminho) se a origem sai do repositório por symlink, se o destino já existe, ou se o destino
      não sai ignorado no worktree — é isso que garante que nunca entra em commit. Padrão inválido
      (`..`, absoluto, `\`, `.git`, `:` ou `-` no início) é `ConfigError` apontando o arquivo de
      onde veio. O checkout só-leitura só recebe cópia com `worktree.copyToReadOnly: true`; falha
      ali libera o checkout e degrada com `no_copy`. O `doctor` avisa quando o último segmento do
      padrão, lido como texto, começa com `.env`, ou quando o padrão casa hoje com um arquivo
      `.env*`. Sem a chave, nenhum comando Git a mais.

<!-- Avulsos -->
- [x] **N4 · A config do projeto só aperta** — `src/config/resolver.ts:7-13` — 72bda11, 25/09
      Um repositório pode hoje ligar `dangerouslySkipPermissions`, acrescentar `args` que
      liberam ferramentas, apontar MCPs e desligar `approval.requiredBeforeImplementation`. Regra
      nova, como no ai-jail: a config do projeto só restringe; liberar exige confiança declarada
      na config global (lista de diretórios confiáveis). O `doctor` diz o que o projeto tentou
      liberar e foi ignorado. Rever junto a config que o próprio repositório do Agent Flow
      traz (agy em skip-permissions).
      **Pronto quando:** num projeto não confiável, as quatro liberações são ignoradas e
      relatadas (testes); num diretório confiável, valem; um projeto que só restringe não muda.
      **Feito.** Lido no código antes: `resolveConfigSources` copiava cada chave de
      `PROJECT_OVERRIDABLE_KEYS` inteira do projeto para o overlay, sem checagem nenhuma. Agora a
      config global tem `trust.projectConfig` (diretórios absolutos; cada um confia nele e em tudo
      abaixo), lida só do arquivo global — um projeto não se declara confiável. `decideProjectTrust`
      compara os dois lados já resolvidos por `realPath`, sem diferenciar maiúsculas nem separador
      no Windows, e não toca o disco quando a lista não existe. Num projeto não confiável o
      resolver descarta, para todo runner que o projeto nomeia (inclusive um que só ele declara):
      `dangerouslySkipPermissions: true`; a lista `args` **inteira** quando algum token é
      `--allowedTools`, `--allowed-tools`, `--dangerously-skip-permissions` ou `--permission-mode`
      (também na forma `--flag=valor`); qualquer `mcp`; e `approval.requiredBeforeImplementation:
      false`. Vale o valor global ou o padrão, `originOf` nunca atribui o valor descartado ao
      projeto, e cada descarte vai em `ignoredLoosenings` e numa nota do `doctor` que nomeia
      `trust.projectConfig`. Escolher runner, modelo, esforço, papéis, paralelismo, retry,
      fallback, idioma e `worktree` continua com o projeto. O agy em skip-permissions já tinha
      saído da config deste repositório (desligado, sem `dangerouslySkipPermissions`); os grants
      de `runners.claude.args` que ela traz agora só valem numa máquina cuja config global confia
      no checkout, e o comentário da própria config diz isso.

      **Riscos que ficam** (nenhum resolvido aqui; cada um é candidato a item próprio):
      - **O worktree de integração não recebe `worktree.copy`.** Os comandos de validação final da
        run (`integrator.ts`) rodam onde nenhum arquivo ignorado foi copiado: um teste que precisa
        de `.env.test` passa na tarefa e falha na revisão da run. Fechar é pequeno (o mesmo helper
        depois da criação do worktree de integração), mas encosta no caminho de revisão perto de
        `run-actions.ts`, que a F7a é dona.
      - **Os grants deste repositório somem sem confiança global.** A validação continua rodando
        no orquestrador, mas os agentes pulam diagnósticos ou voltam BLOCKED num comando negado.
        Mitigado pela nota do `doctor` e pelo comentário na config.
      - **O princípio "só aperta" não está inteiro.** Fora das quatro liberações nomeadas, um
        projeto não confiável ainda pode: declarar `worktree.copy`, que deixa os arquivos
        ignorados do operador — `.env` inclusive — legíveis pelo modelo (o aviso do `doctor` é a
        única guarda); definir `runners.<x>.command`; apontar `baseUrl` com `apiKeyEnv`; e passar
        flags de outros CLIs, como as de sandbox do codex.
      - **Descartar a lista `args` inteira** por causa de um token de grant descarta junto flags
        inofensivas. Escolhido contra filtrar token a token, que deixaria os argumentos do
        `--allowedTools` variádico soltos como posicionais.
      - **Padrão largo em `worktree.copy`** (`**/*`) num repo Node lista `node_modules` e pode
        bater no teto de saída do Git: a tentativa é recusada, alto, em toda tentativa, até o
        padrão ser estreitado.
      - **Sem teto total para as instruções aninhadas.** Só o limite de 64 KiB por arquivo; uma
        tarefa que toca muitos diretórios fundos gera um prompt grande. A fonte
        `directoryInstructions` no orçamento torna isso visível.
      - **Instruções aninhadas em dobro** quando um runner Claude declara `mcp`: sem
        `--safe-mode`, o CLI pode carregar o `CLAUDE.md` aninhado por conta própria, além da cópia
        injetada. Não medido.
      - **A afirmação mais fraca do desenho:** que `ls-files --others --ignored
        --exclude-standard` com pathspecs `:(glob)` lista arquivo a arquivo dentro de diretórios
        ignorados, com essa semântica, no Git for Windows. Vem da documentação do Git, não de
        medição; os testes de subprocesso com repositório real são o que decide.

