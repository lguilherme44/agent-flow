# Field report — 22/09/2026, fix de incidente num monorepo Flutter

> **Estado em 22/09/2026, fim da sessão.** D-1, D-5 (parte), D-6, D-9 e o problema de
> idioma foram **corrigidos nesta mesma sessão**, com teste, controle positivo e a suíte
> inteira verde (206 arquivos, 4152 testes). O que continua aberto está marcado
> **ABERTO** no título. O relato de cada defeito foi mantido como foi medido, porque o
> valor dele está em *como* apareceu, não só em que foi consertado.
>
> | Defeito | Estado |
> |---|---|
> | D-1 classificador casa substring | ✅ corrigido (`adaptive-workflow.ts`) |
> | D-2 `request.md` acumula | ABERTO |
> | D-3 UI exige Node ≥ 20.19 | ABERTO (contorno: rodar o `dist` no Node 22) |
> | D-4 `init` detecta comando inexistente | ABERTO |
> | D-5 `cancel` sai com exit 0 | ❌ **RETIRADO** — não existe; erro de medição meu |
> | D-6 gates de validação inconsistentes entre runs | ABERTO (reformulado — ver correção) |
> | D-7 `revise` inalcançável | ✅ resolvido por consequência de D-1 |
> | D-8 tarefa de verificação sem validação | ABERTO |
> | D-9 executor não roda comando | ✅ diagnosticado pelo `doctor` (`diagnostics.ts`) |
> | D-10 `revise` não re-especifica o SDD | ✅ corrigido — `revise --from sdd` |
> | D-11 orçamento de cerimônia: 1 reparo só | ABERTO (comportamento correto, limite conhecido) |
> | D-12 gate `fail` não distingue sucesso de fracasso | ABERTO |
> | `single_provider` pune quem tem um provedor só | ✅ corrigido (`health.ts`) |
> | Idioma: saída do modelo e `doctor` em inglês | ✅ corrigido (`config.language`) |

Uso real do agent-flow para planejar o fix de um incidente real
num app Flutter que embute um produto web: a WebView não abre o seletor de
arquivo no Android. Worktree isolada sobre `release/6.68.0`, runner `claude`, todos os
papéis pinados em `claude-opus-5`.

**O que funcionou muito bem está no fim.** Os defeitos vêm primeiro porque são o que dá
para consertar.

---

## D-1 · ✅ CORRIGIDO · O classificador casava substring, não palavra — e o repo armava o gatilho

**Severidade: alta.** É o defeito que travou a sessão duas vezes e custou um run inteiro.

`src/core/adaptive-workflow.ts:157-186`, regra de "fatos determinísticos do repositório":

```ts
if (lowerFile.includes('migration') || lowerFile.includes('db/migrations') || …) {
  if (normalized.includes('db') || normalized.includes('table') ||
      normalized.includes('database') || normalized.includes('schema')) {
    detectedHighRisk.push('migration (file: ' + file + ')');
  }
}
```

Duas metades, ambas problemáticas neste repo:

1. **A metade do arquivo é permanente.** Existe
   `lib/src/features/migration_partner/…` — onde "migration" é o domínio do produto
   (o usuário *migrado* de uma loja para a outra), não migração de banco. A
   condição de path é verdadeira para **qualquer** feature deste repositório, para sempre.

2. **A metade do texto é `includes`, não `\b…\b`.** Então dispara em palavras que não têm
   nada a ver com dados. Exemplos reais que eu escrevi sem perceber, todos neste caso:

   | Palavra escrita | Substring que casa |
   |---|---|
   | `unselec**table**` | `table` |
   | `accep**table**` | `table` |
   | `sui**table**`, `por**table**`, `immu**table**` | `table` |

   Note o contraste com a detecção por texto logo acima (`:151-155`), que usa
   `new RegExp('\\b' + signal + '\\b')` — correta. As duas convivem no mesmo arquivo com
   critérios diferentes, e a errada é a que tem a condição de path sempre ligada.

**Impacto composto:** ao ser elevado a `high-risk`, o run bate em
`unreviewableHighRisk` (`src/app/run-git-identity.ts:1099`) e é **recusado**, porque
`planner` e `planReviewer` resolvem para o mesmo provider. Numa configuração de um provider
só — que é a configuração default de quem tem uma assinatura — a combinação D-1 + portão
torna o repositório **impossível de planejar**, por causa de um nome de diretório.

