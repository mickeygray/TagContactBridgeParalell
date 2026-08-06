"use strict";

// THE MIDDAY PASS — recalibrate, then send the rvm half of cadence.
//
// Mickey 2026-08-06: "2) recalibrate at noon and run a second cadence blast."
//
// Everything lands DARK behind MIDDAY_PASS_ENABLED, each task behind its own
// flag on top.

const { createPassRuntime } = require("./passRuntimeFactory");

const flag = (name) => String(process.env[name] || "false").toLowerCase() === "true";
const middayCadenceCap = () => Math.max(1, Number(process.env.MIDDAY_CADENCE_MAX_DISPATCHES) || 200);

const TASKS = [
  {
    // THE RVM HALF.
    //
    // Not a "second batch past lastDailyBatchKey", which is how the work order
    // described it — that is not what forceDaily does and it is not what
    // happens. The morning pass stamps lastDailyBatchKey for sms and email
    // ONLY, so rvm arrives here untouched and this is the day's FIRST rvm
    // batch. The per-channel key is what makes the split safe: neither pass can
    // re-send the other's channel, and neither can re-send its own.
    //
    // forceDaily is still required, for the same reason as the morning pass:
    // 12:00 PT is outside the 09:00–11:59 daily window (`720 < 720` is false),
    // so without it the sweep selects nothing and reports a confident zero.
    key: "cadence-midday",
    label: "Lead cadence — ringless voicemail",
    writesArmed: () => flag("MIDDAY_CADENCE_ENABLED"),
    async plan({ domains }) {
      return [{ domains: [...domains], channels: ["rvm"], maxDispatches: middayCadenceCap() }];
    },
    count() { return 1; },
    async apply(planned, { logger, cadenceImpl = null }) {
      // The DRAIN loop, not the single sweep. One sweep caps at maxDispatches
      // and a durable pass runs once a day, so a single call would send one
      // batch and silently postpone the rest of the backlog to tomorrow.
      const run = cadenceImpl
        || require("../../../../packages/shared-services/src/counterCadenceService").drainCounterCadenceSweep;
      const p = planned[0] || {};
      const r = await run({
        domains: p.domains,
        channels: p.channels,
        // The age-relative push is an SMS. An rvm-only pass must not text
        // anybody, and the channel filter already silences it — this says so
        // twice on purpose, because the two flags mean different things and a
        // future edit to one should not quietly re-enable the other.
        includeAgeRelative: false,
        includeDaily: true,
        forceDaily: true,
        maxDispatches: p.maxDispatches,
        sourceService: "midday-pass",
        logger,
      });
      return {
        written: Number(r?.sent) || 0,
        selected: Number(r?.selected) || 0,
        skipped: Number(r?.skipped) || 0,
        failed: Number(r?.failed) || 0,
        rounds: Number(r?.rounds) || 1,
        // False means the loop stopped on its round cap or a stuck provider —
        // items remain due, and the summary must not read as a finished day.
        drained: r?.drained !== false,
      };
    },
    describe(planned) {
      const p = planned[0] || {};
      return `rvm to up to ${p.maxDispatches} lead(s) across ${(p.domains || []).join(", ")}`
        + " — the day's first rvm batch, forced past the 09:00 window";
    },
  },
  {
    // CALL LOG HYGIENE, MIDDAY HALF — since 20:00 PT yesterday.
    //
    // Pairs with the evening half (E8), which covers noon onward. Same service,
    // same helper, different anchor.
    //
    // ⚠ DO NOT ARM THIS WITH THE EVENING HALF UNTIL REPLAY IS SAFE. The two
    // windows overlap by design, and an overlapping pass is NOT idempotent for
    // this service: `persistCallLog` re-$sets strategy/confidence/status on
    // every pass and the prior-CallLog lookup does not exclude the row's own
    // record, so a call stamped "callrail" at midday can come back
    // "prior-calllog" in the evening — and a pass that fails to match rewrites
    // an already-resolved row to status "pending-retry" with a null source. The
    // review-queue insert has the same problem: it passes a dedupeKey to a model
    // that has no such field, so mongoose strict drops it and every replay adds
    // another row. All of that is recorded as an arming blocker in the E8 entry.
    key: "call-log-hygiene-midday",
    label: "Call log hygiene — morning half (since 20:00 PT yesterday)",
    writesArmed: () => flag("MIDDAY_CALL_LOG_HYGIENE_ENABLED"),
    async plan({ domains, logger }) {
      const { CallLog } = require("../../../../packages/shared-models/src");
      const {
        pacificMsSinceToday,
      } = require("./nightlyHygieneRuntime");
      // 20:00 PT yesterday: pacificMsSinceToday returns "since 20:00 today" if
      // 20:00 has passed, and rolls back a day if it has not — and at midday it
      // has not, which is exactly the window we want.
      const sinceMs = pacificMsSinceToday(20, 0);
      const windowStart = new Date(Date.now() - sinceMs);
      const out = [];
      for (const domain of domains) {
        try {
          const [inbound, outbound] = await Promise.all([
            CallLog.countDocuments({ domain, direction: "inbound", callStartTime: { $gte: windowStart } }),
            CallLog.countDocuments({ domain, direction: "outbound", callStartTime: { $gte: windowStart } }),
          ]);
          out.push({
            domain, sinceMs, windowStart: windowStart.toISOString(),
            inbound: Number(inbound) || 0, outbound: Number(outbound) || 0,
          });
        } catch (error) {
          logger?.warn?.(`midday call-log plan failed for ${domain}: ${error.message}`);
          out.push({
            domain, sinceMs, windowStart: windowStart.toISOString(),
            inbound: null, outbound: null, error: String(error.message).slice(0, 160),
          });
        }
      }
      return out;
    },
    count(planned) {
      return planned.reduce((acc, p) => acc + (Number(p.inbound) || 0) + (Number(p.outbound) || 0), 0);
    },
    async apply(planned, { logger, callLogHygieneImpl = null }) {
      const run = callLogHygieneImpl
        || require("../../../../packages/shared-services/src/hourlyCallLogHygieneService")
          .runHourlyCallLogHygiene;
      const readable = planned.filter((p) => p.inbound !== null);
      const out = { written: 0, ledgerSynced: 0, scored: 0, archived: 0, failed: 0, errors: [] };
      for (const p of planned.filter((x) => x.inbound === null)) {
        out.failed += 1;
        out.errors.push(`${p.domain}: NOT EXAMINED — ${p.error || "window count failed"}`);
      }
      if (!readable.length) return out;
      try {
        const r = await run({
          domains: readable.map((p) => p.domain),
          now: new Date(),
          sinceMs: readable[0].sinceMs,
          // The native RC sweep belongs to the EVENING half only. Running an
          // account-wide Detailed CDR pull twice a day doubles the exposure to
          // a 429, and a 429 in this client opens a process-wide circuit that
          // would fail every later task in this pass.
          nativeSweepEnabled: false,
          limitPerDomain: 200,
          lane: "hourly",
          logger,
        });
        const t = r?.totals || {};
        out.written = (Number(t.mirrored) || 0) + (Number(t.nativeInserted) || 0);
        out.scored = Number(t.scoringCompleted) || 0;
        out.archived = Number(t.archiveQueued) || 0;
        out.failed += (Number(t.scoringFailed) || 0) + (Number(t.archiveFailed) || 0)
          + (Number(t.metricsErrors) || 0);
        for (const d of Array.isArray(r?.domains) ? r.domains : []) {
          out.ledgerSynced += Number(d?.result?.counts?.ledgerSynced) || 0;
          if (d?.ok === false) {
            out.failed += 1;
            out.errors.push(`${d.domain}: ${String(d.error || "domain failed").slice(0, 160)}`);
          }
        }
      } catch (error) {
        out.failed += 1;
        out.errors.push(`midday hygiene failed: ${String(error.message).slice(0, 200)}`);
      }
      return out;
    },
    describe(planned) {
      const unreadable = planned.filter((p) => p.inbound === null);
      if (unreadable.length && unreadable.length === planned.length) {
        return `COULD NOT COUNT THE CALL WINDOW — ${unreadable[0]?.error || "unknown"}`;
      }
      const readable = planned.filter((p) => p.inbound !== null);
      const hours = ((readable[0]?.sinceMs ?? 0) / 3600000).toFixed(1);
      const total = readable.reduce((a, p) => a + p.inbound + p.outbound, 0);
      return `${hours}h since 20:00 PT yesterday: ${total} call(s)`
        + ` [${readable.map((p) => `${p.domain} ${p.inbound}in/${p.outbound}out`).join(" · ")}]`
        + (unreadable.length ? ` · ${unreadable.map((p) => p.domain).join(", ")} NOT COUNTED` : "");
    },
  },
];

function createMiddayPassRuntime({ config = {}, runtime = {} } = {}) {
  return createPassRuntime({
    passKey: "midday",
    label: "Midday pass",
    enabledEnv: "MIDDAY_PASS_ENABLED",
    defaultHour: 12,
    tasks: TASKS,
    config,
    runtime,
  });
}

module.exports = { TASKS, createMiddayPassRuntime };
