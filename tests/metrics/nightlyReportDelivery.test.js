"use strict";

// DELIVERY: the three ways a night can be lost or doubled.
//
// runDefinition talks to Mongo and to every live service, so the composer and
// the model are stubbed here. The subject under test is the ORDER of
// operations around the send — claim, mail, record — which is where all three
// failures live and which no amount of live data would exercise on a good day.

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Captured before any stubbing: the CSV builder is a pure function of the
// report and IS part of what these tests check, so it stays real.
const { renderCsvs } = require("../../packages/shared-services/src/reportComposerService");

const CANNED = {
  from: "2026-07-30", to: "2026-07-30", domain: "ALL",
  sections: [], notes: [], failures: [], filters: [],
};

/**
 * Load reportDefinitionService with its two heavy dependencies replaced.
 * `model` records every write so a test can assert on ordering.
 */
function loadService({ report = CANNED } = {}) {
  const calls = [];
  const model = {
    _lastRunKey: null,
    async findOneAndUpdate(filter, update) {
      calls.push({ op: "claim", key: update.$set.lastRunKey });
      // Mirror Mongo: `{ lastRunKey: { $ne: key } }` MATCHES when the stored
      // key differs, so the update lands exactly once per day. The whole point
      // of the guard is that the second caller matches nothing.
      if (model._lastRunKey !== filter.lastRunKey.$ne) {
        model._lastRunKey = update.$set.lastRunKey;
        return { _id: 1 };
      }
      return null;
    },
    async updateOne(filter, update) {
      calls.push({ op: "release", key: update.$set.lastRunKey });
      model._lastRunKey = update.$set.lastRunKey;
      return { acknowledged: true };
    },
    find: async () => [],
  };

  const realLoad = Module._load;
  const stubs = [
    [/shared-models[\\/]src[\\/]ReportDefinition$/, model],
    [/[\\/]reportComposerService$/, {
      composeReport: async () => report,
      renderText: () => "text",
      renderHtml: () => "<html></html>",
      renderCsvs,
      toTemplateData: () => ({ sections: [], alerts: report.failures || [] }),
    }],
  ];
  Module._load = function load(request, parent, isMain) {
    for (const [re, impl] of stubs) if (re.test(request)) return impl;
    return realLoad.apply(this, [request, parent, isMain]);
  };
  const path = require.resolve("../../packages/shared-services/src/reportDefinitionService");
  delete require.cache[path];
  let svc;
  try { svc = require(path); } finally {
    Module._load = realLoad;
    delete require.cache[path];
  }
  return { svc, model, calls };
}

const def = (o = {}) => ({
  _id: 1, name: "financial roll up with calls", blocks: ["rollup"], range: "today",
  domain: null, sendEmail: true, recipients: ["mgray@taxadvocategroup.com"],
  filters: [], lastRunKey: null, save: async () => {}, ...o,
});

const NOW = new Date("2026-07-31T03:30:00Z"); // 2026-07-30 20:30 Pacific

test("a definition armed to send with NO recipients throws instead of filing a clean run", async () => {
  // It used to fall through, stamp lastRunKey, bump runCount and NULL
  // lastError — so isDue answered "already ran today" and every status surface
  // reported success while no mail existed anywhere.
  const { svc } = loadService();
  let saved = false;
  await assert.rejects(
    () => svc.runDefinition(def({ name: "ad hoc report", recipients: [], save: async () => { saved = true; } }),
      { now: NOW, sendMail: async () => {} }),
    /no recipients/,
  );
  assert.equal(saved, false, "a run that sent nothing must not record itself at all");
});

test("the two nightly boards use their fixed recipient audiences", async () => {
  const { svc } = loadService();
  const sends = [];
  await svc.runDefinition(def({ recipients: ["stale@example.test"] }), {
    now: NOW,
    sendMail: async (_domain, options) => sends.push(options.to),
  });
  assert.deepEqual(sends[0], [
    "mgray@taxadvocategroup.com",
    "abanks@taxadvocategroup.com",
    "manderson@taxadvocategroup.com",
    "jonathan13pineda@yahoo.com",
  ]);

  const vendor = loadService();
  await vendor.svc.runDefinition(def({
    name: "vendor roll up with calls",
    recipients: ["stale@example.test"],
  }), {
    now: NOW,
    sendMail: async (_domain, options) => sends.push(options.to),
  });
  assert.deepEqual(sends[1], ["mgray@taxadvocategroup.com", "liz@lizdev.com"]);
});

test("the day is claimed BEFORE the mail goes out", async () => {
  // The gap between "mail accepted" and "day stamped" was wide enough that a
  // restart inside it re-sent the whole board on the next poll — and start()
  // polls immediately.
  const { svc, calls } = loadService();
  const order = [];
  await svc.runDefinition(def(), {
    now: NOW,
    sendMail: async () => { order.push("mail"); },
  });
  assert.equal(calls[0].op, "claim");
  assert.equal(calls[0].key, "2026-07-30", "claimed under the PACIFIC day");
  assert.deepEqual(order, ["mail"]);
});

test("a second run the same day claims nothing and sends nothing", async () => {
  const { svc, model } = loadService();
  model._lastRunKey = "2026-07-30";
  let sent = 0;
  const result = await svc.runDefinition(def({ lastRunKey: "2026-07-30" }), {
    now: NOW, sendMail: async () => { sent += 1; },
  });
  assert.equal(sent, 0);
  assert.equal(result.delivered, false);
  assert.match(result.skipped, /already claimed/);
});

