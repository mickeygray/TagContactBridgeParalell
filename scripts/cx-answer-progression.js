"use strict";

// ANSWER-TEST PROGRESSION NARRATOR (Mickey's ask, 2026-07-07): start this FIRST, then
// build the list in the UI, dial, answer. Read-only observer — zero writes — that
// narrates every call's journey through the whole trunk as it happens:
//
//   SESSION  -> new bulk session detected (leads listed)
//   DIAL     -> a lead becomes current (serving)
//   ANSWER   -> the call latches (connectedAt)
//   TERMINAL -> the outcome enters (click / auto-advance / wrap-timeout), with the
//               RingCX system disposition or the retry-queue deferral narrated live
//   DRAIN    -> the outbox row is replayed by the live drain
//   CARD     -> the wrap card mints (check the sidebar!)
//   RESOLVE  -> your DNC / Appointment / dismiss click on the card
//
// Each hop prints with +seconds since the previous one. Stall warnings fire when a hop
// takes longer than it should. Ctrl+C any time — nothing to clean up.
//
// Usage:
//   node scripts/cx-answer-progression.js                 -> watch the NEWEST running
//                                                            session (or wait for one)
//   node scripts/cx-answer-progression.js --session <id>  -> watch a specific session

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CxBulkLoadSession, CxTerminalOutbox, CxCallWrapCard } = require("../packages/shared-models/src");

const args = { session: null };
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === "--session") args.session = process.argv[++i] || null;
}

const POLL_MS = 2000;
const STALL_TERMINAL_MS = 90_000; // answered + no terminal row (did the click land?)
const STALL_DRAIN_MS = 60_000;    // terminal row pending too long (drain running?)
const STALL_CARD_MS = 45_000;     // drained answered but no card (flag on?)

const t0 = Date.now();
function stamp() { return new Date().toISOString().slice(11, 19); }
function line(msg) { console.log(`  ${stamp()}  ${msg}`); }
function banner(msg) { console.log(`\n${stamp()}  ${msg}`); }
function secs(fromMs) { return `+${Math.round((Date.now() - fromMs) / 1000)}s`; }
function mask(phone) {
  const s = String(phone || "");
  return s.length > 4 ? `***${s.slice(-4)}` : s || "-";
}

// per-call journey state, keyed by queueItemId
const journeys = new Map();
function journey(key) {
  if (!journeys.get(key)) journeys.set(key, { hops: {}, warned: {}, name: null, uii: null });
  return journeys.get(key);
}
function hop(j, name, msg) {
  if (j.hops[name]) return false;
  j.hops[name] = Date.now();
  line(msg);
  return true;
}
function warnOnce(j, key, msg) {
  if (j.warned[key]) return;
  j.warned[key] = true;
  line(`⚠ ${msg}`);
}

