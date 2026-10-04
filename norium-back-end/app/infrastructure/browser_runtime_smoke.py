"""Smoke test executavel da imagem que prova uma interacao DOM no Chromium."""

from __future__ import annotations

import asyncio

from playwright.async_api import async_playwright
from app.infrastructure.browser_egress import chromium_launch_options


async def smoke() -> None:
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(**chromium_launch_options())
        try:
            page = await browser.new_page()
            await page.set_content(
                '<button id="ok">pendente</button>'
                '<script>document.querySelector("#ok").onclick = () => '
                'document.querySelector("#ok").textContent = "executado";</script>'
            )
            await page.locator("#ok").click()
            if await page.locator("#ok").inner_text() != "executado":
                raise RuntimeError("O Chromium abriu, mas a interacao DOM nao foi concluida.")
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(smoke())
