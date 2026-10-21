"""Synthetic SQL verification; run only inside the disposable network-isolated PG fixture."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sys
import tempfile
import uuid
from unittest.mock import patch


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--synthetic-database", action="store_true", required=True)
    parser.parse_args()
    with tempfile.TemporaryDirectory() as temporary:
        os.environ.update({"NORIUM_DATA_DIR": temporary, "ENVIRONMENT": "test", "APP_ENV": "test", "PYTHON_DOTENV_DISABLED": "1"})
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "norium-back-end"))
        sys.path.insert(0, "/opt/norium")
        import psycopg
        from psycopg.rows import dict_row
        from psycopg import sql
        from psycopg.types.json import Jsonb
        from app.services import evolution_data, evolution_history

        # This credential belongs only to the disposable --network none fixture.
        settings = {"host": "127.0.0.1", "port": 5432, "user": "postgres", "password": "synthetic-test-only",
                    "dbname": "postgres", "row_factory": dict_row, "connect_timeout": 5}
        namespace = "norium_history_test_" + uuid.uuid4().hex
        owned = evolution_data.instance_name("synthetic-owner")
        foreign = evolution_data.instance_name("synthetic-other")
        cid, other_cid = "synthetic-chat", "synthetic-other-chat"
        with psycopg.connect(**settings) as db:
            db.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(namespace)))
            db.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(namespace)))
            db.execute('CREATE TABLE "Instance" (id TEXT PRIMARY KEY,name TEXT UNIQUE)')
            db.execute('''CREATE TABLE "Message" (key JSONB,message JSONB,"messageTimestamp" BIGINT,
                "messageType" TEXT,"pushName" TEXT,participant TEXT,status TEXT,"instanceId" TEXT)''')
            db.execute('INSERT INTO "Instance"(id,name) VALUES (%s,%s),(%s,%s)', ("owned", owned, "foreign", foreign))
            values = []
            for index in range(750):
                values.append((Jsonb({"id": f"m{index:04d}", "remoteJid": cid}), Jsonb({"conversation": "Synthetic"}), 100, "conversation", "owned"))
            values.extend([
                (Jsonb({"id": "alias", "remoteJid": "synthetic-lid", "remoteJidAlt": cid}), Jsonb({"conversation": "Synthetic"}), 99, "conversation", "owned"),
                (Jsonb({"id": "reaction", "remoteJid": cid}), Jsonb({"reactionMessage": {}}), 100, "reactionMessage", "owned"),
                (Jsonb({"id": "foreign-account", "remoteJid": cid}), Jsonb({"conversation": "Must not leave fixture"}), 100, "conversation", "foreign"),
                (Jsonb({"id": "foreign-chat", "remoteJid": other_cid}), Jsonb({"conversation": "Must not leave fixture"}), 100, "conversation", "owned"),
                (Jsonb({"id": "ambiguous", "remoteJid": "separate-a"}), Jsonb({"conversation": "Synthetic"}), 100, "conversation", "owned"),
                (Jsonb({"id": "ambiguous", "remoteJid": "separate-b"}), Jsonb({"conversation": "Synthetic"}), 100, "conversation", "owned"),
            ])
            with db.cursor() as cursor:
                cursor.executemany('''INSERT INTO "Message"(key,message,"messageTimestamp","messageType","instanceId")
                    VALUES (%s,%s,%s,%s,%s)''', values)

        @contextmanager
        def database():
            with psycopg.connect(**settings, options="-c search_path=" + namespace + " -c statement_timeout=5000") as connection:
                yield connection

        with patch.object(evolution_data, "_database", database), patch.object(evolution_data, "owned_names", side_effect=lambda owner: [evolution_data.instance_name(owner)]):
            seen = []
            before = before_id = None
            for _ in range(30):
                page = evolution_history.page("synthetic-owner", owned, cid, before=before, before_id=before_id, limit=50)
                rows = page["records"]
                seen.extend(row["key"]["id"] for row in rows)
                if not page["hasMore"]:
                    break
                assert rows, "History must advance"
                before, before_id = rows[-1]["messageTimestamp"], rows[-1]["key"]["id"]
            assert len(seen) == len(set(seen)) == 751
            assert set(seen) == {f"m{index:04d}" for index in range(750)} | {"alias"}
            assert evolution_history.reference("synthetic-owner", owned, "foreign-account", cid) is None
            assert evolution_history.reference("synthetic-owner", owned, "foreign-chat", cid) is None
            assert evolution_history.reference("synthetic-owner", owned, "ambiguous") is None
            assert evolution_history.reference("synthetic-owner", owned, "ambiguous", "separate-a") is not None
            older = evolution_history.page("synthetic-owner", owned, cid, before=100, before_id=None, limit=100)
            assert [row["key"]["id"] for row in older["records"]] == ["alias"]
        print(json.dumps({"syntheticProviderSchema": True, "messagesPaged": 751, "duplicateIds": 0,
                          "sameSecondBoundaryPassed": True, "instanceIsolationPassed": True,
                          "conversationIsolationPassed": True, "ambiguousReferenceDenied": True,
                          "providerSessionsOrRealMessagesRead": False}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
