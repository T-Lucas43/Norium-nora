from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from starlette.requests import Request

from app import bootstrap
from app.bootstrap import rate_limit_bucket
from app.core.security import create_signed_token
from app.modules.auth import router as auth_router
from app.modules.chat import router as chat_router
from app.modules.platform import router as platform_router
from app.modules.platform import service as platform_service
from app.modules.system import router as system_router
from app.services.agent_manager import AgentManager


def request(path: str, *, workspace: str | None = None) -> Request:
    headers = []
    if workspace:
        headers.append((b"x-norium-workspace", workspace.encode("ascii")))
    return Request({"type": "http", "method": "GET", "path": path, "headers": headers})


def account(
    user_id: str,
    *,
    role: str = "owner",
    plan: str = "free",
    team_owner_id: str | None = None,
    system_admin: bool = False,
    permissions: dict[str, bool] | None = None,
) -> dict:
    return {
        "id": user_id,
        "nome": user_id,
        "email": f"{user_id}@example.com",
        "passwordHash": auth_router.hash_password("senha-muito-segura"),
        "role": role,
        "plan": plan,
        "status": "ativo",
        "systemAdmin": system_admin,
        "sessionVersion": 0,
        "teamOwnerId": team_owner_id,
        "permissions": permissions or auth_router.permissions_for_plan(plan, is_owner=role == "owner"),
    }


