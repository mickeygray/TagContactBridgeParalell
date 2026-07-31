"use strict";

// MONEY GUARDS — the three ways a report quietly reports the wrong number.
//
// Every one of these was hit for real on 2026-07-30 while building the mail
// board, each time producing a figure that looked plausible and was short or
// long by thousands. They live here rather than in each block so there is one
// implementation to get right and one place to test.
//
//   1. ROWS DROPPED BY A FILTER. Grouping by a field that is sometimes blank
//      silently deletes money. `payment.sourceAtSale` is empty on ~35% of
//      cases; filtering mail on it lost $10,258.80 of a $40,710.84 month.
//      groupComplete() cannot drop a row: anything without a key lands in an
//      explicit residual bucket that the caller has to render.
//
//   2. THE SAME MONEY COUNTED TWICE. Crediting a case to whoever called about
//      it put one case on two agents and inflated a total by $1,000.
//      claimOnce() gives each case exactly one owner, by a stated rule.
//
//   3. CHARGEBACKS IGNORED OR MISAPPLIED. Filtering `isChargeback` away
//      reports money we gave back as money we kept. Netting the whole month's
//      chargebacks against initials instead invented a $9,197 hole in new
//      business. netChargebacks() applies a reversal to RECURRING first and
//      only reaches an initial once recurring is exhausted — a reversal can
//      only undo money that was actually taken.
//
// The deal COUNT is never netted: a chargeback un-takes the money, not the
// sale. See the deal-count doctrine — a sale that later reverses is still a
// sale that happened, and netting it hides the reversal instead of showing it.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Apply a case's chargebacks to what that case actually paid.
 *
 * @param {{initial?:number, recurring?:number, chargeback?:number}} row
 *   `chargeback` may be signed either way; magnitude is what matters.
 * @returns {{initial:number, recurring:number, chargeback:number,
 *            initialNet:number, recurringNet:number, unapplied:number}}
 *   `unapplied` is a reversal larger than anything the case paid this range —
 *   real when the original payment landed in an earlier month. It is reported
 *   rather than swallowed so a range can show money leaving that it never
 *   showed arriving.
 */
function netChargebacks(row = {}) {
  const initial = round2(row.initial);
  const recurring = round2(row.recurring);
  const chargeback = round2(row.chargeback);
  let owed = Math.abs(chargeback);

  const recurringNet = round2(Math.max(0, recurring - owed));
  owed = round2(Math.max(0, owed - recurring));
  const initialNet = round2(Math.max(0, initial - owed));
  owed = round2(Math.max(0, owed - initial));

  return {
    initial, recurring, chargeback,
    initialNet, recurringNet,
    unapplied: owed,
  };
}

/**
 * Group rows so that nothing can vanish. A row whose key is blank goes to
 * `residualLabel` instead of being filtered out.
 *
 * @returns {{groups: Map<string, Array>, residual: Array, total: number}}
 */
function groupComplete(rows = [], keyOf, { residualLabel = "(unattributed)" } = {}) {
  const groups = new Map();
  const residual = [];
  for (const row of rows) {
    let key = null;
    try { key = keyOf(row); } catch { key = null; }
    const k = key == null || String(key).trim() === "" ? residualLabel : String(key);
    if (k === residualLabel) residual.push(row);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  return { groups, residual, total: rows.length };
}

/**
 * Give each case exactly one owner. Ties break on `scoreOf` (highest wins),
 * so the rule is explicit rather than "whichever row happened to be last".
 *
 * @returns {Map<string, {owner: *, score: number}>}
 */
function claimOnce(claims = [], { caseOf, ownerOf, scoreOf = () => 0 }) {
  const out = new Map();
  for (const c of claims) {
    const id = caseOf(c);
    if (id == null || String(id).trim() === "") continue;
    const owner = ownerOf(c);
    if (owner == null || String(owner).trim() === "") continue;
    const score = Number(scoreOf(c)) || 0;
    const prior = out.get(String(id));
    if (!prior || score > prior.score) out.set(String(id), { owner, score });
  }
  return out;
}

/**
 * The parts must equal the whole. Returns null when they do, and a sentence
 * fit to print when they do not — a report that cannot balance should say so
 * on its own face rather than be quietly wrong.
 */
function balanceCheck(parts, whole, label = "total", tolerance = 0.01) {
  const sum = round2((Array.isArray(parts) ? parts : []).reduce((s, n) => s + (Number(n) || 0), 0));
  const target = round2(whole);
  if (Math.abs(sum - target) <= tolerance) return null;
  const diff = round2(sum - target);
  return `${label} does not balance: the rows add to ${sum.toFixed(2)} against a total of `
    + `${target.toFixed(2)} (${diff > 0 ? "+" : ""}${diff.toFixed(2)})`;
}

module.exports = {
  balanceCheck,
  claimOnce,
  groupComplete,
  netChargebacks,
  round2,
};
