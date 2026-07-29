from app.services.nora_module_help import answer_module_help


def test_answers_every_contextual_module_question() -> None:
    questions = {
        "dashboard": "Explique meu Dashboard e resuma o Meu Dia.",
        "central": "Explique de forma pratica como usar a Central de atividades do Norium.",
        "controle": "Explique o Controle operacional do Norium.",
        "pendencias": "Analise meu Centro de pendencias e explique os grupos.",
        "notificacoes": "Explique minhas notificacoes do sistema.",
        "emails": "Explique a tela de E-mails do Norium.",
        "agenda": "Explique a tela de Agenda e suas visualizacoes.",
        "chat": "Explique a tela de Chat e seus canais.",
        "tarefas": "Explique a tela de Tarefas e o Kanban.",
        "financeiro": "Explique a tela Financeiro sem alterar nada.",
        "automacoes": "Explique a tela de Automacoes e me ajude a criar um fluxo.",
        "relatorios": "Explique os relatorios do Norium.",
        "perfil": "Explique quais dados posso configurar no meu perfil.",
        "configuracoes": "Explique as configuracoes do Norium.",
        "equipe": "Explique a tela Equipe e suas permissoes.",
        "clientes": "Explique a area de Clientes.",
        "governanca": "Explique a Governanca do Norium.",
        "brainstorm": "Explique como conduzir um brainstorm no Norium.",
        "ajuda": "Quero ajuda para usar o Norium.",
        "mais": "Explique os recursos da tela Mais.",
    }

    for expected_module, question in questions.items():
        answer = answer_module_help(question)
        assert answer is not None, question
        assert answer["module"] == expected_module
        assert len(answer["response"]) > 80


def test_does_not_intercept_real_module_actions() -> None:
    assert answer_module_help("gastei 47 reais hoje no pix comprando comida") is None
    assert answer_module_help("crie uma automacao quando chegar um email") is None
    assert answer_module_help("mande uma mensagem no chat da equipe") is None
