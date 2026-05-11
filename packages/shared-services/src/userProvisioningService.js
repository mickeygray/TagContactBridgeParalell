"use strict";

const { createRingCentralClient } = require("../../shared-integrations/src");
const {
  agentStateRepository,
  userAccountRepository,
} = require("../../shared-repositories/src");
const {
  HARDENED_USERS,
  SEED_ADMINS,
} = require("../../shared-data/src/accounts");
const { findExShellsForEmail } = require("../../shared-data/src/exShellDirectory");
const { findLogicsAgentByEmail } = require("../../shared-data/src/logicsAgents");

const SEED_ADMIN_EMAILS = new Set(
  SEED_ADMINS.map((seed) => String(seed.email || "").toLowerCase()),
);
const HARDENED_USER_RULES = new Map(
  HARDENED_USERS.map((seed) => [String(seed.email || "").toLowerCase(), seed]),
);

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function getSettlementOfficerId(block) {
  return block?.settlementOfficerId || block?.soId || block?.logicsId || null;
}

function isSyntheticExtensionId(extensionId) {
  return String(extensionId || "").trim().toLowerCase().startsWith("sim-");
}

const EMAIL_DOMAIN_TO_COMPANY = {
  "taxadvocategroup.com": "TAG",
  "wynntaxsolutions.com": "WYNN",
  // Add AMITY when their domain is confirmed; until then admin reassigns.
};

// The canonical login domain — every human in the org has exactly one
// UserAccount keyed by their @taxadvocategroup.com email. Wynn/Amity
// RC extensions belong to the SAME human (they're tenant-specific
// telephony seats, not separate identities) and get rolled up into
// `metadata.additionalExtensionIds` on the TAG UA so dial/cx routing
// finds the right agent regardless of which tenant queue served the
// call. Sync skips creating UAs for non-canonical-domain emails.
const CANONICAL_LOGIN_DOMAIN = "taxadvocategroup.com";

function emailDomain(email) {
  return String(email || "").toLowerCase().split("@")[1] || "";
}

function isCanonicalLoginEmail(email) {
  return emailDomain(email) === CANONICAL_LOGIN_DOMAIN;
}

function resolveCompany(extension, logicsAgent = null) {
  // Priority order (most reliable first):
  //  1) Explicit RC hint (`extension.contact.company`) — rare but present
  //     when RC is configured with department metadata.
  //  2) Email domain — reliable in practice because TAG and Wynn each
  //     issue employees an org email on their own domain.
  //  3) Logics roster pairing — if the email only matches a Wynn Logics
  //     entry, stamp WYNN; else TAG. Catches edge cases like admins who
  //     use a TAG email but only exist in the Wynn tenant.
  //  4) TAG fallback — last resort; admin can reassign from the UI.
  //
  // IMPORTANT: `company` gates CX access via requireUser, so mis-stamping
  // a Wynn user as TAG will block them from legitimate Wynn case work.
  const hint = String(extension?.contact?.company || "").toUpperCase();
  if (hint === "TAG" || hint === "WYNN" || hint === "AMITY") return hint;

  const email = String(extension?.contact?.email || "").trim().toLowerCase();
  const domain = email.split("@")[1] || "";
  if (EMAIL_DOMAIN_TO_COMPANY[domain]) return EMAIL_DOMAIN_TO_COMPANY[domain];

  if (logicsAgent) {
    if (!logicsAgent.tag && logicsAgent.wynn) return "WYNN";
    if (logicsAgent.tag && !logicsAgent.wynn) return "TAG";
  }

  return "TAG";
}

function bestName(extension) {
  const firstName = String(extension?.contact?.firstName || "").trim();
  const lastName = String(extension?.contact?.lastName || "").trim();
  const full = `${firstName} ${lastName}`.trim();
  return full || extension?.name || null;
}

function isProvisionableExtension(ext) {
  if (!ext) return false;
  if (ext.type !== "User") return false;
  const email = normalizeEmail(ext?.contact?.email);
  if (!email) return false;
  return true;
}

