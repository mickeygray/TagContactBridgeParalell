"use strict";

// GATHER SESSION — pull once, reuse everywhere inside one report.
//
// Mickey 2026-07-28: "once you pull the activities once store them somewhere
// you can pull that same list again but pull them once per report generated."
//
// The composer already unions block `needs` so payments+activity share one
// gather — but a report is not always one gather. Recordings, post-date
// billing, lag and cohort steps each want activity for the same window, and
// a multi-step plan (Part 3) can revisit it again. Without a session those
// are separate API calls for identical data.
//
// A session is a MEMO, not a store:
//   · keyed by (domain, from, to) — the exact identity of a pull
//   · lives for one report run
//   · optionally survives a few minutes on disk so a re-run, a CSV export
//     right after a view, or a confirm-then-run does not re-pull
//
// It is storage class (c) from the doctrine: droppable, rebuildable, never
// authoritative. Delete the cache directory and nothing is lost but time.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_TTL_MS = 10 * 60 * 1000;   // 10 minutes
const CACHE_DIR_NAME = "gather-cache";

function keyOf(kind, domain, from, to) {
  return `${kind}:${String(domain).toUpperCase()}:${from}:${to}`;
}

function fileNameFor(key) {
  return `${crypto.createHash("sha1").update(key).digest("hex").slice(0, 20)}.json`;
}

/**
 * @param {object} opts
 * @param {number} opts.ttlMs        disk reuse window (0 disables disk)
 * @param {string} opts.cacheDir     defaults to <ROOT>/runtime/gather-cache
 * @param {object} opts.logger
 */
function createGatherSession({ ttlMs = DEFAULT_TTL_MS, cacheDir = null, logger = null } = {}) {
  const memo = new Map();          // key -> Promise<rows>
  const stats = { pulls: 0, memoHits: 0, diskHits: 0, writes: 0 };

  let dir = cacheDir;
  if (dir === null && ttlMs > 0) {
    try {
      const { ROOT_DIR } = require("../../shared-config/src");
      dir = path.join(ROOT_DIR, "runtime", CACHE_DIR_NAME);
    } catch { dir = null; }
  }

  function readDisk(key) {
    if (!dir || ttlMs <= 0) return null;
    try {
      const file = path.join(dir, fileNameFor(key));
      if (!fs.existsSync(file)) return null;
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw.key !== key) return null;                       // hash collision guard
      if (Date.now() - Number(raw.at || 0) > ttlMs) return null;
      return raw.rows;
    } catch { return null; }
  }

  function writeDisk(key, rows) {
    if (!dir || ttlMs <= 0) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, fileNameFor(key)),
        JSON.stringify({ key, at: Date.now(), rows }),
      );
      stats.writes += 1;
    } catch { /* a cache that cannot write is still a working session */ }
  }

  /**
   * Memoized fetch. `produce()` runs at most once per key per session.
   * Concurrent callers share the in-flight promise rather than racing —
   * two blocks asking simultaneously must not become two API calls.
   */
  async function fetch(kind, { domain, from, to }, produce) {
    const key = keyOf(kind, domain, from, to);
    if (memo.has(key)) {
      stats.memoHits += 1;
      return memo.get(key);
    }
    const disk = readDisk(key);
    if (disk) {
      stats.diskHits += 1;
      logger?.info?.(`  cache: reused ${kind} ${domain} ${from}→${to} (${disk.length} rows)`);
      const settled = Promise.resolve(disk);
      memo.set(key, settled);
      return settled;
    }
    const pending = (async () => {
      const rows = await produce();
      stats.pulls += 1;
      writeDisk(key, rows);
      return rows;
    })();
    memo.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      memo.delete(key);          // a failed pull must not poison the session
      throw error;
    }
  }

  return {
    fetch,
    stats: () => ({ ...stats }),
    describe: () => `${stats.pulls} pull(s) · ${stats.memoHits} memo hit(s) · ${stats.diskHits} disk hit(s)`,
    clear: () => memo.clear(),
  };
}

/** Drop cache files older than ttl. Safe to call any time; never throws. */
function pruneGatherCache({ ttlMs = DEFAULT_TTL_MS, cacheDir = null } = {}) {
  let dir = cacheDir;
  if (!dir) {
    try {
      const { ROOT_DIR } = require("../../shared-config/src");
      dir = path.join(ROOT_DIR, "runtime", CACHE_DIR_NAME);
    } catch { return { removed: 0 }; }
  }
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Date.now() - Number(raw.at || 0) > ttlMs) { fs.unlinkSync(file); removed += 1; }
      } catch { try { fs.unlinkSync(file); removed += 1; } catch { /* ignore */ } }
    }
  } catch { /* no cache dir yet */ }
  return { removed };
}

module.exports = { DEFAULT_TTL_MS, createGatherSession, pruneGatherCache };
