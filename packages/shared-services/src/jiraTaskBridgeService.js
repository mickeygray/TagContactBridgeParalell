"use strict";

/**
 * jiraTaskBridgeService — turn a Jira issue into a Logics task, once.
 *
 * Tax prep works in Jira; resolution works in Logics. This is the bridge: when a
 * Jira ticket is raised, the same work appears as a task in the Logics case, so the
 * people who live in Logics see it without anyone re-typing it.
 *
 * ── WHAT MAKES THIS DIFFERENT FROM AN ORDINARY SYNC ─────────────────────────
 *
 * Logics tasks are CREATE-ONLY. No update route, no delete route. Three consequences
 * shape everything below:
 *
 *   - A duplicate cannot be merged away, so deduplication happens BEFORE the write
 *     and is checked twice: against our own ledger, then against Logics itself.
 *   - A wrong task cannot be corrected, so anything ambiguous is SKIPPED rather than
 *     guessed. A skipped ticket costs a question; a wrong one costs somebody's
 *     afternoon, or sends them to redo finished work.
 *   - Later Jira edits cannot propagate. This creates and never revises, which is why
 *     it fires on issue_created and treats issue_updated as a retry of a miss.
 *
 * ── WHY THE TENANT IS VERIFIED AND NOT TRUSTED ──────────────────────────────
 *
 * Case ids COLLIDE across TAG, WYNN and AMITY — case 11330 is three different people.
 * So a case id alone cannot identify a client, and a mistyped database is not a typo,
 * it is a task on a stranger's case. Measured on this data, a stated database is
 * wrong often enough to matter: one issue read "WYNN 194481 - JOSEPH DODSON" for a
 * case that exists only in TAG.
 *
 * The client name in the summary is the check. We fetch the case and compare; a
 * stated tenant is a strong hint about where to look FIRST, never the answer.
 *
 * ── THE SUBJECT VOCABULARY IS CLOSED ────────────────────────────────────────
 *
 * Free-text subjects were tried and produce confident nonsense — "Biz POA in logics"
 * (a statement that the POA exists) reads to a keyword matcher as a request to file
 * one. The vocabulary below is the firm's own, and anything outside it is skipped.
 */

const { resolveLogicsUser } = require("../../shared-data/src/jiraLogicsUserMap");

const TENANTS = ["TAG", "AMITY", "WYNN"];

/** The approved subjects. Anything else is a skip, not a guess. */
const SUBJECTS = [
  "Prep Return", "Prep Personal Return", "Prep Business Return",
  "Prep Personal And Business Return",
  "File Return", "File Personal Return", "File Business Return",
  "Amend Return", "Amend Personal Return", "Amend Business Return",
  "File POA", "File Personal POA", "File Business POA",
  "Send Return For Signature", "Follow Up On Signed Returns",
  "Follow Up On Tax Organizer", "Follow Up On Billing",
  "Run THS", "Review Client Info For POA", "Prac Call", "Business Prac Call",
];

/**
 * Jira workflow statuses that name the action themselves. Where one of these is set
 * it OVERRIDES anything read out of the description — the status is a controlled
 * field and the description is not.
 *
 * "SENT FOR SIGNATURES" is past tense: the returns already went to the client, so the
 * work is chasing them back, not sending them out.
 */
const STATUS_SUBJECT = {
  "SENT FOR SIGNATURES": "Follow Up On Signed Returns",
  "READY TO FILE": "File Return",
  "RUN THS": "Run THS",
};

/** Prefixed rather than substituted — the work still happens, it is just held first. */
const STATUS_PREFIX = { "HOLD FOR A/S": "Hold For A/S" };

/** Default owners when Jira names nobody. Both go on the task, per the firm's convention. */
const PROJECT_DEFAULTS = {
  ASSIGNMENT: ["Monica Cazares", "Jacqueline Santos"],
  POAREQ: ["Riley Mills", "Jackie Rose"],
};

/**
 * Does the person this task would go to ALREADY have an open task on this case?
 *
 * Deliberately broader than the same-work check on one axis and narrower on another.
 * Broader because the subjects need not match: a second row on the same case for the
 * same person is noise regardless of what each says, and what they need is a nudge on
 * the task they have rather than another item in their queue.
 *
 * Narrower because it is about the INDIVIDUAL, not the team. An earlier version
 * checked a roster of everyone in tax prep, which suppressed a task for Monica merely
 * because a case-managing agent held one on the same case — different people, both
 * with real work to do. Only the person actually being assigned counts.
 */
