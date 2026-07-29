"use strict";

// WHO IS ON THE SALES FLOOR — and who is not.
//
// Mickey 2026-07-28: "its Bruce Alllen, Phil Olson, Chris Bolt, Sean Lucas,
// Brad Hansen — jon pineda owns the business and andrew sometimes picks up
// the phone but is cserv."
//
// This exists because a work-log that ranks everyone who touched a phone puts
// the OWNER and a CUSTOMER SERVICE rep in a sales table at zero deals, which
// reads as underperformance. Answering calls is real work; it is just not the
// same work, and the report should not imply otherwise.
//
// An UNKNOWN name is deliberately treated as sales-floor and shown, not
// hidden: a new hire missing from this list must be visible (and prompt an
// update) rather than silently vanishing from the board.

const ROLES = Object.freeze({
  SALES: "sales",     // writes deals; ranked on the board
  OWNER: "owner",     // runs the business; not ranked, never named
  CSERV: "cserv",     // customer service; answers calls, does not sell
  MGMT: "mgmt",       // management; picks up sometimes, stats are not the point
});

const parseList = (raw) => String(raw || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

/** Compare names loosely: case, extra spaces and punctuation do not matter. */
function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const DEFAULT_ROSTER = [
  ["Bruce Allen", ROLES.SALES],
  ["Phil Olson", ROLES.SALES],
  ["Chris Bolt", ROLES.SALES],
  ["Sean Lucas", ROLES.SALES],
  ["Brad Hansen", ROLES.SALES],
  ["Jonathan Pineda", ROLES.OWNER],
  ["Andrew Wells", ROLES.CSERV],
  // Mickey 2026-07-29: "hes management we dont care about his answer stats."
  ["Matthew Anderson", ROLES.MGMT],
];

// Aliases seen in the wild. PhoneBurner ids normalize to "Chris Bolt" etc.,
// but Logics and the queue disagree on some first names.
const ALIASES = [
  ["Jon Pineda", "Jonathan Pineda"],
  ["Jonathon Pineda", "Jonathan Pineda"],
  ["Andrew W", "Andrew Wells"],
];

function buildRoster(env = process.env) {
  const byName = new Map();
  for (const [name, role] of DEFAULT_ROSTER) byName.set(normalizeName(name), { name, role });

  // Env overrides so a hire or a role change needs no code edit.
  for (const [key, role] of [
    ["STAFF_ROSTER_SALES", ROLES.SALES],
    ["STAFF_ROSTER_OWNER", ROLES.OWNER],
    ["STAFF_ROSTER_CSERV", ROLES.CSERV],
    ["STAFF_ROSTER_MGMT", ROLES.MGMT],
  ]) {
    for (const name of parseList(env[key])) byName.set(normalizeName(name), { name, role });
  }

  const aliasTo = new Map();
  for (const [alias, canonical] of ALIASES) aliasTo.set(normalizeName(alias), normalizeName(canonical));
  return { byName, aliasTo };
}

let cached = null;
const roster = () => (cached || (cached = buildRoster()));

/** Reset the memo — tests change env between cases. */
function resetStaffRoster() { cached = null; }

/** Canonical spelling for a name, or the input trimmed if unknown. */
function canonicalStaffName(name) {
  const key = normalizeName(name);
  const { byName, aliasTo } = roster();
  const target = aliasTo.get(key) || key;
  return byName.get(target)?.name || String(name || "").trim();
}

/**
 * "sales" | "owner" | "cserv" for known people, "sales" for anyone unknown.
 *
 * Unknown defaults to SALES on purpose: a missing new hire must still appear
 * on the board. Hiding an unrecognised name would make the report quietly
 * incomplete, which is worse than an extra row that prompts a roster update.
 */
function staffRole(name) {
  const key = normalizeName(name);
  const { byName, aliasTo } = roster();
  const target = aliasTo.get(key) || key;
  return byName.get(target)?.role || ROLES.SALES;
}

/** Is this person ranked on the sales board? */
const isSalesFloor = (name) => staffRole(name) === ROLES.SALES;

/** Everyone the roster knows, by role. */
function listStaff(role = null) {
  const { byName } = roster();
  const all = [...byName.values()];
  return (role ? all.filter((s) => s.role === role) : all).map((s) => ({ ...s }));
}

// Queue and system labels that arrive through the same channel as agent
// names. "Origination Call Qu" appeared on the sales board as a person.
// Unknown PEOPLE still default to the sales floor so a new hire is visible;
// these are not people at all.
const NOT_A_PERSON = /(queue|call qu|origination|voicemail|unassigned|ring group|overflow|after hours|main line|ivr|auto ?attendant|system)/i;

/** Is this label a queue or system rather than a human being? */
function isNotAPerson(name) {
  const raw = String(name || "").trim();
  if (!raw) return true;
  if (!isUnknownStaff(raw)) return false;   // anyone on the roster is a person
  return NOT_A_PERSON.test(raw);
}

/** True when the name is not in the roster at all (prompt an update). */
function isUnknownStaff(name) {
  const key = normalizeName(name);
  const { byName, aliasTo } = roster();
  return !byName.has(aliasTo.get(key) || key);
}

module.exports = {
  ROLES,
  isNotAPerson,
  canonicalStaffName,
  isSalesFloor,
  isUnknownStaff,
  listStaff,
  normalizeName,
  resetStaffRoster,
  staffRole,
};
