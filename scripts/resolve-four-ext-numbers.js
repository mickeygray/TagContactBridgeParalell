"use strict";

require("dotenv").config();

const { createRingCentralClient } = require("../packages/shared-integrations/src");

const TARGETS = [
  "ballen@taxadvocategroup.com",
  "polson@taxadvocategroup.com",
  "acalloway@taxadvocategroup.com",
  "slucas@taxadvocategroup.com",
];

function norm(e) { return String(e || "").trim().toLowerCase(); }

async function main() {
  const rc = createRingCentralClient();
  await rc.reinitializePlatform({ force: false, reason: "resolve-ext" });
  const payload = await rc.listExtensions();
  const records = Array.isArray(payload.records) ? payload.records : [];

  const set = new Set(TARGETS.map(norm));
  const hits = records.filter(
    (r) => r.type === "User" && set.has(norm(r?.contact?.email)),
  );

  for (const r of hits) {
    console.log(JSON.stringify({
      email: r.contact.email,
      id: r.id,
      extensionNumber: r.extensionNumber,
      name: r.name,
      status: r.status,
    }));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
