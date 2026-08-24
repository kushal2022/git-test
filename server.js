'use strict';

const express = require('express');
const cors = require('cors');
const { port, staleAfterMs, historyDepth } = require('./config');
const store = require('./db');
const collector = require('./collector');

const app = express();
app.use(cors());

/**
 * Turn a raw DB row into something the dashboard can render directly,
 * including progress for in-flight builds.
 *
 * Jenkins reports duration: 0 while a build is running, so elapsed time
 * has to be computed from the start timestamp.
 */
function decorate(row) {
  const now = Date.now();
  const building = row.building === 1;

  const { avg_ms: avgMs, n } = store.avgDuration(row.server, row.env);
  // Prefer our own observed average; fall back to Jenkins' estimate.
  const baseline = n >= 3 && avgMs > 0 ? Math.round(avgMs) : (row.estimated_ms || null);

  let elapsedMs = null;
  let progressPct = null;
  let etaMs = null;

  if (building && row.started_at) {
    elapsedMs = now - row.started_at;
    if (baseline > 0) {
      // Cap at 99 — a build that overruns its estimate is still running.
      progressPct = Math.min(99, Math.round((elapsedMs / baseline) * 100));
      etaMs = Math.max(0, baseline - elapsedMs);
    }
  }

  return {
    server: row.server,
    env: row.env,
    jobUrl: row.job_url,
    buildNumber: row.build_number,
    startedAt: row.started_at,
    // Actual duration for finished builds, elapsed so far for running ones.
    durationMs: building ? elapsedMs : row.duration_ms,
    status: building ? 'IN_PROGRESS' : (row.result || 'UNKNOWN'),
    building,
    progressPct,
    etaMs,
    avgDurationMs: baseline,
    fetchedAt: row.fetched_at,
    stale: now - row.fetched_at > staleAfterMs,
  };
}

/** Everything the dashboard needs, in one instant response. */
app.get('/api/status', (req, res) => {
  const now = Date.now();

  const health = {};
  for (const h of store.allHealth()) {
    health[h.server] = {
      lastSuccessAt: h.last_success_at,
      lastError: h.last_error,
      lastErrorAt: h.last_error_at,
      healthy: h.last_success_at != null && now - h.last_success_at <= staleAfterMs,
    };
  }

  const pipelines = store.allStatus().map(decorate);

  res.json({
    generatedAt: now,
    servers: health,
    counts: {
      total: pipelines.length,
      running: pipelines.filter((p) => p.building).length,
      failed: pipelines.filter((p) => p.status === 'FAILURE').length,
    },
    pipelines,
  });
});

/** Build history for one pipeline — for trend charts or a drill-down view. */
app.get('/api/history/:server/:env(*)', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || historyDepth, 100);
  const builds = store.recentBuilds(req.params.server, req.params.env, limit);
  res.json({ server: req.params.server, env: req.params.env, builds });
});

/** Force an immediate refresh, e.g. behind a "Refresh" button. */
app.post('/api/refresh', async (req, res) => {
  await collector.statusRound();
  res.json({ ok: true, refreshedAt: Date.now() });
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Run collector in the same process. To split them onto separate
// processes, delete this line and run `node collector.js` alongside.
collector.start();

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