function heldBySameOwner(openTasks, users) {
  const mine = new Set((users || []).map((u) => String(u.name || u).toLowerCase().trim()).filter(Boolean));
  if (!mine.size) return null;
  for (const t of openTasks || []) {
    const owner = (t.users || []).find((u) => mine.has(String(u).toLowerCase().trim()));
    if (owner) return { ...t, owner };
  }
  return null;
}

/** Existing Logics work that would make a new task a duplicate. */
const SAME_WORK = [
  { action: /^Run THS/i, existing: /\bths\b|transcript/i },
  { action: /POA/i, existing: /\bpoa\b|2848/i },
  { action: /Signed Returns|Send Return For Signature/i, existing: /sign|8879/i },
  { action: /Tax Organizer/i, existing: /\bt\.?o\.?\b|organizer|\bdocs?\b/i },
  { action: /Billing/i, existing: /pay|billing|invoice|collect/i },
  { action: /Prac Call/i, existing: /\bprac\b|practitioner|\bppl\b/i },
  {
    action: /Return/i,
    existing: /tax prep|\bprep\b[^.]{0,12}(20\d\d|return)|(20\d\d|return)[^.]{0,12}\bprep\b|file[d]?[^.]{0,12}(return|tr'?s)|e-?file|\bamend/i,
  },
];

/** Jira descriptions are Atlassian document format, not strings. */
function adfText(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return node.text || "";
  const inner = (node.content || []).map(adfText);
  // Paragraphs are separate lines; inline nodes are not.
  return node.type === "paragraph" || node.type === "heading"
    ? `${inner.join("")}\n`
    : inner.join("");
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Parse the summary.
 *
 * The template shape is `DATABASE | CASE ID | NAME`, but this must keep working for
 * the thousands of issues written before it existed — "401656 - MICHAEL NIELSON",
 * "TAG 295795 Gerald McMullen", "JAMES MILLER 406924". So the pipe form is read
 * first and everything else falls back to scanning for the parts.
 */
function parseSummary(summary) {
  const raw = String(summary || "").trim();
  const parts = raw.split("|").map((s) => s.trim()).filter(Boolean);

  if (parts.length >= 3) {
    const tenant = TENANTS.find((t) => t === parts[0].toUpperCase()) || null;
    const caseId = /^\d{4,8}$/.test(parts[1]) ? Number(parts[1]) : null;
    if (tenant && caseId) {
      return { tenant, caseId, name: parts.slice(2).join(" ").trim(), shape: "template" };
    }
  }

  const idMatch = raw.match(/\b(\d{4,8})\b/);
  const tenantMatch = raw.match(/\b(TAG|WYNN|AMITY)\b/i);
  return {
    tenant: tenantMatch ? tenantMatch[1].toUpperCase() : null,
    caseId: idMatch ? Number(idMatch[1]) : null,
    // Whatever is left once the id and the database word are removed.
    name: raw.replace(/\b\d{4,8}\b/, " ").replace(/\b(TAG|WYNN|AMITY)\b/gi, " ")
      .replace(/[|\-–—]+/g, " ").replace(/\s+/g, " ").trim(),
    shape: "legacy",
  };
}

/**
 * Split the description into subject and notes on a `---` line.
 *
 * A blank line cannot be the delimiter — notes contain blank lines naturally, so the
 * separator has to be something a person types on purpose.
 *
 * Without a divider the whole body is notes and the subject has to come from the
 * status, which is the correct outcome for every pre-template issue.
 */
function parseDescription(description) {
  const text = typeof description === "string" ? description : adfText(description);
  const lines = text.split("\n").map((l) => l.trim());
  const divider = lines.findIndex((l) => /^-{3,}$/.test(l));
  if (divider === -1) {
    return { subject: null, notes: lines.filter(Boolean).join("\n").trim() };
  }
  return {
    subject: lines.slice(0, divider).filter(Boolean).join(" ").trim() || null,
    notes: lines.slice(divider + 1).join("\n").trim(),
  };
}

/** Match a stated subject against the closed vocabulary, case-insensitively. */
function canonicalSubject(candidate) {
  if (!candidate) return null;
  const c = String(candidate).trim().toLowerCase();
  return SUBJECTS.find((s) => s.toLowerCase() === c)
    || SUBJECTS.find((s) => c.startsWith(`${s.toLowerCase()} `))
    || null;
}

/**
 * The subject, from the status where the status knows, else from the description.
 *
 * Status wins deliberately. A ticket whose note reads "2024 PREP" but whose status is
 * READY TO FILE describes a return that is prepared and waiting to be transmitted —
 * taking the note would order the preparation a second time.
 */
function resolveSubject({ statusName, statedSubject }) {
  const status = String(statusName || "").trim().toUpperCase();
  const fromStatus = STATUS_SUBJECT[status] || null;
  const stated = canonicalSubject(statedSubject);
  const base = fromStatus || stated;
  if (!base) return { subject: null, from: null };
  const prefix = STATUS_PREFIX[status];
  return {
    subject: prefix ? `${prefix}: ${base}` : base,
    from: fromStatus ? "status" : "description",
  };
}

/**
 * Which tenant, verified by client name.
 *
 * A stated database is tried first because it is usually right and skipping it would
 * burn lookups. It is never taken on trust: the case is fetched and the name compared.
 */
async function resolveTenant({ tenant, caseId, name }, fetchCase) {
  if (!caseId) return { tenant: null, reason: "no case id in the summary" };
  const order = tenant ? [tenant, ...TENANTS.filter((t) => t !== tenant)] : TENANTS;
  const words = norm(name).split(" ").filter((w) => w.length >= 3);
  const seen = [];

  for (const candidate of order) {
    let body = null;
    try { body = await fetchCase(candidate, caseId); } catch { continue; }
    if (!body || !body.CaseID) continue;
    const logicsName = norm(`${body.FirstName || ""} ${body.MiddleName || ""} ${body.LastName || ""}`);
    seen.push({ tenant: candidate, logicsName });
    if (words.some((w) => logicsName.includes(w))) {
      return { tenant: candidate, client: logicsName, verified: true };
    }
  }

  // The case exists somewhere but under a different name. That is the collision this
  // check exists to catch, so it is a hard stop rather than a best guess.
  if (seen.length) {
    return {
      tenant: null,
      reason: `case ${caseId} found in ${seen.map((s) => s.tenant).join("/")} but no name match`,
      candidates: seen,
    };
  }
  return { tenant: null, reason: `case ${caseId} not found in any database` };
}

/** Who the task goes to, per tenant, falling back to the project's pair. */
function resolveUsers({ assignee, project, tenant }) {
  if (assignee) {
    const hit = resolveLogicsUser(
      { accountId: assignee.accountId, displayName: assignee.displayName }, tenant,
    );
    if (hit) {
      return { users: [{ name: assignee.displayName, id: hit.userId }], verified: hit.verified, from: "jira" };
    }
    return { users: [], reason: `no Logics UserID mapped for ${assignee.displayName} in ${tenant}` };
  }
  const names = PROJECT_DEFAULTS[project];
  if (!names) return { users: [], reason: `unassigned and no default owner for ${project}` };
  const users = names
    .map((n) => ({ name: n, hit: resolveLogicsUser({ displayName: n }, tenant) }))
    .filter((x) => x.hit)
    .map((x) => ({ name: x.name, id: x.hit.userId }));
  if (!users.length) return { users: [], reason: `default owners for ${project} have no UserID in ${tenant}` };
  return { users, from: "project default" };
}

/** Is this work already sitting open in Logics? */
function alreadyOpen(subject, openTasks) {
  const rule = SAME_WORK.find((r) => r.action.test(subject));
  if (!rule) return null;
  return (openTasks || []).find((t) => rule.existing.test(String(t.subject || ""))) || null;
}

/**
 * Bridge one Jira issue.
 *
 * Returns a decision object rather than throwing on the ordinary misses — "no subject",
 * "already covered" and "unassigned" are expected outcomes on a real queue, not errors,
 * and the caller records all of them.
 *
 * @param {object}   issue        the Jira webhook's issue payload
 * @param {object}   deps
 * @param {Function} deps.fetchCase        (tenant, caseId) -> case body
 * @param {Function} deps.listOpenTasks    (tenant, caseId) -> [{taskId, subject}]
 * @param {Function} deps.createTask       (tenant, payload) -> { TaskID }
 * @param {Function} deps.findLink         (jiraKey) -> existing link or null
 * @param {Function} deps.recordLink       (link) -> void
 * @param {boolean}  apply                 false leaves Logics untouched
 */
async function bridgeJiraIssue({ issue, deps, apply = false, trigger = "manual", now = Date.now() }) {
  const key = issue?.key;
  if (!key) return { outcome: "skipped", reason: "no issue key" };
  const f = issue.fields || {};
  const project = f.project?.key || null;

  const base = {
    jiraKey: key, jiraProject: project, jiraStatus: f.status?.name || null,
    jiraAssignee: f.assignee?.displayName || null, trigger,
  };
  const done = (outcome, extra) => ({ ...base, outcome, ...extra });

  // 1. Have we already handled this issue? The ledger is the cheap check and the
  //    only one that survives a Jira retry storm.
  const existing = await deps.findLink(key);
  if (existing && existing.outcome === "created") {
    // Preserve the terminal fact rather than emitting a fresh `skipped` that
    // would overwrite it in the ledger — recordLink also refuses that write,
    // but the decision itself should not ask for it.
    return done("skipped", {
      reason: `already created as Logics task ${existing.logicsTaskId}`,
      logicsTaskId: existing.logicsTaskId,
    });
  }

  // 2. Where does it point, and is that verified?
  const parsed = parseSummary(f.summary);
  const where = await resolveTenant(parsed, deps.fetchCase);
  if (!where.tenant) return done("skipped", { reason: where.reason, caseId: parsed.caseId });

  // 3. What is the work?
  const { subject: statedSubject, notes } = parseDescription(f.description);
  const { subject } = resolveSubject({ statusName: f.status?.name, statedSubject });
  if (!subject) {
    return done("skipped", {
      tenant: where.tenant, caseId: parsed.caseId,
      reason: statedSubject
        ? `"${String(statedSubject).slice(0, 40)}" is not one of the approved subjects`
        : "no subject stated and the status does not imply one",
    });
  }

  // 4. Who does it?
  const who = resolveUsers({ assignee: f.assignee, project, tenant: where.tenant });
  if (!who.users.length) {
    return done("skipped", { tenant: where.tenant, caseId: parsed.caseId, subject, reason: who.reason });
  }
  if (who.verified && who.verified !== "confirmed") {
    return done("skipped", {
      tenant: where.tenant, caseId: parsed.caseId, subject,
      reason: `Logics UserID for ${base.jiraAssignee} in ${where.tenant} is "${who.verified}", not confirmed`,
    });
  }

  // 5. Is Logics already tracking it? Checked second because it costs a call.
  const open = await deps.listOpenTasks(where.tenant, parsed.caseId);

  // 5a. This person already has an open task on this case. Adding another would put a
  //     second row in their own queue for the same client, so tell them instead —
  //     `notify` asks the caller to comment back on the Jira issue.
  const held = heldBySameOwner(open, who.users);
  if (held) {
    return done("skipped", {
      tenant: where.tenant, caseId: parsed.caseId, subject,
      reason: `${held.owner} already has an open Logics task ${held.taskId} on this case`
        + ` "${String(held.subject).slice(0, 40)}"`,
      notify: {
        owner: held.owner, taskId: held.taskId, taskSubject: String(held.subject || ""),
        wouldHaveBeen: subject, notes,
      },
    });
  }

  const dupe = alreadyOpen(subject, open);
  if (dupe) {
    return done("skipped", {
      tenant: where.tenant, caseId: parsed.caseId, subject,
      reason: `already open in Logics as task ${dupe.taskId} "${String(dupe.subject).slice(0, 40)}"`,
      notify: {
        owner: (dupe.users || []).join(", ") || null, taskId: dupe.taskId,
        taskSubject: String(dupe.subject || ""), wouldHaveBeen: subject, notes,
      },
    });
  }

  // 6. Build it. The body is the worker's own words and nothing else — no migration
  //    banner, no source link. Whoever opens this is doing tax work.
  const due = f.duedate ? Date.parse(`${f.duedate}T17:00:00Z`) : now + 7 * 86400000;
  const payload = {
    CaseID: parsed.caseId,
    Subject: subject.slice(0, 200),
    Reminder: new Date(due - 86400000).toISOString(),
    TaskType: 1,
    DueDate: new Date(due).toISOString(),
    UserID: who.users.map((u) => Number(u.id)).filter(Number.isFinite),
    Comments: notes || "(no note on the Jira issue)",
    AllDayEvent: false,
  };

  if (!apply) {
    return done("skipped", {
      tenant: where.tenant, caseId: parsed.caseId, subject, payload,
      reason: "dry run — nothing written",
      userIds: payload.UserID, userNames: who.users.map((u) => u.name),
    });
  }

  try {
    const res = await deps.createTask(where.tenant, payload);
    const body = res?.Data ?? res?.data ?? res;
    const taskId = body?.TaskID ?? body?.taskId ?? null;
    return done("created", {
      tenant: where.tenant, caseId: parsed.caseId, subject,
      logicsTaskId: taskId, userIds: payload.UserID, userNames: who.users.map((u) => u.name),
    });
  } catch (error) {
    return done("failed", {
      tenant: where.tenant, caseId: parsed.caseId, subject,
      reason: String(error.message).slice(0, 200),
    });
  }
}

module.exports = {
  bridgeJiraIssue,
  parseSummary,
  parseDescription,
  resolveSubject,
  resolveTenant,
  resolveUsers,
  alreadyOpen,
  heldBySameOwner,
  adfText,
  SUBJECTS,
  STATUS_SUBJECT,
  PROJECT_DEFAULTS,
};
