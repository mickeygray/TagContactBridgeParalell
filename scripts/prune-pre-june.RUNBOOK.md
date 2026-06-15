# Runbook — Pre-June Operational-Bloat Prune (5:00 PM run)

**Scheduled:** 2026-06-15, 5:00 PM PT
**Script:** `scripts/prune-pre-june-operational-bloat.js` (gates in `scripts/lib/pruneSafety.js`)
**Database:** `tagcontactbridge_parallel` (live floor) — uses `MONGO_URI` from `.env`
**Cutoff:** delete docs dated **before `2026-06-01T07:00:00.000Z`** (June 1 midnight Pacific)

> **Design principle:** this script does its own verification. There is **no "check the report by hand before deleting" step** — the script backs up, *verifies the backup before deleting*, deletes only what it backed up, and proves live work was untouched. If any check fails it **aborts and deletes nothing further**, printing the failing gate. You do not need to babysit it; you need to read the final line (PASS/abort) and keep the dump.

---

## TL;DR

**Read June evidence first (read-only, no metric repair):**

```bash
node scripts/audit-june-metric-reconcile.js --month 2026-06 --out runtime/metric-reconcile/2026-06-metric-reconcile-before-prune.json
```

That report includes `metricRestoreCandidates`, which is a JSON list of June log
signals that might help reconcile TAG/WYNN metrics later. It does not patch metrics,
case profiles, payment ledgers, spend rows, or logs.

```bash
# from repo root: c:/code/tagcontactbridgeparalell
node scripts/prune-pre-june-operational-bloat.js            # 1. dry-run rehearsal (read-only)
node scripts/prune-pre-june-operational-bloat.js --apply    # 2. the real run (self-verifying)
```

**Expected result of `--apply`:** exit code 0, with each target showing `dumped == verifiedLines == deleted` and `preservedLive` unchanged — **these per-target relational checks are what the script actually enforces.** The absolute totals will be **≈** `deleted: 310744` / `preservedLive: 146983` (from the latest dry-run) — approximate, drifts with the day's jobs, and **not** asserted by any gate. Dumps + report land in `runtime/mongo-retention/`.

---

## 1. Pre-flight (the only human checks — both are also enforced by the script)

1. **Confirm `MONGO_URI` points at production `tagcontactbridge_parallel`.** The script refuses to run otherwise (gate **G1**: asserts the connected DB name *and* that known app collections exist), but confirm anyway so you're not surprised by an abort.
2. **Disk headroom for the backup.** The run writes ~310k documents as gzipped JSONL under `runtime/mongo-retention/<runId>/`. Estimate a few hundred MB free. If the disk fills mid-dump, the backup ends up short and gate **G2** aborts *before* deleting — fail-safe, but you'd have to retry.

Everything else (backup integrity, terminal-only scoping, delete accounting, live-work preservation) is checked by the script.

---

## 2. What the run does

Deletes **terminal / safe** pre-June rows from 6 collections and **preserves every live/open item**. Per the latest dry-run:

| Collection | Deleted (pre-June, safe) | **Preserved (live/open — untouched)** | Why preserved |
|---|--:|--:|---|
| `controlplaneworkflowrecords` | 182,647 | 0 | append-only audit; safe to drop wholesale |
| `eventrecords` | 33,517 | **37,499** | live = `pending`/`failed`/`replayed` claimable by `claimNextEvent` |
| `hourlyjobevents` | 3,625 | **970** | live = `pending`/`failed` claimable by `claimNextHourlyJobEvent` |
| `controlplanereviewqueueitems` | 1 | **108,514** | `open` items still surface in the review UI/badge |
| `livecoach_sessions` | 0 | 0 | no pre-June rows |
| `legacy_raw_controlplanemasterprospectindexes` | 90,954 | 0 | orphaned migration copy; zero readers |
| **TOTAL** | **310,744** | **146,983** | |

Only `completed`/`dead-letter` (events, hourly jobs) and `reviewed`/`dismissed` (review items) are deleted from the queue-like collections. Events and hourly jobs are **never** opened up to live-status deletion by any flag.

### The four gates (all fail-closed → abort, delete nothing further)

- **G1 — target DB:** connected DB is `tagcontactbridge_parallel` and contains known app collections. *(before anything)*
- **G2 — backup complete:** the gz backup's line-count equals the number of `_id`s captured for deletion, and a sample is EJSON-parsed to confirm real `_id`s are on disk. *(before each delete)* The *exact-ids* guarantee itself comes from delete-by-captured-ids (G3), not from this count check.
- **G3 — delete accounting:** deleted count equals the backed-up count. *(after each delete)*
- **G4 — live untouched:** the preserved (live/open) count is identical before and after. *(after each delete)*

Underneath G3/G4: the script deletes **only the specific `_id`s it captured into the verified backup**, so a live/open row can't be deleted even in principle.

---

## 3. Run procedure

### Step 1 — Dry-run rehearsal (read-only, no writes)
```bash
node scripts/prune-pre-june-operational-bloat.js
```
Confirm the printed `totals` reads `"matched": 310744, "preservedLive": 146983`. (Numbers drift slightly as the day's jobs complete — that's normal; they should be in the same ballpark.)

