"use strict";

// THE LAST LINK: a retained provider recording reference becomes a listen link.
//
// Capture already works. Every live PhoneBurner Call End carries a recording
// value; none of them validate, because the provider sends a plain `http:`
// locator and the strict capture policy accepts `https:` only. So the value is
// held as `safePayload.recordingReference` with status `retained_unparsed` and
// nothing downstream ever sees it.
//
// These tests assert on RETURNED DATA at every hop of the real chain:
//
//   safePayload.recordingReference
//     -> resolveRecordingLocator          (promotion policy)
//     -> recordDailyDialOffload           (attempt.recordingUrl)
//     -> DailyDial -> CallLog projection  (recordingArchive.sourceUri)
//     -> the report block that renders the nightly email (listenUrl)
//
// NO TEST PRINTS A LINK. The synthetic host below is a reserved `.example`
// name and never appears in any assertion message.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  promoteRetainedRecordingReference,
  resolveRecordingLocator,
} = require("../../packages/shared-services/src/recordingReferencePromotionService");
const {
  recordDailyDialOffload,
} = require("../../packages/shared-services/src/dailyDialLedgerService");
const {
  createDailyDialCallLogProjection,
} = require("../../packages/shared-services/src/dailyDialCallLogProjectionService");
const {
  buildCapturedEventUpgrade,
} = require("../../packages/shared-services/src/leadDeliveryService");
const {
  createRecordLeadDeliveryDailyDial,
} = require("../../apps/control-plane/src/services/leadDeliveryDailyDialAction");
const blocks = require("../../packages/shared-services/src/reportBlocksService");

const HOST = "media.phoneburner.example";
const ALLOWED = [HOST];
const CALL_ID = "3050145953";
const NEAR_MATCH_CALL_ID = "305014595";
const LINK = `http://${HOST}/r/${CALL_ID}.mp3?signature=kept`;
const NEAR_MATCH_LINK = `http://${HOST}/r/${NEAR_MATCH_CALL_ID}.mp3`;
const VALIDATED_LINK = `https://${HOST}/r/${CALL_ID}-validated.mp3`;

// Everything the retained-reference shape carries out of the callback route.
const retained = (reference) => ({
  recordingUrl: null,
  recordingSourceKey: null,
  recordingCandidateStatus: "retained_unparsed",
  recordingReference: reference,
  recordingReferenceSourceKey: "recording_link_public",
});

const validated = (url) => ({
  recordingUrl: url,
  recordingSourceKey: "recording_url_public",
  recordingCandidateStatus: "captured",
  recordingReference: null,
  recordingReferenceSourceKey: null,
});

function clone(value) {
  return value == null ? value : structuredClone(value);
}

