from __future__ import annotations

import base64
import io
import re
from html.parser import HTMLParser
from typing import Any
import unicodedata
from app.modules.commercial.pdf_editor import apply_pdf_edits, decode_image
from app.modules.commercial.document_templates import document_type_label

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


def build_commercial_pdf(document: dict[str, Any], document_type: str, include_edits: bool = True, tenant_id: str | None = None) -> tuple[bytes, str]:
    """Gera o PDF canonico usado por exportacao, Gmail e chat da equipe."""
    output = io.BytesIO()
    branding = document.get("branding") if isinstance(document.get("branding"), dict) else {}
    primary = safe_color(branding.get("primaryColor"), "#1E293B")
    secondary = safe_color(branding.get("secondaryColor"), "#2563EB")
    text_color = safe_color(branding.get("textColor"), "#0F172A")
    title = str(document.get("title") or "Documento comercial").strip()
    client = document.get("client") if isinstance(document.get("client"), dict) else {}
    metadata = document.get("metadata") if isinstance(document.get("metadata"), dict) else {}
    template_document_type = str(metadata.get("documentType") or document_type)
    template_layout = re.sub(r"[^a-z0-9_-]", "", str(metadata.get("templateLayout") or "classic").casefold()) or "classic"
    is_resume = template_document_type == "resume"
    kind = (
        "Contrato comercial"
        if document_type == "contract"
        else "Proposta comercial"
        if template_document_type == "proposal"
        else document_type_label(template_document_type)
    )
    filename = f"{slugify(kind)}-{slugify(title)}.pdf"
    if document_type == "proposal" and document.get("sourceDocumentId"):
        from app.modules.commercial.document_files import document_path, imported_document_or_404
        from app.modules.commercial.repository import read_store
        if not tenant_id:
            raise ValueError("O workspace é obrigatório para abrir a proposta importada.")
        _, source = imported_document_or_404(read_store(tenant_id), document["sourceDocumentId"])
        content = document_path(tenant_id, source).read_bytes()
        if include_edits and document.get("pdfEdits") and not document.get("signedDocumentId"):
            content = apply_pdf_edits(content, document["pdfEdits"])
        return content, filename

    pdf = SimpleDocTemplate(
        output,
        pagesize=A4,
        rightMargin=(14 if is_resume else 18) * mm,
        leftMargin=(14 if is_resume else 18) * mm,
        topMargin=(12 if is_resume else 22) * mm,
        bottomMargin=(14 if is_resume else 20) * mm,
        title=title,
        author="Norium",
        subject=kind,
        pageCompression=1,
    )
    styles = document_styles(primary, secondary, text_color, compact=is_resume)
    story: list[Any] = []

    logo = logo_flowable(
        branding.get("logoUrl"),
        branding.get("logoAlignment"),
        branding.get("logoScale"),
        portrait=is_resume and bool(metadata.get("photoAsPortrait")),
    )
    uses_commercial_cover = document_type == "contract" or template_document_type == "proposal"
    if uses_commercial_cover:
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
    else:
        if logo:
            story.append(logo)
            story.append(Spacer(1, 4 * mm if is_resume else 7 * mm))
        if not is_resume:
            story.extend(
                [
                    Paragraph(kind.upper(), styles["CoverLabel"]),
                    Spacer(1, 3 * mm),
                    Paragraph(escape_reportlab(title), styles["CoverTitle"]),
                    Spacer(1, 5 * mm),
                    HRFlowable(width="100%", thickness=2, color=secondary),
                    Spacer(1, 6 * mm),
                ]
            )

    header_html = clean_text(str(branding.get("headerHtml") or ""))
    if header_html:
        story.append(Paragraph(escape_reportlab(header_html), styles["BodyMuted"]))
        story.append(HRFlowable(width="100%", thickness=0.6, color=colors.HexColor("#CBD5E1")))
        story.append(Spacer(1, 5 * mm))
    content_html = str(document.get("contentHtml") or "")
    has_content_title = bool(re.search(r"<h1\b", content_html, flags=re.IGNORECASE))
    if uses_commercial_cover and not has_content_title:
        story.append(Paragraph(escape_reportlab(title), styles["Title"]))
        story.append(Spacer(1, 6 * mm))
    elif not uses_commercial_cover and not is_resume:
        # The inline document header already prints the title. Preserve a
        # distinct authored h1, but don't repeat the same title immediately.
        heading = re.search(r"<h1\b[^>]*>(.*?)</h1>", content_html, flags=re.I | re.S)
        if heading and clean_text(heading.group(1)) == title:
            content_html = content_html[:heading.start()] + content_html[heading.end():]
    story.extend(html_story(content_html, styles, compact=is_resume))

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
        if is_resume:
            canvas.setFillColor(primary)
            if template_layout == "resume-sidebar":
                canvas.rect(0, 0, 10 * mm, A4[1], fill=1, stroke=0)
                canvas.setFillColor(secondary)
                canvas.rect(10 * mm, 0, 1.5 * mm, A4[1], fill=1, stroke=0)
            elif template_layout == "resume-executive":
                canvas.rect(0, A4[1] - 9 * mm, A4[0] * 0.76, 9 * mm, fill=1, stroke=0)
                canvas.setFillColor(secondary)
                canvas.rect(A4[0] * 0.76, A4[1] - 9 * mm, A4[0] * 0.24, 9 * mm, fill=1, stroke=0)
            elif template_layout == "resume-creative":
                canvas.setFillColor(secondary)
                canvas.rect(0, A4[1] - 7 * mm, A4[0], 7 * mm, fill=1, stroke=0)
                canvas.setFillColor(primary)
                canvas.rect(0, A4[1] - 3 * mm, A4[0] * 0.62, 3 * mm, fill=1, stroke=0)
            else:
                canvas.rect(0, A4[1] - 5 * mm, A4[0], 5 * mm, fill=1, stroke=0)
                canvas.setFillColor(secondary)
                canvas.rect(A4[0] - 42 * mm, A4[1] - 5 * mm, 42 * mm, 5 * mm, fill=1, stroke=0)
            if template_layout == "resume-timeline":
                canvas.setStrokeColor(secondary)
                canvas.setLineWidth(2)
                canvas.line(14 * mm, 22 * mm, 14 * mm, A4[1] - 18 * mm)
        canvas.setStrokeColor(secondary)
        canvas.setLineWidth(1.2)
        canvas.line(18 * mm, 13 * mm, A4[0] - 18 * mm, 13 * mm)
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(colors.HexColor("#64748B"))
        footer = footer_text[:100] if footer_text else f"Norium | {kind}"
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
        self.blocks: list[tuple[str, Any]] = []
        self.current_tag = "p"
        self.buffer: list[str] = []
        self.list_depth = 0
        self.table_rows: list[list[str]] | None = None
        self.table_row: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        if tag == "table":
            self.flush()
            self.table_rows = []
            return
        if self.table_rows is not None:
            if tag == "tr":
                self.table_row = []
                self.buffer = []
                return
            if tag in {"td", "th"}:
                self.buffer = []
                return
            if tag in {"p", "div", "li"}:
                if self.buffer:
                    self.buffer.append("<br/>")
                return
        if tag == "img":
            self.flush()
            source = next((str(value or "") for name, value in attrs if str(name).lower() == "src"), "")
            if source.startswith("data:image/"):
                self.blocks.append(("img", source))
            self.current_tag = "p"
            return
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
        if self.table_rows is not None:
            if tag in {"td", "th"}:
                self.table_row.append("".join(self.buffer).strip())
                self.buffer = []
                return
            if tag == "tr":
                if self.table_row:
                    self.table_rows.append(self.table_row)
                self.table_row = []
                self.buffer = []
                return
            if tag == "table":
                if self.table_rows:
                    self.blocks.append(("table", self.table_rows))
                self.table_rows = None
                self.buffer = []
                self.current_tag = "p"
                return
            if tag in {"p", "div", "li"}:
                return
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


