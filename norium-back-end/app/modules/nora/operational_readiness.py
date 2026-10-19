"""Read-only operator diagnostics; never return credentials or enable providers."""
from __future__ import annotations

import asyncio
import os
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Response

from app.core.identity import require_user_id
from app.modules.auth.router import can_manage_system, current_user

router = APIRouter(prefix="/api/nora/operations", tags=["Operação da Nora"])


def enabled(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip() == "1"


def configuration_snapshot() -> list[dict]:
    brain_db = os.getenv("NORA_BRAIN_DATABASE_URL", "").strip()
    try:
        postgres_configured = urlsplit(brain_db).scheme in {"postgresql", "postgres"}
    except ValueError:
        postgres_configured = False
    brain_checks = {
        "Banco PostgreSQL dedicado": postgres_configured,
        "Credencial da ponte interna": len(os.getenv("NORA_BRAIN_INTERNAL_SECRET", "").strip()) >= 32,
        "Endereço da ponte interna": bool(os.getenv("NORA_BRAIN_INTERNAL_URL", "").strip()),
        "Escritor único": enabled("NORA_LEGACY_WRITER_SINGLETON"),
    }
    specifications = [
        ("brain", "Cérebro durável", enabled("NORA_BRAIN_ENABLED"), brain_checks,
         "A credencial do modelo pertence ao executor separado. A configuração do web não comprova executor ativo; valide uma consulta antes de liberar ações."),
        ("gmail", "Gmail sem a tela aberta", enabled("NORIUM_GMAIL_INCREMENTAL_ENABLED"), {},
         "Sincronização de metadados em páginas; os corpos dos e-mails não são carregados pelo worker."),
        ("embeddings", "Conhecimento por significado", enabled("NORA_KNOWLEDGE_EMBEDDINGS_ENABLED"),
         {"Credencial OpenAI": bool(os.getenv("OPENAI_API_KEY", "").strip()),
          "Persistência PostgreSQL": bool(os.getenv("NORIUM_DATABASE_URL", "").strip())},
         "Textos são minimizados antes do provedor. A busca textual continua disponível."),
        ("brave", "Pesquisa na web", enabled("NORIUM_BRAVE_ENABLED", "1") and bool(os.getenv("BRAVE_SEARCH_API_KEY", "").strip()),
         {"Credencial Brave": bool(os.getenv("BRAVE_SEARCH_API_KEY", "").strip())},
         "A pesquisa acontece somente quando solicitada e registra o consumo da pessoa."),
    ]
    return [{"id": key, "name": name, "enabled": active,
             "configurationReady": all(checks.values()),
             "checks": [{"label": label, "ready": ready} for label, ready in checks.items()],
             "note": note} for key, name, active, checks, note in specifications]


@router.get("/readiness")
async def readiness(response: Response, user: dict = Depends(current_user)):
    if not can_manage_system(user):
        raise HTTPException(403, "Somente administradores podem consultar a operação da Nora.")
    require_user_id(user)
    response.headers["Cache-Control"] = "no-store"
    features = await asyncio.to_thread(configuration_snapshot)
    # No probe contacts an external provider, executes a job or changes a flag.
    return {"features": features, "readOnly": True,
            "message": "Credenciais são configuradas no servidor. Esta consulta não ativa serviços."}
