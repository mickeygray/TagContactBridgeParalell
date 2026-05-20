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

export interface UiVerbatimMoment {
  agent_words?: string;
  why_it_landed?: string;
  stronger_alternative?: string;
  principle?: string;
  principle_applied?: string;
}

export interface UiVulnerabilityMoment {
  phase?: number;
  caller_words?: string;
  agent_response?: string;
  trust_impact?: number;
}

export interface UiPhaseBreakdown {
  phase?: number;
  result?: string;
  score?: number;
  objections?: {
    faced?: number;
    handled_well?: number;
    partial?: number;
    poor?: number;
  };
  hidden_issues_surfaced?: { surfaced?: number; total?: number } | null;
  strongest_moment?: UiVerbatimMoment | null;
  weakest_moment?: UiVerbatimMoment;
  recovery_moment?:
    | {
        agent_words?: string;
        trust_dipped_to?: number;
        trust_recovered_to?: number;
        why_it_worked?: string;
        principle_applied?: string;
      }
    | null;
  vulnerability_handling?:
    | { handled?: "well" | "poorly" | string; what_it_taught?: string }
    | null;
}

export interface UiScorecardFacts {
  caller_summary?: {
    scenario_archetype?: string;
    personality_archetype?: string;
    mode?: string;
    source?: string;
    one_line?: string;
    demographics_one_line?: string;
    primary_tax_issues?: string[];
    approx_debt_usd?: number | null;
  };
  outcome?: "closed" | "no_close" | "terminated" | string;
  termination_reason?: string | null;
  final_mistakes?: number;
  mistake_log?: Array<{
    sequence?: number;
    turn_label?: string;
    category?: string;
    severity?: "standard" | "severe" | "catastrophic" | string;
    agent_words?: string;
  }>;
  objections_record?: Array<{
    phase?: number;
    faced?: number;
    handled_well?: number;
    partial?: number;
    poor?: number;
  }>;
  phase_outcomes?: Record<string, string>;
  trust_trajectory?: Record<string, unknown>;
  hidden_issues_surfaced?:
    | { surfaced?: number; total?: number; which_surfaced?: string[] }
    | null;
  vulnerability_moment?: UiVulnerabilityMoment | null;
  verbatim_quotes?: {
    agent_opening?: string;
    agent_quote_line?: string | null;
    agent_final_line?: string;
    caller_final_line?: string;
  };
}

export interface UiScorecardAssessment {
  overall_score?: number;
  mood_arc?: string;
  inflection_moment?: string;
  phase_breakdowns?: UiPhaseBreakdown[];
  ethical_flags?: UiEthicalFlag[];
  patterns?: Array<{
    principle?: string;
    instances?: string[];
    instances_count?: number;
    the_fix?: string;
  }>;
  clean_call?: boolean;
  strongest_overall_moment?: UiVerbatimMoment | null;
  weakest_overall_moment?: UiVerbatimMoment;
  drill_for_next_call?: string;
  coaching_summary?: string;
  available_actions?: string[];
}

/**
 * Scorecard payload as emitted by the v2 simulator. The current prompt
 * structures the JSON as { type, facts: {...}, assessment: {...} }, but
 * older runs emitted a flat object with the same field names at the top
 * level. Both are tolerated — the renderer uses `normalizeScorecard`
 * below to flatten the nested shape so the UI doesn't care which it got.
 */
export interface UiScorecardPayload
  extends UiScorecardFacts,
    UiScorecardAssessment {
  type: "scorecard";
  facts?: UiScorecardFacts;
  assessment?: UiScorecardAssessment;
}

/**
 * Returns a flat view of the scorecard regardless of whether the
 * incoming payload nests under `facts`/`assessment` or sits at the top
 * level. Useful for the renderer so it doesn't need to look in two
 * places for every field.
 */
export function normalizeScorecard(payload: UiScorecardPayload): UiScorecardFacts & UiScorecardAssessment & { type?: "scorecard" } {
  return {
    ...payload,
    ...(payload.facts || {}),
    ...(payload.assessment || {}),
  };
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
