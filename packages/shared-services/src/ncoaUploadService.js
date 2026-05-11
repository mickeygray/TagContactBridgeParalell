"use strict";

const Papa = require("papaparse");
const { createLogicsClient } = require("../../shared-integrations/src");
const {
  leadCadenceRepository,
} = require("../../shared-repositories/src");
const {
  MailImport,
  WorkflowRecord,
} = require("../../shared-models/src");
const { recordWorkflowStage } = require("./workflowStateService");
const { emitHourlyJobEvent } = require("./hourlyJobEventService");

function cleanText(value) {
  return String(value || "").trim() || null;
}

function cleanPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

function cleanZip(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return raw.split("-")[0] || null;
}

function extractCsvSourceName(row = {}) {
  return (
    cleanText(row["ABC Source"]) ||
    cleanText(row["Source Name"]) ||
    cleanText(row["Source"]) ||
    cleanText(row["SOURCE"]) ||
    cleanText(row.SourceName) ||
    cleanText(row.sourceName)
  );
}

function toNotes(row) {
  const lienType =
    cleanText(row["Lien Type"]) ||
    cleanText(row["Type"]) ||
    cleanText(row["FILE_TYPE"]) ||
    cleanText(row["Plaintiff"]) ||
    cleanText(row["Plantiff"]);
  const amount =
    cleanText(row["Amount"]) ||
    cleanText(row["AMOUNT"]);
  const filingDate =
    cleanText(row["Filing Date"]) ||
    cleanText(row["File Date"]) ||
    cleanText(row["FILING_DATE"]);
  const mailDate =
    cleanText(row["Mail Date"]) ||
    cleanText(row["MAIL_DATE"]);
  const abcSource = extractCsvSourceName(row);

  return [
    `ABC Source: ${abcSource || "N/A"}`,
    `Lien Type: ${lienType || "N/A"}`,
    `Amount: ${amount || "N/A"}`,
    `Filing Date: ${filingDate || "N/A"}`,
    `Mail Date: ${mailDate || "N/A"}`,
  ].join("\n");
}

function normalizeNcoaRow(row = {}) {
  const firstName = cleanText(row["First Name"]) || cleanText(row.FirstName);
  const lastName = cleanText(row["Last Name"]) || cleanText(row.LastName);
  const address =
    cleanText(row["Delivery Address"]) ||
    cleanText(row.Address) ||
    cleanText(row["Street Address"]);
  const city = cleanText(row.City);
  const state = cleanText(row.State)?.toUpperCase() || null;
  const zip = cleanZip(row["ZIP+4"] || row.ZIP || row.Zip);
  const cell =
    cleanPhone(row.Cell) ||
    cleanPhone(row["Cell Phone"]) ||
    cleanPhone(row.Phone) ||
    cleanPhone(row["Phone Number"]);
  const notes = toNotes(row);

  const csvSourceName = extractCsvSourceName(row);
  const sourceName = "ABC";

  // Pull the mail-intake specifics out as discrete fields so we can
  // persist them on the MailImport record (for CX matching tooltips
  // + audit trail) in addition to baking them into Logics' Notes via
  // toNotes().
  const lienType =
    cleanText(row["Lien Type"]) ||
    cleanText(row["Type"]) ||
    cleanText(row["FILE_TYPE"]);
  const plaintiff =
    cleanText(row["Plaintiff"]) ||
    cleanText(row["Plantiff"]);
  const amount =
    cleanText(row["Amount"]) || cleanText(row["AMOUNT"]);
  const filingDate =
    cleanText(row["Filing Date"]) ||
    cleanText(row["File Date"]) ||
    cleanText(row["FILING_DATE"]);
  const mailDate =
    cleanText(row["Mail Date"]) || cleanText(row["MAIL_DATE"]);

  return {
    firstName,
    lastName: lastName || "Prospect",
    address,
    city,
    state,
    zip,
    cell,
    notes,
    sourceName,
    mailIntake: {
      lienType,
      plaintiff,
      amount,
      filingDate,
      mailDate,
      csvSourceName,
    },
    raw: row,
  };
}

function parseNcoaCsv(csvText = "") {
  const { data } = Papa.parse(String(csvText || ""), {
    header: true,
    skipEmptyLines: true,
  });

  return (Array.isArray(data) ? data : [])
    .map(normalizeNcoaRow)
    .filter((row) => row.firstName || row.lastName || row.address || row.cell);
}

