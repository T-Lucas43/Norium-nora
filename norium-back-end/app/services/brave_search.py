"""One bounded official Brave request, attributed to the authenticated actor."""
from __future__ import annotations
import html
import os
import re
from urllib.parse import urlsplit
import httpx
from app.core.identity import require_user_id
from app.core.ai_guardrails import minimize_for_ai
from app.services.ai_costs import Meter


async def search(user, query, *, client_factory=httpx.AsyncClient):
    key = os.getenv("BRAVE_SEARCH_API_KEY", "").strip()
    if not key or os.getenv("NORIUM_BRAVE_ENABLED", "1") != "1":
        raise ValueError("Brave Search ainda não foi configurado pelo administrador.")
    query = minimize_for_ai(str(query), max_chars=300)
    provider = {"provider":"brave","baseUrl":"https://api.search.brave.com/res/v1","model":"web-search","managed":True}
    meter = Meter(provider, [], 1, user_id=require_user_id(user), source="brave-search")
    # Brave charges per request, not prompt/output tokens.
    meter.input_bound = 0
    async with meter:
        meter.sent()
        async with client_factory(timeout=20, follow_redirects=False) as client:
            response = await client.get("https://api.search.brave.com/res/v1/web/search",
                headers={"X-Subscription-Token":key,"Accept":"application/json"},
                params={"q":query,"count":6,"country":"BR","search_lang":"pt-br","safesearch":"moderate"})
        if response.status_code != 200:
            meter.rejected()
            raise ValueError("A pesquisa web está temporariamente indisponível. Nenhuma ação foi executada.")
        if len(response.content) > 1000000:
            raise ValueError("Resposta de pesquisa excedeu o limite.")
        body = response.json()
        await meter.record({"model":"web-search","usage":{"input_tokens":0,"output_tokens":0}})
    sources = []
    for item in (body.get("web") or {}).get("results", [])[:6]:
        url = str(item.get("url") or "")
        parts = urlsplit(url)
        if parts.scheme not in {"https","http"} or not parts.hostname or parts.username or parts.password:
            continue
        clean = lambda value: " ".join(html.unescape(re.sub(r"<[^>]*>", " ", str(value))).split())
        sources.append({"title":clean(item.get("title") or "Resultado")[:240], "url":url,
                        "excerpt":clean(item.get("description") or "")[:1200]})
    return sources
