"use strict";

// Cadence schedule timeline preview.
//
// Builds the legacy cadence schedule for a hypothetical lead arrival
// time and prints what fires when, broken out by channel and relative
// offset from receipt. No DB writes, no sends — pure schedule
// inspection so you can verify the contact rhythm.
//
// Usage:
//   node scripts/preview-cadence-schedule.js
//   node scripts/preview-cadence-schedule.js --at "2026-05-05T16:00:00Z"
//   node scripts/preview-cadence-schedule.js --no-call    # phoneCanCall=false
//   node scripts/preview-cadence-schedule.js --no-text    # phoneCanText=false
//   node scripts/preview-cadence-schedule.js --no-email   # emailCanSend=false

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const {
  createLegacyCadenceSchedule,
} = require("../packages/shared-services/src/cadencePlanService");

function readFlag(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return null;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function fmtMs(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

function fmtPt(date) {
  return date.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function main() {
  const argv = process.argv.slice(2);
  const atRaw = readFlag(argv, "--at");
  const now = atRaw ? new Date(atRaw) : new Date();
  if (Number.isNaN(now.getTime())) {
    console.error("[preview] invalid --at value:", atRaw);
    process.exit(1);
  }

  const validation = {
    phone: { onNationalDNC: false, onStateDNC: false, isLitigator: false, isCell: true },
    phoneValid: true,
    phoneCanCall: !hasFlag(argv, "--no-call"),
    phoneCanText: !hasFlag(argv, "--no-text"),
    phoneIsCell: true,
    emailValid: true,
    emailCanSend: !hasFlag(argv, "--no-email"),
    emailResult: "valid",
  };

  const schedule = createLegacyCadenceSchedule(now, {}, validation);

  console.log(`\n══ Cadence preview ══`);
  console.log(`  receipt time:    ${now.toISOString()}  (PT: ${fmtPt(now)})`);
  console.log(`  validation:      phoneCanText=${validation.phoneCanText}  phoneCanCall=${validation.phoneCanCall}  emailCanSend=${validation.emailCanSend}`);
  console.log(`  plan version:    ${schedule.planVersion}`);
  console.log(`  timezone:        ${schedule.timezone}`);
  console.log(`  totals:          sms=${schedule.timing.smsCount}  email=${schedule.timing.emailCount}  rvm=${schedule.timing.rvmCount}  cx=${schedule.timing.cxCount}`);
  console.log(`  total actions:   ${schedule.actions.length}\n`);

  console.log(`  ${"#".padEnd(4)} ${"key".padEnd(14)} ${"channel".padEnd(7)} ${"type".padEnd(22)} ${"contingent".padEnd(20)} ${"offset".padEnd(7)} scheduledFor (PT)`);
  console.log(`  ${"-".repeat(110)}`);

  schedule.actions.forEach((a, idx) => {
    const sched = new Date(a.scheduledFor);
    const offset = sched.getTime() - now.getTime();
    const offsetLabel = offset < 0 ? `-${fmtMs(-offset)}` : fmtMs(offset);
    const contingent = a.contingentOnActionKey
      ? `${a.contingentOnActionKey}${a.contingencyMode ? ` (${a.contingencyMode})` : ""}`
      : "—";
    console.log(
      `  ${String(idx + 1).padEnd(4)} ${a.key.padEnd(14)} ${a.channel.padEnd(7)} ${a.type.padEnd(22)} ${contingent.padEnd(20)} ${offsetLabel.padEnd(7)} ${fmtPt(sched)}`,
    );
  });

  console.log(`\n══ Day buckets ══`);
  const bucket = new Map();
  for (const a of schedule.actions) {
    const sched = new Date(a.scheduledFor);
    // PT day bucket
    const ptDay = sched.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
    if (!bucket.has(ptDay)) bucket.set(ptDay, []);
    bucket.get(ptDay).push(a);
  }
  for (const [day, actions] of bucket) {
    const counts = actions.reduce((acc, a) => {
      acc[a.channel] = (acc[a.channel] || 0) + 1;
      return acc;
    }, {});
    const summary = Object.entries(counts).map(([c, n]) => `${c}:${n}`).join("  ");
    console.log(`  ${day.padEnd(12)}  ${actions.length} actions  (${summary})`);
  }

  console.log(`\n══ "Reserved-to-workspace" timing (cx channel) ══`);
  const cxActions = schedule.actions.filter((a) => a.channel === "cx");
  for (const a of cxActions) {
    const sched = new Date(a.scheduledFor);
    const offset = sched.getTime() - now.getTime();
    const offsetLabel = offset < 0 ? `-${fmtMs(-offset)}` : fmtMs(offset);
    console.log(`  ${a.key.padEnd(14)} +${offsetLabel.padEnd(7)} ${fmtPt(sched)}`);
  }

  console.log(`\nNext action overall: ${schedule.nextActionType || "(none)"} at ${schedule.nextActionAt ? fmtPt(new Date(schedule.nextActionAt)) : "(n/a)"}`);
}

main();
