"""Persistência local segura e compatível com os bancos JSON existentes."""

from app.infrastructure.persistence.json_repository import read_json, write_json

__all__ = ["read_json", "write_json"]
