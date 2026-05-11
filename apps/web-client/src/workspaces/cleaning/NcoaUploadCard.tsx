import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  Upload,
  XCircle,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusPill } from "@/components/ui/StatusPill";
import { toast } from "@/components/ui/Toaster";
import {
  useNcoaPreview,
  useNcoaProgress,
  useNcoaUpload,
} from "@/lib/api/queries/lexis";
import type {
  NcoaPreviewResult,
  NcoaUploadProgress,
  NcoaUploadResult,
} from "@/lib/api/queries/lexis";
import { formatNumber } from "@/lib/utils/format";

/**
 * NCOA / Lexis CSV → Logics → MasterProspect upload flow.
 *
 * 1. User picks a CSV. FE calls `/api/lexis/ncoa/preview` to validate shape
 *    (shows first 25 normalized rows + total parsed).
 * 2. User clicks Upload. FE calls `/api/lexis/ncoa/upload` which per-row:
 *      - POSTs to Logics createCase, gets CaseID back
 *      - Upserts MasterProspectIndex with statusId=2, statusCategory=prospect
 *      - Upserts LeadCadence
 *      - Writes workflow stages (batch + per-row + completed)
 * 3. Result panel shows succeeded/failed counts.
 */
export function NcoaUploadCard() {
  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<NcoaPreviewResult | null>(null);
  const [result, setResult] = React.useState<NcoaUploadResult | null>(null);
  // Track the batch identifier for the in-flight upload so the
  // progress poll can scope to it. We use the file name today (same
  // value the backend defaults to when no `importBatch` is supplied).
  const [activeImportBatch, setActiveImportBatch] = React.useState<string | null>(null);

  const previewMutation = useNcoaPreview();
  const uploadMutation = useNcoaUpload();

  // Live progress poll. Stays active while the upload mutation is
  // pending OR while we have an active batch the server hasn't yet
  // reported terminal (handles the post-disconnect "is the server
  // still working?" window). Once the server reports `terminal: true`
  // (completed / failed / stalled), polling stops — the strip switches
  // to its final-tally rendering. This is the safety net for the
  // infinite-spin case: even if the upload mutation never resolves,
  // the server-side stall detector flips terminal=true after 5min
  // of inactivity and the UI resolves cleanly.
  const lastProgress = React.useRef<NcoaUploadProgress | null>(null);
  const progressActive =
    Boolean(activeImportBatch) &&
    (uploadMutation.isPending || lastProgress.current?.terminal !== true);
  const progressQuery = useNcoaProgress(activeImportBatch, progressActive);
  const progress = progressQuery.data;
  React.useEffect(() => {
    if (progress) lastProgress.current = progress;
  }, [progress]);

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  function reset() {
    setFile(null);
    setPreview(null);
    setResult(null);
    setActiveImportBatch(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0] ?? null;
    setFile(next);
    setPreview(null);
    setResult(null);
    if (!next) return;
    try {
      const p = await previewMutation.mutateAsync(next);
      setPreview(p);
    } catch (err) {
      toast.error("Could not parse CSV", {
        description: (err as Error).message,
      });
    }
  }

  async function onUpload() {
    if (!file) return;
    const importBatch = file.name;
    setActiveImportBatch(importBatch);
    try {
      const r = await uploadMutation.mutateAsync({
        file,
        importBatch,
      });
      setResult(r);
      const skippedNote = r.skipped && r.skipped > 0
        ? ` · ${r.skipped} skipped (already uploaded)`
        : "";
      toast.success("NCOA upload complete", {
        description: `${r.succeeded} created · ${r.failed} failed${skippedNote}`,
      });
    } catch (err) {
      // The connection may have died after the server kept processing
      // (Node 22 default 5-min request timeout used to bite us; the
      // backend now allows 2h, but proxies/network can still drop).
      // We leave `activeImportBatch` set so the progress poll can keep
      // showing the tally and the operator can decide to re-upload
      // (which will resume — backend skips rows already landed).
      toast.error("Upload connection lost", {
        description:
          `${(err as Error).message}. The server may still be processing — check the live progress below, then re-upload the same file to resume.`,
      });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileUp className="h-4 w-4 text-muted-foreground" />
          NCOA / Lexis prospect upload
        </CardTitle>
        <CardDescription>
          Uploads each row as a Logics case (status 2 · prospect) and writes
          the returned CaseID to the master prospect list.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={onFileChange}
            className="block w-full max-w-sm text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-primary-foreground file:hover:bg-primary/90"
          />
          {previewMutation.isPending ? (
            <StatusPill tone="info" dotted>
              Parsing…
            </StatusPill>
          ) : null}
        </div>

        {preview ? (
          <div className="space-y-3 rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-center gap-3">
              <StatusPill tone="success" dotted>
                {formatNumber(preview.total)} row{preview.total === 1 ? "" : "s"} parsed
              </StatusPill>
              <span className="text-xs text-muted-foreground">
                First {Math.min(preview.rows.length, 25)} previewed below.
              </span>
            </div>
            <div className="max-h-[280px] overflow-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Name</th>
                    <th className="px-2 py-1.5 text-left">Phone</th>
                    <th className="px-2 py-1.5 text-left">City, State</th>
                    <th className="px-2 py-1.5 text-left">ZIP</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => (
                    <tr key={i} className="border-t border-border/60">
                      <td className="px-2 py-1">
                        {[row.firstName, row.lastName].filter(Boolean).join(" ") || "—"}
                      </td>
                      <td className="px-2 py-1 font-mono">{row.cell ?? "—"}</td>
                      <td className="px-2 py-1">
                        {[row.city, row.state].filter(Boolean).join(", ") || "—"}
                      </td>
                      <td className="px-2 py-1 font-mono">{row.zip ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={reset}
                disabled={uploadMutation.isPending}
              >
                Clear
              </Button>
              <Button
                size="sm"
                onClick={onUpload}
                isLoading={uploadMutation.isPending}
                disabled={preview.total === 0}
              >
                <Upload className="h-3.5 w-3.5" />
                Upload {formatNumber(preview.total)} to Logics
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              The upload runs serially — one Logics call per row. Expect ~1s
              per row. Live progress shows below while the upload is running.
            </p>
          </div>
        ) : null}

        {/* Live-progress strip — only renders while the upload mutation
            is in flight (or has touched the workflow ledger but not yet
            populated `result`). Backed by the polled progress endpoint
            so it survives slow Logics calls and reflects the truth even
            if the connection drops mid-batch. */}
        {progress && (uploadMutation.isPending || (!result && progress.total > 0)) ? (
          <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-4">
            <div className="flex flex-wrap items-center gap-2">
              {progress.batchFailed ? (
                <StatusPill tone="danger">
                  <XCircle className="h-3.5 w-3.5" />
                  Aborted server-side
                </StatusPill>
              ) : progress.stalled ? (
                <StatusPill tone="warning">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Stalled — no activity for 5+ min
                </StatusPill>
              ) : progress.batchCompleted ? (
                <StatusPill tone="success" dotted>
                  Completed
                </StatusPill>
              ) : (
                <StatusPill tone="info" dotted>
                  {uploadMutation.isPending ? "Uploading…" : "Last seen"}
                </StatusPill>
              )}
              <span className="text-xs text-muted-foreground">
                batch <span className="font-mono">{progress.importBatch}</span>
              </span>
            </div>
            <div className="grid grid-cols-3 gap-3 text-xs">
              <div>
                <div className="uppercase tracking-[0.12em] text-muted-foreground">
                  Created
                </div>
                <div className="text-lg font-semibold text-emerald-700">
                  {formatNumber(progress.succeeded)}
                </div>
              </div>
              <div>
                <div className="uppercase tracking-[0.12em] text-muted-foreground">
                  Failed
                </div>
                <div className="text-lg font-semibold text-rose-700">
                  {formatNumber(progress.failed)}
                </div>
              </div>
              <div>
                <div className="uppercase tracking-[0.12em] text-muted-foreground">
                  Pending
                </div>
                <div className="text-lg font-semibold">
                  {formatNumber(progress.pending)}
                </div>
              </div>
            </div>
            {progress.total > 0 ? (
              <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{
                    width: `${Math.min(
                      100,
                      Math.round(
                        ((progress.succeeded + progress.failed) / progress.total) * 100,
                      ),
                    )}%`,
                  }}
                />
              </div>
            ) : null}
            <p className="text-[11px] text-muted-foreground">
              Progress comes from the workflow ledger — accurate even if the
              browser disconnects. If the connection drops, re-upload the
              same file and the backend skips rows already landed.
            </p>
          </div>
        ) : null}

        {result ? (
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <StatusPill tone={result.failed === 0 ? "success" : "warning"}>
                <CheckCircle2 className="h-3.5 w-3.5" />
                {formatNumber(result.succeeded)} created
              </StatusPill>
              {result.failed > 0 ? (
                <StatusPill tone="danger">
                  <XCircle className="h-3.5 w-3.5" />
                  {formatNumber(result.failed)} failed
                </StatusPill>
              ) : null}
              {result.skipped && result.skipped > 0 ? (
                <StatusPill tone="info">
                  {formatNumber(result.skipped)} skipped (already uploaded)
                </StatusPill>
              ) : null}
              <span className="text-xs text-muted-foreground">
                batch <span className="font-mono">{result.importBatch}</span>
              </span>
            </div>
            {result.failed > 0 ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  <AlertTriangle className="-mt-0.5 mr-1 inline h-3 w-3 text-amber-500" />
                  Show failed rows
                </summary>
                <ul className="mt-2 space-y-1">
                  {result.results
                    .filter((r) => !r.ok)
                    .slice(0, 20)
                    .map((r, i) => (
                      <li
                        key={i}
                        className="rounded-md bg-rose-50/60 px-2 py-1 text-rose-900/80"
                      >
                        <span className="font-medium">
                          {[r.row.firstName, r.row.lastName]
                            .filter(Boolean)
                            .join(" ") || "unknown"}
                        </span>
                        {r.row.cell ? ` · ${r.row.cell}` : null}
                        <span className="ml-2 text-rose-700">— {r.error}</span>
                      </li>
                    ))}
                </ul>
              </details>
            ) : null}
            <div>
              <Button variant="ghost" size="sm" onClick={reset}>
                Upload another
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
