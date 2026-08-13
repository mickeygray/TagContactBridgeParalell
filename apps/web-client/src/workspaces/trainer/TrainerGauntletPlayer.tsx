import { useEffect, useRef, useState } from "react";
import {
  Headphones,
  Lightbulb,
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
  audioDataUrl,
  salesTrainerApi,
  type TrainerAudio,
  type TrainerPlayback,
} from "@/lib/api/salesTrainer";
import {
  createTrainingRequestId,
  trainingCourseApi,
  type TrainingAttempt,
  type TrainingCourseItem,
  type TrainingGauntletResult,
  type TrainingTargetedCoach,
} from "@/lib/api/trainingCourse";

interface TrainerGauntletPlayerProps {
  item: TrainingCourseItem;
  attempt: TrainingAttempt | null;
  onStart: () => Promise<TrainingAttempt | null>;
  onAttemptChange?: (attempt: TrainingAttempt) => void;
  onComplete?: () => Promise<void>;
  /**
   * Reports which practice is live so the curriculum rail can show this
   * section's own modules (4B.1-4B.4) instead of the section list again.
   */
  onModuleProgress?: (progress: {
    currentModuleId: string | null;
    completedModuleIds: string[];
  }) => void;
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

function playbackForAudio(audio: TrainerAudio): TrainerPlayback | null {
  const sourceChunks = audio.chunks?.length ? audio.chunks : [audio];
  const chunks = sourceChunks
    .filter((chunk) => Boolean(chunk.audioBase64 && chunk.mimeType))
    .map((chunk, index) => ({
      index,
      text: "",
      mimeType: chunk.mimeType,
      format: chunk.format,
      audioBase64: chunk.audioBase64,
      dataUrl: audioDataUrl(chunk),
    }));
  if (!chunks.length) return null;
  return {
    autoplay: true,
    mimeType: chunks[0].mimeType,
    format: chunks[0].format,
    voice: audio.voice,
    audioBase64: chunks[0].audioBase64,
    dataUrl: chunks[0].dataUrl,
    chunks,
  };
}

export function TrainerGauntletPlayer({
  item,
  attempt,
  onStart,
  onAttemptChange,
  onComplete,
  onModuleProgress,
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
  const [coach, setCoach] = useState<TrainingTargetedCoach | null>(null);
  const [reflectionAnswer, setReflectionAnswer] = useState("");
  const [reflectionGrade, setReflectionGrade] = useState<{
    passed: boolean;
    score: number;
    feedback: string;
  } | null>(null);
  const [gradingReflection, setGradingReflection] = useState(false);
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
  const runtimeRef = useRef<TrainingGauntletResult | null>(null);
  const busyRef = useRef(false);
  const recordingRef = useRef(false);
  const prospectSpeakingRef = useRef(false);
  const handsFreeEnabledRef = useRef(true);
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
    runtimeRef.current = runtime;
  }, [runtime]);

