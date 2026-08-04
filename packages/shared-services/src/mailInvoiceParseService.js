"use strict";

// Wizbang daily-mail invoice parser — PURE.
//
// Mickey 2026-07-31: "they have been a little lazy with the g-sheet recently
// but they send me this every day … is this a pdf okay scrape this cost data
// and update a collection we start."
//
// ── WHY THE TOTALS ARE THE PRODUCT AND THE LINE ITEMS ARE NOT ──────────────
//
// A PDF text layer emits COLUMNS, not rows, so adjacent cells arrive
// concatenated with no separator. On the 2026-07-31 invoice the pink-notice
// line extracts as:
//
//     5220.7219$376.85
//
// which is qty 522, unit 0.7219, ext $376.85 — but reads just as naturally as
// qty 5220 at unit .7219. A greedy split takes the second reading, and the
// first parser written here summed the sheet to $1,196.23 while the invoice
// plainly stated $1,234.11. Wrong, and plausible, which is the worst pair.
//
// The LABELLED values have no such ambiguity: "Postage Subtotal:", "Services
// Total:" and the grand total are each a lone money token on their own line.
// So those are the authority, and per-piece numbers are only ever RECONCILED
// against them. If the pieces do not add up to the stated subtotal, this
// returns them flagged rather than pretending — the same rule the report
// blocks already follow: hiding a discrepancy is worse than showing one.

const MONEY = /\$\s*([0-9][0-9,]*\.[0-9]{2})/;
const money = (text) => {
  const m = String(text || "").match(MONEY);
  return m ? Number(m[1].replace(/,/g, "")) : null;
};
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Is this buffer a PDF? Magic bytes, never the filename. */
function isPdf(buffer) {
  if (!buffer || buffer.length < 5) return false;
  return buffer.slice(0, 5).toString("latin1") === "%PDF-";
}

/**
 * Extract the text layer.
 *
 * Deliberately dependency-free: inflate the Flate streams and pull the strings
 * out of the text-showing operators. These invoices carry a real text layer
 * (no /Image, 20 Flate streams), so nothing here needs OCR or poppler — which
 * matters because this has to run on the box, not on a workstation.
 */
function extractPdfText(buffer) {
  const zlib = require("zlib");
  const chunks = [];
  let i = 0;
  for (;;) {
    const s = buffer.indexOf("stream", i);
    if (s < 0) break;
    let a = s + 6;
    if (buffer[a] === 13) a += 1;
    if (buffer[a] === 10) a += 1;
    const e = buffer.indexOf("endstream", a);
    if (e < 0) break;
    try {
      const t = zlib.inflateSync(buffer.slice(a, e)).toString("latin1");
      if (/Tj|TJ/.test(t)) chunks.push(t);
    } catch { /* not a content stream */ }
    i = e + 9;
  }

  const lines = [];
  for (const raw of chunks) {
    let line = [];
    const tokens = raw.match(/\((?:\\.|[^\\)])*\)|Tj|TJ|Td|TD|T\*|ET/g) || [];
    for (const tok of tokens) {
      if (["Td", "TD", "T*", "ET"].includes(tok)) {
        if (line.length) { lines.push(line.join("")); line = []; }
        continue;
      }
      if (tok === "Tj" || tok === "TJ") continue;
      line.push(tok.slice(1, -1)
        .replace(/\\([()\\])/g, "$1")
        .replace(/\\(\d{3})/g, (x, o) => String.fromCharCode(parseInt(o, 8))));
    }
    if (line.length) lines.push(line.join(""));
  }
  return lines.map((l) => l.trim()).filter(Boolean);
}

/**
 * The labelled totals. These are what the collection stores as truth.
 *
 * Each label sits on its own line and the money is on the line BEFORE it —
 * the PDF emits the value column ahead of the label column. Read backwards
 * rather than forwards for exactly that reason.
 */
