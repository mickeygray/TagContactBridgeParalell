"use strict";

const crypto = require("node:crypto");
const {
  agentStateRepository,
  caseProfileRepository,
  cxAppointmentRepository,
  cxDialQueueRepository,
  leadCadenceRepository,
  userAccountRepository,
} = require("../../shared-repositories/src");
const { recordWorkflowStage } = require("./workflowStateService");
const {
  queueCxDialRequest,
} = require("./cxCadenceService");
const {
  resolveQueueDialTimeWindow,
} = require("./cxQueuePolicyService");

const DEFAULT_APPOINTMENT_TIMEZONE = "America/Los_Angeles";
const APPOINTMENT_PRIORITY = 1000;
const ACTIVE_STATUSES = new Set(["scheduled", "due", "fired", "blocked"]);

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.slice(-10);
}

function cleanString(value, maxLength = 400) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength) || null;
}

function isValidTimeZone(value) {
  const timeZone = String(value || "").trim();
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function getZonedParts(date = new Date(), timeZone = DEFAULT_APPOINTMENT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(date));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(lookup.hour);
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: hour === 24 ? 0 : hour,
    minute: Number(lookup.minute),
    second: Number(lookup.second),
  };
}

function getZonedOffsetMs(date = new Date(), timeZone = DEFAULT_APPOINTMENT_TIMEZONE) {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - new Date(date).getTime();
}

function makeZonedDate(year, month, day, hour = 0, minute = 0, second = 0, timeZone = DEFAULT_APPOINTMENT_TIMEZONE) {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  for (let index = 0; index < 3; index += 1) {
    utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0)
      - getZonedOffsetMs(new Date(utcMs), timeZone);
  }
  return new Date(utcMs);
}

function parseAppointmentDateTime(input = {}) {
  const requestedTimezone = isValidTimeZone(input.appointmentTimezone || input.timezone)
    ? String(input.appointmentTimezone || input.timezone).trim()
    : DEFAULT_APPOINTMENT_TIMEZONE;
  const datePart = String(input.appointmentDate || input.date || "").trim();
  const timePart = String(input.appointmentTime || input.time || "").trim();
  if (datePart && timePart) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
    const timeMatch = /^(\d{2}):(\d{2})/.exec(timePart);
    if (!match || !timeMatch) {
      const error = new Error("appointment date/time must use YYYY-MM-DD and HH:mm");
      error.status = 400;
      throw error;
    }
    const appointmentAt = makeZonedDate(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      Number(timeMatch[1]),
      Number(timeMatch[2]),
      0,
      requestedTimezone,
    );
    return {
      appointmentAt,
      appointmentTimezone: requestedTimezone,
      requestedAtLocal: `${datePart}T${timePart.slice(0, 5)}`,
      requestedTimezone,
    };
  }

  const parsed = input.appointmentAt || input.scheduledFor || input.followUpAt
    ? new Date(input.appointmentAt || input.scheduledFor || input.followUpAt)
    : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    const error = new Error("appointment date/time is required");
    error.status = 400;
    throw error;
  }
  return {
    appointmentAt: parsed,
    appointmentTimezone: requestedTimezone,
    requestedAtLocal: null,
    requestedTimezone,
  };
}

async function resolveCxAppointmentContext(domain, user = {}) {
  const normalizedDomain = normalizeDomain(domain || user.company || "TAG");
  const email = normalizeEmail(user.email);
  if (!email) {
    const error = new Error("Authenticated user context is required");
    error.status = 401;
    throw error;
  }
  const account = await userAccountRepository.findUserAccountByEmail(email) || {
    email,
    name: user.name || email,
    company: normalizedDomain,
    extensionId: user.extensionId || null,
    role: user.role || null,
  };
  const extensionId = String(account.extensionId || user.extensionId || "").trim();
  if (!extensionId) {
    const error = new Error("Your account is not paired to a RingCentral extension.");
    error.status = 403;
    throw error;
  }
  const agentState = await agentStateRepository.findAgentStateByExtensionId(extensionId).catch(() => null);
  return {
    domain: normalizedDomain,
    account: {
      ...account,
      extensionId,
      email: normalizeEmail(account.email || email),
      name: account.name || user.name || email,
    },
    agentState,
  };
}

