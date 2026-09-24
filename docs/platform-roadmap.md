# Roadmap de plataforma — do harness ao L4

O porquê de cada frente está aqui. A fila executável, com o critério de pronto de cada
item, está em [`platform-todo.md`](platform-todo.md).

Origem: uma leitura crítica, feita em 24/09/2026, do artigo
[*Do copiloto à fábrica de software*](https://nexify.ink/blog/do-copiloto-a-fabrica-de-software/)
(Nexify, 31/08/2026) contra o `src/` deste repositório, revisada no mesmo dia por uma
pesquisa de projetos abertos e de casos publicados (seção [Revisão de 24/09](#revisão-de-2409--o-que-a-pesquisa-mudou)
e [Referências](#referências)). A escada L0–L6 e os princípios são do autor, não uma
norma: aqui eles servem como **lista de verificação**, não como especificação. Onde este
documento e o código discordarem, o código é a verdade atual — a mesma regra do
[`roadmap.md`](roadmap.md).

---

## A tese: o formato é de L5, a fundação é de L4 incompleto

O artigo define uma *agent platform* pela soma de modelo, contexto, ferramentas, execução,
identidade, segurança, observabilidade e avaliação. A escada dele:

| Nível | Capacidade | Pergunta para subir |
|---|---|---|
| L2 | Coding agents | Como fornecer contexto e feedback confiáveis? |
| L3 | Agentes + MCP | Como padronizar ferramentas, identidade e permissões? |
| L4 | Enterprise harness | Como operar agentes com evals, isolamento e observabilidade? |
| L5 | AI Software Factory | Como redesenhar o SDLC para humanos e agentes? |

O pipeline do Agent Flow **já é** o fluxo que o artigo atribui ao L5: humano especifica →
agentes planejam, implementam, testam e revisam → a plataforma verifica evidências → humano
decide onde há julgamento. Mas a pergunta do L4 tem três partes, e só uma está respondida:
**observabilidade sim, isolamento em parte, evals não**.

O artigo avisa o que acontece nesse arranjo: *"pular degraus costuma produzir um protótipo
sofisticado apoiado sobre processos frágeis"*. A fragilidade aqui não é de código — a
suíte, os invariantes e os testes de arquitetura são rigorosos. Ela é de **medição** e de
**contenção**:

- Os dois field reports de 22 e 23/09 somam 46 itens (12 e 34), todos encontrados em uso
  manual. Nenhum mecanismo avisaria de uma regressão parecida introduzida amanhã.
- O D-6 ([field report de 22/09](engineering/field-report-2026-09-22-webview-file-picker.md))
  foi visto comparando **dois planos do mesmo trabalho**: a variância entre runs é real, e
  hoje só aparece quando alguém calha de rodar duas vezes.
- O ganho do `--grounded` (planejamento 14m05s → 9m05s) foi *"measured once"*, e o próprio
  [field report de 23/09](engineering/field-report-2026-09-23-windows-daily-use.md) diz que
  precisa de mais runs.
- Depois do `approve`, o executor trabalha sem ninguém olhando, e o código que ele escreve
  roda com os privilégios de quem opera: a validação determinística executa os testes que o
  agente acabou de escrever, e um `Bash(npm test:*)` liberado com um `package.json` editável
  é execução arbitrária.

---

## Estado atual, princípio por princípio

Levantado lendo `src/` em 24/09/2026, não a documentação.

| Princípio do artigo | Estado | Evidência |
|---|---|---|
| Model-agnostic | ✅ | 4 runners (`src/adapters/runners/registry.ts:17-20`); runner e modelo por papel e por estágio (`StageOverrideSchema`, `config.schema.ts:149-181`) |
| Context-first | ✅ raiz · ❓ por diretório | repo map, fallback AGENTS.md → CLAUDE.md (`app/project-instructions.ts:33-72`), orçamento de prompt por fonte (`core/prompt-budget.ts`). Só as instruções da **raiz** são lidas; com `--setting-sources ''` o CLI do Claude provavelmente não carrega as aninhadas — a medir (N1) |
| Observable by design | ✅ tempo e custo · ❌ trajetória | telemetria por estágio/modelo (`contracts/result.schema.ts:175-200`), `RunSpend` com `costUsd` (`core/telemetry.ts:136-177`). O envelope `json` do Claude traz `num_turns` e `permission_denials` e o runner **descarta** — o tipo em `claude-code-runner.ts:36-45` nem os declara; o `num_turns` do agy também cai (`agy-runner.ts:329-341`) |
| Resultado em uso real | ❌ | nenhuma medida de o que acontece com a saída de uma run: se virou merge, quanto a pessoa reescreveu, quantos achados de revisão ela descartou |
| Julgamento humano na camada certa | ✅ | aprovação presa ao hash do plano (`app/approval.ts`); uma decisão por run, não por clique |
| Protocol-first (MCP) | 🟡 | só no runner do Claude (`claude-code-runner.ts:394-415`), concedido por servidor inteiro (`mcp__<server>`). O codex roda com `--ignore-user-config` (`codex-runner.ts:174-198`): não herda MCP global, e também não recebe nenhum |
| Secure execution | 🟡 | `--allowedTools`, `--permission-mode plan` e checkout descartável nos estágios só-leitura, env por allowlist (`ports/process-runner.ts:46-73`), servidor que não lê ambiente (§93). **Sem** sandbox de sistema de arquivos ou de rede na execução; **sem** identidade — `RunActor` é `keyboard` ou `device` (`state.schema.ts:646-654`) |
| Limite de custo | 🟡 | iterações limitadas (`CeremonyBudget`, `core/adaptive-workflow.ts:6-10`; orçamentos de reparo); **nenhum** teto em USD ou tokens. O Claude 2.1.217+ tem `--max-budget-usd`, não usado |
| Evaluation-first | ❌ | nada em `src/`, nada no backlog. O harness do AR-10 dirige peças de `app/` e `core/` à mão com cenários roteirizados: testa **o orquestrador**, não modelos nem prompts |
| Entrada por especificação | 🟡 | `feature --file` (`cli/feature.ts:73`); nenhuma porta que leia um work item; critério de aceite do SDD sem notação testável |
| Loop até produção | ❌ | a entrega para em PR aberto e checks lidos, só no GitHub (`app/forge-actions.ts:108`, `id: 'github'` literal em `ports/forge.ts:52`) |
| Texto para quem opera | ❌ | o mesmo campo serve ao agente e à pessoa: critérios de aceite, descrições e achados saem escritos para um verificador conferir, e o Deck mostra esse texto cru |
| Visibilidade ao vivo | ❌ | nada chega durante uma tarefa: o Claude responde só no fim (`--output-format json`), e a sidebar mostra "modelo não registrado" enquanto a tarefa roda |
| Paralelismo | 🟡 existe, desligado | DAG do planejador, checagem de arquivo compartilhado e ondas existem; `git.useWorktrees: false` e `parallelism.maxTasks: 1` por padrão (`config.schema.ts:240-253,383-400`) — tarefas prontas esperam na fila |
| Memória entre runs | ❌ | só o cache da descoberta e o AGENTS.md; nada do que uma run aprendeu chega à seguinte |
| Config do projeto só aperta | ❌ | `runners` e `approval` são sobrescrevíveis pelo projeto (`config/resolver.ts:7-13`): um repositório clonado pode ligar `dangerouslySkipPermissions` ou desligar o gate de aprovação |

---

## As frentes, em ondas

A ordem é por dependência e por custo. Dentro de uma onda, as frentes andam em paralelo.

```text
Onda 1 — barato, já:   F7  o operador sozinho destrava a run
                       F0  texto para humano + passo a passo ao vivo
                       F1a trajetória + resultado em uso real
                       F4a sandbox nativo dos CLIs (medir, depois ligar)
                       F3a teto de gasto (opt-in; adiado, ver o todo)
Onda 2:                F1b corpus + eval run/compare
                       F3b MCP por ferramenta e por estágio
Onda 3:                F2  entrada por work item + identidade + critério testável
                       F6  memória entre runs (depende da F3b)
Condicional:           F4b container  ──►  F5 gatilho automático · loop até produção
```

### F7 — O operador sozinho destrava a run

**Por que no topo.** O Agent Flow vai ser usado por um time, e ninguém do time vai ter outro
agente conduzindo a run ao lado. Hoje, seis situações reais só se resolvem escrevendo arquivo de
instrução, forçando comando ou recomeçando — levantadas por quem conduziu runs em 23 e 24/09 e
conferidas no código:

- **A · BLOCKED sem canal de resposta.** O próprio produto manda *"Answer what the blocked task
  reported, then retry it"* (`core/phrases/en.ts:440`), mas não existe comando de resposta, e o
  `retry` de uma tarefa bloqueada exige `--force` (`app/run-actions.ts:915`). A única entrega
  possível de uma decisão de uma linha é `revise`, que invalida a aprovação.
- **B · O executor não roda os comandos que o projeto declara.** `commands` é rodado pelo Agent
  Flow, mas o executor só roda o que estiver em `--allowedTools` — duas vezes no Windows
  (`Bash(...)` e `PowerShell(...)`). E o planejador pede ao executor medições (build, cherry-pick
  numa branch de port) que ele não tem como fazer.
- **C · `revise` no meio da implementação não preserva o pronto.** Tarefas concluídas só não
  reabrem se a instrução pedir em texto livre; e a tarefa BLOCKED cuja decisão entrou no plano
  novo continua BLOCKED depois do `approve`.
- **D · Decisão do operador não fica registrada.** Existe só no arquivo de instrução do
  `revise`; SDD, estado e revisão final não enxergam quem decidiu o quê.
- **E · O teto de cerimônia conta decisão do operador como ciclo de revisão**
  (`app/run-actions.ts:1772`). Esgotado, sobram "aprovar por cima dos achados" (que não chegam
  aos executores) ou "recomeçar". A run AF-2026-001 bateu no mesmo teto.
- **F · A classe do workflow sai de palavra solta.** `token` e `migration` estão entre os sinais
  de alto risco (`core/adaptive-workflow.ts:37,53`) e não há tratamento de negação: *"não
  trafega token nem dado de sessão"* virou HIGH-RISK.

**O que entrega:** resposta a BLOCKED pela CLI e pelo Deck, registrada e entregue ao próximo
attempt, sem `--force`; os comandos declarados liberados ao executor nos dois shells, e o
planejador sabendo o que ele pode rodar; `revise` que preserva o concluído por padrão; decisões
do operador como emendas registradas que a revisão final lê; orçamento que separa replanejamento
de decisão, com saída explícita no teto; classificação que ignora menção negada, mostra o trecho
que pesou e aceita correção registrada.

**Fecha quando:** as seis situações se resolvem sem arquivo de instrução, sem `--force` e sem
recomeçar, pela CLI e pelo Deck.

### F0 — Legível e visível para quem opera

**Por que primeiro.** Quem conduz uma run hoje lê texto escrito por uma IA para outra IA e não
vê nada do que acontece dentro de uma tarefa. Os dois problemas fazem a pessoa depender de outra
IA para entender a própria ferramenta — o contrário do que o gate humano promete.

**Texto para humano.** A causa é de desenho: **um campo serve dois leitores**. O critério de
aceite "a linha 1 do arquivo continua sendo a primeira linha" está certo para um verificador e é
ilegível para uma pessoa; nenhum ajuste de prompt resolve enquanto o mesmo campo servir aos dois.
A correção separa os leitores no schema — cada coisa que o Deck mostra ganha um resumo curto,
para gente (o que é e por que, sem caminho de arquivo), e o detalhe técnico fica atrás de "ver
detalhes técnicos". Achados ganham título curto, impacto ("o que quebra para quem") e correção.
Uma regra de escrita única, compartilhada pelos prompts, e um gate mecânico barato no schema
(tamanho do resumo, sem crase nem caminho) seguram a regressão até a F1b existir.

**Passo a passo ao vivo.** Medido no Claude 2.1.280: com `--output-format stream-json --verbose`
chegam, ao vivo, cada chamada de ferramenta (nome e entrada), cada resultado e cada texto
intermediário. **O raciocínio não:** o bloco `thinking` chegou vazio, só com a assinatura —
dá para mostrar o que o modelo faz, não o que ele pensa (a medir se alguma configuração expõe
resumos). O codex (`exec --json`) entrega resumos de raciocínio. A mesma trilha alimenta a
sidebar e os evals (P1.4). A sidebar mostra ação e alvo ("editou `x.ts`", "rodou `npm test`"),
**nunca conteúdo**: o Deck pode estar exposto na rede local com pareamento.

**O e2e é o caso mais concreto.** O `agent-browser` foi escolhido justamente porque tem um
dashboard local (porta 4848) com o viewport ao vivo e o feed de comandos de cada sessão. Falta
o Agent Flow escolher a sessão, em vez de deixar o modelo inventar um nome, subir o dashboard
e pôr no card do estágio um "Ver navegador ao vivo" — mais um vídeo por cenário, que fica como
evidência depois que a sessão fecha.

**Fecha quando:** a sidebar de uma tarefa em andamento mostra runner, modelo e as últimas
ações; um e2e em andamento pode ser assistido a partir do Deck; e uma pessoa que não acompanhou a run entende, só pelo Deck, o que cada tarefa faz e por
que um achado importa.

### F1 — Trajetória, resultado em uso real e evals

**Por que primeiro.** O Agent Flow já tem juízes — revisão do plano, revisão de código,
revisão final. O Spotify chegou a mais de 1.500 PRs mergeados com um juiz parecido e
escreveu depois: *"We have yet to invest in evals for our judge."* É a mesma dívida, e aqui
ela está prestes a virar a dívida de um time inteiro: toda mudança de prompt ou de workflow
hoje é julgada por uma amostra.

**O que a pesquisa corrigiu na ordem.** Nenhum caso publicado montou um corpus offline
antes de operar. Todos mediram **o resultado em uso real** primeiro — Stripe com revisão
humana de todo PR, Uber com a taxa de falso positivo dos comentários como métrica central,
Ramp com a fatia de PRs mergeados. Para um time de uns dez, o volume é pequeno, então o
corpus continua necessário; mas ele vem **depois** de medir o que já acontece de graça.

**F1a — trajetória e resultado em uso real (onda 1).**
1. Ler do envelope o que ele já traz: turnos, negações de permissão, duração de API. É
   parsing, não instrumentação. A trilha por tool call (`stream-json`) deixou de ser
   condicional: a F0 precisa dela para a sidebar ao vivo, e os evals a reaproveitam — lembrando
   que a Anthropic recomenda avaliar o **resultado**, não o caminho.
2. Métricas de resultado por run real, carimbadas com o commit do Agent Flow e a
   configuração: a saída virou merge? quanto a pessoa reescreveu no branch até o merge?
   quantos achados de revisão ela descartou (falso positivo)? quantas revisões e retries?
   quanto custou? Merge por squash muda os hashes, então a detecção compara conteúdo, não
   ancestralidade.

**F1b — corpus e evals offline (onda 2).**
1. Um contrato de caso copiado de quem já resolveu isso: a estrutura de diretório do
   [Harbor](https://github.com/harbor-framework/harbor) (instrução, config, ambiente,
   solução de referência, testes) e a divisão do
   [SWE-bench](https://github.com/SWE-bench/SWE-bench) entre `FAIL_TO_PASS` (tem que virar)
   e `PASS_TO_PASS` (não pode quebrar).
2. Um executor (`agent-flow eval`) que dirige a run pelas mesmas funções de
   `app/run-actions.ts` que a CLI e o servidor usam, com id único por repetição (o SWE-bench
   reaproveita resultado por `run_id` — armadilha conhecida) e o commit do Agent Flow e a
   configuração carimbados em cada registro, como o
   [benchmark do Aider](https://github.com/Aider-AI/aider/tree/main/benchmark) faz.
3. Um comparador que mostra **pass@k** (acertou ao menos uma vez) e **pass^k** (acertou
   todas) por caso. Para uma ferramenta de time, consistência importa mais: a 75% por
   tentativa, passar as três é 42%. Qualquer limiar de "inconclusivo" é uma heurística nossa,
   e o relatório diz isso.
4. Um corpus que começa com 10 a 15 tarefas reais e mira 20 a 50 (a recomendação da
   Anthropic para começar), dividido em **regressão** (deve passar sempre) e **capacidade**
   (onde se mede progresso), **fora deste repositório**.
5. A regra: mudança em `prompts/` ou no workflow só entra com `eval compare` anexado. Para
   iterar o próprio corpus, o ciclo *sample-tune-sweep* do Airbnb (achar o grupo que falha,
   ajustar, rodar a amostra, varrer tudo).

**Métricas de trajetória são diagnóstico, não portão.** Um agente pode chegar ao resultado
certo por um caminho que ninguém previu. O que reprova um caso é o resultado errado ou uma
ação proibida (caminho fora do escopo, comando negado tentado repetidamente).

**O que não entra.** Eval rodando em CI a cada commit: cada rodada gasta dinheiro de
modelo, e esse gasto é do dono — a mesma linha que o AR-10 traçou. O CI testa o
**executor** de eval contra runners roteirizados, de graça.

**Fecha quando:** o resultado em uso real de um mês de runs está medido; existe uma baseline
do corpus com N=3 por caso; e uma mudança real de prompt foi aceita ou recusada com base
num `eval compare`.

### F2 — Entrada por work item, identidade e critério testável

**Por que.** O artigo põe o novo gargalo na especificação. Hoje o pedido chega como texto
que o operador monta à mão; o work item — onde o time já escreve critério de aceite — não
entra. E *quem* aprovou o plano é registrado como "teclado" ou "dispositivo pareado".

**Decisão explícita: rascunho, não disparo.** O padrão de mercado é o contrário. O agente de
nuvem do GitHub Copilot e o Devin disparam a run ao atribuir a issue ou pôr um rótulo; para
Azure Boards, Jira e Linear, o Copilot *"only support[s] creating a pull request directly"*,
sem etapa de plano. Aqui o work item vira um **rascunho de pedido** que o operador revisa,
porque o gate de aprovação do plano é o valor central do produto. O meio-termo documentado
— o tracker dispara o **planejamento**, que é só-leitura, e a run para no gate — fica para
depois do teto de gasto (F3a) e exige um processo que observe o tracker, então entra pela
F5. O invariante do M7 (*"the forge is a destination, never an authority"*,
`test/architecture.test.ts:4788`) continua valendo.

**O que entrega.**
1. Uma porta de leitura de work item, **separada** do `ForgeProvider` de entrega, e um
   adaptador de Azure Boards (primeiro, porque é onde o time trabalha).
2. `agent-flow intake <id> --out <arquivo>`: um rascunho com as seções que o pedido precisa —
   sintoma, evidência, critério de aceite, branches de port, clientes antigos — marcando o
   que o work item não trouxe. O texto do item é **conteúdo externo**: entra delimitado como
   dado, e o estágio que o lê não pode ter ao mesmo tempo ferramenta que escreve e saída de
   rede (a regra da "trifeta letal", F3).
3. A origem gravada na run (`provider`, `id`, `url`) e citada na revisão final.
4. Aprovação com identidade **que já existe**: nenhum projeto pesquisado inventa um sistema
   de identidade; todos usam a do host (quem assina o commit, quem aprova o PR). A aprovação
   do PR no Azure DevOps já tem nome; o gate do plano é o único que não tem, e a identidade
   do git de quem opera resolve.
5. Critério de aceite em notação testável no SDD — EARS (`WHEN <evento> THE SYSTEM SHALL
   <comportamento>`), a notação do Kiro. É mudança de prompt, então entra pela regra da F1b.

**O que não entra agora.** PR no Azure Repos. Depende de o `ForgeProvider` deixar de ser
GitHub-literal (`ports/forge.ts:52`, `app/forge-actions.ts:108`) e está no
[`post-mvp3-backlog.md`](post-mvp3-backlog.md) §5–6.

**Fecha quando:** um work item real vira pedido, a run registra a origem, e o
`status`/Deck mostra quem aprovou pelo nome.

### F3 — Teto de gasto e menor privilégio por ferramenta

**Por que.** O artigo separa probabilidade de falha de impacto possível, e diz que o
impacto precisa ser limitado na arquitetura. Três buracos concretos:

- **Sem teto de gasto.** O Agent Flow já calcula o gasto (`RunSpend`); só não age sobre ele.
- **MCP concedido por servidor inteiro.** Declarar um MCP de banco de produção para
  investigação concede junto as ferramentas de escrita dele.
- **Nenhuma regra que impeça um estágio de juntar as três pernas** da trifeta letal: dado
  privado, conteúdo não confiável e um canal de saída. O servidor MCP oficial do GitHub já
  foi explorado exatamente assim.

**F3a — teto de gasto (onda 1).** O teto fica no Agent Flow e **pausa** a run, entrando na
fila "Precisa de você". Por invocação, o `--max-budget-usd` do Claude entra como
**segunda linha**: ele encerra o processo (não pausa), então o encerramento vira uma classe
de falha própria, e não uma falha genérica de runner. O codex não tem equivalente em dólar.
Os limites de iteração que já existem são a mesma ideia do teto de 2 rodadas de CI do Stripe.

**F3b — MCP por ferramenta e por estágio (onda 2).** Pelos mecanismos nativos, **sem
gateway**: no Claude, `mcp__<server>__<tool>` e `mcp__<server>__*` em
`--allowedTools`/`--disallowedTools`; no codex, `enabled_tools`/`disabled_tools` por
servidor via `-c`, já que a configuração do usuário é ignorada de propósito. Gateways
(Docker MCP Gateway, agentgateway, ContextForge) resolvem governança entre vários clientes
simultâneos, que não é o formato do Agent Flow — só entram se um runner não tiver mecanismo
nativo. As anotações `readOnlyHint`/`destructiveHint` do MCP servem de padrão apenas para
servidores confiáveis: a própria especificação diz *"clients should never make tool use
decisions based on ToolAnnotations received from untrusted servers"*.

**Fecha quando:** uma run que cruza o teto para antes da tarefa seguinte, e uma run de teste
com um MCP de banco só consegue chamar as ferramentas de leitura.

### F4 — Sandbox de execução

**O que a pesquisa corrigiu.** A versão anterior deste roadmap dizia que o sandbox só se
pagaria quando runs começassem sem uma pessoa, porque "há sempre alguém no gate". Isso
confundia **aprovar o plano** com **supervisionar a execução** — o plano não mostra o código
que vai rodar. E todos os casos publicados puseram isolamento **antes** de escalar: o
Stripe roda cada agente num devbox, o Ramp numa sandbox da Modal, a OpenAI com worktree e
stack efêmera por branch.

A outra correção: sandbox não exige container. Os próprios CLIs trazem um de sistema
operacional.

**F4a — sandbox nativo dos CLIs (onda 1: medir, depois ligar).**
- **codex:** sandbox nativo no Windows (modos `elevated` e `unelevated`), além de Seatbelt no
  macOS e bwrap+seccomp no Linux. O Agent Flow já passa `-s read-only|workspace-write`, mas
  com `--ignore-user-config` a chave `[windows] sandbox` do `config.toml` não é lida — é
  preciso medir o que vale de fato e passar por `-c`.
- **Claude:** sandbox de arquivos e de rede via `--settings '{"sandbox":{...}}'`, no macOS, no
  Linux e no WSL2. **Não roda no Windows nativo.**
- **[sandbox-runtime](https://github.com/anthropics/sandbox-runtime) (`srt`, Apache-2.0):**
  embrulha qualquer processo — inclusive os comandos de validação que o próprio Agent Flow
  roda — e tem uma implementação **alfa** para Windows nativo (usuário dedicado, cerca de
  rede pelo WFP, ACLs do NTFS). Limite conhecido e decisivo aqui: ferramentas instaladas
  **por usuário** (Node pelo nvm, `pip --user`, scoop) não são alcançáveis pela conta do
  sandbox — e é exatamente assim que o Node está instalado na máquina de uso diário.
- **[ai-jail](https://github.com/akitaonrails/ai-jail) (GPL-3.0):** bubblewrap + Landlock +
  seccomp no Linux, `sandbox-exec` no macOS, home privada por padrão, credenciais do agente só
  por opt-in, egress por allowlist de hosts. **Não roda no Windows** (só no WSL2). Serve como
  opção pronta nas máquinas Linux, chamado como programa externo — a licença impede copiar
  código para cá, não impede invocar o binário.

**F4b — container (condicional).** Só quando a F5 for aprovada. No Windows, todo container
herda a dependência de Docker Desktop/WSL2, então ele não compra nada sobre o sandbox do
Claude no WSL2 — e acrescenta daemon, imagens e montagem de credenciais. O `ProcessRunner`
é uma porta de um método (`ports/process-runner.ts:125-127`) e
`adapters/process/node-process-runner.ts` é o único ponto de spawn de runner
(`test/architecture.test.ts:1233`): qualquer embrulho entra por ali, estendendo a regra de
arquitetura de propósito.

**Regra que não muda: nenhum gatilho automático sem sandbox.**

### F6 — Memória entre runs

**Por que.** Dentro de uma run a memória já é compartilhada entre provedores: SDD, plano e
pacotes de falha são arquivos que qualquer runner lê. Entre runs, nada passa adiante além do
cache da descoberta — o que uma run aprendeu (o comando que não existe, o teste que é
instável, o achado que era falso) morre com ela.

**Candidato: [ai-memory](https://github.com/akitaonrails/ai-memory)** (MIT). Wiki de markdown
versionado no git como fonte da verdade, índice derivado, handoffs entre agentes, suporte a
Claude Code, Codex e Antigravity (agy), e **nenhuma chamada a LLM por padrão**.

**O que não funciona:** instalar os hooks dele no Claude Code não captura as runs do Agent
Flow, porque o Agent Flow isola os runners de propósito (`--setting-sources ''` e
`--safe-mode` no Claude, `--ignore-user-config` no codex). A integração tem de ser explícita:
1. ao fim de cada run, o **próprio Agent Flow** grava uma página determinística — o que foi
   pedido, o que falhou e por quê, quais achados de revisão eram reais;
2. os estágios de planejamento leem um resumo limitado pelo MCP dele — só ferramentas de
   leitura, o que **depende da F3b** (sem MCP por ferramenta, conceder o servidor de memória
   concede junto as de escrita).

**Medir antes de adotar:** o suporte ao Windows nativo é experimental (servidor no WSL2 ou em
Docker), e o efeito tem de aparecer num `eval compare` com e sem o resumo — o ganho publicado
de memória de workflows (Agent Workflow Memory) é em navegação web, não em código.

### F5 — Fora de escopo hoje, e a condição de reabrir

| Tema | Por que não agora | Reabre quando |
|---|---|---|
| Gatilho automático (webhook, alerta, cron, rótulo no tracker) | run sem pessoa no início exige sandbox e baseline de evals | F1 fechada e F4a ligada |
| Planejamento disparado pelo tracker, parando no gate | exige observar o tracker e um teto de gasto; usar detecção de borda (disparar na transição, não a cada leitura), como o Devin | F2 e F3a fechadas |
| Loop até produção (deploy + verificação pós-deploy) | é L5/L6 sem a fundação de L4; deploys de projetos hospedeiros costumam ter passos humanos deliberados | gatilho automático em uso estável |
| Agente de limpeza recorrente (o "garbage collection" da OpenAI: varre desvios de princípios e abre PRs pequenos) | é um caso de uso novo, não fundação | gatilho automático em uso estável |
| A2A / colaboração com autoridade | o canal do M4 existe, desligado e consultivo por decisão (I-27); não há demanda medida | o segundo dogfood do M4 ([`roadmap.md`](roadmap.md), "What the live dogfood changed about M4") |
| RBAC / multiusuário | cada pessoa roda o próprio Agent Flow; não há servidor compartilhado | *Remote Workers* do [`post-mvp3-backlog.md`](post-mvp3-backlog.md) §8 |

### Achados sem frente própria

- **N1 — regras por diretório.** O Stripe mantém as regras por diretório, não globais, para
  que a janela não encha de regra antes de o agente começar; o OpenHands injeta uma regra na
  primeira vez que o agente toca um arquivo que casa com o caminho dela. O Agent Flow lê só a
  raiz, e roda o Claude com `--setting-sources ''`. Se as instruções aninhadas de um monorepo
  não chegam ao executor, isso é perda de contexto silenciosa. Medir primeiro.
- **N2 — arquivos ignorados no worktree da tarefa.** O worktree não tem o que o git ignora
  (`.env`, configuração local). O claude-squad tem a mesma dor em aberto
  ([#260](https://github.com/smtg-ai/claude-squad/issues/260), com um hook de setup proposto
  em [#270](https://github.com/smtg-ai/claude-squad/pull/270)), e usuários do Conductor
  escrevem scripts de 50 a 100 linhas para contornar. Aqui a solução é uma lista explícita
  do que copiar — nunca `.env` por padrão, porque o que vai para o worktree fica legível pelo
  modelo (a perna "dado privado" da trifeta). O ai-jail resolve o inverso com `mask =
  [".env"]`: o agente vê que o arquivo existe, sem conteúdo.
- **N3 — paralelismo visível e medido.** A inteligência existe e está desligada (ver a tabela
  de estado). Ligar custa um worktree e um install por tarefa, merges na integração e consumo
  mais rápido da janela de uso de uma assinatura. Em vez de mudar o padrão às cegas: a escolha
  aparece no Deck ("paralelo: N ao mesmo tempo") e uma run medida compara tempo total e
  retrabalho de integração contra a mesma run sequencial.
- **N4 — a config do projeto só aperta.** Hoje um repositório clonado pode, pela própria
  `.agent-flow/config.yaml`, ligar `dangerouslySkipPermissions`, acrescentar `args` que liberam
  ferramentas, apontar MCPs e desligar `approval.requiredBeforeImplementation` — e o próprio
  repositório do Agent Flow vem com o agy em skip-permissions. O ai-jail adota a regra
  contrária: a config do projeto só pode restringir, e liberar exige confiança declarada na
  config global (`trust_project_config`). Severidade honesta: rodar num repositório estranho já
  executa os scripts de install dele; o que piora aqui é o **gate humano** poder ser desligado
  pelo repositório, e o modelo — guiado por conteúdo possivelmente injetado — ganhar permissão
  total sem a pessoa decidir.

---

## Revisão de 24/09 — o que a pesquisa mudou

A primeira versão deste documento saiu da leitura do artigo e do código. A pesquisa de
projetos e casos corrigiu seis pontos dela:

1. **F4 estava errada.** "Há sempre alguém no gate" confundia aprovar o plano com
   supervisionar a execução, e "sandbox = container" ignorava o sandbox nativo dos CLIs. A
   F4a subiu para a onda 1.
2. **F1 começava pelo lado caro.** Nenhum caso montou corpus antes de medir o resultado em
   uso real. A F1a (resultado em uso real) vem antes da F1b (corpus).
3. **A regra "diferença de até 1 em 3 é inconclusiva" era invenção nossa.** Nenhuma fonte a
   sustenta. Saiu, entrou pass@k com pass^k, e qualquer limiar é declarado como heurística.
4. **P1.1/P1.2 eram maiores do que precisavam.** O envelope `json` do Claude já traz turnos e
   negações; o trabalho é ler o que hoje é descartado.
5. **P3.1 estava pela metade.** O codex já é isolado da configuração global
   (`--ignore-user-config`); só o agy precisa ser medido.
6. **O rascunho de pedido é a posição minoritária**, não a óbvia. Continua sendo a
   escolhida, agora com o porquê e a alternativa escritos.

Na mesma tarde, a primeira run da onda 1 e o uso do Deck acrescentaram quatro frentes e
achados: a **F0** (texto para humano e passo a passo ao vivo — o que mais atrapalha quem
conduz uma run), a **F6** (memória entre runs), o **N3** (paralelismo existe e está
desligado) e o **N4** (a config do projeto pode afrouxar a segurança). E o teto de gasto foi
tentado e adiado — o porquê está no P3.1 do todo. Por último entrou a **F7** (o operador
sozinho destrava a run), a partir das runs de outro condutor, e foi para o topo da onda 1: é o
que separa uma ferramenta de time de uma que precisa de um agente ao lado.

---

## Referências

Estrelas e licenças medidas em 24/09/2026 pela API do GitHub. Números de casos são os que as
próprias empresas publicaram (autodeclarados).

**Projetos**

| Projeto | Estrelas | Licença | O que tirar dele |
|---|---|---|---|
| [openai/codex](https://github.com/openai/codex) | 126k | Apache-2.0 | sandbox nativo no Windows; `enabled_tools`/`disabled_tools` de MCP |
| [github/spec-kit](https://github.com/github/spec-kit) | 139k | MIT | fluxo specify → plan → tasks → implement → *converge* |
| [Aider-AI/aider](https://github.com/Aider-AI/aider) | 49k | Apache-2.0 | benchmark do **produto**, com commit e configuração em cada registro |
| [SWE-agent/SWE-agent](https://github.com/SWE-agent/SWE-agent) · [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) | 20k · 8k | MIT | trajetória = histórico linear de mensagens, com visualizador |
| [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | 12k | Apache-2.0 | o análogo mais próximo: orquestrador + worker por worktree + kanban derivado de fatos |
| [SWE-bench/SWE-bench](https://github.com/SWE-bench/SWE-bench) | 6k | MIT | `FAIL_TO_PASS`/`PASS_TO_PASS`; cache por `run_id` como armadilha |
| [harbor-framework/harbor](https://github.com/harbor-framework/harbor) | 6k | Apache-2.0 | formato de tarefa de eval (instrução, config, ambiente, solução, testes) |
| [anthropics/sandbox-runtime](https://github.com/anthropics/sandbox-runtime) | 5k | Apache-2.0 | sandbox de SO para qualquer processo, alfa no Windows nativo |
| [UKGovernmentBEIS/inspect_ai](https://github.com/UKGovernmentBEIS/inspect_ai) | 3k | MIT | epochs + redutores; log de eval compacto com visualizador |
| [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) | 9k | **AGPL-3.0** | só as issues (#260, #270); não copiar código |
| [akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory) | 8k | MIT | memória entre agentes e runs em markdown versionado, zero LLM por padrão (F6) |
| [akitaonrails/ai-jail](https://github.com/akitaonrails/ai-jail) | 1k | **GPL-3.0** | sandbox Linux/macOS como binário externo; config de projeto que só aperta; `mask` de `.env` |

O espaço muda rápido: o vibe-kanban anunciou o fim, o Crystal virou produto fechado e o
Roo-Code foi arquivado nos últimos sete meses. Nenhum deles serve de referência viva.

**Guias e casos**

- Anthropic — [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (pass@k vs pass^k, 20–50 tarefas, avaliar o resultado);
  [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents);
  [Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing).
- OpenAI — [Harness engineering](https://openai.com/index/harness-engineering/) (AGENTS.md
  como índice, planos versionados, linters de arquitetura, agente de limpeza).
- Stripe — [Minions](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents)
  (devbox, blueprints determinísticos + agente, subconjunto curado de ferramentas, ≤2 rodadas
  de CI, regras por diretório).
- Spotify — série Honk: [parte 1](https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1)
  e [parte 3](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3)
  (verificadores determinísticos, juiz LLM que veta ~25%, e a dívida de evals admitida).
- Ramp — [Why we built our background agent](https://builders.ramp.com/post/why-we-built-our-background-agent).
- Uber — [uReview](https://www.uber.com/us/en/blog/ureview/) (falso positivo como métrica
  central da revisão).
- Airbnb — [migração de testes com LLM](https://airbnb.tech/infrastructure/accelerating-large-scale-test-migration-with-llms/)
  (*sample-tune-sweep*).
- Simon Willison — [The lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/).
- MCP — [ToolAnnotations na especificação](https://modelcontextprotocol.io/specification/2025-06-18/schema).
- GitHub — [Copilot cloud agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)
  (Azure Boards, Jira e Linear só criam PR direto).
- Kiro — [feature specs](https://kiro.dev/docs/specs/feature-specs/) (EARS; tarefas em ondas).

---

## Regras deste roadmap

- **Nomes de projetos hospedeiros ficam fora do repositório.** O corpus de eval é feito de
  código de terceiros: ele vive fora do repo (caminho configurável, por exemplo
  `~/.agent-flow/evals/`), e o repo só guarda o contrato, o executor e um fixture sintético.
  Field reports, casos de teste e mensagens de commit seguem a mesma regra.
- **Rodada de eval com modelo real é decisão do dono**, porque custa dinheiro. O CI nunca
  dispara uma.
- **A definição de pronto é a do [`todo.md`](todo.md)** — teste cobrindo o comportamento,
  controle positivo, verificação rodando o comando de verdade, suíte inteira verde — mais,
  para itens de F1b, uma rodada registrada com o custo dela.
- **Medir antes de construir.** Vários itens da fila são medições que podem mudar o desenho
  do que vem depois (envelope dos CLIs, MCP do agy, sandbox do codex no Windows, `srt` com a
  toolchain real, regras aninhadas). Eles vêm primeiro de propósito.
- **Código de terceiros só com licença compatível.** MIT e Apache-2.0 podem ser adaptados com
  atribuição; AGPL/GPL, não. Formato e ideia não têm licença — código tem.
