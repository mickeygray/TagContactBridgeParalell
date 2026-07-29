import { useEffect, useRef, useState } from "react";
import {
  Headphones,
  Loader2,
  MessageCircle,
  Mic,
  RotateCcw,
  Send,
  Square,
  Volume2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  type TrainerPlayback,
} from "@/lib/api/salesTrainer";
import {
  createTrainingRequestId,
  trainingCourseApi,
  type TrainingAttempt,
  type TrainingCourseItem,
  type TrainingGauntletResult,
} from "@/lib/api/trainingCourse";

interface TrainerGauntletPlayerProps {
  item: TrainingCourseItem;
  attempt: TrainingAttempt | null;
  onStart: () => Promise<TrainingAttempt | null>;
}

type TapeTurn = {
  id: string;
  speaker: "learner" | "prospect";
  text: string;
};

const RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];
const MIN_RECORDING_MS = 350;
const MIN_RECORDING_BYTES = 900;

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
  return "webm";
}

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

export function TrainerGauntletPlayer({
  item,
  attempt,
  onStart,
}: TrainerGauntletPlayerProps) {
  const [runtime, setRuntime] = useState<TrainingGauntletResult | null>(null);
  const [tape, setTape] = useState<TapeTurn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [prospectSpeaking, setProspectSpeaking] = useState(false);
  const [playbackUrls, setPlaybackUrls] = useState<string[]>([]);
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [handsFreeEnabled, setHandsFreeEnabled] = useState(true);
  const [lastProspectText, setLastProspectText] = useState("");
  const [audioNotice, setAudioNotice] = useState("");
  const [error, setError] = useState("");
  const initializeEventRef = useRef<string | null>(null);
  const turnEventRef = useRef<{ input: string; eventId: string } | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingStartedAtRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const autoArmTimerRef = useRef<number | null>(null);
  const prospectAudioUrl = playbackUrls[playbackIndex] || null;
  const micSupported =
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined";

  useEffect(() => {
    if (!attempt || runtime) return;
    const controller = new AbortController();
    void trainingCourseApi.gauntlet(attempt.attemptId, controller.signal)
      .then(setRuntime)
      .catch(() => undefined);
    return () => controller.abort();
  }, [attempt, runtime]);

  useEffect(() => {
    return () => {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      stopTracks(mediaStreamRef.current);
      window.speechSynthesis?.cancel();
      if (autoArmTimerRef.current) window.clearTimeout(autoArmTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const player = audioRef.current;
    if (!player || !prospectAudioUrl) return;
    player.currentTime = 0;
    player.load();
    void player.play().catch(() => {
      setAudioNotice("Click Replay if browser autoplay is blocked.");
      setProspectSpeaking(false);
    });
  }, [prospectAudioUrl]);

  function speakWithBrowser(textToSpeak: string) {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      setAudioNotice("Prospect audio is unavailable; the line is shown below.");
      setProspectSpeaking(false);
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    utterance.rate = 1.08;
    utterance.pitch = 0.95;
    utterance.onstart = () => setProspectSpeaking(true);
    utterance.onend = () => setProspectSpeaking(false);
    utterance.onerror = () => {
      setAudioNotice("Prospect audio could not play; the line is shown below.");
      setProspectSpeaking(false);
    };
    window.speechSynthesis.speak(utterance);
  }

  function playProspect(textToSpeak: string, playback?: TrainerPlayback | null) {
    const clean = textToSpeak.trim();
    if (!clean) return;
    setLastProspectText(clean);
    setAudioNotice("");
    const urls = playback?.chunks?.length
      ? playback.chunks.map((chunk) => chunk.dataUrl).filter(Boolean)
      : playback?.dataUrl
        ? [playback.dataUrl]
        : [];
    if (urls.length === 0) {
      setPlaybackUrls([]);
      speakWithBrowser(clean);
      return;
    }
    setProspectSpeaking(true);
    setPlaybackIndex(0);
    setPlaybackUrls(urls);
  }

  function replayProspect() {
    if (playbackUrls.length && audioRef.current) {
      setAudioNotice("");
      setPlaybackIndex(0);
      audioRef.current.currentTime = 0;
      void audioRef.current.play().catch(() => {
        setAudioNotice("Browser blocked playback.");
        setProspectSpeaking(false);
      });
      return;
    }
    if (lastProspectText) speakWithBrowser(lastProspectText);
  }

  function handlePlaybackEnded() {
    if (playbackIndex + 1 < playbackUrls.length) {
      setPlaybackIndex((current) => current + 1);
      return;
    }
    setProspectSpeaking(false);
    if (handsFreeEnabled && !busy && runtime?.state.status === "in_progress") {
      autoArmTimerRef.current = window.setTimeout(() => {
        void startRecording();
      }, 700);
    }
  }

  async function begin() {
    setBusy(true);
    setError("");
    try {
      const started = attempt || await onStart();
      if (!started) return;
      const eventId = initializeEventRef.current ||
        (initializeEventRef.current = createTrainingRequestId("talk-init"));
      const result = await trainingCourseApi.initializeGauntlet(
        started.attemptId,
        { eventId, expectedVersion: started.version },
      );
      const voiceSession = await trainingCourseApi.startTargetedVoiceSession(
        started.attemptId,
      );
      initializeEventRef.current = null;
      const opening =
        voiceSession.openingLine ||
        "The prospect is ready. Respond to the situation in this section of the call.";
      setRuntime(result);
      setTape([{ id: "opening", speaker: "prospect", text: opening }]);
      playProspect(opening, voiceSession.openingPlayback);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start this Talk Session.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(outboundOverride?: string, voiceBlob?: Blob, filename?: string) {
    const outbound = (outboundOverride ?? text).trim();
    const currentAttempt = runtime?.attempt || attempt;
    if ((!outbound && !voiceBlob) || !runtime?.state || !currentAttempt || busy) return;
    setBusy(true);
    setError("");
    const mutationInput = outbound || `voice-${runtime.state.nextTurn}`;
    const mutation = turnEventRef.current?.input === mutationInput
      ? turnEventRef.current
      : { input: mutationInput, eventId: createTrainingRequestId("talk-turn") };
    turnEventRef.current = mutation;
    try {
      const result = await trainingCourseApi.submitTargetedVoiceTurn(
        currentAttempt.attemptId,
        {
          blob: voiceBlob,
          filename,
          text: outbound,
        },
      );
      turnEventRef.current = null;
      setText("");
      setRuntime(result.gauntlet);
      const learnerText =
        result.voiceTurn.transcript?.text?.trim() || outbound;
      const reply =
        result.voiceTurn.response?.text?.trim() ||
        result.gauntlet.prospectReply?.text ||
        "The prospect responds and keeps this section moving.";
      setTape((current) => [
        ...current,
        { id: mutation.eventId, speaker: "learner", text: learnerText },
        ...(!reply ? [] : [{
          id: `${mutation.eventId}-prospect`,
          speaker: "prospect" as const,
          text: reply,
        }]),
      ]);
      if (reply) playProspect(reply, result.voiceTurn.playback);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit this turn.");
    } finally {
      setBusy(false);
    }
  }

  async function submitVoiceRecording(blob: Blob, mimeType: string, capturedMs: number) {
    if (capturedMs < MIN_RECORDING_MS || blob.size < MIN_RECORDING_BYTES) {
      setError("No speech detected. Hold the button long enough to say your response.");
      return;
    }
    setError("");
    try {
      await submit(
        "",
        blob,
        `targeted-talk-${Date.now()}.${extensionForMimeType(mimeType)}`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not transcribe your response.");
    } finally {
    }
  }

  async function startRecording() {
    if (!micSupported || busy || prospectSpeaking || recording) return;
    setError("");
    setAudioNotice("");
    try {
      window.speechSynthesis?.cancel();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      stopTracks(mediaStreamRef.current);
      mediaStreamRef.current = stream;
      const mimeType = pickRecordingMimeType();
      const options: MediaRecorderOptions = { audioBitsPerSecond: 64000 };
      if (mimeType) options.mimeType = mimeType;
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, options);
      } catch {
        recorder = new MediaRecorder(stream);
      }
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      recordingStartedAtRef.current = Date.now();
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setError("Microphone recording failed.");
        setRecording(false);
        stopTracks(mediaStreamRef.current);
      };
      recorder.onstop = () => {
        const chunks = audioChunksRef.current.slice();
        const capturedMs = Date.now() - recordingStartedAtRef.current;
        const type = recorder.mimeType || mimeType || "audio/webm";
        setRecording(false);
        stopTracks(mediaStreamRef.current);
        mediaStreamRef.current = null;
        if (chunks.length === 0) {
          setError("No speech detected.");
          return;
        }
        void submitVoiceRecording(new Blob(chunks, { type }), type, capturedMs);
      };
      recorder.start(250);
      setRecording(true);
    } catch (cause) {
      const name =
        cause && typeof cause === "object" && "name" in cause
          ? String((cause as { name?: unknown }).name)
          : "";
      setError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone permission denied."
          : "Could not start the microphone.",
      );
      stopTracks(mediaStreamRef.current);
      mediaStreamRef.current = null;
    }
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    try {
      recorder.requestData();
    } catch {
      // The final dataavailable event still fires on stop in supported browsers.
    }
    recorder.stop();
  }

  async function retry() {
    const currentAttempt = runtime?.attempt || attempt;
    if (!currentAttempt) return;
    setBusy(true);
    setError("");
    try {
      const result = await trainingCourseApi.retryGauntlet(
        currentAttempt.attemptId,
        {
          eventId: createTrainingRequestId("talk-retry"),
          expectedVersion: currentAttempt.version || runtime?.version || 0,
        },
      );
      setRuntime(result);
      setTape([]);
      setPlaybackUrls([]);
      setPlaybackIndex(0);
      setLastProspectText("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not begin another run.");
    } finally {
      setBusy(false);
    }
  }

  if (!runtime) {
    return (
      <div className="rounded-lg border border-primary/25 bg-primary/5 p-6">
        <Headphones className="h-7 w-7 text-primary" />
        <h2 className="mt-3 text-lg font-semibold">Targeted Talk Session</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Practice only this part of the call. The prospect can vary, but the
          server keeps the section, rules, voice, and advancement gates fixed.
        </p>
        {item.content.instructions ? (
          <p className="mt-3 text-sm">{item.content.instructions}</p>
        ) : null}
        {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
        <Button className="mt-5" onClick={() => void begin()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Headphones className="h-4 w-4" />}
          Start voice session
        </Button>
      </div>
    );
  }

  const terminal = runtime.state.status === "passed" || runtime.state.status === "failed";
  const voiceBusy = busy || prospectSpeaking;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 p-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">
            Targeted Talk · Run {runtime.state.runNumber + 1}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Turn {runtime.state.nextTurn} · {runtime.state.status.replace(/_/g, " ")}
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          {runtime.state.criteria.filter((criterion) => criterion.status === "satisfied").length}
          /{runtime.state.criteria.length} skills demonstrated
        </div>
      </div>

      <section className="rounded-xl border border-border bg-gradient-to-b from-primary/5 to-card p-6 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-primary">
          {prospectSpeaking ? (
            <Volume2 className="h-8 w-8 animate-pulse" />
          ) : busy ? (
            <Loader2 className="h-8 w-8 animate-spin" />
          ) : recording ? (
            <Mic className="h-8 w-8 animate-pulse" />
          ) : (
            <MessageCircle className="h-8 w-8" />
          )}
        </div>
        <h2 className="mt-4 text-lg font-semibold">
          {prospectSpeaking
            ? "Prospect speaking"
            : busy
                ? "Prospect is responding"
                : recording
                  ? "Listening — say your move"
                  : "Your turn"}
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
          {lastProspectText || "Listen to the prospect, then answer out loud. This session will not leave the assigned call section."}
        </p>

        {prospectAudioUrl ? (
          <audio
            ref={audioRef}
            aria-label="Prospect audio"
            className="sr-only"
            src={prospectAudioUrl}
            onPlay={() => setProspectSpeaking(true)}
            onEnded={handlePlaybackEnded}
            onError={() => setProspectSpeaking(false)}
          />
        ) : null}

        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Button
            size="lg"
            variant={recording ? "destructive" : "primary"}
            onClick={recording ? stopRecording : () => void startRecording()}
            disabled={!micSupported || voiceBusy && !recording || terminal}
          >
            {recording ? <Square className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
            {recording ? "Finish and send" : "Talk"}
          </Button>
          <Button
            size="lg"
            variant="secondary"
            onClick={replayProspect}
            disabled={!lastProspectText || recording || busy}
          >
            <Volume2 className="h-5 w-5" />
            Replay prospect
          </Button>
        </div>
        {!micSupported ? (
          <p className="mt-3 text-xs text-warning">
            This browser cannot capture microphone audio. Use the text fallback below.
          </p>
        ) : null}
        {micSupported ? (
          <label className="mt-4 inline-flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={handsFreeEnabled}
              onChange={(event) => setHandsFreeEnabled(event.target.checked)}
            />
            Hands-free: listen again after the prospect finishes
          </label>
        ) : null}
        {audioNotice ? <p className="mt-3 text-xs text-muted-foreground">{audioNotice}</p> : null}
      </section>

      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {terminal ? (
        <div className="rounded-lg border border-border p-4">
          <h3 className="font-semibold">{runtime.state.status === "passed" ? "Section passed" : "Run complete"}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Review the cited skill evidence before moving on.
          </p>
          {runtime.state.status === "failed" ? (
            <Button className="mt-3" variant="secondary" onClick={() => void retry()} disabled={busy}>
              <RotateCcw className="h-4 w-4" />
              Try another variation
            </Button>
          ) : null}
        </div>
      ) : (
        <details className="rounded-lg border border-border bg-muted/10 p-4">
          <summary className="cursor-pointer text-sm font-medium">Text fallback and transcript</summary>
          <div aria-label="Talk session transcript" className="mt-4 max-h-[280px] space-y-3 overflow-y-auto rounded-lg border border-border bg-background p-4">
            {tape.map((turn) => (
              <div key={turn.id} className={turn.speaker === "learner" ? "ml-auto max-w-[85%] rounded-lg bg-primary p-3 text-sm text-primary-foreground" : "max-w-[85%] rounded-lg bg-muted p-3 text-sm"}>
                <div className="mb-1 text-[10px] font-semibold uppercase opacity-70">{turn.speaker}</div>
                {turn.text}
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <textarea
              aria-label="Text response fallback"
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="min-h-20 flex-1 rounded-md border border-input bg-background p-3 text-sm"
              placeholder="Type only when voice capture is unavailable..."
              disabled={voiceBusy}
            />
            <Button aria-label="Send text response" onClick={() => void submit()} disabled={voiceBusy || !text.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </details>
      )}
    </div>
  );
}
