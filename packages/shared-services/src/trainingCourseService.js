"use strict";

const { randomUUID } = require("crypto");
const {
  trainingCourseRepository: defaultRepository,
} = require("../../shared-repositories/src");
const publishedTrainingContent = require("./trainer-content/publishedTrainingContent.v1");
const {
  validatePublishedTrainingContent,
} = require("./trainer-content/validatePublishedTrainingContent");
const {
  getSalesTrainerFeatureFlags,
} = require("./salesTrainerFeatureFlags");

const ITEM_STATUSES = new Set([
  "locked",
  "available",
  "in_progress",
  "completed",
]);
const SAFE_ITEM_TYPES = new Set([
  "lesson",
  "quiz",
  "say-it",
  "gauntlet",
  "free-call",
  "reflection",
]);
const ACTIVE_COURSE_ITEM_TYPES = new Set(["lesson", "quiz", "say-it"]);

class TrainingCourseError extends Error {
  constructor(status, code, message = "Training course request failed") {
    super(message);
    this.name = "TrainingCourseError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

function trainingCourseError(status, code) {
  return new TrainingCourseError(status, code);
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email || email.length > 320 || !email.includes("@")) {
    throw trainingCourseError(401, "TRAINER_COURSE_AUTH_REQUIRED");
  }
  return email;
}

function normalizeCompany(value) {
  const company = String(value || "").trim().toUpperCase();
  if (!company || company.length > 80 || !/^[A-Z0-9_-]+$/.test(company)) {
    throw trainingCourseError(403, "TRAINER_COURSE_COMPANY_UNAVAILABLE");
  }
  return company;
}

function normalizeId(value, code = "TRAINER_COURSE_INPUT_INVALID") {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(id)) {
    throw trainingCourseError(422, code);
  }
  return id;
}

function normalizeExpectedVersion(value) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw trainingCourseError(422, "TRAINER_COURSE_INPUT_INVALID");
  }
  return version;
}

function normalizeSafeText(value, maxLength = 8_000) {
  const text = String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim();
  if (!text || text.length > maxLength) {
    throw trainingCourseError(422, "TRAINER_COURSE_INPUT_INVALID");
  }
  return text;
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function iso(value) {
  return asDate(value)?.toISOString() || null;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function toPlainMastery(value) {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value.entries());
  return clone(value);
}

function normalizePrincipal(input = {}) {
  return Object.freeze({
    learnerEmailNormalized: normalizeEmail(input.email),
    companySnapshot: normalizeCompany(input.company),
  });
}

function contentBundles(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.values()];
  if (value && Array.isArray(value.bundles)) return value.bundles;
  if (value && typeof value === "object") return [value];
  return [];
}

function manifestOf(bundle) {
  return bundle?.courseManifest && typeof bundle.courseManifest === "object"
    ? bundle.courseManifest
    : null;
}

function rulePackOf(bundle) {
  return bundle?.ruleRegistry && typeof bundle.ruleRegistry === "object"
    ? bundle.ruleRegistry
    : null;
}

function courseMatchesAlias(manifest, alias) {
  if (!alias) return true;
  const normalized = String(alias).trim().toLowerCase();
  return (
    String(manifest?.id || "").trim().toLowerCase() === normalized ||
    (Array.isArray(manifest?.aliases) &&
      manifest.aliases.some(
        (candidate) =>
          String(candidate || "").trim().toLowerCase() === normalized,
      ))
  );
}

function companyAllowed(manifest, company) {
  const explicit = Array.isArray(manifest?.allowedCompanies)
    ? manifest.allowedCompanies
    : [];
  if (
    explicit.some(
      (candidate) =>
        String(candidate || "").trim().toUpperCase() === company,
    )
  ) {
    return true;
  }
  return (Array.isArray(manifest?.overlays) ? manifest.overlays : []).some(
    (overlay) =>
      overlay?.status === "published" &&
      !overlay?.scope?.direction &&
      String(overlay?.scope?.company || "").trim().toUpperCase() === company,
  );
}

function publishedBundle(bundle, { allowTestContent, company }) {
  const manifest = manifestOf(bundle);
  const rulePack = rulePackOf(bundle);
  if (
    bundle?.status !== "published" ||
    manifest?.status !== "published" ||
    rulePack?.status !== "published" ||
    !Array.isArray(manifest.items) ||
    manifest.items.length === 0
  ) {
    return false;
  }
  if (bundle.testOnly === true && allowTestContent !== true) return false;
  validatePublishedTrainingContent(bundle, { allowTestContent });
  return companyAllowed(manifest, company);
}

function itemMap(bundle) {
  return new Map(
    (manifestOf(bundle)?.items || []).map((item) => [item.id, item]),
  );
}

function applyCompanyOverlay(item, manifest, company) {
  let result = item;
  const overlays = Array.isArray(manifest?.overlays)
    ? manifest.overlays
    : [];
  for (const overlay of overlays) {
    if (
      overlay?.status !== "published" ||
      String(overlay?.scope?.company || "").trim().toUpperCase() !== company ||
      overlay?.scope?.direction
    ) {
      continue;
    }
    const override = (overlay.itemOverrides || []).find(
      (candidate) => candidate?.itemId === item.id,
    );
    if (override) {
      result = {
        ...result,
        ...override,
        id: item.id,
        version: override.version || item.version,
      };
    }
  }
  return result;
}

function runtimeItemAvailable(item, flags = {}) {
  if (ACTIVE_COURSE_ITEM_TYPES.has(item?.type)) return true;
  if (item?.type === "gauntlet") return flags.gauntletV1Enabled === true;
  return false;
}

function initialItemStates(bundle, company, now, flags) {
  const manifest = manifestOf(bundle);
  return manifest.items.map((sourceItem) => {
    const item = applyCompanyOverlay(sourceItem, manifest, company);
    const prerequisites = Array.isArray(item.prerequisiteItemIds)
      ? item.prerequisiteItemIds
      : [];
    const featureLocked = !runtimeItemAvailable(item, flags);
    return {
      itemId: item.id,
      itemVersion: item.version,
      itemType: item.type,
      required: item.required !== false,
      status:
        prerequisites.length === 0 && !featureLocked
          ? "available"
          : "locked",
      attemptId: null,
      completionOutcome: null,
      completedAt: null,
      updatedAt: now,
    };
  });
}

function recomputeAvailability(enrollment, bundle, flags, now) {
  const manifest = manifestOf(bundle);
  const states = (enrollment.itemStates || []).map((state) => ({ ...state }));
  const byId = new Map(states.map((state) => [state.itemId, state]));

  for (const sourceItem of manifest.items) {
    const item = applyCompanyOverlay(
      sourceItem,
      manifest,
      enrollment.companySnapshot,
    );
    let state = byId.get(item.id);
    if (!state) {
      state = {
        itemId: item.id,
        itemVersion: item.version,
        itemType: item.type,
        required: item.required !== false,
        status: "locked",
        attemptId: null,
        completionOutcome: null,
        completedAt: null,
        updatedAt: now,
      };
      states.push(state);
      byId.set(item.id, state);
    }
    if (!runtimeItemAvailable(item, flags)) {
      if (state.status !== "completed" && state.status !== "locked") {
        state.status = "locked";
        state.updatedAt = now;
      }
      continue;
    }
    if (state.status === "completed" || state.status === "in_progress") {
      continue;
    }
    const prerequisites = Array.isArray(item.prerequisiteItemIds)
      ? item.prerequisiteItemIds
      : [];
    const prerequisitesComplete = prerequisites.every(
      (itemId) => byId.get(itemId)?.status === "completed",
    );
    const featureAvailable = runtimeItemAvailable(item, flags);
    const nextStatus =
      prerequisitesComplete && featureAvailable ? "available" : "locked";
    if (state.status !== nextStatus) {
      state.status = nextStatus;
      state.updatedAt = now;
    }
  }
  return states;
}

