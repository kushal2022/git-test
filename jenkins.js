'use strict';

const { fetchTimeoutMs, jobFilter, historyDepth } = require('./config');

/**
 * The whole point of this file: ask Jenkins for everything in ONE request
 * using the `tree` parameter, instead of hitting /job/<name>/lastBuild/api/json
 * 16 times per server.
 *
 * The nesting below handles jobs sitting up to 3 folder levels deep. Add
 * another level if your instance is organised more deeply than that.
 */

const BUILD_FIELDS = 'number,timestamp,duration,estimatedDuration,result,building';

function nest(inner, depth) {
  let tree = inner;
  for (let i = 0; i < depth; i++) {
    tree = `jobs[name,url,${inner},${tree}]`;
  }
  return `jobs[name,url,${inner},${tree}]`;
}

const STATUS_TREE = nest(`lastBuild[${BUILD_FIELDS}]`, 2);
const HISTORY_TREE = nest(`builds[${BUILD_FIELDS}]{0,${historyDepth}}`, 2);

function authHeader(server) {
  const raw = `${server.user}:${server.token}`;
  return 'Basic ' + Buffer.from(raw).toString('base64');
}

async function callJenkins(server, tree) {
  const url = `${server.baseUrl}/api/json?tree=${encodeURIComponent(tree)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);

  try {
    const res = await fetch(url, {
      headers: { Authorization: authHeader(server), Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} from ${server.id}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk the folder tree and return a flat list of real jobs.
 * A node with a `jobs` array is a folder; anything else is a job.
 */
function flatten(node, prefix = []) {
  const out = [];
  for (const child of node.jobs || []) {
    const path = [...prefix, child.name];
    if (Array.isArray(child.jobs)) {
      out.push(...flatten(child, path));
    } else {
      out.push({ env: path.join('/'), url: child.url, node: child });
    }
  }
  return out;
}

function applyFilter(jobs) {
  if (!jobFilter) return jobs;
  return jobs.filter((j) => jobFilter.test(j.env));
}

/** Current state of every pipeline on one server. One HTTP call. */
async function fetchStatus(server) {
  const json = await callJenkins(server, STATUS_TREE);
  const now = Date.now();

  return applyFilter(flatten(json)).map(({ env, url, node }) => {
    const b = node.lastBuild || {};
    return {
      server: server.id,
      env,
      job_url: url || null,
      build_number: b.number ?? null,
      started_at: b.timestamp ?? null,
      duration_ms: b.duration ?? null,
      estimated_ms: b.estimatedDuration ?? null,
      result: b.result ?? null,
      building: b.building ? 1 : 0,
      fetched_at: now,
    };
  });
}

/** Recent builds per pipeline, for duration averages. One HTTP call. */
async function fetchHistory(server) {
  const json = await callJenkins(server, HISTORY_TREE);

  return applyFilter(flatten(json)).map(({ env, node }) => ({
    env,
    builds: (node.builds || [])
      .filter((b) => !b.building && b.number != null)
      .map((b) => ({
        number: b.number,
        timestamp: b.timestamp ?? null,
        duration: b.duration ?? null,
        result: b.result ?? null,
      })),
  }));
}

module.exports = { fetchStatus, fetchHistory };