class AccessControlTests(unittest.IsolatedAsyncioTestCase):
    def test_plan_permission_is_enforced_for_direct_api_access(self) -> None:
        free_user = account("free-user")
        with self.assertRaises(HTTPException) as error:
            auth_router.assert_route_permissions(free_user, "/api/emails/gmail/messages")
        self.assertEqual(403, error.exception.status_code)
        with self.assertRaises(HTTPException) as platform_error:
            auth_router.assert_route_permissions(free_user, "/api/plataforma/cofre")
        self.assertEqual(403, platform_error.exception.status_code)
        auth_router.assert_route_permissions(free_user, "/api/clientes")

        paid_user = account("paid-user", plan="individual")
        auth_router.assert_route_permissions(paid_user, "/api/emails/gmail/messages")

    def test_revoked_whatsapp_integration_blocks_direct_send(self) -> None:
        permissions = auth_router.permissions_for_plan("equipe")
        permissions["integracao_whatsapp"] = False
        user = account("team-member", plan="equipe", permissions=permissions)
        with self.assertRaises(HTTPException) as error:
            chat_router.assert_channel_permission(user, "whatsapp")
        self.assertEqual(403, error.exception.status_code)

    async def test_arbitrary_workspace_header_is_rejected(self) -> None:
        member = account("member", role="member", plan="individual", team_owner_id="owner")
        with patch.object(
            auth_router,
            "read_account_db",
            return_value={"workspaces": [{"id": "workspace-known", "active": True}]},
        ):
            await auth_router.assert_workspace_access(member, request("/api/tarefas", workspace="workspace-known"))
            with self.assertRaises(HTTPException) as error:
                await auth_router.assert_workspace_access(member, request("/api/tarefas", workspace="workspace-other"))
        self.assertEqual(403, error.exception.status_code)

    async def test_idempotency_replay_requires_a_current_authorized_session(self) -> None:
        revoked = AsyncMock(side_effect=HTTPException(status_code=401, detail="revoked"))
        with patch.object(bootstrap, "user_from_token", revoked):
            identity = await bootstrap.idempotency_identity(request("/api/tarefas"), "stale-token")
        self.assertIsNone(identity)

        active = account("active-user", plan="individual")
        with (
            patch.object(bootstrap, "user_from_token", AsyncMock(return_value=active)),
            patch.object(bootstrap, "assert_workspace_access", AsyncMock()),
            patch.object(bootstrap, "assert_route_permissions") as route_permission,
        ):
            identity = await bootstrap.idempotency_identity(request("/api/tarefas"), "fresh-token")
        self.assertEqual("active-user", identity)
        route_permission.assert_called_once_with(active, "/api/tarefas")

    async def test_revoked_session_version_is_rejected(self) -> None:
        user = account("user-1", plan="individual")
        token = create_signed_token(user, secret=auth_router.AUTH_SECRET)
        user["sessionVersion"] = 1
        with patch.object(auth_router, "read_user_store", AsyncMock(return_value={"users": [user]})):
            with self.assertRaises(HTTPException) as error:
                await auth_router.user_from_token(token)
        self.assertEqual(401, error.exception.status_code)

    async def test_websocket_ticket_is_short_lived_and_single_use(self) -> None:
        user = account("socket-user", plan="individual")
        ticket = await auth_router.issue_websocket_ticket(user)
        with patch.object(auth_router, "read_user_store", AsyncMock(return_value={"users": [user]})):
            resolved = await auth_router.user_from_websocket_ticket(ticket)
            self.assertEqual(user["id"], resolved["id"])
            with self.assertRaises(HTTPException) as error:
                await auth_router.user_from_websocket_ticket(ticket)
        self.assertEqual(401, error.exception.status_code)

    async def test_production_whatsapp_webhook_fails_closed_without_secret(self) -> None:
        with (
            patch.object(chat_router, "WHATSAPP_WEBHOOK_SECRET", ""),
            patch.dict("os.environ", {"ENVIRONMENT": "production"}),
        ):
            with self.assertRaises(HTTPException) as error:
                await chat_router.webhook_whatsapp({}, None, None)
        self.assertEqual(503, error.exception.status_code)

    async def test_agent_draft_reads_only_the_authenticated_tenant(self) -> None:
        manager = AgentManager()
        with patch(
            "app.services.agent_manager.build_conversation_history",
            AsyncMock(return_value="Cliente: contexto real"),
        ) as history, patch.object(
            manager.nora_service,
            "perguntar_nora",
            AsyncMock(return_value="Resposta"),
        ):
            await manager.draft_message("conversation-1", user_id="tenant-b")
        history.assert_awaited_once_with("conversation-1", limit=30, user_id="tenant-b")

    async def test_last_system_admin_cannot_remove_own_admin_role(self) -> None:
        admin = account("admin", plan="enterprise", system_admin=True)
        with (
            patch.object(auth_router, "read_user_store", AsyncMock(return_value={"users": [admin], "teams": []})),
            patch.object(auth_router, "write_user_store", AsyncMock()),
        ):
            with self.assertRaises(HTTPException) as error:
                await auth_router.update_user(
                    "admin",
                    auth_router.UpdateUserPayload(systemAdmin=False),
                    admin,
                )
        self.assertEqual(409, error.exception.status_code)

    async def test_self_service_cannot_activate_paid_plan(self) -> None:
        user = account("free-user")
        with self.assertRaises(HTTPException) as error:
            await auth_router.select_plan(auth_router.SelectPlanPayload(plan="enterprise"), user)
        self.assertEqual(403, error.exception.status_code)

    async def test_permission_preview_never_returns_an_impersonation_token(self) -> None:
        owner = account("owner", plan="equipe")
        member = account("member", role="member", plan="individual", team_owner_id="owner")
        with patch.object(
            platform_router,
            "read_user_store",
            AsyncMock(return_value={"users": [owner, member]}),
        ):
            preview = await platform_router.simulate_permissions("member", owner)
        self.assertNotIn("token", preview)
        self.assertEqual("member", preview["user"]["id"])

    async def test_diagnostics_are_admin_only_and_health_is_minimal(self) -> None:
        self.assertEqual({"status": "ok"}, await system_router.health())
        with self.assertRaises(HTTPException) as error:
            await system_router.diagnostics(account("member", role="member"))
        self.assertEqual(403, error.exception.status_code)

    def test_rate_limit_risk_buckets_are_distinct(self) -> None:
        self.assertEqual("auth", rate_limit_bucket("/api/auth/login"))
        self.assertEqual("webhook", rate_limit_bucket("/api/whatsapp/webhook"))
        self.assertEqual("ai", rate_limit_bucket("/api/nora/natural"))
        self.assertEqual("message", rate_limit_bucket("/api/chat/enviar"))
        self.assertEqual("admin", rate_limit_bucket("/api/admin/finance/dashboard"))
        self.assertEqual("public", rate_limit_bucket("/api/comercial/public/signature/token"))

    def test_vault_secret_encryption_uses_binary_auth_secret(self) -> None:
        encrypted = platform_service.encrypt_secret("segredo-de-qa")
        self.assertNotIn("segredo-de-qa", encrypted)
        self.assertTrue(encrypted.startswith("gAAAA"))


if __name__ == "__main__":
    unittest.main()
