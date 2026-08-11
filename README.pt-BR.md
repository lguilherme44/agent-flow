# Agent Flow

[English](README.md) · **Português (BR)**

[![CI](https://github.com/lguilherme44/agent-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/lguilherme44/agent-flow/actions/workflows/ci.yml)

Transforma um pedido de feature em um documento de design revisado, uma quebra
em tasks, um gate de aprovação humana — e só então em código.

O Agent Flow orquestra as CLIs de código que você já tem instaladas e
autenticadas. O core não sabe que Claude Code ou Codex existem, e não sabe qual
framework você usa. Os papéis são lógicos; quem os executa é decidido por
configuração.

Ainda não está no npm. Instale a partir de um checkout — o pacote é construído,
empacotado e verificado fora dele, então este é o mesmo artefato que um publish
produziria:

```bash
git clone https://github.com/lguilherme44/agent-flow && cd agent-flow
npm install
npm run build && npm run build:web
npm install -g "$(npm pack | tail -1)"
```

Depois, em qualquer repositório:

```bash
cd ~/seu-projeto
agent-flow init
agent-flow doctor

agent-flow feature "Permitir que reservas se repitam semanalmente"
agent-flow status      # leia o SDD e o plano
agent-flow approve
agent-flow run
agent-flow review

agent-flow ui          # ou: agent-flow ui ~/wk   — o workspace inteiro
```

---

## Documentação

Os documentos abaixo estão em inglês.

| | |
|---|---|
| [`docs/web-ui.md`](docs/web-ui.md) | O dashboard: os dois modos, as páginas, o DAG, o que ele muda e o que não muda, a API |
| [`docs/security.md`](docs/security.md) | A fronteira do servidor local — o browser não envia path, comando nem plan hash; symlinks; o lock de run; os limites |
| [`docs/testing.md`](docs/testing.md) | As três camadas de teste e onde cada uma para |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | O que cada mensagem significa e o que fazer |
| [`docs/runner-capabilities.md`](docs/runner-capabilities.md) | O que cada CLI faz de fato, e o comando que comprova |
| [`FINDINGS.md`](FINDINGS.md) | O que construir isto ensinou, incluindo o que segue sem solução |

---

## Por quê

Entregar uma feature a um agente de código costuma produzir algo plausível que
ninguém revisou. O Agent Flow põe estrutura em volta disso:

**Planejamento é separado de execução.** Cada estágio roda em um contexto novo e
recebe apenas os artefatos de que precisa, para que uma premissa errada não
viaje silenciosamente do discovery até o diff.

**Um humano decide.** Nada é implementado antes de você ler o documento de
design e o plano de tasks. A aprovação é vinculada a um plano *específico* —
revise o plano e a aprovação deixa de valer.

**Um modelo não revisa o próprio trabalho.** Configure dois runners e o planner,
o reviewer e o implementador serão providers diferentes. Com um runner só ainda
funciona, degrada para revisão do mesmo provider, e registra isso no artefato.

**Fallback é infraestrutura, nunca correção.** Um runner sem quota, deslogado ou
ausente pode ser contornado. Um modelo que produziu output ruim não — repetir
isso em outro lugar trocaria uma falha visível por uma silenciosa. A regra é
garantida pelo sistema de tipos.

**"Pronto" é decidido por código.** Aprovado, todas as tasks completas, lint e
testes e build passando, final review PASS. Um agente dizer "terminei" não é uma
das condições — e na nossa primeira execução real foi exatamente isso que pegou
um plano ruim.

---

## Requisitos

- Node 20+
- git
- Pelo menos uma CLI de agente, instalada e autenticada:
  [Claude Code](https://claude.com/claude-code) · [Codex CLI](https://github.com/openai/codex)

**Sem API keys.** O Agent Flow invoca as CLIs que você já autenticou. Ele nunca
lê, armazena ou transmite credenciais. Se uma CLI funciona no seu terminal,
funciona aqui.

---

## Comandos

| Comando | |
|---|---|
| `init` | Prepara um repositório. Detecta a stack, lê os scripts que você realmente tem, nunca sobrescreve sem `--force`. |
| `doctor` | Este ambiente consegue trabalhar? Reporta `OK` / `DEGRADED` / `FAIL`. |
| `feature "<descrição>"` | Discovery → impacto → SDD → plano → review. Para no gate. |
| `status` | Onde o run está, o que produziu, o que está degradado. |
| `approve` | Abre o gate. Recusa review reprovado, a menos que `--force`. |
| `reject` · `revise "<instrução>"` | Encerra um run, ou replaneja com orientação. |
| `run` · `task TASK-004` · `retry TASK-004` | Executa o plano aprovado. |
| `review` | Roda a validação, inspeciona o código e o julga contra o SDD. |
| `clean` | Remove estado de runs antigos. Nunca o run ativo sem `--force`. |

`--dry-run` mostra o roteamento sem invocar nada. `--verbose`, `--json` e
`--strict` se comportam como você espera.

---

## Configuração

Dois arquivos: o global guarda suas preferências, o do projeto guarda o que faz
aquele repositório ser diferente.

```yaml
# ~/.agent-flow/config.yaml
roles:
  architect:     { runner: claude, effort: high }
  sdd:           { runner: claude, effort: high }
  planner:       { runner: codex,  effort: high }
  planReviewer:  { runner: claude, effort: high }
  executors:
    trivial:     { runner: codex,  effort: low }
    normal:      { runner: codex,  effort: medium }
    complex:     { runner: codex,  effort: high }
  verification:  { runner: codex,  effort: medium }
  finalReviewer: { runner: claude, effort: very_high }

fallback:
  enabled: true
  on: [quota_exceeded, auth_required, runner_unavailable]
```

`model:` é opcional de propósito — omita e cada CLI usa o modelo que você já
configurou nela. `effort` é lógico (`low` … `very_high`); cada adapter traduz
para o valor que sua CLI aceita.

Os três triggers de fallback acima são os únicos que o schema aceita.

```yaml
# <projeto>/.agent-flow/config.yaml
project: { name: booking-api, type: node }
commands:            # executados pelo Agent Flow, nunca por um agente
  lint: npm run lint
  test: npm test
rules:
  architecture:
    - "Controllers não acessam o banco diretamente"
```

O `init` preenche isso a partir do que o seu repositório de fato declara. Um
comando que ele não encontra fica vazio em vez de ser adivinhado.

---

## Onde as coisas ficam

```
<projeto>/.agent-flow/
├── config.yaml           # versionado — é convenção de time
├── current-run
├── cache/architecture.md # mapa do repositório, reaproveitado entre features
└── runs/AF-2026-001/
    ├── state.json
    ├── events.jsonl      # trilha de auditoria append-only
    ├── sdd.md
    ├── plan.json
    ├── reviews/ tasks/ logs/
```

Tudo que tem conteúdo vive dentro de um run, então duas features em andamento
não se sobrescrevem.

---

## Estado atual

O MVP 1 está completo e já rodou de ponta a ponta contra Claude Code e Codex.
A suíte não invoca nenhuma CLI: todo runner é fake, então rodar não custa nada e
não prova nada sobre as CLIs em si. O que ela prova está em `FINDINGS.md` — e o
que ela não prova também. O badge acima é a contagem e o resultado atuais; um
número escrito aqui não seria nenhum dos dois por muito tempo.

### Funcionando

- [x] CLI, resolução de configuração, papéis lógicos, abstração de reasoning
- [x] `ClaudeCodeRunner`, `CodexRunner`, modelo de capabilities, normalização de erros
- [x] Fallback restrito a falhas de infraestrutura, garantido pelo sistema de tipos
- [x] `doctor` com saúde ternária calculada sobre rotas de papel
- [x] `init` com detecção de stack para Node, Flutter, Python, Go e Rust
- [x] Discovery → impacto de arquitetura → SDD → plano, com checkpoint por estágio
- [x] Checagens de cobertura e de grafo de dependências como código, antes de qualquer reviewer
- [x] Plan review cross-provider, com a independência registrada no artefato
- [x] Gate de aprovação vinculado ao hash do plano
- [x] Router determinístico, scheduler DAG, task executor, resume e retry
- [x] Comandos de verificação executados pelo orquestrador, não por um agente
- [x] Final review e Definition of Done avaliados como código
- [x] `review --fix` — findings viram tasks no plano e reentram no pipeline
- [x] Rodadas corretivas revisadas por si mesmas, então o loop não precisa de `--force`
- [x] `doctor --deep` — probe real por runner, dobrado de volta no veredito
- [x] Telemetria local, derivada do próprio state e event log do run
- [x] `agent-flow ui` — servidor local e dashboard (spec §59–§102)
- [x] Sete páginas: run detail, runs, projects, agents & models, prompts, analytics, settings
- [x] Ações de escrita — approve, reject, revise, retry, start — como um único conjunto
      de use cases sobre o qual a CLI e a API HTTP são apenas adapters
- [x] Lock de run inter-processo: a CLI e o servidor local não conseguem escalonar o
      mesmo run ao mesmo tempo, provado com oito processos reais disputando um lock —
      e com um stress opt-in de 640 (`AF_LOCK_STRESS=1`), porque uma race é um teste
      que tem de passar com frequência, não uma vez
- [x] Grafo de dependências — as arestas do plano, ranqueadas e desenhadas a partir da
      resposta do servidor, nunca reconstruídas no browser
- [x] Workspace mode — `agent-flow ui ~/wk` serve vários projetos, limitado por
      `ui.workspaceDepth`, e não descobre nada que resolva fora da raiz
- [x] Estados vazio, de erro e degradado — o que aconteceu, onde, se o run parou, e o
      que fazer a respeito
- [x] E2E determinístico de browser — dezesseis cenários atravessando o servidor local
      real, sem stub nenhum; a CLI de código é substituída na fronteira do executável,
      então nenhuma quota é gasta e os dois adapters reais continuam fazendo o parsing
- [x] Regressão visual em CI, com baselines Linux, em container fixado — e uma suíte
      que não consegue adotar um preview velho
- [x] Containment de workspace cross-platform, com as regras de Windows verificadas no Linux
- [x] Empacotamento provado fora do checkout: `npm pack`, install limpo em um prefix
      descartável, e o servidor empacotado dirigido com o bundle do checkout escondido
      — mais uma jornada black-box de browser contra o tarball instalado

### Incompleto

- [ ] `PATCH /config` — desenhado em
      [`docs/config-write-design.md`](docs/config-write-design.md), não construído.
      O escopo precisa fazer parte do endereço, ou um save edita a camada errada
      em silêncio
- [ ] `pause`, `resume`, `cancel` — desenhados em
      [`docs/pause-resume-cancel-design.md`](docs/pause-resume-cancel-design.md),
      não construídos. Pause precisa de um sinal de abort que o scheduler consulte
      entre tasks; cancel precisa de um novo status terminal de run, o que é mudança
      de contrato

### Validado de ponta a ponta, contra CLIs reais

Um repositório Node e um Python rodaram o fluxo inteiro — plano, review
cross-provider, aprovação, implementação, verificação, final review, Definition
of Done. O run Python chegou a `FEATURE COMPLETE` depois de uma rodada
corretiva: o final review reprovou, o `--fix` transformou os findings em tasks,
e os testes que essas tasks produziram matam as mutações correspondentes.
O `FINDINGS.md` §10–§13 registra o que isso revelou, incluindo um defeito em que
o prompt podia definir o código de erro do runner.

### Ainda não validado

- [ ] Repositórios Flutter, Go ou Rust (detecção de stack só tem teste unitário)
- [ ] Fallback e clamp de reasoning contra uma CLI real
- [ ] Custo entre modelos e tamanhos de repositório
- [ ] Windows. O containment de path já usa `node:path` e as regras de Windows são
      verificadas com `path.win32`, mas nenhum job de CI roda lá e o timeout de
      processo ainda não consegue sinalizar uma árvore de processos nessa plataforma

### Limitações conhecidas

Não é roadmap — é o que é verdade hoje.

- **Sem `pause`, `resume` ou `cancel`.** O core não tem semântica para nenhum deles.
- **Sem escrita de configuração.** `/settings` só lê. Decidir em qual das três camadas
  um valor mora é o problema inteiro.
- **Só local.** Loopback por padrão, sem autenticação, sem cloud, sem auth remota.
  Quem alcança a porta pode aprovar um plano e iniciar um run.
- **Baselines visuais são por plataforma.** Os conjuntos darwin e Linux são ambos
  versionados e nunca comparados entre si; a rasterização de fontes difere.
- **Um claim de lock pode ficar ilegível sob contenção.** A exclusão mútua não é
  afetada, mas a recusa passa a dizer que o claim não pôde ser lido em vez de nomear
  quem o detém. Adiado deliberadamente — veja [`FINDINGS.md`](FINDINGS.md).

### Defeitos conhecidos — revisão de validação

Uma revisão estruturada após o MVP 1 confirmou 17 findings. Os doze defeitos de
código estão corrigidos; cada reprodução foi invertida e movida para a suíte da
funcionalidade correspondente.

- [x] **V-01 · crítico** — strings geradas pelo planner chegam ao `/bin/sh -c`; sem allowlist → **corrigido:** `validation` guarda ids resolvidos pela config do projeto
- [x] **V-09 · alto** — o timeout de processo nunca dispara quando o filho tem filhos → **corrigido:** o filho roda no próprio process group
- [x] **V-02 · alto** — `FallbackRunner` nunca é construído em runtime → **corrigido:** ligado via `runner-factory`, resolvendo model e effort da própria role de fallback
- [x] **V-03 · alto** — uma task interrompida no meio fica `running` para sempre → **corrigido:** recuperada como `interrupted` e reenfileirada dentro do limite de tentativas
- [x] **V-04 · alto** — planos test-first não conseguem expressar falha esperada → **corrigido:** `validationExpectation: pass | fail | none`
- [x] **V-05 · médio** — `agent-flow task` monta um grafo sem as dependências → **corrigido:** o grafo fica inteiro, a execução é que é restrita
- [x] **V-06 · médio** — `result.json` grava um reasoning level hardcoded → **corrigido:** a proveniência vem de quem executou de fato
- [x] **V-07 · médio** — o cache de discovery é reusado sem invalidação → **corrigido:** fingerprint de HEAD, working tree, AGENTS.md e config
- [x] **V-08 · médio** — comandos de validação rodam duas vezes, uma delas pelo agente → **corrigido:** o prompt diz que o Agent Flow é o dono da execução
- [x] **V-10/11/12 · baixo** — `approvedAt` gravado, metadata morta de role removida, textos da CLI corrigidos

Veja [FINDINGS §8](FINDINGS.md#8-a-structured-review-found-things-the-build-did-not).

### Próximos passos

- [ ] Git worktrees para isolamento de tasks
- [ ] Execução paralela — o scheduler já roda com concorrência > 1
- [ ] Escalonamento de modelo após falhas repetidas
- [ ] Workspaces de monorepo

---

## Descobertas

O [`FINDINGS.md`](FINDINGS.md) documenta o que construir isto ensinou sobre
dirigir CLIs de código a partir de um programa — incluindo os problemas ainda
não resolvidos. O documento está em inglês; em resumo:

- Cada CLI tem seu próprio dialeto de JSON Schema, e eles são mutuamente incompatíveis
- Nenhuma das CLIs valida a flag de reasoning; um mapeamento errado é invisível
- Casar texto do output do modelo cedo ou tarde classifica um sucesso como falha
- O modo read-only é real, mas "read-only" não significa "não escreve em lugar nenhum"

O [`docs/runner-capabilities.md`](docs/runner-capabilities.md) registra o que
cada CLI de fato faz, com o comando que comprova cada afirmação e a versão em
que foi testada.

---

## Desenvolvimento

```bash
npm install
npm run build          # o bundle da CLI
npm run build:web      # o bundle do dashboard
npm run check          # typecheck + lint + Vitest + testes unitários do dashboard

npm run dev:web        # dashboard contra um `agent-flow ui` rodando
```

Três camadas de teste, respondendo três perguntas diferentes — e nenhuma delas é
uma versão mais barata de outra:

```bash
npm run test:e2e                # Playwright, atravessando o servidor local real
npm run test:visual             # Playwright, screenshots (baselines desta plataforma)
npm run test:packaging          # pack, install em outro lugar, dirige o produto instalado
npm run test:packaging:browser  # o mesmo, via gsd-browser
```

O [`docs/testing.md`](docs/testing.md) explica o que cada uma prova e o que não
prova — inclusive por que o smoke do gsd-browser não substitui o Playwright e por
que ele roda local em vez de no CI.

A suíte nunca invoca uma CLI real. Os runners são exercitados por um
`AgentRunner` roteirizado; os adapters são testados verificando o argv exato que
constroem, mais o parsing de saídas gravadas das ferramentas reais. É isso que
mantém a suíte rápida, gratuita e executável em CI.

As regras de arquitetura são executáveis (`test/architecture.test.ts`):

- `src/core/` não importa nada do Node nem adapters
- `src/core/` não menciona provider, modelo ou nome de CLI
- nenhum nome de framework aparece em `src/` fora da detecção de stack
- ordenação topológica existe em exatamente um módulo
- nenhum contrato de request aceita path de filesystem, comando ou plan hash
- existe um único project registry e um único lock de execução
- nenhum E2E de browser intercepta `/api/**`

As baselines visuais são por plataforma, porque a rasterização de fontes é:
`desktop-1440-darwin` vem da máquina de um mantenedor, `desktop-1440-linux` do
container Playwright fixado em que o CI compara. Regenere o conjunto Linux só
nesse container:

```bash
npm run test:visual:linux    # docker, imagem fixada
npm run test:visual:update   # esta plataforma
```

---

## Contenção

Estágios read-only rodam sob o sandbox da própria CLI — `--permission-mode plan`
no Claude Code, `-s read-only` no Codex. O Agent Flow nunca passa as flags que
desativam isso.

Sendo preciso sobre o limite: o Agent Flow spawna a CLI como processo filho e
não consegue interceptar o que aquele processo executa. A contenção é do runner,
não nossa. Qualquer coisa mais forte que isso exige um container.

O [`docs/security.md`](docs/security.md) cobre o servidor local: por que o browser
nunca envia path, comando ou plan hash, como funciona o containment de symlink, e o
que não ter autenticação significa e não significa.

---

## Licença

MIT
