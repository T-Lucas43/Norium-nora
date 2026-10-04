"""Smoke test executavel da imagem que prova uma interacao DOM no Chromium."""

from __future__ import annotations

import asyncio
import argparse
import os
import re
from pathlib import Path

from playwright.async_api import async_playwright
from app.infrastructure.browser_egress import chromium_launch_options


async def smoke(*, inventory_only: bool = False) -> None:
    async with async_playwright() as playwright:
        if inventory_only:
            binary = Path(playwright.chromium.executable_path)
            if not binary.is_file() or not os.access(binary, os.X_OK):
                raise RuntimeError("O binário Chromium não está disponível na imagem.")
            chromium_launch_options()  # The build identity must also be unprivileged.
            print("chromium_inventory_passed: runtime DOM/sandbox validation still required")
            return
        browser = await playwright.chromium.launch(**chromium_launch_options())
        try:
            page = await browser.new_page()
            await page.goto("chrome://sandbox")
            sandbox = await page.locator("body").inner_text()
            if not (re.search(r"Namespace sandbox\s+Yes", sandbox) and re.search(r"Seccomp-BPF sandbox\s+Yes", sandbox)):
                raise RuntimeError("O Chromium não confirmou os sandboxes de namespace e seccomp.")
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
    asyncio.run(smoke(inventory_only=parser.parse_args().inventory_only))
