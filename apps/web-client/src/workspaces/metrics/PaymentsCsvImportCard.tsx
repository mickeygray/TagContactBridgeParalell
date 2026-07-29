import * as React from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { TOKEN_STORAGE_KEY } from "@/lib/api/client";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

// Daily payments truth-up: export the Logics PaymentsReport CSV, pick the
// domain it came from, drop it here. CSV rows correct/insert PaymentLedger
// rows (mistyped chargebacks, API-missed deals). Safe to re-import — the
// importer is idempotent.

interface ImportSummary {
  domain: string;
  dryRun: boolean;
  parsed: number;
  matchedAlreadyCorrect: number;
  matchedUpdated: number;
  inserted: number;
  chargebacksTyped: number;
  totalAmount: number;
}

export function PaymentsCsvImportCard() {
  const [domain, setDomain] = React.useState<"TAG" | "WYNN">("TAG");
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [summary, setSummary] = React.useState<ImportSummary | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  async function runImport() {
    if (!file) return;
    setBusy(true);
    setError("");
    setSummary(null);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const token = window.localStorage.getItem(TOKEN_STORAGE_KEY) || "";
      const response = await fetch(`/api/metrics/payments-csv/${domain}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const payload = (await response.json()) as { ok: boolean; result?: ImportSummary; error?: string };
      if (!response.ok || !payload.ok || !payload.result) {
        throw new Error(payload.error || `Import failed (${response.status})`);
      }
      setSummary(payload.result);
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="h-4 w-4 text-muted-foreground" />
          Import Logics payments (daily truth-up)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div className="flex flex-wrap items-center gap-2">
          {(["TAG", "WYNN"] as const).map((option) => (
            <Button
              key={option}
              variant={domain === option ? "primary" : "secondary"}
              size="sm"
              onClick={() => setDomain(option)}
            >
              {option}
            </Button>
          ))}
          <input
            ref={inputRef}
            type="file"
            accept=".csv"
            className="text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-muted/30 file:px-3 file:py-1.5 file:text-xs"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <Button size="sm" disabled={!file || busy} onClick={() => void runImport()}>
            {busy ? "Importing…" : `Import to ${domain}`}
          </Button>
        </div>
        <div className="text-xs text-muted-foreground">
          Export the PaymentsReport from {domain} Logics, drop it here once a day. The CSV is the
          truth: it fixes mistyped chargebacks and inserts anything the API reconcile missed.
          Re-importing the same file is harmless.
        </div>
        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs">{error}</div>
        ) : null}
        {summary ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <StatusPill tone="success">{summary.domain} imported</StatusPill>
            <span>{formatNumber(summary.parsed)} rows</span>
            <span>· {formatNumber(summary.inserted)} inserted</span>
            <span>· {formatNumber(summary.matchedUpdated)} corrected</span>
            <span>· {formatNumber(summary.chargebacksTyped)} chargebacks retyped</span>
            <span>· net {formatCurrency(summary.totalAmount, true)}</span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
