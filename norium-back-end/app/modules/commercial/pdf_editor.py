"""Validated visual PDF edits shared by PDF Studio and commercial exports."""
from __future__ import annotations

import base64
import io
from typing import Literal

from PIL import Image as PILImage
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pypdf import PdfReader, PdfWriter, Transformation
from reportlab.lib.colors import HexColor
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas


class Point(BaseModel):
    x: float = Field(ge=0, le=1, allow_inf_nan=False)
    y: float = Field(ge=0, le=1, allow_inf_nan=False)


class PdfLayer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=100)
    type: Literal["text", "image", "signature", "rectangle", "ellipse", "highlight", "draw", "cover"]
    page: int = Field(ge=0, le=1999)
    x: float = Field(ge=0, le=1, allow_inf_nan=False)
    y: float = Field(ge=0, le=1, allow_inf_nan=False)
    width: float = Field(gt=0, le=1, allow_inf_nan=False)
    height: float = Field(gt=0, le=1, allow_inf_nan=False)
    text: str = Field(default="", max_length=5000)
    color: str = Field(default="#171717", pattern=r"^#[0-9A-Fa-f]{6}$")
    fill: str = Field(default="#ffffff", pattern=r"^#[0-9A-Fa-f]{6}$")
    opacity: float = Field(default=1, ge=0.05, le=1, allow_inf_nan=False)
    fontSize: float = Field(default=18, ge=6, le=144, allow_inf_nan=False)
    fontFamily: Literal["Helvetica", "Times", "Courier"] = "Helvetica"
    bold: bool = False
    italic: bool = False
    strokeWidth: float = Field(default=2, ge=0.5, le=30, allow_inf_nan=False)
    dataUrl: str = Field(default="", max_length=1_500_000)
    points: list[Point] = Field(default_factory=list, max_length=2000)

    @model_validator(mode="after")
    def validate_content(self):
        if self.x + self.width > 1.001 or self.y + self.height > 1.001:
            raise ValueError("O elemento deve permanecer dentro da pagina.")
        if self.type in {"image", "signature"}:
            decode_image(self.dataUrl)
        if self.type == "draw" and len(self.points) < 2:
            raise ValueError("O desenho precisa ter ao menos dois pontos.")
        return self


