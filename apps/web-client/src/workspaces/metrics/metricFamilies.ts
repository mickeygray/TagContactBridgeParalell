type MetricFamilyKey = "mail" | "bcd" | "ld" | "meta" | "dialer" | "other";

type MetricRowLike = {
  source?: string | null;
  channel?: string | null;
  channelFamilyKey?: string | null;
  spend?: number | null;
  pieces?: number | null;
  clicks?: number | null;
  leadsReported?: number | null;
  count?: number | null;
  totalCalls?: number | null;
  paymentCount?: number | null;
  initialPaymentCount?: number | null;
  initialPayments?: number | null;
  payments?: number | null;
  calls?: number | null;
  deals?: number | null;
  initials?: number | null;
  paid?: number | null;
  callsOver5?: number | null;
};

export const BCD_CPL = 4;
export const LD_CPL = 3;

const VALID_FAMILIES = new Set<MetricFamilyKey>([
  "mail",
  "bcd",
  "ld",
  "meta",
  "dialer",
  "other",
]);

export function resolveMetricFamilyKey(
  channel?: string | null,
  source?: string | null,
): MetricFamilyKey {
  const normalizedChannel = String(channel || "").trim().toLowerCase();
  const normalizedSource = String(source || "").trim().toLowerCase();
  const value = `${normalizedChannel} ${normalizedSource}`;

  if (
    normalizedChannel === "mailer" ||
    normalizedChannel === "mail" ||
    value.includes("direct mail")
  ) {
    return "mail";
  }
  if (
    normalizedChannel === "bcd" ||
    (normalizedChannel === "vendor" && normalizedSource.includes("bcd")) ||
    normalizedSource.includes("bcd")
  ) {
    return "bcd";
  }
  if (
    normalizedChannel === "ld" ||
    normalizedChannel === "ld-posting" ||
    normalizedChannel === "affiliate" ||
    normalizedChannel === "lead-distribution" ||
    normalizedChannel === "lead-data" ||
    /lead data|lead post|affiliate|digital|a\+ leads/.test(normalizedSource)
  ) {
    return "ld";
  }
  if (
    normalizedChannel === "meta" ||
    normalizedChannel === "paid-social" ||
    normalizedChannel === "paid-search" ||
    normalizedChannel === "facebook" ||
    normalizedChannel === "instagram" ||
    normalizedChannel === "tiktok" ||
    normalizedChannel === "social" ||
    /vf meta|meta|facebook|instagram|tiktok|\bfb\b/.test(normalizedSource)
  ) {
    return "meta";
  }
  if (
    normalizedChannel === "dialer" ||
    normalizedChannel === "callfire" ||
    /callfire|dialer|hand dialer|rvm transfer/.test(normalizedSource)
  ) {
    return "dialer";
  }
  if (normalizedChannel.includes("mailer")) {
    return "mail";
  }
  return "other";
}

export function getMetricFamilyKey(row: MetricRowLike): MetricFamilyKey {
  const explicit = String(row.channelFamilyKey || "").trim().toLowerCase();
  if (VALID_FAMILIES.has(explicit as MetricFamilyKey)) {
    return explicit as MetricFamilyKey;
  }
  return resolveMetricFamilyKey(row.channel, row.source);
}

export function getMetricFamilyLabel(family: MetricFamilyKey): string {
  switch (family) {
    case "mail":
      return "Direct Mail";
    case "bcd":
      return "BCD";
    case "ld":
      return "Lead Data";
    case "meta":
      return "Meta";
    case "dialer":
      return "Dialer";
    default:
      return "Other";
  }
}

export function getMetricLeadBasis(
  row: MetricRowLike,
  family = getMetricFamilyKey(row),
): number {
  if (family === "ld") {
    return Number(row.leadsReported ?? row.clicks ?? row.count ?? 0);
  }
  if (family === "meta") {
    return Number(row.leadsReported ?? row.clicks ?? 0);
  }
  return Number(row.callsOver5 ?? 0);
}

export function getMetricDerivedSpend(
  row: MetricRowLike,
  family = getMetricFamilyKey(row),
): number {
  const rawSpend = Number(row.spend ?? 0);
  if (rawSpend > 0) return 0;

  if (family === "bcd") {
    const calls = Number(row.totalCalls ?? row.calls ?? 0);
    return calls > 0 ? calls * BCD_CPL : 0;
  }

  if (family === "ld") {
    const leads = getMetricLeadBasis(row, family);
    return leads > 0 ? leads * LD_CPL : 0;
  }

  return 0;
}

export function getMetricRowValues(row: MetricRowLike) {
  const family = getMetricFamilyKey(row);
  const rawSpend = Number(row.spend ?? 0);
  const derivedSpend = getMetricDerivedSpend(row, family);

  return {
    family,
    spend: rawSpend + derivedSpend,
    rawSpend,
    derivedSpend,
    pieces: Number(row.pieces ?? 0),
    totalCalls: Number(row.totalCalls ?? row.calls ?? 0),
    callsOver5: Number(row.callsOver5 ?? 0),
    leads: getMetricLeadBasis(row, family),
    deals: Number(row.initialPaymentCount ?? row.paymentCount ?? row.deals ?? 0),
    initials: Number(row.initialPayments ?? row.initials ?? 0),
    paid: Number(row.payments ?? row.paid ?? 0),
  };
}

export type { MetricFamilyKey };
