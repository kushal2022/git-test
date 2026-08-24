# Jenkins Pipeline Monitor

Polls both Jenkins servers on a schedule, stores the results in SQLite, and
serves them to your dashboard instantly.

## Why this is faster

Your dashboard is slow for two reasons, and this fixes both.

**Reason 1 — too many HTTP calls.** Calling `/job/<name>/lastBuild/api/json`
per pipeline means 32 round trips. Jenkins can return everything in **one call
per server** using the `tree` parameter:

```
/api/json?tree=jobs[name,url,lastBuild[number,timestamp,duration,estimatedDuration,result,building]]
```

**Reason 2 — Jenkins is in the request path.** Right now every page load waits
on Jenkins. Here, a background collector talks to Jenkins on its own schedule
and the dashboard only ever reads SQLite. Response time stops depending on how
Jenkins feels.

```
  cron (60s)                     on page load
Jenkins ──────► collector ──► SQLite ──► API ──► dashboard
                                          (~1ms)
```

## Why SQLite and not a free cloud tier

Supabase, Neon, and MongoDB Atlas all have usable free tiers, but for this job
they are worse:

- **Latency.** A network hop to a cloud DB partly undoes the speedup you came for.
- **Scale.** 32 rows refreshed every minute. SQLite will never be the bottleneck.
- **Compliance.** This is State of New Mexico HSD infrastructure. Job names,
  URLs, and build metadata leaving your environment for a free third-party tier
  is a question worth clearing with the engagement before you do it, not after.

Swap in Postgres later if several services need to read the same data. The
schema ports over unchanged.

## Setup

```bash
npm install
cp .env.example .env    # fill in URLs and API tokens
npm start               # API + collector on port 3001
```

Generate API tokens per server at:
`<jenkins>/user/<your-username>/configure` → **Add new Token**.
Use tokens, not passwords — and keep them in `.env`, which is gitignored.

If your jobs live inside folders, the collector already recurses three levels
deep and reports them as `folder/job`. Deeper than that, bump the depth
argument in `jenkins.js`.

To run the collector as its own process instead, delete the
`collector.start()` line in `server.js` and run `npm run collector` alongside.

## API

### `GET /api/status`

Everything the dashboard needs, in one response.

```json
{
  "generatedAt": 1787576270277,
  "servers": {
    "aspen": { "lastSuccessAt": 1787576266426, "lastError": null, "healthy": true }
  },
  "counts": { "total": 32, "running": 2, "failed": 1 },
  "pipelines": [
    {
      "server": "aspen",
      "env": "DEV",
      "jobUrl": "https://.../job/DEV/",
      "buildNumber": 42,
      "startedAt": 1787575863771,
      "durationMs": 406506,
      "status": "IN_PROGRESS",
      "building": true,
      "progressPct": 87,
      "etaMs": 41000,
      "avgDurationMs": 236000,
      "fetchedAt": 1787576266425,
      "stale": false
    }
  ]
}
```

`status` is `IN_PROGRESS` while building, otherwise Jenkins' result
(`SUCCESS`, `FAILURE`, `UNSTABLE`, `ABORTED`).

### `GET /api/history/:server/:env?limit=20`

Recent builds for one pipeline — for trend charts or a drill-down panel.

### `POST /api/refresh`

Forces an immediate poll. Wire this to a Refresh button.

## Details worth knowing

**Running builds report `duration: 0`.** Jenkins only fills in `duration` once a
build finishes, so elapsed time is computed from `startedAt`. The API returns
elapsed-so-far in `durationMs` for running builds and the real duration for
finished ones.

**Progress bars use your own averages.** `estimatedDuration` from Jenkins is
often stale. Once there are 3+ successful builds in history, the average of the
last 10 is used instead, falling back to Jenkins' estimate before that.
Progress caps at 99% so an overrunning build doesn't display as complete.

**A failed poll keeps the last good data.** The collector never clears rows on
error. Instead `stale: true` and `servers.<id>.healthy: false` tell the
dashboard to show a "last updated at …" warning. A slightly old dashboard beats
a blank one, and it means one Jenkins going down doesn't take out the view of
the other.

**History is capped** at 20 builds per pipeline (`HISTORY_DEPTH`) and trimmed on
every write, so the DB file stays small indefinitely.

## Tuning

| Variable | Default | Notes |
|---|---|---|
| `STATUS_INTERVAL_MS` | 60000 | Drop to 15–30s if you want snappier in-progress updates |
| `HISTORY_INTERVAL_MS` | 600000 | History changes slowly; no need to poll it often |
| `HISTORY_DEPTH` | 20 | Builds retained per pipeline |
| `STALE_AFTER_MS` | 180000 | When to flag data as stale |
| `JOB_FILTER` | unset | Regex to track only matching job paths |
