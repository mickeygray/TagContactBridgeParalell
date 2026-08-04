"use strict";

// MAILBOX INGEST — one Gmail loop, a registry of handlers.
//
// Mickey 2026-07-31, on the mail-invoice reader: "you might as well prepare the
// gmail reader since its basically a fork of the ncoa thing and probably can
// happen in the same function."
//
// He is right, and the fork is the thing to avoid. `ncoaMailboxIngestService`
// already knows how to page a Gmail query, walk MIME parts, pull an attachment
// and refuse to process the same one twice. All of that is identical for the
// vendor's daily mail invoice; only the query, the accept test and what to do
// with the bytes differ. Copying it would leave two loops to keep in step, and
// this repo has twice paid for a second copy of a shared rule drifting.
//
// So: the loop lives here once, and a new document type is a HANDLER, not a
// service.
//
// ── THE MESSAGE IS THE UNIT, NOT THE ATTACHMENT ────────────────────────────
//
// NCOA processes attachments independently — each CSV stands alone. The mail
// invoice does NOT: the vendor sends the invoice and its card receipt on the
// SAME email, and the receipt states the invoice's grand total. Handled one at
// a time, a receipt seen without its invoice has no way to know it is not a
// cost, and misfiling it would double the day's mail spend.
//
// So a handler receives every attachment on the message at once and decides as
// a set. That also makes "the email arrived but one attachment is missing"
// observable, which is the realistic failure when both ride one email.

const crypto = require("crypto");

const { createGoogleGmailClient } = require("../../shared-integrations/src");
const { WorkflowRecord } = require("../../shared-models/src");

const clean = (v, max = 500) => String(v || "").trim().slice(0, max);
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function messageHeader(message = {}, name) {
  const headers = message?.payload?.headers || [];
  const hit = headers.find((h) => String(h?.name || "").toLowerCase() === String(name).toLowerCase());
  return clean(hit?.value || "", 1000);
}

/**
 * Walk the MIME tree and collect every part that carries a filename.
 *
 * Keeps the whole `body`, because a SMALL attachment arrives inline as
 * `body.data` with no `attachmentId` at all. Matching only on attachmentId
 * silently drops those — and a one-page PDF is exactly the size Gmail inlines.
 */
function collectAttachmentParts(part = {}, out = []) {
  if (!part || typeof part !== "object") return out;
  const filename = clean(part.filename || "", 300);
  const body = part.body || {};
  if (filename && (body.attachmentId || body.data)) {
    out.push({
      filename,
      attachmentId: body.attachmentId || null,
      inlineData: body.data || null,
      mimeType: clean(part.mimeType || "", 120),
    });
  }
  for (const child of Array.isArray(part.parts) ? part.parts : []) collectAttachmentParts(child, out);
  return out;
}

/**
 * Get the bytes for one attachment part.
 *
 * MUST go through the client's `decodeData`. Gmail returns base64URL (`-` and
 * `_` for `+` and `/`), so a plain `Buffer.from(data, "base64")` decodes to
 * subtly wrong bytes — which for a PDF means a file that still starts with
 * %PDF- and then fails to inflate, i.e. a corrupt read that looks like a
 * parsing bug rather than a decoding one.
 */
async function readAttachmentBuffer(gmail, messageId, part) {
  if (part.inlineData) return gmail.decodeData(part.inlineData);
  if (!part.attachmentId) return null;
  const attachment = await gmail.getAttachment(messageId, part.attachmentId);
  if (!attachment?.data) return null;
  return gmail.decodeData(attachment.data);
}

/**
 * Open a mailbox. The ONE place a Gmail client is constructed.
 *
 * Mickey 2026-07-31: "turn the open gmail into an agnostic service that is
 * called in both functions."
 *
 * Agnostic means it knows nothing about NCOA or invoices — it takes a config
 * and an optional pre-built client (which is how tests inject a fake) and hands
 * back something that can list, fetch and decode. Every caller opening its own
 * client is how two callers end up authenticating differently.
 */
function openMailbox({ gmail = null, config = {} } = {}) {
  if (gmail) return gmail;
  return createGoogleGmailClient({ ...(config.gmail || {}), user: config.user });
}

/**
 * Page a Gmail query into a de-duplicated list of message refs.
 *
 * Shared with `ncoaMailboxIngestService`, which had its own copy. The return
 * shape carries BOTH namings (`pages`/`pagesScanned`) because NCOA's summary
 * already reports `pagesScanned` and quietly renaming a field somebody's
 * summary email prints is not a refactor, it is a bug.
 */
