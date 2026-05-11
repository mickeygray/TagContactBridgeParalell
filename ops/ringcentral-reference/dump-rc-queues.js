// Run from TagContactBridge root: node dump-rc-queues.js
// Pulls RingCentral queues + their forwarding numbers + IVR routing
// Then cross-references with CallRail trackers if available

require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const axios = require("axios");
const fs = require("fs");

const SERVER =
  process.env.RING_CENTRAL_SERVER || "https://platform.ringcentral.com";

async function getToken() {
  const clientId = process.env.RING_CENTRAL_CLIENT_ID;
  const clientSecret = process.env.RING_CENTRAL_CLIENT_SECRET;
  const jwt = process.env.RING_CENTRAL_JWT_TOKEN;

  if (!jwt || !clientId) {
    console.error(
      "Missing RING_CENTRAL_JWT_TOKEN or RING_CENTRAL_CLIENT_ID in .env",
    );
    process.exit(1);
  }

  const resp = await axios.post(
    `${SERVER}/restapi/oauth/token`,
    new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      auth: { username: clientId, password: clientSecret },
    },
  );
  return resp.data.access_token;
}

async function rcGet(path, token) {
  const resp = await axios.get(`${SERVER}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return resp.data;
}

(async () => {
  const token = await getToken();
  console.log("Fetching RingCentral data...\n");

  // ── All extensions ──
  const extData = await rcGet(
    "/restapi/v1.0/account/~/extension?perPage=1000",
    token,
  );
  const extensions = extData.records || [];

  const queues = extensions.filter(
    (e) => e.type === "Department" || e.type === "CallQueue",
  );
  const ivrs = extensions.filter((e) => e.type === "IvrMenu");
  const users = extensions.filter((e) => e.type === "User");

  console.log(`Extensions: ${extensions.length} total`);
  console.log(
    `  Queues: ${queues.length}, IVRs: ${ivrs.length}, Users: ${users.length}\n`,
  );

  // ── Queue details: phone numbers + forwarding rules ──
  console.log("═══ CALL QUEUES ═══\n");
  const queueData = [];

  for (const q of queues) {
    const tollFrees = (q.phoneNumbers || [])
      .map((p) => p.phoneNumber)
      .join(", ");
    let forwardingNumber = "";
    let forwardingLabel = "";
    let members = [];

    // Get queue call handling rules (where calls forward to)
    try {
      const rules = await rcGet(
        `/restapi/v1.0/account/~/extension/${q.id}/answering-rule`,
        token,
      );
      for (const rule of rules.records || []) {
        // Get full rule details
        try {
          const detail = await rcGet(
            `/restapi/v1.0/account/~/extension/${q.id}/answering-rule/${rule.id}`,
            token,
          );
          // Check for forwarding/transfer
          if (detail.forwarding?.rules) {
            for (const fwd of detail.forwarding.rules) {
              for (const fn of fwd.forwardingNumbers || []) {
                forwardingNumber = fn.phoneNumber || fn.uri || "";
                forwardingLabel = fn.label || fn.type || "";
              }
            }
          }
          if (detail.transfer?.extension) {
            forwardingLabel += ` → transfer to ext ${detail.transfer.extension.id}`;
          }
          if (detail.unconditionalForwarding?.phoneNumber) {
            forwardingNumber = detail.unconditionalForwarding.phoneNumber;
            forwardingLabel = "unconditional";
          }
        } catch {}
      }
    } catch (err) {
      forwardingLabel = `(rules fetch failed: ${err.message})`;
    }

    // Get queue members
    try {
      const memberData = await rcGet(
        `/restapi/v1.0/account/~/call-queues/${q.id}/members`,
        token,
      );
      members = (memberData.records || []).map(
        (m) => m.name || m.extensionNumber || "?",
      );
    } catch {
      // Might not be a call queue type
      try {
        const deptMembers = await rcGet(
          `/restapi/v1.0/account/~/extension/${q.id}/call-queues`,
          token,
        );
        members = (deptMembers.records || []).map((m) => m.name || "?");
      } catch {}
    }

    const entry = {
      name: q.name,
      ext: q.extensionNumber,
      status: q.status,
      tollFrees,
      forwardingNumber,
      forwardingLabel,
      members: members.join(", "),
      id: q.id,
    };
    queueData.push(entry);

    console.log(`[${q.extensionNumber}] ${q.name}`);
    console.log(`  Status: ${q.status}`);
    console.log(`  Toll-Free(s): ${tollFrees || "none"}`);
    console.log(
      `  Forwards To: ${forwardingNumber || "N/A"} ${forwardingLabel}`,
    );
    console.log(`  Members: ${members.join(", ") || "none"}`);
    console.log("");

    await new Promise((r) => setTimeout(r, 300)); // pace
  }

  // ── IVR Menus ──
  console.log("\n═══ IVR MENUS ═══\n");
  const ivrData = [];

  for (const ivr of ivrs) {
    const numbers = (ivr.phoneNumbers || [])
      .map((p) => p.phoneNumber)
      .join(", ");
    console.log(`[${ivr.extensionNumber}] ${ivr.name} — ${numbers}`);

    try {
      const detail = await rcGet(
        `/restapi/v1.0/account/~/ivr-menus/${ivr.id}`,
        token,
      );
      if (detail.actions) {
        for (const action of detail.actions) {
          const target = action.extension?.name || action.phoneNumber || "?";
          const targetExt = action.extension?.extensionNumber || "";
          console.log(
            `  Key ${action.input || "?"} → ${action.action} → ${target} ${targetExt ? `(ext ${targetExt})` : ""}`,
          );
          ivrData.push({
            ivrName: ivr.name,
            ivrExt: ivr.extensionNumber,
            ivrNumbers: numbers,
            key: action.input,
            action: action.action,
            targetName: target,
            targetExt,
          });
        }
      }
    } catch (err) {
      console.log(`  (details failed: ${err.message})`);
    }
    console.log("");
    await new Promise((r) => setTimeout(r, 300));
  }

  // ── Users ──
  console.log("\n═══ USERS ═══\n");
  users.forEach((u) => {
    const nums = (u.phoneNumbers || [])
      .map((p) => `${p.phoneNumber} (${p.usageType})`)
      .join(", ");
    console.log(`[${u.extensionNumber}] ${u.name} — ${u.status} — ${nums}`);
  });

  // ── CSV: Full queue map ──
  const qHeaders =
    "Queue_Name,Extension,Status,Toll_Free_Numbers,Forwards_To,Forward_Label,Members,RC_ID";
  const qRows = queueData.map((q) =>
    [
      `"${q.name}"`,
      q.ext,
      q.status,
      `"${q.tollFrees}"`,
      q.forwardingNumber,
      `"${q.forwardingLabel}"`,
      `"${q.members}"`,
      q.id,
    ].join(","),
  );
  fs.writeFileSync("rc-queues.csv", [qHeaders, ...qRows].join("\n"));

  // ── CSV: IVR routing ──
  if (ivrData.length > 0) {
    const iHeaders =
      "IVR_Name,IVR_Ext,IVR_Numbers,Key,Action,Target_Name,Target_Ext";
    const iRows = ivrData.map((i) =>
      [
        `"${i.ivrName}"`,
        i.ivrExt,
        `"${i.ivrNumbers}"`,
        i.key,
        i.action,
        `"${i.targetName}"`,
        i.targetExt,
      ].join(","),
    );
    fs.writeFileSync("rc-ivr-routing.csv", [iHeaders, ...iRows].join("\n"));
  }

  // ── CSV: All extensions ──
  const eHeaders = "Type,Extension,Name,Status,Phone_Numbers,ID";
  const eRows = extensions.map((e) =>
    [
      e.type || "",
      e.extensionNumber || "",
      `"${(e.name || "").replace(/"/g, '""')}"`,
      e.status || "",
      `"${(e.phoneNumbers || []).map((p) => p.phoneNumber).join("; ")}"`,
      e.id || "",
    ].join(","),
  );
  fs.writeFileSync("rc-extensions.csv", [eHeaders, ...eRows].join("\n"));

  console.log(`\n═══ FILES ═══`);
  console.log(
    `  rc-queues.csv — ${queueData.length} queues with forwarding + members`,
  );
  console.log(`  rc-ivr-routing.csv — ${ivrData.length} IVR key routes`);
  console.log(`  rc-extensions.csv — ${extensions.length} total extensions`);

  process.exit(0);
})();
