PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS scheduling_services (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),
  durations_json TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6d5dfc',
  location_type TEXT NOT NULL DEFAULT 'online',
  location TEXT NOT NULL DEFAULT '' CHECK(length(location) <= 500),
  instructions TEXT NOT NULL DEFAULT '' CHECK(length(instructions) <= 2000),
  buffer_before INTEGER NOT NULL DEFAULT 0 CHECK(buffer_before BETWEEN 0 AND 1440),
  buffer_after INTEGER NOT NULL DEFAULT 0 CHECK(buffer_after BETWEEN 0 AND 1440),
  capacity INTEGER NOT NULL DEFAULT 1 CHECK(capacity BETWEEN 1 AND 500),
  minimum_notice_minutes INTEGER NOT NULL DEFAULT 0 CHECK(minimum_notice_minutes BETWEEN 0 AND 525600),
  maximum_days INTEGER NOT NULL DEFAULT 60 CHECK(maximum_days BETWEEN 1 AND 730),
  slot_interval INTEGER NOT NULL DEFAULT 15 CHECK(slot_interval BETWEEN 5 AND 1440),
  active INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sched_service_scope ON scheduling_services(tenant_id, workspace_id, owner_id, active);

CREATE TABLE IF NOT EXISTS scheduling_availability (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  service_id TEXT,
  timezone TEXT NOT NULL,
  weekly_json TEXT NOT NULL,
  exceptions_json TEXT NOT NULL DEFAULT '{}',
  blocked_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(service_id) REFERENCES scheduling_services(id) ON DELETE CASCADE,
  UNIQUE(tenant_id, workspace_id, owner_id, service_id)
);
CREATE INDEX IF NOT EXISTS idx_sched_availability_scope ON scheduling_availability(tenant_id, workspace_id, owner_id, service_id);

CREATE TABLE IF NOT EXISTS scheduling_pages (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  slug TEXT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),
  theme_json TEXT NOT NULL DEFAULT '{}',
  fields_json TEXT NOT NULL DEFAULT '[]',
  logo_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(service_id) REFERENCES scheduling_services(id) ON DELETE RESTRICT,
  UNIQUE(tenant_id, workspace_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_sched_page_scope ON scheduling_pages(tenant_id, workspace_id, owner_id, service_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sched_page_public_slug ON scheduling_pages(slug) WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS scheduling_holds (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  page_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  responsible_id TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(page_id) REFERENCES scheduling_pages(id) ON DELETE CASCADE,
  FOREIGN KEY(service_id) REFERENCES scheduling_services(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sched_hold_slot ON scheduling_holds(service_id, responsible_id, start_at, expires_at);

CREATE TABLE IF NOT EXISTS scheduling_bookings (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  responsible_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  client_id TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING','CONFIRMED','CANCELLED','COMPLETED','NO_SHOW','RESCHEDULED')),
  attendee_name TEXT NOT NULL CHECK(length(attendee_name) BETWEEN 1 AND 160),
  attendee_email TEXT NOT NULL CHECK(length(attendee_email) <= 254),
  attendee_phone TEXT CHECK(length(attendee_phone) <= 32),
  responses_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'public',
  cancel_token_hash TEXT NOT NULL UNIQUE,
  reschedule_token_hash TEXT NOT NULL UNIQUE,
  idempotency_key TEXT,
  external_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(service_id) REFERENCES scheduling_services(id) ON DELETE RESTRICT,
  FOREIGN KEY(page_id) REFERENCES scheduling_pages(id) ON DELETE RESTRICT,
  UNIQUE(page_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_sched_booking_scope ON scheduling_bookings(tenant_id, workspace_id, owner_id, start_at);
CREATE INDEX IF NOT EXISTS idx_sched_booking_conflict ON scheduling_bookings(responsible_id, start_at, end_at, status);
CREATE INDEX IF NOT EXISTS idx_sched_booking_service_slot ON scheduling_bookings(service_id, responsible_id, start_at, status);

CREATE TABLE IF NOT EXISTS scheduling_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sched_audit_scope ON scheduling_audit(tenant_id, workspace_id, created_at);
