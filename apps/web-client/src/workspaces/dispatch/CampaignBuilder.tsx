import * as React from "react";
import {
  Library as LibraryIcon,
  Mail,
  MessageSquare,
  Phone,
  PhoneOff,
  Send,
  Users,
} from "lucide-react";
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
import { SkeletonRow } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/ErrorState";
import { EmptyState } from "@/components/ui/EmptyState";
import { toast } from "@/components/ui/Toaster";
import {
  useBuildDispatch,
  useCampaignAudience,
  useDispatchLists,
  useQueueDispatch,
} from "@/lib/api/queries/dispatch";
import { useLibraryWorkspace } from "@/lib/api/queries/library";
import type { LibraryCatalogEntry } from "@/lib/api/types";
import { formatNumber, formatRelative } from "@/lib/utils/format";
import { useDomainStore } from "@/lib/domain/domainStore";

const COMPANY_OPTIONS = ["TAG", "WYNN", "AMITY"] as const;
type Company = (typeof COMPANY_OPTIONS)[number];
type Channel = "sms" | "email" | "rvm" | "callfire";
type PulseDelayUnit = "seconds" | "minutes" | "hours";
type AudienceSource = "prospect-index" | "case-profiles" | "lead-cadence" | "upload";

const CHANNEL_META: Record<
  Channel,
  { label: string; icon: React.ComponentType<{ className?: string }>; description: string }
> = {
  sms: { label: "Text", icon: MessageSquare, description: "Requires cellPhone" },
  email: { label: "Email", icon: Mail, description: "Requires email" },
  rvm: { label: "RVM", icon: PhoneOff, description: "Requires cellPhone" },
  callfire: { label: "CallFire Dialer", icon: Phone, description: "Requires cellPhone" },
};

const VARIABLES = ["{name}", "{firstName}", "{lastName}", "{phone}", "{number}"];
const AUDIENCE_SOURCE_OPTIONS: Array<{
  value: AudienceSource;
  label: string;
  description: string;
}> = [
  { value: "prospect-index", label: "Prospect index", description: "Best for prospect outreach." },
  { value: "case-profiles", label: "Case profiles", description: "Client-focused lists." },
  { value: "lead-cadence", label: "Lead cadence", description: "Operational cadence-driven lists." },
  { value: "upload", label: "Upload", description: "Placeholder for ad hoc imports." },
];

function formatRecipientsLabel(count: number) {
  return `${formatNumber(count)} recipient${count === 1 ? "" : "s"}`;
}

function sortByMostRecentDispatch(
  a: { builtAt?: string; createdAt?: string },
  b: { builtAt?: string; createdAt?: string },
) {
  const aTime = new Date(a.builtAt || a.createdAt || 0).getTime();
  const bTime = new Date(b.builtAt || b.createdAt || 0).getTime();
  return bTime - aTime;
}

