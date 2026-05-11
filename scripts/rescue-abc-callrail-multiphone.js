"use strict";

// Rescue ABC-attributed CaseProfiles by walking ALL phones associated
// with each case (cell, home, work, spouse cell, spouse home) against
// CallRail with a wide time window, then attributing each case to the
// LONGEST non-generic call from the first phone that returns hits.
//
// Why this exists:
//   The earlier rescue (rescue-abc-attribution.js) only used the case's
//   primary phone with CallRail's default `this_month` window. Cases
//   with conversion calls outside the current month — or where the
//   household answered the mailer on a different number than what the
//   intake stored as primary — got left in ABC. This script widens
//   both axes:
//     - Phone surface: pulls Logics getCaseInfo for the canonical
//       Cell/Home/Work numbers + spouse equivalents, dedup'd.
//     - Time window: queries CallRail back to roughly Nov 2024 (~1.5y)
//       so January 2026 cases can find their conversion calls
//       regardless of when the call happened.
//
// Selection rule:
//   Per phone in the ladder (cell → home → work → spouse cell → spouse
//   home), call CallRail. Stop on the first phone whose results contain
//   at least one call mapping to a NON-generic SourceCanonical (skip
//   ABC/BCD trackers — those are catch-alls that wouldn't refine
//   attribution). Among that phone's qualifying calls, pick the
//   longest by duration. Tie-breaker: closest to firstPaymentDate.
//
// What this does NOT do:
//   - Touch BCD-attributed cases (broadcast-dialer aggregator, fine
//     as-is per ops decision).
//   - Touch cases with `attribution.lockedManual: true`.
//   - Run the full attribution resolver chain (heavier, side effects
//     we don't want here — only canonical writes via writeSourceAttribution).
//
// Pacing:
//   `--callrail-gap-ms 1100` (default) keeps us safely under CallRail's
//   ~60 req/min cap. Concurrency = 1 by design — don't increase without
//   verifying the rate-limit headroom; the prior run saturated and
//   429'd ~half the cohort.
//   429 → exponential backoff (2s → 4s → 8s, max 30s, max 4 retries).
//
// Output:
//   - Per-case decision row to stdout (table)
//   - On --commit: writes via caseProfileRepository.writeSourceAttribution
//     which propagates to PaymentLedger via the syncPaymentLedgerSourceForCase
//     helper Codex wired up.
//   - No-match cases dropped to ops/abc-callrail-no-match-<timestamp>.json
//     for manual review.
//
// Usage:
//   node scripts/rescue-abc-callrail-multiphone.js                              # DRY
//   node scripts/rescue-abc-callrail-multiphone.js --commit
//   node scripts/rescue-abc-callrail-multiphone.js --commit --domain TAG --since 2026-01-01
//   node scripts/rescue-abc-callrail-multiphone.js --commit --case-ids 315235,318910   # smoke test
//   node scripts/rescue-abc-callrail-multiphone.js --callrail-gap-ms 1500       # extra-paced run

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const fs = require("fs");
const mongoose = require("mongoose");
const {
  CaseProfile,
  SourceCanonical,
} = require("../packages/shared-models/src");
const {
  caseProfileRepository,
  sourceCanonicalRepository,
} = require("../packages/shared-repositories/src");
const {
  createCallrailClient,
  createLogicsClient,
} = require("../packages/shared-integrations/src");

function readFlag(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return null;
}
function hasFlag(argv, name) {
  return argv.includes(name);
}

const GENERIC_NAMES = new Set([
  "abc",
  "bcd",
  ...String(process.env.LOGICS_GENERIC_SOURCE_NAMES || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean),
]);

function isGeneric(internalName) {
  if (!internalName) return true;
  return GENERIC_NAMES.has(String(internalName).trim().toLowerCase());
}

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function dedupPhones(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const norm = normalizeDigits(item.phone);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ ...item, phone: norm });
  }
  return out;
}