function applyRcBackfillPatch({
  patch,
  existing,
  primary,
  agentState,
  exShells,
  logicsAgent,
  primaryBlock,
  tagBlock,
  wynnBlock,
}) {
  if ((!Array.isArray(existing.exShells) || existing.exShells.length === 0) && exShells.length > 0) {
    patch.exShells = exShells;
  }

  const currentExtensionId = String(existing.extensionId || "").trim();
  const nextExtensionId = String(primary.id);
  const currentIsSynthetic = isSyntheticExtensionId(currentExtensionId);
  if (!currentExtensionId || currentIsSynthetic) {
    patch.extensionId = nextExtensionId;
  } else if (currentExtensionId !== nextExtensionId) {
    patch.metadata.rcExtensionId = nextExtensionId;
  }

  if ((!existing.extensionNumber || currentIsSynthetic) && primary.extensionNumber != null) {
    patch.extensionNumber = String(primary.extensionNumber);
  }

  if (!existing.name) {
    patch.name = logicsAgent?.name || bestName(primary) || existing.name;
  }

  if (!existing.cxAgentId && agentState?.cxAgentId) {
    patch.cxAgentId = agentState.cxAgentId;
  }

  if (!existing.company) {
    patch.company = resolveCompany(primary, logicsAgent);
  }

  if (logicsAgent) {
    if (!existing.logicsUserId && primaryBlock) {
      patch.logicsUserId = primaryBlock.logicsId;
    }
    if (!existing.logicsDisplayName) {
      patch.logicsDisplayName = logicsAgent.name;
    }
    if (!existing.phone && logicsAgent.phone) {
      patch.phone = logicsAgent.phone;
    }
    if (tagBlock) {
      if (!existing.tagLogicsId) patch.tagLogicsId = tagBlock.logicsId;
      if (!existing.tagSOId) patch.tagSOId = getSettlementOfficerId(tagBlock);
      if (!existing.tagEmail) patch.tagEmail = tagBlock.email;
      if (!existing.tagLogicsName) {
        patch.tagLogicsName = tagBlock.displayName || logicsAgent.name;
      }
      if (!existing.tagLogicsRoles) patch.tagLogicsRoles = tagBlock.roles;
    }
    if (wynnBlock) {
      if (!existing.wynnLogicsId) patch.wynnLogicsId = wynnBlock.logicsId;
      if (!existing.wynnSOId) patch.wynnSOId = getSettlementOfficerId(wynnBlock);
      if (!existing.wynnEmail) patch.wynnEmail = wynnBlock.email;
      if (!existing.wynnLogicsName) {
        patch.wynnLogicsName = wynnBlock.displayName || logicsAgent.name;
      }
      if (!existing.wynnLogicsRoles) patch.wynnLogicsRoles = wynnBlock.roles;
    }
  }
}

/**
 * Consolidate RingCentral extensions → UserAccount keyed by email.
 *
 * Sources of truth:
 *   - RC extensions API (primary) — has email, name, extensionId, status
 *   - AgentState (secondary) — already mirrors RC presence; we pull
 *     `cxAgentId` forward if it was set (manual pairing, possibly via
 *     CX console)
 *   - Logics — case-owner emails could augment later; not consulted in
 *     the initial sync pass (most case owners are also RC users)
 *
 * Rules:
 *   - Create new UserAccount (status=invited, role=internal-agent,
 *     audience=user, source=rc-poll) for every RC User extension with
 *     an email that doesn't already have an account.
 *   - Update existing accounts: refresh `extensionId`, `name` (only if
 *     the existing value is empty — don't overwrite operator edits),
 *     `cxAgentId` (only if empty). Never touch `role`, `audience`,
 *     `workspace`, `stationLabel` on existing rows.
 *   - Demote: if an existing UA's extension is `Status: Disabled` or
 *     no longer in the RC list, mark UA.status=disabled. Seed admins
 *     are exempt — they may not have RC extensions at all.
 *   - Email collisions: one UA per email. If two RC extensions share
 *     an email, the Enabled one wins on pairing; the other is stored
 *     in metadata.additionalExtensionIds for future reference.
 */
