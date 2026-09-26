import type { Phrases } from './index.js';

/**
 * Português, e a regra que vale para o arquivo inteiro: **identificador não se traduz.**
 *
 * `agent-flow approve` é digitado, não lido — quem está na tela vai copiar aquilo para um
 * terminal. Ids de tarefa, nomes de branch, de runner e de arquivo idem. O que traduz é o
 * que está em volta.
 *
 * A outra regra é concordância: **tarefa** é feminina e **estágio** é masculino, então
 * `TASK-004 falhou` e `a revisão de TASK-004 está defasada` são frases diferentes da
 * mesma linha em inglês. É por isso que estas são funções.
 */
export const ptBR: Phrases = {
  gate: {
    approval: 'Revise o plano e rode `agent-flow approve`',
    taskReview: (tasks) =>
      `Revise ${tasks}, e então recoloque na fila com \`agent-flow retry\` ou aceite o resultado`,
    agentBlocked: (tasks) => `Responda o que ${tasks} apontou como impedimento, e recoloque na fila`,
    taskFailed: (tasks, waiting) =>
      `Conserte o que parou ${tasks}, e então rode \`agent-flow retry\` nela — ou ` +
      `\`agent-flow revalidate\` se você mesmo já consertou a worktree dela.${waiting}`,
    waitingOn: (tasks) => ` ${tasks} está esperando por ela.`,
    finalAcceptance: 'Rode `agent-flow review`, e então aceite e faça o merge',
  },







  config: {
    general: 'Geral',
    workspace: 'Workspace',
    runners: 'Runners',
    models: 'Modelos',
    execution: 'Execução',
    ui: 'Interface',
    retention: 'Retenção',

    configUnreadable: 'A configuração não pôde ser lida.',
    correctBeforeSaving: 'Corrija a requisição antes de salvar.',
    configVersion: 'Versão da config',
    globalConfig: 'Config global',
    projectConfig: 'Config do projeto',
    notPresentDefaults: 'não existe — os padrões embutidos estão valendo',
    notPresent: 'não existe',
    projectName: 'Nome do projeto',
    detectedStack: 'Stack detectada',
    notDetected: 'não detectada',
    sourcePaths: 'Caminhos de código',
    testPaths: 'Caminhos de teste',
    architectureRules: 'Regras de arquitetura',
    enabled: 'habilitado',
    disabled: 'desabilitado',
    commandIs: (command) => `comando ${command}`,
    roleRoutingHasItsOwnPage:
      'O roteamento de papéis tem uma página própria, que resolve cada papel contra o que o runner dele realmente consegue fazer.',
    approvalBeforeImplementation: 'Aprovação antes da implementação',
    required: 'obrigatória',
    notRequired: 'não obrigatória',
    canStartWithoutGate: 'a implementação pode começar sem alguém abrir o portão',
    parallelTasks: 'Tarefas em paralelo',
    attemptsPerTask: 'Tentativas por tarefa',
    gitWorktrees: 'Worktrees do Git',
    on: 'ligado',
    off: 'desligado',
    fallback: 'Fallback',
    fallbackTriggers: 'Gatilhos de fallback',
    infrastructureOnly:
      'só falhas de infraestrutura — uma lacuna de capacidade nunca é contornada',
    extraValidationCommands: 'Comandos de validação extras',
    planNamesById:
      'um plano nomeia um destes por id; nada que um modelo escreve chega a um shell',
    everythingElseInBrowser:
      'Todo o resto que o dashboard lembra — filtros, abas, qual tarefa está aberta — vive no navegador.',
    workspaceScanDepth: 'Profundidade da varredura do workspace',
    scanDepthNote:
      'até onde, abaixo da raiz do workspace, o `agent-flow ui ~/wk` procura projetos; um diretório além disso não é descoberto nem servido',
    uiPairing: 'Pareamento de dispositivos',
    uiPairingNote:
      'se dispositivos remotos podem se parear com este servidor via código de curta duração',
    retentionNote:
      'O histórico de runs é podado a pedido, não por política: agent-flow clean --keep <n>. Não há configuração de retenção para ler.',
    notSet: 'não definido',
    none: 'nenhum',
    declared: (total) => `${String(total)} declarado${total === 1 ? '' : 's'}`,
    configuredNotEffective: (effective) =>
      `configurado, mas não efetivo: sem workspaces isolados uma run executa ` +
      `${String(effective)} tarefa por vez — ligue git.useWorktrees, e então comece uma run nova`,
    newRunsExecuteUpTo: (isolated, shared) =>
      `runs novas executam até ${String(isolated)} por vez em workspaces isolados; ` +
      `uma run criada antes de as worktrees estarem ligadas ainda executa ${String(shared)}`,
  },
  doctor: {
    authNotVerified: (runners) =>
      `autenticação não verificada para: ${runners} ` +
      '(use `doctor --deep` para checar de verdade)',
    runnerNotUsable: (runner) => `o runner "${runner}" não é utilizável`,
    rolesWillRunOn: (from, to) =>
      `papéis configurados para "${from}" vão rodar em "${to}" no lugar`,
    onlyOneUsable: (provider) => `só "${provider}" é utilizável`,
    noCrossProviderReview:
      'a revisão de plano e a revisão final não podem ser entre provedores; elas vão rodar no ' +
      'mesmo provedor com contexto novo, o que não protege contra uma suposição errada repetida',
    runnerGrantsNoTools: (runner) =>
      `o runner "${runner}" não recebe nenhuma ferramenta além de editar arquivos`,
    implementationCannotRunCommands: (runner) =>
      'um estágio de implementação vai conseguir editar arquivos mas não rodar um único ' +
      'comando. Este projeto declara commands, e install, lint, test e build seriam todos ' +
      'recusados, sem aprovação, numa sessão não-interativa. Conceda os binários que esses ' +
      `commands já nomeiam, ex.: runners.${runner}.args: ` +
      "['--allowedTools', 'Bash(npm:*)', 'Bash(git status:*)'] — no Windows declare cada regra também para o PowerShell, ex. 'PowerShell(npm:*)': é por ele que o Claude Code roda comandos lá",
    projectLooseningIgnored: (path) =>
      `a configuração do projeto define \`${path}\`, e isso é ignorado: este projeto não é ` +
      'confiável, então a configuração dele só pode restringir as suas. Para que valha, ' +
      'adicione o diretório do projeto a `trust.projectConfig` na sua configuração global',
    worktreeCopyExposesEnv: (pattern) =>
      `o padrão \`${pattern}\` de \`worktree.copy\` nomeia ou casa um arquivo .env, e o que ele ` +
      'casa é copiado para cada worktree de tarefa, onde o modelo consegue lê-lo. Restrinja o ' +
      'padrão, a menos que esses valores sejam para o agente',
    worktreeCopyEnvUnchecked: (pattern) =>
      `não foi possível listar os arquivos ignorados que o padrão \`${pattern}\` de \`worktree.copy\` ` +
      'casa, então não foi verificado se ele copia um arquivo .env para os worktrees de tarefa',
    projectCommandsNotGranted:
      'os comandos que este projeto declara não são concedidos ao executor: o projeto não ' +
      'está coberto por `trust.projectConfig`, então não pode ampliar o que um agente pode ' +
      'rodar. Para concedê-los, adicione o diretório do projeto a `trust.projectConfig` na sua ' +
      'configuração global',
    declaredCommandNotGranted: (id, line, why) =>
      `o comando declarado \`${id}\` (\`${line}\`) não é concedido ao executor: ${why}`,
    grantExcludedInstall:
      'install é uma etapa de preparação que o Agent Flow roda antes de o executor começar',
    grantExcludedEmpty: 'ele está vazio',
    grantExcludedLineBreak: 'ele ocupa mais de uma linha',
    grantExcludedWildcard:
      'ele contém um curinga (`*` ou `?`), então uma concessão por prefixo permitiria mais do que ele nomeia',
    grantExcludedShellSyntax:
      'ele contém sintaxe de shell ou aspas, então uma concessão por prefixo permitiria mais do que ele nomeia',
    nodeMissing: 'O Node.js não está no PATH',
    installNode: 'Instale o Node.js 20+ (https://nodejs.org ou via fnm/nvm)',
    gitMissingOrOld: 'O Git não existe ou é mais antigo que 2.38',
    installGit: 'Instale o Git 2.38+ (https://git-scm.com ou pelo seu gerenciador de pacotes)',
    runnerNotInstalled: (runner) => `O runner "${runner}" não está instalado ou não é executável`,
    runnerMissingCredentials: (runner) => `O runner "${runner}" está sem credenciais`,
    runnerDisabled: (runner) =>
      `O runner "${runner}" está desabilitado na configuração (não está faltando)`,
    enableRunner: (runner) =>
      `Defina \`runners.${runner}.enabled: true\`, ou aponte esses papéis para um runner habilitado`,
    runnerUndeclared: (runner) =>
      `Um papel aponta para o runner "${runner}", que nunca foi declarado`,
    declareRunner: (runner) =>
      `Declare "${runner}" em \`runners:\`, ou aponte esses papéis para um runner declarado`,
    disabledInConfig: (runner) =>
      `desabilitado na configuração — \`runners.${runner}.enabled: false\``,
    nothingWasProbed: (runner) =>
      `Nada foi sondado, então isto não diz nada sobre o "${runner}" estar instalado.`,
    notDeclaredInConfig: (runner) =>
      `não declarado — um papel aponta para "${runner}", mas nenhuma entrada em \`runners:\` o define`,
    installAndEnsurePath: (product, command) =>
      `Instale o ${product} e garanta que \`${command}\` esteja no PATH`,
    runLoginOrExport: (command, variable) => `Rode \`${command}\` ou exporte ${variable}`,
    runInTerminal: (command) => `Rode \`${command}\` no seu terminal`,
    installProbeReason: 'sonda de instalação do agent-flow doctor',
    remoteAccessUndetermined:
      'o status de acesso remoto não pode ser determinado a partir de um terminal; consulte o servidor em execução',

    // ── O chrome do próprio relatório ────────────────────────────────────────────────
    // `runner`, `worktree`, `effort`, `forge` e `fallback` ficam como estão: são termos
    // do produto, aparecem nas chaves de configuração que a pessoa vai digitar, e
    // traduzi-los criaria dois nomes para a mesma coisa — um na tela, outro no YAML.
    labelInstalled: 'instalado',
    labelExecutable: 'executável',
    labelAuth: 'autenticação',
    labelVersion: 'versão',
    labelDetail: 'detalhe',
    livePro: 'Sonda ao vivo:',
    quotaDoesNotChangeVerdict: [
      'Cota e chamadas falhas são reportadas mas não mudam o veredito:',
      'um orçamento gasto é uma janela de cobrança, e uma resposta ruim não é um',
      'ambiente quebrado. Credenciais ausentes mudam sim — foi para isso que',
      'o --deep existe.',
    ],
    probeCouldNotUseTool: [
      'A sonda rodou em modo leitura e não conseguiu usar nenhuma ferramenta. Conceda',
      'acesso não-interativo a ferramentas na configuração do próprio CLI do runner.',
    ],
    rolesWithNowhereToRun: 'Papéis sem onde rodar:',
    unusableAndNoFallback: (primary) => `"${primary}" não é utilizável e não tem fallback`,
    rolesWhoseConfigCannotRun: 'Papéis cuja configuração não consegue rodar:',
    seeCapabilitiesAbove: 'veja Capacidades acima',
    configErrorsNotDegradations: [
      'Estes são erros de configuração, não degradações: o estágio falha no contato,',
      'toda vez. Aponte o papel para um runner que faça o que os prompts dele exigem.',
    ],
    degradedHeading: 'Degradado:',
    noteLabel: 'Nota',
    remediationHeading: 'Correção:',
    fixLabel: 'Como corrigir',
    remoteAccessHeading: 'Acesso remoto:',
    remoteEnabled: (sessions) =>
      `ligado (${String(sessions)} sessão${sessions === 1 ? '' : 'ões'} ao vivo)`,
    remoteOff: 'desligado',
    admittedAddresses: 'endereços admitidos',
    workStillPossible:
      'Ainda dá para trabalhar. Use --strict para tratar isto como falha no CI.',
    capabilitiesHeading: 'Capacidades (declaradas — nenhum runner foi invocado)',
    runnerDefaultModel: '(padrão do runner)',
    cannotRun: (errorKind) => `não consegue rodar: ${errorKind}`,
    effortNotOffered: (requested, supported) =>
      `o effort ${requested} não é oferecido por esta dupla (suportados: ${supported})`,
    willBeClamped: (effective) => `será limitado a ${effective}, e isso fica registrado na run`,
    effortSupported: (effective, supported) => `effort ${effective} (suportados: ${supported})`,
    doesNotDeclareToolClass: (runner, toolClass) =>
      `"${runner}" não declara ${toolClass}, que os prompts deste papel precisam`,
    mayRunCommands: (prefixes) => `pode rodar: ${prefixes}`,
    mayRunAnyCommand: 'pode rodar qualquer comando',
    declaredCapabilitiesCaveat: [
      'Capacidades declaradas são lidas dos adapters, nunca inferidas de uma run que por',
      'acaso deu certo. Uma concessão ausente é um aviso: ela não impede a execução.',
    ],
    installProbeHeading: 'Sonda de instalação',
    checkoutDirtyBeforeInstall:
      'um checkout novo deste repositório não está limpo antes de instalar',
    worktreeRefusesDirtyCheckout:
      'O modo worktree recusa uma tarefa cujo checkout está sujo (fase: checkout).',
    installFailedInFreshCheckout: (command) => `\`${command}\` falhou num checkout novo`,
    worktreeRunsInstallEveryTask:
      'O modo worktree roda isso antes de cada tarefa, então toda tarefa falharia aqui.',
    installLeavesCheckoutClean: (command) => `\`${command}\` deixa um checkout novo limpo`,
    installModifiesTrackedFiles: (command) =>
      `\`${command}\` modifica arquivos versionados ou não ignorados:`,
    worktreeWillRefuseEveryTask:
      'O modo worktree vai recusar toda tarefa neste projeto (fase: setup).',
    useLockfileRespectingInstall:
      'Use uma instalação que respeite o lockfile — no npm, `commands.install: npm ci`.',
    belowWorktreeFloor: (floor) => `abaixo do mínimo ${floor} exigido pelo modo worktree`,
    worktreeNeedsVersion: (floor) => `o modo worktree precisa de ${floor} ou mais novo`,
    belowNodeFloor: (floor) => `o dashboard precisa de ${floor} ou mais novo, e nenhum Node instalado atende`,
    dashboardRunsOn: (version) => `o dashboard roda no Node ${version}`,
    nodeNeedsVersion: (floor) => `o \`ui\` precisa de ${floor} ou mais novo`,

    authConfigured: 'configurada',
    authAvailable: 'disponível',
    authNotConfigured: 'não configurada',
    authNotVerifiedShort: 'não verificada (use --deep)',
    verdictOkWithNote: 'OK — nada aqui impede uma run, mas veja a nota acima',

    stageRoutingHeading: 'Roteamento de estágios (qual runner serve o quê)',
    readsRepository: 'lê o repositório',
    textInTextOut: 'trabalha a partir dos documentos anteriores',
    stageOpensNoFile:
      'não exige o repositório — um runner `openai-compatible` serviria, mas sem conferir nada no código',
    configuredAndUnrouted: 'Configurados e sem rota',
    noRolePointsAtIt: 'nenhum papel aponta para ele',
    pointARoleAtOne:
      'Aponte um papel para ele para usá-lo; o `doctor` só reporta o que um papel resolve.',
  },
  delivery: {
    noForgeConfigured: 'nenhuma forge está configurada, então esta run não entrega em lugar nenhum',
    nothingPublished: 'nada foi publicado para esta run ainda',
    onBranchNoPr: (commit, branch) => `${commit} está em ${branch}, sem pull request`,
    prPointsElsewhere: (number, head, approved) =>
      `o pull request #${number} aponta para ${head}, e esta run aprovou ${approved}`,
    prOpenNoChecks: (number) => `o pull request #${number} está aberto; nenhuma checagem foi observada`,
    checksUnfinished: (pending, total) =>
      `${String(pending)} de ${String(total)} checagens não terminaram`,
    checksFailed: (red) =>
      `${String(red)} checagem(ns) remota(s) falhou(aram). Isto é entrega, não qualidade: ` +
      'a run local não é afetada',
    allChecksPassed: (total) => `todas as ${String(total)} checagens remotas passaram`,
  },
  server: {
    noSuchCandidate: 'este candidato não existe',
    noSuchProject: 'este projeto não existe',
    noSuchRun: 'esta run não existe',
    noSuchTask: 'esta tarefa não existe',
    noSuchArtifact: 'este artefato não existe',
    noSuchPrompt: 'este prompt não existe',
    noSuchJob: 'este job não existe',
    expectedCandidateId: 'era esperado um id de candidato',
    invalidProjectId: 'projectId inválido',
    unknownPipelineStage: 'estágio de pipeline desconhecido',
    invalidRunOrTaskId: 'id de run ou de tarefa inválido',
    unknownArtifact: 'artefato desconhecido',
    invalidDoctorOptions: 'opções de doctor inválidas',
    invalidCleanupOptions: 'opções de limpeza inválidas',
    invalidConfigurationTarget: 'alvo de configuração inválido',
    invalidConfigurationRequest: 'requisição de configuração inválida',
    unknownPrompt: 'prompt desconhecido',
    invalidAnalyticsScope: 'escopo de analytics inválido',
    featureNeedsDescription: 'uma feature precisa de uma descrição',
    invalidPlanResumeRequest: 'requisição de retomada de plano inválida',
    invalidApproveRequest: 'requisição de aprovação inválida',
    invalidRejectRequest: 'requisição de rejeição inválida',
    invalidRetryRequest: 'requisição de retry inválida',
    invalidAnswerRequest: 'uma resposta precisa de texto, com no máximo 4000 caracteres',
    invalidStartRequest: 'requisição de start inválida',
    revisionNeedsInstruction: 'uma revisão precisa de uma instrução dizendo o que deve mudar',
    invalidReviewRequest: 'requisição de revisão inválida',
    invalidJobId: 'id de job inválido',
    invalidFilter: 'filtro inválido',
    invalidRunId: 'id de run inválido',
    plannedTasks: (tasks, review) => `${String(tasks)} tarefas planejadas${review}.`,
    replannedInto: (tasks, review) => `Replanejada em ${String(tasks)} tarefas${review}.`,
    reviewVerdictSuffix: (verdict) => `; revisão ${verdict}`,
    initRunActive: (runId, status) =>
      `A run ${runId} ainda está ativa (${status}). O init escreve arquivos que precisam ser commitados, e esse commit move o HEAD.`,
    finishOrAbandonFirst:
      'Termine ou abandone a run primeiro, ou tente de novo com force para prosseguir mesmo assim.',
    writtenButNotScanned: 'O projeto foi escrito, mas a varredura do workspace não o encontrou.',
    restartUiCheckRoot: 'Reinicie o `agent-flow ui` e confira a raiz e a profundidade do workspace.',
    configChangedAfterLoad: 'A configuração mudou depois de ter sido carregada.',
    reviewFreshAndRetry: 'Revise o estado atual e refaça suas mudanças.',
    noSuchRunShort: (runId) => `Não existe a run ${runId}`,
    checkTheRunId: 'Confira o id da run.',
    alreadyBusyHere: (runId, what) => `${runId} já está ${what} neste servidor.`,
    busyRunning: 'rodando',
    busyBeingReviewed: 'sendo revisada',
    busyPlanning: 'planejando',
    busyReplanning: 'replanejando',
    busyRetrying: 'modificada por um retry',
    waitForExecution: 'Espere a execução em andamento terminar.',
    waitOrWatch: 'Espere terminar, ou acompanhe na página da run.',
    noSuchEndpoint: 'este endpoint não existe',
    lockedByAnother: (runId) => `${runId} está travada por outro processo.`,
    beingByOwner: (runId, operation, owner, where) =>
      `${runId} já está sendo ${operation} pelo ${owner}${where}.`,
    wherePid: (pid) => ` (pid ${pid})`,
    whereHost: (hostname) => ` em ${hostname}`,
    lockFromAnotherMachine:
      'O lock foi escrito por outra máquina, e este servidor não vai julgá-lo.',
    configNotEditable: 'A fonte da configuração não pode ser editada com segurança.',
    correctYamlRetry: 'Corrija o YAML de origem e tente de novo.',
    configUnreadable: 'A configuração não pôde ser lida nem salva.',
    checkFsRetry: 'Confira o acesso ao sistema de arquivos e tente de novo.',
    pairingNotEnabled: 'o pareamento não está habilitado neste servidor',
    invalidPairRequest: 'requisição de pareamento inválida',
    invalidPairingCode: 'código de pareamento inválido',
    sessionLimitReached: 'o limite de 16 sessões ativas de dispositivos foi atingido',
    noSuchDeviceSession: 'sessão de dispositivo não encontrada',
    invalidDeviceSessionRequest: 'requisição de sessão de dispositivo inválida',
  },
  git: {
    notAGitRepository:
      'Rode `git init`, ou desligue o modo worktree com `git.useWorktrees: false`.',
    repositoryIsBare: 'O modo worktree precisa de uma árvore de trabalho. Use um clone normal.',
    repositoryHasNoCommits: 'Faça o primeiro commit; ainda não há base de onde cortar uma branch.',
    repositoryHasSubmodules:
      'O modo worktree não popula submódulos. Desligue-o para este projeto.',
    gitVersionUnsupported: (version) => `Atualize o Git para ${version} ou mais novo.`,
    repositoryRootUnresolvable:
      'A raiz do repositório não pôde ser resolvida. Procure um symlink quebrado acima dela.',
    worktreePathTooLong:
      'Use um caminho de home mais curto, ou habilite caminhos longos nesta plataforma.',
    gitIdentityMissing: 'Esta run não tem namespace no Git. Comece uma run nova.',
    agentFlowStateNotIgnored:
      'Adicione `.agent-flow/runs/`, `.agent-flow/cache/` e `.agent-flow/current-run` ao .gitignore.',
    workingTreeDirty: 'Faça commit ou stash das suas mudanças, e então tente de novo.',
    planningBaseMoved:
      'Faça checkout do commit contra o qual esta run foi planejada, ou comece uma run nova.',
    gitRunKeyCollision:
      'O namespace desta run no Git já tem refs que ela não criou. Comece uma run nova.',
    namespaceMissing:
      'A branch de integração em que esta run registrou trabalho sumiu. Ela não pode ser reconstruída daqui.',
    integrationHeadDiverged:
      'A branch de integração foi rebobinada ou substituída debaixo desta run. Comece uma run nova.',
    gitUnavailable: 'O Git não pôde ser executado. Confira se está instalado e no PATH.',

    headNamesNoCommit: 'o HEAD não aponta para um commit, então não há base de onde cortar a run',
    noConfigAt: (path) => `não há configuração do Agent Flow em ${path}`,
    bareHasNoWorkingTree: 'um repositório bare não tem árvore de trabalho',
    notInsideWorkingTree: (dir) => `${dir} não está dentro de uma árvore de trabalho do Git`,
    headIsUnborn: 'o HEAD é unborn, então não há commit de onde cortar a run',
    submoduleStatusUnreadable: 'o git submodule status não pôde ser lido',
    worktreeAddSkipsSubmodules:
      'o git worktree add não popula submódulos, então a worktree ficaria incompleta',
    rootUnresolvable: 'a raiz do repositório não pôde ser resolvida, então a identidade dela não seria estável',
    worstCasePathUncomposable:
      'um caminho de workspace de pior caso não pôde ser composto a partir da chave deste repositório',
    pathNotIgnored: (path) =>
      `${path} não é ignorado por este repositório, então o estado do próprio Agent Flow sujaria a árvore`,
    treeHasUncommitted: (files, more) =>
      `a árvore de trabalho tem mudanças não commitadas: ${files}${more ? ' …' : ''}`,
    noNamespaceRecorded: 'esta run não tem namespace do Git registrado',
    namespaceNotThisRun: (key, runId) =>
      `o namespace do Git registrado "${key}" não pertence a ${runId}`,
    noNamespace: 'esta run não tem namespace no Git',
    plannedAgainstHeadNow: (base, head) =>
      `esta run foi planejada contra ${base} e o HEAD agora é ${head}`,
    unborn: 'unborn',
    integrationNoLongerContains: (commit) =>
      `a branch de integração não contém mais ${commit}, que esta run registrou como integrado`,

    worktreeCannotSupport: (code, detail) =>
      `O modo worktree foi pedido e este repositório não consegue suportá-lo (${code}): ${detail}`,
    notInitialised: (detail) => `Este projeto não foi inicializado para o Agent Flow: ${detail}`,
    runInitFirst: 'Rode `agent-flow init`, e então commite o que ele escrever.',
    worktreeRequestedNotReady: (code, detail) =>
      `O modo worktree foi pedido e este repositório não está pronto (${code}): ${detail}`,
  },
  actions: {
    noSuchRun: (runId) => `Não existe a run ${runId} neste projeto.`,

    lockUnreadable: (runId) => `${runId} está travada, e a reivindicação sobre ela não pôde ser lida.`,
    lockUnreadableAction:
      'O Agent Flow recusa uma reivindicação que não consegue ler em vez de adivinhar, porque ' +
      'adivinhar é como uma run acaba executada duas vezes. Confirme que nenhum processo do ' +
      'Agent Flow está trabalhando nesta run — e então apague o arquivo execution.lock.* de ' +
      'maior número no diretório da run.',
    atPid: (pid) => `pid ${pid}`,
    atHost: (hostname) => `host ${hostname}, que não é esta máquina`,
    alreadyBeing: (runId, operation, owner, where, since) =>
      `${runId} já está sendo ${operation} pelo ${owner} (${where}), desde ${since}.`,
    waitForExecution: 'Espere a execução em andamento terminar.',
    useSeparateWorktree:
      'Espere ela terminar, ou comece a feature nova numa worktree separada (`git worktree add`), para as duas runs não dividirem a run atual.',
    lockOnAnotherHost:
      'O Agent Flow não julga um lock de outra máquina. Pare a execução naquele host, ou — se ' +
      'aquele host não existe mais — apague aqui o arquivo execution.lock.* de maior número no ' +
      'diretório da run.',
    beingExecuted: 'executada',
    beingReplanned: 'replanejada',
    beingRetried: 'modificada por um retry',
    beingApproved: 'aprovada',
    beingRejected: 'rejeitada',
    beingReviewed: 'revisada',
    beingRevalidated: 'revalidada na mão',
    heldByPidOn: (pid, hostname) => ` (pid ${pid} em ${hostname})`,

    noPlanYetToApprove: (runId) => `${runId} ainda não tem plano, então não há o que aprovar.`,
    finishPlanningFirst: 'Termine o planejamento primeiro.',
    noPlanToApprove: 'Não há plano para aprovar.',
    repositoryNotReady: (runId, detail) =>
      `${runId} é uma run isolada e este repositório não está pronto: ${detail}.`,

    alreadyRejected: (runId) => `${runId} já foi rejeitada.`,
    completedCannotReject: (runId) =>
      `${runId} já foi concluída. O plano dela não pode ser rejeitado depois do fato.`,
    startNewRunIfRevisiting: 'Comece uma run nova se o trabalho precisa ser revisto.',

    taskNeverRan: (taskId, runId) => `${taskId} não rodou em ${runId}.`,
    onlyAttemptedCanRetry: 'Só uma tarefa que já foi tentada pode ser recolocada na fila.',
    taskAlreadyCompleted: (taskId, integrated) =>
      `${taskId} já está concluída${integrated ? ', o que em modo worktree significa integrada' : ''}.`,
    retryingFinishedWork:
      'Repetir trabalho terminado construiria uma segunda tentativa para algo que a run já ' +
      'tem. Revise o plano e comece uma run nova se o trabalho precisa mudar.',
    taskMarkedRunning: (taskId) =>
      `${taskId} está marcada como running, então ou está executando agora, ou um processo morreu segurando-a.`,
    runReconcilesFirst:
      'Rode `agent-flow run`: ele reconcilia o que a tentativa interrompida realmente deixou ' +
      'antes de recolocar qualquer coisa na fila, então uma tentativa validada é finalizada em ' +
      'vez de repetida.',
    taskAnsweredBlocked: (taskId) =>
      `${taskId} está BLOCKED: o agente dela respondeu BLOCKED, então ela parou por causa de ` +
      'algo que o SDD não responde.',
    fixSddOrForce: 'Conserte o SDD ou o plano — ou force o retry deliberadamente.',
    answerOrForce: (taskId) =>
      `Responda o que ela perguntou com \`agent-flow answer ${taskId}\`, que a recoloca na fila — ` +
      'ou force o retry deliberadamente com `--force`.',
    taskNotAnswerable: (taskId, state, heldByDependency) =>
      `${taskId} está \`${state}\`${heldByDependency ? ', retida por uma tarefa da qual depende' : ''}, ` +
      'então não há pergunta do agente dela para responder.',
    onlyBlockedCanBeAnswered:
      'Só uma tarefa cujo agente parou com BLOCKED pode ser respondida. Uma tarefa retida por ' +
      'uma dependência é liberada quando essa dependência termina.',
    answerNeedsText: 'Uma resposta precisa de algum texto.',
    sayWhatTaskNeeds: 'Escreva o que a tarefa bloqueada precisa saber para continuar.',

    runPausedAt: (runId, at) => `${runId} foi pausada em ${at}.`,
    resumeIt: 'Retome com `agent-flow resume`.',
    runCancelledTerminal: (runId, at) => `${runId} foi cancelada${at}, e uma run cancelada é terminal.`,
    cancelledAt: (at) => ` em ${at}`,
    evidenceStillOnDisk:
      'As evidências, a branch de integração e as worktrees dela continuam em disco. ' +
      'Comece uma run nova com `agent-flow feature`.',
    finishedNothingToRun: (runId, status) =>
      `${runId} terminou (${status}), então não há o que rodar.`,
    noRunnableAtReview: (runId, tasks, count) =>
      `${runId} não tem tarefa executável: ${tasks} ${count === 1 ? 'está' : 'estão'} em review_required.`,
    noRunnableBlocked: (runId, tasks, count) =>
      `${runId} não tem tarefa executável: ${tasks} ${count === 1 ? 'está bloqueada' : 'estão bloqueadas'}.`,
    noRunnableFailed: (runId, tasks, count) =>
      `${runId} não tem tarefa executável: ${tasks} ${count === 1 ? 'falhou' : 'falharam'}.`,
    noRunnableInState: (runId, status) =>
      `${runId} não tem tarefa executável no estado atual (${status}).`,
    reviewEvidenceThenRetry: (taskId) =>
      `Revise as evidências da tarefa, e então rode \`agent-flow retry ${taskId}\` — ou ` +
      `\`agent-flow revalidate ${taskId}\` se você mesmo já consertou a worktree dela.`,
    answerBlockedThenRetry: (taskId) =>
      taskId === undefined
        ? 'Responda o que a tarefa bloqueada apontou, e então recoloque na fila.'
        : `Responda o que ${taskId} apontou com \`agent-flow answer ${taskId}\`, que a recoloca na fila.`,
    startNewOrCheckStatus:
      'Comece uma run nova, ou veja em `agent-flow status` o que esta está esperando.',
    planRejected: (runId) => `O plano de ${runId} foi rejeitado, então ele não será executado.`,
    revisePlanOrStartNew: 'Revise o plano e aprove o resultado, ou comece uma run nova.',
    runHasNoPlan: (runId) => `${runId} ainda não tem plano.`,
    finishPlanningBeforeStarting: 'Termine o planejamento antes de começar a implementação.',
    planNotApproved: (runId) => `O plano de ${runId} não foi aprovado.`,
    reviewAndApproveBeforeStarting: 'Revise e aprove o plano atual antes de começar.',
    approvalStale:
      'O plano mudou depois de ser aprovado. A aprovação vale para um plano específico, ' +
      'não para a run.',
    readPlanApproveAgain: 'Leia o plano atual e aprove de novo.',
    runHasNoSdd: (runId, workflow) =>
      `${runId} não tem SDD, que o workflow ${workflow} exige.`,
    rerunSddStage: 'Rode o estágio de SDD de novo antes de começar a implementação.',
    noSuchTaskInPlan: (taskId, runId) => `Não há a tarefa ${taskId} no plano de ${runId}.`,
    dependsOnUnmet: (taskId, unmet) => `${taskId} depende de ${unmet}, que não foi concluída.`,
    runInOrder: 'Rode o plano na ordem, ou rode as dependências primeiro.',

    cancelledNothingToPause: (runId) =>
      `${runId} foi cancelada, então não sobrou o que pausar.`,
    startNewRunFeature: 'Comece uma run nova com `agent-flow feature`.',
    finishedNothingToPause: (runId, status) =>
      `${runId} terminou (${status}), então não há o que pausar.`,

    runNotPaused: (runId) => `${runId} não está pausada.`,
    runItWithRun: 'Rode com `agent-flow run`.',
    stillExecuting: (runId, holder) => `${runId} ainda está executando${holder}.`,
    waitForBoundary: 'Espere a run pausada chegar ao limite dela, e então retome.',

    finishedNothingToCancel: (runId, status) =>
      `${runId} terminou (${status}), então não há o que cancelar.`,

    revisionNeedsInstruction: 'Uma revisão precisa de uma instrução dizendo o que deve mudar.',
    trivialNoRevision:
      'O workflow TRIVIAL não suporta ciclos de revisão automatizados (orçamento = 0).',
    approveAsIsOrStandard:
      'Aprove o plano como está, ou comece uma run nova com o workflow STANDARD.',
    ceremonyBudget: (workflow, cycles) =>
      `STOP_AND_ASK_HUMAN: o workflow ${workflow} atingiu o limite do orçamento de cerimônia ` +
      `(${String(cycles)} ciclo${cycles === 1 ? '' : 's'} de revisão). ` +
      'Achados não resolvidos exigem aprovação humana ou elevação de workflow: registre uma ' +
      'decisão com `agent-flow revise --decision`, suba uma classe com `agent-flow revise --escalate`, ' +
      'ou aprove entregando os achados às tarefas com `agent-flow approve --attach-findings`.',
    reviewResidualFindings:
      'Revise os achados residuais no diálogo de Aprovação e aprove por cima deles, ou comece uma run nova com uma classe de workflow mais alta.',
    workflowAtCeiling: (workflow) =>
      `${workflow} é a classe de workflow mais alta, então não há classe para onde escalar.`,
    decideOrApproveAtCeiling:
      'Registre uma decisão com `agent-flow revise --decision`, ou aprove entregando os achados às ' +
      'tarefas com `agent-flow approve --attach-findings`.',
    implementationStarted: (tasks, count) =>
      `A implementação já começou (${tasks} ${count === 1 ? 'concluída' : 'concluídas'}), ` +
      'então a run não pode mais mudar de ' +
      'classe de workflow.',
    revisePlainInstead:
      'Revise o plano com `agent-flow revise`, que mantém a classe atual e gasta um ciclo de revisão.',

    featureNeedsDescription: 'Uma feature precisa de uma descrição.',
    sayWhatFeatureDoes:
      'Diga o que a feature deve fazer. Uma frase basta; um parágrafo é melhor.',

    promptsMismatch:
      'Os prompts instalados não batem com este build. Reinstale o agent-flow, ou rode `agent-flow doctor`.',
    stageFailed: (stage, failureClass, errorCode, message) =>
      `O estágio "${stage}" falhou: ${failureClass} (${errorCode}). ${message}`,
    stagesBeforeKept: (stage, kept, rerun) =>
      (kept === '' ? 'Nada antes dele é reaproveitado' : `Guardados: ${kept}`) +
      (rerun === '' ? '' : `. Roda de novo: ${rerun}`) +
      `. Retome com: agent-flow feature "<mesma descrição>" --from ${stage}`,

    noPlanToReviewAgainst: (runId) => `${runId} não tem plano para revisar contra.`,
    finishPlanningBeforeReviewing: 'Termine o planejamento antes de revisar a implementação.',

    integrationTreeUnreadable: (runId, detail) =>
      `${runId} é uma run isolada e a árvore de integração dela não pôde ser lida: ${detail}.`,
    integrationBranchIsProduct:
      'A branch de integração é o produto da run. Restaure-a, ou comece uma run nova.',

    notActiveRunAndNone: (runId) => `${runId} não é a run ativa, e este projeto não tem nenhuma.`,
    notActiveRunButIs: (runId, current) => `${runId} não é a run ativa — ${current} é.`,
    onlyActiveRun: 'Só a run ativa pode ser iniciada ou replanejada.',

    processWasExecuting: (holder) =>
      `Um processo estava executando esta run${holder}. ` +
      'Ele observa o cancelamento e encerra os agentes dele.',
    noActiveRun: 'Não há run ativa.',
    thisRunHasNoPlan: 'Esta run ainda não tem plano.',
    planNotReviewed: 'Este plano não foi revisado.',
    runReviewOrApproveOver: 'Rode a revisão, ou aprove deliberadamente por cima dela.',
    reviewJudgedAnother:
      'A revisão de plano em arquivo julgou uma versão diferente deste plano. Um veredito ' +
      'sobre outro documento não é um veredito sobre este.',
    requestRevisionOrApprove:
      'Peça uma revisão, ou aprove deliberadamente — o que fica registrado na run.',
    reviewUnverifiable:
      'A revisão de plano em arquivo não diz qual plano ela julgou, então nada a ' +
      'conecta ao plano em mãos.',
    reviewFailedWith: (findings) => `A revisão de plano retornou FAIL com ${String(findings)} achado(s).`,
    requestRevisionAddressing:
      'Peça uma revisão que trate deles, ou aprove por cima do veredito deliberadamente.',
    alreadyApproved: 'Esta run já está aprovada.',
    planWasRejected:
      'Este plano foi rejeitado. Aprová-lo agora deixaria a run registrando as duas coisas, ' +
      'e nada executaria de qualquer forma.',
    revisePlanOrApproveOver:
      'Revise o plano e aprove o resultado — ou aprove por cima da rejeição ' +
      'deliberadamente, o que fica registrado na run.',
    approvalNotPossible: 'A aprovação não é possível no estado atual.',
    findingsNotAttachable: (state) =>
      '`--attach-findings` entrega às tarefas os achados de uma revisão de plano reprovada, e ' +
      `não há revisão reprovada deste plano para entregar. ${state}`,
    reviewPassedNothingToAttach: 'A revisão de plano em arquivo aprovou este plano.',
    approveWithoutAttaching: 'Aprove com `agent-flow approve`, que não anexa nada.',
    attachFindingsOrForce:
      '`--attach-findings` e `--force` são duas aprovações diferentes: uma entrega às tarefas ' +
      'os achados de uma revisão reprovada, a outra passa por cima da recusa sem eles.',
    chooseAttachOrForce: 'Use uma delas, não as duas.',
  },
  board: {
    completed: 'concluída',
    unknownState: (state) => `o estado \`${state}\` não é um que este build conheça`,
    failed: (attempts) =>
      `falhou${attempts > 1 ? ` após ${String(attempts)} tentativas` : ''} — decida o que mudar, e recoloque na fila`,
    interruptedByStop:
      'interrompida por uma run parada — retome para a recuperação reconciliá-la',
    heldBackBy: (tasks) => `presa por ${tasks}`,
    heldByUpstreamFailure: 'presa por uma falha acima na cadeia',
    agentReportedSdd: 'o agente avisou que o SDD não responde algo de que ele precisa',
    waitingForReviewDecision: 'esperando uma decisão de revisão',
    changesRequested: (blocking) =>
      `mudanças pedidas — ${String(blocking)} achado${blocking === 1 ? '' : 's'} bloqueante${blocking === 1 ? '' : 's'}`,
    reviewMovedPast: 'a revisão descreve uma árvore que esta tarefa já deixou para trás',
    inReviewRound: (round) => `em revisão, rodada ${String(round)}`,
    waitingToMerge: 'validada, esperando o merge na branch de integração',
    interruptedWillRequeue: 'interrompida — a recuperação vai recolocá-la na fila',
    running: (attempt, ownWorktree) =>
      `${attempt > 1 ? `tentativa ${String(attempt)}` : 'rodando'}${ownWorktree ? ' na própria worktree' : ''}`,
    readyToStart: 'pronta para começar',
    waitingOn: (tasks) => `esperando por ${tasks}`,
    plannedNotReady: 'planejada, ainda não pronta para começar',
    everyEligibleAgent: 'todo agente elegível',
    heldOneWave: (who) => `segurada por uma onda — ${who} em capacidade máxima`,
    anExclusiveArea: 'uma área exclusiva',
    ownershipConflict: (area, holder) => `conflito de propriedade em ${area}${holder}`,
    heldBy: (who) => `, presa por ${who}`,
  },

  attention: {
    remoteDiverged: 'a branch remota se moveu debaixo desta run',
    inspectRemote: 'Examinar o remoto',
    couldNotMerge: (task) => `${task} não pôde ser mergeada`,
    conflictingPaths: (paths) => `caminhos em conflito: ${paths}`,
    integratedFirst: (task, paths) =>
      `${task} integrou primeiro e moveu o head; caminhos em conflito: ${paths}`,
    open: (task) => `Abrir ${task}`,
    heldByOwnership: (task) => `${task} está presa num conflito de propriedade`,
    reviewOwnership: 'Revisar as áreas de propriedade',

    planWaiting: 'o plano está esperando uma decisão',
    finalReviewWaiting: 'todas as tarefas terminaram; falta a revisão final',
    runTheFinalReview: 'Rodar a revisão final',
    nothingRunsUntilGate: 'nada roda enquanto o portão não abrir',
    reviewThePlan: 'Revisar o plano',
    exhaustedRecovery: (task) => `${task} esgotou a recuperação automática`,
    repairsTried: (failureClass, repairs) =>
      `${failureClass}; ${String(repairs)} passos de reparo tentados`,
    waitingForReview: (task) => `${task} está esperando uma decisão de revisão`,
    nothingAcceptedIt: 'a tentativa terminou e nada a aceitou nem a recolocou na fila',
    reportedBlocked: (task) => `${task} avisou que está bloqueada`,
    sddDoesNotAnswer:
      'o SDD não responde algo de que a tarefa precisa; a recuperação não destrava isso',
    readWhatAsked: (task) => `Ler o que ${task} perguntou`,
    answerBlocked: (task) => `Responder ${task}`,

    taskFailed: (task) => `${task} falhou`,
    attemptsNoneSatisfied: (attempts) =>
      `${String(attempts)} tentativas, e nenhuma satisfez o contrato`,
    attemptDidNotSatisfy: 'a tentativa não satisfez o contrato',
    requeue: (task) => `Recolocar ${task} na fila`,
    gateDidNotRun: (gate) => `o portão obrigatório \`${gate}\` não rodou`,
    gateFailed: (gate) => `o portão obrigatório \`${gate}\` falhou`,
    nothingRecordedResult:
      'nada registrou um resultado para ele, o que bloqueia exatamente como uma falha',
    exitCode: (code) => `saída ${code}`,
    openQualityGates: 'Abrir os portões de qualidade',
    blockingFindings: (task, count) =>
      `${task} tem ${String(count)} achado${count === 1 ? '' : 's'} bloqueante${count === 1 ? '' : 's'}`,
    reviewRequestedChanges: 'a revisão pediu mudanças',
    readTheFindings: 'Ler os achados',
    remoteChecksFailed: (red) =>
      `${String(red)} checagem${red === 1 ? '' : 's'} remota${red === 1 ? '' : 's'} falh${red === 1 ? 'ou' : 'aram'}`,
    deliveryNotLocalQuality:
      'isto é entrega, não qualidade local — os portões da própria run não são afetados',
    openTheDelivery: 'Abrir a entrega',
    deliveryFailed: 'a entrega para a forge falhou',
    runForgeSync: 'Rode `agent-flow forge sync`',

    reviewMovedPast: 'a revisão mais nova descreve um estado que esta run já deixou para trás',
    stageStartedAfter:
      'um estágio começou depois que ela foi escrita, então o veredito dela é sobre outra árvore',
    openTheReview: 'Abrir a revisão',
    reviewOfIsStale: (task) => `a revisão de ${task} está defasada`,
    namesATreeMovedPast:
      'ela nomeia uma árvore que a tarefa já deixou para trás, então a aprovação não vale',
    openTheReviewThread: 'Abrir a conversa da revisão',
    operatorAskedToStop: 'alguém pediu para esta run parar',
    noNewTaskStarts:
      'nenhuma tarefa nova começa até ser retomada; a que está em andamento vai até o fim',
    resumeTheRun: 'Retomar a run',
    readyAndNobodyTakes: (task) => `${task} está pronta e ninguém pode pegá-la`,
    everyMemberAtCapacity: 'todo membro com as habilidades que servem está em maxConcurrentTasks',
    openTheTeam: 'Abrir a equipe',
    finishedNothingPublished: 'esta run terminou e nada foi publicado',
    runForgePublish: 'Rode `agent-flow forge publish`',
    checksPending: (pending) => `${String(pending)} checagens remotas ainda não reportaram`,
    checksAreObservation: 'checagens remotas são observação, nunca um veredito local',
  },
  pairing: {
    title: 'Parear Dispositivo',
    description: 'Digite o código de pareamento exibido no terminal do servidor para conectar este dispositivo.',
    codeLabel: 'Código de Pareamento',
    deviceLabel: 'Nome do Dispositivo',
    pairButton: 'Parear Dispositivo',
    codeExpired: 'O código de pareamento expirou. Digite `code` no terminal do servidor para gerar outro.',
    codeUsed: 'Este código de pareamento já foi utilizado.',
    codeBurned:
      'Este código de pareamento foi queimado após muitas tentativas com falha. Digite `code` no terminal do servidor para gerar outro.',
    codeUnknown: 'O código de pareamento é inválido.',
    limitReached:
      'O limite de 16 sessões ativas de dispositivos foi atingido. Revogue uma sessão para parear um novo dispositivo.',
    pairingDisabled: 'O pareamento remoto de dispositivos não está habilitado neste servidor.',
    restartWarning:
      'Reiniciar o servidor despareia todos os dispositivos e invalida qualquer código pendente.',
  },
  devices: {
    title: 'Dispositivos Conectados',
    description: 'Gerencie as sessões ativas de dispositivos. Revogar uma sessão desconecta o dispositivo imediatamente.',
    noSessions: 'Nenhum dispositivo remoto está pareado no momento.',
    revoke: 'Revogar',
    revoked: 'Sessão do dispositivo revogada',
    pairedAt: 'Pareado em',
    lastSeenAt: 'Visto pela última vez',
    activeSessions: (count) =>
      `${String(count)} ${count === 1 ? 'sessão ativa de dispositivo' : 'sessões ativas de dispositivos'}`,
  },
};
