"""Editable research documents with server-owned source references."""
from __future__ import annotations

from html import escape
from datetime import datetime, timezone
from io import BytesIO
import gzip
import json
import re
import time
from typing import Any

from fastapi import HTTPException
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.modules.intelligence.repository import mutate_store, now_iso, read_store
from app.infrastructure.persistence import files as persistent_files


_REWRITES: set[str] = set()


def save_research_material(user_id: str, run_id: str, pages: list[dict]) -> None:
    from app.modules.intelligence.browser_runtime import _run_dir
    path = _run_dir(user_id, run_id) / "research-material.json.gz"
    persistent_files.write(path, gzip.compress(json.dumps(pages, ensure_ascii=False).encode("utf-8")),
                           content_type="application/gzip")


def load_research_material(user_id: str, run_id: str) -> list[dict] | None:
    from app.modules.intelligence.browser_runtime import _run_dir
    path = _run_dir(user_id, run_id) / "research-material.json.gz"
    if not persistent_files.exists(path):
        return None
    try:
        return json.loads(gzip.decompress(persistent_files.read(path)))
    except (OSError, ValueError, EOFError, FileNotFoundError):
        return None


def get_report(user_id: str, run_id: str) -> dict[str, Any]:
    run = next((item for item in read_store(user_id)["browserRuns"] if item["id"] == run_id), None)
    if not run:
        raise HTTPException(404, "Pesquisa não encontrada.")
    report = run.get("report")
    if not report:
        raise HTTPException(404, "O relatório ainda não está pronto.")
    return {key: value for key, value in report.items() if key != "researchMaterial"}


async def update_report(user_id: str, run_id: str, payload: dict) -> dict:
    def update(store: dict) -> dict:
        run = next((item for item in store["browserRuns"] if item["id"] == run_id), None)
        report = run.get("report") if run else None
        if not report:
            raise HTTPException(404, "Relatório não encontrado.")
        if int(report["revision"]) != payload["revision"]:
            raise HTTPException(409, "O relatório foi atualizado em outra janela. Reabra antes de editar.")
        report.update(title=payload["title"].strip(), content=payload["content"].strip(), revision=report["revision"] + 1, generator="manual", updatedAt=now_iso())
        run["updatedAt"] = now_iso()
        if run.get("status") == "analysis_pending":
            run["status"] = "completed"
            for step in run.get("plan", []):
                if step.get("status") == "analysis_pending":
                    step["status"] = "completed"
            if isinstance(run.get("researchProgress"), dict):
                run["researchProgress"]["phase"] = "completed"
        return {key: value for key, value in report.items() if key != "researchMaterial"}
    return await mutate_store(user_id, update)


async def rewrite_report(user_id: str, run_id: str, revision: int, instruction: str) -> dict:
    from app.modules.intelligence.browser_live import live_key
    key = live_key(user_id, run_id)
    if key in _REWRITES:
        raise HTTPException(409, "A Nora já está reescrevendo este relatório. Aguarde a conclusão.")
    _REWRITES.add(key)
    try:
        return await _rewrite_report(user_id, run_id, revision, instruction)
    finally:
        _REWRITES.discard(key)


async def _rewrite_report(user_id: str, run_id: str, revision: int, instruction: str) -> dict:
    from app.modules.intelligence.browser_research import summarize
    from app.modules.intelligence.browser_runtime import BrowserControl

    run = next((item for item in read_store(user_id)["browserRuns"] if item["id"] == run_id), None)
    report = run.get("report") if run else None
    if not report:
        raise HTTPException(404, "Relatório não encontrado.")
    if report["revision"] != revision:
        raise HTTPException(409, "O relatório mudou. Reabra antes de pedir uma nova redação.")
    if run.get("status") in {"running", "queued", "paused", "awaiting_approval", "awaiting_login"}:
        raise HTTPException(409, "Aguarde a pesquisa terminar antes de reescrever o relatório.")
    material = report.get("researchMaterial") or load_research_material(user_id, run_id)
    legacy = not material
    if not material:
        # Older reports retain their known sources; no invented new browsing or evidence.
        material = [{"title": source["title"], "url": source["url"], "text": report["content"] if index == 0 else "Fonte listada no relatório anterior; o texto integral desta página não está disponível.", "layout": {}} for index, source in enumerate(report["sources"])]
    task = {**run, "objective": f"{run['objective']}\nOrientação adicional do usuário: {instruction}"}
    if legacy:
        task["previousReport"] = report["content"]
        task["objective"] += "\nEsta revisão usa o relatório anterior, não uma nova consulta às páginas. Preserve os fatos e as referências existentes, explique os conceitos e não adicione evidências que não foram fornecidas."
    import asyncio
    async def save_notes(pages):
        await asyncio.to_thread(save_research_material, user_id, run_id, pages)

    content, generator, warnings = await summarize(material, task, BrowserControl(), time.monotonic() + 150, on_material=save_notes)
    if generator != "nora":
        raise HTTPException(503, warnings[0] if warnings else "A Nora não conseguiu concluir a nova redação agora. Seu relatório anterior foi preservado. Tente novamente.")

    def save(store):
        current = next((item for item in store["browserRuns"] if item["id"] == run_id), None)
        saved = current.get("report") if current else None
        if not saved or saved["revision"] != revision:
            raise HTTPException(409, "O relatório foi editado durante a reescrita. As alterações existentes foram preservadas.")
        saved.update(content=content, revision=revision + 1, generator="nora", updatedAt=now_iso())
        saved["warnings"] = [warning for warning in saved.get("warnings", []) if not any(term in warning.lower() for term in ("nora", "síntese", "provedor de ia"))] + warnings
        if legacy:
            note = "Esta revisão foi elaborada com o relatório anterior e suas referências, sem nova navegação nas páginas."
            if note not in saved["warnings"]:
                saved["warnings"].append(note)
        current["updatedAt"] = now_iso()
        if current.get("status") == "analysis_pending":
            current["status"] = "completed"
            for step in current.get("plan", []):
                if step.get("status") == "analysis_pending":
                    step["status"] = "completed"
            if isinstance(current.get("researchProgress"), dict):
                current["researchProgress"]["phase"] = "completed"
        return {key: value for key, value in saved.items() if key != "researchMaterial"}
    return await mutate_store(user_id, save)


