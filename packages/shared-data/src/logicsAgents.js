"use strict";

/**
 * TAG / Wynn Logics agent roster — one row per human. Each row may carry
 * a `tag` block (TAG Logics tenant identity) and/or a `wynn` block (Wynn
 * Logics tenant identity). The two tenants are separate ID namespaces:
 * TAG Logics 404 and Wynn Logics 24 are both Bruce Allen, but they're
 * distinct user records on distinct Logics instances, and case ownership
 * is tracked against whichever tenant the case lives in.
 *
 * At runtime the caller resolves "which company is this phone call /
 * case for?" from the DID + CallRail tenant lookup, then picks the
 * matching `tag` or `wynn` block to get the correct Logics user id.
 *
 * Email notes:
 *  - Most humans have `ballen@taxadvocategroup.com` + `ballen@wynntaxsolutions.com`.
 *  - `manderson` and `mgray` have ONE email (the TAG one) registered in
 *    both tenants — so their wynn.email is the same TAG address. That's
 *    fine: the id namespace distinguishes them, not the email.
 *  - Alazey Cordero has a third legacy TAG-tenant record (id 447) tied
 *    to her wynn email — kept in metadata as `tag.legacyIds` so we don't
 *    lose the reference, but not treated as her primary TAG identity.
 *
 * Source: user-provided dumps, 2026-04-23 (TAG) + 2026-04-23 (Wynn).
 * Maintained manually; no Logics list-users endpoint exposed publicly.
 */
