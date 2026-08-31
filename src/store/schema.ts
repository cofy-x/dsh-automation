/** Sequential, transactional SQLite schema creation and migration. */

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { AutomationError } from '../domain.ts'

/** Current on-disk schema. Unknown future readers fail closed. */
export const SCHEMA_VERSION = 2

export function initializeSchema(db: DatabaseSync): void {
  let version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) {
    throw new AutomationError('STORE_INCOMPATIBLE', `automation store schema ${version} is not supported by schema ${SCHEMA_VERSION}`)
  }
  if (version === 0) {
    createCurrentSchema(db)
    return
  }
  while (version < SCHEMA_VERSION) {
    if (version === 1) migrateV1ToV2(db)
    else throw new AutomationError('STORE_INCOMPATIBLE', `automation store schema ${version} has no migration to schema ${SCHEMA_VERSION}`)
    version += 1
  }
}

function createCurrentSchema(db: DatabaseSync): void {
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE store_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      store_id TEXT NOT NULL
    ) STRICT;
    INSERT INTO store_meta VALUES (1, ${SCHEMA_VERSION}, '${randomUUID()}');
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('queued','claimed','running','cancelling','succeeded','failed','cancelled','indeterminate')),
      prompt TEXT NOT NULL CHECK (length(trim(prompt)) > 0),
      target_json TEXT NOT NULL,
      trigger_json TEXT NOT NULL,
      trigger_kind TEXT NOT NULL,
      trigger_source_id TEXT NOT NULL,
      idempotency_key TEXT,
      priority INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
      current_attempt INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      available_at INTEGER NOT NULL,
      cancel_requested_at INTEGER,
      final_session_id TEXT,
      outcome TEXT,
      result_excerpt TEXT,
      error TEXT,
      retry_of TEXT REFERENCES runs(id),
      trigger_occurrence_id TEXT,
      concurrency_key TEXT,
      concurrency_limit INTEGER CHECK (concurrency_limit IS NULL OR (concurrency_limit >= 1 AND concurrency_limit <= 1000))
    ) STRICT;
    CREATE UNIQUE INDEX runs_idempotency ON runs(trigger_kind, trigger_source_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX runs_claim_order ON runs(state, available_at, priority DESC, created_at, id);
    CREATE INDEX runs_by_trigger ON runs(trigger_kind, trigger_source_id, created_at DESC, id DESC);
    CREATE INDEX runs_active_concurrency ON runs(concurrency_key, state) WHERE concurrency_key IS NOT NULL;
    CREATE TABLE attempts (
      run_id TEXT NOT NULL REFERENCES runs(id),
      attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
      state TEXT NOT NULL CHECK (state IN ('claimed','running','cancelling','succeeded','failed','cancelled','lost','indeterminate')),
      worker_id TEXT NOT NULL,
      lease_token TEXT NOT NULL UNIQUE,
      lease_expires_at INTEGER NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      claimed_at INTEGER NOT NULL,
      dispatched_at INTEGER,
      finished_at INTEGER,
      outcome TEXT,
      result_excerpt TEXT,
      error TEXT,
      PRIMARY KEY (run_id, attempt_no)
    ) STRICT;
    CREATE INDEX attempts_expired ON attempts(state, lease_expires_at);
    CREATE TABLE run_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id),
      at INTEGER NOT NULL,
      type TEXT NOT NULL,
      data_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX run_events_by_run ON run_events(run_id, seq);
    CREATE TABLE event_consumers (
      consumer_id TEXT PRIMARY KEY,
      last_seq INTEGER NOT NULL CHECK (last_seq >= 0),
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE event_retention (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      pruned_through_seq INTEGER NOT NULL CHECK (pruned_through_seq >= 0)
    ) STRICT;
    INSERT INTO event_retention VALUES (1, 0);
    CREATE TABLE automation_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      mode TEXT NOT NULL CHECK (mode IN ('running','paused','draining')),
      paused_at INTEGER,
      pause_reason TEXT,
      updated_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO automation_control VALUES (1, 'running', NULL, NULL, 0);
    PRAGMA user_version = ${SCHEMA_VERSION};
    COMMIT;
  `)
}

function migrateV1ToV2(db: DatabaseSync): void {
  db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE runs ADD COLUMN trigger_occurrence_id TEXT;
    ALTER TABLE runs ADD COLUMN concurrency_key TEXT;
    ALTER TABLE runs ADD COLUMN concurrency_limit INTEGER CHECK (concurrency_limit IS NULL OR (concurrency_limit >= 1 AND concurrency_limit <= 1000));
    UPDATE runs SET trigger_occurrence_id = json_extract(trigger_json, '$.occurrenceId');
    CREATE INDEX runs_by_trigger ON runs(trigger_kind, trigger_source_id, created_at DESC, id DESC);
    CREATE INDEX runs_active_concurrency ON runs(concurrency_key, state) WHERE concurrency_key IS NOT NULL;
    CREATE TABLE automation_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      mode TEXT NOT NULL CHECK (mode IN ('running','paused','draining')),
      paused_at INTEGER,
      pause_reason TEXT,
      updated_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO automation_control VALUES (1, 'running', NULL, NULL, 0);
    CREATE TABLE event_consumers (
      consumer_id TEXT PRIMARY KEY,
      last_seq INTEGER NOT NULL CHECK (last_seq >= 0),
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE event_retention (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      pruned_through_seq INTEGER NOT NULL CHECK (pruned_through_seq >= 0)
    ) STRICT;
    INSERT INTO event_retention VALUES (1, 0);
    UPDATE store_meta SET schema_version = ${SCHEMA_VERSION} WHERE singleton = 1;
    PRAGMA user_version = ${SCHEMA_VERSION};
    COMMIT;
  `)
}
