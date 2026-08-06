"use strict";

/**
 * jiraLogicsUserMap — who a Jira person is, in Logics.
 *
 * Tax prep works in Jira; resolution works in Logics. To mirror a Jira task into
 * Logics we must supply a `UserID`, which Logics requires on Task/Task. Nothing
 * in either system links the two — Atlassian hides every email address except the
 * calling token's own, so the ONLY join key available is a display name, and this
 * file is where that join is pinned down by hand rather than guessed at runtime.
 *
 * ── UserIDs ARE PER TENANT AND THE NAMESPACES OVERLAP ───────────────────────
 *
 * The single most dangerous property of this data: TAG 20 is Jonathan Haro, but
 * WYNN 20 is Riley Mills. A UserID with no tenant beside it is not just incomplete,
 * it is a live hazard — Logics will accept it and quietly assign the task to the
 * wrong human. Never pass a bare id; always resolve through {tenant, id}.
 *
 * ── PROVENANCE ──────────────────────────────────────────────────────────────
 *
 * The ids were supplied by Mickey on 2026-08-05 from the Logics back office, then
 * VERIFIED independently rather than taken on trust. Logics exposes no user
 * directory — twelve candidate V4 routes return a router-level 404 — but
 * Task/GetTasksByDateRange returns `Users:[{UserID, FullName}]` on every task row,
 * which is an id-to-name mapping issued by Logics itself. Harvesting 42 months of
 * tasks (TAG 5.2k, WYNN 8.4k, AMITY 18.8k) confirmed 16 of the 18 ids by name with
 * ZERO mismatches, including the WYNN-20 collision above.
 *
 * The two unconfirmed ids are marked `verified: "unexercised"`. That is not a
 * defect and must not be read as one: the id assigned no task in the window, and a
 * reverse lookup found the person under no OTHER id in that tenant either, so
 * nothing contradicts them — they are simply unproven. Treat them as usable but
 * worth a second look the first time one is actually written to.
 *
 * Re-verify with: node scripts/analysis/logics-user-map-verify.js 42
 */

/**
 * @typedef {Object} MappedUser
 * @property {string} jiraName      Jira display name — the join key.
 * @property {string} jiraAccountId Jira accountId. Prefer this over the name.
 * @property {boolean} jiraActive   Deactivated accounts cannot be assigned in Jira.
 * @property {Object} logics        Logics UserID per tenant.
 * @property {Object} verified      Per-tenant verification state.
 * @property {string} [note]
 */