`--workflow standard` não resolve: `adaptive-workflow.ts:191` recusa o rebaixamento
justamente quando há sinal detectado. Correto como invariante, mas aqui protege um falso
positivo.

### Correção aplicada

Duas funções pequenas em `src/core/adaptive-workflow.ts`, e a segunda é a que importa:

- `mentionsWord` — casa `\b…\b`, como a detecção por texto logo acima já fazia. Duas formas
  de responder a mesma pergunta era o defeito; agora há uma.
- `pathNamesConcern` — o caminho precisa **se chamar** daquilo: um segmento de diretório
  igual ao termo, o nome do arquivo sem extensão, ou um segmento começando `termo.` (que é
  como `auth.config.ts` se declara). Para migração, `migrations/` ou `*.sql`.

Coberto por um teste com **dois controles positivos que isolam cada metade** — e o controle
pegou uma fraqueza no primeiro teste que escrevi: ele continuava verde com o matcher de
palavra revertido, porque o caso de prosa usava um path que o fix de caminho já barrava.
Sem isolar, eu teria afirmado que provava as duas metades provando uma.

**Ainda vale fazer:** registrar no evento `workflow_classified` **qual arquivo** casou.
Hoje o `rationale` diz só `migration`, sem dizer que veio de fato de repositório nem de
qual path — levei uma leitura do fonte para descobrir, e o rationale sozinho mandava editar
a descrição, que era o lugar errado.

---

## D-2 · `request.md` acumula, então o operador perde o controle do texto classificado

**Severidade: alta** — é o que tornou D-1 irrecuperável.

Cada `revise` anexa a instrução ao `request.md` do run, e o `plan-review` também deposita
seus achados ali. O classificador roda sobre esse corpo acumulado.

Consequência concreta desta sessão: a **própria revisão automática** escreveu "lookup
table" e "mapper table" nos achados. No `revise` seguinte, esse texto — gerado pela
ferramenta, não por mim — disparou D-1. Eu limpei minha instrução duas vezes e o run
continuou sendo recusado, porque a palavra estava num trecho que eu não podia editar.

**O caminho de recuperação não é óbvio:** foi abrir um run **novo** com uma descrição
reescrita à mão contendo os achados. Funcionou porque o cache de discovery sobreviveu
(`head` + `agentsMd` + `projectConfig` inalterados), então os US$ 19 do estágio caro não
foram pagos de novo — mas isso foi sorte de fingerprint, não um caminho que a ferramenta
ofereça.

### Sugestão

Classificar apenas o **pedido original do operador**, ou no máximo o pedido + instruções de
revisão — nunca texto gerado por um estágio. Uma classificação que muda por causa da saída
de um estágio anterior não é determinística em relação ao que o operador pediu.

---

## D-3 · `agent-flow ui` não sobe no Node 20.10 (ERR_REQUIRE_ESM)

**Severidade: média.** Falha fechada, com mensagem clara, mas nada em `doctor` avisa antes.

```
ERR_REQUIRE_ESM: require() of ES Module …/content-disposition/dist/index.js
from …/@fastify/static/index.js not supported
```

`@fastify/static@10` declara `content-disposition: ^3.0.0`, que é `"type": "module"`.
`require()` de ESM só funciona a partir do **Node 20.19**. Contornei rodando só a UI com o
binário do Node 22 — trocar o Node global não era opção, porque outros repos do ecossistema
quebram nele.

### Sugestão

Declarar `engines.node` no `package.json` e checar em `doctor`. Hoje `doctor` diz
"OK — nothing here blocks a run" e a UI está quebrada.

---

## D-4 · `init` detecta comandos que não existem na máquina

**Severidade: média**, e silenciosa — que é o pior tipo.

`init` detectou `flutter` e escreveu:

```yaml
commands:
  install: flutter pub get
  lint:    flutter analyze
  test:    flutter test
```

Não existe `flutter` no PATH desta máquina: o projeto usa **fvm** (`.fvmrc` na raiz, versão
3.38.6 fixada). Todo comando de validação sairia com exit 127. Um estágio de verificação
lendo 127 não distingue "repositório quebrado" de "comando inexistente" — e o run inteiro
teria concluído que a base está vermelha.

### Sugestão

`init` já lê o repositório para detectar a stack; ler `.fvmrc` / `.tool-versions` /
`.nvmrc` é o mesmo gesto. Alternativa mínima: `init` executar cada comando detectado uma
vez e avisar se não for encontrado. Hoje a única defesa é o operador reparar sozinho.

