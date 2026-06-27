"use strict";

// The riff reference — organized into broad sections, trimmed of redundancy and
// commentary: the approved Tax Group METHOD (backbone) + a TACTICS list + an
// OBJECTIONS list + a general TAX list. The product is representation + compliance,
// so tax stays general. No overlapping objection layers, no self-commenting prose.

const { OBJECTION_PLAYBOOK } = require("./liveCoachObjectionBank");
const { RIFF_SYSTEM } = require("./coachRiff");
const { TAX_GROUP_SCRIPT } = require("./taxGroupScript");
const { buildTacticsSection } = require("./coachTacticsDeep");

// OBJECTIONS — one terse line per objection: reframe + primary move + one example
// line. The generic mechanics (boomerang, isolate, etc.) live in the TACTICS section,
// so the bank's doctrine header is dropped here.
function formatObjectionsSection() {
  const lines = ["OBJECTIONS — the play for each (adapt the lines, never read verbatim):"];
  for (const e of OBJECTION_PLAYBOOK) {
    const p = e.playbook || {};
    if (e.family === "compliance_dnc") {
      lines.push(`- ${e.label}: TERMINAL — honor immediately, confirm removal, end politely; never overcome.`);
      continue;
    }
    const move = (p.moves && p.moves[0]) || "";
    const line = (p.lines && p.lines[0]) || "";
    lines.push(`- ${e.label}: ${p.reframe || p.read}${move ? " | Move: " + move : ""}${line ? " | Ex: " + line : ""}`);
  }
  return lines.join("\n");
}

// TAX — general knowledge only.
const TAX_SECTION = `TAX (answer generally — the offering is representation + compliance, never a guaranteed outcome):
- Collections escalate: CP14 (first notice) -> CP504 (intent to levy) -> LT11 / Letter 1058 (final notice + hearing right) -> levy (seizes bank/wages) or lien.
- Levy / garnishment: the IRS takes funds or paycheck until paid or released; representation can request a release.
- Lien: secures the IRS claim (paid first if you sell or liquidate); doesn't seize immediately.
- Unfiled returns: the IRS files substitutes that inflate the balance; representation pulls wage & income data and files correctly. Compliance (filing) gates every resolution.
- Resolution options: Installment Agreement (monthly), Offer in Compromise (settle for less — rare/strict, NEVER promise), Currently Not Collectible (hardship pause), Penalty Abatement (reasonable cause / first-time).
- Representation: Forms 2848 (limited POA) + 8821 (info authorization) + state POA let the firm speak to the IRS and pull the full file. A CPA filing returns is NOT active collection representation.
- Business/payroll, capital gains, self-employment: trigger mismatch notices and blended liability; representation separates and verifies. Keep tax answers general — the value is getting represented and seeing the real file.`;

// buildReferenceBody() -> the content only (no framing): method backbone + the
// three lists. Shared by the riff and the unified coach so they reference the same
// material under different output contracts.
function buildReferenceBody() {
  return [
    TAX_GROUP_SCRIPT, // the approved methodology — the BACKBONE
    "",
    buildTacticsSection(), // the tactics list
    "",
    formatObjectionsSection(), // the objections list
    "",
    TAX_SECTION, // the (general) tax list
  ].join("\n");
}

// buildRiffLibrarySystem() -> riff framing + the reference body.
function buildRiffLibrarySystem() {
  return [RIFF_SYSTEM, "", buildReferenceBody()].join("\n");
}

module.exports = { TAX_SECTION, formatObjectionsSection, buildReferenceBody, buildRiffLibrarySystem };
