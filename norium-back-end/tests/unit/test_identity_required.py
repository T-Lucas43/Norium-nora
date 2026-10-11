"""Sem usuário identificado, o sistema falha fechado em vez de usar uma conta padrão."""

import pathlib
import unittest

from fastapi import HTTPException

from app.core.identity import require_team_id, require_user_id
from app.modules.operations import service as ops


APP_ROOT = pathlib.Path(__file__).resolve().parents[2] / "app"


class IdentityRequiredTests(unittest.IsolatedAsyncioTestCase):
    def test_missing_user_id_is_rejected(self) -> None:
        for user in (None, {}, {"id": ""}, {"id": "   "}):
            with self.assertRaises(HTTPException) as caught:
                require_user_id(user)
            self.assertEqual(401, caught.exception.status_code)

    def test_team_id_prefers_team_owner(self) -> None:
        self.assertEqual("owner-1", require_team_id({"id": "member-1", "teamOwnerId": "owner-1"}))
        self.assertEqual("solo-1", require_team_id({"id": "solo-1"}))
        with self.assertRaises(HTTPException):
            require_team_id({"teamOwnerId": ""})

    async def test_service_never_falls_back_to_default_account(self) -> None:
        with self.assertRaises(HTTPException):
            await ops.list_nora_memory({})

    def test_no_identity_fallback_to_fixed_account_in_code(self) -> None:
        offenders = []
        for path in APP_ROOT.rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            # Identidade de sessao; nomes de arquivos legados (gmail/calendar) nao contam.
            if 'get("id") or "lucas123"' in text or 'str(user_id or "lucas123")' in text:
                offenders.append(str(path.relative_to(APP_ROOT)))
        self.assertEqual([], offenders)


if __name__ == "__main__":
    unittest.main()