function isAdminUser(user = {}) {
  return String(user.role || "").trim().toLowerCase() === "admin";
}

function queueItemObject(queueItem) {
  return queueItem && typeof queueItem.toObject === "function" ? queueItem.toObject() : queueItem;
}

function buildAppointmentActionKey(appointmentId) {
  return `appointment:${String(appointmentId || "").trim()}`;
}

function buildQueueTimingProbe(input = {}, queueItem = null, appointmentAt = new Date()) {
  const metadata = {
    ...(queueItem?.metadata || {}),
    ...(input.metadata || {}),
  };
  if (input.leadState || input.state) metadata.leadState = input.leadState || input.state;
  if (input.leadTimeZone || input.leadTimezone || input.timezone) {
    metadata.leadTimeZone = input.leadTimeZone || input.leadTimezone || input.timezone;
  }
  return {
    ...(queueItem || {}),
    payloadSnapshot: {
      ...(queueItem?.payloadSnapshot || {}),
      ...(input.payloadSnapshot || {}),
      state: input.state || input.leadState || input.payloadSnapshot?.state || undefined,
      timezone: input.leadTimeZone || input.leadTimezone || input.timezone || input.payloadSnapshot?.timezone || undefined,
    },
    metadata,
    releaseAt: appointmentAt,
  };
}

function resolveLegalDialTiming(input = {}, queueItem = null, appointmentAt = new Date()) {
  const probe = buildQueueTimingProbe(input, queueItem, appointmentAt);
  const timing = resolveQueueDialTimeWindow(probe, appointmentAt);
  return {
    timing,
    legalDialAt: timing.nextAllowedAt || appointmentAt,
    legalDialTimezone: timing.timeZone || input.appointmentTimezone || DEFAULT_APPOINTMENT_TIMEZONE,
    legalDialReason: timing.allowed ? null : timing.reason || "adjusted-to-legal-window",
  };
}

async function resolveQueueItemForAppointment(domain, caseId, input = {}) {
  const queueItemId = String(input.queueItemId || input.queueTicketId || "").trim();
  if (queueItemId) {
    const byId = await cxDialQueueRepository.findQueueItemById(queueItemId);
    if (byId) return queueItemObject(byId);
  }
  const actionKey = String(input.queueActionKey || input.actionKey || input.queueKey || "").trim();
  const byAction = await cxDialQueueRepository.findActiveQueueItem(
    domain,
    caseId,
    actionKey ? { actionKey } : {},
  );
  if (byAction) return queueItemObject(byAction);
  return queueItemObject(await cxDialQueueRepository.findActiveQueueItem(domain, caseId));
}

