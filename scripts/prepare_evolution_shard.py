"""Prepara segredos próprios no servidor, sem imprimir ou alterar o Norium.

Executar no diretório da instalação Evolution. Nunca sobrescreve arquivos.
Revisar a auditoria da imagem e a capacidade da VPS antes de iniciar serviços.
"""
from __future__ import annotations

import os
import base64
from pathlib import Path
import secrets


def main() -> None:
    target = Path.cwd()
    paths = (target / ".env", target / "norium-evolution.env")
    if any(path.exists() or path.is_symlink() for path in paths):
        raise SystemExit("Configuração já existe; nenhum segredo foi alterado.")
    if os.name != "posix":
        raise SystemExit("Execute no servidor Linux para aplicar permissões privadas.")
    import shutil
    if shutil.disk_usage(target).free < 6 * 1024**3:
        raise SystemExit("São necessários pelo menos 6 GiB livres antes de preparar a instalação.")
    values = {
        "EVOLUTION_DATABASE_PASSWORD": secrets.token_urlsafe(32),
        "EVOLUTION_API_KEY": secrets.token_urlsafe(32),
        "EVOLUTION_CREDENTIAL_ENCRYPTION_KEY": base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii"),
        "WAPI_WEBHOOK_SECRET": secrets.token_urlsafe(32),
    }
    provider = {
        "WHATSAPP_PROVIDER": "evolution",
        "EVOLUTION_CONNECTIONS_ENABLED": "0",
        "EVOLUTION_BASE_URL": "http://evolution-api:8080",
        "EVOLUTION_PRIVATE_NETWORK_ENABLED": "1",
        "EVOLUTION_WEBHOOK_URL": "http://norium-api:8000/api/whatsapp/webhook",
        **{key: value for key, value in values.items() if key != "EVOLUTION_DATABASE_PASSWORD"},
    }
    for path, settings in zip(paths, (values, provider), strict=True):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write("".join(f"{key}={value}\n" for key, value in settings.items()))
    print("Arquivos privados preparados; nenhum serviço foi iniciado nem alterado.")


if __name__ == "__main__":
    main()
