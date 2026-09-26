# Agent Flow

[English](README.md) · **Português (BR)**

[![CI](https://github.com/lguilherme44/agent-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/lguilherme44/agent-flow/actions/workflows/ci.yml)

**Um orquestrador local para os agentes de código que você já usa.** O Agent Flow transforma
"implemente esta feature" num fluxo com um portão humano: planeja, manda o plano para revisão,
espera você aprovar, executa as tarefas, valida por conta própria e revisa o resultado. Ele
comanda o Claude Code, o Codex, o AGY ou um endpoint compatível com a OpenAI, e mantém cada
passo na sua máquina.

```text
pedido → análise de impacto → documento de design (SDD) → plano → revisão do plano
       → você aprova (preso a este plano exato)
       → as tarefas rodam, cada uma no seu worktree Git quando o isolamento está ligado
       → o Agent Flow roda seu lint/test/build, não o agente
       → revisão de código por um modelo que não escreveu o código
       → revisão final → Definição de Pronto
```

## Por quê

- **Uma pessoa decide.** Nada é implementado antes de você ler o design e o plano. Revise o
  plano e a aprovação deixa de valer.
- **Pronto é decidido por código.** Plano aprovado, todas as tarefas concluídas, seus gates
  verdes, revisão final PASS. O agente dizer "terminei" não é uma das condições.
- **O agente não corrige a própria prova.** A validação roda depois que o agente sai, e a
  revisão é feita por outro modelo (ou por um contexto novo, quando há um provedor só).
- **Local primeiro.** Estado das runs, artefatos, trilha de auditoria e dashboard ficam na sua
  máquina. Sem plano de controle na nuvem, sem envio de telemetria, sem chave de API para os
  CLIs de código.

## Estado

`v0.1.0`, pré-lançamento, não publicado no npm. Construído e em uso diário: o núcleo de
execução, ondas paralelas em worktrees isolados, recuperação, gates de revisão, o dashboard
Deck, turnos e negações de permissão na telemetria, regras por diretório e entrega no GitHub.
O que vem a seguir — responder uma tarefa bloqueada, progresso ao vivo no dashboard, evals,
sandboxes nativos, entrada por work item — está em
[`docs/platform-roadmap.md`](docs/platform-roadmap.md), com a fila em
[`docs/platform-todo.md`](docs/platform-todo.md). Vêm **desligados** por padrão: execução
paralela, o canal entre agentes e toda escrita remota num forge.

## Requisitos

- **Node 20+** para rodar (Node 22.12+ para desenvolver nele — o executor de testes exige).
- **git** (2.33+ para o isolamento em worktree).
- Pelo menos um CLI de código instalado e logado: **Claude Code**, **Codex** ou **AGY**.
  Opcional: um endpoint compatível com a OpenAI (Ollama, llama.cpp, vLLM) para os estágios de
  planejamento e revisão do plano, que não precisam de acesso a arquivo.

## Instalação

```bash
git clone https://github.com/lguilherme44/agent-flow
cd agent-flow
npm install
npm run install:global     # compila, empacota, instala e confere o binário instalado
```

Depois de `git pull`, rode `npm install && npm run install:global` de novo.

## Primeiros passos

```bash
cd ~/meu-projeto
agent-flow init            # detecta a stack e lê seus scripts reais
agent-flow doctor          # esta máquina consegue rodar?

agent-flow feature "Adicionar agendamentos recorrentes"   # planeja, revisa, para no portão
agent-flow status          # leia o SDD, o plano e a revisão
agent-flow approve
agent-flow run
agent-flow review          # verificação, revisão final, Definição de Pronto

agent-flow ui              # Deck, o dashboard, em http://127.0.0.1:4782
```

Pedidos longos vão num arquivo: `agent-flow feature --file pedido.md`. Um passo a passo com uma
feature de quatro tarefas: [`docs/example-walkthrough.md`](docs/example-walkthrough.md).

## Comandos

| Comando | O que faz |
|---|---|
| `init` · `doctor` | Prepara um repositório · confere o ambiente (`--deep` testa cada runner de verdade) |
| `feature` | Planeja uma feature e para no portão. `--workflow <classe>` corrige a classe de risco; `--grounded` pula o remapeamento do repositório quando o pedido traz a própria investigação |
| `status` | Onde a run está, o que produziu, quanto gastou |
| `approve` · `reject` · `revise` | Abre o portão · encerra a run · replaneja com uma instrução (`--from sdd` reabre o design) |
| `run` · `retry <tarefa>` · `revalidate <tarefa>` | Executa · roda uma tarefa de novo · reconfere uma tarefa que você consertou à mão, sem modelo |
| `review` | Verificação, revisão final e Definição de Pronto |
| `pause` · `resume` · `cancel` | Para de começar trabalho · continua · encerra a run, guardando todo artefato |
| `ui` · `projects` · `autostart` | Dashboard · o hub de projetos · sobe o dashboard no login |
| `clean` | Remove runs antigas e seus worktrees; apaga branch só com `--branches` |

## Configuração

Dois arquivos YAML: `~/.agent-flow/config.yaml` para suas preferências e
`<projeto>/.agent-flow/config.yaml` para o que torna o repositório diferente.

```yaml
# ~/.agent-flow/config.yaml
runners:
  claude: { type: claude-code-cli, enabled: true }
roles:
  planner:       { runner: claude, model: claude-opus-5-5, effort: high }
  executors:
    normal:      { runner: claude, model: claude-opus-5-5, effort: high }
  finalReviewer: { runner: claude, model: claude-opus-5-5, effort: high }
trust:
  projectConfig: [/home/eu/trabalho]   # configs de projeto aqui dentro podem afrouxar permissões
```

```yaml
# <projeto>/.agent-flow/config.yaml
commands:            # rodados pelo Agent Flow, nunca por um agente
  install: npm ci
  lint: npm run lint
  test: npm test
validationCommands:  # gates extras que uma tarefa pode citar
  typecheck-ui: npm run typecheck:ui
worktree:
  copy: [.env.test]  # arquivos ignorados pelo git que o worktree da tarefa precisa (vazio por padrão)
```

- **Fixe o modelo.** Sem `model:`, cada CLI usa o próprio padrão. No Deck, a tela Equipe fixa um
  modelo para todos os papéis.
- **A config do projeto só aperta.** De um diretório que não está em `trust.projectConfig`, um
  projeto não liga `dangerouslySkipPermissions`, não acrescenta `args` que liberam ferramentas,
  não aponta servidores `mcp` nem desliga o portão de aprovação; o `doctor` lista o que ignorou.
- **Deixe o executor rodar comandos.** O Claude Code em modo headless só roda o que for
  permitido: `runners.claude.args: ['--allowedTools', 'Bash(npm run:*)', 'PowerShell(npm run:*)']`
  (no Windows os comandos passam pelo PowerShell, então cada regra vai duas vezes). Vindo da
  config do projeto, isso exige o diretório em `trust.projectConfig`. O `doctor` avisa quando falta.
- **Paralelismo é opcional.** `git.useWorktrees: true` mais `parallelism.maxTasks: N` (até 8)
  roda tarefas independentes ao mesmo tempo, cada uma no seu worktree travado. Custa um checkout
  e um install por tarefa, e suítes inteiras em paralelo disputam a CPU.
- **As regras do repositório** vêm do `AGENTS.md` (ou do `CLAUDE.md`, quando não há), e os
  estágios de implementação e revisão de código também recebem o `AGENTS.md`/`CLAUDE.md`
  aninhado dos diretórios que a tarefa toca.

## Runners

| Runner | `type` | Estágios só-leitura |
|---|---|---|
| Claude Code | `claude-code-cli` | `--permission-mode plan` |
| Codex | `codex-cli` | `-s read-only` |
| AGY (Antigravity) | `agy-cli` | não fica só-leitura; atende papéis de executor |
| Compatível com OpenAI | `openai-compatible` | não tem acesso a arquivo nenhum; só planejamento e revisão do plano |

Um provedor só é uma configuração suportada. Um segundo torna a revisão do plano e a revisão
final entre provedores diferentes. O que cada CLI faz de verdade, medido com o comando que prova:
[`docs/runner-capabilities.md`](docs/runner-capabilities.md).

## Segurança

- Planos citam **ids** de validação, nunca comandos: saída de modelo não chega a um shell.
- Seus hooks do Git nunca rodam dentro de uma operação do Agent Flow, e ele nunca escreve em `git config`.
- Os CLIs de código recebem uma allowlist de ambiente, não o seu shell inteiro. O Claude Code roda
  com suas configurações pessoais e hooks desligados; o Codex e o AGY são isolados só em parte (o
  Codex ainda carrega skills, o AGY ainda carrega seus servidores MCP) — medido em
  `docs/runner-capabilities.md`.
- A contenção durante a execução é a do próprio CLI; o Agent Flow ainda não coloca o processo em
  sandbox (sandboxes nativos estão no roadmap).
- O dashboard escuta em `127.0.0.1` por padrão e recebe ids do navegador, nunca caminhos.

Detalhes e limites declarados: [`docs/security.md`](docs/security.md).

## Documentação

| | |
|---|---|
| [`docs/platform-roadmap.md`](docs/platform-roadmap.md) · [`docs/platform-todo.md`](docs/platform-todo.md) | Para onde o produto vai, e a fila |
| [`docs/roadmap.md`](docs/roadmap.md) | Marcos já construídos (em inglês) |
| [`docs/web-ui.md`](docs/web-ui.md) | O dashboard e sua API HTTP (em inglês) |
| [`docs/runner-capabilities.md`](docs/runner-capabilities.md) | O que cada CLI de código faz de verdade, medido (em inglês) |
| [`docs/security.md`](docs/security.md) | O modelo de confiança e seus limites (em inglês) |
| [`docs/testing.md`](docs/testing.md) | As camadas de teste e o que cada uma prova (em inglês) |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | O que uma mensagem significa e o que fazer (em inglês) |
| [`docs/engineering/`](docs/engineering/) | Relatórios de campo de runs reais, retratações incluídas |

## Desenvolvimento

```bash
npm install
npm run verify           # todo gate exigido localmente
npm run test:fast        # testes que não criam processo
npm run test             # as duas camadas de teste
npm run dev:deck         # o Deck contra um `agent-flow ui` rodando
```

Nenhuma suíte chama um CLI de código de verdade: os runners são testados por saída gravada e pelo
argv exato que montam. O Git nunca é simulado. Antes de um pull request: `npm run verify` verde, e
`test/architecture.test.ts` atualizado, nunca apagado.

## Licença

MIT — veja [`LICENSE`](LICENSE).