async function ensureAppointmentQueueItem({
  context,
  appointmentId,
  caseId,
  input,
  legalDialAt,
  queueItem,
}) {
  const now = new Date();
  const actionKey = queueItem?.metadata?.actionKey || buildAppointmentActionKey(appointmentId);
  let effectiveQueueItem = queueItem || null;

  if (!effectiveQueueItem) {
    const queueResult = await queueCxDialRequest({
      domain: context.domain,
      caseId,
      actionKey,
      phone: input.phone || null,
      name: input.prospectName || input.name || null,
      sourceName: input.sourceName || null,
      intakeSource: input.intakeSource || null,
      intakeRoute: input.intakeRoute || "appointment",
      queueFamily: input.queueFamily || "fresh-day2to10",
      queueTier: input.queueTier || "later",
      releaseAt: legalDialAt,
      requestedBy: "cx-appointment",
      requestedByUserEmail: context.account.email,
      metadata: {
        ...(input.metadata || {}),
        actionKey,
        appointmentId,
        appointmentStatus: "scheduled",
        dialabilityHoldReason: "appointment",
        dialabilityHoldUntil: legalDialAt,
        assignedExtensionId: context.account.extensionId,
        assignedAgentName: context.account.name || null,
      },
      payloadSnapshot: input.payloadSnapshot || null,
    });
    if (!queueResult?.queued || queueResult.skipped) {
      const error = new Error(queueResult?.reason || queueResult?.error || "appointment queue item could not be created");
      error.status = 409;
      error.details = queueResult;
      throw error;
    }
    effectiveQueueItem = queueResult.queueItem || null;
  }

  const queueItemId = String(effectiveQueueItem?._id || "").trim();
  if (!queueItemId) {
    const error = new Error("appointment queue item could not be resolved");
    error.status = 409;
    throw error;
  }

  const existingAssignment = String(effectiveQueueItem.assignment?.extensionId || "").trim();
  if (
    existingAssignment &&
    existingAssignment !== context.account.extensionId &&
    !isAdminUser({ role: context.account.role })
  ) {
    const error = new Error(`This lead is currently assigned to ${effectiveQueueItem.assignment?.agentName || existingAssignment}`);
    error.status = 409;
    throw error;
  }

  const patched = await cxDialQueueRepository.transitionQueueItemState(
    queueItemId,
    ["queued", "ready", "claimed", "serving", "paused"],
    {
      state: "paused",
      releaseAt: legalDialAt,
      claimUntil: null,
      priorityScore: Math.max(Number(effectiveQueueItem.priorityScore || 0) || 0, APPOINTMENT_PRIORITY),
      assignment: {
        extensionId: context.account.extensionId,
        agentName: context.account.name || null,
        assignedAt: effectiveQueueItem.assignment?.assignedAt || now,
        queueFamilySnapshot: effectiveQueueItem.assignment?.queueFamilySnapshot || effectiveQueueItem.queueFamily || null,
      },
      "metadata.appointmentId": appointmentId,
      "metadata.appointmentStatus": "scheduled",
      "metadata.appointmentAt": input.appointmentAt || null,
      "metadata.appointmentLegalDialAt": legalDialAt,
      "metadata.appointmentAgentExtensionId": context.account.extensionId,
      "metadata.appointmentAgentName": context.account.name || null,
      "metadata.dialabilityHoldReason": "appointment",
      "metadata.dialabilityHoldUntil": legalDialAt,
      "metadata.assignedExtensionId": context.account.extensionId,
      "metadata.assignedAgentName": context.account.name || null,
      "metadata.appointmentReservedAt": now,
      "metadata.appointmentReservedBy": context.account.email,
      "metadata.lastQueueAttemptHeldForDisposition": false,
      "metadata.wrapUpRequired": false,
    },
    { returnNew: true },
  );

  return queueItemObject(patched) || effectiveQueueItem;
}

async function upsertLeadAppointmentHold(domain, caseId, appointment = {}) {
  return leadCadenceRepository.upsertLeadCadence(domain, caseId, {
    active: true,
    currentStage: "cx-appointment-scheduled",
    "payloadSnapshot.cxAppointment": {
      appointmentId: appointment.appointmentId,
      status: appointment.status,
      agentExtensionId: appointment.agentExtensionId,
      legalDialAt: appointment.legalDialAt,
      appointmentAt: appointment.appointmentAt,
    },
  }).catch(() => null);
}

