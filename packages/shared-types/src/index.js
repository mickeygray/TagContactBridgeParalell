"use strict";

const ROLES = Object.freeze({
  ADMIN: "admin",
  INTERNAL_AGENT: "internal-agent",
  WIDGET_USER: "widget-user",
  SERVICE: "service",
});

const AUDIENCES = Object.freeze({
  ADMIN: "admin",
  USER: "user",
});

module.exports = {
  AUDIENCES,
  ROLES,
};
