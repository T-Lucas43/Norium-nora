"""Fachada mantida para não quebrar imports legados durante a refatoração."""

from app.core.settings import Settings, settings

__all__ = ["Settings", "settings"]
