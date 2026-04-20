"use strict";

async function requestPhoneBurnerDispatch({ domain, caseId, phone, name }) {
  return {
    ok: false,
    skipped: true,
    reason: "phoneburner-not-wired-yet",
    payload: {
      domain,
      caseId,
      phone,
      name,
    },
  };
}

module.exports = {
  requestPhoneBurnerDispatch,
};