async function fetchLogicsContacts(client, caseId) {
  try {
    const payload = await client.getCaseInfo(Number(caseId));
    const data = payload?.data || payload?.Data || payload || null;
    if (!data || typeof data !== "object") return null;
    return {
      cellPhone: data.CellPhone || null,
      homePhone: data.HomePhone || null,
      workPhone: data.WorkPhone || null,
      spouseCellPhone: data.SpouseCellPhone || null,
      spouseHomePhone: data.SpouseHomePhone || null,
      spouseWorkPhone: data.SpouseWorkPhone || null,
    };
  } catch (err) {
    return { error: err.message };
  }
}

function buildPhoneLadder(caseProfile, logicsContacts) {
  // Order matters: cell-first because that's the most-likely-to-match
  // for typical mailer respondents. Home is a strong signal for the
  // older demographic the mail-house targets. Work is a long shot but
  // worth the cheap CallRail miss. Spouse phones cover dual-respondent
  // households where one spouse answered the mailer.
  const candidates = [
    { label: "primaryPhone", phone: caseProfile.primaryPhone },
    { label: "logics.cell", phone: logicsContacts?.cellPhone },
    { label: "homePhone", phone: caseProfile.homePhone },
    { label: "logics.home", phone: logicsContacts?.homePhone },
    { label: "logics.work", phone: logicsContacts?.workPhone },
    { label: "spouse.cell", phone: caseProfile.spouse?.cellPhone },
    { label: "logics.spouseCell", phone: logicsContacts?.spouseCellPhone },
    { label: "spouse.home", phone: caseProfile.spouse?.homePhone },
    { label: "logics.spouseHome", phone: logicsContacts?.spouseHomePhone },
    { label: "logics.spouseWork", phone: logicsContacts?.spouseWorkPhone },
    // Fall-back to anything in normalizedPhones we haven't seen yet.
    ...(Array.isArray(caseProfile.normalizedPhones)
      ? caseProfile.normalizedPhones.map((p) => ({
          label: "normalizedPhones",
          phone: p,
        }))
      : []),
  ];
  return dedupPhones(candidates);
}

async function callrailLookupAllInboundForPhone(client, phone, opts = {}) {
  // Wrap client.lookupInboundCallByPhone — same call, but we want all
  // calls in the wide window, not just calls[0]. perPage 250 covers
  // nearly any reasonable household; pagination not needed at this scale.
  const e164 = `+1${phone}`;
  const params = {
    search: e164,
    per_page: 250,
    direction: "inbound",
    sort: "start_time",
    order: "desc",
  };
  if (opts.startDate && opts.endDate) {
    params.start_date = opts.startDate;
    params.end_date = opts.endDate;
  }
  const payload = await client.lookupInboundCallByPhone(phone, {
    perPage: 250,
    startDate: opts.startDate,
    endDate: opts.endDate,
  });
  return Array.isArray(payload?.calls) ? payload.calls : [];
}

function selectBestCall(calls, firstPaymentDate, isGenericFn) {
  // Filter to non-generic-tracker calls so we can refine attribution.
  // ABC/BCD trackers don't help — they're the catch-alls we're trying
  // to break out of.
  const candidates = [];
  for (const call of calls) {
    const tn = call.tracking_phone_number;
    if (!tn) continue;
    candidates.push({ call, trackingNumber: tn });
  }
  if (candidates.length === 0) return null;

  // Sort: longest duration first, tie-break by closeness to
  // firstPaymentDate (smaller absolute gap wins).
  const paymentMs = firstPaymentDate
    ? new Date(firstPaymentDate).getTime()
    : null;
  candidates.sort((a, b) => {
    const da = Number(a.call.duration || 0);
    const db = Number(b.call.duration || 0);
    if (da !== db) return db - da;
    if (paymentMs == null) return 0;
    const ga = Math.abs(new Date(a.call.start_time).getTime() - paymentMs);
    const gb = Math.abs(new Date(b.call.start_time).getTime() - paymentMs);
    return ga - gb;
  });
  return candidates[0];
}