// One-document DailyDial stand-in, same shape the ledger suite uses.
function fakeDailyDialModel() {
  let doc = null;
  let currentAttemptKey = null;
  function matchesIdentity(filter) {
    return doc && doc.domain === filter.domain && doc.caseId === filter.caseId && doc.dateKey === filter.dateKey;
  }
  function setAttemptPath(path, value) {
    const match = path.match(/^attempts\.\$\.(.+)$/);
    if (!match) return;
    const attempt = doc.attempts.find((entry) => entry.attemptKey === currentAttemptKey);
    if (attempt) attempt[match[1]] = clone(value);
  }
  return {
    get doc() { return doc; },
    async findOneAndUpdate(filter, update) {
      if (!doc) {
        doc = {
          _id: "daily-1",
          contactedToday: 0,
          capped: false,
          countedAttemptKeys: [],
          attempts: [],
          cadencePersistedAt: null,
          ...clone(update.$setOnInsert || {}),
        };
      }
      Object.assign(doc, clone(update.$set || {}));
      return clone(doc);
    },
    findOne(filter) {
      const found = matchesIdentity(filter) ? clone(doc) : null;
      return { async lean() { return found; } };
    },
    async updateOne(filter, update) {
      if (!matchesIdentity(filter) && filter._id !== doc?._id) return { matchedCount: 0 };
      if (matchesIdentity(filter)) {
        if (filter.terminal?.$ne === true && doc.terminal === true) return { matchedCount: 0 };
        if (filter.capped?.$ne === true && doc.capped === true) return { matchedCount: 0 };
        if (Array.isArray(filter.$or)) {
          const currentEnd = doc.callEndedAt ? new Date(doc.callEndedAt) : null;
          const matchesLatest = filter.$or.some((condition) => {
            if (condition.callEndedAt === null) return doc.callEndedAt == null;
            if (condition.callEndedAt?.$exists === false) return doc.callEndedAt === undefined;
            if (condition.callEndedAt?.$lte) {
              return !currentEnd || currentEnd.getTime() <= new Date(condition.callEndedAt.$lte).getTime();
            }
            return false;
          });
          if (!matchesLatest) return { matchedCount: 0 };
        }
      }
      if (filter["attempts.attemptKey"]) {
        currentAttemptKey = filter["attempts.attemptKey"];
        if (!doc.attempts.some((entry) => entry.attemptKey === currentAttemptKey)) {
          return { matchedCount: 0 };
        }
      }
      const unseen = filter.countedAttemptKeys?.$ne;
      if (unseen && doc.countedAttemptKeys.includes(unseen)) return { matchedCount: 0 };
      for (const [path, value] of Object.entries(update.$set || {})) {
        if (path.startsWith("attempts.$.")) setAttemptPath(path, value);
        else doc[path] = clone(value);
      }
      for (const [path, value] of Object.entries(update.$max || {})) {
        doc[path] = Math.max(Number(doc[path] || 0), Number(value));
      }
      if (update.$addToSet?.countedAttemptKeys
        && !doc.countedAttemptKeys.includes(update.$addToSet.countedAttemptKeys)) {
        doc.countedAttemptKeys.push(update.$addToSet.countedAttemptKeys);
      }
      if (update.$push?.attempts) doc.attempts.push(clone(update.$push.attempts));
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
}

const dialAction = (over = {}) => ({
  domain: "TAG",
  caseId: 42,
  leadReceivedAt: new Date("2026-08-03T15:00:00.000Z"),
  normalizedPhone: "5555550100",
  originPool: "new_today",
  provider: "phoneburner",
  agentId: "chris_bolt",
  providerAttemptKey: "attempt-1",
  providerCallId: CALL_ID,
  normalizedOutcome: "answered",
  connected: true,
  dailyAttemptDateKey: "2026-08-03",
  dailyAttemptCount: 1,
  totalAttemptCount: 1,
  completedAt: new Date("2026-08-03T21:30:00.000Z"),
  callStartedAt: new Date("2026-08-03T21:15:00.000Z"),
  durationSeconds: 900,
  recordingUrl: null,
  ...over,
});

async function projectToCallLog(model, dateKey = "2026-08-03") {
  const projected = new Map();
  const reconcile = createDailyDialCallLogProjection({
    DailyDial: {
      find() {
        return {
          sort() { return this; },
          async lean() { return [clone(model.doc)]; },
        };
      },
    },
    upsertCallLog: async (input) => {
      const key = `${input.domain}:${input.telephonySessionId}`;
      projected.set(key, { ...(projected.get(key) || {}), ...clone(input) });
      return clone(projected.get(key));
    },
    now: () => new Date("2026-08-04T05:00:00.000Z"),
  });
  const result = await reconcile({ dateKey });
  return { projected, result };
}

// The exact join reportComposerService performs to hand the report block its
// media authority: DOMAIN + providerCallId, off the persisted CallLog only.
function joinPersistedRecordings(projected, row) {
  const byAttempt = new Map();
  for (const callLog of projected.values()) {
    const sourceUri = String(callLog["recordingArchive.sourceUri"] || "").trim();
    if (!sourceUri) continue;
    byAttempt.set(`${String(callLog.domain || "").toUpperCase()}:${String(callLog.providerCallId || "").trim()}`, sourceUri);
  }
  return {
    ...row,
    attempts: (row.attempts || []).map((attempt) => ({
      ...attempt,
      persistedRecordingUrl: byAttempt.get(
        `${String(row.domain || "").toUpperCase()}:${String(attempt.providerCallId || "").trim()}`,
      ) || null,
    })),
  };
}

const material = (over = {}) => ({
  callsRange: [],
  payments: [],
  callRecordings: {},
  callContext: {},
  dials: [],
  events: [],
  ldCaseStatus: {},
  ldCaseSource: {},
  from: "2026-08-03",
  to: "2026-08-03",
  domain: "TAG",
  ...over,
});

const capturedEvent = (over = {}) => ({
  provider: "phoneburner",
  eventType: "call_done",
  providerCallId: CALL_ID,
  providerContactId: "9911",
  providerExternalLeadId: "TAG:test:1",
  status: "pending",
  normalizedOutcome: "no_answer",
  safePayload: retained(null),
  ...over,
});

// ── 1. the whole chain ───────────────────────────────────────────────────

test("an http PhoneBurner reference is promoted and reaches the emailed listen link", async () => {
  const locator = resolveRecordingLocator(retained(LINK), { allowedHosts: ALLOWED });
  assert.equal(locator.reason, "promoted");
  assert.equal(locator.strength, "promoted");
  assert.equal(locator.recordingUrl, LINK);

  const model = fakeDailyDialModel();
  const record = createRecordLeadDeliveryDailyDial({ DailyDial: model });
  const written = await record(dialAction({ recordingUrl: locator.recordingUrl }));
  assert.equal(written.ok, true);
  assert.equal(written.counted, true);
  assert.equal(model.doc.attempts.length, 1);
  assert.equal(model.doc.attempts[0].recordingUrl, LINK, "the link lands on the counted attempt");

  const { projected, result } = await projectToCallLog(model);
  assert.equal(result.rejected, 0);
  assert.equal(result.reconciled, 1);
  const callLog = projected.get(`TAG:phoneburner:${CALL_ID}`);
  assert.equal(callLog["recordingArchive.provider"], "phoneburner");
  assert.equal(callLog["recordingArchive.sourceUri"], LINK);

  const joined = joinPersistedRecordings(projected, {
    domain: "tag",
    caseId: "42",
    dateKey: "2026-08-03",
    attempts: [{ providerCallId: CALL_ID, durationSeconds: 900 }],
  });
  const rows = blocks.BY_ID.get("longcalls").compute(material({ dials: [joined] }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].listenUrl, LINK, "the nightly email row carries the promoted link");
  assert.equal(
    blocks.BY_ID.get("longcalls").renderText(rows).includes(LINK),
    true,
    "the rendered email body carries the link, as a link and never an attachment",
  );
});

// ── 2. what the promotion still refuses ──────────────────────────────────

test("a non-approved host is rejected, and a lookalike domain is not a match", () => {
  const unapproved = promoteRetainedRecordingReference(
    retained("http://recordings.other.example/r/x.mp3"),
    { allowedHosts: ALLOWED },
  );
  assert.equal(unapproved.recordingUrl, null);
  assert.equal(unapproved.reason, "reference-host-not-allowed");

  // `evilmedia.phoneburner.example`.endsWith(`media.phoneburner.example`) is
  // TRUE. Only exact host equality refuses it.
  const lookalikeSuffix = promoteRetainedRecordingReference(
    retained(`http://evil${HOST}/r/x.mp3`),
    { allowedHosts: ALLOWED },
  );
  assert.equal(lookalikeSuffix.recordingUrl, null);
  assert.equal(lookalikeSuffix.reason, "reference-host-not-allowed");

  const lookalikeSubdomain = promoteRetainedRecordingReference(
    retained(`http://${HOST}.attacker.example/r/x.mp3`),
    { allowedHosts: ALLOWED },
  );
  assert.equal(lookalikeSubdomain.recordingUrl, null);
  assert.equal(lookalikeSubdomain.reason, "reference-host-not-allowed");

  // A blank allowlist promotes nothing at all.
  const unconfigured = promoteRetainedRecordingReference(retained(LINK), { allowedHosts: [] });
  assert.equal(unconfigured.recordingUrl, null);
  assert.equal(unconfigured.reason, "recording-host-allowlist-empty");

  // A wildcard rule is accepted by the strict capture parser but may not widen
  // a promotion, so a config holding only wildcards promotes nothing.
  const wildcardOnly = promoteRetainedRecordingReference(retained(LINK), { allowedHosts: [`.${HOST}`] });
  assert.equal(wildcardOnly.recordingUrl, null);
  assert.equal(wildcardOnly.reason, "recording-host-allowlist-empty");
});

test("embedded credentials are rejected", () => {
  const credentialed = promoteRetainedRecordingReference(
    retained(`http://someuser:somesecret@${HOST}/r/x.mp3`),
    { allowedHosts: ALLOWED },
  );
  assert.equal(credentialed.recordingUrl, null);
  assert.equal(credentialed.reason, "reference-embedded-credentials");
  assert.equal(credentialed.reason.includes("somesecret"), false);
});

test("every other refusal has its own diagnosable reason and fails closed", () => {
  const cases = [
    [{}, "reference-absent"],
    [retained(null), "reference-absent"],
    [retained("   "), "reference-absent"],
    [{ ...retained(LINK), recordingReference: { nested: LINK } }, "reference-not-scalar"],
    [{ ...retained(LINK), recordingCandidateStatus: "captured" }, "reference-status-not-retained"],
    [retained(`http://${HOST}/r/${"a".repeat(2100)}.mp3`), "reference-too-long"],
    [retained("88213"), "reference-not-absolute-url"],
    [retained("provider-private-reference"), "reference-not-absolute-url"],
    [retained(`ftp://${HOST}/r/x.mp3`), "reference-protocol-not-http"],
    [retained("file:///etc/passwd"), "reference-protocol-not-http"],
    [retained("http://localhost/r/x.mp3"), "reference-host-forbidden"],
    [retained("http://recordings.internal/r/x.mp3"), "reference-host-forbidden"],
    [retained("http://10.0.0.1/r/x.mp3"), "reference-host-private-ip"],
    [retained("http://127.0.0.1/r/x.mp3"), "reference-host-private-ip"],
    [retained("http://[::1]/r/x.mp3"), "reference-host-private-ip"],
    [retained("http://recordings.local/r/x.mp3"), "reference-host-forbidden"],
  ];
  const reasons = new Set();
  for (const [payload, reason] of cases) {
    const outcome = promoteRetainedRecordingReference(payload, { allowedHosts: ALLOWED });
    assert.equal(outcome.recordingUrl, null, reason);
    assert.equal(outcome.reason, reason);
    reasons.add(outcome.reason);
  }
  assert.equal(reasons.size >= 8, true, "a failure must be diagnosable, not one catch-all code");

  // A private literal IP cannot be promoted even if someone allowlists it.
  const allowlistedPrivateIp = promoteRetainedRecordingReference(
    retained("http://10.0.0.1/r/x.mp3"),
    { allowedHosts: ["10.0.0.1"] },
  );
  assert.equal(allowlistedPrivateIp.recordingUrl, null);
  assert.equal(allowlistedPrivateIp.reason, "reference-host-private-ip");
});

// ── 3. never downgrade ───────────────────────────────────────────────────

test("a stronger validated recordingUrl is never overwritten by a retained reference", async () => {
  // The resolver prefers the validated URL and never consults the reference.
  const both = resolveRecordingLocator(
    { ...validated(VALIDATED_LINK), recordingReference: LINK, recordingReferenceSourceKey: "recording_link" },
    { allowedHosts: ALLOWED },
  );
  assert.equal(both.recordingUrl, VALIDATED_LINK);
  assert.equal(both.strength, "validated");

  // A later reference-only callback is NOT an upgrade and NOT a conflict.
  const noDowngrade = buildCapturedEventUpgrade(
    capturedEvent({ status: "completed", safePayload: validated(VALIDATED_LINK) }),
    capturedEvent({ status: "pending", safePayload: retained(LINK) }),
    { allowedRecordingHosts: ALLOWED },
  );
  assert.equal(noDowngrade, null, "a retained reference may not reopen an event holding a validated URL");

  // The reverse IS a strengthening: promoted evidence yields to validated.
  const strengthened = buildCapturedEventUpgrade(
    capturedEvent({ status: "completed", safePayload: retained(LINK) }),
    capturedEvent({ status: "pending", safePayload: validated(VALIDATED_LINK) }),
    { allowedRecordingHosts: ALLOWED },
  );
  assert.notEqual(strengthened, null);
  assert.equal(strengthened.set.status, "pending");
  assert.equal(
    resolveRecordingLocator(strengthened.set.safePayload, { allowedHosts: ALLOWED }).recordingUrl,
    VALIDATED_LINK,
  );

  // The ledger enforces the same rule on the attempt itself.
  const model = fakeDailyDialModel();
  await recordDailyDialOffload({
    model,
    cadence: { domain: "TAG", caseId: 42, receivedAt: new Date("2026-08-03T15:00:00.000Z") },
    originPool: "new_today",
    provider: "phoneburner",
    providerAttemptKey: "attempt-1",
    providerCallId: CALL_ID,
    normalizedOutcome: "answered",
    dailyAttemptDateKey: "2026-08-03",
    dailyAttemptCount: 1,
    totalAttemptCount: 1,
    callEndedAt: new Date("2026-08-03T21:30:00.000Z"),
    recordingUrl: VALIDATED_LINK,
  });
  assert.equal(model.doc.attempts[0].recordingUrl, VALIDATED_LINK);
  const weakerLater = await recordDailyDialOffload({
    model,
    cadence: { domain: "TAG", caseId: 42, receivedAt: new Date("2026-08-03T15:00:00.000Z") },
    originPool: "new_today",
    provider: "phoneburner",
    providerAttemptKey: "attempt-1",
    providerCallId: CALL_ID,
    normalizedOutcome: "answered",
    dailyAttemptDateKey: "2026-08-03",
    dailyAttemptCount: 1,
    totalAttemptCount: 1,
    callEndedAt: new Date("2026-08-03T21:30:00.000Z"),
    recordingUrl: LINK,
  });
  assert.equal(weakerLater.counted, false);
  assert.equal(model.doc.attempts.length, 1);
  assert.equal(model.doc.attempts[0].recordingUrl, VALIDATED_LINK, "the promoted reference did not win");

  // Two locators of the SAME strength that disagree still fail closed.
  await assert.rejects(recordDailyDialOffload({
    model,
    cadence: { domain: "TAG", caseId: 42, receivedAt: new Date("2026-08-03T15:00:00.000Z") },
    originPool: "new_today",
    provider: "phoneburner",
    providerAttemptKey: "attempt-1",
    providerCallId: CALL_ID,
    normalizedOutcome: "answered",
    dailyAttemptDateKey: "2026-08-03",
    dailyAttemptCount: 1,
    totalAttemptCount: 1,
    callEndedAt: new Date("2026-08-03T21:30:00.000Z"),
    recordingUrl: `https://${HOST}/r/${CALL_ID}-other.mp3`,
  }), /recording conflict/);
});

test("a first reference fills an empty slot on an already completed event", () => {
  const upgrade = buildCapturedEventUpgrade(
    capturedEvent({
      status: "completed",
      localAppliedAt: new Date("2026-08-03T21:30:01.000Z"),
      downstreamAppliedAt: new Date("2026-08-03T21:30:02.000Z"),
      safePayload: retained(null),
    }),
    capturedEvent({ status: "pending", safePayload: retained(LINK) }),
    { allowedRecordingHosts: ALLOWED },
  );
  assert.notEqual(upgrade, null);
  assert.equal(upgrade.set.status, "pending");
  assert.equal(upgrade.set.normalizedOutcome, "no_answer", "recording evidence never moves the outcome");
  assert.notEqual(upgrade.set.localAppliedAt, null, "business effects are not replayed");
  assert.notEqual(upgrade.set.downstreamAppliedAt, null);
  assert.equal(
    resolveRecordingLocator(upgrade.set.safePayload, { allowedHosts: ALLOWED }).recordingUrl,
    LINK,
  );

  // An unpromotable reference is not evidence and reopens nothing.
  const notEvidence = buildCapturedEventUpgrade(
    capturedEvent({ status: "completed", safePayload: retained(null) }),
    capturedEvent({ status: "pending", safePayload: retained("88213") }),
    { allowedRecordingHosts: ALLOWED },
  );
  assert.equal(notEvidence, null);
});

// ── 4. idempotency and exactness ─────────────────────────────────────────

test("promoting the same reference twice changes nothing and creates no attempt", async () => {
  const model = fakeDailyDialModel();
  const record = createRecordLeadDeliveryDailyDial({ DailyDial: model });
  const link = resolveRecordingLocator(retained(LINK), { allowedHosts: ALLOWED }).recordingUrl;

  const first = await record(dialAction({ recordingUrl: link }));
  const second = await record(dialAction({ recordingUrl: link }));
  const third = await record(dialAction({ recordingUrl: link }));

  assert.equal(first.counted, true);
  assert.equal(second.counted, false);
  assert.equal(third.counted, false);
  assert.equal(model.doc.attempts.length, 1, "a replayed recording never appends an attempt");
  assert.equal(model.doc.contactedToday, 1, "a replayed recording never advances the daily count");
  assert.equal(model.doc.countedAttemptKeys.length, 1);
  assert.equal(model.doc.attempts[0].recordingUrl, link);

  const firstPass = await projectToCallLog(model);
  const secondPass = await projectToCallLog(model);
  assert.equal(firstPass.projected.size, 1);
  assert.equal(secondPass.projected.size, 1, "a nightly rerun projects one CallLog, not two");
  assert.equal(
    secondPass.projected.get(`TAG:phoneburner:${CALL_ID}`)["recordingArchive.sourceUri"],
    link,
  );
});

test("the link lands on the exact attempt and CallLog row, never on a near-match", async () => {
  const model = fakeDailyDialModel();
  const record = createRecordLeadDeliveryDailyDial({ DailyDial: model });
  // A near-match provider call id on the same case, same day: only the exact
  // call whose callback carried the reference may gain the link.
  await record(dialAction({
    providerAttemptKey: "attempt-near",
    providerCallId: NEAR_MATCH_CALL_ID,
    dailyAttemptCount: 1,
    totalAttemptCount: 1,
    completedAt: new Date("2026-08-03T20:00:00.000Z"),
    recordingUrl: null,
  }));
  await record(dialAction({
    providerAttemptKey: "attempt-exact",
    providerCallId: CALL_ID,
    dailyAttemptCount: 2,
    totalAttemptCount: 2,
    completedAt: new Date("2026-08-03T21:30:00.000Z"),
    recordingUrl: resolveRecordingLocator(retained(LINK), { allowedHosts: ALLOWED }).recordingUrl,
  }));

  const byCall = new Map(model.doc.attempts.map((a) => [a.providerCallId, a]));
  assert.equal(byCall.get(CALL_ID).recordingUrl, LINK);
  assert.equal(byCall.get(NEAR_MATCH_CALL_ID).recordingUrl, null, "a near-match call id gains nothing");

  const { projected } = await projectToCallLog(model);
  assert.equal(projected.size, 2);
  assert.equal(projected.get(`TAG:phoneburner:${CALL_ID}`)["recordingArchive.sourceUri"], LINK);
  assert.equal(
    projected.get(`TAG:phoneburner:${NEAR_MATCH_CALL_ID}`)["recordingArchive.sourceUri"],
    undefined,
    "the projection never writes a locator onto a row it did not arrive for",
  );

  // And the report join is on the same exact identity.
  const joined = joinPersistedRecordings(projected, {
    domain: "tag",
    caseId: "42",
    dateKey: "2026-08-03",
    attempts: [
      { providerCallId: NEAR_MATCH_CALL_ID, durationSeconds: 900 },
      { providerCallId: CALL_ID, durationSeconds: 900 },
    ],
  });
  const rows = blocks.BY_ID.get("longcalls").compute(material({ dials: [joined] }));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.listenUrl).filter(Boolean), [LINK]);

  // A projected row can never be claimed by a lookalike locator either.
  assert.notEqual(
    projected.get(`TAG:phoneburner:${CALL_ID}`)["recordingArchive.sourceUri"],
    NEAR_MATCH_LINK,
  );
});

