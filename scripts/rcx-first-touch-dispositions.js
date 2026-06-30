"use strict";

// Provision minimal native RingCX dispositions for First Touch campaigns.
//
// Dry-run by default. Use --apply to create/update live campaigns.
//
// Shape:
//   - Auto Dispo: fast non-contact/close/default disposition.
//   - VM DROP: same literal name in every per-agent First Touch campaign,
//     but forwarded to that agent's voicemail-drop number.

const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { createRingcxVoiceClient } = require("../packages/shared-integrations/src/ringcxVoiceClient");

const FIRST_TOUCH_CAMPAIGNS = Object.freeze([
  { key: "brad", label: "Brad", dialGroupId: 1067, campaignId: 2827, vmXferDest: "2132797810" },
  { key: "bruce", label: "Bruce", dialGroupId: 1012, campaignId: 2828, vmXferDest: "2137843567" },
  { key: "chris", label: "Chris", dialGroupId: 1068, campaignId: 2829, vmXferDest: "8182644826" },
  { key: "phil", label: "Phil", dialGroupId: 1014, campaignId: 2830, vmXferDest: "2133353006" },
  { key: "sean", label: "Sean", dialGroupId: 1011, campaignId: 2831, vmXferDest: "4242071310" },
]);

function hasFlag(argv, name) {
  return argv.includes(name);
}

function readMultiFlag(argv, name) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith(`${name}=`)) {
      values.push(arg.slice(name.length + 1));
    } else if (arg === name && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      values.push(argv[i + 1]);
      i += 1;
    }
  }
  return values.flatMap((value) => String(value || "").split(",")).map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function logHeader(value) {
  console.log(`\n== ${value} ==`);
}

