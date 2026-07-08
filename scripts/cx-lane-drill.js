"use strict";

require("dotenv").config();

// LANE DRILL (Mickey's ask, 2026-07-08): send a synthetic Mickey through EACH lane —
// a "new lead" to his First Touch campaign and an appointment to his Appointment
// campaign — and self-grade the dispatch chain end to end:
//
//   first-touch:  drill queue row (firstTouchPending) -> the LIVE drip dispatcher claims,
//                 publishes IMMEDIATE to the mapped campaign -> firstTouchDispatch stamp
//                 -> Mickey's phone rings when he's on the campaign.
//   appointment:  drill CxAppointment (due in ~90s) -> the LIVE clock dispatcher claims,
//                 publishes at the moment -> rcxDispatch stamp -> phone rings on time.
//
// PREREQS (the drill preflights and tells you exactly what's missing):
//   - Mickey's test campaigns exist (create in console, e.g. "Mickey First Touch" /
//     "Mickey Appointment" under his dial group; re-run scripts/cx-campaign-map.js to
//     get the ids) and mgray@ is in BOTH maps in .env
//   - CX_FIRST_TOUCH_ENABLED=true / CX_APPT_LANE_ENABLED=true + ParallelControlPlane restarted
//
// Usage:
//   node scripts/cx-lane-drill.js --first-touch --phone 8185551234 --arm
//   node scripts/cx-lane-drill.js --appointment --phone 8185551234 --in-minutes 2 --arm
//   node scripts/cx-lane-drill.js --interrupt --phone 8185551234 --gap-seconds 60 --arm
//       THE INTERRUPT TEST: work a NORMAL bulk queue as the baseline; first-touch cuts
//       in now, the appointment ~1 gap later — the interruption feel, under load.
//   node scripts/cx-lane-drill.js --cleanup <tag>
//
// SAFETY: drill-tagged synthetic rows (case 101617 WYNN — the known test case), zero
// Logics writes, zero intake side effects (we inject at the MINT layer, not through the
// 4001 route — the real intake creates cases/sends mail and is not drill material).
// RingCX copies land in MICKEY'S OWN test campaigns only; note they stay until dialed
// or cleared in console.

const mongoose = require("mongoose");
const crypto = require("crypto");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CxDialQueue, CxAppointment } = require("../packages/shared-models/src");
const { parseAgentQueueMap } = require("../packages/shared-services/src/cxLaneRegistry");

const AGENT = "mgray@taxadvocategroup.com";
const FIRST_TOUCH_CASE_ID = 101617;
const APPOINTMENT_CASE_ID = 101618;
const DOMAIN = "WYNN";
const WATCH_TIMEOUT_MS = 4 * 60 * 1000;
const POLL_MS = 5000;

const args = { firstTouch: false, appointment: false, arm: false, cleanup: null, phone: null, inMinutes: 2, gapSeconds: 60, interrupt: false };
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key === "--first-touch") args.firstTouch = true;
  else if (key === "--appointment") args.appointment = true;
  else if (key === "--interrupt") { args.firstTouch = true; args.appointment = true; args.interrupt = true; }
  else if (key === "--gap-seconds") args.gapSeconds = Math.max(30, Number(process.argv[++i]) || 60);
  else if (key === "--arm") args.arm = true;
  else if (key === "--phone") args.phone = String(process.argv[++i] || "").replace(/\D/g, "");
  else if (key === "--in-minutes") args.inMinutes = Math.max(1, Number(process.argv[++i]) || 2);
  else if (key === "--cleanup") args.cleanup = process.argv[++i] || "missing-tag";
}

function line(msg) { console.log(msg); }

