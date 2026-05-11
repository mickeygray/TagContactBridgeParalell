"use strict";

const { createCallFireClient } = require("../../shared-integrations/src");

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return digits;
  if (digits.length === 10) return `1${digits}`;
  return digits;
}

function buildTemplateClone(template, overrides = {}) {
  // Sound resolution policy:
  //   1. If the operator passed `messageText`, honor it via TTS (a
  //      campaign-specific override from the CampaignBuilder body).
  //   2. Else if env vars provide live/machine TTS defaults, use those.
  //      This is how we inject a "press 1 to be connected" prompt
  //      without having to re-record the template audio in CallFire.
  //   3. Else prefer the template's pre-recorded `*SoundId` files —
  //      the official Wynn voiceovers, falling back to the template's
  //      `*SoundText` only when no recording is present.
  // The previous version always overrode with TTS, which is why
  // recipients heard a placeholder line instead of the Wynn audio.
  const operatorMessage = overrides.messageText && String(overrides.messageText).trim();
  const envLive = String(process.env.CALLFIRE_LIVE_MESSAGE_TEXT || "").trim();
  const envMachine = String(process.env.CALLFIRE_MACHINE_MESSAGE_TEXT || "").trim();
  const hasMessageOverride = Boolean(operatorMessage);
  const hasEnvDefaults = Boolean(envLive || envMachine);

  const sounds = {};

  if (hasMessageOverride) {
    const text = String(operatorMessage);
    sounds.liveSoundText = text;
    sounds.machineSoundText = text;
    sounds.dncSoundText = text;
  } else if (hasEnvDefaults) {
    // Apply env-driven defaults independently per channel so live can
    // include "press 1" while voicemail can include a callback number.
    if (envLive) {
      sounds.liveSoundText = envLive;
    } else if (template?.sounds?.liveSoundId) {
      sounds.liveSoundId = template.sounds.liveSoundId;
    } else if (template?.sounds?.liveSoundText) {
      sounds.liveSoundText = template.sounds.liveSoundText;
    }
    if (envMachine) {
      sounds.machineSoundText = envMachine;
    } else if (template?.sounds?.machineSoundId) {
      sounds.machineSoundId = template.sounds.machineSoundId;
    } else if (template?.sounds?.machineSoundText) {
      sounds.machineSoundText = template.sounds.machineSoundText;
    }
    if (template?.sounds?.dncSoundId) {
      sounds.dncSoundId = template.sounds.dncSoundId;
    } else if (template?.sounds?.dncSoundText) {
      sounds.dncSoundText = template.sounds.dncSoundText;
    } else if (envLive) {
      sounds.dncSoundText = envLive;
    }
  } else {
    if (template?.sounds?.liveSoundId) {
      sounds.liveSoundId = template.sounds.liveSoundId;
    } else if (template?.sounds?.liveSoundText) {
      sounds.liveSoundText = template.sounds.liveSoundText;
    }
    if (template?.sounds?.machineSoundId) {
      sounds.machineSoundId = template.sounds.machineSoundId;
    } else if (template?.sounds?.machineSoundText) {
      sounds.machineSoundText = template.sounds.machineSoundText;
    }
    if (template?.sounds?.dncSoundId) {
      sounds.dncSoundId = template.sounds.dncSoundId;
    } else if (template?.sounds?.dncSoundText) {
      sounds.dncSoundText = template.sounds.dncSoundText;
    }
  }

  sounds.dncDigit = template?.sounds?.dncDigit || "8";

  // Transfer config (live-answer bridge to an agent line). Resolution:
  //   1. Override (per-call params) wins.
  //   2. Else env vars CALLFIRE_TRANSFER_NUMBER / CALLFIRE_TRANSFER_DIGIT.
  //   3. Else whatever the template carries (template currently doesn't
  //      have transfer config, so this branch is mostly forward-looking).
  // If no transfer number resolves at any tier we omit transfer entirely
  // and the broadcast plays the message + hangs up — same legacy
  // behavior we had before the fix.
  const transferNumber =
    overrides.transferNumber ||
    process.env.CALLFIRE_TRANSFER_NUMBER ||
    template?.sounds?.transferNumber ||
    null;
  const transferDigit =
    overrides.transferDigit ||
    process.env.CALLFIRE_TRANSFER_DIGIT ||
    template?.sounds?.transferDigit ||
    "1";
  const transferSoundId =
    overrides.transferSoundId || template?.sounds?.transferSoundId || null;
  const transferSoundText =
    overrides.transferSoundText || template?.sounds?.transferSoundText || null;

  if (transferNumber) {
    sounds.transferNumber = String(transferNumber).replace(/\D/g, "");
    sounds.transferDigit = transferDigit;
    if (transferSoundId) {
      sounds.transferSoundId = transferSoundId;
    } else if (transferSoundText) {
      sounds.transferSoundText = transferSoundText;
    }
  }

  const broadcast = {
    name:
      overrides.name ||
      `TagContactBridge ${new Date().toLocaleString("en-US", { hour12: true })}`,
    fromNumber: overrides.fromNumber || template?.fromNumber,
    localTimeRestriction: template?.localTimeRestriction || { enabled: false },
    maxActive: overrides.maxActive || template?.maxActive || 1,
    resumeNextDay: false,
    retryConfig: {
      maxAttempts: 1,
      minutesBetweenAttempts: 60,
    },
    sounds,
    answeringMachineConfig: template?.answeringMachineConfig || "AM_AND_LIVE",
  };

  if (transferNumber) {
    broadcast.maxActiveTransfers =
      overrides.maxActiveTransfers ||
      template?.maxActiveTransfers ||
      50;
  }

  return broadcast;
}

