"use strict";

const { caseProfileRepository } = require("../../shared-repositories/src");
const { createLogicsFacade } = require("./logicsFacadeService");
const { reviewCaseActivities } = require("./activityAiReviewService");
const { recordWorkflowStage } = require("./workflowStateService");

function summarizeActivities(activities = []) {
  const sample = activities.slice(0, 5).map((activity) => ({
    activityId: activity.ActivityID || null,
    subject: activity.Subject || "",
    activityType: activity.ActivityType || "",
    createdDate: activity.CreatedDate || activity.ModifiedDate || null,
  }));

  return {
    total: activities.length,
    sample,
  };
}

function summarizePayments(payments = []) {
  const successful = payments.filter((payment) => {
    const amount = Number(payment.Amount || payment.PaymentAmount || 0);
    return Number.isFinite(amount) && amount > 0;
  });

  const totalAmount = successful.reduce((sum, payment) => {
    return sum + Number(payment.Amount || payment.PaymentAmount || 0);
  }, 0);

  const initialPayments = successful.filter((payment) =>
    String(payment.PaymentType || payment.Type || "")
      .toLowerCase()
      .includes("initial"),
  );

  return {
    total: payments.length,
    successfulCount: successful.length,
    totalAmount,
    initialCount: initialPayments.length,
    initialAmount: initialPayments.reduce(
      (sum, payment) => sum + Number(payment.Amount || payment.PaymentAmount || 0),
      0,
    ),
    latestPaymentDate:
      successful
        .map((payment) => payment.PaymentDate || payment.Date || null)
        .filter(Boolean)
        .sort()
        .slice(-1)[0] || null,
  };
}

function summarizeInvoices(invoices = []) {
  const totalAmount = invoices.reduce((sum, invoice) => {
    const unitPrice = Number(invoice.UnitPrice || 0);
    const quantity = Number(invoice.Quantity || 1);
    return sum + unitPrice * quantity;
  }, 0);

  return {
    total: invoices.length,
    totalAmount,
    sample: invoices.slice(0, 5).map((invoice) => ({
      caseInvoiceId: invoice.CaseInvoiceID || null,
      invoiceTypeId: invoice.InvoiceTypeID || null,
      description: invoice.Description || "",
      date: invoice.Date || null,
      unitPrice: Number(invoice.UnitPrice || 0),
      quantity: Number(invoice.Quantity || 1),
    })),
  };
}

function summarizeBillingSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  return {
    totalFees: Number(summary.TotalFees || 0),
    paidAmount: Number(summary.PaidAmount || 0),
    balance: Number(summary.Balance || 0),
    amountDue: Number(summary.AmountDue || 0),
    dueDate: summary.DueDate || null,
    pastDue: Number(summary.PastDue || 0),
  };
}

async function runClientCaseScrub(domain, caseId, user = null, options = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const numericCaseId = Number(caseId);
  const facade = createLogicsFacade(normalizedDomain);

  const requested = await recordWorkflowStage({
    domain: normalizedDomain,
    family: "client",
    subtype: "manual-scrub",
    stage: "requested",
    aggregateType: "case-profile",
    aggregateId: String(numericCaseId),
    caseId: numericCaseId,
    sourceService: "control-plane",
    title: "Manual client scrub requested",
    summary: `Run client scrub for case ${numericCaseId}`,
    payload: {
      actorEmail: user?.email || null,
      includeActivityReview: options.includeActivityReview !== false,
    },
  });

  try {
    const [billingSummary, activities, payments, invoices] = await Promise.all([
      facade.fetchBillingSummary(numericCaseId),
      facade.fetchActivities(numericCaseId),
      facade.fetchPayments(numericCaseId),
      facade.fetchInvoices(numericCaseId),
    ]);

    let activityReview = null;
    let activityReviewError = null;
    if (options.includeActivityReview !== false) {
      try {
        const reviewResult = await reviewCaseActivities(normalizedDomain, numericCaseId, options.activityReview || {});
        activityReview = reviewResult.ok ? reviewResult.review : null;
        if (!reviewResult.ok) {
          activityReviewError = reviewResult.reason || "activity-review-not-produced";
        }
      } catch (error) {
        activityReviewError = error.message;
      }
    }

    const scrubSummary = {
      status: activityReviewError ? "partial" : "completed",
      reviewedAt: new Date(),
      actorEmail: user?.email || null,
      activityReviewStatus: activityReview?.status || null,
      activityReviewConfidence: activityReview?.confidence || null,
      activityReviewError,
      providers: {
        activities: summarizeActivities(activities),
        payments: summarizePayments(payments),
        invoices: summarizeInvoices(invoices),
        billingSummary: summarizeBillingSummary(billingSummary),
      },
    };

    await caseProfileRepository.upsertCaseProfile(normalizedDomain, numericCaseId, {
      scrubSummary,
      totalPaid: scrubSummary.providers.payments.totalAmount || 0,
      paymentsCount: scrubSummary.providers.payments.successfulCount || 0,
      initialPayment: scrubSummary.providers.payments.initialAmount || 0,
      firstPaymentDate: scrubSummary.providers.payments.initialCount > 0
        ? scrubSummary.providers.payments.latestPaymentDate || null
        : undefined,
      lastPaymentDate: scrubSummary.providers.payments.latestPaymentDate || null,
    });

    const completed = await recordWorkflowStage({
      domain: normalizedDomain,
      family: "client",
      subtype: "manual-scrub",
      stage: "completed",
      aggregateType: "case-profile",
      aggregateId: String(numericCaseId),
      caseId: numericCaseId,
      sourceService: "control-plane",
      title: "Manual client scrub completed",
      summary: `Scrubbed case ${numericCaseId}`,
      payload: {
        actorEmail: user?.email || null,
        scrubSummary,
      },
    });

    return {
      domain: normalizedDomain,
      caseId: numericCaseId,
      requestedWorkflowId: String(requested._id),
      workflowId: String(completed._id),
      scrubSummary,
      activityReview,
    };
  } catch (error) {
    await recordWorkflowStage({
      domain: normalizedDomain,
      family: "client",
      subtype: "manual-scrub",
      stage: "failed",
      aggregateType: "case-profile",
      aggregateId: String(numericCaseId),
      caseId: numericCaseId,
      sourceService: "control-plane",
      title: "Manual client scrub failed",
      summary: error.message || `Scrub failed for case ${numericCaseId}`,
      payload: {
        actorEmail: user?.email || null,
        error: error.message || String(error),
      },
    });
    throw error;
  }
}

module.exports = {
  runClientCaseScrub,
};