function preflight() {
  const problems = [];
  const ftOn = String(process.env.CX_FIRST_TOUCH_ENABLED || "false").toLowerCase() === "true";
  const aptOn = String(process.env.CX_APPT_LANE_ENABLED || "false").toLowerCase() === "true";
  const ftMap = parseAgentQueueMap(process.env.CX_FIRST_TOUCH_QUEUE_MAP);
  const aptMap = parseAgentQueueMap(process.env.CX_APPT_QUEUE_MAP);
  const ftMe = ftMap.find((a) => a.agentEmail === AGENT);
  const aptMe = aptMap.find((a) => a.agentEmail === AGENT);
  const ftOthers = ftMap.filter((a) => a.agentEmail !== AGENT).map((a) => a.agentEmail);
  const aptOthers = aptMap.filter((a) => a.agentEmail !== AGENT).map((a) => a.agentEmail);
  if (args.firstTouch) {
    if (!ftOn) problems.push("CX_FIRST_TOUCH_ENABLED is not true in .env (flip + restart)");
    if (!ftMe) problems.push(`${AGENT} missing from CX_FIRST_TOUCH_QUEUE_MAP (create 'Mickey First Touch' in console, re-run scripts/cx-campaign-map.js, add the id)`);
    if (ftOthers.length) problems.push(`CX_FIRST_TOUCH_QUEUE_MAP must be Mickey-only for this drill; remove: ${ftOthers.join(", ")}`);
  }
  if (args.appointment) {
    if (!aptOn) problems.push("CX_APPT_LANE_ENABLED is not true in .env (flip + restart)");
    if (!aptMe) problems.push(`${AGENT} missing from CX_APPT_QUEUE_MAP (create 'Mickey Appointment' in console, re-run scripts/cx-campaign-map.js, add the id)`);
    if (aptOthers.length) problems.push(`CX_APPT_QUEUE_MAP must be Mickey-only for this drill; remove: ${aptOthers.join(", ")}`);
  }
  if (!args.phone || args.phone.length < 10) problems.push("--phone <your cell> is required (the lead RingCX will dial)");
  return { problems, ftCampaign: ftMe?.campaignId || null, aptCampaign: aptMe?.campaignId || null };
}

async function cleanup(tag) {
  const rows = await CxDialQueue.deleteMany({ "metadata.laneDrillTag": tag });
  const appts = await CxAppointment.deleteMany({ appointmentId: new RegExp(`^lanedrill-${tag}`) });
  line(`cleanup tag=${tag}: queue rows=${rows.deletedCount}, appointments=${appts.deletedCount}`);
  line("NOTE: any copies already published into the test campaigns stay until dialed or cleared in console.");
}

