# Field report — 24/09/2026: o Agent Flow implementando o próprio roadmap

O Agent Flow rodando sobre o próprio repositório (run AF-2026-001, worktree separada, todos os
papéis no `claude-opus-5-5`, Windows 11, Claude Code 2.1.280), para entregar a onda 1 do
[`platform-roadmap.md`](../platform-roadmap.md). Conduzido de outra sessão pela skill
`agent-flow`. Este documento anota o que falhou e o que pode melhorar **enquanto** a run
acontece; cada item vira entrada do [`platform-todo.md`](../platform-todo.md) quando for
decidido.

Estado: **execução concluída e integrada (`e110140`)**. Os achados seguem abertos; itens novos entram no fim, numerados em sequência.

## Números da run até aqui

| Etapa | Tempo |
|---|---|
| Impacto (descoberta pulada: `--grounded`) | 6m35s |
| SDD | 12m16s |
| Plano (a checagem recusou e o planejador corrigiu sozinho) | ~6 min |
| Revisão do plano — **reprovou** (3 altos) | 2m24s |
| Revisão 1 (SDD + plano + revisão) — **reprovou** (2 altos) | ~26 min |
| Revisão 2 (escopo reduzido ao P1.2) — **aprovou** | ~15 min |
| Planejamento total, três rodadas | **~1h28**, ~US$ 29 a preço de lista |
| TASK-001 | 11m46s |

## Achados

### A-01 · O SDD triplicou o escopo e consumiu as revisões — alto

O pedido tinha três itens pequenos (P1.2, P3.1, P3.2). O SDD voltou com **26 requisitos
funcionais**: ledger de gasto, guarda por invocação, pausa no scheduler, re-entrada com teto,
endpoints novos. Todos os achados das duas revisões caíram nessa expansão, e o workflow
`standard` permite só duas revisões — a saída foi cortar escopo na última. Nada avisou antes
do plano que o SDD tinha crescido muito além do pedido.
**Oportunidade:** um alarme de escopo depois do SDD — requisitos por item pedido, arquivos
afetados vs. os citados no pedido — que para no gate do SDD, não no do plano, quando cortar
ainda é barato.

### A-02 · A config do projeto sobrescreve a global em silêncio — médio

A config versionada do repositório põe todos os papéis no agy (Gemini flash, skip-permissions)
e desliga o Claude; a global pina Opus em tudo. Vence a do projeto, e o `doctor` só lista
"agy — no role points at it" depois de trocada. Antes da troca, nada dizia "este projeto
ignora os modelos que você fixou na tela Equipe".
**Oportunidade:** `doctor` e Deck mostram, por papel, de onde veio o runner e o modelo
(global ou projeto). Ligado ao N4 (a config do projeto só aperta).

### A-03 · Trocar de runner exige commit — médio

O Agent Flow recusa árvore suja, então mudar a config do projeto numa worktree obriga a um
commit no branch da feature — que depois vai junto no merge, se ninguém lembrar de tirar.
**Oportunidade:** uma sobrescrita local não versionada (`.agent-flow/config.local.yaml`,
ignorada pelo git) ou `feature --runner <nome>` por run.

### A-04 · O Node que roda a run não é o que a suíte exige — médio

O `agent-flow` no PATH resolve para o prefixo do Node 20.10; a suíte do próprio repositório
precisa de 22.12 (vitest). Sem prefixar o PATH à mão, toda validação da run falharia por
ambiente, não por código. O `doctor` mostrou "v22" só porque o PATH já estava corrigido.
**Oportunidade:** o `doctor` compara o Node que vai criar os processos com o que o projeto
declara ou exige (`engines`, versão do vitest) e recusa antes de gastar planejamento.

### A-05 · Validação só enxerga os comandos de `commands` — médio

Os gates do Deck (`typecheck:deck`, `test:deck`) existem no `package.json`, mas o `init` não
os detectou e o `validationCommands` ficou vazio. Resultado: uma tarefa que muda o Deck não
pode declarar os gates do Deck; a verificação vira trabalho manual de quem conduz.
**Oportunidade:** o `init`/`doctor` detecta scripts de workspace e oferece registrá-los; o
planejador recebe a lista de nomes de validação que existem.

### A-06 · Sidebar sem runner e modelo durante a execução — baixo (P0.1)

A tarefa em andamento mostra "RUNNER –", "MODELO não registrado", embora `stage_started` já
tenha os dois.

### A-07 · Texto escrito para IA — médio (P0.2, P0.3)

Critérios de aceite e achados chegam ao Deck no formato que um verificador precisa, ilegíveis
para quem conduz.

### A-08 · Tarefas prontas esperam na fila — baixo (N3)

Com `maxTasks: 1` por padrão, a TASK-004 (que só depende da 001) espera a 002 e a 003
terminarem, mesmo sem conflito de arquivo.

### A-09 · O mesmo id de run em todo projeto — baixo

