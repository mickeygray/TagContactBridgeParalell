"use strict";

const AgentState = require("./AgentState");
const ActivityAiReview = require("./ActivityAiReview");
const CallLedger = require("./CallLedger");
const CallLog = require("./CallLog");
const ConsentRecord = require("./ConsentRecord");
const AuthOtpChallenge = require("./AuthOtpChallenge");
const CaseProfile = require("./CaseProfile");
const ConversationMessage = require("./ConversationMessage");
const ConversationWorkflow = require("./ConversationWorkflow");
const CxAgentCallNote = require("./CxAgentCallNote");
const CxAppointment = require("./CxAppointment");
const CxBulkLoadSession = require("./CxBulkLoadSession");
const CxDialQueue = require("./CxDialQueue");
const CxSlowLaneSession = require("./CxSlowLaneSession");
const CxTerminalOutbox = require("./CxTerminalOutbox");
const CxCallWrapCard = require("./CxCallWrapCard");
const CxSimpleLoopSession = require("./CxSimpleLoopSession");
const DailyCallStat = require("./DailyCallStat");
const DeepCutRun = require("./DeepCutRun");
const DispatchList = require("./DispatchList");
const DncAudit = require("./DncAudit");
const EventRecord = require("../../event-core/src/models/EventRecord");
const HourlyJobEvent = require("./HourlyJobEvent");
const LeadCadence = require("./LeadCadence");
const LeadDeliveryAgent = require("./LeadDeliveryAgent");
const LeadDeliveryCheckpoint = require("./LeadDeliveryCheckpoint");
const LeadDeliveryEvent = require("./LeadDeliveryEvent");
const LeadDeliveryFairPickCursor = require("./LeadDeliveryFairPickCursor");
const LeadDeliveryItem = require("./LeadDeliveryItem");
const DailyDial = require("./DailyDial");
const MailImport = require("./MailImport");
const MailerConfig = require("./MailerConfig");
const MasterProspectIndex = require("./MasterProspectIndex");
const MetricsSnapshot = require("./MetricsSnapshot");
const MetricClose = require("./MetricClose");
const CallSession = require("./CallSession");
const LeadActivity = require("./LeadActivity");
const LiveCoachSession = require("./LiveCoachSession");
const RcOAuthState = require("./RcOAuthState");
const PacingConfig = require("./PacingConfig");
const PacingReport = require("./PacingReport");
const PaymentAlert = require("./PaymentAlert");
const PaymentLedger = require("./PaymentLedger");
const ActivityEvent = require("./ActivityEvent");
const PaymentTruth = require("./PaymentTruth");
const DailyQueueRollup = require("./DailyQueueRollup");
const MarketingCallLink = require("./MarketingCallLink");
const ReportDefinition = require("./ReportDefinition");
const DailyLoopRun = require("./DailyLoopRun");
const PaymentsSheetImport = require("./PaymentsSheetImport");
const PostDateHold = require("./PostDateHold");
const PoolBudget = require("./PoolBudget");
const PrePing = require("./PrePing");
const QualityReview = require("./QualityReview");
const QueueItem = require("./QueueItem");
const AgentSlice = require("./AgentSlice");
const ReviewQueueItem = require("./ReviewQueueItem");
const RunLock = require("./RunLock");
const SocialResponderConfig = require("./SocialResponderConfig");
const SourceCanonical = require("./SourceCanonical");
const SpendEntry = require("./SpendEntry");
const UserAccount = require("./UserAccount");
const WorkflowRecord = require("./WorkflowRecord");
const ClientProfile = require("./ClientProfile");
const TrainingCallReview = require("./TrainingCallReview");
const TrainingEnrollment = require("./TrainingEnrollment");
const TrainingAttempt = require("./TrainingAttempt");

const MODEL_REGISTRY = Object.freeze({
  AgentState,
  ActivityAiReview,
  ClientProfile,
  CallLedger,
  CallLog,
  ConsentRecord,
  AuthOtpChallenge,
  CaseProfile,
  ConversationMessage,
  ConversationWorkflow,
  CxAgentCallNote,
  CxAppointment,
  CxBulkLoadSession,
  CxDialQueue,
  CxSlowLaneSession,
  CxSimpleLoopSession,
  CxTerminalOutbox,
  CxCallWrapCard,
  DailyCallStat,
  DeepCutRun,
  DispatchList,
  DncAudit,
  EventRecord,
  HourlyJobEvent,
  LeadCadence,
  LeadDeliveryAgent,
  LeadDeliveryCheckpoint,
  LeadDeliveryEvent,
  LeadDeliveryFairPickCursor,
  LeadDeliveryItem,
  DailyDial,
  MailImport,
  MailerConfig,
  MasterProspectIndex,
  MetricsSnapshot,
  MetricClose,
  CallSession,
  LeadActivity,
  LiveCoachSession,
  PacingConfig,
  PacingReport,
  PaymentAlert,
  PaymentLedger,
  ActivityEvent,
  PaymentTruth,
  DailyQueueRollup,
  MarketingCallLink,
  ReportDefinition,
  DailyLoopRun,
  PaymentsSheetImport,
  PostDateHold,
  PoolBudget,
  PrePing,
  QualityReview,
  QueueItem,
  AgentSlice,
  RcOAuthState,
  ReviewQueueItem,
  RunLock,
  SocialResponderConfig,
  SourceCanonical,
  SpendEntry,
  UserAccount,
  WorkflowRecord,
  TrainingCallReview,
  TrainingEnrollment,
  TrainingAttempt,
});

function listModels() {
  return Object.keys(MODEL_REGISTRY);
}

module.exports = {
  AgentState,
  ActivityAiReview,
  ClientProfile,
  CallLedger,
  CallLog,
  ConsentRecord,
  AuthOtpChallenge,
  CaseProfile,
  ConversationMessage,
  ConversationWorkflow,
  CxAgentCallNote,
  CxAppointment,
  CxBulkLoadSession,
  CxDialQueue,
  CxSlowLaneSession,
  CxSimpleLoopSession,
  CxTerminalOutbox,
  CxCallWrapCard,
  DailyCallStat,
  DeepCutRun,
  DispatchList,
  DncAudit,
  EventRecord,
  HourlyJobEvent,
  LeadCadence,
  LeadDeliveryAgent,
  LeadDeliveryCheckpoint,
  LeadDeliveryEvent,
  LeadDeliveryFairPickCursor,
  LeadDeliveryItem,
  DailyDial,
  MailImport,
  MailerConfig,
  MasterProspectIndex,
  MetricsSnapshot,
  MetricClose,
  CallSession,
  LeadActivity,
  LiveCoachSession,
  PacingConfig,
  PacingReport,
  PaymentAlert,
  MODEL_REGISTRY,
  PaymentLedger,
  ActivityEvent,
  PaymentTruth,
  DailyQueueRollup,
  MarketingCallLink,
  ReportDefinition,
  DailyLoopRun,
  PaymentsSheetImport,
  PostDateHold,
  PoolBudget,
  PrePing,
  QualityReview,
  QueueItem,
  AgentSlice,
  RcOAuthState,
  ReviewQueueItem,
  RunLock,
  SocialResponderConfig,
  SourceCanonical,
  SpendEntry,
  UserAccount,
  WorkflowRecord,
  TrainingCallReview,
  TrainingEnrollment,
  TrainingAttempt,
  listModels,
};