def html_story(value: str, styles: dict[str, ParagraphStyle], *, compact: bool = False) -> list[Any]:
    parser = BlockParser()
    parser.feed(value)
    parser.flush()
    blocks = parser.blocks or [("p", "Documento sem conteudo.")]
    flowables: list[Any] = []
    block_gap = (0.8 if compact else 2.5) * mm
    heading_gap = (0.65 if compact else 2) * mm
    paired_gap = (0.9 if compact else 2.5) * mm
    index = 0
    while index < len(blocks):
        tag, text = blocks[index]
        if tag == "table":
            columns = max(len(row) for row in text)
            rows = [[Paragraph(cell or " ", styles["TableCell"]) for cell in row + [""] * (columns - len(row))] for row in text]
            grid = Table(rows, colWidths=[(A4[0] - 36 * mm) / columns] * columns, repeatRows=1, hAlign="LEFT")
            grid.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E2E8F0")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F8FAFC")]),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#CBD5E1")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]))
            flowables.extend([grid, Spacer(1, 4 * mm)])
            index += 1
            continue
        if tag == "img":
            image = content_image_flowable(text, compact=compact)
            if image:
                flowables.extend([image, Spacer(1, (1.2 if compact else 4) * mm)])
            index += 1
            continue
        style_name = {"h1": "Heading1", "h2": "Heading2", "h3": "Heading3", "blockquote": "Quote", "li": "Bullet"}.get(tag, "Body")
        paragraph = Paragraph(("&#8226; " if tag == "li" else "") + text, styles[style_name])
        # Mantem o titulo com o primeiro paragrafo da secao, evitando quebras sem sentido.
        if tag in {"h1", "h2", "h3"} and index + 1 < len(blocks) and blocks[index + 1][0] not in {"h1", "h2", "h3", "img", "table"}:
            next_tag, next_text = blocks[index + 1]
            next_style = "Bullet" if next_tag == "li" else "Body"
            next_paragraph = Paragraph(("&#8226; " if next_tag == "li" else "") + next_text, styles[next_style])
            flowables.append(KeepTogether([paragraph, Spacer(1, heading_gap), next_paragraph, Spacer(1, paired_gap)]))
            index += 2
            continue
        flowables.extend([paragraph, Spacer(1, block_gap)])
        index += 1
    # A final spacer can overflow onto an otherwise empty trailing page.
    while flowables and isinstance(flowables[-1], Spacer):
        flowables.pop()
    return flowables