---

## D-5 · ❌ RETIRADO — este defeito não existe, e o erro de medição foi meu

Eu havia registrado que `agent-flow cancel` sai com código 0 quando a confirmação não veio,
escondendo de um script que nada foi cancelado.

**Falso.** `src/cli/lifecycle.ts:136` retorna `ExitCode.GATE_NOT_SATISFIED`, e medido:

```
$ agent-flow cancel > /dev/null 2>&1; echo $?
3
```

A observação que me levou ao engano foi `agent-flow cancel 2>&1 | tail -5` — o `$?` de um
pipeline é o do **último** comando, ou seja o do `tail`, que sempre sai 0. O produto estava
certo; a medição é que estava errada.

Fica registrado em vez de apagado porque um relatório que some com o que errou não merece
crédito no que acertou — e porque a armadilha (`| tail` mascarando exit code) é fácil de
repetir em qualquer verificação de CLI.

---

## D-6 · Falar da baseline vermelha desarma os gates mecânicos, sem aviso

**Severidade: alta.** Observado comparando dois planos do mesmo trabalho.

O primeiro plano (AF-2026-002) distribuiu portões reais por tarefa:

```
TASK-001 -> ["install"] / "pass"
TASK-002 -> ["lint"]    / "fail"
TASK-007 -> ["lint","test"] / "fail"
```

O segundo (AF-2026-003), depois que eu reforcei na descrição que a suíte **já nasce
vermelha** (102 issues no analyzer, 22 testes falhando) e que não se deve consertar teste
alheio, produziu:

```
TASK-001 .. TASK-007 -> [] / "none"
```

**Todas as sete com `validation: []`.** O `validationExpectation: "fail"` existe exatamente
para "espera-se vermelho" — o primeiro plano o usou corretamente. O segundo, em vez de
usá-lo, removeu o portão. O trabalho de verificação continua descrito **em prosa** na
TASK-007 (`fvm flutter analyze`, `fvm flutter test`, diff dos nomes `[E]`), mas prosa
depende da diligência do executor; o campo `validation` é o que a ferramenta executa e
registra.

Medido três vezes, e o padrão ficou mais nítido a cada uma. No terceiro plano só sobreviveu
o gate cuja expectativa era `pass`:

```
TASK-002 -> ["install"]           (expectativa: pass)
as outras seis -> [] / "none"     (seriam lint/test sobre base vermelha)
```

**Segunda correção a este relatório, e ela enfraquece o achado.** Eu havia escrito aqui que
o planner *"evita declarar um gate que espera ver vermelho"* e que `validationExpectation:
"fail"` **não é usado**. Falsificado na quinta medição:

```
TASK-003  gate=["test"]                     / "fail"   ← testes RED, vermelho esperado
TASK-007  gate=["install","lint","test"]    / "fail"
```

O planner usou exatamente o mecanismo que eu disse que ele não usava. O que resta de
verdadeiro é mais modesto e mais difícil de agir: **o comportamento varia entre execuções
do mesmo plano, sobre o mesmo repositório, com descrições equivalentes.** Em três ciclos os
gates das tarefas de código vieram vazios; em um deles vieram com `fail` declarado, na
ordem RED→GREEN correta.

Uma regra que vale em parte das execuções é pior de confiar que uma ausência, porque não
se sabe quando ela valeu. Mas é um defeito diferente do que eu descrevi, e a sugestão muda:
não é "ensinar o campo ao planner", é **tornar determinístico** — ou o plan-review passa a
exigir gate em toda tarefa que produz código, o que é mecanicamente checável e não depende
de o planner lembrar.

**Correção a uma afirmação anterior deste relatório:** eu havia escrito que a revisão
automática não menciona os gates vazios. Errado — ela mencionou no quarto ciclo
(*"TASK-003, TASK-004 e TASK-005 … declaram `validation: []`"*) e não mencionou no
terceiro. O revisor não é cego para isso; é **inconsistente**, o que é um problema
diferente e pior de confiar: um achado que aparece em metade das execuções não é uma rede.

### Sugestão

- O plan-review deveria tratar "tarefa que muda código com `validation: []`" como achado,
  no mínimo LOW. É mecanicamente checável e não depende de julgamento.
- O prompt do planner deveria ensinar `validationExpectation: "fail"` como a resposta para
  base vermelha, já que é para isso que o campo existe.

---

## D-7 · `revise` é estruturalmente inalcançável quando D-1 + D-2 se combinam