O hub mostra `AF-2026-001` em quatro projetos ao mesmo tempo. Na fila "Precisa de você" e em
conversa ("a run AF-2026-001"), o id não identifica nada sem o nome do projeto ao lado.
**Oportunidade:** id com prefixo do projeto na exibição, ou numeração global no hub.

### A-10 · As decisões do dono gastaram os ciclos de revisão — médio (P7.5)

Das duas revisões permitidas, a primeira levou os achados da revisão **mais** duas decisões do
dono do produto (teto opt-in, visível no Deck); a segunda foi só uma decisão de escopo. Nenhuma
das duas era "o plano está ruim, replaneje" no sentido que o teto de cerimônia quer limitar. É
o mesmo defeito E levantado por outro condutor em outras runs.

### A-11 · Run entregue continua "esperando por você" — médio (P7.7)

O único caminho para `completed` é `review` com a Definição de Pronto verde. No hub, uma run
7/7 que nunca passou por `review` (entregue à mão) e uma 8/8 com revisão final FAIL (entregue
mesmo assim) ficaram marcadas "parado, esperando por você" sem prazo para sair. Não há comando
para encerrar uma run registrando o motivo.

### A-12 · Revisão em andamento aparece como parada — baixo (P7.8)

Enquanto o `review` desta run rodava, a lista do hub dizia "parado, esperando por você" e o
cabeçalho "0 em movimento". E a run com revisão FAIL é marcada como esperando por alguém na
lista, mas não gera item na fila "Precisa de você".

### A-13 · Os gates do Deck não rodaram em lugar nenhum — médio (liga com A-05)

A revisão final disse PASS com a ressalva certa: `typecheck:deck` e `test:deck` não estão
entre as validações, e o checkout descartável da revisão não tem `node_modules`, então ela
leu o código mas não pôde rodar os gates. O "FEATURE COMPLETE" saiu com uma parte da mudança
(Deck) verificada só por leitura. Quem conduz precisa rodar à mão — e precisa saber disso,
porque a tela diz "completo".

### A-14 · Falso negativo do classificador: mudança transversal virou `simple` — alto (P7.6)

A run da F7a (resposta a BLOCKED, `revise` que preserva o concluído, emendas, orçamento) mexe em
estado, run-actions, scheduler e prompts. Foi classificada `simple` com a justificativa
*"scoped feature without cross-module architectural risks (styling/isolated UI request)"* — sem
estágio de impacto, sem SDD, no máximo 3 tarefas para 4 itens. É o outro lado do defeito F: a
classe sai de palavras soltas ("Deck", "tela" aparecem no pedido) nos dois sentidos. O
`feature --workflow standard` existe e resolveu, re-entrando com `--from architecture-impact`,
mas nada na saída do `feature` nem no Deck diz que a classe pode ser corrigida, e o motivo
exibido não mostra qual trecho pesou.

### A-15 · Um `timeout` do condutor matou o estágio no meio — baixo (condutor)

Para testar se o `--workflow` era aceito, rodei o `feature` com `timeout 90`: aceitou, começou o
impacto e foi morto aos 90s. Não deixou lixo visível, mas o estágio perdido custou uma rodada. É
erro de quem conduz, registrado porque um produto que aceita a correção de classe como comando de
primeira classe (P7.6) evitaria o experimento.

## Fechamento da execução (medido por quem conduziu, depois do FEATURE COMPLETE)

| Gate | Base (`7306ca8`) | Depois |
|---|---|---|
| lint · typecheck · build | verde | verde |
| `npm run test` | 211 arquivos / 4220 testes + subprocesso 47 / 809 | 214 / 4313 + 48 / 815 |
| `typecheck:deck` | verde | verde (rodado à mão — a run não rodou) |
| `test:deck` | 26 / 231 | 26 / 237 (idem) |

**Controle positivo:** trocando `super.rawMessage({ ...result, stdout: withoutToolInput(...) })`
por `super.rawMessage(result)` (mutação conferida no arquivo), 6 de 20 testes de
`claude-raw-message` e 3 de 6 do teste de disco no lane de subprocesso ficaram vermelhos;
restaurado, 20/20 e 6/6. O teste prova o comportamento, não a intenção.

Execução: quatro tarefas em sequência, ~52 min (11m46s, 10m25s, 17m48s, 12m12s).

## O que funcionou e vale registrar

- **A revisão do plano foi o melhor estágio da run.** Nas três rodadas, cada achado veio com
  `arquivo:linha` conferido no código (o `--from` que ignorava o teto, o contador de tentativas
  incrementado no despacho, a base do NFR-001 gravada tarde demais). Nenhum falso positivo.
- **Uma sugestão minha passou pela revisão e foi derrubada por ela** (dividir o saldo pela
  onda criava pausa sem teto atingido). O gate serve também contra quem conduz.
- **O reparo automático do plano** resolveu a primeira recusa das checagens sem intervenção.
- **O SDD achou o que o pedido não previa:** o `tool_input` também vazaria pelos logs de falha
  e pelo `stage_failed.rawExcerpt`, não só pelo `result.json`.
