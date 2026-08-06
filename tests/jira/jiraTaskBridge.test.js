"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bridgeJiraIssue,
  parseSummary,
  parseDescription,
  resolveSubject,
} = require("../../packages/shared-services/src/jiraTaskBridgeService");

/** A Jira description as the API actually returns it: a document tree, not a string. */
const adf = (...paragraphs) => ({
  type: "doc",
  version: 1,
  content: paragraphs.map((text) => ({
    type: "paragraph",
    content: text ? [{ type: "text", text }] : [],
  })),
});

const issueOf = (over = {}) => ({
  key: over.key || "ASSIGNMENT-9001",
  fields: {
    summary: "TAG | 401656 | MICHAEL NIELSON",
    status: { name: "To Do" },
    project: { key: "ASSIGNMENT" },
    assignee: { accountId: "712020:fe39fe2a-85ca-4b25-86dd-36e6315423d8", displayName: "Monica Cazares" },
    description: adf("Prep Return", "---", "2023-2025 client sending W-2s"),
    duedate: null,
    ...over.fields,
  },
});

/** Deps that answer plausibly and record what was asked of them. */
function fakeDeps(over = {}) {
  const created = [];
  return {
    created,
    fetchCase: async (tenant, caseId) => (tenant === "TAG" && caseId === 401656
      ? { CaseID: caseId, FirstName: "MICHAEL", MiddleName: "H", LastName: "NIELSON" }
      : null),
    listOpenTasks: async () => [],
    createTask: async (tenant, payload) => { created.push({ tenant, payload }); return { Data: { TaskID: 99001 } }; },
    findLink: async () => null,
    recordLink: async () => {},
    ...over,
  };
}

test("parses the template summary into database, case and name", () => {
  const p = parseSummary("TAG | 401656 | MICHAEL NIELSON");
  assert.equal(p.tenant, "TAG");
  assert.equal(p.caseId, 401656);
  assert.equal(p.name, "MICHAEL NIELSON");
  assert.equal(p.shape, "template");
});

test("still reads the legacy summary shapes written before the template", () => {
  for (const [summary, caseId] of [
    ["401656 - MICHAEL NIELSON", 401656],
    ["JAMES MILLER 406924", 406924],
    ["TAG 295795 Gerald McMullen", 295795],
  ]) {
    const p = parseSummary(summary);
    assert.equal(p.caseId, caseId, summary);
    assert.ok(p.name.length, `expected a name from "${summary}"`);
  }
});

test("splits the description on the divider, not on blank lines", () => {
  // The note itself contains a blank line — whitespace cannot be the delimiter.
  const d = parseDescription(adf("Prep Return", "---", "2023-2025", "", "client called Tuesday"));
  assert.equal(d.subject, "Prep Return");
  assert.match(d.notes, /2023-2025/);
  assert.match(d.notes, /client called Tuesday/);
});

test("with no divider the whole body is notes and no subject is claimed", () => {
  const d = parseDescription(adf("2023-2025 waiting on docs"));
  assert.equal(d.subject, null);
  assert.equal(d.notes, "2023-2025 waiting on docs");
});

test("status beats the description when the status names the work", () => {
  // "2024 PREP" is a label for the job; SENT FOR SIGNATURES says where it has got to.
  const r = resolveSubject({ statusName: "SENT FOR SIGNATURES", statedSubject: "Prep Return" });
  assert.equal(r.subject, "Follow Up On Signed Returns");
  assert.equal(r.from, "status");
});

test("HOLD FOR A/S prefixes the work instead of replacing it", () => {
  const r = resolveSubject({ statusName: "HOLD FOR A/S", statedSubject: "File Return" });
  assert.equal(r.subject, "Hold For A/S: File Return");
});

test("a subject outside the approved vocabulary is refused, not approximated", () => {
  const r = resolveSubject({ statusName: "To Do", statedSubject: "sort out the POA thing" });
  assert.equal(r.subject, null);
});

test("creates a task for a well-formed issue", async () => {
  const deps = fakeDeps();
  const d = await bridgeJiraIssue({ issue: issueOf(), deps, apply: true });
  assert.equal(d.outcome, "created");
  assert.equal(d.tenant, "TAG");
  assert.equal(d.logicsTaskId, 99001);
  assert.equal(deps.created.length, 1);
  const { payload } = deps.created[0];
  assert.equal(payload.Subject, "Prep Return");
  assert.deepEqual(payload.UserID, [398]);
  // The body is the worker's own words — no migration banner.
  assert.equal(payload.Comments, "2023-2025 client sending W-2s");
});