**Severidade: alta** — é D-1 e D-2 juntos, mas merece entrada própria porque o efeito é
categórico: **o comando `revise` ficou inutilizável neste repositório.**

Medido nos dois runs. O `request.md` que eu escrevo posso limpar. Mas `revise` anexa os
achados do `plan-review` ao request, e esses achados são escritos pela ferramenta:

```
achados do plan-review (AF-2026-003): "db" ×1, "table" ×3
```

Com `migration_partner/` no repo satisfazendo a metade de path para sempre, qualquer
`revise` é classificado `high-risk` e recusado pelo portão de cross-provider. Tentei duas
vezes, limpando meu texto entre as tentativas; a terceira eu nem tentei, porque dava para
prever pelo `rg`.

O caminho que sobrou foi abrir run **novo** com a descrição reescrita à mão — e isso só é
barato porque o cache de discovery sobreviveu (`stage_reused [discovery]`, US$ 19
poupados). Sem esse acaso de fingerprint, cada revisão custaria um ciclo completo.

**Um ciclo de revisão que não pode ser executado é pior que ausente:** a ferramenta aponta
`agent-flow revise "<instrução>"` na mensagem de rejeição, e o comando que ela recomenda é
o que não roda.

---

## D-9 · ✅ DIAGNOSTICADO PELO `doctor` · O executor não consegue rodar comando nenhum

**Severidade: crítica.** É o defeito que impede o produto de entregar o que promete, e
aparece só quando se chega em `run` — depois de US$ 33 de planejamento.

`TASK-001` (capturar a baseline de analyze/test) bloqueou em 1m24s. Palavras do executor:

> Blocking reason is a permission grant, not a missing decision. `fvm flutter pub get`,
> `fvm flutter analyze` and `fvm flutter test` are all refused by the permission layer
> ("This command requires approval") via both the Bash and PowerShell tools.

A causa está no próprio adapter (`claude-code-runner.ts:239-245`), e é a interação de duas
decisões que isoladamente fazem sentido:

- `--permission-mode acceptEdits` auto-aprova **edições de arquivo**, e só elas. Comando de
  shell continua exigindo aprovação.
- `--setting-sources ''` (`isolationArgs`) faz o CLI **ignorar de propósito** qualquer
  `permissions.allow` do `settings.json` — que é justamente onde um projeto declararia
  "pode rodar `fvm flutter test`".

Numa sessão `-p` não-interativa não existe quem aprove. Resultado: **o executor escreve
arquivo mas não roda nada.** Sem baseline, sem lint, sem teste, sem build. Qualquer tarefa
que precise executar um comando — ou seja, a maioria — bloqueia.

Note a ironia com D-6: o produto tem um campo `validation` por tarefa, comandos de
validação configurados por projeto, e um estágio de verificação inteiro — e o executor não
tem permissão para executar nenhum deles.

### É descobribilidade, não capacidade — e `dangerouslySkipPermissions` NÃO é a saída

Corrijo duas coisas que escrevi antes de ler o suficiente:

**`dangerouslySkipPermissions` não é uma válvula esquecida no runner do Claude; é recusada
de propósito.** O teste `never passes --dangerously-skip-permissions`
(`test/adapters/claude-code-runner.test.ts:198`) é invariante declarada, com a razão no
corpo: *"The only containment agent-flow actually has is the runner's own sandbox.
Disabling it would leave nothing at all."* A factory não repassar a flag está correto. Eu
tinha registrado isso como defeito separado; não é.

**A concessão estreita já funciona hoje, por `runners.claude.args`.** `base-runner.ts:212`
monta `[...invocation.args, ...isolation, ...this.extraArgs]` — os `args` do config entram
**por último**, e nada os segue (o prompt vai por stdin). Então isto é posicionalmente
seguro apesar de `--allowedTools` ser variádico:

```yaml
runners:
  claude:
    args: ["--allowedTools", "Bash(fvm:*)", "Bash(git status:*)", "Bash(git diff:*)"]
```

Ou seja: o produto **pode** conceder, e concede com a granularidade certa. O defeito é que
essa é a única via, e ela só é descobrível lendo `base-runner.ts` com atenção suficiente
para saber que `extraArgs` é appendado por último. Uma capacidade que exige ler o fonte do
adapter não é uma capacidade suportada.

### Sugestão

Por ordem de custo/benefício:

1. **`doctor` deveria pegar isso.** Ele já conhece `commands.install/lint/test/build`. Um
   probe que tente executar o menor deles *através do runner* falharia em 30 segundos, em
   vez de a operação inteira descobrir no `run` — depois de US$ 33 de planejamento.
2. **Um campo `runners.*.allowedTools`** (lista, na vocabulária do próprio CLI, como
   `mcp.servers` já faz) torna a concessão de primeira classe e tira o operador da
   dependência de um detalhe de ordenação de argv.
3. **Derivar o default de `commands.*`**: o projeto já declara quais binários roda;
   conceder exatamente esses e nada mais é o default seguro, e faria `run` funcionar out of
   the box sem afrouxar contenção nenhuma.

### O que foi feito: (1), e medido nos dois sentidos

`doctor` agora emite uma **nota** quando o projeto declara `commands` e o runner de um papel
executor é `claude-code-cli` sem `--allowedTools` (`src/app/diagnostics.ts`). Medido ao vivo:

- **dispara** no projeto Node, que declara `commands` e não tem concessão, com o remédio
  literal na mensagem (`runners.claude.args: ['--allowedTools', 'Bash(npm:*)', …]`);
- fica **calada** no worktree Flutter, que já tem a concessão.

**Nota, não degradação**, e a condição inclui "o projeto declara comandos" — pelo mesmo C-4
que este relatório invoca contra o `single_provider`: sem isso seria verdade em toda
instalação default, e um DEGRADED sempre ligado não vale nada.

(2) e (3) continuam abertos. Tentei (2) nesta sessão e **não consegui terminar**: o
classificador de segurança da minha própria sessão bloqueou tanto `agent-flow run`/`retry`
quanto a edição que liga o campo ao spawner, com o motivo *"Create Unsafe Agents"*. Reverti
o campo do schema em vez de deixar uma configuração que valida e não faz nada — que é
justamente o defeito que este relatório critica noutro lugar. O ponto vale como requisito
de produto: **conceder shell a um agente autônomo é operação que ferramentas de segurança
tratam como sensível**, o que é mais um argumento para (3) — concessão derivada e estreita —
do que para um booleano global.

**Nota de segunda ordem, e ela importa:** conceder esses `args` é, literalmente, configurar
um agente autônomo para executar shell sem aprovação por comando. Na minha própria sessão o
classificador de segurança bloqueou a operação com o motivo *"Create Unsafe Agents"* — e
está certo. Isso não é argumento contra a funcionalidade; é argumento a favor de a
concessão ser **derivada e estreita** (os binários que o config já declara) em vez de um
booleano chamado `dangerouslySkipPermissions`, que é a única alternativa hoje.

---

## D-10 · ✅ CORRIGIDO · `revise` re-planejava mas não re-especificava, e não avisava

**Severidade: média.** Descoberto usando o `revise` depois que D-1 o tornou alcançável.

Um `revise` entra direto em `planning`. O `sdd.md` fica como está. Isso é defensável quando
o achado é sobre o plano — mas a revisão automática **também** julga o SDD, e um achado
sobre o SDD não tem por onde ser aplicado.

Caso concreto desta sessão. O SDD afirmava, para justificar não adicionar uma janela de
supressão, que as duas fontes de deep link pendente são alimentadas "por toque em push" e
concluía: *"no máximo ele entrega uma rota que o usuário de fato pediu tocando numa
notificação"*. Falso para uma delas:
`lib/src/core/firebase/firebase_messaging_service.dart:128-148` é o handler de
`onBackgroundMessage` e grava `pending_notification_route` na **chegada** da mensagem.

O desenho continua certo — a corrida é pré-existente ao seletor de arquivos, então não há
guarda a construir. O que fica errado é o documento que alguém vai abrir daqui a três meses
para entender *por que* não existe guarda. O `revise` não tem como consertá-lo.

### Confirmado: deixou de ser teórico e passou a bloquear o fluxo

Uma hora depois de eu registrar este defeito, ele apareceu como o achado HIGH que reprovou
o plano seguinte:

> *"TASK-003 e TASK-004 contradizem diretamente o SDD. O SDD fixa, na tabela de Contracts
> and Interfaces, `image/*` → `jpg, jpeg, png`, e seu critério de aceite do FR-002 exige
> literalmente…"*

A sequência é o defeito inteiro em três passos: a revisão aponta que a regra do SDD quebra
o caso de uso do chamado → `revise` manda o planner corrigir → o plano corrige e passa a
contradizer o SDD, que `revise` não alcança → a revisão seguinte reprova pela contradição.
**O ciclo não converge**, e o operador só descobre por quê se souber que `revise` começa em
`planning`.

