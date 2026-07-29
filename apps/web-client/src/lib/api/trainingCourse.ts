import { API_BASE_URL, TOKEN_STORAGE_KEY } from "@/lib/api/client";
import { SALES_TRAINER_TOKEN_KEY } from "@/lib/api/salesTrainer";

export type TrainingCourseItemState =
  | "locked"
  | "available"
  | "in_progress"
  | "completed"
  | "unavailable";

export type TrainingCourseItemType =
  | "lesson"
  | "quiz"
  | "say_it"
  | "say-it"
  | "gauntlet"
  | "free_call"
  | "free-call"
  | "reflection"
  | string;

export interface TrainingCourseTarget {
  courseId: string;
  itemId: string;
}

export interface TrainingCourseRailItem {
  itemId: string;
  itemVersion: string;
  title: string;
  type: TrainingCourseItemType;
  status: TrainingCourseItemState;
  required: boolean;
}

export interface TrainingMasterySummary {
  knowledgeBest?: number | null;
  guidedExecutionBest?: number | null;
  transferBest?: number | null;
  realCallEvidenceBest?: number | null;
}

export interface TrainingEnrollment {
  enrollmentId: string;
  status: string;
  courseId: string;
  courseVersion: string;
  rulePackVersion: string;
  resumeItemId: string | null;
  version: number;
  progress: {
    completed: number;
    total: number;
    requiredCompleted: number;
    requiredTotal: number;
  };
  activeRemediation: Array<Record<string, unknown>>;
  items: TrainingCourseRailItem[];
  mastery?: TrainingMasterySummary | null;
}

export interface TrainingCourseHome {
  course: {
    courseId: string;
    courseVersion: string;
    title: string;
    status: string;
  } | null;
  enrollment: TrainingEnrollment | null;
  capabilities: {
    courseV1Enabled: boolean;
    gauntletV1Enabled: boolean;
    callReviewV1Enabled: boolean;
  };
}

export interface TrainingAttempt {
  attemptId: string;
  enrollmentId: string;
  itemId: string;
  itemVersion: string;
  itemType: TrainingCourseItemType;
  version: number;
  status: string;
  createdAt: string;
}

export interface TrainingCourseItem {
  itemId: string;
  itemVersion: string;
  type: TrainingCourseItemType;
  title: string;
  required: boolean;
  status: TrainingCourseItemState;
  completedAttemptId?: string | null;
  content: {
    summary: string | null;
    body: string | null;
    instructions: string | null;
    prompt: string | null;
    choices: Array<{ choiceId: string; label: string }>;
    estimatedMinutes: number | null;
  };
}

export interface TrainingEnrollmentResult {
  enrollment: TrainingEnrollment;
  resumeTarget: TrainingCourseTarget | null;
}

export interface TrainingCourseItemResult {
  item: TrainingCourseItem;
}

export interface TrainingAttemptStartResult {
  attempt: TrainingAttempt;
}

export interface TrainingAnswerResult {
  attemptId: string;
  eventId: string;
  duplicate: boolean;
  version: number;
  grade: {
    passed: boolean;
    score: number;
    evidence: string[];
  };
  completionEligible: boolean;
}

export interface TrainingAttemptCompleteResult {
  attemptId: string;
  eventId: string;
  duplicate: boolean;
  version: number;
  terminalSummary: Record<string, unknown> | null;
  enrollment: TrainingEnrollment;
  nextAssignment: TrainingCourseTarget | null;
}

export interface TrainingReflectionResult {
  attemptId: string;
  eventId: string;
  duplicate: boolean;
  version: number;
  reflection: {
    text: string;
    occurredAt: string;
  };
}

export interface TrainingAttemptResult {
  attempt: {
    attemptId: string;
    enrollmentId?: string;
    courseId: string;
    itemId: string;
    itemVersion?: string;
    itemType?: TrainingCourseItemType;
    version: number;
    status: string;
  };
  events: Array<{
    eventId: string;
    sequence: number;
    type: "answer_submitted" | "reflection_added" | "attempt_completed" | string;
    occurredAt: string | null;
    payload: {
      answer?: string;
      grade?: {
        passed: boolean;
        score: number;
        evidence: string[];
        gradingVersion?: string;
      } | null;
      reflection?: string;
      [key: string]: unknown;
    };
  }>;
  terminalSummary: Record<string, unknown> | null;
  enrollment: {
    enrollmentId?: string;
    resumeItemId?: string | null;
    progress?: TrainingEnrollment["progress"];
    masteryByRule?: Record<string, TrainingMasterySummary>;
    activeRemediation?: Array<Record<string, unknown>>;
    version?: number;
  } | null;
  nextAssignment: TrainingCourseTarget | null;
}

export interface TrainingGauntletCriterion {
  criterionId: string;
  ruleId: string;
  ruleRevision: string;
  status: "pending" | "satisfied" | "failed" | "uncertain";
  evidenceTurnIds: string[];
}