def report_pdf(report: dict) -> bytes:
    stream = BytesIO()
    styles = getSampleStyleSheet()
    body = ParagraphStyle("ReportBody", fontName="Helvetica", fontSize=10, leading=15, spaceAfter=9, textColor=colors.HexColor("#202124"), alignment=TA_LEFT, splitLongWords=True)
    heading = ParagraphStyle("ReportHeading", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=13, spaceBefore=12, spaceAfter=8)
    small = ParagraphStyle("ReportSource", parent=body, fontSize=8, leading=12)
    story = [Paragraph("NORIUM / PESQUISA", small), Paragraph(escape(report["title"]), styles["Title"]), Spacer(1, .3 * cm)]
    story.append(Paragraph(escape(report.get("coverage", "")), small))
    def inline(value: str) -> str:
        value = value.translate(str.maketrans({"\u2010": "-", "\u2011": "-", "\u2212": "-", "\u2009": " ", "\u202f": " "}))
        value = escape(value)
        value = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", value)
        value = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<i>\1</i>", value)
        value = re.sub(r"`([^`]+)`", r"<font face='Courier'>\1</font>", value)
        return value

    lines = report["content"].splitlines()
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        index += 1
        if line.startswith("|") and index < len(lines) and re.fullmatch(r"[| :\-]+", lines[index].strip()):
            rows = [[Paragraph(inline(cell.strip()), small) for cell in line.strip("|").split("|")]]
            index += 1
            while index < len(lines) and lines[index].strip().startswith("|"):
                cells = lines[index].strip().strip("|").split("|")
                if len(cells) == len(rows[0]):
                    rows.append([Paragraph(inline(cell.strip()), small) for cell in cells])
                index += 1
            table = Table(rows, colWidths=[17 * cm / len(rows[0])] * len(rows[0]), repeatRows=1, hAlign="LEFT")
            table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee")), ("GRID", (0, 0), (-1, -1), .4, colors.HexColor("#d5d5d5")), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7)]))
            story.extend([table, Spacer(1, .3 * cm)])
            continue
        if not line.strip():
            story.append(Spacer(1, .15 * cm))
        elif line.startswith("#"):
            story.append(Paragraph(inline(line.lstrip("# ")), heading))
        else:
            if re.fullmatch(r"[-*_]{3,}", line):
                continue
            story.append(Paragraph(inline(line[2:]) if line.startswith("- ") else inline(line), body, bulletText="•" if line.startswith("- ") else None))
    story.append(Paragraph("Fontes consultadas", heading))
    for index, source in enumerate(report.get("sources", []), 1):
        # URLs come from validated navigations, never from model-produced links.
        url = escape(source["url"], quote=True)
        accessed = source.get("accessedAt", "")
        try:
            accessed = datetime.fromisoformat(accessed).astimezone(timezone.utc).strftime("%d/%m/%Y, %H:%M UTC")
        except ValueError:
            pass
        story.append(Paragraph(f'[{index}] {escape(source.get("title") or source["url"])}<br/><link href="{url}" color="#245a9b">{url}</link><br/>Acesso: {escape(accessed)}', small))
    for warning in report.get("warnings", []):
        story.append(Paragraph(escape(warning), small))

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(colors.HexColor("#666666"))
        canvas.drawString(2 * cm, 1.2 * cm, "Norium | Relatório de pesquisa")
        canvas.drawRightString(19 * cm, 1.2 * cm, str(doc.page))
        canvas.restoreState()

    SimpleDocTemplate(stream, pagesize=(21 * cm, 29.7 * cm), rightMargin=2 * cm, leftMargin=2 * cm, topMargin=1.8 * cm, bottomMargin=2 * cm, title=report["title"], author="Norium").build(story, onFirstPage=footer, onLaterPages=footer)
    return stream.getvalue()