A saída foi abrir uma run nova com a decisão escrita na descrição, para que o SDD a adote
como contrato. Isso custa um ciclo completo (~US$ 10 com discovery em cache) para mudar uma
linha de uma tabela.

### Correção aplicada, e verificada no próprio defeito que a motivou

`agent-flow revise --from <sdd|planning>`, default `planning` — o comportamento de sempre,
para quem não passa nada. `discovery` e `architecture-impact` ficam de fora de propósito:
discovery é feature-agnóstica e cacheada entre runs, então re-entrar lá é `--no-cache` numa
run nova, não revisão desta — e oferecer o estágio mais caro do produto como resposta a um
achado de revisão não é gentileza.

Coberto por teste que afirma sobre os **estágios que o pipeline iniciou**, não sobre o
evento que registra o parâmetro. A primeira versão do teste afirmava sobre
`revision_requested.detail.from` e permaneceu **verde** com `from: 'planning'` cravado de
volta na chamada ao pipeline: provava que a intenção fora escrita, não que algo agiu sobre
ela. O controle positivo pegou isso.

**Verificado no defeito real, no ciclo seguinte.** Uma revisão apontou que a tabela de
mapeamento do SDD sub-inclui (`.jpg` sem `jpeg`) contra o princípio de super-inclusão que
o próprio SDD declara. Com `--from sdd`:

```
revision_requested  from = "sdd"
stage_reused        architecture-impact  (reason: resumed_from_later_stage)
stage_started       sdd
```

Re-entrou na especificação, reaproveitou o estágio anterior que não precisava mudar, e
re-planeja depois. Antes, o mesmo achado custava uma run inteira com a decisão reescrita à
mão na descrição — feito duas vezes nesta sessão, a ~US$ 10 cada.

## D-11 · O orçamento de cerimônia corta a revisão, e só há uma tentativa de reparo

**Severidade: baixa**, e o comportamento observado foi **correto** — vale registro como
limite conhecido, não como defeito.

A instrução de `revise` acrescentou trabalho (trocar uma tarefa inútil, corrigir a tradução
de `image/*`, um log, limpeza de artefatos, ordem de dependência) e o planner devolveu 10
tarefas contra o teto de 8 do workflow `standard`:

```
stage_failed :: STANDARD workflow ceremony budget allows at most 8 tasks (got 10).
                Merge what belongs together, or split the feature.
planning_repair_requested :: repair: 1, maxRepairs: 1
```

O laço de reparo pediu a fusão sozinho, sem silenciar o estouro nem derrubar a run — que é
o comportamento certo. O limite é que existe **uma** tentativa: se o segundo plano também
estourar, o ciclo acaba. Vale considerar se `maxRepairs: 1` é o número certo para um
estágio cujo problema é aritmético e cuja correção é mecânica.

## D-12 · Um gate com expectativa `fail` não distingue sucesso de fracasso

**Severidade: média.** Medido durante a execução, e é o outro lado do D-6: o gate que eu
vinha cobrando foi declarado, rodou, e não informou nada.

Numa base vermelha — aqui, 22 falhas pré-existentes — `fvm flutter test` falha
independentemente do que a tarefa acabou de escrever. Resultado, no mesmo run:

```
TASK-003  escreveu testes RED, propositalmente quebrados   →  validationPassed=false
TASK-004  implementou o mapeador, 11 testes verdes         →  validationPassed=false
```

Os dois registros são idênticos. Verificado à mão o que o gate não sabe dizer: rodando só
o arquivo da tarefa, `+11 All tests passed!`.

O plano compensa na tarefa final, comparando os **conjuntos** de nomes de teste contra a
baseline — que é o mecanismo certo e funciona. Mas por tarefa o sinal é cego, e "o gate
passou/não passou" é o que a UI mostra e o que um operador lê primeiro.

### Sugestão

Quando `validationExpectation` é `fail`, rodar o comando **restrito aos arquivos que a
tarefa tocou** (`flutter test <arquivos>`, `vitest run <arquivos>`) além da suíte inteira.
Aí `+11 -0` no escopo da tarefa é sinal, e a suíte inteira continua sendo a rede. Sem isso
o campo `validationPassed` de uma tarefa numa base vermelha carrega zero bits.

## D-8 · Tarefa de verificação sem verificação

