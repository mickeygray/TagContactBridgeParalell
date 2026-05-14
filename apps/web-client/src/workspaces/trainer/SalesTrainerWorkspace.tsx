import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Award,
  CheckCircle2,
  Flame,
  Loader2,
  LogOut,
  MessageSquare,
  Mic,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Trophy,
  Volume2,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
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
import {
  audioDataUrl,
  clearTrainerToken,
  salesTrainerApi,
  type TrainerAudio,
  type TrainerCoachPanel,
  type TrainerConfig,
  type TrainerMessage,
  type TrainerSessionBundle,
  type TrainerVoiceProfile,
} from "@/lib/api/salesTrainer";
import { useAuthStore } from "@/lib/auth/authStore";
import { cn } from "@/lib/utils/cn";
import {
  healthFromPayload,
  processTrainerTaggedResponse,
  type ParsedTrainerResponse,
  type UiHealthPayload,
  type UiPhasePayload,
  type UiScorecardPayload,
} from "./uiPayloads";

const PHASES = [
  { key: "opening", label: "Open" },
  { key: "discovery", label: "Discover" },
  { key: "pain", label: "Pain" },
  { key: "qualification", label: "Qualify" },
  { key: "solution", label: "Frame" },
  { key: "objection", label: "Objection" },
  { key: "close", label: "Close" },
  { key: "wrap", label: "Wrap" },
];
const PHASE_COUNTDOWN_SECONDS = 30;
const LIVE_COACH_ENABLED = false;
const TRAINER_TTS_GENERATION_SPEED = 1.35;
const TRAINER_AUDIO_PLAYBACK_RATE = 1;
const MIN_RECORDING_BYTES = 900;
const MIN_RECORDING_MS = 350;
// VAD voice-detection threshold on the normalized (rms * 6) level.
//
// History of this constant:
//   0.035 — original; worked for studio-quality input but starved
//           on laptop mics where the silence countdown never started.
//   0.012 — too low; Chrome's autoGainControl keeps a 0.03–0.05
//           baseline floor during real silence on laptop hardware,
//           which sits ABOVE 0.012, so the countdown still never
//           triggered (level never "dropped below" threshold).
//   0.05  — sits ABOVE the typical AGC-amplified noise floor.
//           Combined with the hysteresis below, this makes recording
//           transitions reliable on consumer hardware without
//           false-triggering on HVAC / fan / breathing.
//
// Real speech on a laptop mic with AGC peaks at 0.15–0.45+; the gap
// between noise floor (~0.04) and speech (~0.15+) is wide enough that
// 0.05 cleanly discriminates.
const VOICE_LEVEL_THRESHOLD = 0.05;
// Slightly below the entry threshold so a quick dip below 0.05 during
// active speech doesn't end the turn — has to genuinely fall + stay
// down for SILENCE_GRACE_MS to start the countdown. Cancelling a
// running countdown requires crossing this for 180ms, which is enough
// to reject a single ambient pop but not so long that a continued
// utterance fails to cancel.
const COUNTDOWN_CANCEL_VOICE_THRESHOLD = 0.06;
const COUNTDOWN_CANCEL_VOICE_MS = 180;
// 300ms was too aggressive — reps pausing mid-sentence to gather a
// thought triggered the auto-send countdown before they were done.
// 700ms gives reasonable thinking space before VAD starts checking
// for end-of-utterance.
const SILENCE_GRACE_MS = 700;
// 1.5s of silence → auto-send was firing while reps were still mid-
// thought. 3.0s lets you finish your sentence and breathe before VAD
// kicks in. The explicit Send/Transmit button is the snappy path for
// users who don't want to wait for VAD.
const SILENCE_SEND_COUNTDOWN_SECONDS = 3.0;
const RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/wav",
];
type TrainerCallMode = "inbound" | "outbound";
const DIFFICULTY_OPTIONS = [
  { value: "random", label: "Random" },
  { value: "easy", label: "Easy" },
  { value: "hard", label: "Hard" },
];
const SCENARIO_ARCHETYPES = [
  { value: "random", label: "Random" },
  { value: "trucker", label: "Trucker" },
  { value: "retired", label: "Retired" },
  { value: "small_business", label: "Small business" },
  { value: "payroll", label: "Payroll" },
  { value: "farmer", label: "Farmer" },
  { value: "divorced", label: "Divorced" },
];

function isTrainerAudio(value: unknown): value is TrainerAudio {
  return Boolean(
    value &&
      typeof value === "object" &&
      "audioBase64" in value &&
      "mimeType" in value,
  );
}

function trainerAudioFailure(value: unknown) {
  if (!value || typeof value !== "object") return "";
  if ("ok" in value && (value as { ok?: unknown }).ok === false) {
    return String((value as { error?: unknown }).error || "Prospect audio failed");
  }
  return "";
}

function profileString(profile: Record<string, unknown> | null, key: string) {
  const value = profile?.[key];
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "number") return value.toLocaleString();
  if (Array.isArray(value)) return value.map(String).join(", ");
  return String(value);
}

function toNullableChoice(value: string) {
  return value === "auto" || value === "random" ? null : value;
}

function setupCommandFor(
  mode: TrainerCallMode,
  difficulty: string,
  scenarioArchetype: string,
) {
  const difficultyToken = difficulty === "random" ? "random" : difficulty;
  if (scenarioArchetype !== "random") {
    return `drill: ${mode} ${scenarioArchetype} ${difficultyToken}`;
  }
  return `${mode} ${difficultyToken}`;
}

function isTaxGroupGreeting(value: string) {
  return /\btax\s*group\b/i.test(value);
}

function isSetupBriefingMessage(message: TrainerMessage) {
  return message.role === "assistant" && /^(Inbound|Outbound) .+ loaded\./.test(message.content);
}

function modelMessages(messages: TrainerMessage[]) {
  return messages.filter((message) => !isSetupBriefingMessage(message));
}

function pickRecordingMimeType() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) {
    return "";
  }
  return RECORDING_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function extensionForMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("mp4") || normalized.includes("m4a")) return "m4a";
  if (normalized.includes("wav")) return "wav";
  return "webm";
}

function formatRecordingTime(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function primeAudioOutput() {
  if (typeof window === "undefined") return;
  const AudioContextCtor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return;
  try {
    const context = new AudioContextCtor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    gain.gain.value = 0;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.01);
    void context.resume().finally(() => {
      window.setTimeout(() => {
        void context.close().catch(() => {
          /* ignored */
        });
      }, 80);
    });
  } catch {
    /* Audio will still render through the visible player. */
  }
}