test("refuses when the client name does not match the case in that database", async () => {
  const deps = fakeDeps({
    fetchCase: async () => ({ CaseID: 401656, FirstName: "SOMEONE", LastName: "ELSE" }),
  });
  const d = await bridgeJiraIssue({ issue: issueOf(), deps, apply: true });
  assert.equal(d.outcome, "skipped");
  assert.match(d.reason, /no name match/);
  assert.equal(deps.created.length, 0);
});

test("finds the right database even when the summary names the wrong one", async () => {
  // A real case: an issue read "WYNN 194481 - JOSEPH DODSON" for a TAG-only case.
  const deps = fakeDeps({
    fetchCase: async (tenant, caseId) => (tenant === "TAG"
      ? { CaseID: caseId, FirstName: "MICHAEL", LastName: "NIELSON" }
      : null),
  });
  const issue = issueOf({ fields: { summary: "WYNN | 401656 | MICHAEL NIELSON" } });
  const d = await bridgeJiraIssue({ issue, deps, apply: true });
  assert.equal(d.outcome, "created");
  assert.equal(d.tenant, "TAG");
});

test("does not create a second task when the ledger already has one", async () => {
  const deps = fakeDeps({ findLink: async () => ({ outcome: "created", logicsTaskId: 47175 }) });
  const d = await bridgeJiraIssue({ issue: issueOf(), deps, apply: true });
  assert.equal(d.outcome, "skipped");
  assert.match(d.reason, /already created as Logics task 47175/);
  assert.equal(deps.created.length, 0);
});

test("does not duplicate work Logics already has open", async () => {
  const deps = fakeDeps({
    listOpenTasks: async () => [{ taskId: 45892, subject: "2025 Tax Prep" }],
  });
  const d = await bridgeJiraIssue({ issue: issueOf(), deps, apply: true });
  assert.equal(d.outcome, "skipped");
  assert.match(d.reason, /already open in Logics as task 45892/);
  assert.equal(deps.created.length, 0);
});

test("a completed Logics task does not block new work", async () => {
  // listOpenTasks only ever returns StatusID 0, so a finished task never appears.
  const deps = fakeDeps({ listOpenTasks: async () => [] });
  const d = await bridgeJiraIssue({ issue: issueOf(), deps, apply: true });
  assert.equal(d.outcome, "created");
});

test("falls back to the project's pair when nobody is assigned", async () => {
  const deps = fakeDeps();
  const issue = issueOf({ fields: { assignee: null } });
  const d = await bridgeJiraIssue({ issue, deps, apply: true });
  assert.equal(d.outcome, "created");
  // Both names, matching the firm's own convention on Logics tasks.
  assert.deepEqual(deps.created[0].payload.UserID, [398, 437]);
  assert.deepEqual(d.userNames, ["Monica Cazares", "Jacqueline Santos"]);
});

test("refuses a UserID that was never confirmed against Logics", async () => {
  // Jacqueline's WYNN id (43) never appeared in 42 months of task harvest.
  const deps = fakeDeps({
    fetchCase: async (tenant, caseId) => (tenant === "WYNN"
      ? { CaseID: caseId, FirstName: "MICHAEL", LastName: "NIELSON" } : null),
  });
  const issue = issueOf({
    fields: {
      summary: "WYNN | 112604 | MICHAEL NIELSON",
      assignee: { accountId: "712020:46c4a2b9-0217-4bb9-bd21-e7f1df0880a7", displayName: "Jacqueline Santos" },
    },
  });
  const d = await bridgeJiraIssue({ issue, deps, apply: true });
  assert.equal(d.outcome, "skipped");
  assert.match(d.reason, /unexercised|not confirmed/);
  assert.equal(deps.created.length, 0);
});

test("dry run resolves everything but writes nothing", async () => {
  const deps = fakeDeps();
  const d = await bridgeJiraIssue({ issue: issueOf(), deps, apply: false });
  assert.equal(d.outcome, "skipped");
  assert.match(d.reason, /dry run/);
  assert.equal(d.subject, "Prep Return");
  assert.equal(deps.created.length, 0);
});

test("a Logics failure is recorded as failed, not swallowed", async () => {
  const deps = fakeDeps({
    createTask: async () => { throw new Error("Logics request failed: 500"); },
  });
  const d = await bridgeJiraIssue({ issue: issueOf(), deps, apply: true });
  assert.equal(d.outcome, "failed");
  assert.match(d.reason, /500/);
});