async function syncUsersFromRcExtensions({
  dryRun = false,
  logger = null,
} = {}) {
  const rc = createRingCentralClient();
  await rc.reinitializePlatform({ force: false, reason: "user-sync" });

  const payload = await rc.listExtensions();
  const records = Array.isArray(payload.records) ? payload.records : [];

  const byEmail = new Map();
  for (const ext of records) {
    if (!isProvisionableExtension(ext)) continue;
    const email = normalizeEmail(ext.contact.email);
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email).push(ext);
  }

  // Roll up tenant-sibling RC extensions under the canonical TAG email.
  // The Logics roster is the source of truth for "which TAG/Wynn/Amity
  // emails belong to the same human." For each canonical TAG email we
  // pull its Logics record, find sibling RC extensions by tag.email /
  // wynn.email, and stash their RC ext IDs as siblingExtensionIds.
  // Non-canonical-domain emails get skipped during the create loop —
  // they don't get their own UA.
  const siblingExtensionIdsByCanonicalEmail = new Map();
  const claimedNonCanonicalEmails = new Set();
  for (const email of byEmail.keys()) {
    if (!isCanonicalLoginEmail(email)) continue;
    const logicsAgent = findLogicsAgentByEmail(email);
    if (!logicsAgent) continue;
    const siblings = [];
    for (const block of [logicsAgent.tag, logicsAgent.wynn, logicsAgent.amity]) {
      const blockEmail = normalizeEmail(block?.email);
      if (!blockEmail || blockEmail === email) continue;
      const siblingExts = byEmail.get(blockEmail);
      if (!siblingExts || siblingExts.length === 0) continue;
      claimedNonCanonicalEmails.add(blockEmail);
      for (const ext of siblingExts) {
        if (ext?.id != null) siblings.push(String(ext.id));
      }
    }
    if (siblings.length > 0) {
      siblingExtensionIdsByCanonicalEmail.set(email, siblings);
    }
  }

  const agentStates = await agentStateRepository.listAgentStates({});
  const agentStateByExt = new Map(
    agentStates.map((agent) => [String(agent.extensionId || ""), agent]),
  );

  const existingAccounts = await userAccountRepository.listUserAccounts({
    limit: 1000,
  });
  const existingByEmail = new Map(
    existingAccounts.map((account) => [
      normalizeEmail(account.email),
      account,
    ]),
  );

  const stats = {
    rcExtensionsScanned: records.length,
    provisionable: byEmail.size,
    created: 0,
    updated: 0,
    demoted: 0,
    protectedBackfilled: 0,
    errors: [],
  };
  const createdAccounts = [];
  const demotedAccounts = [];

  // ── Upsert every provisionable RC email ────────────────────────────
  for (const [email, extensions] of byEmail.entries()) {
    try {
      // Skip non-canonical-domain emails entirely — they're tenant-sibling
      // seats whose RC ext IDs already got rolled up onto the TAG UA via
      // siblingExtensionIdsByCanonicalEmail. Creating a separate UA for
      // each tenant email produces orphan rows nobody logs into.
      if (!isCanonicalLoginEmail(email)) {
        if (claimedNonCanonicalEmails.has(email)) {
          // Sibling rolled up onto a TAG UA — silent skip.
          continue;
        }
        // Truly off-domain (e.g. external contractor / partner). Log so
        // operators can decide whether to create manually.
        logger?.info?.("user.rc_skipped_non_canonical", {
          email,
          extensionIds: extensions.map((e) => String(e.id)),
        });
        continue;
      }

      // Prefer the first Enabled extension for pairing; others become
      // additionalExtensionIds in metadata. Sort so Enabled wins.
      const sorted = [...extensions].sort((a, b) =>
        (a.status === "Enabled" ? 0 : 1) - (b.status === "Enabled" ? 0 : 1),
      );
      const primary = sorted[0];
      // Same-email duplicates (rare) + cross-tenant siblings (common).
      const additionalIds = [
        ...sorted.slice(1).map((e) => String(e.id)),
        ...(siblingExtensionIdsByCanonicalEmail.get(email) || []),
      ].filter(Boolean);

      const existing = existingByEmail.get(email);
      const isSeed = SEED_ADMIN_EMAILS.has(email);
      const hardenedUser = HARDENED_USER_RULES.get(email) || null;
      const agentState = agentStateByExt.get(String(primary.id));
      const primaryStatus = primary.status === "Enabled" ? "active" : "disabled";

      // Look up Logics roster by email — gives us one row per human
      // with a `tag` block and/or `wynn` block. Domain-prefixed fields
      // get populated on the UA so downstream callers can pick the
      // TAG vs Wynn Logics identity based on which company the phone
      // call / case belongs to (resolved from DID → CallRail mapping).
      const logicsAgent = findLogicsAgentByEmail(email);
      const exShells = findExShellsForEmail(email);
      const tagBlock = logicsAgent?.tag || null;
      const wynnBlock = logicsAgent?.wynn || null;
      // Pick the "primary" Logics identity for the flat legacy fields:
      // whichever block matches the login email, else prefer TAG.
      const primaryBlock =
        tagBlock && tagBlock.email === email
          ? tagBlock
          : wynnBlock && wynnBlock.email === email
            ? wynnBlock
            : tagBlock || wynnBlock;

      if (!existing) {
        // Create new UA (invited — operator must finish via OTP login)
        if (dryRun) {
          stats.created += 1;
          createdAccounts.push({
            email,
            extensionId: primary.id,
            tagLogicsId: tagBlock?.logicsId || null,
            tagSOId: getSettlementOfficerId(tagBlock),
            wynnLogicsId: wynnBlock?.logicsId || null,
            wynnSOId: getSettlementOfficerId(wynnBlock),
            exShells,
          });
          continue;
        }
        const created = await userAccountRepository.createUserAccount({
          email,
          name: hardenedUser?.name || logicsAgent?.name || bestName(primary),
          role: isSeed ? "admin" : hardenedUser?.role || "internal-agent",
          audience: isSeed ? "admin" : hardenedUser?.audience || "user",
          workspace: hardenedUser?.workspace || "general",
          company: hardenedUser?.company || resolveCompany(primary, logicsAgent),
          logicsUserId: primaryBlock?.logicsId || null,
          logicsDisplayName: logicsAgent?.name || null,
          tagLogicsId: tagBlock?.logicsId || null,
          tagSOId: getSettlementOfficerId(tagBlock),
          tagEmail: tagBlock?.email || null,
          tagLogicsName: tagBlock ? (tagBlock.displayName || logicsAgent.name) : null,
          tagLogicsRoles: tagBlock?.roles || null,
          wynnLogicsId: wynnBlock?.logicsId || null,
          wynnSOId: getSettlementOfficerId(wynnBlock),
          wynnEmail: wynnBlock?.email || null,
          wynnLogicsName: wynnBlock ? (wynnBlock.displayName || logicsAgent.name) : null,
          wynnLogicsRoles: wynnBlock?.roles || null,
          extensionId: String(primary.id),
          extensionNumber: primary.extensionNumber != null ? String(primary.extensionNumber) : null,
          cxAgentId: agentState?.cxAgentId || null,
          phone: logicsAgent?.phone || null,
          exShells,
          status:
            isSeed || hardenedUser
              ? "active"
              : primary.status === "Enabled"
                ? "invited"
                : "disabled",
          source: isSeed || hardenedUser ? "seed" : "rc-poll",
          metadata: {
            provisionedFromRc: true,
            lastRcSyncAt: new Date(),
            rcStatus: primary.status,
            additionalExtensionIds: additionalIds,
          },
        });
        stats.created += 1;
        createdAccounts.push({
          email,
          id: created.id,
          extensionId: primary.id,
          tagLogicsId: tagBlock?.logicsId || null,
          wynnLogicsId: wynnBlock?.logicsId || null,
        });
        logger?.info?.("user.rc_provisioned", {
          email,
          extensionId: primary.id,
          tagLogicsId: tagBlock?.logicsId || null,
          wynnLogicsId: wynnBlock?.logicsId || null,
        });
        continue;
      }

      // Existing account: merge RC-owned fields without trampling
      // operator-edited fields. Seed admins get a very narrow update:
      // only `lastRcSyncAt` + `rcStatus` in metadata — we never touch
      // their extension pairing because admins may be paired manually
      // to a different extension than the one their email matches.
      if (isSeed || hardenedUser) {
        const patch = {
          role: isSeed ? "admin" : hardenedUser.role,
          audience: isSeed ? "admin" : hardenedUser.audience,
          metadata: {
            ...(existing.metadata || {}),
            provisionedFromRc: existing.metadata?.provisionedFromRc ?? true,
            lastRcSyncAt: new Date(),
            rcStatus: primary.status,
            additionalExtensionIds: additionalIds,
          },
        };
        if (hardenedUser?.company) patch.company = hardenedUser.company;
        if (hardenedUser?.workspace) patch.workspace = hardenedUser.workspace;
        if (isSeed) {
          patch.status = "active";
        } else if (primaryStatus === "active" && existing.status !== "active") {
          patch.status = "active";
        } else if (primaryStatus === "disabled" && existing.status === "active") {
          patch.status = "disabled";
          stats.demoted += 1;
          demotedAccounts.push({ email, id: existing.id, extensionId: primary.id });
        }
        applyRcBackfillPatch({
          patch,
          existing,
          primary,
          agentState,
          exShells,
          logicsAgent,
          primaryBlock,
          tagBlock,
          wynnBlock,
        });
        if (!dryRun) {
          await userAccountRepository.updateUserAccount(existing.id, patch);
        }
        stats.updated += 1;
        stats.protectedBackfilled += 1;
        continue;
      }

      const patch = {
        metadata: {
          ...(existing.metadata || {}),
          provisionedFromRc: existing.metadata?.provisionedFromRc ?? true,
          lastRcSyncAt: new Date(),
          rcStatus: primary.status,
          additionalExtensionIds: additionalIds,
        },
      };
      applyRcBackfillPatch({
        patch,
        existing,
        primary,
        agentState,
        exShells,
        logicsAgent,
        primaryBlock,
        tagBlock,
        wynnBlock,
      });
      // Safe RC backfill: fill missing identities and replace synthetic
      // extension ids, but preserve deliberate manual pairings by stamping
      // `metadata.rcExtensionId` instead of overwriting them.
      // Never overwrites operator-edited values — only fills gaps.
      // Status flip: if RC says Disabled and UA is currently active,
      // demote. If RC flipped back to Enabled and UA is disabled, we
      // leave it — re-enabling should be an explicit admin action so
      // we don't silently re-admit a terminated employee.
      if (primaryStatus === "disabled" && existing.status === "active") {
        patch.status = "disabled";
        stats.demoted += 1;
        demotedAccounts.push({ email, id: existing.id, extensionId: primary.id });
      }

      if (!dryRun) {
        await userAccountRepository.updateUserAccount(existing.id, patch);
      }
      stats.updated += 1;
    } catch (error) {
      stats.errors.push({ email, error: error.message });
      logger?.warn?.("user.rc_sync_failed", { email, error: error.message });
    }
  }

  // ── Demote UAs whose RC extension has disappeared entirely ─────────
  const rcEmails = new Set(byEmail.keys());
  for (const account of existingAccounts) {
    if (account.source !== "rc-poll") continue; // only touch auto-provisioned
    if (SEED_ADMIN_EMAILS.has(normalizeEmail(account.email))) continue;
    if (account.status !== "active") continue;
    if (rcEmails.has(normalizeEmail(account.email))) continue;
    try {
      if (!dryRun) {
        await userAccountRepository.updateUserAccount(account.id, {
          status: "disabled",
          metadata: {
            ...(account.metadata || {}),
            demotionReason: "rc-extension-no-longer-present",
            demotedAt: new Date(),
          },
        });
      }
      stats.demoted += 1;
      demotedAccounts.push({
        email: account.email,
        id: account.id,
        extensionId: account.extensionId,
      });
      logger?.info?.("user.rc_demoted", {
        email: account.email,
        reason: "not-in-rc-list",
      });
    } catch (error) {
      stats.errors.push({ email: account.email, error: error.message });
    }
  }

  return {
    dryRun,
    syncedAt: new Date().toISOString(),
    stats,
    created: createdAccounts,
    demoted: demotedAccounts,
    errors: stats.errors.slice(0, 25),
  };
}

module.exports = {
  syncUsersFromRcExtensions,
};
