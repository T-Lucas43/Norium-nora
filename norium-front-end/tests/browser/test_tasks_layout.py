"""Run with Vite on 127.0.0.1:5178 and Python Playwright installed."""
import json
import os
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

project = dict(id="synthetic-project", name="Synthetic project", category="pessoal", description="Synthetic", color="#0EA5E9", defaultPriority="media", owner="Synthetic owner", ownerUserId="owner", responsibleUserId="owner", responsibleName="Synthetic owner", sharedUserIds=[], status="ativo", startDate="", dueDate="", defaultStartTime="09:00", calendarDurationMinutes=60, templateId="standard", workflowColumns=[dict(id="pendente", title="Pendente")], archived=False, createdAt="2026-10-06")

def respond(route):
    path = urlparse(route.request.url).path
    if path.endswith("/projetos"):
        payload = {"projects": [project]}
    elif path.endswith("/users"):
        payload = {"users": [dict(id="owner", nome="Synthetic owner", status="ativo")]}
    elif path.endswith("/modelos-projeto"):
        payload = {"templates": []}
    else:
        payload = {"tasks": [], "columns": project["workflowColumns"], "labels": [], "stats": {"total": 0, "ativas": 0, "pendentes": 0, "andamento": 0, "concluidas": 0, "vencidas": 0}}
    route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel=os.getenv("NORIUM_TEST_BROWSER_CHANNEL") or None)
    try:
        for width in (766, 390, 1440):
            page = browser.new_page(viewport={"width": width, "height": 930})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.route("**/api/tarefas**", respond)
            page.route("**/api/auth/users", respond)
            page.goto("http://127.0.0.1:5178/tests/browser/tasks-layout.html")
            page.wait_for_load_state("networkidle")
            assert not errors, errors
            page.get_by_text("Synthetic project", exact=True).click(timeout=5000)
            page.wait_for_load_state("networkidle")
            dimensions = page.locator(".tasks-workspace").bounding_box()
            print(json.dumps({"width": width, "workspace": dimensions}))
            assert dimensions and dimensions["height"] > 300, dimensions
            assert page.evaluate("document.documentElement.scrollWidth") <= width
            expect(page.get_by_role("button", name="Nova tarefa", exact=True)).to_be_visible()
            page.get_by_role("button", name="Nova tarefa", exact=True).click()
            expect(page.locator(".tasks-modal")).to_be_visible()
            assert not errors, errors
            page.close()
    finally:
        browser.close()
