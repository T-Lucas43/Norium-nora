"""Create at most one explicitly authorized test member through the normal API.

Passwords/identifiers stay on the VPS; the fourth-account registry is untouched.
Run only after source review, with --create-one-dedicated-member.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import sys
import types

BASE_HASH = "266ac3fa766ef58184759409301d21dad1d9e431bef9b526288e18b08527d7d9"
base_path = Path("/srv/norium/private/vps_authenticated_smoke_9176971.py")
if os.name == "nt":
    base_path = Path("C:/NOrium/.tmp-tests/privacy-live-vps-2026-10-09-163745/vps_authenticated_smoke_9176971.py")
base_source = base_path.read_bytes()
if hashlib.sha256(base_source).hexdigest() != BASE_HASH:
    raise SystemExit("Reviewed auth helper changed; no account creation performed")
base = types.ModuleType("reviewed_auth_helper")
exec(compile(base_source, str(base_path), "exec"), base.__dict__)

CAPACITY_BODY = r'''
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


def capacity(owner, ids, team, rows, catalog):
    base.require(owner.get("role") == "owner" and owner["id"] == (owner.get("teamOwnerId") or owner["id"]), "IdentityMismatch")
    base.require(isinstance(rows, list) and len(rows) == 2 and isinstance(team, dict)
                 and team.get("id") == owner["id"] and team.get("ownerUserId") == owner["id"]
                 and team.get("memberCount") == 2 and {row.get("id") for row in rows} == ids
                 and all(row.get("status") == "ativo" and row.get("systemAdmin") is False
                         and (row.get("teamOwnerId") or row["id"]) == owner["id"] for row in rows), "TeamMismatch")
    base.require(isinstance(catalog, list), "ProtocolInvalid")
    plan = next((item for item in catalog if item.get("code") == owner.get("plan")), None)
    base.require(isinstance(plan, dict) and type(plan.get("teamSeats")) is int
                 and 1 <= plan["teamSeats"] <= 100, "ProtocolInvalid")
    seats = plan["teamSeats"]
    return {"dedicatedTeamExactlyTwo": True, "ownerPlanSupportsTeam": owner.get("plan") in {"equipe", "enterprise"},
            "activeTeamMembers": len(rows), "seatLimit": seats, "additionalSeats": max(0, seats - len(rows)),
            "capacityAvailable": owner.get("plan") in {"equipe", "enterprise"} and seats > len(rows)}


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


def automation_guard(ids, team_id):
    base.require(len(ids) == 2 and team_id in ids and all(isinstance(uid, str) and uid and
                 all(char.isascii() and (char.isalnum() or char in "_.-") for char in uid) for uid in ids), "IdentityMismatch")
    with readonly_database() as db:
        retained = db.execute("SELECT jsonb_typeof(payload)='object' AND jsonb_typeof(payload->'messages')='array' AND jsonb_typeof(payload->'activeCalls')='array' AND jsonb_array_length(payload->'activeCalls')=0 AS safe, jsonb_array_length(payload->'messages') AS count FROM norium_documents WHERE store_key=%s", ("user_" + team_id + "/team_chat_db.json",)).fetchone()
        base.require(retained is None or (retained.get("safe") is True and type(retained.get("count")) is int
                     and 0 <= retained["count"] <= 1960), "FixtureMismatch")
        rows = db.execute("SELECT payload FROM norium_documents WHERE store_key IN (%s,%s)", tuple("user_" + uid + "/automacoes_db.json" for uid in sorted(ids))).fetchall()
        blocked = relevant_automations([row.get("payload") for row in rows])
        return {"automationSafetyChecked": True, "noRelevantAutomaticActions": blocked == 0,
                "activeRelevantAutomations": blocked, "historyCapacityChecked": True,
                "existingTeamMessages": retained["count"] if retained else 0, "reservedMessageSlots": 40}

'''
exec(compile(CAPACITY_BODY, "reviewed_capacity_body", "exec"), globals())

PROVISION_BODY = r'''
import re
import urllib.error
NEW_NAME = "Codex-Priv-Sem-Acesso"
BOOLS = ("ok", "revisionMatched", "directoryCheckedBeforeLogin", "ownerIdentityMatched",
         "existingTwoAccountsMatched", "explicitSecondAccountLink", "capacityAvailable",
         "automationSafetyChecked", "noRelevantAutomaticActions", "aliasControlledMailbox",
         "noExistingAliasOrName", "privateRegistryPrepared", "createAttempted", "accountCreated",
         "normalLoginVerified", "newMemberIdentityMatched", "threeDedicatedMembersVerified",
         "minimalPermissionsVerified", "verificationEmailExpected", "smtpSentConfirmed",
         "taskProjectFixturesMutated", "fourProfilePrivacyValidated", "postOutcomeUnknown")
COUNTS = ("postAttempts", "accountsCreated", "activeTeamMembersBefore", "activeTeamMembersAfter", "additionalSeatsBefore")
ERRORS = base.ERRORS | {"AutomationBlocked", "FixtureMismatch", "ProvisionPreflightFailed",
    "PrivateRegistryExists", "PrivateStateWriteFailed", "Conflict", "PostCreationVerificationFailed"}
def summary():
    return {**dict.fromkeys(BOOLS, False), **dict.fromkeys(COUNTS, 0), "errorClass": "None"}
def safe_summary(value):
    base.require(isinstance(value, dict) and set(value) == set(summary()) and
        all(type(value[key]) is bool for key in BOOLS) and all(type(value[key]) is int and 0 <= value[key] <= 100 for key in COUNTS)
        and value["errorClass"] in ERRORS and not any(value[key] for key in
        ("smtpSentConfirmed", "taskProjectFixturesMutated", "fourProfilePrivacyValidated")), "ProtocolInvalid")
    base.require(value["postAttempts"] <= 1 and value["accountsCreated"] <= 1, "ProtocolInvalid")
    if value["ok"]:
        base.require(value["errorClass"] == "None" and all(value[key] for key in
            ("accountCreated", "normalLoginVerified", "newMemberIdentityMatched", "threeDedicatedMembersVerified",
             "minimalPermissionsVerified")) and value["postAttempts"] == value["accountsCreated"] == 1, "ProtocolInvalid")
    return value
def alias(identifier):
    local, domain = identifier.strip().lower().rsplit("@", 1)
    base.require(domain in {"gmail.com", "googlemail.com"} and bool(local.split("+", 1)[0]), "ProvisionPreflightFailed")
    result = local.split("+", 1)[0] + "+privsemacesso20261013@" + domain
    base.require(3 <= len(result) <= 180 and result != identifier.strip().lower(), "ProvisionPreflightFailed")
    return result
def authenticate(session, account):
    token = session.request("/api/auth/login", {"email": account["identifier"], "password": account["password"], "persistent": False}).get("token")
    base.require(isinstance(token, str) and 20 <= len(token) <= 8192, "ProtocolInvalid")
    session.token = token
    user = session.request("/api/auth/me").get("user")
    base.identity(user, account["expectedName"])
    base.require(isinstance(user.get("email"), str) and user["email"].casefold() == account["identifier"].casefold(), "IdentityMismatch")
    return user
def proposal_guard(proposal, owner_identifier):
    base.require(isinstance(proposal, dict) and set(proposal) == {"expectedName", "identifier", "password"}
        and proposal["expectedName"] == NEW_NAME and proposal["identifier"] == alias(owner_identifier)
        and isinstance(proposal["password"], str) and 40 <= len(proposal["password"]) <= 180, "CredentialsInvalid")
def create_member(session, proposal):
    payload = {"nome": NEW_NAME, "email": proposal["identifier"], "password": proposal["password"],
        "jobTitle": "Teste de privacidade", "role": "member", "plan": "individual",
        "permissions": {"dashboard": True, "central": True, "tarefas": True, "chat": True, "perfil": True}}
    request = urllib.request.Request(base.ORIGIN + "/api/auth/users", method="POST", data=json.dumps(payload).encode(), headers={
        "Authorization": "Bearer " + session.token, "Origin": base.ORIGIN,
        "Content-Type": "application/json", "Cache-Control": "no-store"})
    with session.opener.open(request, timeout=10) as response:
        base.require(response.status == 200 and response.geturl() == base.ORIGIN + "/api/auth/users", "TransportError")
        raw = response.read(262145)
        base.require(len(raw) <= 262144, "ProtocolInvalid")
        return json.loads(raw).get("user")
def provision(value, report, private):
    base.require(isinstance(value, dict) and set(value) == {"legacy", "proposal"}, "CredentialsInvalid")
    accounts = base.credentials(value["legacy"])
    proposal = value["proposal"]
    proposal_guard(proposal, accounts[0]["identifier"])
    report["aliasControlledMailbox"] = True
    session = CapacitySession()
    revision_guard(session)
    report["revisionMatched"] = True
    directory_guard()
    report["directoryCheckedBeforeLogin"] = True
    owner = authenticate(session, accounts[0])
    base.require(owner.get("role") == "owner" and (owner.get("teamOwnerId") or owner["id"]) == owner["id"], "IdentityMismatch")
    report["ownerIdentityMatched"] = True
    rows = session.request("/api/auth/users").get("users")
    base.require(isinstance(rows, list) and len(rows) == 2, "TeamMismatch")
    matches = [[row for row in rows if isinstance(row.get("email"), str) and
        row["email"].casefold() == account["identifier"].casefold()] for account in accounts]
    base.require(all(len(match) == 1 for match in matches), "IdentityMismatch")
    users = [match[0] for match in matches]
    for user, account in zip(users, accounts):
        base.identity(user, account["expectedName"])
    ids = {user["id"] for user in users}
    base.require(len(ids) == 2 and users[0]["id"] == owner["id"] and users[1].get("role") in {"owner", "member"}
        and users[1].get("teamOwnerId") == owner["id"], "IdentityMismatch")
    report["existingTwoAccountsMatched"] = report["explicitSecondAccountLink"] = True
    observed = capacity(owner, ids, session.request("/api/auth/team-profile").get("team"), rows,
        session.request("/api/auth/plans").get("plans"))
    report["capacityAvailable"] = observed["capacityAvailable"]
    report["activeTeamMembersBefore"] = observed["activeTeamMembers"]
    report["additionalSeatsBefore"] = observed["additionalSeats"]
    base.require(observed["capacityAvailable"], "ProvisionPreflightFailed")
    automated = automation_guard(ids, owner["id"])
    report["automationSafetyChecked"] = automated["automationSafetyChecked"]
    report["noRelevantAutomaticActions"] = automated["noRelevantAutomaticActions"]
    base.require(report["noRelevantAutomaticActions"], "ProvisionPreflightFailed")
    with readonly_database() as db:
        existing = db.execute("SELECT count(*)::int AS count FROM norium_documents CROSS JOIN LATERAL jsonb_array_elements(payload->'users') AS item WHERE store_key='usuarios_db.json' AND (lower(item->>'email')=%s OR item->>'nome'=%s)", (proposal["identifier"], NEW_NAME)).fetchone()
        base.require(existing.get("count") == 0, "Conflict")
    report["noExistingAliasOrName"] = True
    revision_guard(session)
    report["createAttempted"] = report["postOutcomeUnknown"] = True
    report["postAttempts"] = 1
    created = create_member(session, proposal)
    base.require(isinstance(created, dict) and isinstance(created.get("id"), str) and re.fullmatch(r"usr_[0-9a-f]{16}", created["id"]), "ProtocolInvalid")
    private["createdUserId"] = created["id"]
    report["accountCreated"] = True
    report["accountsCreated"] = 1
    report["postOutcomeUnknown"] = False
    base.identity(created, NEW_NAME)
    base.require(created.get("role") == "member" and created.get("plan") == "individual"
        and created.get("teamOwnerId") == owner["id"] and created.get("email") == proposal["identifier"], "PostCreationVerificationFailed")
    new_session = CapacitySession()
    new_user = authenticate(new_session, proposal)
    base.require(new_user["id"] == created["id"] and new_user.get("role") == "member"
        and new_user.get("teamOwnerId") == owner["id"] and new_user.get("plan") == "individual", "PostCreationVerificationFailed")
    report["normalLoginVerified"] = report["newMemberIdentityMatched"] = True
    permissions = new_user.get("permissions") or {}
    report["minimalPermissionsVerified"] = new_user.get("teamChatEnabled") is True and all(
        type(value) is bool for value in permissions.values()) and {
        key for key, enabled in permissions.items() if enabled is True} == {"dashboard", "central", "tarefas", "chat", "perfil"}
    base.require(report["minimalPermissionsVerified"], "PostCreationVerificationFailed")
    after = session.request("/api/auth/users").get("users")
    team = session.request("/api/auth/team-profile").get("team")
    base.require(isinstance(after, list) and len(after) == 3 and isinstance(team, dict), "TeamMismatch")
    report["activeTeamMembersAfter"] = len(after)
    report["threeDedicatedMembersVerified"] = {row.get("id") for row in after} == ids | {created["id"]} and all(
        row.get("status") == "ativo" and row.get("systemAdmin") is False and not row.get("systemAdminRole")
        and (row.get("teamOwnerId") or row["id"]) == owner["id"] for row in after) and team.get("memberCount") == 3 and team.get("ownerUserId") == owner["id"]
    base.require(report["threeDedicatedMembersVerified"], "TeamMismatch")
    # The normal route schedules verification; this flag does not claim delivery.
    report["verificationEmailExpected"] = True
    revision_guard(session)
    report["ok"] = True
'''
exec(compile(PROVISION_BODY, "provision_private_member_body", "exec"), globals())

CHILD_MAIN = r'''
report,private=summary(),{"createdUserId":""}
report["privateRegistryPrepared"] = True
with base.quiet():
    try:
        base.require(os.name == "posix" and os.geteuid() == 10001, "HostRequired")
        def timeout(*_):
            raise base.Blocked("Timeout")
        signal.signal(signal.SIGALRM, timeout)
        signal.alarm(95)
        base.require(json.loads(Path("/opt/norium/release.json").read_text()).get("revision") == RUNTIME_REVISION, "RevisionMismatch")
        raw=sys.stdin.buffer.read(32769)
        base.require(len(raw)<=32768,"CredentialsInvalid")
        provision(json.loads(raw),report,private)
    except urllib.error.HTTPError as error:
        report["errorClass"] = "Conflict" if error.code == 409 else "TransportError"
        if error.code == 409:
            report["postOutcomeUnknown"] = False
    except base.Blocked as error:
        report["errorClass"] = error.args[0] if error.args and error.args[0] in ERRORS else "InternalError"
    except Exception:
        report["errorClass"] = "TransportError"
    finally:
        pg=sys.modules.get("app.infrastructure.persistence.postgres_store")
        if pg is not None and pg._pool is not None:
            try:
                pg._pool.close(timeout=5)
            except Exception:
                report["errorClass"]="TransportError"
        signal.alarm(0)
report["ok"] = report["ok"] and report["errorClass"] == "None"
print(json.dumps({"report":safe_summary(report),"private":private},separators=(",",":")))
raise SystemExit(0 if report["ok"] else 2)
'''

def write_record(stream, record):
    stream.seek(0)
    json.dump(record, stream, separators=(",", ":"))
    stream.truncate()
    stream.flush()
    os.fsync(stream.fileno())

def fsync_parent(path):
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def replace_record_atomically(path, original_stream, record):
    # Keep the durable original, including its only generated password, until a
    # complete replacement is fsynced. A failed update leaves the original usable.
    temporary = path.with_name(path.name + ".update-" + secrets.token_hex(8))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        info = os.fstat(stream.fileno())
        base.require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600, "FileUnsafe")
        write_record(stream, record)
    original = os.fstat(original_stream.fileno())
    current = path.lstat()
    base.require(stat.S_ISREG(current.st_mode) and current.st_uid == 0 and current.st_nlink == 1
        and (current.st_dev, current.st_ino) == (original.st_dev, original.st_ino), "FileUnsafe")
    os.replace(temporary, path)
    fsync_parent(path)

def self_check():
    compile(CAPACITY_BODY + PROVISION_BODY + CHILD_MAIN, "provision_private_member_child", "exec")
    assert alias("synthetic+oldtag@gmail.com") == "synthetic+privsemacesso20261013@gmail.com"
    for probe in (lambda: alias("synthetic@example.invalid"),
                  lambda: proposal_guard({"expectedName": NEW_NAME, "identifier": "wrong@gmail.com", "password": "x" * 43}, "synthetic@gmail.com"),
                  lambda: safe_summary({**summary(), "postAttempts": 2})):
        try:
            probe()
        except base.Blocked:
            pass
        else:
            raise AssertionError("Unsafe proposal must be rejected")
    print('{"offlineSelfCheckPassed":true,"credentialsRead":false,"networkRequests":0,"accountsCreated":0}')

def main():
    if sys.argv[1:] == ["--self-check"]:
        self_check()
        return 0
    report = summary()
    with base.quiet():
        try:
            base.require(sys.argv[1:] == ["--create-one-dedicated-member"], "ProtocolInvalid")
            value = base.host_credentials()
            revision_guard(base.Session())
            proposal = {"expectedName": NEW_NAME, "identifier": alias(value["accounts"][0]["identifier"]), "password": secrets.token_urlsafe(32)}
            proposal_guard(proposal, value["accounts"][0]["identifier"])
            registry = Path("/srv/norium/private/smoke-private-member-637106e.json")
            fd = os.open(registry, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                info = os.fstat(stream.fileno())
                base.require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600, "FileUnsafe")
                record = {"revision": RUNTIME_REVISION, "operatorDedicatedAccountsConfirmed": True,
                    "operatorCurrentPasswordsConfirmed": False, "accounts": [proposal],
                    "state": "execution-started-outcome-unknown", "createdUserId": "", "fourProfilePrivacyValidated": False}
                write_record(stream, record)
                fsync_parent(registry)
                report["privateRegistryPrepared"] = True
                code = "import base64,types,json,os,sys\nfrom pathlib import Path\nbase=types.ModuleType('reviewed_auth_helper')\nexec(base64.b64decode('" + base64.b64encode(base_source).decode("ascii") + "'),base.__dict__)\n" + CAPACITY_BODY + PROVISION_BODY + CHILD_MAIN
                child = subprocess.run(["/usr/bin/docker", "--host", "unix:///var/run/docker.sock", "exec", "--user", "10001", "-i", "norium-api", "python", "-c", code],
                    input=json.dumps({"legacy": value, "proposal": proposal}).encode(), capture_output=True, timeout=110, check=False,
                    env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
                base.require(len(child.stdout) <= 8192, "ProtocolInvalid")
                outcome = json.loads(child.stdout)
                base.require(isinstance(outcome, dict) and set(outcome) == {"report", "private"}, "ProtocolInvalid")
                report = safe_summary(outcome["report"])
                private = outcome["private"]
                base.require(isinstance(private, dict) and set(private) == {"createdUserId"} and isinstance(private["createdUserId"], str)
                    and (private["createdUserId"] == "" or re.fullmatch(r"usr_[0-9a-f]{16}", private["createdUserId"])), "ProtocolInvalid")
                base.require(child.returncode == (0 if report["ok"] else 2), "ProtocolInvalid")
                record.update({"createdUserId": private["createdUserId"],
                    "operatorCurrentPasswordsConfirmed": report["normalLoginVerified"], "receipt": report,
                    "state": "created-and-verified" if report["ok"] else
                        ("created-needs-review" if report["accountCreated"] else ("post-outcome-unknown" if report["postOutcomeUnknown"] else ("post-rejected-needs-review" if report["createAttempted"] else "preflight-failed-no-post")))})
                try:
                    replace_record_atomically(registry, stream, record)
                except Exception:
                    report["errorClass"] = "PrivateStateWriteFailed"
        except FileExistsError:
            report["errorClass"] = "PrivateRegistryExists"
        except base.Blocked as error:
            report["errorClass"] = error.args[0] if error.args and error.args[0] in ERRORS else "InternalError"
        except subprocess.TimeoutExpired:
            report["postOutcomeUnknown"] = report["privateRegistryPrepared"]
            report["errorClass"] = "Timeout"
        except Exception:
            report["errorClass"] = "TransportError"
    report["ok"] = report["ok"] and report["errorClass"] == "None"
    print(json.dumps(safe_summary(report), separators=(",", ":")))
    return 0 if report["ok"] else 2

if __name__ == "__main__":
    raise SystemExit(main())
