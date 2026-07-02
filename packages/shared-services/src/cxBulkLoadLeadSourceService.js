"use strict";

// Lead source for the bulk_load rail — turns eligible queue rows into candidate
// drafts. Read-only by construction: the queue reader is INJECTED, so this module
// has no way to claim, transition, or dial a lead (the legacy mutators are simply
// not in scope). Pure transforms (normalizeQueueRows, excludeSessionCandidates,
// buildExternId) test with zero mocks. See plan "### 4. Lead Source Snapshot".

function str(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeDomain(value) {
  return str(value).toUpperCase() || "TAG";
}

function externIdPart(value) {
  return str(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildExternSessionToken(sessionId) {
  const raw = str(sessionId).replace(/^cxbl-/i, "");
  return raw.replace(/[^a-z0-9]+/gi, "").slice(-12).toLowerCase() || null;
}

function digits(value) {
  return str(value).replace(/\D+/g, "");
}

function last4(value) {
  const d = digits(value);
  return d ? d.slice(-4) : null;
}

function normalizeStatusCategory(value) {
  return str(value).toLowerCase().replace(/[_\s]+/g, "-");
}

function readContactStatusCategory(row = {}) {
  return normalizeStatusCategory(
    row.statusCategory
      || row.contactStatusCategory
      || row.caseProfile?.statusCategory
      || row.contact?.statusCategory
      || row.metadata?.statusCategory
      || row.metadata?.reflectedLogicsStatusCategory,
  );
}

function isHardBlockedStatusCategory(value) {
  return new Set([
    "client",
    "dnc",
    "do-not-contact",
    "contact-blocked",
    "stop-contact",
  ]).has(normalizeStatusCategory(value));
}

// PURE. Cheap visible-state guard. The runtime still performs the authoritative
// contact-eligibility check before RingCX publish; this only drops rows whose
// joined/snapshotted state is already obviously not dialable.
function isQueueRowContactable(row = {}) {
  const category = readContactStatusCategory(row);
  if (category && isHardBlockedStatusCategory(category)) return false;
  if (row.active === false || row.caseProfile?.active === false) return false;
  return true;
}

// PURE. A stable, RingCX-safe externId. The publisher loads the lead WITH this
// id; RingCX echoes it on the active call; the watcher matches on it. Active
// bulk sessions must pass sessionId so stale RingCX rows cannot collide with a
// later session that reuses the same queue row id.
function buildExternId({ domain, queueItemId, sessionId } = {}) {
  const qid = externIdPart(queueItemId);
  if (!qid) return null;
  const token = buildExternSessionToken(sessionId);
  const parts = ["cxbl", normalizeDomain(domain).toLowerCase()];
  if (token) parts.push(token);
  parts.push(qid);
  return parts.join("-");
}

function normalizeQueueRow(row = {}) {
  const queueItemId = str(row.queueItemId || row._id || row.id);
  if (!queueItemId) return null;
  const domain = normalizeDomain(row.domain);
  const phone = digits(row.phone || row.leadPhone || row.phoneNumber);
  return {
    queueItemId,
    domain,
    caseId: row.caseId != null ? row.caseId : row.case_id != null ? row.case_id : null,
    name: row.name || row.leadName || row.fullName || null,
    phone: phone || null,
    phoneLast4: last4(phone),
    externId: buildExternId({ domain, queueItemId }),
  };
}

// PURE. Map raw queue rows to candidate drafts, dropping rows with no id.
function normalizeQueueRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter(isQueueRowContactable)
    .map(normalizeQueueRow)
    .filter(Boolean);
}

// PURE. Drop drafts whose queueItemId is already known to the session (in the
// buffer, the current call, or already completed) so a snapshot never re-adds one.
function excludeSessionCandidates(drafts = [], session = {}) {
  const known = new Set();
  const add = (item) => {
    const id = item && str(item.queueItemId || item.id || item._id);
    if (id) known.add(id);
  };
  (session.acceptedBuffer || []).forEach(add);
  (session.completed || []).forEach(add);
  if (session.current) add(session.current);
  return (Array.isArray(drafts) ? drafts : []).filter((d) => !known.has(str(d.queueItemId)));
}

// Thin I/O orchestration. `deps.listReadyQueueItems` is a READ-ONLY reader the
// orchestrator supplies (a wrapper over the queue repo's list path — never claim).
async function snapshotCandidates(deps = {}, input = {}) {
  const reader = deps.listReadyQueueItems;
  if (typeof reader !== "function") {
    throw new Error("snapshotCandidates requires a read-only deps.listReadyQueueItems");
  }
  const max = Number(input.maxItems || 0);
  const rows = await reader({
    agentEmail: input.agentEmail,
    agentExtensionId: input.agentExtensionId,
    domain: input.domain,
    limit: max > 0 ? max : undefined,
  });
  const drafts = excludeSessionCandidates(normalizeQueueRows(rows), input.session || {});
  return max > 0 ? drafts.slice(0, max) : drafts;
}

module.exports = {
  buildExternId,
  buildExternSessionToken,
  isQueueRowContactable,
  normalizeQueueRows,
  excludeSessionCandidates,
  snapshotCandidates,
};
