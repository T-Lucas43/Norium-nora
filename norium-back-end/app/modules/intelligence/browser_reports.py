"""Editable research documents with server-owned source references."""
from __future__ import annotations

from html import escape
from datetime import datetime, timezone
from io import BytesIO
import re
from typing import Any

from fastapi import HTTPException
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.modules.intelligence.repository import mutate_store, now_iso, read_store


def get_report(user_id: str, run_id: str) -> dict[str, Any]:
    run = next((item for item in read_store(user_id)["browserRuns"] if item["id"] == run_id), None)
    if not run:
        raise HTTPException(404, "Pesquisa não encontrada.")
    report = run.get("report")
    if not report:
        raise HTTPException(404, "O relatório ainda não está pronto.")
    return report


async def update_report(user_id: str, run_id: str, payload: dict) -> dict:
    def update(store: dict) -> dict:
        run = next((item for item in store["browserRuns"] if item["id"] == run_id), None)
        report = run.get("report") if run else None
        if not report:
            raise HTTPException(404, "Relatório não encontrado.")
        if int(report["revision"]) != payload["revision"]:
            raise HTTPException(409, "O relatório foi atualizado em outra janela. Reabra antes de editar.")
        report.update(title=payload["title"].strip(), content=payload["content"].strip(), revision=report["revision"] + 1, updatedAt=now_iso())
        run["updatedAt"] = now_iso()
        return report
    return await mutate_store(user_id, update)


def report_pdf(report: dict) -> bytes:
    stream = BytesIO()
    styles = getSampleStyleSheet()
    body = ParagraphStyle("ReportBody", fontName="Helvetica", fontSize=10, leading=15, spaceAfter=9, textColor=colors.HexColor("#202124"), alignment=TA_LEFT, splitLongWords=True)
    heading = ParagraphStyle("ReportHeading", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=13, spaceBefore=12, spaceAfter=8)
    small = ParagraphStyle("ReportSource", parent=body, fontSize=8, leading=12)
    story = [Paragraph("NORIUM / PESQUISA", small), Paragraph(escape(report["title"]), styles["Title"]), Spacer(1, .3 * cm)]
    story.append(Paragraph(escape(report.get("coverage", "")), small))
    def inline(value: str) -> str:
        value = escape(value)
        value = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", value)
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
