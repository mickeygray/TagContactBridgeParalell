"use strict";

const mongoose = require("mongoose");

// IDENTIFIER SCOPE:
// - `email` is globally unique. Accounts are platform-wide identities; one
//   email = one human regardless of which company they work in.
// - `extensionId` sparse-unique mirrors AgentState.extensionId — safe today
//   because all companies share one RingCentral account. If that changes,
//   move both AgentState and UserAccount to `{ company: 1, extensionId: 1 }`.
const userAccountSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    role: {
      type: String,
      // "manager" = per-domain admin (see permissionsCatalog.js for the
      // full role → permissions mapping). Added in PR-B (auth hardening).
      enum: ["admin", "manager", "internal-agent", "widget-user", "service"],
      default: "widget-user",
      index: true,
    },
    // Additive permissions on top of role defaults. See
    // packages/shared-auth/src/permissionsCatalog.js for known keys.
    // Admin role implicitly has ALL permissions regardless of this field.
    permissions: { type: [String], default: [] },
    permissionsUpdatedAt: { type: Date, default: null },
    permissionsUpdatedBy: { type: String, default: null },
    audience: {
      type: String,
      enum: ["admin", "user"],
      default: "user",
      index: true,
    },
    workspace: { type: String, default: "general" },
    stationLabel: { type: String, default: null },
    company: {
      type: String,
      enum: ["TAG", "WYNN", "AMITY"],
      default: "TAG",
      index: true,
    },
    // Legacy flat fields (pre-multi-company). Kept for backwards compat —
    // `logicsUserId` mirrors tagLogicsId when TAG is the user's primary
    // company. Prefer `tagLogicsId`/`wynnLogicsId` for new reads.
    logicsUserId: { type: Number, default: null, index: true, sparse: true },
    logicsDisplayName: { type: String, default: null },
    // Domain-specific Logics identities. A human may have one or both.
    // At runtime: resolve the company from the phone/DID/CallRail lookup,
    // then pick `tag*` or `wynn*` fields accordingly.
    tagLogicsId: { type: Number, default: null, index: true, sparse: true },
    tagSOId: { type: Number, default: null, index: true, sparse: true },
    tagEmail: { type: String, default: null, lowercase: true, trim: true },
    tagLogicsName: { type: String, default: null },
    tagLogicsRoles: { type: String, default: null },
    wynnLogicsId: { type: Number, default: null, index: true, sparse: true },
    wynnSOId: { type: Number, default: null, index: true, sparse: true },
    wynnEmail: { type: String, default: null, lowercase: true, trim: true },
    wynnLogicsName: { type: String, default: null },
    wynnLogicsRoles: { type: String, default: null },
    logicsAuth: {
      credentialMode: {
        type: String,
        enum: ["company", "user", "external-ref"],
        default: "company",
      },
      credentialStatus: {
        type: String,
        enum: ["pending", "active", "revoked"],
        default: "pending",
      },
      apiKeyHash: { type: String, default: null },
      secretHash: { type: String, default: null },
      apiKeyLast4: { type: String, default: null },
      secretLast4: { type: String, default: null },
      externalSecretRef: { type: String, default: null },
      scopes: [{ type: String }],
      permissionsLabel: { type: String, default: null },
      activatedAt: { type: Date, default: null },
      rotatedAt: { type: Date, default: null },
      lastValidatedAt: { type: Date, default: null },
    },
    extensionId: { type: String, default: null, index: true, sparse: true },
    extensionNumber: { type: String, default: null },
    cxAgentId: { type: String, default: null, sparse: true },
    phone: { type: String, default: null },
    cxQueuePolicy: {
      tier: {
        type: String,
        enum: ["no_leads", "red_only", "old_balanced", "fresh_capped", "fresh_priority"],
        default: null,
        index: true,
      },
      enabled: { type: Boolean, default: true },
      routeCampaigns: { type: [String], default: undefined },
      totalOpen: { type: Number, default: null },
      fresh: {
        eligible: { type: Boolean, default: null },
        firstTouchEligible: { type: Boolean, default: null },
        targetOpen: { type: Number, default: null },
        hourlyCap: { type: Number, default: null },
        priorityWeight: { type: Number, default: null },
      },
      day2to15: {
        targetOpen: { type: Number, default: null },
      },
      day16to30: {
        targetOpen: { type: Number, default: null },
      },
      aged: {
        targetOpen: { type: Number, default: null },
        fillRemainder: { type: Boolean, default: null },
      },
      updatedAt: { type: Date, default: null },
      updatedBy: { type: String, default: null },
    },
    // ── CX (RingCX) authentication state ──────────────────────────
    //
    // Populated by the 3-legged OAuth flow (PR-C). When the agent
    // first authorizes Parallel against their RC account, we exchange
    // the auth code for a user-scoped RC token, then exchange THAT
    // for a RingCX bearer. The refresh token (encrypted) survives
    // ~60 days; the bearer lives ~5 minutes and gets refreshed
    // on-demand by cxTokenStorageService.
    //
    // Encrypted blobs use AES-256-GCM with key from
    // CX_TOKEN_ENCRYPTION_KEY env. NEVER store cleartext.
    cxAuth: {
      // RC user identity from 3LO (e.g. "ballen@taxadvocategroup.com").
      rcUserEmail: { type: String, default: null },
      rcUserId: { type: String, default: null, index: true, sparse: true },
      // Encrypted RC refresh token + when it expires (~60 days)
      refreshTokenEnc: { type: String, default: null },
      refreshTokenExpiresAt: { type: Date, default: null },
      // OAuth scopes granted by the user
      scopes: { type: [String], default: [] },
      // Audit
      consentGrantedAt: { type: Date, default: null },
      consentRevokedAt: { type: Date, default: null },
      lastTokenIssuedAt: { type: Date, default: null },
      lastRefreshAt: { type: Date, default: null },
      lastRefreshError: { type: String, default: null },
      // Anti-loop stamp for the off-hook scope auto-heal: set when an
      // OAuth callback completes WITHOUT CXRouting in the granted
      // scope set. While this stamp is recent (within
      // OFFHOOK_SCOPE_REAUTH_BACKOFF_DAYS), deriveOAuthValidity stops
      // gating the workspace on the missing scope — the agent's RC
      // role doesn't allow CXRouting and re-prompting won't help.
      // Cleared on any successful consent that DOES include CXRouting.
      scopeReauthAttemptedAt: { type: Date, default: null },
    },
    cxSession: {
      // Encrypted current RingCX bearer (5-min lifetime)
      bearerEnc: { type: String, default: null },
      bearerExpiresAt: { type: Date, default: null },
      // Encrypted RingCX-side refresh token (different from RC's)
      rcxRefreshTokenEnc: { type: String, default: null },
      // Identity from RingCX side
      rcxMainAccountId: { type: String, default: null },
      rcxAgentEmail: { type: String, default: null },
      // Bookkeeping
      refreshedAt: { type: Date, default: null },
      lastUsedAt: { type: Date, default: null },
      lastErrorAt: { type: Date, default: null },
      lastError: { type: String, default: null },
    },
    exShells: [
      {
        company: {
          type: String,
          enum: ["TAG", "WYNN", "AMITY"],
          default: "TAG",
        },
        email: { type: String, default: null, lowercase: true, trim: true },
        name: { type: String, default: null },
        extensionNumber: { type: String, default: null },
        loginPhones: [{ type: String }],
        primaryPhone: { type: String, default: null },
        rcExtensionId: { type: String, default: null },
        lastResolvedAt: { type: Date, default: null },
        source: { type: String, default: null },
      },
    ],
    status: {
      type: String,
      enum: ["active", "disabled", "invited"],
      default: "active",
      index: true,
    },
    source: {
      type: String,
      enum: ["seed", "manual", "rc-poll"],
      default: "manual",
    },
    lastLoginAt: { type: Date, default: null },
    disabledAt: { type: Date, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  {
    timestamps: true,
    collection: "useraccounts",
  },
);

module.exports =
  mongoose.models.ControlPlaneUserAccount ||
  mongoose.model("ControlPlaneUserAccount", userAccountSchema);
