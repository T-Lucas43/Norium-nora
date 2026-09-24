CREATE TABLE IF NOT EXISTS scheduling_team_settings (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS scheduling_professionals (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT NOT NULL DEFAULT '',
  profession TEXT NOT NULL DEFAULT '',
  position TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#6d5dfc',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_sched_professional_scope ON scheduling_professionals(tenant_id, workspace_id, active);

CREATE TABLE IF NOT EXISTS scheduling_service_professionals (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, workspace_id, service_id, user_id),
  FOREIGN KEY(service_id) REFERENCES scheduling_services(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sched_service_professional ON scheduling_service_professionals(tenant_id, workspace_id, user_id, service_id);
