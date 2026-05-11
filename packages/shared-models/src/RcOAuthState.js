"use strict";

const mongoose = require("mongoose");

// RcOAuthState — one document per pending 3LO authorization request.
//
// Lifecycle:
//   1. /api/auth/cx/start mints a state row + generates code_verifier
//      (PKCE) and returns the RC authorize URL with state + code_challenge
//   2. User authorizes at RC, RC redirects to /api/auth/cx/callback?code=…&state=…
//   3. Callback looks up the state row by `state`, verifies it's not
//      expired or already-used, exchanges code for tokens (using the
//      stored code_verifier), then marks the row `consumed`.
//
// State + verifier are short-lived (10 min default); a sweep cron OR
// the Mongo TTL index purges expired rows. The `consumed` flag prevents
// replay attacks.
//
// IMPORTANT: codeVerifier is plaintext in this collection. PKCE
// verifiers are short-lived (10 min) AND tied to a single redirect
// URL + client-id, so even if the DB leaks, a stolen verifier is
// useless without a matching unused state. Still — don't persist these
// long-term; the TTL cleans them up automatically.

const rcOAuthStateSchema = new mongoose.Schema(
  {
    // Random opaque state token returned via redirect
    state: { type: String, required: true, unique: true, index: true },
    // PKCE: S256 challenge + plaintext verifier
    codeVerifier: { type: String, required: true },
    codeChallenge: { type: String, required: true },
    codeChallengeMethod: { type: String, default: "S256" },
    // Initiating user (must already have a Parallel JWT)
    initiatingUserId: { type: String, default: null, index: true },
    initiatingUserEmail: { type: String, default: null, index: true },
    // The redirect_uri passed to RC (must match exactly on callback)
    redirectUri: { type: String, required: true },
    // Optional client-supplied redirect-after-success target
    finalRedirectTo: { type: String, default: null },
    // Lifecycle
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    consumed: { type: Boolean, default: false, index: true },
    consumedAt: { type: Date, default: null },
    consumeError: { type: String, default: null },
  },
  {
    collection: "rcoauthstates",
  },
);

// TTL: Mongo auto-deletes expired rows on the indexed field
rcOAuthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.ControlPlaneRcOAuthState
  || mongoose.model("ControlPlaneRcOAuthState", rcOAuthStateSchema);
