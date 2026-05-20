"use strict";

// Compare small/fast models on one narrow job:
// turn a short mixed live-call transcript chunk into speaker-labeled segments.
//
// Examples:
//   node scripts/eval-speaker-label-models.js
//   node scripts/eval-speaker-label-models.js --models anthropic:claude-haiku-4-5,anthropic:claude-sonnet-4-6,openai:gpt-4o-mini,openai:gpt-4o
//   node scripts/eval-speaker-label-models.js --script scripts/fixtures/speaker-label-call-script.json --script-mode pairs
//   node scripts/eval-speaker-label-models.js --source runtime/ex-live-monitor-oneoff/<run>/transcripts.ndjson
//   node scripts/eval-speaker-label-models.js --latest --script scripts/fixtures/speaker-label-call-script.json
//   node scripts/eval-speaker-label-models.js --text "Hi, this is Bruce with Wynn Tax. I got a CP504 letter."

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { createAnthropicClient } = require("../packages/shared-integrations/src/anthropicClient");

const SPEAKER_KEYS = ["agent", "prospect", "system", "unknown"];

const DEFAULT_MODELS = [
  "anthropic:claude-haiku-4-5",
  "anthropic:claude-sonnet-4-6",
  "openai:gpt-4o-mini",
  "openai:gpt-4o",
];

const DEFAULT_FIXTURE = [
  {
    id: "mixed-agent-intro",
    chunkText: "Bye. Hi, this is Bruce with WinTax Solutions.",
    expected: [
      { speaker: "prospect", text: "Bye." },
      { speaker: "agent", text: "Hi, this is Bruce with WinTax Solutions." },
    ],
  },
  {
    id: "agent-pleasantry",
    prior: [
      { speaker: "prospect", text: "Hello?" },
      { speaker: "agent", text: "Hi, this is Bruce with WinTax Solutions." },
    ],
    chunkText: "How are you doing today?",
    expected: [{ speaker: "agent", text: "How are you doing today?" }],
  },
  {
    id: "prospect-audio-complaint",
    prior: [
      { speaker: "prospect", text: "Hello?" },
      { speaker: "agent", text: "Hi, this is Bruce with WinTax Solutions." },
      { speaker: "agent", text: "How are you doing today?" },
    ],
    chunkText: "Okay, well, that's kind of breaking up a little bit.",
    expected: [{ speaker: "prospect", text: "Okay, well, that's kind of breaking up a little bit." }],
  },
  {
    id: "agent-qualifying-question",
    prior: [
      { speaker: "prospect", text: "Okay, well, that's kind of breaking up a little bit." },
      { speaker: "prospect", text: "Not so bad." },
    ],
    chunkText: "So, do you owe taxes?",
    expected: [{ speaker: "agent", text: "So, do you owe taxes?" }],
  },
  {
    id: "prospect-qualifying-answer",
    prior: [
      { speaker: "agent", text: "So, do you owe taxes?" },
    ],
    chunkText: "I do not owe taxes.",
    expected: [{ speaker: "prospect", text: "I do not owe taxes." }],
  },
  {
    id: "system-hold",
    chunkText: "Please continue to hold. Your call is important to us.",
    expected: [{ speaker: "system", text: "Please continue to hold. Your call is important to us." }],
  },
];

const DEFAULT_SCRIPT_TURNS = [
  {
    id: "prospect-open",
    speaker: "prospect",
    text: "Hello, this is Mickey.",
    readAs: "Prospect",
  },
  {
    id: "agent-intro",
    speaker: "agent",
    text: "Hi Mickey, this is Bruce with Tax Advocate Group. Can you hear me clearly?",
    readAs: "Agent",
  },
  {
    id: "prospect-hears",
    speaker: "prospect",
    text: "Yes, I can hear you. I had a question about a letter I got.",
    readAs: "Prospect",
  },
  {
    id: "agent-qualifies",
    speaker: "agent",
    text: "Okay. Is the main issue a tax balance, unfiled returns, or both?",
    readAs: "Agent",
  },
  {
    id: "prospect-balance",
    speaker: "prospect",
    text: "I filed the last two years, but I still owe for twenty twenty two.",
    readAs: "Prospect",
  },
  {
    id: "agent-process",
    speaker: "agent",
    text: "Got it. I am going to ask a couple quick questions, then a consultant can review it.",
    readAs: "Agent",
  },
  {
    id: "prospect-cost",
    speaker: "prospect",
    text: "Before that, can you tell me if this is going to cost money today?",
    readAs: "Prospect",
  },
  {
    id: "agent-cost",
    speaker: "agent",
    text: "The review starts with a phone call. We do not quote fees before looking at the basics.",
    readAs: "Agent",
  },
  {
    id: "prospect-window",
    speaker: "prospect",
    text: "Okay, that makes sense. I can talk for about five minutes.",
    readAs: "Prospect",
  },
  {
    id: "agent-close",
    speaker: "agent",
    text: "That works. Let me confirm the best phone number and then we can keep this moving.",
    readAs: "Agent",
  },
];

