"use strict";

/**
 * jira-case-tenant-resolve — work out which Logics tenant a Jira issue means.
 *
 * Mickey 2026-08-05: "we have names so you can sorta pull and match that way,
 * and generally assume it's tag, so go tag => amity => wynn checking case id
 * til you match a name."
 *
 * The problem this solves: 99.5% of Jira summaries carry a Logics case id, but
 * only 63% name the tenant — and case ids are PER TENANT, so 295795 exists in
 * more than one database and means different clients. The id alone is ambiguous.
 *
 * The name disambiguates it. Fetch the case in each tenant in turn and keep the
 * one whose client name matches the summary. TAG first because most volume is
 * TAG, so most lookups stop after one call.
 *
 * ── WHAT COUNTS AS A MATCH ──────────────────────────────────────────────────
 *
 * Surname only, case-insensitive. Summaries are hand-typed by several people
 * across three projects in at least three different orders, so first names get
 * abbreviated, middle names appear and disappear, and "LINDA KIELKOPF" may be
 * "Linda M Kielkopf" in Logics. A surname hit plus a matching case id is strong
 * evidence; demanding an exact full-name match would reject correct answers.
 *
 * ── AND WHAT DOES NOT ───────────────────────────────────────────────────────
 *
 * An id that exists in a tenant but whose NAME does not match is NOT a match —
 * it is the ambiguity this exists to catch, and silently accepting it would
 * attach a Jira issue to the wrong client's case. Those are reported as
 * `conflict`, never resolved by position.
 *
 *   node scripts/analysis/jira-case-tenant-resolve.js [sampleSize]
 */

require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) {
  require("dns").setServers(String(process.env.DNS_SERVERS).split(",").map((s) => s.trim()));
}

const path = require("path");
const { connectMongo, disconnectMongo } = require(path.join(__dirname, "../../packages/event-core/src"));
const { getSharedConfig } = require(path.join(__dirname, "../../packages/shared-config/src"));
const { createLogicsFacade } = require(path.join(__dirname, "../../packages/shared-services/src/logicsFacadeService"));

