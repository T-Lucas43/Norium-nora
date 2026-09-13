"""Readiness and access diagnostics for public browser research."""
from __future__ import annotations

import asyncio
import re

from fastapi import HTTPException
from playwright.async_api import Page, TimeoutError as BrowserTimeout


class BrowserAccessIssue(HTTPException):
    def __init__(self, code: str, detail: str, *, interactive: bool = False):
        self.code = code
        self.interactive = interactive
        super().__init__(422, detail)


async def access_state(page: Page, status: int = 200) -> BrowserAccessIssue | None:
    title = (await page.title()).lower()
    text = (await page.locator("body").inner_text(timeout=5000)).strip()
    challenge = await page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha"], #challenge-form, #cf-challenge-running').count()
    if challenge or re.search(r"just a moment|um momento|attention required|verifique.*humano|verify.*human", title):
        return BrowserAccessIssue("verification", "O site está solicitando uma verificação de acesso. Conclua a verificação no navegador ao vivo e continue.", interactive=True)
    password = page.locator('input[type="password"]:visible')
    login_path = re.search(r"/(?:login|signin|sign-in|auth|authenticate|entrar)(?:[/.?]|$)", page.url, re.I)
    login_words = re.search(r"sign in|log in|faça login|fazer login|entrar na conta|iniciar sessão", text, re.I)
    login_title = re.search(r"^(?:login|sign in|log in|entrar|iniciar sessão)(?:\b|\s)", title)
    if status == 401 or await password.count() or (login_path and login_words) or (login_title and login_words):
        return BrowserAccessIssue("login", "Este site exige login. Entre na sua conta no navegador ao vivo e confirme para continuar a pesquisa.", interactive=True)
    if status == 403:
        return BrowserAccessIssue("blocked", "O site recusou o acesso ao navegador (403). Você pode verificar o acesso ao vivo ou usar outra página pública.", interactive=True)
    if status == 404:
        return BrowserAccessIssue("not_found", "Esta página não foi encontrada (404). Edite o endereço ou use a página inicial do site.")
    if status == 429:
        return BrowserAccessIssue("rate_limit", "O site limitou temporariamente as consultas (429). Aguarde e tente novamente.")
    if status >= 400:
        return BrowserAccessIssue("server", f"O site está indisponível no momento (HTTP {status}).")
    if len(text) < 20:
        return BrowserAccessIssue("empty", "A página abriu, mas não disponibilizou texto para leitura. Tente outra página ou verifique o acesso ao vivo.", interactive=True)
    return None


async def navigate_readable(page: Page, url: str) -> int:
    """A slow image/analytics request must not discard an already loaded document."""
    for attempt in range(2):
        try:
            response = await page.goto(url, wait_until="commit", timeout=20_000)
            status = response.status if response else 200
            if response and not any(kind in response.headers.get("content-type", "text/html").lower() for kind in ("html", "text/plain")):
                raise BrowserAccessIssue("format", "Este endereço não é uma página de texto. Use a página que apresenta o documento.")
            if status in {502, 503, 504} and attempt == 0:
                await asyncio.sleep(1)
                continue
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=8000)
            except BrowserTimeout:
                pass
            try:
                await page.wait_for_function("() => document.body && document.body.innerText.trim().length > 80", timeout=8000)
            except BrowserTimeout:
                pass
            return status
        except BrowserTimeout:
            if attempt:
                raise BrowserAccessIssue("timeout", "O site demorou demais para responder. O agente tentou novamente; você pode repetir a pesquisa.") from None
    return 200