function selectResumeItemId(enrollment, bundle, flags, now) {
  const states = recomputeAvailability(enrollment, bundle, flags, now);
  const byId = new Map(states.map((state) => [state.itemId, state]));
  const manifestItems = manifestOf(bundle).items;
  const activeRemediation = (enrollment.activeRemediation || []).find(
    (entry) =>
      entry?.status === "active" &&
      ["available", "in_progress"].includes(byId.get(entry.itemId)?.status),
  );
  if (activeRemediation) return activeRemediation.itemId;

  const inProgress = manifestItems.find((item) => {
    const state = byId.get(item.id);
    return state?.required !== false && state?.status === "in_progress";
  });
  if (inProgress) return inProgress.id;

  const required = manifestItems.find((item) => {
    const state = byId.get(item.id);
    return state?.required !== false && state?.status === "available";
  });
  if (required) return required.id;

  return (
    manifestItems.find((item) => {
      const state = byId.get(item.id);
      return state?.required === false && state?.status === "available";
    })?.id || null
  );
}

function publicRemediation(remediation) {
  return {
    remediationId: String(remediation?.remediationId || ""),
    ruleId: String(remediation?.ruleId || ""),
    itemId: String(remediation?.itemId || ""),
    reasonCode: String(remediation?.reasonCode || ""),
    status: remediation?.status === "completed" ? "completed" : "active",
    assignedAt: iso(remediation?.assignedAt),
    completedAt: iso(remediation?.completedAt),
  };
}

function publicEnrollment(enrollment, bundle, flags) {
  if (!enrollment) return null;
  const manifest = manifestOf(bundle);
  const states = recomputeAvailability(
    enrollment,
    bundle,
    flags,
    new Date(enrollment.updatedAt || Date.now()),
  );
  const stateById = new Map(states.map((state) => [state.itemId, state]));
  const items = manifest.items.map((sourceItem) => {
    const item = applyCompanyOverlay(
      sourceItem,
      manifest,
      enrollment.companySnapshot,
    );
    const state = stateById.get(item.id);
    return {
      itemId: item.id,
      itemVersion: state?.itemVersion || item.version,
      type: item.type,
      title: String(item.presentation?.title || item.title || item.id),
      required: state?.required !== false,
      status: ITEM_STATUSES.has(state?.status) ? state.status : "locked",
      completionOutcome:
        state?.status === "completed" && ["passed", "failed"].includes(state?.completionOutcome)
          ? state.completionOutcome
          : null,
    };
  });
  const requiredItems = items.filter((item) => item.required);
  return {
    enrollmentId: enrollment.enrollmentId,
    status: enrollment.status,
    courseId: enrollment.courseId,
    courseVersion: enrollment.courseVersion,
    rulePackVersion: enrollment.rulePackVersion,
    resumeItemId: enrollment.resumeItemId || null,
    version: Number(enrollment.version) || 0,
    progress: {
      completed: items.filter((item) => item.status === "completed").length,
      total: items.length,
      requiredCompleted: requiredItems.filter(
        (item) => item.status === "completed",
      ).length,
      requiredTotal: requiredItems.length,
    },
    activeRemediation: (enrollment.activeRemediation || [])
      .filter((entry) => entry?.status === "active")
      .map(publicRemediation),
    items,
  };
}

function publicCourse(bundle) {
  const manifest = manifestOf(bundle);
  return {
    courseId: manifest.id,
    courseVersion: manifest.version,
    title: String(manifest.title || manifest.id),
    status: manifest.status,
  };
}

function publicItem(item, state) {
  const presentation =
    item?.presentation && typeof item.presentation === "object"
      ? item.presentation
      : {};
  const choices = Array.isArray(presentation.choices)
    ? presentation.choices.map((choice) => ({
        choiceId: String(choice?.choiceId || choice?.id || ""),
        label: String(choice?.label || ""),
      }))
    : [];
  const sourceGuide =
    presentation.coachingGuide && typeof presentation.coachingGuide === "object"
      ? presentation.coachingGuide
      : null;
  const coachingGuide = sourceGuide
    ? {
        objective: String(sourceGuide.objective || "").slice(0, 4_000),
        exactMoves: (Array.isArray(sourceGuide.exactMoves) ? sourceGuide.exactMoves : [])
          .slice(0, 50)
          .map((move) => ({
            beatId: String(move?.beatId || "").slice(0, 200),
            label: String(move?.label || "").slice(0, 500),
            language: String(move?.language || "").slice(0, 2_000),
          })),
        responseSignals: (Array.isArray(sourceGuide.responseSignals)
          ? sourceGuide.responseSignals
          : [])
          .slice(0, 50)
          .map((signal) => ({
            signalId: String(signal?.signalId || "").slice(0, 200),
            prospectPattern: String(signal?.prospectPattern || "").slice(0, 1_000),
            coachNotice: String(signal?.coachNotice || "").slice(0, 2_000),
            suggestedMove: String(signal?.suggestedMove || "").slice(0, 2_000),
            listenFor: String(signal?.listenFor || "").slice(0, 1_000),
          })),
        practiceModules: (Array.isArray(sourceGuide.practiceModules)
          ? sourceGuide.practiceModules
          : [])
          .slice(0, 100)
          .map((moduleDef) => ({
            moduleId: String(moduleDef?.moduleId || "").slice(0, 200),
            title: String(moduleDef?.title || "").slice(0, 500),
            objective: String(moduleDef?.objective || "").slice(0, 2_000),
            reading: String(moduleDef?.reading || "").slice(0, 20_000),
            questionCount: Math.max(0, Math.min(100, Number(moduleDef?.questionCount) || 0)),
          })),
      }
    : null;
  return {
    itemId: item.id,
    itemVersion: item.version,
    type: SAFE_ITEM_TYPES.has(item.type) ? item.type : "lesson",
    title: String(presentation.title || item.title || item.id),
    required: state?.required !== false,
    status: state?.status || "locked",
    completionOutcome:
      state?.status === "completed" && ["passed", "failed"].includes(state?.completionOutcome)
        ? state.completionOutcome
        : null,
    completedAttemptId:
      state?.status === "completed" ? state.attemptId || null : null,
    content: {
      summary: presentation.summary
        ? String(presentation.summary).slice(0, 4_000)
        : null,
      body: presentation.body
        ? String(presentation.body).slice(0, 40_000)
        : null,
      instructions: presentation.instructions
        ? String(presentation.instructions).slice(0, 8_000)
        : null,
      prompt: presentation.prompt
        ? String(presentation.prompt).slice(0, 8_000)
        : null,
      choices,
      estimatedMinutes: Number.isFinite(Number(presentation.estimatedMinutes))
        ? Math.max(0, Math.min(480, Number(presentation.estimatedMinutes)))
        : null,
      coachingGuide,
    },
  };
}

function publicAttemptIdentity(attempt) {
  const terminal = Boolean(attempt?.terminalSummary);
  return {
    attemptId: attempt.attemptId,
    enrollmentId: attempt.enrollmentId,
    courseId: attempt.courseId,
    courseVersion: attempt.courseVersion,
    itemId: attempt.itemId,
    itemVersion: attempt.itemVersion,
    itemType: attempt.itemType,
    version: Number(attempt.version) || 0,
    status: terminal ? "completed" : "in_progress",
    createdAt: iso(attempt.createdAt),
  };
}