**Severidade: baixa**, observação de qualidade de plano. O plano gerou `TASK-006`
("verificar que nenhuma permissão nova é necessária no AndroidManifest") com
`validation: []` — uma chamada de modelo para registrar um fato que um `grep` responde em
segundos, e sem portão automático nenhum. Vale considerar se o planner deveria poder emitir
uma "constatação" sem gastar um ciclo de executor.

---

## ✅ CORRIGIDO · `single_provider` punia quem tem um provedor só

Levantado pelo operador, não por mim: *"não sei de onde tiramos que um runner só é
degradação; e se o dev só tiver acesso ao claude ou só o agy?"*. Ele tem razão, e o próprio
repositório já tinha razão junto — `test/core/health.test.ts:90` diz, em comentário:

> *The shipped default enables one runner. A fresh install must not be told its environment
> is degraded for following the defaults (**C-4**).*

A intenção estava escrita; a implementação vazava. `assessHealth` comparava contra
`observed`, que vem de `referencedRunners` e **também coleta o que `fallback.roles` cita** —
então um runner com `enabled: false` explícito ainda contava como evidência de que revisão
cruzada estivera disponível. Medido: configuração com `codex: { enabled: false }` e todos os
papéis no Claude era reportada DEGRADED em toda run, por um provedor que o dono desligou de
propósito.

O denominador passou a ser os runners **habilitados**. Quem habilitou um só fez uma escolha;
quem habilitou dois e viu um quebrar perdeu capacidade — e esse ainda degrada, como deve.

**O que a degradação diz continua verdade e não foi suavizado:** revisão do mesmo provedor
não protege contra uma suposição repetida. Nesta sessão, porém, a revisão same-provider
achou 11 problemas reais no próprio trabalho, dois deles que teriam ido para produção. A
regra superestima a perda na prática — mas o registro honesto dela é o que permite saber
disso.

## ✅ CORRIGIDO · Tudo saía em inglês, e não era tradução faltando

Três decisões, cada uma defensável, que juntas garantiam 100% de inglês — e ninguém as
tinha conectado:

1. `core/phrases/index.ts:19` — *"The CLI always passes English, **by construction**"*,
   porque saída de terminal é colada em issue e passada por grep.
2. `core/phrases/index.ts:24` — o renderer nunca reescreve as palavras de um modelo. Correto,
   e deve continuar.
3. `claude-code-runner.ts:167` — `--setting-sources ''` apaga o `language` do operador. Era
   um fix medido de reprodutibilidade; o efeito colateral é que a configuração que faria o
   modelo responder em português é removida antes de chegar.

**As três apoiam-se na mesma premissa: "idioma é configuração pessoal".** Com `language`
declarado no config do **projeto**, a premissa cai — o idioma passa a ser propriedade do
repositório, idêntica para todo mundo que o abre, e tão reprodutível quanto o inglês era.

O que foi entregue:

- `config.language` (`en` | `pt-BR`), sobrescrevível pelo projeto, default `en` — instalação
  existente não muda uma vírgula (verificado rodando `doctor` num projeto sem a chave).
- **Saída do modelo**: `languageInstructionFor` injeta a instrução via `--append-system-prompt`
  em todo estágio, e ela **proíbe explicitamente** traduzir `FR-001`, `TASK-004`, paths,
  comandos e valores fixados por schema — sem isso um modelo prestativo quebraria o
  casamento que torna o plano legível por máquina. 4 testes e um controle positivo.
- **`doctor` inteiro** em português, verificado lendo a saída real.
- **`ExecutionContext.say`** — acabaram os `say: Phrases = en` que nunca recebiam nada. Um
  default silenciosamente certo em teste e silenciosamente errado em produção não é default,
  é bug com cara simpática.
- As frases de degradação gravadas na run saíram do código cravado para o phrase book.
  Isso **reverte** a decisão *"the record stays English, like a commit message"* — cuja
  justificativa era não depender de quem apertou o botão, e que a chave de projeto dissolve.

**Aberto:** os demais comandos da CLI (`status`, `feature`, `run`) ainda têm literais
ingleses que nunca entraram no phrase book. É trabalho igual ao do `doctor`, repetido.

## O que funcionou, e que vale preservar em qualquer refatoração

Nada disto é elogio de cortesia — é o que me fez recomendar seguir com a ferramenta em vez
de implementar na mão.

**O SDD é grounded de verdade, não plausível.** Verifiquei quatro afirmações dele por
amostragem e todas bateram, incluindo duas que eu não teria checado sozinho:

