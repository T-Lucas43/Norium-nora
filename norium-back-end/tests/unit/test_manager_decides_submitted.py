"""Achado 2 (revisão 21/09): gestor decide proposta submetida pelo autor.

O modelo é por autor: a submissão grava `in_review` no armazenamento de quem
submeteu. O decisor autorizado (gestor/proprietário) localiza a proposta no
armazenamento do autor pelo resolvedor; `can_approve` permite aprovar ou
solicitar alterações sem conceder edição geral do conteúdo. Membro comum sem
papel de aprovação recebe 403 e nada vaza antes da transição a equipe.
Autor e gestor têm plano de equipe (sem plano, a submissão autoaprova e
esconde o defeito). Tudo com dados sintéticos.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException


TEST_DATA_DIR = tempfile.mkdtemp(prefix="norium_manager_decides_")
os.environ["NORIUM_DATA_DIR"] = TEST_DATA_DIR

from app.modules.clients.router import ClientCreate, create_client  # noqa: E402
from app.modules.commercial.repository import read_store  # noqa: E402
from app.modules.commercial.router import get_proposal  # noqa: E402
from app.modules.commercial.schemas import ProposalCreate, ProposalUpdate  # noqa: E402
from app.modules.commercial.service import (  # noqa: E402
    collaboration_tenant_id,
    create_proposal,
    decide_proposal,
    submit_proposal,
    update_proposal,
)


def _user(user_id: str, *, role: str) -> dict:
    return {
        "id": user_id,
        "nome": f"Pessoa {user_id}",
        "email": f"{user_id}@norium.local",
        "plan": "equipe",
        "role": role,
        "status": "ativo",
        "teamOwnerId": "decides-owner",
    }


@asynccontextmanager
async def _team(*users: dict):
    visible = [{**user, "status": "ativo"} for user in users]
    with patch(
        "app.modules.team.router.visible_team_members",
        new=AsyncMock(return_value=visible),
    ):
        yield visible


def _stored(author: dict, proposal_id: str) -> dict:
    store = read_store(collaboration_tenant_id(author))
    return next(item for item in store["proposals"] if item["id"] == proposal_id)


class ManagerDecidesSubmittedTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(TEST_DATA_DIR, ignore_errors=True)

    async def _setup_trio(self, suffix: str) -> tuple[dict, dict, dict, str]:
        author = _user(f"decides-author-{suffix}", role="member")
        manager = _user(f"decides-manager-{suffix}", role="owner")
        common = _user(f"decides-common-{suffix}", role="member")
        client = await create_client(
            ClientCreate(name="Cliente da Equipe", email="equipe@empresa.local", document="12345678901"),
            author,
        )
        return author, manager, common, client["item"]["id"]

    async def _submit_team_proposal(self, author: dict, manager: dict, client_id: str, title: str) -> dict:
        proposal = await create_proposal(
            author, ProposalCreate(clientId=client_id, title=title, visibility="private")
        )
        # Nada vaza antes da transição explícita a equipe.
        with self.assertRaises(HTTPException) as hidden_ctx:
            await get_proposal(proposal["id"], manager)
        self.assertEqual(404, hidden_ctx.exception.status_code)
        await update_proposal(author, proposal["id"], ProposalUpdate(visibility="team", expectedVersion=1))
        submitted = await submit_proposal(author, proposal["id"], "Submissão do autor")
        self.assertEqual("in_review", submitted["status"])
        return submitted

    async def test_manager_approves_in_author_store(self) -> None:
        author, manager, common, client_id = await self._setup_trio("approve")
        async with _team(author, manager, common):
            submitted = await self._submit_team_proposal(author, manager, client_id, "Proposta do autor")
            # Membro comum sem papel de aprovação não decide.
            with self.assertRaises(HTTPException) as forbidden_ctx:
                await decide_proposal(common, submitted["id"], approved=True, note="Tentativa")
            self.assertEqual(403, forbidden_ctx.exception.status_code)
            # Gestor abre (visível em equipe) e aprova.
            seen = await get_proposal(submitted["id"], manager)
            self.assertEqual(submitted["id"], seen["proposal"]["id"])
            decided = await decide_proposal(manager, submitted["id"], approved=True, note="Aprovado pelo gestor")
            self.assertEqual("approved", decided["status"])
            self.assertEqual("approved", decided["approval"]["status"])
            self.assertEqual(manager["id"], decided["approval"]["decidedBy"])
            # Mudança persistida no armazenamento do autor, não no do gestor.
            stored = _stored(author, submitted["id"])
            self.assertEqual("approved", stored["status"])
            self.assertEqual(manager["id"], stored["approval"]["decidedBy"])
            manager_store = read_store(collaboration_tenant_id(manager))
            self.assertNotIn(submitted["id"], [item["id"] for item in manager_store["proposals"]])
            # Aprovar não concede edição geral do conteúdo.
            with self.assertRaises(HTTPException) as edit_ctx:
                await update_proposal(manager, submitted["id"], ProposalUpdate(title="Reescrita do gestor", expectedVersion=2))
            self.assertEqual(403, edit_ctx.exception.status_code)
            self.assertEqual("Proposta do autor", _stored(author, submitted["id"])["title"])

    async def test_manager_requests_changes_in_author_store(self) -> None:
        author, manager, common, client_id = await self._setup_trio("changes")
        async with _team(author, manager, common):
            submitted = await self._submit_team_proposal(author, manager, client_id, "Proposta a ajustar")
            decided = await decide_proposal(
                manager, submitted["id"], approved=False, note="Ajustar o prazo"
            )
            self.assertEqual("changes_requested", decided["status"])
            self.assertEqual("rejected", decided["approval"]["status"])
            self.assertEqual("Ajustar o prazo", decided["approval"]["decisionNote"])
            stored = _stored(author, submitted["id"])
            self.assertEqual("changes_requested", stored["status"])
            self.assertEqual("Ajustar o prazo", stored["approval"]["decisionNote"])