function parseLogicsPayload(payload) {
  const candidate = payload?.data ?? payload?.Data ?? payload;
  if (typeof candidate !== "string") return candidate;
  const text = candidate.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return candidate;
  }
}

function extractCaseId(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = extractCaseId(item);
      if (candidate) return candidate;
    }
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === "string") {
    const parsed = parseLogicsPayload(value);
    if (parsed !== value) return extractCaseId(parsed);
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }
  if (typeof value !== "object") return null;

  const directCandidate =
    value.CaseID ??
    value.caseId ??
    value.caseID ??
    value.ID ??
    value.Id ??
    value.id ??
    null;

  if (directCandidate != null) {
    const numeric = Number(directCandidate);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }

  const nested = value.data ?? value.Data ?? null;
  if (nested && nested !== value) {
    return extractCaseId(nested);
  }

  return null;
}

function buildNcoaCreateCasePayload(row) {
  return {
    FirstName: row.firstName || undefined,
    LastName: row.lastName || "Prospect",
    CellPhone: row.cell ? `(${row.cell.slice(0, 3)})${row.cell.slice(3, 6)}-${row.cell.slice(6)}` : undefined,
    Address: row.address || undefined,
    City: row.city || undefined,
    State: row.state || undefined,
    Zip: row.zip || undefined,
    Notes: row.notes,
    // Logics expects "ABC" as the SourceName for NCOA-uploaded
    // prospects. The previous "NCOA Upload" fallback didn't match
    // anything Logics tracks.
    SourceName: "ABC",
  };
}

/**
 * Build a resume-skip set from MailImport. Any row we already created
 * under the same `(domain, importBatch)` pair has its `cellPhone`
 * recorded — we use that as the dedup key so re-uploading the same
 * CSV after a partial run only sends the un-processed rows to Logics.
 * Rows without a phone fall back to lastName as a coarse key (rare;
 * NCOA without a phone is unusual).
 *
 * Returning a Set lets the loop short-circuit in O(1) per row.
 *
 * Historical note: this used to read from MasterProspectIndex (the
 * NCOA service mirrored mail-intake data there). MPI is now scoped
 * to the monthly filler-pool and gets aggressively GC'd, so its row
 * presence isn't a reliable resume signal. MailImport is the
 * authoritative store for "did we process this NCOA row already."
 */
async function buildResumeSkipSet(domain, importBatch) {
  if (!domain || !importBatch) return new Set();
  const rows = await MailImport.find(
    {
      domain,
      importBatch,
    },
    { cellPhone: 1, lastName: 1 },
  ).lean();
  const set = new Set();
  for (const row of rows) {
    const phone = cleanPhone(row.cellPhone);
    if (phone) set.add(`phone:${phone}`);
    if (row.lastName) set.add(`name:${String(row.lastName).trim().toLowerCase()}`);
  }
  return set;
}

function buildResumeKeyForRow(row) {
  if (row?.cell) return `phone:${row.cell}`;
  if (row?.lastName) return `name:${String(row.lastName).trim().toLowerCase()}`;
  return null;
}

/**
 * Aggregate per-row workflow stages for a given importBatch into a
 * progress snapshot the UI can poll. The frontend has no live channel
 * to the running upload — Express is holding one big POST — but the
 * service writes a workflow stage record per row as soon as the row
 * lands, so the ledger is the live source of truth.
 *
 * Returns a tally that mirrors the final upload-result envelope:
 * `{succeeded, failed, total, mostRecent: ISO}`. The total comes from
 * the upload-batch `requested` stage's payload when present.
 */
