PRAGMA foreign_keys = ON;

-- Tentativas de notificação por canal após reagendamento administrativo.
-- A chave de operação é estável por (reagendamento, canal) e impede que um
-- retry consciente reenvie um canal cujo recibo já foi verificado.
CREATE TABLE IF NOT EXISTS scheduling_notification_attempts (
  operation_key TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('gmail', 'whatsapp')),
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'failed')) DEFAULT 'pending',
  receipt_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (operation_key, channel),
  FOREIGN KEY(booking_id) REFERENCES scheduling_bookings(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_sched_notify_booking ON scheduling_notification_attempts(booking_id, updated_at);