  // Publish which practice is live so the rail can render this section's own
  // modules. Depends on the ids rather than the object so a re-render of the
  // same state does not re-notify the parent.
  const currentModuleId = runtime?.module?.moduleId ?? null;
  const completedKey = (runtime?.state.completedModuleIds || []).join("|");
  useEffect(() => {
    if (!onModuleProgress) return;
    onModuleProgress({
      currentModuleId,
      completedModuleIds: completedKey ? completedKey.split("|") : [],
    });
  }, [onModuleProgress, currentModuleId, completedKey]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    prospectSpeakingRef.current = prospectSpeaking;
  }, [prospectSpeaking]);

  useEffect(() => {
    handsFreeEnabledRef.current = handsFreeEnabled;
  }, [handsFreeEnabled]);

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
      finishProspectPlayback(false);
    });
  }, [prospectAudioUrl]);

  function finishProspectPlayback(autoArm = true) {
    prospectSpeakingRef.current = false;
    setProspectSpeaking(false);
    if (autoArmTimerRef.current) {
      window.clearTimeout(autoArmTimerRef.current);
      autoArmTimerRef.current = null;
    }
    if (
      !autoArm ||
      !handsFreeEnabledRef.current ||
      busyRef.current ||
      recordingRef.current ||
      !["ready", "in_progress"].includes(runtimeRef.current?.state.status || "")
    ) {
      return;
    }
    autoArmTimerRef.current = window.setTimeout(() => {
      autoArmTimerRef.current = null;
      void startRecording();
    }, 700);
  }

  function speakWithBrowser(textToSpeak: string) {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      setAudioNotice("Prospect audio is unavailable; the line is shown below.");
      finishProspectPlayback(false);
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    utterance.rate = 1.08;
    utterance.pitch = 0.95;
    utterance.onstart = () => {
      prospectSpeakingRef.current = true;
      setProspectSpeaking(true);
    };
    utterance.onend = () => finishProspectPlayback();
    utterance.onerror = () => {
      setAudioNotice("Prospect audio could not play; the line is shown below.");
      finishProspectPlayback(false);
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
    prospectSpeakingRef.current = true;
    setProspectSpeaking(true);
    setPlaybackIndex(0);
    setPlaybackUrls(urls);
  }

  async function playVoicedProspect(textToSpeak: string) {
    const clean = textToSpeak.trim();
    if (!clean) return;
    try {
      const audio = await salesTrainerApi.speech({ text: clean });
      const playback = playbackForAudio(audio);
      if (playback) {
        playProspect(clean, playback);
        return;
      }
    } catch {
      // The course remains usable during a TTS outage. Browser speech is a
      // deliberately visible last-mile fallback, not the primary voice path.
    }
    playProspect(clean);
  }

  function replayProspect() {
    if (playbackUrls.length && audioRef.current) {
      setAudioNotice("");
      setPlaybackIndex(0);
      audioRef.current.currentTime = 0;
      void audioRef.current.play().catch(() => {
        setAudioNotice("Browser blocked playback.");
        finishProspectPlayback(false);
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
    finishProspectPlayback();
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
      initializeEventRef.current = null;
      const opening =
        result.openingLine ||
        "The prospect is ready. Respond to the situation in this section of the call.";
      runtimeRef.current = result;
      setRuntime(result);
      if (result.attempt) onAttemptChange?.(result.attempt);
      setCoach(result.coach || null);
      setTape([{ id: "opening", speaker: "prospect", text: opening }]);
      await playVoicedProspect(opening);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start this Talk Session.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(outboundOverride?: string, voiceBlob?: Blob, filename?: string) {
    let outbound = (outboundOverride ?? text).trim();
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
      if (voiceBlob) {
        const transcript = await salesTrainerApi.transcribeAudio({
          blob: voiceBlob,
          filename,
          prompt: `Sales training, ${item.title}. Transcribe only the learner.`,
        });
        outbound = String(transcript.text || "").trim();
      }
      if (!outbound) {
        setError("No speech was detected. Try the response again.");
        return;
      }
      const result = await trainingCourseApi.submitGauntletTurn(
        currentAttempt.attemptId,
        {
          eventId: mutation.eventId,
          expectedVersion: runtime.version ?? currentAttempt.version,
          expectedTurn: runtime.state.nextTurn,
          text: outbound,
        },
      );
      turnEventRef.current = null;
      setText("");
      const learnerText = outbound;
      runtimeRef.current = result;
      setRuntime(result);
      if (result.attempt) onAttemptChange?.(result.attempt);
      setCoach(result.coach || null);
      const reply =
        result.prospectReply?.text ||
        "";
      setTape((current) => [
        ...current,
        { id: mutation.eventId, speaker: "learner", text: learnerText },
        ...(!reply ? [] : [{
          id: `${mutation.eventId}-prospect`,
          speaker: "prospect" as const,
          text: reply,
        }]),
      ]);
      if (reply) await playVoicedProspect(reply);
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
    if (
      !micSupported ||
      busyRef.current ||
      prospectSpeakingRef.current ||
      recordingRef.current
    ) {
      return;
    }
    if (autoArmTimerRef.current) {
      window.clearTimeout(autoArmTimerRef.current);
      autoArmTimerRef.current = null;
    }
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
      if (busyRef.current || prospectSpeakingRef.current || recordingRef.current) {
        stopTracks(stream);
        return;
      }
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
        recordingRef.current = false;
        setRecording(false);
        stopTracks(mediaStreamRef.current);
      };
      recorder.onstop = () => {
        const chunks = audioChunksRef.current.slice();
        const capturedMs = Date.now() - recordingStartedAtRef.current;
        const type = recorder.mimeType || mimeType || "audio/webm";
        recordingRef.current = false;
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
      recordingRef.current = true;
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
      recordingRef.current = false;
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
      const reset = await trainingCourseApi.retryGauntlet(
        currentAttempt.attemptId,
        {
          eventId: createTrainingRequestId("talk-retry"),
          expectedVersion: currentAttempt.version || runtime?.version || 0,
        },
      );
      const opening = reset.openingLine ||
        "The prospect is ready. Respond to the situation in this section of the call.";
      runtimeRef.current = reset;
      setRuntime(reset);
      if (reset.attempt) onAttemptChange?.(reset.attempt);
      setTape([{ id: `opening-${reset.state.runNumber}`, speaker: "prospect", text: opening }]);
      setPlaybackUrls([]);
      setPlaybackIndex(0);
      setLastProspectText(opening);
      setCoach(reset.coach || null);
      setReflectionAnswer("");
      setReflectionGrade(null);
      await playVoicedProspect(opening);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not begin another run.");
    } finally {
      setBusy(false);
    }
  }

  async function gradeReflection() {
    const currentAttempt = runtime?.attempt || attempt;
    if (!currentAttempt || !reflectionAnswer.trim() || gradingReflection) return;
    setGradingReflection(true);
    setError("");
    try {
      const grade = await trainingCourseApi.gradeTargetedModuleAnswer(
        currentAttempt.attemptId,
        reflectionAnswer.trim(),
      );
      setReflectionGrade(grade);
      if (grade.passed && onComplete) await onComplete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not grade that answer.");
    } finally {
      setGradingReflection(false);
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
        {item.content.coachingGuide?.practiceModules?.length ? (
          <div className="mt-4 rounded-md border border-border bg-background p-4">
            <div className="text-xs font-semibold uppercase text-muted-foreground">
              {item.content.coachingGuide.practiceModules.length} brief practices ·{" "}
              {item.title}
            </div>
            <ul className="mt-2 space-y-2 text-sm">
              {item.content.coachingGuide.practiceModules.map((module, index) => (
                <li key={module.moduleId}>
                  <span className="font-semibold">{index + 1}. {module.title}: </span>
                  {module.objective}
                </li>
              ))}
            </ul>
            <div className="mt-4 rounded-md bg-muted/40 p-3 text-sm">
              <div className="font-semibold">
                Read first · {item.content.coachingGuide.practiceModules[0].title}
              </div>
              <p className="mt-1 text-muted-foreground">
                {item.content.coachingGuide.practiceModules[0].reading}
              </p>
            </div>
          </div>
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
            Targeted Talk · Module {runtime.module?.moduleNumber || runtime.state.runNumber + 1}
            {runtime.module?.moduleCount ? ` of ${runtime.module.moduleCount}` : ""}
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
        {prospectSpeaking ? (
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
            {lastProspectText}
          </p>
        ) : coach ? (
          <div className="mx-auto mt-4 max-w-2xl rounded-lg border border-primary/25 bg-background/90 p-4 text-left">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-primary">
              <Lightbulb className="h-4 w-4" />
              Coach · what to notice
            </div>
            <p className="mt-2 text-sm font-medium">{coach.notice}</p>
            {coach.suggestedMove ? (
              <p className="mt-2 text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">Try this move: </span>
                {coach.suggestedMove}
              </p>
            ) : null}
            <p className="mt-3 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">Listen for: </span>
              {coach.listenFor}
            </p>
          </div>
        ) : (
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
            Listen to the prospect, then answer out loud. This session will not leave the assigned call section.
          </p>
        )}

        {prospectAudioUrl ? (
          <audio
            ref={audioRef}
            aria-label="Prospect audio"
            className="sr-only"
            src={prospectAudioUrl}
            onPlay={() => {
              prospectSpeakingRef.current = true;
              setProspectSpeaking(true);
            }}
            onEnded={handlePlaybackEnded}
            onError={() => finishProspectPlayback(false)}
          />
        ) : null}

        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Button
            size="lg"
            variant={recording ? "destructive" : "primary"}
            onClick={recording ? stopRecording : () => void startRecording()}
            disabled={!micSupported || (voiceBusy && !recording) || terminal}
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

      {runtime.module ? (
        <details className="rounded-lg border border-border bg-muted/10 p-4">
          <summary className="cursor-pointer text-sm font-semibold">
            Reading · {runtime.module.title}
          </summary>
          <p className="mt-3 text-sm text-muted-foreground">{runtime.module.reading}</p>
          <p className="mt-3 text-sm font-medium">{runtime.module.objective}</p>
        </details>
      ) : null}

      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {terminal ? (
        <div className="rounded-lg border border-border p-4">
          <h3 className="font-semibold">
            {runtime.state.status === "passed" ? "Talk practice complete" : "Run complete"}
          </h3>
          {runtime.state.status === "passed" && runtime.module?.question ? (
            <div className="mt-4 space-y-3">
              <div className="text-xs font-semibold uppercase text-muted-foreground">
                Short model-graded Q&A
              </div>
              <p className="text-sm font-medium">{runtime.module.question.prompt}</p>
              <textarea
                aria-label="Module reflection answer"
                value={reflectionAnswer}
                onChange={(event) => setReflectionAnswer(event.target.value)}
                className="min-h-24 w-full rounded-md border border-input bg-background p-3 text-sm"
                placeholder="Explain your reasoning in your own words..."
                disabled={gradingReflection || reflectionGrade?.passed === true}
              />
              <Button
                onClick={() => void gradeReflection()}
                disabled={!reflectionAnswer.trim() || gradingReflection}
              >
                {gradingReflection ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Grade my answer
              </Button>
              {reflectionGrade ? (
                <div className={`rounded-md border p-3 text-sm ${
                  reflectionGrade.passed
                    ? "border-success/30 bg-success/10"
                    : "border-warning/30 bg-warning/10"
                }`}>
                  <div className="font-semibold">
                    {reflectionGrade.passed ? "Understood" : "Think it through once more"}
                  </div>
                  <p className="mt-1">{reflectionGrade.feedback}</p>
                </div>
              ) : null}
              {reflectionGrade?.passed &&
              (runtime.module.moduleNumber || 0) < (runtime.module.moduleCount || 0) ? (
                <Button variant="secondary" onClick={() => void retry()} disabled={busy}>
                  Next brief practice
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              Review what happened before trying another variation.
            </p>
          )}
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