async function watchFirstTouch(rowId) {
  const startedAt = Date.now();
  for (;;) {
    const row = await CxDialQueue.findById(rowId).lean();
    const dispatch = row?.metadata?.firstTouchDispatch;
    if (dispatch?.dispatchedAt) return { ok: true, dispatch };
    if (Date.now() - startedAt > WATCH_TIMEOUT_MS) return { ok: false, row };
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function watchAppointment(appointmentId, dueAtMs) {
  const startedAt = Date.now();
  for (;;) {
    const appt = await CxAppointment.findOne({ appointmentId }).lean();
    const dispatch = appt?.rcxDispatch;
    if (dispatch?.dispatchedAt) {
      const skewSec = Math.round((new Date(dispatch.dispatchedAt).getTime() - dueAtMs) / 1000);
      return { ok: true, dispatch, skewSec };
    }
    if (Date.now() - startedAt > WATCH_TIMEOUT_MS + args.inMinutes * 60_000) return { ok: false, appt };
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function main() {
  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  try {
    if (args.cleanup) return void (await cleanup(args.cleanup));
    if (!args.firstTouch && !args.appointment) {
      line("pick a lane: --first-touch and/or --appointment (plus --phone <cell> --arm)");
      return;
    }
    const { problems, ftCampaign, aptCampaign } = preflight();
    const tag = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  line(`LANE DRILL tag=${tag} agent=${AGENT} firstTouchCase=${FIRST_TOUCH_CASE_ID} appointmentCase=${APPOINTMENT_CASE_ID}`);
    if (problems.length) {
      line("\nNOT READY — the drill is built to this boundary; finish these and re-run:");
      for (const p of problems) line(`  - ${p}`);
      return;
    }
    if (!args.arm) {
      line("\nDRY RUN. Prereqs all green:");
      if (args.firstTouch) line(`  first-touch -> campaign ${ftCampaign}`);
      if (args.appointment) {
        const approx = args.interrupt ? `${Math.round((45 + args.gapSeconds) / 60)}min after arm` : `~${args.inMinutes}min`;
        line(`  appointment -> campaign ${aptCampaign} (fires in ${approx})`);
      }
      if (args.interrupt) {
        line("");
        line("THE INTERRUPT RUNBOOK:");
        line("  1. Build a small NORMAL queue in the workspace (5 test leads) and start dialing.");
        line("  2. Re-run this command with --arm while mid-queue.");
        line(`  3. Expect: first-touch rings within ~30-60s; the appointment fires ~${args.gapSeconds}s after it.`);
        line("  4. The workspace polls the lane modal source; modal should appear only after UII exists.");
        line("     Bulk ignores foreign externs by design, so there should be no ghost interference.");
      } else {
        line("Re-run with --arm. Log into the campaign(s) in RingCX so the dial reaches you.");
      }
      return;
    }

    const verdicts = [];

    if (args.firstTouch) {
      const row = await CxDialQueue.create({
        domain: DOMAIN,
        caseId: FIRST_TOUCH_CASE_ID,
        phone: args.phone,
        name: `LANE DRILL First Touch ${tag}`,
        state: "ready",
        releaseAt: new Date(),
        queueFamily: "fresh-day1",
        metadata: {
          laneDrillTag: tag,
          drill: true,
          firstTouchPending: true,
          firstTouchDispatch: null,
        },
      });
      line(`\n[first-touch] drill row ${row._id} minted (firstTouchPending, phone ***${args.phone.slice(-4)})`);
      line("[first-touch] waiting on the LIVE drip dispatcher (15s ticks)...");
      const result = await watchFirstTouch(row._id);
      verdicts.push(["first-touch dispatched by the live drip", result.ok]);
      if (result.ok) {
        verdicts.push(["  -> published to Mickey's mapped campaign", String(result.dispatch.campaignId) === String(ftCampaign)]);
        verdicts.push(["  -> cxft extern id", String(result.dispatch.externId || "").startsWith("cxft-")]);
        line(`[first-touch] DISPATCHED -> campaign ${result.dispatch.campaignId}, extern ${result.dispatch.externId}`);
        line("[first-touch] ANSWER YOUR PHONE when RingCX dials (be logged into the campaign).");
      } else {
        line(`[first-touch] TIMEOUT — dispatcher never claimed it. Check the flag/restart and cx.alpha.firsttouch.* in the log. Row state: ${JSON.stringify(result.row?.metadata?.firstTouchDispatch)}`);
      }
    }

    if (args.appointment) {
      // interrupt mode: the appointment lands one GAP after the first-touch ring window
      const dueMs = args.interrupt
        ? Date.now() + 45_000 + args.gapSeconds * 1000 // ~45s ft dispatch+dial, then the gap
        : Date.now() + args.inMinutes * 60_000;
      const dueAt = new Date(dueMs);
      const appointmentId = `lanedrill-${tag}-${crypto.randomUUID().slice(0, 8)}`;
      await CxAppointment.create({
        appointmentId,
        domain: DOMAIN,
        caseId: APPOINTMENT_CASE_ID,
        agentExtensionId: "drill",
        agentEmail: AGENT,
        prospectName: `LANE DRILL Appointment ${tag}`,
        phone: args.phone,
        appointmentAt: dueAt,
        legalDialAt: dueAt,
        status: "scheduled",
        rcxDispatch: null,
      });
      line(`\n[appointment] drill appointment ${appointmentId} booked for ${dueAt.toISOString()} (~${args.inMinutes}min out)`);
      line("[appointment] waiting on the LIVE clock dispatcher (30s ticks) — it must NOT fire early...");
      const result = await watchAppointment(appointmentId, dueAt.getTime());
      verdicts.push(["appointment dispatched by the live clock", result.ok]);
      if (result.ok) {
        verdicts.push(["  -> published to Mickey's mapped campaign", String(result.dispatch.campaignId) === String(aptCampaign)]);
        verdicts.push(["  -> cxapt extern id (the CxApt key)", String(result.dispatch.externId || "").startsWith("cxapt-")]);
        verdicts.push([`  -> fired AT the moment (skew ${result.skewSec}s, tolerance -5..+45s)`, result.skewSec >= -5 && result.skewSec <= 45]);
        line(`[appointment] DISPATCHED at skew ${result.skewSec}s -> campaign ${result.dispatch.campaignId}, extern ${result.dispatch.externId}`);
        line("[appointment] ANSWER YOUR PHONE — this ring IS the 4:30-fires-at-4:30 proof.");
      } else {
        line(`[appointment] TIMEOUT — check CX_APPT_LANE_ENABLED/restart and cx.alpha.appt.* in the log. Doc: ${JSON.stringify(result.appt?.rcxDispatch)}`);
      }
    }

    line("\nVERDICT:");
    let pass = true;
    for (const [label, ok] of verdicts) {
      line(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
      if (!ok) pass = false;
    }
    line(pass
      ? `\nDISPATCH BOUNDARY PROVEN. Cleanup: node scripts/cx-lane-drill.js --cleanup ${tag}`
      : `\nFAILURES — artifacts kept under tag ${tag} (cleanup with --cleanup ${tag}).`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
