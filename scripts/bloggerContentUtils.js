"use strict";

// Shared blogger content helpers. ONE canonical splitBodyIntoBlocks — both the
// current-event generator (blogger-current-event.js) and the legacy claude writer
// (blogger-claude-writer.js) turn the model's single `bodyHtml` string into the
// array-of-block-elements shape blogData wants. (Draft-field assembly is NOT
// shared: current-event uses model output, the legacy writer re-attaches seed
// metadata — different shapes on purpose.)
function splitBodyIntoBlocks(html) {
  const text = String(html || "").trim();
  if (!text) return [];
  // Match each block-level element (<h1-6>, <p>, <ul>, <ol>, <blockquote>,
  // <figure>, <hr>) greedily on the same tag, non-overlapping across tags.
  const blocks = text.match(
    /<(h[1-6]|p|ul|ol|blockquote|figure|hr)\b[^>]*>[\s\S]*?<\/\1>/gi,
  );
  if (blocks && blocks.length > 0) return blocks.map((b) => b.trim());
  // Fallback: split by blank lines.
  return text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
}

module.exports = { splitBodyIntoBlocks };
