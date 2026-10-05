"""Exercise native runtime dependencies with synthetic data and no providers."""
from __future__ import annotations

import ast
import io
import json
import logging
import math
from pathlib import Path
import shutil
import struct
import subprocess
import wave


def synthetic_wav() -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(48_000)
        stream.writeframes(b"".join(struct.pack("<h", round(8_000 * math.sin(2 * math.pi * 440 * i / 48_000)))
                                  for i in range(12_000)))
    return output.getvalue()


def require_opus_probe(probe: dict) -> None:
    streams = probe.get("streams", [])
    if (len(streams) != 1 or streams[0].get("codec_name") != "opus"
            or streams[0].get("sample_rate") != "48000" or streams[0].get("channels") != 1):
        raise RuntimeError("Synthetic audio did not retain the required Opus format")


def audio_smoke() -> None:
    # Compile only the existing pure conversion function. Importing the chat
    # router would initialize stores and provider adapters; this smoke uses no
    # account, application data or credentials.
    source = Path(__file__).parents[1] / "modules/chat/router.py"
    functions = [node for node in ast.parse(source.read_text(encoding="utf-8")).body
                 if isinstance(node, ast.FunctionDef) and node.name == "transcode_audio_to_ogg"]
    if len(functions) != 1:
        raise RuntimeError("The application audio conversion function was not found")
    namespace = {"shutil": shutil, "subprocess": subprocess, "logger": logging.getLogger(__name__)}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), "exec"), namespace)  # nosec B102
    # A browser records WebM/Opus. Generate that input before exercising the
    # exact application conversion to Ogg/Opus.
    webm = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
                           "-vn", "-c:a", "libopus", "-f", "webm", "pipe:1"],
                          input=synthetic_wav(), capture_output=True, check=True, timeout=15).stdout
    ogg = namespace["transcode_audio_to_ogg"](webm)
    if not ogg or not ogg.startswith(b"OggS"):
        raise RuntimeError("Application WebM to Ogg conversion failed")
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", "pipe:0"],
                           input=ogg, capture_output=True, check=True, timeout=15)
    require_opus_probe(json.loads(probe.stdout))
    decoded = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
                              "-f", "s16le", "-ar", "48000", "-ac", "1", "pipe:1"],
                             input=ogg, capture_output=True, check=True, timeout=15).stdout
    if not 23_000 <= len(decoded) <= 25_000 or not any(decoded):
        raise RuntimeError("Synthetic audio roundtrip lost its content or duration")
    print("runtime_audio_passed: application WebM/Opus to Ogg/Opus; probe and PCM roundtrip")


def library_smoke() -> None:
    from cryptography.fernet import Fernet
    from PIL import Image
    import psycopg
    import psycopg_pool
    from pypdf import PdfReader, PdfWriter
    from reportlab.pdfgen.canvas import Canvas
    from app.core.credentials import CredentialRecoveryError, FernetCredentialStore
    from app.core.security import hash_password, verify_password

    if not psycopg.__version__ or not psycopg_pool.__version__:
        raise RuntimeError("PostgreSQL client import failed")
    password = "synthetic-runtime-only"
    hashed = hash_password(password)
    if not hashed.startswith("pbkdf2_sha256_v2$600000$") or not verify_password(password, hashed):
        raise RuntimeError("Runtime password primitive failed")
    if verify_password(password + "-wrong", hashed):
        raise RuntimeError("Runtime password primitive accepted an invalid password")
    store = FernetCredentialStore(Fernet.generate_key().decode("ascii"))
    envelope = store.store("synthetic-runtime-value")
    if store.retrieve(envelope).value != "synthetic-runtime-value":
        raise RuntimeError("Runtime credential primitive failed")
    different = FernetCredentialStore(Fernet.generate_key().decode("ascii"))
    try:
        different.retrieve(envelope)
    except CredentialRecoveryError:
        pass
    else:
        raise RuntimeError("Runtime credential primitive accepted an invalid key")
    png = io.BytesIO()
    Image.new("RGB", (2, 2), "blue").save(png, format="PNG")
    png.seek(0)
    with Image.open(png) as image:
        image.load()
        if image.size != (2, 2):
            raise RuntimeError("Runtime image roundtrip failed")
    pdf = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.write(pdf)
    pdf.seek(0)
    if len(PdfReader(pdf).pages) != 1:
        raise RuntimeError("Runtime PDF roundtrip failed")
    rendered_pdf = io.BytesIO()
    canvas = Canvas(rendered_pdf)
    canvas.drawString(10, 10, "Synthetic runtime check")
    canvas.save()
    if not rendered_pdf.getvalue().startswith(b"%PDF-"):
        raise RuntimeError("Runtime PDF rendering failed")
    print("runtime_libraries_passed: password/credential primitives; PostgreSQL client; PNG and PDF")


if __name__ == "__main__":
    library_smoke()
    audio_smoke()
