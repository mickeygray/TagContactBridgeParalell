"use strict";

const {
  bumpLastActivityAt,
  deriveActivityState,
  deriveFreshLeadGate,
  getCxAgentStateByExtensionId,
  listCxAgentStates,
  mirrorAgentState,
  setActivityState,
  touchCxWorkspacePresence,
} = require("./agentAvailabilityService");
const {
  isOperatingNow,
  isChannelOperatingNow,
  clampToOperatingHours,
  clampToChannelOperatingHours,
  nextOperatingMomentAfter,
  formatHourBucket: formatPacingHourBucket,
} = require("./businessHoursGuard");
const {
  getConfig: getPacingConfig,
  updateConfig: updatePacingConfig,
  getHistory: getPacingConfigHistory,
  validatePatch: validatePacingPatch,
  bumpCacheVersion: bumpPacingConfigCache,
} = require("./pacingConfigService");
const {
  refillPool,
  emptinessWatcherTick,
  refreshPoolOccupancy,
  enqueueLead,
} = require("./universalQueueService");
const {
  isAgentEligibleForSlice,
  computeTargetMix,
  issueSlice,
  releaseSlice,
  releaseSliceById,
  recordItemDispositioned,
  maybeCompleteSlice,
} = require("./agentSliceService");
const {
  assignOne: assignFreshLead,
  drainPending: drainPendingFreshLeads,
  expirySweep: freshLeadExpirySweep,
  onAgentBecomesEligible,
  listEligibleIdleAgents,
} = require("./freshLeadAssignmentService");
const {
  reapTick: idleReaperTick,
} = require("./idleReaperService");
const {
  computePacingReport,
  getReport: getPacingReport,
  listRecentReports: listRecentPacingReports,
  formatReportText: formatPacingReportText,
} = require("./pacingReportService");
const {
  runHourly: runHourlyPacing,
  runMorningPrep: runMorningPacingPrep,
} = require("./hourlyPacingOrchestrator");
const {
  DISPOSITION_MAP,
  listDispositions,
  getDisposition,
  validateDisposition,
  computeNextTouchAt,
} = require("./dispositionMapService");
const cxTokenStorageService = require("./cxTokenStorageService");
const cxOAuthService = require("./cxOAuthService");
const {
  ensureRingcxAgentOffhookAllowed,
  resolveRingcxAgentIdentity,
} = require("./ringcxAgentSelfHealService");
const {
  placeCall: dialPlaceCall,
  terminateAndDispose: dialTerminateAndDispose,
  reconcileCallEnded: dialReconcileCallEnded,
  reconcileCallConnected: dialReconcileCallConnected,
  materializeInboundCall: dialMaterializeInboundCall,
  sweepStaleStates: dialSweepStaleStates,
  buildLogicsCaseUrl,
  sanitizeUsPhone,
} = require("./dialService");
const {
  buildNextAssignmentStats,
  deriveQueueFamily: deriveCxQueueFamily,
  listEligibleAgentsForCx,
  normalizeAssignmentStats,
  normalizeQueueFamily: normalizeCxQueueFamily,
  rankAgentsForQueueItem,
} = require("./cxLoadBalancerService");
const {
  CONTROL_PLANE_EVENT_TYPES,
  createControlPlaneEvent,
  processControlPlaneEventBatch,
  processNextControlPlaneEvent,
} = require("./controlPlaneEventService");
const {
  buildCampaignAudience,
} = require("./campaignAudienceService");
const {
  extractCadenceEmailIndex,
  extractCadenceSmsIndex,
  resolveCadenceEmailContent,
  resolveCadenceSmsContent,
} = require("./cadenceContentService");
const {
  evaluateCounterCadenceDueItems,
  getCounterCadenceCounters,
  getCounterCadenceLastTouched,
  getCounterCadenceTemplateKey,
  isWeekdayBatchTime: isCounterCadenceBatchTime,
  pollCounterCadenceRvmDispositions,
  recordCounterCadenceTouch,
  runCounterCadenceSweep,
  selectCounterCadenceDueItems,
} = require("./counterCadenceService");
const {
  buildCallLog,
  buildRingcentralPollingRuntime,
} = require("./callLogService");
const {
  seedRingcentralExtensionsFromCsv,
} = require("./ringcentralExtensionSeedService");
const {
  reconcileUnattributedSessions,
} = require("./ringcentralReconcileService");
const {
  runRingCentralCallLogSweep,
} = require("./ringcentralCallLogSweepService");
const {
  SHORT_CIRCUIT_INTAKE_SOURCES,
  resolveInboundCallSource,
} = require("./callAttributionResolverService");
const { buildMetricsPulse } = require("./metricsPulseService");
const { buildSimpleMarketingSummary } = require("./simpleMarketingReadService");
const { syncCallrailDailyStats } = require("./callrailDailyStatSyncService");
const { importLogicsPaymentsCsv } = require("./logicsPaymentsCsvImportService");
const {
  evaluatePaymentsSheetGate,
  readPaymentsSheetStatus,
  recordPaymentsSheetImport,
  verifyPaymentsCsvDomain,
} = require("./paymentsSheetGateService");
const { reconcileSheetCases } = require("./paymentsSheetReconcileService");
const { emitServiceRequest } = require("./serviceRequestService");
const {
  syncUsersFromRcExtensions,
} = require("./userProvisioningService");
const {
  buildAgentCallStats,
  getOrComputeAgentCallStats,
  invalidateAgentCallStatsSnapshot,
} = require("./agentCallStatsService");
const {
  buildBlogBotStatus,
} = require("./blogBotStatusService");
const {
  isConfigured: isTranscriptionConfigured,
  processCallLogRecording,
} = require("./transcriptionScoringService");
const {
  isRecordingArchiveConfigured,
  isRingcxRecordingEnabled,
  processCallRecordingArchive,
  queueCallRecordingArchiveJob,
} = require("./recordingArchiveService");
const {
  computeWindow: computeCxRecordingHourlyWindow,
  runCxRecordingHourly,
} = require("./cxRecordingHourlyService");
const {
  countLegacyContactActivities,
  listLegacyContactActivities,
} = require("./legacyContactActivityService");
const { runProspectSweep } = require("./prospectCleanerService");
const {
  ACTION_KEYS: DEPLOY_ACTION_KEYS,
  buildDeployState,
  buildLocalDeployState,
  cancelDeployRun,
  listDeployRuns,
  runLocalDeployCommand,
  triggerDeploy,
} = require("./deployOrchestrationService");
const {
  buildCxCallQueue,
  buildCxQueueForAgent,
  buildCxQueuesForAgents,
  buildCxWorkspace,
  listCxPlacedCallsToday,
  executeCxAppointmentWorkbenchActions,
  executeCxCallSummary,
  executeCxLogicsCreateCase,
  executeCxSaveCaseProfileFromLogics,
  executeCxLogicsFindMatch,
  executeCxLogicsActivity,
  executeCxInterviewSnapshot,
  executeCxLogicsAmortization,
  executeCxLogicsInvoice,
  executeCxLogicsNotes,
  executeCxLogicsTask,
  executeCxLogicsUpdateCase,
  listCxLogicsTasks,
  listCxPostDateHolds,
  listCxTasks,
  lookupCxLogicsMatch,
  requestCxAssignCaseToMe,
  requestCxDial,
  requestCxEndCall,
  requestCxDisposition,
  requestCxEmail,
  requestCxLogicsCreateCase,
  requestCxLogicsFindMatch,
  requestCxLeadStatusUpdate,
  releaseCxPostDateHold,
  requestCxReminder,
  requestCxStatusChange,
  requestCxTask,
  requestCxText,
  runPostDateHoldEodSweep,
  searchCxCases,
  enqueueCxSmokeLead,
  simulateCxIncomingCall,
} = require("./cxWorkspaceService");
const { requestCxVoicemailDrop, listVmDropThemes, vmDropMode } = require("./cxVoicemailDropService");
const {
  CX_CADENCE_EVENT_TYPES,
  buildCxCadenceRuntimeSnapshot,
  claimNextCxQueueItem,
  completeCxQueueItem,
  createCxCallPlacedEvent,
  createCxCallTerminalOutcomeEvent,
  classifyCxTerminalOutcome,
  handleCxTerminalCallOutcome,
  recordMinimalTerminalResolution,
  processCxCadenceEventBatch,
  processNextCxCadenceEvent,
  queueCxDialRequest,
  releaseManualUnavailableAgentQueues,
  releaseCxQueueBatch,
} = require("./cxCadenceService");
const {
  LANES: CX_LANES,
  buildLaneExternId,
  parseLaneFromExternId,
  parseAgentQueueMap,
} = require("./cxLaneRegistry");
const { createCxFirstTouchDispatcher } = require("./cxFirstTouchDispatchService");
const {
  createCxCallerIdRotationService,
  filterRotationConfig: filterCxCallerIdRotationConfig,
  loadRotationConfig: loadCxCallerIdRotationConfig,
} = require("./cxCallerIdRotationService");
const { createCxAppointmentDispatcher } = require("./cxAppointmentDispatchService");
const { createCxSeanFirstTouchDrip } = require("./cxSeanFirstTouchDripService");
const { getLaneCall } = require("./cxLaneCallRegistry");