function logKv(key, value) {
  console.log(`  ${String(key).padEnd(24)} ${value == null || value === "" ? "-" : value}`);
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function dispositionName(row) {
  return String(row?.disposition || row?.name || row?.description || "").trim();
}

function dispositionId(row) {
  return row?.dispositionId || row?.campaignDispositionId || row?.id || "";
}

function baseDispositionPayload(name) {
  return {
    disposition: name,
    isRequeued: 0,
    requeueDelay: 120,
    requeueDelayDuration: "MINUTES",
    isSuccess: false,
    isContact: false,
    doNotCall: false,
    dncTagLabel: "GLOBAL",
    createCopy: false,
    setAgentFlag: false,
    emailDestinations: null,
    mergeOriginal: false,
    requireNote: false,
    saveSurvey: true,
    isDisabled: false,
    termMessage: null,
    contactForwarding: 0,
    excludeAbandon: false,
    dncType: "PHONE",
    isWholeLeadSuppressed: true,
    emailTemplate: null,
    dispSoapService: null,
    destCampaign: null,
    categoryIds: [],
  };
}

function autoDispoPayload() {
  return {
    ...baseDispositionPayload("Auto Dispo"),
    rank: 10,
    isComplete: false,
    dtmfMapping: "0",
    xferDest: null,
    xferDestE164: null,
    xfer: 0,
    isDefault: true,
    timeout: 1,
  };
}

function vmDropPayload(xferDest) {
  return {
    ...baseDispositionPayload("VM DROP"),
    rank: 30,
    isComplete: true,
    dtmfMapping: null,
    xferDest,
    xferDestE164: null,
    xfer: 2,
    isDefault: false,
    timeout: 1,
  };
}

function defaultDisabledPayload(row) {
  return {
    ...row,
    isDisabled: true,
    isDefault: false,
  };
}

function summarize(row) {
  return {
    id: dispositionId(row),
    disposition: dispositionName(row),
    isDefault: Boolean(row?.isDefault),
    isDisabled: Boolean(row?.isDisabled),
    timeout: row?.timeout,
    rank: row?.rank,
    xfer: row?.xfer,
    xferDest: row?.xferDest || null,
  };
}

function pickTargets(argv) {
  const requested = readMultiFlag(argv, "--agent");
  if (!requested.length) return FIRST_TOUCH_CAMPAIGNS;
  const wanted = new Set(requested);
  return FIRST_TOUCH_CAMPAIGNS.filter((row) => wanted.has(row.key) || wanted.has(row.label.toLowerCase()));
}

async function ensureDisposition(client, target, rows, desired, { apply }) {
  const hit = rows.find((row) => normalizeName(dispositionName(row)) === normalizeName(desired.disposition));
  if (!hit) {
    logKv(`create ${desired.disposition}`, JSON.stringify({
      rank: desired.rank,
      isDefault: desired.isDefault,
      timeout: desired.timeout,
      xfer: desired.xfer,
      xferDest: desired.xferDest || null,
    }));
    if (!apply) return null;
    return client.createCampaignDisposition(target.campaignId, desired, target.dialGroupId);
  }

  const needsPatch =
    Boolean(hit.isDisabled) !== Boolean(desired.isDisabled)
    || Boolean(hit.isDefault) !== Boolean(desired.isDefault)
    || Number(hit.timeout) !== Number(desired.timeout)
    || Number(hit.rank) !== Number(desired.rank)
    || Number(hit.xfer || 0) !== Number(desired.xfer || 0)
    || String(hit.xferDest || "") !== String(desired.xferDest || "");

  if (!needsPatch) {
    logKv(`ok ${desired.disposition}`, JSON.stringify(summarize(hit)));
    return hit;
  }

  logKv(`patch ${desired.disposition}`, JSON.stringify({
    before: summarize(hit),
    after: {
      disposition: desired.disposition,
      rank: desired.rank,
      isDefault: desired.isDefault,
      isDisabled: desired.isDisabled,
      timeout: desired.timeout,
      xfer: desired.xfer,
      xferDest: desired.xferDest || null,
    },
  }));
  if (!apply) return hit;
  return client.updateCampaignDisposition(
    target.campaignId,
    dispositionId(hit),
    { ...hit, ...desired },
    target.dialGroupId,
  );
}

async function disableDefaultIfNeeded(client, target, rows, { apply }) {
  const hit = rows.find((row) => normalizeName(dispositionName(row)) === "default");
  if (!hit) return null;
  if (hit.isDisabled === true && hit.isDefault !== true) {
    logKv("ok Default", JSON.stringify(summarize(hit)));
    return hit;
  }
  logKv("patch Default", JSON.stringify({ before: summarize(hit), after: { isDisabled: true, isDefault: false } }));
  if (!apply) return hit;
  return client.updateCampaignDisposition(
    target.campaignId,
    dispositionId(hit),
    defaultDisabledPayload(hit),
    target.dialGroupId,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = hasFlag(argv, "--apply");
  const targets = pickTargets(argv);
  if (!targets.length) throw new Error("No targets selected.");

  const client = createRingcxVoiceClient();
  const who = await client.auth.whoami();

  logHeader("Auth");
  logKv("auth user", who.rcUser?.email || "(unknown)");
  logKv("account id", who.accountId);
  logKv("mode", apply ? "APPLY" : "DRY RUN");

  for (const target of targets) {
    logHeader(`${target.label} First Touch`);
    logKv("dial group", target.dialGroupId);
    logKv("campaign", target.campaignId);
    logKv("vm target", target.vmXferDest);

    let rows = await client.listCampaignDispositions(target.campaignId, target.dialGroupId);
    await ensureDisposition(client, target, rows, autoDispoPayload(), { apply });

    rows = apply ? await client.listCampaignDispositions(target.campaignId, target.dialGroupId) : rows;
    await ensureDisposition(client, target, rows, vmDropPayload(target.vmXferDest), { apply });

    rows = apply ? await client.listCampaignDispositions(target.campaignId, target.dialGroupId) : rows;
    await disableDefaultIfNeeded(client, target, rows, { apply });
  }

  if (apply) {
    logHeader("Verification");
    for (const target of targets) {
      const rows = await client.listCampaignDispositions(target.campaignId, target.dialGroupId);
      const compact = rows
        .filter((row) => ["default", "auto dispo", "vm drop"].includes(normalizeName(dispositionName(row))))
        .map(summarize);
      logKv(target.label, JSON.stringify(compact));
    }
  }
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exitCode = 1;
});
