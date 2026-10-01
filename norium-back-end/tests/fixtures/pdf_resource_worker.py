"""Cargas sintéticas limitadas para testar o supervisor, sem PDFs de ataque."""

import json
import os
import runpy
import sys
import time
from pathlib import Path


worker = runpy.run_path(str(Path(__file__).resolve().parents[2] / "app/modules/platform/pdf_worker.py"))
job_handle = worker["apply_resource_limits"](int(sys.argv[1]), int(sys.argv[2]))
mode = sys.stdin.buffer.read()
if mode == b"%PDF-block":
    time.sleep(60)
elif mode == b"%PDF-cpu":
    while True:
        pass
elif mode == b"%PDF-memory":
    try:
        data = bytearray(192 * 1024 * 1024)
    except MemoryError:
        print('{"error":"resources"}')
    else:
        print('{"pages":["allocation unexpectedly allowed"]}')
elif mode == b"%PDF-environment":
    clean = "NORIUM_TEST_SECRET" not in os.environ and sys.flags.isolated
    print(json.dumps({"pages": ["isolated" if clean else "leaked"]}))
else:
    print('{"pages":["Worker sintetico pronto"]}')
