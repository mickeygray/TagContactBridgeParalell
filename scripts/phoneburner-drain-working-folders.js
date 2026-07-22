#!/usr/bin/env node
"use strict";

// Destructive, explicit cutover helper. It empties only the enabled agents'
// configured PhoneBurner distribution/receiving folders. It never prints
// folder IDs, contact IDs, lead data, credentials, or provider payloads.

const fs = require("node:fs");
const path = require("node:path");

const APPLY_ACK = "EMPTY-ENABLED-PHONEBURNER-WORKING-FOLDERS";
const DEFAULT_DELAY_MS = 350;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function parseArgs(argv = process.argv.slice(2)) {
  const apply = argv.includes("--apply");
  const ackArg = argv.find((value) => String(value).startsWith("--ack="));
  const delayArg = argv.find((value) => String(value).startsWith("--delay-ms="));
  const delayMs = delayArg ? Number(delayArg.slice("--delay-ms=".length)) : DEFAULT_DELAY_MS;
  if (!Number.isSafeInteger(delayMs) || delayMs < 100 || delayMs > 10_000) throw new Error("delay-invalid");
  if (apply && ackArg?.slice("--ack=".length) !== APPLY_ACK) throw new Error("apply-ack-required");
  return { apply, delayMs };
}

async function main() {
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });
  const options = parseArgs();
  const { createPhoneBurnerClient, createPhoneBurnerEnvironmentCredentialStore } = require("../packages/shared-integrations/src");
  const { validateLeadDeliveryConfiguration } = require("../packages/shared-services/src/leadDeliveryService");
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "config", "lead-delivery-agents.json"), "utf8"));
  const validation = validateLeadDeliveryConfiguration(config);
  if (!validation.valid) throw new Error("configuration-invalid");
  const agents = Object.entries(config.agents).filter(([, agent]) => agent.enabled === true);
  const folderRows = agents.flatMap(([agentId, agent]) => [
    { agentId, role: "distribution", folderId: agent.distributionFolderId },
    { agentId, role: "receiving", folderId: agent.receivingFolderId },
  ]);
  const client = createPhoneBurnerClient({
    credentialStore: createPhoneBurnerEnvironmentCredentialStore(),
  });
  const before = [];
  for (const row of folderRows) {
    const count = await client.getFolderCount(row.folderId);
    if (!count?.ok) throw new Error("folder-count-failed");
    before.push({ agentId: row.agentId, role: row.role, count: count.count });
  }
  if (!options.apply) {
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, total: before.reduce((sum, row) => sum + row.count, 0), folders: before })}\n`);
    return;
  }
  let deleted = 0;
  for (const row of folderRows) {
    while (true) {
      const page = await client.listFolderContacts(row.folderId, { page: 1, pageSize: 100 });
      if (!page?.ok) throw new Error("folder-list-failed");
      if (!page.contacts.length) break;
      for (const contact of page.contacts) {
        let result = await client.deleteContact(contact.contactId);
        if (!result?.ok && Number(result?.httpStatus) === 429) {
          await sleep(60_000);
          result = await client.deleteContact(contact.contactId);
        }
        if (!result?.ok && Number(result?.httpStatus) !== 404) throw new Error("contact-delete-failed");
        deleted += 1;
        if (deleted % 25 === 0) {
          process.stdout.write(`${JSON.stringify({ type: "phoneburner_folder_drain_progress", deleted, total: before.reduce((sum, item) => sum + item.count, 0) })}\n`);
        }
        await sleep(options.delayMs);
      }
    }
  }
  const after = [];
  for (const row of folderRows) {
    const count = await client.getFolderCount(row.folderId);
    if (!count?.ok) throw new Error("folder-count-failed");
    after.push({ agentId: row.agentId, role: row.role, count: count.count });
  }
  const remaining = after.reduce((sum, row) => sum + row.count, 0);
  process.stdout.write(`${JSON.stringify({ ok: remaining === 0, dryRun: false, deleted, remaining, folders: after })}\n`);
  if (remaining !== 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: String(error?.message || "drain-failed").slice(0, 80) })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { APPLY_ACK, DEFAULT_DELAY_MS, parseArgs };
