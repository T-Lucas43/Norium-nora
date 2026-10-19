"""Seleção de provedor exclusivamente pelo operador, congelada no processo."""
from __future__ import annotations

import os
from dotenv import load_dotenv

load_dotenv()
PROVIDER = os.getenv("WHATSAPP_PROVIDER", "wapi").strip().lower()
if PROVIDER not in {"wapi", "evolution"}:
    raise RuntimeError("WHATSAPP_PROVIDER inválido; use wapi ou evolution.")


def is_evolution() -> bool:
    return PROVIDER == "evolution"


def store_name(legacy: str) -> str:
    return "evolution_" + legacy if is_evolution() else legacy


def create_whatsapp_client():
    # Imports tardios evitam ciclos com os serviços legados.
    if is_evolution():
        from app.services.evolution_client import EvolutionClient
        return EvolutionClient()
    from app.services.wapi_client import WapiClient
    return WapiClient()