test("skips an issue whose case cannot be found in any database", async () => {
  const deps = fakeDeps({ fetchCase: async () => null });
  const d = await bridgeJiraIssue({ issue: issueOf(), deps, apply: true });
  assert.equal(d.outcome, "skipped");
  assert.match(d.reason, /not found in any database/);
});

test("skips when there is no subject and the status does not imply one", async () => {
  const deps = fakeDeps();
  const issue = issueOf({ fields: { description: adf("2025 waiting on docs"), status: { name: "To Do" } } });
  const d = await bridgeJiraIssue({ issue, deps, apply: true });
  assert.equal(d.outcome, "skipped");
  assert.match(d.reason, /no subject stated/);
});

test("alerts instead of creating when the SAME person already has a task here", async () => {
  // Monica is the assignee and already holds an open task on this case. A second row
  // in her own queue for the same client helps nobody; a nudge on the one she has does.
  const deps = fakeDeps({
    listOpenTasks: async () => [
      { taskId: 44325, subject: "A/S, tax prep", users: ["Monica Cazares"] },
    ],
  });
  const d = await bridgeJiraIssue({ issue: issueOf(), deps, apply: true });
  assert.equal(d.outcome, "skipped");
  assert.match(d.reason, /Monica Cazares already has an open Logics task 44325/);
  assert.equal(d.notify.owner, "Monica Cazares");
  assert.equal(d.notify.wouldHaveBeen, "Prep Return");
  assert.equal(deps.created.length, 0);
});

test("a task held by a DIFFERENT person does not suppress this one", async () => {
  // The earlier roster version blocked here, which was wrong: Eli holding the case as
  // its managing agent says nothing about whether Monica has prep work to do on it.
  const deps = fakeDeps({
    listOpenTasks: async () => [
      { taskId: 44325, subject: "433a review", users: ["Eli Hayes"] },
    ],
  });
  const d = await bridgeJiraIssue({ issue: issueOf(), deps, apply: true });
  assert.equal(d.outcome, "created");
  assert.equal(deps.created.length, 1);
});

test("the same-person check fires even when the subjects are unrelated", async () => {
  const deps = fakeDeps({
    listOpenTasks: async () => [
      { taskId: 43936, subject: "update and go through 433a", users: ["Monica Cazares"] },
    ],
  });
  const d = await bridgeJiraIssue({ issue: issueOf(), deps, apply: true });
  assert.equal(d.outcome, "skipped");
  assert.match(d.reason, /Monica Cazares already has an open/);
});

test("matches on either member of a default-assigned pair", async () => {
  // Unassigned in Jira, so it would go to Monica AND Jacqueline. Jacqueline already
  // having one on this case is enough.
  const deps = fakeDeps({
    listOpenTasks: async () => [
      { taskId: 46001, subject: "2025 Tax Prep", users: ["Jacqueline Santos"] },
    ],
  });
  const d = await bridgeJiraIssue({ issue: issueOf({ fields: { assignee: null } }), deps, apply: true });
  assert.equal(d.outcome, "skipped");
  assert.equal(d.notify.owner, "Jacqueline Santos");
});

test("a same-work duplicate also carries a notify so the reporter hears back", async () => {
  const deps = fakeDeps({
    listOpenTasks: async () => [{ taskId: 45892, subject: "2025 Tax Prep", users: [] }],
  });
  const d = await bridgeJiraIssue({ issue: issueOf(), deps, apply: true });
  assert.equal(d.outcome, "skipped");
  assert.equal(d.notify.taskId, 45892);
  assert.equal(deps.created.length, 0);
});

test("the notify payload carries everything the alert text needs", async () => {
  // The comment reads "...posted in your name, for <notes>. Please Update <case> in
  // <database> with <subject>", so all four have to survive on the decision.
  const deps = fakeDeps({
    listOpenTasks: async () => [
      { taskId: 44325, subject: "A/S, tax prep", users: ["Monica Cazares"] },
    ],
  });
  const d = await bridgeJiraIssue({ issue: issueOf(), deps, apply: true });
  assert.equal(d.notify.notes, "2023-2025 client sending W-2s");
  assert.equal(d.notify.wouldHaveBeen, "Prep Return");
  assert.equal(d.caseId, 401656);
  assert.equal(d.tenant, "TAG");
});

