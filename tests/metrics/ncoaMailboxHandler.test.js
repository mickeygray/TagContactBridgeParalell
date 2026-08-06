"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createNcoaHandler } = require("../../packages/shared-services/src/ncoaMailboxHandler");

const CONFIG = {
  domain: "TAG",
  gmailQuery: "is:unread has:attachment",
  acceptedExtensions: [".csv", ".txt"],
  outDir: "/tmp/ncoa-test",
  markRead: true,
  archiveProcessed: true,
};

/** A stand-in for ncoaMailboxIngestService that records what it was asked to do. */
function fakeService(over = {}) {
  const calls = [];
  return {
    calls,
    buildConfig: () => CONFIG,
    processAttachment: async (args) => {
      calls.push(args);
      return { filename: args.part.filename, total: 10, succeeded: 10, failed: 0 };
    },
    ...over,
  };
}

const csv = (name = "ncoa_return.csv") => ({
  filename: name, buffer: Buffer.from("a,b\n1,2\n"), attachmentId: "att1",
});

test("takes its query and extensions from the shared config, not its own defaults", () => {
  const h = createNcoaHandler({ service: fakeService(), config: CONFIG });
  assert.equal(h.key, "ncoa");
  // An invented "has:attachment newer_than:2d" would widen the scan and change
  // which mail is even considered.
  assert.equal(h.gmailQuery, "is:unread has:attachment");
});

test("accepts a CSV and refuses the vendor's invoice PDF on the same mailbox", () => {
  const h = createNcoaHandler({ service: fakeService(), config: CONFIG });
  assert.equal(h.accepts([csv()]), true);
  assert.equal(h.accepts([{ filename: "83648_Invoice.pdf", buffer: Buffer.from("%PDF-") }]), false);
  assert.equal(h.accepts([]), false);
});

test("passes the already-downloaded buffer through rather than refetching", async () => {
  const svc = fakeService();
  const h = createNcoaHandler({ service: svc, config: CONFIG });
  const a = csv();
  await h.process({ attachments: [a], message: { id: "m1" }, messageId: "m1", apply: true, gmail: null });
  assert.equal(svc.calls.length, 1);
  assert.equal(svc.calls[0].buffer, a.buffer);
  // No client handed down: a refetch would have to go through it.
  assert.equal(svc.calls[0].gmail, null);
});

test("apply:false runs the pass without claiming the message", async () => {
  const svc = fakeService();
  const h = createNcoaHandler({ service: svc, config: CONFIG });
  const r = await h.process({ attachments: [csv()], message: { id: "m1" }, apply: false, gmail: null });
  assert.equal(svc.calls[0].dryRun, true);
  // written:false keeps the message unclaimed, so a dry run stays repeatable.
  assert.equal(r.written, false);
});

test("marks read and archives after a clean pass", async () => {
  const modified = [];
  const gmail = { modifyMessage: async (id, opts) => { modified.push({ id, opts }); } };
  const h = createNcoaHandler({ service: fakeService(), config: CONFIG });
  await h.process({ attachments: [csv()], message: { id: "m1" }, apply: true, gmail });
  assert.equal(modified.length, 1);
  assert.deepEqual(modified[0].opts.removeLabelIds, ["UNREAD", "INBOX"]);
});

test("leaves the message unread when any file failed", async () => {
  // The query is unread-scoped, so the flag is what brings a bad message back.
  const modified = [];
  const gmail = { modifyMessage: async (id, o) => { modified.push({ id, o }); } };
  const svc = fakeService({
    processAttachment: async (args) => {
      if (args.part.filename === "bad.csv") throw new Error("logics rejected the batch");
      return { filename: args.part.filename, total: 1, succeeded: 1 };
    },
  });
  const h = createNcoaHandler({ service: svc, config: CONFIG });
  const r = await h.process({
    attachments: [csv("good.csv"), csv("bad.csv")], message: { id: "m1" }, apply: true, gmail,
  });
  assert.equal(modified.length, 0, "a failed file must leave the message unread");
  assert.equal(r.summary.skipped, 1);
  assert.equal(r.summary.uploaded, 1);
});

test("one bad CSV does not cost the others on the same message", async () => {
  const svc = fakeService({
    processAttachment: async (args) => {
      if (args.part.filename === "bad.csv") throw new Error("parse failed");
      return { filename: args.part.filename, total: 5, succeeded: 5 };
    },
  });
  const h = createNcoaHandler({ service: svc, config: CONFIG });
  const r = await h.process({
    attachments: [csv("a.csv"), csv("bad.csv"), csv("c.csv")],
    message: { id: "m1" }, apply: true, gmail: null,
  });
  assert.equal(r.summary.uploaded, 2);
  assert.equal(r.summary.rows, 10);
});

test("does not mark read when the config says not to", async () => {
  const modified = [];
  const gmail = { modifyMessage: async () => { modified.push(1); } };
  const h = createNcoaHandler({
    service: fakeService({ buildConfig: () => ({ ...CONFIG, markRead: false }) }),
    config: { ...CONFIG, markRead: false },
  });
  await h.process({ attachments: [csv()], message: { id: "m1" }, apply: true, gmail });
  assert.equal(modified.length, 0);
});

test("reports the resolved domain, not the caller's blank parameter", async () => {
  const h = createNcoaHandler({ service: fakeService(), config: CONFIG });
  const r = await h.process({ attachments: [csv()], message: { id: "m1" }, apply: true, gmail: null });
  assert.equal(r.summary.domain, "TAG");
});
