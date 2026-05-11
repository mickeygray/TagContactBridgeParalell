"use strict";

const fs = require("fs");
const path = require("path");
const { SourceCanonical } = require("../../shared-models/src");

/**
 * Build a canonicalKey from a queue name. Slugified, collision-suffixed
 * with the tracking DID when present. Example:
 *   "3rd Day (Pink) Urgent Third State 800-921-9263"
 *   → "3rd-day-pink-urgent-third-state-8009219263"
 */
function slugifyQueueName(name, trackingDigits) {
  const base = String(name || "")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (trackingDigits) {
    // Suffix the DID so two queues that share a name but have different
    // tracking numbers (e.g. same mailer re-tooled across campaigns) don't
    // collide on the unique index.
    return `${base || "rc-queue"}-${trackingDigits}`;
  }
  return base || "rc-queue";
}

const DEFAULT_CSV_PATH = path.resolve(
  __dirname,
  "../../../ops/ringcentral-reference/rc-queues.csv",
);

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.slice(-10);
}

/**
 * Parse a single CSV line that may contain quoted fields with commas inside.
 */
function splitCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function parseRcQueuesCsv(contents) {
  const lines = contents.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const header = splitCsvLine(lines[0]).map((cell) =>
    cell.trim().replace(/^"|"$/g, ""),
  );
  const rows = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]).map((cell) =>
      cell.trim().replace(/^"|"$/g, ""),
    );
    const row = {};
    header.forEach((key, idx) => {
      row[key] = cells[idx] ?? "";
    });
    rows.push(row);
  }

  return rows;
}

/**
 * Extract 10-digit US phone numbers from anywhere in a string. Catches
 * tracking DIDs embedded in queue names like "C SNAP Urgent Notice State
 * 800-313-6634" or "Federal Reminder Letter (800) 849-5358".
 */
function extractPhoneCandidates(input) {
  const text = String(input || "");
  const results = new Set();

  // Toll-free and regular US numbers in various formats.
  const patterns = [
    /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
  ];

  for (const pattern of patterns) {
    const matches = text.match(pattern) || [];
    for (const match of matches) {
      const normalized = normalizeDigits(match);
      if (normalized.length === 10) results.add(normalized);
    }
  }

  return [...results];
}

/**
 * Build the tracking-number → canonical index so we can match queues to
 * SourceCanonical docs by any known tracking number in O(1).
 */
async function buildCanonicalIndex() {
  const canonicals = await SourceCanonical.find({
    $or: [
      { trackingNumbers: { $exists: true, $ne: [] } },
      { phoneNumbers: { $exists: true, $ne: [] } },
    ],
  });

  const byNumber = new Map();
  for (const canonical of canonicals) {
    const numbers = [
      ...(Array.isArray(canonical.trackingNumbers) ? canonical.trackingNumbers : []),
      ...(Array.isArray(canonical.phoneNumbers) ? canonical.phoneNumbers : []),
    ];
    for (const raw of numbers) {
      const digits = normalizeDigits(raw);
      if (digits && !byNumber.has(digits)) byNumber.set(digits, canonical);
    }
  }

  return { canonicals, byNumber };
}

/**
 * Seed / refresh `SourceCanonical.ringCentralExtensions` from the RC queues
 * CSV. For each queue with a matchable tracking DID (either in
 * `Toll_Free_Numbers` or embedded in the queue name), push the queue's RC_ID
 * and short Extension onto the canonical's `ringCentralExtensions` array.
 *
 * Idempotent — safe to rerun whenever the CSV gets regenerated.
 */
