"use strict";

const agentStateRepository = require("./agentStateRepository");
const activityAiReviewRepository = require("./activityAiReviewRepository");
const authOtpChallengeRepository = require("./authOtpChallengeRepository");
const callLedgerRepository = require("./callLedgerRepository");
const callLogRepository = require("./callLogRepository");
const callRecoveryLeadRepository = require("./callRecoveryLeadRepository");
const callRecoveryDailyCohortRepository = require("./callRecoveryDailyCohortRepository");
const consentRecordRepository = require("./consentRecordRepository");
const conversationMessageRepository = require("./conversationMessageRepository");
const conversationWorkflowRepository = require("./conversationWorkflowRepository");
const callSessionRepository = require("./callSessionRepository");
const leadActivityRepository = require("./leadActivityRepository");
const rcOAuthStateRepository = require("./rcOAuthStateRepository");
const cxAgentCallNoteRepository = require("./cxAgentCallNoteRepository");
const cxAppointmentRepository = require("./cxAppointmentRepository");
const cxBulkLoadSessionRepository = require("./cxBulkLoadSessionRepository");
const cxDialQueueRepository = require("./cxDialQueueRepository");
const cxSlowLaneSessionRepository = require("./cxSlowLaneSessionRepository");
const cxTerminalOutboxRepository = require("./cxTerminalOutboxRepository");
const cxCallWrapCardRepository = require("./cxCallWrapCardRepository");
const cxBoringWebhookRepository = require("./cxBoringWebhookRepository");
const dailyCallStatRepository = require("./dailyCallStatRepository");
const eventRepository = require("./eventRepository");
const hourlyJobEventRepository = require("./hourlyJobEventRepository");
const caseProfileRepository = require("./caseProfileRepository");
const deepCutRunRepository = require("./deepCutRunRepository");
const dispatchListRepository = require("./dispatchListRepository");
const dncAuditRepository = require("./dncAuditRepository");
const leadCadenceRepository = require("./leadCadenceRepository");
const leadDeliveryRepository = require("./leadDeliveryRepository");
const mailerConfigRepository = require("./mailerConfigRepository");
const masterProspectRepository = require("./masterProspectRepository");
const metricsSnapshotRepository = require("./metricsSnapshotRepository");
const pacingConfigRepository = require("./pacingConfigRepository");
const pacingReportRepository = require("./pacingReportRepository");
const paymentAlertRepository = require("./paymentAlertRepository");
const paymentLedgerRepository = require("./paymentLedgerRepository");
const postDateHoldRepository = require("./postDateHoldRepository");
const poolBudgetRepository = require("./poolBudgetRepository");
const prePingRepository = require("./prePingRepository");
const qualityReviewRepository = require("./qualityReviewRepository");
const queueItemRepository = require("./queueItemRepository");
const agentSliceRepository = require("./agentSliceRepository");
const reviewQueueRepository = require("./reviewQueueRepository");
const runLockRepository = require("./runLockRepository");
const socialResponderConfigRepository = require("./socialResponderConfigRepository");
const sourceCanonicalRepository = require("./sourceCanonicalRepository");
const spendEntryRepository = require("./spendEntryRepository");
const userAccountRepository = require("./userAccountRepository");
const workflowRecordRepository = require("./workflowRecordRepository");
const trainingCallReviewRepository = require("./trainingCallReviewRepository");
const trainingCourseRepository = require("./trainingCourseRepository");
const trainingFreeCallSessionRepository = require("./trainingFreeCallSessionRepository");

module.exports = {
  agentStateRepository,
  activityAiReviewRepository,
  authOtpChallengeRepository,
  callLedgerRepository,
  callLogRepository,

  callRecoveryLeadRepository,
  callRecoveryDailyCohortRepository,
  caseProfileRepository,
  consentRecordRepository,
  conversationMessageRepository,
  conversationWorkflowRepository,
  callSessionRepository,
  leadActivityRepository,
  rcOAuthStateRepository,
  cxAgentCallNoteRepository,
  cxAppointmentRepository,
  cxBulkLoadSessionRepository,
  cxDialQueueRepository,
  cxSlowLaneSessionRepository,
  cxTerminalOutboxRepository,
  cxCallWrapCardRepository,
  cxBoringWebhookRepository,
  dailyCallStatRepository,
  deepCutRunRepository,
  dispatchListRepository,
  dncAuditRepository,
  eventRepository,
  hourlyJobEventRepository,
  leadCadenceRepository,
  leadDeliveryRepository,
  mailerConfigRepository,
  masterProspectRepository,
  metricsSnapshotRepository,
  pacingConfigRepository,
  pacingReportRepository,
  paymentAlertRepository,
  paymentLedgerRepository,
  postDateHoldRepository,
  poolBudgetRepository,
  prePingRepository,
  qualityReviewRepository,
  queueItemRepository,
  agentSliceRepository,
  reviewQueueRepository,
  runLockRepository,
  socialResponderConfigRepository,
  sourceCanonicalRepository,
  spendEntryRepository,
  userAccountRepository,
  workflowRecordRepository,
  trainingCallReviewRepository,
  trainingCourseRepository,
  trainingFreeCallSessionRepository,
};
