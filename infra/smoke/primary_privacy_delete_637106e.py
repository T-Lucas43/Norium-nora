"""Separate synthetic-task DELETE stage. Human approval is required; no implicit execution."""
import base64
import contextlib
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import stat
import subprocess
import sys
import types

FULL_SHA = "26905f49d39fc1bf4f06a27e25ff3df74d27f93336eaeac004bd6f32a8925f71"
FULL_PATH = Path("/srv/norium/private/primary_privacy_637106e.py")
if os.name == "nt":
    FULL_PATH = Path("C:/NOrium/.tmp-tests/resume-vps-20261013/privacy/primary_privacy_637106e.py")
    full_source = FULL_PATH.read_bytes()
else:
    fd = os.open(FULL_PATH, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not (stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 65536):
            raise SystemExit("Reviewed privacy source is unsafe; no delete performed")
        full_source = stream.read(65537)
if hashlib.sha256(full_source).hexdigest() != FULL_SHA:
    raise SystemExit("Reviewed privacy source changed; no delete performed")
full = types.ModuleType("reviewed_primary_privacy")
full.__file__ = str(FULL_PATH)
exec(compile(full_source, str(FULL_PATH), "exec"), full.__dict__)
for name in ("base", "ROLES", "MARKER", "RUNTIME_REVISION", "N_NAME", "valid_id", "PROJECTS", "TASKS",
             "PrimarySession", "readonly_database", "directory_guard", "revision_guard", "authenticate_all",
             "Sockets", "filtered", "project_key", "assert_persisted", "ledger_guard"):
    globals()[name] = getattr(full, name)

DELETE_BODY = r'''
import copy
import re
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode
REVIEW_FLAG = "--review-candidates"
EXECUTE_FLAG = "--execute-approved-three-task-deletes"
APPROVAL_FLAG = "--human-approved-three-task-deletes"
DELETE_ORDER = (("t2", "A"), ("t1", "P"), ("t3", "A"))
EXPECTED = {
    "t1": {"title": MARKER + "_T1_REVIEW", "status": "revisao", "priority": "urgente", "assignee": "A", "creator": "P"},
    "t2": {"title": MARKER + "_T2", "status": "pendente", "priority": "media", "assignee": "P", "creator": "P"},
    "t3": {"title": MARKER + "_T3", "status": "andamento", "priority": "alta", "assignee": "A", "creator": "A"}}
SNAPSHOT_FIELDS = ("id", "projectId", "title", "description", "category", "status", "priority", "dueDate", "assigneeId", "assigneeName", "createdBy", "comments", "attachments", "labels")
DELETE_BOOLS = ("ok", "revisionMatched", "directoryCheckedBeforeLogin", "threeNormalLoginsMatched",
    "primaryTeamExactlyThree", "automationSafetyChecked", "noRelevantAutomaticActions", "historyCapacityChecked",
    "candidateReviewComplete", "humanApprovalConfirmed", "taskSnapshotVerified", "deniedDeleteVerified",
    "threeTaskDeletesVerified", "projectsPreserved", "historyPreviewInboxVerified", "deletedTaskSnapshotsVerified",
    "fourProfilePrivacyAccepted", "deleteOutcomeUnknown", "operationOutcomeUnknown", "completeChildReportReceived", "countsAreLowerBounds")
DELETE_COUNTS = ("authenticatedAccounts", "deleteAttempts", "tasksDeleted", "expectedDenials", "websocketConnections",
    "markerEventsObserved", "unauthorizedMarkerEvents", "checkpoints", "existingTeamMessages")
DELETE_ERRORS = base.ERRORS | {"AutomationBlocked", "FixtureMismatch", "LedgerExists", "LedgerBusy", "LedgerNeedsReconciliation",
    "CheckpointFailed", "PrivacyViolation", "DeleteApprovalRequired"}

def delete_summary():
    return {**dict.fromkeys(DELETE_BOOLS, False), **dict.fromkeys(DELETE_COUNTS, 0), "countsAreLowerBounds": True, "errorClass": "None"}

def safe_delete_summary(report):
    base.require(isinstance(report, dict) and set(report) == set(delete_summary()) and
        all(type(report[key]) is bool for key in DELETE_BOOLS) and
        all(type(report[key]) is int and 0 <= report[key] <= 10000 for key in DELETE_COUNTS) and
        report["errorClass"] in DELETE_ERRORS and not report["fourProfilePrivacyAccepted"] and
        0 <= report["tasksDeleted"] <= 3 and 0 <= report["deleteAttempts"] <= 6, "ProtocolInvalid")
    return report

def fixture_guard(fixture):
    ledger_guard(fixture)
    base.require(fixture["phase"] == "updates-reviewed", "LedgerNeedsReconciliation")
    probe = copy.deepcopy(fixture)
    probe["phase"] = "fixtures-ready"
    ledger_guard(probe, ready=True)
    expected = {"create-" + key: 200 for key in (*PROJECTS, *TASKS)}
    expected.update({key: 200 for key in ("update-authorized-a", "revoke-a", "update-while-revoked", "restore-a", "update-after-restoration", "member-private-update")})
    expected.update({"deny-assignment-n": 400, "deny-update-n": 404})
    base.require(len(fixture["actions"]) == len(expected) and
        {action["key"]: action["http"] for action in fixture["actions"]} == expected, "LedgerNeedsReconciliation")

def fixture_digest(fixture):
    return hashlib.sha256(json.dumps(fixture, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

def new_delete_ledger(fixture):
    fixture_guard(fixture)
    return {"revision": RUNTIME_REVISION, "marker": MARKER, "sequence": 0, "phase": "planned",
        "sourceLedgerDigest": fixture_digest(fixture), "userIds": dict(fixture["userIds"]),
        "projects": copy.deepcopy(fixture["projects"]), "tasks": copy.deepcopy(fixture["tasks"]),
        "snapshots": {}, "actions": [], "operatorHumanApprovalConfirmed": False}

def delete_ledger_guard(ledger, fixture=None):
    keys = {"revision", "marker", "sequence", "phase", "sourceLedgerDigest", "userIds", "projects", "tasks", "snapshots", "actions", "operatorHumanApprovalConfirmed"}
    base.require(isinstance(ledger, dict) and set(ledger) == keys and ledger["revision"] == RUNTIME_REVISION and
        ledger["marker"] == MARKER and type(ledger["sequence"]) is int and 0 <= ledger["sequence"] <= 50 and
        ledger["phase"] in {"planned", "candidates-reviewed", "deleting", "deletes-reviewed"} and
        isinstance(ledger["sourceLedgerDigest"], str) and re.fullmatch(r"[0-9a-f]{64}", ledger["sourceLedgerDigest"]) and
        type(ledger["operatorHumanApprovalConfirmed"]) is bool and isinstance(ledger["actions"], list) and len(ledger["actions"]) <= 6,
        "FixtureMismatch")
    if fixture is not None:
        fixture_guard(fixture)
        base.require(ledger["sourceLedgerDigest"] == fixture_digest(fixture) and
            all(ledger[field] == fixture[field] for field in ("userIds", "projects", "tasks")), "FixtureMismatch")
    base.require(set(ledger["userIds"]) == set(ROLES) and len(set(ledger["userIds"].values())) == 3 and
        all(valid_id(uid, "user") for uid in ledger["userIds"].values()) and set(ledger["projects"]) == set(PROJECTS) and
        set(ledger["tasks"]) == set(TASKS), "FixtureMismatch")
    for key, planned in PROJECTS.items():
        row = ledger["projects"][key]
        base.require(set(row) == {"id", *planned} and valid_id(row["id"], "project") and
            all(row[field] == value for field, value in planned.items()), "FixtureMismatch")
    for key, planned in TASKS.items():
        row = ledger["tasks"][key]
        base.require(set(row) == {"id", *planned} and valid_id(row["id"], "task") and
            all(row[field] == value for field, value in planned.items()), "FixtureMismatch")
    base.require(len({row["id"] for row in ledger["projects"].values()}) == 2 and len({row["id"] for row in ledger["tasks"].values()}) == 3 and
        isinstance(ledger["snapshots"], dict) and set(ledger["snapshots"]) in (set(), set(TASKS)), "FixtureMismatch")
    for key, snapshot in ledger["snapshots"].items():
        snapshot_guard(snapshot, ledger, key)
    allowed = {"deny-" + key for key in TASKS} | {"delete-" + key for key in TASKS}
    base.require(len({action.get("key") for action in ledger["actions"]}) == len(ledger["actions"]), "FixtureMismatch")
    for action in ledger["actions"]:
        base.require(set(action) == {"key", "state", "http", "startedEpoch", "endedEpoch"} and action["key"] in allowed and
            action["state"] in {"pending", "verified"} and type(action["http"]) is int and action["http"] in {0, 200, 404} and
            all(type(action[field]) in {int, float} and 0 <= action[field] <= 4102444800 for field in ("startedEpoch", "endedEpoch")), "FixtureMismatch")
    if ledger["phase"] != "planned":
        base.require(set(ledger["snapshots"]) == set(TASKS), "FixtureMismatch")
    if ledger["phase"] in {"deleting", "deletes-reviewed"}:
        base.require(ledger["operatorHumanApprovalConfirmed"], "DeleteApprovalRequired")

def snapshot_guard(snapshot, ledger, key):
    expected = EXPECTED[key]
    base.require(isinstance(snapshot, dict) and set(snapshot) == set(SNAPSHOT_FIELDS) and snapshot["id"] == ledger["tasks"][key]["id"] and
        snapshot["projectId"] == ledger["projects"][TASKS[key]["project"]]["id"] and
        all(snapshot[field] == expected[field] for field in ("title", "status", "priority")) and
        snapshot["description"] == "Conteudo sintetico sem dados de clientes." and snapshot["category"] == "geral" and snapshot["dueDate"] == "2031-01-15" and
        snapshot["assigneeId"] == ledger["userIds"][expected["assignee"]] and snapshot["assigneeName"] == expected["assignee"] + " sintetico" and
        snapshot["createdBy"] == ledger["userIds"][expected["creator"]] and
        all(snapshot[field] == [] for field in ("comments", "attachments", "labels")), "FixtureMismatch")

def capture_candidates(sessions, ledger):
    return capture_remaining(sessions, ledger, set(TASKS))

def delete_automation_guard(users):
    ids = {user["id"] for user in users.values()}
    with readonly_database() as db:
        rows = db.execute("SELECT payload FROM norium_documents WHERE store_key IN (%s,%s,%s)", tuple("user_" + uid + "/automacoes_db.json" for uid in sorted(ids))).fetchall()
        for row in rows:
            payload = row.get("payload")
            base.require(isinstance(payload, dict) and isinstance(payload.get("automations", []), list), "AutomationBlocked")
            for item in payload.get("automations", []):
                base.require(isinstance(item, dict), "AutomationBlocked")
                nodes = (item.get("flow") or {}).get("nodes") or []
                base.require(isinstance(nodes, list) and all(isinstance(node, dict) for node in nodes), "AutomationBlocked")
                for node in nodes:
                    config = node.get("config") or {}
                    base.require(isinstance(config, dict), "AutomationBlocked")
                    base.require(not (item.get("active") and node.get("kind") == "trigger" and config.get("automatic") == "true" and
                        config.get("eventType") in {"task.created", "task.updated", "task.comment", "task.deleted", "team.message", "team.mentioned"}), "AutomationBlocked")

def delete_checkpoint(ledger, report):
    ledger["sequence"] += 1
    delete_ledger_guard(ledger)
    packet = (json.dumps({"kind": "checkpoint", "ledger": ledger}, separators=(",", ":")) + "\n").encode()
    base.require(len(packet) <= 65536, "ProtocolInvalid")
    os.write(CONTROL_FD, packet)
    reply = json.loads(sys.stdin.buffer.readline(513))
    base.require(reply == {"checkpointed": True, "sequence": ledger["sequence"]}, "CheckpointFailed")
    report["checkpoints"] += 1

def begin_delete_action(ledger, report, key):
    base.require(not any(action["key"] == key for action in ledger["actions"]), "LedgerNeedsReconciliation")
    action = {"key": key, "state": "pending", "http": 0, "startedEpoch": time.time(), "endedEpoch": 0}
    ledger["actions"].append(action)
    delete_checkpoint(ledger, report)
    return action

class DeleteReadSession:
    def __init__(self, session):
        self.session, self.token, self.opener = session, session.token, session.opener

    def api(self, method, path, payload=None, expected=200):
        base.require(method == "GET" and payload is None, "ProtocolInvalid")
        return self.session.api(method, path, payload, expected=expected)

    def request(self, path, payload=None):
        base.require(path == "/api/auth/websocket-ticket" and payload == {} or
            path == "/api/system/release" and payload is None, "ProtocolInvalid")
        return self.session.request(path, payload)

def delete_request(session, ledger, key, *, approved, expected):
    delete_ledger_guard(ledger)
    base.require(approved is True and ledger["operatorHumanApprovalConfirmed"] is True and
        key in TASKS and set(ledger["snapshots"]) == set(TASKS) and expected in {200, 404} and bool(session.token), "DeleteApprovalRequired")
    task = ledger["tasks"][key]
    project = ledger["projects"][task["project"]]
    path = "/api/tarefas/" + task["id"] + "?" + urlencode({"project_id": project["id"], "project_name": project["name"]})
    request = urllib.request.Request(base.ORIGIN + path, method="DELETE", headers={"Authorization": "Bearer " + session.token,
        "Origin": base.ORIGIN, "Accept": "application/json", "Cache-Control": "no-store"})
    try:
        response = session.opener.open(request, timeout=10)
    except urllib.error.HTTPError as error:
        base.require(expected == 404 and error.code == 404, "TransportError")
        return 404
    with response:
        base.require(expected == 200 and response.status == 200 and response.geturl() == base.ORIGIN + path, "TransportError")
        raw = response.read(262145)
        base.require(len(raw) <= 262144 and json.loads(raw) == {"status": "sucesso"}, "ProtocolInvalid")
        return 200

def audit_deletes(sessions, ledger, remaining, report):
    access = {"P": {"p1"}, "A": {"p1", "p2"}, "N": set()}
    observed = {}
    for role in ROLES:
        _, response = sessions[role].api("GET", "/api/tarefas/projetos")
        projects = filtered(response.get("projects"), ledger)
        base.require({row.get("id") for row in projects} == {ledger["projects"][key]["id"] for key in access[role]}, "PrivacyViolation")
        for row in projects:
            key = project_key(row, ledger)
            plan = ledger["projects"][key]
            base.require(row.get("name") == plan["name"] and row.get("ownerUserId") == ledger["userIds"][plan["role"]] and
                set(row.get("sharedUserIds") or []) == {ledger["userIds"][member] for member in plan["shared"]}, "FixtureMismatch")
        _, response = sessions[role].api("GET", "/api/tarefas?status=todas")
        tasks = filtered(response.get("tasks"), ledger)
        base.require({row.get("id") for row in tasks} == {ledger["tasks"][key]["id"] for key in remaining if TASKS[key]["project"] in access[role]}, "PrivacyViolation")
        _, history = sessions[role].api("GET", "/api/team-chat/messages?scope=team")
        _, threads = sessions[role].api("GET", "/api/team-chat/threads")
        _, inbox = sessions[role].api("GET", "/api/omnichannel/inbox")
        messages, notices = filtered(history.get("messages"), ledger), filtered(inbox, ledger)
        previews = filtered([row["lastMessage"] for row in threads.get("threads", []) if isinstance(row.get("lastMessage"), dict)], ledger)
        base.require(all(project_key(row, ledger) in access[role] for row in (*messages, *notices, *previews)), "PrivacyViolation")
        thread = next((row for row in threads.get("threads", []) if row.get("id") == "team"), None)
        base.require(isinstance(thread, dict) and type(thread.get("unreadCount")) is int, "ProtocolInvalid")
        observed[role] = {"messages": messages, "previews": previews, "inbox": notices, "unread": thread["unreadCount"]}
    report["projectsPreserved"] = report["historyPreviewInboxVerified"] = True
    return observed

def verify_deleted_event_snapshot(events, observed, ledger, key):
    snapshot, project_key_value = ledger["snapshots"][key], TASKS[key]["project"]
    for role, channel, kind, _, event_id in events:
        base.require(kind in {"TEAM_CHAT_MESSAGE", "NEW_EVENT"}, "ProtocolInvalid")
        rows = observed[role]["messages" if channel == "team" else "inbox"]
        item = next((row for row in rows if row.get("id") == event_id), None)
        base.require(isinstance(item, dict), "ProtocolInvalid")
        metadata = item.get("metadata") or {}
        reference = metadata.get("taskProject") or {}
        base.require(metadata.get("action") == "task_deleted" and metadata.get("taskId") == snapshot["id"] and
            metadata.get("taskTitle") == snapshot["title"] and metadata.get("previousStatus") == snapshot["status"] and
            reference.get("projectId") == snapshot["projectId"] and
            reference.get("ownerId") == ledger["userIds"][ledger["projects"][project_key_value]["role"]], "FixtureMismatch")
        if channel == "team":
            summary_value = metadata.get("summary") or {}
            state = summary_value.get("state") or {}
            base.require(summary_value.get("taskTitle") == snapshot["title"] and summary_value.get("projectName") == ledger["projects"][project_key_value]["name"] and
                state.get("Status") == {"pendente": "pendente", "andamento": "em andamento", "revisao": "em revisao"}[snapshot["status"]] and
                state.get("Prioridade") == snapshot["priority"] and state.get("Categoria") == snapshot["category"] and
                state.get("Responsavel") == snapshot["assigneeName"] and state.get("Vencimento") == snapshot["dueDate"], "FixtureMismatch")

def execute_deletes(sessions, users, ledger, report, *, approved):
    base.require(approved is True and ledger["phase"] == "candidates-reviewed" and not ledger["actions"] and
        ledger["operatorHumanApprovalConfirmed"] is False, "DeleteApprovalRequired")
    base.require(capture_candidates(sessions, ledger) == ledger["snapshots"], "FixtureMismatch")
    ledger["phase"], ledger["operatorHumanApprovalConfirmed"] = "deleting", True
    delete_checkpoint(ledger, report)
    report["humanApprovalConfirmed"] = report["taskSnapshotVerified"] = True
    remaining = set(TASKS)
    baseline = audit_deletes(sessions, ledger, remaining, report)
    sockets = Sockets(sessions, ledger, report)
    try:
        for key, actor in DELETE_ORDER:
            # Recheck the owning account's exact snapshot immediately before each denied/authorized pair.
            current = capture_remaining(sessions, ledger, remaining)
            base.require(all(current[item] == ledger["snapshots"][item] for item in remaining), "FixtureMismatch")
            base.require(not sockets.pump(0.5), "UnexpectedActivity")
            action = begin_delete_action(ledger, report, "deny-" + key)
            report["deleteAttempts"] += 1
            report["deleteOutcomeUnknown"] = True
            status = delete_request(sessions["N"], ledger, key, approved=approved, expected=404)
            sockets.check_window(set())
            base.require(capture_remaining(sessions, ledger, remaining) == current, "PrivacyViolation")
            audit_deletes(sessions, ledger, remaining, report)
            action.update(state="verified", http=status, endedEpoch=time.time())
            delete_checkpoint(ledger, report)
            report["deleteOutcomeUnknown"] = False
            report["expectedDenials"] += 1
            base.require(not sockets.pump(0.5), "UnexpectedActivity")
            action = begin_delete_action(ledger, report, "delete-" + key)
            report["deleteAttempts"] += 1
            report["deleteOutcomeUnknown"] = True
            status = delete_request(sessions[actor], ledger, key, approved=approved, expected=200)
            allowed = {"P", "A"} if TASKS[key]["project"] == "p1" else {"A"}
            events = sockets.check_window(allowed, project=TASKS[key]["project"], require_team=True)
            remaining.remove(key)
            observed = audit_deletes(sessions, ledger, remaining, report)
            assert_persisted(events, observed)
            verify_deleted_event_snapshot(events, observed, ledger, key)
            action.update(state="verified", http=status, endedEpoch=time.time())
            delete_checkpoint(ledger, report)
            report["deleteOutcomeUnknown"] = False
            report["tasksDeleted"] += 1
        final = audit_deletes(sessions, ledger, set(), report)
        base.require(final["N"]["unread"] == baseline["N"]["unread"], "PrivacyViolation")
        report["deniedDeleteVerified"] = report["threeTaskDeletesVerified"] = report["deletedTaskSnapshotsVerified"] = True
        ledger["phase"] = "deletes-reviewed"
        delete_checkpoint(ledger, report)
    finally:
        sockets.close()

def capture_remaining(sessions, ledger, remaining):
    subset = {}
    for key in remaining:
        plan = TASKS[key]
        _, response = sessions[plan["role"]].api("GET", "/api/tarefas?" + urlencode({"project_id": ledger["projects"][plan["project"]]["id"], "status": "todas"}))
        rows = response.get("tasks")
        base.require(isinstance(rows, list), "ProtocolInvalid")
        matches = [row for row in rows if isinstance(row, dict) and row.get("id") == ledger["tasks"][key]["id"]]
        base.require(len(matches) == 1, "FixtureMismatch")
        row = matches[0]
        base.require(set(SNAPSHOT_FIELDS) <= set(row), "FixtureMismatch")
        subset[key] = {field: row[field] for field in SNAPSHOT_FIELDS}
        snapshot_guard(subset[key], ledger, key)
    return subset

def run_delete_stage(value, report):
    base.require(isinstance(value, dict) and set(value) == {"accounts", "fixtureLedger", "ledger", "phase", "approved"} and
        value["phase"] in {REVIEW_FLAG, EXECUTE_FLAG} and type(value["approved"]) is bool, "ProtocolInvalid")
    base.require(value["phase"] == REVIEW_FLAG and not value["approved"] or value["phase"] == EXECUTE_FLAG and value["approved"], "DeleteApprovalRequired")
    accounts, fixture, ledger = value["accounts"], value["fixtureLedger"], value["ledger"]
    fixture_guard(fixture)
    delete_ledger_guard(ledger, fixture)
    base.require(isinstance(accounts, list) and len(accounts) == 3, "CredentialsInvalid")
    for account, name in zip(accounts, (*base.NAMES, N_NAME)):
        base.require(isinstance(account, dict) and set(account) == {"identifier", "password", "expectedName"} and account["expectedName"] == name and
            isinstance(account["identifier"], str) and "@" in account["identifier"] and isinstance(account["password"], str), "CredentialsInvalid")
    revision_guard(PrimarySession())
    report["revisionMatched"] = True
    sessions, users = authenticate_all(accounts, report)
    sessions = {role: DeleteReadSession(session) for role, session in sessions.items()}
    base.require(ledger["userIds"] == {role: users[role]["id"] for role in ROLES}, "IdentityMismatch")
    delete_automation_guard(users)
    if value["phase"] == REVIEW_FLAG:
        base.require(ledger["phase"] == "planned" and not ledger["actions"] and not ledger["snapshots"] and not ledger["operatorHumanApprovalConfirmed"], "LedgerNeedsReconciliation")
        ledger["snapshots"] = capture_candidates(sessions, ledger)
        audit_deletes(sessions, ledger, set(TASKS), report)
        ledger["phase"] = "candidates-reviewed"
        delete_checkpoint(ledger, report)
        report["candidateReviewComplete"] = report["taskSnapshotVerified"] = True
    else:
        execute_deletes(sessions, users, ledger, report, approved=value["approved"])
    revision_guard(sessions["P"])
    report["ok"] = True
'''
exec(compile(DELETE_BODY, "delete_stage", "exec"), globals())

DELETE_CHILD = r'''
CONTROL_FD=os.dup(1)
report=delete_summary()
with base.quiet():
    try:
        base.require(os.name=="posix" and os.geteuid()==10001,"HostRequired")
        def child_timeout(*_):
            raise base.Blocked("Timeout")
        signal.signal(signal.SIGALRM,child_timeout)
        signal.alarm(240)
        base.require(json.loads(Path("/opt/norium/release.json").read_text()).get("revision")==RUNTIME_REVISION,"RevisionMismatch")
        raw=sys.stdin.buffer.readline(65537)
        base.require(len(raw)<=65536,"ProtocolInvalid")
        run_delete_stage(json.loads(raw),report)
    except base.Blocked as error:
        report["errorClass"]=error.args[0] if error.args and error.args[0] in DELETE_ERRORS else "InternalError"
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
os.write(CONTROL_FD,(json.dumps({"kind":"final","report":safe_delete_summary(report)},separators=(",",":"))+"\n").encode())
os.close(CONTROL_FD)
raise SystemExit(0 if report["ok"] else 2)
'''

def atomic_delete_ledger(path, ledger, *, initial=False):
    delete_ledger_guard(ledger)
    target = path if initial else path.with_name(path.name + ".checkpoint-" + secrets.token_hex(8))
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        info = os.fstat(stream.fileno())
        base.require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600, "FileUnsafe")
        json.dump(ledger, stream, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())
    if not initial:
        previous = full.protected_json(path)
        delete_ledger_guard(previous)
        base.require(previous["sourceLedgerDigest"] == ledger["sourceLedgerDigest"] and previous["sequence"] + 1 == ledger["sequence"], "CheckpointFailed")
        os.replace(target, path)
    parent_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)

