'use strict';

const { servers, statusIntervalMs, historyIntervalMs } = require('./config');
const { fetchStatus, fetchHistory } = require('./jenkins');
const store = require('./db');

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function collectStatus(server) {
  try {
    const rows = await fetchStatus(server);
    store.saveStatusBatch(rows);
    store.markSuccess(server.id, Date.now());
    log(`status  ${server.id}: ${rows.length} pipelines`);
  } catch (err) {
    // Deliberately do NOT clear existing rows. A failed poll should leave
    // the last known good snapshot in place; the API flags it as stale.
    store.markError(server.id, err.message, Date.now());
    log(`status  ${server.id}: FAILED - ${err.message}`);
  }
}

async function collectHistory(server) {
  try {
    const jobs = await fetchHistory(server);
    let total = 0;
    for (const { env, builds } of jobs) {
      if (builds.length) {
        store.saveHistoryBatch(server.id, env, builds);
        total += builds.length;
      }
    }
    log(`history ${server.id}: ${total} builds across ${jobs.length} pipelines`);
  } catch (err) {
    log(`history ${server.id}: FAILED - ${err.message}`);
  }
}

async function statusRound() {
  // Both servers in parallel — a slow Jenkins should not delay the other.
  await Promise.all(servers.map(collectStatus));
}

async function historyRound() {
  await Promise.all(servers.map(collectHistory));
}

function start() {
  log(`collector starting: ${servers.length} servers, ` +
      `status every ${statusIntervalMs / 1000}s, ` +
      `history every ${historyIntervalMs / 1000}s`);

  statusRound();
  historyRound();

  setInterval(statusRound, statusIntervalMs);
  setInterval(historyRound, historyIntervalMs);
}

module.exports = { start, statusRound, historyRound };

if (require.main === module) start();
