"use strict";

// RUNTIME-LEVEL EVAL (2026-07-08): the annotated fixtures through the REAL two-station
// runtime — createCoachTwoStationLoop + createTwoStationTransports + REAL API calls —
// not just the prompts. This is the artifact that says "the CADENCE behaves" before a
// human wears it: B grounds fast and regrounds sanely, A fires on substance and knows
// how to shut up, DNC is terminal, nothing promises outcomes, the fee is a real number,
// and the whole call costs what the economics doc said it would.
//
//   node scripts/coach-eval/run-two-station.js                    # 4 core fixtures
//   node scripts/coach-eval/run-two-station.js --all              # all 7
//   node scripts/coach-eval/run-two-station.js --fixture hostile-dnc
//
// Simulated clock: ~20s per turn, so B's 5-min interval ≈ every ~15 turns (plus the
// immediate first ground). Read-only against the repo; spends real API cents.

const fs = require("fs");
const path = require("path");
const { createCoachTwoStationLoop } = require("../../packages/shared-services/src/coachTwoStationLoop");
const { createTwoStationTransports } = require("../../apps/ai-bus/src/coachTwoStationTransports");

const argv = process.argv.slice(2);
const runAll = argv.includes("--all");
const onlyFixture = (() => {
  const i = argv.indexOf("--fixture");
  return i >= 0 ? argv[i + 1] : null;
})();

// key: two-station override -> solo metered -> general (eval fallback; pilot should
// mint the dedicated key — see the Thursday runbook)
function loadKey() {
  const envText = fs.readFileSync(path.resolve(__dirname, "..", "..", ".env"), "utf8");
  for (const name of [
    "LIVE_COACH_TWO_STATION_ANTHROPIC_API_KEY",
    "LIVE_COACH_SOLO_ANTHROPIC_API_KEY",
    "ANTHROPIC_API_KEY",
  ]) {
    const m = envText.match(new RegExp(`^${name}=(.+)$`, "m"));
    if (m && m[1].trim()) return { name, key: m[1].trim() };
    if (process.env[name]) return { name, key: process.env[name] };
  }
  return null;
}