// ── AUDIT FIXES: claim-before-ack, terminal created, refuse-on-partial ─────

test("the link model knows the in-flight state", () => {
  const JiraTaskLink = require("../../packages/shared-models/src/JiraTaskLink");
  const outcomes = JiraTaskLink.schema.path("outcome").enumValues;
  assert.ok(outcomes.includes("pending"), "the claim needs a durable in-flight state");
  assert.ok(outcomes.includes("created"));
});

test("the webhook claims BEFORE acknowledging, and acknowledges before working", () => {
  // The old order (ack -> create -> record) had two fatal shapes: a crash after
  // the 200 lost the event with nothing durable, and two concurrent deliveries
  // could both see no link and both create against a destination with no
  // delete. The claim insert against the unique _id is the arbiter.
  const src = require("node:fs").readFileSync(
    require.resolve("../../apps/control-plane/src/routes/jiraWebhook"), "utf8",
  );
  const handler = src.slice(src.indexOf('router.post("/webhook"'));
  const claim = handler.indexOf("deps.claimIssue(");
  const ack = handler.indexOf("res.json({ ok: true, received: event, key: issue.key");
  const work = handler.indexOf("bridgeJiraIssue({");
  assert.ok(claim > 0 && ack > 0 && work > 0);
  assert.ok(claim < ack, "the claim must be durable before Jira hears a 2xx");
  assert.ok(ack < work, "and the 2xx must precede the slow external work");
  // A failed claim must NOT ack — a 500 makes Jira retry, which now converges
  // on the claim instead of duplicating.
  assert.match(handler.slice(0, ack), /status\(500\)/);
});

test("recordLink cannot overwrite the terminal created outcome", () => {
  // The bridge's own "already created -> skipped" decision used to overwrite
  // the stored `created` with `skipped`, after which the ledger no longer knew
  // a task existed and the next retry was free to duplicate it.
  const src = require("node:fs").readFileSync(
    require.resolve("../../apps/control-plane/src/routes/jiraWebhook"), "utf8",
  );
  const record = src.slice(src.indexOf("recordLink: async"), src.indexOf("claimIssue:"));
  assert.match(record, /outcome: \{ \$ne: "created" \}/,
    "a non-created write must be conditional on the row not being created");
});

test("an unreadable open-task window REFUSES the create instead of narrowing it", async () => {
  // The dedupe evidence exists to stop a second un-deletable task. A window we
  // could not read is evidence we do not have.
  const src = require("node:fs").readFileSync(
    require.resolve("../../apps/control-plane/src/routes/jiraWebhook"), "utf8",
  );
  const lookup = src.slice(src.indexOf("listOpenTasks: async"), src.indexOf("createTask:"));
  assert.match(lookup, /throw new Error\(/, "a failed window must throw, not continue");
  assert.doesNotMatch(lookup, /\n\s*continue;/, "the silent continue is the defect");
});

test("an already-created decision carries the task id forward, not just a reason", async () => {
  const decision = await bridgeJiraIssue({
    issue: { key: "ASSIGNMENT-9001", fields: {} },
    deps: {
      findLink: async () => ({ outcome: "created", logicsTaskId: 5150 }),
    },
    apply: true,
  });
  assert.equal(decision.outcome, "skipped");
  assert.equal(decision.logicsTaskId, 5150,
    "the terminal fact rides the decision so no writer can lose it");
});

// ── ROUND 2: durable completion ────────────────────────────────────────────

test("the claim stores the issue snapshot, or pending is a tombstone", () => {
  const JiraTaskLink = require("../../packages/shared-models/src/JiraTaskLink");
  assert.ok(JiraTaskLink.schema.path("issueSnapshot"),
    "declared on the strict schema BEFORE anything writes it");
  const src = require("node:fs").readFileSync(
    require.resolve("../../apps/control-plane/src/routes/jiraWebhook"), "utf8",
  );
  assert.match(src, /claimIssue\(issue\.key, event, issue\)/,
    "the webhook must hand the claim the payload a drain would need");
});

test("the drain re-drives a stale pending claim from its snapshot", async () => {
  const { drainStaleJiraClaims } = require("../../apps/control-plane/src/routes/jiraWebhook");
  const stale = new Date(Date.now() - 30 * 60 * 1000);
  const rows = [{
    _id: "ASSIGNMENT-7001", outcome: "pending", attempts: 2, lastAttemptAt: stale,
    issueSnapshot: { key: "ASSIGNMENT-7001", fields: { summary: "x" } },
  }];
  const updates = [];
  const Model = {
    find: () => ({ sort: () => ({ limit: () => ({ lean: async () => rows }) }) }),
    updateOne: async (...a) => { updates.push(a); return { matchedCount: 1 }; },
    findOneAndUpdate: async (q) => (q._id === "ASSIGNMENT-7001" ? rows[0] : null),
  };
  const recorded = [];
  const out = await drainStaleJiraClaims({
    deps: { recordLink: async (d) => recorded.push(d) },
    apply: false,
    Model,
    bridge: async ({ issue, trigger }) => ({
      jiraKey: issue.key, outcome: "skipped", reason: "dry run", trigger,
    }),
  });
  assert.equal(out.redriven, 1);
  assert.equal(recorded[0].jiraKey, "ASSIGNMENT-7001");
  assert.equal(recorded[0].trigger, "claim-drain");
});

test("a pending claim with NO snapshot terminates as failed, not pending forever", async () => {
  const { drainStaleJiraClaims } = require("../../apps/control-plane/src/routes/jiraWebhook");
  const stale = new Date(Date.now() - 30 * 60 * 1000);
  const updates = [];
  const Model = {
    find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [
      { _id: "ASSIGNMENT-7002", outcome: "pending", attempts: 1, lastAttemptAt: stale, issueSnapshot: null },
    ] }) }) }),
    updateOne: async (...a) => { updates.push(a); return { matchedCount: 1 }; },
    findOneAndUpdate: async () => null,
  };
  const out = await drainStaleJiraClaims({ deps: { recordLink: async () => {} }, apply: false, Model });
  assert.equal(out.unrecoverable, 1);
  assert.equal(updates[0][1].$set.outcome, "failed");
  assert.match(updates[0][1].$set.reason, /no snapshot/);
});