async function createCxAppointment(domain, user, input = {}) {
  const context = await resolveCxAppointmentContext(domain, user);
  const caseId = Number(input.caseId ?? input.CaseID);
  if (!Number.isFinite(caseId) || caseId <= 0) {
    const error = new Error("caseId is required");
    error.status = 400;
    throw error;
  }

  const { appointmentAt, appointmentTimezone, requestedAtLocal, requestedTimezone } = parseAppointmentDateTime(input);
  const existingQueueItem = await resolveQueueItemForAppointment(context.domain, caseId, input);
  const activeAppointment = await cxAppointmentRepository.findActiveAppointmentForCase(
    context.domain,
    caseId,
  );
  if (
    activeAppointment &&
    String(activeAppointment.agentExtensionId || "") !== context.account.extensionId &&
    !isAdminUser(context.account)
  ) {
    const error = new Error(`This lead already has an appointment with ${activeAppointment.agentName || activeAppointment.agentExtensionId}`);
    error.status = 409;
    throw error;
  }
  const timing = resolveLegalDialTiming(
    {
      ...input,
      appointmentTimezone,
    },
    existingQueueItem,
    appointmentAt,
  );
  const appointmentId = String(input.appointmentId || activeAppointment?.appointmentId || crypto.randomUUID());
  const phone = normalizePhone(
    input.phone ||
      input.searchPhone ||
      existingQueueItem?.phone ||
      input.payloadSnapshot?.phone ||
      "",
  );
  const prospectName = cleanString(
    input.prospectName ||
      input.name ||
      existingQueueItem?.name ||
      input.payloadSnapshot?.name ||
      "",
    180,
  );

  const queueItem = await ensureAppointmentQueueItem({
    context,
    appointmentId,
    caseId,
    input: {
      ...input,
      appointmentAt,
    },
    legalDialAt: timing.legalDialAt,
    queueItem: existingQueueItem,
  });
  const queueItemId = String(queueItem?._id || input.queueItemId || input.queueTicketId || "").trim() || null;
  const queueActionKey = String(queueItem?.metadata?.actionKey || input.queueActionKey || buildAppointmentActionKey(appointmentId)).trim();
  const appointmentDoc = await cxAppointmentRepository.upsertAppointment(appointmentId, {
    appointmentId,
    domain: context.domain,
    caseId,
    leadCadenceId: queueItem?.leadCadenceId || input.leadCadenceId || null,
    cxQueueRecordId: queueItemId,
    queueActionKey,
    status: "scheduled",
    agentExtensionId: context.account.extensionId,
    agentName: context.account.name || null,
    agentEmail: context.account.email,
    prospectName,
    phone,
    sourceName: input.sourceName || queueItem?.sourceName || null,
    intakeSource: input.intakeSource || queueItem?.intakeSource || null,
    intakeRoute: input.intakeRoute || queueItem?.intakeRoute || "appointment",
    requestedAtLocal,
    requestedTimezone,
    appointmentAt,
    appointmentTimezone,
    legalDialAt: timing.legalDialAt,
    legalDialTimezone: timing.legalDialTimezone,
    legalDialReason: timing.legalDialReason,
    note: cleanString(input.note, 1000),
    createdByEmail: context.account.email,
    updatedByEmail: context.account.email,
    metadata: {
      queueStateBeforeAppointment: existingQueueItem?.state || null,
      requestedQueueItemId: input.queueItemId || input.queueTicketId || null,
      requestedQueueActionKey: input.queueActionKey || input.actionKey || null,
      legalDialTiming: timing.timing,
    },
    historyEntry: {
      type: "appointment-created",
      actorEmail: context.account.email,
      note: cleanString(input.note, 1000),
      payload: {
        requestedAtLocal,
        requestedTimezone,
        appointmentAt,
        legalDialAt: timing.legalDialAt,
        queueItemId,
      },
    },
  });

  await cxAppointmentRepository.mirrorAgentAppointment(
    context.account.extensionId,
    appointmentDoc,
  ).catch(() => null);
  await upsertLeadAppointmentHold(context.domain, caseId, appointmentDoc).catch(() => null);

  await recordWorkflowStage({
    domain: context.domain,
    family: "cx",
    subtype: "appointment",
    stage: "scheduled",
    aggregateType: "cx-appointment",
    aggregateId: appointmentId,
    caseId,
    sourceService: "control-plane",
    title: "CX appointment scheduled",
    summary: `Appointment scheduled for case ${caseId}`,
    payload: {
      appointmentId,
      agentExtensionId: context.account.extensionId,
      agentEmail: context.account.email,
      appointmentAt,
      legalDialAt: timing.legalDialAt,
      queueItemId,
      queueActionKey,
    },
  }).catch(() => null);

  return {
    ok: true,
    domain: context.domain,
    appointment: appointmentDoc?.toObject ? appointmentDoc.toObject() : appointmentDoc,
    queueItem,
    timing: timing.timing,
  };
}

