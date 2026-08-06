"use strict";

// E7 — THE RECONCILIATION TRIO, folded from the hourly sweeper's Phase A into
// the evening pass.
//
// These three did not run at all before this: server.js hardcodes BOTH
// `runScheduledPhase = false` (which skips the whole Phase A block) and
// `scheduledPhaseLite = true` (which passes through as
// `sessionReconcileEnabled: !scheduledPhaseLite` and friends). So the move is
// "off -> once a night", and the hazard is not lost coverage but a job written
// for fourteen passes keeping its name while getting one. Every window and cap
// below is a place where the hourly default would have quietly under-covered.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createNightlyHygieneRuntime,
} = require("../../apps/control-plane/src/services/nightlyHygieneRuntime");

const withEnv = async (vars, fn) => {
  const prior = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

const trio = (key) => createNightlyHygieneRuntime({}).TASKS.find((t) => t.key === key);

// ── ORDER ──────────────────────────────────────────────────────────────────

test("payment-fields-sync runs AFTER payment-reconcile — the shared checkpoint", () => {
  // Both services stamp `paymentReconcile.lastCheckedAt`, and reconcile SELECTS
  // on it. Reversed, fields-sync stamps the checkpoint to now and suppresses
  // reconcile's own candidate query for exactly the cases it just touched.
  // Until now that contract lived only in a file-header comment and nothing
  // failed if the two were swapped.
  const keys = createNightlyHygieneRuntime({}).TASKS.map((t) => t.key);
  const reconcile = keys.indexOf("payment-reconcile");
  const fields = keys.indexOf("payment-fields-sync");
  assert.ok(reconcile >= 0 && fields >= 0, "both tasks must be registered");
  assert.ok(
    fields > reconcile,
    "fields-sync must not stamp paymentReconcile.lastCheckedAt before reconcile reads it",
  );
});

test("the trio does not displace night-persist or call-recording-index", () => {
  // The work order put the trio ahead of night-persist on the theory that
  // payment-reconcile produces the rows night-persist stamps. It does not:
  // night-persist runs runNightPass -> runMoneyLoop -> pullCaseBilling, a live
  // Logics pull, so it never reads a PaymentLedger row this pass wrote. With no
  // produce/consume edge, both existing ordering rules keep their reason.
  const keys = createNightlyHygieneRuntime({}).TASKS.map((t) => t.key);
  assert.equal(keys[0], "night-persist", "the irreplaceable write goes first");
  assert.equal(keys[keys.length - 1], "call-recording-index", "the index wants a corrected day");
  assert.ok(keys.indexOf("session-reconcile") > keys.indexOf("activity-review"));
  assert.ok(keys.indexOf("payment-fields-sync") < keys.indexOf("call-recording-index"));
});

// ── ARMING ─────────────────────────────────────────────────────────────────

test("all three land dark, and each carries its own switch", async () => {
  await withEnv({
    NIGHTLY_SESSION_RECONCILE_ENABLED: undefined,
    NIGHTLY_PAYMENT_RECONCILE_ENABLED: undefined,
    NIGHTLY_PAYMENT_FIELDS_SYNC_ENABLED: undefined,
  }, async () => {
    for (const key of ["session-reconcile", "payment-reconcile", "payment-fields-sync"]) {
      assert.equal(trio(key).writesArmed(), false, `${key} must land dark`);
    }
  });

  // Arming one must not arm its neighbours — three separate decisions.
  await withEnv({
    NIGHTLY_SESSION_RECONCILE_ENABLED: "true",
    NIGHTLY_PAYMENT_RECONCILE_ENABLED: undefined,
    NIGHTLY_PAYMENT_FIELDS_SYNC_ENABLED: undefined,
  }, async () => {
    assert.equal(trio("session-reconcile").writesArmed(), true);
    assert.equal(trio("payment-reconcile").writesArmed(), false);
    assert.equal(trio("payment-fields-sync").writesArmed(), false);
  });
});

test("every trio task is REACHABLE — a missing count() would never apply", () => {
  for (const key of ["session-reconcile", "payment-reconcile", "payment-fields-sync"]) {
    assert.equal(typeof trio(key).count, "function", `${key} needs its own count()`);
  }
  // The two summary-shaped plans are one indivisible unit each.
  assert.equal(trio("payment-reconcile").count([{}]), 1);
  assert.equal(trio("payment-fields-sync").count([{}]), 1);
  // session-reconcile counts the FEED, so an empty feed correctly plans zero.
  assert.equal(trio("session-reconcile").count([{ sessions: 4 }, { sessions: 6 }]), 10);
  assert.equal(trio("session-reconcile").count([{ sessions: 0 }]), 0);
});

// ── session-reconcile: the dead feed ───────────────────────────────────────

test("a dead session feed is named as DEAD, never rendered as zero", () => {
  // Probed 2026-08-06 against the shared cluster: the newest telephony-session
  // workflow record is 2026-06-30 and there have been no
  // ringcentral.attribution.resolved events since. A task reporting
  // "0 sessions reconciled" every night would read as "attribution is clean".
  // A Date, NOT an ISO string — plan() reads through .lean(), so this is the
  // shape describe() actually receives. Feeding it a string here would let
  // String(date).slice(0,10) pass while rendering "Tue Jun 30" in production.
  const stale = new Date(Date.now() - 37 * 86400000);
  const summary = trio("session-reconcile").describe([
    { domain: "TAG", sessions: 0, newestEver: stale },
    { domain: "WYNN", sessions: 0, newestEver: null },
  ]);
  assert.match(summary, /FEED IS DEAD/, "a dead feed must say so");
  assert.match(summary, /37 days/);
  assert.match(summary, new RegExp(stale.toISOString().slice(0, 10)),
    "the date must carry its YEAR — this banner exists to show how long it has been dead");
  assert.doesNotMatch(summary, /^0 /, "it must not open with a count that implies success");
});

test("a feed that is merely quiet today is NOT called dead", () => {
  const recent = new Date(Date.now() - 6 * 3600000);
  const summary = trio("session-reconcile").describe([
    { domain: "TAG", sessions: 0, newestEver: recent },
  ]);
  assert.doesNotMatch(summary, /DEAD/);
  assert.match(summary, /no unattributed sessions/);
});

test("a feed we could not COUNT is not an empty feed", () => {
  const summary = trio("session-reconcile").describe([
    { domain: "TAG", sessions: null, newestEver: null, error: "connection lost" },
  ]);
  assert.match(summary, /COULD NOT COUNT/);
  assert.match(summary, /connection lost/);
});

test("session-reconcile reports what the scan cap left UNEXAMINED", async () => {
  // The service stops at `limit` and says nothing about it. 166 is an RC-call
  // budget, not a truncation boundary: the scan loop breaks on the raw limit
  // while the fetch is repo-clamped at 500 either way, so this caps one domain
  // at ~332 call-log GETs rather than ~1000. Above it, sessions go unexamined.
  const summary = trio("session-reconcile").describe([
    { domain: "TAG", sessions: 400, newestEver: new Date(), examineCap: 166 },
  ]);
  assert.match(summary, /CAP 166/);
  assert.match(summary, /TAG leaves 234 unexamined/);

  const calls = [];
  const applied = await trio("session-reconcile").apply([{ domain: "TAG", sessions: 400 }], {
    sessionReconcileImpl: async (args) => {
      calls.push(args);
      return { stats: { scanned: 166, resolved: 3, unmatched: 2, errors: 0 } };
    },
  });
  assert.equal(calls[0].limit, 166, "must not ask for more than the repository will return");
  assert.equal(calls[0].sinceMs, 26 * 3600000, "the window must overlap last night's");
  assert.equal(applied.written, 3);
  assert.equal(applied.truncated, 234, "sessions never examined must be counted, not dropped");
});

test("session-reconcile does not call RingCentral for a domain with no sessions", async () => {
  // plan() counts the feed precisely so apply() can skip. Asking RC about a
  // dead feed burns quota to learn nothing, and an RC 429 opens a process-wide
  // circuit that would take the rest of the pass down with it.
  let called = 0;
  const applied = await trio("session-reconcile").apply(
    [{ domain: "TAG", sessions: 0 }, { domain: "WYNN", sessions: 0 }],
    { sessionReconcileImpl: async () => { called += 1; return { stats: {} }; } },
  );
  assert.equal(called, 0, "no sessions means no RC call");
  assert.equal(applied.skipped, 2);
  assert.equal(applied.written, 0);
});

test("one domain's RingCentral failure does not cost the others", async () => {
  const applied = await trio("session-reconcile").apply(
    [{ domain: "TAG", sessions: 5 }, { domain: "WYNN", sessions: 5 }],
    {
      sessionReconcileImpl: async ({ domain }) => {
        if (domain === "TAG") throw new Error("RC 429 rate limited");
        return { stats: { scanned: 5, resolved: 2, unmatched: 0, errors: 0 } };
      },
    },
  );
  assert.equal(applied.written, 2, "WYNN still reconciled");
  assert.equal(applied.failed, 1);
  assert.match(applied.errors[0], /TAG: RC 429/);
});

// ── payment-reconcile: the cap that has to finish ──────────────────────────

test("payment-reconcile is capped at 500/domain, NOT the 10,000 first proposed", async () => {
  const planned = await trio("payment-reconcile").plan({ domains: ["TAG", "WYNN", "AMITY"] });
  assert.equal(planned[0].maxCases, 500);
  // The loop is serial and unpaced at one Logics round-trip per case, against a
  // 45-minute claim lease. 10,000 x 3 domains does not finish before morning.
  assert.ok(
    planned[0].maxCases * planned[0].domains.length <= 2000,
    "the whole pass must fit inside the claim lease",
  );
});

test("the two payment caps are INDEPENDENT — Phase A shared one and should not have", async () => {
  await withEnv({
    NIGHTLY_PAYMENT_RECONCILE_MAX_CASES: "1200",
    NIGHTLY_PAYMENT_FIELDS_SYNC_MAX_CASES: undefined,
  }, async () => {
    const rec = await trio("payment-reconcile").plan({ domains: ["TAG"] });
    const fld = await trio("payment-fields-sync").plan({ domains: ["TAG"] });
    assert.equal(rec[0].maxCases, 1200, "the reconciler takes its own override");
    assert.equal(fld[0].maxCases, 500, "widening the reconciler must not widen the fields sync");
  });
});

test("payment-reconcile emits retry jobs on the lane something actually drains", async () => {
  // drainHourlyJobQueue runs every 60s OUTSIDE the dead scheduledPhase gate, so
  // the hourly LANE is alive. The "nightly" lane hardcodes 02:00, which is not
  // when this pass fires and has no claimer.
  const seen = [];
  await trio("payment-reconcile").apply([{ domains: ["TAG"], maxCases: 500 }], {
    paymentReconcileImpl: async (a) => { seen.push(a); return { newLedgerRows: 0 }; },
  });
  assert.equal(seen[0].lane, "hourly");
  assert.equal(seen[0].maxCases, 500);
});

test("the retry those jobs ride on has a CLAIMER, not just a live lane", () => {
  // The lane being drained is only half of it. server.js drains through a
  // handler whitelist (scheduledPhaseLite is hardcoded true), and a handler
  // missing from that list is filtered out with no error — the job sits
  // `pending` forever, and never dead-letters either, because
  // markHourlyJobFailed only dead-letters a CLAIMED attempt.
  //
  // paymentReconcileService:301 emits handlerKey "reconcileCasePayments" on any
  // non-404 Logics failure. Folding that service into the nightly pass without
  // this key in the whitelist would have stranded every retry it produces.
  const source = require("node:fs").readFileSync(
    require.resolve("../../apps/control-plane/src/server"), "utf8",
  );
  const list = source.match(/BUSINESS_HOURS_LITE_HOURLY_HANDLER_KEYS = Object\.freeze\(\[([\s\S]*?)\]\)/);
  assert.ok(list, "the lite handler whitelist must still exist");
  assert.match(list[1], /"reconcileCasePayments"/,
    "payment-reconcile's retry handler must be drainable");

  // And it must actually be registered, or the whitelist entry is a dead name.
  const handlerSource = require("node:fs").readFileSync(
    require.resolve("../../packages/shared-services/src/hourlyJobHandlers"), "utf8",
  );
  assert.match(handlerSource, /register\("reconcileCasePayments"/);
});

test("payment-reconcile counts ledger rows written, and survives one domain failing", async () => {
  const applied = await trio("payment-reconcile").apply(
    [{ domains: ["TAG", "WYNN", "AMITY"], maxCases: 500 }],
    {
      paymentReconcileImpl: async ({ domain }) => {
        if (domain === "WYNN") throw new Error("Logics timeout");
        return {
          casesScanned: 100, casesWithPayments: 40, newLedgerRows: 7,
          flaggedFailures: 2, reversals: 1, errors: 0,
        };
      },
    },
  );
  assert.equal(applied.written, 14, "7 rows each from TAG and AMITY");
  assert.equal(applied.casesScanned, 200);
  assert.equal(applied.flaggedFailures, 4);
  assert.equal(applied.failed, 1);
  assert.match(applied.errors[0], /WYNN: Logics timeout/);
});

// ── payment-fields-sync: the windows Phase A never forwarded ───────────────

test("payment-fields-sync widens the windows an hourly job left behind", async () => {
  // Two widen and one goes the OTHER way. lookbackHours and lockTtlMs grow for
  // the obvious reason; staleCheckMs grows too, which is the opposite of the
  // first cut. Shrinking it to 20h made the candidate query's stale clause match
  // the entire domain, and the service slices an UNSORTED union to the cap.
  const seen = [];
  const planned = await trio("payment-fields-sync").plan({ domains: ["TAG"] });
  await trio("payment-fields-sync").apply(planned, {
    paymentFieldsSyncImpl: async (a) => { seen.push(a); return { casesUpdated: 0 }; },
  });
  const call = seen[0];
  assert.equal(call.lookbackHours, 26, "a 6h window run once a night sees a quarter of the day");
  assert.ok(
    call.staleCheckMs > 24 * 3600000,
    "a stale check SHORTER than the run interval matches every profile in the domain",
  );
  assert.ok(
    call.lockTtlMs > 10 * 60 * 1000,
    "the lock is never extended, so a long nightly run would lose mutual exclusion",
  );
  assert.equal(call.lockedBy, "nightly-hygiene", "not 'hourly-sweep' — a lock holder must be identifiable");
});

test("a lock-busy fields sync is reported, not counted as a clean zero", async () => {
  const applied = await trio("payment-fields-sync").apply(
    [{ domains: ["TAG", "WYNN"], maxCases: 500, lookbackHours: 26, staleCheckMs: 72000000 }],
    {
      paymentFieldsSyncImpl: async ({ domain }) => (domain === "TAG"
        ? { skipped: true, reason: "lock-busy" }
        : {
          casesScanned: 50, casesWithDrift: 3, casesUpdated: 3,
          totalDriftDollars: 120.5, errors: 0,
        }),
    },
  );
  assert.equal(applied.lockBusy, 1, "a skipped domain must be visible");
  assert.equal(applied.written, 3, "and must not inflate or zero the domain that did run");
  assert.equal(applied.casesWithDrift, 3);
});

test("a fields sync skipped for an unexpected reason surfaces that reason", async () => {
  const applied = await trio("payment-fields-sync").apply(
    [{ domains: ["TAG"], maxCases: 500, lookbackHours: 26, staleCheckMs: 72000000 }],
    { paymentFieldsSyncImpl: async () => ({ skipped: true, reason: "missing-domain" }) },
  );
  assert.equal(applied.written, 0);
  assert.match(applied.errors[0], /skipped — missing-domain/);
});

test("both summary-shaped tasks describe what they WILL do, not a bare count", () => {
  const rec = trio("payment-reconcile").describe([{ domains: ["TAG", "WYNN"], maxCases: 500 }]);
  assert.match(rec, /up to 500 case\(s\) per domain across TAG, WYNN/);
  const fld = trio("payment-fields-sync").describe([{
    domains: ["TAG"], maxCases: 500, lookbackHours: 26, staleCheckMs: 30 * 86400000,
  }]);
  assert.match(fld, /26h lookback, 30d stale check/);
});

// ── the partial-failure hole the first cut of this task left open ──────────

test("ONE domain we could not count is not folded into the others' zero", () => {
  // The first version guarded only the all-domains-failed case, so a single
  // domain's Mongo hiccup rendered as "no unattributed sessions in the window"
  // — or, when the readable domains were legitimately empty, as the confident
  // "THE SESSION FEED IS DEAD". Both are the could-not-look / was-not-there
  // conflation this task exists to prevent.
  const mixedEmpty = trio("session-reconcile").describe([
    { domain: "TAG", sessions: null, newestEver: null, error: "connection lost" },
    { domain: "WYNN", sessions: 0, newestEver: null },
    { domain: "AMITY", sessions: 0, newestEver: null },
  ]);
  assert.match(mixedEmpty, /TAG NOT COUNTED/);
  assert.match(mixedEmpty, /connection lost/);
  assert.doesNotMatch(mixedEmpty, /FEED IS DEAD/,
    "a dead-feed verdict must not be reached on partial evidence");

  const mixedBusy = trio("session-reconcile").describe([
    { domain: "TAG", sessions: null, newestEver: null, error: "connection lost" },
    { domain: "WYNN", sessions: 5, newestEver: new Date() },
  ]);
  assert.match(mixedBusy, /TAG NOT COUNTED/);
  assert.match(mixedBusy, /5 session\(s\)/);
});

test("an uncounted domain is a FAILURE in apply(), not the empty-domain bucket", async () => {
  // `skipped` means "asked, nothing there". A domain whose feed count threw was
  // never asked, and charging it to the same counter loses the tenant silently.
  let called = 0;
  const applied = await trio("session-reconcile").apply(
    [
      { domain: "TAG", sessions: null, error: "connection lost" },
      { domain: "WYNN", sessions: 0 },
      { domain: "AMITY", sessions: 3 },
    ],
    {
      sessionReconcileImpl: async () => {
        called += 1;
        return { stats: { scanned: 3, resolved: 1, unmatched: 0, errors: 0 } };
      },
    },
  );
  assert.equal(called, 1, "only AMITY had anything to examine");
  assert.equal(applied.skipped, 1, "WYNN was asked and was empty");
  assert.equal(applied.failed, 1, "TAG was never asked — that is a failure");
  assert.match(applied.errors[0], /TAG: NOT EXAMINED — connection lost/);
  assert.equal(applied.written, 1);
});

test("a fields sync that was lock-busy on EVERY domain is a failed night", async () => {
  // The lock is global, not per-domain, so one stale lock blocks all three for
  // its full TTL — longer than the runtime's whole retry budget. Counting that
  // as skipped would render casesWithDrift 0, identical to a night with no drift.
  const applied = await trio("payment-fields-sync").apply(
    [{ domains: ["TAG", "WYNN", "AMITY"], maxCases: 500, lookbackHours: 26, staleCheckMs: 2592000000 }],
    { paymentFieldsSyncImpl: async () => ({ skipped: true, reason: "lock-busy" }) },
  );
  assert.equal(applied.lockBusy, 3);
  assert.equal(applied.failed, 1, "a night that synced nothing must not read as clean");
  assert.match(applied.errors[0], /every domain was lock-busy/);
});

test("payment-fields-sync targets CHANGE, not a degenerate domain-wide audit", async () => {
  // staleCheckMs below the run interval makes the candidate query's last clause
  // match every profile in the domain (measured 93,076 of 93,076 for TAG), and
  // the service slices an UNSORTED union to the cap — so the same head-500 ids
  // are swept forever. Every case it touches also gets payment-reconcile's
  // lastCheckedAt stamped, including on the no-drift path that never calls
  // Logics, which pushes never-pulled cases to the back of reconcile's wheel.
  const planned = await trio("payment-fields-sync").plan({ domains: ["TAG"] });
  assert.ok(planned[0].staleCheckMs > 24 * 3600000,
    "a stale check shorter than the run interval matches the whole domain");
  assert.ok(planned[0].staleCheckMs >= 7 * 86400000,
    "it must be long enough that the drift signals, not the stale clause, pick candidates");
});

test("payment-reconcile says when its cap BOUND the night", async () => {
  // Run once a night with the service's 1-hour staleAfterMs default, every
  // profile is due, so the lane fills to the cap on any domain bigger than it.
  // A saturated night is a partial night and has to say so.
  const applied = await trio("payment-reconcile").apply(
    [{ domains: ["TAG", "AMITY"], maxCases: 500 }],
    {
      paymentReconcileImpl: async ({ domain }) => (domain === "TAG"
        ? { casesScanned: 555, newLedgerRows: 4, errors: 0 }
        : { casesScanned: 64, newLedgerRows: 1, errors: 0 }),
    },
  );
  assert.equal(applied.capSaturated, 1, "TAG filled its cap, AMITY did not");
  assert.equal(applied.domains.find((d) => d.domain === "TAG").capSaturated, true);
  assert.equal(applied.domains.find((d) => d.domain === "AMITY").capSaturated, false);
});