async function sendOutboundCallFireDial({
  toPhone,
  name,
  caseId = null,
  broadcastName = null,
  messageText = null,
} = {}) {
  const client = createCallFireClient();
  const normalizedPhone = normalizePhone(toPhone);

  if (!normalizedPhone) {
    return { ok: false, reason: "missing-phone" };
  }

  if (!client.config.broadcastId) {
    return { ok: false, reason: "missing-template-broadcast-id" };
  }

  const template = await client.getBroadcast(client.config.broadcastId);
  const created = await client.createBroadcast(
    buildTemplateClone(template, {
      name: broadcastName,
      fromNumber: client.config.fromNumber || template?.fromNumber,
      messageText,
    }),
  );

  const broadcastId = created?.id;
  if (!broadcastId) {
    return {
      ok: false,
      reason: "broadcast-create-failed",
      created,
    };
  }

  const recipients = await client.addRecipientsToBroadcast(broadcastId, [
    {
      phoneNumber: normalizedPhone,
      attributes: {
        name: name || "Test Contact",
        caseId: caseId != null ? String(caseId) : "",
      },
    },
  ]);

  const started = await client.startBroadcast(broadcastId);

  return {
    ok: true,
    broadcastId,
    toPhone: normalizedPhone,
    created,
    recipients,
    started,
  };
}

async function sendOutboundCallFireDialBatch({
  recipients = [],
  broadcastName = null,
  messageText = null,
  maxActive = null,
} = {}) {
  const client = createCallFireClient();
  const normalizedRecipients = recipients
    .map((recipient) => ({
      phoneNumber: normalizePhone(recipient.phoneNumber || recipient.toPhone),
      attributes: {
        name: recipient.name || "Contact",
        caseId: recipient.caseId != null ? String(recipient.caseId) : "",
      },
      caseId: recipient.caseId != null ? Number(recipient.caseId) : null,
    }))
    .filter((recipient) => recipient.phoneNumber);

  if (normalizedRecipients.length === 0) {
    return { ok: false, reason: "missing-phone" };
  }

  if (!client.config.broadcastId) {
    return { ok: false, reason: "missing-template-broadcast-id" };
  }

  const template = await client.getBroadcast(client.config.broadcastId);
  const created = await client.createBroadcast(
    buildTemplateClone(template, {
      name: broadcastName,
      fromNumber: client.config.fromNumber || template?.fromNumber,
      messageText,
      maxActive: maxActive != null ? Number(maxActive) : undefined,
    }),
  );

  const broadcastId = created?.id;
  if (!broadcastId) {
    return {
      ok: false,
      reason: "broadcast-create-failed",
      created,
    };
  }

  const recipientsResult = await client.addRecipientsToBroadcast(
    broadcastId,
    normalizedRecipients.map((recipient) => ({
      phoneNumber: recipient.phoneNumber,
      attributes: recipient.attributes,
    })),
  );

  const started = await client.startBroadcast(broadcastId);

  return {
    ok: true,
    broadcastId,
    recipientCount: normalizedRecipients.length,
    recipients: normalizedRecipients,
    created,
    recipientsResult,
    started,
  };
}

module.exports = {
  normalizePhone,
  sendOutboundCallFireDial,
  sendOutboundCallFireDialBatch,
};
