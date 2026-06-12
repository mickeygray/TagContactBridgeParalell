"use strict";

// Resolution intelligence — document text extractor (reading-room harness).
// Dumps the raw text layer of a PDF (or strips an IRS e-Services HTML file)
// so parser design can see exactly what the scrapers will see. Read-only.
//
// Usage:
//   node scripts/resolution-doc-extract.js <file> [maxChars] [--page N]
//
// NOTE: pdf-parse is currently installed --no-save (design phase). It becomes
// a real dependency when the P1 document pipeline lands.

const fs = require("fs");
const path = require("path");

(async () => {
  const file = process.argv[2];
  if (!file) throw new Error("usage: node scripts/resolution-doc-extract.js <file> [maxChars]");
  const max = Number(process.argv[3] || 3000);

  if (/\.html?$/i.test(file)) {
    const html = fs.readFileSync(file, "utf8");
    const text = html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/\n{2,}/g, "\n")
      .trim();
    console.log("HTML", path.basename(file));
    console.log(text.slice(0, max));
    return;
  }

  const { PDFParse } = require("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(file)) });
  const result = await parser.getText();
  const pages = Array.isArray(result.pages) ? result.pages.length : "?";
  console.log("PDF", path.basename(file), "pages:", pages);
  console.log((result.text || "").slice(0, max));
  await parser.destroy();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
