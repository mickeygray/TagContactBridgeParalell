"use strict";

// CASE-SIDE SOURCE RESCUE (prototype of pipeline Stage 2.5's attribution
// seed — Mickey 2026-07-27: "get an initial payment in tag? get every phone
// number from logics search callrail => ex => phoneburner call logs and map
// a source based on the info you pull update the case file with that
// source.")
//
// DRY-RUN BY DEFAULT. --apply writes the resolved source to OUR CaseProfile
// (fill-only: an existing different source is reported as a conflict, never
// clobbered). It never writes to Logics — the logicsSourceWriterService
// write-back is a later, separately-approved step.
//
//   node scripts/rescue-case-source.js --domain TAG --case 426256
//   node scripts/rescue-case-source.js --domain TAG --case 426256 --apply
//
// EX note: this script reads EX call LOG METADATA for matching only and
// never prints or surfaces recording fields — the allow-list rule stands.

require("dotenv").config();

const { connectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { createLogicsClient } = require("../packages/shared-integrations/src");
const { foldCasePhones } = require("../packages/shared-services/src/casePhoneFoldService");
const { lookupInboundCall } = require("../packages/shared-services/src/callrailLookupService");
const { caseProfileRepository } = require("../packages/shared-repositories/src");
const CallLog = require("../packages/shared-models/src/CallLog");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

// The Logics envelope rule: every GET returns a wrapper; unwrap before use.
function unwrap(result) {
  let d = result;
  if (typeof d === "string") { try { d = JSON.parse(d); } catch { return null; } }
  if (typeof d?.Data === "string") { try { d = { ...d, Data: JSON.parse(d.Data) }; } catch { /* keep */ } }
  return d?.Data ?? d;
}

async function main() {
  const domain = String(arg("domain", "TAG")).toUpperCase();
  const caseId = Number(arg("case"));
  const apply = process.argv.includes("--apply");
  if (!Number.isFinite(caseId)) {
    console.error("usage: node scripts/rescue-case-source.js --domain TAG --case <id> [--apply]");
    process.exit(1);
  }

  await connectMongo(getSharedConfig());
  const client = createLogicsClient(domain);

  console.log(`\n══ SOURCE RESCUE · ${domain} case ${caseId} · ${apply ? "APPLY" : "DRY RUN"} ══\n`);

  // 1 ── confirm the initial payment (first-date rule)
  const history = unwrap(await client.getCasePayments(caseId)) || [];
  const success = history.filter((p) => String(p.TransactionStatus).toUpperCase() === "SUCCESS");
  if (!success.length) {
    console.log("no successful payments on this case — nothing to attribute; aborting.");
    process.exit(2);
  }
  const firstDate = success.map((p) => String(p.PaidDate).slice(0, 10)).sort()[0];
  const initials = success.filter((p) => String(p.PaidDate).slice(0, 10) === firstDate);
  console.log(`payments: ${success.length} SUCCESS (${history.length} total) · first date ${firstDate}`);
  for (const p of initials) {
    console.log(`  INITIAL: id=${p.CasePaymentID} $${p.Amount} tag=${p.TagID} type=${p.PaymentTypeName} by ${p.CreatedByUserFullName}`);
  }

  // 2 ── every phone number from Logics
  const info = unwrap(await client.getCaseInfo(caseId));
  const phones = foldCasePhones(info || {});
  const name = `${info?.FirstName || ""} ${info?.LastName || ""}`.trim();
  console.log(`\ncase: ${name} · Logics status "${info?.StatusName || "?"}" · Logics source "${info?.SourceName || info?.Source || "(none)"}"`);
  console.log(`phones folded: ${phones.normalizedPhones.length} → ${phones.normalizedPhones.join(", ") || "(none)"}`);
  if (!phones.normalizedPhones.length) {
    console.log("no phones on the Logics case — cannot attribute by call; aborting.");
    process.exit(2);
  }

  // 3 ── search, in Mickey's stated order: CallRail ⇒ EX ⇒ PhoneBurner (then CX)
  const evidence = [];
  for (const phone of phones.normalizedPhones) {
    // CallRail (one cross-company tenant; TAG key reaches it)
    try {
      const cr = await lookupInboundCall(domain, phone);
      if (cr?.call) {
        evidence.push({
          rank: 1, platform: "callrail", phone,
          source: cr.call.sourceName || null,
          tracker: cr.call.trackingNumber || null,
          at: cr.call.startTime || null,
          direction: cr.call.direction || "inbound",
          detail: `${cr.totalMatches} match(es)`,
        });
      }
    } catch (error) {
      evidence.push({ rank: 1, platform: "callrail", phone, error: String(error.message).slice(0, 90) });
    }

    // EX / PhoneBurner / CX call logs (ours). Metadata only — no recording fields.
    const logs = await CallLog.find({
      domain,
      $or: [{ phone }, { normalizedPhone: phone }],
    }).sort({ callStartTime: 1 }).limit(20)
      .select("platform direction callStartTime sourceName sourceChannel sourceCanonicalId confidence caseId")
      .lean();
    for (const log of logs) {
      evidence.push({
        rank: log.platform === "ex" ? 2 : log.platform === "phoneburner" ? 3 : 4,
        platform: log.platform || "unknown", phone,
        source: log.sourceName || log.sourceCanonicalId || null,
        at: log.callStartTime || null,
        direction: log.direction || null,
        detail: `confidence=${log.confidence || "-"} caseId=${log.caseId ?? "-"}`,
      });
    }
  }

  console.log(`\n── evidence (${evidence.length} hits, CallRail ⇒ EX ⇒ PhoneBurner order) ──`);
  evidence.sort((a, b) => (a.rank - b.rank) || (new Date(a.at || 0) - new Date(b.at || 0)));
  for (const e of evidence) {
    if (e.error) { console.log(`  [${e.platform}] ${e.phone} ERROR ${e.error}`); continue; }
    console.log(`  [${e.platform}] ${e.phone} ${e.direction || "?"} ${e.at ? String(e.at).slice(0, 19) : "(no time)"} → source=${e.source || "(none)"} ${e.tracker ? `tracker=${e.tracker}` : ""} ${e.detail || ""}`);
  }

  // 4 ── map the source: first CallRail inbound wins; else earliest sourced log
  const crHit = evidence.find((e) => e.platform === "callrail" && e.source && !e.error);
  const logHit = evidence.find((e) => e.platform !== "callrail" && e.source && !e.error);
  const resolved = crHit || logHit || null;

  console.log(`\n── resolution ──`);
  if (!resolved) {
    console.log("UNRESOLVED: no platform produced a source for any folded phone.");
    console.log("(outbound-only history with no source usually means LD/aged origin — needs the cadence-origin rule, not a guess.)");
  } else {
    console.log(`source = "${resolved.source}" via ${resolved.platform}${resolved.tracker ? ` (tracker ${resolved.tracker})` : ""} at ${String(resolved.at).slice(0, 19)}`);
  }

  // 5 ── the case file
  const profile = await caseProfileRepository.findCaseProfile(domain, caseId);
  const current = profile?.sourceName || null;
  console.log(`\ncase profile today: sourceName="${current || "(none)"}" ${profile ? "" : "(NO PROFILE)"}`);

  // A source label carrying an embedded phone number is a raw tracker name,
  // not a catalog source (Mickey is aligning tracker names in CallRail —
  // this guard is the backstop so a stray "… 800-921-9263" can never enter
  // a profile and fragment the by-source rollups).
  if (resolved && /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|\b8(00|33|44|55|66|77|88)\b/.test(resolved.source)) {
    console.log(`HELD: "${resolved.source}" looks like a raw tracker label (embedded phone number) — rename the tracker to the catalog name, then re-run.`);
    resolved.held = true;
  }

  if (resolved && !resolved.held) {
    if (current && current !== resolved.source) {
      console.log(`CONFLICT: profile says "${current}", evidence says "${resolved.source}" — fill-only rule: NOT overwriting. Review line.`);
    } else if (current === resolved.source) {
      console.log("profile already agrees — nothing to write.");
    } else if (apply) {
      await caseProfileRepository.upsertCaseProfile(domain, caseId, { sourceName: resolved.source });
      console.log(`APPLIED: CaseProfile.sourceName ← "${resolved.source}"`);
    } else {
      console.log(`DRY RUN: would set CaseProfile.sourceName ← "${resolved.source}" (re-run with --apply)`);
    }
    console.log(`Logics write-back (NOT performed): SourceName "${info?.SourceName || "(none)"}" → "${resolved.source}" via logicsSourceWriterService — separate approval.`);
  }

  process.exit(0);
}

main().catch((error) => { console.error("rescue crashed:", error.stack || error.message); process.exit(1); });
