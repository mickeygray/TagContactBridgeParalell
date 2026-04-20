"use strict";

function buildContactTarget(payload = {}) {
  return {
    email: payload.email || payload.destinationEmail || payload.userEmail || "",
    phone: payload.phone || payload.destinationPhone || "",
    company: payload.company || null,
  };
}

module.exports = {
  buildContactTarget,
};
