"use strict";

const mongoose = require("mongoose");

const ACTIVE_QUEUE_STATES = Object.freeze([
  "in_pool",
  "in_slice",
  "fresh_assigned",
  "pending_assignment",
  "dialing",
]);

// QueueItem — one item in the Universal Call Queue (UCQ).
//
// Lifecycle:
//   in_pool            → cadence-due, sitting in the global FIFO pool
//   in_slice           → assigned to an agent's 10-batch slice (non-fresh)
//   fresh_assigned     → assigned to a single agent with a hard timer (fresh)
//   pending_assignment → fresh lead waiting for an eligible agent (off-hours
//                        or all-busy holding lane). No timer running yet.
//   dialing            → DialService placed the call, awaiting hangup
//   completed          → dispositioned (terminal)
//   recycled           → did-not-connect → returned to bottom of pool, soft-resets
//
// Partition vs ageBucket:
//   partition  = fresh | non_fresh           (drives queue/UI behavior)
//   ageBucket  = just_came_in | second_contact | third_contact   (within fresh)
//              | day2_10 | day16_30 | aged | dead (within non_fresh)
//
// FIFO ordering:
//   Within a partition, items sort by enteredQueueAt ASC (older first).
//   Recycled items get their enteredQueueAt bumped to "now" so they go to
//   the bottom of the bucket on cycle-back.
//
// Key indexes:
//   { partition: 1, state: 1, enteredQueueAt: 1 }   → pool reads
//   { assignedTo: 1, state: 1 }                     → per-agent slice reads
//   { state: 1, expiresAt: 1 }                      → fresh-timer sweep
//   { sliceId: 1 }                                  → slice teardown

const queueItemSchema = new mongoose.Schema(
  {
    leadId: { type: String, required: true, index: true },
    phoneNumber: { type: String, required: true },
    domain: { type: String, enum: ["TAG", "WYNN"], default: "TAG", index: true },

    partition: {
      type: String,
      enum: ["fresh", "non_fresh"],
      required: true,
      index: true,
    },
    ageBucket: {
      type: String,
      enum: [
        "just_came_in",
        "second_contact",
        "third_contact",
        "day2_10",
        "day16_30",
        "aged",
        "dead",
      ],
      required: true,
      index: true,
    },
    state: {
      type: String,
      enum: [
        "in_pool",
        "in_slice",
        "fresh_assigned",
        "pending_assignment",
        "dialing",
        "completed",
        "recycled",
      ],
      default: "in_pool",
      index: true,
    },

    // Assignment context (set when state ∈ {in_slice, fresh_assigned, dialing})
    assignedTo: { type: String, default: null, index: true },   // extensionId
    assignedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },                   // fresh only
    sliceId: { type: String, default: null },                   // non-fresh only

    // Ordering
    enteredQueueAt: { type: Date, default: Date.now, index: true },
    hourBucket: { type: String, default: null, index: true },   // "YYYY-MM-DD-HH" PT

    // Recycle / retry tracking
    recycleCount: { type: Number, default: 0 },
    lastDialedAt: { type: Date, default: null },

    // Disposition outcome (terminal record on this item)
    dispositionResult: {
      type: String,
      enum: [
        null,
        "did_not_connect",
        "callback",
        "dnc",
        "postdate",
        "inactive",
        "connected_no_sale",
        "connected_sale",
        "wrong_number",
        "voicemail",
      ],
      default: null,
    },
    dispositionAt: { type: Date, default: null },

    // Provenance — where did this come from
    sourceCadenceTaskId: { type: String, default: null, index: true },
    sourceLogicsCaseId: { type: String, default: null, index: true },

    // Cadence's idea of when this should next be touched (used as
    // secondary sort tiebreak; primary sort is enteredQueueAt FIFO).
    cadenceDueAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: "queueitems",
  },
);

queueItemSchema.index({ partition: 1, state: 1, enteredQueueAt: 1 });
queueItemSchema.index({ assignedTo: 1, state: 1 });
queueItemSchema.index({ state: 1, expiresAt: 1 });
queueItemSchema.index({ ageBucket: 1, state: 1, enteredQueueAt: 1 });
queueItemSchema.index(
  { leadId: 1 },
  {
    unique: true,
    partialFilterExpression: { state: { $in: ACTIVE_QUEUE_STATES } },
    name: "uq_queueitems_active_lead",
  },
);

const QueueItem = mongoose.models.ControlPlaneQueueItem
  || mongoose.model("ControlPlaneQueueItem", queueItemSchema);

module.exports = QueueItem;
module.exports.ACTIVE_QUEUE_STATES = ACTIVE_QUEUE_STATES;