async function getNcoaUploadProgress(domain, importBatch) {
  if (!importBatch) {
    return {
      domain: String(domain || "").toUpperCase() || null,
      importBatch: null,
      total: 0,
      succeeded: 0,
      failed: 0,
      pending: 0,
      mostRecent: null,
      batchStarted: null,
      batchCompleted: null,
    };
  }
  const normalizedDomain = String(domain || "").toUpperCase() || null;
  const baseQuery = {
    family: "lexis",
    "payload.importBatch": importBatch,
    ...(normalizedDomain ? { domain: normalizedDomain } : {}),
  };

  // Per-row stages (subtype: "ncoa-upload") + batch envelope stages
  // (subtype: "ncoa-upload-batch") in a single round-trip; we split
  // them out client-side.
  const rows = await WorkflowRecord.find(baseQuery, {
    subtype: 1,
    stage: 1,
    happenedAt: 1,
    payload: 1,
    result: 1,
  })
    .sort({ happenedAt: 1 })
    .lean();

  let succeeded = 0;
  let failed = 0;
  let mostRecent = null;
  let total = 0;
  let batchStarted = null;
  let batchCompleted = null;
  let batchFailed = null;

  for (const stage of rows) {
    if (stage.subtype === "ncoa-upload-batch") {
      if (stage.stage === "requested") {
        batchStarted = stage.happenedAt || null;
        const declared = Number(stage.payload?.total);
        if (Number.isFinite(declared) && declared > 0) total = declared;
      }
      if (stage.stage === "completed") {
        batchCompleted = stage.happenedAt || null;
      }
      if (stage.stage === "failed") {
        batchFailed = stage.happenedAt || null;
      }
      continue;
    }
    if (stage.subtype !== "ncoa-upload") continue;
    if (stage.stage === "completed") succeeded += 1;
    else if (stage.stage === "failed") failed += 1;
    if (stage.happenedAt) {
      const ts = new Date(stage.happenedAt).getTime();
      if (!mostRecent || ts > new Date(mostRecent).getTime()) {
        mostRecent = stage.happenedAt;
      }
    }
  }

  // Fall back to row-count when the batch envelope hasn't landed yet
  // (eg the very first poll fires before `requested` stages flush).
  if (total === 0) total = succeeded + failed;
  const pending = Math.max(total - succeeded - failed, 0);

  // Stall detection — gives the UI a way to render "this looks stuck"
  // and stop spinning even if the upload mutation never resolved
  // (eg server crashed after writing the requested envelope but
  // before completed/failed). A run with no row activity in 5 min
  // and no terminal envelope is presumed dead. Operator can re-upload
  // to resume.
  const STALE_THRESHOLD_MS = 5 * 60 * 1000;
  const now = Date.now();
  const lastActivityMs = mostRecent
    ? new Date(mostRecent).getTime()
    : (batchStarted ? new Date(batchStarted).getTime() : null);
  const staleSinceMs =
    !batchCompleted && !batchFailed && lastActivityMs && pending > 0
      ? now - lastActivityMs
      : 0;
  const stalled = staleSinceMs > STALE_THRESHOLD_MS;
  const terminal = Boolean(batchCompleted || batchFailed || stalled);

  return {
    domain: normalizedDomain,
    importBatch,
    total,
    succeeded,
    failed,
    pending,
    mostRecent,
    batchStarted,
    batchCompleted,
    batchFailed,
    stalled,
    terminal,
    staleSinceMs,
  };
}

