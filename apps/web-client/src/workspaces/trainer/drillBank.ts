// Drill bank — the field manual's `drill` blocks, surfaced as quizzes.
//
// Every manual entry that carries a drill ("the prospect says X — what's your
// move?") becomes a fixed quiz question whose reference answer is the house
// answer from the guide. The trainee answers free-text; the backend grades
// substance against the reference under the analyst doctrine
// (POST /api/sales-trainer/quiz/grade). Zero new content to maintain — the
// guide IS the quiz bank, so authoring a manual entry authors its drill.

import { ALL_ENTRIES, PARTS } from "../field-manual/content";
import type { ManualEntry } from "../field-manual/content";

export interface DrillQuestion {
  /** stable id: `<entryId>#<index>` */
  id: string;
  entryId: string;
  entryTitle: string;
  part: ManualEntry["part"];
  section: string;
  prompt: string;
  referenceAnswer: string;
}

export interface DrillTopic {
  key: string; // `${part}/${section}`
  partTitle: string;
  sectionTitle: string;
  questions: DrillQuestion[];
}

function partMeta(part: ManualEntry["part"]) {
  return PARTS.find((p) => p.id === part) || null;
}

function sectionTitle(part: ManualEntry["part"], section: string) {
  const meta = partMeta(part);
  const hit = meta?.sections.find((s) => s.id === section);
  return hit?.title || section;
}

export function buildDrillBank(): DrillTopic[] {
  const byTopic = new Map<string, DrillTopic>();
  for (const entry of ALL_ENTRIES) {
    entry.blocks.forEach((block, index) => {
      if (block.kind !== "drill") return;
      const key = `${entry.part}/${entry.section}`;
      let topic = byTopic.get(key);
      if (!topic) {
        topic = {
          key,
          partTitle: partMeta(entry.part)?.title || entry.part,
          sectionTitle: sectionTitle(entry.part, entry.section),
          questions: [],
        };
        byTopic.set(key, topic);
      }
      topic.questions.push({
        id: `${entry.id}#${index}`,
        entryId: entry.id,
        entryTitle: entry.title,
        part: entry.part,
        section: entry.section,
        prompt: block.prompt,
        referenceAnswer: block.answer,
      });
    });
  }
  // Keep manual reading order: PARTS order, then section order within the part.
  const partOrder = new Map(PARTS.map((p, i) => [p.id, i] as const));
  const sectionOrder = new Map<string, number>(
    PARTS.flatMap((p) => p.sections.map((s, i) => [`${p.id}/${s.id}`, i] as [string, number])),
  );
  return [...byTopic.values()].sort((a, b) => {
    const pa = partOrder.get(a.questions[0]?.part) ?? 99;
    const pb = partOrder.get(b.questions[0]?.part) ?? 99;
    if (pa !== pb) return pa - pb;
    return (sectionOrder.get(a.key) ?? 99) - (sectionOrder.get(b.key) ?? 99);
  });
}

export function pickDrillSet(topic: DrillTopic, count: number, seed = Date.now()): DrillQuestion[] {
  // Deterministic-enough shuffle (mulberry32) so a session's set is stable
  // but different sessions vary.
  let a = seed >>> 0;
  const rand = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pool = [...topic.questions];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(1, Math.min(count, pool.length)));
}
