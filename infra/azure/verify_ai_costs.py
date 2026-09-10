"""Read-only authenticated verification in the deployed runtime; never emits tokens."""
import base64
import os
import re
import zlib

import pexpect


PROBE = '''
import asyncio
import os
import httpx
import traceback
from app.modules.auth.router import read_user_store, create_token, can_manage_system

async def verify():
    import sqlite3
    import tempfile
    from pathlib import Path
    from app.core.tenant import get_data_root
    with tempfile.TemporaryDirectory(prefix="ai-costs-storage-check-", dir=get_data_root()) as folder:
        uri = (Path(folder) / "probe.sqlite3").as_uri() + "?vfs=unix-dotfile"
        first = sqlite3.connect(uri, uri=True, timeout=1)
        second = sqlite3.connect(uri, uri=True, timeout=1)
        try:
            first.execute("CREATE TABLE probe(value INTEGER)")
            first.execute("INSERT INTO probe VALUES (7)")
            try:
                second.execute("INSERT INTO probe VALUES (9)")
            except sqlite3.OperationalError as locked:
                assert locked.sqlite_errorcode == sqlite3.SQLITE_BUSY
            else:
                raise AssertionError("Concurrent write was not blocked")
            first.commit()
            assert second.execute("SELECT value FROM probe").fetchone()[0] == 7
            assert second.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            print("AI_COSTS_STORAGE_OK", flush=True)
        finally:
            second.close()
            first.close()
    users = (await read_user_store()).get("users", [])
    admin = next(u for u in users if can_manage_system(u) and u.get("status") == "ativo")
    async with httpx.AsyncClient(base_url="http://127.0.0.1:8000", timeout=60) as client:
        health = (await client.get("/health")).json()
        assert health.get("revision") == __EXPECTED_REVISION__
        anonymous = await client.get("/api/auth/admin/ai-costs")
        assert anonymous.status_code == 401
        response = await client.get("/api/auth/admin/ai-costs", headers={"Authorization": "Bearer " + create_token(admin)})
        if response.status_code != 200:
            print("AI_COSTS_HTTP:" + str(response.status_code), flush=True)
            from app.services import ai_costs
            ai_costs.overview(users, ai_costs.month_for())
        assert response.status_code == 200, "Admin accounting endpoint failed"
        data = response.json()
        models = data["models"]
        assert any(m["provider"] == "groq" and m["model"] == (os.getenv("NORA_MODEL") or "openai/gpt-oss-20b") for m in models)
        assert any(m["provider"] == "google" and m["model"] == (os.getenv("GEMINI_MODEL") or "gemini-3.7-flash") and m["inputUsd"] is not None for m in models)
        assert len(data["users"]) >= len(users)
        assert data["totals"]["totalTokens"] == data["totals"]["inputTokens"] + data["totals"]["outputTokens"]
        assert abs(data["totals"]["costUsd"] - sum(u["costUsd"] for u in data["users"])) < 0.000001
        assert abs(data["totals"]["costUsd"] - sum(m["costUsd"] for m in models)) < 0.000001
        # A second request checks persistence and idempotent legacy import.
        second = await client.get("/api/auth/admin/ai-costs", headers={"Authorization": "Bearer " + create_token(admin)})
        assert second.status_code == 200
        assert second.json()["totals"]["requests"] >= data["totals"]["requests"]
        member = next((u for u in users if not can_manage_system(u) and u.get("status") == "ativo"), None)
        if member:
            denied = await client.get("/api/auth/admin/ai-costs", headers={"Authorization": "Bearer " + create_token(member)})
            assert denied.status_code == 403
    print("AI_COSTS_PRODUCTION_OK", flush=True)

try:
    asyncio.run(verify())
except Exception as exc:
    frames = traceback.extract_tb(exc.__traceback__)
    location = frames[-1]
    print("AI_COSTS_DIAGNOSTIC:" + type(exc).__name__ + ":" + str(location.lineno), flush=True)
    print("AI_COSTS_SQLITE:" + str(getattr(exc, "sqlite_errorname", "NONE")), flush=True)
    raise SystemExit(1)
'''


if __name__ == "__main__":
    probe = PROBE.replace("__EXPECTED_REVISION__", repr(os.environ["EXPECTED_REVISION"]))
    # Container Apps exec carries the command in its WebSocket URL. Compress the
    # probe to stay below gateway URL limits without logging account information.
    encoded = base64.b64encode(zlib.compress(probe.encode())).decode()
    command = f"import base64,zlib;exec(zlib.decompress(base64.b64decode('{encoded}')))"
    child = pexpect.spawn("az", ["containerapp", "exec", "-g", os.environ["RESOURCE_GROUP"], "-n", os.environ["APP_NAME"], "--command", "python -i -q"], encoding="utf-8", timeout=180)
    try:
        child.expect(">>> ")
        child.sendline(command)
        child.expect("AI_COSTS_PRODUCTION_OK")
        print("Production AI costs verified: expected revision, authenticated admin API, persistent ledger, provider discovery, user/model totals and access control.")
    except (pexpect.EOF, pexpect.TIMEOUT):
        if "AI_COSTS_STORAGE_OK" in (child.before or ""):
            print("Persistent storage dotfile locking, commit and integrity verified.")
        for marker in re.findall(r"AI_COSTS_(?:HTTP:[0-9]+|SQLITE:[A-Z_]+)", child.before or ""):
            print(marker)
        diagnostic = re.search(r"AI_COSTS_DIAGNOSTIC:([A-Za-z]+):([0-9]+)", child.before or "")
        if diagnostic:
            print(f"Verification exception: {diagnostic.group(1)} at probe line {diagnostic.group(2)}.")
        else:
            # Only fixed diagnostic labels; do not print remote terminal output.
            raw = child.before or ""
            labels = [label for label in ("AuthorizationFailed", "ResourceNotFound", "ModuleNotFoundError", "SyntaxError", "OperationalError", "WebSocket", "unrecognized arguments") if label in raw]
            print("Remote verification transport diagnostics: " + (", ".join(labels) or "no probe result received"))
        raise SystemExit("AI costs production verification failed. Runtime output was withheld to protect account data.") from None
    finally:
        child.close(force=True)