// ── 5. a day before the capture cutoff ───────────────────────────────────

test("a pre-cutoff call renders as no recording, never as an empty link", async () => {
  // Capture went live 2026-08-03T20:57:45Z. Anything earlier has no reference
  // at all, so no attempt, CallLog, or report row may fabricate one.
  const model = fakeDailyDialModel();
  const record = createRecordLeadDeliveryDailyDial({ DailyDial: model });
  await record(dialAction({
    dailyAttemptDateKey: "2026-08-01",
    completedAt: new Date("2026-08-01T21:30:00.000Z"),
    callStartedAt: new Date("2026-08-01T21:15:00.000Z"),
    recordingUrl: resolveRecordingLocator(retained(null), { allowedHosts: ALLOWED }).recordingUrl,
  }));
  assert.equal(model.doc.attempts[0].recordingUrl, null);

  const { projected } = await projectToCallLog(model, "2026-08-01");
  const callLog = projected.get(`TAG:phoneburner:${CALL_ID}`);
  assert.equal(callLog["recordingArchive.sourceUri"], undefined);
  assert.equal("recordingArchive.provider" in callLog, false, "no empty archive entry is written");

  const joined = joinPersistedRecordings(projected, {
    domain: "tag",
    caseId: "42",
    dateKey: "2026-08-01",
    attempts: [{ providerCallId: CALL_ID, durationSeconds: 900 }],
  });
  const rows = blocks.BY_ID.get("longcalls").compute(material({
    from: "2026-08-01", to: "2026-08-01", dials: [joined],
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].listenUrl, null);
  const rendered = blocks.BY_ID.get("longcalls").renderText(rows);
  assert.equal(rendered.includes("http"), false, "a missing recording prints no link line at all");
  assert.equal(
    blocks.BY_ID.get("longcalls").csv(rows).emailColumns.find((c) => c.header === "listen").get(rows[0]),
    null,
  );

  // The other listen surface says so in words rather than printing a blank.
  const recordings = blocks.BY_ID.get("recordings");
  assert.equal(recordings.renderText([]), "Calls to review     (none)");
  assert.match(
    recordings.renderText([{ reasons: ["LONG"], minutes: 15, caller: null, phone: null, listenUrl: null }]),
    /\(no link\)/,
  );
});

// ── 6. the link is in the email and nowhere else ─────────────────────────

test("the nightly email carries the link while no diagnostic or error line does", async () => {
  const model = fakeDailyDialModel();
  const record = createRecordLeadDeliveryDailyDial({ DailyDial: model });
  const link = resolveRecordingLocator(retained(LINK), { allowedHosts: ALLOWED }).recordingUrl;
  const written = await record(dialAction({ recordingUrl: link }));
  const { projected, result } = await projectToCallLog(model);

  const joined = joinPersistedRecordings(projected, {
    domain: "tag", caseId: "42", dateKey: "2026-08-03",
    attempts: [{ providerCallId: CALL_ID, durationSeconds: 900 }],
  });
  const rows = blocks.BY_ID.get("longcalls").compute(material({ dials: [joined] }));
  const emailBody = blocks.BY_ID.get("longcalls").renderText(rows);
  assert.equal(emailBody.includes(link), true, "the email is the one place the link belongs");

  // Everything the chain hands back for logging, counting or diagnosis.
  const diagnostics = [
    JSON.stringify(written),
    JSON.stringify(result),
    JSON.stringify(resolveRecordingLocator(retained(LINK), { allowedHosts: ALLOWED }).reason),
    JSON.stringify(promoteRetainedRecordingReference(retained(LINK), { allowedHosts: [] })),
  ];
  for (const line of diagnostics) {
    assert.equal(line.includes(HOST), false, "no diagnostic surface may carry the host");
    assert.equal(line.includes("signature=kept"), false, "no diagnostic surface may carry the signature");
  }

  // Error paths are the classic leak: a thrown message that interpolates the
  // locator bypasses every deliberate log site.
  const thrown = [];
  for (const bad of [
    `http://${HOST}/${"a".repeat(2100)}`,
    `http://someuser:somesecret@${HOST}/r/x.mp3`,
    "not-a-locator",
    `gopher://${HOST}/r/x.mp3`,
  ]) {
    await assert.rejects(
      recordDailyDialOffload({
        model: fakeDailyDialModel(),
        cadence: { domain: "TAG", caseId: 43, receivedAt: new Date("2026-08-03T15:00:00.000Z") },
        originPool: "new_today",
        provider: "phoneburner",
        providerAttemptKey: "attempt-bad",
        providerCallId: CALL_ID,
        normalizedOutcome: "answered",
        dailyAttemptDateKey: "2026-08-03",
        dailyAttemptCount: 1,
        totalAttemptCount: 1,
        callEndedAt: new Date("2026-08-03T21:30:00.000Z"),
        recordingUrl: bad,
      }),
      (error) => {
        thrown.push(String(error.message));
        return error instanceof TypeError;
      },
    );
  }
  assert.equal(thrown.length, 4);
  for (const message of thrown) {
    assert.equal(message.includes(HOST), false);
    assert.equal(message.includes("somesecret"), false);
    assert.equal(message.includes("not-a-locator"), false);
  }
  assert.equal(new Set(thrown).size >= 3, true, "each ledger refusal names its own cause");
});