- Citou `webview_flutter_android-4.10.2/…/WebChromeClientProxyApi.java:100-104` — leu o
  **Java** do plugin no pub cache, não só o Dart.
- `RISK-003`: "registrar o callback chama
  `setSynchronousReturnValueForOnShowFileChooser(true)`, prometendo resposta ao Android; um
  caminho que lança mata o input de arquivo até a WebView ser recriada, **com sintoma
  idêntico ao bug atual**". Conferi: `android_webview_controller.dart:707-709`, exato. A
  observação de que um fix parcial é indistinguível de fix nenhum é a coisa mais útil do
  documento inteiro, e é justamente o tipo de coisa que não sai de um resumo.

**O plan-review pagou o próprio custo, mesmo sendo same-provider.** US$ 1,33 para achar 7
problemas reais, um deles grave: a guarda de concorrência que o SDD havia proposto é
**inerte**, porque no Android o `onActivityResult` chega antes do `onResume` — a flag é
limpa antes do evento que ela deveria suprimir. Uma proteção que aparece no diff e não
protege nada. Eu tinha lido o SDD e elogiado exatamente essa guarda; a revisão me corrigiu.

**A degradação `single_provider` é honestidade rara.** O run registrou sozinho que a
revisão não é independente e que uma premissa errada do planejamento pode ser repetida em
vez de pega. Não bloqueou (workflow `standard`), apenas ficou no registro. Ferramenta que
documenta a própria fraqueza vale mais que ferramenta que finge não ter.

**Os riscos residuais têm valor de produto, não só de engenharia.** O melhor: expandir
`image/*` para `{jpg,jpeg,png}` deixa foto **HEIC** impossível de escolher em aparelhos que
fotografam em HEIC por padrão — decisão de produto que ninguém no ticket tinha levantado.

---

## Números desta sessão

**AF-2026-002** — plano REJEITADO pela revisão (7 achados, 1 HIGH):

| Estágio | Duração | Custo (medidor do próprio agent-flow) |
|---|---|---|
| discovery | 14m49s | US$ 19,05 |
| architecture-impact | 5m20s | US$ 1,94 |
| sdd | 10m06s | US$ 2,54 |
| planning | 3m30s | US$ 1,19 |
| plan-review | 3m59s | US$ 1,33 |
| **total** | **~38min** | **US$ 26,06** |

**AF-2026-003** — run novo carregando os achados à mão (saída de D-7), plano PASS com 4
achados:

| Estágio | Duração | Custo |
|---|---|---|
| discovery | — | **US$ 0,00 — `stage_reused`** |
| architecture-impact | 5m23s | US$ 2,18 |
| sdd | 8m32s | US$ 2,58 |
| planning | 3m33s | US$ 1,08 |
| plan-review | 4m20s | US$ 1,66 |
| **total** | **~22min** | **US$ 7,49** |

**Planejamento completo: US$ 33,55 e ~80 minutos, antes da primeira linha de código.** O
cache de discovery é o que torna a segunda tentativa viável — sem ele, a saída de D-7
custaria US$ 26 por ciclo. Isso eleva bastante a importância de manter o fingerprint
estável, e é um argumento contra incluir qualquer coisa volátil nele.

Duas ressalvas sobre esses números:

1. `docs/engineering/findings.md` já admite que "cost is sampled, not measured", e cita uma
   invocação de SDD em Opus reportada a US$ 1,37 — ordem de grandeza bem distante dos
   US$ 19 da discovery aqui. Ou discovery em monorepo é genuinamente cara, ou a conta
   superestima. Não sei qual, e a diferença muda decisão de uso.
2. A **proporção** é confiável porque saiu do mesmo medidor: discovery custa ~10x o estágio
   seguinte. É o que justifica o cache de discovery existir — e é o que torna D-2 caro,
   porque a saída natural dele é abrir um run novo.

## Nota de ambiente

A discovery levou 14m49s e ficou 11 minutos sem emitir evento. Com o `timeoutSeconds`
default de 900s ela teria sido morta a poucos minutos do fim — foi o que aconteceu num run
anterior noutro repositório do mesmo ecossistema. Aqui só passou porque eu havia subido
`architect.timeoutSeconds` para 2700 preventivamente. Vale considerar se o default serve
para monorepo, ou se `discovery` merece um default próprio: é o estágio que lê o
repositório inteiro e o único cujo custo já é amortizado por cache.