async function listMessageRefs(gmail, { gmailQuery, maxMessages = 25, maxPages = 5 } = {}) {
  const pageSize = Math.max(1, Math.min(500, Number(maxMessages) || 25));
  const pageCap = Math.max(1, Math.min(50, Number(maxPages) || 5));
  const messages = [];
  const seen = new Set();
  let pageToken = "";
  let pages = 0;
  for (;;) {
    const listed = await gmail.listMessages({ query: gmailQuery, maxResults: pageSize, pageToken });
    pages += 1;
    for (const m of Array.isArray(listed?.messages) ? listed.messages : []) {
      const id = clean(m?.id || "", 200);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      messages.push({ ...m, id });
    }
    pageToken = clean(listed?.nextPageToken || "", 500);
    if (!pageToken || pages >= pageCap) break;
  }
  return {
    messages,
    pages,
    pagesScanned: pages,
    truncated: Boolean(pageToken),
    pageSize,
    maxPages: pageCap,
  };
}

/**
 * Has this exact message already been handled by this handler?
 *
 * Keyed on MESSAGE, not attachment — because the message is the unit of work.
 * Re-running the reader over the same mailbox must be a no-op, and Gmail
 * queries are time-windowed rather than exact, so the same mail WILL be listed
 * again tomorrow.
 */
async function alreadyHandled(handlerKey, messageId) {
  const key = `mailbox:${handlerKey}:${messageId}`;
  const existing = await WorkflowRecord.findOne({ dedupeKey: key }).lean().catch(() => null);
  return { handled: Boolean(existing), key };
}

async function recordHandled(key, { handlerKey, messageId, summary }) {
  await WorkflowRecord.updateOne(
    { dedupeKey: key },
    {
      $set: {
        dedupeKey: key,
        workflow: "mailbox-ingest",
        stage: handlerKey,
        // Count-only. Never a subject line, a sender or an attachment name —
        // this record is operational bookkeeping, not a copy of the mail.
        payload: { messageId, ...summary },
        completedAt: new Date(),
      },
    },
    { upsert: true },
  ).catch(() => { /* bookkeeping must not fail the ingest */ });
}

/**
 * Run one pass.
 *
 * A handler is `{ key, gmailQuery, accepts(attachments) -> boolean,
 * process({ message, attachments, subject, from, receivedAt, apply }) }`.
 *
 * `apply: false` lists, downloads and classifies but never writes — the same
 * dry-run discipline every other ingest here has, so the funnel can be read
 * before anything is armed.
 */
async function runMailboxIngest({
  handlers = [],
  apply = false,
  maxMessages = 25,
  maxPages = 5,
  gmail = null,
  config = {},
  logger = null,
} = {}) {
  if (!Array.isArray(handlers) || !handlers.length) throw new TypeError("at least one handler is required");
  const client = openMailbox({ gmail, config });
  const out = { apply, handlers: {}, errors: 0 };

  for (const handler of handlers) {
    const stat = {
      listed: 0, alreadyHandled: 0, accepted: 0, processed: 0, skipped: 0, errors: 0, results: [],
    };
    out.handlers[handler.key] = stat;
    try {
      const { messages, truncated } = await listMessageRefs(client, {
        gmailQuery: handler.gmailQuery, maxMessages, maxPages,
      });
      stat.listed = messages.length;
      stat.truncated = truncated;

      for (const ref of messages) {
        try {
          const { handled, key } = await alreadyHandled(handler.key, ref.id);
          if (handled) { stat.alreadyHandled += 1; continue; }

          const message = await client.getMessage(ref.id);
          const parts = collectAttachmentParts(message?.payload || {});
          // Download once, hand the whole set to the handler — see the header.
          const attachments = [];
          for (const p of parts) {
            const buf = await readAttachmentBuffer(client, ref.id, p);
            if (!buf) continue;
            attachments.push({ ...p, buffer: buf, sha256: sha256(buf) });
          }

          if (!handler.accepts(attachments, { message })) { stat.skipped += 1; continue; }
          stat.accepted += 1;

          const result = await handler.process({
            message,
            attachments,
            messageId: ref.id,
            threadId: clean(message?.threadId || "", 200),
            subject: messageHeader(message, "Subject"),
            from: messageHeader(message, "From"),
            receivedAt: message?.internalDate ? new Date(Number(message.internalDate)) : null,
            apply,
            logger,
          });
          stat.results.push(result);
          if (result?.written) stat.processed += 1;
          // Only a real write claims the message. A dry run must be repeatable.
          if (apply && result?.written) await recordHandled(key, { handlerKey: handler.key, messageId: ref.id, summary: result.summary || {} });
        } catch (error) {
          stat.errors += 1;
          out.errors += 1;
          logger?.warn?.("mailbox_ingest.message_failed", {
            handler: handler.key, error: String(error.message).slice(0, 140),
          });
        }
      }
    } catch (error) {
      stat.errors += 1;
      out.errors += 1;
      stat.listFailed = String(error.message).slice(0, 140);
      // A mailbox we could not read is NOT an empty mailbox. Saying so is the
      // difference between "they sent nothing" and "we could not look".
      logger?.warn?.("mailbox_ingest.list_failed", {
        handler: handler.key, error: stat.listFailed,
      });
    }
  }
  return out;
}

module.exports = {
  openMailbox,
  collectAttachmentParts,
  readAttachmentBuffer,
  listMessageRefs,
  messageHeader,
  alreadyHandled,
  runMailboxIngest,
};