// Per-row work — Logics call + 3 Mongo writes + workflow stage. Returns
// the same shape the serial loop used so the result envelope stays
// identical. Errors caught locally so one bad row doesn't sink the
// whole batch when run inside a `Promise.all` map.
async function processNcoaRow({
  row,
  domain,
  importBatch,
  logicsClient,
  aggregateId,
  sourceService,
  emitRetryOnFailure,
}) {
  const payload = buildNcoaCreateCasePayload(row);
  try {
    const response = await logicsClient.createCase(payload);
    // Logics envelopes are inconsistent across endpoints — some
    // return `data` (lowercase), others `Data` (capital), and the
    // body sometimes nests under either. Walk every plausible path
    // before declaring failure.
    const dataPart = parseLogicsPayload(response);
    const firstNode = Array.isArray(dataPart) ? dataPart[0] : dataPart;
    const caseId =
      extractCaseId(firstNode) ||
      extractCaseId(response?.data) ||
      extractCaseId(response?.Data) ||
      extractCaseId(response);
    if (!caseId || !Number.isFinite(caseId)) {
      // Stash the raw response on the thrown error so the workflow
      // record's `result.error` shows what Logics actually returned —
      // helps diagnose tenant-specific envelope drift.
      const err = new Error("Logics did not return CaseID");
      err.details = { responseSnippet: JSON.stringify(response).slice(0, 400) };
      throw err;
    }

    // Persist to MailImport (the mail-intake-specific collection).
    // Was previously writing to MasterProspectIndex too — that path
    // is gone now: MPI is scoped to the monthly filler-pool, and
    // these rows aren't filler-pool members. MailImport is the
    // authoritative store for "this case came in via NCOA / Lexis /
    // mail-house return" with the source-specific metadata
    // attached. cxLeadLookupService joins to MailImport by
    // (domain, caseId) when the operator needs address+lien-type
    // context for a name/address candidate match.
    await MailImport.findOneAndUpdate(
      { domain, caseId },
      {
        $set: {
          firstName: row.firstName,
          lastName: row.lastName,
          cellPhone: row.cell,
          address: row.address || null,
          city: row.city || null,
          state: row.state || null,
          zip: row.zip || null,
          sourceName: row.sourceName || "ABC",
          intakeRoute: "ncoa-upload",
          partnerSource: "mail-house-return",
          importBatch,
          mailIntake: row.mailIntake,
          raw: row.raw,
        },
        $setOnInsert: {
          domain,
          caseId,
        },
      },
      { upsert: true, setDefaultsOnInsert: true, new: true },
    );

    await leadCadenceRepository.upsertLeadCadence(domain, caseId, {
      intakeRoute: "ncoa-upload",
      intakeSource: row.sourceName || "ABC",
      partnerSource: "mail-house-return",
      firstName: row.firstName,
      lastName: row.lastName,
      name: [row.firstName, row.lastName].filter(Boolean).join(" ").trim() || row.lastName,
      primaryPhone: row.cell,
      normalizedPhone: row.cell,
      city: row.city,
      state: row.state,
      sourceName: row.sourceName || "ABC",
      active: false,
      currentStage: "ncoa-uploaded",
      payloadSnapshot: {
        address: row.address,
        zip: row.zip,
        notes: row.notes,
        raw: row.raw,
      },
    });

    await recordWorkflowStage({
      domain,
      family: "lexis",
      subtype: "ncoa-upload",
      stage: "completed",
      aggregateType: "case",
      aggregateId: String(caseId),
      caseId,
      sourceService,
      title: "NCOA row uploaded to Logics",
      summary: `${row.firstName || ""} ${row.lastName || ""}`.trim() || "NCOA upload",
      payload: {
        importBatch,
        sourceName: row.sourceName || "ABC",
        address: row.address,
        city: row.city,
        state: row.state,
        zip: row.zip,
      },
      result: {
        caseId,
        response,
      },
    });

    return { ok: true, caseId, row, response };
  } catch (error) {
    if (emitRetryOnFailure) {
      await emitHourlyJobEvent({
        lane: "hourly",
        domain,
        eventType: "ncoa.logics.create.retry",
        targetService: "control-plane",
        handlerKey: "retryNcoaCreateCase",
        aggregateType: "ncoa-upload-row",
        aggregateId: `${aggregateId}:${row.cell || row.lastName || "unknown"}`,
        caseId: null,
        payload: {
          importBatch,
          row,
        },
        resolutionCheckKey: "logics-case-visible",
        resolutionContext: {
          phone: row.cell || null,
          email: row.email || null,
          lastName: row.lastName || null,
        },
        dedupeKey: `${String(domain || "").toUpperCase()}:ncoa:${importBatch}:${row.cell || row.lastName || "unknown"}`,
        emittedBy: sourceService,
        priority: 60,
        severity: "warning",
        immediateRetryAttempts: 1,
        immediateRetryDelayMs: 1000,
        provideSummary: false,
        firstError: error.message,
        notify: false,
      }).catch(() => null);
    }
    await recordWorkflowStage({
      domain,
      family: "lexis",
      subtype: "ncoa-upload",
      stage: "failed",
      aggregateType: "ncoa-upload-row",
      aggregateId: `${aggregateId}:${row.cell || row.lastName || "unknown"}`,
      sourceService,
      status: "failed",
      title: "NCOA row upload failed",
      summary: `${row.firstName || ""} ${row.lastName || ""}`.trim() || "NCOA row",
      payload: {
        importBatch,
        address: row.address,
        city: row.city,
        state: row.state,
        zip: row.zip,
      },
      result: {
        error: error.message,
      },
    });
    return { ok: false, row, error: error.message };
  }
}

// Batch + breath — the legacy TagContactBridge `postNCOA` runs Logics
// createCase calls 100-at-a-time with `Promise.all` and a 200ms pause
// between batches. Logics handles that fanout cleanly. Mirroring the
// exact shape so we don't reinvent rate-shaping behavior that's
// already proven safe against this API.
const NCOA_BATCH_SIZE = 100;
const NCOA_BATCH_DELAY_MS = 200;

