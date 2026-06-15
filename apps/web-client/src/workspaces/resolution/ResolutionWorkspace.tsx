import * as React from "react";
import {
  ArrowLeft, ChevronDown, ChevronUp, FileUp, Gem, Loader2, LogOut,
  Plus, RotateCcw, Send, ShieldAlert, Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { api } from "@/lib/api/client";
import { useSession } from "@/lib/auth/useSession";
import { cn } from "@/lib/utils/cn";

// Resolution intelligence — the case bank.
//
// Cards, best-prospect-first (the pursuit model). Clicking a card opens the
// PROFILE PAGE: full dossier on the left, the Opus pitch designer on the
// right — a back-and-forth conversation that maintains a live verdict card
// (pitchable class, plays, fee range, clocks, missing docs).
// Uploads are parse-and-delete — the file is read in memory server-side,
// distilled into shorthand, recorded as a hash, and never stored.

type ResolutionAccess = { read: boolean; write: boolean; agent: boolean };

type BankRow = {
  profileKey?: string;
  domain: string;
  caseNumber: string;
  credit?: { score?: number | null; pullCount?: number };
  funding?: { funded?: boolean; rejected?: boolean; lastLoanTotal?: number | null };
  payments?: { totalPaid?: number; count?: number; lastDate?: string | null };
  touches?: {
    work?: { lastDate?: string | null; product?: string | null };
    sales?: { lastDate?: string | null; lastPitched?: string | null; servicesPitched?: string | null };
  };
  temperature?: { label?: string; signals?: string | null };
  pursuit?: { score?: number; tier?: string; reasons?: string | null };
  shorthand?: Record<string, ShorthandEntry> | null;
};

type BankSummary = {
  total: number;
  retired: number;
  tiers: Record<string, number>;
  temperatures: Record<string, number>;
  domains?: Record<string, number>;
};

type ShorthandEntry = { value: unknown; snippet?: string; asOf?: string; source?: string };
type NoticeAlert = {
  uploadedAt?: string;
  documentName?: string;
  noticeMatches?: string;
  recommendedAction?: string;
};

type PitchVerdict = {
  class: "PITCH_NOW" | "DEVELOP" | "NURTURE" | "PASS";
  headline?: string;
  plays?: string[];
  angle?: string;
  fee?: { low?: number | null; high?: number | null; monthly?: number | null; path?: string | null } | null;
  clocks?: Array<{ what?: string; by?: string }>;
  missingDocs?: string[];
  citations?: string[];
  at?: string;
};

type PitchMessage = { role: "user" | "assistant"; content: string; at?: string; by?: string | null };

type FullProfile = BankRow & {
  shorthand?: Record<string, ShorthandEntry> | null;
  documentHashes?: Array<{ docType?: string; parsedAt?: string; label?: string }>;
  pitch?: { thread?: PitchMessage[]; verdict?: PitchVerdict | null; updatedAt?: string } | null;
};

type ProfileIdentity = { caseNumber: string; domain: string; profileKey?: string };

const DOMAIN_OPTIONS = ["TAG", "WYNN"];

const DOC_TYPES = [
  { key: "ths", label: "THS Tax Analysis (PDF)" },
  { key: "wit", label: "W&I Transcript (HTML)" },
  { key: "rt", label: "Return Transcript (HTML)" },
  { key: "lexis", label: "Lexis Export (TXT)" },
];

const TIER_FILTERS = ["ALL", "A", "B", "C", "D"];

function normalizeDomain(value?: string | null) {
  return String(value || "TAG").trim().toUpperCase() || "TAG";
}

function profileIdentity(row: Pick<BankRow, "caseNumber" | "domain" | "profileKey">): ProfileIdentity {
  const domain = normalizeDomain(row.domain);
  return {
    caseNumber: row.caseNumber,
    domain,
    profileKey: row.profileKey || `${domain}:${row.caseNumber}`,
  };
}

function tierTone(tier?: string) {
  const t = String(tier || "").charAt(0);
  if (t === "A") return "border-emerald-300 bg-emerald-50 text-emerald-800";
  if (t === "B") return "border-sky-300 bg-sky-50 text-sky-800";
  if (t === "C") return "border-amber-300 bg-amber-50 text-amber-800";
  return "border-slate-300 bg-slate-50 text-slate-700";
}

function tempTone(label?: string) {
  if (label === "hot") return "border-red-300 bg-red-50 text-red-700";
  if (label === "warm") return "border-orange-300 bg-orange-50 text-orange-700";
  if (label === "cold") return "border-blue-200 bg-blue-50 text-blue-700";
  return "border-border bg-muted text-muted-foreground";
}

function verdictTone(cls?: string) {
  if (cls === "PITCH_NOW") return "border-emerald-400 bg-emerald-50 text-emerald-900";
  if (cls === "DEVELOP") return "border-sky-400 bg-sky-50 text-sky-900";
  if (cls === "NURTURE") return "border-amber-400 bg-amber-50 text-amber-900";
  if (cls === "PASS") return "border-slate-300 bg-slate-100 text-slate-700";
  return "border-border bg-muted text-muted-foreground";
}

function fmtMoney(value?: number | null) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return `$${Number(value).toLocaleString()}`;
}

