'use strict';

const Database = require('better-sqlite3');
const { dbPath, historyDepth } = require('./config');

const db = new Database(dbPath);

// WAL lets the API read while the collector writes, with no blocking.
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS pipeline_status (
    server        TEXT    NOT NULL,
    env           TEXT    NOT NULL,
    job_url       TEXT,
    build_number  INTEGER,
    started_at    INTEGER,   -- epoch ms, build start
    duration_ms   INTEGER,   -- 0 while building
    estimated_ms  INTEGER,   -- Jenkins' own guess
    result        TEXT,      -- SUCCESS | FAILURE | UNSTABLE | ABORTED | NULL
    building      INTEGER NOT NULL DEFAULT 0,
    fetched_at    INTEGER NOT NULL,
    PRIMARY KEY (server, env)
  );

  CREATE TABLE IF NOT EXISTS build_history (
    server        TEXT    NOT NULL,
    env           TEXT    NOT NULL,
    build_number  INTEGER NOT NULL,
    started_at    INTEGER,
    duration_ms   INTEGER,
    result        TEXT,
    PRIMARY KEY (server, env, build_number)
  );

  CREATE INDEX IF NOT EXISTS idx_history_lookup
    ON build_history (server, env, started_at DESC);

  CREATE TABLE IF NOT EXISTS collector_health (
    server          TEXT PRIMARY KEY,
    last_success_at INTEGER,
    last_error      TEXT,
    last_error_at   INTEGER
  );
`);

const stmts = {
  upsertStatus: db.prepare(`
    INSERT INTO pipeline_status
      (server, env, job_url, build_number, started_at, duration_ms,
       estimated_ms, result, building, fetched_at)
    VALUES
      (@server, @env, @job_url, @build_number, @started_at, @duration_ms,
       @estimated_ms, @result, @building, @fetched_at)
    ON CONFLICT(server, env) DO UPDATE SET
      job_url      = excluded.job_url,
      build_number = excluded.build_number,
      started_at   = excluded.started_at,
      duration_ms  = excluded.duration_ms,
      estimated_ms = excluded.estimated_ms,
      result       = excluded.result,
      building     = excluded.building,
      fetched_at   = excluded.fetched_at
  `),

  insertHistory: db.prepare(`
    INSERT OR IGNORE INTO build_history
      (server, env, build_number, started_at, duration_ms, result)
    VALUES (?, ?, ?, ?, ?, ?)
  `),

  trimHistory: db.prepare(`
    DELETE FROM build_history
    WHERE server = ? AND env = ?
      AND build_number NOT IN (
        SELECT build_number FROM build_history
        WHERE server = ? AND env = ?
        ORDER BY build_number DESC LIMIT ?
      )
  `),

  markSuccess: db.prepare(`
    INSERT INTO collector_health (server, last_success_at)
    VALUES (?, ?)
    ON CONFLICT(server) DO UPDATE SET last_success_at = excluded.last_success_at
  `),

  markError: db.prepare(`
    INSERT INTO collector_health (server, last_error, last_error_at)
    VALUES (?, ?, ?)
    ON CONFLICT(server) DO UPDATE SET
      last_error    = excluded.last_error,
      last_error_at = excluded.last_error_at
  `),

  allStatus: db.prepare(`SELECT * FROM pipeline_status ORDER BY server, env`),

  allHealth: db.prepare(`SELECT * FROM collector_health`),

  // Median-ish duration from recent successful builds, used for progress bars.
  avgDuration: db.prepare(`
    SELECT AVG(duration_ms) AS avg_ms, COUNT(*) AS n
    FROM (
      SELECT duration_ms FROM build_history
      WHERE server = ? AND env = ?
        AND result = 'SUCCESS' AND duration_ms > 0
      ORDER BY build_number DESC LIMIT 10
    )
  `),

  recentBuilds: db.prepare(`
    SELECT build_number, started_at, duration_ms, result
    FROM build_history
    WHERE server = ? AND env = ?
    ORDER BY build_number DESC LIMIT ?
  `),
};

const saveStatusBatch = db.transaction((rows) => {
  for (const row of rows) stmts.upsertStatus.run(row);
});

const saveHistoryBatch = db.transaction((server, env, builds) => {
  for (const b of builds) {
    stmts.insertHistory.run(server, env, b.number, b.timestamp, b.duration, b.result);
  }
  stmts.trimHistory.run(server, env, server, env, historyDepth);
});

module.exports = {
  db,
  saveStatusBatch,
  saveHistoryBatch,
  markSuccess: (server, at) => stmts.markSuccess.run(server, at),
  markError: (server, msg, at) => stmts.markError.run(server, msg, at),
  allStatus: () => stmts.allStatus.all(),
  allHealth: () => stmts.allHealth.all(),
  avgDuration: (server, env) => stmts.avgDuration.get(server, env),
  recentBuilds: (server, env, limit) => stmts.recentBuilds.all(server, env, limit),
};
