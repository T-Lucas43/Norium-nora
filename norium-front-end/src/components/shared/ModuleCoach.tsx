import { ChevronDown, CircleHelp, Sparkles } from "lucide-react";

export type GuidedModule =
  | "Dashboard"
  | "Central"
  | "Controle"
  | "Pendencias"
  | "Notificacoes"
  | "Emails"
  | "Agenda"
  | "Chat"
  | "Tarefas"
  | "Gastos"
  | "Automacoes"
  | "Relatorios"
  | "Perfil"
  | "Configuracoes"
  | "Equipe"
  | "Clientes"
  | "Governanca"
  | "Brainstorm"
  | "Ajuda"
  | "Mais";

type ModuleGuide = {
  title: string;
  description: string;
  topics: string[];
  prompt: string;
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
  },
  Controle: {
    title: "Controle operacional",
    description: "Reuna aprovacoes, saude das integracoes, auditoria, modelos e acoes reversiveis.",
    topics: ["Aprovacoes protegem acoes sensiveis", "Saude mostra falhas de sincronizacao", "Auditoria registra quem fez cada alteracao"],
    prompt: "Explique o Controle operacional do Norium e verifique aprovacoes, integracoes ou riscos que exigem minha atencao.",
  },
  Pendencias: {
    title: "Centro de pendencias",
    description: "Priorize tudo que ainda depende de resposta, correcao, aprovacao ou pagamento.",
    topics: ["Use os filtros por origem e urgencia", "Abra o item original pelo atalho", "Conclua somente depois de validar a acao"],
    prompt: "Analise meu Centro de pendencias, explique os grupos e sugira uma ordem objetiva para resolver o que esta aberto.",
  },
  Notificacoes: {
    title: "Notificacoes do sistema",
    description: "Veja alertas globais, erros de conexao e avisos importantes do Norium.",
    topics: ["Alertas de canais ficam na Central", "Erros persistentes devem ser investigados", "Limpe apenas notificacoes ja conferidas"],
    prompt: "Explique minhas notificacoes do sistema e diga quais alertas devo investigar primeiro.",
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
  },
  Automacoes: {
    title: "Automacoes",
    description: "Crie fluxos visuais, teste sem efeitos reais e publique somente depois de homologar.",
    topics: ["Rascunho e o ambiente de edicao", "Homologacao valida o fluxo", "Producao executa a automacao real"],
    prompt: "Explique a tela de Automacoes e me ajude a criar ou revisar um fluxo usando linguagem simples, perguntando os dados que faltarem.",
  },
  Relatorios: {
    title: "Relatorios",
    description: "Transforme eventos e dados financeiros em indicadores, comparacoes e arquivos profissionais.",
    topics: ["Escolha periodo e canais", "Personalize as secoes antes de exportar", "Confira a origem dos numeros apresentados"],
    prompt: "Explique os relatorios do Norium e sugira o melhor periodo, indicadores e secoes para o relatorio que devo gerar.",
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
  },
  Clientes: {
    title: "Clientes",
    description: "Centralize dados, contatos, historico e proximas acoes de cada relacionamento.",
    topics: ["Evite cadastros duplicados", "Use a timeline para recuperar contexto", "Vincule tarefas e conversas ao cliente"],
    prompt: "Explique a area de Clientes e me ajude a organizar cadastros, historicos e proximos contatos.",
  },
  Governanca: {
    title: "Governanca",
    description: "Administre empresas, atendimento, documentos, seguranca e politicas operacionais.",
    topics: ["Cada empresa mantem dados isolados", "Documentos autorizados fundamentam respostas da Nora", "Regras protegem credenciais e acoes sensiveis"],
    prompt: "Explique a Governanca do Norium e avalie empresas, documentos, atendimento e seguranca que precisam de configuracao.",
  },
  Brainstorm: {
    title: "Brainstorm colaborativo",
    description: "Organize ideias em tempo real, defina responsavel e encerre a sessao com decisoes claras.",
    topics: ["O cronometro delimita a dinamica", "Blocos podem ser agrupados e conectados", "Depois do encerramento a sessao fica bloqueada"],
    prompt: "Explique como conduzir um brainstorm no Norium e me ajude a preparar objetivo, duracao e estrutura da sessao.",
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
        <span className="norium-module-coach__icon"><CircleHelp size={17} /></span>
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
      <button type="button" className="norium-module-coach__ask" onClick={() => onAskNora(guide.prompt)}>
        <Sparkles size={16} /> Perguntar a Nora
      </button>
    </aside>
  );
}