const {
  computeFreshHotLaneWindow,
  getFreshHotLaneSnapshot,
  rebuildFreshHotLane,
  runFreshHotLaneAllocator,
} = require("./cxFreshHotLaneService");
const {
  buildCxCommLog,
} = require("./cxCommLogService");
const {
  cancelCxAppointmentsForCase,
  createCxAppointment,
  fireCxAppointmentNow,
  listCxAppointments,
  releaseCxAppointment,
  resolveCxAppointmentAfterDisposition,
  runDueCxAppointments,
} = require("./cxAppointmentService");
const {
  publishQueueItemToRingcx,
} = require("./ringcxLeadServingService");
const {
  executeCxDispatchIntent,
  executeCxHangupRequest,
} = require("./ringcxDialExecutionService");
const {
  runRingcxAgentMonitor,
} = require("./ringcxAgentMonitorService");
const {
  getCxBucketLiveRead,
  getCxBucketSnapshotForExtension,
  isCxBucketDebugReadEnabled,
  isCxBucketShadowEnabled,
} = require("./cxDialQueueMediatorService");
const {
  advanceCxSimpleLoopSession,
  getCxSimpleLoopSession,
  killCxSimpleLoopSession,
  reduceCxSimpleLoopSession,
  skipCxSimpleLoopCurrent,
  startCxSimpleLoopSession,
  submitCxSimpleLoopDisposition,
} = require("./cxSimpleCallLoopService");
const {
  CX_BULK_LOAD_PHASES,
  reduceCxBulkLoadState,
} = require("./cxBulkLoadStateMachine");
const {
  confirmCxSlowSingleCurrent,
  getCxSlowSingleSession,
  killCxSlowSingleSession,
  normalizeSlowSingleOutcome,
  startCxSlowSingleCall,
  submitCxSlowSingleOutcome,
} = require("./cxSlowLaneService");
const {
  getCxBulkLoadSession,
  killCxBulkLoadSession,
  pauseCxBulkLoadProgressiveDialing,
  resumeCxBulkLoadProgressiveDialing,
  skipCxBulkLoadCurrent,
  startCxBulkLoadGetLeads,
  startCxBulkLoadSession,
  syncCxBulkLoadActiveCall,
  submitCxBulkLoadDisposition,
  submitCxLaneCallDisposition,
  submitCxBulkLoadReviewOutcome,
  watchCxBulkLoadAccountActiveCalls,
} = require("./cxBulkLoadRuntime");
const {
  buildCxAccountActiveCallWatchPlan,
  runCxAccountActiveCallWatchOnce,
} = require("./cxAccountActiveCallWatcherService");
const { createCxQueueReservationService } = require("./cxQueueReservationService");
const { createCxReservationReconcilerService } = require("./cxReservationReconcilerService");
const {
  createCxStaleServingReconcilerService,
  classifyStaleServingRow,
  resolveServingIdentity,
} = require("./cxStaleServingReconcilerService");
const { createCxTerminalOutboxDrain } = require("./cxTerminalOutboxDrain");
const {
  ACTIONS: CX_BORING_WEBHOOK_ACTIONS,
  OUTCOMES: CX_BORING_WEBHOOK_OUTCOMES,
  actionForEvent: actionForCxBoringWebhookEvent,
  classifyDisposition: classifyCxBoringWebhookDisposition,
  createCxBoringWebhookActionDrain,
  createCxBoringWebhookCallPoller,
  createCxBoringWebhookService,
  normalizeRingcxWebhook: normalizeCxBoringRingcxWebhook,
  parseDirectExternId: parseCxBoringDirectExternId,
} = require("./cxBoringWebhookService");
const {
  buildCxCallWrapBody,
  buildCxCallWrapThreadKey,
  normalizeCxCallWrapPacket,
  writeCxCallWrapSummary,
} = require("./cxCallWrapService");
const {
  createCxCallWrapCardService,
  wrapCardNeeded,
  RESOLUTION_RULES: CX_WRAP_RESOLUTION_RULES,
} = require("./cxCallWrapCardService");
const {
  buildBadNumberAlertEmail,
  createCxBadNumberOutcomeHandler,
  isBadNumberOutcome,
} = require("./cxBadNumberOutcomeService");
const { buildReviewCorrectionRow: buildCxReviewCorrectionRow } = require("./cxBulkLoadOutcomeAdapter");
const {
  buildAgentCallNoteFromCloseout,
  buildAgentCallNoteFromTerminal,
  hasGradeEvidence: hasAgentCallNoteGradeEvidence,
  noteKeyFrom: agentCallNoteKeyFrom,
  writeAgentCallNoteFromCloseout,
  writeAgentCallNoteFromTerminal,
} = require("./cxAgentCallNoteService");
const {
  buildTerminalOutboxPayloadFromEvidence,
  buildTerminalRectificationIdemKey,
  classifyRectificationEvidence,
  extractRectificationKeysFromCallLog,
  isRealRingcxUii,
  normalizeRectificationWindow,
  runCxTerminalRectification,
} = require("./cxTerminalRectificationService");
const {
  makeOutcomeIdemKey,
  buildTerminalEvidenceKeys,
} = require("./cxBulkLoadOutcomeAdapter");
const { buildFamilyTargets } = require("./cxReserveModeService");
const {
  alphaTraceEnabled,
  logCxAlpha,
  redactCxAlphaPayload,
  traceMatchesFilter: traceCxAlphaMatchesFilter,
} = require("./cxAlphaTraceService");
const {
  buildControlPlaneHealthReport,
  buildProviderHealth,
  recordServiceAlert,
} = require("./controlPlaneHealthService");
const {
  approveInboxWorkflow,
  cancelInboxWorkflow,
  dncInboxWorkflow,
  editSendInboxWorkflow,
  regenerateInboxWorkflow,
  sleepInboxWorkflow,
  wakeInboxWorkflow,
} = require("./inboxCommandService");
const {
  autoRouteHotInboundWorkflow,
  isAvailableForHotIntent,
  listAvailableHotIntentAgents,
} = require("./hotIntentRouterService");
const {
  relayControlPlaneEvent,
  relayMetricObserved,
  relayReviewItemObserved,
  relayRingcentralTelephonyForwarded,
} = require("./controlPlaneRelayService");
const {
  buildControlPlaneReadOverview,
  listPresentationCaseProfiles,
  listPresentationPayments,
  listPresentationProspects,
} = require("./controlPlaneReadService");
const {
  buildClientDetail,
  buildClientWorkspaceList,
  buildDeployWorkspace,
  buildInboxWorkspace,
  buildLibraryWorkspace,
  buildReviewWorkspace,
  buildRingBridgeWorkspace,
  buildRingCentralWorkspace,
  listRingCentralEvents,
  listReviewWorkspaceItems,
  searchClientWorkspace,
} = require("./frontendReadService");
const {
  recordConversationAi,
  recordQualityReview,
} = require("./caseIntelligenceService");
const {
  classifyActivityForAttribution,
  extractMailerLabel,
  parseSuccessfulPayments,
  resolveCanonicalAttribution,
  summarizeSuccessfulPayments,
} = require("./attributionEnrichmentService");
const { buildContactLibraryCatalog } = require("./contactLibraryService");
const { runClientCaseScrub } = require("./clientScrubService");
const { reviewCaseActivities } = require("./activityAiReviewService");
const { REPORTS, generateReport } = require("./reportingService");
const reportOps = require("./reportOpsService");
const reportDefinitions = require("./reportDefinitionService");
const sourceSanitizer = require("./logicsSourceSanitizerService");
const queueRollup = require("./queueRollupService");
const marketingCallLinks = require("./marketingCallLinkService");
const { createGatherSession, pruneGatherCache } = require("./gatherSessionService");
const {
  classifyRow,
  insertActivityEvents,
  parseReportRows,
} = require("./activityEventService");
const { listLastMonthInboundCalls, lookupInboundCall } = require("./callrailLookupService");
const { buildControlPlaneSummary, getControlPlaneDomain, listControlPlaneDomains } = require("./controlPlaneService");
const { buildDataHygieneOverview, runDataHygieneSmoke } = require("./dataHygieneService");
const {
  buildDailyDeepCutDashboard,
  buildDailyDeepCutPlan,
  getDailyDeepCutRun,
  listDailyDeepCutRuns,
  recordDailyDeepCutRun,
  startDailyDeepCutRun,
  startDailyDeepCutVerification,
} = require("./dailyDeepCutService");
const {
  runGroupedNightlyClose,
  reconcilePhoneBurnerCallsForNightly,
  sendOpsStatusEmail,
  sendAgedRefreshReportEmail,
  wrapHourlyJobs,
} = require("./nightlyCloseService");
const { publishDemoEvent } = require("./demoEventService");
const {
  buildDispatchList,
  getDispatchList,
  listDispatchLists,
  queueDispatchList,
} = require("./dispatchListService");
const {
  buildScheduledBlastRuntimeSnapshot,
  previewScheduledBlast,
  queueScheduledBlast,
  resolveScheduledBlastRule,
  runScheduledBlastSweep,
} = require("./scheduledBlastService");
const {
  buildWorkList,
  getWorkList,
  listWorkLists,
  queueWorkList,
} = require("./workListService");
const {
  listWorkflowStages,
  recordWorkflowStage,
} = require("./workflowStateService");
const {
  resolveCaseContactEligibility,
  stopCaseContact,
  resolveUpsellContactEligibility,
  getUpsellContactAllowList,
} = require("./contactEligibilityService");
const {
  sendUpsellContact,
  sendBulkUpsellContact,
} = require("./resolutionContactService");
const {
  buildProspectBlast,
  planProspectBlast,
  loadProspectBlast,
} = require("./predictiveCampaignService");
const blastJobStore = require("./blastJobStore");
const {
  buildHourlyHygienePlan,
  listHourlyReviewFeed,
  pushHourlyReviewItem,
} = require("./hourlyHygieneService");
const {
  runHourlyLeadCadenceEnforcement,
} = require("./hourlyLeadCadenceEnforcementService");
const {
  runHourlyCallLogHygiene,
  runHourlyCallLogHygieneForDomain,
} = require("./hourlyCallLogHygieneService");
const {
  claimNextHourlyJobEvent,
  computeNextLaneRunAt,
  emitHourlyJobEvent,
  listHourlyJobEvents,
  markHourlyJobCompleted,
  markHourlyJobFailed,
  notifyHourlyJobAlert,
} = require("./hourlyJobEventService");
const {
  TEMPLATE_CATALOG: EMAIL_TEMPLATE_CATALOG,
  listTemplates: listEmailTemplates,
  renderEmailTemplate,
} = require("./emailTemplateService");
const { lookupCxLead, findCxLeadCandidates } = require("./cxLeadLookupService");
const hourlyJobHandlerRegistry = require("./hourlyJobHandlerRegistry");
const hourlyJobResolutionCheckRegistry = require("./hourlyJobResolutionCheckRegistry");
// Requiring the built-in checks + handler modules registers them as a
// side effect. Handler module uses lazy requires inside each handler
// so it's safe to load here even though it indirectly references other
// services in the same package.
require("./hourlyJobResolutionChecks");
require("./hourlyJobHandlers");
const {
  drainHourlyJobQueue,
  runHourlySweep,
  sendResolutionEmails,
  summarizeHourlySweepResult,
} = require("./hourlySweeperService");
const {
  runFillerPoolRefresh,
  runDailyAgedRefresh,
  runMonthlyGraduationSweep,
  isAtMonthlyRefreshBoundary,
  isAtDailyAgedRefreshBoundary,
  isAgedRollingRefreshEnabled,
} = require("./fillerPoolRefreshService");
const {
  previewHourlyFinancialSync,
} = require("./hourlyFinancialPreviewService");
const {
  ignoreMetricsAttributionReviewItem,
  listMetricsAttributionReviewItems,
  reconcileMetricsAttributionCandidates,
  reopenMetricsAttributionReviewItem,
  resolveMetricsAttributionReviewItem,
} = require("./metricsAttributionReviewService");
const {
  resolveMetricsPaymentReviewItem,
  scanPaymentMetricsExceptions,
} = require("./paymentMetricsReviewService");
const {
  previewCallLedgerForDomain,
  previewHourlyCallLedger,
} = require("./hourlyCallLedgerPreviewService");
const {
  buildCallLedgerEntryFromCallLog,
  syncCallLedgerBySession,
  syncCallLedgerFromCallLog,
} = require("./callLedgerService");
const {
  recoverCxCallLogs,
  recoverCxCallLogsForDate,
} = require("./cxCallActivityBackfillService");
const {
  reconcilePaymentsForCase,
  reconcilePaymentsForDomain,
} = require("./paymentReconcileService");
const marketingMoneyService = require("./marketingMoneyService");
const {
  runPaymentFieldsSync,
} = require("./caseProfilePaymentSyncService");
const {
  runSubscriptionWatchdog,
  checkEventSilence: checkRingcentralEventSilence,
  recordRingcentralEvent,
  getWatchdogState: getRingcentralWatchdogState,
} = require("./ringcentralSubscriptionWatchdogService");
const {
  OUTBOUND_EVENT_TYPES,
  createOutboundEvent,
  createCadenceSweepEvents,
  pollOutboundRvmDispositions,
  processNextOutboundEvent,
  processOutboundEventBatch,
} = require("./outboundDispatchService");
const { sendOutboundCallFireDial, sendOutboundCallFireDialBatch } = require("./outboundCallFireService");
const {
  fireImmediateContact,
  intakeAffiliateLead,
  intakeFacebookLead,
  intakeInstagramLead,
  intakeLdLead,
  intakeLdPrePing,
  intakeLexisBatch,
  intakeNormalizedLead,
  notifyAffiliatePostback,
  intakeOrganicLandingLead,
  intakeTikTokLead,
  intakeVfLandingLead,
  intakeWebsiteLead,
  normalizeAffiliateLeadPayload,
  normalizeFacebookLeadPayload,
  normalizeInstagramLeadPayload,
  normalizeLdLeadPayload,
  normalizeTikTokLeadPayload,
  normalizeWebsiteLeadPayload,
  validateLeadWebhook,
} = require("./inboundIntakeService");
const {
  buildDailyStatusScanWorkflow,
  buildDomainStatusScanPlan,
  buildLogicsScanSummary,
} = require("./logicsScanService");
const {
  buildCapabilitySummary,
  buildRecommendedWorkflow,
} = require("./logicsCapabilityService");
const {
  runLogicsActivityReview,
  runLogicsActivityReviewBatch,
} = require("./logicsActivityReviewService");
const {
  getActiveMailers,
  getMailerConfigState,
  getMailerHistory,
  isMailerConfigLoaded,
  loadMailerConfigCache,
  reconcileMailerConfigsWithSheet,
  resolveMailer,
  resolveMailerAt,
  resolveMailerByRcExtension,
  resolveMailerByTrackingNumber,
} = require("./mailerConfigService");
const {
  computeNextRunAt: computeSpendSyncNextRunAt,
  createSpendSyncRuntime,
  getSpendSheets,
  parseCsv: parseSpendCsv,
  parseMailerRow,
  parseMetaRow,
} = require("./spendSyncService");
const {
  buildSpendSyncRead,
} = require("./spendSyncReadService");
const {
  backfillCallLogSourceFromLeadCadence,
} = require("./callLogSourceBackfillService");
const {
  collectFiles,
  buildRunId,
  downloadLatestLexisZip,
  fetchLatestLexisDrop,
  ingestLatestLexisDrop,
  mapLexisRowsForIntake,
  parseLexisCsv,
  processMailHouseCsv,
  sendLexisRegionalMail,
  unzipLexisArchive,
} = require("./lexisSftpService");
const {
  formatDateKey: formatLexisDailyDropDateKey,
  isLexisDailyDropDelivered,
  queueLexisDailyDropRetry,
  readLexisDailyDropState,
  sendLexisDailyDropMail,
  summarizeLexisCounts,
  writeLexisDailyDropState,
} = require("./lexisDailyDropService");
const {
  buildNcoaCreateCasePayload,
  getNcoaUploadProgress,
  normalizeNcoaRow,
  parseNcoaCsv,
  sweepStaleNcoaBatches,
  uploadNcoaRows,
} = require("./ncoaUploadService");
const {
  runNcoaMailboxIngest,
  runNcoaMailboxIngestIfDue,
} = require("./ncoaMailboxIngestService");
const { createLogicsFacade, parseLogicsData } = require("./logicsFacadeService");
const { buildProspectStatusDiff } = require("./logicsStatusDiffService");
const {
  clearScheduledTelephonySessions,
  extractAttributionCandidates,
  fetchCallRecordWithRetry,
  getScheduledTelephonySessionState,
  probeTelephonySessionLookup,
  processTelephonySessionCandidate,
  resolveSourceForCallRecord,
  resolveSourceFromDid,
  resolveSourceFromLegs,
  scheduleTelephonySessionEnvelope,
} = require("./ringcentralAttributionService");
const {
  EX_EVENT_TYPES,
  exPresencePollMode,
  processPresenceEnvelope,
  seedPresenceForAgents,
  startPresencePoller,
} = require("./ringcentralExService");
const {
  createCxLoginTrace,
  isCxLoginTraceEnabled,
  traceCxLoginTiming,
} = require("./cxLoginTraceService");
const {
  ROLLING_SUMMARY_TASK_ID,
  applyRollingSummaryToSession,
  buildRollingSummaryApplyPlan,
  buildRollingSummaryBatchRequest,
  buildRollingSummaryCursorFromApplyPlan,
  buildRollingSummaryPrompt,
  buildRollingSummarySchema,
  mergeAppendOnlySummary,
  normalizeRollingSummaryPayload,
  normalizeRollingSummaryMemory,
  parseRollingSummaryResult,
  rollingSummaryToText,
} = require("./liveCoachRollingSummaryService");
const {
  enrichPayloadWithRollingSummary,
  enrichTerminalPacketWithCoachSummary,
  loadRollingSummaryForTerminalPayload,
  readRollingSummaryFromSession,
} = require("./cxTerminalCoachSummaryBridge");
const {
  TASK_ID: NIGHTLY_CALL_GRADE_TASK_ID,
  TASK_SCHEMA: NIGHTLY_CALL_GRADE_TASK_SCHEMA,
  RESULT_SCHEMA: NIGHTLY_CALL_GRADE_RESULT_SCHEMA,
  applyCallGradeResult,
  buildCallGradeAiTaskPayload,
  buildNightlyCallGradeEmail,
  buildCallGradePrompt,
  buildCallGradeTaskPacket,
  buildNightlyCallGradeReport,
  groupNotesByAgent,
  hasEnoughGradeEvidence,
  markCallGradeFailure,
  normalizeCallGradeResult,
  runNightlyCallGrading,
} = require("./cxNightlyCallGradeService");
const { listServiceTopology } = require("./serviceCatalog");
const { sendPlainEmail, sendTestEmail } = require("./sendgridMailService");
const {
  sendMail,
  renderOnly: renderEmailHtml,
  clearCaches: clearMailerCaches,
} = require("./mailerService");
const { listActiveSourceCanonicals, resolveCanonicalSource } = require("./sourceCanonicalService");
const {
  buildSocialResponderWorkspace,
  getMetaWebhookVerifyToken,
  listMetaWebhookDomains,
  processMetaSocialWebhook,
  saveSocialResponderConfig,
} = require("./socialResponderService");
const { getWorkspaceForUser } = require("./workspaceService");
const {
  classifySms,
  fastStopCheck,
  CLASSIFIER_MODEL: SMS_CLASSIFIER_MODEL,
} = require("./smsClassifierService");
const {
  runAutoResponder,
  evaluateAutoSendGates,
  enforceReplyConstraints,
  AUTO_REPLY_COOLDOWN_MS,
} = require("./smsAutoResponderService");