function readTotals(lines) {
  const out = { postage: null, services: null, total: null };
  // The money follows its label. Measured on the real sheet:
  //   499 "Postage Subtotal:"  ->  500 "$1,009.20"
  //   505 "Services Total:"    ->  506 "$224.91"
  // A `$0.00` also sits immediately BEFORE each label, so reading backwards
  // silently returned zero for both — which looked like a free invoice.
  lines.forEach((line, i) => {
    const label = line.toLowerCase();
    const next = money(lines[i + 1]);
    if (next == null) return;
    if (/postage\s*subtotal/.test(label) && out.postage == null) out.postage = next;
    else if (/services\s*total/.test(label) && out.services == null) out.services = next;
  });
  // Wizbang prints the grand total unlabelled, so take the largest money token
  // and cross-check it against the two subtotals below.
  const candidates = lines.map(money).filter((n) => n != null);
  out.total = candidates.length ? Math.max(...candidates) : null;
  return out;
}

/**
 * Line items, WITH the ambiguity made explicit.
 *
 * `qtyUnitExt` is the concatenated cell. The extended price is unambiguous
 * (it follows a "$"), so quantity is DERIVED from ext/unit rather than parsed
 * — which sidesteps the 522-vs-5220 split entirely. When that derivation does
 * not land on a near-integer the row is returned `confident: false`.
 */
function readLineItems(lines) {
  const items = [];
  // "<digits><unit-with-decimal>$<ext>" — the leading digits are qty and unit
  // run together with no separator.
  const RE = /^(\d[\d.,]*)\$([0-9][0-9,]*\.[0-9]{2})$/;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].trim().match(RE);
    if (!m) continue;
    const head = m[1].replace(/,/g, "");
    const ext = Number(m[2].replace(/,/g, ""));
    const description = (lines[i + 1] || "").trim();
    if (!(ext > 0)) continue;

    // RESOLVE THE SPLIT BY ARITHMETIC, not by regex greed.
    //
    // "5220.7219" is qty|unit with no delimiter, and both 522|0.7219 and
    // 5220|.7219 parse. The EXTENDED price is unambiguous (it follows the $),
    // so try every split point and keep the one where qty * unit lands on the
    // stated ext. That turns a guess into a check — and when no split works,
    // the row says so instead of inventing one.
    const dot = head.indexOf(".");
    let best = null;

    // TWO LAYOUTS, both real on the same invoice. Sometimes qty is glued to the
    // unit price ("5220.7219"); sometimes it sits on its own preceding line and
    // only the unit price is glued to the extension ("0.17000$88.74"). Handle
    // the second by reading the quantity from the line above.
    if (dot === 0 || head.startsWith("0.")) {
      const unit = Number(head);
      const prior = Number(String(lines[i - 1] || "").replace(/,/g, "").trim());
      if (unit > 0 && Number.isInteger(prior) && prior > 0) best = { qty: prior, unit, err: Math.abs(prior * unit - ext) };
    }
    if (!best && dot > 0) {
      for (let cut = 1; cut <= dot; cut += 1) {
        const qty = Number(head.slice(0, cut));
        const unit = Number(head.slice(cut));
        if (!Number.isFinite(qty) || !Number.isFinite(unit) || qty <= 0 || unit <= 0) continue;
        const err = Math.abs(qty * unit - ext);
        if (best == null || err < best.err) best = { qty, unit, err };
      }
    }
    // RELATIVE tolerance. 522 x 0.7219 is $376.8318 against a stated $376.85 —
    // off by 1.8 cents because the DISPLAYED unit price is rounded to four
    // places while the real one is not. An absolute penny threshold rejected
    // the correct split on the two largest lines on the sheet.
    const allow = Math.max(0.02, ext * 0.001);
    const resolved = best && best.err <= allow ? best : null;
    items.push({
      description: description.slice(0, 160),
      quantity: resolved ? resolved.qty : null,
      unitPrice: resolved ? resolved.unit : null,
      extendedPrice: round2(ext),
      // The extension is always trustworthy; the SPLIT is what may not be.
      confident: Boolean(resolved),
      raw: lines[i].trim(),
    });
  }
  return items;
}

/**
 * Parse one Wizbang invoice.
 *
 * Returns `reconciled: false` when the line items do not add up to the stated
 * services subtotal. That is not a parse failure — the totals are still good
 * and still storable — it means the PER-PIECE breakdown must not be trusted
 * for attribution until somebody looks.
 */