class PdfPageLayout(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: int = Field(ge=0, le=1999)
    rotation: Literal[0, 90, 180, 270] = 0


class PdfEdits(BaseModel):
    model_config = ConfigDict(extra="forbid")
    layers: list[PdfLayer] = Field(default_factory=list, max_length=300)
    pages: list[PdfPageLayout] = Field(default_factory=list, max_length=2000)

    @field_validator("layers")
    @classmethod
    def total_image_size(cls, value):
        if sum(len(layer.dataUrl) for layer in value) > 8_000_000:
            raise ValueError("As imagens do editor excedem 8 MB.")
        if len({layer.id for layer in value}) != len(value):
            raise ValueError("Elementos duplicados no editor.")
        return value

    @field_validator("pages")
    @classmethod
    def unique_pages(cls, value):
        if len({page.source for page in value}) != len(value):
            raise ValueError("Uma pagina nao pode ser repetida.")
        return value


def decode_image(data_url: str) -> bytes:
    if not data_url.startswith(("data:image/png;base64,", "data:image/jpeg;base64,")):
        raise ValueError("Selecione uma imagem PNG ou JPEG valida.")
    try:
        raw = base64.b64decode(data_url.split(",", 1)[1], validate=True)
        with PILImage.open(io.BytesIO(raw)) as image:
            if image.width * image.height > 16_000_000 or image.format not in {"PNG", "JPEG"}:
                raise ValueError("Imagem muito grande ou invalida.")
            image.verify()
        return raw
    except Exception as exc:
        raise ValueError("A imagem da assinatura ou do editor e invalida.") from exc


def draw_layer(pdf: canvas.Canvas, layer: PdfLayer, width: float, height: float) -> None:
    x, top, w, h = layer.x * width, layer.y * height, layer.width * width, layer.height * height
    y = height - top - h
    pdf.saveState()
    pdf.setFillColor(HexColor(layer.color))
    pdf.setStrokeColor(HexColor(layer.color))
    pdf.setFillAlpha(layer.opacity)
    pdf.setStrokeAlpha(layer.opacity)
    pdf.setLineWidth(layer.strokeWidth)
    if layer.type in {"image", "signature"}:
        pdf.drawImage(ImageReader(io.BytesIO(decode_image(layer.dataUrl))), x, y, w, h, mask="auto")
    elif layer.type == "text":
        clip = pdf.beginPath()
        clip.rect(x, y, w, h)
        pdf.clipPath(clip, stroke=0, fill=0)
        family = layer.fontFamily
        if family == "Times":
            font = "Times-BoldItalic" if layer.bold and layer.italic else "Times-Bold" if layer.bold else "Times-Italic" if layer.italic else "Times-Roman"
        else:
            font = family + ("-BoldOblique" if layer.bold and layer.italic else "-Bold" if layer.bold else "-Oblique" if layer.italic else "")
        pdf.setFont(font, layer.fontSize)
        for index, line in enumerate(layer.text.split("\n")):
            baseline = height - top - layer.fontSize * (0.85 + index * 1.2)
            if baseline < y:
                break
            pdf.drawString(x, baseline, line)
    elif layer.type == "ellipse":
        pdf.ellipse(x, y, x + w, y + h, stroke=1, fill=0)
    elif layer.type in {"highlight", "cover"}:
        pdf.setFillColor(HexColor(layer.color if layer.type == "highlight" else layer.fill))
        pdf.setFillAlpha(layer.opacity)
        pdf.rect(x, y, w, h, stroke=0, fill=1)
    elif layer.type == "rectangle":
        pdf.rect(x, y, w, h, stroke=1, fill=0)
    elif layer.type == "draw":
        path = pdf.beginPath()
        for index, point in enumerate(layer.points):
            px, py = x + point.x * w, height - top - point.y * h
            (path.moveTo if index == 0 else path.lineTo)(px, py)
        pdf.setLineCap(1)
        pdf.setLineJoin(1)
        pdf.drawPath(path)
    pdf.restoreState()


def apply_pdf_edits(content: bytes, edits: dict | PdfEdits) -> bytes:
    edits = edits if isinstance(edits, PdfEdits) else PdfEdits.model_validate(edits)
    reader = PdfReader(io.BytesIO(content))
    if reader.is_encrypted:
        raise ValueError("Desbloqueie o PDF antes de edita-lo.")
    total = len(reader.pages)
    if any(layer.page >= total for layer in edits.layers) or any(page.source >= total for page in edits.pages):
        raise ValueError("Uma das paginas editadas nao existe no documento.")
    layout = edits.pages or [PdfPageLayout(source=index) for index in range(total)]
    writer = PdfWriter()
    # append() copies the AcroForm tree together with retained page widgets.
    writer.append(reader, pages=[item.source for item in layout], import_outline=False)
    for output_index, item in enumerate(layout):
        page = writer.pages[output_index]
        if item.rotation:
            page.rotate(item.rotation)
        crop = page.cropbox
        cx, cy = float(crop.left), float(crop.bottom)
        source_width, source_height = float(crop.width), float(crop.height)
        rotation = page.rotation % 360
        width, height = (source_height, source_width) if rotation in {90, 270} else (source_width, source_height)
        # Map display-space edits back into the original page. Keeping page
        # geometry intact also keeps existing form widgets in their locations.
        transforms = {
            0: (1, 0, 0, 1, cx, cy),
            90: (0, 1, -1, 0, cx + source_width, cy),
            180: (-1, 0, 0, -1, cx + source_width, cy + source_height),
            270: (0, -1, 1, 0, cx, cy + source_height),
        }
        layers = [layer for layer in edits.layers if layer.page == item.source]
        if layers:
            overlay = io.BytesIO()
            pdf = canvas.Canvas(overlay, pagesize=(width, height))
            for layer in layers:
                draw_layer(pdf, layer, width, height)
            pdf.save()
            page.merge_transformed_page(PdfReader(io.BytesIO(overlay.getvalue())).pages[0], Transformation(transforms[rotation]))
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()