export interface TrainingGauntletState {
  schemaVersion: "1";
  experienceMode: "gauntlet";
  sectionId: string;
  status: "ready" | "in_progress" | "run_failed" | "passed" | "failed" | "invalidated";
  stateVersion: number;
  runNumber: number;
  nextTurn: number;
  currentNodeId: string;
  variantId: string;
  criteria: TrainingGauntletCriterion[];
}

export interface TrainingGauntletResult {
  attemptId?: string;
  version?: number;
  attempt?: TrainingAttempt;
  duplicate?: boolean;
  state: TrainingGauntletState;
  reactionIntent?: string | null;
  prospectReply?: { text: string; speechActs: string[] } | null;
  terminal?: "passed" | "failed" | null;
}

type CourseRequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
};

function trainerToken() {
  try {
    return (
      window.localStorage.getItem(SALES_TRAINER_TOKEN_KEY) ||
      window.localStorage.getItem(TOKEN_STORAGE_KEY)
    );
  } catch {
    return null;
  }
}

async function courseRequest<T>(
  path: string,
  { method = "GET", body, signal }: CourseRequestOptions = {},
): Promise<T> {
  const token = trainerToken();
  const response = await fetch(`${API_BASE_URL}/api/sales-trainer${path}`, {
    method,
    credentials: "include",
    signal,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const safe = payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
    const error = new Error(
      typeof safe.error === "string"
        ? safe.error
        : typeof safe.message === "string"
          ? safe.message
          : `Course request failed (${response.status})`,
    ) as Error & { status?: number; code?: string };
    error.status = response.status;
    if (typeof safe.code === "string") error.code = safe.code;
    throw error;
  }
  if (
    payload &&
    typeof payload === "object" &&
    (payload as { ok?: unknown }).ok === true &&
    "result" in payload
  ) {
    return (payload as { ok: true; result: T }).result;
  }
  throw new Error("Course service returned an invalid response.");
}

export function createTrainingRequestId(prefix: string) {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

export const trainingCourseApi = {
  home(courseAlias?: string, signal?: AbortSignal) {
    const query = courseAlias
      ? `?courseAlias=${encodeURIComponent(courseAlias)}`
      : "";
    return courseRequest<TrainingCourseHome>(`/course/home${query}`, { signal });
  },
  enroll(body: { courseAlias?: string; requestId: string }) {
    return courseRequest<TrainingEnrollmentResult>("/enrollments", {
      method: "POST",
      body,
    });
  },
  item(courseId: string, itemId: string, signal?: AbortSignal) {
    return courseRequest<TrainingCourseItemResult>(
      `/course/${encodeURIComponent(courseId)}/items/${encodeURIComponent(itemId)}`,
      { signal },
    );
  },
  startAttempt(body: {
    itemId: string;
    requestId: string;
  }) {
    return courseRequest<TrainingAttemptStartResult>("/attempts", {
      method: "POST",
      body,
    });
  },
  answer(
    attemptId: string,
    body: {
      answer: string;
      eventId: string;
      expectedVersion: number;
    },
  ) {
    return courseRequest<TrainingAnswerResult>(
      `/attempts/${encodeURIComponent(attemptId)}/answers`,
      { method: "POST", body },
    );
  },
  complete(
    attemptId: string,
    body: { eventId: string; expectedVersion: number },
  ) {
    return courseRequest<TrainingAttemptCompleteResult>(
      `/attempts/${encodeURIComponent(attemptId)}/complete`,
      { method: "POST", body },
    );
  },
  reflect(
    attemptId: string,
    body: {
      reflection: string;
      eventId: string;
      expectedVersion: number;
    },
  ) {
    return courseRequest<TrainingReflectionResult>(
      `/attempts/${encodeURIComponent(attemptId)}/reflection`,
      { method: "POST", body },
    );
  },
  results(attemptId: string, signal?: AbortSignal) {
    return courseRequest<TrainingAttemptResult>(
      `/attempts/${encodeURIComponent(attemptId)}/results`,
      { signal },
    );
  },
  gauntlet(attemptId: string, signal?: AbortSignal) {
    return courseRequest<TrainingGauntletResult>(
      `/course/gauntlet/attempts/${encodeURIComponent(attemptId)}`,
      { signal },
    );
  },
  initializeGauntlet(
    attemptId: string,
    body: { eventId: string; expectedVersion: number },
  ) {
    return courseRequest<TrainingGauntletResult>(
      `/course/gauntlet/attempts/${encodeURIComponent(attemptId)}/initialize`,
      { method: "POST", body },
    );
  },
  submitGauntletTurn(
    attemptId: string,
    body: {
      eventId: string;
      expectedVersion: number;
      expectedTurn: number;
      text: string;
    },
  ) {
    return courseRequest<TrainingGauntletResult>(
      `/course/gauntlet/attempts/${encodeURIComponent(attemptId)}/turns`,
      { method: "POST", body },
    );
  },
  retryGauntlet(
    attemptId: string,
    body: { eventId: string; expectedVersion: number },
  ) {
    return courseRequest<TrainingGauntletResult>(
      `/course/gauntlet/attempts/${encodeURIComponent(attemptId)}/retry`,
      { method: "POST", body },
    );
  },
};