function parseMailInvoice(buffer) {
  if (!isPdf(buffer)) throw new TypeError("not a PDF");
  const lines = extractPdfText(buffer);
  if (!lines.length) {
    return { ok: false, reason: "no-text-layer", lines: 0 };
  }

  const at = (re) => {
    const i = lines.findIndex((l) => re.test(l));
    return i >= 0 ? lines[i] : null;
  };
  const after = (re) => {
    const i = lines.findIndex((l) => re.test(l));
    return i >= 0 ? (lines[i + 1] || null) : null;
  };

  const totals = readTotals(lines);
  const items = readLineItems(lines);
  const itemSum = round2(items.reduce((s, x) => s + x.extendedPrice, 0));

  // Vendor + identity. The invoice number is its own line under "Invoice #".
  const invoiceNumber = (after(/^Invoice\s*#$/i) || "").trim() || null;
  const jobName = (after(/Job Name:$/i) || "").trim() || null;

  return {
    ok: true,
    vendor: /wizbang/i.test(lines.join(" ")) ? "wizbang" : null,
    invoiceNumber,
    jobName,
    // The stated figures — the authority.
    postageTotal: totals.postage,
    servicesTotal: totals.services,
    grandTotal: totals.total,
    // The breakdown — evidence, trusted only when it reconciles.
    lineItems: items,
    lineItemSum: itemSum,
    reconciled: totals.total != null && Math.abs(itemSum - totals.total) <= 0.02,
    allItemsConfident: items.every((x) => x.confident),
    lineCount: lines.length,
    headline: at(/^Invoice$/i) ? "invoice" : null,
  };
}

/**
 * Which document is this? STRUCTURAL, never by filename or keyword.
 *
 * The two PDFs the vendor sends every day are built by different tools and it
 * shows in the bytes: the invoice carries no top-level /Font and hides its
 * fonts in object streams; the receipt is a browser print-to-PDF
 * (Producer: Skia/PDF) with /ToUnicode and /Image.
 *
 * Keyword matching would be the obvious approach and it is the wrong one here:
 * the receipt's embedded subset font maps glyphs incorrectly, so its own text
 * decodes as "To1al" and "InvoiceN6mber". A matcher looking for "Total" fails
 * on the very document it is meant to identify.
 *
 * The stake: the receipt states the invoice's GRAND total. Misfiled as an
 * invoice it would post a second $1,234.11 and double the day's mail spend —
 * so anything that is neither is `unknown`, stored and flagged, never guessed
 * into the likelier bucket.
 */
function classifyMailPdf(buffer) {
  if (!isPdf(buffer)) return "not-pdf";
  const head = buffer.toString("latin1");
  if (/\/Producer\s*\(\s*Skia\/PDF/.test(head)) return "receipt";
  const text = extractPdfText(buffer).join(" ");
  if (/wizbang/i.test(text) && /Services\s*Total/i.test(text)) return "invoice";
  return "unknown";
}

/**
 * Decode a receipt's text through its ToUnicode CMaps.
 *
 * Needed because the receipt uses embedded CID fonts. The glyph mapping is
 * imperfect (t->1, u->6), so callers must read NUMBERS, which survive, and
 * treat words as approximate.
 */
function extractCidText(buffer) {
  const zlib = require("zlib");
  const streams = [];
  let i = 0;
  for (;;) {
    const s = buffer.indexOf("stream", i);
    if (s < 0) break;
    let a = s + 6;
    if (buffer[a] === 13) a += 1;
    if (buffer[a] === 10) a += 1;
    const e = buffer.indexOf("endstream", a);
    if (e < 0) break;
    try { streams.push(zlib.inflateSync(buffer.slice(a, e)).toString("latin1")); } catch { /* raw */ }
    i = e + 9;
  }
  const map = new Map();
  for (const s of streams) {
    if (!/beginbfchar|beginbfrange/.test(s)) continue;
    for (const blk of s.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
      for (const m of blk.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        map.set(parseInt(m[1], 16), String.fromCharCode(parseInt(m[2].slice(0, 4), 16)));
      }
    }
    for (const blk of s.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
      for (const m of blk.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const lo = parseInt(m[1], 16); const hi = parseInt(m[2], 16); const dst = parseInt(m[3].slice(0, 4), 16);
        for (let c = lo; c <= hi && c - lo < 512; c += 1) map.set(c, String.fromCharCode(dst + (c - lo)));
      }
    }
  }
  const out = [];
  for (const s of streams) {
    if (!/Tj|TJ/.test(s)) continue;
    for (const t of s.match(/<[0-9A-Fa-f]+>/g) || []) {
      const hex = t.slice(1, -1);
      let acc = "";
      for (let k = 0; k + 1 < hex.length; k += 4) {
        const code = parseInt(hex.slice(k, k + 4), 16);
        acc += map.has(code) ? map.get(code) : "";
      }
      out.push(acc);
    }
  }
  return out.join("");
}

/** Parse the card receipt. Numbers only — the glyph map mangles words. */
function parseMailReceipt(buffer) {
  // CID decode first — the vendor's receipt is a print-to-PDF with embedded
  // subset fonts. Fall back to the ordinary text layer when that yields
  // nothing, because the receipt is only a print-to-PDF by their current
  // habit: change the tool and the fonts stop being CID-encoded. A parser
  // that only handles today's encoding fails silently on the day it changes,
  // and a receipt that reads as empty looks exactly like one that never came.
  const cid = extractCidText(buffer);
  const text = /\d/.test(cid) ? cid : extractPdfText(buffer).join(" ");
  const total = (() => {
    // "To1al:USD1,234.11" — read the amount after USD rather than the word.
    const m = text.match(/USD\s*([0-9][0-9,]*\.[0-9]{2})/);
    return m ? Number(m[1].replace(/,/g, "")) : null;
  })();
  const invoiceNumber = (text.match(/(\d{5,6})Billing/) || text.match(/N6mber:(\d{4,8})/) || [])[1] || null;
  // "31-J6l-2026 10:56:07 MDT" — the month is CORRUPTED by the subset font's
  // glyph map (u renders as 6), so the word cannot be trusted. Undo only the
  // handful of known substitutions, and if the month still does not resolve to
  // one of twelve, keep the raw string and leave the Date null rather than
  // inventing a month. Numbers survive this font; words do not.
  const capturedRaw = (text.match(/(\d{1,2}-[A-Za-z0-9]{3}-\d{4}\s*\d{1,2}:\d{2}:\d{2})/) || [])[1] || null;
  const capturedAt = (() => {
    if (!capturedRaw) return null;
    const fixed = capturedRaw.replace(/-([A-Za-z0-9]{3})-/, (all, mon) => {
      const guess = mon.replace(/6/g, "u").replace(/1/g, "l").replace(/0/g, "o");
      const known = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const hit = known.find((k) => k.toLowerCase() === guess.toLowerCase());
      return hit ? `-${hit}-` : all;
    });
    const d = new Date(`${fixed} UTC`);
    return Number.isFinite(d.getTime()) ? d : null;
  })();
  return {
    ok: total != null,
    total,
    invoiceNumber,
    capturedAt,
    capturedRaw,
    // Tolerant of spacing either way. A throwaway extractor used while
    // exploring this file collapsed the gaps, so the first regex here was
    // written against "AmericanExpressXXXX2014" and matched nothing — the real
    // decode is "American Express XXXX2014". Worth remembering that the scratch
    // tool and the shipped one are not the same reader.
    method: (() => {
      const m = text.match(/(American\s*Express|Amex|Visa|Mastercard|Discover)\s*X*\s*(\d{4})/i);
      return m ? `${m[1].replace(/\s+/g, " ")} ****${m[2]}` : null;
    })(),
    authCode: (text.match(/de:(\d{4,8})/) || [])[1] || null,
    transactionId: (text.match(/ID:(\d{8,20})/) || [])[1] || null,
  };
}

// The vendor names a postage line by its tracking fragment and the matching
// print line by piece name. Both routes resolve to the same canonical source.
const PIECES = Object.freeze([
  { fragment: /9263/, name: /pink/i, source: "3rd Day (Pink) Urgent Third State" },
  { fragment: /6356/, name: /urgent\s*3rd\s*white/i, source: "Urgent Third State" },
  { fragment: /8323/, name: /afford/i, source: "Affordability Federal" },
]);

/**
 * Split the invoice into sections and cost each piece.
 *
 * SECTION comes from whether the description carries a tracking fragment:
 * postage lines do, print/lettershop lines do not. Verified on 2026-07-31 —
 * the fragment lines sum to $971.32 (postage less the card fee) and the rest
 * to $224.91 (the stated services total), so the split is provable rather
 * than positional.
 *
 * PIECES are counted from POSTAGE lines only. The same physical mailer is
 * billed twice — once to print, once to mail — so summing every quantity
 * would report double the mail actually sent.
 */
function derivePerPiece(parsed) {
  const rows = [];
  const unmapped = [];
  const classified = parsed.lineItems.map((item) => {
    const d = item.description || "";
    if (/permit|cc\s*fee/i.test(d) && item.quantity == null) return { ...item, section: "fee", source: null };
    const byFragment = PIECES.find((p) => p.fragment.test(d));
    if (byFragment) return { ...item, section: "postage", source: byFragment.source };
    const byName = PIECES.find((p) => p.name.test(d));
    if (byName) return { ...item, section: "service", source: byName.source };
    unmapped.push(d);
    return { ...item, section: "service", source: null };
  });

  const cardFee = classified.filter((x) => x.section === "fee")
    .reduce((s, x) => s + x.extendedPrice, 0);
  const postageBase = classified.filter((x) => x.section === "postage")
    .reduce((s, x) => s + x.extendedPrice, 0);

  for (const { source } of PIECES) {
    const postageLines = classified.filter((x) => x.section === "postage" && x.source === source);
    const serviceLines = classified.filter((x) => x.section === "service" && x.source === source);
    if (!postageLines.length && !serviceLines.length) continue;
    const postage = round2(postageLines.reduce((s, x) => s + x.extendedPrice, 0));
    const service = round2(serviceLines.reduce((s, x) => s + x.extendedPrice, 0));
    // Pieces from POSTAGE only — see above.
    const pieces = postageLines.reduce((s, x) => s + (x.quantity || 0), 0);
    // The fee rides on postage, so it is allocated by postage share.
    const feeShare = postageBase > 0 ? round2(cardFee * (postage / postageBase)) : 0;
    const total = round2(postage + service + feeShare);
    rows.push({
      source,
      pieces,
      postage,
      service,
      feeShare,
      total,
      costPerPiece: pieces > 0 ? Math.round((total / pieces) * 10000) / 10000 : 0,
    });
  }

  // Per-piece rounding loses (or gains) a cent against the stated fee — the
  // 2026-07-31 sheet allocated $37.89 of a $37.88 fee. Push the remainder onto
  // the largest piece so the allocation is EXACT. A penny that quietly
  // disappears is a penny nobody can later account for.
  const feeAllocated = round2(rows.reduce((s, r) => s + r.feeShare, 0));
  const drift = round2(round2(cardFee) - feeAllocated);
  if (drift !== 0 && rows.length) {
    const biggest = rows.reduce((a, b) => (b.postage > a.postage ? b : a));
    biggest.feeShare = round2(biggest.feeShare + drift);
    biggest.total = round2(biggest.postage + biggest.service + biggest.feeShare);
    biggest.costPerPiece = biggest.pieces > 0 ? Math.round((biggest.total / biggest.pieces) * 10000) / 10000 : 0;
  }
  const allocated = round2(rows.reduce((s, r) => s + r.total, 0));
  return {
    perPiece: rows,
    lineItems: classified,
    cardFee: round2(cardFee),
    unmapped: [...new Set(unmapped)],
    allPiecesMapped: unmapped.length === 0,
    // Every dollar on the invoice must land on a piece or be explained.
    allocated,
    allocationBalances: parsed.grandTotal != null && Math.abs(allocated - parsed.grandTotal) <= 0.02,
  };
}

/** "Daily Mail 7-31" + a year -> 2026-07-31. */
function serviceDateFromJobName(jobName, year) {
  const m = String(jobName || "").match(/(\d{1,2})\s*[-/]\s*(\d{1,2})/);
  if (!m) return null;
  const mm = String(Number(m[1])).padStart(2, "0");
  const dd = String(Number(m[2])).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

module.exports = {
  isPdf,
  classifyMailPdf,
  extractPdfText,
  extractCidText,
  readTotals,
  readLineItems,
  parseMailInvoice,
  parseMailReceipt,
  derivePerPiece,
  serviceDateFromJobName,
  PIECES,
};
