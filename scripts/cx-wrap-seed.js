"use strict";

// WRAP-UP SEEDER (Mickey's ask, 2026-07-07): inject synthetic ANSWERED calls tied to the
// REAL test case 101617 WYNN, each carrying a full fake dossier (coach summary, interview
// form snapshot, transcript pointer), so the wrap-up bar has real cards to click through
// — DNC / Appointment / ✕ — end to end.
//
// THE GUARD: with CX_CALL_WRAP_QUEUE_ENABLED off, an answered row WITH wrap material would
// fire the LEGACY lane (a real Logics activity write) instead of minting a card. So the
// seeder first flies an INERT CANARY — answered, NO wrap material, synthetic case — which
// is a no-op on the legacy lane (no-call-wrap-material) but mints a card when the flag is
// on. No canary card within ~75s -> ABORT before anything touches 101617.
//
// Every seed queue row is synthetic and pre-completed (stamp-only drain branch): no
// RingCX, no cadence reschedule. The card actions are REAL though — that is the point:
//   [DNC]         -> sets case 101617 status to DNC in Logics + correction row
//   [Appointment] -> books a real appointment for the resolving agent
//   [✕ / expiry]  -> files the (fake) interview activity to case 101617
//
// Usage:
//   node scripts/cx-wrap-seed.js --arm                      -> canary, then seed 3 cards
//   node scripts/cx-wrap-seed.js --arm --count 5            -> seed 5
//   node scripts/cx-wrap-seed.js --arm --agent you@x.com    -> cards for another agent
//   node scripts/cx-wrap-seed.js                            -> dry run
//   node scripts/cx-wrap-seed.js --cleanup <tag>            -> remove a run's leftovers

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CxDialQueue, CxTerminalOutbox, CxCallWrapCard } = require("../packages/shared-models/src");

const args = { arm: false, cleanup: null, count: 3, agent: "mgray@taxadvocategroup.com" };
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key === "--arm") args.arm = true;
  else if (key === "--cleanup") args.cleanup = process.argv[++i] || "missing-tag";
  else if (key === "--count") args.count = Math.max(1, Math.min(10, Number(process.argv[++i]) || 3));
  else if (key === "--agent") args.agent = String(process.argv[++i] || "").trim().toLowerCase();
}

const CASE_ID = 101617;
const DOMAIN = "WYNN";
const CANARY_WAIT_MS = 75_000;
const SEED_WAIT_MS = 90_000;
const POLL_MS = 5_000;

function line(msg) { console.log(msg); }

const FAKE_PEOPLE = [
  { name: "SEED Morgan Whitfield", phone: "8185550171", debt: "$24,300", years: "2021-2023", summary: "Prospect answered on the second ring. Self-employed contractor, three unfiled years, IRS letters started arriving last month (CP59). Engaged well, asked about penalty abatement twice — real urgency around a levy warning his bank mentioned. Wants a callback after 3pm tomorrow; spouse handles the finances and needs to be on the call." },
  { name: "SEED Alvin Corrado", phone: "8185550172", debt: "$61,900", years: "2019-2024", summary: "Long conversation. W-2 plus rental income, six years behind after a divorce. Received a CP504 (intent to levy). Very anxious, price-sensitive, mentioned a competitor quote. Agreed the debt grows ~$40/day in penalties. Strong close candidate if we lead with the levy timeline; asked specifically about installment agreements vs OIC — steered to resolution review per policy." },
  { name: "SEED Priya Ramachandran", phone: "8185550173", debt: "$13,750", years: "2022", summary: "Short but genuine pickup. Single unfiled year from an equity sale, got a CP2000 mismatch notice. Skeptical of 'tax relief' calls, softened after the transcript-of-record explanation. Requested the field-manual style breakdown by email; gatekeeper energy but she is the decision maker. Books cleanly if offered a same-week evening slot." },
  { name: "SEED Dexter Aldana", phone: "8185550174", debt: "$88,200", years: "2018-2023", summary: "Business owner, payroll trust-fund exposure (941s), the serious kind. Answered while driving, gave eight solid minutes. Two revenue-officer voicemails already — needs representation letter language fast. Flagged as a high-value resolution case; do NOT let this one ride cadence, wants a partner-level callback." },
  { name: "SEED Lupe Ferreira", phone: "8185550175", debt: "$7,400", years: "2023", summary: "Polite, brief, real. Small balance from gig income, panicked by a CP14. Could self-serve with a payment plan but wants hand-holding; low ticket, high close probability. Asked to text her the appointment details — vm-text candidate when that lane opens." },
];

