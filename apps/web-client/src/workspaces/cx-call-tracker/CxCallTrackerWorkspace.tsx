import * as React from "react";
import {
  Clock,
  Download,
  Flame,
  Headphones,
  PhoneIncoming,
  PhoneOutgoing,
  Play,
  RefreshCw,
  Search,
  Users,
} from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, KpiCard } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import {
  normalizeUsPhone,
  useCallsByPhone,
  useCallTrackerToday,
  type CallReviewRow,
  type CallSortKey,
  type CallPlatformFilter,
  type CallDirectionFilter,
  type CallsByPhoneFilters,
} from "@/lib/api/queries/callReview";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

type PhoneLookupWindow = 30 | 90 | 365 | "all";

const PHONE_WINDOW_OPTIONS: { label: string; value: PhoneLookupWindow }[] = [
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "1y", value: 365 },
  { label: "all", value: "all" },
];

type DomainFilter = "ALL" | "TAG" | "WYNN";

function formatDuration(sec: number | null | undefined): string {
  if (!sec || sec < 1) return "—";
  const minutes = Math.floor(sec / 60);
  const seconds = Math.floor(sec % 60);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  }
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function durationTone(
  sec: number | null | undefined,
): "info" | "warning" | "success" | "accent" {
  if (!sec || sec < 30) return "info";
  if (sec < 120) return "accent";
  if (sec < 480) return "success";
  return "warning";
}

function verdictTone(verdict: string | null): {
  className: string;
  label: string;
} | null {
  if (!verdict) return null;
  const v = verdict.toLowerCase();
  if (v === "hot") return { className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", label: "HOT" };
  if (v === "warm") return { className: "bg-amber-500/15 text-amber-700 dark:text-amber-300", label: "WARM" };
  if (v === "cold") return { className: "bg-sky-500/15 text-sky-700 dark:text-sky-300", label: "COLD" };
  if (v === "dead") return { className: "bg-muted text-muted-foreground", label: "DEAD" };
  if (v === "fake") return { className: "bg-rose-500/15 text-rose-700 dark:text-rose-300", label: "FAKE" };
  return { className: "bg-muted text-muted-foreground", label: v.toUpperCase() };
}

function routeCampaignLabel(row: CallReviewRow): string | null {
  if (row.routeCampaignName) return row.routeCampaignName;
  if (row.routeCampaignKey === "ld-custom") return "LD Custom";
  if (row.routeCampaignKey === "ld-general") return "LD General";
  if (row.routeCampaignKey) return row.routeCampaignKey;
  return row.sourceName || null;
}

function buildDownloadFilename(call: CallReviewRow): string {
  const date = call.callStartTime
    ? new Date(call.callStartTime).toISOString().replace(/[:.]/g, "-").slice(0, 19)
    : "unknown";
  const agent = (call.agentName || call.extensionId || "agent")
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "");
  const phone = call.phone || "unknown";
  return `${date}_${agent}_${phone}.mp3`;
}

