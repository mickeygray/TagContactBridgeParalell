import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FileText,
  Loader2,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { StatusPill, type StatusTone } from "@/components/ui/StatusPill";
import { ApiError } from "@/lib/api/client";
import {
  salesTrainerApi,
  type TrainerCallReviewProvider,
  type TrainerCallReviewResult,
  type TrainerCallReviewScriptStatus,
  type TrainerCallReviewStatus,
  type TrainerCaseReviewCall,
  type TrainerCaseReviewLookup,
} from "@/lib/api/salesTrainer";
import { KNOWN_DOMAINS } from "@/lib/domain/domainStore";
import { formatDateTime, formatDuration } from "@/lib/utils/format";

const PROVIDER_LABELS: Record<TrainerCallReviewProvider, string> = {
  ex: "EX",
  phoneburner: "PhoneBurner",
  callrail: "CallRail",
};

function requestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `case-review-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown, operation: "lookup" | "review"): string {
  if (error instanceof ApiError) {
    if (error.status === 400 || error.status === 422) {
      return operation === "lookup"
        ? "Enter a valid domain and case number."
        : "That call could not be submitted for review.";
    }
    if (error.status === 401) return "Your Trainer sign-in expired. Sign in again.";
    if (error.status === 403) {
      return "This case is not assigned to you, or Logics could not confirm the current assignment.";
    }
    if (error.status === 404) {
      return operation === "lookup"
        ? "That case or its call history could not be found."
        : "That saved review is no longer available.";
    }
    if (error.status === 409) {
      return "The case assignment changed. Check the case again.";
    }
    if (error.status === 503) return "Case Review is temporarily unavailable.";
  }
  return operation === "lookup"
    ? "The case could not be checked. Try again."
    : "The call review could not be loaded. Try again.";
}

function reviewTone(status: TrainerCallReviewStatus): StatusTone {
  if (status === "completed") return "success";
  if (status === "processing") return "info";
  if (status === "failed") return "danger";
  return "neutral";
}

function reviewLabel(status: TrainerCallReviewStatus): string {
  if (status === "not_started") return "Not analyzed";
  if (status === "processing") return "Analyzing";
  if (status === "completed") return "Saved";
  return "Failed";
}

function reviewPending(status: TrainerCallReviewStatus | null): boolean {
  return status === "not_started" || status === "processing";
}

function assignmentNoLongerConfirmed(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 409);
}

function actionLabel(call: TrainerCaseReviewCall): string {
  if (call.recordingStatus === "pending") return "Recording pending";
  if (call.recordingStatus === "unavailable") return "No recording";
  if (call.reviewStatus === "processing") return "Analyzing...";
  if (call.reviewStatus === "completed") {
    return call.reviewId ? "View saved result" : "Result unavailable";
  }
  if (call.reviewStatus === "failed") return "Retry analysis";
  return "Analyze this call";
}

function scriptStatusLabel(status: TrainerCallReviewScriptStatus): string {
  if (status === "not_applicable") return "Not applicable";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function scriptStatusTone(status: TrainerCallReviewScriptStatus): StatusTone {
  if (status === "observed") return "success";
  if (status === "partial") return "warning";
  if (status === "missed") return "danger";
  if (status === "uncertain") return "info";
  return "neutral";
}

function confidenceLabel(confidence: number | null): string | null {
  if (confidence == null || !Number.isFinite(confidence)) return null;
  return `${Math.round(Math.min(1, Math.max(0, confidence)) * 100)}% confidence`;
}

function formatOffset(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function ReviewResult({ review }: { review: TrainerCallReviewResult }) {
  if (review.status === "processing" || review.status === "not_started") {
    return (
      <section className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-5">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-sky-600" />
          <div>
            <h3 className="font-semibold">Analyzing the call</h3>
            <p className="text-sm text-muted-foreground">
              The saved transcript and coaching notes will appear here when they are ready.
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (review.status === "failed") {
    return (
      <section className="rounded-lg border border-destructive/30 bg-destructive/5 p-5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-destructive" />
          <div>
            <h3 className="font-semibold">Analysis could not be completed</h3>
            <p className="text-sm text-muted-foreground">
              Retry from the call list. If it keeps failing, the recording may still be processing.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const segments = review.transcript?.segments ?? [];
  return (
    <section className="space-y-5 rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            <h2 className="text-base font-semibold">Saved call review</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDateTime(review.source.startedAt)} - {formatDuration(review.source.durationSec)}
          </p>
        </div>
        <StatusPill tone="success">Completed {formatDateTime(review.completedAt)}</StatusPill>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <StatusPill tone="info">{PROVIDER_LABELS[review.source.provider]}</StatusPill>
        <StatusPill tone="neutral">{review.source.direction || "Unknown direction"}</StatusPill>
        <StatusPill tone="neutral">{review.source.agentName || "Unknown agent"}</StatusPill>
        {review.source.outcome ? <StatusPill tone="neutral">{review.source.outcome}</StatusPill> : null}
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Transcript</h3>
        </div>
        {segments.length ? (
          <ol className="space-y-2">
            {segments.map((segment) => (
              <li key={segment.segmentId} className="rounded-md border border-border bg-muted/20 p-3 text-sm">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{formatOffset(segment.startMs)}</span>
                  <span className="font-semibold capitalize text-foreground">{segment.speaker}</span>
                </div>
                <p className="whitespace-pre-wrap leading-relaxed">{segment.text}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            A transcript was not available for this saved review.
          </p>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Script review</h3>
        </div>
        {review.scriptFindings.length ? (
          <ol className="space-y-3">
            {review.scriptFindings.map((finding) => {
              const confidence = confidenceLabel(finding.confidence);
              const ruleLabel = [finding.sectionId, finding.beatId].filter(Boolean).join(" / ");
              return (
                <li key={finding.findingId} className="rounded-md border border-border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill tone={scriptStatusTone(finding.status)}>
                      {scriptStatusLabel(finding.status)}
                    </StatusPill>
                    {ruleLabel ? <span className="font-mono text-xs text-muted-foreground">{ruleLabel}</span> : null}
                    {confidence ? <span className="text-xs text-muted-foreground">{confidence}</span> : null}
                  </div>
                  <h4 className="mt-2 font-medium">{finding.title}</h4>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{finding.summary}</p>
                  {finding.citations.length ? (
                    <ul className="mt-3 space-y-2">
                      {finding.citations.map((citation) => (
                        <li
                          key={`${citation.segmentId}-${citation.startMs}`}
                          className="border-l-2 border-primary/30 pl-3 text-sm"
                        >
                          <div className="font-mono text-[11px] text-muted-foreground">
                            {formatOffset(citation.startMs)} to {formatOffset(citation.endMs)}
                          </div>
                          <p className="mt-0.5 italic">&quot;{citation.quote}&quot;</p>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            No authoritative script findings were saved for this review.
          </p>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Things to consider</h3>
        </div>
        {review.thingsToConsider.length ? (
          <ol className="space-y-3">
            {review.thingsToConsider.map((finding) => (
              <li key={finding.findingId} className="rounded-md border border-border p-4">
                <h4 className="font-medium">{finding.title}</h4>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{finding.summary}</p>
                {finding.citations.length ? (
                  <ul className="mt-3 space-y-2">
                    {finding.citations.map((citation) => (
                      <li key={`${citation.segmentId}-${citation.startMs}`} className="border-l-2 border-primary/30 pl-3 text-sm">
                        <div className="font-mono text-[11px] text-muted-foreground">
                          {formatOffset(citation.startMs)} to {formatOffset(citation.endMs)}
                        </div>
                        <p className="mt-0.5 italic">&quot;{citation.quote}&quot;</p>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            No coaching notes were saved for this review.
          </p>
        )}
      </div>
    </section>
  );
}

export function CaseReviewPanel() {
  const [domain, setDomain] = useState<string>(KNOWN_DOMAINS[0]);
  const [caseNumber, setCaseNumber] = useState("");
  const [lookup, setLookup] = useState<TrainerCaseReviewLookup | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [startingSourceId, setStartingSourceId] = useState<string | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [activeReviewId, setActiveReviewId] = useState<string | null>(null);
  const [activeReviewStatus, setActiveReviewStatus] = useState<TrainerCallReviewStatus | null>(null);
  const [activeReview, setActiveReview] = useState<TrainerCallReviewResult | null>(null);
  const lookupRequestRef = useRef(0);
  const reviewRequestRef = useRef(0);

  useEffect(() => {
    return () => {
      lookupRequestRef.current += 1;
      reviewRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!activeReviewId || !reviewPending(activeReviewStatus)) return undefined;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const next = await salesTrainerApi.callReview(activeReviewId);
        if (cancelled) return;
        setActiveReview(next);
        setActiveReviewStatus(next.status);
        setReviewError("");
        setLookup((current) =>
          current
            ? {
                ...current,
                calls: current.calls.map((call) =>
                  call.reviewId === activeReviewId ? { ...call, reviewStatus: next.status } : call,
                ),
              }
            : current,
        );
        if (reviewPending(next.status)) {
          timer = window.setTimeout(() => void poll(), 2500);
        }
      } catch (error) {
        if (cancelled) return;
        if (assignmentNoLongerConfirmed(error)) setLookup(null);
        setReviewError(errorMessage(error, "review"));
        setActiveReview(null);
        setActiveReviewId(null);
        setActiveReviewStatus(null);
      }
    };

    timer = window.setTimeout(() => void poll(), 1500);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeReviewId, activeReviewStatus]);

  async function checkCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedCaseNumber = caseNumber.trim();
    if (!normalizedCaseNumber) {
      setLookupError("Enter a case number.");
      return;
    }

    const request = ++lookupRequestRef.current;
    reviewRequestRef.current += 1;
    setLookupBusy(true);
    setLookupError("");
    setLookup(null);
    setReviewError("");
    setActiveReview(null);
    setActiveReviewId(null);
    setActiveReviewStatus(null);
    try {
      const next = await salesTrainerApi.caseReviewCaseCalls({
        domain,
        caseNumber: normalizedCaseNumber,
      });
      if (request === lookupRequestRef.current) setLookup(next);
    } catch (error) {
      if (request === lookupRequestRef.current) setLookupError(errorMessage(error, "lookup"));
    } finally {
      if (request === lookupRequestRef.current) setLookupBusy(false);
    }
  }

  async function openSavedReview(reviewId: string) {
    const request = ++reviewRequestRef.current;
    setReviewLoading(true);
    setReviewError("");
    setActiveReview(null);
    setActiveReviewId(reviewId);
    setActiveReviewStatus(null);
    try {
      const next = await salesTrainerApi.callReview(reviewId);
      if (request !== reviewRequestRef.current) return;
      setActiveReview(next);
      setActiveReviewStatus(next.status);
    } catch (error) {
      if (request !== reviewRequestRef.current) return;
      if (assignmentNoLongerConfirmed(error)) setLookup(null);
      setReviewError(errorMessage(error, "review"));
      setActiveReviewId(null);
      setActiveReviewStatus(null);
    } finally {
      if (request === reviewRequestRef.current) setReviewLoading(false);
    }
  }

  async function startReview(call: TrainerCaseReviewCall) {
    const sourceId = call.sourceId;
    if (!lookup || !sourceId || call.recordingStatus !== "available") return;
    const request = ++reviewRequestRef.current;
    setStartingSourceId(sourceId);
    setReviewLoading(false);
    setReviewError("");
    setActiveReview(null);
    setActiveReviewId(null);
    setActiveReviewStatus(null);
    try {
      const started = await salesTrainerApi.startCallReview({
        caseSourceId: lookup.caseSourceId,
        sourceId,
        requestId: requestId(),
      });
      if (request !== reviewRequestRef.current) return;
      setLookup((current) =>
        current
          ? {
              ...current,
              calls: current.calls.map((row) =>
                row.sourceId === sourceId
                  ? { ...row, reviewStatus: started.status, reviewId: started.reviewId }
                  : row,
              ),
            }
          : current,
      );
      setActiveReviewId(started.reviewId);
      setActiveReviewStatus(started.status);
      if (!reviewPending(started.status)) {
        setReviewLoading(true);
        const next = await salesTrainerApi.callReview(started.reviewId);
        if (request !== reviewRequestRef.current) return;
        setActiveReview(next);
        setActiveReviewStatus(next.status);
      }
    } catch (error) {
      if (request !== reviewRequestRef.current) return;
      if (assignmentNoLongerConfirmed(error)) setLookup(null);
      setReviewError(errorMessage(error, "review"));
      setActiveReview(null);
      setActiveReviewId(null);
      setActiveReviewStatus(null);
    } finally {
      if (request === reviewRequestRef.current) {
        setStartingSourceId(null);
        setReviewLoading(false);
      }
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-base font-semibold">Case review</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Enter a domain and Logics case number. We check the latest assignment activity and show calls at least five minutes long.
            </p>
          </div>
        </div>

        <form onSubmit={(event) => void checkCase(event)} className="mt-5 grid gap-3 sm:grid-cols-[180px_minmax(220px,1fr)_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="case-review-domain">Domain</Label>
            <Select value={domain} onValueChange={setDomain}>
              <SelectTrigger id="case-review-domain">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KNOWN_DOMAINS.map((knownDomain) => (
                  <SelectItem key={knownDomain} value={knownDomain}>{knownDomain}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="case-review-number">Case number</Label>
            <Input
              id="case-review-number"
              value={caseNumber}
              onChange={(event) => setCaseNumber(event.target.value)}
              inputMode="numeric"
              autoComplete="off"
              placeholder="Enter the Logics case number"
            />
          </div>
          <Button type="submit" isLoading={lookupBusy} disabled={!caseNumber.trim()}>
            <Search className="h-4 w-4" />
            Get calls
          </Button>
        </form>

        {lookupError ? (
          <div className="mt-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{lookupError}</span>
          </div>
        ) : null}
      </section>

      {lookup ? (
        <section className="rounded-lg border border-border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">Meaningful calls</h2>
              <p className="text-sm text-muted-foreground">
                {lookup.domain} case {lookup.caseNumber} - five minutes or longer
              </p>
            </div>
            <StatusPill tone="success" dotted>Assignment confirmed {formatDateTime(lookup.authorizationCheckedAt)}</StatusPill>
          </div>

          {lookup.calls.length ? (
            <ul className="mt-4 space-y-2">
              {lookup.calls.map((call, index) => {
                const canOpen = call.reviewStatus === "completed" && Boolean(call.reviewId);
                const canStart =
                  Boolean(call.sourceId) &&
                  call.recordingStatus === "available" &&
                  call.reviewStatus !== "processing" &&
                  (call.reviewStatus !== "completed" || !call.reviewId);
                return (
                  <li key={call.sourceId || `${call.provider}-${call.startedAt}-${index}`} className="flex flex-col gap-3 rounded-md border border-border bg-muted/10 p-4 lg:flex-row lg:items-center">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusPill tone="info">{PROVIDER_LABELS[call.provider]}</StatusPill>
                        <StatusPill tone={reviewTone(call.reviewStatus)}>{reviewLabel(call.reviewStatus)}</StatusPill>
                        <span className="text-sm font-medium">{call.agentName || "Unknown agent"}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>{formatDateTime(call.startedAt)}</span>
                        <span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" />{formatDuration(call.durationSec)}</span>
                        <span>{call.direction || "Unknown direction"}</span>
                        {call.outcome ? <span>{call.outcome}</span> : null}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={canOpen ? "secondary" : "primary"}
                      disabled={!canOpen && !canStart}
                      isLoading={Boolean(call.sourceId && startingSourceId === call.sourceId) || (reviewLoading && activeReviewId === call.reviewId)}
                      onClick={() => {
                        if (canOpen && call.reviewId) void openSavedReview(call.reviewId);
                        else if (canStart && call.sourceId) void startReview(call);
                      }}
                    >
                      {actionLabel(call)}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="mt-4 rounded-md border border-dashed border-border p-6 text-center">
              <p className="font-medium">No meaningful calls found</p>
              <p className="mt-1 text-sm text-muted-foreground">This case has no meaningful calls at least five minutes long.</p>
            </div>
          )}
        </section>
      ) : null}

      {reviewError ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{reviewError}</span>
        </div>
      ) : null}

      {reviewLoading && !activeReview ? (
        <section className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading the saved review...
          </div>
        </section>
      ) : activeReview ? (
        <ReviewResult review={activeReview} />
      ) : activeReviewId && reviewPending(activeReviewStatus) ? (
        <section className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-5">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-sky-600" />
            <div>
              <h3 className="font-semibold">Analyzing the call</h3>
              <p className="text-sm text-muted-foreground">The saved result will appear here automatically.</p>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