export function CampaignBuilder() {
  const storedDomain = useDomainStore((s) => s.domain);
  const [company, setCompany] = React.useState<Company>(
    (COMPANY_OPTIONS.includes(storedDomain as Company) ? storedDomain : "TAG") as Company,
  );
  const [channel, setChannel] = React.useState<Channel>("sms");
  const [templateId, setTemplateId] = React.useState<string>("");
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [note, setNote] = React.useState("");
  const [maxCount, setMaxCount] = React.useState("200");
  const [ratePerMinute, setRatePerMinute] = React.useState("20");
  const [pulseSize, setPulseSize] = React.useState("25");
  const [pulseDelayValue, setPulseDelayValue] = React.useState("30");
  const [pulseDelayUnit, setPulseDelayUnit] = React.useState<PulseDelayUnit>("minutes");
  const [audienceSource, setAudienceSource] = React.useState<AudienceSource>("prospect-index");
  // Optional date-range scoping on LeadCadence.createdAt — only
  // surfaced when the lead-cadence source is selected (the other
  // sources don't expose a createdAt axis). Both bounds independent;
  // empty string = no bound. The audience query treats empty as
  // "no filter" so the default behavior (no narrowing) is preserved.
  const [createdAtAfter, setCreatedAtAfter] = React.useState("");
  const [createdAtBefore, setCreatedAtBefore] = React.useState("");
  // Empty default — leaving the body blank means "use the CallFire
  // template's pre-recorded audio" (the official Wynn intro) instead of
  // overriding with a TTS placeholder. Operators can still type a
  // custom one-off body if they want to override; the placeholder text
  // below is just shown as the textarea hint, never sent.
  const defaultCallfireBody = "";
  const effectiveStatusId = channel === "callfire" ? 2 : 2;

  const audience = useCampaignAudience(company, {
    channel,
    audienceSource,
    statusId: effectiveStatusId,
    createdAtAfter: audienceSource === "lead-cadence" ? createdAtAfter || undefined : undefined,
    createdAtBefore: audienceSource === "lead-cadence" ? createdAtBefore || undefined : undefined,
  });
  const library = useLibraryWorkspace(company);
  const dispatchLists = useDispatchLists(company);
  const build = useBuildDispatch();
  const queue = useQueueDispatch();

  const libraryEntries: LibraryCatalogEntry[] = React.useMemo(() => {
    if (!library.data) return [];
    const catalogs = library.data.catalogs;
    return channel === "email"
      ? catalogs.emailTemplates ?? []
      : channel === "sms"
        ? catalogs.textMessages ?? []
        : [];
  }, [library.data, channel]);

  React.useEffect(() => {
    if (!templateId) return;
    const entry = libraryEntries.find((e) => e.id === templateId);
    if (!entry) return;
    if (channel === "email") {
      setSubject(entry.subject ?? subject);
      setBody(entry.content ?? entry.preview ?? body);
    } else {
      setBody(entry.content ?? entry.preview ?? body);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  React.useEffect(() => {
    if (channel === "callfire" && company !== "WYNN") {
      setCompany("WYNN");
    }
  }, [channel, company]);

  React.useEffect(() => {
    if (channel === "callfire") {
      setAudienceSource("lead-cadence");
    }
  }, [channel]);

  const audienceReady = Boolean(audience.data && audience.data.returned > 0);
  const latestDispatch = React.useMemo(() => {
    const lists = dispatchLists.data ?? [];
    return (
      lists
        .filter((list) => list.channel === channel && String(list.mode || "").toLowerCase() === "manual")
        .sort(sortByMostRecentDispatch)[0] ?? null
    );
  }, [dispatchLists.data, channel]);
  const latestSelectedCount =
    Number(latestDispatch?.stats?.selectedCount ?? latestDispatch?.prospectCount ?? 0) || 0;
  const latestAttemptedCount = Number(latestDispatch?.stats?.attemptedCount ?? 0) || 0;
  const latestSuccessCount = Number(latestDispatch?.stats?.successCount ?? 0) || 0;
  const latestFailedCount = Number(latestDispatch?.stats?.failedCount ?? 0) || 0;
  const latestProgress = latestSelectedCount > 0
    ? Math.min(100, Math.round((latestAttemptedCount / latestSelectedCount) * 100))
    : 0;
  const canCommit =
    audienceReady &&
    (channel === "callfire" || body.trim().length > 0) &&
    (channel !== "email" || subject.trim().length > 0);

  function insertVar(variable: string) {
    setBody((current) => `${current}${current.endsWith(" ") ? "" : " "}${variable} `);
  }

  function toPulseDelayMs(value: string, unit: PulseDelayUnit) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return undefined;
    if (unit === "hours") return Math.round(amount * 60 * 60 * 1000);
    if (unit === "minutes") return Math.round(amount * 60 * 1000);
    return Math.round(amount * 1000);
  }

  async function onCommit(mode: "build" | "queue", options: { oneClickCallfire?: boolean } = {}) {
    if (!audience.data) return;

    const effectiveBody =
      channel === "callfire"
        ? body.trim() || defaultCallfireBody
        : body;

    const payload = {
      domain: company,
      family: "dispatch",
      subtype: `${channel}-manual`,
      channel,
      audienceSource,
      statusId: effectiveStatusId,
      mode: "manual",
      caseIds: audience.data.caseIds.map(String),
      maxCount: Math.max(Number(maxCount) || 0, 0) || undefined,
      ratePerMinute:
        channel === "callfire" ? Math.max(Number(ratePerMinute) || 0, 0) || undefined : undefined,
      pulseSize:
        channel !== "callfire" ? Math.max(Number(pulseSize) || 0, 0) || undefined : undefined,
      pulseDelayMs:
        channel !== "callfire"
          ? toPulseDelayMs(pulseDelayValue, pulseDelayUnit)
          : undefined,
      templateKey: templateId || null,
      notes: note.trim() || undefined,
      instructions: {
        content: effectiveBody,
        subject: channel === "email" ? subject : null,
      },
      sourceService: "web-client",
    };

    try {
      if (mode === "build") {
        const list = await build.mutateAsync(payload);
        toast.success("Dispatch list built", {
          description: `${audience.data.total} recipient${audience.data.total === 1 ? "" : "s"} · ${company} · ${CHANNEL_META[channel].label}`,
        });
        return list;
      }

      const envelope = await queue.mutateAsync(payload);
      const inner = envelope?.result;
      const listId = inner?.list?.id ?? "created";
      const reason = inner?.reason ? String(inner.reason) : "";
      const description =
        `${audience.data.total} recipient${audience.data.total === 1 ? "" : "s"} ` +
        `· list ${listId}${reason ? ` · ${reason}` : ""}${options.oneClickCallfire ? " · lead cadence dialer" : ""}`;
      toast.success("Queued for send", {
        description,
      });
    } catch (err) {
      toast.error(
        mode === "build" ? "Could not build list" : "Could not queue send",
        { description: (err as Error).message },
      );
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Send className="h-4 w-4 text-muted-foreground" />
          Campaign builder
        </CardTitle>
        <CardDescription>
          Blast a text, email, RVM, or CallFire dial job to prospects in one status.
          Execution is picked up by{" "}
          <code className="font-mono text-xs">outbound-gateway</code> (4002)
          and routed to the right provider.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pt-0">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
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
            <Label>Channel</Label>
            <Select value={channel} onValueChange={(v) => setChannel(v as Channel)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(CHANNEL_META) as Channel[]).map((c) => (
                  <SelectItem key={c} value={c}>
                    {CHANNEL_META[c].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {CHANNEL_META[channel].description}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Channel decides delivery; list source decides who we pull.
            </p>
            {channel === "callfire" ? (
              <p className="text-[11px] text-muted-foreground">
                WYNN dialer mode intersects current Logics status results with the full active lead cadence collection.
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label>List source</Label>
            <Select
              value={audienceSource}
              onValueChange={(v) => setAudienceSource(v as AudienceSource)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUDIENCE_SOURCE_OPTIONS.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    disabled={channel === "callfire" && option.value !== "lead-cadence"}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {AUDIENCE_SOURCE_OPTIONS.find((option) => option.value === audienceSource)?.description}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>{channel === "callfire" ? "Prospect rule" : "Prospect status"}</Label>
            {channel === "callfire" ? (
              <>
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                  Live Logics status must equal <strong>2</strong> to persist into the dialer list.
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Candidate rows come from active lead cadence, then `GetCasesByStatus(2)` is used as the live truth before the dispatch list is built.
                </p>
              </>
            ) : (
              <>
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                  Prospect status locked to <strong>2</strong>.
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Standard prospect dispatch currently targets status 2.
                </p>
              </>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Tag (optional)</Label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Thursday blast"
            />
            <p className="text-[11px] text-muted-foreground">
              Stored on the workflow record.
            </p>
            {channel === "callfire" ? (
              <p className="text-[11px] text-muted-foreground">
                CallFire dialer is locked to the WYNN Logics tenant.
              </p>
            ) : null}
          </div>
        </div>

        {audienceSource === "lead-cadence" ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Created from</Label>
              <Input
                type="date"
                value={createdAtAfter}
                onChange={(e) => setCreatedAtAfter(e.target.value)}
                max={createdAtBefore || undefined}
              />
              <p className="text-[11px] text-muted-foreground">
                Earliest <code className="font-mono">createdAt</code> on the lead cadence row (PT).
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Created to</Label>
              <Input
                type="date"
                value={createdAtBefore}
                onChange={(e) => setCreatedAtBefore(e.target.value)}
                min={createdAtAfter || undefined}
              />
              <p className="text-[11px] text-muted-foreground">
                Latest <code className="font-mono">createdAt</code> on the lead cadence row (PT, inclusive).
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>&nbsp;</Label>
              <Button
                variant="secondary"
                size="sm"
                disabled={!createdAtAfter && !createdAtBefore}
                onClick={() => {
                  setCreatedAtAfter("");
                  setCreatedAtBefore("");
                }}
              >
                Clear date range
              </Button>
              <p className="text-[11px] text-muted-foreground">
                Leave both empty to dispatch the entire eligible cadence (default).
              </p>
            </div>
          </div>
        ) : null}

        {channel === "callfire" ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Dial cap</Label>
              <Input
                value={maxCount}
                onChange={(e) => setMaxCount(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="200"
              />
              <p className="text-[11px] text-muted-foreground">
                Max leads to persist into this run.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Rate / minute</Label>
              <Input
                value={ratePerMinute}
                onChange={(e) => setRatePerMinute(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="20"
              />
              <p className="text-[11px] text-muted-foreground">
                Adds pacing in 4002 between CallFire submissions.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <div className="space-y-1.5">
              <Label>Send cap</Label>
              <Input
                value={maxCount}
                onChange={(e) => setMaxCount(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="200"
              />
              <p className="text-[11px] text-muted-foreground">
                Max recipients to persist into this run.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Pulse size</Label>
              <Input
                value={pulseSize}
                onChange={(e) => setPulseSize(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="25"
              />
              <p className="text-[11px] text-muted-foreground">
                Sends this many contacts before pausing.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Pause length</Label>
              <Input
                value={pulseDelayValue}
                onChange={(e) => setPulseDelayValue(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="30"
              />
              <p className="text-[11px] text-muted-foreground">
                Wait time between pulses on 4002.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Pause unit</Label>
              <Select value={pulseDelayUnit} onValueChange={(value) => setPulseDelayUnit(value as PulseDelayUnit)}>
                <SelectTrigger>
                  <SelectValue placeholder="Unit" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="seconds">Seconds</SelectItem>
                  <SelectItem value="minutes">Minutes</SelectItem>
                  <SelectItem value="hours">Hours</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Use longer waits like 30 minutes or 1 hour between 50-send pulses.
              </p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <KpiCard
            label="Eligible"
            value={audience.isLoading ? "..." : formatNumber(audience.data?.total ?? 0)}
            hint={`${company} · ${CHANNEL_META[channel].label}`}
            icon={<Users className="h-4 w-4" />}
          />
          <KpiCard
            label="Selected"
            value={audience.isLoading ? "..." : formatNumber(audience.data?.returned ?? 0)}
            hint={
              audience.data?.truncated
                ? "Truncated - raise maxSize to send more"
                : audience.data?.excludedCount
                  ? `${formatNumber(audience.data.excludedCount)} suppressed / DNC skipped`
                  : "Full audience"
            }
            icon={<Users className="h-4 w-4" />}
          />
          <KpiCard
            label="Template"
            value={
              templateId
                ? libraryEntries.find((e) => e.id === templateId)?.name ?? "custom"
                : "Custom"
            }
            hint={`${libraryEntries.length} in library`}
            icon={<LibraryIcon className="h-4 w-4" />}
          />
        </div>

        {latestDispatch ? (
          <Card className="border-border/70 bg-muted/20">
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-3">
                <span>Latest run</span>
                <StatusPill tone={
                  latestDispatch.status === "completed"
                    ? "success"
                    : latestDispatch.status === "failed"
                      ? "danger"
                      : "warning"
                }>
                  {latestDispatch.status ?? "unknown"}
                </StatusPill>
              </CardTitle>
              <CardDescription>
                {latestDispatch.title ?? `${company} ${CHANNEL_META[channel].label}`} ·{" "}
                {latestDispatch.builtAt ? formatRelative(latestDispatch.builtAt) : "just now"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 pt-0">
              <div className="h-2 overflow-hidden rounded-full bg-border/60">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${latestProgress}%` }}
                />
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Selected</div>
                  <div className="numeric text-lg font-semibold">{formatNumber(latestSelectedCount)}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Consumed</div>
                  <div className="numeric text-lg font-semibold">{formatNumber(latestAttemptedCount)}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Sent</div>
                  <div className="numeric text-lg font-semibold">{formatNumber(latestSuccessCount)}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Failed</div>
                  <div className="numeric text-lg font-semibold">{formatNumber(latestFailedCount)}</div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {latestDispatch.queuedAt ? `Queued ${formatRelative(latestDispatch.queuedAt)}` : "Not queued yet"}
                {latestDispatch.consumedAt ? ` · finished ${formatRelative(latestDispatch.consumedAt)}` : ""}
                {latestDispatch.eventId ? ` · event ${latestDispatch.eventId}` : ""}
              </p>
            </CardContent>
          </Card>
        ) : null}

        {audience.isError ? (
          <ErrorState error={audience.error} onRetry={() => audience.refetch()} />
        ) : null}

        {audience.data && audience.data.returned === 0 && !audience.isLoading ? (
          <EmptyState
            icon={<Users />}
            title={`No sendable ${company} contacts in this list`}
            description="The source may have matches, but none survived channel checks, status filters, or suppression rules."
          />
        ) : null}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(220px,280px)_1fr]">
          <div className="space-y-2">
            <Label>Library</Label>
            {library.isLoading ? (
              <SkeletonRow count={4} />
            ) : libraryEntries.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {channel === "callfire"
                  ? "CallFire uses the custom body below as the one-off voice message."
                  : `No ${channel === "email" ? "email" : "text"} templates yet.`}
              </p>
            ) : (
              <ul className="max-h-[240px] space-y-1 overflow-auto rounded-md border border-border p-1">
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      setTemplateId("");
                      setBody("");
                      setSubject("");
                    }}
                    className={
                      "w-full rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted " +
                      (templateId === "" ? "bg-primary/10 font-medium" : "")
                    }
                  >
                    Custom (write your own)
                  </button>
                </li>
                {libraryEntries.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => setTemplateId(entry.id)}
                      className={
                        "w-full rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted " +
                        (templateId === entry.id ? "bg-primary/10 font-medium" : "")
                      }
                    >
                      <div className="truncate">{entry.name ?? entry.id}</div>
                      {entry.category || entry.brand ? (
                        <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                          {[entry.category, entry.brand].filter(Boolean).join(" · ")}
                        </div>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-3">
            {channel === "email" ? (
              <div className="space-y-1.5">
                <Label>Subject</Label>
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="e.g. Final reminder for your 2024 return"
                />
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label>Message body</Label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="min-h-[160px] w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm"
                placeholder={
                  channel === "email"
                    ? "Hi {firstName}, ..."
                    : channel === "callfire"
                      ? "Leave blank to play the CallFire template's recorded audio (Wynn intro). Type here to override with a custom TTS message."
                      : "Hi {name}, this is reaching out about {number}. Reply STOP to opt out."
                }
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Insert:
                </span>
                {VARIABLES.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => insertVar(v)}
                    className="rounded-md border border-border bg-muted/40 px-2 py-0.5 font-mono text-[11px] hover:bg-muted"
                  >
                    {v}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Variables are resolved per-recipient by{" "}
                <code className="font-mono">outbound-gateway</code> using each prospect&apos;s
                name and cellPhone. For CallFire, this body becomes the one-off broadcast voice text.
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
          <div className="flex items-center gap-2">
            <StatusPill tone={audienceReady ? "success" : "warning"} dotted>
              {audienceReady ? `${formatRecipientsLabel(audience.data!.returned)} ready` : "No audience"}
            </StatusPill>
            {audience.data?.sample[0] ? (
              <span className="text-xs text-muted-foreground">
                most recent: {audience.data.sample[0].name ?? audience.data.sample[0].caseId}
                {audience.data.sample[0].lastSeenAt
                  ? ` · ${formatRelative(audience.data.sample[0].lastSeenAt)}`
                  : ""}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={!canCommit}
              isLoading={build.isPending}
              onClick={() => onCommit("build")}
            >
              Build list only
            </Button>
            <Button
              size="sm"
              disabled={!canCommit}
              isLoading={queue.isPending}
              onClick={() => onCommit("queue")}
            >
              <Send className="h-3.5 w-3.5" />
              {channel === "callfire" ? "Run digital dialer" : "Build + Queue"}
            </Button>
            {channel === "callfire" ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={!audienceReady}
                isLoading={queue.isPending}
                onClick={() => onCommit("queue", { oneClickCallfire: true })}
              >
                <Phone className="h-3.5 w-3.5" />
                One-click lead cadence
              </Button>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