const LOGICS_AGENTS = Object.freeze([
  {
    name: "Alazey Cordero",
    phone: null,
    tag: {
      logicsId: 446,
      email: "acordero@taxadvocategroup.com",
      roles: "BackOffice,Case Worker,Case worker - All status/No Billing,Tax Preparer",
      legacyIds: [447],
    },
    wynn: {
      logicsId: 71,
      email: "acordero@wynntaxsolutions.com",
      roles: "Case Worker,Tax Preparer",
    },
  },
  {
    name: "Alexander Banks",
    phone: "(818)638-8190",
    tag: {
      logicsId: 394,
      email: "abanks@taxadvocategroup.com",
      roles: "Accountant / Controller,Admin,Case Manager,Case Worker,Opener,Settlement Officer / Sales,Tax Preparer,TIER 5",
    },
    wynn: {
      logicsId: 26,
      email: "abanks@wynntaxsolutions.com",
      roles: "Accountant / Controller,Case Manager,Case Worker,Sales Manager,Settlement Officer / Sales,Super Admin",
    },
  },
  {
    name: "Andrew Wells",
    phone: "(818)396-1862",
    tag: {
      logicsId: 400,
      email: "awells@taxadvocategroup.com",
      roles: "Case Manager,Case Worker,Opener,Settlement Officer / Sales,Tax Preparer,TIER 5",
    },
    wynn: {
      logicsId: 27,
      email: "awells@wynntaxsolutions.com",
      roles: "Case Manager,Case Worker,Opener,Settlement Officer / Sales,Tax Preparer",
    },
  },
  {
    name: "Anthony Calloway",
    phone: "(818)206-4601",
    tag: {
      logicsId: 48,
      email: "acalloway@taxadvocategroup.com",
      roles: "Opener,Settlement Officer / Sales",
    },
    wynn: {
      logicsId: 76,
      email: "acalloway@wynntaxsolutions.com",
      roles: "Case Manager,Opener,Outsource,Settlement Officer / Sales",
    },
  },
  {
    name: "Bruce Allen",
    phone: "(747)307-7280",
    tag: {
      logicsId: 404,
      email: "ballen@taxadvocategroup.com",
      roles: "Accountant / Controller,Case Manager,Case Worker,Opener,Sales Manager,Settlement Officer / Sales,Tax Preparer",
    },
    wynn: {
      logicsId: 24,
      email: "ballen@wynntaxsolutions.com",
      roles: "Accountant / Controller,Case Manager,Case Worker,Sales Manager,Settlement Officer / Sales",
    },
  },
  {
    name: "Dani Pearson",
    phone: "(818)235-1306",
    tag: {
      logicsId: 427,
      email: "dpearson@taxadvocategroup.com",
      roles: "Case Manager,Case Worker,Opener,Settlement Officer / Sales,Tax Preparer,TIER 5",
    },
    wynn: {
      logicsId: 34,
      email: "dpearson@wynntaxsolutions.com",
      roles: "Case Manager,Case Worker,Opener,Settlement Officer / Sales",
    },
  },
  {
    name: "Eli Hayes",
    phone: "(818)334-4107",
    tag: {
      logicsId: 421,
      email: "ehayes@taxadvocategroup.com",
      roles: "Case Manager,Case Worker,Opener,Settlement Officer / Sales,Tax Preparer,TIER 5",
    },
    wynn: {
      logicsId: 25,
      email: "ehayes@wynntaxsolutions.com",
      roles: "Case Manager,Case Worker,Settlement Officer / Sales",
    },
  },
  {
    name: "Jackie Rose",
    phone: null,
    tag: {
      logicsId: 440,
      email: "jrose@taxadvocategroup.com",
      roles: "Settlement Officer / Sales,TIER 5",
    },
    wynn: {
      logicsId: 46,
      email: "jrose@wynntaxsolutions.com",
      roles: "Case Manager,Case Worker,Settlement Officer / Sales",
    },
  },
  {
    name: "Jacqueline Santos",
    phone: null,
    tag: {
      logicsId: 437,
      email: "jsantos@taxadvocategroup.com",
      roles: "Case Manager,Case Worker,Settlement Officer / Sales,Tax Preparer,TIER 5",
    },
    wynn: {
      logicsId: 43,
      email: "jsantos@wynntaxsolutions.com",
      roles: "Case Manager,Case Worker,Settlement Officer / Sales,Tax Preparer",
    },
  },
  {
    name: "Jake Wallace",
    phone: "(818)793-0820",
    tag: {
      logicsId: 429,
      email: "jwallace@taxadvocategroup.com",
      roles: "Case Manager,Case Worker,Opener,Settlement Officer / Sales,Tax Preparer,TIER 5",
    },
    wynn: {
      logicsId: 36,
      email: "jwallace@wynntaxsolutions.com",
      roles: "Case Manager,Case Worker,Opener,Settlement Officer / Sales",
    },
  },
  {
    name: "Jonathan Haro",
    phone: "(818)239-4141",
    tag: {
      logicsId: 20,
      email: "jharo@taxadvocategroup.com",
      roles: "Case Manager,Case Worker,Opener,Receptionist,Settlement Officer / Sales,Tax Preparer,TIER 5",
    },
    wynn: {
      logicsId: 39,
      email: "jharo@wynntaxsolutions.com",
      phone: "(949)570-8747",
      roles: "Case Manager,Case Worker,Opener,Settlement Officer / Sales",
    },
  },
  {
    name: "Jonathan Pineda",
    phone: null,
    tag: {
      logicsId: 22,
      email: "jpineda@taxadvocategroup.com",
      roles: "Admin,BackOffice,Case Manager,Case Worker,Opener,Sales Manager,TIER 5",
    },
    wynn: {
      logicsId: 17,
      email: "jpineda@wynntaxsolutions.com",
      displayName: "House Wynn",
      roles: "Attorney / EA / CPA,Case Manager,Case Worker,Opener,Sales Manager,Settlement Officer / Sales,Tax Preparer",
    },
  },
  {
    name: "Leo Collins III",
    phone: "(818)396-8986",
    tag: {
      logicsId: 413,
      email: "lcollins@taxadvocategroup.com",
      roles: "Attorney / EA / CPA,Settlement Officer / Sales,TIER 5",
    },
    wynn: {
      logicsId: 28,
      email: "lcollins@wynntaxsolutions.com",
      roles: "Attorney / EA / CPA,Case Manager,Case Worker,Settlement Officer / Sales",
    },
  },
  {
    name: "Matthew Anderson",
    phone: "(213)757-7884",
    // NOTE: Wynn Logics id 33 is registered under the TAG email, not a
    // separate wynn address. Admin-only, not a phone-answering seat.
    tag: {
      logicsId: 44,
      email: "manderson@taxadvocategroup.com",
      roles: "Accountant / Controller,BackOffice,Case Manager,Case Worker,Opener,Sales Manager,Settlement Officer / Sales,Tax Preparer,TIER 5",
    },
    wynn: {
      logicsId: 33,
      email: "manderson@taxadvocategroup.com",
      roles: "Case Manager,Case Worker,Sales Manager,Settlement Officer / Sales,Admin",
    },
  },
  {
    name: "Mickey Gray",
    phone: null,
    // NOTE: Wynn Logics id 45 is registered under the TAG email. Admin-only.
    tag: {
      logicsId: 439,
      email: "mgray@taxadvocategroup.com",
      roles: "Admin,CAN EXPORT,Case Manager,Case Worker,Settlement Officer / Sales,TIER 5",
    },
    wynn: {
      logicsId: 45,
      email: "mgray@taxadvocategroup.com",
      roles: "Admin,Settlement Officer / Sales",
    },
  },
  {
    name: "Monica Cazares",
    phone: "(213)445-9712",
    tag: {
      logicsId: 398,
      email: "mcazares@taxadvocategroup.com",
      roles: "Admin,Attorney / EA / CPA,Settlement Officer / Sales,Tax Preparer,TIER 5",
    },
    wynn: {
      logicsId: 32,
      email: "mcazares@wynntaxsolutions.com",
      roles: "Accountant / Controller,Admin,Attorney / EA / CPA,Case Manager,Case Worker,Sales Manager,Settlement Officer / Sales,Super Admin,Tax Preparer",
    },
  },
  {
    name: "Neyla Ramirez",
    phone: null,
    tag: {
      logicsId: 84,
      email: "nramirez@taxadvocategroup.com",
      roles: "Attorney / EA / CPA,Case Manager,Case Worker,Settlement Officer / Sales,TIER 5",
    },
    wynn: {
      logicsId: 69,
      email: "nramirez@wynntaxsolutions.com",
      roles: "Attorney / EA / CPA,Case Manager,Case Worker,Settlement Officer / Sales",
    },
  },
  {
    name: "Phil Olson",
    phone: "(818)206-3751",
    tag: {
      logicsId: 433,
      email: "polson@taxadvocategroup.com",
      roles: "Case Manager,Case Worker,Opener,Settlement Officer / Sales,Tax Preparer",
    },
    wynn: {
      logicsId: 38,
      email: "polson@wynntaxsolutions.com",
      roles: "Case Manager,Case Worker,Opener,Settlement Officer / Sales",
    },
  },
  {
    name: "Riley Mills",
    phone: "(818)492-9763",
    tag: {
      logicsId: 407,
      email: "rmills@taxadvocategroup.com",
      roles: "Attorney / EA / CPA,Settlement Officer / Sales,TIER 5",
    },
    wynn: {
      logicsId: 20,
      email: "rmills@wynntaxsolutions.com",
      roles: "Case Manager,Case Worker,Settlement Officer / Sales",
    },
  },
  {
    name: "Sean Lucas",
    phone: "(818)286-3539",
    tag: {
      logicsId: 441,
      email: "slucas@taxadvocategroup.com",
      roles: "Case Worker,Settlement Officer / Sales",
    },
    wynn: {
      logicsId: 67,
      email: "slucas@wynntaxsolutions.com",
      roles: "Case Manager,Case Worker,Opener,Settlement Officer / Sales",
    },
  },
  // ── TAG-only identities (no Wynn Logics pairing) ────────────────────
  {
    name: "Ricardo Reyes",
    phone: null,
    tag: {
      logicsId: 51,
      email: "rreyes@taxadvocategroup.com",
      roles: "Accountant / Controller,Admin,Attorney / EA / CPA,Case Manager,Case Worker",
    },
    wynn: null,
  },
  {
    name: "Tax Advocate Group",
    phone: null,
    tag: {
      logicsId: 399,
      email: "no-reply@taxadvocategroup.com",
      roles: "Admin,Case Manager,Case Worker,Opener,Settlement Officer / Sales,Tax Preparer",
    },
    wynn: null,
  },
  {
    name: "Todd Lewis",
    phone: null,
    tag: {
      logicsId: 424,
      email: "todd@thereputationmd.com",
      roles: "CAN EXPORT,Todd",
    },
    wynn: null,
  },
]);

