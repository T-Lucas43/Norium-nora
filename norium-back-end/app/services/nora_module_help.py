from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass


@dataclass(frozen=True)
class ModuleHelp:
    module: str
    aliases: tuple[str, ...]
    response: str


NORA_CAPABILITIES_RESPONSE = """Eu atuo sobre os módulos reais do Norium e separo claramente consulta, preparação, confirmação e execução.

## Comunicação

| Área | O que posso fazer |
| --- | --- |
| E-mails | Listar, resumir, pesquisar, redigir, revisar, responder e enviar pelo Gmail conectado. |
| WhatsApp | Resumir a conversa selecionada e preparar uma resposta; o envio exige destinatário e texto revisados. |
| Chat da Equipe | Resumir conversas, organizar decisões e enviar mensagens internas autorizadas. |

## Organização e operação

| Área | O que posso fazer |
| --- | --- |
| Agenda | Consultar disponibilidade e criar, editar ou cancelar eventos com os dados obrigatórios. |
| Tarefas | Criar projetos e cards, consultar o Kanban e alterar responsável, prioridade, prazo ou status. |
| Financeiro | Registrar e consultar entradas, saídas, boletos, anexos e lembretes; não faço pagamentos. |
| Automações | Montar gatilhos, condições e ações, testar o fluxo e acompanhar execuções. |
| Estúdio | Criar sessões, resumir ideias, sugerir próximos passos e converter decisões em tarefas. |

## Documentos e conhecimento

| Área | O que posso fazer |
| --- | --- |
| Documentos | Criar propostas, contratos, currículos, relatórios e outros modelos cadastrados; revisar, editar a fonte e gerar novamente o PDF. |
| PDFs | Visualizar, extrair texto, comprimir, numerar, dividir, girar, combinar e converter imagens; PDFs ficam na Biblioteca automaticamente. |
| Conhecimento | Consultar fontes autorizadas do workspace com identificação da origem. |
| Relatórios | Organizar métricas reais do sistema em tabelas e exportações. |

## Administração e segurança

| Área | O que posso explicar ou consultar |
| --- | --- |
| Governança | Ambientes, fontes, permissões, riscos, controles e auditoria. |
| Clientes e equipe | Cadastros, relacionamentos, responsáveis, acessos e distribuição do trabalho. |
| Controle | Aprovações, integrações, auditoria, memória operacional e ações reversíveis. |

## Limites importantes

Não invento dados ausentes, não exponho segredos, não atravesso workspaces e não afirmo que uma ação foi executada sem confirmação real. Pagamentos, exclusões, assinaturas, compartilhamentos e envios sensíveis exigem revisão ou confirmação."""


