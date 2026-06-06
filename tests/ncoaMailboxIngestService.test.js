"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { WorkflowRecord } = require("../packages/shared-models/src");
const {
  listMailboxMessageRefs,
  runNcoaMailboxIngestIfDue,
} = require("../packages/shared-services/src/ncoaMailboxIngestService");

function makeFindOneResult(value) {
  return {
    lean() {
      return Promise.resolve(value);
    },
  };
}

test("NCOA mailbox lists all Gmail pages instead of only the first result page", async () => {
  const calls = [];
  const gmail = {
    async listMessages(input) {
      calls.push(input);
      if (!input.pageToken) {
        return {
          messages: [{ id: "msg-1" }],
          nextPageToken: "page-2",
        };
      }
      return {
        messages: [{ id: "msg-2" }],
      };
    },
  };

  const result = await listMailboxMessageRefs(gmail, {
    gmailQuery: "is:unread has:attachment",
    maxMessages: 1,
    maxMessagePages: 3,
  });

  assert.equal(result.messages.length, 2);
  assert.equal(result.pagesScanned, 2);
  assert.deepEqual(result.messages.map((message) => message.id), ["msg-1", "msg-2"]);
  assert.deepEqual(calls.map((call) => call.pageToken || ""), ["", "page-2"]);
});

test("NCOA mailbox already-completed guard still runs when unread messages exist", async () => {
  const originalFindOne = WorkflowRecord.findOne;
  WorkflowRecord.findOne = () => makeFindOneResult({ _id: "completed-run" });
  try {
    const gmail = {
      async listMessages() {
        return { messages: [{ id: "msg-unread" }] };
      },
      async getMessage() {
        return {
          id: "msg-unread",
          payload: {
            headers: [],
            parts: [],
          },
        };
      },
    };

    const result = await runNcoaMailboxIngestIfDue({
      gmailClient: gmail,
      skipEmail: true,
      now: new Date("2026-06-05T12:00:00-07:00"),
      dateKey: "2026-06-05",
      config: {
        enabled: true,
        domain: "TAG",
        user: "documents@taxadvocategroup.com",
        gmailQuery: "is:unread has:attachment",
        maxMessages: 1,
        maxMessagePages: 2,
        activeWeekdays: [5],
        timezone: "America/Los_Angeles",
        acceptedExtensions: [".csv", ".txt"],
        outDir: process.cwd(),
        markRead: false,
        archiveProcessed: false,
        completeOnNoUnread: false,
        notifyRecipients: [],
        gmail: {},
      },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "no-attachments");
    assert.equal(result.messagesScanned, 1);
  } finally {
    WorkflowRecord.findOne = originalFindOne;
  }
});

test("NCOA mailbox already-completed guard skips only when no unread messages remain", async () => {
  const originalFindOne = WorkflowRecord.findOne;
  WorkflowRecord.findOne = () => makeFindOneResult({ _id: "completed-run" });
  try {
    const gmail = {
      async listMessages() {
        return {};
      },
    };

    const result = await runNcoaMailboxIngestIfDue({
      gmailClient: gmail,
      skipEmail: true,
      now: new Date("2026-06-05T12:00:00-07:00"),
      dateKey: "2026-06-05",
      config: {
        enabled: true,
        domain: "TAG",
        user: "documents@taxadvocategroup.com",
        gmailQuery: "is:unread has:attachment",
        maxMessages: 1,
        maxMessagePages: 2,
        activeWeekdays: [5],
        timezone: "America/Los_Angeles",
        acceptedExtensions: [".csv", ".txt"],
        outDir: process.cwd(),
        markRead: false,
        archiveProcessed: false,
        completeOnNoUnread: false,
        notifyRecipients: [],
        gmail: {},
      },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "already-completed-today");
    assert.equal(result.messagesScanned, 0);
  } finally {
    WorkflowRecord.findOne = originalFindOne;
  }
});