const TOKEN = process.env.JIRA_API_TOKEN;
const EMAIL = "mgray@taxadvocategroup.com";
const BASE = "https://taxadvocategroup.atlassian.net";
const AUTH = {
  Authorization: `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

// Tenant order: TAG carries most volume, so most lookups stop on the first call.
const ORDER = ["TAG", "AMITY", "WYNN"];
const CASE_RE = /\b(\d{5,7})\b/;
const TENANT_RE = /\b(TAG|WYNN|AMITY)\b/i;

/** Words that are not part of a person's name. */
const NOISE = /\b(TAG|WYNN|AMITY|TEST|PROBE|IRS|STATE|POA|RE|FOR|THE|AND|MO|SENT|HOLD|READY|FILE)\b/gi;

function nameTokens(summary) {
  return String(summary || "")
    .replace(CASE_RE, " ")
    .replace(NOISE, " ")
    .replace(/[^A-Za-z\s'-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length >= 3);
}

function parseSummary(summary) {
  const idMatch = String(summary || "").match(CASE_RE);
  const tenantMatch = String(summary || "").match(TENANT_RE);
  return {
    caseId: idMatch ? Number(idMatch[1]) : null,
    statedTenant: tenantMatch ? tenantMatch[1].toUpperCase() : null,
    words: nameTokens(summary),
  };
}

const unwrap = (res) => {
  const d = res?.data ?? res;
  return Array.isArray(d) ? d[0] : d;
};

async function resolveOne(parsed, facades, blind = false) {
  const attempts = [];
  // A stated tenant is tried FIRST — it is evidence, and skipping it would burn
  // calls re-deriving something the author already told us.
  //
  // `blind` throws that evidence away on purpose. Only 63% of summaries name a
  // tenant, so the fallback walk is what carries the other 37% — and a sample
  // where every WYNN issue said "Wynn" proves nothing about it. Running blind
  // over issues whose answer we already know is the only way to test the walk.
  const order = parsed.statedTenant && !blind
    ? [parsed.statedTenant, ...ORDER.filter((t) => t !== parsed.statedTenant)]
    : ORDER;

  for (const tenant of order) {
    let body;
    try {
      body = unwrap(await facades(tenant).fetchCaseInfo(parsed.caseId));
    } catch (error) {
      attempts.push({ tenant, outcome: "error", detail: String(error.message).slice(0, 60) });
      continue;
    }
    if (!body || !body.CaseID) { attempts.push({ tenant, outcome: "no-case" }); continue; }

    const logicsName = `${body.FirstName || ""} ${body.MiddleName || ""} ${body.LastName || ""}`
      .toLowerCase();
    const hit = parsed.words.some((w) => logicsName.includes(w));
    attempts.push({
      tenant, outcome: hit ? "match" : "name-mismatch",
      logicsName: logicsName.replace(/\s+/g, " ").trim(),
    });
    if (hit) return { tenant, body, attempts, how: "name" };
  }

  // No name to check against, but the author named a tenant and that tenant does
  // hold the case. Requiring a name match here would throw away the only evidence
  // there is — the earlier version rejected "WYNN - 104446" outright, which is
  // wrong: nothing about it is ambiguous to a human.
  //
  // It is still weaker than a name match, because nothing corroborates it, so it
  // is reported as `stated` rather than folded in with the confirmed ones.
  // Suppressed under --blind: this fallback reads the stated tenant straight off
  // the summary, so letting it run during grading would let the answer key mark
  // its own homework.
  if (!blind && !parsed.words.length && parsed.statedTenant) {
    const stated = attempts.find((a) => a.tenant === parsed.statedTenant && a.outcome === "name-mismatch");
    if (stated) return { tenant: parsed.statedTenant, body: null, attempts, how: "stated" };
  }
  return { tenant: null, body: null, attempts, how: null };
}

/**
 * Ask every tenant for the same handful of ids, to find out whether a case id
 * is unique across the three databases or only within one.
 *
 * This decides what the name check is FOR. If ids collide, the name is the only
 * thing preventing a Jira issue from being attached to a stranger's case and it
 * is load-bearing. If ids are globally unique, the walk alone is already correct
 * and the name is a cheap second opinion.
 */
async function probeCollisions(facades) {
  // Ids whose owner we know, from summaries that stated their tenant.
  const known = [[137912, "WYNN"], [130897, "WYNN"], [436545, "TAG"], [219780, "TAG"], [11330, "TAG"]];
  console.log("\n  Does the same case id exist in more than one tenant?\n");
  let collisions = 0;
  for (const [id, owner] of known) {
    const row = [];
    for (const tenant of ORDER) {
      let cell = "-";
      try {
        const b = unwrap(await facades(tenant).fetchCaseInfo(id));
        if (b && b.CaseID) { cell = String(b.LastName || "?").slice(0, 12); }
      } catch { cell = "ERR"; }
      if (cell !== "-" && cell !== "ERR" && tenant !== owner) collisions += 1;
      row.push(`${tenant}=${cell}`);
    }
    console.log(`  ${String(id).padEnd(8)} owner ${owner.padEnd(6)} ${row.join("  ")}`);
  }
  console.log(`\n  cross-tenant hits: ${collisions}`
    + (collisions ? "  → ids COLLIDE, the name check is load-bearing"
      : "  → ids appear unique per id, name check is a second opinion"));
}

async function fetchAll(jql, fields) {
  const out = [];
  let token = null;
  do {
    const res = await fetch(`${BASE}/rest/api/3/search/jql`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ jql, maxResults: 100, fields, ...(token ? { nextPageToken: token } : {}) }),
    });
    const page = JSON.parse(await res.text());
    out.push(...(page.issues || []));
    token = page.nextPageToken || null;
  } while (token);
  return out;
}

/**
 * Since ids collide, a summary carrying an id but NO name cannot be resolved at
 * all — the walk would have to guess. Count how often that happens, per project,
 * with no Logics calls: it is the ceiling on what any sync can map.
 */
async function probeCoverage() {
  const issues = await fetchAll(
    "project in (ASSIGNMENT, POAREQ, RESO) ORDER BY created DESC",
    ["summary", "project", "status"],
  );
  const by = {};
  for (const issue of issues) {
    const key = issue.fields.project.key;
    const p = parseSummary(issue.fields.summary || "");
    const b = by[key] || (by[key] = { n: 0, id: 0, name: 0, both: 0, tenant: 0, neither: 0 });
    b.n += 1;
    if (p.caseId) b.id += 1;
    if (p.words.length) b.name += 1;
    if (p.statedTenant) b.tenant += 1;
    if (p.caseId && p.words.length) b.both += 1;
    // The unresolvable shape: an id with nothing to disambiguate it.
    if (p.caseId && !p.words.length && !p.statedTenant) b.neither += 1;
  }
  console.log(`\n  ${"project".padEnd(12)}${"issues".padEnd(9)}${"case id".padEnd(15)}`
    + `${"name".padEnd(15)}${"id+name".padEnd(15)}id, nothing else`);
  const pct = (a, b) => `${a} (${((a / Math.max(b, 1)) * 100).toFixed(1)}%)`;
  const tot = { n: 0, id: 0, name: 0, both: 0, neither: 0 };
  for (const [k, b] of Object.entries(by)) {
    for (const f of ["n", "id", "name", "both", "neither"]) tot[f] += b[f];
    console.log(`  ${k.padEnd(12)}${String(b.n).padEnd(9)}${pct(b.id, b.n).padEnd(15)}`
      + `${pct(b.name, b.n).padEnd(15)}${pct(b.both, b.n).padEnd(15)}${b.neither}`);
  }
  console.log(`  ${"ALL".padEnd(12)}${String(tot.n).padEnd(9)}${pct(tot.id, tot.n).padEnd(15)}`
    + `${pct(tot.name, tot.n).padEnd(15)}${pct(tot.both, tot.n).padEnd(15)}${tot.neither}`);
  console.log(`\n  resolvable ceiling: ${pct(tot.both, tot.n)} of issues carry both an id `
    + `and a name\n  unresolvable: ${tot.neither} carry an id with nothing to disambiguate it\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const blind = args.includes("--blind");
  const sample = Number(args.find((a) => /^\d+$/.test(a))) || 30;
  await connectMongo(getSharedConfig());

  const cache = new Map();
  const facades = (t) => {
    if (!cache.has(t)) cache.set(t, createLogicsFacade(t));
    return cache.get(t);
  };

  // --one <KEY> dumps every tenant's answer for a single issue. For reading the
  // cases the graded run disagreed on, where the summary is as likely to be wrong
  // as the walk is.
  const one = args.find((a) => /^[A-Z]+-\d+$/.test(a));
  if (one) {
    const r = await fetch(`${BASE}/rest/api/3/issue/${one}?fields=summary`, { headers: AUTH });
    const summary = JSON.parse(await r.text())?.fields?.summary || "";
    const p = parseSummary(summary);
    console.log(`\n  ${one}: "${summary}"`);
    console.log(`  parsed: case ${p.caseId}  tenant ${p.statedTenant || "(none)"}  `
      + `name words [${p.words.join(", ")}]`);
    for (const tenant of ORDER) {
      let cell = "(no case)";
      try {
        const b = unwrap(await facades(tenant).fetchCaseInfo(p.caseId));
        if (b && b.CaseID) cell = `${b.FirstName || ""} ${b.MiddleName || ""} ${b.LastName || ""}`
          .replace(/\s+/g, " ").trim();
      } catch (e) { cell = "ERROR " + String(e.message).slice(0, 40); }
      console.log(`    ${tenant.padEnd(6)} ${cell}`);
    }
    console.log("");
    await disconnectMongo();
    return;
  }

  if (args.includes("--coverage")) {
    await probeCoverage();
    await disconnectMongo();
    return;
  }

  if (args.includes("--collide")) {
    await probeCollisions(facades);
    console.log("");
    await disconnectMongo();
    return;
  }

  // --grade picks the issues where TAG-first is WRONG: the ones that name WYNN or
  // AMITY. They come with their own answer key, so running them blind measures the
  // only thing that can really go wrong — the walk stopping one tenant too early.
  // Default is open issues; a backfill of 3,631 Done ones is not the interesting case.
  const grading = args.includes("--grade");
  const jql = grading
    ? 'project in (ASSIGNMENT, POAREQ, RESO) AND (summary ~ "Wynn" OR summary ~ "Amity") ORDER BY created DESC'
    : "project in (ASSIGNMENT, POAREQ, RESO) AND statusCategory != Done ORDER BY created DESC";
  const res = await fetch(`${BASE}/rest/api/3/search/jql`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ jql, maxResults: sample, fields: ["summary", "project", "status"] }),
  });
  const issues = (JSON.parse(await res.text()).issues || []);
  console.log(`\n  OPEN issues sampled: ${issues.length}\n`);

  const tally = { match: 0, statedOnly: 0, noName: 0, noCase: 0, conflict: 0, unresolved: 0 };
  const byTenant = {};
  const truth = { total: 0, agree: 0, disagree: [] };
  let calls = 0;
  if (blind) console.log("  --blind: ignoring the tenant stated in the summary\n");

  for (const issue of issues) {
    const summary = issue.fields.summary || "";
    const parsed = parseSummary(summary);
    if (!parsed.caseId) {
      tally.noCase += 1;
      console.log(`  ${issue.key.padEnd(16)} NO CASE ID   ${summary.slice(0, 46)}`);
      continue;
    }
    if (!parsed.words.length) tally.noName += 1;

    const r = await resolveOne(parsed, facades, blind);
    calls += r.attempts.length;

    if (r.tenant) {
      tally.match += 1;
      if (r.how === "stated") tally.statedOnly += 1;
      byTenant[r.tenant] = (byTenant[r.tenant] || 0) + 1;
      const tried = r.attempts.length;
      // Under --blind, an issue that names its tenant is ground truth: the walk
      // reached an answer without being told, so we can check whether it agrees.
      let graded = "";
      if (blind && parsed.statedTenant) {
        const ok = r.tenant === parsed.statedTenant;
        truth.total += 1;
        if (ok) truth.agree += 1; else truth.disagree.push(
          `${issue.key} said ${parsed.statedTenant}, walk said ${r.tenant}`);
        graded = ok ? "  [agrees]" : `  [DISAGREES — summary says ${parsed.statedTenant}]`;
      }
      console.log(`  ${issue.key.padEnd(16)} ${r.tenant.padEnd(6)} ${String(parsed.caseId).padEnd(8)}`
        + `${tried > 1 ? `(${tried} tries) ` : ""}${summary.slice(0, 40)}${graded}`);
    } else {
      const sawCase = r.attempts.some((a) => a.outcome === "name-mismatch");
      if (sawCase) tally.conflict += 1; else tally.unresolved += 1;
      console.log(`  ${issue.key.padEnd(16)} ${(sawCase ? "CONFLICT" : "NOT FOUND").padEnd(13)}`
        + `${String(parsed.caseId).padEnd(8)}${summary.slice(0, 34)}`);
      for (const a of r.attempts.filter((x) => x.outcome === "name-mismatch")) {
        console.log(`      ${a.tenant} has ${parsed.caseId} but as "${a.logicsName}"`);
      }
    }
  }

  console.log(`\n  RESOLVED  ${tally.match}/${issues.length}`
    + `   (${tally.match - tally.statedOnly} confirmed by name, ${tally.statedOnly} on stated tenant alone)`);
  console.log(`  conflicts ${tally.conflict}   not found ${tally.unresolved}   no case id ${tally.noCase}`);
  console.log(`  by tenant: ${Object.entries(byTenant).map(([k, v]) => `${k}=${v}`).join("  ") || "(none)"}`);
  console.log(`  Logics calls: ${calls} for ${issues.length} issues `
    + `(${(calls / Math.max(issues.length, 1)).toFixed(2)} per issue)`);

  if (blind && truth.total) {
    console.log(`\n  GRADED against the tenant the summary stated: `
      + `${truth.agree}/${truth.total} agree`);
    for (const d of truth.disagree) console.log(`      ${d}`);
  }
  console.log("");

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