### Step 2 — The real run
```bash
node scripts/prune-pre-june-operational-bloat.js --apply
```
This backs up → verifies → deletes → proves-live-untouched, per collection. It prints a JSON report and writes it to `runtime/mongo-retention/<runId>.report.json`.

**Optional — stage it** (run the zero-risk bulk first, then the guarded queues). Each `--only` run is independently gated:
```bash
node scripts/prune-pre-june-operational-bloat.js --apply \
  --only legacy_raw_controlplanemasterprospectindexes,controlplaneworkflowrecords   # 273,601 docs
node scripts/prune-pre-june-operational-bloat.js --apply \
  --only eventrecords,hourlyjobevents,controlplanereviewqueueitems                  # 37,143 docs (terminal only)
```

---

## 4. Success criteria (read the final report)

The run **succeeded** if the report shows:

- `"mode": "apply"` and a non-error exit (exit code 0).
- `totals.deleted` ≈ **310,744** (sanity sniff only — approximate, drifts with the day's jobs, **not** enforced by any gate).
- `totals.dumped == totals.verifiedLines == totals.deleted` — backup, verification, and deletion all agree (this *is* enforced, per target).
- Each guarded target has `preservedLive == preservedAfter` (G4 held; printed per target).
- Dump files exist: `runtime/mongo-retention/<runId>/<runId>.<collection>.jsonl.gz`.

If you see any of the gate strings (`G1 …`, `G2 … backup INCOMPLETE`, `G3 … delete MISMATCH`, `G4 … PRESERVED LIVE COUNT CHANGED`) the run **stopped at that point**. Everything already deleted in that run is in the dump. Do not re-run blindly — read the message, then see §6.

---

## 5. Restore (if anything looks wrong)

One command, idempotent (re-inserting existing rows is skipped as duplicates):
```bash
node scripts/prune-pre-june-operational-bloat.js --restore <runId>
```
`<runId>` is the timestamped folder name under `runtime/mongo-retention/` (also in the report as part of `reportPath`/`dumpDir`). It re-inserts from the canonical-EJSON dumps with original `_id`s, dates, and BSON types intact. Restrict to one collection with `--only <collection>` if needed.

---

## 6. Failure handling

| Symptom | Meaning | Action |
|---|---|---|
| `G1 refusing to run …` | wrong/empty/surprise DB | fix `MONGO_URI` / `PARALLEL_DB_NAME`; re-run. Nothing was touched. |
| `G2 … backup INCOMPLETE` / dump file missing | backup didn't fully write (e.g. disk) | free disk; re-run. **No deletes happened for that collection.** |
| `G3 … delete MISMATCH` | deleted count ≠ backed-up count (concurrent writer?) | stop; the dump is the source of truth. Investigate before re-running; `--restore` if needed. |
| `G4 … PRESERVED LIVE COUNT CHANGED` | a live/open row count moved during the run | stop immediately; `--restore <runId>`; escalate — this should be structurally impossible. |
| Process crashed mid-run | partial progress | Safe: deletes were id-scoped and already backed up. Re-run `--apply` — it does **not** resume the prior run; it makes a fresh full pass over rows that still match (already-deleted rows are gone, so the net effect converges) and writes a **new** `runId`/dump. Keep the prior partial run's dump for restore. |

---

## 7. DO NOT (tonight)

- **Do not pass `--include-open-review`.** It would also delete the 108,514 open review items — including **1,428 `attribution-review`** rows tied to metrics-accuracy work and the 12 `critical` items. That cleanup is a separate, surgical follow-up.
- **Do not** hand-edit the dump files or delete `runtime/mongo-retention/<runId>/` until you've confirmed the app is healthy post-run — that folder *is* the backup.

---

## 8. Known / deferred (not part of this run)

- **Preserved backlog:** 37,499 events + 970 hourly jobs in live status are intentionally kept. Some may be zombies (no live worker). Triage separately — do not force-delete them.
- **Metrics follow-ups (independent of this prune):** TAG payment-ledger source is ~91% "Unknown" (attribution backfill), and LD spend is materialized for only 2026-06-12 (run the materializer across June). These don't touch the prune's collections.

---

## Appendix — flags & paths

| Flag | Effect |
|---|---|
| *(none)* | dry-run; read-only; prints matched/preserved counts |
| `--apply` | run for real (always backs up + verifies first) |
| `--only a,b` | restrict to named collections |
| `--skip a,b` | exclude named collections |
| `--cutoff <ISO>` | override cutoff (default `2026-06-01T07:00:00.000Z`) |
| `--out-dir <path>` | override output dir (default `runtime/mongo-retention`) |
| `--restore <runId>` | re-insert from a prior run's dumps |
| `--include-open-review` | **(do not use tonight)** also delete pre-June `open` review items |

- **Report:** `runtime/mongo-retention/<runId>.report.json`
- **Dumps:** `runtime/mongo-retention/<runId>/<runId>.<collection>.jsonl.gz`
- **Tests (green):** `tests/mongo-retention/pruneSafety.test.js` (10 unit, incl. abort paths) + `tests/mongo-retention/prunePipeline.integration.test.js` (backup→delete→restore round-trip on a throwaway DB)