test("a failed send gives the day back so the next poll retries", async () => {
  // Without the release a transient SMTP blip at 20:30 costs the whole night,
  // because the day is already claimed and isDue says "already ran".
  const { svc, model, calls } = loadService();
  await assert.rejects(
    () => svc.runDefinition(def(), {
      now: NOW,
      sendMail: async () => { throw new Error("SMTP 421"); },
    }),
    /SMTP 421/,
  );
  assert.deepEqual(calls.map((c) => c.op), ["claim", "release"]);
  assert.equal(model._lastRunKey, null, "back to where it started");
});

test("the send path cannot be broken by the fact store — it never touches it", async () => {
  // This used to assert the ordering ["mail-accepted","fact-write"] INSIDE
  // runDefinition, and that a throwing fact writer still left the claim held.
  // The snapshot moved out of the send path on 2026-08-04, so the guarantee is
  // now structural rather than defended by a try/catch: runDefinition cannot
  // release the claim over a fact failure because it does not write the fact.
  //
  // The property being protected is unchanged and is the important one — a mail
  // provider has accepted this email, and nothing afterwards may make the day
  // sendable again, or the next five-minute poll sends it a second time.
  const qualifying = {
    ...CANNED,
    selection: ["topline", "source", "ldcalls", "status", "longcalls"],
  };
  const { svc, model, calls } = loadService({ report: qualifying });
  const order = [];
  let factWriterCalled = false;
  const result = await svc.runDefinition(def(), {
    now: NOW,
    sendMail: async () => { order.push("mail-accepted"); },
    dailyFactWriter: async () => {
      factWriterCalled = true;
      throw new Error("fact store unavailable");
    },
  });
  assert.deepEqual(order, ["mail-accepted"]);
  assert.equal(factWriterCalled, false, "sending must not write the daily fact");
  assert.equal(result.delivered, true);
  assert.deepEqual(calls.map((call) => call.op), ["claim"]);
  assert.equal(model._lastRunKey, "2026-07-30", "accepted mail must never become sendable again");
});

test("a degraded board announces itself in the SUBJECT, not just the body", async () => {
  // The banner only helps someone who opened the mail. The point of a nightly
  // is that most nights you read the subject and move on.
  const { svc } = loadService({ report: { ...CANNED, failures: ["dials unavailable — ECONNREFUSED"] } });
  let subject = null;
  await svc.runDefinition(def(), { now: NOW, sendMail: async (d, o) => { subject = o.subject; } });
  assert.match(subject, /^\[DEGRADED\] /);
});

test("a clean board carries no marker", async () => {
  const { svc } = loadService();
  let subject = null;
  await svc.runDefinition(def(), { now: NOW, sendMail: async (d, o) => { subject = o.subject; } });
  assert.doesNotMatch(subject, /DEGRADED/);
  assert.match(subject, /^financial roll up with calls · 2026-07-30/);
});

test("lastError records a source that did not answer, not only a block that threw", async () => {
  // `sections[].error` catches a block exception. A total Logics outage throws
  // nothing — it composes five well-formed sections of zero — so the union is
  // what makes three bad nights in a row visible.
  const { svc } = loadService({ report: { ...CANNED, failures: ["queue counts unavailable — 429"] } });
  let recorded;
  await svc.runDefinition(def({ save: async function save() { recorded = this.lastError; } }),
    { now: NOW, sendMail: async () => {} });
  assert.match(recorded, /queue counts unavailable/);
});

test("a clean run clears lastError and resets the attempt counter", async () => {
  const { svc } = loadService();
  const d = def({ lastError: "yesterday exploded", attemptsToday: 3, save: async () => {} });
  await svc.runDefinition(d, { now: NOW, sendMail: async () => {} });
  assert.equal(d.lastError, null);
  assert.equal(d.attemptsToday, 0, "a delivered night must not stay capped");
});

test("dryRun neither claims the day nor sends", async () => {
  const { svc, calls } = loadService();
  let sent = 0;
  const result = await svc.runDefinition(def(), { now: NOW, dryRun: true, sendMail: async () => { sent += 1; } });
  assert.equal(sent, 0);
  assert.equal(calls.length, 0, "inspecting a schedule must never consume the day");
  assert.equal(result.delivered, false);
});

test("attachCsv actually attaches a CSV per section", async () => {
  // The setting was stored on every definition and printed as "+csv" on the
  // schedule listing while nothing honoured it. A toggle that shows as on and
  // does nothing is worse than no toggle.
  const report = {
    ...CANNED,
    sections: [
      { id: "source", label: "By source", data: [{ source: "LD CUSTOM", roi: -40.8 }],
        block: { csv: () => ({ rows: [{ source: "LD CUSTOM", roi: -40.8 }],
          columns: [{ header: "source", get: (x) => x.source }, { header: "roi_pct", get: (x) => x.roi }] }) } },
      { id: "longcalls", label: "Calls worth hearing", data: [{ minutes: 12 }],
        block: { csv: () => ({ rows: [{ minutes: 12 }], columns: [{ header: "minutes", get: (x) => x.minutes }] }) } },
    ],
  };
  const { svc } = loadService({ report });
  let opts = null;
  await svc.runDefinition(def({ attachCsv: true }), { now: NOW, sendMail: async (d, o) => { opts = o; } });
  assert.equal(opts.attachments.length, 2, "one file per section, never one stacked sheet");
  assert.deepEqual(opts.attachments.map((a) => a.filename),
    ["source-2026-07-30.csv", "longcalls-2026-07-30.csv"]);
  const csv = opts.attachments[0].content.toString("utf8");
  assert.match(csv, /^source,roi_pct/, "the CSV keeps the columns the email drops");
  assert.match(csv, /LD CUSTOM,-40\.8/);
});

test("no attachCsv means no attachments", async () => {
  const { svc } = loadService();
  let opts = null;
  await svc.runDefinition(def({ attachCsv: false }), { now: NOW, sendMail: async (d, o) => { opts = o; } });
  assert.deepEqual(opts.attachments, []);
});
