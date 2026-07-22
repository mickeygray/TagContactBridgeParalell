"use strict";

const COMPANY_SUBJECT =
  "(?:you|your\\s+(?:company|firm|business|office|team)|wynn(?:\\s+tax\\s+solutions)?)";

const LOCATION_QUESTION_PATTERNS = [
  new RegExp(
    `\\bwhere\\s+(?:are|is)\\s+${COMPANY_SUBJECT}\\s+(?:based|located|headquartered|from)\\b`,
    "i",
  ),
  new RegExp(
    `\\b(?:what|which)\\s+(?:city|state)\\s+(?:are|is)\\s+${COMPANY_SUBJECT}(?:\\s+(?:in|from))?\\b`,
    "i",
  ),
  new RegExp(
    `\\b(?:are|is)\\s+${COMPANY_SUBJECT}\\s+(?:(?:based|located|headquartered)\\s+)?(?:in|out\\s+of|near)\\b`,
    "i",
  ),
  /\bwhere\s+(?:is|are)\s+(?:your|the)\s+(?:office|company|firm|business|headquarters|hq)\b/i,
  /\bwhat(?:'s|\s+is)\s+(?:your|the)\s+(?:(?:physical|mailing)\s+)?(?:address|location)\b/i,
  /\b(?:do|does)\s+(?:you|your\s+(?:company|firm|business))\s+(?:have|operate)\s+(?:an?\s+)?(?:office|location)\s+(?:in|at|near)\b/i,
];

const LOCATION_CLAIM_PATTERNS = [
  /\b(?:we(?:'re|\s+are)|wynn(?:\s+tax\s+solutions)?\s+is)\s+(?:(?:based|located|headquartered)\s+(?:in|out\s+of|at|near)|from)\b/i,
  /\bour\s+(?:company|firm|business|office|team|headquarters|hq)\s+(?:is|are)\s+(?:(?:based|located|headquartered)\s+(?:in|out\s+of|at|near)|(?:in|at|near))\b/i,
  /\bwe\s+(?:have|operate)\s+(?:an?\s+)?(?:office|location)\s+(?:in|at|near)\b/i,
];

function asksCompanyLocation(text) {
  const body = String(text || "").trim();
  return Boolean(body) && LOCATION_QUESTION_PATTERNS.some((pattern) => pattern.test(body));
}

function containsCompanyLocationClaim(text) {
  const body = String(text || "").trim();
  return Boolean(body) && LOCATION_CLAIM_PATTERNS.some((pattern) => pattern.test(body));
}

module.exports = {
  asksCompanyLocation,
  containsCompanyLocationClaim,
};