function daysAgo(value?: string | null) {
  if (!value) return null;
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 86_400_000);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getLogicsBilling(profile?: Pick<BankRow, "shorthand"> | null) {
  const value = asRecord(profile?.shorthand?.logics_billing?.value);
  return value as { pastDue?: number; amountDue?: number; dueDate?: string } | null;
}

function isPaymentDelinquent(profile?: Pick<BankRow, "shorthand"> | null) {
  const billing = getLogicsBilling(profile);
  const pastDue = Number(billing?.pastDue || 0);
  return Number.isFinite(pastDue) && pastDue > 0;
}

function getNoticeAlerts(profile?: Pick<BankRow, "shorthand"> | null): NoticeAlert[] {
  const value = profile?.shorthand?.logics_notice_alerts?.value;
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => asRecord(row))
    .filter(Boolean)
    .map((row) => ({
      uploadedAt: String(row?.uploadedAt || ""),
      documentName: String(row?.documentName || ""),
      noticeMatches: String(row?.noticeMatches || ""),
      recommendedAction: String(row?.recommendedAction || ""),
    }))
    .filter((row) => row.noticeMatches || row.documentName);
}

function summarizeNoticeAlerts(alerts: NoticeAlert[]) {
  const labels = alerts
    .flatMap((alert) => String(alert.noticeMatches || alert.documentName || "").split("|"))
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(labels)].slice(0, 4).join(" / ");
}

function UploadSlot({ caseNumber, domain, canWrite, onUploaded, compact = true }: {
  caseNumber: string;
  domain: string;
  canWrite: boolean;
  onUploaded: () => void;
  compact?: boolean;
}) {
  const [docType, setDocType] = React.useState("ths");
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  async function send(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("docType", docType);
      form.append("domain", normalizeDomain(domain));
      const result = await api.post<{
        ok: boolean; deduped?: boolean; docLabel?: string;
        fieldsExtracted?: string[]; snippets?: Record<string, string>; message?: string; error?: string;
      }>(`/api/resolution/cases/${encodeURIComponent(caseNumber)}/documents`, form);
      if (result?.ok) {
        if (result.deduped) {
          toast(`Already parsed: ${result.docLabel || "document"}`, { description: result.message });
        } else {
          toast.success(`Parsed: ${result.docLabel || "document"}`, {
            description: `${(result.fieldsExtracted || []).length} shorthand fields updated. The document was not stored.`,
          });
          onUploaded();
        }
      } else {
        toast.error("Parse failed", { description: result?.error || "Re-upload or check the document type." });
      }
    } catch (err) {
      toast.error("Parse failed — document NOT recorded", {
        description: err instanceof Error ? err.message : "Re-upload or check the document type.",
      });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  if (!canWrite) return null;
  return (
    <div className={cn("flex items-center gap-1.5", compact && "mt-2 border-t border-dashed border-border pt-2")}>
      <select
        value={docType}
        onChange={(e) => setDocType(e.target.value)}
        className="h-7 rounded-md border border-input bg-background px-1.5 text-[11px]"
        disabled={busy}
      >
        {DOC_TYPES.map((d) => (
          <option key={d.key} value={d.key}>{d.label}</option>
        ))}
      </select>
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        accept=".pdf,.html,.htm,.txt"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void send(file);
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="h-7 gap-1 px-2 text-[11px]"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileUp className="h-3 w-3" />}
        {busy ? "Parsing..." : "Upload"}
      </Button>
      <span className="text-[10px] text-muted-foreground">parse → shorthand → file deleted</span>
    </div>
  );
}

