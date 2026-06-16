import * as React from "react";
import { Radio, Upload, Users, Play, Eye } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  KpiCard,
} from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { StatusPill } from "@/components/ui/StatusPill";
import { toast } from "@/components/ui/Toaster";
import { api } from "@/lib/api/client";
import { formatNumber } from "@/lib/utils/format";
import { useDomainStore } from "@/lib/domain/domainStore";

const COMPANY_OPTIONS = ["TAG", "WYNN", "AMITY"] as const;
type Company = (typeof COMPANY_OPTIONS)[number];
type BlastSource = "lead-cadence" | "upload";

type BlastPlan = {
  campaignId: number;
  total: number;
  batchSize: number;
  batches: number;
  plan: Array<{ batch: number; size: number }>;
};
type BlastJob = {
  jobId: string;
  status: "running" | "complete" | "partial" | "failed";
  campaignId: number;
  total: number;
  totalBatches: number;
  batchesDone: number;
  loaded: number;
  progressPct: number;
  dryRun: boolean;
  error: string | null;
};

type UploadRow = { phone: string; firstName?: string; lastName?: string; caseId?: number };

function parseUpload(text: string): UploadRow[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [phone, firstName, lastName, caseId] = line.split(",").map((s) => s.trim());
      return {
        phone,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        caseId: caseId ? Number(caseId) : undefined,
      };
    })
    .filter((row) => row.phone);
}

// Build the request body for both preview + start from the current form state.
function buildBody(opts: {
  company: Company;
  source: BlastSource;
  upload: UploadRow[];
  batchSize: number;
  paceMs: number;
  dryRun: boolean;
}) {
  const base: Record<string, unknown> = {
    domain: opts.company,
    batchSize: opts.batchSize,
    paceMs: opts.paceMs,
    dryRun: opts.dryRun,
  };
  if (opts.source === "upload") {
    base.upload = opts.upload;
  } else {
    base.audienceSource = "lead-cadence";
    base.channel = "cx";
  }
  return base;
}

