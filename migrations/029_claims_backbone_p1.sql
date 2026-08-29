-- Backbone durable para Claims y futuros canales (P1).
CREATE TABLE IF NOT EXISTS integration_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  source TEXT NOT NULL,
  external_event_id TEXT,
  resource_id TEXT,
  thread_id TEXT,
  actor_id TEXT,
  payload_version TEXT,
  occurred_at TEXT,
  received_at TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  priority INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','failed','dead_lettered'))
);
CREATE INDEX IF NOT EXISTS idx_integration_events_status ON integration_events(status, received_at);
CREATE INDEX IF NOT EXISTS idx_integration_events_correlation ON integration_events(correlation_id);

CREATE TABLE IF NOT EXISTS integration_jobs (
  job_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES integration_events(event_id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  available_at TEXT NOT NULL,
  locked_at TEXT,
  locked_by TEXT,
  lease_until TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  last_error_code TEXT,
  last_error_message TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','failed','dead_lettered')),
  UNIQUE(event_id, job_type)
);
CREATE INDEX IF NOT EXISTS idx_integration_jobs_claim ON integration_jobs(status, available_at, lease_until);

CREATE TABLE IF NOT EXISTS integration_event_history (
  history_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES integration_events(event_id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  error_code TEXT,
  resource_id TEXT,
  correlation_id TEXT NOT NULL,
  retryable INTEGER,
  attempts INTEGER,
  safe_message TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_integration_history_event ON integration_event_history(event_id, created_at);

CREATE TABLE IF NOT EXISTS inbox_items (
  inbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES integration_events(event_id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  resource_id TEXT,
  conversation_id INTEGER,
  title TEXT NOT NULL,
  preview TEXT,
  status TEXT NOT NULL DEFAULT 'unread'
    CHECK (status IN ('unread','read','resolved','archived')),
  assigned_user_id INTEGER,
  assigned_role TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(event_id)
);
CREATE INDEX IF NOT EXISTS idx_inbox_items_status ON inbox_items(status, updated_at);

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  external_thread_id TEXT,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','assigned','resolved','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(channel, external_thread_id)
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  message_id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  event_id TEXT REFERENCES integration_events(event_id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  external_message_id TEXT,
  body TEXT,
  body_redacted INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(conversation_id, external_message_id)
);

CREATE TABLE IF NOT EXISTS user_notifications (
  notification_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT REFERENCES integration_events(event_id) ON DELETE SET NULL,
  inbox_id INTEGER REFERENCES inbox_items(inbox_id) ON DELETE SET NULL,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  deep_link TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','failed','expired')),
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_notifications_user ON user_notifications(user_id, status, created_at);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  delivery_id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL REFERENCES user_notifications(notification_id) ON DELETE CASCADE,
  device_id INTEGER,
  provider TEXT,
  provider_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','failed','expired')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  lease_until TEXT,
  last_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(notification_id, device_id, provider)
);

-- La versión global la administra el runner JavaScript, nunca este SQL aislado.