const TOOL_SCHEMA = {
  name: "submit_speaker_labels",
  description: "Label a short mixed call-transcript chunk by likely speaker.",
  input_schema: {
    type: "object",
    required: ["segments"],
    properties: {
      segments: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          required: ["speaker", "text", "confidence", "reason"],
          properties: {
            speaker: { type: "string", enum: SPEAKER_KEYS },
            text: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string" },
          },
        },
      },
    },
  },
};

const OPENAI_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["segments"],
  properties: {
    segments: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["speaker", "text", "confidence", "reason"],
        properties: {
          speaker: { type: "string", enum: SPEAKER_KEYS },
          text: { type: "string" },
          confidence: { type: "number" },
          reason: { type: "string" },
        },
      },
    },
  },
};

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && index < argv.length - 1) return argv[index + 1];
  return fallback;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cleanText(value, maxLength = 2000) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeForCompare(value) {
  return cleanText(value, 4000)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeForCompare(value) {
  const normalized = normalizeForCompare(value);
  return normalized ? normalized.split(" ") : [];
}

function editDistanceWords(aWords, bWords) {
  const a = Array.isArray(aWords) ? aWords : [];
  const b = Array.isArray(bWords) ? bWords : [];
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }
  return previous[b.length] || 0;
}

function textSimilarity(a, b) {
  const aWords = tokenizeForCompare(a);
  const bWords = tokenizeForCompare(b);
  if (!aWords.length && !bWords.length) return 1;
  if (!aWords.length || !bWords.length) return 0;
  const distance = editDistanceWords(aWords, bWords);
  return Math.max(0, 1 - distance / Math.max(aWords.length, bWords.length));
}

function splitModelSpec(spec) {
  const raw = String(spec || "").trim();
  const index = raw.indexOf(":");
  if (index <= 0) return { provider: "anthropic", model: raw };
  return {
    provider: raw.slice(0, index).trim().toLowerCase(),
    model: raw.slice(index + 1).trim(),
  };
}

function parseModels(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(splitModelSpec);
}

function parseJsonLoose(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function extractOpenAiText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (typeof block?.text === "string") parts.push(block.text);
      if (typeof block?.output_text === "string") parts.push(block.output_text);
    }
  }
  return parts.join("\n").trim();
}

function normalizeSegments(input, fallbackText = "") {
  const rawSegments = Array.isArray(input?.segments) ? input.segments : [];
  const segments = rawSegments
    .map((segment) => {
      const speaker = SPEAKER_KEYS.includes(String(segment?.speaker || "").toLowerCase())
        ? String(segment.speaker).toLowerCase()
        : "unknown";
      const text = cleanText(segment?.text || "", 1000);
      if (!text) return null;
      const confidence = Number(segment?.confidence);
      return {
        speaker,
        text,
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
        reason: cleanText(segment?.reason || "", 220),
      };
    })
    .filter(Boolean)
    .slice(0, 8);
  if (segments.length) return segments;
  const text = cleanText(fallbackText, 1000);
  return text ? [{ speaker: "unknown", text, confidence: 0.2, reason: "fallback unlabeled" }] : [];
}