export function ProspectBlastBuilder() {
  const storedDomain = useDomainStore((s) => s.domain);
  const [company, setCompany] = React.useState<Company>(
    (COMPANY_OPTIONS.includes(storedDomain as Company) ? storedDomain : "TAG") as Company,
  );
  const [source, setSource] = React.useState<BlastSource>("upload");
  const [uploadText, setUploadText] = React.useState("");
  const [chunkSize, setChunkSize] = React.useState("100");
  const [paceSeconds, setPaceSeconds] = React.useState("5");
  const [dryRun, setDryRun] = React.useState(true);

  const [plan, setPlan] = React.useState<BlastPlan | null>(null);
  const [job, setJob] = React.useState<BlastJob | null>(null);
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [starting, setStarting] = React.useState(false);

  const uploadRows = React.useMemo(() => parseUpload(uploadText), [uploadText]);
  const batchSize = Math.max(1, Number(chunkSize) || 100);
  const paceMs = Math.max(0, Number(paceSeconds) || 0) * 1000;

  // Poll the job for the chunk-completion progress bar until it stops running.
  React.useEffect(() => {
    if (!jobId) return undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const res = await api.get<{ ok: boolean; job: BlastJob }>(`/api/dispatch/blast/job/${jobId}`);
        if (stopped) return;
        setJob(res.job);
        if (res.job.status !== "running") stopped = true;
      } catch {
        /* keep the last known job state */
      }
    };
    void poll();
    const id = setInterval(() => {
      if (stopped) {
        clearInterval(id);
        return;
      }
      void poll();
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [jobId]);

  const hasTargets = source === "upload" ? uploadRows.length > 0 : true;

  async function onPreview() {
    setPreviewing(true);
    setJob(null);
    setJobId(null);
    try {
      const res = await api.post<{ ok: boolean; plan: BlastPlan }>(
        "/api/dispatch/blast/preview",
        buildBody({ company, source, upload: uploadRows, batchSize, paceMs, dryRun }),
      );
      setPlan(res.plan);
      if (!res.plan.total) {
        toast.error("No targets resolved", { description: "The list resolved to 0 dialable leads." });
      }
    } catch (err) {
      toast.error("Preview failed", { description: (err as Error).message });
    } finally {
      setPreviewing(false);
    }
  }

  async function onStart() {
    if (!dryRun) {
      const n = plan?.total ?? uploadRows.length;
      const ok = window.confirm(
        `Fire a LIVE blast of ${n} lead${n === 1 ? "" : "s"} into the CX dialer? This dials real prospects.`,
      );
      if (!ok) return;
    }
    setStarting(true);
    try {
      const res = await api.post<{ ok: boolean; jobId: string } & BlastPlan>(
        "/api/dispatch/blast/start",
        { ...buildBody({ company, source, upload: uploadRows, batchSize, paceMs, dryRun }), confirmLive: !dryRun },
      );
      setJobId(res.jobId);
      toast.success(dryRun ? "Dry-run blast started" : "Blast started", {
        description: `${formatNumber(res.total)} leads · ${res.batches} chunk${res.batches === 1 ? "" : "s"} → campaign ${res.campaignId}`,
      });
    } catch (err) {
      toast.error("Could not start blast", { description: (err as Error).message });
    } finally {
      setStarting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-muted-foreground" />
          Predictive prospect blast
        </CardTitle>
        <CardDescription>
          Load a paced list into the CX predictive-dialer campaign. Our own agents dial — no per-message
          cost. Preview the chunk plan, then start; the bar tracks chunk completion. Keep{" "}
          <strong>dry run</strong> on until you&apos;ve confirmed the plan.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pt-0">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <div className="space-y-1.5">
            <Label>Company (Logics tenant)</Label>
            <Select value={company} onValueChange={(v) => setCompany(v as Company)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMPANY_OPTIONS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>List source</Label>
            <Select value={source} onValueChange={(v) => setSource(v as BlastSource)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="upload">Upload (paste numbers)</SelectItem>
                <SelectItem value="lead-cadence">Lead cadence</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Chunk size</Label>
            <Input
              value={chunkSize}
              onChange={(e) => setChunkSize(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="100"
            />
            <p className="text-[11px] text-muted-foreground">Leads loaded per chunk.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Pause between chunks (sec)</Label>
            <Input
              value={paceSeconds}
              onChange={(e) => setPaceSeconds(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="5"
            />
            <p className="text-[11px] text-muted-foreground">Paces the load into the dialer.</p>
          </div>
        </div>

        {source === "upload" ? (
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              <Upload className="h-3.5 w-3.5" /> Paste leads
            </Label>
            <textarea
              value={uploadText}
              onChange={(e) => setUploadText(e.target.value)}
              className="min-h-[140px] w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-sm shadow-sm"
              placeholder={"One per line: phone[,firstName,lastName,caseId]\n3105551234,Jane,Doe,128300\n3105559999"}
            />
            <p className="text-[11px] text-muted-foreground">
              {formatNumber(uploadRows.length)} dialable line{uploadRows.length === 1 ? "" : "s"} parsed.
            </p>
          </div>
        ) : (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
            Pulls the active lead cadence for <strong>{company}</strong>. Use Preview to see how many
            resolve before starting.
          </div>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
            className="h-4 w-4"
          />
          <span>
            Dry run — plan the chunks without loading anything into the dialer.
          </span>
        </label>

        {plan ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <KpiCard
              label="Leads"
              value={formatNumber(plan.total)}
              hint={`campaign ${plan.campaignId}`}
              icon={<Users className="h-4 w-4" />}
            />
            <KpiCard
              label="Chunks"
              value={formatNumber(plan.batches)}
              hint={`${plan.batchSize} per chunk`}
              icon={<Radio className="h-4 w-4" />}
            />
            <KpiCard
              label="Pace"
              value={`${paceSeconds || "0"}s`}
              hint="between chunks"
              icon={<Play className="h-4 w-4" />}
            />
          </div>
        ) : null}

        {job ? (
          <Card className="border-border/70 bg-muted/20">
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-3">
                <span>Blast progress {job.dryRun ? "(dry run)" : ""}</span>
                <StatusPill
                  tone={
                    job.status === "complete" ? "success" : job.status === "failed" ? "danger" : "warning"
                  }
                  dotted={job.status === "running"}
                >
                  {job.status}
                </StatusPill>
              </CardTitle>
              <CardDescription>
                {formatNumber(job.batchesDone)} / {formatNumber(job.totalBatches)} chunks ·{" "}
                {formatNumber(job.loaded)} loaded → campaign {job.campaignId}
                {job.error ? ` · ${job.error}` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="h-2 overflow-hidden rounded-full bg-border/60">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${job.progressPct}%` }}
                />
              </div>
              <p className="mt-1 text-right text-[11px] text-muted-foreground">{job.progressPct}%</p>
            </CardContent>
          </Card>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
          <Button
            variant="secondary"
            size="sm"
            disabled={!hasTargets}
            isLoading={previewing}
            onClick={onPreview}
          >
            <Eye className="h-3.5 w-3.5" />
            Preview chunks
          </Button>
          <Button
            size="sm"
            disabled={!hasTargets || job?.status === "running"}
            isLoading={starting}
            onClick={onStart}
          >
            <Play className="h-3.5 w-3.5" />
            {dryRun ? "Start dry run" : "Start blast"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