def reconcile_delete_receipt(report, ledger, *, complete, started):
    if ledger is not None:
        delete_ledger_guard(ledger)
    actions = [] if ledger is None else ledger["actions"]
    pending = any(action["state"] == "pending" for action in actions)
    if not complete:
        error = report["errorClass"]
        report = delete_summary()
        report["errorClass"] = error
        verified = [action for action in actions if action["state"] == "verified"]
        report["deleteAttempts"] = len(verified)
        report["tasksDeleted"] = sum(action["key"].startswith("delete-") and action["http"] == 200 for action in verified)
        report["expectedDenials"] = sum(action["key"].startswith("deny-") and action["http"] == 404 for action in verified)
        report["checkpoints"] = 0 if ledger is None else ledger["sequence"]
    report["completeChildReportReceived"], report["countsAreLowerBounds"] = complete, not complete
    report["deleteOutcomeUnknown"] |= pending
    report["operationOutcomeUnknown"] = pending or started and not complete or report["deleteOutcomeUnknown"]
    report["ok"] = report["ok"] and not report["operationOutcomeUnknown"]
    if report["operationOutcomeUnknown"] and report["errorClass"] == "None":
        report["errorClass"] = "LedgerNeedsReconciliation"
    return safe_delete_summary(report)

def self_check():
    compile(full.SHARED_BODY + full.BODY + DELETE_BODY + DELETE_CHILD, "delete_child", "exec")
    safe_delete_summary(delete_summary())
    for args in ([], [EXECUTE_FLAG], [EXECUTE_FLAG, "--wrong-approval"], ["--delete-projects"]):
        try:
            cli_phase(args)
        except base.Blocked:
            pass
        else:
            raise AssertionError("Missing explicit approval must be rejected")
    print('{"offlineSelfCheckPassed":true,"credentialsRead":false,"networkRequests":0,"deletionsPerformed":false}')

