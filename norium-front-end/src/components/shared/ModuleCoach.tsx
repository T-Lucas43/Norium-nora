import Button from "../shared/Button";
import {
  BarChart3,
  Bell,
  Bot,
  BrainCircuit,
  CalendarDays,
  CheckSquare,
  ChevronDown,
  CircleHelp,
  CreditCard,
  FileSignature,
  GitBranch,
  Inbox,
  LayoutDashboard,
  Mail,
  MessageSquare,
  MessagesSquare,
  Settings,
  ShieldCheck,
  Sparkles,
  UserRound,
  UserRoundCheck,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

export type GuidedModule =
  | "Dashboard"
  | "Central"
  | "Controle"
  | "Pendencias"
  | "Notificacoes"
  | "Emails"
  | "Agenda"
  | "Chat"
  | "TeamChat"
  | "Tarefas"
  | "Gastos"
  | "Automacoes"
  | "Relatorios"
  | "Propostas"
  | "Perfil"
  | "Configuracoes"
  | "Equipe"
  | "Clientes"
  | "Governanca"
  | "Brainstorm"
  | "Ajuda"
  | "Mais";

type QuickPrompt = {
  label: string;
  prompt: string;
};

type ModuleGuide = {
  title: string;
  description: string;
  topics: string[];
  prompt: string;
  quickPrompts?: QuickPrompt[];
};

const guides: Record<GuidedModule, ModuleGuide> = {
  Dashboard: {
    title: "Dashboard",
    description: "Veja seu Meu Dia, agenda, tarefas, canais e proximos passos em um unico resumo.",
    topics: ["O resumo diario fica nesta tela", "Atalhos abrem a origem de cada item", "Agenda e prioridades sao atualizadas pelos canais conectados"],
    prompt: "Explique meu Dashboard e resuma o Meu Dia, indicando compromissos, mensagens, tarefas, pagamentos e aprovacoes que exigem atencao, sem alterar nada.",
  },
  Central: {
    title: "Central de atividades",
    description: "Acompanhe os acontecimentos de cada canal sem misturar notificacoes do sistema.",
    topics: ["Reordene e redimensione os canais", "Clique em um evento para abrir a origem", "O contador mostra o volume de cada integracao"],
    prompt: "Explique de forma pratica como usar a Central de atividades do Norium e me ajude a identificar o que exige atencao agora.",
    quickPrompts: [
      { label: "Analisar metricas", prompt: "Analise os eventos recentes da Central de atividades e aponte o que precisa de atencao imediata." },
      { label: "Gerar insights", prompt: "Gere insights sobre os padroes de atividade recentes na Central de atividades." },
    ],
  },
  Controle: {
    title: "Controle operacional",
    description: "Reuna aprovacoes, saude das integracoes, auditoria, modelos e acoes reversiveis.",
    topics: ["Aprovacoes protegem acoes sensiveis", "Saude mostra falhas de sincronizacao", "Auditoria registra quem fez cada alteracao"],
    prompt: "Explique o Controle operacional do Norium e verifique aprovacoes, integracoes ou riscos que exigem minha atencao.",
    quickPrompts: [
      { label: "Sugerir resumo", prompt: "Resuma o estado atual do Controle operacional: aprovacoes pendentes, saude das integracoes e auditoria recente." },
    ],
  },
  Pendencias: {
    title: "Centro de pendencias",
    description: "Priorize tudo que ainda depende de resposta, correcao, aprovacao ou pagamento.",
    topics: ["Use os filtros por origem e urgencia", "Abra o item original pelo atalho", "Conclua somente depois de validar a acao"],
    prompt: "Analise meu Centro de pendencias, explique os grupos e sugira uma ordem objetiva para resolver o que esta aberto.",
    quickPrompts: [
      { label: "Priorizar pendencias", prompt: "Analise minhas pendencias abertas e sugira a ordem de resolucao mais eficiente." },
    ],
  },
  Notificacoes: {
    title: "Notificacoes do sistema",
    description: "Veja alertas globais, erros de conexao e avisos importantes do Norium.",
    topics: ["Alertas de canais ficam na Central", "Erros persistentes devem ser investigados", "Limpe apenas notificacoes ja conferidas"],
    prompt: "Explique minhas notificacoes do sistema e diga quais alertas devo investigar primeiro.",
    quickPrompts: [
      { label: "Analisar alertas", prompt: "Analise minhas notificacoes do sistema e aponte quais exigem acao imediata." },
    ],
  },
  Emails: {
    title: "E-mails",
    description: "Pesquise, leia, organize, responda e envie mensagens pela conta Gmail conectada.",
    topics: ["Filtros e categorias organizam a caixa", "Abra um e-mail para ver a conversa completa", "A Nora pode resumir e preparar uma resposta para sua aprovacao"],
    prompt: "Explique a tela de E-mails do Norium e me oriente para pesquisar, organizar, ler, responder ou enviar uma mensagem. Nao envie nada sem minha confirmacao.",
  },
  Agenda: {
    title: "Agenda",
    description: "Consulte e organize compromissos locais e do Google Agenda.",
    topics: ["Alterne entre dia, semana, mes e ano", "Abra um evento para consultar ou editar", "A Nora coleta os dados antes de criar um compromisso"],
    prompt: "Explique a tela de Agenda, suas visualizacoes e como consultar, criar ou editar um compromisso. Nao altere minha agenda sem confirmacao.",
  },
  Chat: {
    title: "Chat",
    description: "Acompanhe conversas, grupos, mensagens e midias dos canais conectados.",
    topics: ["Use os filtros por canal e status", "Selecione uma conversa para carregar o historico", "Anexos, audio e dados do grupo ficam no contexto da conversa"],
    prompt: "Explique a tela de Chat e me oriente para localizar uma conversa, consultar o historico e enviar texto, audio ou arquivo. Nao envie nada sem confirmacao.",
  },
  TeamChat: {
    title: "Chat da equipe",
    description: "Converse com o time, envie anexos, abra mensagens diretas e mencione a Nora com o contexto da conversa.",
    topics: ["O canal geral inclui toda a equipe", "Mensagens diretas ficam separadas", "Use @nora para pedir ajuda sem sair da conversa"],
    prompt: "Explique o Chat da equipe e me ajude a organizar uma conversa interna, sem enviar nenhuma mensagem sem minha confirmacao.",
    quickPrompts: [
      { label: "Resumir conversa", prompt: "Resuma as mensagens recentes do Chat da equipe e destaque decisoes e proximos passos." },
    ],
  },
  Tarefas: {
    title: "Tarefas",
    description: "Organize projetos e acompanhe cards por status, responsavel, prioridade e prazo.",
    topics: ["Cada projeto possui seu proprio quadro", "Arraste cards entre as etapas", "Abra a tarefa para anexos, comentarios e integracao com a agenda"],
    prompt: "Explique a tela de Tarefas e me ajude a escolher um projeto, organizar o Kanban ou preparar uma tarefa com responsavel, prioridade e prazo.",
  },
  Gastos: {
    title: "Financeiro",
    description: "Controle entradas, saidas, programacoes, boletos, comprovantes e conciliacoes.",
    topics: ["Visao geral resume caixa e vencimentos", "Lancamentos guardam anexos e comprovantes", "Programados podem ser pagos, pausados ou recorrentes"],
    prompt: "Explique a tela Financeiro e analise meus lancamentos, vencimentos e proximas acoes sem alterar nada sem confirmacao.",
    quickPrompts: [
      { label: "Gerar insights financeiros", prompt: "Analise meus lancamentos financeiros recentes e aponte padroes, riscos ou economias possiveis." },
      { label: "Resumir vencimentos", prompt: "Resuma meus proximos vencimentos e boletos pendentes." },
    ],
  },
  Automacoes: {
    title: "Automacoes",
    description: "Crie fluxos visuais, teste sem efeitos reais e publique somente depois de homologar.",
    topics: ["Rascunho e o ambiente de edicao", "Homologacao valida o fluxo", "Producao executa a automacao real"],
    prompt: "Explique a tela de Automacoes e me ajude a criar ou revisar um fluxo usando linguagem simples, perguntando os dados que faltarem.",
    quickPrompts: [
      { label: "Analisar metricas", prompt: "Analise as automacoes ativas, quantas execucoes tiveram e quanto tempo economizaram." },
      { label: "Sugerir automacao", prompt: "Sugira uma nova automacao util com base no que ja esta configurado no Norium." },
    ],
  },
  Relatorios: {
    title: "Relatorios",
    description: "Transforme eventos e dados financeiros em indicadores, comparacoes e arquivos profissionais.",
    topics: ["Escolha periodo e canais", "Personalize as secoes antes de exportar", "Confira a origem dos numeros apresentados"],
    prompt: "Explique os relatorios do Norium e sugira o melhor periodo, indicadores e secoes para o relatorio que devo gerar.",
    quickPrompts: [
      { label: "Analisar metricas", prompt: "Analise as metricas de produtividade e financeiro do periodo atual e destaque os pontos mais importantes." },
      { label: "Gerar insights", prompt: "Gere insights acionaveis a partir do relatorio operacional atual." },
    ],
  },
  Propostas: {
    title: "Central de documentos",
    description: "Crie documentos comerciais, revise com a Nora, obtenha aprovacoes e converta propostas em contratos.",
    topics: ["Vincule cliente e brainstorm de origem", "Edite com salvamento automatico e historico", "Depois da aprovacao, gere o contrato e transforme obrigacoes em tarefas"],
    prompt: "Explique a Central de Documentos e me ajude a preparar, revisar ou processar um documento comercial completo, perguntando os dados que estiverem faltando antes de executar qualquer acao.",
  },
  Perfil: {
    title: "Perfil do operador",
    description: "Atualize seus dados pessoais, foto, idioma, CEP e preferencias da Nora.",
    topics: ["Perfil identifica o operador", "CEP alimenta o clima do painel", "Preferencias da Nora sao individuais"],
    prompt: "Explique quais dados posso configurar no meu perfil e como cada opcao afeta minha experiencia no Norium.",
  },
  Configuracoes: {
    title: "Configuracoes",
    description: "Defina comportamento, aparencia, acessibilidade e preferencias gerais da sua conta.",
    topics: ["Mudancas visuais sao aplicadas em todo o sistema", "Acessibilidade reduz barreiras de uso", "Integracoes possuem configuracao propria"],
    prompt: "Explique as configuracoes do Norium e recomende ajustes adequados para meu uso, sem alterar nada antes de eu confirmar.",
  },
  Equipe: {
    title: "Equipe",
    description: "Gerencie membros, permissoes, responsabilidades e produtividade sem misturar contas.",
    topics: ["Selecione um membro para ver detalhes", "Permissoes controlam telas e integracoes", "O relatorio usa as tarefas atribuidas a cada pessoa"],
    prompt: "Explique a tela Equipe e resuma membros, permissoes e distribuicao das tarefas atuais.",
    quickPrompts: [
      { label: "Resumir atividade", prompt: "Resuma a atividade recente da equipe: membros, permissoes e distribuicao de tarefas." },
    ],
  },
  Clientes: {
    title: "Clientes",
    description: "Centralize dados, contatos, historico e proximas acoes de cada relacionamento.",
    topics: ["Evite cadastros duplicados", "Use a timeline para recuperar contexto", "Vincule tarefas e conversas ao cliente"],
    prompt: "Explique a area de Clientes e me ajude a organizar cadastros, historicos e proximos contatos.",
    quickPrompts: [
      { label: "Sugerir proximos passos", prompt: "Analise minha carteira de clientes e sugira proximos passos para os relacionamentos mais importantes." },
    ],
  },
  Governanca: {
    title: "Governanca",
    description: "Administre ambientes de trabalho, fontes de conhecimento, permissões e auditoria.",
    topics: ["Cada ambiente mantem dados isolados (nao confunda com Clientes, seu CRM)", "Documentos autorizados fundamentam respostas da Nora", "Confira os acessos da equipe e as ações registradas"],
    prompt: "Explique a Governanca do Norium e avalie ambientes de trabalho, fontes de conhecimento e acessos da equipe.",
    quickPrompts: [
      { label: "Analisar seguranca", prompt: "Explique a matriz de permissões e a trilha de auditoria disponíveis na Governança." },
      { label: "Resumir documentos", prompt: "Resuma os documentos e a base de conhecimento cadastrados na Governanca." },
    ],
  },
  Brainstorm: {
    title: "Estúdio colaborativo",
    description: "Organize ideias em tempo real, defina responsavel e encerre a sessao com decisoes claras.",
    topics: ["O cronometro delimita a dinamica", "Blocos podem ser agrupados e conectados", "Depois do encerramento a sessao fica bloqueada"],
    prompt: "Explique como conduzir um brainstorm no Norium e me ajude a preparar objetivo, duracao e estrutura da sessao.",
    quickPrompts: [
      { label: "Resumir sessoes", prompt: "Resuma as sessoes de brainstorm ativas e as principais ideias registradas." },
    ],
  },
  Ajuda: {
    title: "Ajuda e guia pratico",
    description: "Encontre orientacoes por modulo e atalhos para resolver duvidas sem sair do sistema.",
    topics: ["Pesquise pelo nome da funcao", "Abra o guia do modulo desejado", "Use a Nora para uma explicacao contextual"],
    prompt: "Quero ajuda para usar o Norium. Pergunte qual tarefa estou tentando realizar e me oriente passo a passo.",
  },
  Mais: {
    title: "Mais recursos",
    description: "Acesse modulos administrativos e recursos complementares disponiveis no seu plano.",
    topics: ["Itens indisponiveis mostram o motivo", "Atalhos respeitam suas permissoes", "Recursos novos aparecem aqui"],
    prompt: "Explique os recursos da tela Mais e indique quais deles podem ajudar no meu trabalho agora.",
  },
};

const moduleIcons: Record<GuidedModule, LucideIcon> = {
  Dashboard: LayoutDashboard,
  Central: Inbox,
  Controle: ShieldCheck,
  Pendencias: CheckSquare,
  Notificacoes: Bell,
  Emails: Mail,
  Agenda: CalendarDays,
  Chat: MessageSquare,
  TeamChat: MessagesSquare,
  Tarefas: CheckSquare,
  Gastos: CreditCard,
  Automacoes: GitBranch,
  Relatorios: BarChart3,
  Propostas: FileSignature,
  Perfil: UserRound,
  Configuracoes: Settings,
  Equipe: UsersRound,
  Clientes: UserRoundCheck,
  Governanca: ShieldCheck,
  Brainstorm: BrainCircuit,
  Ajuda: CircleHelp,
  Mais: Bot,
};

export default function ModuleCoach({
  module,
  onAskNora,
  compact = false,
}: {
  module: GuidedModule;
  onAskNora: (prompt: string) => void;
  compact?: boolean;
}) {
  const guide = guides[module];
  const GuideIcon = moduleIcons[module];

  if (compact) {
    return (
      <div className="norium-module-coach-compact" aria-label={`Ajuda contextual da tela ${guide.title}`}>
        <button type="button" className="norium-module-coach__ask" onClick={() => onAskNora(guide.prompt)}>
          <Sparkles size={16} /> Perguntar a Nora
        </button>
      </div>
    );
  }

  return (
    <aside className="norium-module-coach" aria-label={`Orientacao da tela ${guide.title}`}>
      <div className="norium-module-coach__intro">
        <span className="norium-module-coach__icon">
          <GuideIcon size={18} />
        </span>
        <span className="min-w-0">
          <strong>{guide.title}</strong>
          <small>{guide.description}</small>
        </span>
      </div>
      <details className="norium-module-coach__details">
        <summary>
          Como funciona <ChevronDown size={15} />
        </summary>
        <ul>
          {guide.topics.map((topic) => <li key={topic}>{topic}</li>)}
        </ul>
      </details>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="norium-module-coach__ask" onClick={() => onAskNora(guide.prompt)}>
          <Sparkles size={16} /> Perguntar a Nora
        </button>
        {guide.quickPrompts?.map((quick) => (
          <Button size="sm"
            key={quick.label}
           
            onClick={() => onAskNora(quick.prompt)}
            className="rounded-full text-[var(--text-secondary)] hover:border-[var(--primary)] hover:text-[var(--primary)]"
          >
            <Sparkles size={12} /> {quick.label}
          </Button>
        ))}
      </div>
    </aside>
  );
}
