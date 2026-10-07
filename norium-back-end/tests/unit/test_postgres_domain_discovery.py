from __future__ import annotations

import os
from pathlib import Path
import unittest
from unittest.mock import patch

from app.modules.team import router as team, studio_router
from app.services import task_store


class PostgresDomainDiscoveryTests(unittest.TestCase):
    def postgres(self):
        return patch.dict(os.environ, {"NORIUM_DATABASE_URL": "postgresql://example.invalid/norium"})

    def test_tasks_are_discovered_from_postgres_document_keys(self):
        workspace = {"columns": [], "labels": [], "projects": [{"id": "project-1", "name": "Migrated"}], "tasks": [{"id": "task-1", "projectId": "project-1", "title": "Kept"}]}
        with self.postgres(), patch.object(task_store.postgres_store, "list_document_keys", return_value=["user_owner/tarefas_db.json", "user_owner/backups/backup/tarefas_db.json", "user_other/team_chat_db.json"]), patch.object(task_store, "read_json_file", return_value=workspace) as read_store, patch.object(Path, "stat", side_effect=AssertionError("local stat must not gate PostgreSQL")):
            loaded = task_store._read_db()
        self.assertEqual({"owner": workspace}, loaded)
        self.assertEqual(1, read_store.call_count)
        self.assertEqual("tarefas_db.json", Path(read_store.call_args.args[0]).name)

    def test_team_chat_reads_postgres_before_local_file_stat(self):
        stored = {"messages": [{"id": "message-1"}], "subteams": [], "recordings": [], "activeCalls": [], "scheduledMeetings": []}
        with self.postgres(), patch.object(team, "read_json_file", return_value=stored) as read_store, patch.object(Path, "stat", side_effect=AssertionError("local stat must not gate PostgreSQL")):
            loaded = team.read_chat_store("owner")
        self.assertEqual("message-1", loaded["messages"][0]["id"])
        read_store.assert_called_once()

    def test_call_studio_reads_postgres_before_local_exists(self):
        stored = {"id": "studio-1", "board": {"nodes": [], "edges": []}}
        with self.postgres(), patch.object(studio_router, "read_json_file", return_value=stored) as read_store, patch.object(Path, "exists", side_effect=AssertionError("local exists must not gate PostgreSQL")):
            loaded = studio_router.read_studio("owner", "call_0123456789abcdef")
        self.assertEqual("studio-1", loaded["id"])
        read_store.assert_called_once()


if __name__ == "__main__":
    unittest.main()