async function lookupTrackerWithCache(trackingNumber, cache) {
  const key = normalizeDigits(trackingNumber);
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  const can = await sourceCanonicalRepository
    .findSourceCanonicalByTrackingNumber(key)
    .catch(() => null);
  cache.set(key, can || null);
  return can;
}

function isRateLimitError(err) {
  if (!err) return false;
  const status = err?.details?.responseStatus || err?.status || 0;
  return status === 429;
}

async function paced(callrailGapMs, fn, lastCallrailAtRef) {
  const now = Date.now();
  const wait = Math.max(0, callrailGapMs - (now - lastCallrailAtRef.value));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallrailAtRef.value = Date.now();
  return fn();
}

async function withBackoff(fn, label) {
  // Exponential backoff on 429 only. Other errors propagate.
  const delays = [2000, 4000, 8000, 16000];
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err) || attempt >= delays.length) throw err;
      const wait = Math.min(delays[attempt], 30000);
      console.log(`  ⚠ 429 on ${label}; backoff ${wait}ms (attempt ${attempt + 1}/${delays.length})`);
      await new Promise((r) => setTimeout(r, wait));
      attempt += 1;
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const commit = hasFlag(argv, "--commit");
  const domain = (readFlag(argv, "--domain") || "TAG").toUpperCase();
  const sinceRaw = readFlag(argv, "--since") || "2026-01-01";
  const callrailGapMs = Number(readFlag(argv, "--callrail-gap-ms")) || 1100;
  const caseIdsRaw = readFlag(argv, "--case-ids");
  const cohortLimit = Number(readFlag(argv, "--limit")) || 10000;
  const callrailStartDate =
    readFlag(argv, "--callrail-start") || "2024-11-01";
  const callrailEndDate =
    readFlag(argv, "--callrail-end") || new Date().toISOString().slice(0, 10);

  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });

  // Resolve ABC canonical(s) for the cohort filter.
  const abcCanonicals = await SourceCanonical.find({
    internalName: { $regex: /^abc$/i },
  })
    .select({ _id: 1, internalName: 1 })
    .lean();
  if (abcCanonicals.length === 0) {
    console.error("No ABC canonical found in SourceCanonical.");
    await mongoose.disconnect();
    process.exit(1);
  }
  const abcIds = abcCanonicals.map((a) => a._id);

  // Cohort: ABC-tagged, not lockedManual, firstPaymentDate >= since,
  // OR explicit --case-ids override.
  //
  // When --case-ids is provided we trust the operator's selection and
  // drop the canonical filter — paid cases sometimes have
  // `sourceName: "ABC"` (text) while `sourceCanonicalId` is null
  // (never got the canonical pointer set). The canonical filter would
  // skip them; --case-ids should rescue them anyway.
  const baseQuery = {
    domain,
    "attribution.lockedManual": { $ne: true },
  };
  if (caseIdsRaw) {
    baseQuery.caseId = {
      $in: caseIdsRaw
        .split(",")
        .map((s) => Number(String(s).trim()))
        .filter(Number.isFinite),
    };
  } else {
    baseQuery.sourceCanonicalId = { $in: abcIds };
    baseQuery.firstPaymentDate = { $gte: new Date(sinceRaw) };
  }

  const total = await CaseProfile.countDocuments(baseQuery);
  console.log("══ ABC CallRail multi-phone rescue ══");
  console.log(`  mode:               ${commit ? "COMMIT" : "DRY"}`);
  console.log(`  domain:             ${domain}`);
  console.log(
    `  cohort filter:      ${
      caseIdsRaw ? `caseIds=${caseIdsRaw}` : `firstPaymentDate >= ${sinceRaw}`
    }`,
  );
  console.log(`  candidates:         ${total}`);
  console.log(
    `  CallRail window:    ${callrailStartDate} → ${callrailEndDate}`,
  );
  console.log(`  pacing gap:         ${callrailGapMs}ms`);
  console.log("");

  if (total === 0) {
    console.log("  Nothing to upgrade.");
    await mongoose.disconnect();
    return;
  }

  const candidates = await CaseProfile.find(baseQuery)
    .select({
      _id: 1,
      domain: 1,
      caseId: 1,
      name: 1,
      firstName: 1,
      lastName: 1,
      totalPaid: 1,
      firstPaymentDate: 1,
      primaryPhone: 1,
      homePhone: 1,
      spouse: 1,
      normalizedPhones: 1,
    })
    .limit(cohortLimit)
    .lean();

  const callrailClient = createCallrailClient(domain);
  const logicsClient = createLogicsClient(domain);
  const trackerCache = new Map();
  const lastCallrailAtRef = { value: 0 };

  const results = [];
  let processed = 0;

  for (const cp of candidates) {
    processed += 1;
    process.stdout.write(`\r  processing ${processed}/${candidates.length}... `);

    const logicsContacts = await fetchLogicsContacts(logicsClient, cp.caseId);
    const ladder = buildPhoneLadder(cp, logicsContacts);

    if (ladder.length === 0) {
      results.push({
        cp,
        chosen: null,
        reason: "no-phones",
        attempted: [],
        logicsContacts,
      });
      continue;
    }

    let chosen = null;
    let chosenSource = null;
    const attemptedPhones = [];
    let stoppedReason = null;

    for (const { phone, label } of ladder) {
      attemptedPhones.push({ phone, label });
      let calls = [];
      try {
        calls = await paced(
          callrailGapMs,
          () =>
            withBackoff(
              () =>
                callrailLookupAllInboundForPhone(callrailClient, phone, {
                  startDate: callrailStartDate,
                  endDate: callrailEndDate,
                }),
              `phone=${phone}`,
            ),
          lastCallrailAtRef,
        );
      } catch (err) {
        attemptedPhones[attemptedPhones.length - 1].error = err.message;
        continue;
      }

      if (calls.length === 0) continue;

      const best = selectBestCall(calls, cp.firstPaymentDate);
      if (!best) continue;

      const canonical = await lookupTrackerWithCache(
        best.trackingNumber,
        trackerCache,
      );
      if (!canonical) {
        attemptedPhones[attemptedPhones.length - 1].trackerNotMapped =
          best.trackingNumber;
        continue;
      }
      if (isGeneric(canonical.internalName)) {
        attemptedPhones[attemptedPhones.length - 1].trackerGeneric =
          canonical.internalName;
        continue;
      }

      // Hit — stop the phone ladder.
      chosen = best;
      chosenSource = canonical;
      stoppedReason = "matched";
      break;
    }

    results.push({
      cp,
      chosen,
      chosenSource,
      attempted: attemptedPhones,
      reason: stoppedReason || "no-match-on-any-phone",
      logicsContacts,
    });
  }
  process.stdout.write("\n\n");

  // ── Report ───────────────────────────────────────────────────────
  const matched = results.filter((r) => r.chosenSource);
  const noMatch = results.filter((r) => !r.chosenSource);

  console.log(`══ Results ══`);
  console.log(`  matched:           ${matched.length}/${results.length}`);
  console.log(`  no-match:          ${noMatch.length}`);
  console.log("");

  if (matched.length > 0) {
    console.log("  MATCHED (first 25):");
    console.log(
      `    ${"caseId".padEnd(8)}  ${"name".padEnd(22)}  ${"matched-phone".padEnd(16)}  ${"call-dur".padEnd(8)}  ${"gap-d".padEnd(7)}  → canonical`,
    );
    const paid = (s) => `$${(Number(s) || 0).toFixed(0)}`.padEnd(8);
    const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "-");
    for (const r of matched.slice(0, 25)) {
      const matchPhone =
        r.attempted.find((a) => !a.error && !a.trackerGeneric && !a.trackerNotMapped)?.phone || "-";
      const callTime = r.chosen.call.start_time
        ? new Date(r.chosen.call.start_time)
        : null;
      const paymentTime = r.cp.firstPaymentDate
        ? new Date(r.cp.firstPaymentDate)
        : null;
      const gapDays =
        callTime && paymentTime
          ? Math.round(
              (callTime.getTime() - paymentTime.getTime()) /
                (24 * 60 * 60 * 1000),
            )
          : null;
      const dur = `${Number(r.chosen.call.duration || 0)}s`;
      const nameStr = (r.cp.name || `${r.cp.firstName || ""} ${r.cp.lastName || ""}`)
        .trim()
        .slice(0, 22)
        .padEnd(22);
      console.log(
        `    ${String(r.cp.caseId).padEnd(8)}  ${nameStr}  ${matchPhone.padEnd(16)}  ${dur.padEnd(8)}  ${(gapDays != null ? `${gapDays}d` : "-").padEnd(7)}  → ${r.chosenSource.internalName}`,
      );
    }
    if (matched.length > 25) {
      console.log(`    ... and ${matched.length - 25} more`);
    }
  }

  if (noMatch.length > 0) {
    console.log("");
    console.log(
      `  NO-MATCH (first 15) — these will be saved to ops/abc-callrail-no-match-*.json:`,
    );
    for (const r of noMatch.slice(0, 15)) {
      const phones = r.attempted
        .map((a) => `${a.phone}${a.trackerGeneric ? "(generic:" + a.trackerGeneric + ")" : a.trackerNotMapped ? "(no-tracker-map)" : a.error ? "(err)" : "(0-calls)"}`)
        .join(", ");
      console.log(
        `    case=${r.cp.caseId}  name=${(r.cp.name || "").slice(0, 22)}  phones=${phones || "(none)"}`,
      );
    }
  }

  // ── No-match dump for manual review ──────────────────────────────
  if (noMatch.length > 0) {
    const opsDir = path.resolve(__dirname, "..", "ops");
    if (!fs.existsSync(opsDir)) fs.mkdirSync(opsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const noMatchPath = path.resolve(
      opsDir,
      `abc-callrail-no-match-${domain}-${stamp}.json`,
    );
    fs.writeFileSync(
      noMatchPath,
      JSON.stringify(
        noMatch.map((r) => ({
          caseId: r.cp.caseId,
          name: r.cp.name || `${r.cp.firstName || ""} ${r.cp.lastName || ""}`.trim(),
          firstPaymentDate: r.cp.firstPaymentDate,
          totalPaid: r.cp.totalPaid,
          attemptedPhones: r.attempted,
          reason: r.reason,
          logicsContacts: r.logicsContacts,
        })),
        null,
        2,
      ),
    );
    console.log("");
    console.log(`  no-match list written to: ${noMatchPath}`);
  }

  // ── Commit writes ────────────────────────────────────────────────
  if (!commit) {
    console.log("");
    console.log(`  DRY RUN. Re-run with --commit to write ${matched.length} attribution updates.`);
    await mongoose.disconnect();
    return;
  }

  if (matched.length === 0) {
    console.log("");
    console.log("  Nothing to commit.");
    await mongoose.disconnect();
    return;
  }

  console.log("");
  console.log(`  writing ${matched.length} attribution updates...`);
  let written = 0;
  let writeErrors = 0;
  for (const r of matched) {
    try {
      await caseProfileRepository.writeSourceAttribution(domain, r.cp.caseId, {
        sourceCanonicalId: r.chosenSource._id,
        matchedBy: "abc-callrail-multiphone-rescue",
        forceMirrorSourceName: true,
      });
      written += 1;
    } catch (err) {
      writeErrors += 1;
      console.log(`    write failed for case ${r.cp.caseId}: ${err.message}`);
    }
  }
  console.log(`  wrote: ${written}, errors: ${writeErrors}`);

  await mongoose.disconnect();
  console.log("\n[done]");
}

main().catch(async (err) => {
  console.error("FATAL:", err.stack || err.message);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