function buildPrompt({ sample, metadata }) {
  const priorSegments = Array.isArray(sample.prior) ? sample.prior : [];
  const prior = priorSegments
    .slice(-20)
    .map((segment) => `${segment.speaker}: ${segment.text}`)
    .join("\n");
  const callFlow = cleanText(metadata.callFlow || "outbound", 40);
  const initialHumanSpeaker = cleanText(metadata.initialHumanSpeaker || "prospect", 40);
  return [
    "You are labeling speaker turns in a live tax-resolution sales call transcript.",
    "The audio source is a single RingEX supervision leg, so the transcript may be mixed mono and may include the agent, the prospect/client, hold prompts, voicemail prompts, or system audio.",
    "Do not invent precision. Split the chunk only when the words clearly change speaker.",
    `Call flow: ${callFlow}. For outbound calls, the first non-system human voice after hold/connection is usually the prospect answering.`,
    `Initial human speaker bias: ${initialHumanSpeaker}. Keep speaker inertia across short fragments; switch speakers only when the words clearly prove a turn change.`,
    "Prefer complete sentence-level speaker turns. If a chunk is just a stutter or half-sentence, keep it with the previous human speaker unless a greeting, company intro, or question clearly starts a new turn.",
    "Use speaker=agent for the Tax Advocate Group/Wynn representative.",
    "Use speaker=prospect for the person being called on the cell/client side.",
    "Use speaker=system for RingCentral/CX prompts, hold messages, voicemail greetings, beep instructions, or automated call audio.",
    "Use speaker=unknown when there is not enough evidence.",
    "Short fragments are okay. Keep the original wording, lightly cleaned.",
    "",
    `Metadata: ${JSON.stringify(metadata || {})}`,
    "",
    "Recent labeled context:",
    prior || "(none)",
    "",
    "New raw transcript chunk:",
    sample.chunkText,
  ].join("\n");
}

function loadNdjson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function normalizeScriptTurn(turn, index) {
  const speaker = SPEAKER_KEYS.includes(String(turn?.speaker || "").toLowerCase())
    ? String(turn.speaker).toLowerCase()
    : "";
  const text = cleanText(turn?.text || turn?.line || turn?.utterance || "", 1000);
  if (!speaker || !text) return null;
  return {
    id: cleanText(turn?.id || `turn-${String(index + 1).padStart(2, "0")}`, 80),
    speaker,
    text,
    readAs: cleanText(turn?.readAs || turn?.role || speaker, 80),
    notes: cleanText(turn?.notes || "", 220),
  };
}

function loadScriptTurns(filePath) {
  if (!filePath) return DEFAULT_SCRIPT_TURNS;
  const absolute = path.resolve(filePath);
  const raw = fs.readFileSync(absolute, "utf8");
  const parsed = absolute.toLowerCase().endsWith(".ndjson")
    ? raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line))
    : JSON.parse(raw);
  const rawTurns = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.turns) ? parsed.turns : [];
  const turns = rawTurns.map(normalizeScriptTurn).filter(Boolean);
  if (!turns.length) throw new Error(`No valid script turns found in ${absolute}`);
  return turns;
}

function samplesFromScriptTurns(turns, mode, limit) {
  const samples = [];
  const prior = [];
  const normalizedMode = String(mode || "turns").toLowerCase();
  const groupSize = normalizedMode === "pairs" ? 2 : normalizedMode === "triples" ? 3 : 1;
  for (let index = 0; index < turns.length; index += groupSize) {
    const group = turns.slice(index, index + groupSize);
    if (!group.length) continue;
    samples.push({
      id: group.map((turn) => turn.id).join("+"),
      chunkText: group.map((turn) => turn.text).join(" "),
      prior: prior.slice(-8),
      expected: group.map((turn) => ({ speaker: turn.speaker, text: turn.text, id: turn.id })),
      scriptMode: normalizedMode,
    });
    for (const turn of group) prior.push({ speaker: turn.speaker, text: turn.text });
    if (samples.length >= limit) break;
  }
  return samples;
}

function renderScriptMarkdown(turns) {
  const lines = [];
  lines.push("# Speaker Label Call Script");
  lines.push("");
  lines.push("Read these lines in order. Use natural pauses between turns. For diarize tests, use two real voices when possible; if one person is reading both sides, use a natural but clearly different cadence.");
  lines.push("");
  for (const turn of turns) {
    lines.push(`**${turn.readAs || turn.speaker}:** ${turn.text}`);
    if (turn.notes) lines.push(`_${turn.notes}_`);
    lines.push("");
  }
  return lines.join("\n");
}

