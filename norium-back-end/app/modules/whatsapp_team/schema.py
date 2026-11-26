"""Additive metadata tables; no messages or provider credentials are copied."""
from app.infrastructure.persistence import postgres_store


def initialize(db) -> None:
    # Run within the caller transaction: a rolled back DDL must never set a
    # process-wide initialized flag that would hide an absent table.
    row = db.execute("SELECT version FROM norium_schema WHERE component='whatsapp_team'").fetchone()
    if row:
        if row["version"] != 1:
            raise postgres_store.PostgresStoreError("whatsapp_team_schema_unsupported")
        return
    db.execute("SELECT pg_advisory_xact_lock(%s)", (711904213,))
    row = db.execute("SELECT version FROM norium_schema WHERE component='whatsapp_team'").fetchone()
    if row:
        if row["version"] != 1:
            raise postgres_store.PostgresStoreError("whatsapp_team_schema_unsupported")
        return
    db.execute("""CREATE TABLE IF NOT EXISTS norium_whatsapp_team_inboxes (
        tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        binding_id TEXT NOT NULL, payload JSONB NOT NULL,
        PRIMARY KEY(tenant_id,workspace_id,owner_id,binding_id))""")
    db.execute("""CREATE TABLE IF NOT EXISTS norium_whatsapp_team_assignments (
        tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        binding_id TEXT NOT NULL, id TEXT NOT NULL, payload JSONB NOT NULL,
        PRIMARY KEY(tenant_id,workspace_id,owner_id,binding_id,id))""")
    db.execute("""CREATE TABLE IF NOT EXISTS norium_whatsapp_team_events (
        tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        binding_id TEXT NOT NULL, id TEXT NOT NULL, payload JSONB NOT NULL,
        PRIMARY KEY(tenant_id,workspace_id,owner_id,binding_id,id))""")
    db.execute("""CREATE TABLE IF NOT EXISTS norium_whatsapp_team_notes (
        tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        binding_id TEXT NOT NULL, id TEXT NOT NULL, payload JSONB NOT NULL,
        PRIMARY KEY(tenant_id,workspace_id,owner_id,binding_id,id))""")
    db.execute("""CREATE INDEX IF NOT EXISTS norium_whatsapp_team_assignment_filter
        ON norium_whatsapp_team_assignments
        (tenant_id,workspace_id,owner_id,binding_id,(payload->>'assigneeUserId'),(payload->>'status'))""")
    db.execute("""CREATE INDEX IF NOT EXISTS norium_whatsapp_team_event_conversation
        ON norium_whatsapp_team_events
        (tenant_id,workspace_id,owner_id,binding_id,(payload->>'conversationId'),(payload->>'createdAt'))""")
    db.execute("""CREATE INDEX IF NOT EXISTS norium_whatsapp_team_note_conversation
        ON norium_whatsapp_team_notes
        (tenant_id,workspace_id,owner_id,binding_id,(payload->>'conversationId'),(payload->>'createdAt'))""")
    db.execute("INSERT INTO norium_schema(component,version) VALUES ('whatsapp_team',1)")


def postgres_enabled() -> bool:
    return postgres_store.configured() or postgres_store.required()
