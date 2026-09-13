"""Live Chromium compositor frames. Nothing is recorded on disk."""
from __future__ import annotations

import asyncio
import base64
from contextlib import suppress
from dataclasses import dataclass, field

from playwright.async_api import Page

from app.core.request_context import current_workspace_id


def live_key(user_id: str, run_id: str) -> str:
    return f"{current_workspace_id()}:{user_id}:{run_id}"


@dataclass
class LiveFeed:
    frame: bytes | None = None
    viewers: set[asyncio.Queue[bytes | None]] = field(default_factory=set)
    display_page: Page | None = None

    def publish(self, frame: bytes | None) -> None:
        self.frame = frame
        for queue in self.viewers:
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(frame)


FEEDS: dict[str, LiveFeed] = {}


async def start_live(page: Page, key: str, existing_feed: LiveFeed | None = None):
    session = await page.context.new_cdp_session(page)
    feed = existing_feed or LiveFeed()
    feed.display_page = page
    FEEDS[key] = feed

    async def frame_received(event: dict) -> None:
        try:
            if feed.display_page is page:
                feed.publish(base64.b64decode(event["data"]))
            await session.send("Page.screencastFrameAck", {"sessionId": event["sessionId"]})
        except Exception:
            # The page can close while a compositor event is in flight.
            if not existing_feed:
                feed.publish(None)

    session.on("Page.screencastFrame", frame_received)
    try:
        await session.send("Page.startScreencast", {"format": "jpeg", "quality": 75, "maxWidth": 1440, "maxHeight": 900, "everyNthFrame": 2})
    except Exception:
        if not existing_feed:
            FEEDS.pop(key, None)
        await session.detach()
        raise

    async def stop() -> None:
        if not existing_feed:
            FEEDS.pop(key, None)
            feed.publish(None)
        session.remove_listener("Page.screencastFrame", frame_received)
        with suppress(Exception):
            await session.send("Page.stopScreencast")
            await session.detach()

    return stop