function latestTranscriptPath() {
  const root = path.resolve(__dirname, "..", "runtime", "ex-live-monitor-oneoff");
  if (!fs.existsSync(root)) return "";
  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "transcripts.ndjson"))
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.file || "";
}

function samplesFromTranscriptFile(filePath, limit) {
  const rows = loadNdjson(filePath);
  const samples = [];
  const prior = [];
  for (const row of rows) {
    const chunkText = cleanText(row.text || "", 1000);
    if (!chunkText) continue;
    samples.push({
      id: row.id || `sample-${samples.length + 1}`,
      chunkText,
      prior: prior.slice(-8),
      sourceSpeakerSegments: Array.isArray(row.speakerSegments) ? row.speakerSegments : [],
    });
    const speakerSegments = Array.isArray(row.speakerSegments) ? row.speakerSegments : [];
    for (const segment of speakerSegments) {
      const speaker = SPEAKER_KEYS.includes(String(segment?.speaker || "").toLowerCase())
        ? String(segment.speaker).toLowerCase()
        : "unknown";
      const text = cleanText(segment?.text || "", 1000);
      if (text) prior.push({ speaker, text });
    }
    if (samples.length >= limit) break;
  }
  return samples;
}

function loadSamples({ source, text, useLatest, scriptTurns, scriptMode, limit }) {
  if (text) {
    return [{ id: "cli-text", chunkText: cleanText(text, 1000), expected: [] }];
  }
  if (scriptTurns?.length && !source && !useLatest) {
    return samplesFromScriptTurns(scriptTurns, scriptMode, limit);
  }
  const sourcePath = source || (useLatest ? latestTranscriptPath() : "");
  if (sourcePath) {
    return samplesFromTranscriptFile(path.resolve(sourcePath), limit);
  }
  return DEFAULT_FIXTURE.slice(0, limit);
}

async function callAnthropicLabeler({ model, prompt, timeoutMs }) {
  const client = createAnthropicClient();
  const raw = await client.createMessage({
    system: "Output strictly via submit_speaker_labels. No free text.",
    messages: [{ role: "user", content: prompt }],
    model,
    maxTokens: 700,
    temperature: 0,
    tools: [TOOL_SCHEMA],
    toolChoice: { type: "tool", name: "submit_speaker_labels" },
    timeoutMs,
  });
  const toolUse = client.extractToolUse(raw, "submit_speaker_labels");
  if (!toolUse?.input) throw new Error("No submit_speaker_labels tool use returned");
  return {
    raw,
    parsed: toolUse.input,
    model: raw?.model || model,
    usage: raw?.usage || null,
  };
}

async function callOpenAiLabeler({ model, prompt, timeoutMs }) {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing");
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), Math.max(timeoutMs, 1000));
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        instructions: [
          "Return only valid JSON matching this schema:",
          JSON.stringify(OPENAI_JSON_SCHEMA),
          "No markdown. No prose outside the JSON object.",
        ].join("\n"),
        input: [{ role: "user", content: prompt }],
        max_output_tokens: 700,
        temperature: 0,
      }),
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
  const rawText = await response.text();
  let payload = parseJsonLoose(rawText) || { rawText };
  if (!response.ok) {
    throw new Error(`OpenAI ${response.status}: ${rawText.slice(0, 500)}`);
  }
  const outputText = extractOpenAiText(payload);
  const parsed = parseJsonLoose(outputText);
  if (!parsed) throw new Error(`OpenAI returned non-JSON label payload: ${outputText.slice(0, 300)}`);
  return {
    raw: payload,
    parsed,
    model: payload?.model || model,
    usage: payload?.usage || null,
  };
}

async function callModel({ spec, sample, metadata, timeoutMs }) {
  const prompt = buildPrompt({ sample, metadata });
  const startedAt = Date.now();
  const result = spec.provider === "openai"
    ? await callOpenAiLabeler({ model: spec.model, prompt, timeoutMs })
    : await callAnthropicLabeler({ model: spec.model, prompt, timeoutMs });
  const elapsedMs = Date.now() - startedAt;
  return {
    provider: spec.provider,
    requestedModel: spec.model,
    returnedModel: result.model,
    elapsedMs,
    segments: normalizeSegments(result.parsed, sample.chunkText),
    usage: result.usage,
  };
}

