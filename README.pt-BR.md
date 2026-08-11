# Agent Flow

[English](README.md) · **Português (BR)**

[![CI](https://github.com/lguilherme44/agent-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/lguilherme44/agent-flow/actions/workflows/ci.yml)

**Orquestração local-first para agentes de código.**

O Agent Flow transforma um pedido de feature em um documento de design revisado,
uma quebra em tasks e um gate de aprovação humana — e só então em código. Ele
dirige as CLIs de código que você já tem instaladas e autenticadas; nada aqui
conversa com uma API de modelo.

```text
pedido de feature
  → discovery
  → análise de arquitetura
  → SDD
  → planejamento
  → plan review independente
  → aprovação humana        ← vinculada a um plan hash exato
  → implementação
  → validação determinística ← executada pelo orquestrador, nunca por um agente
  → final review
  → Definition of Done
```

O core não sabe que Claude Code ou Codex existem, e não sabe qual framework você
usa. Os papéis são lógicos (`architect`, `sdd`, `planner`, `planReviewer`, três
`executors`, `verification`, `finalReviewer`); a configuração decide qual runner
e qual nível de effort atende cada um. Claude Code e Codex são os dois adapters
que existem hoje.

Tudo é local: o estado do run, os artefatos, a trilha de auditoria e o dashboard.
Não existe control plane em cloud, não existe envio de telemetria e não existe
API key.

**Estado:** `v0.1.0` · Spec v3 completa · não publicado no npm.
Veja [Estado atual](#estado-atual) para o quadro completo.

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

## Instalação

Ainda não está no npm. Instale a partir de um checkout — o pacote é construído,
empacotado e verificado fora dele, então este é o mesmo artefato que um publish
produziria:

```bash
git clone https://github.com/lguilherme44/agent-flow
cd agent-flow

npm install
npm run build
npm run build:web

npm install -g "$(npm pack | tail -1)"
```

## Primeiros passos

```bash
cd ~/meu-projeto

agent-flow init          # detecta a stack, lê os scripts que você realmente tem
agent-flow doctor        # este ambiente consegue trabalhar?

agent-flow feature "Permitir reservas recorrentes"
agent-flow status        # leia o SDD e o plano
agent-flow approve       # o gate — vinculado a este plano, não ao próximo
agent-flow run
agent-flow review

agent-flow ui            # o dashboard local em 127.0.0.1:4782
```

Um dashboard sobre vários repositórios:

```bash
agent-flow ui ~/wk
```

---

## Documentação

Os documentos abaixo estão em inglês.

**Produto**

| | |
|---|---|
| [`docs/web-ui.md`](docs/web-ui.md) | O dashboard: os dois modos, as páginas, o DAG, os eventos ao vivo, o que ele muda e o que não muda, a API HTTP |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | O que cada mensagem significa e o que fazer a respeito |

**Arquitetura e engenharia**

| | |
|---|---|
| [`docs/security.md`](docs/security.md) | A fronteira do servidor local — o browser não envia path, comando nem plan hash; containment de symlink; o lock de run; os limites |
| [`docs/testing.md`](docs/testing.md) | As camadas de teste, o que cada uma prova e onde cada uma para |
| [`docs/runner-capabilities.md`](docs/runner-capabilities.md) | O que cada CLI faz de fato, com o comando que comprova e a versão em que foi testada |
| [`docs/engineering/findings.md`](docs/engineering/findings.md) | Log de engenharia: o que construir isto ensinou, incluindo o que segue sem solução |

**Especificação** — o que foi desenhado e entregue, mantido como foi escrito

| | |
|---|---|
| [`docs/specs/implementation-spec-v3.md`](docs/specs/implementation-spec-v3.md) | Implementation Spec v3, completa. Documento histórico; o código é a verdade atual |

**Revisões técnicas** — snapshots, não documentos vivos

| | |
|---|---|
| [`docs/reviews/validation-review.md`](docs/reviews/validation-review.md) | Revisão estruturada de validação da primeira implementação completa |
| [`docs/reviews/reanalysis-post-fixes.md`](docs/reviews/reanalysis-post-fixes.md) | Reanálise depois que aquelas correções entraram |

**Designs, não implementações** — escritos e deliberadamente não construídos

| | |
|---|---|
| [`docs/config-write-design.md`](docs/config-write-design.md) | `PATCH /config`: por que o escopo precisa fazer parte do endereço |
| [`docs/pause-resume-cancel-design.md`](docs/pause-resume-cancel-design.md) | `pause` / `resume` / `cancel`: o sinal de abort e a mudança de contrato que exigem |

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

## Comandos

| Comando | |
|---|---|
| `init` | Prepara um repositório. Detecta a stack, lê os scripts que você realmente tem, nunca sobrescreve sem `--force`. |
| `doctor` | Este ambiente consegue trabalhar? Reporta `OK` / `DEGRADED` / `FAIL`. `--deep` faz um probe real em cada runner, o que gasta quota. |
| `feature "<descrição>"` | Discovery → impacto → SDD → plano → review. Para no gate. |
| `status` | Onde o run está, o que produziu, o que está degradado. |
| `approve` | Abre o gate. Recusa review reprovado, a menos que `--force`. |
| `reject` · `revise "<instrução>"` | Encerra um run, ou replaneja com orientação. |
| `run` · `task TASK-004` · `retry TASK-004` | Executa o plano aprovado. |
| `review` | Roda a validação, inspeciona o código e o julga contra o SDD. `--fix` transforma os findings em tasks e revisa o plano corrigido. |
| `ui [root]` | Serve o dashboard local em `127.0.0.1:4782`. Com um diretório, serve todo repositório inicializado abaixo dele como workspace. Approve, revise, retry e run passam pelos mesmos use cases que esta CLI usa — veja [`docs/web-ui.md`](docs/web-ui.md). |
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

```text
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
não se sobrescrevem. O resultado de cada task registra o runner, o modelo e o
effort que de fato atenderam a chamada, não os que a configuração pediu.

---

## Estado atual

```text
versão:    v0.1.0
Spec v3:   completa
npm:       não publicado
MVP 2:     não iniciado
```

A Implementation Spec v3 está encerrada: o fluxo de CLI, o Web Control Plane
local e os gates de teste dos dois estão dentro. Ainda não existe release no
GitHub nem pacote no npm — as instruções de instalação acima são o único caminho
suportado.

A suíte Vitest não invoca nenhuma CLI: todo runner é fake, então rodar não custa
nada e não prova nada sobre as CLIs em si. O que ela prova está em
[`docs/engineering/findings.md`](docs/engineering/findings.md) — e o que ela não
prova também. O badge acima é o resultado atual; um número escrito aqui não
seria atual por muito tempo.

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
- [x] Sete páginas em oito rotas — run detail, runs, projects, agents & models,
      prompts, analytics, settings; `/dashboard` renderiza a view de run detail do
      run que mais precisa de você
- [x] Atualização ao vivo por SSE, com polling como fallback documentado em vez de
      comportamento padrão
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

### Desenhado, não construído

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
O [Findings §10–§13](docs/engineering/findings.md) registra o que isso revelou,
incluindo um defeito em que o prompt podia definir o código de erro do runner.

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
- **Só local.** Loopback por padrão, sem autenticação, sem control plane em cloud, sem
  auth remota. Quem alcança a porta pode aprovar um plano e iniciar um run.
- **Fora do npm.** Não existe pacote publicado nem release no GitHub; instale a partir
  de um checkout.
- **Sem job de CI no Windows**, e no Windows o timeout de processo não consegue sinalizar
  uma árvore de processos, então uma CLI que spawna filhos pode sobreviver ao timeout.
- **Baselines visuais são por plataforma.** Os conjuntos darwin e Linux são ambos
  versionados e nunca comparados entre si; a rasterização de fontes difere.
- **Um claim de lock pode ficar ilegível sob contenção.** A exclusão mútua não é
  afetada, mas a recusa passa a dizer que o claim não pôde ser lido em vez de nomear
  quem o detém. Adiado deliberadamente — veja
  [`docs/engineering/findings.md`](docs/engineering/findings.md).

### Defeitos conhecidos — revisão de validação

Uma revisão estruturada da primeira implementação completa confirmou 17 findings.
Os doze defeitos de código estão corrigidos; cada reprodução foi invertida e movida
para a suíte da funcionalidade correspondente. A revisão está preservada como foi
escrita, em [`docs/reviews/validation-review.md`](docs/reviews/validation-review.md),
com a reanálise em
[`docs/reviews/reanalysis-post-fixes.md`](docs/reviews/reanalysis-post-fixes.md).

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

Veja [Findings §8](docs/engineering/findings.md#8-a-structured-review-found-things-the-build-did-not).

### Próximos passos

Não iniciados. Listados para deixar visível onde a Spec v3 termina, não como
compromisso.

- [ ] Git worktrees para isolamento de tasks
- [ ] Execução paralela — o scheduler já roda com concorrência > 1
- [ ] Escalonamento de modelo após falhas repetidas
- [ ] Workspaces de monorepo

---

## O que construir isto ensinou

O [`docs/engineering/findings.md`](docs/engineering/findings.md) documenta o que
dirigir CLIs de código a partir de um programa realmente exige — incluindo os
problemas ainda não resolvidos. O documento está em inglês; em resumo:

- Cada CLI tem seu próprio dialeto de JSON Schema, e eles são mutuamente incompatíveis
- Nenhuma das CLIs valida a flag de reasoning; um mapeamento errado é invisível
- Casar texto do output do modelo cedo ou tarde classifica um sucesso como falha
- O modo read-only é real, mas "read-only" não significa "não escreve em lugar nenhum"
- Um dialog modal do Radix devolve o foco para um `Dialog.Trigger` — e para lugar
  nenhum quando não existe um; aqui todo dialog fornece o próprio retorno de foco

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

Depois do build, a CLI roda do próprio checkout como `node dist/bin/agent-flow.js`,
ou faça `npm link` e use `agent-flow` como documentado acima.

Mais três camadas de teste, respondendo três perguntas diferentes — e nenhuma
delas é uma versão mais barata de outra:

```bash
npm run test:e2e                # Playwright, atravessando o servidor local real
npm run test:visual             # Playwright, screenshots (baselines desta plataforma)
npm run test:packaging          # pack, install em outro lugar, dirige o produto instalado
npm run test:packaging:browser  # o mesmo, via gsd-browser
```

O [`docs/testing.md`](docs/testing.md) explica o que cada uma prova e o que não
prova — inclusive por que o smoke do gsd-browser não substitui o Playwright e por
que ele roda local em vez de no CI.

Nenhuma suíte invoca uma CLI real. Os runners são exercitados por um
`AgentRunner` roteirizado; os adapters são testados verificando o argv exato que
constroem e fazendo o parsing de saídas gravadas das ferramentas — os dois casos
que não deu para provocar sob demanda estão marcados como `SYNTHETIC-` em
`test/fixtures/`. É isso que mantém a suíte rápida, gratuita e executável em CI.

As regras de arquitetura são executáveis (`test/architecture.test.ts`):

- `src/core/` não importa nada do Node nem adapters
- `src/core/` não menciona provider, modelo ou nome de CLI
- nenhum nome de framework aparece em `src/` fora da detecção de stack
- ordenação topológica existe em exatamente um módulo
- o lado do core nunca importa o servidor; o servidor nunca importa a CLI
- nenhum módulo do servidor nomeia arquivo de auth nem lê o environment
- nenhum contrato de request aceita path de filesystem, comando ou plan hash
- existe um único project registry e um único lock de execução
- nenhum E2E de browser intercepta `/api/**`

O layout do dashboard é verificado por screenshot contra
[`docs/assets/agent-flow-ui-reference.png`](docs/assets/agent-flow-ui-reference.png),
em 1440, 1280, 1200 e 1024 — os dois últimos são os lados da fronteira em que o
inspector deixa de dividir a linha com a tabela e passa a ser um drawer. API
stubada, clock fixado, locale e timezone fixos.

As baselines visuais são por plataforma, porque a rasterização de fontes é:
`desktop-1440-darwin` vem da máquina de um mantenedor, `desktop-1440-linux` do
container Playwright fixado em que o CI compara. Regenere o conjunto Linux só
nesse container:

```bash
npm run test:visual:linux    # docker, imagem fixada
npm run test:visual:update   # esta plataforma
```

O CI roda o `check` no Node 20 e 22, o E2E de browser e a suíte de screenshots no
container fixado, e a cobertura como relatório em vez de gate. Os smokes de
empacotamento rodam localmente.

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

MIT — veja [`LICENSE`](LICENSE).
