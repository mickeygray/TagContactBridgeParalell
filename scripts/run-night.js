"use strict";

// THE NIGHT — manual runner. A thin CLI over `runNightPass`, the exact same
// callable the scheduled nightBoardRuntime uses, so what runs by hand and
// what runs automatically can never drift apart.
//
// DRY-RUN BY DEFAULT: no DB writes, no email. Flags opt in.
//
//   node scripts/run-night.js
//   node scripts/run-night.js --date 2026-07-27 --domains TAG,WYNN
//   node scripts/run-night.js --apply --attach --email
//
// EX note: call metadata is read for attribution only; recordings come from
// an allow-list (callrail/phoneburner) — EX can never surface.

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const { connectMongo } = require("../packages/event-core/src");
const { getSharedConfig, ROOT_DIR, getInternalFromEmail } = require("../packages/shared-config/src");
const { runNightPass, pacificDateKey } = require("../packages/shared-services/src/nightPassService");
const { sendMail } = require("../packages/shared-services/src/mailerService");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const money = (n) => `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const dateKey = String(arg("date", pacificDateKey()));
  const domains = String(arg("domains", "TAG,WYNN,AMITY")).toUpperCase()
    .split(",").map((s) => s.trim()).filter(Boolean);
  const apply = process.argv.includes("--apply");
  const attach = process.argv.includes("--attach");
  const email = process.argv.includes("--email");

  console.log(`\n${"═".repeat(64)}`);
  console.log(`  THE NIGHT · ${dateKey} · ${domains.join("+")} · ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`${"═".repeat(64)}\n`);

  await connectMongo(getSharedConfig());

  const logger = { info: (m) => console.log(`  ${m}`), warn: (m, d) => console.log(`  WARN ${m} ${JSON.stringify(d || {}).slice(0, 160)}`) };
  const { night, text, emailData, attachments } = await runNightPass({
    dateKey, domains, apply, attach, logger,
  });

  console.log(`\n${text}\n`);

  // Diagnostics live HERE, not in the email — the board is for readers.
  if (night.review.length) {
    console.log(`── DIAGNOSTICS (${night.review.length}, console only) ──`);
    for (const r of night.review.slice(0, 30)) console.log(`  · ${r}`);
    if (night.review.length > 30) console.log(`  … +${night.review.length - 30} more`);
    console.log("");
  }

  const outDir = path.join(ROOT_DIR, "runtime", "night-run");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `board-${dateKey}.txt`), text);
  fs.writeFileSync(path.join(outDir, `board-${dateKey}.json`), JSON.stringify({ night, emailData }, null, 1));
  console.log(`wrote runtime/night-run/board-${dateKey}.{txt,json}`);

  if (email) {
    const to = String(arg("to", process.env.NIGHT_BOARD_RECIPIENTS || "mgray@taxadvocategroup.com"));
    const fromEmail = getInternalFromEmail();
    // Pin BOTH domain and transportDomain — a falsy domain routes through
    // WYNN's SendGrid key and marketing From address.
    const res = await sendMail("TAG", {
      to,
      subject: `Daily Board ${dateKey} — ${money(night.counters.confirmedAmountToday)} · ${night.lanes.deals.length} deal(s)`,
      template: "nightly/daily-board",
      data: emailData,
      text,
      attachments: attachments || [],
      from: `Parallel Nightly <${fromEmail}>`,
      replyTo: `Parallel Nightly <${fromEmail}>`,
      transportDomain: "TAG",
    });
    console.log(`emailed → ${to} (${(attachments || []).length} attachment(s), messageId ${res?.messageId || "?"})`);
  }

  console.log(`\ntotal ${Math.round((night.durationMs || 0) / 1000)}s\n`);
  process.exit(0);
}

main().catch((error) => { console.error("night run crashed:", error.stack || error.message); process.exit(1); });
