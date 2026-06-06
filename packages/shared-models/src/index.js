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
const CxAppointment = require("./CxAppointment");
const CxDialQueue = require("./CxDialQueue");
const DailyCallStat = require("./DailyCallStat");
const DeepCutRun = require("./DeepCutRun");
const DispatchList = require("./DispatchList");
const DncAudit = require("./DncAudit");
const EventRecord = require("../../event-core/src/models/EventRecord");
const HourlyJobEvent = require("./HourlyJobEvent");
const LeadCadence = require("./LeadCadence");
const MailImport = require("./MailImport");
const MailerConfig = require("./MailerConfig");
const MasterProspectIndex = require("./MasterProspectIndex");
const MetricsSnapshot = require("./MetricsSnapshot");
const CallSession = require("./CallSession");
const LeadActivity = require("./LeadActivity");
const LiveCoachSession = require("./LiveCoachSession");
const RcOAuthState = require("./RcOAuthState");
const PacingConfig = require("./PacingConfig");
const PacingReport = require("./PacingReport");
const PaymentAlert = require("./PaymentAlert");
const PaymentLedger = require("./PaymentLedger");
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

const MODEL_REGISTRY = Object.freeze({
  AgentState,
  ActivityAiReview,
  CallLedger,
  CallLog,
  ConsentRecord,
  AuthOtpChallenge,
  CaseProfile,
  ConversationMessage,
  ConversationWorkflow,
  CxAppointment,
  CxDialQueue,
  DailyCallStat,
  DeepCutRun,
  DispatchList,
  DncAudit,
  EventRecord,
  HourlyJobEvent,
  LeadCadence,
  MailImport,
  MailerConfig,
  MasterProspectIndex,
  MetricsSnapshot,
  CallSession,
  LeadActivity,
  LiveCoachSession,
  PacingConfig,
  PacingReport,
  PaymentAlert,
  PaymentLedger,
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
});

function listModels() {
  return Object.keys(MODEL_REGISTRY);
}

module.exports = {
  AgentState,
  ActivityAiReview,
  CallLedger,
  CallLog,
  ConsentRecord,
  AuthOtpChallenge,
  CaseProfile,
  ConversationMessage,
  ConversationWorkflow,
  CxAppointment,
  CxDialQueue,
  DailyCallStat,
  DeepCutRun,
  DispatchList,
  DncAudit,
  EventRecord,
  HourlyJobEvent,
  LeadCadence,
  MailImport,
  MailerConfig,
  MasterProspectIndex,
  MetricsSnapshot,
  CallSession,
  LeadActivity,
  LiveCoachSession,
  PacingConfig,
  PacingReport,
  PaymentAlert,
  MODEL_REGISTRY,
  PaymentLedger,
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
  listModels,
};
