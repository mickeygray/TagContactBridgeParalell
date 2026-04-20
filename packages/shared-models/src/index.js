"use strict";

const AgentState = require("./AgentState");
const ActivityAiReview = require("./ActivityAiReview");
const AuthOtpChallenge = require("./AuthOtpChallenge");
const CaseProfile = require("./CaseProfile");
const ConversationWorkflow = require("./ConversationWorkflow");
const DailyCallStat = require("./DailyCallStat");
const DeepCutRun = require("./DeepCutRun");
const DispatchList = require("./DispatchList");
const EventRecord = require("../../event-core/src/models/EventRecord");
const LeadCadence = require("./LeadCadence");
const MasterProspectIndex = require("./MasterProspectIndex");
const MetricsSnapshot = require("./MetricsSnapshot");
const PaymentAlert = require("./PaymentAlert");
const PaymentLedger = require("./PaymentLedger");
const QualityReview = require("./QualityReview");
const ReviewQueueItem = require("./ReviewQueueItem");
const SourceCanonical = require("./SourceCanonical");
const SpendEntry = require("./SpendEntry");
const WorkflowRecord = require("./WorkflowRecord");

const MODEL_REGISTRY = Object.freeze({
  AgentState,
  ActivityAiReview,
  AuthOtpChallenge,
  CaseProfile,
  ConversationWorkflow,
  DailyCallStat,
  DeepCutRun,
  DispatchList,
  EventRecord,
  LeadCadence,
  MasterProspectIndex,
  MetricsSnapshot,
  PaymentAlert,
  PaymentLedger,
  QualityReview,
  ReviewQueueItem,
  SourceCanonical,
  SpendEntry,
  WorkflowRecord,
});

function listModels() {
  return Object.keys(MODEL_REGISTRY);
}

module.exports = {
  AgentState,
  ActivityAiReview,
  AuthOtpChallenge,
  CaseProfile,
  ConversationWorkflow,
  DailyCallStat,
  DeepCutRun,
  DispatchList,
  EventRecord,
  LeadCadence,
  MasterProspectIndex,
  MetricsSnapshot,
  PaymentAlert,
  MODEL_REGISTRY,
  PaymentLedger,
  QualityReview,
  ReviewQueueItem,
  SourceCanonical,
  SpendEntry,
  WorkflowRecord,
  listModels,
};
