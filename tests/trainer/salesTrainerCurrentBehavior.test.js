"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const trainer = require("../../packages/shared-services/src/taxResolutionSalesTrainerService");
const {
  KIND_TRAINING,
  appendTrainingSessionEntry,
  sessionManifestPathFor,
} = require("../../packages/shared-services/src/recordingStorageService");

function fixtureProfile() {
  return {
    callerFirstName: "Casey",
    callerLastName: "Fixture",
    age: 42,
    sex: "female",
    mood: "skeptical",
    voiceHints: {
      accent: "neutral fixture accent",
      energy: "measured",
      tone: "guarded",
    },
  };
}

test("Free Call direction remains pinned in the server-owned session header", () => {
  const inbound = trainer.buildSessionHeader({
    mode: "inbound",
    scenario: "test-only fixture",
    profile: fixtureProfile(),
  });
  const outbound = trainer.buildSessionHeader({
    mode: "outbound",
    scenario: "test-only fixture",
    profile: fixtureProfile(),
  });

  assert.match(inbound, /Locked mode: inbound/);
  assert.match(outbound, /Locked mode: outbound/);
  assert.notEqual(inbound, outbound);
});

test("Free Call turn input keeps one server header followed by the conversation", () => {
  const input = trainer.buildInput({
    mode: "outbound",
    scenario: "test-only fixture",
    profile: fixtureProfile(),
    messages: [
      { role: "user", content: "Hello, this is the trainee." },
      { role: "assistant", content: "What is this about?" },
    ],
  });

  assert.equal(input[0].role, "developer");
  assert.match(input[0].content, /Locked mode: outbound/);
  assert.deepEqual(
    input.slice(1).map(({ role, content }) => ({ role, content })),
    [
      { role: "user", content: "Hello, this is the trainee." },
      { role: "assistant", content: "What is this about?" },
    ],
  );
});

test("voice selection and the normalized voice lock are deterministic", () => {
  const picked = trainer.pickTtsVoiceForProfile(fixtureProfile());
  const first = trainer.normalizeTtsProfile({
    voiceProfile: { ...picked, responseFormat: "mp3", speed: 1.1 },
  });
  const duplicate = trainer.normalizeTtsProfile({
    voiceProfile: { ...picked, responseFormat: "mp3", speed: 1.1 },
  });
  const second = trainer.normalizeTtsProfile({
    voiceProfile: { ...picked, responseFormat: "mp3", speed: 1.1 },
    voice: "onyx",
    speed: 2,
  });

  assert.equal(first.locked, true);
  assert.equal(second.locked, true);
  assert.equal(second.voice, first.voice, "the supplied voiceProfile owns the lock");
  assert.equal(second.speed, 2, "per-turn playback speed remains an explicit override");
  assert.equal(duplicate.profileId, first.profileId, "the same lock hashes identically");
  assert.notEqual(second.profileId, first.profileId, "an explicit speed change creates a new lock");
});

test("two-station Coach state is versioned and supports unchanged polling", () => {
  const sessionId = `phase0-coach-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const first = trainer.publishSalesTrainerUiState(
    sessionId,
    {
      source: "two-station-observer",
      coach: {
        phase: { key: "discovery", label: "Discovery" },
        confidence: 0.75,
        oneSentenceFocus: "Ask one grounded question.",
        tips: ["Listen before advancing."],
      },
    },
    { email: "internal-fixture", source: "internal" },
  );

  assert.equal(first.version, 1);
  assert.equal(first.source, "two-station-observer");
  assert.equal(first.coach.phase.key, "discovery");
  assert.equal(trainer.getSalesTrainerUiState(sessionId, { sinceVersion: 1 }), null);

  const second = trainer.publishSalesTrainerUiState(
    sessionId,
    {
      source: "two-station-observer",
      coach: {
        phase: { key: "presentation", label: "Presentation" },
        confidence: 0.8,
      },
    },
    { email: "internal-fixture", source: "internal" },
  );
  assert.equal(second.version, 2);
  assert.equal(trainer.getSalesTrainerUiState(sessionId, { sinceVersion: 1 }).version, 2);
});

test("scorecard extraction remains fail-closed for malformed model payloads", () => {
  assert.equal(trainer.extractScorecardPayload("ordinary prospect dialogue"), null);
  assert.equal(
    trainer.extractScorecardPayload("<UI_SCORECARD>{broken}</UI_SCORECARD>"),
    null,
  );
  assert.deepEqual(
    trainer.extractScorecardPayload(
      '<UI_SCORECARD>{"assessment":{"overall_score":82}}</UI_SCORECARD>',
    ),
    { assessment: { overall_score: 82 } },
  );
});

test("training recording manifest appends turns without replacing prior evidence", async (t) => {
  const priorRoot = process.env.PARALLEL_RECORDINGS_ROOT;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trainer-phase0-"));
  process.env.PARALLEL_RECORDINGS_ROOT = root;
  t.after(async () => {
    if (priorRoot == null) delete process.env.PARALLEL_RECORDINGS_ROOT;
    else process.env.PARALLEL_RECORDINGS_ROOT = priorRoot;
    await fs.rm(root, { recursive: true, force: true });
  });

  const sessionId = "test-only-session";
  await appendTrainingSessionEntry({
    sessionId,
    date: "2026-07-28",
    entry: { turnNumber: 1, repLocalPath: "fixture-rep-1" },
  });
  const manifest = await appendTrainingSessionEntry({
    sessionId,
    date: "2026-07-28",
    entry: { turnNumber: 2, prospectLocalPath: "fixture-prospect-2" },
  });

  assert.deepEqual(
    manifest.entries.map((entry) => entry.turnNumber),
    [1, 2],
  );
  const stored = JSON.parse(
    await fs.readFile(
      sessionManifestPathFor({
        kind: KIND_TRAINING,
        sessionId,
        date: "2026-07-28",
      }),
      "utf8",
    ),
  );
  assert.equal(stored.kind, KIND_TRAINING);
  assert.equal(stored.entries.length, 2);
});
