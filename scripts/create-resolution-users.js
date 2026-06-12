"use strict";

// Provision the resolution-management users (2026-06-12, user-directed).
//
// Creates accounts with the MINIMAL role (widget-user — no CX/EX surface)
// plus per-user resolution.* permission grants. Login is email OTP, so no
// password provisioning. Idempotent: existing emails are skipped (reported),
// never modified — re-running is safe.
//
// Admins need no grants: the catalog gives them all permissions implicitly.
//
// Usage:
//   node scripts/create-resolution-users.js --dry   # show plan
//   node scripts/create-resolution-users.js         # create

require("dotenv").config();
const mongoose = require("mongoose");
const {
  createUserAccount,
  findUserAccountByEmail,
} = require("../packages/shared-repositories/src/userAccountRepository");

const RESOLUTION_USERS = [
  "dpearson@taxadvocategroup.com",
  "jharo@taxadvocategroup.com",
  "lcollins@taxadvocategroup.com",
  "mcazares@taxadvocategroup.com",
  "nramirez@taxadvocategroup.com",
  "jwallace@taxadvocategroup.com",
  "jpineda@taxadvocategroup.com",
];

const RESOLUTION_PERMISSIONS = ["resolution.read", "resolution.write", "resolution.agent"];

(async () => {
  const dry = process.argv.includes("--dry");
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: process.env.MONGO_DB_NAME || "tagcontactbridge_parallel",
  });

  for (const email of RESOLUTION_USERS) {
    const existing = await findUserAccountByEmail(email);
    if (existing) {
      const has = (existing.permissions || []).filter((p) => RESOLUTION_PERMISSIONS.includes(p));
      console.log(`EXISTS  ${email} (role ${existing.role}, status ${existing.status}, resolution perms: ${has.length}/${RESOLUTION_PERMISSIONS.length}) — untouched`);
      continue;
    }
    if (dry) {
      console.log(`WOULD CREATE  ${email} — widget-user/active + [${RESOLUTION_PERMISSIONS.join(", ")}]`);
      continue;
    }
    const record = await createUserAccount({
      email,
      name: email.split("@")[0],
      role: "widget-user",
      audience: "user",
      status: "active",
      permissions: RESOLUTION_PERMISSIONS,
      metadata: { createdBy: "resolution-provisioning-script", purpose: "resolution-panel-only" },
    });
    console.log(`CREATED ${email} (id ${record._id || record.id}, role ${record.role}, status ${record.status})`);
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
