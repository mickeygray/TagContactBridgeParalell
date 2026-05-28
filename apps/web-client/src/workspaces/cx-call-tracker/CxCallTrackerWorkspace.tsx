import * as React from "react";
import {
  Download,
  Folder,
  Headphones,
  HardDrive,
  Play,
  RefreshCw,
  Search,
} from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, KpiCard } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { API_BASE_URL, TOKEN_STORAGE_KEY } from "@/lib/api/client";
import {
  useCallLibrary,
  type CallDirectionFilter,
  type CallLibraryScope,
  type CallPlatformFilter,
  type DriveRecordingRow,
} from "@/lib/api/queries/callReview";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

type LibraryWindow = "today" | 7 | 30 | 90 | 365 | "all";

const WINDOW_OPTIONS: { label: string; value: LibraryWindow }[] = [
  { label: "today", value: "today" },
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "1y", value: 365 },
  { label: "all", value: "all" },
];
const AGENT_LIBRARY_GROUP_KEYS = new Set(["cx", "og"]);

function normalizeRecordingGroupKey(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function isAgentVisibleRecording(row: DriveRecordingRow): boolean {
  const groupKeys = [
    row.groupKey,
    row.recording?.groupKey,
    row.rootFolderKey,
  ].map(normalizeRecordingGroupKey);
  if (groupKeys.some((key) => AGENT_LIBRARY_GROUP_KEYS.has(key))) return true;
  if (normalizeRecordingGroupKey(row.provider) === "callrail") return true;
  return normalizeRecordingGroupKey(row.platform) === "cx";
}

function formatBytes(value: number | null | undefined): string {
  const bytes = Number(value) || 0;
  if (!bytes) return "-";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatPhone(value: string | null | undefined): string {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return value || "-";
}

function buildDownloadFilename(row: DriveRecordingRow): string {
  const base = row.fileName || row.driveFileId || "recording.mp3";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function protectedDrivePlaybackPath(row: DriveRecordingRow): string | null {
  const existing = row.playbackUrl || row.recording?.playbackUrl || null;
  if (existing) return existing;
  return null;
}

function playbackTicketPath(path: string): string {
  const parsed = new URL(path, window.location.origin);
  return `${parsed.pathname.replace("/recordings/play/", "/recordings/play-ticket/")}${parsed.search}`;
}

function isSignedStreamPath(path: string): boolean {
  return (
    path.includes("/recordings/stream/") ||
    path.includes("/api/recordings/play/") ||
    path.includes("/api/recordings/rc-play/")
  );
}

function withDownloadParam(url: string, filename: string): string {
  const parsed = new URL(url, window.location.origin);
  parsed.searchParams.set("download", filename);
  return parsed.toString();
}

function absoluteApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE_URL}${path}`;
}

async function fetchTicketedRecordingStreamUrl(path: string): Promise<string | null> {
  if (!path.includes("/recordings/play/")) return null;
  const token = window.localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!token) {
    throw new Error("Sign in again before opening a recording");
  }
  const response = await fetch(absoluteApiUrl(playbackTicketPath(path)), {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  if (response.status === 404) {
    throw new Error("Playback ticket endpoint is not loaded yet. Restart the backend service.");
  }
  if (!response.ok) {
    let message = `Playback failed (${response.status})`;
    try {
      const payload = await response.json();
      message = String(payload.error || payload.message || message);
    } catch {
      // Keep the status-based message.
    }
    throw new Error(message);
  }
  const payload = (await response.json()) as { playbackUrl?: string };
  if (!payload.playbackUrl) {
    throw new Error("Playback URL was not returned");
  }
  return absoluteApiUrl(payload.playbackUrl);
}

async function fetchRecordingStreamUrl(path: string): Promise<string> {
  if (isSignedStreamPath(path)) return absoluteApiUrl(path);
  const ticketedUrl = await fetchTicketedRecordingStreamUrl(path);
  if (ticketedUrl) return ticketedUrl;
  throw new Error("Recording playback URL could not be signed");
}

async function fetchRecordingBlobUrl(
  path: string,
  _sizeBytes: number | null | undefined,
): Promise<string> {
  const directStreamUrl = isSignedStreamPath(path)
    ? absoluteApiUrl(path)
    : await fetchTicketedRecordingStreamUrl(path);
  if (!directStreamUrl) {
    throw new Error("Recording playback URL could not be signed");
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 45_000);
  let response: Response;
  try {
    response = await fetch(directStreamUrl, {
      signal: controller.signal,
    });
    if (!response.ok && response.status !== 206) {
      let message = `Playback failed (${response.status})`;
      try {
        const payload = await response.json();
        message = String(payload.error || payload.message || message);
      } catch {
        // Keep the status-based message.
      }
      throw new Error(message);
    }
    return URL.createObjectURL(await response.blob());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Playback request timed out after 45 seconds");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

export function CxCallTrackerWorkspace({
  scope = "admin",
}: {
  scope?: CallLibraryScope;
}) {
  const [platform, setPlatform] = React.useState<CallPlatformFilter>("all");
  const [direction, setDirection] = React.useState<CallDirectionFilter>("all");
  const [recordingGroup, setRecordingGroup] = React.useState("all");
  const [window, setWindow] = React.useState<LibraryWindow>(7);
  const [search, setSearch] = React.useState("");
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  const query = useCallLibrary({
    platform,
    direction,
    recordingGroup,
    days: window,
    limit: 500,
  }, { scope });

  const rawRecordings = query.data?.recordings ?? query.data?.calls ?? [];
  const rawGroups = query.data?.recordingGroups ?? [];
  const recordings = React.useMemo(
    () => (scope === "user" ? rawRecordings.filter(isAgentVisibleRecording) : rawRecordings),
    [rawRecordings, scope],
  );
  const groups = React.useMemo(
    () =>
      scope === "user"
        ? rawGroups.filter((group) =>
            AGENT_LIBRARY_GROUP_KEYS.has(normalizeRecordingGroupKey(group.key)),
          )
        : rawGroups,
    [rawGroups, scope],
  );

  React.useEffect(() => {
    if (scope !== "user" || recordingGroup === "all") return;
    if (!AGENT_LIBRARY_GROUP_KEYS.has(normalizeRecordingGroupKey(recordingGroup))) {
      setRecordingGroup("all");
    }
  }, [recordingGroup, scope]);

  const visibleRecordings = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return recordings;
    return recordings.filter((row) => {
      const haystack = [
        row.fileName,
        row.agentName,
        row.phone,
        row.telephonySessionId,
        row.groupLabel,
        row.provider,
        row.platform,
        row.direction,
        row.folderPath,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [recordings, search]);

  React.useEffect(() => {
    if (!expandedId) return;
    if (!visibleRecordings.some((row) => row.driveFileId === expandedId)) {
      setExpandedId(null);
    }
  }, [expandedId, visibleRecordings]);

  const playNextRecording = React.useCallback(
    (driveFileId: string) => {
      const currentIndex = visibleRecordings.findIndex(
        (row) => row.driveFileId === driveFileId,
      );
      if (currentIndex < 0) {
        setExpandedId(null);
        return;
      }
      const nextRecording = visibleRecordings
        .slice(currentIndex + 1)
        .find((row) => protectedDrivePlaybackPath(row));
      setExpandedId(nextRecording?.driveFileId ?? null);
    },
    [visibleRecordings],
  );

  const totalBytes = recordings.reduce(
    (sum, row) => sum + (Number(row.sizeBytes) || 0),
    0,
  );
  const cxCount = recordings.filter(
    (row) => row.groupKey === "cx" || row.platform === "cx",
  ).length;
  const ogCount = recordings.filter(
    (row) => row.groupKey === "og" || row.provider === "callrail",
  ).length;

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Call Library"
        description={
          query.data
            ? `${visibleRecordings.length} of ${recordings.length} playable recording${
                recordings.length === 1 ? "" : "s"
              } from Google Drive${scope === "user" ? " in your folders" : ""}${
                query.data.truncated ? " (truncated)" : ""
              }`
            : "Playable recordings from the Google Drive archive."
        }
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => query.refetch()}
            isLoading={query.isFetching && !query.isLoading}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <KpiCard
          label="Playable files"
          value={formatNumber(recordings.length)}
          icon={<Headphones className="h-4 w-4" />}
        />
        <KpiCard
          label="CX"
          value={formatNumber(cxCount)}
          icon={<Play className="h-4 w-4" />}
        />
        <KpiCard
          label="OG"
          value={formatNumber(ogCount)}
          icon={<Folder className="h-4 w-4" />}
        />
        <KpiCard
          label="Buckets"
          value={formatNumber(groups.length)}
          icon={<Folder className="h-4 w-4" />}
        />
        <KpiCard
          label="Drive size"
          value={formatBytes(totalBytes)}
          icon={<HardDrive className="h-4 w-4" />}
        />
      </div>

      <Card>
        <CardContent className="p-3">
          <div className="flex flex-wrap items-center gap-2">
            <FilterGroup label="Window">
              {WINDOW_OPTIONS.map((opt) => (
                <FilterChip
                  key={String(opt.value)}
                  active={window === opt.value}
                  onClick={() => setWindow(opt.value)}
                >
                  {opt.label}
                </FilterChip>
              ))}
            </FilterGroup>
            <FilterGroup label="Bucket">
              <FilterChip
                active={recordingGroup === "all"}
                onClick={() => setRecordingGroup("all")}
              >
                all
              </FilterChip>
              {groups.map((group) => (
                <FilterChip
                  key={group.key}
                  active={recordingGroup === group.key}
                  onClick={() => setRecordingGroup(group.key)}
                >
                  {group.label} {group.callCount}
                </FilterChip>
              ))}
            </FilterGroup>
            <FilterGroup label="Platform">
              {(["all", "cx", "ex"] as CallPlatformFilter[]).map((opt) => (
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
            <div className="ml-auto flex items-center gap-2">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="file, agent, phone..."
                className="h-7 w-52 text-xs"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {query.isError ? (
            <div className="p-3">
              <ErrorState error={query.error} onRetry={() => query.refetch()} />
            </div>
          ) : query.isLoading ? (
            <div className="p-3">
              <SkeletonRow count={5} />
            </div>
          ) : visibleRecordings.length === 0 ? (
            <div className="p-3">
              <EmptyState
                title="No playable recordings"
                description={
                  recordings.length
                    ? "Your filters narrowed the Drive library out."
                    : "No audio files were found in the configured Drive archive folders."
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {visibleRecordings.map((recording) => (
                <RecordingRow
                  key={recording.driveFileId}
                  recording={recording}
                  expanded={expandedId === recording.driveFileId}
                  onToggle={() =>
                    setExpandedId(
                      expandedId === recording.driveFileId ? null : recording.driveFileId,
                    )
                  }
                  onEnded={() => playNextRecording(recording.driveFileId)}
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

function RecordingRow({
  recording,
  expanded,
  onToggle,
  onEnded,
}: {
  recording: DriveRecordingRow;
  expanded: boolean;
  onToggle: () => void;
  onEnded: () => void;
}) {
  const playbackUrl = protectedDrivePlaybackPath(recording);
  const displayTime =
    recording.callStartTime || recording.createdTime || recording.modifiedTime;
  const rowRef = React.useRef<HTMLLIElement | null>(null);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const [streamUrl, setStreamUrl] = React.useState<string | null>(null);
  const [blobUrl, setBlobUrl] = React.useState<string | null>(null);
  const [isLoadingAudio, setIsLoadingAudio] = React.useState(false);
  const [audioError, setAudioError] = React.useState<string | null>(null);
  const [audioStatus, setAudioStatus] = React.useState<string | null>(null);
  const playableUrl = blobUrl || streamUrl;
  const shouldUseBlobPlayback = false;

  React.useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  React.useEffect(() => {
    if (!expanded) return;
    rowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [expanded]);

  React.useEffect(() => {
    if (!expanded || !playbackUrl || playableUrl || isLoadingAudio) return;
    let cancelled = false;
    setAudioError(null);
    setAudioStatus(
      shouldUseBlobPlayback
        ? `Loading ${formatBytes(recording.sizeBytes)} recording...`
        : "Opening recording stream...",
    );
    setIsLoadingAudio(true);
    const load = shouldUseBlobPlayback
      ? fetchRecordingBlobUrl(playbackUrl, recording.sizeBytes)
      : fetchRecordingStreamUrl(playbackUrl);
    load
      .then((url) => {
        if (cancelled) {
          if (url.startsWith("blob:")) URL.revokeObjectURL(url);
          return;
        }
        if (url.startsWith("blob:")) {
          setBlobUrl(url);
        } else {
          setStreamUrl(url);
        }
        setAudioStatus(url.startsWith("blob:") ? "Ready" : "Streaming");
      })
      .catch((error) => {
        if (!cancelled) {
          setAudioError(error.message || "Could not load recording");
          setAudioStatus(null);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingAudio(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    expanded,
    isLoadingAudio,
    playbackUrl,
    playableUrl,
    recording.sizeBytes,
    shouldUseBlobPlayback,
  ]);

  React.useEffect(() => {
    if (!expanded || !playableUrl || !audioRef.current) return;
    void audioRef.current.play().catch(() => {
      setAudioStatus("Ready - press play to continue");
    });
  }, [expanded, playableUrl]);

  const downloadRecording = async () => {
    if (!playbackUrl) return;
    setAudioError(null);
    try {
      const url = playableUrl || (await fetchRecordingBlobUrl(playbackUrl, recording.sizeBytes));
      if (!playableUrl && url.startsWith("blob:")) setBlobUrl(url);
      const link = document.createElement("a");
      link.href = url.startsWith("blob:")
        ? url
        : withDownloadParam(url, buildDownloadFilename(recording));
      link.download = buildDownloadFilename(recording);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : "Could not download recording");
      setAudioStatus(null);
    }
  };

  const openRecording = async () => {
    if (!playbackUrl) return;
    setAudioError(null);
    try {
      const url = streamUrl || (await fetchRecordingStreamUrl(playbackUrl));
      setStreamUrl(url);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : "Could not open recording");
      setAudioStatus(null);
    }
  };

  return (
    <li ref={rowRef} className="px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <Headphones className="h-4 w-4 shrink-0 text-primary" />
        <span
          className="w-20 font-mono text-[10px] text-muted-foreground"
          title={displayTime ? formatDateTime(displayTime) : undefined}
        >
          {displayTime ? formatRelative(displayTime) : "-"}
        </span>
        <span className="min-w-[8rem] truncate font-medium">
          {recording.agentName || "Unknown agent"}
        </span>
        <span className="w-28 truncate text-foreground/80">
          {formatPhone(recording.phone)}
        </span>
        <StatusPill tone="info">{recording.groupLabel || "Drive"}</StatusPill>
        {recording.platform ? (
          <span className="uppercase text-muted-foreground">
            {recording.platform}
          </span>
        ) : null}
        {recording.direction ? (
          <span className="text-muted-foreground">{recording.direction}</span>
        ) : null}
        <span className="truncate text-muted-foreground" title={recording.fileName || undefined}>
          {recording.fileName || recording.driveFileId}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {formatBytes(recording.sizeBytes)}
        </span>
        <Button
          variant="primary"
          size="sm"
          className="h-7 px-2"
          disabled={!playbackUrl}
          onClick={onToggle}
          isLoading={expanded && isLoadingAudio}
        >
          <Play className="h-3 w-3" />
          {expanded ? "Hide" : "Play"}
        </Button>
        {playbackUrl ? (
          <>
            <button
              type="button"
              onClick={openRecording}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] text-foreground hover:bg-muted/50"
              title="Open recording stream"
            >
              Open
            </button>
            <button
              type="button"
              onClick={downloadRecording}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] text-foreground hover:bg-muted/50"
              title="Download recording"
            >
              <Download className="h-3 w-3" />
              Save
            </button>
          </>
        ) : null}
      </div>
      {expanded && playbackUrl ? (
        <div className="mt-2 rounded-md border border-border bg-muted/30 p-2">
          {audioError ? (
            <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
              {audioError}
            </div>
          ) : playableUrl ? (
            <audio
              ref={audioRef}
              controls
              preload="metadata"
              src={playableUrl}
              className="w-full"
              onCanPlay={() => setAudioStatus("Ready")}
              onEnded={onEnded}
              onError={() => {
                setAudioError("Audio player could not load this recording stream");
                setAudioStatus(null);
              }}
            />
          ) : (
            <div className="rounded border border-border bg-card px-3 py-2 text-[11px] text-muted-foreground">
              {audioStatus || "Loading recording..."}
            </div>
          )}
          <div className="mt-1 flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
            <span className="truncate" title={recording.folderPath || undefined}>
              {recording.folderPath || recording.rootFolderLabel || "Drive"}
            </span>
            <span className="font-mono">
              {audioStatus ? `${audioStatus} · ` : ""}
              {recording.driveFileId.slice(0, 10)}
            </span>
          </div>
        </div>
      ) : null}
    </li>
  );
}