function fakeDossier(i, tag) {
  const person = FAKE_PEOPLE[i % FAKE_PEOPLE.length];
  return {
    person,
    coachSessionId: `seed-coach-${tag}-${i + 1}`,
    callSummary: person.summary,
    formSnapshot: {
      firstName: person.name.split(" ")[1],
      lastName: person.name.split(" ").slice(2).join(" "),
      phone: person.phone,
      email: `${person.name.split(" ")[1].toLowerCase()}@example-prospect.test`,
      state: "CA",
      estimatedTaxDebt: person.debt,
      unfiledYears: person.years,
      filingStatus: i % 2 ? "married-joint" : "single",
      irsNoticesReceived: i % 2 ? "CP504" : "CP59",
      bestCallbackWindow: "after 3pm PT",
      notes: `Synthetic wrap-seed dossier (tag ${tag}). ${person.summary.slice(0, 120)}...`,
    },
    interviewSnapshotWorkflowId: `seed-interview-${tag}-${i + 1}`,
    transcriptArtifactPath: `seed/wrap-seed/${tag}/transcript-${i + 1}.txt`,
    durationSec: 180 + i * 95,
  };
}

async function cleanup(tag) {
  const outbox = await CxTerminalOutbox.deleteMany({ idemKey: new RegExp(`^wrapseed:${tag}:`) });
  const rows = await CxDialQueue.deleteMany({ "metadata.wrapSeedTag": tag });
  const cards = await CxCallWrapCard.deleteMany({ idemKey: new RegExp(`^wrapseed:${tag}:`) });
  line(`cleanup tag=${tag}: outbox=${outbox.deletedCount}, queue rows=${rows.deletedCount}, cards=${cards.deletedCount}`);
}