def content_image_flowable(value: str, *, compact: bool = False) -> Image | None:
    """Converte imagens embutidas do editor em imagens proporcionais no PDF."""
    match = re.match(r"^data:image/[^;]+;base64,(.+)$", value, flags=re.DOTALL | re.IGNORECASE)
    if not match:
        return None
    try:
        image = Image(io.BytesIO(base64.b64decode(match.group(1), validate=True)))
        max_width = 30 * mm if compact else 160 * mm
        max_height = 24 * mm if compact else 70 * mm
        ratio = min(max_width / max(image.imageWidth, 1), max_height / max(image.imageHeight, 1), 1)
        image.drawWidth = image.imageWidth * ratio
        image.drawHeight = image.imageHeight * ratio
        image.hAlign = "RIGHT" if compact else "CENTER"
        return image
    except Exception:
        return None


def document_styles(primary, secondary, text_color, *, compact: bool = False) -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    body_size = 9.2 if compact else 10.5
    body_leading = 12.2 if compact else 16
    heading_1_size = 23 if compact else 18
    heading_2_size = 11 if compact else 15
    heading_3_size = 9.6 if compact else 12
    return {
        "CoverLabel": ParagraphStyle("CoverLabel", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=10, leading=13, textColor=secondary, spaceAfter=0),
        "CoverTitle": ParagraphStyle("CoverTitle", parent=base["Title"], fontName="Helvetica-Bold", fontSize=29, leading=35, textColor=primary, alignment=TA_LEFT),
        "MetaLabel": ParagraphStyle("MetaLabel", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=colors.HexColor("#64748B")),
        "Client": ParagraphStyle("Client", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=17, leading=22, textColor=text_color),
        "Title": ParagraphStyle("Title", parent=base["Title"], fontName="Helvetica-Bold", fontSize=23, leading=29, textColor=primary, keepWithNext=True),
        "Heading1": ParagraphStyle("Heading1", parent=base["Heading1"], fontName="Helvetica-Bold", fontSize=heading_1_size, leading=heading_1_size + 3, textColor=primary, spaceBefore=2 if compact else 10, spaceAfter=0, keepWithNext=True),
        "Heading2": ParagraphStyle("Heading2", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=heading_2_size, leading=heading_2_size + 3, textColor=primary, spaceBefore=5 if compact else 9, spaceAfter=1, borderColor=secondary, borderWidth=0 if compact else 0, keepWithNext=True),
        "Heading3": ParagraphStyle("Heading3", parent=base["Heading3"], fontName="Helvetica-Bold", fontSize=heading_3_size, leading=heading_3_size + 3, textColor=primary, spaceBefore=4 if compact else 7, keepWithNext=True),
        "SignatureHeading": ParagraphStyle("SignatureHeading", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=15, leading=20, textColor=primary, spaceBefore=0, spaceAfter=0, keepWithNext=True),
        "Body": ParagraphStyle("Body", parent=base["BodyText"], fontName="Helvetica", fontSize=body_size, leading=body_leading, textColor=text_color, splitLongWords=True, allowWidows=0, allowOrphans=0),
        "TableCell": ParagraphStyle("TableCell", parent=base["BodyText"], fontName="Helvetica", fontSize=8.3 if compact else 9, leading=11 if compact else 13, textColor=text_color, splitLongWords=True),
        "BodyMuted": ParagraphStyle("BodyMuted", parent=base["BodyText"], fontName="Helvetica", fontSize=9, leading=13, textColor=colors.HexColor("#64748B")),
        "Bullet": ParagraphStyle("Bullet", parent=base["BodyText"], fontName="Helvetica", fontSize=body_size, leading=body_leading, leftIndent=4 * mm if compact else 5 * mm, firstLineIndent=-3 * mm, textColor=text_color, allowWidows=0, allowOrphans=0),
        "Quote": ParagraphStyle("Quote", parent=base["BodyText"], fontName="Helvetica-Oblique", fontSize=8 if compact else 10.5, leading=10 if compact else 16, leftIndent=3 * mm if compact else 5 * mm, borderColor=secondary, borderWidth=1.5, borderPadding=4 if compact else 5, textColor=colors.HexColor("#475569")),
        "Signature": ParagraphStyle("Signature", parent=base["BodyText"], fontName="Helvetica", fontSize=9, leading=13, textColor=text_color),
    }