function normalize(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * Returns the single canonical agent row whose TAG or Wynn email
 * matches the given address. If both `manderson` entries (TAG + Wynn
 * under the same email) match, still returns one row — because one
 * row represents one human.
 */
function findLogicsAgentByEmail(email) {
  const needle = normalize(email);
  if (!needle) return null;
  for (const agent of LOGICS_AGENTS) {
    if (normalize(agent.tag?.email) === needle) return agent;
    if (normalize(agent.wynn?.email) === needle) return agent;
  }
  return null;
}

/**
 * Resolve the Logics identity for a specific company. Returns
 * `{ logicsId, email, roles, displayName }` or null.
 *
 * Used by call/case routing: once the DID → CallRail → company mapping
 * says "this is a TAG interaction", you call `resolveLogicsForCompany(
 * agent, 'TAG')` to get the TAG-side Logics identity.
 */
function resolveLogicsForCompany(agent, company) {
  if (!agent) return null;
  const key = String(company || "").toLowerCase() === "wynn" ? "wynn" : "tag";
  const block = agent[key];
  if (!block) return null;
  return {
    logicsId: block.logicsId,
    settlementOfficerId: block.settlementOfficerId || block.soId || block.logicsId,
    email: block.email,
    roles: block.roles,
    displayName: block.displayName || agent.name,
  };
}

/**
 * Flatten the roster into company-scoped rows.
 * Each row: { name, company, logicsId, email, roles, phone }.
 * Convenient for building company-specific dispatch tables.
 */
function flattenByCompany() {
  const rows = [];
  for (const agent of LOGICS_AGENTS) {
    if (agent.tag) {
      rows.push({
        name: agent.name,
        company: "TAG",
        logicsId: agent.tag.logicsId,
        settlementOfficerId: agent.tag.settlementOfficerId || agent.tag.soId || agent.tag.logicsId,
        email: agent.tag.email,
        roles: agent.tag.roles,
        phone: agent.phone,
      });
    }
    if (agent.wynn) {
      rows.push({
        name: agent.name,
        company: "WYNN",
        logicsId: agent.wynn.logicsId,
        settlementOfficerId: agent.wynn.settlementOfficerId || agent.wynn.soId || agent.wynn.logicsId,
        email: agent.wynn.email,
        roles: agent.wynn.roles,
        phone: agent.wynn.phone || agent.phone,
      });
    }
  }
  return rows;
}

module.exports = {
  LOGICS_AGENTS,
  findLogicsAgentByEmail,
  resolveLogicsForCompany,
  flattenByCompany,
};