// $/MTok (Sonnet from apiRunner.js consts; Haiku 4.5 public card).
// NOTE: Sonnet figures are the INTRO rate — list is $3/$15 from 2026-09-01, which
// raises the B leg (the dominant cost) ~50%. Realistic band: ~$40-65/agent-mo now
// (real pace pays mostly cache WRITES — B's 5-min reground sits at the cache TTL
// boundary), ~$60-90 post-intro. The live 5-min meter's cacheWrite-vs-cacheRead
// split on the strategist bucket is the real number.
const PRICE = {
  sonnet: { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  haiku: { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};
function usageCost(u, p) {
  return (
    (u.inputTokens / 1e6) * p.in +
    (u.outputTokens / 1e6) * p.out +
    (u.cacheWriteTokens / 1e6) * p.cacheWrite +
    (u.cacheReadTokens / 1e6) * p.cacheRead
  );
}

const PROMISE_PATTERN = /\bguarantee(?:d|s)?\b|\bOIC\b|offer in compromise|settle for less|pennies on the dollar|\bwill (?:be )?(?:accept|approv|remov|eliminat)/i;
const PLACEHOLDER_PATTERN = /\$\s*\[|\$___|\$X\b|\$\[X\]/i;

const CORE = ["fixture-tax-call-01", "fixture-hostile-dnc", "fixture-noise-heavy", "fixture-fast-yes"];

async function runFixture(name, transports) {
  const fx = require(path.join(__dirname, name));
  const says = [];
  const cockpits = [];
  let clock = 1_000_000_000;

  let batchRows = [];
  let lastBText = "";
  const wrappedStrategist = async (req) => {
    const res = await transports.runStrategist(req);
    lastBText = res?.text || "";
    return res;
  };
  const loop = createCoachTwoStationLoop({
    buildBatch: () => ({ conversations: [{ sessionId: "eval", call: { uii: "eval-uii" }, arrays: { transcript: batchRows } }] }),
    applySteering: (updates) => cockpits.push(...updates),
    emitGuidance: (dispatch) => { says.push(dispatch.payload); },
    runStrategist: wrappedStrategist,
    runCoach: transports.runCoach,
    reference: require("../../packages/shared-services/src/coachReferenceLibrary")
      .buildReferenceBody()
      .replace(/\$___/g, "$3,500"),
    logger: { info: () => {}, warn: (msg, meta) => {
      console.log(`    ⚠ ${msg} ${JSON.stringify(meta || {})}`);
      if (String(msg).includes("unparseable")) {
        console.log(`    RAW-B (${lastBText.length} chars) tail>>> ${lastBText.slice(-300)}`);
      }
    } },
    now: () => clock,
  });

  // find where the prospect goes DNC (for the terminal-doctrine grade)
  const dncTurnIndex = fx.turns.findIndex((t) =>
    t.speaker === "prospect" && /do not call|don't call|stop calling|take me off/i.test(t.text));
  let saysBeforeDnc = 0;

  for (let i = 0; i < fx.turns.length; i += 1) {
    const t = fx.turns[i];
    batchRows = [...batchRows, { id: `r${i}`, role: t.speaker, text: t.text, provisional: false }];
    clock += 20_000;
    await loop.tick();
    if (dncTurnIndex >= 0 && i <= dncTurnIndex) saysBeforeDnc = says.length;
  }
  // trailing tick after a minute of silence — nothing new should fire
  clock += 60_000;
  await loop.tick();

  const c = loop.getCounters();
  const saysAfterDnc = says.slice(saysBeforeDnc);
  // the compliance scan grades what the agent would SAY (`try`) — the `read` line is a
  // summary that legitimately NARRATES the prospect's own asks ("asked about pennies on
  // the dollar"), and a negated refusal ("nobody can promise X") IS the doctrine
  const NEGATION_WINDOW = /(?:won't|will not|can't|cannot|not going to|nobody can|no one can|never|don't|do not)\s+(?:\w+\s+){0,4}$/i;
  const promiseHit = (() => {
    for (const s of says) {
      const text = String(s.try || "");
      const m = PROMISE_PATTERN.exec(text);
      if (m && !NEGATION_WINDOW.test(text.slice(0, m.index))) return m[0];
    }
    return null;
  })();
  const allSayText = says.map((s) => `${s.read || ""} ${s.try || ""}`).join("\n");
  const cockpitText = cockpits.map((u) => JSON.stringify(u.says || [])).join("\n");

  const checks = [];
  const check = (ok, label, detail) => { checks.push({ ok, label, detail }); };

  check(c.bRegrounds >= 1, "B grounded", `${c.bRegrounds} reground(s), ${c.bFailures} failure(s)`);
  check(c.bFailures === 0, "no B failures", `${c.bFailures}`);
  check(c.aFailures === 0, "no A failures", `${c.aFailures}`);
  const substantive = c.turnsCommitted;
  const maxSaneFires = Math.ceil(substantive / 3) + 1;
  check(c.aFires <= maxSaneFires, "fire rate sane", `${c.aFires} fires vs ${substantive} substantive turns (cap ${maxSaneFires}); holds=${c.aHolds} dupes=${c.aDupes}`);
  check(!promiseHit, "no outcome promises in says", promiseHit || "clean");
  check(!PLACEHOLDER_PATTERN.test(allSayText) && !PLACEHOLDER_PATTERN.test(cockpitText), "no fee placeholders", "fee rides as a real number");
  if (dncTurnIndex >= 0) {
    const badReopen = saysAfterDnc.filter((s) => !/confirm|remove|list|apolog|understood|respect/i.test(String(s.try || ""))).length;
    check(saysAfterDnc.length === 0 || badReopen === 0, "DNC terminal (no reopen sell)",
      `${saysAfterDnc.length} say(s) after the DNC turn, ${badReopen} non-compliant`);
  }

  const cost = usageCost(c.usage.strategist, PRICE.sonnet) + usageCost(c.usage.coach, PRICE.haiku);
  return { name, checks, counters: c, says, cost };
}

async function main() {
  const found = loadKey();
  if (!found) {
    console.error("no anthropic key found (checked two-station/solo/general env names) — cannot run");
    process.exit(2);
  }
  console.log(`key source: ${found.name}`);
  const transports = createTwoStationTransports({
    logger: { info: () => {}, warn: () => {} },
    env: { ...process.env, LIVE_COACH_SOLO_ANTHROPIC_API_KEY: found.key },
  });
  if (!transports.runStrategist) {
    console.error("transports dormant — key rejected?");
    process.exit(2);
  }

  const names = onlyFixture
    ? [`fixture-${onlyFixture.replace(/^fixture-/, "")}`]
    : runAll
      ? fs.readdirSync(__dirname).filter((f) => /^fixture-.*\.js$/.test(f)).map((f) => f.replace(/\.js$/, "")).sort()
      : CORE;

  let totalCost = 0;
  let failed = 0;
  for (const name of names) {
    console.log(`\n■ ${name}`);
    const r = await runFixture(name, transports);
    totalCost += r.cost;
    for (const chk of r.checks) {
      console.log(`  ${chk.ok ? "PASS" : "FAIL"}  ${chk.label} — ${chk.detail}`);
      if (!chk.ok) failed += 1;
    }
    const c = r.counters;
    console.log(`  · B ${c.bRegrounds}x (${c.bHolds} hold)  A ${c.aFires} fired / ${c.aHolds} held / ${c.aDupes} dup  turns ${c.turnsCommitted} subst / ${c.turnsDropped} dropped  ~$${r.cost.toFixed(4)}`);
    for (const s of r.says) console.log(`    say> ${String(s.try).slice(0, 220)}`);
  }
  console.log(`\nTOTAL ~$${totalCost.toFixed(4)} · ${failed === 0 ? "ALL DOCTRINE CHECKS PASS ✅" : `${failed} CHECK(S) FAILED ❌`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`run-two-station failed: ${err.message}`);
  process.exit(1);
});
