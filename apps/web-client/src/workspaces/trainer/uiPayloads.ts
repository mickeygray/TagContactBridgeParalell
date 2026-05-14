export type UiTagType = "UI_HEALTH" | "UI_PAYLOAD" | "UI_SCORECARD";

export interface UiHealthPayload {
  type: "health_update";
  mistakes: number;
  max: number;
  last_mistake_category?: string;
  last_mistake_severity?: "standard" | "severe" | "catastrophic" | string;
  principle_crossed?: string;
  agent_words?: string;
}

export interface UiEthicalFlag {
  agent_words?: string;
  principle_crossed?: string;
  severity?: "minor" | "major" | string;
}

export interface UiPhasePayload {
  type: "phase_transition";
  phase: number;
  result?: "pass" | "fail" | string;
  score?: number;
  trust_start?: number;
  trust_end?: number;
  objections?: {
    faced?: number;
    handled_well?: number;
    partial?: number;
    poor?: number;
  };
  strongest_moment?: {
    agent_words?: string;
    why_it_landed?: string;
  };
  weakest_moment?: {
    agent_words?: string;
    stronger_alternative?: string;
    principle?: string;
  };
  carry_forward?: string;
  ethical_flags?: UiEthicalFlag[];
}

export interface UiScorecardPayload {
  type: "scorecard";
  caller_summary?: {
    scenario_archetype?: string;
    personality_archetype?: string;
    mode?: string;
    source?: string;
    one_line?: string;
  };
  outcome?: "closed" | "no_close" | "terminated" | string;
  overall_score?: number;
  final_mistakes?: number;
  trust_trajectory?: Record<string, unknown>;
  phase_breakdowns?: Array<{
    phase?: number;
    result?: string;
    score?: number;
    objections?: {
      handled_well?: number;
      partial?: number;
      poor?: number;
    };
    hidden_issues_surfaced?: { surfaced?: number; total?: number } | null;
    strongest_moment?: {
      agent_words?: string;
      why_it_landed?: string;
    };
    weakest_moment?: {
      agent_words?: string;
      stronger_alternative?: string;
      principle?: string;
    };
  }>;
  ethical_flags?: UiEthicalFlag[];
  patterns?: Array<{
    principle?: string;
    instances?: string[];
    the_fix?: string;
  }>;
  clean_call?: boolean;
  drill_for_next_call?: string;
  available_actions?: string[];
}

export type UiPayload = UiHealthPayload | UiPhasePayload | UiScorecardPayload;

export interface ParsedUiEvent {
  tagType: UiTagType;
  payload: UiPayload;
}

export interface ParsedTrainerResponse {
  chatText: string;
  events: ParsedUiEvent[];
  parseErrors: Array<{ tagType: UiTagType; error: string; raw: string }>;
}

const TAG_PATTERN = /<(UI_HEALTH|UI_PAYLOAD|UI_SCORECARD)>([\s\S]*?)<\/\1>/g;

export function processTrainerTaggedResponse(rawResponse: string): ParsedTrainerResponse {
  const raw = String(rawResponse || "");
  const events: ParsedUiEvent[] = [];
  const parseErrors: ParsedTrainerResponse["parseErrors"] = [];
  let match: RegExpExecArray | null;

  while ((match = TAG_PATTERN.exec(raw)) !== null) {
    const tagType = match[1] as UiTagType;
    const jsonStr = match[2] || "";
    try {
      events.push({
        tagType,
        payload: JSON.parse(jsonStr) as UiPayload,
      });
    } catch (error) {
      parseErrors.push({
        tagType,
        error: error instanceof Error ? error.message : "JSON parse failed",
        raw: jsonStr,
      });
    }
  }

  return {
    chatText: raw.replace(TAG_PATTERN, "").trim(),
    events,
    parseErrors,
  };
}

export function healthFromPayload(payload: UiHealthPayload) {
  const max = Number.isFinite(Number(payload.max)) ? Number(payload.max) : 10;
  const mistakes = Math.min(Math.max(Number(payload.mistakes) || 0, 0), max);
  return {
    current: Math.max(max - mistakes, 0),
    mistakes,
    max,
    lastMistake: payload,
  };
}
