"""Biblioteca autoral de modelos editaveis da Central de Documentos.

Os textos abaixo sao estruturas originais do Norium. Eles nao reproduzem
modelos de terceiros e funcionam como ponto de partida editavel, nunca como
aconselhamento juridico, contabil ou trabalhista.
"""

from __future__ import annotations

import html
from typing import Any


DOCUMENT_TYPE_LABELS: dict[str, str] = {
    "proposal": "Proposta",
    "contract": "Contrato",
    "term": "Termo e declaracao",
    "budget": "Orcamento e financeiro",
    "report": "Relatorio",
    "resume": "Curriculo e carreira",
    "letter": "Carta e comunicado",
    "invoice": "Fatura e cobranca",
    "receipt": "Recibo",
    "plan": "Plano",
    "policy": "Politica e norma",
    "hr": "Pessoas e RH",
    "certificate": "Certificado",
    "meeting": "Reuniao",
    "project": "Projeto",
    "marketing": "Marketing",
    "academic": "Educacao e pesquisa",
    "personal": "Pessoal",
    "custom": "Personalizado",
}


def document_type_label(value: str) -> str:
    return DOCUMENT_TYPE_LABELS.get(value, "Documento")


def _spec(
    slug: str,
    name: str,
    document_type: str,
    category: str,
    description: str,
    sections: tuple[str, ...],
    *,
    keywords: tuple[str, ...] = (),
    featured: bool = False,
    requires_client: bool = False,
    legal_review: bool = False,
    layout: str = "classic",
) -> dict[str, Any]:
    # A biblioteca viaja no carregamento inicial da tela. Mantemos a previa
    # deliberadamente compacta; as orientacoes completas ficam nos metadados e
    # a Nora expande cada secao apenas quando o usuario escolhe o modelo.
    section_html = "".join(f"<h2>{html.escape(section)}</h2><p>A definir.</p>" for section in sections)
    warning = (
        "<blockquote><strong>Revisão recomendada:</strong> adapte esta minuta ao caso concreto e submeta o texto a um profissional habilitado antes de assinar ou publicar.</blockquote>"
        if legal_review
        else ""
    )
    return {
        "id": f"standard_{document_type}_{slug}",
        "name": name,
        "description": description,
        "documentType": document_type,
        "category": category,
        "contentHtml": f"<h1>{html.escape(name)}</h1>{warning}{section_html}",
        "shared": True,
        "createdBy": "system",
        "createdAt": "2026-01-01T00:00:00+00:00",
        "updatedAt": "2026-01-01T00:00:00+00:00",
        "active": True,
        "isDefault": False,
        "variables": [],
        "featured": featured,
        "requiresClient": requires_client,
        "legalReview": legal_review,
        "layout": layout,
        "keywords": sorted({slug.replace("_", " "), name.lower(), category.lower(), *keywords}),
        "generationGuide": (
            f"Produza um {document_type_label(document_type).lower()} profissional do tipo {name}. "
            f"Organize o texto nas seções: {', '.join(sections)}. "
            "Use somente fatos fornecidos; marque informações ausentes como 'A definir' e não invente dados."
        ),
        "sections": list(sections),
    }