test("the drain gives up after its attempt budget — terminally, with a reason", async () => {
  const { drainStaleJiraClaims } = require("../../apps/control-plane/src/routes/jiraWebhook");
  const stale = new Date(Date.now() - 30 * 60 * 1000);
  const updates = [];
  const Model = {
    find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [
      { _id: "ASSIGNMENT-7003", outcome: "pending", attempts: 5, lastAttemptAt: stale,
        issueSnapshot: { key: "ASSIGNMENT-7003", fields: {} } },
    ] }) }) }),
    updateOne: async (...a) => { updates.push(a); return { matchedCount: 1 }; },
    findOneAndUpdate: async () => null,
  };
  const out = await drainStaleJiraClaims({ deps: { recordLink: async () => {} }, apply: false, Model });
  assert.equal(out.exhausted, 1);
  assert.match(updates[0][1].$set.reason, /gave up after 5/);
});

test("a lost CAS means another delivery owns it — the drain walks away", async () => {
  const { drainStaleJiraClaims } = require("../../apps/control-plane/src/routes/jiraWebhook");
  const stale = new Date(Date.now() - 30 * 60 * 1000);
  let bridged = 0;
  const Model = {
    find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [
      { _id: "ASSIGNMENT-7004", outcome: "pending", attempts: 1, lastAttemptAt: stale,
        issueSnapshot: { key: "ASSIGNMENT-7004", fields: {} } },
    ] }) }) }),
    updateOne: async () => ({ matchedCount: 1 }),
    findOneAndUpdate: async () => null, // CAS lost
  };
  const out = await drainStaleJiraClaims({
    deps: { recordLink: async () => {} }, apply: false, Model,
    bridge: async () => { bridged += 1; return {}; },
  });
  assert.equal(bridged, 0, "no bridge run without the CAS");
  assert.equal(out.redriven, 0);
});

test("the replay route goes through the SAME claim gate as the webhook", () => {
  // Replay used to go straight to the bridge — an admin replaying while a
  // webhook delivery was mid-flight could create the task twice.
  const src = require("node:fs").readFileSync(
    require.resolve("../../apps/control-plane/src/routes/jiraWebhook"), "utf8",
  );
  const replay = src.slice(src.indexOf('router.post("/replay/:key"'));
  const claim = replay.indexOf("deps.claimIssue(");
  const bridge = replay.indexOf("bridgeJiraIssue({");
  assert.ok(claim > 0 && bridge > 0 && claim < bridge, "claim before bridge, in replay too");
  assert.match(replay.slice(0, bridge), /status\(409\)/, "a refused claim is a 409, not a second create");
});