def logo_flowable(value: Any, alignment: Any, scale: Any, *, portrait: bool = False) -> Image | None:
    text = str(value or "")
    match = re.match(r"^data:image/[^;]+;base64,(.+)$", text, flags=re.DOTALL | re.IGNORECASE)
    if not match:
        return None
    try:
        image = Image(io.BytesIO(base64.b64decode(match.group(1), validate=True)))
    except Exception:
        return None
    normalized_scale = max(0.3, min(1.8, float(scale or 100) / 100))
    if portrait:
        target_size = 28 * mm * normalized_scale
        ratio = min(target_size / max(image.imageWidth, 1), target_size / max(image.imageHeight, 1))
    else:
        max_width = 55 * mm * normalized_scale
        max_height = 22 * mm * normalized_scale
        ratio = min(max_width / max(image.imageWidth, 1), max_height / max(image.imageHeight, 1))
    image.drawWidth = image.imageWidth * ratio
    image.drawHeight = image.imageHeight * ratio
    image.hAlign = {"center": "CENTER", "right": "RIGHT"}.get(str(alignment), "LEFT")
    return image


def safe_color(value: Any, fallback: str):
    text = str(value or fallback)
    return colors.HexColor(text if re.fullmatch(r"#[0-9a-fA-F]{6}", text) else fallback)


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", normalize_pdf_text(value))).strip()


def normalize_pdf_text(value: Any) -> str:
    """Mantem acentos e troca apenas glifos que as fontes PDF base nao renderizam."""

    text = unicodedata.normalize("NFC", str(value or ""))
    replacements = {
        "\u00a0": " ",
        "\u2007": " ",
        "\u202f": " ",
        "\u2010": "-",
        "\u2011": "-",
        "\u2012": "-",
        "\u2013": "-",
        "\u2014": "-",
        "\u2212": "-",
        "\u2022": "-",
        "\u25aa": "-",
        "\ufeff": "",
    }
    return "".join(replacements.get(character, character) for character in text if character in "\n\t" or ord(character) >= 32)


def escape_reportlab(value: str) -> str:
    return normalize_pdf_text(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def slugify(value: str) -> str:
    text = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip()).strip("-").lower()
    return text[:80] or "documento"


def format_date(value: Any) -> str:
    text = str(value or "")
    if not text:
        return "data não informada"
    date_part = text[:10].split("T")[0]
    match = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", date_part)
    return f"{match.group(3)}/{match.group(2)}/{match.group(1)}" if match else normalize_pdf_text(date_part)