function publicEvent(event) {
  const payload = event?.payload || {};
  if (event?.type === "answer_submitted") {
    return {
      eventId: event.eventId,
      sequence: event.sequence,
      type: event.type,
      occurredAt: iso(event.occurredAt),
      payload: {
        answer: String(payload.answer || "").slice(0, 8_000),
        grade: clone(payload.grade || null),
      },
    };
  }
  if (event?.type === "reflection_added") {
    return {
      eventId: event.eventId,
      sequence: event.sequence,
      type: event.type,
      occurredAt: iso(event.occurredAt),
      payload: {
        reflection: String(payload.reflection || "").slice(0, 8_000),
      },
    };
  }
  if (event?.type === "gauntlet_module_answer_graded") {
    return {
      eventId: event.eventId,
      sequence: event.sequence,
      type: event.type,
      occurredAt: iso(event.occurredAt),
      payload: {
        runNumber: Number(payload.runNumber) || 0,
        questionIndex: Number(payload.questionIndex) || 0,
        questionCount: Number(payload.questionCount) || 0,
        answer: String(payload.answer || "").slice(0, 8_000),
        grade: clone(payload.grade || null),
      },
    };
  }
  return {
    eventId: event.eventId,
    sequence: event.sequence,
    type: event.type,
    occurredAt: iso(event.occurredAt),
    payload: clone(payload),
  };
}