function scorePrediction(sample, segments) {
  const expected = Array.isArray(sample.expected) ? sample.expected : [];
  const normalizedInput = normalizeForCompare(sample.chunkText);
  const normalizedOutput = normalizeForCompare(segments.map((segment) => segment.text).join(" "));
  const validSpeakers = segments.every((segment) => SPEAKER_KEYS.includes(segment.speaker));
  const preservesText = normalizedInput === normalizedOutput;
  const score = {
    hasExpected: expected.length > 0,
    exactSpeakerSequence: null,
    exactText: preservesText,
    validSpeakers,
    segmentCount: segments.length,
    expectedSegmentCount: expected.length || null,
    passed: null,
  };
  if (expected.length) {
    const predictedSpeakers = segments.map((segment) => segment.speaker).join("|");
    const expectedSpeakers = expected.map((segment) => segment.speaker).join("|");
    score.exactSpeakerSequence = predictedSpeakers === expectedSpeakers;
    score.passed =
      score.validSpeakers &&
      score.exactText &&
      score.exactSpeakerSequence &&
      segments.length === expected.length;
  }
  return score;
}

function flattenResultSegments(rows) {
  const segments = [];
  for (const row of rows) {
    for (const segment of row.segments || []) {
      const text = cleanText(segment?.text || "", 1000);
      if (!text) continue;
      segments.push({
        sampleId: row.sampleId,
        speaker: segment.speaker || "unknown",
        text,
        confidence: segment.confidence ?? null,
      });
    }
  }
  return segments;
}

function alignScriptTurnsToPredictions(turns, predictedSegments) {
  const matches = [];
  let cursor = 0;
  for (const turn of turns) {
    let best = null;
    const searchEnd = Math.min(predictedSegments.length, cursor + 8);
    for (let index = cursor; index < searchEnd; index += 1) {
      const one = predictedSegments[index];
      const oneSimilarity = textSimilarity(turn.text, one.text);
      const oneScore = oneSimilarity + (one.speaker === turn.speaker ? 0.15 : 0) - ((index - cursor) * 0.015);
      if (!best || oneScore > best.score) {
        best = { index, take: 1, segment: one, text: one.text, score: oneScore, similarity: oneSimilarity };
      }
      const two = predictedSegments[index + 1];
      if (two) {
        const mergedText = `${one.text} ${two.text}`;
        const mergedSimilarity = textSimilarity(turn.text, mergedText);
        const speakerBonus = one.speaker === turn.speaker || two.speaker === turn.speaker ? 0.12 : 0;
        const mergedScore = mergedSimilarity + speakerBonus - ((index - cursor) * 0.015) - 0.03;
        if (!best || mergedScore > best.score) {
          best = { index, take: 2, segment: one, text: mergedText, score: mergedScore, similarity: mergedSimilarity };
        }
      }
    }
    const speakerMatch = Boolean(best?.segment?.speaker === turn.speaker);
    matches.push({
      expectedId: turn.id,
      expectedSpeaker: turn.speaker,
      expectedText: turn.text,
      predictedSpeaker: best?.segment?.speaker || "missing",
      predictedText: best?.text || "",
      predictedSampleId: best?.segment?.sampleId || "",
      textSimilarity: Number((best?.similarity || 0).toFixed(3)),
      speakerMatch,
      matched: Boolean(best && best.similarity >= 0.58),
      passed: Boolean(best && best.similarity >= 0.58 && speakerMatch),
    });
    if (best) cursor = Math.max(cursor, best.index + best.take);
  }
  const matched = matches.filter((match) => match.matched).length;
  const speakerPassed = matches.filter((match) => match.passed).length;
  const avgTextSimilarity = matches.length
    ? Number((matches.reduce((sum, match) => sum + match.textSimilarity, 0) / matches.length).toFixed(3))
    : 0;
  return {
    total: turns.length,
    matched,
    speakerPassed,
    avgTextSimilarity,
    passRate: turns.length ? Number((speakerPassed / turns.length).toFixed(3)) : 0,
    matches,
  };
}

