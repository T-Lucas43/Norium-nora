"""Achados 1 e 2 (revisão 21/09): privacidade fail-closed de proposta privada.

Proposta privada só resolve acesso para quem a criou: permissão residual em
`access` não vale para terceiros, tornar privada revoga o compartilhamento,
compartilhar privada é 409 e colega com ID conhecido recebe 404 sem alterar
conteúdo ou status. Voltar a equipe não restaura permissões antigas.
Tudo com dados sintéticos.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException


TEST_DATA_DIR = tempfile.mkdtemp(prefix="norium_private_failclosed_")
os.environ["NORIUM_DATA_DIR"] = TEST_DATA_DIR

from app.modules.clients.router import ClientCreate, create_client  # noqa: E402
from app.modules.commercial.repository import read_store  # noqa: E402
from app.modules.commercial.router import get_proposal  # noqa: E402
from app.modules.commercial.schemas import (  # noqa: E402
    DocumentAccessPerson,
    DocumentAccessUpdate,
    ProposalCreate,
    ProposalStatusChange,
    ProposalUpdate,
)
from app.modules.commercial.service import (  # noqa: E402
    change_proposal_status,
    collaboration_tenant_id,
    create_proposal,
    list_commercial_data,
    update_document_access,
    update_proposal,
)


def _member(user_id: str, *, role: str = "member") -> dict:
    return {
        "id": user_id,
        "nome": f"Pessoa {user_id}",
        "email": f"{user_id}@norium.local",
        "plan": "equipe",
        "role": role,
        "status": "ativo",
        "teamOwnerId": "failclosed-owner",
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


class PrivateFailClosedTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(TEST_DATA_DIR, ignore_errors=True)

    async def _setup_pair(self, suffix: str) -> tuple[dict, dict, str]:
        author = _member(f"failclosed-author-{suffix}")
        colleague = _member(f"failclosed-colleague-{suffix}")
        client = await create_client(
            ClientCreate(name="Cliente Privado", email="privado@empresa.local", document="12345678901"),
            author,
        )
        return author, colleague, client["item"]["id"]

    async def test_residual_grant_stops_after_team_to_private(self) -> None:
        author, colleague, client_id = await self._setup_pair("grant")
        async with _team(author, colleague):
            proposal = await create_proposal(
                author, ProposalCreate(clientId=client_id, title="Proposta da equipe")
            )
            await update_document_access(
                author,
                "proposal",
                proposal["id"],
                DocumentAccessUpdate(people=[DocumentAccessPerson(userId=colleague["id"], permission="edit")]),
            )
            # Sanidade: com a proposta em equipe, a permissão concedida vale.
            granted = await update_proposal(
                colleague, proposal["id"], ProposalUpdate(title="Edição permitida", expectedVersion=2)
            )
            self.assertEqual("Edição permitida", granted["title"])
            flipped = await update_proposal(
                author, proposal["id"], ProposalUpdate(visibility="private", expectedVersion=3)
            )
            self.assertEqual("private", flipped["visibility"])
            self.assertEqual("none", flipped["access"]["teamPermission"])
            self.assertEqual([], flipped["access"]["people"])

            member_items = (await list_commercial_data(colleague))["proposals"]
            self.assertNotIn(proposal["id"], [item["id"] for item in member_items])
            for action in (
                lambda: get_proposal(proposal["id"], colleague),
                lambda: update_proposal(colleague, proposal["id"], ProposalUpdate(title="Invasão", expectedVersion=4)),
                lambda: change_proposal_status(colleague, proposal["id"], ProposalStatusChange(status="sent", expectedVersion=4)),
            ):
                with self.assertRaises(HTTPException) as ctx:
                    await action()
                self.assertEqual(404, ctx.exception.status_code)
            stored = _stored(author, proposal["id"])
            self.assertEqual("Edição permitida", stored["title"])
            self.assertEqual("draft", stored["status"])

    async def test_colleague_with_known_id_cannot_mutate_private(self) -> None:
        author, colleague, client_id = await self._setup_pair("known")
        async with _team(author, colleague):
            proposal = await create_proposal(
                author,
                ProposalCreate(clientId=client_id, title="Rascunho privado", visibility="private"),
            )
            with self.assertRaises(HTTPException) as update_ctx:
                await update_proposal(colleague, proposal["id"], ProposalUpdate(title="Invasão", expectedVersion=1))
            self.assertEqual(404, update_ctx.exception.status_code)
            with self.assertRaises(HTTPException) as status_ctx:
                await change_proposal_status(colleague, proposal["id"], ProposalStatusChange(status="sent", expectedVersion=1))
            self.assertEqual(404, status_ctx.exception.status_code)
            stored = _stored(author, proposal["id"])
            self.assertEqual("Rascunho privado", stored["title"])
            self.assertEqual("draft", stored["status"])

    async def test_share_private_is_rejected(self) -> None:
        author, colleague, client_id = await self._setup_pair("share")
        async with _team(author, colleague):
            proposal = await create_proposal(
                author,
                ProposalCreate(clientId=client_id, title="Rascunho privado", visibility="private"),
            )
            with self.assertRaises(HTTPException) as ctx:
                await update_document_access(
                    author,
                    "proposal",
                    proposal["id"],
                    DocumentAccessUpdate(people=[DocumentAccessPerson(userId=colleague["id"], permission="view")]),
                )
            self.assertEqual(409, ctx.exception.status_code)
            self.assertIn("equipe", str(ctx.exception.detail))
            # Nada foi gravado no compartilhamento.
            self.assertEqual([], _stored(author, proposal["id"])["access"]["people"])

    async def test_author_keeps_read_and_edit_private(self) -> None:
        author, colleague, client_id = await self._setup_pair("author")
        async with _team(author, colleague):
            proposal = await create_proposal(
                author,
                ProposalCreate(clientId=client_id, title="Rascunho privado", visibility="private"),
            )
            seen = await get_proposal(proposal["id"], author)
            self.assertEqual(proposal["id"], seen["proposal"]["id"])
            updated = await update_proposal(
                author, proposal["id"], ProposalUpdate(title="Título do autor", expectedVersion=1)
            )
            self.assertEqual("Título do autor", updated["title"])
            moved = await change_proposal_status(
                author, proposal["id"], ProposalStatusChange(status="sent", expectedVersion=2)
            )
            self.assertEqual("sent", moved["status"])

    async def test_return_to_team_does_not_restore_grants(self) -> None:
        author, colleague, client_id = await self._setup_pair("restore")
        async with _team(author, colleague):
            proposal = await create_proposal(
                author, ProposalCreate(clientId=client_id, title="Proposta da equipe")
            )
            await update_document_access(
                author,
                "proposal",
                proposal["id"],
                DocumentAccessUpdate(people=[DocumentAccessPerson(userId=colleague["id"], permission="edit")]),
            )
            await update_proposal(author, proposal["id"], ProposalUpdate(visibility="private", expectedVersion=2))
            back = await update_proposal(author, proposal["id"], ProposalUpdate(visibility="team", expectedVersion=3))
            self.assertEqual("view", back["access"]["teamPermission"])
            self.assertEqual([], back["access"]["people"])
            # Sem restauração silenciosa: colega vê (equipe) mas não edita.
            with self.assertRaises(HTTPException) as ctx:
                await update_proposal(colleague, proposal["id"], ProposalUpdate(title="Invasão", expectedVersion=4))
            self.assertEqual(403, ctx.exception.status_code)
            # Nova concessão explícita volta a valer.
            await update_document_access(
                author,
                "proposal",
                proposal["id"],
                DocumentAccessUpdate(people=[DocumentAccessPerson(userId=colleague["id"], permission="edit")]),
            )
            updated = await update_proposal(
                colleague, proposal["id"], ProposalUpdate(title="Edição reconcedida", expectedVersion=5)
            )
            self.assertEqual("Edição reconcedida", updated["title"])
