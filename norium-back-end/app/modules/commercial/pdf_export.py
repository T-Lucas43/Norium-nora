from __future__ import annotations

import base64
import io
import re
from html.parser import HTMLParser
from typing import Any
from app.modules.commercial.pdf_editor import apply_pdf_edits, decode_image

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    HRFlowable,
    Image,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


def build_commercial_pdf(document: dict[str, Any], document_type: str, include_edits: bool = True) -> tuple[bytes, str]:
    """Gera o PDF canonico usado por exportacao, Gmail e chat da equipe."""
    output = io.BytesIO()
    branding = document.get("branding") if isinstance(document.get("branding"), dict) else {}
    primary = safe_color(branding.get("primaryColor"), "#1E293B")
    secondary = safe_color(branding.get("secondaryColor"), "#2563EB")
    text_color = safe_color(branding.get("textColor"), "#0F172A")
    title = str(document.get("title") or "Documento comercial").strip()
    client = document.get("client") if isinstance(document.get("client"), dict) else {}
    kind = "Proposta comercial" if document_type == "proposal" else "Contrato comercial"
    filename = f"{slugify(kind)}-{slugify(title)}.pdf"

    pdf = SimpleDocTemplate(
        output,
        pagesize=A4,
        rightMargin=18 * mm,
        leftMargin=18 * mm,
        topMargin=22 * mm,
        bottomMargin=20 * mm,
        title=title,
        author="Norium",
        subject=kind,
        pageCompression=1,
    )
    styles = document_styles(primary, secondary, text_color)
    story: list[Any] = []

    logo = logo_flowable(branding.get("logoUrl"), branding.get("logoAlignment"), branding.get("logoScale"))
    if logo:
        story.append(logo)
        story.append(Spacer(1, 18 * mm))
    else:
        story.append(Spacer(1, 24 * mm))

    story.extend(
        [
            Paragraph(kind.upper(), styles["CoverLabel"]),
            Spacer(1, 7 * mm),
            Paragraph(escape_reportlab(title), styles["CoverTitle"]),
            Spacer(1, 16 * mm),
            HRFlowable(width="100%", thickness=2, color=secondary),
            Spacer(1, 7 * mm),
            Paragraph("Preparado para", styles["MetaLabel"]),
            Paragraph(escape_reportlab(str(client.get("company") or client.get("name") or "Cliente")), styles["Client"]),
        ]
    )
    client_details = " | ".join(str(value) for value in [client.get("document"), client.get("email")] if value)
    if client_details:
        story.append(Paragraph(escape_reportlab(client_details), styles["BodyMuted"]))
    story.extend(
        [
            Spacer(1, 55 * mm),
            Paragraph(f"Atualizado em {format_date(document.get('updatedAt'))}", styles["BodyMuted"]),
            PageBreak(),
        ]
    )

    header_html = clean_text(str(branding.get("headerHtml") or ""))
    if header_html:
        story.append(Paragraph(escape_reportlab(header_html), styles["BodyMuted"]))
        story.append(HRFlowable(width="100%", thickness=0.6, color=colors.HexColor("#CBD5E1")))
        story.append(Spacer(1, 5 * mm))
    story.append(Paragraph(escape_reportlab(title), styles["Title"]))
    story.append(Spacer(1, 6 * mm))
    story.extend(html_story(str(document.get("contentHtml") or ""), styles))

    signers = [item for item in document.get("signers", []) if isinstance(item, dict)]
    if signers:
        rows: list[list[Any]] = []
        for index in range(0, len(signers), 2):
            cells: list[Any] = []
            for signer in signers[index:index + 2]:
                role = {"client": "Contratante", "contractor": "Contratado", "witness": "Testemunha"}.get(str(signer.get("role")), "Assinante")
                signature_image = []
                if signer.get("signatureDataUrl"):
                    raw = decode_image(str(signer["signatureDataUrl"]))
                    image = Image(io.BytesIO(raw), width=150, height=48, kind="proportional")
                    signature_image.append(image)
                cells.append([*signature_image, Paragraph(
                    f"<br/><br/>______________________________<br/><b>{escape_reportlab(str(signer.get('name') or 'Assinante'))}</b><br/>{role}",
                    styles["Signature"],
                )])
            while len(cells) < 2:
                cells.append("")
            rows.append(cells)
        signatures = Table(rows, colWidths=[(A4[0] - 36 * mm) / 2] * 2, hAlign="LEFT")
        signatures.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 8)]))
        # O titulo e as linhas de assinatura precisam viajar juntos. Mantê-los
        # separados permitia que o ReportLab deixasse o titulo no fim de uma
        # pagina e empurrasse somente os assinantes para a pagina seguinte.
        story.append(
            KeepTogether(
                [
                    Spacer(1, 8 * mm),
                    Paragraph("Assinaturas", styles["SignatureHeading"]),
                    Spacer(1, 5 * mm),
                    signatures,
                ]
            )
        )

    footer_text = clean_text(str(branding.get("footerHtml") or ""))

    def decorate_page(canvas, doc) -> None:
        canvas.saveState()
        canvas.setStrokeColor(secondary)
        canvas.setLineWidth(1.2)
        canvas.line(18 * mm, 13 * mm, A4[0] - 18 * mm, 13 * mm)
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(colors.HexColor("#64748B"))
        footer = footer_text[:100] if footer_text else "Norium | Documento comercial"
        canvas.drawString(18 * mm, 8.5 * mm, footer)
        canvas.drawRightString(A4[0] - 18 * mm, 8.5 * mm, f"Pagina {doc.page}")
        canvas.restoreState()

    pdf.build(story, onFirstPage=decorate_page, onLaterPages=decorate_page)
    result = output.getvalue()
    if include_edits and document.get("pdfEdits"):
        result = apply_pdf_edits(result, document["pdfEdits"])
    return result, filename


class BlockParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[tuple[str, str]] = []
        self.current_tag = "p"
        self.buffer: list[str] = []
        self.list_depth = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        if tag in {"h1", "h2", "h3", "p", "li", "blockquote", "tr"}:
            self.flush()
            self.current_tag = tag
        if tag in {"ul", "ol"}:
            self.list_depth += 1
        if tag == "br":
            self.buffer.append("<br/>")
        if tag in {"strong", "b"}:
            self.buffer.append("<b>")
        if tag in {"em", "i"}:
            self.buffer.append("<i>")
        if tag == "u":
            self.buffer.append("<u>")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in {"strong", "b"}:
            self.buffer.append("</b>")
        if tag in {"em", "i"}:
            self.buffer.append("</i>")
        if tag == "u":
            self.buffer.append("</u>")
        if tag in {"h1", "h2", "h3", "p", "li", "blockquote", "tr"}:
            self.flush()
        if tag in {"ul", "ol"}:
            self.list_depth = max(0, self.list_depth - 1)

    def handle_data(self, data: str) -> None:
        self.buffer.append(escape_reportlab(data))

    def flush(self) -> None:
        value = "".join(self.buffer).strip()
        if value:
            self.blocks.append((self.current_tag, value))
        self.buffer = []
        self.current_tag = "p"


def html_story(value: str, styles: dict[str, ParagraphStyle]) -> list[Any]:
    parser = BlockParser()
    parser.feed(value)
    parser.flush()
    blocks = parser.blocks or [("p", "Documento sem conteudo.")]
    flowables: list[Any] = []
    index = 0
    while index < len(blocks):
        tag, text = blocks[index]
        style_name = {"h1": "Heading1", "h2": "Heading2", "h3": "Heading3", "blockquote": "Quote", "li": "Bullet"}.get(tag, "Body")
        paragraph = Paragraph(("&#8226; " if tag == "li" else "") + text, styles[style_name])
        # Mantem o titulo com o primeiro paragrafo da secao, evitando quebras sem sentido.
        if tag in {"h1", "h2", "h3"} and index + 1 < len(blocks) and blocks[index + 1][0] not in {"h1", "h2", "h3"}:
            next_tag, next_text = blocks[index + 1]
            next_style = "Bullet" if next_tag == "li" else "Body"
            next_paragraph = Paragraph(("&#8226; " if next_tag == "li" else "") + next_text, styles[next_style])
            flowables.append(KeepTogether([paragraph, Spacer(1, 2 * mm), next_paragraph, Spacer(1, 2.5 * mm)]))
            index += 2
            continue
        flowables.extend([paragraph, Spacer(1, 2.5 * mm)])
        index += 1
    return flowables


