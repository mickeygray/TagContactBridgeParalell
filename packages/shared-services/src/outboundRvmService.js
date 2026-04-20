"use strict";

const { createDropClient } = require("../../shared-integrations/src");

async function sendOutboundRvm({ domain, toPhone, caseId, name, source, audioUrl }) {
  if (!toPhone) {
    return { ok: false, skipped: true, reason: "missing-phone" };
  }

  const client = createDropClient(domain);
  const response = await client.dropVoicemail({
    phone: toPhone,
    caseId,
    name,
    source: source || "outbound-gateway",
    audioUrl,
  });

  return {
    ok: true,
    provider: "drop",
    response,
  };
}

module.exports = {
  sendOutboundRvm,
};