function buildScriptAlignment(results, scriptTurns) {
  if (!scriptTurns?.length) return [];
  const grouped = new Map();
  for (const row of results) {
    const key = `${row.provider}:${row.returnedModel || row.requestedModel}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const alignments = [];
  for (const [modelKey, rows] of grouped.entries()) {
    const sortedRows = rows.slice().sort((a, b) => String(a.sampleId).localeCompare(String(b.sampleId)));
    alignments.push({
      model: modelKey,
      ...alignScriptTurnsToPredictions(scriptTurns, flattenResultSegments(sortedRows)),
    });
  }
  return alignments;
}

function renderMarkdown(results, outputJsonPath, scriptAlignments = []) {
  const lines = [];
  lines.push("# Speaker Label Model Eval");
  lines.push("");
  lines.push(`JSON: ${outputJsonPath}`);
  lines.push("");
  if (scriptAlignments.length) {
    lines.push("## Spoken Script Alignment");
    lines.push("");
    lines.push("| Model | Script pass | Matched text | Avg text similarity |");
    lines.push("| --- | ---: | ---: | ---: |");
    for (const alignment of scriptAlignments) {
      lines.push(`| ${alignment.model} | ${alignment.speakerPassed}/${alignment.total} | ${alignment.matched}/${alignment.total} | ${alignment.avgTextSimilarity} |`);
    }
    lines.push("");
  }
  lines.push("| Model | Passed | Avg ms | Valid | Text kept | Speaker seq |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  const grouped = new Map();
  for (const row of results) {
    const key = `${row.provider}:${row.returnedModel || row.requestedModel}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  for (const [key, rows] of grouped.entries()) {
    const expectedRows = rows.filter((row) => row.score.hasExpected);
    const passed = expectedRows.filter((row) => row.score.passed).length;
    const valid = rows.filter((row) => row.score.validSpeakers).length;
    const textKept = rows.filter((row) => row.score.exactText).length;
    const speakerSeq = expectedRows.filter((row) => row.score.exactSpeakerSequence).length;
    const avgMs = Math.round(rows.reduce((sum, row) => sum + row.elapsedMs, 0) / rows.length);
    lines.push(`| ${key} | ${passed}/${expectedRows.length || 0} | ${avgMs} | ${valid}/${rows.length} | ${textKept}/${rows.length} | ${speakerSeq}/${expectedRows.length || 0} |`);
  }
  lines.push("");
  for (const row of results) {
    lines.push(`## ${row.sampleId} - ${row.provider}:${row.returnedModel || row.requestedModel}`);
    lines.push("");
    lines.push(`Input: ${row.chunkText}`);
    if (row.expected?.length) {
      lines.push(`Expected: ${row.expected.map((segment) => `${segment.speaker}: ${segment.text}`).join(" | ")}`);
    }
    lines.push(`Predicted: ${row.segments.map((segment) => `${segment.speaker} ${Math.round(segment.confidence * 100)}%: ${segment.text}`).join(" | ")}`);
    lines.push(`Score: ${JSON.stringify(row.score)}`);
    lines.push("");
  }
  for (const alignment of scriptAlignments) {
    lines.push(`## Script Alignment - ${alignment.model}`);
    lines.push("");
    for (const match of alignment.matches) {
      const status = match.passed ? "PASS" : match.matched ? "TEXT_ONLY" : "MISS";
      lines.push(`- ${status} ${match.expectedId}: expected ${match.expectedSpeaker} "${match.expectedText}" -> predicted ${match.predictedSpeaker} "${match.predictedText}" (${match.textSimilarity})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    console.log(`Usage:
  node scripts/eval-speaker-label-models.js [options]

Options:
  --models provider:model,...  Default: ${DEFAULT_MODELS.join(",")}
  --source FILE               Load chunks from transcripts.ndjson
  --latest                    Load newest runtime/ex-live-monitor-oneoff/*/transcripts.ndjson
  --script FILE               Use exact spoken test script as ground truth
  --script-mode MODE          turns, pairs, or triples when evaluating the script directly. Default turns
  --write-default-script DIR  Write default script JSON + readable Markdown, then exit
  --text TEXT                 Evaluate one ad hoc chunk
  --limit N                   Max samples, default 8
  --timeout-ms N              Per-model timeout, default 12000
  --out-dir DIR               Default runtime/speaker-label-model-eval
`);
    return;
  }

  const models = parseModels(readFlag(argv, "--models", DEFAULT_MODELS.join(",")));
  const source = readFlag(argv, "--source", "");
  const text = readFlag(argv, "--text", "");
  const useLatest = hasFlag(argv, "--latest");
  const scriptPath = readFlag(argv, "--script", "");
  const scriptMode = readFlag(argv, "--script-mode", "turns");
  const writeDefaultScriptDir = readFlag(argv, "--write-default-script", "");
  const limit = Math.max(1, Math.min(50, Number(readFlag(argv, "--limit", "8")) || 8));
  const timeoutMs = Math.max(1000, Number(readFlag(argv, "--timeout-ms", "12000")) || 12000);
  const outDir = path.resolve(readFlag(argv, "--out-dir", path.join("runtime", "speaker-label-model-eval")));
  if (writeDefaultScriptDir) {
    const targetDir = path.resolve(writeDefaultScriptDir);
    ensureDir(targetDir);
    const jsonPath = path.join(targetDir, "speaker-label-call-script.json");
    const mdPath = path.join(targetDir, "speaker-label-call-script.md");
    fs.writeFileSync(jsonPath, JSON.stringify({ turns: DEFAULT_SCRIPT_TURNS }, null, 2));
    fs.writeFileSync(mdPath, renderScriptMarkdown(DEFAULT_SCRIPT_TURNS));
    console.log(`[speaker-eval] wrote ${jsonPath}`);
    console.log(`[speaker-eval] wrote ${mdPath}`);
    return;
  }
  const scriptTurns = scriptPath ? loadScriptTurns(scriptPath) : [];
  const metadata = {
    callFlow: readFlag(argv, "--call-flow", "outbound"),
    initialHumanSpeaker: readFlag(argv, "--initial-human-speaker", "prospect"),
    agentCompany: "Tax Advocate Group / Wynn Tax Solutions",
    note: "Live RingEX/CX supervision transcript label test.",
  };
  const samples = loadSamples({ source, text, useLatest, scriptTurns, scriptMode, limit });
  if (!samples.length) throw new Error("No samples found");

  console.log(`[speaker-eval] samples=${samples.length} models=${models.map((m) => `${m.provider}:${m.model}`).join(", ")}`);
  ensureDir(outDir);

  const results = [];
  for (const sample of samples) {
    for (const spec of models) {
      const label = `${spec.provider}:${spec.model}`;
      process.stdout.write(`[speaker-eval] ${sample.id} -> ${label} ... `);
      try {
        const prediction = await callModel({ spec, sample, metadata, timeoutMs });
        const score = scorePrediction(sample, prediction.segments);
        const row = {
          sampleId: sample.id,
          chunkText: sample.chunkText,
          expected: sample.expected || [],
          sourceSpeakerSegments: sample.sourceSpeakerSegments || [],
          score,
          ...prediction,
        };
        results.push(row);
        console.log(`${prediction.elapsedMs}ms ${score.passed === null ? "" : score.passed ? "PASS" : "FAIL"}`);
      } catch (error) {
        results.push({
          sampleId: sample.id,
          chunkText: sample.chunkText,
          expected: sample.expected || [],
          provider: spec.provider,
          requestedModel: spec.model,
          error: error.message,
          elapsedMs: null,
          segments: [],
          score: {
            hasExpected: Array.isArray(sample.expected) && sample.expected.length > 0,
            passed: false,
            validSpeakers: false,
            exactText: false,
          },
        });
        console.log(`ERROR ${error.message}`);
      }
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputJsonPath = path.join(outDir, `speaker-label-eval-${stamp}.json`);
  const outputMdPath = path.join(outDir, `speaker-label-eval-${stamp}.md`);
  const scriptAlignments = scriptTurns.length && (source || useLatest)
    ? buildScriptAlignment(results, scriptTurns)
    : [];
  fs.writeFileSync(outputJsonPath, JSON.stringify({ metadata, models, samples, scriptTurns, scriptAlignments, results }, null, 2));
  fs.writeFileSync(outputMdPath, renderMarkdown(results, outputJsonPath, scriptAlignments));
  console.log(`[speaker-eval] wrote ${outputJsonPath}`);
  console.log(`[speaker-eval] wrote ${outputMdPath}`);
}

main().catch((error) => {
  console.error(`[speaker-eval] fatal: ${error.message}`);
  process.exit(1);
});
