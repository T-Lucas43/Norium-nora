"""TEST ONLY: three dedicated primary profiles, synthetic fixtures and private checkpoints.

No remote execution is implicit. DELETE is disabled independently of CLI flags.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import types

BASE_HASH = "266ac3fa766ef58184759409301d21dad1d9e431bef9b526288e18b08527d7d9"
BASE_PATH = Path("/srv/norium/private/vps_authenticated_smoke_9176971.py")
if os.name == "nt":
    BASE_PATH = Path("C:/NOrium/.tmp-tests/privacy-live-vps-2026-10-09-163745/vps_authenticated_smoke_9176971.py")
base_source = BASE_PATH.read_bytes()
if hashlib.sha256(base_source).hexdigest() != BASE_HASH:
    raise SystemExit("Reviewed auth loader changed; no fixture operation performed")
base = types.ModuleType("reviewed_auth_helper")
exec(compile(base_source, str(BASE_PATH), "exec"), base.__dict__)

SHARED_BODY = r'''
import signal


import urllib.request


import logging


import warnings


RUNTIME_REVISION = "637106e347a0621bb2ad8548382e1a3cf3f57dee"


logging.disable(sys.maxsize)


warnings.filterwarnings("ignore")


class CapacitySession(base.Session):
    def request(self, path, payload=None):
        if path not in {"/api/auth/plans", "/api/auth/users", "/api/auth/team-profile"}:
            return super().request(path, payload)
        base.require(payload is None and bool(self.token), "ProtocolInvalid")
        request = urllib.request.Request(base.ORIGIN + path, method="GET", headers={
            "Authorization": "Bearer " + self.token, "Origin": base.ORIGIN,
            "Cache-Control": "no-store", "Accept": "application/json",
        })
        with self.opener.open(request, timeout=8) as response:
            base.require(response.status == 200 and response.geturl() == base.ORIGIN + path, "TransportError")
            raw = response.read(262145)
            base.require(len(raw) <= 262144, "ProtocolInvalid")
            return json.loads(raw)


def revision_guard(session):
    release = session.request("/api/system/release")
    base.require(release.get("revision") == RUNTIME_REVISION and release.get("environment") == "homologacao", "RevisionMismatch")


def relevant_automations(payloads):
    blocked = 0
    for value in payloads:
        base.require(isinstance(value, dict) and isinstance(value.get("automations", []), list), "AutomationBlocked")
        for item in value.get("automations", []):
            base.require(isinstance(item, dict), "AutomationBlocked")
            flow = item.get("flow") or {}
            base.require(isinstance(flow, dict), "AutomationBlocked")
            nodes = flow.get("nodes") or []
            base.require(isinstance(nodes, list) and all(isinstance(node, dict) for node in nodes), "AutomationBlocked")
            configs = [node.get("config") or {} for node in nodes if node.get("kind") == "trigger"]
            base.require(all(isinstance(config, dict) for config in configs), "AutomationBlocked")
            blocked += bool(item.get("active") and any(config.get("automatic") == "true" and config.get("eventType") in
                {"task.created", "task.updated", "task.comment", "team.message", "team.mentioned"} for config in configs))
    return blocked


@base.contextlib.contextmanager
def readonly_database():
    from app.infrastructure.persistence import postgres_store as pg
    base.require(pg.configured() and pg.required() and not pg._initialized and
                 os.getenv("NORIUM_DATABASE_SSLMODE", "verify-full").strip().lower() in {"verify-full", "verify-ca"}, "AutomationBlocked")
    with pg.connection() as db:
        try:
            db.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            db.execute("SET LOCAL statement_timeout='3s'")
            db.execute("SET LOCAL lock_timeout='1s'")
            db.execute("SET LOCAL idle_in_transaction_session_timeout='8s'")
            row = db.execute("SELECT current_setting('transaction_read_only')='on' AS ro, current_setting('transaction_isolation')='repeatable read' AS stable, (SELECT version FROM norium_schema WHERE component='core')=1 AS schema").fetchone()
            base.require(bool(db.pgconn.ssl_in_use) and all(row.get(key) is True for key in ("ro", "stable", "schema")), "AutomationBlocked")
            yield db
        finally:
            db.rollback()


def directory_guard():
    with readonly_database() as db:
        row = db.execute("SELECT jsonb_typeof(payload)='object' AND jsonb_typeof(payload->'users')='array' AND jsonb_array_length(payload->'users')>0 AND jsonb_typeof(payload->'teams')='array' AND jsonb_array_length(payload->'teams')>0 AS safe FROM norium_documents WHERE store_key='usuarios_db.json'").fetchone()
        base.require(row is not None and row.get("safe") is True, "FixtureMismatch")

'''
exec(compile(SHARED_BODY, "reviewed_readonly_helpers", "exec"), globals())

BODY = r'''
import contextlib
import logging
import signal
import time
import urllib.error
from urllib.parse import quote, urlencode, urlsplit
logging.disable(sys.maxsize)
RUNTIME_REVISION = "637106e347a0621bb2ad8548382e1a3cf3f57dee"
MARKER = "PRV20261013_PRIMARY_637106E"
DELETE_ENABLED = False
ROLES = ("P", "A", "N")
N_NAME = "Codex-Priv-Sem-Acesso"
PROJECTS = {"p1": {"role": "P", "name": MARKER + "_P1", "shared": ["A"]},
            "p2": {"role": "A", "name": MARKER + "_P2", "shared": []}}
TASKS = {"t1": {"role": "P", "project": "p1", "title": MARKER + "_T1"},
         "t2": {"role": "P", "project": "p1", "title": MARKER + "_T2"},
         "t3": {"role": "A", "project": "p2", "title": MARKER + "_T3"}}
BOOLS = ("ok", "revisionMatched", "directoryCheckedBeforeLogin", "threeNormalLoginsMatched",
         "primaryTeamExactlyThree", "automationSafetyChecked", "noRelevantAutomaticActions",
         "historyCapacityChecked", "markerUnused", "fixturesPrepared", "initialAclVerified",
         "updateChannelsVerified", "deniedAssignmentVerified", "deniedUpdateVerified",
         "revocationVerified", "restorationVerified", "memberPrivateProjectVerified",
         "historyPreviewInboxVerified", "websocketReconnectVerified", "deleteEnabled",
         "deletionsPerformed", "fourProfilePrivacyAccepted", "postOutcomeUnknown", "patchOutcomeUnknown",
         "operationOutcomeUnknown", "completeChildReportReceived", "countsAreLowerBounds")
COUNTS = ("authenticatedAccounts", "projectsCreated", "tasksCreated", "postAttempts",
          "patchAttempts", "expectedDenials", "websocketConnections", "markerEventsObserved",
          "unauthorizedMarkerEvents", "checkpoints", "existingTeamMessages")
ERRORS = base.ERRORS | {"AutomationBlocked", "FixtureMismatch", "LedgerExists", "LedgerBusy",
    "LedgerNeedsReconciliation", "CheckpointFailed", "PrivacyViolation", "DeleteApprovalRequired"}

def summary():
    return {**dict.fromkeys(BOOLS, False), **dict.fromkeys(COUNTS, 0), "countsAreLowerBounds": True, "errorClass": "None"}

def safe_summary(value):
    base.require(isinstance(value, dict) and set(value) == set(summary()) and
        all(type(value[key]) is bool for key in BOOLS) and
        all(type(value[key]) is int and 0 <= value[key] <= 10000 for key in COUNTS)
        and value["errorClass"] in ERRORS and not value["fourProfilePrivacyAccepted"], "ProtocolInvalid")
    base.require(not value["deleteEnabled"] and not value["deletionsPerformed"], "ProtocolInvalid")
    return value

def valid_id(value, kind):
    return isinstance(value, str) and bool(re.fullmatch({"project": r"workspace_[0-9a-f]{12}",
        "task": r"task_[0-9a-f]{32}", "user": r"[A-Za-z0-9_.-]{1,160}"}[kind], value))

def new_ledger():
    return {"revision": RUNTIME_REVISION, "marker": MARKER, "sequence": 0, "phase": "planned",
        "userIds": {}, "projects": {key: {"id": "", **value} for key, value in PROJECTS.items()},
        "tasks": {key: {"id": "", **value} for key, value in TASKS.items()}, "actions": [],
        "humanDeleteApproved": False}

def ledger_guard(ledger, *, ready=False):
    base.require(isinstance(ledger, dict) and set(ledger) == set(new_ledger()) and
        ledger["revision"] == RUNTIME_REVISION and ledger["marker"] == MARKER and
        type(ledger["sequence"]) is int and 0 <= ledger["sequence"] <= 500 and
        ledger["humanDeleteApproved"] is False and isinstance(ledger["actions"], list)
        and len(ledger["actions"]) <= 100, "FixtureMismatch")
    base.require(set(ledger["projects"]) == set(PROJECTS) and set(ledger["tasks"]) == set(TASKS), "FixtureMismatch")
    for key, planned in PROJECTS.items():
        row = ledger["projects"][key]
        base.require(set(row) == {"id", *planned} and all(row[field] == value for field, value in planned.items())
            and (row["id"] == "" or valid_id(row["id"], "project")), "FixtureMismatch")
    for key, planned in TASKS.items():
        row = ledger["tasks"][key]
        base.require(set(row) == {"id", *planned} and all(row[field] == value for field, value in planned.items())
            and (row["id"] == "" or valid_id(row["id"], "task")), "FixtureMismatch")
    base.require(isinstance(ledger["userIds"], dict) and (not ledger["userIds"] or
        set(ledger["userIds"]) == set(ROLES) and all(valid_id(uid, "user") for uid in ledger["userIds"].values())), "FixtureMismatch")
    for action in ledger["actions"]:
        base.require(isinstance(action, dict) and set(action) == {"key", "state", "http", "startedEpoch", "endedEpoch"}
            and isinstance(action["key"], str) and re.fullmatch(r"[a-z0-9_-]{1,80}", action["key"])
            and action["state"] in {"pending", "verified"} and type(action["http"]) is int
            and 0 <= action["http"] <= 599 and all(type(action[field]) in {int, float} and 0 <= action[field] <= 4102444800
                for field in ("startedEpoch", "endedEpoch")), "FixtureMismatch")
    if ready:
        creation = [action for action in ledger["actions"] if action["key"].startswith("create-")]
        base.require(ledger["phase"] == "fixtures-ready" and set(ledger["userIds"]) == set(ROLES)
            and all(row["id"] for row in [*ledger["projects"].values(), *ledger["tasks"].values()])
            and all(action["state"] == "verified" for action in ledger["actions"])
            and len(creation) == 5 and {action["key"] for action in creation} ==
                {"create-p1", "create-p2", "create-t1", "create-t2", "create-t3"}
            and all(action["http"] == 200 for action in creation), "LedgerNeedsReconciliation")
        base.require(len({row["id"] for row in ledger["projects"].values()}) == 2 and
            len({row["id"] for row in ledger["tasks"].values()}) == 3 and
            len(set(ledger["userIds"].values())) == 3, "FixtureMismatch")

def checkpoint(ledger, report):
    ledger["sequence"] += 1
    ledger_guard(ledger)
    packet = json.dumps({"kind": "checkpoint", "ledger": ledger}, separators=(",", ":")).encode() + b"\n"
    base.require(len(packet) <= 65536, "ProtocolInvalid")
    os.write(CONTROL_FD, packet)
    reply = json.loads(sys.stdin.buffer.readline(513))
    base.require(reply == {"checkpointed": True, "sequence": ledger["sequence"]}, "CheckpointFailed")
    report["checkpoints"] += 1

def begin_action(ledger, report, key):
    base.require(not any(action["key"] == key for action in ledger["actions"]), "LedgerNeedsReconciliation")
    ledger["actions"].append({"key": key, "state": "pending", "http": 0, "startedEpoch": time.time(), "endedEpoch": 0})
    checkpoint(ledger, report)
    return ledger["actions"][-1]

def end_action(ledger, report, action, status):
    action.update({"state": "verified", "http": status, "endedEpoch": time.time()})
    checkpoint(ledger, report)

class PrimarySession(CapacitySession):
    def api(self, method, path, payload=None, expected=200):
        plain = urlsplit(path).path
        allowed = method == "GET" and plain in {"/api/tarefas", "/api/tarefas/projetos", "/api/team-chat/messages",
            "/api/team-chat/threads", "/api/omnichannel/inbox"}
        allowed = allowed or method == "POST" and plain in {"/api/tarefas", "/api/tarefas/projetos"}
        allowed = allowed or method == "PATCH" and bool(re.fullmatch(r"/api/tarefas/(task_[0-9a-f]{32}|projetos/workspace_[0-9a-f]{12})", plain))
        base.require(allowed and bool(self.token) and path.startswith("/api/")
            and (method == "GET") == (payload is None), "ProtocolInvalid")
        request = urllib.request.Request(base.ORIGIN + path, method=method,
            data=None if payload is None else json.dumps(payload).encode(), headers={
            "Authorization": "Bearer " + self.token, "Origin": base.ORIGIN,
            "Content-Type": "application/json", "Cache-Control": "no-store"})
        try:
            response = self.opener.open(request, timeout=10)
        except urllib.error.HTTPError as error:
            base.require(error.code == expected and expected in {400, 404}, "TransportError")
            return expected, None
        with response:
            base.require(response.status == expected and response.geturl() == base.ORIGIN + path, "TransportError")
            raw = response.read(2097153)
            base.require(len(raw) <= 2097152, "ProtocolInvalid")
            return response.status, json.loads(raw)

def authenticate_all(accounts, report):
    directory_guard()
    report["directoryCheckedBeforeLogin"] = True
    sessions, users = {}, {}
    for role, account in zip(ROLES, accounts):
        session = PrimarySession()
        token = session.request("/api/auth/login", {"email": account["identifier"], "password": account["password"], "persistent": False}).get("token")
        base.require(isinstance(token, str) and 20 <= len(token) <= 8192, "ProtocolInvalid")
        session.token = token
        user = session.request("/api/auth/me").get("user")
        base.identity(user, account["expectedName"])
        base.require(user.get("email", "").casefold() == account["identifier"].casefold()
            and user.get("permissions", {}).get("tarefas") is True and user.get("teamChatEnabled") is True
            and (user.get("permissions", {}).get("chat") is True or user.get("permissions", {}).get("equipe") is True), "IdentityMismatch")
        sessions[role], users[role] = session, user
        report["authenticatedAccounts"] += 1
    owner = users["P"]["id"]
    ids = {user["id"] for user in users.values()}
    base.require(len(ids) == 3 and users["P"].get("role") == "owner" and
        (users["P"].get("teamOwnerId") or owner) == owner and users["P"].get("plan") in {"equipe", "enterprise"}
        and users["A"].get("role") in {"owner", "member"} and users["N"].get("role") == "member"
        and all(users[role].get("teamOwnerId") == owner for role in ("A", "N")), "TeamMismatch")
    team = sessions["P"].request("/api/auth/team-profile").get("team")
    rows = sessions["P"].request("/api/auth/users").get("users")
    base.require(isinstance(team, dict) and team.get("id") == owner and team.get("ownerUserId") == owner
        and team.get("memberCount") == 3 and isinstance(rows, list) and len(rows) == 3
        and {row.get("id") for row in rows} == ids and all(row.get("status") == "ativo"
            and row.get("systemAdmin") is False and not row.get("systemAdminRole") for row in rows), "TeamMismatch")
    report["threeNormalLoginsMatched"] = report["primaryTeamExactlyThree"] = True
    with readonly_database() as db:
        auto = db.execute("SELECT payload FROM norium_documents WHERE store_key IN (%s,%s,%s)",
            tuple("user_" + uid + "/automacoes_db.json" for uid in sorted(ids))).fetchall()
        base.require(relevant_automations([row.get("payload") for row in auto]) == 0, "AutomationBlocked")
        retained = db.execute("SELECT jsonb_typeof(payload->'messages')='array' AND jsonb_typeof(payload->'activeCalls')='array' AND jsonb_array_length(payload->'activeCalls')=0 AS safe,jsonb_array_length(payload->'messages') AS count FROM norium_documents WHERE store_key=%s", ("user_" + owner + "/team_chat_db.json",)).fetchone()
        base.require(retained is not None and retained.get("safe") is True and type(retained.get("count")) is int
            and 0 <= retained["count"] <= 1940, "FixtureMismatch")
        report["existingTeamMessages"] = retained["count"]
    report["automationSafetyChecked"] = report["noRelevantAutomaticActions"] = report["historyCapacityChecked"] = True
    return sessions, users

def prepare_fixtures(sessions, users, ledger, report):
    base.require(ledger["phase"] == "planned" and not ledger["actions"] and not ledger["userIds"], "LedgerNeedsReconciliation")
    ids = {role: users[role]["id"] for role in ROLES}
    with readonly_database() as db:
        rows = db.execute("SELECT payload FROM norium_documents WHERE store_key IN (%s,%s,%s)",
            tuple("user_" + uid + "/tarefas_db.json" for uid in ids.values())).fetchall()
        for row in rows:
            payload = row.get("payload")
            base.require(isinstance(payload, dict) and all(isinstance(payload.get(key, []), list) for key in ("projects", "tasks")), "FixtureMismatch")
            base.require(not any(MARKER in str(item.get(field) or "") for key, field in (("projects", "name"), ("tasks", "title"))
                for item in payload.get(key, []) if isinstance(item, dict)), "FixtureMismatch")
    report["markerUnused"] = True
    ledger["userIds"] = ids
    ledger["phase"] = "preparing-fixtures"
    checkpoint(ledger, report)
    for key, plan in PROJECTS.items():
        action = begin_action(ledger, report, "create-" + key)
        report["postAttempts"] += 1
        report["postOutcomeUnknown"] = True
        status, result = sessions[plan["role"]].api("POST", "/api/tarefas/projetos", {
            "name": plan["name"], "description": "Dados exclusivamente sinteticos de privacidade.",
            "owner": plan["role"] + " sintetico", "responsibleUserId": ids[plan["role"]],
            "responsibleName": plan["role"] + " sintetico", "sharedUserIds": [ids[role] for role in plan["shared"]]})
        project = result.get("project")
        base.require(isinstance(project, dict) and valid_id(project.get("id"), "project")
            and project.get("name") == plan["name"] and project.get("ownerUserId") == ids[plan["role"]]
            and set(project.get("sharedUserIds") or []) == {ids[role] for role in plan["shared"]}, "FixtureMismatch")
        ledger["projects"][key]["id"] = project["id"]
        report["projectsCreated"] += 1
        report["postOutcomeUnknown"] = False
        end_action(ledger, report, action, status)
    base.require(len({row["id"] for row in ledger["projects"].values()}) == 2, "FixtureMismatch")
    for key, plan in TASKS.items():
        project = ledger["projects"][plan["project"]]
        action = begin_action(ledger, report, "create-" + key)
        report["postAttempts"] += 1
        report["postOutcomeUnknown"] = True
        status, result = sessions[plan["role"]].api("POST", "/api/tarefas", {
            "projectId": project["id"], "projectName": project["name"], "title": plan["title"],
            "description": "Conteudo sintetico sem dados de clientes.", "status": "pendente", "priority": "media",
            "dueDate": "2031-01-15", "assigneeId": ids[plan["role"]], "assigneeName": plan["role"] + " sintetico"})
        task = result.get("task")
        base.require(isinstance(task, dict) and valid_id(task.get("id"), "task") and task.get("title") == plan["title"]
            and task.get("projectId") == project["id"] and task.get("assigneeId") == ids[plan["role"]], "FixtureMismatch")
        ledger["tasks"][key]["id"] = task["id"]
        report["tasksCreated"] += 1
        report["postOutcomeUnknown"] = False
        end_action(ledger, report, action, status)
    ledger["phase"] = "fixtures-ready"
    checkpoint(ledger, report)
    ledger_guard(ledger, ready=True)
    report["fixturesPrepared"] = True

def project_key(item, ledger):
    if not isinstance(item, dict):
        return None
    text = json.dumps(item, ensure_ascii=True)
    found = set()
    for key, project in ledger["projects"].items():
        if project["id"] in text or project["name"] in text:
            found.add(key)
    for task in ledger["tasks"].values():
        if task["id"] in text or task["title"] in text:
            found.add(task["project"])
    if not found and MARKER not in text:
        return None
    base.require(len(found) == 1, "ProtocolInvalid")
    return next(iter(found))

def filtered(items, ledger):
    base.require(isinstance(items, list) and all(isinstance(item, dict) for item in items), "ProtocolInvalid")
    return [item for item in items if project_key(item, ledger)]

def audit_reads(sessions, ledger, access, report):
    observed = {}
    for role in ROLES:
        session = sessions[role]
        _, projects = session.api("GET", "/api/tarefas/projetos")
        relevant_projects = filtered(projects.get("projects"), ledger)
        expected_projects = {ledger["projects"][key]["id"] for key in access[role]}
        base.require({item.get("id") for item in relevant_projects} == expected_projects, "PrivacyViolation")
        _, tasks = session.api("GET", "/api/tarefas?" + urlencode({"status": "todas"}))
        expected_tasks = {task["id"] for task in ledger["tasks"].values() if task["project"] in access[role]}
        base.require({task.get("id") for task in filtered(tasks.get("tasks"), ledger)} == expected_tasks, "PrivacyViolation")
        _, history = session.api("GET", "/api/team-chat/messages?scope=team")
        _, threads = session.api("GET", "/api/team-chat/threads")
        _, inbox = session.api("GET", "/api/omnichannel/inbox")
        messages = filtered(history.get("messages"), ledger)
        notices = filtered(inbox, ledger)
        previews = [thread.get("lastMessage") for thread in threads.get("threads", []) if isinstance(thread.get("lastMessage"), dict)]
        previews = filtered(previews, ledger)
        for item in [*messages, *notices, *previews]:
            base.require(project_key(item, ledger) in access[role], "PrivacyViolation")
        thread = next((item for item in threads.get("threads", []) if item.get("id") == "team"), None)
        base.require(isinstance(thread, dict) and type(thread.get("unreadCount")) is int, "ProtocolInvalid")
        observed[role] = {"messages": messages, "inbox": notices, "previews": previews, "unread": thread["unreadCount"]}
    report["historyPreviewInboxVerified"] = True
    return observed

class Sockets:
    def __init__(self, sessions, ledger, report):
        try:
            from websockets.sync.client import connect
        except ImportError:
            raise base.Blocked("DependencyMissing")
        self.connect, self.sessions, self.ledger, self.report = connect, sessions, ledger, report
        self.rows, self.seen = [], set()
        try:
            for role in ROLES:
                self.open_role(role)
            base.require(not self.pump(3), "UnexpectedActivity")
            self.ready()
        except Exception:
            self.close()
            raise

    def open_role(self, role):
        for channel, path in (("team", "/api/team-chat/ws"), ("inbox", "/api/omnichannel/ws")):
            ticket = self.sessions[role].request("/api/auth/websocket-ticket", {}).get("ticket")
            base.require(isinstance(ticket, str) and 20 <= len(ticket) <= 200 and ticket.isascii(), "ProtocolInvalid")
            socket = self.connect(base.ORIGIN.replace("https://", "wss://", 1) + path + "?ticket=" + quote(ticket, safe=""),
                ssl=base.ssl.create_default_context(), origin=base.ORIGIN, proxy=None, open_timeout=8,
                close_timeout=2, max_size=2097152, max_queue=64, ping_interval=None)
            self.rows.append({"role": role, "channel": channel, "socket": socket, "connected": False, "calls": False})
            self.report["websocketConnections"] += 1

    def ready(self):
        base.require(len(self.rows) == 6 and all(row["connected"] and (row["channel"] != "team" or row["calls"]) for row in self.rows), "ProtocolInvalid")

    def pump(self, seconds):
        observed = []
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            for row in self.rows:
                try:
                    event = json.loads(row["socket"].recv(timeout=0.025))
                except TimeoutError:
                    continue
                base.require(isinstance(event, dict), "ProtocolInvalid")
                kind = event.get("type")
                if kind == "CONNECTED":
                    row["connected"] = True
                elif kind == "CALLS_STATE":
                    base.require(event.get("calls") == [], "UnexpectedActivity")
                    row["calls"] = True
                elif kind in {"CALL_INVITE", "CALL_INCOMING", "CALL_SESSION", "CALL_ACTIVE", "CALL_START"}:
                    raise base.Blocked("UnexpectedActivity")
                elif kind in {"PRESENCE", "PONG", "ACK"}:
                    pass
                else:
                    base.require(kind in {"TEAM_CHAT_MESSAGE", "NEW_EVENT", "TEAM_MESSAGE_READ", "TEAM_MESSAGE_REACTION"}, "UnexpectedActivity")
                if kind in {"CONNECTED", "PRESENCE"} and row["channel"] == "team":
                    online = event.get("onlineUserIds")
                    base.require(isinstance(online, list) and set(online) <= set(self.ledger["userIds"].values()), "TeamMismatch")
                item = event.get("message") if kind == "TEAM_CHAT_MESSAGE" else event.get("event") if kind == "NEW_EVENT" else None
                key = project_key(item, self.ledger)
                if key:
                    base.require(isinstance(item.get("id"), str) and 1 <= len(item["id"]) <= 200, "ProtocolInvalid")
                    identity = (row["role"], row["channel"], item["id"])
                    if identity in self.seen:
                        continue
                    self.seen.add(identity)
                    base.require(len(self.seen) <= 500, "ProtocolInvalid")
                    observed.append((row["role"], row["channel"], kind, key, item["id"]))
                    self.report["markerEventsObserved"] += 1
                elif isinstance(item, dict) and str((item.get("metadata") or {}).get("action") or "").startswith(("task_", "automation_task_")):
                    raise base.Blocked("UnexpectedActivity")
        return observed

    def check_window(self, allowed, *, require_team=False, project=None):
        events = self.pump(3)
        for role, _, _, key, _ in events:
            if role not in allowed or (project is not None and key != project):
                self.report["unauthorizedMarkerEvents"] += 1
                raise base.Blocked("PrivacyViolation")
        if require_team:
            for role in allowed:
                base.require(any(item[0] == role and item[1] == "team" and item[2] == "TEAM_CHAT_MESSAGE" for item in events)
                    and any(item[0] == role and item[1] == "inbox" and item[2] == "NEW_EVENT" for item in events), "ProtocolInvalid")
        return events

    def reconnect(self, role):
        retained = []
        for row in self.rows:
            if row["role"] == role:
                row["socket"].close()
            else:
                retained.append(row)
        self.rows = retained
        self.open_role(role)
        events = self.pump(3)
        base.require(not events, "UnexpectedActivity")
        self.ready()

    def close(self):
        for row in self.rows:
            with contextlib.suppress(Exception):
                row["socket"].close()
        self.rows = []

def guarded_patch(sessions, ledger, report, sockets, key, role, path, payload, expected, allowed, *, project=None, require_team=False):
    base.require(not sockets.pump(0.5), "UnexpectedActivity")
    action = begin_action(ledger, report, key)
    report["patchAttempts"] += 1
    status, response = sessions[role].api("PATCH", path, payload, expected=expected)
    events = sockets.check_window(allowed, require_team=require_team, project=project)
    end_action(ledger, report, action, status)
    return events

def assert_persisted(events, observed):
    for role, channel, kind, _, event_id in events:
        if channel == "team" and kind == "TEAM_CHAT_MESSAGE":
            base.require(any(item.get("id") == event_id for item in observed[role]["messages"])
                and any(item.get("id") == event_id for item in observed[role]["previews"]), "ProtocolInvalid")
        elif channel == "inbox" and kind == "NEW_EVENT":
            base.require(any(item.get("id") == event_id for item in observed[role]["inbox"]), "ProtocolInvalid")

def task_snapshot(session, ledger, key):
    task = ledger["tasks"][key]
    _, response = session.api("GET", "/api/tarefas?" + urlencode({"project_id": ledger["projects"][task["project"]]["id"], "status": "todas", "q": MARKER}))
    found = next((item for item in response.get("tasks", []) if item.get("id") == task["id"]), None)
    base.require(isinstance(found, dict), "FixtureMismatch")
    return {field: found.get(field) for field in ("id", "projectId", "title", "status", "priority", "dueDate", "assigneeId")}

def read_update_review(sessions, users, ledger, report):
    ledger_guard(ledger, ready=True)
    ledger["phase"] = "reviewing-updates"
    checkpoint(ledger, report)
    baseline = audit_reads(sessions, ledger, {"P": {"p1"}, "A": {"p1", "p2"}, "N": set()}, report)
    report["initialAclVerified"] = True
    task_path = "/api/tarefas/" + ledger["tasks"]["t1"]["id"]
    project_path = "/api/tarefas/projetos/" + ledger["projects"]["p1"]["id"]
    sockets = Sockets(sessions, ledger, report)
    try:
        delivered = guarded_patch(sessions, ledger, report, sockets, "update-authorized-a", "A", task_path,
            {"title": MARKER + "_T1_REVIEW", "status": "andamento", "priority": "alta", "dueDate": "2031-01-15",
             "assigneeId": users["A"]["id"], "assigneeName": "A sintetico"}, 200, {"P", "A"}, project="p1", require_team=True)
        state = task_snapshot(sessions["P"], ledger, "t1")
        base.require(state["status"] == "andamento" and state["priority"] == "alta" and state["assigneeId"] == users["A"]["id"], "FixtureMismatch")
        observed = audit_reads(sessions, ledger, {"P": {"p1"}, "A": {"p1", "p2"}, "N": set()}, report)
        assert_persisted(delivered, observed)
        report["updateChannelsVerified"] = True
        guarded_patch(sessions, ledger, report, sockets, "deny-assignment-n", "P", task_path,
            {"assigneeId": users["N"]["id"], "assigneeName": "N sintetico"}, 400, set())
        base.require(task_snapshot(sessions["P"], ledger, "t1") == state, "PrivacyViolation")
        report["expectedDenials"] += 1
        report["deniedAssignmentVerified"] = True
        guarded_patch(sessions, ledger, report, sockets, "deny-update-n", "N", task_path, {"status": "concluida"}, 404, set())
        base.require(task_snapshot(sessions["P"], ledger, "t1") == state, "PrivacyViolation")
        report["expectedDenials"] += 1
        report["deniedUpdateVerified"] = True
        guarded_patch(sessions, ledger, report, sockets, "revoke-a", "P", project_path, {"sharedUserIds": []}, 200, {"P"}, project="p1")
        audit_reads(sessions, ledger, {"P": {"p1"}, "A": {"p2"}, "N": set()}, report)
        sessions["A"].api("GET", "/api/tarefas?" + urlencode({"project_id": ledger["projects"]["p1"]["id"], "status": "todas"}), expected=404)
        report["revocationVerified"] = True
        sockets.reconnect("A")
        report["websocketReconnectVerified"] = True
        revoked = guarded_patch(sessions, ledger, report, sockets, "update-while-revoked", "P", task_path, {"priority": "urgente"}, 200, {"P"}, project="p1", require_team=True)
        observed = audit_reads(sessions, ledger, {"P": {"p1"}, "A": {"p2"}, "N": set()}, report)
        assert_persisted(revoked, observed)
        guarded_patch(sessions, ledger, report, sockets, "restore-a", "P", project_path, {"sharedUserIds": [users["A"]["id"]]}, 200, {"P"}, project="p1")
        delivered = guarded_patch(sessions, ledger, report, sockets, "update-after-restoration", "P", task_path, {"status": "revisao"}, 200, {"P", "A"}, project="p1", require_team=True)
        observed = audit_reads(sessions, ledger, {"P": {"p1"}, "A": {"p1", "p2"}, "N": set()}, report)
        assert_persisted(delivered, observed)
        revoked_ids = {item[4] for item in revoked if item[2] == "TEAM_CHAT_MESSAGE"}
        base.require(not any(item.get("id") in revoked_ids for item in observed["A"]["messages"]), "PrivacyViolation")
        report["restorationVerified"] = True
        delivered = guarded_patch(sessions, ledger, report, sockets, "member-private-update", "A", "/api/tarefas/" + ledger["tasks"]["t3"]["id"],
            {"status": "andamento", "priority": "alta"}, 200, {"A"}, project="p2", require_team=True)
        final = audit_reads(sessions, ledger, {"P": {"p1"}, "A": {"p1", "p2"}, "N": set()}, report)
        assert_persisted(delivered, final)
        base.require(final["N"]["unread"] == baseline["N"]["unread"], "PrivacyViolation")
        report["memberPrivateProjectVerified"] = True
        ledger["phase"] = "updates-reviewed"
        checkpoint(ledger, report)
    finally:
        sockets.close()

def run(value, report):
    base.require(isinstance(value, dict) and set(value) == {"accounts", "ledger", "phase"}
        and value["phase"] in {"--prepare-fixtures", "--read-update-review"}, "ProtocolInvalid")
    accounts = value["accounts"]
    base.require(isinstance(accounts, list) and len(accounts) == 3, "CredentialsInvalid")
    for account, name in zip(accounts, (*base.NAMES, N_NAME)):
        base.require(isinstance(account, dict) and set(account) == {"identifier", "password", "expectedName"}
            and account["expectedName"] == name and isinstance(account["identifier"], str)
            and "@" in account["identifier"] and isinstance(account["password"], str), "CredentialsInvalid")
    ledger = value["ledger"]
    ledger_guard(ledger, ready=value["phase"] == "--read-update-review")
    revision_guard(PrimarySession())
    report["revisionMatched"] = True
    sessions, users = authenticate_all(accounts, report)
    if value["phase"] == "--prepare-fixtures":
        prepare_fixtures(sessions, users, ledger, report)
    else:
        base.require(ledger["userIds"] == {role: users[role]["id"] for role in ROLES}, "IdentityMismatch")
        read_update_review(sessions, users, ledger, report)
    revision_guard(sessions["P"])
    report["ok"] = True
'''
exec(compile(BODY, "primary_privacy_body", "exec"), globals())

CHILD_MAIN = r'''
CONTROL_FD=os.dup(1)
report=summary()
with base.quiet():
    try:
        base.require(os.name=="posix" and os.geteuid()==10001,"HostRequired")
        def timeout(*_):
            raise base.Blocked("Timeout")
        signal.signal(signal.SIGALRM,timeout)
        signal.alarm(240)
        base.require(json.loads(Path("/opt/norium/release.json").read_text()).get("revision")==RUNTIME_REVISION,"RevisionMismatch")
        raw=sys.stdin.buffer.readline(65537)
        base.require(len(raw)<=65536,"CredentialsInvalid")
        run(json.loads(raw),report)
    except base.Blocked as error:
        report["errorClass"]=error.args[0] if error.args and error.args[0] in ERRORS else "InternalError"
    except Exception:
        report["errorClass"]="TransportError"
    finally:
        pg=sys.modules.get("app.infrastructure.persistence.postgres_store")
        if pg is not None and pg._pool is not None:
            try:
                pg._pool.close(timeout=5)
            except Exception:
                report["errorClass"]="TransportError"
        signal.alarm(0)
report["ok"]=report["ok"] and report["errorClass"]=="None"
report["countsAreLowerBounds"]=False
os.write(CONTROL_FD,(json.dumps({"kind":"final","report":safe_summary(report)},separators=(",",":"))+"\n").encode())
os.close(CONTROL_FD)
raise SystemExit(0 if report["ok"] else 2)
'''

def protected_json(path, maximum=65536):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        base.require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
            and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= maximum, "FileUnsafe")
        return json.loads(stream.read(maximum + 1))

def atomic_ledger(path, ledger, *, initial=False):
    ledger_guard(ledger)
    target = path if initial else path.with_name(path.name + ".checkpoint-" + secrets.token_hex(8))
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        info = os.fstat(stream.fileno())
        base.require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600, "FileUnsafe")
        json.dump(ledger, stream, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())
    if not initial:
        previous = protected_json(path)
        base.require(previous["revision"] == ledger["revision"] and previous["marker"] == ledger["marker"]
            and previous["sequence"] + 1 == ledger["sequence"], "CheckpointFailed")
        os.replace(target, path)
    parent_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)

def reconcile_receipt(report, ledger, *, complete, started):
    # A durable pending action precedes every mutation; never reinterpret it as no action.
    if ledger is not None:
        ledger_guard(ledger)
    actions = [] if ledger is None else ledger["actions"]
    pending = [action for action in actions if action["state"] == "pending"]
    if not complete:
        error = report["errorClass"]
        report = summary()
        report["errorClass"] = error
        verified = [action for action in actions if action["state"] == "verified"]
        report["postAttempts"] = sum(action["key"].startswith("create-") for action in verified)
        report["patchAttempts"] = sum(not action["key"].startswith("create-") for action in verified)
        report["expectedDenials"] = sum(action["http"] in {400, 404} for action in verified)
        report["projectsCreated"] = sum(action["key"] in {"create-p1", "create-p2"} and action["http"] == 200 for action in verified)
        report["tasksCreated"] = sum(action["key"] in {"create-t1", "create-t2", "create-t3"} and action["http"] == 200 for action in verified)
        report["checkpoints"] = 0 if ledger is None else ledger["sequence"]
    report["completeChildReportReceived"] = complete
    report["countsAreLowerBounds"] = not complete
    report["postOutcomeUnknown"] |= any(action["key"].startswith("create-") for action in pending)
    report["patchOutcomeUnknown"] |= any(not action["key"].startswith("create-") for action in pending)
    report["operationOutcomeUnknown"] = bool(pending) or started and not complete or report["postOutcomeUnknown"] or report["patchOutcomeUnknown"]
    report["ok"] = report["ok"] and not report["operationOutcomeUnknown"]
    if report["operationOutcomeUnknown"] and report["errorClass"] == "None":
        report["errorClass"] = "LedgerNeedsReconciliation"
    return safe_summary(report)

def self_check():
    compile(SHARED_BODY + BODY + CHILD_MAIN, "primary_privacy_child", "exec")
    ledger_guard(new_ledger())
    ledger = new_ledger()
    ledger["projects"]["p1"]["id"] = "workspace_" + "a" * 12
    ledger["tasks"]["t1"]["id"] = "task_" + "b" * 32
    ledger_guard(ledger)
    for probe in (lambda: ledger_guard({**ledger, "marker": "WRONG"}),
                  lambda: ledger_guard(ledger, ready=True),
                  lambda: safe_summary({**summary(), "deletionsPerformed": True})):
        try:
            probe()
        except base.Blocked:
            pass
        else:
            raise AssertionError("Unsafe fixture/phase must be rejected")
    print('{"offlineSelfCheckPassed":true,"credentialsRead":false,"networkRequests":0,"fixturesCreated":0}')

def main():
    if sys.argv[1:] == ["--self-check"]:
        self_check()
        return 0
    report = summary()
    process = None
    lock_fd = None
    ledger = None
    complete = False
    with base.quiet():
        try:
            base.require(len(sys.argv[1:]) == 1 and sys.argv[1] in {"--prepare-fixtures", "--read-update-review"}, "ProtocolInvalid")
            base.require(os.name == "posix" and os.geteuid() == 0, "HostRequired")
            def host_timeout(*_):
                raise base.Blocked("Timeout")
            signal.signal(signal.SIGALRM, host_timeout)
            signal.alarm(270)
            phase = sys.argv[1]
            legacy = base.host_credentials()
            member = protected_json(Path("/srv/norium/private/smoke-private-member-637106e.json"))
            base.require(member.get("revision") == RUNTIME_REVISION and member.get("state") == "created-and-verified"
                and member.get("operatorDedicatedAccountsConfirmed") is True and member.get("operatorCurrentPasswordsConfirmed") is True
                and isinstance(member.get("accounts"), list) and len(member["accounts"]) == 1
                and member["accounts"][0].get("expectedName") == N_NAME, "CredentialsInvalid")
            accounts = [*base.credentials(legacy), member["accounts"][0]]
            path = Path("/srv/norium/private/privacy-primary-fixtures-637106e.json")
            import fcntl
            lock_fd = os.open(path.with_name(path.name + ".lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            info = os.fstat(lock_fd)
            base.require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600, "FileUnsafe")
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise base.Blocked("LedgerBusy")
            if phase == "--prepare-fixtures":
                ledger = new_ledger()
                atomic_ledger(path, ledger, initial=True)
            else:
                ledger = protected_json(path)
                ledger_guard(ledger, ready=True)
            code = "import base64,types,json,os,sys,re\nfrom pathlib import Path\nbase=types.ModuleType('reviewed_auth_helper')\nexec(base64.b64decode('" + base64.b64encode(base_source).decode("ascii") + "'),base.__dict__)\n" + SHARED_BODY + BODY + CHILD_MAIN
            process = subprocess.Popen(["/usr/bin/docker", "--host", "unix:///var/run/docker.sock", "exec", "--user", "10001", "-i", "norium-api", "python", "-c", code],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
            process.stdin.write((json.dumps({"accounts": accounts, "ledger": ledger, "phase": phase}, separators=(",", ":")) + "\n").encode())
            process.stdin.flush()
            while True:
                raw = process.stdout.readline(65537)
                base.require(raw and len(raw) <= 65536, "ProtocolInvalid")
                packet = json.loads(raw)
                if packet.get("kind") == "checkpoint":
                    base.require(set(packet) == {"kind", "ledger"}, "ProtocolInvalid")
                    next_ledger = packet["ledger"]
                    base.require(next_ledger.get("sequence") == ledger["sequence"] + 1, "CheckpointFailed")
                    atomic_ledger(path, next_ledger)
                    ledger = next_ledger
                    process.stdin.write((json.dumps({"checkpointed": True, "sequence": ledger["sequence"]}) + "\n").encode())
                    process.stdin.flush()
                else:
                    base.require(set(packet) == {"kind", "report"} and packet.get("kind") == "final", "ProtocolInvalid")
                    report = safe_summary(packet["report"])
                    base.require(process.wait(timeout=8) == (0 if report["ok"] else 2), "ProtocolInvalid")
                    complete = True
                    break
        except FileExistsError:
            report["errorClass"] = "LedgerExists"
        except base.Blocked as error:
            report["errorClass"] = error.args[0] if error.args and error.args[0] in ERRORS else "InternalError"
        except Exception:
            report["errorClass"] = "TransportError"
        finally:
            if os.name == "posix":
                signal.alarm(0)
            if process is not None:
                try:
                    if process.poll() is None:
                        process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                except Exception:
                    report["errorClass"] = "TransportError"
                    complete = False
                for stream in (process.stdin, process.stdout):
                    if stream:
                        with contextlib.suppress(Exception):
                            stream.close()
            if lock_fd is not None:
                with contextlib.suppress(Exception):
                    os.close(lock_fd)
    report = reconcile_receipt(report, ledger, complete=complete, started=process is not None)
    report["ok"] = report["ok"] and report["errorClass"] == "None"
    print(json.dumps(safe_summary(report), separators=(",", ":")))
    return 0 if report["ok"] else 2

if __name__ == "__main__":
    raise SystemExit(main())
