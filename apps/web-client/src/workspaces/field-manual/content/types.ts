// Field Manual content schema — the static, human-readable twin of the live
// coach. Entries are authored prose (synthesized from the coach guidance
// corpus), NOT a live render of the coach's match banks: the coach speaks in
// terse steering lines; the manual teaches in full sentences.
//
// Every entry is addressable (id = URL hash) and cross-linked: a script beat
// links to the objections that arise there, an objection to the strategy that
// answers it, a strategy to the psychology principle underneath. Inline
// references inside `text`/`items` use [[entry-id]] and are rendered as links.

export type ManualPart = "script" | "objections" | "strategies" | "psychology";

/** Full readable paragraphs — the teaching voice. `text` may contain [[id]] refs. */
export interface ProseBlock {
  kind: "prose";
  heading?: string;
  text: string;
}

/** Ordered lists: `moves` = the plays in order, `lines` = floor-voice example
 *  lines (adapt, never recite), `avoid` = what NOT to do. */
export interface ListBlock {
  kind: "moves" | "lines" | "avoid";
  heading?: string;
  items: string[];
}

/** Weak vs strong handling, side by side, so the difference is visible. */
export interface ExampleBlock {
  kind: "example";
  weak: string;
  strong: string;
  note?: string;
}

/** Self-quiz: “the prospect says X — what’s your move?” */
export interface DrillBlock {
  kind: "drill";
  prompt: string;
  answer: string;
}

/** The compliance spine — only where the entry touches outcomes, fees, or DNC. */
export interface ComplianceBlock {
  kind: "compliance";
  text: string;
}

export type ManualBlock =
  | ProseBlock
  | ListBlock
  | ExampleBlock
  | DrillBlock
  | ComplianceBlock;

export interface ManualEntry {
  /** Canonical id from the registry (e.g. "obj.cant-afford") — anchor + link target. */
  id: string;
  part: ManualPart;
  /** TOC grouping within the part (e.g. "money", "voss"). */
  section: string;
  title: string;
  /** Search terms; for objections, the things the prospect actually says. */
  aliases?: string[];
  /** The entry’s thesis — one to three sentences a rep absorbs in ten seconds. */
  lead: string;
  blocks: ManualBlock[];
  /** Related entry ids (registry ids only) — rendered as a “See also” row. */
  links?: string[];
}