MODULE_HELP: tuple[ModuleHelp, ...] = (
    ModuleHelp(
        module="nora",
        aliases=("tela da nora", "espaco da nora", "histórico da nora", "historico da nora"),
        response=(
            "A Nora tem uma tela própria no menu lateral do Norium. Clique em Nova conversa para começar "
            "e use o histórico lateral para buscar e retomar conversas anteriores. As mensagens são salvas "
            "na sua conta e no espaço de trabalho atual. Você pode renomear, exportar e excluir conversas. "
            "Peça ajuda para escrever, organizar tarefas, consultar e-mails, agenda e finanças. "
            "As ações disponíveis respeitam suas permissões e as integrações conectadas. "
            "O botão de microfone permite usar voz; as preferências ficam no botão de ajustes da conversa."
        ),
    ),
    ModuleHelp(
        module="dashboard",
        aliases=("meu dashboard", "tela dashboard", "dashboard", "meu dia"),
        response=(
            "O Dashboard é o resumo do seu dia no Norium. Ele reúne compromissos, mensagens importantes, "
            "tarefas prioritárias, pagamentos, aprovações e os próximos passos em um único lugar.\n\n"
            "Como usar:\n"
            "1. Confira o resumo e o clima no início do dia.\n"
            "2. Revise a atividade recente e a agenda de hoje.\n"
            "3. Abra os atalhos para ir diretamente ao e-mail, conversa, tarefa ou compromisso.\n"
            "4. Use o painel da Nora para pedir uma priorização do que merece atenção.\n\n"
            "A Central de trabalho reúne pendências e a caixa compartilhada; o Meu Dia permanece no Dashboard."
        ),
    ),
    ModuleHelp(
        module="emails",
        aliases=("tela de e-mails", "tela de emails", "e-mails", "emails", "gmail"),
        response=(
            "A tela de E-mails conecta sua conta Gmail ao Norium para pesquisar, organizar, ler, responder "
            "e enviar mensagens.\n\n"
            "Fluxo recomendado:\n"
            "1. Escolha a pasta ou use a pesquisa e os filtros avançados.\n"
            "2. Abra uma mensagem para consultar a conversa completa e os anexos.\n"
            "3. Marque, arquive, exclua ou classifique somente depois de conferir o conteúdo.\n"
            "4. Ao responder, peça uma sugestão à Nora, revise o texto e aceite, refaça ou ajuste antes do envio.\n"
            "5. Confirme destinatários, assunto e anexos antes de enviar.\n\n"
            "Nenhuma mensagem é enviada somente por abrir esta orientação."
        ),
    ),
    ModuleHelp(
        module="agenda",
        aliases=("tela de agenda", "tela agenda", "google agenda", "agenda"),
        response=(
            "A Agenda reúne compromissos locais e eventos sincronizados com o Google Agenda.\n\n"
            "Como usar:\n"
            "1. Alterne entre as visualizações diária, semanal, mensal e anual.\n"
            "2. Clique em um evento para consultar detalhes, editar ou excluir com confirmação.\n"
            "3. Use Novo evento para informar título, data, horário, participantes e lembrete.\n"
            "4. Ao pedir para a Nora agendar, responda às perguntas sequenciais até todos os dados estarem completos.\n"
            "5. Confira o calendário de destino antes de confirmar a criação.\n\n"
            "A Nora não altera a agenda sem reunir os dados necessários e receber sua confirmação."
        ),
    ),
    ModuleHelp(
        module="agendamentos",
        aliases=(
            "tela de agendamentos",
            "paginas de agendamento",
            "link de agendamento",
            "agendamentos",
        ),
        response=(
            "A tela de Agendamentos permite publicar páginas para clientes escolherem horários disponíveis sem acessar o Norium.\n\n"
            "Como usar:\n"
            "1. Cadastre os serviços, com duração, capacidade, intervalos e antecedência mínima.\n"
            "2. Defina horários semanais, pausas, exceções e períodos bloqueados.\n"
            "3. Crie uma página, ajuste a identidade visual e escolha os serviços oferecidos.\n"
            "4. Compartilhe o link público e acompanhe as reservas na seção Agendamentos.\n"
            "5. Cancele ou reagende somente depois de conferir cliente, serviço, data e horário.\n\n"
            "A disponibilidade é validada novamente pelo servidor ao confirmar a reserva para evitar conflito de horários."
        ),
    ),
    ModuleHelp(
        module="chat",
        aliases=("tela de chat", "conversas do chat", "chat", "whatsapp"),
        response=(
            "O Chat reúne as conversas do WhatsApp conectado.\n\n"
            "Como usar:\n"
            "1. Filtre por canal, mensagens não lidas, grupos ou arquivados.\n"
            "2. Selecione uma conversa para carregar o histórico e o contexto corretos.\n"
            "3. Consulte dados do contato ou do grupo, participantes e mídias compartilhadas.\n"
            "4. Envie texto, áudio ou arquivos e revise a pré-visualização antes do envio.\n"
            "5. Use a Nora com a conversa selecionada quando quiser resumir ou preparar uma resposta.\n\n"
            "Nenhuma mensagem é enviada sem uma conversa ativa e sua confirmação."
        ),
    ),
    ModuleHelp(
        module="tarefas",
        aliases=("tela de tarefas", "projetos e tarefas", "tarefas", "kanban"),
        response=(
            "A tela de Tarefas separa o trabalho por projeto e organiza cada tarefa em um quadro Kanban.\n\n"
            "Fluxo recomendado:\n"
            "1. Selecione ou crie um projeto com categoria, descrição, responsável e prazo.\n"
            "2. Abra o Kanban e crie a tarefa com prioridade, responsável, vencimento e etiquetas.\n"
            "3. Arraste o card entre Pendente, Em andamento, Em revisão e Concluída.\n"
            "4. Abra a tarefa para comentários, anexos e opção de adicionar o prazo ao Google Agenda.\n"
            "5. Use filtros para localizar itens atrasados, concluídos ou atribuídos a uma pessoa.\n\n"
            "A Nora pode preparar e executar a ação depois de confirmar projeto e dados obrigatórios."
        ),
    ),
    ModuleHelp(
        module="central",
        aliases=("central de trabalho", "central de atividades", "central"),
        response=(
            "A Central de trabalho unificou a antiga Central e o Centro de pendências. Ela reúne prioridades, "
            "caixa compartilhada, follow-ups, metas da equipe e gestão de dados.\n\n"
            "Como usar:\n"
            "1. Confira os indicadores e a próxima prioridade sugerida.\n"
            "2. Alterne entre Pendências, Caixa compartilhada, Follow-ups, Metas e equipe e Dados e segurança.\n"
            "3. Clique em um evento para abrir exatamente o item na tela de origem.\n"
            "4. Use Priorizar com a Nora para consultar os dados atuais e organizar os próximos passos.\n\n"
            "Para decidir o que exige atenção agora, priorize erros de integração, vencimentos, "
            "mensagens sem resposta e itens que aguardam aprovação."
        ),
    ),
    ModuleHelp(
        module="controle",
        aliases=("controle operacional", "controle"),
        response=(
            "O Controle operacional reúne aprovações, saúde das integrações, auditoria, memória da "
            "Nora, alertas e ações que podem ser desfeitas.\n\n"
            "Ordem recomendada:\n"
            "1. Revise aprovações pendentes antes de autorizar ações sensíveis.\n"
            "2. Verifique integrações com erro ou sincronização atrasada.\n"
            "3. Consulte a auditoria para saber quem alterou cada registro.\n"
            "4. Use o histórico de ações para conferir resultados e desfazer quando disponível.\n\n"
            "Nada é alterado somente por abrir esta orientação."
        ),
    ),
    ModuleHelp(
        module="pendencias",
        aliases=("centro de pendencias", "pendencias"),
        response=(
            "O antigo Centro de pendências agora fica na aba Pendências da Central de trabalho. Ela concentra aprovações, "
            "e-mails e conversas sem resposta, tarefas vencidas, pagamentos próximos e automações com erro.\n\n"
            "Sugestão de prioridade:\n"
            "1. Falhas de integração e automação que interrompem outros fluxos.\n"
            "2. Pagamentos vencidos e tarefas críticas.\n"
            "3. Mensagens aguardando resposta e compromissos próximos.\n"
            "4. Aprovações e itens informativos restantes.\n\n"
            "Abra sempre o item original antes de concluir a pendência."
        ),
    ),
    ModuleHelp(
        module="notificacoes",
        aliases=("notificacoes do sistema", "notificacoes", "alertas do sistema"),
        response=(
            "As Notificações exibem apenas avisos do próprio Norium: integrações desconectadas, "
            "erros, alertas de segurança, limites e atualizações críticas. Eventos de Gmail, WhatsApp, "
            "Agenda e outros canais aparecem na Central de atividades.\n\n"
            "Investigue primeiro alertas persistentes, falhas de autenticação e sincronizações paradas. "
            "Marque como lido somente depois de conferir a origem do aviso."
        ),
    ),
    ModuleHelp(
        module="financeiro",
        aliases=("tela financeiro", "tela de gastos", "financeiro", "gastos"),
        response=(
            "O Financeiro organiza entradas, saídas, lançamentos programados, boletos, comprovantes "
            "e conciliações.\n\n"
            "Fluxo recomendado:\n"
            "1. Use a visão geral para conferir saldo, vencimentos e valores pendentes.\n"
            "2. Abra Lançamentos para criar, editar, excluir, marcar como pago e gerenciar anexos.\n"
            "3. Use Programados para recorrências e lembretes antes do vencimento.\n"
            "4. Confira boletos e comprovantes antes de conciliar.\n"
            "5. Gere o relatório financeiro após aplicar período e filtros.\n\n"
            "Eu posso consultar ou preparar uma ação, mas qualquer alteração sensível exige confirmação."
        ),
    ),
    ModuleHelp(
        module="automacoes",
        aliases=("tela de automacoes", "automacoes", "automacao"),
        response=(
            "Automações conecta um gatilho a condições e ações em um fluxo visual.\n\n"
            "Como montar com segurança:\n"
            "1. Diga o que inicia o fluxo, por exemplo: novo e-mail ou tarefa vencida.\n"
            "2. Informe as condições que filtram quando ele deve agir.\n"
            "3. Escolha as ações e os dados que cada bloco utilizará.\n"
            "4. Salve como rascunho e use Testar fluxo para simular sem alterar dados reais.\n"
            "5. Homologue o resultado e só então publique em produção.\n\n"
            "Se você descrever o resultado em linguagem simples, eu faço perguntas sequenciais pelos "
            "dados que faltarem antes de criar o fluxo."
        ),
    ),
    ModuleHelp(
        module="relatorios",
        aliases=("tela de relatorios", "relatorios", "relatorio"),
        response=(
            "Relatórios transforma os eventos do Norium em indicadores operacionais e financeiros.\n\n"
            "Antes de gerar:\n"
            "1. Defina o período que representa a análise desejada.\n"
            "2. Selecione os canais e indicadores relevantes.\n"
            "3. Revise produtividade, tempo economizado e volume por canal.\n"
            "4. Personalize as seções, identidade visual e tema claro ou escuro.\n"
            "5. Exporte em PDF ou CSV e confira a origem dos números.\n\n"
            "Para acompanhamento semanal, recomendo tarefas concluídas, tempo de resposta, automações, "
            "gastos e principais pendências."
        ),
    ),
    ModuleHelp(
        module="perfil",
        aliases=("perfil do operador", "meu perfil", "perfil"),
        response=(
            "O Perfil contém seus dados pessoais e preferências individuais: nome, foto, idioma, CEP "
            "para o clima e comportamento da Nora.\n\n"
            "A foto e o nome identificam suas ações; o CEP alimenta o clima do Dashboard; idioma e "
            "preferências da Nora afetam somente sua experiência. Configurações gerais e integrações "
            "ficam na tela Configurações, separadas do perfil."
        ),
    ),
    ModuleHelp(
        module="configuracoes",
        aliases=("configuracoes do norium", "configuracoes", "aparencia"),
        response=(
            "Configurações reúne aparência, acessibilidade, comportamento do sistema, notificações e "
            "preferências da conta.\n\n"
            "Você pode ajustar tema e cores, contraste, redução de movimento, atalhos, avisos e opções "
            "gerais. As mudanças visuais são aplicadas em todos os módulos compatíveis. Credenciais e "
            "reconexões permanecem na área própria de cada integração."
        ),
    ),
    ModuleHelp(
        module="equipe",
        aliases=("tela equipe", "area de equipe", "equipe", "time"),
        response=(
            "Equipe permite administrar membros, acessos e distribuição de trabalho sem misturar contas.\n\n"
            "Selecione um membro para conferir permissões, tarefas atribuídas e indicadores por status. "
            "O relatório mostra pendentes, em execução, em revisão, finalizadas e vencidas por responsável. "
            "O líder pode liberar módulos e integrações conforme o plano, enquanto o chat interno mantém "
            "as conversas do time no mesmo contexto."
        ),
    ),
    ModuleHelp(
        module="chat da equipe",
        aliases=("tela chat da equipe", "chat da equipe", "chat interno", "conversa da equipe"),
        response=(
            "Chat da Equipe é o canal interno separado das conversas do WhatsApp. Ele reúne canais "
            "coletivos e mensagens diretas, mostra quem está online e mantém arquivos e contexto do time.\n\n"
            "Como usar:\n"
            "1. Selecione um canal ou uma pessoa na coluna lateral.\n"
            "2. Escreva a mensagem, mencione @nora ou um colega e anexe arquivos quando necessário.\n"
            "3. Confira participantes, presença e detalhes da conversa no painel de contexto.\n"
            "4. Use a Nora para resumir a conversa ou organizar os próximos passos.\n\n"
            "Mensagens desta tela permanecem no chat interno e não são enviadas ao WhatsApp."
        ),
    ),
    ModuleHelp(
        module="clientes",
        aliases=("area de clientes", "tela clientes", "clientes", "cliente"),
        response=(
            "Clientes reúne cadastro, contatos, histórico e próximos passos de cada relacionamento.\n\n"
            "Use a busca antes de criar um cadastro para evitar duplicidades. Dentro da ficha, consulte "
            "a timeline, vincule e-mails, conversas, tarefas, compromissos, gastos e arquivos, e registre "
            "a próxima ação com responsável e prazo."
        ),
    ),
    ModuleHelp(
        module="governanca",
        aliases=("governanca", "administracao da empresa"),
        response=(
            "Governança é o sistema que orienta decisões, distribui responsabilidades e monitora a execução com transparência. No Norium, ela conecta estrutura, conhecimento, riscos, controles e evidências.\n\n"
            "## Estrutura e direção\n\n"
            "Use Ambientes para separar dados e integrações por operação. Defina responsáveis e permissões coerentes com cada papel.\n\n"
            "## Informação e transparência\n\n"
            "Em Conhecimento, envie somente materiais autorizados. PDFs com texto são indexados e a Nora identifica a fonte consultada.\n\n"
            "## Riscos, controles e responsabilização\n\n"
            "Revise a matriz de permissões e a trilha de auditoria. O Controle operacional concentra aprovações, falhas de integração, histórico de ações e evidências para acompanhamento contínuo.\n\n"
            "## Princípios\n\n"
            "A tela adota integridade, transparência, equidade, responsabilização e sustentabilidade como referências de boa governança, sem substituir análise jurídica ou regulatória."
        ),
    ),
    ModuleHelp(
        module="brainstorm",
        aliases=("estudio", "estúdio", "brainstorm colaborativo", "brainstorm", "sessao de ideias"),
        response=(
            "O Estúdio (antigo Brainstorm) é um quadro colaborativo para transformar ideias em decisões.\n\n"
            "Comece com Plano do projeto, Brainstorming, Lista de afazeres, Anotações de reunião, "
            "Status do projeto ou Retrospectiva. Os modelos já trazem seções e cartões editáveis. "
            "Defina título, objetivo, responsável e duração; depois adicione notas, agrupe temas, conecte "
            "ideias e use votação quando necessário. O cronômetro é compartilhado. Quando a sessão termina, "
            "o quadro é bloqueado para novas alterações, preservando o resultado. Sessões anteriores podem "
            "ser editadas nas propriedades, arquivadas ou excluídas com confirmação."
        ),
    ),
    ModuleHelp(
        module="propostas",
        aliases=(
            "tela de documentos",
            "central de documentos",
            "documentos comerciais",
            "pdf studio",
            "tela de propostas",
            "propostas e contratos",
            "propostas",
            "proposta comercial",
            "contratos",
            "assinatura digital",
        ),
        response=(
            "Documentos e a central que leva propostas e contratos do rascunho ate a assinatura, "
            "reune arquivos importados e oferece ferramentas de PDF com revisao da Nora e aprovacao humana.\n\n"
            "Fluxo completo:\n"
            "1. Crie a proposta a partir de um cliente cadastrado; a origem pode ser uma sessão "
            "de brainstorm encerrada.\n"
            "2. Escreva o escopo no editor A4, com marca, cabeçalho, rodapé e assinantes "
            "(contratante, contratado e testemunhas).\n"
            "3. Peça a análise da Nora: ela aponta riscos de escopo, prazo, margem e cláusulas. "
            "Aceite ou rejeite cada sugestão — nada entra no documento sem sua decisão.\n"
            "4. Envie para aprovação. Em conta Equipe o pedido entra na fila do Controle; "
            "no modo Solo a aprovação é imediata.\n"
            "5. Depois de aprovada, gere o contrato e envie para assinatura. Só nesse momento "
            "o sistema cria o link seguro de cada assinante e dispara o e-mail.\n"
            "6. O cliente abre o link, confirma o código enviado por e-mail e assina. "
            "Ficam registrados data e hora em UTC, IP e o hash SHA-256 do documento.\n"
            "7. Com todas as assinaturas, o escopo vira tarefas e prazos automaticamente.\n\n"
            "Nenhum e-mail ou link de assinatura sai sem passar pela aprovação humana. "
            "A trilha de auditoria de cada etapa fica na Governança."
        ),
    ),
    ModuleHelp(
        module="agente navegador",
        aliases=("tela agente navegador", "agente navegador", "navegador web"),
        response=(
            "O Agente Navegador planeja e executa leituras de paginas publicas com controles de seguranca.\n\n"
            "Informe objetivo, URL e, se desejar, um perfil de dominios permitidos. Revise o risco e as etapas "
            "antes de executar. Pedidos com login, envio, compra, formulario, download ou outra acao sensivel "
            "param para aprovacao humana. A tela mostra progresso, resultado, erro e linha do tempo. Nesta versao "
            "o executor e somente leitura e bloqueia redes privadas, redirecionamentos e conteudo nao textual."
        ),
    ),
    ModuleHelp(
        module="conhecimento",
        aliases=("tela conhecimento", "conhecimento empresarial", "base de conhecimento"),
        response=(
            "Conhecimento organiza o contexto autorizado da empresa em bases independentes.\n\n"
            "Crie uma base, escolha visibilidade e adicione texto ou uma pagina publica. O Norium deduplica a fonte, "
            "divide o conteudo em trechos e registra a indexacao. Na busca, cada resultado informa base, fonte, "
            "trecho citavel, relevancia e aviso de desatualizacao. Permissoes sao aplicadas antes da recuperacao; "
            "nao use a tela para armazenar segredos ou materiais que voce nao esta autorizado a indexar."
        ),
    ),
    ModuleHelp(
        module="marketplace",
        aliases=("tela marketplace", "marketplace interno", "catalogo de componentes"),
        response=(
            "Marketplace interno instala agentes, automacoes, modelos e pacotes governados.\n\n"
            "Abra um item para revisar autor, versao, permissoes e dependencias. A instalacao exige confirmacao e "
            "cria um recurso real, sempre desativado para revisao. Atualizacoes preservam configuracoes e tambem "
            "exigem confirmacao. Ao remover, o Norium mantem historico e desativa o recurso associado em vez de "
            "apagar evidencias da operacao."
        ),
    ),
    ModuleHelp(
        module="ia e modelos",
        aliases=("tela ia e modelos", "ia e modelos", "roteamento de modelos", "multi modelo"),
        response=(
            "IA e Modelos administra provedores e politicas de roteamento da Nora e das automacoes.\n\n"
            "Cadastre provedor, modelo, capacidades, custo, privacidade e chave; o segredo e criptografado e nao "
            "volta pela API. Depois crie uma politica manual ou automatica, simule a rota sem consumir tokens e "
            "confira por que provedores foram aceitos ou rejeitados. O fallback considera capacidade, privacidade, "
            "custo e contexto e e bloqueado depois que uma acao externa ja foi confirmada."
        ),
    ),
    ModuleHelp(
        module="ajuda",
        aliases=("ajuda e guia pratico", "guia pratico", "quero ajuda", "ajuda"),
        response=(
            "Posso orientar qualquer fluxo do Norium passo a passo. Diga o resultado que deseja alcançar, "
            "por exemplo: responder um cliente, organizar tarefas, registrar um gasto, preparar uma reunião "
            "ou criar uma automação. Eu identifico o módulo correto, explico os passos e, quando você pedir "
            "uma execução, reúno os dados necessários antes de agir."
        ),
    ),
    ModuleHelp(
        module="mais",
        aliases=("tela mais", "mais recursos", "recursos da tela mais"),
        response=(
            "Mais reúne recursos complementares e administrativos que não precisam ocupar a navegação "
            "principal o tempo todo. Cada atalho respeita seu plano e suas permissões. Ao abrir um item, "
            "o Norium leva à tela correspondente; recursos ainda indisponíveis informam claramente o motivo "
            "e não exibem botões que fingem executar uma ação."
        ),
    ),
)