// Dependency-free render of the narrow markdown the doctrine emits:
// "## headers", "**bold**", "- bullets". Everything else passes through.
function MiniMarkdown({ text }: { text: string }) {
  const renderInline = (line: string, key: number) => {
    const parts = line.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**")
        ? <strong key={i}>{part.slice(2, -2)}</strong>
        : part,
    );
    return <React.Fragment key={key}>{parts}</React.Fragment>;
  };
  return (
    <div className="space-y-1">
      {text.split("\n").map((line, i) => {
        if (/^#{1,4}\s/.test(line)) {
          return <div key={i} className="pt-1 text-[11px] font-bold uppercase tracking-wide">{renderInline(line.replace(/^#{1,4}\s/, ""), i)}</div>;
        }
        if (/^\s*[-•]\s/.test(line)) {
          return (
            <div key={i} className="flex gap-1.5 pl-1">
              <span className="shrink-0">•</span>
              <span>{renderInline(line.replace(/^\s*[-•]\s/, ""), i)}</span>
            </div>
          );
        }
        if (!line.trim()) return <div key={i} className="h-1" />;
        return <div key={i}>{renderInline(line, i)}</div>;
      })}
    </div>
  );
}

function VerdictCard({ verdict }: { verdict: PitchVerdict | null | undefined }) {
  if (!verdict) return null;
  return (
    <div className={cn("space-y-1.5 rounded-lg border-2 p-3", verdictTone(verdict.class))}>
      <div className="flex items-center justify-between gap-2">
        <span className="rounded-full border border-current px-2 py-0.5 text-[11px] font-bold tracking-wide">
          {verdict.class.replace("_", " ")}
        </span>
        {verdict.fee && (verdict.fee.low || verdict.fee.high) ? (
          <span className="text-sm font-bold">
            {fmtMoney(verdict.fee.low)}–{fmtMoney(verdict.fee.high)}
            {verdict.fee.monthly ? <span className="font-medium"> · {fmtMoney(verdict.fee.monthly)}/mo</span> : null}
          </span>
        ) : null}
      </div>
      {verdict.headline ? <div className="text-sm font-semibold leading-snug">{verdict.headline}</div> : null}
      {verdict.plays?.length ? (
        <div className="flex flex-wrap gap-1">
          {verdict.plays.map((p) => (
            <span key={p} className="rounded-full border border-current/40 bg-white/50 px-1.5 py-0.5 text-[10px] font-medium">{p}</span>
          ))}
        </div>
      ) : null}
      {verdict.fee?.path ? <div className="text-[11px]">Funding: {verdict.fee.path}</div> : null}
      {verdict.clocks?.length ? (
        <div className="space-y-0.5">
          {verdict.clocks.map((c, i) => (
            <div key={i} className="text-[11px] font-medium">⏱ {c.what}{c.by ? ` — ${c.by}` : ""}</div>
          ))}
        </div>
      ) : null}
      {verdict.missingDocs?.length ? (
        <div className="text-[11px]">Needs: {verdict.missingDocs.join(", ")}</div>
      ) : null}
      {verdict.citations?.length ? (
        <div className="truncate text-[10px] opacity-70" title={verdict.citations.join(", ")}>
          cites {verdict.citations.join(", ")}
        </div>
      ) : null}
      {verdict.at ? (
        <div className="text-[10px] opacity-60">assessed {new Date(verdict.at).toLocaleString()}</div>
      ) : null}
    </div>
  );
}

function PitchDesigner({ caseNumber, profile, canUseAgent, onProfileChange }: {
  caseNumber: string;
  profile: FullProfile;
  canUseAgent: boolean;
  onProfileChange: () => void;
}) {
  const [thread, setThread] = React.useState<PitchMessage[]>(profile.pitch?.thread || []);
  const [verdict, setVerdict] = React.useState<PitchVerdict | null>(profile.pitch?.verdict || null);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    setThread(profile.pitch?.thread || []);
    setVerdict(profile.pitch?.verdict || null);
  }, [profile]);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [thread, busy]);

  async function ask(message?: string) {
    setBusy(true);
    try {
      const result = await api.post<{
        ok: boolean; reply?: string; verdict?: PitchVerdict | null; thread?: PitchMessage[]; error?: string;
      }>(`/api/resolution/cases/${encodeURIComponent(caseNumber)}/agent/ask`, {
        domain: normalizeDomain(profile.domain),
        ...(message ? { message } : {}),
      });
      if (result?.ok) {
        setThread(result.thread || []);
        setVerdict(result.verdict || null);
        setDraft("");
      } else {
        toast.error("Pitch designer failed", { description: result?.error });
      }
    } catch (err) {
      toast.error("Pitch designer failed", { description: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    try {
      await api.post(`/api/resolution/cases/${encodeURIComponent(caseNumber)}/agent/reset`, {
        domain: normalizeDomain(profile.domain),
      });
      setThread([]);
      setVerdict(null);
      onProfileChange();
      toast("Pitch thread cleared");
    } catch (err) {
      toast.error("Reset failed", { description: err instanceof Error ? err.message : undefined });
    }
  }

  if (!canUseAgent) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
        Pitch designer requires <code className="rounded bg-muted px-1">resolution.agent</code>.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="h-4 w-4 text-violet-600" />
          Pitch designer
        </div>
        {thread.length ? (
          <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[10px]" onClick={() => void reset()} disabled={busy}>
            <RotateCcw className="h-3 w-3" /> Reset
          </Button>
        ) : null}
      </div>

      <VerdictCard verdict={verdict} />

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto rounded-md border bg-muted/30 p-2">
        {!thread.length && !busy ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
            <p className="text-xs text-muted-foreground">
              No pitch designed yet. The agent reads the full dossier, walks the
              four gates (need / means / openness / timing), and proposes the
              play with a fee range — floor $5,000.
            </p>
            <Button type="button" size="sm" className="gap-1.5" onClick={() => void ask()} disabled={busy}>
              <Gem className="h-3.5 w-3.5" /> Assess pitchability
            </Button>
          </div>
        ) : (
          thread.map((m, i) => (
            <div
              key={i}
              className={cn(
                "max-w-[92%] rounded-lg px-2.5 py-1.5 text-xs leading-relaxed",
                m.role === "user"
                  ? "ml-auto whitespace-pre-wrap bg-violet-600 text-white"
                  : "border bg-background text-foreground",
              )}
            >
              {m.role === "assistant" ? <MiniMarkdown text={m.content} /> : m.content}
            </div>
          ))
        )}
        {busy ? (
          <div className="flex items-center gap-2 px-2 py-1 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Opus is reading the dossier...
          </div>
        ) : null}
      </div>

      <form
        className="flex items-end gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          if (text && !busy) void ask(text);
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const text = draft.trim();
              if (text && !busy) void ask(text);
            }
          }}
          placeholder={thread.length ? "Refine the pitch — push back, ask for lines, change the angle..." : "Or ask something specific first..."}
          rows={2}
          disabled={busy}
          className="min-h-[40px] flex-1 resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs"
        />
        <Button type="submit" size="sm" className="h-8 px-2.5" disabled={busy || !draft.trim()}>
          <Send className="h-3.5 w-3.5" />
        </Button>
      </form>
    </div>
  );
}

