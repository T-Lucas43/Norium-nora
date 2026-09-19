"""Standalone durable executor: python -m app.modules.nora.brain.worker."""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import time

from .contracts import BrainError
from .runtime import engine, repository


logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("nora.brain.worker")


async def run():
    if os.getenv("NORA_BRAIN_EXECUTOR_ENABLED") != "1":
        raise RuntimeError("NORA_BRAIN_EXECUTOR_ENABLED=1 is required")
    repo, executor = repository(), engine()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for name in ("SIGTERM", "SIGINT"):
        if hasattr(signal, name):
            try:
                loop.add_signal_handler(getattr(signal, name), stop.set)
            except NotImplementedError:
                pass
    last_cleanup = 0.0
    logger.info("Nora executor ready")
    while not stop.is_set():
        try:
            worked = await executor.tick()
            if time.monotonic() - last_cleanup >= 3600:
                repo.cleanup()
                last_cleanup = time.monotonic()
            if not worked:
                try:
                    await asyncio.wait_for(stop.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    pass
        except BrainError as error:
            logger.error("Executor paused: %s", error.code)
            await asyncio.sleep(5)
        except Exception:
            logger.exception("Executor failure without job payload")
            await asyncio.sleep(5)


if __name__ == "__main__":
    asyncio.run(run())
