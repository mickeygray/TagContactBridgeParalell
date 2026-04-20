"use strict";

const {
  buildDispatchList,
  getDispatchList,
  listDispatchLists,
  queueDispatchList,
} = require("./dispatchListService");

function buildWorkList(input = {}) {
  return buildDispatchList({
    family: input.family || "dispatch",
    subtype: input.subtype || null,
    consumerService: input.consumerService || null,
    ...input,
  });
}

function queueWorkList(input = {}) {
  return queueDispatchList({
    family: input.family || "dispatch",
    subtype: input.subtype || null,
    consumerService: input.consumerService || null,
    ...input,
  });
}

function getWorkList(id) {
  return getDispatchList(id);
}

function listWorkLists(domain, filters = {}) {
  return listDispatchLists(domain, filters);
}

module.exports = {
  buildWorkList,
  getWorkList,
  listWorkLists,
  queueWorkList,
};