async function main() {
  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  banner("PROGRESSION NARRATOR armed (read-only). Build the list, dial, answer — I'll talk.");

  let sessionId = args.session;
  let announcedSession = false;
  let knownLeadCount = -1;
  const startedAt = new Date();

  for (;;) {
    try {
      // ---- 1) find / follow the session ----
      const query = sessionId
        ? { sessionId }
        : { status: "running", createdAt: { $gte: new Date(Date.now() - 6 * 60 * 60 * 1000) } };
      const session = await CxBulkLoadSession.findOne(query).sort({ createdAt: -1 }).lean();
      if (!session) {
        if (!announcedSession) { /* quietly wait for the new session */ }
        await sleep(POLL_MS);
        continue;
      }
      if (!announcedSession || session.sessionId !== sessionId) {
        sessionId = session.sessionId;
        announcedSession = true;
        knownLeadCount = -1;
        banner(`SESSION ${session.sessionId} (${session.agentEmail}) phase=${session.phase}`);
      }

      // ---- 2) the list ----
      const buffer = Array.isArray(session.acceptedBuffer) ? session.acceptedBuffer : [];
      const totalLeads = buffer.length + (session.current ? 1 : 0) + (session.completed || []).length;
      if (totalLeads !== knownLeadCount) {
        knownLeadCount = totalLeads;
        const names = [
          ...(session.current ? [`${session.current.name} (serving)`] : []),
          ...buffer.map((c) => c.name),
        ];
        if (names.length) line(`LIST: ${names.length} live lead(s): ${names.join(", ")}`);
      }

      // ---- 3) the current call's journey ----
      const current = session.current;
      if (current?.queueItemId) {
        const j = journey(String(current.queueItemId));
        j.name = current.name || j.name;
        j.uii = current.uii || j.uii;
        hop(j, "dial", `DIAL → serving "${current.name}" ${mask(current.phone)} (${current.queueItemId})`);
        if (current.connectedAt) {
          hop(j, "answer", `ANSWER → "${current.name}" connected at ${String(current.connectedAt).slice(11, 19)} — talk, hang up, click a disposition`);
        }
        if (current.wrap?.at) {
          hop(j, "wrap", `WRAP HOLD → "${current.name}" waiting on your disposition click (janitor would sweep in ~30min)`);
        }
      }

      // ---- 4) terminal rows + retry stash for every known journey ----
      // only THIS test's events — rows from before the narrator started are history, not news
      const rows = await CxTerminalOutbox.find({ sessionId: session.sessionId, createdAt: { $gte: startedAt } }).lean();
      for (const row of rows) {
        const key = String(row.queueItemId || row.payload?.queueItemId || row.idemKey);
        const j = journey(key);
        j.name = j.name || row.payload?.name || null;
        const sys = row.payload?.systemDisposition || null;
        hop(j, "terminal",
          `TERMINAL → "${j.name || key}" outcome=${row.payload?.outcome || row.outcome}` +
          ` sys=${sys || "none"} source=${row.payload?.source || "-"}` +
          (j.hops.answer ? ` (${secs(j.hops.answer)} after answer)` : ""));
        if (row.status === "drained") {
          hop(j, "drain", `DRAIN → "${j.name || key}" replayed${j.hops.terminal ? ` (${secs(j.hops.terminal)} after terminal)` : ""}`);
        } else if (j.hops.terminal && Date.now() - j.hops.terminal > STALL_DRAIN_MS) {
          warnOnce(j, "drain-stall", `"${j.name || key}" terminal row still ${row.status} after ${secs(j.hops.terminal)} — is the drain ticking? (status=${row.status}, attempts=${row.attempts})`);
        }
      }

      // the retry queue narration (deferred labels)
      const stash = Array.isArray(session.sysDispoRetries) ? session.sysDispoRetries : [];
      for (const entry of stash) {
        const j = journey(String(entry.queueItemId));
        hop(j, "retry-defer",
          `RETRY QUEUE → "${j.name || entry.queueItemId}" label not readable yet (${entry.lastReason}${entry.lastError ? `: ${String(entry.lastError).slice(0, 40)}` : ""}) — re-read at ${String(entry.nextAttemptAt).slice(11, 19)}`);
      }

      // ---- 5) wrap cards ----
      const cards = await CxCallWrapCard.find({
        agentEmail: session.agentEmail,
        createdAt: { $gte: startedAt },
      }).lean();
      for (const card of cards) {
        const key = String(card.queueItemId || card.idemKey);
        const j = journey(key);
        if (hop(j, "card",
          `CARD MINTED → "${card.name}" sys=${card.systemDisposition || "none"}` +
          ` summary=${card.coachSummary ? "yes" : "no"} — CHECK THE SIDEBAR` +
          (j.hops.terminal ? ` (${secs(j.hops.terminal)} after terminal)` : ""))) {
          // fresh card — nothing else
        }
        if (card.status !== "pending") {
          hop(j, "resolve", `RESOLVED → "${card.name}" action=${card.status} by ${card.resolvedBy || "-"} — THE FULL PROGRESSION IS COMPLETE 🎉`);
          if (j.hops.dial && !j.warned.summaryPrinted) {
            j.warned.summaryPrinted = true;
            const order = ["dial", "answer", "wrap", "terminal", "retry-defer", "drain", "card", "resolve"];
            const legs = order.filter((o) => j.hops[o]);
            const timeline = legs.map((o, i) => {
              if (i === 0) return `${o}@${new Date(j.hops[o]).toISOString().slice(11, 19)}`;
              const dt = Math.round((j.hops[o] - j.hops[legs[i - 1]]) / 1000);
              return `${o}(+${dt}s)`;
            }).join(" → ");
            line(`SUMMARY "${j.name || key}": ${timeline}`);
          }
        } else if (j.hops.card && Date.now() - j.hops.card > 10 * 60_000) {
          warnOnce(j, "unclicked", `"${card.name}" card pending ${secs(j.hops.card)} — expires ${String(card.expiresAt).slice(11, 16)}`);
        }
      }

      // stall check: answered but no terminal (missed click / stuck?)
      for (const [key, j] of journeys) {
        if (j.hops.answer && !j.hops.terminal && !j.hops.wrap && Date.now() - j.hops.answer > STALL_TERMINAL_MS) {
          warnOnce(j, "terminal-stall", `"${j.name || key}" answered ${secs(j.hops.answer)} ago, no terminal row and no wrap hold — did the disposition click land?`);
        }
        if (j.hops.drain && !j.hops.card && Date.now() - j.hops.drain > STALL_CARD_MS) {
          const row = rows.find((r) => String(r.queueItemId || "") === key);
          const outcome = row?.payload?.outcome || row?.outcome;
          if (outcome === "answered") {
            warnOnce(j, "card-stall", `"${j.name || key}" drained ANSWERED ${secs(j.hops.drain)} ago, no card — check CX_CALL_WRAP_QUEUE_ENABLED / drain log`);
          } else {
            warnOnce(j, "no-card-expected", `"${j.name || key}" outcome=${outcome} — no card expected (only ANSWERED cards). Working as designed.`);
          }
        }
      }
    } catch (err) {
      line(`(poll error, retrying: ${err.message})`);
    }
    await sleep(POLL_MS);
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

main().catch((err) => { console.error(err.message); process.exit(1); });
