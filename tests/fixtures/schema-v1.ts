import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

/** Create the exact structural v1 store needed to prove sequential migration. */
export function createSchemaV1(path: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE store_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        store_id TEXT NOT NULL
      ) STRICT;
      INSERT INTO store_meta VALUES (1, 1, '${randomUUID()}');
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
        retry_of TEXT REFERENCES runs(id)
      ) STRICT;
      CREATE UNIQUE INDEX runs_idempotency ON runs(trigger_kind, trigger_source_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX runs_claim_order ON runs(state, available_at, priority DESC, created_at, id);
      CREATE TABLE attempts (
        run_id TEXT NOT NULL REFERENCES runs(id), attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
        state TEXT NOT NULL CHECK (state IN ('claimed','running','cancelling','succeeded','failed','cancelled','lost','indeterminate')),
        worker_id TEXT NOT NULL, lease_token TEXT NOT NULL UNIQUE, lease_expires_at INTEGER NOT NULL,
        session_id TEXT NOT NULL UNIQUE, claimed_at INTEGER NOT NULL, dispatched_at INTEGER,
        finished_at INTEGER, outcome TEXT, result_excerpt TEXT, error TEXT,
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
      INSERT INTO runs VALUES (
        'run-v1', 'queued', 'migrate me',
        '{"kind":"fresh","cwd":"/workspace"}',
        '{"kind":"manual","sourceId":"legacy","occurrenceId":"old-1"}',
        'manual', 'legacy', NULL, 0, 1, 0, NULL, 10, 10, 10, NULL, NULL, NULL, NULL, NULL, NULL
      );
      PRAGMA user_version = 1;
    `)
  } finally {
    db.close()
  }
}