def _normalize(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value.lower().strip())
    return "".join(char for char in normalized if not unicodedata.combining(char))


def answer_module_help(message: str) -> dict[str, str] | None:
    text = _normalize(message)
    if re.search(r"\b(?:o\s+que\s+(?:voce|a\s+nora)\s+(?:e\s+capaz\s+de|pode|sabe)\s+fazer|tudo\s+(?:o\s+)?que\s+(?:voce|a\s+nora)\s+(?:pode|faz)|capacidades\s+da\s+nora)\b", text):
        return {
            "status": "orientacao",
            "module": "nora",
            "response": NORA_CAPABILITIES_RESPONSE,
        }
    asks_for_guidance = bool(
        re.search(
            r"\b(?:explique|explica|como\s+(?:usar|funciona)|me\s+ajude|ajuda|oriente|analise|"
            r"o\s+que\s+(?:e|faz)|para\s+que\s+serve|quais\s+dados|quais\s+recursos)\b",
            text,
        )
    )
    if not asks_for_guidance:
        return None

    ranked = sorted(
        (
            (len(_normalize(alias)), guide)
            for guide in MODULE_HELP
            for alias in guide.aliases
            if _normalize(alias) in text
        ),
        key=lambda item: item[0],
        reverse=True,
    )
    if not ranked:
        return None

    guide = ranked[0][1]
    return {
        "status": "orientacao",
        "module": guide.module,
        "response": guide.response,
    }