def extended_document_templates() -> list[dict[str, Any]]:
    """Retorna modelos amplos para negocios, carreira, operacao e vida pessoal."""

    specs = [
        # Propostas e vendas
        _spec("eventos", "Proposta para eventos", "proposal", "Comercial e vendas", "Escopo, producao e investimento para eventos corporativos ou sociais.", ("Contexto do evento", "Conceito e experiência", "Escopo de produção", "Cronograma", "Investimento", "Condições"), keywords=("evento", "producao", "cerimonial"), requires_client=True),
        _spec("patrocinio", "Proposta de patrocínio", "proposal", "Comercial e vendas", "Cotas, contrapartidas, audiência e métricas para patrocinadores.", ("Oportunidade", "Público e alcance", "Cotas de patrocínio", "Contrapartidas", "Métricas e prestação de contas", "Próximos passos"), keywords=("sponsor", "patrocinador"), requires_client=True),
        _spec("freelancer", "Proposta de trabalho freelancer", "proposal", "Comercial e vendas", "Proposta objetiva para projetos independentes e serviços especializados.", ("Necessidade do cliente", "Solução proposta", "Entregáveis", "Prazo e revisões", "Investimento", "Aceite"), keywords=("freela", "freelance", "autonomo"), requires_client=True, featured=True),
        _spec("imobiliaria", "Proposta imobiliária", "proposal", "Comercial e vendas", "Apresentação de imóvel, condições e etapas da negociação.", ("Objeto da proposta", "Características do imóvel", "Condições comerciais", "Documentação e diligências", "Prazos", "Aceite"), keywords=("imovel", "locacao", "compra"), requires_client=True, legal_review=True),
        _spec("treinamento", "Proposta de treinamento", "proposal", "Comercial e vendas", "Programa de capacitação com objetivos, conteúdo e avaliação.", ("Diagnóstico", "Objetivos de aprendizagem", "Programa", "Metodologia", "Agenda e participantes", "Investimento e avaliação"), keywords=("curso", "workshop", "capacitacao"), requires_client=True),
        _spec("pesquisa", "Proposta de pesquisa", "proposal", "Comercial e vendas", "Plano de pesquisa aplicada com método, amostra e entregáveis.", ("Problema e objetivo", "Perguntas de pesquisa", "Metodologia", "Amostra e fontes", "Cronograma", "Entregáveis e investimento"), keywords=("estudo", "levantamento", "survey"), requires_client=True),

        # Contratos, termos e politicas legais
        _spec("nda", "Acordo de confidencialidade (NDA)", "contract", "Jurídico e conformidade", "Minuta bilateral para proteção de informações confidenciais.", ("Partes", "Finalidade", "Informações confidenciais", "Obrigações e exceções", "Prazo", "Responsabilidade e foro"), keywords=("confidencialidade", "sigilo", "nda"), legal_review=True, requires_client=True, featured=True),
        _spec("parceria", "Contrato de parceria", "contract", "Jurídico e conformidade", "Regras de colaboração, responsabilidades, receitas e propriedade intelectual.", ("Partes e objetivo", "Responsabilidades", "Governança", "Receitas e despesas", "Propriedade intelectual", "Vigência e encerramento"), keywords=("sociedade", "colaboracao"), legal_review=True, requires_client=True),
        _spec("software", "Contrato de desenvolvimento de software", "contract", "Jurídico e conformidade", "Minuta para escopo, aceite, código, segurança e suporte.", ("Objeto e requisitos", "Etapas e aceite", "Preço e pagamento", "Código e propriedade intelectual", "Segurança e dados", "Garantia, suporte e rescisão"), keywords=("sistema", "aplicativo", "site", "tecnologia"), legal_review=True, requires_client=True, featured=True),
        _spec("marketing", "Contrato de serviços de marketing", "contract", "Jurídico e conformidade", "Minuta para campanhas, conteúdo, mídia, aprovações e métricas.", ("Objeto", "Canais e entregas", "Aprovações", "Mídia e orçamento", "Direitos de uso", "Vigência e rescisão"), keywords=("agencia", "trafego", "conteudo"), legal_review=True, requires_client=True),
        _spec("design", "Contrato de design e criação", "contract", "Jurídico e conformidade", "Minuta para criação visual, revisões, arquivos e licenças.", ("Briefing e objeto", "Entregáveis", "Rodadas de revisão", "Prazos", "Direitos autorais e licenças", "Pagamento e cancelamento"), keywords=("identidade visual", "branding", "ux", "ui"), legal_review=True, requires_client=True),
        _spec("sla", "Acordo de nível de serviço (SLA)", "contract", "Jurídico e conformidade", "Níveis de atendimento, disponibilidade, severidade e escalonamento.", ("Serviços cobertos", "Disponibilidade", "Severidades", "Tempos de resposta e solução", "Medição e créditos", "Exclusões e governança"), keywords=("suporte", "manutencao", "nivel de servico"), legal_review=True, requires_client=True),
        _spec("licenciamento", "Contrato de licenciamento", "contract", "Jurídico e conformidade", "Condições de uso de software, marca, conteúdo ou propriedade intelectual.", ("Objeto licenciado", "Licença concedida", "Restrições", "Remuneração", "Garantias", "Prazo e término"), keywords=("licenca", "royalty", "direitos"), legal_review=True, requires_client=True),
        _spec("dados_lgpd", "Acordo de tratamento de dados (LGPD)", "contract", "Jurídico e conformidade", "Papéis, finalidades, segurança, incidentes e direitos dos titulares.", ("Partes e papéis", "Dados e finalidades", "Base e instruções", "Segurança", "Suboperadores e transferências", "Incidentes, término e auditoria"), keywords=("lgpd", "dpa", "privacidade", "dados pessoais"), legal_review=True, requires_client=True, featured=True),
        _spec("compra_venda", "Contrato de compra e venda", "contract", "Jurídico e conformidade", "Minuta para descrição do bem, preço, entrega e garantias.", ("Partes", "Bem ou direito", "Preço e pagamento", "Entrega e transferência", "Garantias", "Inadimplemento e foro"), keywords=("venda", "comprar", "bem"), legal_review=True, requires_client=True),
        _spec("locacao", "Contrato de locação", "contract", "Jurídico e conformidade", "Minuta para imóvel ou bem móvel, encargos, garantias e vistoria.", ("Partes e objeto", "Prazo", "Aluguel e encargos", "Garantia", "Uso, manutenção e vistoria", "Rescisão e devolução"), keywords=("aluguel", "imovel", "inquilino"), legal_review=True, requires_client=True),
        _spec("mutuo", "Contrato de empréstimo", "contract", "Jurídico e conformidade", "Minuta para valor, devolução, encargos e garantias.", ("Partes", "Valor e liberação", "Prazo e parcelas", "Encargos", "Garantias", "Inadimplemento e quitação"), keywords=("mutuo", "emprestimo", "divida"), legal_review=True, requires_client=True),
        _spec("distrato", "Distrato contratual", "term", "Jurídico e conformidade", "Instrumento para encerrar uma relação e registrar obrigações remanescentes.", ("Contrato original", "Encerramento", "Valores e quitação", "Devoluções", "Confidencialidade remanescente", "Assinaturas"), keywords=("rescisao", "encerramento", "cancelamento"), legal_review=True, requires_client=True),
        _spec("aditivo", "Termo aditivo", "term", "Jurídico e conformidade", "Alteração controlada de escopo, prazo, preço ou cláusulas.", ("Instrumento original", "Motivo", "Alterações", "Efeitos financeiros", "Vigência", "Ratificação"), keywords=("alteracao contratual", "adendo"), legal_review=True, requires_client=True),
        _spec("uso_imagem", "Termo de autorização de uso de imagem", "term", "Jurídico e conformidade", "Autorização com finalidade, canais, prazo e limites de uso.", ("Identificação", "Materiais autorizados", "Finalidade e canais", "Prazo e território", "Remuneração", "Revogação e assinaturas"), keywords=("voz", "foto", "video", "imagem"), legal_review=True),
        _spec("privacidade", "Política de privacidade", "policy", "Jurídico e conformidade", "Estrutura de transparência sobre dados pessoais e direitos.", ("Quem somos", "Dados coletados", "Finalidades e bases", "Compartilhamento", "Segurança e retenção", "Direitos, cookies e contato"), keywords=("lgpd", "cookies", "dados pessoais"), legal_review=True, featured=True),
        _spec("termos_uso", "Termos de uso", "policy", "Jurídico e conformidade", "Regras de acesso, conta, conteúdo, responsabilidades e encerramento.", ("Aceite", "Elegibilidade e conta", "Uso permitido", "Conteúdo e propriedade", "Disponibilidade e responsabilidade", "Suspensão, alterações e foro"), keywords=("site", "aplicativo", "plataforma"), legal_review=True),

        # Curriculos e carreira
        _spec("ats", "Currículo profissional ATS", "resume", "Carreira", "Currículo limpo, objetivo e compatível com triagem automatizada.", ("Contato e objetivo", "Resumo profissional", "Experiência", "Formação", "Competências", "Idiomas e certificações"), keywords=("curriculo", "cv", "emprego", "vaga"), featured=True, layout="resume-ats"),
        _spec("duas_colunas", "Currículo em duas colunas", "resume", "Carreira", "Leitura rápida com competências, idiomas e contatos destacados em uma faixa lateral.", ("Contato e objetivo", "Resumo profissional", "Competências e idiomas", "Experiência", "Formação", "Cursos e certificações"), keywords=("duas colunas", "lateral", "moderno"), featured=True, layout="resume-sidebar"),
        _spec("foto_clean", "Currículo clean com foto", "resume", "Carreira", "Composição clara com retrato opcional, cores suaves e hierarquia profissional.", ("Contato e objetivo", "Perfil profissional", "Experiência", "Formação", "Competências", "Idiomas e certificações"), keywords=("foto", "retrato", "clean", "elegante"), featured=True, layout="resume-photo"),
        _spec("linha_tempo", "Currículo em linha do tempo", "resume", "Carreira", "Trajetória organizada cronologicamente para evidenciar progressão e continuidade.", ("Contato e objetivo", "Resumo profissional", "Linha do tempo da experiência", "Resultados", "Formação", "Competências e idiomas"), keywords=("timeline", "cronologico", "carreira"), layout="resume-timeline"),
        _spec("competencias", "Currículo orientado a competências", "resume", "Carreira", "Competências transferíveis e resultados em primeiro plano, indicado para transição ou lacunas.", ("Contato e objetivo", "Perfil", "Competências-chave", "Resultados e projetos", "Experiência", "Formação e cursos"), keywords=("habilidades", "transicao", "lacunas"), layout="resume-skills"),
        _spec("primeiro_emprego", "Currículo para primeiro emprego", "resume", "Carreira", "Destaque para formação, projetos, cursos e potencial.", ("Contato e objetivo", "Perfil", "Formação", "Projetos e atividades", "Cursos", "Competências"), keywords=("estagio", "jovem aprendiz", "sem experiencia")),
        _spec("executivo", "Currículo executivo", "resume", "Carreira", "Narrativa de liderança, resultados, governança e transformação.", ("Proposta de valor", "Resultados executivos", "Experiência de liderança", "Conselhos e governança", "Formação", "Idiomas"), keywords=("diretor", "gerente", "lideranca")),
        _spec("tecnologia", "Currículo de tecnologia", "resume", "Carreira", "Experiência, stack, projetos, arquitetura e impacto técnico.", ("Resumo técnico", "Competências", "Experiência", "Projetos relevantes", "Formação", "Certificações e links"), keywords=("desenvolvedor", "programador", "dados", "devops"), featured=True),
        _spec("criativo", "Currículo criativo", "resume", "Carreira", "Perfil para design, conteúdo, audiovisual e áreas criativas.", ("Apresentação", "Especialidades", "Experiência", "Portfólio e projetos", "Ferramentas", "Formação e reconhecimentos"), keywords=("designer", "portfolio", "criacao"), layout="resume-creative"),
        _spec("academico", "Currículo acadêmico", "resume", "Carreira", "Formação, pesquisa, publicações, docência e eventos.", ("Perfil acadêmico", "Formação", "Pesquisa", "Publicações", "Docência", "Projetos, prêmios e idiomas"), keywords=("lattes", "pesquisador", "professor")),
        _spec("transicao", "Currículo para transição de carreira", "resume", "Carreira", "Competências transferíveis, projetos e direção profissional.", ("Objetivo de transição", "Competências transferíveis", "Resultados relevantes", "Projetos e formação recente", "Experiência", "Plano de desenvolvimento"), keywords=("mudar de carreira", "recolocacao")),
        _spec("carta_apresentacao", "Carta de apresentação", "letter", "Carreira", "Carta personalizada para candidatura, vaga e empresa.", ("Saudação", "Motivação", "Aderência à vaga", "Evidências e resultados", "Disponibilidade", "Encerramento"), keywords=("cover letter", "candidatura", "vaga"), featured=True),
        _spec("recomendacao", "Carta de recomendação", "letter", "Carreira", "Recomendação profissional ou acadêmica baseada em evidências.", ("Relação com a pessoa", "Contexto", "Competências observadas", "Resultados", "Recomendação", "Contato"), keywords=("referencia", "indicacao")),

        # Pessoas e RH
        _spec("descricao_vaga", "Descrição de vaga", "hr", "Pessoas e RH", "Responsabilidades, requisitos, contexto e processo seletivo.", ("Sobre a função", "Responsabilidades", "Requisitos", "Diferenciais", "Condições e benefícios", "Processo seletivo"), keywords=("job description", "contratacao"), featured=True),
        _spec("carta_oferta", "Carta oferta de trabalho", "hr", "Pessoas e RH", "Resumo formal da proposta de contratação e condições.", ("Cargo e reporte", "Início e local", "Remuneração", "Benefícios", "Condições", "Aceite"), keywords=("offer letter", "proposta de emprego"), legal_review=True),
        _spec("onboarding", "Plano de onboarding", "hr", "Pessoas e RH", "Roteiro de integração para 30, 60 e 90 dias.", ("Objetivos", "Antes do primeiro dia", "Primeiros 30 dias", "60 dias", "90 dias", "Responsáveis e indicadores"), keywords=("integracao", "novo colaborador"), featured=True),
        _spec("manual_colaborador", "Manual do colaborador", "policy", "Pessoas e RH", "Cultura, rotina, políticas, conduta e canais internos.", ("Boas-vindas", "Cultura e princípios", "Jornada e rotina", "Benefícios e recursos", "Conduta e segurança", "Canais e ciência"), keywords=("handbook", "funcionario"), legal_review=True),
        _spec("avaliacao_desempenho", "Avaliação de desempenho", "hr", "Pessoas e RH", "Avaliação estruturada de resultados, competências e desenvolvimento.", ("Período e função", "Resultados", "Competências", "Pontos fortes", "Desenvolvimento", "Plano e acompanhamento"), keywords=("performance", "avaliar")),
        _spec("pdi", "Plano de desenvolvimento individual", "hr", "Pessoas e RH", "Objetivos de desenvolvimento, ações, apoio e evidências.", ("Objetivo profissional", "Competências atuais", "Lacunas", "Ações de desenvolvimento", "Recursos e mentores", "Marcos e revisão"), keywords=("pdi", "carreira")),
        _spec("feedback", "Registro de feedback", "hr", "Pessoas e RH", "Feedback respeitoso com contexto, comportamento, impacto e acordo.", ("Contexto", "Comportamento observado", "Impacto", "Reconhecimento", "Ajuste esperado", "Acordos e acompanhamento"), keywords=("1:1", "conversa")),
        _spec("entrevista", "Roteiro de entrevista", "hr", "Pessoas e RH", "Perguntas por competência, critérios e evidências.", ("Contexto da vaga", "Abertura", "Experiência", "Competências", "Caso prático", "Critérios e próximos passos"), keywords=("selecao", "candidato")),
        _spec("advertencia", "Advertência disciplinar", "hr", "Pessoas e RH", "Registro factual de ocorrência, orientação e ciência.", ("Identificação", "Fatos verificados", "Regra aplicável", "Orientação", "Recorrência e consequências", "Ciência"), keywords=("disciplinar", "ocorrencia"), legal_review=True),
        _spec("desligamento", "Checklist de desligamento", "hr", "Pessoas e RH", "Passos de acesso, patrimônio, comunicação e conhecimento.", ("Dados do desligamento", "Acessos", "Equipamentos", "Pendências", "Transferência de conhecimento", "Comunicação e conclusão"), keywords=("demissao", "offboarding"), legal_review=True),

        # Projetos e gestao
        _spec("business_plan", "Plano de negócios", "plan", "Estratégia e projetos", "Visão executiva, mercado, operação, finanças e riscos.", ("Resumo executivo", "Problema e solução", "Mercado e concorrência", "Modelo de negócio", "Operação e equipe", "Plano financeiro e riscos"), keywords=("empresa", "startup", "empreendimento"), featured=True),
        _spec("resumo_executivo", "Resumo executivo", "report", "Estratégia e projetos", "Síntese para decisão com contexto, análise e recomendação.", ("Decisão necessária", "Contexto", "Principais achados", "Opções", "Recomendação", "Próximos passos"), keywords=("sumario", "diretoria")),
        _spec("business_case", "Business case", "project", "Estratégia e projetos", "Justificativa, benefícios, custos, alternativas e riscos.", ("Oportunidade", "Cenário atual", "Alternativas", "Benefícios", "Custos e viabilidade", "Riscos e recomendação"), keywords=("caso de negocio", "viabilidade")),
        _spec("termo_abertura", "Termo de abertura de projeto", "project", "Estratégia e projetos", "Mandato inicial com objetivo, escopo, papéis e governança.", ("Justificativa", "Objetivos", "Escopo e exclusões", "Entregas e marcos", "Papéis", "Riscos, orçamento e aprovação"), keywords=("project charter", "tap"), featured=True),
        _spec("plano_projeto", "Plano de projeto", "project", "Estratégia e projetos", "Plano integrado de escopo, prazo, recursos, comunicação e riscos.", ("Objetivo e sucesso", "Escopo", "Cronograma", "Equipe e responsabilidades", "Comunicação e qualidade", "Riscos e mudanças"), keywords=("gestao", "pm")),
        _spec("status_projeto", "Relatório de status do projeto", "report", "Estratégia e projetos", "Situação executiva, progresso, decisões, riscos e próximos marcos.", ("Resumo", "Progresso", "Entregas concluídas", "Riscos e impedimentos", "Decisões necessárias", "Próximos passos"), keywords=("status report", "andamento"), featured=True),
        _spec("viabilidade", "Estudo de viabilidade", "report", "Estratégia e projetos", "Análise técnica, operacional, econômica e de riscos.", ("Objetivo", "Premissas", "Viabilidade técnica", "Viabilidade operacional", "Viabilidade financeira", "Riscos e conclusão"), keywords=("feasibility", "estudo")),
        _spec("plano_acao", "Plano de ação", "plan", "Estratégia e projetos", "Ações, responsáveis, prazos, indicadores e dependências.", ("Objetivo", "Diagnóstico", "Ações prioritárias", "Responsáveis e prazos", "Indicadores", "Riscos e acompanhamento"), keywords=("5w2h", "execucao"), featured=True),
        _spec("registro_riscos", "Registro de riscos", "project", "Estratégia e projetos", "Catálogo de riscos com probabilidade, impacto e resposta.", ("Contexto", "Riscos identificados", "Probabilidade e impacto", "Prevenção", "Contingência", "Responsáveis e revisão"), keywords=("risk register", "matriz")),
        _spec("ata_reuniao", "Ata de reunião", "meeting", "Estratégia e projetos", "Registro de participantes, decisões, ações e prazos.", ("Dados da reunião", "Participantes", "Pauta", "Discussões", "Decisões", "Ações, responsáveis e prazos"), keywords=("meeting minutes", "decisoes"), featured=True),
        _spec("pauta_reuniao", "Pauta de reunião", "meeting", "Estratégia e projetos", "Objetivo, tópicos, tempo, preparação e decisões esperadas.", ("Objetivo", "Participantes", "Preparação", "Pauta e tempo", "Decisões esperadas", "Próximos passos"), keywords=("agenda de reuniao", "meeting agenda")),

        # Financeiro e administrativo
        _spec("orcamento", "Orçamento comercial", "budget", "Financeiro e administrativo", "Itens, quantidades, preços, validade e condições.", ("Cliente e referência", "Itens e serviços", "Valores", "Impostos e despesas", "Validade", "Pagamento e aceite"), keywords=("cotacao", "preco", "quote"), requires_client=True, featured=True),
        _spec("fatura", "Fatura de serviços", "invoice", "Financeiro e administrativo", "Documento de cobrança com itens, vencimento e instruções.", ("Emitente e cliente", "Competência", "Itens faturados", "Totais", "Vencimento", "Instruções de pagamento"), keywords=("invoice", "cobranca"), requires_client=True),
        _spec("recibo", "Recibo de pagamento", "receipt", "Financeiro e administrativo", "Comprovante editável de valor recebido e finalidade.", ("Pagador e recebedor", "Valor", "Referência", "Forma de pagamento", "Data e local", "Assinatura"), keywords=("quitação", "pagamento"), requires_client=True),
        _spec("ordem_compra", "Ordem de compra", "budget", "Financeiro e administrativo", "Solicitação formal de itens, entrega, cobrança e aprovação.", ("Fornecedor", "Itens", "Preços e impostos", "Entrega", "Faturamento", "Aprovações"), keywords=("purchase order", "fornecedor")),
        _spec("prestacao_contas", "Prestação de contas", "report", "Financeiro e administrativo", "Resumo de recursos, despesas, comprovantes e saldo.", ("Período e responsável", "Recursos recebidos", "Despesas", "Comprovantes", "Saldo", "Pendências e declaração"), keywords=("despesas", "reembolso")),
        _spec("relatorio_financeiro", "Relatório financeiro gerencial", "report", "Financeiro e administrativo", "Receitas, despesas, caixa, desvios e projeções.", ("Resumo executivo", "Receitas", "Despesas", "Fluxo de caixa", "Desvios", "Projeções e ações"), keywords=("dre", "caixa", "resultado"), featured=True),
        _spec("politica_reembolso", "Política de despesas e reembolsos", "policy", "Financeiro e administrativo", "Regras, limites, comprovação, aprovação e prazos.", ("Objetivo", "Elegibilidade", "Despesas permitidas", "Limites", "Comprovantes e aprovação", "Prazos e exceções"), keywords=("viagem", "expense")),
        _spec("cobranca", "Carta de cobrança", "letter", "Financeiro e administrativo", "Comunicação profissional de pendência, prazo e canais.", ("Identificação", "Pendência", "Histórico", "Prazo", "Formas de regularização", "Contato"), keywords=("inadimplencia", "vencido"), requires_client=True, legal_review=True),

        # Marketing e comunicacao
        _spec("briefing_criativo", "Briefing criativo", "marketing", "Marketing e comunicação", "Objetivo, público, mensagem, canais e restrições.", ("Contexto", "Objetivo", "Público", "Mensagem", "Entregas e canais", "Tom, referências e restrições"), keywords=("criacao", "campanha"), featured=True),
        _spec("plano_marketing", "Plano de marketing", "plan", "Marketing e comunicação", "Mercado, posicionamento, canais, campanhas e métricas.", ("Diagnóstico", "Objetivos", "Públicos", "Posicionamento", "Canais e calendário", "Orçamento e indicadores"), keywords=("marketing plan", "estrategia")),
        _spec("calendario_conteudo", "Plano de conteúdo", "marketing", "Marketing e comunicação", "Pilares, formatos, canais, calendário e mensuração.", ("Objetivo", "Público", "Pilares editoriais", "Formatos e canais", "Calendário", "Métricas e rotina"), keywords=("redes sociais", "editorial", "social media")),
        _spec("press_release", "Comunicado à imprensa", "letter", "Marketing e comunicação", "Notícia com título, contexto, dados e contatos.", ("Título", "Linha fina", "Abertura", "Contexto e dados", "Citações", "Sobre e contato de imprensa"), keywords=("press release", "imprensa")),
        _spec("case_sucesso", "Estudo de caso", "marketing", "Marketing e comunicação", "Desafio, solução, implementação, resultados e aprendizados.", ("Cliente e contexto", "Desafio", "Solução", "Implementação", "Resultados comprovados", "Aprendizados e depoimento"), keywords=("case study", "caso de sucesso"), featured=True),
        _spec("media_kit", "Mídia kit", "marketing", "Marketing e comunicação", "Posicionamento, audiência, formatos, números e contato comercial.", ("Apresentação", "Audiência", "Canais", "Formatos e entregas", "Resultados e cases", "Condições e contato"), keywords=("influenciador", "audiencia", "midia")),
        _spec("persona", "Documento de persona", "marketing", "Marketing e comunicação", "Perfil de público baseado em dados, dores, jornada e mensagens.", ("Contexto e fontes", "Perfil", "Objetivos", "Dores", "Comportamentos e jornada", "Mensagens e hipóteses"), keywords=("publico alvo", "buyer persona")),
        _spec("guia_marca", "Guia básico de marca", "marketing", "Marketing e comunicação", "Essência, voz, identidade e regras de aplicação.", ("Essência", "Públicos", "Posicionamento", "Tom de voz", "Identidade visual", "Aplicações e cuidados"), keywords=("brand guide", "branding")),

        # Operacoes, qualidade e atendimento
        _spec("procedimento", "Procedimento operacional padrão (POP)", "policy", "Operações e atendimento", "Passo a passo controlado com papéis, evidências e exceções.", ("Objetivo", "Escopo", "Responsabilidades", "Pré-requisitos", "Procedimento", "Controles, exceções e revisão"), keywords=("sop", "processo", "instrucao"), featured=True),
        _spec("manual_processo", "Manual de processo", "policy", "Operações e atendimento", "Visão ponta a ponta, entradas, etapas, saídas e indicadores.", ("Finalidade", "Entradas e saídas", "Papéis", "Fluxo", "Sistemas e registros", "Indicadores e melhoria"), keywords=("workflow", "rotina")),
        _spec("relatorio_incidente", "Relatório de incidente", "report", "Operações e atendimento", "Linha do tempo, impacto, causa, resposta e prevenção.", ("Resumo", "Impacto", "Linha do tempo", "Resposta", "Causa raiz", "Ações corretivas e preventivas"), keywords=("post mortem", "falha", "indisponibilidade"), featured=True),
        _spec("plano_continuidade", "Plano de continuidade do negócio", "plan", "Operações e atendimento", "Serviços críticos, resposta, recuperação e testes.", ("Objetivo e escopo", "Serviços críticos", "Cenários", "Estratégia de resposta", "Recuperação e comunicação", "Testes e manutenção"), keywords=("bcp", "crise", "desastre")),
        _spec("checklist_qualidade", "Checklist de qualidade", "policy", "Operações e atendimento", "Critérios verificáveis para revisão e aceite.", ("Objeto", "Critérios", "Evidências", "Não conformidades", "Responsáveis", "Aprovação"), keywords=("qa", "auditoria", "aceite")),
        _spec("relatorio_auditoria", "Relatório de auditoria", "report", "Operações e atendimento", "Escopo, método, evidências, achados e plano de ação.", ("Objetivo e escopo", "Critérios", "Metodologia", "Achados", "Riscos", "Recomendações e plano"), keywords=("compliance", "conformidade")),
        _spec("script_atendimento", "Script de atendimento", "policy", "Operações e atendimento", "Abertura, descoberta, solução, objeções e encerramento.", ("Objetivo", "Abertura", "Perguntas de descoberta", "Orientações", "Objeções", "Encerramento e registro"), keywords=("cliente", "suporte", "vendas")),
        _spec("faq", "FAQ - Perguntas frequentes", "policy", "Operações e atendimento", "Perguntas, respostas, limites e encaminhamentos.", ("Sobre", "Acesso", "Uso", "Cobrança", "Privacidade e segurança", "Suporte"), keywords=("duvidas", "central de ajuda")),

        # Educacao e pesquisa
        _spec("projeto_pesquisa", "Projeto de pesquisa acadêmica", "academic", "Educação e pesquisa", "Problema, objetivos, referencial, método e cronograma.", ("Tema e problema", "Justificativa", "Objetivos", "Referencial", "Metodologia", "Cronograma e referências"), keywords=("tcc", "monografia", "dissertacao"), featured=True),
        _spec("plano_aula", "Plano de aula", "academic", "Educação e pesquisa", "Objetivos, conteúdos, metodologia, recursos e avaliação.", ("Identificação", "Objetivos", "Conteúdos", "Metodologia", "Recursos e tempo", "Avaliação e adaptações"), keywords=("professor", "ensino")),
        _spec("plano_estudos", "Plano de estudos", "academic", "Educação e pesquisa", "Meta, diagnóstico, rotina, recursos e revisões.", ("Objetivo", "Diagnóstico", "Conteúdos", "Cronograma", "Métodos e recursos", "Avaliação e ajustes"), keywords=("concurso", "prova", "aprender")),
        _spec("relatorio_academico", "Relatório acadêmico", "academic", "Educação e pesquisa", "Introdução, método, resultados, discussão e referências.", ("Introdução", "Objetivos", "Método", "Resultados", "Discussão", "Conclusão e referências"), keywords=("trabalho", "experimento")),
        _spec("fichamento", "Fichamento de leitura", "academic", "Educação e pesquisa", "Referência, síntese, conceitos, trechos e análise crítica.", ("Referência", "Tema", "Síntese", "Conceitos", "Trechos selecionados", "Análise e relações"), keywords=("livro", "artigo", "leitura")),
        _spec("certificado", "Certificado de participação", "certificate", "Educação e pesquisa", "Certificado editável com atividade, carga horária e validação.", ("Instituição", "Participante", "Atividade", "Período e carga horária", "Local e data", "Assinaturas e validação"), keywords=("curso", "evento", "conclusao")),

        # Cartas, declaracoes e organizacao pessoal
        _spec("declaracao", "Declaração", "term", "Cartas e vida pessoal", "Declaração objetiva de fato, finalidade, data e responsabilidade.", ("Declarante", "Fato declarado", "Finalidade", "Ressalvas", "Local e data", "Assinatura"), keywords=("declaro", "comprovacao"), legal_review=True),
        _spec("autorizacao", "Autorização", "term", "Cartas e vida pessoal", "Autorização delimitada por pessoa, ato, prazo e condições.", ("Autorizante", "Autorizado", "Ato autorizado", "Limites", "Prazo", "Assinatura"), keywords=("autorizar", "permissao"), legal_review=True),
        _spec("procuracao", "Procuração simples", "term", "Cartas e vida pessoal", "Outorga de poderes específicos com prazo e limites.", ("Outorgante", "Outorgado", "Poderes", "Limites", "Validade", "Local, data e assinatura"), keywords=("representar", "poderes"), legal_review=True),
        _spec("carta_formal", "Carta formal", "letter", "Cartas e vida pessoal", "Correspondência profissional com assunto, contexto e solicitação.", ("Remetente e destinatário", "Assunto", "Saudação", "Contexto", "Solicitação ou informação", "Encerramento"), keywords=("oficio", "correspondencia")),
        _spec("comunicado", "Comunicado interno", "letter", "Cartas e vida pessoal", "Mensagem objetiva para equipes com impacto e ação esperada.", ("Título", "Público", "Contexto", "O que muda", "Ação necessária", "Data e contato"), keywords=("aviso", "anuncio")),
        _spec("roteiro_viagem", "Roteiro de viagem", "personal", "Cartas e vida pessoal", "Itinerário, reservas, atividades, custos e contatos.", ("Visão geral", "Transporte", "Hospedagem", "Roteiro diário", "Orçamento", "Documentos e contatos"), keywords=("ferias", "itinerario")),
        _spec("planejamento_semanal", "Planejamento semanal", "personal", "Cartas e vida pessoal", "Prioridades, agenda, tarefas, hábitos e revisão.", ("Foco da semana", "Prioridades", "Agenda", "Tarefas", "Hábitos", "Revisão"), keywords=("planner", "semana")),
    ]
    # Cobertura segmentada inspirada nas necessidades listadas pela pagina de
    # propostas indicada pelo usuario. Cada item e uma estrutura autoral do
    # Norium e permanece totalmente editavel.
    segment_proposals = (
        ("arquitetura", "Arquitetura", "conceito, programa, estudos, projeto e compatibilização"),
        ("engenharia", "Engenharia", "premissas técnicas, cálculos, projetos, responsabilidade e entregas"),
        ("projeto_obras", "Projeto e execução de obras", "levantamento, projeto, mobilização, execução, medições e entrega"),
        ("gerenciamento_obras", "Gerenciamento de obras", "planejamento, fiscalização, qualidade, custos, riscos e reportes"),
        ("laudos", "Laudos e perícias", "objeto, vistoria, método, evidências, conclusões e responsabilidade técnica"),
        ("construcao_reforma", "Construção e reforma", "ambientes, serviços, materiais, mão de obra, cronograma e aceite"),
        ("impermeabilizacao", "Impermeabilização", "diagnóstico, áreas, sistema, preparação, testes e garantia"),
        ("telhados", "Telhados e coberturas", "vistoria, solução, materiais, segurança, execução e garantia"),
        ("energia_solar", "Energia solar", "consumo, dimensionamento, equipamentos, instalação, homologação e retorno"),
        ("eletrica_hidraulica", "Elétrica e hidráulica", "levantamento, pontos, materiais, normas, testes e entrega"),
        ("pintura", "Pintura", "áreas, preparação, materiais, demãos, proteção e acabamento"),
        ("climatizacao", "Climatização", "carga, equipamentos, instalação, comissionamento e manutenção"),
        ("pos_obra", "Limpeza pós-obra", "áreas, etapas, equipe, insumos, descarte e vistoria final"),
        ("pisos_revestimentos", "Pisos e revestimentos", "metragem, base, materiais, paginação, instalação e acabamento"),
        ("drywall_gesso", "Drywall e gesso", "ambientes, sistemas, estrutura, fechamentos, acabamento e prazo"),
        ("divisorias_cortinas", "Divisórias, persianas e cortinas", "medidas, modelos, tecidos ou materiais, instalação e garantia"),
        ("serralheria_vidracaria", "Serralheria e vidraçaria", "medidas, materiais, ferragens, fabricação, instalação e segurança"),
        ("marcenaria", "Marcenaria sob medida", "ambientes, projeto, materiais, ferragens, fabricação e montagem"),
        ("manutencao_predial", "Manutenção predial", "ativos, cobertura, preventiva, corretiva, SLA e relatórios"),
        ("seguranca_cftv", "Segurança e CFTV", "riscos, pontos, equipamentos, instalação, acesso e suporte"),
        ("limpeza", "Serviços de limpeza", "áreas, frequência, equipe, insumos, rotinas e indicadores"),
        ("consultoria_gestao", "Consultoria em gestão", "diagnóstico, processos, indicadores, plano de ação e acompanhamento"),
        ("consultoria_financeira", "Consultoria financeira", "diagnóstico, caixa, custos, preços, projeções e plano de ação"),
        ("consultoria_rh", "Consultoria de RH", "diagnóstico, políticas, cargos, desenvolvimento, indicadores e implantação"),
        ("software", "Software e aplicativos", "descoberta, módulos, integrações, testes, implantação e suporte"),
        ("infra_devops", "Infraestrutura e DevOps", "ambientes, arquitetura, automação, segurança, observabilidade e SLA"),
        ("integracoes_automacoes", "Integrações e automações", "sistemas, fluxos, dados, exceções, testes e monitoramento"),
        ("trafego_pago", "Gestão de tráfego pago", "objetivo, canais, campanhas, verba, otimização e métricas"),
        ("social_media", "Social media", "público, pilares, calendário, formatos, aprovações e métricas"),
        ("branding", "Branding e identidade visual", "diagnóstico, estratégia, conceito, sistema visual, aplicações e guia"),
        ("sites", "Criação de sites", "objetivo, arquitetura, conteúdo, design, desenvolvimento, publicação e suporte"),
        ("advocacia", "Assessoria jurídica", "demanda, escopo, estratégia, documentos, limites e honorários"),
        ("auditoria_compliance", "Auditoria e compliance", "escopo, critérios, evidências, achados, riscos e recomendações"),
        ("recrutamento", "Recrutamento e seleção", "perfil, divulgação, triagem, entrevistas, shortlist e garantia"),
        ("terceirizacao_equipes", "Terceirização de equipes", "perfis, alocação, gestão, indicadores, substituição e condições"),
        ("fretes_transporte", "Fretes e transporte", "origem, destino, carga, prazos, rastreio, seguros e valores"),
        ("gestao_frotas", "Gestão de frotas", "veículos, operação, manutenção, telemetria, custos e indicadores"),
        ("producao_video", "Produção de vídeo", "conceito, roteiro, pré-produção, captação, edição, revisões e direitos"),
        ("eventos_corporativos", "Eventos corporativos", "objetivo, público, estrutura, produção, fornecedores e cronograma"),
        ("buffet_catering", "Buffet e catering", "evento, público, cardápio, equipe, estrutura, logística e condições"),
        ("fornecimento_produtos", "Fornecimento de produtos", "itens, especificações, quantidades, logística, garantia e pagamento"),
        ("representacao_comercial", "Representação comercial", "território, portfólio, metas, comissões, suporte e governança"),
        ("saude_bem_estar", "Saúde e bem-estar", "público, serviços, profissionais, agenda, cuidados e condições"),
        ("educacao_treinamento", "Educação e treinamento", "público, objetivos, conteúdo, método, agenda, avaliação e investimento"),
        ("turismo_hospitalidade", "Turismo e hospitalidade", "perfil, roteiro ou operação, serviços, reservas, logística e condições"),
    )
    specs.extend(
        _spec(
            f"segmento_{slug}",
            f"Proposta - {name}",
            "proposal",
            "Propostas por segmento",
            f"Modelo especializado para {name.lower()}, com escopo e condições organizados para apresentação ao cliente.",
            ("Contexto e necessidade", "Solução proposta", "Escopo e entregáveis", "Método e cronograma", "Investimento", "Condições e próximos passos"),
            keywords=(slug.replace("_", " "), name.lower()),
            requires_client=True,
            featured=slug in {"arquitetura", "software", "social_media", "eventos_corporativos"},
        )
        | {"generationGuide": f"Estruture uma proposta profissional de {name.lower()}. Detalhe {guide}. Use somente fatos fornecidos, sinalize lacunas como 'A definir' e mantenha o texto editável."}
        for slug, name, guide in segment_proposals
    )
    return specs
