// Field Manual content assembly — the four parts in reading order, plus the
// lookup tables the workspace renders from. Content lives in the sibling
// modules; this file owns ordering, titles, and link integrity.

import type { ManualEntry, ManualPart } from "./types";
import { READ_ENTRIES } from "./read";
import { SCRIPT_ENTRIES } from "./script";
import { TAX_ENTRIES } from "./tax";
import { OBJECTION_TRUST_ENTRIES } from "./objections-trust";
import { OBJECTION_CAPABILITY_ENTRIES } from "./objections-capability";
import { OBJECTION_MONEY_ENTRIES } from "./objections-money";
import { STRATEGY_MECHANICS_ENTRIES } from "./strategies-mechanics";
import { STRATEGY_PLAYS_ENTRIES } from "./strategies-plays";
import { PSYCH_VOSS_ENTRIES } from "./psychology-voss";
import { PSYCH_PRINCIPLES_ENTRIES } from "./psychology-principles";

export type { ManualEntry, ManualBlock, ManualPart } from "./types";

export interface PartMeta {
  id: ManualPart;
  title: string;
  blurb: string;
  /** Section order within the part; sections not listed sort last. */
  sections: { id: string; title: string }[];
}

export const PARTS: PartMeta[] = [
  {
    id: "script",
    title: "Part 1 — The Script",
    blurb:
      "The tax-resolution call start to finish — the seven-section method everything else hangs off, plus the house point of view on the tax topics that come up.",
    sections: [
      { id: "read", title: "Read the person first — legitimacy & trust" },
      { id: "method", title: "The method — the call, start to finish" },
      { id: "tax", title: "Tax topics — the house point of view" },
    ],
  },
  {
    id: "objections",
    title: "Part 2 — Objections",
    blurb:
      "Every objection you will hear and the play for each — what it really means, the reframe, the lines, and what not to do.",
    sections: [
      { id: "compliance", title: "Compliance — the hard stop" },
      { id: "trust", title: "Trust & identity" },
      { id: "decision", title: "Stalls & decisions" },
      { id: "capability", title: "Capability & competition" },
      { id: "debt", title: "The debt itself" },
      { id: "money", title: "Money" },
      { id: "edge", title: "Edge cases" },
    ],
  },
  {
    id: "strategies",
    title: "Part 3 — Strategies",
    blurb:
      "The tactics and plays that advance a call — when to reach for each, how it works, and worked examples in the floor’s voice.",
    sections: [
      { id: "mechanics", title: "Classic mechanics" },
      { id: "plays", title: "Situational plays" },
      { id: "funnel", title: "Funnels & framing" },
      { id: "tone", title: "Tone" },
    ],
  },
  {
    id: "psychology",
    title: "Part 4 — Psychology of the Sale",
    blurb:
      "The principles underneath the plays, in the voices of the people who taught them — Voss, Cialdini, SPIN, Sandler, NEPQ — cited, so you learn the source.",
    sections: [
      { id: "voss", title: "Chris Voss — tactical empathy" },
      { id: "spin", title: "Neil Rackham — SPIN" },
      { id: "cialdini", title: "Robert Cialdini — influence" },
      { id: "sandler", title: "David Sandler — the Sandler system" },
      { id: "nepq", title: "Jeremy Miner — NEPQ" },
    ],
  },
];

export const ALL_ENTRIES: ManualEntry[] = [
  ...READ_ENTRIES,
  ...SCRIPT_ENTRIES,
  ...TAX_ENTRIES,
  ...OBJECTION_TRUST_ENTRIES,
  ...OBJECTION_CAPABILITY_ENTRIES,
  ...OBJECTION_MONEY_ENTRIES,
  ...STRATEGY_MECHANICS_ENTRIES,
  ...STRATEGY_PLAYS_ENTRIES,
  ...PSYCH_VOSS_ENTRIES,
  ...PSYCH_PRINCIPLES_ENTRIES,
];

export const ENTRY_BY_ID: Map<string, ManualEntry> = new Map(
  ALL_ENTRIES.map((e) => [e.id, e]),
);

const INLINE_REF = /\[\[([a-z0-9.-]+)\]\]/g;

/** Dev-time link integrity: warn on duplicate ids, dangling `links`, and
 *  dangling [[inline]] refs. Returns the problem list so a test can assert
 *  it is empty. */
export function validateManualContent(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of ALL_ENTRIES) {
    if (seen.has(e.id)) problems.push(`duplicate id: ${e.id}`);
    seen.add(e.id);
  }
  const texts = (e: ManualEntry): string[] => {
    const out: string[] = [e.lead];
    for (const b of e.blocks) {
      if (b.kind === "prose" || b.kind === "compliance") out.push(b.text);
      else if (b.kind === "example") out.push(b.weak, b.strong, b.note ?? "");
      else if (b.kind === "drill") out.push(b.prompt, b.answer);
      else out.push(...b.items);
    }
    return out;
  };
  for (const e of ALL_ENTRIES) {
    for (const id of e.links ?? []) {
      if (!ENTRY_BY_ID.has(id)) problems.push(`${e.id}: dangling link -> ${id}`);
    }
    for (const t of texts(e)) {
      for (const m of t.matchAll(INLINE_REF)) {
        if (!ENTRY_BY_ID.has(m[1])) problems.push(`${e.id}: dangling inline ref -> ${m[1]}`);
      }
    }
  }
  return problems;
}

if (import.meta.env?.DEV) {
  const problems = validateManualContent();
  if (problems.length) {
    // eslint-disable-next-line no-console
    console.warn(`[field-manual] content problems:\n${problems.join("\n")}`);
  }
}
