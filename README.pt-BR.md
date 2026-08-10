# Agent Flow

[English](README.md) · **Português (BR)**

Transforma um pedido de feature em um documento de design revisado, uma quebra
em tasks, um gate de aprovação humana — e só então em código.

O Agent Flow orquestra as CLIs de código que você já tem instaladas e
autenticadas. O core não sabe que Claude Code ou Codex existem, e não sabe qual
framework você usa. Os papéis são lógicos; quem os executa é decidido por
configuração.

```bash
npm install -g agent-flow

cd ~/seu-projeto
agent-flow init
agent-flow doctor

agent-flow feature "Permitir que reservas se repitam semanalmente"
agent-flow status      # leia o SDD e o plano
agent-flow approve
agent-flow run
agent-flow review
```

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
552 testes, e a suíte não invoca nenhuma CLI.

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

### Incompleto

- [ ] `doctor --deep` — probe real de autenticação (hoje apenas avisa que não está implementado)
- [ ] `review --fix` — gera as tasks corretivas, mas não as reinjeta no pipeline
- [ ] Telemetria local — o schema existe, nada escreve nele
- [ ] Planos test-first — veja [FINDINGS §7](FINDINGS.md#7-the-tool-caught-a-contradiction-three-reviews-had-missed)

### Ainda não validado

- [ ] Verification e final review contra uma CLI real (só cobertos por testes)
- [ ] Qualquer stack além de Node
- [ ] Custo entre modelos e tamanhos de repositório

### Defeitos conhecidos — revisão de validação

Uma revisão estruturada após o MVP 1 confirmou 17 findings, reproduzidos em
[`test/validation-review.repro.test.ts`](test/validation-review.repro.test.ts).
Ordem de correção e severidade:

- [ ] **V-01 · crítico** — strings geradas pelo planner chegam ao `/bin/sh -c`; sem allowlist
- [ ] **V-09 · alto** — o timeout de processo nunca dispara quando o filho tem filhos
- [ ] **V-02 · alto** — `FallbackRunner` nunca é construído em runtime
- [ ] **V-03 · alto** — uma task interrompida no meio fica `running` para sempre
- [ ] **V-04 · alto** — planos test-first não conseguem expressar falha esperada
- [ ] **V-05 · médio** — `agent-flow task` monta um grafo sem as dependências
- [ ] **V-06 · médio** — `result.json` grava um reasoning level hardcoded
- [ ] **V-07 · médio** — o cache de discovery é reusado sem invalidação
- [ ] **V-08 · médio** — comandos de validação rodam duas vezes, uma delas pelo agente
- [ ] **V-10/11/12 · baixo** — `approvedAt` não gravado, metadata de role do prompt sem uso, textos desatualizados

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
npm run check    # typecheck + lint + test
npm run build
```

A suíte nunca invoca uma CLI real. Os runners são exercitados por um
`AgentRunner` roteirizado; os adapters são testados verificando o argv exato que
constroem, mais o parsing de saídas gravadas das ferramentas reais. É isso que
mantém a suíte rápida, gratuita e executável em CI.

As regras de arquitetura são executáveis (`test/architecture.test.ts`):

- `src/core/` não importa nada do Node nem adapters
- `src/core/` não menciona provider, modelo ou nome de CLI
- nenhum nome de framework aparece em `src/` fora da detecção de stack
- ordenação topológica existe em exatamente um módulo

---

## Contenção

Estágios read-only rodam sob o sandbox da própria CLI — `--permission-mode plan`
no Claude Code, `-s read-only` no Codex. O Agent Flow nunca passa as flags que
desativam isso.

Sendo preciso sobre o limite: o Agent Flow spawna a CLI como processo filho e
não consegue interceptar o que aquele processo executa. A contenção é do runner,
não nossa. Qualquer coisa mais forte que isso exige um container.

---

## Licença

MIT