function gradeAnswer(item, answer) {
  const assessment =
    item?.assessment && typeof item.assessment === "object"
      ? item.assessment
      : null;
  if (!assessment || !assessment.version) {
    throw trainingCourseError(422, "TRAINER_COURSE_ITEM_NOT_ASSESSABLE");
  }
  const usesChoiceIds =
    Array.isArray(item?.presentation?.choices) &&
    item.presentation.choices.length > 0;
  const normalizeAnswer = usesChoiceIds
    ? (value) => value.trim()
    : (value) => value.trim().replace(/\s+/g, " ").toLowerCase();
  const normalized = normalizeAnswer(answer);
  const accepted = [
    assessment.canonicalAnswer,
    ...(Array.isArray(assessment.acceptedAnswers)
      ? assessment.acceptedAnswers
      : []),
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .map(normalizeAnswer);
  const passed = accepted.includes(normalized);
  return Object.freeze({
    passed,
    score: passed ? 1 : 0,
    evidence: [passed ? "canonical_match" : "retry_required"],
    gradingVersion: String(assessment.version),
  });
}

function ensurePinnedEnrollmentCurriculum(enrollment, bundle) {
  const manifest = manifestOf(bundle);
  const expectedStates = enrollment?.itemStates || [];
  const publishedItems = (manifest?.items || []).map((sourceItem) =>
    applyCompanyOverlay(
      sourceItem,
      manifest,
      enrollment.companySnapshot,
    ),
  );
  const stateById = new Map(
    expectedStates.map((state) => [state.itemId, state]),
  );
  const curriculumMatches =
    publishedItems.length === expectedStates.length &&
    publishedItems.every((item) => {
      const state = stateById.get(item.id);
      return (
        state &&
        state.itemVersion === item.version &&
        state.itemType === item.type
      );
    });
  if (
    !curriculumMatches ||
    rulePackOf(bundle)?.version !== enrollment.rulePackVersion
  ) {
    throw trainingCourseError(503, "TRAINER_COURSE_PINNED_CONTENT_MISSING");
  }
  return bundle;
}
function ensurePinnedItem({
  item,
  bundle,
  expectedItemVersion,
  expectedItemType,
  expectedRulePackVersion,
}) {
  if (
    !item ||
    item.version !== expectedItemVersion ||
    item.type !== expectedItemType ||
    rulePackOf(bundle)?.version !== expectedRulePackVersion
  ) {
    throw trainingCourseError(503, "TRAINER_COURSE_PINNED_CONTENT_MISSING");
  }
  return item;
}
function eventById(attempt, eventId) {
  return (attempt?.events || []).find((event) => event?.eventId === eventId);
}

function latestAnswerEvent(attempt) {
  return [...(attempt?.events || [])]
    .reverse()
    .find((event) => event?.type === "answer_submitted");
}

function gauntletQuestions(bundle, attempt) {
  const scenario = (bundle?.scenarioBlueprints || []).find(
    (candidate) =>
      candidate?.id === attempt?.blueprintId &&
      candidate?.version === attempt?.blueprintVersion,
  );
  return Array.isArray(scenario?.presentation?.questions)
    ? scenario.presentation.questions.filter((question) => question?.prompt)
    : [];
}

function gauntletKnowledgeCheckComplete(attempt, questionCount) {
  if (questionCount === 0) return true;
  const runNumber = Number(attempt?.gauntletState?.runNumber) || 0;
  const latestByQuestion = new Map();
  for (const event of attempt?.events || []) {
    if (
      event?.type !== "gauntlet_module_answer_graded" ||
      Number(event?.payload?.runNumber) !== runNumber
    ) {
      continue;
    }
    const questionIndex = Number(event?.payload?.questionIndex);
    if (Number.isInteger(questionIndex)) {
      latestByQuestion.set(questionIndex, event);
    }
  }
  return Array.from({ length: questionCount }, (_, questionIndex) => questionIndex)
    .every((questionIndex) => latestByQuestion.get(questionIndex)?.payload?.grade?.passed === true);
}

function ensureOwnedEnrollment(enrollment, principal) {
  if (!enrollment) {
    throw trainingCourseError(404, "TRAINER_COURSE_NOT_FOUND");
  }
  if (
    enrollment.learnerEmailNormalized !== principal.learnerEmailNormalized ||
    enrollment.companySnapshot !== principal.companySnapshot
  ) {
    throw trainingCourseError(403, "TRAINER_COURSE_FORBIDDEN");
  }
  return enrollment;
}

function ensureOwnedAttempt(attempt, principal) {
  if (!attempt) {
    throw trainingCourseError(404, "TRAINER_COURSE_NOT_FOUND");
  }
  if (
    attempt.learnerEmailNormalized !== principal.learnerEmailNormalized ||
    attempt.companySnapshot !== principal.companySnapshot
  ) {
    throw trainingCourseError(403, "TRAINER_COURSE_FORBIDDEN");
  }
  return attempt;
}

function createTrainingCourseService(options = {}) {
  const repository = options.repository || defaultRepository;
  const contentProvider =
    options.contentProvider || (() => publishedTrainingContent);
  const flagsProvider =
    options.flagsProvider || (() => getSalesTrainerFeatureFlags());
  const allowTestContent = options.allowTestContent === true;
  const idFactory = options.idFactory || (() => randomUUID());
  const clock = options.now || (() => new Date());

  function flags() {
    const value = flagsProvider() || {};
    return {
      courseV1Enabled: value.courseV1Enabled === true,
      gauntletV1Enabled: value.gauntletV1Enabled === true,
      callReviewV1Enabled: value.callReviewV1Enabled === true,
    };
  }

  function requireFeature() {
    const resolved = flags();
    if (!resolved.courseV1Enabled) {
      throw trainingCourseError(503, "TRAINER_COURSE_DISABLED");
    }
    return resolved;
  }

  function resolveBundle({
    principal,
    alias = null,
    courseId = null,
    courseVersion = null,
  }) {
    const raw = contentProvider({
      alias,
      courseId,
      courseVersion,
      company: principal.companySnapshot,
    });
    const bundles = contentBundles(raw);
    const candidates = bundles.filter((bundle) => {
      const manifest = manifestOf(bundle);
      if (
        courseId &&
        String(manifest?.id || "") !== String(courseId)
      ) {
        return false;
      }
      if (
        courseVersion &&
        String(manifest?.version || "") !== String(courseVersion)
      ) {
        return false;
      }
      return (
        courseMatchesAlias(manifest, alias) &&
        bundle?.status === "published" &&
        (bundle.testOnly !== true || allowTestContent === true)
      );
    });
    let selected;
    if (courseVersion) {
      if (candidates.length !== 1) {
        throw trainingCourseError(503, "TRAINER_COURSE_UNAVAILABLE");
      }
      [selected] = candidates;
    } else {
      const enrollmentDefaults = candidates.filter(
        (bundle) => bundle?.enrollmentDefault === true,
      );
      if (enrollmentDefaults.length > 0) {
        if (enrollmentDefaults.length !== 1) {
          throw trainingCourseError(503, "TRAINER_COURSE_UNAVAILABLE");
        }
        [selected] = enrollmentDefaults;
      } else if (candidates.length === 1) {
        [selected] = candidates;
      } else {
        throw trainingCourseError(503, "TRAINER_COURSE_UNAVAILABLE");
      }
    }
    try {
      if (
        !publishedBundle(selected, {
          allowTestContent,
          company: principal.companySnapshot,
        })
      ) {
        throw new Error("Selected Trainer course is unavailable");
      }
    } catch {
      throw trainingCourseError(503, "TRAINER_COURSE_UNAVAILABLE");
    }
    return selected;
  }

  function bundleForEnrollment(enrollment, principal) {
    return ensurePinnedEnrollmentCurriculum(
      enrollment,
      resolveBundle({
        principal,
        courseId: enrollment.courseId,
        courseVersion: enrollment.courseVersion,
      }),
    );
  }

  async function updateEnrollmentWithRetry(
    enrollmentId,
    principal,
    mutate,
  ) {
    for (let tries = 0; tries < 6; tries += 1) {
      const current = ensureOwnedEnrollment(
        await repository.findEnrollmentById(enrollmentId),
        principal,
      );
      const set = mutate(clone(current));
      if (!set) return current;
      const updated = await repository.updateEnrollmentCas(
        enrollmentId,
        Number(current.version) || 0,
        set,
      );
      if (updated) return updated;
    }
    throw trainingCourseError(409, "TRAINER_COURSE_CONFLICT");
  }

  async function projectCompletedAttempt({
    attempt,
    enrollment,
    principal,
    bundle,
    resolvedFlags,
    occurredAt,
  }) {
    return updateEnrollmentWithRetry(
      enrollment.enrollmentId,
      principal,
      (current) => {
        const currentState = (current.itemStates || []).find(
          (state) => state.itemId === attempt.itemId,
        );
        const completionOutcome = ["passed", "failed"].includes(
          attempt.terminalSummary?.status,
        )
          ? attempt.terminalSummary.status
          : "passed";
        const alreadyApplied =
          currentState?.status === "completed" &&
          currentState?.attemptId === attempt.attemptId &&
          currentState?.completionOutcome === completionOutcome;
        if (alreadyApplied) return null;
        if (
          !["in_progress", "completed"].includes(currentState?.status) ||
          currentState?.attemptId !== attempt.attemptId
        ) {
          throw trainingCourseError(409, "TRAINER_COURSE_CONFLICT");
        }
        const itemStates = (current.itemStates || []).map((state) =>
          state.itemId === attempt.itemId
            ? {
                ...state,
                status: "completed",
                attemptId: attempt.attemptId,
                completionOutcome,
                completedAt: state.completedAt || occurredAt,
                updatedAt: occurredAt,
              }
            : state,
        );
        const dimension = ["lesson", "quiz"].includes(attempt.itemType)
          ? "knowledge"
          : attempt.itemType === "say-it"
            ? "guidedExecution"
            : null;
        const mastery = toPlainMastery(current.masteryByRule);
        if (dimension) {
          for (const ruleId of attempt.ruleIds || []) {
            mastery[ruleId] = {
              knowledge: 0,
              guidedExecution: 0,
              transfer: 0,
              realCallEvidence: 0,
              ...(mastery[ruleId] || {}),
              [dimension]: 1,
            };
          }
        }
        const activeRemediation = (current.activeRemediation || []).map(
          (entry) =>
            entry.itemId === attempt.itemId && entry.status === "active"
              ? {
                  ...entry,
                  status: "completed",
                  completedAt: occurredAt,
                }
              : entry,
        );
        const draft = {
          ...current,
          itemStates,
          masteryByRule: mastery,
          activeRemediation,
        };
        const availableStates = recomputeAvailability(
          draft,
          bundle,
          resolvedFlags,
          occurredAt,
        );
        const resumeItemId = selectResumeItemId(
          { ...draft, itemStates: availableStates },
          bundle,
          resolvedFlags,
          occurredAt,
        );
        const requiredComplete = availableStates
          .filter((state) => state.required !== false)
          .every((state) => state.status === "completed");
        return {
          status: requiredComplete ? "completed" : "active",
          itemStates: availableStates,
          masteryByRule: mastery,
          activeRemediation,
          resumeItemId,
        };
      },
    );
  }

  async function reconcileAcceptedAttemptProjections(
    enrollment,
    principal,
    bundle,
    resolvedFlags,
  ) {
    let current = enrollment;
    for (const state of current.itemStates || []) {
      if (!state.attemptId) continue;
      const attempt = ensureOwnedAttempt(
        await repository.findAttemptById(state.attemptId),
        principal,
      );
      const sourceItem = itemMap(bundle).get(state.itemId);
      const effectiveItem = ensurePinnedItem({
        item: sourceItem
          ? applyCompanyOverlay(
              sourceItem,
              manifestOf(bundle),
              principal.companySnapshot,
            )
          : null,
        bundle,
        expectedItemVersion: state.itemVersion,
        expectedItemType: state.itemType,
        expectedRulePackVersion: current.rulePackVersion,
      });
      const expectedRuleIds = [...(effectiveItem.ruleIds || [])].sort();
      const attemptRuleIds = [...(attempt.ruleIds || [])].sort();
      if (
        attempt.enrollmentId !== current.enrollmentId ||
        attempt.courseId !== current.courseId ||
        attempt.courseVersion !== current.courseVersion ||
        attempt.itemId !== state.itemId ||
        attempt.itemVersion !== state.itemVersion ||
        attempt.itemType !== state.itemType ||
        attempt.rulePackVersion !== current.rulePackVersion ||
        JSON.stringify(attemptRuleIds) !== JSON.stringify(expectedRuleIds)
      ) {
        throw trainingCourseError(503, "TRAINER_COURSE_PINNED_CONTENT_MISSING");
      }
      if (attempt.terminalSummary) {
        const completionEvent = [...(attempt.events || [])]
          .reverse()
          .find((event) => event?.type === "attempt_completed");
        if (!completionEvent) {
          throw trainingCourseError(
            503,
            "TRAINER_COURSE_PINNED_CONTENT_MISSING",
          );
        }
        current = await projectCompletedAttempt({
          attempt,
          enrollment: current,
          principal,
          bundle,
          resolvedFlags,
          occurredAt:
            asDate(completionEvent.occurredAt) ||
            asDate(attempt.terminalSummary.completedAt) ||
            clock(),
        });
        continue;
      }
      const answer = latestAnswerEvent(attempt);
      if (typeof answer?.payload?.grade?.passed === "boolean") {
        await reconcileAnswerRemediation(attempt, principal, answer);
        current = ensureOwnedEnrollment(
          await repository.findEnrollmentById(current.enrollmentId),
          principal,
        );
      }
    }
    return current;
  }
  async function refreshEnrollmentAvailability(
    enrollment,
    principal,
    bundle,
    resolvedFlags,
  ) {
    enrollment = await reconcileAcceptedAttemptProjections(
      enrollment,
      principal,
      bundle,
      resolvedFlags,
    );
    const reconciliationNow = clock();
    const nextItemStates = recomputeAvailability(
      enrollment,
      bundle,
      resolvedFlags,
      reconciliationNow,
    );
    const nextResumeItemId = selectResumeItemId(
      { ...enrollment, itemStates: nextItemStates },
      bundle,
      resolvedFlags,
      reconciliationNow,
    );
    const stateProjection = (states) =>
      (states || []).map((state) => ({
        itemId: state.itemId,
        itemVersion: state.itemVersion,
        itemType: state.itemType,
        required: state.required !== false,
        status: state.status,
        attemptId: state.attemptId || null,
      }));
    if (
      JSON.stringify(stateProjection(nextItemStates)) ===
        JSON.stringify(stateProjection(enrollment.itemStates)) &&
      nextResumeItemId === enrollment.resumeItemId
    ) {
      return enrollment;
    }
    return updateEnrollmentWithRetry(
      enrollment.enrollmentId,
      principal,
      (current) => {
        const now = clock();
        const currentItemStates = recomputeAvailability(
          current,
          bundle,
          resolvedFlags,
          now,
        );
        return {
          itemStates: currentItemStates,
          resumeItemId: selectResumeItemId(
            { ...current, itemStates: currentItemStates },
            bundle,
            resolvedFlags,
            now,
          ),
        };
      },
    );
  }

  async function getHome({ principal: principalInput, courseAlias = null }) {
    const resolvedFlags = requireFeature();
    const principal = normalizePrincipal(principalInput);
    const alias = courseAlias
      ? normalizeId(courseAlias, "TRAINER_COURSE_INPUT_INVALID")
      : null;
    let enrollment = await repository.findActiveEnrollment({
      learnerEmailNormalized: principal.learnerEmailNormalized,
    });
    let bundle;
    if (enrollment) {
      ensureOwnedEnrollment(enrollment, principal);
      bundle = bundleForEnrollment(enrollment, principal);
      enrollment = await reconcileAcceptedAttemptProjections(
        enrollment,
        principal,
        bundle,
        resolvedFlags,
      );
      if (alias && !courseMatchesAlias(manifestOf(bundle), alias)) {
        throw trainingCourseError(404, "TRAINER_COURSE_NOT_FOUND");
      }
      const reconciliationNow = clock();
      const reconciledItemStates = recomputeAvailability(
        enrollment,
        bundle,
        resolvedFlags,
        reconciliationNow,
      );
      const resumeItemId = selectResumeItemId(
        { ...enrollment, itemStates: reconciledItemStates },
        bundle,
        resolvedFlags,
        reconciliationNow,
      );
      const statusProjection = (states) =>
        (states || []).map((state) => ({
          itemId: state.itemId,
          status: state.status,
          attemptId: state.attemptId || null,
        }));
      const availabilityChanged =
        JSON.stringify(statusProjection(reconciledItemStates)) !==
        JSON.stringify(statusProjection(enrollment.itemStates));
      if (
        availabilityChanged ||
        resumeItemId !== enrollment.resumeItemId
      ) {
        enrollment = await updateEnrollmentWithRetry(
          enrollment.enrollmentId,
          principal,
          (current) => {
            const nextItemStates = recomputeAvailability(
              current,
              bundle,
              resolvedFlags,
              clock(),
            );
            return {
              itemStates: nextItemStates,
              resumeItemId: selectResumeItemId(
                { ...current, itemStates: nextItemStates },
                bundle,
                resolvedFlags,
                clock(),
              ),
            };
          },
        );
      }
    } else {
      bundle = resolveBundle({ principal, alias });
    }
    return {
      course: publicCourse(bundle),
      enrollment: publicEnrollment(enrollment, bundle, resolvedFlags),
      capabilities: resolvedFlags,
    };
  }

  async function enroll({
    principal: principalInput,
    courseAlias = null,
    requestId,
  }) {
    const resolvedFlags = requireFeature();
    const principal = normalizePrincipal(principalInput);
    const safeRequestId = normalizeId(
      requestId,
      "TRAINER_COURSE_INPUT_INVALID",
    );
    const alias = courseAlias
      ? normalizeId(courseAlias, "TRAINER_COURSE_INPUT_INVALID")
      : null;

    let active = await repository.findActiveEnrollment({
      learnerEmailNormalized: principal.learnerEmailNormalized,
    });
    let bundle;
    if (active) {
      ensureOwnedEnrollment(active, principal);
      if (active.requestId !== safeRequestId) {
        throw trainingCourseError(409, "TRAINER_COURSE_REQUEST_REUSED");
      }
      bundle = bundleForEnrollment(active, principal);
      if (alias && !courseMatchesAlias(manifestOf(bundle), alias)) {
        throw trainingCourseError(409, "TRAINER_COURSE_REQUEST_REUSED");
      }
    } else {
      bundle = resolveBundle({ principal, alias });
      const manifest = manifestOf(bundle);
      const now = clock();
      const itemStates = initialItemStates(
        bundle,
        principal.companySnapshot,
        now,
        resolvedFlags,
      );
      const draft = {
        enrollmentId: idFactory(),
        requestId: safeRequestId,
        ...principal,
        courseId: manifest.id,
        courseVersion: manifest.version,
        rulePackVersion: rulePackOf(bundle).version,
        status: "active",
        resumeItemId: null,
        itemStates,
        masteryByRule: {},
        activeRemediation: [],
        version: 0,
        createdAt: now,
        updatedAt: now,
      };
      draft.resumeItemId = selectResumeItemId(
        draft,
        bundle,
        resolvedFlags,
        now,
      );
      active = await repository.findOrCreateEnrollment({
        learnerEmailNormalized: principal.learnerEmailNormalized,
        courseId: manifest.id,
        courseVersion: manifest.version,
        create: draft,
      });
      ensureOwnedEnrollment(active, principal);
      if (
        active.requestId !== safeRequestId ||
        active.courseId !== manifest.id ||
        active.courseVersion !== manifest.version
      ) {
        throw trainingCourseError(409, "TRAINER_COURSE_REQUEST_REUSED");
      }
    }
    return {
      enrollment: publicEnrollment(active, bundle, resolvedFlags),
      resumeTarget: active.resumeItemId
        ? {
            courseId: active.courseId,
            itemId: active.resumeItemId,
          }
        : null,
    };
  }

  async function getItem({
    principal: principalInput,
    courseId,
    itemId,
  }) {
    const resolvedFlags = requireFeature();
    const principal = normalizePrincipal(principalInput);
    const safeCourseId = normalizeId(courseId);
    const safeItemId = normalizeId(itemId);
    let enrollment = ensureOwnedEnrollment(
      await repository.findActiveEnrollment({
        learnerEmailNormalized: principal.learnerEmailNormalized,
        courseId: safeCourseId,
      }),
      principal,
    );
    const bundle = bundleForEnrollment(enrollment, principal);
    enrollment = await refreshEnrollmentAvailability(
      enrollment,
      principal,
      bundle,
      resolvedFlags,
    );
    const state = (enrollment.itemStates || []).find(
      (candidate) => candidate.itemId === safeItemId,
    );
    if (!state || state.status === "locked") {
      throw trainingCourseError(404, "TRAINER_COURSE_NOT_FOUND");
    }
    const sourceItem = itemMap(bundle).get(safeItemId);
    if (!sourceItem) {
      throw trainingCourseError(404, "TRAINER_COURSE_NOT_FOUND");
    }
    const item = applyCompanyOverlay(
      sourceItem,
      manifestOf(bundle),
      principal.companySnapshot,
    );
    ensurePinnedItem({
      item,
      bundle,
      expectedItemVersion: state.itemVersion,
      expectedItemType: state.itemType,
      expectedRulePackVersion: enrollment.rulePackVersion,
    });
    if (!runtimeItemAvailable(item, resolvedFlags)) {
      throw trainingCourseError(404, "TRAINER_COURSE_NOT_FOUND");
    }
    return {
      item: publicItem(item, state),
      capabilities: resolvedFlags,
    };
  }

  async function startAttempt({
    principal: principalInput,
    itemId,
    requestId,
  }) {
    const resolvedFlags = requireFeature();
    const principal = normalizePrincipal(principalInput);
    const safeItemId = normalizeId(itemId);
    const safeRequestId = normalizeId(requestId);
    let enrollment = ensureOwnedEnrollment(
      await repository.findActiveEnrollment({
        learnerEmailNormalized: principal.learnerEmailNormalized,
      }),
      principal,
    );
    const bundle = bundleForEnrollment(enrollment, principal);
    enrollment = await refreshEnrollmentAvailability(
      enrollment,
      principal,
      bundle,
      resolvedFlags,
    );
    const state = (enrollment.itemStates || []).find(
      (candidate) => candidate.itemId === safeItemId,
    );
    if (!state || !["available", "in_progress"].includes(state.status)) {
      throw trainingCourseError(422, "TRAINER_COURSE_ITEM_UNAVAILABLE");
    }
    const sourceItem = itemMap(bundle).get(safeItemId);
    if (!sourceItem) {
      throw trainingCourseError(404, "TRAINER_COURSE_NOT_FOUND");
    }
    const item = applyCompanyOverlay(
      sourceItem,
      manifestOf(bundle),
      principal.companySnapshot,
    );
    ensurePinnedItem({
      item,
      bundle,
      expectedItemVersion: state.itemVersion,
      expectedItemType: state.itemType,
      expectedRulePackVersion: enrollment.rulePackVersion,
    });
    if (!runtimeItemAvailable(item, resolvedFlags)) {
      throw trainingCourseError(422, "TRAINER_COURSE_ITEM_UNAVAILABLE");
    }
    const now = clock();
    let attempt = state.attemptId
      ? await repository.findAttemptById(state.attemptId)
      : null;
    if (!attempt) {
      attempt = await repository.findLatestAttemptForEnrollmentItem({
        enrollmentId: enrollment.enrollmentId,
        itemId: item.id,
      });
    }
    if (!attempt && state.status === "in_progress") {
      throw trainingCourseError(409, "TRAINER_COURSE_CONFLICT");
    }
    if (!attempt) {
      attempt = await repository.findOrCreateAttempt({
        learnerEmailNormalized: principal.learnerEmailNormalized,
        requestId: safeRequestId,
        create: {
        attemptId: idFactory(),
        requestId: safeRequestId,
        enrollmentId: enrollment.enrollmentId,
        ...principal,
        courseId: enrollment.courseId,
        courseVersion: enrollment.courseVersion,
        itemId: item.id,
        itemVersion: item.version,
        itemType: item.type,
        rulePackVersion: enrollment.rulePackVersion,
        ruleIds: [...(item.ruleIds || [])],
        blueprintId: item.blueprintId || null,
        blueprintVersion: item.blueprintVersion || null,
        variantId: item.variantId || null,
        recordingManifestRef: null,
        contentSnapshot: {
          title: String(item.presentation?.title || item.title || item.id),
          required: state.required !== false,
          gradingVersion: item.assessment?.version || null,
          promptVersion: item.promptVersion || null,
        },
        eventIds: [],
        events: [],
        version: 0,
        terminalSummary: null,
        createdAt: now,
        updatedAt: now,
        },
      });
    }
    ensureOwnedAttempt(attempt, principal);
    if (
      attempt.enrollmentId !== enrollment.enrollmentId ||
      attempt.courseId !== enrollment.courseId ||
      attempt.courseVersion !== enrollment.courseVersion ||
      attempt.itemId !== item.id ||
      attempt.itemVersion !== item.version ||
      attempt.rulePackVersion !== enrollment.rulePackVersion ||
      attempt.terminalSummary
    ) {
      throw trainingCourseError(409, "TRAINER_COURSE_REQUEST_REUSED");
    }

    enrollment = await updateEnrollmentWithRetry(
      enrollment.enrollmentId,
      principal,
      (current) => {
        const currentState = (current.itemStates || []).find(
          (candidate) => candidate.itemId === item.id,
        );
        if (
          currentState?.status === "in_progress" &&
          currentState?.attemptId === attempt.attemptId
        ) {
          return null;
        }
        if (
          currentState?.attemptId &&
          currentState.attemptId !== attempt.attemptId
        ) {
          throw trainingCourseError(409, "TRAINER_COURSE_CONFLICT");
        }
        if (!["available", "in_progress"].includes(currentState?.status)) {
          throw trainingCourseError(
            422,
            "TRAINER_COURSE_ITEM_UNAVAILABLE",
          );
        }
        const itemStates = (current.itemStates || []).map((candidate) =>
          candidate.itemId === item.id
            ? {
                ...candidate,
                status: "in_progress",
                attemptId: attempt.attemptId,
                updatedAt: now,
              }
            : candidate,
        );
        return {
          itemStates,
          resumeItemId: item.id,
        };
      },
    );

    return {
      attempt: publicAttemptIdentity(attempt),
      enrollment: publicEnrollment(enrollment, bundle, resolvedFlags),
    };
  }

  async function reconcileAnswerRemediation(attempt, principal, event) {
    const latestAttempt = await repository.findAttemptById(attempt.attemptId);
    if (!latestAttempt || latestAttempt.terminalSummary) return;
    const acceptedEvent = eventById(latestAttempt, event?.eventId);
    const latestAnswer = latestAnswerEvent(latestAttempt);
    if (
      !acceptedEvent ||
      acceptedEvent.type !== "answer_submitted" ||
      latestAnswer?.eventId !== acceptedEvent.eventId
    ) {
      return;
    }
    const passed = acceptedEvent.payload?.grade?.passed === true;
    const occurredAt = asDate(acceptedEvent.occurredAt) || clock();
    await updateEnrollmentWithRetry(
      latestAttempt.enrollmentId,
      principal,
      (current) => {
        const currentState = (current.itemStates || []).find(
          (state) => state.itemId === latestAttempt.itemId,
        );
        if (
          currentState?.status !== "in_progress" ||
          currentState?.attemptId !== latestAttempt.attemptId
        ) {
          return null;
        }
        const active = current.activeRemediation || [];
        if (passed) {
          let changed = false;
          const reconciled = active.map((entry) => {
            if (
              entry.itemId === latestAttempt.itemId &&
              entry.status === "active"
            ) {
              changed = true;
              return {
                ...entry,
                status: "completed",
                completedAt: occurredAt,
              };
            }
            return entry;
          });
          return changed ? { activeRemediation: reconciled } : null;
        }
        const additions = (latestAttempt.ruleIds || [])
          .filter(
            (ruleId) =>
              !active.some(
                (entry) =>
                  entry.status === "active" &&
                  entry.ruleId === ruleId &&
                  entry.itemId === latestAttempt.itemId,
              ),
          )
          .map((ruleId) => ({
            remediationId: `remediation:${latestAttempt.attemptId}:${ruleId}`,
            ruleId,
            itemId: latestAttempt.itemId,
            reasonCode: "assessment_retry",
            status: "active",
            assignedAt: occurredAt,
            completedAt: null,
          }));
        if (
          additions.length === 0 &&
          current.resumeItemId === latestAttempt.itemId
        ) {
          return null;
        }
        return {
          activeRemediation: [...active, ...additions],
          resumeItemId: latestAttempt.itemId,
        };
      },
    );
    if (!passed) {
      const newestAttempt = await repository.findAttemptById(
        latestAttempt.attemptId,
      );
      const newestAnswer = latestAnswerEvent(newestAttempt);
      if (
        newestAttempt &&
        !newestAttempt.terminalSummary &&
        newestAnswer?.eventId !== acceptedEvent.eventId
      ) {
        await reconcileAnswerRemediation(
          newestAttempt,
          principal,
          newestAnswer,
        );
      }
    }
  }
  async function submitAnswer({
    principal: principalInput,
    attemptId,
    answer,
    eventId,
    expectedVersion,
  }) {
    requireFeature();
    const principal = normalizePrincipal(principalInput);
    const safeAttemptId = normalizeId(attemptId);
    const safeEventId = normalizeId(eventId);
    const safeAnswer = normalizeSafeText(answer);
    const safeExpectedVersion = normalizeExpectedVersion(expectedVersion);
    let attempt = ensureOwnedAttempt(
      await repository.findAttemptById(safeAttemptId),
      principal,
    );
    const duplicateEvent = eventById(attempt, safeEventId);
    if (duplicateEvent) {
      if (
        duplicateEvent.type !== "answer_submitted" ||
        duplicateEvent.payload?.answer !== safeAnswer
      ) {
        throw trainingCourseError(409, "TRAINER_COURSE_EVENT_REUSED");
      }
      await reconcileAnswerRemediation(
        attempt,
        principal,
        duplicateEvent,
      );
      return {
        attemptId: attempt.attemptId,
        eventId: safeEventId,
        duplicate: true,
        version: attempt.version,
        grade: clone(duplicateEvent.payload?.grade || null),
        completionEligible:
          duplicateEvent.payload?.grade?.passed === true,
      };
    }
    if (attempt.terminalSummary) {
      throw trainingCourseError(422, "TRAINER_COURSE_ATTEMPT_TERMINAL");
    }
    if (attempt.version !== safeExpectedVersion) {
      throw trainingCourseError(409, "TRAINER_COURSE_CONFLICT");
    }
    const enrollment = ensureOwnedEnrollment(
      await repository.findEnrollmentById(attempt.enrollmentId),
      principal,
    );
    const bundle = bundleForEnrollment(enrollment, principal);
    const sourceItem = itemMap(bundle).get(attempt.itemId);
    const item = ensurePinnedItem({
      item: sourceItem
        ? applyCompanyOverlay(
            sourceItem,
            manifestOf(bundle),
            principal.companySnapshot,
          )
        : null,
      bundle,
      expectedItemVersion: attempt.itemVersion,
      expectedItemType: attempt.itemType,
      expectedRulePackVersion: attempt.rulePackVersion,
    });
    const grade = gradeAnswer(item, safeAnswer);
    const occurredAt = clock();
    const result = await repository.appendAttemptEvent({
      attemptId: attempt.attemptId,
      eventId: safeEventId,
      expectedVersion: safeExpectedVersion,
      event: {
        eventId: safeEventId,
        sequence: safeExpectedVersion + 1,
        type: "answer_submitted",
        occurredAt,
        expectedPriorVersion: safeExpectedVersion,
        payload: {
          answer: safeAnswer,
          grade,
        },
        provenance: {
          authority: "server_owned_content",
          gradingVersion: grade.gradingVersion,
          rulePackVersion: attempt.rulePackVersion,
        },
      },
    });
    if (!result.attempt) {
      throw trainingCourseError(404, "TRAINER_COURSE_NOT_FOUND");
    }
    if (result.conflict) {
      throw trainingCourseError(409, "TRAINER_COURSE_CONFLICT");
    }
    attempt = result.attempt;

    const acceptedEvent = eventById(attempt, safeEventId);
    if (
      acceptedEvent?.type !== "answer_submitted" ||
      acceptedEvent.payload?.answer !== safeAnswer
    ) {
      throw trainingCourseError(409, "TRAINER_COURSE_EVENT_REUSED");
    }
    await reconcileAnswerRemediation(
      attempt,
      principal,
      acceptedEvent,
    );
    return {
      attemptId: attempt.attemptId,
      eventId: safeEventId,
      duplicate: result.duplicate,
      version: attempt.version,
      grade: clone(acceptedEvent?.payload?.grade || grade),
      completionEligible:
        (acceptedEvent?.payload?.grade || grade).passed === true,
    };
  }

  async function completeAttempt({
    principal: principalInput,
    attemptId,
    eventId,
    expectedVersion,
  }) {
    const resolvedFlags = requireFeature();
    const principal = normalizePrincipal(principalInput);
    const safeAttemptId = normalizeId(attemptId);
    const safeEventId = normalizeId(eventId);
    const safeExpectedVersion = normalizeExpectedVersion(expectedVersion);
    let attempt = ensureOwnedAttempt(
      await repository.findAttemptById(safeAttemptId),
      principal,
    );
    const existingEvent = eventById(attempt, safeEventId);
    if (existingEvent && existingEvent.type !== "attempt_completed") {
      throw trainingCourseError(409, "TRAINER_COURSE_EVENT_REUSED");
    }
    const isGauntlet = attempt.itemType === "gauntlet";
    if (attempt.terminalSummary && !existingEvent && !isGauntlet) {
      throw trainingCourseError(422, "TRAINER_COURSE_ATTEMPT_TERMINAL");
    }
    if (!existingEvent && attempt.version !== safeExpectedVersion) {
      throw trainingCourseError(409, "TRAINER_COURSE_CONFLICT");
    }
    const enrollment = ensureOwnedEnrollment(
      await repository.findEnrollmentById(attempt.enrollmentId),
      principal,
    );
    const bundle = bundleForEnrollment(enrollment, principal);
    const completionSourceItem = itemMap(bundle).get(attempt.itemId);
    ensurePinnedItem({
      item: completionSourceItem
        ? applyCompanyOverlay(
            completionSourceItem,
            manifestOf(bundle),
            principal.companySnapshot,
          )
        : null,
      bundle,
      expectedItemVersion: attempt.itemVersion,
      expectedItemType: attempt.itemType,
      expectedRulePackVersion: attempt.rulePackVersion,
    });
    const completionState = (enrollment.itemStates || []).find(
      (state) => state.itemId === attempt.itemId,
    );
    const completionAlreadyApplied =
      completionState?.status === "completed" &&
      completionState?.attemptId === attempt.attemptId;
    if (
      !completionAlreadyApplied &&
      (completionState?.status !== "in_progress" ||
        completionState?.attemptId !== attempt.attemptId)
    ) {
      throw trainingCourseError(409, "TRAINER_COURSE_CONFLICT");
    }
    const answer = latestAnswerEvent(attempt);
    const needsAnswer = ["quiz", "say-it"].includes(attempt.itemType);
    if (!existingEvent && needsAnswer && answer?.payload?.grade?.passed !== true) {
      throw trainingCourseError(
        422,
        "TRAINER_COURSE_ATTEMPT_NOT_COMPLETE",
      );
    }
    const gauntletStatus = String(attempt.gauntletState?.status || "");
    const questions = isGauntlet ? gauntletQuestions(bundle, attempt) : [];
    if (
      !existingEvent &&
      isGauntlet &&
      (!["passed", "failed"].includes(gauntletStatus) ||
        !gauntletKnowledgeCheckComplete(attempt, questions.length))
    ) {
      throw trainingCourseError(
        422,
        "TRAINER_COURSE_ATTEMPT_NOT_COMPLETE",
      );
    }
    let occurredAt =
      asDate(existingEvent?.occurredAt) ||
      clock();
    const currentOutcome = isGauntlet ? gauntletStatus : "passed";
    const priorOutcome = String(attempt.terminalSummary?.status || "");
    const terminalSummary = Object.freeze({
      ...(attempt.terminalSummary || {}),
      status:
        priorOutcome === "passed" || currentOutcome === "passed"
          ? "passed"
          : "failed",
      latestRunStatus: currentOutcome,
      completedAt: occurredAt,
      score: answer?.payload?.grade?.score ?? attempt.terminalSummary?.score ?? null,
    });
    const appendResult = existingEvent
      ? { attempt, duplicate: true, conflict: false }
      : await repository.appendAttemptEvent({
          attemptId: attempt.attemptId,
          eventId: safeEventId,
          expectedVersion: safeExpectedVersion,
          event: {
            eventId: safeEventId,
            sequence: safeExpectedVersion + 1,
            type: "attempt_completed",
            occurredAt,
            expectedPriorVersion: safeExpectedVersion,
            payload: terminalSummary,
            provenance: {
              authority: "server_owned_content",
              rulePackVersion: attempt.rulePackVersion,
            },
          },
          terminalSummary,
        });
    if (!appendResult.attempt) {
      throw trainingCourseError(404, "TRAINER_COURSE_NOT_FOUND");
    }
    if (appendResult.conflict) {
      throw trainingCourseError(409, "TRAINER_COURSE_CONFLICT");
    }
    attempt = appendResult.attempt;
    const acceptedCompletionEvent = eventById(attempt, safeEventId);
    if (acceptedCompletionEvent?.type !== "attempt_completed") {
      throw trainingCourseError(409, "TRAINER_COURSE_EVENT_REUSED");
    }
    occurredAt =
      asDate(acceptedCompletionEvent.occurredAt) ||
      asDate(attempt.terminalSummary?.completedAt) ||
      occurredAt;

    const updatedEnrollment = await projectCompletedAttempt({
      attempt,
      enrollment,
      principal,
      bundle,
      resolvedFlags,
      occurredAt,
    });
    const nextAssignment = updatedEnrollment.resumeItemId
      ? {
          courseId: updatedEnrollment.courseId,
          itemId: updatedEnrollment.resumeItemId,
        }
      : null;
    return {
      attemptId: attempt.attemptId,
      eventId: safeEventId,
      duplicate: appendResult.duplicate,
      version: attempt.version,
      terminalSummary: clone(attempt.terminalSummary),
      enrollment: publicEnrollment(
        updatedEnrollment,
        bundle,
        resolvedFlags,
      ),
      nextAssignment,
    };
  }

  async function addReflection({
    principal: principalInput,
    attemptId,
    reflection,
    eventId,
    expectedVersion,
  }) {
    requireFeature();
    const principal = normalizePrincipal(principalInput);
    const safeAttemptId = normalizeId(attemptId);
    const safeEventId = normalizeId(eventId);
    const safeReflection = normalizeSafeText(reflection);
    const safeExpectedVersion = normalizeExpectedVersion(expectedVersion);
    let attempt = ensureOwnedAttempt(
      await repository.findAttemptById(safeAttemptId),
      principal,
    );
    if (!attempt.terminalSummary) {
      throw trainingCourseError(422, "TRAINER_COURSE_ATTEMPT_NOT_COMPLETE");
    }
    const duplicateEvent = eventById(attempt, safeEventId);
    if (duplicateEvent) {
      if (
        duplicateEvent.type !== "reflection_added" ||
        duplicateEvent.payload?.reflection !== safeReflection
      ) {
        throw trainingCourseError(409, "TRAINER_COURSE_EVENT_REUSED");
      }
      return {
        attemptId: attempt.attemptId,
        eventId: safeEventId,
        duplicate: true,
        version: attempt.version,
        reflection: {
          text: String(duplicateEvent.payload?.reflection || ""),
          occurredAt: iso(duplicateEvent.occurredAt),
        },
      };
    }
    if (attempt.version !== safeExpectedVersion) {
      throw trainingCourseError(409, "TRAINER_COURSE_CONFLICT");
    }
    const occurredAt = clock();
    const result = await repository.appendAttemptEvent({
      attemptId: attempt.attemptId,
      eventId: safeEventId,
      expectedVersion: safeExpectedVersion,
      event: {
        eventId: safeEventId,
        sequence: safeExpectedVersion + 1,
        type: "reflection_added",
        occurredAt,
        expectedPriorVersion: safeExpectedVersion,
        payload: { reflection: safeReflection },
        provenance: { authority: "learner_reflection" },
      },
    });
    if (!result.attempt) {
      throw trainingCourseError(404, "TRAINER_COURSE_NOT_FOUND");
    }
    if (result.conflict) {
      throw trainingCourseError(409, "TRAINER_COURSE_CONFLICT");
    }
    attempt = result.attempt;
    const accepted = eventById(attempt, safeEventId);
    if (
      accepted?.type !== "reflection_added" ||
      accepted.payload?.reflection !== safeReflection
    ) {
      throw trainingCourseError(409, "TRAINER_COURSE_EVENT_REUSED");
    }
    return {
      attemptId: attempt.attemptId,
      eventId: safeEventId,
      duplicate: result.duplicate,
      version: attempt.version,
      reflection: {
        text: String(accepted?.payload?.reflection || safeReflection),
        occurredAt: iso(accepted?.occurredAt || occurredAt),
      },
    };
  }

  async function getResults({
    principal: principalInput,
    attemptId,
  }) {
    const resolvedFlags = requireFeature();
    const principal = normalizePrincipal(principalInput);
    const safeAttemptId = normalizeId(attemptId);
    const attempt = ensureOwnedAttempt(
      await repository.findAttemptById(safeAttemptId),
      principal,
    );
    if (!attempt.terminalSummary) {
      throw trainingCourseError(422, "TRAINER_COURSE_ATTEMPT_NOT_COMPLETE");
    }
    let enrollment = ensureOwnedEnrollment(
      await repository.findEnrollmentById(attempt.enrollmentId),
      principal,
    );
    const bundle = bundleForEnrollment(enrollment, principal);
    enrollment = await reconcileAcceptedAttemptProjections(
      enrollment,
      principal,
      bundle,
      resolvedFlags,
    );
    const publicEnrollmentValue = publicEnrollment(
      enrollment,
      bundle,
      resolvedFlags,
    );
    return {
      attempt: publicAttemptIdentity(attempt),
      events: (attempt.events || []).map(publicEvent),
      terminalSummary: clone(attempt.terminalSummary),
      enrollment: {
        enrollmentId: publicEnrollmentValue.enrollmentId,
        status: publicEnrollmentValue.status,
        resumeItemId: publicEnrollmentValue.resumeItemId,
        version: publicEnrollmentValue.version,
        progress: publicEnrollmentValue.progress,
        masteryByRule: toPlainMastery(enrollment.masteryByRule),
        activeRemediation: publicEnrollmentValue.activeRemediation,
      },
      nextAssignment: enrollment.resumeItemId
        ? {
            courseId: enrollment.courseId,
            itemId: enrollment.resumeItemId,
          }
        : null,
    };
  }

  return Object.freeze({
    addReflection,
    completeAttempt,
    enroll,
    getHome,
    getItem,
    getResults,
    startAttempt,
    submitAnswer,
  });
}

module.exports = {
  TrainingCourseError,
  createTrainingCourseService,
  normalizePrincipal,
  trainingCourseError,
};