def document_styles(primary, secondary, text_color) -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "CoverLabel": ParagraphStyle("CoverLabel", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=10, leading=13, textColor=secondary, spaceAfter=0),
        "CoverTitle": ParagraphStyle("CoverTitle", parent=base["Title"], fontName="Helvetica-Bold", fontSize=29, leading=35, textColor=primary, alignment=TA_LEFT),
        "MetaLabel": ParagraphStyle("MetaLabel", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=colors.HexColor("#64748B")),
        "Client": ParagraphStyle("Client", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=17, leading=22, textColor=text_color),
        "Title": ParagraphStyle("Title", parent=base["Title"], fontName="Helvetica-Bold", fontSize=23, leading=29, textColor=primary, keepWithNext=True),
        "Heading1": ParagraphStyle("Heading1", parent=base["Heading1"], fontName="Helvetica-Bold", fontSize=18, leading=23, textColor=primary, spaceBefore=10, keepWithNext=True),
        "Heading2": ParagraphStyle("Heading2", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=15, leading=20, textColor=primary, spaceBefore=9, keepWithNext=True),
        "Heading3": ParagraphStyle("Heading3", parent=base["Heading3"], fontName="Helvetica-Bold", fontSize=12, leading=17, textColor=primary, spaceBefore=7, keepWithNext=True),
        "SignatureHeading": ParagraphStyle("SignatureHeading", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=15, leading=20, textColor=primary, spaceBefore=0, spaceAfter=0, keepWithNext=True),
        "Body": ParagraphStyle("Body", parent=base["BodyText"], fontName="Helvetica", fontSize=10.5, leading=16, textColor=text_color, splitLongWords=True, allowWidows=0, allowOrphans=0),
        "BodyMuted": ParagraphStyle("BodyMuted", parent=base["BodyText"], fontName="Helvetica", fontSize=9, leading=13, textColor=colors.HexColor("#64748B")),
        "Bullet": ParagraphStyle("Bullet", parent=base["BodyText"], fontName="Helvetica", fontSize=10.5, leading=16, leftIndent=5 * mm, firstLineIndent=-3 * mm, textColor=text_color),
        "Quote": ParagraphStyle("Quote", parent=base["BodyText"], fontName="Helvetica-Oblique", fontSize=10.5, leading=16, leftIndent=5 * mm, borderColor=secondary, borderWidth=1.5, borderPadding=5, textColor=colors.HexColor("#475569")),
        "Signature": ParagraphStyle("Signature", parent=base["BodyText"], fontName="Helvetica", fontSize=9, leading=13, textColor=text_color),
    }


def logo_flowable(value: Any, alignment: Any, scale: Any) -> Image | None:
    text = str(value or "")
    match = re.match(r"^data:image/[^;]+;base64,(.+)$", text, flags=re.DOTALL | re.IGNORECASE)
    if not match:
        return None
    try:
        image = Image(io.BytesIO(base64.b64decode(match.group(1), validate=True)))
    except Exception:
        return None
    max_width = 55 * mm * max(0.3, min(1.8, float(scale or 100) / 100))
    ratio = min(max_width / max(image.imageWidth, 1), 22 * mm / max(image.imageHeight, 1))
    image.drawWidth = image.imageWidth * ratio
    image.drawHeight = image.imageHeight * ratio
    image.hAlign = {"center": "CENTER", "right": "RIGHT"}.get(str(alignment), "LEFT")
    return image


def safe_color(value: Any, fallback: str):
    text = str(value or fallback)
    return colors.HexColor(text if re.fullmatch(r"#[0-9a-fA-F]{6}", text) else fallback)


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", value)).strip()


def escape_reportlab(value: str) -> str:
    return str(value or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def slugify(value: str) -> str:
    text = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip()).strip("-").lower()
    return text[:80] or "documento"


def format_date(value: Any) -> str:
    text = str(value or "")
    return text[:10].split("T")[0] if text else "data nao informada"