export function CxCallTrackerWorkspace() {
  const [domain, setDomain] = React.useState<DomainFilter>("ALL");
  const [platform, setPlatform] = React.useState<CallPlatformFilter>("cx");
  const [direction, setDirection] = React.useState<CallDirectionFilter>("outbound");
  const [hasRecording, setHasRecording] = React.useState<boolean | undefined>(undefined);
  const [sort, setSort] = React.useState<CallSortKey>("time");
  const [agentFilter, setAgentFilter] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  // Phone-lookup mode — when set, the workspace switches from "today's
  // CX activity" to "all calls to this phone over the past N days."
  const [phoneInput, setPhoneInput] = React.useState("");
  const [phoneQuery, setPhoneQuery] = React.useState<string | null>(null);
  const [phoneWindow, setPhoneWindow] = React.useState<PhoneLookupWindow>(90);
  const phoneNormalized = normalizeUsPhone(phoneQuery);
  const phoneMode = Boolean(phoneNormalized);

  const query = useCallTrackerToday({
    domain,
    platform,
    direction,
    hasRecording,
    extensionId: agentFilter || undefined,
    sort,
  });
  const phoneResults = useCallsByPhone(phoneNormalized, {
    domain,
    days: phoneWindow,
    sort,
  } satisfies CallsByPhoneFilters);

  // When in phone mode, the visible data + summary come from the phone
  // query; otherwise from the tracker today query. Branching here keeps
  // the rest of the component shape simple.
  const activeQuery = phoneMode ? phoneResults : query;
  const activeData = phoneMode ? phoneResults.data : query.data;
  const activeCalls = activeData?.calls ?? [];

  const visibleCalls = React.useMemo(() => {
    if (!activeCalls.length) return [];
    const term = search.trim().toLowerCase();
    if (!term) return activeCalls;
    return activeCalls.filter((row) => {
      const haystack = [
        row.agentName,
        row.phone,
        row.sourceName,
        row.routeCampaignName,
        row.routeCampaignKey,
        row.score?.summary,
        row.caseId ? `#${row.caseId}` : null,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [activeCalls, search]);

  const totalDurationSec = activeData?.summary?.totalDurationSec ?? 0;
  const avgDurationSec = activeCalls.length
    ? Math.round(totalDurationSec / activeCalls.length)
    : 0;
  const cxCount = activeCalls.filter((c) => c.platform === "cx").length;
  const scoredHot = activeCalls.filter(
    (c) => c.score?.verdict?.toLowerCase() === "hot",
  ).length;

  const phoneSummary =
    phoneMode && phoneResults.data
      ? {
          firstCallAt: phoneResults.data.summary.firstCallAt,
          lastCallAt: phoneResults.data.summary.lastCallAt,
          uniqueAgents: phoneResults.data.summary.uniqueAgents,
          phoneDisplay: phoneResults.data.phoneDisplay,
          truncated: phoneResults.data.truncated,
        }
      : null;

  const submitPhoneLookup = (raw: string) => {
    const normalized = normalizeUsPhone(raw);
    setPhoneQuery(normalized);
    setAgentFilter(null);
  };
  const clearPhoneLookup = () => {
    setPhoneInput("");
    setPhoneQuery(null);
  };

  return (
    <div className="space-y-4">
      <SectionHeader
        title="CX Call Tracker"
        description={
          phoneMode && phoneSummary
            ? `Phone history for ${phoneSummary.phoneDisplay} · ${activeCalls.length} call${
                activeCalls.length === 1 ? "" : "s"
              } across ${phoneSummary.uniqueAgents} agent${
                phoneSummary.uniqueAgents === 1 ? "" : "s"
              }${phoneSummary.truncated ? " (truncated)" : ""}`
            : activeData
              ? `${(activeData as any).dateKey ?? ""} · ${activeData.domain} · ${
                  visibleCalls.length
                } of ${activeCalls.length} call${
                  activeCalls.length === 1 ? "" : "s"
                } shown${activeData.truncated ? " (truncated)" : ""}`
              : "Today's CX dial activity across all agents and tenants."
        }
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => activeQuery.refetch()}
            isLoading={activeQuery.isFetching && !activeQuery.isLoading}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        }
      />

      {/* Phone lookup — paste a number to switch from "today's CX
          activity" to "every call to/from this person." */}
      <Card>
        <CardContent className="p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitPhoneLookup(phoneInput);
            }}
            className="flex flex-wrap items-center gap-2"
          >
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              placeholder="Look up by phone — e.g. (310) 666-5997"
              className="h-7 w-72 text-xs"
            />
            <Button
              type="submit"
              variant="primary"
              size="sm"
              className="h-7 px-3"
              disabled={!normalizeUsPhone(phoneInput)}
            >
              Search
            </Button>
            {phoneMode ? (
              <>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Window
                </span>
                {PHONE_WINDOW_OPTIONS.map((opt) => (
                  <FilterChip
                    key={String(opt.value)}
                    active={phoneWindow === opt.value}
                    onClick={() => setPhoneWindow(opt.value)}
                  >
                    {opt.label}
                  </FilterChip>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={clearPhoneLookup}
                >
                  Clear lookup
                </Button>
              </>
            ) : null}
            {phoneMode && phoneSummary ? (
              <span className="ml-auto text-[11px] text-muted-foreground">
                First: {phoneSummary.firstCallAt
                  ? formatDateTime(phoneSummary.firstCallAt)
                  : "—"}
                {" · Last: "}
                {phoneSummary.lastCallAt
                  ? formatDateTime(phoneSummary.lastCallAt)
                  : "—"}
              </span>
            ) : null}
          </form>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <KpiCard
          label={phoneMode ? "Total calls" : "Total today"}
          value={formatNumber(activeCalls.length)}
          icon={<Headphones className="h-4 w-4" />}
        />
        <KpiCard
          label="CX dials"
          value={formatNumber(cxCount)}
          icon={<PhoneOutgoing className="h-4 w-4" />}
        />
        <KpiCard
          label="Avg duration"
          value={formatDuration(avgDurationSec)}
          icon={<Clock className="h-4 w-4" />}
        />
        <KpiCard
          label="With recording"
          value={`${formatNumber(activeData?.summary?.withRecording ?? 0)} / ${formatNumber(activeCalls.length)}`}
          icon={<Play className="h-4 w-4" />}
        />
        <KpiCard
          label={phoneMode ? "Unique agents" : "Hot leads"}
          value={formatNumber(
            phoneMode ? phoneSummary?.uniqueAgents ?? 0 : scoredHot,
          )}
          icon={phoneMode ? <Users className="h-4 w-4" /> : <Flame className="h-4 w-4" />}
        />
      </div>

      <Card>
        <CardContent className="p-3">
          <div className="flex flex-wrap items-center gap-2">
            <FilterGroup label="Domain">
              {(["ALL", "TAG", "WYNN"] as DomainFilter[]).map((opt) => (
                <FilterChip
                  key={opt}
                  active={domain === opt}
                  onClick={() => setDomain(opt)}
                >
                  {opt}
                </FilterChip>
              ))}
            </FilterGroup>
            <FilterGroup label="Platform">
              {(["cx", "ex", "all"] as CallPlatformFilter[]).map((opt) => (
                <FilterChip
                  key={opt}
                  active={platform === opt}
                  onClick={() => setPlatform(opt)}
                >
                  {opt.toUpperCase()}
                </FilterChip>
              ))}
            </FilterGroup>
            <FilterGroup label="Direction">
              {(["all", "outbound", "inbound"] as CallDirectionFilter[]).map((opt) => (
                <FilterChip
                  key={opt}
                  active={direction === opt}
                  onClick={() => setDirection(opt)}
                >
                  {opt}
                </FilterChip>
              ))}
            </FilterGroup>
            <FilterGroup label="Recording">
              <FilterChip
                active={hasRecording === undefined}
                onClick={() => setHasRecording(undefined)}
              >
                any
              </FilterChip>
              <FilterChip
                active={hasRecording === true}
                onClick={() => setHasRecording(true)}
              >
                has rec
              </FilterChip>
              <FilterChip
                active={hasRecording === false}
                onClick={() => setHasRecording(false)}
              >
                no rec
              </FilterChip>
            </FilterGroup>
            <FilterGroup label="Sort">
              {(["time", "duration", "score"] as CallSortKey[]).map((opt) => (
                <FilterChip
                  key={opt}
                  active={sort === opt}
                  onClick={() => setSort(opt)}
                >
                  {opt}
                </FilterChip>
              ))}
            </FilterGroup>
            <div className="ml-auto flex items-center gap-2">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="agent, phone, case…"
                className="h-7 w-44 text-xs"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {activeData?.agents && activeData.agents.length > 0 ? (
        <Card>
          <CardContent className="p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {phoneMode ? "Agents who called this number" : "Today's leaderboard"}
            </div>
            <div className="flex flex-wrap gap-2">
              {activeData.agents.slice(0, 12).map((agent) => (
                <button
                  key={agent.extensionId}
                  type="button"
                  onClick={() =>
                    setAgentFilter(
                      agentFilter === agent.extensionId
                        ? null
                        : agent.extensionId,
                    )
                  }
                  className={cn(
                    "rounded-md border px-2 py-1 text-left text-[11px] transition-colors",
                    agentFilter === agent.extensionId
                      ? "border-primary bg-primary/10"
                      : "border-border hover:bg-muted/50",
                  )}
                >
                  <div className="font-medium">
                    {agent.agentName || `ext ${agent.extensionId}`}
                  </div>
                  <div className="text-muted-foreground">
                    {agent.callCount} call{agent.callCount === 1 ? "" : "s"}
                    {" · "}
                    {formatDuration(agent.totalDurationSec)}
                    {" · "}
                    {agent.withRecording} rec
                  </div>
                </button>
              ))}
              {agentFilter ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setAgentFilter(null)}
                >
                  Clear agent filter
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="p-0">
          {activeQuery.isError ? (
            <div className="p-3">
              <ErrorState
                error={activeQuery.error}
                onRetry={() => activeQuery.refetch()}
              />
            </div>
          ) : activeQuery.isLoading ? (
            <div className="p-3">
              <SkeletonRow count={5} />
            </div>
          ) : visibleCalls.length === 0 ? (
            <div className="p-3">
              <EmptyState
                title="No calls match"
                description={
                  activeCalls.length
                    ? "Your filters narrowed everything out — try widening platform or recording."
                    : phoneMode
                      ? "No calls to/from this number in the selected window."
                      : "Nothing dialed yet on the current PT day with these filters."
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {visibleCalls.map((call) => (
                <TrackerRow
                  key={call.id}
                  call={call}
                  expanded={expandedId === call.id}
                  onToggle={() =>
                    setExpandedId(expandedId === call.id ? null : call.id)
                  }
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded px-2 py-1 text-[11px] transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted/40 text-foreground/80 hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

function TrackerRow({
  call,
  expanded,
  onToggle,
}: {
  call: CallReviewRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const DirectionIcon =
    call.direction === "outbound" ? PhoneOutgoing : PhoneIncoming;
  const verdict = verdictTone(call.score?.verdict ?? null);
  const route = routeCampaignLabel(call);
  return (
    <li className="px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <DirectionIcon
          className={cn(
            "h-4 w-4 shrink-0",
            call.direction === "outbound" ? "text-blue-500" : "text-amber-500",
          )}
        />
        <span
          className="font-mono text-[10px] text-muted-foreground"
          title={
            call.callStartTime ? formatDateTime(call.callStartTime) : undefined
          }
        >
          {call.callStartTime ? formatRelative(call.callStartTime) : "—"}
        </span>
        <span className="min-w-[8rem] truncate font-medium">
          {call.agentName || (call.extensionId ? `ext ${call.extensionId}` : "—")}
        </span>
        <span className="truncate text-foreground/80">{call.phone || "—"}</span>
        {call.caseId ? (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            #{call.caseId}
          </span>
        ) : null}
        <StatusPill tone={durationTone(call.durationSec)}>
          {formatDuration(call.durationSec)}
        </StatusPill>
        {call.platform ? (
          <span className="uppercase text-muted-foreground">{call.platform}</span>
        ) : null}
        {verdict ? (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide",
              verdict.className,
            )}
            title={
              call.score?.summary ||
              (call.score?.overall != null
                ? `Score ${call.score.overall}/10`
                : undefined)
            }
          >
            {verdict.label}
            {call.score?.overall != null ? ` ${call.score.overall}` : ""}
          </span>
        ) : null}
        {route ? (
          <span
            className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-foreground/80"
            title={call.sourceName || route}
          >
            {route}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant={call.recording.available ? "primary" : "ghost"}
            size="sm"
            className="h-7 px-2"
            disabled={!call.recording.available}
            onClick={onToggle}
          >
            <Play className="h-3 w-3" />
            {call.recording.available
              ? expanded
                ? "Hide"
                : "Play"
              : "No rec"}
          </Button>
          {call.recording.available && call.recording.playbackUrl ? (
            <a
              href={`${call.recording.playbackUrl}?download=${encodeURIComponent(
                buildDownloadFilename(call),
              )}`}
              download={buildDownloadFilename(call)}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] text-foreground hover:bg-muted/50"
              title="Download recording (mp3)"
            >
              <Download className="h-3 w-3" />
              Save
            </a>
          ) : null}
        </div>
      </div>
      {expanded && call.recording.playbackUrl ? (
        <div className="mt-2 rounded-md border border-border bg-muted/30 p-2">
          {/* /api/read/cx/recordings/play/:fileId — Range-supported Drive
              proxy, so scrubbing in the HTML5 audio element works. */}
          <audio
            controls
            preload="none"
            src={call.recording.playbackUrl}
            className="w-full"
          />
          <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
            <span title={formatDateTime(call.callStartTime)}>
              Started{" "}
              {call.callStartTime ? formatDateTime(call.callStartTime) : "—"}
            </span>
            {call.recording.driveFileId ? (
              <span className="font-mono">
                {call.recording.driveFileId.slice(0, 8)}…
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}
