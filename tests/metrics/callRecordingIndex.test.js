"use strict";

// The recording index. Its whole job is to be searched later, so the invariants
// that matter are about what a row PROMISES: a link that works, or an id to
// mint from — never a stored string that was only ever valid for 45 minutes.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const CallRecordingIndex = require("../../packages/shared-models/src/CallRecordingIndex");

const paths = () => CallRecordingIndex.schema.paths;

test("a call is ONE row — re-running a capture updates, never duplicates", () => {
  const unique = CallRecordingIndex.schema.indexes()
    .find(([fields, opts]) => opts?.unique
      && fields.provider === 1 && fields.providerCallId === 1);
  assert.ok(unique, "provider + providerCallId must be unique");
});

test("the two locator fields are separate, because the providers are not alike", () => {
  // A CallRail or PhoneBurner URL is durable and storable. A RingCentral URL
  // dies with its token, so what is stored is an id and the URL is minted per
  // request. Collapsing these into one field is how a dead link gets served.
  assert.ok(paths().playbackUrl, "playbackUrl — a URL that works on its own");
  assert.ok(paths().providerRef, "providerRef — the id a signed URL is minted from");
});

test("isDurable refuses to call a RingCentral row durable, even with a url set", () => {
  const rc = new CallRecordingIndex({
    provider: "ringcentral", providerCallId: "abc", dateKey: "2026-08-04",
    // Deliberately wrong on purpose: a writer bug, or a copied CallLog field.
    playbackUrl: "https://media.ringcentral.com/restapi/v1.0/.../content",
  });
  assert.equal(rc.isDurable(), false,
    "an RC url is not independently valid and must never be served as one");

  const cr = new CallRecordingIndex({
    provider: "callrail", providerCallId: "xyz", dateKey: "2026-08-04",
    playbackUrl: "https://app.callrail.com/calls/123/recording",
  });
  assert.equal(cr.isDurable(), true);
});

test("provider is an explicit enum, not whatever `platform` happened to say", () => {
  // CallLog stores RingCentral calls under platform "ex" — 6,454 in 30 days —
  // and there is no "ringcentral" value in it at all. ~252 CallRail rows are
  // mislabelled "ex" too. Copying platform across would carry both problems in.
  const enumValues = paths().provider.enumValues;
  assert.deepEqual([...enumValues].sort(), ["callrail", "phoneburner", "ringcentral", "ringcx"]);
  assert.ok(!enumValues.includes("ex"), "'ex' is a CallLog artefact, not a provider");
});

test("exclusion is recorded on the row, not enforced by absence", () => {
  // Today an excluded agent's recording is kept out by never being downloaded.
  // Once nothing downloads, that has nowhere to live — and a missing row cannot
  // tell you whether it was excluded or simply never captured.
  assert.ok(paths().excluded, "excluded must be a field");
  assert.ok(paths().excludedReason, "and it must say why");
});

test("the day is a Pacific dateKey, kept alongside the true instant", () => {
  assert.equal(paths().dateKey.isRequired, true);
  assert.ok(paths().startedAt, "the exact start survives too — they answer different questions");
});
