"""Cheap Gmail history polling without bodies or an open browser tab.

Opt-in worker, one serialized account at a time. historyId is checkpointed only
when all pages finish. Gmail 404 resets with a bounded ID-only baseline.
"""
from __future__ import annotations
import asyncio
import logging
import os
import time
from app.core.request_context import set_request_context, reset_request_context
from app.core.tenant import get_system_db_path, read_json_file

logger = logging.getLogger(__name__)


def read(service, request, units=2):
    # The shared budget arrives in the deployed Gmail hotfix. Failing closed
    # avoids a second worker bypassing that account-level read budget.
    from app.services.gmail_read_limits import reserve_read, raise_if_throttled
    reserve_read(service.user_id, units, background=True)
    try:
        return request.execute()
    except Exception as error:
        raise_if_throttled(service.user_id, error)
        raise


def poll(service):
    state = service._read_profile_section("gmailIncrementalSync", {})
    state = dict(state) if isinstance(state, dict) else {}
    api = service._service().users()
    history_id = str(state.get("historyId") or "")
    changes, complete, next_token = {}, True, state.get("pageToken")
    try:
        if not history_id:
            # Fetch the checkpoint before the listing, so any concurrent change
            # is replayed by the next history poll rather than silently skipped.
            profile = read(service, api.getProfile(userId="me"), 1)
            listing = read(service, api.messages().list(userId="me", maxResults=100), 5)
            ids = [str(r["id"]) for r in listing.get("messages", []) if r.get("id")]
            state.update(historyId=str(profile["historyId"]), knownIds=ids, fullCoverage=False,
                         baselineCount=len(ids), pageToken=None)
            changed = len(ids)
        else:
            checkpoint = history_id
            # One page per poll bounds work and avoids tight pagination loops.
            params = {"userId":"me","startHistoryId":history_id,"maxResults":100}
            if next_token:
                params["pageToken"] = next_token
            result = read(service, api.history().list(**params), 2)
            for item in result.get("history", []):
                for kind in ("messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"):
                    for row in item.get(kind, []):
                        message = row.get("message") or {}
                        if message.get("id"):
                            changes[str(message["id"])] = kind
            next_token = result.get("nextPageToken")
            state["pageToken"] = next_token
            # Cached IDs are a bounded inventory, never advertised as all mail.
            known = list(state.get("knownIds") or [])
            for identifier, kind in changes.items():
                known = [v for v in known if v != identifier]
                if kind != "messagesDeleted":
                    known.append(identifier)
            state["knownIds"] = known[-500:]
            if not next_token:
                state["historyId"] = str(result.get("historyId") or checkpoint)
            changed = len(changes)
            complete = not bool(next_token)
    except Exception as exc:
        code = getattr(getattr(exc, "resp", None), "status", None)
        if code == 404:
            # Expired history cursor: reset metadata baseline, never hydrate bodies.
            service._write_profile_section("gmailIncrementalSync", {"historyId":"", "knownIds":[], "fullCoverage":False})
            return {"changed":0,"complete":False,"reset":True,"interval":180}
        raise
    if changed:
        service._clear_mailbox_cache()
        service._mark_sync()
    previous = max(180, min(900, int(state.get("interval") or 180)))
    interval = 180 if changed or not complete else min(900, previous * 2)
    state.update(lastPoll=time.time(), interval=interval, nextPoll=time.time()+interval,
                 lastChanged=changed, status="current" if complete else "catching_up")
    service._write_profile_section("gmailIncrementalSync", state)
    return {"changed":changed,"complete":complete,"interval":interval}


async def worker():
    if os.getenv("NORIUM_GMAIL_INCREMENTAL_ENABLED") != "1":
        return
    from app.services.gmail_service import GmailService
    from app.modules.auth.router import effective_permissions
    while True:
        store = await asyncio.to_thread(read_json_file, get_system_db_path("usuarios"), {})
        users = store.get("users", []) if isinstance(store, dict) else []
        for user in users:
            permissions = effective_permissions(user)
            if user.get("status") != "ativo" or not permissions.get("emails") or not permissions.get("integracao_gmail"):
                continue
            context = set_request_context("gmail-background", "primary")
            service = None
            try:
                service = GmailService(user["id"])
                if not service.connection_snapshot().get("connected"):
                    continue
                state = service._read_profile_section("gmailIncrementalSync", {})
                if float((state or {}).get("nextPoll") or 0) > time.time():
                    continue
                result = await asyncio.to_thread(poll, service)
                if result["changed"]:
                    from app.modules.inbox.router import manager
                    await manager.broadcast(user["id"], {"type":"GMAIL_CHANGED", "count":result["changed"]})
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("gmail_background_poll_deferred")
                # A provider outage/quota pause backs off, with no body/log payload.
                if service is not None:
                    try:
                        state = service._read_profile_section("gmailIncrementalSync", {})
                        service._write_profile_section("gmailIncrementalSync", {**(state if isinstance(state,dict) else {}),
                            "nextPoll":time.time()+900,"interval":900,"status":"deferred"})
                    except Exception:
                        logger.warning("gmail_background_checkpoint_deferred")
            finally:
                reset_request_context(context)
            await asyncio.sleep(2)
        await asyncio.sleep(30)