/** @type {MappedUser[]} */
const USERS = [
  {
    jiraName: "Monica Cazares",
    jiraAccountId: "712020:fe39fe2a-85ca-4b25-86dd-36e6315423d8",
    jiraActive: true,
    logics: { TAG: 398, WYNN: 32, AMITY: 139 },
    verified: { TAG: "confirmed", WYNN: "confirmed", AMITY: "confirmed" },
    note: "Busiest open ASSIGNMENT queue (248 open).",
  },
  {
    jiraName: "Jacqueline Santos",
    jiraAccountId: "712020:46c4a2b9-0217-4bb9-bd21-e7f1df0880a7",
    jiraActive: true,
    logics: { TAG: 437, WYNN: 43, AMITY: 165 },
    verified: { TAG: "confirmed", WYNN: "unexercised", AMITY: "unexercised" },
    // Low Logics volume even in TAG (1 task sighting in 12 months), so the absence
    // of WYNN/AMITY sightings is consistent with her simply not working those books.
    note: "224 open ASSIGNMENT issues. Do not confuse with Jackie Rose.",
  },
  {
    jiraName: "Riley Mills",
    jiraAccountId: "712020:1f6b23db-8f66-4010-848a-b88311f7c5dd",
    jiraActive: true,
    logics: { TAG: 407, WYNN: 20, AMITY: 149 },
    verified: { TAG: "confirmed", WYNN: "confirmed", AMITY: "confirmed" },
    note: "WYNN 20 collides with TAG 20 (Jonathan Haro) — tenant is mandatory here.",
  },
  {
    jiraName: "Jackie Rose",
    jiraAccountId: "712020:4ff7869a-215a-4551-ab4b-2f6f304dfab7",
    jiraActive: true,
    logics: { TAG: 440, WYNN: 46, AMITY: 168 },
    verified: { TAG: "confirmed", WYNN: "confirmed", AMITY: "confirmed" },
    note: "POAREQ. Distinct person from Jacqueline Santos — never fuzzy-match these two.",
  },
  {
    jiraName: "Neyla Ramirez",
    jiraAccountId: "712020:21c79eb6-8705-4959-a82b-ed8ce0eab5cf",
    jiraActive: true,
    logics: { TAG: 84, WYNN: 69, AMITY: 171 },
    verified: { TAG: "confirmed", WYNN: "confirmed", AMITY: "confirmed" },
    note: "RESO. One of only three people assignable on RESO in Jira.",
  },
  {
    jiraName: "Leo Collins",
    jiraAccountId: "712020:6abca4fc-90a1-479f-a905-c6143039e44f",
    jiraActive: true,
    logics: { TAG: 413, WYNN: 28, AMITY: 151 },
    verified: { TAG: "confirmed", WYNN: "confirmed", AMITY: "confirmed" },
    // Logics spells him "Leo Collins III"; Jira does not. Exact-string matching
    // fails on this pair, which is why the verifier compares surnames.
    note: "RESO, currently zero open issues. Logics FullName is 'Leo Collins III'.",
  },
];

/**
 * Assignable in Jira but holds no issue yet, so he never appeared in the Jira
 * sweep and was not part of the hand-supplied table. His ids come from the Logics
 * harvest ALONE — nobody has confirmed them — so he is kept separate rather than
 * mixed in above. He is listed at all because he IS assignable on ASSIGNMENT and
 * POAREQ, so a sync can meet him tomorrow and would otherwise fail unmapped.
 */
const UNCONFIRMED = [
  {
    jiraName: "Alexander Banks",
    jiraAccountId: "712020:0e694875-1237-44cc-a5f3-dcbb291f164f",
    jiraActive: true,
    logics: { TAG: 394, WYNN: 26, AMITY: 150 },
    verified: { TAG: "harvested", WYNN: "harvested", AMITY: "harvested" },
    note: "HARVESTED ONLY — not supplied or confirmed by a human. Confirm before use.",
  },
];

const BY_ACCOUNT_ID = new Map(USERS.map((u) => [u.jiraAccountId, u]));
const BY_NAME = new Map(USERS.map((u) => [u.jiraName.toLowerCase(), u]));

/**
 * Resolve a Jira person to a Logics UserID for one tenant.
 *
 * Returns null rather than a fallback id when the person is unknown. A wrong
 * assignee is worse than an unassigned task: the work looks handled and lands in
 * a queue nobody is watching. Let the caller decide what to do with a miss.
 *
 * @param {{accountId?: string, displayName?: string}} jiraUser
 * @param {"TAG"|"WYNN"|"AMITY"} tenant
 * @returns {{userId: number, verified: string, user: MappedUser}|null}
 */
function resolveLogicsUser(jiraUser, tenant) {
  if (!jiraUser || !tenant) return null;
  const user = (jiraUser.accountId && BY_ACCOUNT_ID.get(jiraUser.accountId))
    || (jiraUser.displayName && BY_NAME.get(String(jiraUser.displayName).toLowerCase()))
    || null;
  if (!user) return null;
  const userId = user.logics[tenant];
  if (userId == null) return null;
  return { userId, verified: user.verified[tenant] || "unknown", user };
}

module.exports = {
  USERS,
  UNCONFIRMED,
  resolveLogicsUser,
  /** Jira display names we can map. Anything outside this set needs a human. */
  MAPPED_JIRA_NAMES: USERS.map((u) => u.jiraName),
};