async function uploadNcoaRows(rows = [], options = {}) {
  const domain = String(options.domain || "TAG").trim().toUpperCase() || "TAG";
  const importBatch = cleanText(options.importBatch) || `ncoa-${new Date().toISOString().slice(0, 10)}`;
  const emitRetryOnFailure = options.emitRetryOnFailure !== false;
  const skipAlreadyUploaded = options.skipAlreadyUploaded !== false;
  const sourceService = options.sourceService || "control-plane";
  const batchSize = Math.max(Number(options.batchSize) || NCOA_BATCH_SIZE, 1);
  const batchDelayMs = Math.max(Number(options.batchDelayMs ?? NCOA_BATCH_DELAY_MS), 0);
  const logicsClient = createLogicsClient(domain);
  const results = [];
  const aggregateId = `${importBatch}-${Date.now()}`;
  // Tracks whether we've emitted a terminal stage (completed/failed)
  // for this batch envelope. The finally block uses this to ensure
  // we ALWAYS emit one — without this guarantee, a thrown error
  // mid-loop leaves the workflow ledger showing `pending > 0`
  // forever and the UI's progress strip never resolves.
  let terminalStageEmitted = false;

  // Resume support — when the prior run died mid-loop (Node request
  // timeout, agent crash, etc.) the rows that DID land are still in
  // Mongo. Pre-load that set so the re-run only ships the unprocessed
  // rows to Logics. Operator has to re-upload the same CSV / pass the
  // same `importBatch`; we identify that by file name today.
  const resumeSkipSet = skipAlreadyUploaded
    ? await buildResumeSkipSet(domain, importBatch)
    : new Set();
  let resumeSkipped = 0;
  const pendingRows = [];
  for (const row of rows) {
    const resumeKey = buildResumeKeyForRow(row);
    if (resumeKey && resumeSkipSet.has(resumeKey)) {
      resumeSkipped += 1;
      results.push({
        ok: true,
        skipped: true,
        skipReason: "already-uploaded-this-batch",
        row,
      });
    } else {
      pendingRows.push(row);
    }
  }

  await recordWorkflowStage({
    domain,
    family: "lexis",
    subtype: "ncoa-upload-batch",
    stage: "requested",
    aggregateType: "ncoa-upload",
    aggregateId,
    sourceService,
    title: "NCOA upload requested",
    summary: `Uploading ${pendingRows.length}/${rows.length} NCOA row(s) to Logics`,
    payload: {
      importBatch,
      total: rows.length,
      pending: pendingRows.length,
      resumeSkipCandidates: resumeSkipSet.size,
      resumeSkipped,
      batchSize,
      batchDelayMs,
    },
  });

  try {
    for (let offset = 0; offset < pendingRows.length; offset += batchSize) {
      const slice = pendingRows.slice(offset, offset + batchSize);
      // Per-row helper has its own try/catch and converts errors into
      // `{ok:false}` results, so `Promise.all` won't reject under
      // normal failure conditions. A genuine unexpected throw (eg
      // mongo connection death, out-of-memory) WILL propagate, and
      // the finally block below makes sure we still emit a terminal
      // batch envelope so the UI's progress strip can resolve.
      const sliceResults = await Promise.all(
        slice.map((row) =>
          processNcoaRow({
            row,
            domain,
            importBatch,
            logicsClient,
            aggregateId,
            sourceService,
            emitRetryOnFailure,
          }),
        ),
      );
      results.push(...sliceResults);
      if (batchDelayMs > 0 && offset + batchSize < pendingRows.length) {
        await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
      }
    }

    const result = {
      domain,
      importBatch,
      total: rows.length,
      succeeded: results.filter((item) => item.ok && !item.skipped).length,
      failed: results.filter((item) => !item.ok).length,
      skipped: resumeSkipped,
      results,
    };

    await recordWorkflowStage({
      domain,
      family: "lexis",
      subtype: "ncoa-upload-batch",
      stage: "completed",
      aggregateType: "ncoa-upload",
      aggregateId,
      sourceService,
      title: "NCOA upload completed",
      summary: `${result.succeeded} succeeded, ${result.failed} failed`,
      result,
    });
    terminalStageEmitted = true;

    return result;
  } finally {
    // Failsafe — if we threw before emitting the `completed` stage,
    // emit a `failed` envelope so the UI's progress strip can
    // resolve. Best-effort: a thrown mongo error here would mean
    // we can't write the failure either, but at that point the
    // request is clearly in an error state and the route handler
    // returns 500 anyway.
    if (!terminalStageEmitted) {
      await recordWorkflowStage({
        domain,
        family: "lexis",
        subtype: "ncoa-upload-batch",
        stage: "failed",
        aggregateType: "ncoa-upload",
        aggregateId,
        sourceService,
        title: "NCOA upload aborted",
        summary: `Aborted with ${results.filter((item) => item.ok && !item.skipped).length} succeeded, ${results.filter((item) => !item.ok).length} failed before throw`,
        result: {
          domain,
          importBatch,
          total: rows.length,
          succeededBeforeThrow: results.filter((item) => item.ok && !item.skipped).length,
          failedBeforeThrow: results.filter((item) => !item.ok).length,
          skipped: resumeSkipped,
        },
      }).catch(() => null);
    }
  }
}