async function listCxAppointments(domain, user, filters = {}) {
  const requestedDomain = normalizeDomain(domain || user?.company || "TAG");
  const allDomains = requestedDomain === "ALL";
  if (allDomains) {
    if (!isAdminUser(user)) {
      const error = new Error("Admin access is required for all-domain appointments");
      error.status = 403;
      throw error;
    }
    const items = await cxAppointmentRepository.listAppointments({
      ...filters,
      domain: null,
    });
    const summary = items.reduce((acc, item) => {
      acc.total += 1;
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, { total: 0 });
    return {
      domain: "ALL",
      filters: {
        ...filters,
        domain: "ALL",
      },
      summary,
      items,
    };
  }

  const context = await resolveCxAppointmentContext(domain, user);
  const scopedFilters = {
    ...filters,
    domain: context.domain,
  };
  if (!isAdminUser(user)) {
    scopedFilters.agentExtensionId = context.account.extensionId;
  }
  const items = await cxAppointmentRepository.listAppointments(scopedFilters);
  const summary = items.reduce((acc, item) => {
    acc.total += 1;
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, { total: 0 });
  return {
    domain: context.domain,
    filters: scopedFilters,
    summary,
    items,
  };
}

async function releaseCxAppointment(domain, user, input = {}) {
  const context = await resolveCxAppointmentContext(domain, user);
  const appointmentId = String(input.appointmentId || input.id || "").trim();
  if (!appointmentId) {
    const error = new Error("appointmentId is required");
    error.status = 400;
    throw error;
  }
  const appointment = await cxAppointmentRepository.findAppointmentById(appointmentId);
  if (!appointment || normalizeDomain(appointment.domain) !== context.domain) {
    const error = new Error("Appointment not found");
    error.status = 404;
    throw error;
  }
  if (
    String(appointment.agentExtensionId || "") !== context.account.extensionId &&
    !isAdminUser(user)
  ) {
    const error = new Error("Appointment belongs to another agent");
    error.status = 403;
    throw error;
  }
  const now = new Date();
  const updated = await cxAppointmentRepository.patchAppointment(
    appointmentId,
    {
      status: "released",
      releasedAt: now,
      releasedByEmail: context.account.email,
      updatedByEmail: context.account.email,
      resolvedAt: now,
      resolvedByEmail: context.account.email,
      resolvedDisposition: "released",
    },
    {
      type: "appointment-released",
      at: now,
      actorEmail: context.account.email,
      note: cleanString(input.reason || input.note, 500),
    },
  );
  await cxAppointmentRepository.removeAgentAppointment(
    appointment.agentExtensionId,
    appointmentId,
  ).catch(() => null);
  if (appointment.cxQueueRecordId) {
    await cxDialQueueRepository.updateQueueItem(appointment.cxQueueRecordId, {
      "metadata.appointmentStatus": "released",
      "metadata.dialabilityHoldReason": null,
      "metadata.dialabilityHoldUntil": null,
      "metadata.appointmentReleasedAt": now,
      "metadata.appointmentReleasedBy": context.account.email,
      state: "queued",
      releaseAt: now,
      claimUntil: null,
      assignment: {
        extensionId: null,
        agentName: null,
        assignedAt: null,
        queueFamilySnapshot: null,
      },
    }).catch(() => null);
  }
  await recordWorkflowStage({
    domain: context.domain,
    family: "cx",
    subtype: "appointment",
    stage: "released",
    aggregateType: "cx-appointment",
    aggregateId: appointmentId,
    caseId: appointment.caseId,
    sourceService: "control-plane",
    title: "CX appointment released",
    summary: `Appointment released for case ${appointment.caseId}`,
    payload: {
      appointmentId,
      releasedByEmail: context.account.email,
      reason: input.reason || input.note || null,
    },
  }).catch(() => null);
  return {
    ok: true,
    domain: context.domain,
    appointment: updated?.toObject ? updated.toObject() : updated,
  };
}

async function fireOneDueAppointment(appointment, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const queueItem =
    appointment.cxQueueRecordId
      ? queueItemObject(await cxDialQueueRepository.findQueueItemById(appointment.cxQueueRecordId))
      : queueItemObject(await cxDialQueueRepository.findActiveQueueItem(
        appointment.domain,
        appointment.caseId,
      ));
  let effectiveQueueItem = queueItem;
  if (!effectiveQueueItem) {
    const queueResult = await queueCxDialRequest({
      domain: appointment.domain,
      caseId: appointment.caseId,
      actionKey: appointment.queueActionKey || buildAppointmentActionKey(appointment.appointmentId),
      phone: appointment.phone || null,
      name: appointment.prospectName || null,
      sourceName: appointment.sourceName || null,
      intakeSource: appointment.intakeSource || null,
      intakeRoute: appointment.intakeRoute || "appointment",
      queueFamily: "fresh-day2to10",
      queueTier: "later",
      releaseAt: now,
      requestedBy: "cx-appointment-due",
      requestedByUserEmail: appointment.agentEmail || null,
      metadata: {
        appointmentId: appointment.appointmentId,
        appointmentStatus: "due",
        dialabilityHoldReason: "appointment",
        assignedExtensionId: appointment.agentExtensionId,
        assignedAgentName: appointment.agentName || null,
      },
    });
    if (!queueResult?.queued || queueResult.skipped) {
      await cxAppointmentRepository.patchAppointment(
        appointment.appointmentId,
        {
          status: "blocked",
          blockedReason: queueResult?.reason || queueResult?.error || "queue-create-failed",
          updatedByEmail: "appointment-worker",
        },
        {
          type: "appointment-blocked",
          actorEmail: "appointment-worker",
          payload: queueResult,
        },
      );
      return {
        ok: false,
        appointmentId: appointment.appointmentId,
        caseId: appointment.caseId,
        reason: queueResult?.reason || queueResult?.error || "queue-create-failed",
      };
    }
    effectiveQueueItem = queueResult.queueItem;
  }

  const timing = resolveQueueDialTimeWindow(effectiveQueueItem || appointment, now);
  if (!timing.allowed) {
    const nextAt = timing.nextAllowedAt || new Date(now.getTime() + 15 * 60 * 1000);
    const updated = await cxAppointmentRepository.patchAppointment(
      appointment.appointmentId,
      {
        status: "scheduled",
        legalDialAt: nextAt,
        legalDialTimezone: timing.timeZone || appointment.legalDialTimezone,
        legalDialReason: timing.reason || "deferred-to-legal-window",
        blockedReason: timing.reason || null,
        updatedByEmail: "appointment-worker",
      },
      {
        type: "appointment-deferred",
        actorEmail: "appointment-worker",
        payload: {
          reason: timing.reason,
          nextAllowedAt: nextAt,
          timeZone: timing.timeZone,
        },
      },
    );
    await cxAppointmentRepository.mirrorAgentAppointment(appointment.agentExtensionId, updated).catch(() => null);
    if (effectiveQueueItem?._id) {
      await cxDialQueueRepository.updateQueueItem(effectiveQueueItem._id, {
        state: "paused",
        releaseAt: nextAt,
        claimUntil: null,
        "metadata.appointmentStatus": "scheduled",
        "metadata.dialabilityHoldUntil": nextAt,
        "metadata.appointmentDeferredReason": timing.reason || null,
      }).catch(() => null);
    }
    return {
      ok: true,
      deferred: true,
      appointmentId: appointment.appointmentId,
      caseId: appointment.caseId,
      nextAllowedAt: nextAt,
      reason: timing.reason,
    };
  }

  const queueItemId = String(effectiveQueueItem?._id || "").trim();
  const firedQueueItem = queueItemId
    ? await cxDialQueueRepository.transitionQueueItemState(
      queueItemId,
      ["queued", "ready", "claimed", "paused"],
      {
        state: "ready",
        releaseAt: now,
        claimUntil: null,
        priorityScore: Math.max(Number(effectiveQueueItem.priorityScore || 0) || 0, APPOINTMENT_PRIORITY),
        assignment: {
          extensionId: appointment.agentExtensionId,
          agentName: appointment.agentName || null,
          assignedAt: effectiveQueueItem.assignment?.assignedAt || now,
          queueFamilySnapshot: effectiveQueueItem.assignment?.queueFamilySnapshot || effectiveQueueItem.queueFamily || null,
        },
        "metadata.appointmentId": appointment.appointmentId,
        "metadata.appointmentStatus": "fired",
        "metadata.appointmentFiredAt": now,
        "metadata.queueReason": "appointment-due",
        "metadata.dialabilityHoldReason": null,
        "metadata.dialabilityHoldUntil": null,
        "metadata.assignedExtensionId": appointment.agentExtensionId,
        "metadata.assignedAgentName": appointment.agentName || null,
      },
      { returnNew: true },
    )
    : null;
  if (queueItemId && !firedQueueItem) {
    const updated = await cxAppointmentRepository.patchAppointment(
      appointment.appointmentId,
      {
        status: "blocked",
        blockedReason: `queue-state-not-fireable:${String(effectiveQueueItem?.state || "missing")}`,
        updatedByEmail: "appointment-worker",
      },
      {
        type: "appointment-blocked",
        actorEmail: "appointment-worker",
        payload: {
          queueItemId,
          queueState: effectiveQueueItem?.state || null,
        },
      },
    );
    await cxAppointmentRepository.mirrorAgentAppointment(appointment.agentExtensionId, updated).catch(() => null);
    return {
      ok: false,
      appointmentId: appointment.appointmentId,
      caseId: appointment.caseId,
      reason: "queue-state-not-fireable",
      queueItemId,
      queueState: effectiveQueueItem?.state || null,
    };
  }
  const updated = await cxAppointmentRepository.patchAppointment(
    appointment.appointmentId,
    {
      status: "fired",
      firedAt: now,
      cxQueueRecordId: queueItemId || appointment.cxQueueRecordId || null,
      updatedByEmail: "appointment-worker",
      blockedReason: null,
    },
    {
      type: "appointment-fired",
      actorEmail: "appointment-worker",
      payload: {
        queueItemId,
      },
    },
  );
  await cxAppointmentRepository.patchAgentAppointment(
    appointment.agentExtensionId,
    appointment.appointmentId,
    {
      status: "fired",
      cxQueueRecordId: queueItemId || appointment.cxQueueRecordId || null,
    },
  ).catch(() => null);
  await recordWorkflowStage({
    domain: appointment.domain,
    family: "cx",
    subtype: "appointment",
    stage: "fired",
    aggregateType: "cx-appointment",
    aggregateId: appointment.appointmentId,
    caseId: appointment.caseId,
    sourceService: "control-plane",
    title: "CX appointment fired",
    summary: `Appointment placed at top of queue for case ${appointment.caseId}`,
    payload: {
      appointmentId: appointment.appointmentId,
      queueItemId,
      agentExtensionId: appointment.agentExtensionId,
    },
  }).catch(() => null);
  return {
    ok: true,
    fired: true,
    appointment: updated?.toObject ? updated.toObject() : updated,
    queueItem: queueItemObject(firedQueueItem) || effectiveQueueItem,
  };
}

async function runDueCxAppointments(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  const due = await cxAppointmentRepository.listDueAppointments(now, limit);
  const results = [];
  for (const appointment of due) {
    try {
      results.push(await fireOneDueAppointment(appointment, { now }));
    } catch (error) {
      results.push({
        ok: false,
        appointmentId: appointment.appointmentId,
        caseId: appointment.caseId,
        error: error.message,
      });
    }
  }
  return {
    ok: true,
    checked: due.length,
    fired: results.filter((row) => row.fired).length,
    deferred: results.filter((row) => row.deferred).length,
    blocked: results.filter((row) => row.ok === false).length,
    results,
  };
}

async function fireCxAppointmentNow(domain, user, input = {}) {
  const context = await resolveCxAppointmentContext(domain, user);
  const appointmentId = String(input.appointmentId || input.id || "").trim();
  if (!appointmentId) {
    const error = new Error("appointmentId is required");
    error.status = 400;
    throw error;
  }

  const appointment = await cxAppointmentRepository.findAppointmentById(appointmentId);
  if (!appointment || normalizeDomain(appointment.domain) !== context.domain) {
    const error = new Error("Appointment not found");
    error.status = 404;
    throw error;
  }

  const appointmentAgentExtensionId = String(appointment.agentExtensionId || "").trim();
  if (
    appointmentAgentExtensionId &&
    appointmentAgentExtensionId !== context.account.extensionId &&
    !isAdminUser(context.account)
  ) {
    const error = new Error(`This appointment belongs to ${appointment.agentName || appointmentAgentExtensionId}`);
    error.status = 409;
    throw error;
  }

  if (!ACTIVE_STATUSES.has(String(appointment.status || ""))) {
    const error = new Error(`Appointment is not active: ${appointment.status || "unknown"}`);
    error.status = 409;
    throw error;
  }
  if (input.requirePhone && !normalizePhone(appointment.phone || "")) {
    const error = new Error("Appointment has no phone number to dial");
    error.status = 409;
    throw error;
  }

  const result = await fireOneDueAppointment(appointment, { now: input.now || new Date() });
  return {
    ok: Boolean(result?.ok),
    manual: true,
    domain: context.domain,
    appointmentId,
    result,
  };
}

async function resolveCxAppointmentAfterDisposition({
  domain,
  caseId,
  queueItem = null,
  queueItemId = null,
  disposition = null,
  actorEmail = null,
  cancel = false,
} = {}) {
  const appointmentId = String(queueItem?.metadata?.appointmentId || "").trim();
  let appointment = appointmentId
    ? await cxAppointmentRepository.findAppointmentById(appointmentId)
    : null;
  if (!appointment && domain && caseId != null) {
    appointment = await cxAppointmentRepository.findActiveAppointmentForCase(domain, caseId);
  }
  if (!appointment || !ACTIVE_STATUSES.has(String(appointment.status || ""))) return null;
  if (!["due", "fired", "blocked"].includes(String(appointment.status || "")) && !cancel) {
    return {
      skipped: true,
      reason: "appointment-not-fired",
      appointmentId: appointment.appointmentId,
      status: appointment.status,
    };
  }
  const now = new Date();
  const nextStatus = cancel ? "cancelled" : "completed";
  const resolvedDisposition = disposition || (cancel ? "cancelled" : "completed");
  const updated = await cxAppointmentRepository.patchAppointment(
    appointment.appointmentId,
    {
      status: nextStatus,
      resolvedAt: now,
      resolvedByEmail: actorEmail || null,
      resolvedDisposition,
      updatedByEmail: actorEmail || "system",
    },
    {
      type: cancel ? "appointment-cancelled" : "appointment-completed",
      actorEmail: actorEmail || null,
      payload: {
        disposition: resolvedDisposition,
        queueItemId,
      },
    },
  );
  await cxAppointmentRepository.removeAgentAppointment(
    appointment.agentExtensionId,
    appointment.appointmentId,
  ).catch(() => null);
  if (queueItemId || appointment.cxQueueRecordId) {
    await cxDialQueueRepository.updateQueueItem(queueItemId || appointment.cxQueueRecordId, {
      "metadata.appointmentStatus": nextStatus,
      "metadata.appointmentResolvedAt": now,
      "metadata.appointmentResolvedDisposition": resolvedDisposition,
      "metadata.dialabilityHoldReason": null,
      "metadata.dialabilityHoldUntil": null,
    }).catch(() => null);
  }
  return {
    ok: true,
    appointment: updated?.toObject ? updated.toObject() : updated,
  };
}

async function cancelCxAppointmentsForCase(domain, caseId, options = {}) {
  const appointment = await cxAppointmentRepository.findActiveAppointmentForCase(domain, caseId);
  if (!appointment) return null;
  return resolveCxAppointmentAfterDisposition({
    domain,
    caseId,
    queueItemId: appointment.cxQueueRecordId || null,
    disposition: options.disposition || options.reason || "status-change",
    actorEmail: options.actorEmail || null,
    cancel: true,
  });
}

module.exports = {
  cancelCxAppointmentsForCase,
  createCxAppointment,
  fireCxAppointmentNow,
  listCxAppointments,
  releaseCxAppointment,
  resolveCxAppointmentAfterDisposition,
  runDueCxAppointments,
};
