"""Smoke test executavel da imagem que prova uma interacao DOM no Chromium."""

from __future__ import annotations

import asyncio
import argparse
import os
import re
from pathlib import Path
import subprocess
import sys

from playwright.async_api import async_playwright, expect
from app.infrastructure.browser_egress import chromium_launch_options


def check_container_status(text: str, uid: int) -> None:
    if uid != 10001:
        raise RuntimeError("The runtime smoke requires unprivileged UID 10001")
    status = dict(line.split(":", 1) for line in text.splitlines() if ":" in line)
    if status.get("NoNewPrivs", "").strip() != "1" or status.get("Seccomp", "").strip() != "2":
        raise RuntimeError("no-new-privileges and a seccomp filter are mandatory")
    if any(int(status.get(name, "1").strip(), 16) != 0 for name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")):
        raise RuntimeError("The runtime smoke requires ALL capabilities dropped")


def require_container_security() -> None:
    if os.name != "posix":
        raise RuntimeError("The runtime smoke requires Linux")
    check_container_status(Path("/proc/self/status").read_text(), os.geteuid())
    # An independent child proves the allowed syscall grants no initial-namespace
    # privilege. Even chroot('/') must fail; never change this process's root.
    result = subprocess.run([sys.executable, "-c", "import os,sys\ntry: os.chroot('/')\nexcept PermissionError: sys.exit(0)\nelse: sys.exit(1)"],
                            env=chromium_launch_options()["env"], capture_output=True, timeout=5, check=False)
    if result.returncode != 0:
        raise RuntimeError("chroot must remain forbidden outside the browser user namespace")
    print("container_security_passed: UID 10001; capabilities zero; no-new-privileges; seccomp; initial namespace chroot denied")


def check_chromium_sandbox_status(rows: dict[str, str], evaluation: str) -> None:
    # Chromium 151's official sandbox_internals.ts reports the namespace as
    # "Layer 1 Sandbox / Namespace", rather than the obsolete Namespace row.
    required = {"Layer 1 Sandbox": "Namespace", "PID namespaces": "Yes",
                "Network namespaces": "Yes", "Seccomp-BPF sandbox": "Yes"}
    if any(rows.get(name) != value for name, value in required.items()) or evaluation != "You are adequately sandboxed.":
        raise RuntimeError("O Chromium não confirmou os sandboxes de namespace e seccomp.")


async def smoke(*, inventory_only: bool = False, container_security: bool = False) -> None:
    if container_security:
        require_container_security()
    async with async_playwright() as playwright:
        if inventory_only:
            binary = Path(playwright.chromium.executable_path)
            if not binary.is_file() or not os.access(binary, os.X_OK):
                raise RuntimeError("O binário Chromium não está disponível na imagem.")
            chromium_launch_options()  # The build identity must also be unprivileged.
            print("chromium_inventory_passed: runtime DOM/sandbox validation still required")
            return
        options = chromium_launch_options()
        options["args"].append("--enable-logging=stderr")
        browser = await playwright.chromium.launch(**options)
        try:
            page = await browser.new_page()
            await page.goto("chrome://sandbox")
            await expect(page.locator("#evaluation")).to_have_text(re.compile(r"You are (?:NOT )?adequately sandboxed\."), timeout=10_000)
            rows = {}
            for row in await page.locator("#sandbox-status tr").all():
                cells = await row.locator("td").all_inner_texts()
                if len(cells) == 2:
                    rows[cells[0].strip()] = cells[1].strip()
            check_chromium_sandbox_status(rows, (await page.locator("#evaluation").inner_text()).strip())
            await page.goto("about:blank")
            await page.set_content(
                '<button id="ok">pendente</button>'
                '<script>document.querySelector("#ok").onclick = () => '
                'document.querySelector("#ok").textContent = "executado";</script>'
            )
            await page.locator("#ok").click()
            if await page.locator("#ok").inner_text() != "executado":
                raise RuntimeError("O Chromium abriu, mas a interacao DOM nao foi concluida.")
            print("chromium_runtime_passed: namespace and seccomp sandbox; DOM interaction")
        finally:
            await browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory-only", action="store_true", help="Build inventory only; does not prove DOM or sandbox")
    parser.add_argument("--require-container-security", action="store_true", help="Assert UID, no capabilities, seccomp and no-new-privileges")
    args = parser.parse_args()
    asyncio.run(smoke(inventory_only=args.inventory_only, container_security=args.require_container_security))