/**
 * Proactively close stale NCOA upload batches. Runs from the
 * hourly sweep — finds batches that emitted a `requested` envelope
 * but never `completed`/`failed`, and have had no row activity
 * for >`maxStaleMs`. Stamps a `failed` envelope on each so the
 * workflow ledger is consistent (terminal stage exists) and the
 * progress endpoint flips `terminal: true` instead of staying in
 * stalled-but-pending limbo.
 *
 * The third leg of the resilience triad:
 *   - happy path:   try/finally in `uploadNcoaRows` writes `completed`
 *   - thrown path:  same finally writes `failed` failsafe
 *   - dead-process path: this sweep catches batches whose process
 *                   died mid-flight (no in-process finally fired)
 *
 * Idempotent — re-running picks up nothing new because the previous
 * pass stamped a `failed` envelope and `batchFailed` is now set.
 */
async function sweepStaleNcoaBatches({
  maxStaleMs = 30 * 60 * 1000, // 30 min — generous; uploads are slow
  limit = 50,
  sourceService = "ncoa-stale-sweep",
} = {}) {
  const now = new Date();
  const ageCutoff = new Date(now.getTime() - maxStaleMs);

  // Find unique importBatch values that have a `requested` stage
  // older than the cutoff but no terminal stage afterward.
  const requestedStages = await WorkflowRecord.find({
    family: "lexis",
    subtype: "ncoa-upload-batch",
    stage: "requested",
    happenedAt: { $lt: ageCutoff },
  })
    .sort({ happenedAt: -1 })
    .limit(limit * 4) // pull more than `limit` since some will already be terminal
    .lean();

  const candidates = [];
  for (const stage of requestedStages) {
    const importBatch = stage.payload?.importBatch;
    if (!importBatch) continue;
    // Skip if a terminal envelope already exists for this batch.
    const terminal = await WorkflowRecord.findOne({
      family: "lexis",
      subtype: "ncoa-upload-batch",
      stage: { $in: ["completed", "failed"] },
      "payload.importBatch": importBatch,
    }).lean();
    if (terminal) continue;
    candidates.push({ importBatch, requestedAt: stage.happenedAt, payload: stage.payload, domain: stage.domain });
    if (candidates.length >= limit) break;
  }

  const closed = [];
  for (const candidate of candidates) {
    // Only close if no row stages have landed in the last
    // `maxStaleMs`. If rows are still landing, the batch is alive
    // — just slow.
    const recentRow = await WorkflowRecord.findOne({
      family: "lexis",
      subtype: "ncoa-upload",
      "payload.importBatch": candidate.importBatch,
      happenedAt: { $gte: ageCutoff },
    }).lean();
    if (recentRow) continue;

    await recordWorkflowStage({
      domain: candidate.domain,
      family: "lexis",
      subtype: "ncoa-upload-batch",
      stage: "failed",
      aggregateType: "ncoa-upload",
      aggregateId: `${candidate.importBatch}-stale-sweep-${now.getTime()}`,
      sourceService,
      title: "NCOA upload aborted by stale-sweep",
      summary: `No row activity in >${Math.round(maxStaleMs / 60000)}m; closing batch envelope`,
      result: {
        importBatch: candidate.importBatch,
        requestedAt: candidate.requestedAt,
        sweepClosedAt: now,
        reason: "stale-no-activity",
      },
    }).catch(() => null);

    closed.push({
      importBatch: candidate.importBatch,
      domain: candidate.domain,
      requestedAt: candidate.requestedAt,
    });
  }

  return {
    inspected: candidates.length,
    closed: closed.length,
    closedBatches: closed,
  };
}

module.exports = {
  buildNcoaCreateCasePayload,
  extractCaseId,
  getNcoaUploadProgress,
  normalizeNcoaRow,
  parseNcoaCsv,
  parseLogicsPayload,
  sweepStaleNcoaBatches,
  uploadNcoaRows,
};