const { createAiTaskRunner } = require("./aiTaskRunner");
const { createAiProviders, createAnthropicAdapter, createOpenAiAdapter, REASONING_KINDS } = require("./aiProviders");
const { createAiPrimitives, toCall } = require("./aiPrimitives");
const { createAiTaskClient } = require("./aiTaskClient");
const aiTaskRegistry = require("./aiTaskRegistry");
const leadDeliveryService = require("./leadDeliveryService");
const dailyDialLedgerService = require("./dailyDialLedgerService");
const trainingCourseService = require("./trainingCourseService");

module.exports = {
  leadDeliveryService,
  dailyDialLedgerService,
  trainingCourseService,
  // ── CX lane registry + dispatchers (first-touch drip, appointment clock) ──
  CX_LANES,
  buildLaneExternId,
  parseLaneFromExternId,
  parseAgentQueueMap,
  createCxFirstTouchDispatcher,
  createCxCallerIdRotationService,
  filterCxCallerIdRotationConfig,
  loadCxCallerIdRotationConfig,
  createCxAppointmentDispatcher,
  createCxSeanFirstTouchDrip,
  getLaneCall,
  // ── AI bus: provider-neutral task runner + primitives + delivery client ──
  createAiTaskRunner,
  createAiProviders,
  createAnthropicAdapter,
  createOpenAiAdapter,
  REASONING_KINDS,
  createAiPrimitives,
  toCall,
  createAiTaskClient,
  aiTaskRegistry,
  // Pacing queue (PR: Universal Call Queue)
  bumpLastActivityAt,
  deriveActivityState,
  deriveFreshLeadGate,
  setActivityState,
  touchCxWorkspacePresence,
  isOperatingNow,
  isChannelOperatingNow,
  clampToOperatingHours,
  clampToChannelOperatingHours,
  nextOperatingMomentAfter,
  formatPacingHourBucket,
  getPacingConfig,
  updatePacingConfig,
  getPacingConfigHistory,
  validatePacingPatch,
  bumpPacingConfigCache,
  refillPool,
  emptinessWatcherTick,
  refreshPoolOccupancy,
  enqueueLead,
  isAgentEligibleForSlice,
  computeTargetMix,
  issueSlice,
  releaseSlice,
  releaseSliceById,
  recordItemDispositioned,
  maybeCompleteSlice,
  assignFreshLead,
  drainPendingFreshLeads,
  freshLeadExpirySweep,
  onAgentBecomesEligible,
  listEligibleIdleAgents,
  idleReaperTick,
  computePacingReport,
  getPacingReport,
  listRecentPacingReports,
  formatPacingReportText,
  runHourlyPacing,
  runMorningPacingPrep,
  DISPOSITION_MAP,
  listDispositions,
  getDisposition,
  validateDisposition,
  computeNextTouchAt,
  cxTokenStorageService,
  cxOAuthService,
  ensureRingcxAgentOffhookAllowed,
  resolveRingcxAgentIdentity,
  dialPlaceCall,
  dialTerminateAndDispose,
  dialReconcileCallEnded,
  dialReconcileCallConnected,
  dialMaterializeInboundCall,
  dialSweepStaleStates,
  buildLogicsCaseUrl,
  sanitizeUsPhone,

  getCxAgentStateByExtensionId,
  buildCxCallQueue,
  buildCxQueueForAgent,
  buildCxQueuesForAgents,
  buildCxCadenceRuntimeSnapshot,
  buildCxCommLog,
  buildCxWorkspace,
  createCxAppointment,
  fireCxAppointmentNow,
  listCxAppointments,
  releaseCxAppointment,
  runDueCxAppointments,
  listCxPlacedCallsToday,
  executeCxAppointmentWorkbenchActions,
  executeCxCallSummary,
  computeFreshHotLaneWindow,
  approveInboxWorkflow,
  cancelInboxWorkflow,
  dncInboxWorkflow,
  editSendInboxWorkflow,
  autoRouteHotInboundWorkflow,
  isAvailableForHotIntent,
  listAvailableHotIntentAgents,
  executeCxLogicsCreateCase,
  executeCxSaveCaseProfileFromLogics,
  executeCxLogicsFindMatch,
  executeCxLogicsActivity,
  executeCxInterviewSnapshot,
  executeCxLogicsAmortization,
  executeCxLogicsInvoice,
  executeCxLogicsNotes,
  executeCxLogicsTask,
  executeCxLogicsUpdateCase,
  enqueueCxSmokeLead,
  simulateCxIncomingCall,
  reviewCaseActivities,
  CONTROL_PLANE_EVENT_TYPES,
  buildControlPlaneHealthReport,
  relayControlPlaneEvent,
  relayMetricObserved,
  relayReviewItemObserved,
  relayRingcentralTelephonyForwarded,
  buildControlPlaneReadOverview,
  buildClientDetail,
  buildClientWorkspaceList,
  buildDeployWorkspace,
  buildInboxWorkspace,
  buildLibraryWorkspace,
  buildHourlyHygienePlan,
  claimNextHourlyJobEvent,
  computeNextLaneRunAt,
  OUTBOUND_EVENT_TYPES,
  createCadenceSweepEvents,
  evaluateCounterCadenceDueItems,
  getCounterCadenceCounters,
  getCounterCadenceLastTouched,
  getCounterCadenceTemplateKey,
  isCounterCadenceBatchTime,
  pollCounterCadenceRvmDispositions,
  recordCounterCadenceTouch,
  runCounterCadenceSweep,
  selectCounterCadenceDueItems,
  buildWorkList,
  fireImmediateContact,
  intakeAffiliateLead,
  intakeFacebookLead,
  intakeInstagramLead,
  intakeLdLead,
  intakeLexisBatch,
  intakeNormalizedLead,
  notifyAffiliatePostback,
  normalizeAffiliateLeadPayload,
  normalizeLdLeadPayload,
  intakeOrganicLandingLead,
  intakeTikTokLead,
  intakeVfLandingLead,
  intakeWebsiteLead,
  listHourlyReviewFeed,
  listHourlyJobEvents,
  pushHourlyReviewItem,
  classifyActivityForAttribution,
  buildContactLibraryCatalog,
  runClientCaseScrub,
  listLastMonthInboundCalls,
  lookupInboundCall,
  listCxAgentStates,
  listEligibleAgentsForCx,
  previewCallLedgerForDomain,
  previewHourlyCallLedger,
  buildCallLedgerEntryFromCallLog,
  syncCallLedgerBySession,
  syncCallLedgerFromCallLog,
  recoverCxCallLogs,
  recoverCxCallLogsForDate,
  previewHourlyFinancialSync,
  resolveMetricsPaymentReviewItem,
  scanPaymentMetricsExceptions,
  previewScheduledBlast,
  listMetricsAttributionReviewItems,
  reconcileMetricsAttributionCandidates,
  resolveMetricsAttributionReviewItem,
  ignoreMetricsAttributionReviewItem,
  reopenMetricsAttributionReviewItem,
  listCxLogicsTasks,
  listCxTasks,
  extractMailerLabel,
  buildDataHygieneOverview,
  buildSimpleMarketingSummary,
  syncCallrailDailyStats,
  importLogicsPaymentsCsv,
  evaluatePaymentsSheetGate,
  readPaymentsSheetStatus,
  recordPaymentsSheetImport,
  verifyPaymentsCsvDomain,
  reconcileSheetCases,
  buildReviewWorkspace,
  buildRingBridgeWorkspace,
  buildRingCentralWorkspace,
  buildDailyDeepCutDashboard,
  buildDailyDeepCutPlan,
  getDailyDeepCutRun,
  listDailyDeepCutRuns,
  recordDailyDeepCutRun,
  startDailyDeepCutRun,
  startDailyDeepCutVerification,
  buildControlPlaneSummary,
  createControlPlaneEvent,
  createOutboundEvent,
  buildDispatchList,
  buildScheduledBlastRuntimeSnapshot,
  getWorkList,
  buildProviderHealth,
  processControlPlaneEventBatch,
  processNextOutboundEvent,
  processOutboundEventBatch,
  pollOutboundRvmDispositions,
  sendOutboundCallFireDial,
  sendOutboundCallFireDialBatch,
  buildCapabilitySummary,
  buildDailyStatusScanWorkflow,
  buildDomainStatusScanPlan,
  buildLogicsScanSummary,
  buildRecommendedWorkflow,
  buildSpendSyncRead,
  backfillCallLogSourceFromLeadCadence,
  getActiveMailers,
  getMailerConfigState,
  getMailerHistory,
  computeSpendSyncNextRunAt,
  collectFiles,
  clearScheduledTelephonySessions,
  claimNextCxQueueItem,
  completeCxQueueItem,
  createCxCallPlacedEvent,
  createCxCallTerminalOutcomeEvent,
  classifyCxTerminalOutcome,
  handleCxTerminalCallOutcome,
  recordMinimalTerminalResolution,
  createLogicsFacade,
  downloadLatestLexisZip,
  buildProspectStatusDiff,
  extractAttributionCandidates,
  EX_EVENT_TYPES,
  fetchCallRecordWithRetry,
  fetchLatestLexisDrop,
  processTelephonySessionCandidate,
  resolveSourceForCallRecord,
  resolveSourceFromDid,
  resolveSourceFromLegs,
  getControlPlaneDomain,
  getDispatchList,
  getScheduledTelephonySessionState,
  getMetaWebhookVerifyToken,
  getWorkspaceForUser,
  classifySms,
  fastStopCheck,
  SMS_CLASSIFIER_MODEL,
  runAutoResponder,
  evaluateAutoSendGates,
  enforceReplyConstraints,
  AUTO_REPLY_COOLDOWN_MS,
  listActiveSourceCanonicals,
  listMetaWebhookDomains,
  isMailerConfigLoaded,
  listPresentationCaseProfiles,
  listPresentationPayments,
  listPresentationProspects,
  listControlPlaneDomains,
  listReviewWorkspaceItems,
  listRingCentralEvents,
  listDispatchLists,
  listWorkLists,
  listServiceTopology,
  CX_CADENCE_EVENT_TYPES,
  buildNcoaCreateCasePayload,
  mapLexisRowsForIntake,
  normalizeNcoaRow,
  parseLexisCsv,
  parseNcoaCsv,
  parseLogicsData,
  parseSuccessfulPayments,
  processMailHouseCsv,
  runNcoaMailboxIngest,
  runNcoaMailboxIngestIfDue,
  processCxCadenceEventBatch,
  processNextCxCadenceEvent,
  processNextControlPlaneEvent,
  publishQueueItemToRingcx,
  executeCxDispatchIntent,
  executeCxHangupRequest,
  listCxPostDateHolds,
  runRingcxAgentMonitor,
  getCxBucketLiveRead,
  getCxBucketSnapshotForExtension,
  isCxBucketDebugReadEnabled,
  isCxBucketShadowEnabled,
  advanceCxSimpleLoopSession,
  CX_BULK_LOAD_PHASES,
  getCxBulkLoadSession,
  killCxBulkLoadSession,
  pauseCxBulkLoadProgressiveDialing,
  resumeCxBulkLoadProgressiveDialing,
  skipCxBulkLoadCurrent,
  startCxBulkLoadGetLeads,
  startCxBulkLoadSession,
  syncCxBulkLoadActiveCall,
  submitCxBulkLoadDisposition,
  submitCxLaneCallDisposition,
  submitCxBulkLoadReviewOutcome,
  watchCxBulkLoadAccountActiveCalls,
  buildCxAccountActiveCallWatchPlan,
  runCxAccountActiveCallWatchOnce,
  createCxQueueReservationService,
  createCxReservationReconcilerService,
  createCxStaleServingReconcilerService,
  classifyStaleServingRow,
  resolveServingIdentity,
  createCxTerminalOutboxDrain,
  CX_BORING_WEBHOOK_ACTIONS,
  CX_BORING_WEBHOOK_OUTCOMES,
  actionForCxBoringWebhookEvent,
  classifyCxBoringWebhookDisposition,
  createCxBoringWebhookActionDrain,
  createCxBoringWebhookCallPoller,
  createCxBoringWebhookService,
  normalizeCxBoringRingcxWebhook,
  parseCxBoringDirectExternId,
  buildCxCallWrapBody,
  buildCxCallWrapThreadKey,
  normalizeCxCallWrapPacket,
  writeCxCallWrapSummary,
  createCxCallWrapCardService,
  wrapCardNeeded,
  CX_WRAP_RESOLUTION_RULES,
  buildBadNumberAlertEmail,
  createCxBadNumberOutcomeHandler,
  isBadNumberOutcome,
  buildAgentCallNoteFromCloseout,
  buildAgentCallNoteFromTerminal,
  hasAgentCallNoteGradeEvidence,
  agentCallNoteKeyFrom,
  writeAgentCallNoteFromCloseout,
  writeAgentCallNoteFromTerminal,
  buildTerminalOutboxPayloadFromEvidence,
  buildTerminalRectificationIdemKey,
  classifyRectificationEvidence,
  extractRectificationKeysFromCallLog,
  isRealRingcxUii,
  normalizeRectificationWindow,
  runCxTerminalRectification,
  makeOutcomeIdemKey,
  buildCxReviewCorrectionRow,
  buildTerminalEvidenceKeys,
  buildFamilyTargets,
  alphaTraceEnabled,
  logCxAlpha,
  redactCxAlphaPayload,
  traceCxAlphaMatchesFilter,
  confirmCxSlowSingleCurrent,
  getCxSimpleLoopSession,
  getCxSlowSingleSession,
  killCxSimpleLoopSession,
  killCxSlowSingleSession,
  normalizeSlowSingleOutcome,
  reduceCxBulkLoadState,
  reduceCxSimpleLoopSession,
  skipCxSimpleLoopCurrent,
  startCxSimpleLoopSession,
  startCxSlowSingleCall,
  submitCxSimpleLoopDisposition,
  submitCxSlowSingleOutcome,
  probeTelephonySessionLookup,
  processPresenceEnvelope,
  publishDemoEvent,
  queueCxDialRequest,
  queueDispatchList,
  queueScheduledBlast,
  queueWorkList,
  regenerateInboxWorkflow,
  recordConversationAi,
  recordQualityReview,
  resolveCaseContactEligibility,
  recordWorkflowStage,
  requestCxAssignCaseToMe,
  requestCxDial,
  requestCxEndCall,
  requestCxDisposition,
  requestCxVoicemailDrop,
  listVmDropThemes,
  vmDropMode,
  requestCxEmail,
  requestCxLogicsCreateCase,
  requestCxLogicsFindMatch,
  requestCxLeadStatusUpdate,
  releaseCxPostDateHold,
  requestCxReminder,
  requestCxStatusChange,
  requestCxTask,
  requestCxText,
  reconcileMailerConfigsWithSheet,
  resolveScheduledBlastRule,
  resolveCanonicalAttribution,
  resolveCanonicalSource,
  resolveMailer,
  resolveMailerAt,
  resolveMailerByRcExtension,
  resolveMailerByTrackingNumber,
  buildCampaignAudience,
  resolveUpsellContactEligibility,
  getUpsellContactAllowList,
  sendUpsellContact,
  sendBulkUpsellContact,
  buildProspectBlast,
  planProspectBlast,
  loadProspectBlast,
  blastJobStore,
  extractCadenceEmailIndex,
  extractCadenceSmsIndex,
  resolveCadenceEmailContent,
  resolveCadenceSmsContent,
  buildCallLog,
  buildRingcentralPollingRuntime,
  countLegacyContactActivities,
  listLegacyContactActivities,
  seedRingcentralExtensionsFromCsv,
  reconcileUnattributedSessions,
  runRingCentralCallLogSweep,
  resolveInboundCallSource,
  emitServiceRequest,
  isRecordingArchiveConfigured,
  isRingcxRecordingEnabled,
  isTranscriptionConfigured,
  processCallRecordingArchive,
  processCallLogRecording,
  queueCallRecordingArchiveJob,
  computeCxRecordingHourlyWindow,
  runCxRecordingHourly,
  rebuildFreshHotLane,
  processMetaSocialWebhook,
  syncUsersFromRcExtensions,
  buildAgentCallStats,
  getOrComputeAgentCallStats,
  invalidateAgentCallStatsSnapshot,
  buildBlogBotStatus,
  buildMetricsPulse,
  SHORT_CIRCUIT_INTAKE_SOURCES,
  runProspectSweep,
  runScheduledBlastSweep,
  DEPLOY_ACTION_KEYS,
  buildDeployState,
  buildLocalDeployState,
  buildSocialResponderWorkspace,
  cancelDeployRun,
  listDeployRuns,
  runLocalDeployCommand,
  triggerDeploy,
  mirrorAgentState,
  normalizeAssignmentStats,
  normalizeCxQueueFamily,
  rankAgentsForQueueItem,
  deriveCxQueueFamily,
  normalizeFacebookLeadPayload,
  normalizeInstagramLeadPayload,
  normalizeTikTokLeadPayload,
  normalizeWebsiteLeadPayload,
  runDataHygieneSmoke,
  recordServiceAlert,
  releaseCxQueueBatch,
  releaseManualUnavailableAgentQueues,
  runFreshHotLaneAllocator,
  runPostDateHoldEodSweep,
  scheduleTelephonySessionEnvelope,
  sleepInboxWorkflow,
  seedPresenceForAgents,
  exPresencePollMode,
  createCxLoginTrace,
  isCxLoginTraceEnabled,
  traceCxLoginTiming,
  ROLLING_SUMMARY_TASK_ID,
  applyRollingSummaryToSession,
  buildRollingSummaryApplyPlan,
  buildRollingSummaryBatchRequest,
  buildRollingSummaryCursorFromApplyPlan,
  buildRollingSummaryPrompt,
  buildRollingSummarySchema,
  mergeAppendOnlySummary,
  normalizeRollingSummaryPayload,
  normalizeRollingSummaryMemory,
  parseRollingSummaryResult,
  rollingSummaryToText,
  enrichPayloadWithRollingSummary,
  enrichTerminalPacketWithCoachSummary,
  loadRollingSummaryForTerminalPayload,
  readRollingSummaryFromSession,
  NIGHTLY_CALL_GRADE_TASK_ID,
  NIGHTLY_CALL_GRADE_TASK_SCHEMA,
  NIGHTLY_CALL_GRADE_RESULT_SCHEMA,
  applyCallGradeResult,
  buildCallGradeAiTaskPayload,
  buildNightlyCallGradeEmail,
  buildCallGradePrompt,
  buildCallGradeTaskPacket,
  buildNightlyCallGradeReport,
  groupNotesByAgent,
  hasEnoughGradeEvidence,
  markCallGradeFailure,
  normalizeCallGradeResult,
  runNightlyCallGrading,
  sendMail,
  sendPlainEmail,
  sendOpsStatusEmail,
  sendAgedRefreshReportEmail,
  runGroupedNightlyClose,
  renderEmailHtml,
  clearMailerCaches,
  sendLexisDailyDropMail,
  sendLexisRegionalMail,
  sendTestEmail,
  searchClientWorkspace,
  searchCxCases,
  lookupCxLogicsMatch,
  getSpendSheets,
  loadMailerConfigCache,
  startPresencePoller,
  ingestLatestLexisDrop,
  readLexisDailyDropState,
  writeLexisDailyDropState,
  isLexisDailyDropDelivered,
  queueLexisDailyDropRetry,
  formatLexisDailyDropDateKey,
  summarizeLexisCounts,
  buildRunId,
  createSpendSyncRuntime,
  parseSpendCsv,
  parseMailerRow,
  parseMetaRow,
  emitHourlyJobEvent,
  markHourlyJobCompleted,
  markHourlyJobFailed,
  notifyHourlyJobAlert,
  EMAIL_TEMPLATE_CATALOG,
  listEmailTemplates,
  renderEmailTemplate,
  runLogicsActivityReview,
  runLogicsActivityReviewBatch,
  lookupCxLead,
  findCxLeadCandidates,
  cancelCxAppointmentsForCase,
  resolveCxAppointmentAfterDisposition,
  hourlyJobHandlerRegistry,
  hourlyJobResolutionCheckRegistry,
  drainHourlyJobQueue,
  runHourlyLeadCadenceEnforcement,
  runHourlyCallLogHygiene,
  runHourlyCallLogHygieneForDomain,
  runHourlySweep,
  runFillerPoolRefresh,
  runDailyAgedRefresh,
  runMonthlyGraduationSweep,
  isAtMonthlyRefreshBoundary,
  isAtDailyAgedRefreshBoundary,
  isAgedRollingRefreshEnabled,
  sendResolutionEmails,
  summarizeHourlySweepResult,
  reconcilePaymentsForCase,
  reconcilePaymentsForDomain,
  marketingMoneyService,
  runPaymentFieldsSync,
  runSubscriptionWatchdog,
  checkRingcentralEventSilence,
  recordRingcentralEvent,
  getRingcentralWatchdogState,
  getFreshHotLaneSnapshot,
  summarizeSuccessfulPayments,
  unzipLexisArchive,
  uploadNcoaRows,
  runNcoaMailboxIngest,
  runNcoaMailboxIngestIfDue,
  getNcoaUploadProgress,
  sweepStaleNcoaBatches,
  intakeLdPrePing,
  validateLeadWebhook,
  listWorkflowStages,
  saveSocialResponderConfig,
  REPORTS,
  createGatherSession,
  generateReport,
  pruneGatherCache,
  reportDefinitions,
  marketingCallLinks,
  queueRollup,
  sourceSanitizer,
  reportOps,
  classifyRow,
  insertActivityEvents,
  parseReportRows,
  stopCaseContact,
  wakeInboxWorkflow,
  wrapHourlyJobs,
};