function AddCaseSlot({ onAdded }: { onAdded: (identity: ProfileIdentity) => void }) {
  const [value, setValue] = React.useState("");
  const [domain, setDomain] = React.useState("TAG");
  const [busy, setBusy] = React.useState(false);

  async function add() {
    const caseNumber = value.trim();
    if (!/^\d{3,12}$/.test(caseNumber)) {
      toast.error("Enter a Logics case ID (digits only)");
      return;
    }
    setBusy(true);
    try {
      const result = await api.post<{
        ok: boolean; created?: boolean; fields?: string[]; error?: string; profile?: FullProfile;
      }>("/api/resolution/cases", { caseNumber, domain: normalizeDomain(domain) });
      if (result?.ok) {
        const added = profileIdentity(result.profile || { caseNumber, domain });
        toast.success(result.created ? `${added.domain} case ${caseNumber} added to the bank` : `${added.domain} case ${caseNumber} refreshed (already in bank)`, {
          description: result.fields?.length ? `Logics fields: ${result.fields.join(", ")}` : undefined,
        });
        setValue("");
        onAdded(added);
      } else {
        toast.error("Add failed", { description: result?.error });
      }
    } catch (err) {
      toast.error("Add failed — case not found in Logics?", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void add();
      }}
    >
      <select
        value={domain}
        onChange={(e) => setDomain(normalizeDomain(e.target.value))}
        className="h-7 rounded-md border border-input bg-background px-1.5 text-[11px]"
        disabled={busy}
      >
        {DOMAIN_OPTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
        placeholder="Add case #"
        className="h-7 w-28 text-xs"
        disabled={busy}
        inputMode="numeric"
      />
      <Button type="submit" size="sm" variant="secondary" className="h-7 gap-1 px-2 text-[11px]" disabled={busy || !value.trim()}>
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
        {busy ? "Pulling..." : "Add"}
      </Button>
    </form>
  );
}

function ProfilePage({ identity, access, onBack }: {
  identity: ProfileIdentity;
  access: ResolutionAccess;
  onBack: () => void;
}) {
  const [profile, setProfile] = React.useState<FullProfile | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<{ ok: boolean; profile: FullProfile }>(`/api/resolution/cases/${encodeURIComponent(identity.caseNumber)}`, {
        query: { domain: normalizeDomain(identity.domain) },
      })
      .then((result) => {
        if (!cancelled && result?.ok) setProfile(result.profile);
      })
      .catch((err: unknown) => {
        toast.error("Profile load failed", { description: err instanceof Error ? err.message : undefined });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [identity.caseNumber, identity.domain, reloadKey]);

  const refresh = React.useCallback(() => setReloadKey((k) => k + 1), []);

  if (loading && !profile) {
    return (
      <div className="flex h-[60vh] items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading profile...
      </div>
    );
  }
  if (!profile) {
    return (
      <div className="space-y-3">
        <Button type="button" size="sm" variant="ghost" className="gap-1" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" /> Back to bank
        </Button>
        <div className="text-sm text-muted-foreground">Profile not found.</div>
      </div>
    );
  }

  const workDays = daysAgo(profile.touches?.work?.lastDate);
  const salesDays = daysAgo(profile.touches?.sales?.lastDate);
  const shorthand = profile.shorthand || {};
  // Live Logics posture chips from the appendage refresh (when polled).
  const logicsStatus = (shorthand.logics_status?.value || null) as
    { statusName?: string; taxLiability?: number } | null;
  const logicsBilling = getLogicsBilling(profile);
  const paymentDelinquent = isPaymentDelinquent(profile);
  const noticeAlerts = getNoticeAlerts(profile);
  const noticeSummary = summarizeNoticeAlerts(noticeAlerts);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="ghost" className="gap-1" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" /> Bank
        </Button>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">
          {normalizeDomain(profile.domain)}
        </span>
        <h2 className="text-base font-semibold">Case {profile.caseNumber}</h2>
        <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-bold", tierTone(profile.pursuit?.tier))}>
          {profile.pursuit?.tier || "?"} · {profile.pursuit?.score ?? "—"}
        </span>
        <span className={cn("rounded-full border px-1.5 py-0.5 text-[10px] font-semibold", tempTone(profile.temperature?.label))}>
          {profile.temperature?.label || "unknown"}
        </span>
        {logicsStatus?.statusName ? (
          <span className="rounded-full border border-indigo-300 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-800">
            {logicsStatus.statusName}
          </span>
        ) : null}
        {logicsStatus?.taxLiability ? (
          <span className="rounded-full border border-rose-300 bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-800">
            liability {fmtMoney(logicsStatus.taxLiability)}
          </span>
        ) : null}
        {noticeAlerts.length ? (
          <span className="rounded-full border border-red-300 bg-red-50 px-1.5 py-0.5 text-[10px] font-bold text-red-700">
            notices received: {noticeSummary || noticeAlerts.length}
          </span>
        ) : null}
        {paymentDelinquent ? (
          <span className="rounded-full border border-red-400 bg-red-50 px-1.5 py-0.5 text-[10px] font-bold text-red-700">
            PAST DUE {fmtMoney(logicsBilling?.pastDue)}
          </span>
        ) : null}
        <span className="text-[11px] text-muted-foreground">
          Credit <strong>{profile.credit?.score ?? "—"}</strong> · Paid <strong>{fmtMoney(profile.payments?.totalPaid)}</strong>
          {" "}· Touch {workDays != null ? `${workDays}d` : "—"}/{salesDays != null ? `${salesDays}d` : "—"}
        </span>
      </div>
      {profile.pursuit?.reasons ? (
        <div className="text-[11px] text-violet-800/80">{profile.pursuit.reasons}</div>
      ) : null}
      {noticeAlerts.length ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
          <div className="mb-1 font-semibold">Notices received</div>
          <div className="flex flex-wrap gap-1.5">
            {noticeAlerts.slice(-5).map((notice, index) => (
              <span key={`${notice.uploadedAt || index}-${notice.noticeMatches || notice.documentName}`} className="rounded-full border border-red-200 bg-white px-2 py-0.5">
                {notice.noticeMatches || notice.documentName}
                {notice.uploadedAt ? ` · ${new Date(notice.uploadedAt).toLocaleDateString()}` : ""}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        {/* Dossier column */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Dossier</h3>
            <UploadSlot
              caseNumber={profile.caseNumber}
              domain={profile.domain}
              canWrite={access.write}
              onUploaded={refresh}
              compact={false}
            />
          </div>
          <div className="max-h-[65vh] space-y-1.5 overflow-y-auto rounded-md border border-violet-100 bg-violet-50/40 p-2.5">
            {Object.keys(shorthand).length ? (
              Object.entries(shorthand).map(([key, entry]) => (
                <div key={key} className="rounded-md bg-white/70 p-1.5 text-[11px] leading-snug">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono font-semibold text-violet-900">{key}</span>
                    {entry.asOf ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">{new Date(entry.asOf).toLocaleDateString()}</span>
                    ) : null}
                  </div>
                  <div className="text-slate-700">{entry.snippet || JSON.stringify(entry.value).slice(0, 160)}</div>
                  <details className="mt-0.5">
                    <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-violet-700">raw value</summary>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-1.5 text-[10px] leading-snug text-slate-600">
                      {JSON.stringify(entry.value, null, 1)}
                    </pre>
                  </details>
                </div>
              ))
            ) : (
              <div className="p-3 text-[11px] text-muted-foreground">
                No shorthand yet — upload a THS, W&I, RT, or Lexis document to start the dossier.
              </div>
            )}
            {profile.touches?.sales?.lastPitched ? (
              <div className="border-t border-violet-100 pt-1.5 text-[11px] text-muted-foreground">
                Last pitched: {profile.touches.sales.lastPitched}
              </div>
            ) : null}
            {profile.documentHashes?.length ? (
              <div className="border-t border-violet-100 pt-1.5 text-[10px] text-muted-foreground">
                Documents seen: {profile.documentHashes.map((d) => d.label || d.docType).join(" · ")}
              </div>
            ) : null}
          </div>
        </div>

        {/* Pitch designer column */}
        <div className="flex min-h-[480px] flex-col lg:max-h-[75vh]">
          <PitchDesigner
            caseNumber={profile.caseNumber}
            profile={profile}
            canUseAgent={access.agent}
            onProfileChange={refresh}
          />
        </div>
      </div>
    </div>
  );
}

function ClientCard({ row, canWrite, onOpen }: { row: BankRow; canWrite: boolean; onOpen: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [full, setFull] = React.useState<FullProfile | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function loadFull() {
    setLoading(true);
    try {
      const result = await api.get<{ ok: boolean; profile: FullProfile }>(
        `/api/resolution/cases/${encodeURIComponent(row.caseNumber)}`,
        { query: { domain: normalizeDomain(row.domain) } },
      );
      if (result?.ok) setFull(result.profile);
    } catch {
      // Card stays collapsed-data only; the table row is still useful.
    } finally {
      setLoading(false);
    }
  }

  const workDays = daysAgo(row.touches?.work?.lastDate);
  const salesDays = daysAgo(row.touches?.sales?.lastDate);
  const effectiveProfile = full || row;
  const shorthand = effectiveProfile.shorthand || null;
  const pitchClass = full?.pitch?.verdict?.class;
  const paymentDelinquent = isPaymentDelinquent(effectiveProfile);
  const logicsBilling = getLogicsBilling(effectiveProfile);
  const noticeAlerts = getNoticeAlerts(effectiveProfile);
  const noticeSummary = summarizeNoticeAlerts(noticeAlerts);

  return (
    <Card
      className={cn(
        "overflow-hidden",
        paymentDelinquent && "border-red-300 bg-red-50/60 ring-1 ring-red-200",
      )}
    >
      <CardContent className="space-y-1.5 p-3">
        <div className="flex items-start justify-between gap-2">
          <button type="button" className="min-w-0 text-left hover:underline" onClick={onOpen} title="Open profile">
            <div className="truncate text-sm font-semibold">{normalizeDomain(row.domain)} case {row.caseNumber}</div>
            <div className="text-[11px] text-muted-foreground">Resolution dossier</div>
          </button>
          <div className="flex shrink-0 items-center gap-1">
            <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-bold", tierTone(row.pursuit?.tier))}>
              {row.pursuit?.tier || "?"} · {row.pursuit?.score ?? "—"}
            </span>
            <span className={cn("rounded-full border px-1.5 py-0.5 text-[10px] font-semibold", tempTone(row.temperature?.label))}>
              {row.temperature?.label || "unknown"}
            </span>
            {paymentDelinquent ? (
              <span className="rounded-full border border-red-400 bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-800">
                past due {fmtMoney(logicsBilling?.pastDue)}
              </span>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1 text-[11px]">
          <div><span className="text-muted-foreground">Credit</span> <strong>{row.credit?.score ?? "—"}</strong></div>
          <div><span className="text-muted-foreground">Paid</span> <strong>{fmtMoney(row.payments?.totalPaid)}</strong></div>
          <div>
            <span className="text-muted-foreground">Touch</span>{" "}
            <strong>{workDays != null ? `${workDays}d` : "—"}/{salesDays != null ? `${salesDays}d` : "—"}</strong>
          </div>
        </div>

        {row.touches?.sales?.lastPitched ? (
          <div className="truncate text-[11px] text-muted-foreground" title={row.touches.sales.lastPitched}>
            Last pitched: {row.touches.sales.lastPitched}
          </div>
        ) : null}
        {row.pursuit?.reasons ? (
          <div className="line-clamp-2 text-[11px] text-violet-800/80" title={row.pursuit.reasons}>
            {row.pursuit.reasons}
          </div>
        ) : null}
        {noticeAlerts.length ? (
          <div className="rounded-md border border-red-200 bg-white/70 px-2 py-1 text-[11px] font-medium text-red-800">
            Notices received: {noticeSummary || `${noticeAlerts.length} notice${noticeAlerts.length === 1 ? "" : "s"}`}
          </div>
        ) : null}

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="flex items-center gap-1 text-[11px] font-medium text-violet-700 hover:underline"
            onClick={() => {
              setOpen((v) => !v);
              if (!open && !full) void loadFull();
            }}
          >
            {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {open ? "Hide dossier" : "Dossier"}
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          </button>
          {pitchClass ? (
            <span className={cn("rounded-full border px-1.5 py-0.5 text-[9px] font-bold", verdictTone(pitchClass))}>
              {pitchClass.replace("_", " ")}
            </span>
          ) : null}
        </div>

        {open ? (
          <div className="space-y-1 rounded-md border border-violet-100 bg-violet-50/40 p-2">
            {shorthand && Object.keys(shorthand).length ? (
              Object.entries(shorthand).map(([key, entry]) => (
                <div key={key} className="text-[11px] leading-snug">
                  <span className="font-mono font-semibold text-violet-900">{key}</span>
                  <span className="text-slate-700"> — {entry.snippet || JSON.stringify(entry.value).slice(0, 120)}</span>
                  {entry.asOf ? (
                    <span className="text-muted-foreground"> ({new Date(entry.asOf).toLocaleDateString()})</span>
                  ) : null}
                </div>
              ))
            ) : (
              <div className="text-[11px] text-muted-foreground">
                No shorthand yet — upload a THS, W&I, or Lexis document to start the dossier.
              </div>
            )}
            {full?.documentHashes?.length ? (
              <div className="border-t border-violet-100 pt-1 text-[10px] text-muted-foreground">
                Documents seen: {full.documentHashes.map((d) => d.label || d.docType).join(" · ")}
              </div>
            ) : null}
          </div>
        ) : null}

        <UploadSlot caseNumber={row.caseNumber} domain={row.domain} canWrite={canWrite} onUploaded={() => void loadFull()} />
      </CardContent>
    </Card>
  );
}

export function ResolutionWorkspace() {
  const { user, logout } = useSession();
  const [access, setAccess] = React.useState<ResolutionAccess | null>(null);
  const [denied, setDenied] = React.useState(false);
  const [error, setError] = React.useState("");
  const [summary, setSummary] = React.useState<BankSummary | null>(null);
  const [rows, setRows] = React.useState<BankRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [tier, setTier] = React.useState("ALL");
  const [temp, setTemp] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [selectedCase, setSelectedCase] = React.useState<ProfileIdentity | null>(null);

  React.useEffect(() => {
    // Don't latch "denied" before the session hydrates — a fresh login (or
    // a cached user predating the resolution grant) should still let the
    // server answer as the authority.
    if (!user) return;
    let cancelled = false;
    api
      .get<{ ok: boolean; access: ResolutionAccess }>("/api/resolution/access")
      .then((result) => {
        if (cancelled) return;
        if (result?.ok && result.access) {
          setAccess(result.access);
          setDenied(false); // the server is the authority — clear any stale latch
        } else setDenied(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if ((err as { status?: number })?.status === 403) setDenied(true);
        else setError(err instanceof Error ? err.message : "Access check failed");
      });
    return () => { cancelled = true; };
  }, [user]);

  // Search is SERVER-side (the page only holds 150 of 2,000+ rows) and
  // debounced so we don't query per keystroke.
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  React.useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(handle);
  }, [search]);

  const loadBank = React.useCallback(async () => {
    setLoading(true);
    try {
      const [bank, sum] = await Promise.all([
        api.get<{ ok: boolean; rows: BankRow[]; total: number }>("/api/resolution/bank", {
          query: {
            limit: 150,
            ...(tier !== "ALL" ? { tier } : {}),
            ...(temp ? { temperature: temp } : {}),
            ...(debouncedSearch ? { q: debouncedSearch } : {}),
          },
        }),
        summary ? Promise.resolve(null) : api.get<{ ok: boolean; summary: BankSummary }>("/api/resolution/bank/summary"),
      ]);
      if (bank?.ok) {
        setRows(bank.rows || []);
        setTotal(bank.total || 0);
      }
      if (sum?.ok) setSummary(sum.summary);
    } catch (err) {
      toast.error("Bank load failed", { description: err instanceof Error ? err.message : undefined });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier, temp, debouncedSearch]);

  React.useEffect(() => {
    if (access) void loadBank();
  }, [access, loadBank]);

  if (denied) {
    return (
      <div className="mx-auto flex h-[70vh] max-w-md flex-col items-center justify-center gap-3 text-center">
        <ShieldAlert className="h-10 w-10 text-amber-500" />
        <h1 className="text-lg font-semibold">Upsellerator access required</h1>
        <p className="text-sm text-muted-foreground">
          Ask an admin to grant <code className="rounded bg-muted px-1">resolution.read</code> on your account.
        </p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="mx-auto flex h-[70vh] max-w-md flex-col items-center justify-center gap-3 text-center">
        <ShieldAlert className="h-10 w-10 text-red-500" />
        <h1 className="text-lg font-semibold">Access check failed</h1>
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    );
  }
  if (!access) {
    return (
      <div className="flex h-[70vh] items-center justify-center text-sm text-muted-foreground">
        Checking Upsellerator access...
      </div>
    );
  }

  if (selectedCase) {
    return (
      <div className="mx-auto max-w-7xl p-4">
        <ProfilePage
          identity={selectedCase}
          access={access}
          onBack={() => {
            setSelectedCase(null);
            // Uploads/refreshes on the profile page change tier badges and
            // counts — reload the grid so the bank reflects them.
            void loadBank();
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-600 text-white">
          <Gem className="h-4 w-4" />
        </div>
        <div>
          <h1 className="text-lg font-semibold leading-tight">Upsellerator</h1>
          <p className="text-xs text-muted-foreground">
            Resolution intelligence · {summary ? `${summary.total} active clients` : "case bank"} · best prospects first
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {summary ? (
            <>
              {Object.entries(summary.tiers)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([t, n]) => (
                  <span key={t} className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold", tierTone(t))}>
                    {t}: {n}
                  </span>
                ))}
              <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold", tempTone("hot"))}>
                hot: {summary.temperatures.hot || 0}
              </span>
              <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold", tempTone("warm"))}>
                warm: {summary.temperatures.warm || 0}
              </span>
            </>
          ) : null}
          {user?.role === "admin" ? (
            <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-[11px]">
              <a href="/admin">Admin</a>
            </Button>
          ) : null}
          {/* This page renders OUTSIDE the admin/CX shells — the resolution
              crew logs straight into it, so sign-out lives here. */}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
            onClick={() => void logout()}
            title={user?.email || "Sign out"}
          >
            <LogOut className="h-3 w-3" /> Sign out
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {TIER_FILTERS.map((t) => (
            <Button
              key={t}
              type="button"
              size="sm"
              variant={tier === t ? "primary" : "ghost"}
              className="h-7 px-2.5 text-xs"
              onClick={() => setTier(t)}
            >
              {t}
            </Button>
          ))}
        </div>
        <select
          value={temp}
          onChange={(e) => setTemp(e.target.value)}
          className="h-7 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="">All temps</option>
          <option value="hot">Hot</option>
          <option value="warm">Warm</option>
          <option value="cold">Cold</option>
          <option value="unknown">Unknown</option>
        </select>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or case # (whole bank)"
          className="h-7 w-56 text-xs"
        />
        {access.write ? <AddCaseSlot onAdded={(identity) => setSelectedCase(identity)} /> : null}
        <span className="text-xs text-muted-foreground">
          {loading ? "Loading..." : `${rows.length} of ${total}`}
        </span>
        <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
          <Sparkles className="h-3 w-3 text-violet-500" />
          uploads parse-and-delete — documents are never stored
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {rows.map((row) => (
          <ClientCard
            key={row.profileKey || `${normalizeDomain(row.domain)}:${row.caseNumber}`}
            row={row}
            canWrite={access.write}
            onOpen={() => setSelectedCase(profileIdentity(row))}
          />
        ))}
      </div>
      {!loading && !rows.length ? (
        <div className="flex h-40 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
          No clients match the current filters.
        </div>
      ) : null}
    </div>
  );
}