async function seedRingcentralExtensionsFromCsv({
  csvPath = DEFAULT_CSV_PATH,
  dryRun = false,
  autoCreateMissing = true,
  defaultChannel = "mail",
  defaultDomains = ["TAG"],
} = {}) {
  if (!fs.existsSync(csvPath)) {
    const err = new Error(`RC queues CSV not found at ${csvPath}`);
    err.status = 404;
    throw err;
  }

  const contents = fs.readFileSync(csvPath, "utf8");
  const rows = parseRcQueuesCsv(contents);
  const { canonicals, byNumber } = await buildCanonicalIndex();

  const matches = [];
  const unmatched = [];
  const created = [];

  for (const row of rows) {
    const candidates = new Set();
    for (const digits of extractPhoneCandidates(row.Toll_Free_Numbers)) {
      candidates.add(digits);
    }
    for (const digits of extractPhoneCandidates(row.Queue_Name)) {
      candidates.add(digits);
    }

    let canonical = null;
    let matchedNumber = null;
    for (const digits of candidates) {
      const hit = byNumber.get(digits);
      if (hit) {
        canonical = hit;
        matchedNumber = digits;
        break;
      }
    }

    if (!canonical) {
      if (candidates.size > 0 && autoCreateMissing) {
        // Auto-create a SourceCanonical for this queue. Gives us a complete
        // catalog of mailer queues without manual data entry, so legs[] can
        // attribute back to a named mailer even if CallRail misses the call.
        const trackingDigits = [...candidates][0];
        const canonicalKey = slugifyQueueName(row.Queue_Name, trackingDigits);
        if (dryRun) {
          created.push({
            queueName: row.Queue_Name,
            extension: row.Extension,
            rcId: row.RC_ID,
            trackingDigits,
            canonicalKey,
            wouldCreate: true,
          });
          continue;
        }
        try {
          const doc = await SourceCanonical.findOneAndUpdate(
            { canonicalKey },
            {
              $setOnInsert: {
                canonicalKey,
                internalName: row.Queue_Name || canonicalKey,
                channel: defaultChannel,
                domains: defaultDomains,
                active: true,
                flags: { mailer: true, digital: false, needsReview: true },
              },
              $addToSet: {
                trackingNumbers: trackingDigits,
                ringCentralExtensions: {
                  $each: [row.RC_ID, row.Extension]
                    .map((v) => String(v || "").trim())
                    .filter(Boolean),
                },
              },
            },
            { new: true, upsert: true, setDefaultsOnInsert: true },
          );
          // Update the in-memory index so later rows can find the new canonical.
          byNumber.set(trackingDigits, doc);
          created.push({
            queueName: row.Queue_Name,
            extension: row.Extension,
            rcId: row.RC_ID,
            trackingDigits,
            canonicalKey: doc.canonicalKey,
            canonicalId: String(doc._id),
          });
        } catch (err) {
          unmatched.push({
            queueName: row.Queue_Name,
            extension: row.Extension,
            rcId: row.RC_ID,
            candidates: [...candidates],
            createError: err.message,
          });
        }
        continue;
      }
      if (candidates.size > 0) {
        unmatched.push({
          queueName: row.Queue_Name,
          extension: row.Extension,
          rcId: row.RC_ID,
          candidates: [...candidates],
        });
      }
      continue;
    }

    const existing = new Set(
      (Array.isArray(canonical.ringCentralExtensions)
        ? canonical.ringCentralExtensions
        : []
      ).map((value) => String(value || "").trim()),
    );

    const toAdd = [];
    if (row.RC_ID && !existing.has(String(row.RC_ID))) toAdd.push(String(row.RC_ID));
    if (row.Extension && !existing.has(String(row.Extension))) toAdd.push(String(row.Extension));

    if (toAdd.length > 0 && !dryRun) {
      canonical.ringCentralExtensions = [...existing, ...toAdd];
      await canonical.save();
    }

    matches.push({
      queueName: row.Queue_Name,
      extension: row.Extension,
      rcId: row.RC_ID,
      matchedNumber,
      canonicalKey: canonical.canonicalKey,
      canonicalName: canonical.internalName,
      added: toAdd,
    });
  }

  return {
    csvPath,
    dryRun,
    autoCreateMissing,
    scannedQueues: rows.length,
    scannedCanonicals: canonicals.length,
    matchedQueues: matches.length,
    createdCanonicals: created.length,
    unmatchedQueues: unmatched.length,
    matches,
    created: created.slice(0, 100),
    unmatched: unmatched.slice(0, 50),
  };
}

module.exports = {
  DEFAULT_CSV_PATH,
  buildCanonicalIndex,
  extractPhoneCandidates,
  parseRcQueuesCsv,
  seedRingcentralExtensionsFromCsv,
};
