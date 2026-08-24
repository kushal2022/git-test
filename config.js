'use strict';

/**
 * Configuration. Everything comes from environment variables so no
 * credentials ever land in a file that gets committed.
 *
 * Set these in a .env file (see .env.example) or in your process manager.
 */

require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const servers = [
  {
    id: 'aspen',
    baseUrl: required('ASPEN_URL').replace(/\/+$/, ''),
    user: required('ASPEN_USER'),
    token: required('ASPEN_TOKEN'),
  },
  {
    id: 'aspen-plus',
    baseUrl: required('ASPEN_PLUS_URL').replace(/\/+$/, ''),
    user: required('ASPEN_PLUS_USER'),
    token: required('ASPEN_PLUS_TOKEN'),
  },
];

module.exports = {
  servers,

  // Where the SQLite file lives.
  dbPath: process.env.DB_PATH || './jenkins-monitor.db',

  // How often to refresh current build status (milliseconds).
  statusIntervalMs: Number(process.env.STATUS_INTERVAL_MS || 60_000),

  // How often to refresh build history for duration averages (milliseconds).
  historyIntervalMs: Number(process.env.HISTORY_INTERVAL_MS || 600_000),

  // How many past builds to keep per pipeline.
  historyDepth: Number(process.env.HISTORY_DEPTH || 20),

  // Optional regex. If set, only job paths matching it are tracked.
  // Example: JOB_FILTER="^(DEV|QA|UAT|PROD)"
  jobFilter: process.env.JOB_FILTER ? new RegExp(process.env.JOB_FILTER) : null,

  // Data older than this is flagged stale in the API response.
  staleAfterMs: Number(process.env.STALE_AFTER_MS || 180_000),

  // HTTP timeout for a single Jenkins call.
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 20_000),

  port: Number(process.env.PORT || 3001),
};