async function waitForCards(regex, want, timeoutMs) {
  const startedAt = Date.now();
  for (;;) {
    const cards = await CxCallWrapCard.find({ idemKey: regex }).lean();
    if (cards.length >= want) return cards;
    if (Date.now() - startedAt > timeoutMs) return cards;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function injectAnswered({ tag, key, caseId, uii, payloadExtra }) {
  const row = await CxDialQueue.create({
    domain: DOMAIN,
    caseId,
    phone: null,
    state: "completed", // stamp-only drain branch — no cadence, no RingCX
    releaseAt: new Date(),
    metadata: { wrapSeedTag: tag, drill: true },
  });
  const idemKey = `wrapseed:${tag}:${key}`;
  await CxTerminalOutbox.create({
    idemKey,
    sessionId: `wrapseed-${tag}`,
    queueItemId: String(row._id),
    uii,
    agentEmail: args.agent,
    outcome: "answered",
    status: "pending",
    attempts: 0,
    payload: {
      queueItemId: String(row._id),
      domain: DOMAIN,
      caseId,
      uii,
      agentEmail: args.agent,
      outcome: "answered",
      eventType: "terminal",
      systemDisposition: "ANSWER",
      sourceService: "cx-bulk-load",
      source: "wrap-seed",
      at: new Date().toISOString(),
      ...payloadExtra,
    },
  });
  return idemKey;
}

async function main() {
  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  try {
    if (args.cleanup) return void (await cleanup(args.cleanup));

    const tag = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    line(`WRAP-UP SEEDER tag=${tag} — ${args.count} answered call(s) -> case ${CASE_ID} ${DOMAIN}, cards for ${args.agent}`);
    if (!args.arm) {
      line("\nDRY RUN. --arm flies the canary first; if the wrap flag is off in the running");
      line("process it ABORTS before anything touches 101617. Post-ceremony it seeds the cards.");
      return;
    }

    // ---- THE CANARY: answered, NO wrap material, synthetic case. Flag off = fully inert. ----
    line("\ncanary: answered + no wrap material + synthetic case (inert on the legacy lane)...");
    await injectAnswered({ tag, key: "canary", caseId: 999920, uii: `WRAPSEED${tag}CANARY`, payloadExtra: { name: "SEED Canary" } });
    const canaryCards = await waitForCards(new RegExp(`^wrapseed:${tag}:canary$`), 1, CANARY_WAIT_MS);
    if (!canaryCards.length) {
      line("\nABORT — no canary card minted: CX_CALL_WRAP_QUEUE_ENABLED is OFF in the running");
      line("process. Nothing was sent near case 101617 (the canary is inert by design).");
      line("Do the ceremony (flags + restart + client rebuild), then re-run this seeder.");
      line(`Removing canary artifacts...`);
      await cleanup(tag);
      return;
    }
    line("canary card minted — wrap queue is LIVE. Seeding the real cards...");

    // ---- THE SEEDS: full fake dossiers against the real test case ----
    for (let i = 0; i < args.count; i += 1) {
      const dossier = fakeDossier(i, tag);
      const idemKey = await injectAnswered({
        tag,
        key: `card${i + 1}`,
        caseId: CASE_ID,
        uii: `WRAPSEED${tag}C${i + 1}`,
        payloadExtra: {
          name: dossier.person.name,
          phone: dossier.person.phone,
          durationSec: dossier.durationSec,
          coachSessionId: dossier.coachSessionId,
          callSummary: dossier.callSummary,
          formSnapshot: dossier.formSnapshot,
          interviewSnapshotWorkflowId: dossier.interviewSnapshotWorkflowId,
          transcriptArtifactPath: dossier.transcriptArtifactPath,
        },
      });
      line(`injected ${idemKey} (${dossier.person.name}, ${dossier.person.debt})`);
    }

    const seedRegex = new RegExp(`^wrapseed:${tag}:card`);
    const cards = await waitForCards(seedRegex, args.count, SEED_WAIT_MS);

    // Self-grading.
    const verdicts = [
      [`${args.count} cards minted`, cards.length === args.count],
      ["all pending", cards.every((c) => c.status === "pending")],
      [`all for ${args.agent}`, cards.every((c) => c.agentEmail === args.agent)],
      [`all tied to case ${CASE_ID}`, cards.every((c) => Number(c.caseId) === CASE_ID)],
      ["all carry systemDisposition=ANSWER", cards.every((c) => c.systemDisposition === "ANSWER")],
      ["all carry the coach summary", cards.every((c) => String(c.coachSummary || "").length > 50)],
      ["all carry the form snapshot", cards.every((c) => c.formSnapshot && c.formSnapshot.estimatedTaxDebt)],
      ["2h expiry clock set", cards.every((c) => c.expiresAt && (new Date(c.expiresAt).getTime() - Date.now()) > 90 * 60 * 1000)],
    ];
    line("\nVERDICT:");
    let pass = true;
    for (const [label, ok] of verdicts) {
      line(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
      if (!ok) pass = false;
    }

    // The canary card is clutter — remove it, keep the real seeds for clicking.
    await CxCallWrapCard.deleteMany({ idemKey: `wrapseed:${tag}:canary` });
    await CxTerminalOutbox.deleteMany({ idemKey: `wrapseed:${tag}:canary` });
    await CxDialQueue.deleteMany({ "metadata.wrapSeedTag": tag, caseId: 999920 });
    line("\ncanary artifacts removed; the seed cards are LIVE in the wrap bar.");

    line(pass ? `
READY — refresh the CX workspace: the wrap bar should show ${args.count} card(s) for ${args.agent}.
Click through them. REMEMBER, the buttons are REAL:
  [DNC]         sets case ${CASE_ID} to DNC in Logics + files the correction row
  [Appointment] books a real appointment for the resolving agent
  [✕]           files the (fake) interview activity to case ${CASE_ID}
Unclicked cards expire in 2h (janitor) and file their interview activities then.
Leftover cleanup any time: node scripts/cx-wrap-seed.js --cleanup ${tag}`
      : `\nFAILURES — capture this output. Artifacts kept under tag ${tag} (cleanup with --cleanup ${tag}).`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
