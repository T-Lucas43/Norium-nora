import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from app.services.nora_module_help import answer_module_help
from app.services.nora import NoraIAService


class NoraModuleHelpTest(unittest.TestCase):
    def test_answers_every_contextual_module_question(self) -> None:
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
            "propostas": "Explique a tela de Propostas do Norium.",
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
            with self.subTest(module=expected_module):
                answer = answer_module_help(question)
                self.assertIsNotNone(answer, question)
                assert answer is not None
                self.assertEqual(answer["module"], expected_module)
                self.assertGreater(len(answer["response"]), 80)

    def test_does_not_intercept_real_module_actions(self) -> None:
        """Pedido de acao vai para o LLM; so orientacao e respondida pelo catalogo."""
        self.assertIsNone(answer_module_help("gastei 47 reais hoje no pix comprando comida"))
        self.assertIsNone(answer_module_help("crie uma automacao quando chegar um email"))
        self.assertIsNone(answer_module_help("mande uma mensagem no chat da equipe"))
        self.assertIsNone(answer_module_help("crie uma proposta para o cliente Acme"))
        self.assertIsNone(answer_module_help("envie a proposta por email para o cliente"))

    def test_explains_full_real_capability_catalog_in_tab_ready_sections(self) -> None:
        answer = answer_module_help("Nora, o que você é capaz de fazer?")
        self.assertIsNotNone(answer)
        assert answer is not None
        self.assertEqual(answer["module"], "nora")
        self.assertIn("## Comunicação", answer["response"])
        self.assertIn("| Documentos |", answer["response"])
        self.assertIn("## Limites importantes", answer["response"])

    def test_every_ai_request_receives_the_current_sao_paulo_date(self) -> None:
        service = NoraIAService()
        messages = service._build_payload_messages([{"role": "user", "content": "Qual é o ano atual?"}], None)
        today = datetime.now(ZoneInfo("America/Sao_Paulo"))
        self.assertIn(today.strftime("%d/%m/%Y"), messages[0]["content"])
        self.assertIn(f"({today.year})", messages[0]["content"])


if __name__ == "__main__":
    unittest.main()
