"""Editable starting boards for the Studio; never sample business data."""

import uuid


TEMPLATES = {
    "plano-projeto": [
        ("Objetivo e escopo", ["Defina o resultado esperado", "O que faz parte do projeto?"], "Registre contexto, entregáveis e critérios de sucesso."),
        ("Plano de ação", ["Primeira entrega", "Próxima etapa"], "Descreva a ação, atribua um responsável e defina o prazo.") ,
        ("Riscos e decisões", ["Riscos a acompanhar", "Decisões do projeto"], "Documente dependências, riscos e decisões da equipe."),
    ],
    "brainstorming": [
        ("Desafio", ["Qual problema vamos resolver?"], "Defina a pergunta que orienta esta sessão."),
        ("Ideias", ["Uma primeira possibilidade", "Uma abordagem diferente"], "Edite este cartão com sua ideia. Conecte, comente e vote."),
        ("Próximos passos", ["Ideia a desenvolver", "Como vamos validar?"], "Priorize com a equipe e transforme a decisão em tarefa."),
    ],
    "lista-afazeres": [
        ("A fazer", ["Defina sua primeira tarefa", "Adicione a próxima tarefa"], "Descreva a atividade, escolha um responsável e informe o prazo."),
        ("Em andamento", ["Atividade em execução"], "Arraste atividades para esta coluna conforme avançam."),
        ("Concluído", [], "Marque o item como concluído no painel de edição."),
    ],
    "anotacoes-reuniao": [
        ("Pauta", ["Objetivo da reunião", "Assuntos para discutir"], "Registre participantes, contexto e os tópicos da conversa."),
        ("Discussão e decisões", ["Anotações", "Decisões tomadas"], "Documente os pontos discutidos e os acordos da equipe."),
        ("Encaminhamentos", ["Ação após a reunião", "Próximo encontro"], "Defina responsáveis e prazos; converta ações em tarefas."),
    ],
    "status-projeto": [
        ("Progresso", ["Resumo do período", "Entregas realizadas"], "Registre avanços e resultados reais do projeto."),
        ("Pontos de atenção", ["Bloqueios e riscos", "Decisões necessárias"], "Descreva o impacto e a ajuda necessária."),
        ("Próximas entregas", ["Próximo marco", "Plano para o período"], "Defina o que vem a seguir, responsáveis e prazos."),
    ],
    "retrospectiva": [
        ("Continuar", ["O que funcionou bem?"], "Registre práticas que a equipe quer manter."),
        ("Parar", ["O que pode melhorar?"], "Identifique dificuldades e o que deve ser evitado."),
        ("Começar", ["O que vamos experimentar?", "Ação de melhoria"], "Escolha uma melhoria concreta e atribua um responsável."),
    ],
    "swot": [(label, ["Adicione sua análise"], "Registre evidências e possibilidades.") for label in ("Forças", "Fraquezas", "Oportunidades", "Ameaças")],
    "mapa-mental": [(label, ["Desenvolva esta ideia"], "Conecte ideias relacionadas.") for label in ("Ideia central", "Possibilidades", "Conexões")],
    "jornada": [(label, ["Descreva esta etapa"], "Registre ações, necessidades e oportunidades.") for label in ("Descoberta", "Experiência", "Continuidade")],
}


def build_template_board(template: str, objective: str = "") -> dict:
    nodes = []
    colors = ["#BAE6FD", "#DDD6FE", "#BBF7D0", "#FED7AA"]
    for column, (section, items, guidance) in enumerate(TEMPLATES.get(template, [])):
        nodes.append({
            "id": f"idea_{uuid.uuid4().hex}", "type": "idea",
            "position": {"x": column * 330, "y": 0},
            "data": {"label": section, "description": guidance, "variant": "frame", "color": colors[column % 4], "category": section},
        })
        for row, label in enumerate(items):
            data = {"label": label, "description": objective if column == row == 0 and objective else "", "variant": "sticky", "color": colors[column % 4], "category": section, "comments": [], "votes": []}
            if template in {"lista-afazeres", "plano-projeto", "anotacoes-reuniao"}:
                data["completed"] = False
            nodes.append({"id": f"idea_{uuid.uuid4().hex}", "type": "idea", "position": {"x": column * 330, "y": 210 + row * 200}, "data": data})
    return {"nodes": nodes, "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}}
