from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


AZURE_INFRA = Path(__file__).resolve().parents[3] / "infra" / "azure"
if str(AZURE_INFRA) not in sys.path:
    sys.path.insert(0, str(AZURE_INFRA))

import set_system_administrators as subject


class _Download:
    def __init__(self, data):
        self._data = data

    def readall(self):
        return self._data


class _UserStoreFile:
    def __init__(self, store, lifecycle):
        self.data = json.dumps(store).encode()
        self.lifecycle = lifecycle

    def download_file(self):
        return _Download(self.data)

    def upload_file(self, data):
        self.data = data
        self.lifecycle.append("store:persisted")


class _Share:
    def __init__(self, user_store):
        self.user_store = user_store

    def get_file_client(self, name):
        if name != "usuarios_db.json":
            raise AssertionError(f"unexpected_file:{name}")
        return self.user_store

    def create_snapshot(self):
        return {"snapshot": "synthetic-snapshot"}


class _Marker:
    def __init__(self, name, lifecycle):
        self.name = name
        self.lifecycle = lifecycle

    def write_text(self, value):
        if self.name == "roles-completed.txt":
            self.lifecycle.append("marker:roles-completed")
        return len(value)


class SetSystemAdministratorsTests(unittest.TestCase):
    maxDiff = None

    def test_recovery_persists_roles_and_reactivates_without_bootstrap_environment(self):
        lifecycle = []
        azure_mutations = []
        bootstrap_assignments = []
        original_revision = "norium--original-revision"
        initial_store = {
            "users": [
                {
                    "id": "lucas123",
                    "email": "principal@example.test",
                    "nome": "Principal Ficticio",
                    "systemAdmin": False,
                    "systemAdminRole": "member",
                    "sessionVersion": 2,
                },
                {
                    "id": "norium-admin",
                    "email": "assistant@example.test",
                    "nome": "Assistente Ficticio",
                    "systemAdmin": False,
                    "systemAdminRole": "member",
                    "sessionVersion": 4,
                },
            ],
            "systemOwnerId": None,
            "adminAudit": [],
        }
        user_store = _UserStoreFile(initial_store, lifecycle)
        share = _Share(user_store)

        def fake_az(*args):
            if args[:3] == ("containerapp", "revision", "list"):
                return [{"name": original_revision, "properties": {"active": True}}]
            if args[:3] == ("containerapp", "revision", "deactivate"):
                lifecycle.append(f"revision:deactivate:{args[-1]}")
                azure_mutations.append(args)
                return None
            if args[:3] == ("containerapp", "replica", "list"):
                return []
            if args[:3] == ("containerapp", "revision", "activate"):
                lifecycle.append(f"revision:activate:{args[-1]}")
                azure_mutations.append(args)
                return None
            if args[:2] == ("containerapp", "update"):
                lifecycle.append("containerapp:update")
                azure_mutations.append(args)
                bootstrap_assignments.extend(
                    value for value in args if value.startswith("NORIUM_BOOTSTRAP_ADMIN_")
                )
                return None
            if args[:2] == ("containerapp", "show"):
                return {
                    "properties": {
                        "template": {"containers": [{"env": []}]},
                    }
                }
            raise AssertionError(f"unexpected_azure_call:{args}")

        def write_report(report):
            lifecycle.append(f"report:{report['status']}")

        def marker(name):
            return _Marker(name, lifecycle)

        error = None
        with patch.dict(
            os.environ,
            {"RESOURCE_GROUP": "rg-synthetic", "APP_NAME": "app-synthetic"},
            clear=True,
        ), patch.multiple(
            subject,
            az=fake_az,
            connect=lambda: (share, {"id": "synthetic-app"}),
            Path=marker,
            write_report=write_report,
        ):
            try:
                subject.main()
            except RuntimeError as exc:
                error = str(exc)

        persisted = json.loads(user_store.data)
        users = {user["id"]: user for user in persisted["users"]}
        observed = {
            "error": error,
            "systemOwnerId": persisted.get("systemOwnerId"),
            "roles": {
                "lucas123": [
                    users["lucas123"].get("systemAdmin"),
                    users["lucas123"].get("systemAdminRole"),
                ],
                "norium-admin": [
                    users["norium-admin"].get("systemAdmin"),
                    users["norium-admin"].get("systemAdminRole"),
                ],
            },
            "azureMutations": azure_mutations,
            "bootstrapAssignments": bootstrap_assignments,
            "lifecycle": lifecycle,
        }
        expected = {
            "error": None,
            "systemOwnerId": "lucas123",
            "roles": {
                "lucas123": [True, "owner"],
                "norium-admin": [True, "assistant"],
            },
            "azureMutations": [
                (
                    "containerapp",
                    "revision",
                    "deactivate",
                    "-g",
                    "rg-synthetic",
                    "--revision",
                    original_revision,
                ),
                (
                    "containerapp",
                    "revision",
                    "activate",
                    "-g",
                    "rg-synthetic",
                    "--revision",
                    original_revision,
                ),
            ],
            "bootstrapAssignments": [],
            "lifecycle": [
                f"revision:deactivate:{original_revision}",
                "store:persisted",
                f"revision:activate:{original_revision}",
                "report:verified",
                "marker:roles-completed",
            ],
        }
        self.assertEqual(observed, expected)


if __name__ == "__main__":
    unittest.main()
