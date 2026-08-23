from __future__ import annotations

import os
import shutil
import tempfile
import unittest


TEST_DATA_DIR = tempfile.mkdtemp(prefix="norium_commercial_")
os.environ["NORIUM_DATA_DIR"] = TEST_DATA_DIR

from app.modules.clients.router import ClientCreate, create_client  # noqa: E402
from app.modules.commercial.schemas import (  # noqa: E402
    ContractUpdate,
    InstantiateObligationsRequest,
    ProposalBriefRequest,
    ProposalCreate,
    ProposalUpdate,
    SignatureRequest,
    SignerInput,
)
from app.modules.commercial.nora_agent import handle_commercial_agent  # noqa: E402
from app.modules.commercial.nora_agent import handle_commercial_agent  # noqa: E402
from app.modules.commercial.repository import read_store, write_store  # noqa: E402
from app.modules.commercial.service import (  # noqa: E402
    _briefing_sentence_count,
    _draft_requires_expansion,
    _ensure_briefing_detail,
    _parse_briefing_response,
    _proposal_html_from_briefing,
    cancel_contract,
    create_contract,
    create_proposal,
    decide_suggestion,
    decide_proposal,
    delete_contract,
    instantiate_obligations,
    replace_visible_text,
    public_signature_data,
    send_for_signature,
    sign_contract_public,
    sign_contract,
    signature_links,
    submit_proposal,
    update_contract,
    update_proposal,
    standard_templates,
)


class CommercialModuleTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(TEST_DATA_DIR, ignore_errors=True)

    async def asyncSetUp(self) -> None:
        self.user = {
            "id": f"user-{self._testMethodName}",
            "nome": "Operador de teste",
            "email": "operador@norium.local",
            "plan": "solo",
            "role": "owner",
        }
        response = await create_client(
            ClientCreate(
                name="Cliente Comercial",
                email="cliente@empresa.local",
                document="12345678901",
            ),
            self.user,
        )
        self.client_id = response["item"]["id"]

    async def test_solo_pipeline_sanitizes_content_and_instantiates_tasks(self) -> None:
        proposal = await create_proposal(
            self.user,
            ProposalCreate(
                clientId=self.client_id,
                title="Implantacao Norium",
                contentHtml="<h1>Escopo</h1><script>alert('xss')</script><p>Entrega em 30 dias com duas revisoes.</p>",
                scopeSummary="Implantacao completa",
                amount=12_500,
                signers=[
                    SignerInput(
                        name="Cliente Comercial",
                        email="cliente@empresa.local",
                        role="client",
                        order=1,
                    ),
                ],
                deliverables=[
                    {
                        "title": "Configuracao inicial",
                        "description": "Configurar o ambiente contratado.",
                        "createCalendarEvent": False,
                    },
                ],
            ),
        )
        self.assertNotIn("<script", proposal["contentHtml"])
        self.assertIn("Entrega em 30 dias", proposal["contentHtml"])

        updated = await update_proposal(
            self.user,
            proposal["id"],
            ProposalUpdate(expectedVersion=1, title="Implantacao Norium revisada"),
        )
        self.assertEqual(updated["version"], 2)
        self.assertEqual(len(updated["revisions"]), 1)

        approved = await submit_proposal(self.user, proposal["id"], "Fluxo Solo")
        self.assertEqual(approved["status"], "approved")

        contract, converted = await create_contract(self.user, proposal["id"], None)
        self.assertEqual(converted["status"], "contracted")
        self.assertEqual(contract["proposalId"], proposal["id"])
        self.assertEqual(contract["client"]["id"], self.client_id)

        contract = await update_contract(
            self.user,
            contract["id"],
            ContractUpdate(expectedVersion=1, title="Contrato de Implantacao Norium"),
        )
        contract = await send_for_signature(self.user, contract["id"])
        self.assertEqual(contract["status"], "awaiting_signatures")

        signer = contract["signers"][0]
        contract = await sign_contract(
            self.user["id"],
            contract["id"],
            signer["id"],
            SignatureRequest(
                name="Cliente Comercial",
                email="cliente@empresa.local",
                consent=True,
            ),
            ip="127.0.0.1",
            user_agent="Norium Test",
            actor_id=self.user["id"],
        )
        self.assertEqual(contract["status"], "signed")
        self.assertNotIn("cliente@empresa.local", contract["auditTrail"][0]["emailHash"])

        instantiated = await instantiate_obligations(
            self.user,
            contract["id"],
            InstantiateObligationsRequest(
                projectId="default",
                projectName="Contrato",
                createCalendarEvents=False,
            ),
        )
        self.assertEqual(instantiated["contract"]["status"], "active")
        self.assertEqual(len(instantiated["tasks"]), 1)

    async def test_contract_draft_can_be_deleted_and_formal_contract_is_cancelled(self) -> None:
        proposal = await create_proposal(
            self.user,
            ProposalCreate(
                clientId=self.client_id,
                title="Contrato com ciclo de vida",
                contentHtml="<p>Escopo comercial aprovado.</p>",
            ),
        )
        approved = await submit_proposal(self.user, proposal["id"], "Fluxo Solo")
        draft, _ = await create_contract(self.user, approved["id"], None)

        removed, restored = await delete_contract(self.user, draft["id"])
        self.assertEqual(removed["status"], "draft")
        self.assertEqual(restored["status"], "approved")
        self.assertIsNone(restored["contractId"])

        recreated, _ = await create_contract(self.user, approved["id"], None)
        cancelled = await cancel_contract(self.user, recreated["id"])
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(cancelled["auditTrail"][0]["action"], "contract_cancelled")
        with self.assertRaisesRegex(Exception, "Somente minutas"):
            await delete_contract(self.user, cancelled["id"])

    async def test_nora_requires_confirmation_and_then_cancels_contract(self) -> None:
        proposal = await create_proposal(
            self.user,
            ProposalCreate(
                clientId=self.client_id,
                title="Contrato cancelado pela Nora",
                contentHtml="<p>Escopo aprovado.</p>",
            ),
        )
        approved = await submit_proposal(self.user, proposal["id"], "Fluxo Solo")
        contract, _ = await create_contract(self.user, approved["id"], None)

        preview = await handle_commercial_agent(self.user, f"Cancele o contrato {contract['title']}")
        self.assertEqual(preview["status"], "precisa_confirmacao")

        executed = await handle_commercial_agent(
            self.user,
            f"Cancelar definitivamente o contrato {contract['title']}",
        )
        self.assertEqual(executed["status"], "cancelado")
        self.assertEqual(executed["contract"]["status"], "cancelled")

    async def test_enterprise_requires_explicit_approval(self) -> None:
        enterprise_user = {**self.user, "plan": "enterprise"}
        proposal = await create_proposal(
            enterprise_user,
            ProposalCreate(
                clientId=self.client_id,
                title="Projeto Enterprise",
                contentHtml="<p>Escopo empresarial com prazo, aceite e revisoes.</p>",
            ),
        )
        submitted = await submit_proposal(enterprise_user, proposal["id"], "")
        self.assertEqual(submitted["status"], "in_review")

        approved = await decide_proposal(
            enterprise_user,
            proposal["id"],
            approved=True,
            note="Aprovado pelo gestor",
        )
        self.assertEqual(approved["status"], "approved")
        self.assertEqual(approved["approval"]["decisionNote"], "Aprovado pelo gestor")

    async def test_public_signature_link_opens_and_registers_audited_signature(self) -> None:
        proposal = await create_proposal(
            self.user,
            ProposalCreate(
                clientId=self.client_id,
                title="Proposta com assinatura publica",
                contentHtml="<h1>Escopo</h1><p>Documento pronto para assinatura.</p>",
                signers=[
                    SignerInput(
                        name="Cliente Comercial",
                        email="cliente@empresa.local",
                        role="client",
                        order=1,
                    ),
                ],
            ),
        )
        await submit_proposal(self.user, proposal["id"], "")
        contract, _ = await create_contract(self.user, proposal["id"], None)
        contract = await send_for_signature(self.user, contract["id"])

        links = signature_links(self.user["id"], contract, "http://127.0.0.1:5173")
        self.assertEqual(len(links), 1)
        token = links[0]["url"].rsplit("/", 1)[-1]
        invitation = public_signature_data(token)
        self.assertEqual(invitation["contract"]["id"], contract["id"])
        self.assertEqual(invitation["signer"]["email"], "cliente@empresa.local")

        signed = await sign_contract_public(
            token,
            SignatureRequest(
                name="Cliente Comercial",
                email="cliente@empresa.local",
                consent=True,
            ),
            ip="127.0.0.1",
            user_agent="Norium Public Signature Test",
        )
        self.assertEqual(signed["status"], "signed")
        self.assertEqual(signed["signers"][0]["status"], "signed")
        self.assertEqual(signed["auditTrail"][0]["action"], "contract_signed")
        self.assertEqual(signed["auditTrail"][0]["ip"], "127.0.0.1")
        self.assertNotIn("cliente@empresa.local", signed["auditTrail"][0]["emailHash"])

    async def test_nora_simple_command_starts_commercial_session(self) -> None:
        result = await handle_commercial_agent(self.user, "quero criar uma proposta")
        self.assertEqual(result["status"], "precisa_dados")
        self.assertTrue(str(result.get("session_id") or "").startswith("commercial_"))
        self.assertIn("cliente", result["response"].lower())

    async def test_consecutive_nora_suggestions_are_idempotent(self) -> None:
        proposal = await create_proposal(
            self.user,
            ProposalCreate(
                clientId=self.client_id,
                title="Proposta com revisoes",
                contentHtml="<h2>Escopo</h2><p>Entrega inicial.</p><p>Suporte basico.</p>",
            ),
        )
        store = read_store(self.user["id"])
        stored = next(item for item in store["proposals"] if item["id"] == proposal["id"])
        stored["suggestions"] = [
            {
                "id": "suggestion_one",
                "original": "Entrega inicial.",
                "replacement": "Entrega inicial com critérios de aceite.",
                "reason": "Tornar o aceite verificável.",
                "severity": "info",
                "status": "pending",
            },
            {
                "id": "suggestion_two",
                "original": "Suporte basico.",
                "replacement": "Suporte básico durante o período definido.",
                "reason": "Delimitar o suporte.",
                "severity": "warning",
                "status": "pending",
            },
        ]
        await write_store(self.user["id"], store)

        first = await decide_suggestion(self.user, proposal["id"], "suggestion_one", "accepted")
        second = await decide_suggestion(self.user, proposal["id"], "suggestion_two", "accepted")
        repeated = await decide_suggestion(self.user, proposal["id"], "suggestion_one", "accepted")

        self.assertIn("critérios de aceite", first["contentHtml"])
        self.assertIn("Suporte básico", second["contentHtml"])
        self.assertEqual(repeated["version"], second["version"])

    def test_nora_replacement_preserves_rich_text_block_structure(self) -> None:
        content = (
            "<h2>Escopo</h2>"
            "<p>Primeira parte do escopo.</p>"
            "<p>Segunda parte do escopo.</p>"
            "<h2>Entregaveis</h2>"
        )

        updated, applied = replace_visible_text(
            content,
            "Primeira parte do escopo. Segunda parte do escopo.",
            "Escopo detalhado, com atividades e criterios de aceite.",
        )

        self.assertTrue(applied)
        self.assertIn(
            "<p>Escopo detalhado, com atividades e criterios de aceite.</p><p></p>",
            updated,
        )
        self.assertEqual(updated.count("<h2>"), 2)
        self.assertIn("<h2>Entregaveis</h2>", updated)

    def test_nora_replacement_keeps_heading_and_body_styles_separate(self) -> None:
        content = (
            "<h2>Escopo</h2>"
            "<p>Desenvolvimento do portal do cliente.</p>"
            "<h2>Entregaveis</h2>"
        )

        updated, applied = replace_visible_text(
            content,
            "Escopo Desenvolvimento do portal do cliente.",
            "Escopo Desenvolvimento do portal do cliente com validacao em etapas e criterios de aceite.",
        )

        self.assertTrue(applied)
        self.assertIn("<h2>Escopo</h2>", updated)
        self.assertIn(
            "<p>Desenvolvimento do portal do cliente com validacao em etapas e criterios de aceite.</p>",
            updated,
        )
        self.assertIn("<h2>Entregaveis</h2>", updated)

    def test_standard_templates_cover_supported_categories(self) -> None:
        templates = standard_templates()
        for category in ("desenvolvimento", "marketing", "consultoria", "manutencao", "design", "recorrente"):
            self.assertTrue(any(item["id"] == f"standard_proposal_{category}" for item in templates))
            self.assertTrue(any(item["id"] == f"standard_contract_{category}" for item in templates))

    def test_structured_nora_briefing_is_rendered_as_readable_document(self) -> None:
        payload = ProposalBriefRequest(
            clientId=self.client_id,
            title="Reforma da Presença Digital",
            objective="Aumentar a taxa de conversão em 25% e modernizar a interface.",
            scopeNotes="Novas telas de checkout e reformulação do painel do usuário.",
            team="Designer, desenvolvedor front-end e líder técnico.",
            deadline="45 dias úteis.",
            deliverablesNotes="Protótipo; código-fonte; documentação.",
            exclusions="Conteúdo e mídia paga.",
            amount=15_000,
            currency="BRL",
        )
        response = """
        {
          "title": "Reforma da Presença Digital do Cliente",
          "scopeSummary": "Modernizar a experiência digital para apoiar o aumento da conversão e facilitar a jornada do usuário.",
          "expandedScope": {
            "objetivos": [
              {"title": "Aumentar a taxa de conversão", "description": "Melhorar a experiência de checkout com base no briefing aprovado."}
            ],
            "escopoInicial": [
              {"title": "Reformular o painel", "description": "Atualizar a experiência do usuário e validar o resultado com o cliente."}
            ]
          },
          "teamPlan": {
            "equipe": [
              {"nome": "Designer UI/UX", "função": "Prototipagem", "responsabilidades": ["Criar protótipos", "Validar a navegação"]}
            ]
          },
          "timeline": {
            "prazo": "45 dias úteis",
            "sprints": [
              {"nome": "Design", "duração": "15 dias", "tarefas": ["Criar protótipos", "Validar interfaces"]}
            ]
          },
          "deliverables": [
            {"title": "Protótipo navegável", "description": "Protótipo para validação do fluxo.", "responsible": "Designer UI/UX"}
          ],
          "exclusions": {"itens": ["Criação de conteúdo", "Mídia paga"]},
          "notes": "Validar critérios de aceite antes do início.",
          "noraComment": "Detalhei o briefing sem alterar as premissas informadas."
        }
        """
        client = {"id": self.client_id, "name": "Cliente Comercial"}
        draft = _parse_briefing_response(response, payload, client)
        document = _proposal_html_from_briefing(draft, client, payload)

        for value in (
            draft["scopeSummary"],
            draft["expandedScope"],
            draft["teamPlan"],
            draft["timeline"],
            draft["exclusions"],
            document,
        ):
            self.assertNotIn("{'", value)
            self.assertNotIn("['", value)
        self.assertIn("Objetivos", draft["expandedScope"])
        self.assertIn("Responsabilidades: Criar protótipos; Validar a navegação", draft["teamPlan"])
        self.assertIn("Duração: 15 dias", draft["timeline"])
        self.assertIn("Protótipo navegável", document)

    def test_serialized_structures_from_nora_are_decoded_before_rendering(self) -> None:
        payload = ProposalBriefRequest(
            clientId=self.client_id,
            objective="Modernizar a presenca digital e aumentar a conversao.",
            scopeNotes="Redesenhar o checkout e o painel do usuario.",
            team="Designer, desenvolvedor e lider tecnico.",
            deadline="45 dias uteis.",
            deliverablesNotes="Prototipo navegavel.",
            exclusions="Conteudo e midia paga.",
        )
        response = """
        {
          "title": "Modernizacao da plataforma",
          "scopeSummary": "A iniciativa moderniza a experiencia digital para apoiar a conversao. O trabalho organiza objetivos, validacoes e resultados esperados.",
          "expandedScope": "[{'title': 'Redesenho do checkout', 'description': 'Atualizar a jornada e validar a experiencia com o cliente.'}, {'title': 'Painel do usuario', 'description': 'Reorganizar as informacoes conforme o briefing aprovado.'}]",
          "teamPlan": "[{'nome': 'Designer', 'funcao': 'Prototipagem', 'responsabilidades': ['Mapear fluxos', 'Validar interfaces']}, {'nome': 'Desenvolvedor', 'funcao': 'Implementacao'}]",
          "timeline": "{'prazo': '45 dias uteis', 'etapas': [{'nome': 'Planejamento', 'duracao': '15 dias'}, {'nome': 'Execucao', 'duracao': '30 dias'}]}",
          "deliverables": [{"title": "Prototipo navegavel", "description": "Material navegavel para validar os fluxos, os limites do escopo e os criterios de aceite.", "responsible": "Designer"}],
          "exclusions": "{'itens': ['Conteudo', 'Midia paga']}",
          "notes": "Validar os criterios antes do inicio.",
          "noraComment": "Detalhei o briefing usando somente as informacoes fornecidas."
        }
        """
        client = {"id": self.client_id, "name": "Cliente Comercial"}
        draft = _parse_briefing_response(response, payload, client)
        document = _proposal_html_from_briefing(draft, client, payload)

        for value in (draft["expandedScope"], draft["teamPlan"], draft["timeline"], draft["exclusions"], document):
            self.assertNotIn("{'", value)
            self.assertNotIn("['", value)
        self.assertIn("Redesenho do checkout", draft["expandedScope"])
        self.assertIn("Responsabilidades: Mapear fluxos; Validar interfaces", draft["teamPlan"])
        self.assertIn("Prazo: 45 dias uteis", draft["timeline"])

    def test_detail_guard_expands_short_sections_without_inventing_facts(self) -> None:
        payload = ProposalBriefRequest(
            clientId=self.client_id,
            objective="Aumentar a conversao do portal.",
            scopeNotes="Redesenhar o checkout.",
            team="Designer e desenvolvedor.",
            deadline="30 dias.",
            deliverablesNotes="Prototipo.",
            exclusions="Midia paga.",
        )
        draft = {
            "title": "Proposta",
            "scopeSummary": payload.objective,
            "expandedScope": payload.scopeNotes,
            "teamPlan": payload.team,
            "timeline": payload.deadline,
            "deliverables": [
                {
                    "title": "Prototipo",
                    "description": "",
                    "responsibleId": "",
                    "responsibleName": "",
                    "dueDate": None,
                    "createCalendarEvent": True,
                }
            ],
            "exclusions": payload.exclusions,
            "notes": "",
            "noraComment": "",
        }

        detailed = _ensure_briefing_detail(draft, payload)

        self.assertGreaterEqual(_briefing_sentence_count(detailed["scopeSummary"]), 2)
        self.assertIn("Controle de mudanças", detailed["expandedScope"])
        self.assertIn("Responsabilidades", detailed["teamPlan"])
        self.assertIn("Acompanhamento", detailed["timeline"])
        self.assertIn("mudança de escopo", detailed["exclusions"])
        self.assertGreaterEqual(len(detailed["deliverables"][0]["description"]), 60)

    def test_copied_briefing_is_flagged_for_expansion(self) -> None:
        payload = ProposalBriefRequest(
            clientId=self.client_id,
            objective="Aumentar a taxa de conversão em 25% e modernizar a interface.",
            scopeNotes="Novas telas de checkout e reformulação do painel do usuário.",
        )
        draft = {
            "scopeSummary": payload.objective,
            "expandedScope": payload.scopeNotes,
            "teamPlan": "",
            "timeline": "",
        }
        self.assertTrue(_draft_requires_expansion(draft, payload))


if __name__ == "__main__":
    unittest.main()
