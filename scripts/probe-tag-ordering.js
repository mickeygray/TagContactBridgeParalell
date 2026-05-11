"use strict";

// Compare TAG status=2 cases ordered by CaseID (orderByCreatedDate=true)
// vs. ModifiedDate (default). For each, fetch the first 500 cases past
// caseId >= 50000 (the modern-mail-era floor) and count how many have
// a callable cell phone. Helps decide which sort order yields more
// usable phones for the filler pool.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { createLogicsClient } = require("../packages/shared-integrations/src");

const CASE_ID_FLOOR = 50000;
const SAMPLE_SIZE = 500;
const CONCURRENCY = 20;

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

async function runConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let inflight = 0;
  let nextIndex = 0;
  let completed = 0;
  return new Promise((resolve, reject) => {
    function pump() {
      while (inflight < concurrency && nextIndex < items.length) {
        const myIndex = nextIndex;
        nextIndex += 1;
        inflight += 1;
        Promise.resolve()
          .then(() => fn(items[myIndex]))
          .then((value) => {
            results[myIndex] = value;
            completed += 1;
            inflight -= 1;
            if (completed === items.length) resolve(results);
            else pump();
          })
          .catch(reject);
      }
    }
    if (items.length === 0) resolve(results);
    else pump();
  });
}

async function fetchCaseInfoSafe(client, caseId) {
  try {
    const r = await client.getCaseInfo(caseId);
    return r?.data || r?.Data || r;
  } catch {
    return null;
  }
}

function summarize(caseInfo) {
  const cellRaw = caseInfo?.CellPhone || caseInfo?.cellPhone || "";
  const homeRaw = caseInfo?.HomePhone || caseInfo?.homePhone || "";
  const workRaw = caseInfo?.WorkPhone || caseInfo?.workPhone || "";
  return {
    caseId: Number(caseInfo?.CaseID || caseInfo?.caseId),
    cell: normalizePhone(cellRaw),
    home: normalizePhone(homeRaw),
    work: normalizePhone(workRaw),
    createdDate: caseInfo?.CreatedDate || caseInfo?.createdDate || null,
    statusId: caseInfo?.StatusID,
  };
}

function unwrapIds(payload) {
  const data = payload?.data || payload?.Data || payload;
  if (!Array.isArray(data)) return [];
  return data
    .map((v) => Number.isFinite(Number(v))
      ? Number(v)
      : Number(v?.CaseID || v?.caseId || v?.ID))
    .filter((v) => Number.isFinite(v));
}

async function probe(label, idsRaw) {
  const ids = idsRaw.filter((id) => id >= CASE_ID_FLOOR).slice(0, SAMPLE_SIZE);
  console.log(`\n[${label}] fetching ${ids.length} cases (caseId >= ${CASE_ID_FLOOR}, first 500)...`);

  const cases = await runConcurrent(ids, CONCURRENCY, (id) => fetchCaseInfoSafe(client, id));
  const summaries = cases.filter(Boolean).map(summarize);

  let withCell = 0;
  let withHome = 0;
  let withWork = 0;
  let withAnyPhone = 0;
  let oldestCreated = null;
  let newestCreated = null;
  for (const s of summaries) {
    if (s.cell) withCell += 1;
    if (s.home) withHome += 1;
    if (s.work) withWork += 1;
    if (s.cell || s.home || s.work) withAnyPhone += 1;
    if (s.createdDate) {
      const t = new Date(s.createdDate).getTime();
      if (Number.isFinite(t)) {
        if (oldestCreated === null || t < oldestCreated) oldestCreated = t;
        if (newestCreated === null || t > newestCreated) newestCreated = t;
      }
    }
  }

  console.log(`  scanned:           ${summaries.length}`);
  console.log(`  withCell (filler-eligible):  ${withCell} (${Math.round(withCell / summaries.length * 100)}%)`);
  console.log(`  withHome:                    ${withHome} (${Math.round(withHome / summaries.length * 100)}%)`);
  console.log(`  withWork:                    ${withWork} (${Math.round(withWork / summaries.length * 100)}%)`);
  console.log(`  withAnyPhone:                ${withAnyPhone} (${Math.round(withAnyPhone / summaries.length * 100)}%)`);
  if (oldestCreated && newestCreated) {
    console.log(`  createDate range: ${new Date(oldestCreated).toISOString().slice(0, 10)} .. ${new Date(newestCreated).toISOString().slice(0, 10)}`);
  }
  console.log(`  caseId range:     ${ids[0]} .. ${ids[ids.length - 1]}`);
  return { withCell, withAnyPhone, scanned: summaries.length, oldestCreated, newestCreated };
}

const client = createLogicsClient("TAG");

(async () => {
  console.log(`══ TAG ordering probe ══`);
  console.log(`  filter: caseId >= ${CASE_ID_FLOOR}, sample first ${SAMPLE_SIZE} per ordering`);
  console.log(`  concurrency: ${CONCURRENCY}`);

  // 1. orderByCreatedDate: true → sorted by CaseID desc
  const byCaseIdPayload = await client.getCasesByStatus(2, { orderByCreatedDate: true });
  const byCaseIdIds = unwrapIds(byCaseIdPayload);
  console.log(`\n[CaseID-desc] returned ${byCaseIdIds.length} ids; first 3: ${byCaseIdIds.slice(0, 3).join(", ")}`);

  // 2. orderByCreatedDate omitted (default false) → sorted by ModifiedDate desc
  const byModifiedPayload = await client.getCasesByStatus(2);
  const byModifiedIds = unwrapIds(byModifiedPayload);
  console.log(`[ModifiedDate-desc] returned ${byModifiedIds.length} ids; first 3: ${byModifiedIds.slice(0, 3).join(", ")}`);

  // Run probes back-to-back
  const caseIdResult = await probe("CaseID-desc (createDate)", byCaseIdIds);
  const modifiedResult = await probe("ModifiedDate-desc", byModifiedIds);

  console.log(`\n══ Summary ══`);
  console.log(`  CaseID order:    ${caseIdResult.withCell} cell phones in 500 (${Math.round(caseIdResult.withCell / caseIdResult.scanned * 100)}%)`);
  console.log(`  Modified order:  ${modifiedResult.withCell} cell phones in 500 (${Math.round(modifiedResult.withCell / modifiedResult.scanned * 100)}%)`);
  const winner = modifiedResult.withCell > caseIdResult.withCell ? "Modified" : "CaseID";
  console.log(`  → ${winner}-date ordering yields more cell phones for filler pool`);
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
