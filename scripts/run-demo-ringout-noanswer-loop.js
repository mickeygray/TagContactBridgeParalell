"use strict";

require("dotenv").config();

const { createRingCentralClient } = require("../packages/shared-integrations/src");

function readArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function hasArg(name) {
  return process.argv.includes(name);
}

function readNumberArg(name, fallback) {
  const value = Number(readArg(name, ""));
  return Number.isFinite(value) ? value : fallback;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return String(value || "").trim();
}

function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "";
}

function splitList(value) {
  return String(value || "")
    .split(/[,\n|]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseTarget(entry, defaultExtensionId) {
  const raw = String(entry || "").trim();
  if (!raw) return null;
  const match = raw.match(/^([^:=\s]+)\s*[:=]\s*(.+)$/);
  const extensionId = match ? String(match[1] || "").trim() : defaultExtensionId;
  const phone = normalizePhone(match ? match[2] : raw);
  if (!phone) return null;
  return {
    extensionId: extensionId || "~",
    phone,
    label: `${extensionId || "~"}:${maskPhone(phone)}`,
  };
}

function readTargets(defaultExtensionId) {
  const rawTargets = readArg("--targets", process.env.DEMO_RINGOUT_NOANSWER_TARGETS || "");
  const rawPhones = readArg("--phones", process.env.DEMO_RINGOUT_NOANSWER_PHONES || "");
  const entries = splitList(rawTargets || rawPhones || process.env.DEMO_RINGOUT_FROM_PHONE || "");
  return entries
    .map((entry) => parseTarget(entry, defaultExtensionId))
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ringOutId(ringout) {
  return ringout?.id || ringout?.uri?.split("/").pop() || null;
}

async function fireTarget(client, target, toPhone, playPrompt) {
  const primary = await client.createRingOut(target.extensionId, {
    fromPhoneNumber: target.phone,
    toPhoneNumber: toPhone,
    playPrompt,
    countryId: "1",
  });
  return {
    target,
    ok: true,
    id: ringOutId(primary),
    response: primary,
  };
}

async function cancelTarget(client, fired) {
  if (!fired?.id) {
    return {
      ok: false,
      skipped: true,
      reason: "missing-ringout-id",
      target: fired?.target || null,
    };
  }
  try {
    const response = await client.deleteRingOut(fired.target.extensionId, fired.id);
    return {
      ok: true,
      id: fired.id,
      target: fired.target,
      response: response || null,
    };
  } catch (error) {
    const status = Number(error.details?.responseStatus || error.status || 0);
    return {
      ok: status === 404,
      id: fired.id,
      target: fired.target,
      alreadyGone: status === 404,
      error: status === 404 ? null : error.message,
      details: status === 404 ? null : error.details || null,
    };
  }
}

async function main() {
  const dryRun = !hasArg("--live");
  const defaultExtensionId = String(readArg("--extension-id", process.env.DEMO_RINGOUT_EXTENSION_ID || "~")).trim() || "~";
  const toPhone = normalizePhone(readArg("--to", process.env.DEMO_RINGOUT_TO_PHONE || ""));
  const count = Math.max(1, readNumberArg("--count", 45));
  const ringSeconds = Math.max(1, readNumberArg("--ring-seconds", 120));
  const pauseSeconds = Math.max(0, readNumberArg("--pause-seconds", 60));
  const playPrompt = hasArg("--play-prompt");
  const targets = readTargets(defaultExtensionId);

  if (!toPhone) throw new Error("--to or DEMO_RINGOUT_TO_PHONE is required");
  if (targets.length === 0) {
    throw new Error("--targets/--phones or DEMO_RINGOUT_NOANSWER_TARGETS is required");
  }

  const plan = {
    ok: true,
    dryRun,
    mode: "ringout-noanswer-loop",
    count,
    ringSeconds,
    pauseSeconds,
    toPhone: maskPhone(toPhone),
    targets: targets.map((target) => ({
      extensionId: target.extensionId,
      phone: maskPhone(target.phone),
    })),
  };
  process.stdout.write(`${JSON.stringify({ event: "plan", ...plan }, null, 2)}\n`);
  if (dryRun) return;

  const client = createRingCentralClient();
  const iterations = [];
  for (let iteration = 1; iteration <= count; iteration += 1) {
    const fired = await Promise.all(targets.map(async (target) => {
      try {
        return await fireTarget(client, target, toPhone, playPrompt);
      } catch (error) {
        return {
          target,
          ok: false,
          error: error.message,
          details: error.details || null,
        };
      }
    }));
    process.stdout.write(`${JSON.stringify({
      event: "fired",
      iteration,
      count,
      fired: fired.map((row) => ({
        target: row.target?.label || null,
        ok: row.ok,
        id: row.id || null,
        error: row.error || null,
      })),
    })}\n`);

    await sleep(ringSeconds * 1000);

    const cancelled = await Promise.all(fired.map((row) => cancelTarget(client, row)));
    const summary = {
      iteration,
      fired: fired.map((row) => ({
        target: row.target?.label || null,
        ok: row.ok,
        id: row.id || null,
        error: row.error || null,
      })),
      cancelled: cancelled.map((row) => ({
        target: row.target?.label || null,
        ok: row.ok,
        id: row.id || null,
        alreadyGone: Boolean(row.alreadyGone),
        error: row.error || null,
      })),
    };
    iterations.push(summary);
    process.stdout.write(`${JSON.stringify({ event: "cancelled", ...summary })}\n`);

    if (iteration < count && pauseSeconds > 0) {
      await sleep(pauseSeconds * 1000);
    }
  }

  process.stdout.write(`${JSON.stringify({
    event: "complete",
    ok: true,
    count,
    completedCount: iterations.length,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