def cli_phase(args):
    if args == [REVIEW_FLAG]:
        return REVIEW_FLAG, False
    base.require(args == [EXECUTE_FLAG, APPROVAL_FLAG], "DeleteApprovalRequired")
    return EXECUTE_FLAG, True

def main():
    if sys.argv[1:] == ["--self-check"]:
        self_check()
        return 0
    report, ledger, process, lock_fd, complete = delete_summary(), None, None, None, False
    with base.quiet():
        try:
            phase, approved = cli_phase(sys.argv[1:])
            base.require(os.name == "posix" and os.geteuid() == 0, "HostRequired")
            def host_timeout(*_):
                raise base.Blocked("Timeout")
            signal.signal(signal.SIGALRM, host_timeout)
            signal.alarm(270)
            member = full.protected_json(Path("/srv/norium/private/smoke-private-member-637106e.json"))
            base.require(member.get("revision") == RUNTIME_REVISION and member.get("state") == "created-and-verified" and
                member.get("operatorDedicatedAccountsConfirmed") is True and member.get("operatorCurrentPasswordsConfirmed") is True and
                isinstance(member.get("accounts"), list) and len(member["accounts"]) == 1 and member["accounts"][0].get("expectedName") == N_NAME, "CredentialsInvalid")
            accounts = [*base.credentials(base.host_credentials()), member["accounts"][0]]
            fixture = full.protected_json(Path("/srv/norium/private/privacy-primary-fixtures-637106e.json"))
            fixture_guard(fixture)
            path = Path("/srv/norium/private/privacy-primary-task-deletes-637106e.json")
            import fcntl
            lock_fd = os.open(path.with_name(path.name + ".lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            info = os.fstat(lock_fd)
            base.require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600, "FileUnsafe")
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise base.Blocked("LedgerBusy")
            if phase == REVIEW_FLAG:
                ledger = new_delete_ledger(fixture)
                atomic_delete_ledger(path, ledger, initial=True)
            else:
                candidate_ledger = full.protected_json(path)
                delete_ledger_guard(candidate_ledger, fixture)
                base.require(candidate_ledger["phase"] == "candidates-reviewed" and not candidate_ledger["actions"] and not candidate_ledger["operatorHumanApprovalConfirmed"], "LedgerNeedsReconciliation")
                ledger = candidate_ledger
            code = "import base64,types,json,os,sys,re,hashlib\nfrom pathlib import Path\nbase=types.ModuleType('reviewed_auth_helper')\nexec(base64.b64decode('" + base64.b64encode(full.base_source).decode("ascii") + "'),base.__dict__)\n" + full.SHARED_BODY + full.BODY + DELETE_BODY + DELETE_CHILD
            process = subprocess.Popen(["/usr/bin/docker", "--host", "unix:///var/run/docker.sock", "exec", "--user", "10001", "-i", "norium-api", "python", "-c", code],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
            process.stdin.write((json.dumps({"accounts": accounts, "fixtureLedger": fixture, "ledger": ledger, "phase": phase, "approved": approved}, separators=(",", ":")) + "\n").encode())
            process.stdin.flush()
            while True:
                raw = process.stdout.readline(65537)
                base.require(raw and len(raw) <= 65536, "ProtocolInvalid")
                packet = json.loads(raw)
                if packet.get("kind") == "checkpoint":
                    base.require(set(packet) == {"kind", "ledger"}, "ProtocolInvalid")
                    next_ledger = packet["ledger"]
                    delete_ledger_guard(next_ledger, fixture)
                    base.require(next_ledger["sequence"] == ledger["sequence"] + 1, "CheckpointFailed")
                    atomic_delete_ledger(path, next_ledger)
                    ledger = next_ledger
                    process.stdin.write((json.dumps({"checkpointed": True, "sequence": ledger["sequence"]}) + "\n").encode())
                    process.stdin.flush()
                else:
                    base.require(set(packet) == {"kind", "report"} and packet.get("kind") == "final", "ProtocolInvalid")
                    report = safe_delete_summary(packet["report"])
                    base.require(process.wait(timeout=8) == (0 if report["ok"] else 2), "ProtocolInvalid")
                    complete = True
                    break
        except FileExistsError:
            report["errorClass"] = "LedgerExists"
        except base.Blocked as error:
            report["errorClass"] = error.args[0] if error.args and error.args[0] in DELETE_ERRORS else "InternalError"
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
                    report["errorClass"], complete = "TransportError", False
                for stream in (process.stdin, process.stdout):
                    if stream:
                        with contextlib.suppress(Exception):
                            stream.close()
            if lock_fd is not None:
                with contextlib.suppress(Exception):
                    os.close(lock_fd)
    report = reconcile_delete_receipt(report, ledger, complete=complete, started=process is not None)
    report["ok"] = report["ok"] and report["errorClass"] == "None"
    print(json.dumps(safe_delete_summary(report), separators=(",", ":")))
    return 0 if report["ok"] else 2

if __name__ == "__main__":
    raise SystemExit(main())
