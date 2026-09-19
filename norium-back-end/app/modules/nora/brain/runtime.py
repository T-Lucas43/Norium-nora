"""Composition root shared by the authenticated API and the standalone worker."""
from __future__ import annotations

from functools import lru_cache

from .engine import Engine
from .planner import Planner
from .repository import configured_repository
from .tools import registry


@lru_cache(maxsize=1)
def repository():
    instance = configured_repository()
    instance.initialize()
    # Every process reapplies active-store retention before jobs become visible.
    # This also prevents an old backup from exposing expired job context first.
    instance.cleanup()
    return instance


@lru_cache(maxsize=1)
def engine():
    instance = repository()
    return Engine(instance, registry(instance), Planner())


def clear_runtime_cache():
    engine.cache_clear()
    repository.cache_clear()