function SignInPanel({
  onSignedIn,
}: {
  onSignedIn: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [previewCode, setPreviewCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"send" | "verify" | null>(null);

  async function sendCode() {
    setError("");
    setBusy("send");
    try {
      const result = await salesTrainerApi.sendCode(email);
      setSent(true);
      setPreviewCode(result.previewCode || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send code");
    } finally {
      setBusy(null);
    }
  }

  async function verifyCode() {
    setError("");
    setBusy("verify");
    try {
      await salesTrainerApi.verifyCode(email, code);
      await onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not verify code");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="rounded-lg border border-border bg-card p-6 shadow-soft">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-base font-semibold">Sales Trainer</h1>
            <p className="text-xs text-muted-foreground">OTP access</p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="trainer-email">Email</Label>
            <Input
              id="trainer-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@taxadvocategroup.com"
              disabled={Boolean(busy)}
            />
          </div>

          {sent ? (
            <div className="space-y-1.5">
              <Label htmlFor="trainer-code">Code</Label>
              <Input
                id="trainer-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="000000"
                disabled={Boolean(busy)}
              />
            </div>
          ) : null}

          {previewCode ? (
            <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
              Preview code: <span className="font-semibold">{previewCode}</span>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => void sendCode()}
              disabled={!email.trim() || Boolean(busy)}
              isLoading={busy === "send"}
            >
              <RefreshCw className="h-4 w-4" />
              Send code
            </Button>
            <Button
              onClick={() => void verifyCode()}
              disabled={!sent || !code.trim() || Boolean(busy)}
              isLoading={busy === "verify"}
            >
              <CheckCircle2 className="h-4 w-4" />
              Verify
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PhaseRail({ activeKey }: { activeKey?: string }) {
  const activeIndex = Math.max(
    0,
    PHASES.findIndex((phase) => phase.key === activeKey),
  );
  return (
    <div className="grid grid-cols-4 gap-1 lg:grid-cols-8">
      {PHASES.map((phase, index) => (
        <div
          key={phase.key}
          className={cn(
            "rounded-md border px-2 py-2 text-center text-[11px] font-medium",
            index < activeIndex
              ? "border-success/30 bg-success/10 text-success"
              : index === activeIndex
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-border bg-card text-muted-foreground",
          )}
        >
          {phase.label}
        </div>
      ))}
    </div>
  );
}

interface HealthState {
  current: number;
  mistakes: number;
  max: number;
  lastMistake: UiHealthPayload | null;
}

function readableSeverity(value?: string) {
  if (!value) return "Mistake";
  return value.replace(/_/g, " ").replace(/^\w/, (char) => char.toUpperCase());
}

function HealthBar({ health }: { health: HealthState }) {
  const ratio = health.max > 0 ? health.current / health.max : 1;
  const tone =
    health.current <= 0
      ? "bg-red-950"
      : health.current <= 3
        ? "bg-red-600"
        : health.current <= 6
          ? "bg-warning"
          : "bg-success";
  const last = health.lastMistake;
  const tooltip = last
    ? `${last.principle_crossed || readableSeverity(last.last_mistake_severity)}${
        last.agent_words ? `: "${last.agent_words}"` : ""
      }`
    : "No mistakes logged";

  return (
    <div className="border-b border-border p-4" title={tooltip}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Flame className="h-4 w-4 text-primary" />
          Call health
        </div>
        <StatusPill
          tone={
            health.current <= 0
              ? "danger"
              : health.current <= 3
                ? "danger"
                : health.current <= 6
                  ? "warning"
                  : "success"
          }
        >
          {health.current}/{health.max}
        </StatusPill>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all duration-300", tone)}
          style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }}
        />
      </div>
      {last ? (
        <div className="mt-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed">
          <div className="font-medium">
            {last.principle_crossed || readableSeverity(last.last_mistake_severity)}
          </div>
          {last.agent_words ? (
            <div className="mt-1 text-muted-foreground">"{last.agent_words}"</div>
          ) : null}
          {last.last_mistake_severity === "catastrophic" ? (
            <div className="mt-2 font-semibold text-destructive">Terminal mistake logged.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MomentBlock({
  label,
  tone,
  words,
  detail,
}: {
  label: string;
  tone: "good" | "teach";
  words?: string;
  detail?: string;
}) {
  if (!words && !detail) return null;
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-xs leading-relaxed",
        tone === "good"
          ? "border-success/30 bg-success/10"
          : "border-border bg-muted/40",
      )}
    >
      <div className="mb-1 font-semibold">{label}</div>
      {words ? <div className="text-foreground">"{words}"</div> : null}
      {detail ? <div className="mt-1 text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

function PhaseNotesCard({
  notes,
  countdown,
  onCommand,
}: {
  notes: UiPhasePayload;
  countdown: number | null;
  onCommand: (command: string) => void;
}) {
  const countdownValue = countdown ?? PHASE_COUNTDOWN_SECONDS;
  const progress = Math.max(0, Math.min(1, countdownValue / PHASE_COUNTDOWN_SECONDS));
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase text-muted-foreground">
            Phase {notes.phase} notes
          </div>
          <div className="mt-1 flex items-center gap-2">
            <div className="text-lg font-semibold">{notes.result || "Complete"}</div>
            {notes.score != null ? <StatusPill tone="accent">Score {notes.score}</StatusPill> : null}
          </div>
        </div>
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-sm font-semibold">
          {countdownValue}
        </div>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="rounded-md border border-border px-3 py-2">
          <div className="text-muted-foreground">Trust</div>
          <div className="font-semibold">
            {notes.trust_start ?? "-"} to {notes.trust_end ?? "-"}
          </div>
        </div>
        <div className="rounded-md border border-border px-3 py-2">
          <div className="text-muted-foreground">Objections</div>
          <div className="font-semibold">{notes.objections?.faced ?? "-"}</div>
        </div>
        <div className="rounded-md border border-border px-3 py-2">
          <div className="text-muted-foreground">Carry</div>
          <div className="truncate font-semibold">{notes.carry_forward || "-"}</div>
        </div>
      </div>

      <MomentBlock
        label="Strongest"
        tone="good"
        words={notes.strongest_moment?.agent_words}
        detail={notes.strongest_moment?.why_it_landed}
      />
      <MomentBlock
        label="Try stronger"
        tone="teach"
        words={notes.weakest_moment?.agent_words}
        detail={
          notes.weakest_moment?.stronger_alternative ||
          notes.weakest_moment?.principle
        }
      />

      {notes.ethical_flags?.length ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
          <div className="mb-2 flex items-center gap-2 font-semibold text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            Ethical flags
          </div>
          <div className="space-y-2">
            {notes.ethical_flags.map((flag, index) => (
              <div key={`${flag.principle_crossed}-${index}`}>
                <div className="font-medium">{flag.principle_crossed || "Flag"}</div>
                {flag.agent_words ? (
                  <div className="text-muted-foreground">"{flag.agent_words}"</div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" onClick={() => onCommand("redo")}>
          <RefreshCw className="h-4 w-4" />
          Redo
        </Button>
        <Button onClick={() => onCommand("continue")}>
          <Play className="h-4 w-4" />
          Continue
        </Button>
      </div>
    </div>
  );
}

function formatOutcome(value?: string) {
  if (!value) return "Outcome pending";
  return value.replace(/_/g, " ").replace(/^\w/, (char) => char.toUpperCase());
}

function actionLabel(action: string) {
  switch (action) {
    case "go_again":
      return "Go Again";
    case "switch":
      return "Switch";
    case "reflect":
      return "Reflect";
    default:
      return action.replace(/_/g, " ");
  }
}

function actionCommand(action: string) {
  switch (action) {
    case "go_again":
      return "go again";
    case "switch":
      return "switch";
    case "reflect":
      return "reflect";
    default:
      return action.replace(/_/g, " ");
  }
}

function ScorecardPanel({
  scorecard,
  onAction,
}: {
  scorecard: UiScorecardPayload;
  onAction: (command: string) => void;
}) {
  const actions = scorecard.available_actions?.length
    ? scorecard.available_actions
    : ["go_again", "switch", "reflect"];
  const trustPhases = Object.entries(scorecard.trust_trajectory || {}).filter(
    ([, value]) => value && typeof value === "object" && "start" in (value as Record<string, unknown>),
  );
  return (
    <div className="space-y-4 p-4">
      <div className="rounded-md border border-primary/30 bg-primary/5 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
              <Trophy className="h-3.5 w-3.5" />
              Scorecard
            </div>
            <div className="mt-2 text-4xl font-semibold">{scorecard.overall_score ?? "-"}</div>
          </div>
          <div className="space-y-2 text-right">
            <StatusPill tone={scorecard.clean_call ? "warning" : "info"}>
              {scorecard.clean_call ? "Clean Call" : formatOutcome(scorecard.outcome)}
            </StatusPill>
            <div className="text-xs text-muted-foreground">
              {scorecard.final_mistakes ?? 0} mistakes
            </div>
          </div>
        </div>
        {scorecard.caller_summary?.one_line ? (
          <div className="mt-3 text-sm leading-relaxed">{scorecard.caller_summary.one_line}</div>
        ) : null}
      </div>

      {trustPhases.length ? (
        <div className="rounded-md border border-border p-3">
          <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
            Trust movement
          </div>
          <div className="grid gap-2">
            {trustPhases.map(([key, value]) => {
              const point = value as { start?: number; end?: number };
              return (
                <div key={key} className="flex items-center justify-between text-xs">
                  <span>{key.replace(/_/g, " ")}</span>
                  <span className="font-semibold">
                    {point.start ?? "-"} to {point.end ?? "-"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {scorecard.phase_breakdowns?.map((phase) => (
        <div key={`phase-${phase.phase}`} className="space-y-2 rounded-md border border-border p-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Phase {phase.phase}</div>
            <StatusPill tone={phase.result === "pass" ? "success" : "warning"}>
              {phase.score ?? "-"}
            </StatusPill>
          </div>
          <MomentBlock
            label="Strongest"
            tone="good"
            words={phase.strongest_moment?.agent_words}
            detail={phase.strongest_moment?.why_it_landed}
          />
          <MomentBlock
            label="Stronger"
            tone="teach"
            words={phase.weakest_moment?.agent_words}
            detail={
              phase.weakest_moment?.stronger_alternative ||
              phase.weakest_moment?.principle
            }
          />
        </div>
      ))}

      {scorecard.ethical_flags?.length ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Ethical flags
          </div>
          <div className="space-y-2 text-xs">
            {scorecard.ethical_flags.map((flag, index) => (
              <div key={`${flag.principle_crossed}-${index}`}>
                <div className="font-medium">{flag.principle_crossed || "Flag"}</div>
                {flag.agent_words ? (
                  <div className="text-muted-foreground">"{flag.agent_words}"</div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {scorecard.patterns?.length ? (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase text-muted-foreground">Patterns</div>
          {scorecard.patterns.map((pattern, index) => (
            <div key={`${pattern.principle}-${index}`} className="rounded-md border border-border p-3 text-xs">
              <div className="font-semibold">{pattern.principle || "Pattern"}</div>
              {pattern.the_fix ? <div className="mt-1 text-muted-foreground">{pattern.the_fix}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      {scorecard.drill_for_next_call ? (
        <div className="rounded-md border border-success/30 bg-success/10 p-3 text-sm">
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
            <Award className="h-3.5 w-3.5" />
            Next drill
          </div>
          {scorecard.drill_for_next_call}
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-2">
        {actions.map((action) => (
          <Button
            key={action}
            variant={action === "reflect" ? "secondary" : "primary"}
            size="sm"
            onClick={() => onAction(actionCommand(action))}
          >
            {actionLabel(action)}
          </Button>
        ))}
      </div>
    </div>
  );
}

function CallStatusPanel({ phaseKey }: { phaseKey?: string }) {
  return (
    <div className="space-y-4 p-4">
      <PhaseRail activeKey={phaseKey} />
      <div className="rounded-md border border-border bg-muted/30 p-4">
        <div className="text-sm font-semibold">Roleplay active</div>
        <div className="mt-1 text-xs text-muted-foreground">Awaiting phase break</div>
      </div>
    </div>
  );
}

function SidePanel({
  health,
  phaseNotes,
  scorecard,
  countdown,
  coach,
  onCommand,
}: {
  health: HealthState;
  phaseNotes: UiPhasePayload | null;
  scorecard: UiScorecardPayload | null;
  countdown: number | null;
  coach: TrainerCoachPanel | null;
  onCommand: (command: string) => void;
}) {
  return (
    <aside className="flex min-h-[640px] flex-col rounded-lg border border-border bg-card">
      <HealthBar health={health} />
      {scorecard ? (
        <ScorecardPanel scorecard={scorecard} onAction={onCommand} />
      ) : phaseNotes ? (
        <PhaseNotesCard notes={phaseNotes} countdown={countdown} onCommand={onCommand} />
      ) : (
        <CallStatusPanel phaseKey={coach?.phase.key} />
      )}
    </aside>
  );
}

function Transcript({
  messages,
  lastAudio,
  audioNotice,
  onAudioNotice,
  onAudioPending,
  onAudioPlaying,
  onAudioComplete,
}: {
  messages: TrainerMessage[];
  lastAudio: TrainerAudio | null;
  audioNotice: string;
  onAudioNotice: (message: string) => void;
  onAudioPending: () => void;
  onAudioPlaying: () => void;
  onAudioComplete: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastAudioUrl = useMemo(() => audioDataUrl(lastAudio), [lastAudio]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  useEffect(() => {
    if (!lastAudioUrl) return;
    const player = audioRef.current;
    if (!player) return;
    onAudioPending();
    onAudioNotice("");
    player.currentTime = 0;
    player.playbackRate = TRAINER_AUDIO_PLAYBACK_RATE;
    player.load();
    void player.play().catch(() => {
      onAudioNotice("Click Play in the open prospect audio bar to hear the response.");
      onAudioComplete();
    });
  }, [lastAudioUrl, onAudioComplete, onAudioNotice, onAudioPending]);

  function replayAudio() {
    const player = audioRef.current;
    if (!player || !lastAudioUrl) return;
    onAudioNotice("");
    player.currentTime = 0;
    player.playbackRate = TRAINER_AUDIO_PLAYBACK_RATE;
    void player.play().catch(() => {
      onAudioNotice("Browser blocked playback. Click Play in the prospect audio bar.");
      onAudioComplete();
    });
  }

  return (
    <div className="flex min-h-[520px] flex-1 flex-col rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-primary" />
          <div>
            <div className="text-sm font-semibold">Roleplay</div>
            <div className="text-xs text-muted-foreground">{messages.length} turns</div>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={!lastAudio}
          onClick={replayAudio}
        >
          <Volume2 className="h-3.5 w-3.5" />
          Replay
        </Button>
      </div>
      {lastAudio || audioNotice ? (
        <div className="border-b border-border bg-primary/5 px-4 py-3">
          <div className="mb-1 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              {audioNotice || "Prospect audio ready"}
            </span>
            {lastAudio?.byteLength ? (
              <span>{Math.round(lastAudio.byteLength / 1024)} KB</span>
            ) : null}
          </div>
          {lastAudioUrl ? (
            <audio
              ref={audioRef}
              aria-label="Prospect audio playback"
              className="h-10 w-full"
              autoPlay
              controls
              onEnded={onAudioComplete}
              onError={onAudioComplete}
              onLoadedMetadata={(event) => {
                event.currentTarget.playbackRate = TRAINER_AUDIO_PLAYBACK_RATE;
              }}
              onPlay={(event) => {
                event.currentTarget.playbackRate = TRAINER_AUDIO_PLAYBACK_RATE;
                onAudioNotice("");
                onAudioPlaying();
              }}
              onPlaying={onAudioPlaying}
              playsInline
              preload="auto"
              src={lastAudioUrl}
            />
          ) : null}
        </div>
      ) : null}
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="flex h-full min-h-[420px] items-center justify-center text-sm text-muted-foreground">
            No active session
          </div>
        ) : (
          messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              className={cn(
                "flex",
                message.role === "user" ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[78%] rounded-lg px-3 py-2 text-sm leading-relaxed shadow-sm",
                  message.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "border border-border bg-muted text-foreground",
                )}
              >
                <div className="mb-1 text-[10px] font-semibold uppercase opacity-70">
                  {message.role === "user" ? "Agent" : "Prospect"}
                </div>
                {message.content}
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

export function SalesTrainerWorkspace() {
  const navigate = useNavigate();
  const appUser = useAuthStore((state) => state.user);
  const [authState, setAuthState] = useState<"checking" | "signed-out" | "signed-in">("checking");
  const [config, setConfig] = useState<TrainerConfig | null>(null);
  const [session, setSession] = useState<TrainerSessionBundle | null>(null);
  const [messages, setMessages] = useState<TrainerMessage[]>([]);
  const [coach, setCoach] = useState<TrainerCoachPanel | null>(null);
  const [health, setHealth] = useState<HealthState>({
    current: 10,
    mistakes: 0,
    max: 10,
    lastMistake: null,
  });
  const [phaseNotes, setPhaseNotes] = useState<UiPhasePayload | null>(null);
  const [scorecard, setScorecard] = useState<UiScorecardPayload | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [voiceProfile, setVoiceProfile] = useState<TrainerVoiceProfile | null>(null);
  const [lastAudio, setLastAudio] = useState<TrainerAudio | null>(null);
  const [audioNotice, setAudioNotice] = useState("");
  const [callMode, setCallMode] = useState<TrainerCallMode | null>(null);
  const [difficulty, setDifficulty] = useState("random");
  const [scenarioArchetype, setScenarioArchetype] = useState("random");
  const [openingDelivered, setOpeningDelivered] = useState(false);
  const [provider, setProvider] = useState("anthropic");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [micSupported, setMicSupported] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [micError, setMicError] = useState("");
  const [micLevel, setMicLevel] = useState(0);
  const [micHeard, setMicHeard] = useState(false);
  const [silenceCountdown, setSilenceCountdown] = useState<number | null>(null);
  const [voiceAutoSending, setVoiceAutoSending] = useState(false);
  const [handsFreeEnabled, setHandsFreeEnabled] = useState(false);
  const [prospectAudioPending, setProspectAudioPending] = useState(false);
  const [prospectAudioPlaying, setProspectAudioPlaying] = useState(false);
  const uiStateVersionRef = useRef(0);
  const draftRef = useRef("");
  const draftInputRef = useRef<HTMLTextAreaElement | null>(null);
  const healthQueueRef = useRef<UiHealthPayload[]>([]);
  const healthAnimatingRef = useRef(false);
  const autoContinueRef = useRef(false);
  const lockedVoiceProfileRef = useRef<TrainerVoiceProfile | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingStartedAtRef = useRef(0);
  const recordingMimeTypeRef = useRef("audio/webm");
  const lastVoiceHeardAtRef = useRef(0);
  const silenceCountdownStartedAtRef = useRef<number | null>(null);
  const countdownCancelVoiceStartedAtRef = useRef<number | null>(null);
  const autoStopRecordingRef = useRef(false);
  const recordingStartInFlightRef = useRef(false);
  const micPermissionRequestedRef = useRef(false);
  const micAudioContextRef = useRef<AudioContext | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micLevelFrameRef = useRef<number | null>(null);
  const unmountedRef = useRef(false);

  const profile = session?.profile ?? null;
  // Sonnet-generated story playbook from /session/start. Pinned for the
  // session and passed back on every /turn or /respond so Haiku has the
  // same script the session was built around (objection queue, hidden
  // facts, tell lines, trust arc, phase guidance). Null if generation
  // failed — Haiku still works without it, just improvises more.
  const playbook = session?.playbook ?? null;
  const scenario = useMemo(() => {
    if (!profile) return "Tax-resolution sales roleplay";
    const mode = profileString(profile, "practiceMode");
    const archetype = profileString(profile, "scenarioArchetype");
    const lead = profileString(profile, "leadSource");
    const debt = profileString(profile, "approxDebtUsd");
    const mood = profileString(profile, "mood");
    return `Mode ${mode}, archetype ${archetype}, caller ${lead}, approx debt ${debt}, mood ${mood}`;
  }, [profile]);

  async function loadTrainerState() {
    try {
      await salesTrainerApi.checkAuth();
      const nextConfig = await salesTrainerApi.config();
      setConfig(nextConfig);
      setProvider(nextConfig.providers.default || nextConfig.providers.available[0] || "anthropic");
      setAuthState("signed-in");
    } catch {
      setAuthState("signed-out");
    }
  }

  useEffect(() => {
    void loadTrainerState();
  }, []);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    setMicSupported(
      typeof navigator !== "undefined" &&
        Boolean(navigator.mediaDevices?.getUserMedia) &&
        typeof MediaRecorder !== "undefined",
    );
  }, []);

  useEffect(() => {
    if (authState !== "signed-in" || !micSupported || micPermissionRequestedRef.current) {
      return;
    }
    micPermissionRequestedRef.current = true;
    void requestInitialMicrophonePermission();
  }, [authState, micSupported]);

  useEffect(() => {
    if (!recording) return undefined;
    const id = window.setInterval(() => {
      setRecordingMs(Date.now() - recordingStartedAtRef.current);
    }, 200);
    return () => window.clearInterval(id);
  }, [recording]);

  useEffect(
    () => () => {
      unmountedRef.current = true;
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        try {
          recorder.stop();
        } catch {
          /* already stopped */
        }
      }
      stopMicTracks();
    },
    [],
  );

  function drainHealthQueue() {
    if (healthAnimatingRef.current) return;
    const next = healthQueueRef.current.shift();
    if (!next) return;
    healthAnimatingRef.current = true;
    setHealth(healthFromPayload(next));
    window.setTimeout(() => {
      healthAnimatingRef.current = false;
      drainHealthQueue();
    }, 300);
  }

  function enqueueHealth(payload: UiHealthPayload) {
    healthQueueRef.current.push(payload);
    drainHealthQueue();
  }

  function applyParsedResponse(parsed: ParsedTrainerResponse) {
    if (parsed.parseErrors.length > 0) {
      console.warn("Trainer UI payload parse errors", parsed.parseErrors);
    }
    let delay = 0;
    parsed.events.forEach((event) => {
      if (event.tagType === "UI_HEALTH") {
        window.setTimeout(() => {
          enqueueHealth(event.payload as UiHealthPayload);
        }, delay);
        delay += 320;
        return;
      }
      if (event.tagType === "UI_PAYLOAD") {
        window.setTimeout(() => {
          setPhaseNotes(event.payload as UiPhasePayload);
          setScorecard(null);
          autoContinueRef.current = false;
          setCountdown(PHASE_COUNTDOWN_SECONDS);
        }, delay);
        return;
      }
      if (event.tagType === "UI_SCORECARD") {
        window.setTimeout(() => {
          setScorecard(event.payload as UiScorecardPayload);
          setPhaseNotes(null);
          setCountdown(null);
        }, delay);
      }
    });
  }

  useEffect(() => {
    if (!LIVE_COACH_ENABLED || !session?.sessionId) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const state = await salesTrainerApi.uiState(
          session.sessionId,
          uiStateVersionRef.current,
        );
        if (cancelled || !state) return;
        uiStateVersionRef.current = state.version;
        if (state.coach) setCoach(state.coach);
        if (state.suggestedDraft && !draftRef.current.trim()) {
          setDraft(state.suggestedDraft);
        }
      } catch {
        /* bridge snapshots are opportunistic; local coach still works */
      }
    };
    void poll();
    const id = window.setInterval(() => {
      void poll();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [session?.sessionId]);

  useEffect(() => {
    if (!phaseNotes || inputFocused || countdown == null) return undefined;
    if (countdown <= 0) {
      if (!autoContinueRef.current) {
        autoContinueRef.current = true;
        void sendCommand("continue");
      }
      return undefined;
    }
    const id = window.setTimeout(() => {
      setCountdown((value) => (value == null ? value : Math.max(0, value - 1)));
    }, 1000);
    return () => window.clearTimeout(id);
  }, [countdown, inputFocused, phaseNotes]);

  async function refreshCoach(nextMessages = messages, previousPhase = coach?.phase.key) {
    if (!LIVE_COACH_ENABLED) {
      setCoach(null);
      return;
    }
    if (nextMessages.length === 0) return;
    try {
      const panel = await salesTrainerApi.coach({
        messages: modelMessages(nextMessages),
        profile,
        scenario,
        previousPhase,
        provider,
      });
      setCoach(panel);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not refresh coach");
    }
  }

  function setAudioFailure(message: string) {
    setAudioNotice(message || "Prospect audio was not returned. Text mode is still available.");
  }

  // Sentence-chunked playback queue.
  //
  // The server now parallel-renders TTS by sentence and returns the
  // response as `audio.chunks: [audio0, audio1, audio2]`. The client
  // plays them as a playlist — chunk N+1 starts when chunk N ends —
  // so the user hears the first sentence at ~600-900ms instead of
  // waiting for the whole 3-sentence blob (~2-3s).
  //
  // Implementation: we feed Transcript ONE TrainerAudio at a time
  // (its existing <audio> element handles a single source cleanly).
  // pendingChunksRef holds the remaining sentences; when the current
  // one ends, handleAudioComplete pops the next and re-sets lastAudio,
  // which retriggers Transcript's playback effect.
  const pendingChunksRef = useRef<TrainerAudio[]>([]);

  function setProspectAudio(audio?: TrainerAudio | null) {
    if (!audio) {
      pendingChunksRef.current = [];
      setLastAudio(null);
      setProspectAudioPlaying(false);
      setProspectAudioPending(false);
      return;
    }
    // Chunked path: queue chunks[1..N], play chunks[0] first.
    if (Array.isArray(audio.chunks) && audio.chunks.length > 0) {
      const [first, ...rest] = audio.chunks;
      pendingChunksRef.current = rest;
      // Strip the `chunks` field on the played piece so the <audio>
      // element only sees a single-source audio. The base fields
      // (audioBase64, mimeType) are mirrored from chunks[0] server-side.
      const { chunks: _omit, ...flat } = first;
      setLastAudio(flat);
      setProspectAudioPlaying(false);
      setProspectAudioPending(Boolean(flat.audioBase64));
      return;
    }
    pendingChunksRef.current = [];
    setLastAudio(audio);
    setProspectAudioPlaying(false);
    setProspectAudioPending(Boolean(audio.audioBase64));
  }

  function withTrainerSpeed(profile: TrainerVoiceProfile | null | undefined): TrainerVoiceProfile {
    return profile
      ? { ...profile, speed: TRAINER_TTS_GENERATION_SPEED }
      : { speed: TRAINER_TTS_GENERATION_SPEED };
  }

  function trainerAudioRequestOptions() {
    const lockedProfile = withTrainerSpeed(lockedVoiceProfileRef.current || voiceProfile);
    return {
      voiceProfile: lockedProfile,
      voice: lockedProfile.voice,
      persona: lockedProfile.persona,
      responseFormat: "mp3",
      speed: TRAINER_TTS_GENERATION_SPEED,
    };
  }

  function lockVoiceProfile(profile: TrainerVoiceProfile | null | undefined) {
    if (!profile || lockedVoiceProfileRef.current) return;
    lockedVoiceProfileRef.current = profile;
    setVoiceProfile(profile);
  }

  const handleAudioPending = useCallback(() => {
    setProspectAudioPending(true);
    setProspectAudioPlaying(false);
  }, []);

  const handleAudioPlaying = useCallback(() => {
    setProspectAudioPending(true);
    setProspectAudioPlaying(true);
  }, []);

  const handleAudioComplete = useCallback(() => {
    // If we have queued chunks, advance to the next one.
    // Transcript will see the new `lastAudio` and play it.
    if (pendingChunksRef.current.length > 0) {
      const next = pendingChunksRef.current.shift();
      if (next) {
        const { chunks: _omit, ...flat } = next;
        setLastAudio(flat);
        setProspectAudioPending(true);
        // Keep prospectAudioPlaying true through the transition so the
        // UI doesn't briefly flicker to "idle" between sentences.
        return;
      }
    }
    setProspectAudioPlaying(false);
    setProspectAudioPending(false);
  }, []);

  async function startSession(modeOverride?: TrainerCallMode) {
    const selectedMode = modeOverride || callMode;
    if (!selectedMode) {
      setError("Pick inbound or outbound first");
      return;
    }
    const setupCommand = setupCommandFor(selectedMode, difficulty, scenarioArchetype);
    setError("");
    setStarting(true);
    setHandsFreeEnabled(true);
    setProspectAudioPending(false);
    setProspectAudioPlaying(false);
    try {
      const bundle = await salesTrainerApi.startSession({
        difficulty: toNullableChoice(difficulty),
        mode: selectedMode,
        scenarioArchetype: toNullableChoice(scenarioArchetype),
        includeAudio: true,
        audio: {
          responseFormat: "mp3",
          speed: TRAINER_TTS_GENERATION_SPEED,
        },
      });
      const setupTurn: TrainerMessage = {
        role: "user",
        content: setupCommand,
      };
      const opening: TrainerMessage = {
        role: "assistant",
        content: bundle.openingLine,
      };
      const inboundBriefing: TrainerMessage = {
        role: "assistant",
        content: `${selectedMode === "inbound" ? "Inbound" : "Outbound"} ${difficulty} loaded. ${
          selectedMode === "inbound"
            ? 'Say "Tax Group" to begin.'
            : "Prospect is on the line."
        }`,
      };
      const initialMessages =
        selectedMode === "outbound" ? [setupTurn, opening] : [setupTurn, inboundBriefing];
      setSession(bundle);
      uiStateVersionRef.current = 0;
      healthQueueRef.current = [];
      healthAnimatingRef.current = false;
      autoContinueRef.current = false;
      setMessages(initialMessages);
      setCallMode(selectedMode);
      setOpeningDelivered(selectedMode === "outbound");
      setCoach(null);
      setHealth({ current: 10, mistakes: 0, max: 10, lastMistake: null });
      setPhaseNotes(null);
      setScorecard(null);
      setCountdown(null);
      const sessionVoiceProfile = bundle.openingAudio?.voiceProfile || bundle.voice || null;
      lockedVoiceProfileRef.current = sessionVoiceProfile;
      setVoiceProfile(sessionVoiceProfile);
      setAudioNotice(bundle.openingAudioError?.message ? `Prospect voice failed: ${bundle.openingAudioError.message}` : "");
      if (selectedMode === "outbound" && bundle.openingAudio) {
        setProspectAudio(bundle.openingAudio);
      } else {
        setProspectAudio(null);
        if (selectedMode === "outbound" && !bundle.openingAudio && !bundle.openingAudioError) {
          setAudioFailure("Prospect text is ready, but no opening voice audio was returned.");
        }
      }
      if (LIVE_COACH_ENABLED) {
        const panel = await salesTrainerApi.coach({
          messages: modelMessages(initialMessages),
          profile: bundle.profile,
          scenario: setupCommand,
          provider,
        });
        setCoach(panel);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start session");
      lockedVoiceProfileRef.current = null;
      setVoiceProfile(null);
      setHandsFreeEnabled(false);
      setProspectAudioPending(false);
      setProspectAudioPlaying(false);
    } finally {
      setStarting(false);
    }
  }

  // One-shot voice turn via POST /api/sales-trainer/turn.
  //
  // Replaces the legacy two-call pattern (POST /transcribe → POST
  // /respond) with a single multipart request that runs STT + Claude +
  // TTS server-side. This:
  //   - Saves one HTTP round-trip (~150-300ms over a residential uplink)
  //   - Keeps the server-side Anthropic prompt cache warm — the same
  //     process handles back-to-back turns
  //   - Returns a unified envelope so the UI processes one response
  //     instead of stitching two together
  //
  // The first inbound turn (Tax Group greeting trigger) still routes
  // through the legacy /transcribe + submitTrainerMessage path to
  // preserve the pre-synth'd opening audio fast-path. Every subsequent
  // turn comes through here.
  async function submitTrainerTurn(opts: {
    blob: Blob;
    mimeType: string;
  }): Promise<void> {
    if (!session || sending) return;
    const previousMessages = messages;
    setPhaseNotes(null);
    setCountdown(null);
    autoContinueRef.current = false;
    setError("");
    setSending(true);
    try {
      const result = await salesTrainerApi.turn({
        blob: opts.blob,
        filename: `trainer-mic-${Date.now()}.${extensionForMimeType(opts.mimeType)}`,
        sessionId: session.sessionId,
        // 1-indexed turn counter for the training/{sessionId}/turn-NNN-... files.
        // Pairs in `messages` are user+assistant; current length / 2 + 1.
        turnNumber: Math.floor(previousMessages.length / 2) + 1,
        messages: modelMessages(previousMessages),
        profile,
        playbook,
        scenario,
        provider,
        mode: String(profile?.practiceMode || callMode || "roleplay"),
        includeAudio: true,
        audio: trainerAudioRequestOptions(),
        sttPrompt:
          "Tax resolution sales training call. Transcribe only the agent's spoken turn.",
      });

      // Server gives us the transcript inside the result. Build the user
      // message from that — no separate /transcribe call.
      const userText = (result.transcript?.text || "").trim();
      if (!userText) {
        setMicError("No speech detected");
        return;
      }
      const userTurn: TrainerMessage = { role: "user", content: userText };
      const afterUser = [...previousMessages, userTurn];

      // Same post-processing as submitTrainerMessage: parse UI payload
      // tags out of the assistant text, apply them, append the chat
      // text to messages, route audio to the player.
      const parsed = processTrainerTaggedResponse(result.response?.text || "");
      applyParsedResponse(parsed);
      const nextMessages = parsed.chatText
        ? [...afterUser, { role: "assistant" as const, content: parsed.chatText }]
        : afterUser;
      setMessages(nextMessages);

      if (parsed.chatText && isTrainerAudio(result.audio)) {
        lockVoiceProfile(result.audio.voiceProfile);
        setProspectAudio(result.audio);
      } else if (parsed.chatText) {
        setProspectAudio(null);
        const failure = trainerAudioFailure(result.audio);
        if (failure || result.audioError) {
          setAudioFailure(
            failure ||
              result.audioError?.message ||
              "Prospect voice failed.",
          );
        }
      } else {
        setProspectAudio(null);
      }

      const hasPanelPayload = parsed.events.some(
        (event) => event.tagType === "UI_PAYLOAD" || event.tagType === "UI_SCORECARD",
      );
      if (!hasPanelPayload) {
        await refreshCoach(nextMessages);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send turn");
    } finally {
      setSending(false);
    }
  }

  async function submitTrainerMessage(content: string, restoreDraft = "") {
    const trimmed = content.trim();
    if (!trimmed || sending) return;
    const previousMessages = messages;
    setPhaseNotes(null);
    setCountdown(null);
    autoContinueRef.current = false;
    setError("");
    setSending(true);
    const userTurn: TrainerMessage = { role: "user", content: trimmed };
    const profileMode = String(profile?.practiceMode || callMode || "").toLowerCase();
    if (session && profileMode === "inbound" && !openingDelivered && isTaxGroupGreeting(trimmed)) {
      const opening: TrainerMessage = {
        role: "assistant",
        content: session.openingLine,
      };
      const nextMessages = [...previousMessages, userTurn, opening];
      setMessages(nextMessages);
      setOpeningDelivered(true);
      if (session.openingAudio) {
        setProspectAudio(session.openingAudio);
      } else {
        setProspectAudio(null);
        setAudioFailure(
          session.openingAudioError?.message
            ? `Prospect voice failed: ${session.openingAudioError.message}`
            : "Prospect text is ready, but no opening voice audio was returned.",
        );
      }
      try {
        await refreshCoach(nextMessages);
      } finally {
        setSending(false);
      }
      return;
    }
    const outbound = [...previousMessages, userTurn];
    setMessages(outbound);
    try {
      const result = await salesTrainerApi.respond({
        messages: modelMessages(outbound),
        profile,
        playbook,
        scenario,
        provider,
        includeAudio: true,
        audio: trainerAudioRequestOptions(),
      });
      const parsed = processTrainerTaggedResponse(result.text);
      applyParsedResponse(parsed);
      const nextMessages = parsed.chatText
        ? [...outbound, { role: "assistant" as const, content: parsed.chatText }]
        : outbound;
      setMessages(nextMessages);
      if (parsed.chatText && isTrainerAudio(result.audio)) {
        lockVoiceProfile(result.audio.voiceProfile);
        setProspectAudio(result.audio);
      } else if (parsed.chatText) {
        setProspectAudio(null);
        const failure = trainerAudioFailure(result.audio);
        if (failure || result.audio) {
          setAudioFailure(failure || "Prospect voice failed.");
        }
      } else {
        setProspectAudio(null);
      }
      const hasPanelPayload = parsed.events.some(
        (event) => event.tagType === "UI_PAYLOAD" || event.tagType === "UI_SCORECARD",
      );
      if (!hasPanelPayload) {
        await refreshCoach(nextMessages);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send turn");
      setMessages(previousMessages);
      if (restoreDraft) setDraft(restoreDraft);
    } finally {
      setSending(false);
    }
  }

  async function sendCommand(command: string) {
    if (!command.trim()) return;
    if (["reflect", "go again", "switch"].includes(command)) {
      setScorecard(null);
    }
    if (["go again", "switch"].includes(command)) {
      setHealth({ current: 10, mistakes: 0, max: 10, lastMistake: null });
      setCoach(null);
    }
    await submitTrainerMessage(command);
  }

  function stopMicTracks() {
    stopMicLevelMeter();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }

  function stopMicLevelMeter() {
    if (micLevelFrameRef.current != null) {
      window.cancelAnimationFrame(micLevelFrameRef.current);
      micLevelFrameRef.current = null;
    }
    try {
      micSourceRef.current?.disconnect();
    } catch {
      /* already disconnected */
    }
    micSourceRef.current = null;
    const context = micAudioContextRef.current;
    micAudioContextRef.current = null;
    if (context && context.state !== "closed") {
      void context.close().catch(() => {
        /* ignored */
      });
    }
    if (!unmountedRef.current) setMicLevel(0);
  }

  async function requestInitialMicrophonePermission() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      stream.getTracks().forEach((track) => track.stop());
      if (!unmountedRef.current) setMicError("");
    } catch (err) {
      const name =
        err && typeof err === "object" && "name" in err
          ? String((err as { name?: unknown }).name)
          : "";
      if (!unmountedRef.current) {
        setMicError(
          name === "NotAllowedError" || name === "SecurityError"
            ? "Microphone permission denied"
            : "Could not request microphone permission",
        );
      }
    }
  }

  function startMicLevelMeter(stream: MediaStream) {
    stopMicLevelMeter();
    if (typeof window === "undefined") return;
    const AudioContextCtor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    try {
      const context = new AudioContextCtor();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.72;
      const source = context.createMediaStreamSource(stream);
      source.connect(analyser);
      const buffer = new Uint8Array(analyser.fftSize);
      micAudioContextRef.current = context;
      micSourceRef.current = source;
      void context.resume().catch(() => {
        /* browsers may already have the context running */
      });

      const readLevel = () => {
        analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (const sample of buffer) {
          const centered = (sample - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / buffer.length);
        const normalized = Math.min(1, rms * 6);
        if (!unmountedRef.current) {
          const now = Date.now();
          const countdownStartedAt = silenceCountdownStartedAtRef.current;
          setMicLevel(normalized);

          if (countdownStartedAt != null) {
            if (normalized > COUNTDOWN_CANCEL_VOICE_THRESHOLD) {
              const cancelStartedAt = countdownCancelVoiceStartedAtRef.current ?? now;
              countdownCancelVoiceStartedAtRef.current = cancelStartedAt;
              if (now - cancelStartedAt >= COUNTDOWN_CANCEL_VOICE_MS) {
                lastVoiceHeardAtRef.current = now;
                silenceCountdownStartedAtRef.current = null;
                countdownCancelVoiceStartedAtRef.current = null;
                setSilenceCountdown(null);
                setMicHeard(true);
                micLevelFrameRef.current = window.requestAnimationFrame(readLevel);
                return;
              }
            } else {
              countdownCancelVoiceStartedAtRef.current = null;
            }

            const elapsedMs = now - countdownStartedAt;
            if (elapsedMs >= SILENCE_SEND_COUNTDOWN_SECONDS * 1000) {
              setSilenceCountdown(null);
              if (stopRecording({ autoSend: true })) setVoiceAutoSending(true);
              return;
            }
            const remaining = Math.max(
              1,
              Math.ceil((SILENCE_SEND_COUNTDOWN_SECONDS * 1000 - elapsedMs) / 1000),
            );
            setSilenceCountdown(remaining);
          } else if (normalized > VOICE_LEVEL_THRESHOLD) {
            lastVoiceHeardAtRef.current = now;
            countdownCancelVoiceStartedAtRef.current = null;
            setSilenceCountdown(null);
            setMicHeard(true);
          } else if (
            lastVoiceHeardAtRef.current > 0 &&
            now - lastVoiceHeardAtRef.current >= SILENCE_GRACE_MS
          ) {
            silenceCountdownStartedAtRef.current = now;
            countdownCancelVoiceStartedAtRef.current = null;
            setSilenceCountdown(Math.ceil(SILENCE_SEND_COUNTDOWN_SECONDS));
          }
        }
        micLevelFrameRef.current = window.requestAnimationFrame(readLevel);
      };
      readLevel();
    } catch {
      // Recording still works without the meter.
    }
  }

  function clearRecordingState() {
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    stopMicTracks();
    recordingStartedAtRef.current = 0;
    lastVoiceHeardAtRef.current = 0;
    silenceCountdownStartedAtRef.current = null;
    countdownCancelVoiceStartedAtRef.current = null;
    if (!unmountedRef.current) {
      setRecording(false);
      setRecordingMs(0);
      setMicHeard(false);
      setSilenceCountdown(null);
    }
  }

  async function transcribeRecording(
    blob: Blob,
    mimeType: string,
    capturedMs: number,
    autoSend = false,
  ) {
    if (unmountedRef.current) return;
    if (capturedMs < MIN_RECORDING_MS || blob.size < MIN_RECORDING_BYTES) {
      setMicError("No speech detected");
      if (autoSend) setVoiceAutoSending(false);
      return;
    }

    setMicError("");
    setError("");
    setTranscribing(true);
    if (autoSend) setVoiceAutoSending(true);
    try {
      // Auto-send routing:
      //   - First inbound turn (the "Tax Group" greeting) still goes
      //     through /transcribe so we can detect the greeting client-
      //     side and play the pre-synth'd opening audio without a
      //     Claude round-trip. That keeps the snappy first-turn UX.
      //   - Every other auto-send turn goes one-shot via /turn (STT +
      //     Claude + TTS in a single server call). Saves a network
      //     round-trip and keeps Anthropic prompt cache warm.
      //   - The fill-the-draft path (autoSend=false) keeps using
      //     /transcribe — user is going to edit before sending.
      const profileMode = String(profile?.practiceMode || callMode || "").toLowerCase();
      const isFirstInboundTurn =
        session !== null &&
        profileMode === "inbound" &&
        !openingDelivered;

      if (autoSend && !isFirstInboundTurn) {
        setDraft("");
        await submitTrainerTurn({ blob, mimeType });
        return;
      }

      const transcript = await salesTrainerApi.transcribeAudio({
        blob,
        filename: `trainer-mic-${Date.now()}.${extensionForMimeType(mimeType)}`,
        prompt: "Tax resolution sales training call. Transcribe only the agent's spoken turn.",
      });
      const text = transcript.text.trim();
      if (!text) {
        setMicError("No speech detected");
        return;
      }
      if (autoSend) {
        setDraft("");
        await submitTrainerMessage(text, text);
      } else {
        setDraft((current) => (current.trim() ? `${current.trim()}\n${text}` : text));
        window.requestAnimationFrame(() => draftInputRef.current?.focus());
      }
    } catch (err) {
      setMicError(err instanceof Error ? err.message : "Could not transcribe microphone audio");
    } finally {
      setTranscribing(false);
      if (autoSend) setVoiceAutoSending(false);
    }
  }

  async function startRecording(options: { automatic?: boolean } = {}) {
    if (
      !session ||
      sending ||
      transcribing ||
      recording ||
      voiceAutoSending ||
      recordingStartInFlightRef.current
    ) {
      return false;
    }
    if (!micSupported) {
      setMicError("Microphone unavailable");
      if (options.automatic) setHandsFreeEnabled(false);
      return false;
    }

    recordingStartInFlightRef.current = true;
    setMicError("");
    setError("");
    setMicLevel(0);
    setMicHeard(false);
    setSilenceCountdown(null);
    setVoiceAutoSending(false);
    lastVoiceHeardAtRef.current = 0;
    silenceCountdownStartedAtRef.current = null;
    countdownCancelVoiceStartedAtRef.current = null;
    autoStopRecordingRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      stopMicTracks();
      mediaStreamRef.current = stream;
      startMicLevelMeter(stream);

      const mimeType = pickRecordingMimeType();
      const options: MediaRecorderOptions = { audioBitsPerSecond: 64000 };
      if (mimeType) options.mimeType = mimeType;

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, options);
      } catch {
        recorder = new MediaRecorder(stream);
      }

      recordingMimeTypeRef.current = recorder.mimeType || mimeType || "audio/webm";
      audioChunksRef.current = [];
      mediaRecorderRef.current = recorder;
      recordingStartedAtRef.current = Date.now();

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setMicError("Microphone recording failed");
        stopRecording();
      };
      recorder.onstop = () => {
        const chunks = audioChunksRef.current.slice();
        const capturedMs = Date.now() - recordingStartedAtRef.current;
        const autoSend = autoStopRecordingRef.current;
        autoStopRecordingRef.current = false;
        const type =
          recordingMimeTypeRef.current ||
          chunks.find((chunk) => chunk.type)?.type ||
          "audio/webm";
        clearRecordingState();
        if (chunks.length === 0) {
          setMicError("No speech detected");
          if (autoSend) setVoiceAutoSending(false);
          return;
        }
        void transcribeRecording(new Blob(chunks, { type }), type, capturedMs, autoSend);
      };

      recorder.start(250);
      setRecording(true);
      setRecordingMs(0);
      return true;
    } catch (err) {
      clearRecordingState();
      const name =
        err && typeof err === "object" && "name" in err
          ? String((err as { name?: unknown }).name)
          : "";
      setMicError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone permission denied"
          : "Could not start microphone",
      );
      if (options.automatic) setHandsFreeEnabled(false);
      return false;
    } finally {
      recordingStartInFlightRef.current = false;
    }
  }

  function stopRecording(options: { autoSend?: boolean } = {}) {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return false;
    autoStopRecordingRef.current = Boolean(options.autoSend);
    try {
      if (recorder.state === "recording") recorder.requestData();
    } catch {
      /* browsers may throw if a chunk is already being delivered */
    }
    try {
      recorder.stop();
      return true;
    } catch {
      autoStopRecordingRef.current = false;
      return false;
    }
  }

  useEffect(() => {
    if (
      !handsFreeEnabled ||
      !session ||
      !micSupported ||
      starting ||
      sending ||
      transcribing ||
      voiceAutoSending ||
      recording ||
      prospectAudioPending ||
      prospectAudioPlaying ||
      phaseNotes ||
      scorecard
    ) {
      return undefined;
    }

    const id = window.setTimeout(() => {
      void startRecording({ automatic: true });
    }, 250);
    return () => window.clearTimeout(id);
  }, [
    handsFreeEnabled,
    session,
    micSupported,
    starting,
    sending,
    transcribing,
    voiceAutoSending,
    recording,
    prospectAudioPending,
    prospectAudioPlaying,
    phaseNotes,
    scorecard,
  ]);

  if (authState === "checking") {
    return (
      <div className="shell-gradient flex min-h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (authState === "signed-out") {
    return (
      <div className="shell-gradient min-h-screen">
        <SignInPanel onSignedIn={loadTrainerState} />
      </div>
    );
  }

  return (
    <div className="shell-gradient min-h-screen text-foreground">
      <header className="border-b border-border bg-card/70 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1500px] items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold">Sales Trainer</div>
              <div className="text-xs text-muted-foreground">
                {appUser?.email || "Trainer session"}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                clearTrainerToken();
                setAuthState("signed-out");
              }}
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] space-y-4 px-6 py-6">
        <section className="grid gap-4 rounded-lg border border-border bg-card p-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                size="lg"
                variant={callMode === "inbound" ? "primary" : "secondary"}
                onClick={() => setCallMode("inbound")}
                disabled={starting}
              >
                <Play className="h-4 w-4" />
                Inbound
              </Button>
              <Button
                size="lg"
                variant={callMode === "outbound" ? "primary" : "secondary"}
                onClick={() => setCallMode("outbound")}
                disabled={starting}
              >
                <Play className="h-4 w-4" />
                Outbound
              </Button>
            </div>

            {callMode ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>Difficulty</Label>
                  <Select value={difficulty} onValueChange={setDifficulty}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DIFFICULTY_OPTIONS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Scenario</Label>
                  <Select value={scenarioArchetype} onValueChange={setScenarioArchetype}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SCENARIO_ARCHETYPES.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Logic engine</Label>
                  <Select value={provider} onValueChange={setProvider}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(config?.providers.available.length ? config.providers.available : ["anthropic", "openai"]).map(
                        (item) => (
                          <SelectItem key={item} value={item}>
                            {item === "anthropic" ? "Claude" : "GPT"}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ) : null}
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
            <div className="grid grid-cols-2 gap-2 text-xs lg:grid-cols-4">
              <div className="rounded-md border border-border px-3 py-2">
                <div className="text-muted-foreground">Mode</div>
                <div className="truncate font-medium capitalize">
                  {profileString(profile, "practiceMode") !== "-"
                    ? profileString(profile, "practiceMode")
                    : callMode || "-"}
                </div>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <div className="text-muted-foreground">Scenario</div>
                <div className="truncate font-medium">
                  {profileString(profile, "scenarioArchetype") !== "-"
                    ? profileString(profile, "scenarioArchetype")
                    : scenarioArchetype}
                </div>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <div className="text-muted-foreground">Debt</div>
                <div className="truncate font-medium">${profileString(profile, "approxDebtUsd")}</div>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <div className="text-muted-foreground">Mood</div>
                <div className="truncate font-medium">{profileString(profile, "mood")}</div>
              </div>
            </div>

            <Button
              className="lg:self-end"
              onClick={() => {
                primeAudioOutput();
                void startSession();
              }}
              disabled={!callMode || starting}
              isLoading={starting}
            >
              <Play className="h-4 w-4" />
              Go
            </Button>
          </div>
        </section>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div className="flex min-h-[640px] flex-col gap-3">
            <Transcript
              messages={messages}
              lastAudio={lastAudio}
              audioNotice={audioNotice}
              onAudioNotice={setAudioNotice}
              onAudioPending={handleAudioPending}
              onAudioPlaying={handleAudioPlaying}
              onAudioComplete={handleAudioComplete}
            />
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <textarea
                  ref={draftInputRef}
                  value={draft}
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => setInputFocused(false)}
                  readOnly
                  disabled
                  rows={3}
                  className="min-h-20 flex-1 resize-none rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder={session ? "Voice-only mode" : "Press Go to start"}
                />
                <div className="flex shrink-0 gap-2 sm:flex-col sm:justify-end">
                  <Button
                    variant={recording ? "destructive" : "secondary"}
                    onClick={() => {
                      if (recording) {
                        // Manual stop = push-to-talk release. Pass
                        // autoSend so the captured clip flows straight
                        // to /transcribe → submitTrainerMessage instead
                        // of just filling the draft field. This mirrors
                        // the hands-free VAD path at the silence-detect
                        // hook above. Without this flag the user has to
                        // click the mic, speak, click again to stop,
                        // then click Send — three clicks per turn.
                        stopRecording({ autoSend: true });
                      } else {
                        primeAudioOutput();
                        setHandsFreeEnabled(true);
                        void startRecording({ automatic: true });
                      }
                    }}
                    disabled={
                      !session ||
                      sending ||
                      transcribing ||
                      voiceAutoSending ||
                      !micSupported ||
                      (!recording && (prospectAudioPending || prospectAudioPlaying))
                    }
                    isLoading={transcribing || voiceAutoSending}
                    title={!micSupported ? "Microphone unavailable" : undefined}
                  >
                    {recording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                    {voiceAutoSending
                      ? "Generating"
                      : transcribing
                        ? "Transcribing"
                        : recording
                          ? formatRecordingTime(recordingMs)
                          : handsFreeEnabled
                            ? "Auto"
                            : "Mic"}
                  </Button>
                  <Button
                    onClick={() => {
                      // route through the same /transcribe → /respond
                      if (recording) {
                        stopRecording({ autoSend: true });
                      }
                    }}
                    disabled={
                      !session ||
                      sending ||
                      transcribing ||
                      voiceAutoSending ||
                      // Only require a draft when NOT recording — while
                      // recording, the audio clip IS the message.
                      !recording
                    }
                    isLoading={sending || transcribing || voiceAutoSending}
                    variant="primary"
                    title="Send your recording for transcription"
                  >
                    <Send className="h-4 w-4" />
                    Done talking
                  </Button>
                </div>
              </div>
              {micError ? (
                <div className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                  {micError}
                </div>
              ) : null}
              {handsFreeEnabled ||
              recording ||
              transcribing ||
              voiceAutoSending ||
              prospectAudioPending ||
              prospectAudioPlaying ? (
                <div className="mt-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {voiceAutoSending
                        ? "Generating response"
                        : transcribing
                        ? "Sending clip to Whisper"
                        : prospectAudioPlaying
                          ? "Prospect speaking"
                          : prospectAudioPending
                            ? "Opening prospect audio"
                        : silenceCountdown != null
                          ? `Generating response in ${silenceCountdown}`
                          : recording
                            ? micHeard
                              ? "Pause to send"
                              : "Listening for your voice"
                            : handsFreeEnabled
                              ? "Auto mic ready"
                              : "Mic idle"}
                    </span>
                    <span>
                      {recording
                        ? silenceCountdown != null
                          ? "Auto-send"
                          : `${Math.round(micLevel * 100)}%`
                        : prospectAudioPending || prospectAudioPlaying
                          ? "Paused"
                          : handsFreeEnabled
                            ? "Auto"
                            : "Processing"}
                    </span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-background">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all duration-150",
                        silenceCountdown != null
                          ? "bg-primary"
                          : micHeard
                            ? "bg-success"
                            : "bg-warning",
                      )}
                      style={{
                        width: recording
                          ? silenceCountdown != null
                            ? `${Math.round(
                                ((SILENCE_SEND_COUNTDOWN_SECONDS - silenceCountdown + 1) /
                                  SILENCE_SEND_COUNTDOWN_SECONDS) *
                                  100,
                              )}%`
                            : `${Math.max(micLevel > 0 ? 8 : 0, Math.round(micLevel * 100))}%`
                          : "100%",
                      }}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <SidePanel
            health={health}
            phaseNotes={phaseNotes}
            scorecard={scorecard}
            countdown={countdown}
            coach={coach}
            onCommand={(command) => void sendCommand(command)}
          />
        </section>
      </main>
    </div>
  );
}
