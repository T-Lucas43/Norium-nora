"""Run local regression tests in a source-only disposable copy, without credentials.

Usage (repository root): python scripts/run_backend_audit_tests.py --label p0
    tests.unit.test_json_repository tests.unit.test_store_loading
No application module is imported until the isolated environment is configured.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument("tests", nargs="*")
    args = parser.parse_args()
    if not args.label.replace("-", "").replace("_", "").isalnum():
        parser.error("label must be alphanumeric")
    repo = Path(__file__).resolve().parents[1]
    output = repo / "output" / "pos-correcao"
    output.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, *sys.argv]
    started = dt.datetime.now(dt.timezone.utc).isoformat()
    clock = time.monotonic()
    files = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=repo,
    ).decode("utf-8").split("\0")
    safe_env = {key: os.environ[key] for key in (
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LOCALAPPDATA",
    ) if key in os.environ}
    with tempfile.TemporaryDirectory(prefix="audit-tests-", dir=output) as temporary:
        scratch = Path(temporary)
        mirror = scratch / "source"
        for name in files:
            if not name or name.startswith((".git/", "output/", "tmp/")):
                continue
            source = repo / name
            if source.is_file() and not source.is_symlink():
                target = mirror / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
        data = scratch / "data"
        data.mkdir()
        safe_env.update({
            "ENVIRONMENT": "test", "APP_ENV": "test", "PYTHON_DOTENV_DISABLED": "1",
            "NORIUM_DATA_DIR": str(data), "PYTHONDONTWRITEBYTECODE": "1",
            "NORIUM_AUTH_SECRET": "synthetic-audit-signing-key-never-used-outside-tests-123456789",
            "TEMP": str(scratch), "TMP": str(scratch),
        })
        os.environ.clear()
        os.environ.update(safe_env)
        sys.dont_write_bytecode = True
        backend = mirror / "norium-back-end"
        os.chdir(backend)
        sys.path.insert(0, str(backend))
        # Deterministic provider fakes are allowed; live provider calls are not.
        original_connect = socket.socket.connect
        original_connect_ex = socket.socket.connect_ex

        def local_address(address):
            return not isinstance(address, tuple) or str(address[0]) in {"127.0.0.1", "::1", "localhost"}

        def connect(sock, address):
            if not local_address(address):
                raise RuntimeError("External network disabled in audit tests")
            return original_connect(sock, address)

        def connect_ex(sock, address):
            if not local_address(address):
                raise RuntimeError("External network disabled in audit tests")
            return original_connect_ex(sock, address)

        socket.socket.connect = connect
        socket.socket.connect_ex = connect_ex
        with (output / f"{args.label}.log").open("w", encoding="utf-8") as log:
            with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                print("Started:", started)
                print("Command:", json.dumps(command))
                print("Isolation: source-only copy; synthetic data; dotenv disabled; external sockets denied")
                loader = unittest.TestLoader()
                suite = (loader.loadTestsFromNames(args.tests) if args.tests else
                         loader.discover("tests", pattern="test*.py"))
                if suite.countTestCases() == 0:
                    raise RuntimeError("No backend tests discovered; validation failed")
                result = unittest.TextTestRunner(stream=log, verbosity=2).run(suite)
        code = 0 if result.wasSuccessful() else 1
        summary = {
            "command": command, "startedAt": started, "exitCode": code,
            "testsRun": result.testsRun, "failures": len(result.failures),
            "errors": len(result.errors), "skipped": len(result.skipped),
            "durationSeconds": round(time.monotonic() - clock, 3),
            "isolation": "temporary source copy and data; no dotenv or external sockets",
        }
        (output / f"{args.label}.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        os.chdir(repo)
        print(json.dumps(summary))
        return code


if __name__ == "__main__":
    raise SystemExit(main())
