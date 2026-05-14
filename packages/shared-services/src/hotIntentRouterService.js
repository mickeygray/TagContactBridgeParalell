"use strict";

/**
 * Hot-intent SMS auto-router.
 *
 * Fires when the SMS classifier flags an inbound as "hot" (buying intent —
 * tax questions, asks for help, asks for pricing, etc.). Picks an available
 * rep via round-robin and stamps the routing decision on the
 * ConversationWorkflow. The rep's WYNN inbox surfaces it with a "Routed to
 * you" indicator on the next poll.
 *
 * "Available rep" definition (per product decision):
 *   - AgentState.cxRouting.desiredAvailability === "available"   (toggle ON)
 *   - AgentState.appPresence.lastSeenAt within HEARTBEAT_FRESH_MS    (active)
 *
 * Round-robin cursor: AgentState.cxRouting.lastHotIntentRoutedAt.
 *   - The available rep with the OLDEST value wins (null = "never routed
 *     to" = wins first).
 *   - After routing, we bump that field to now() so the next hot inbound
 *     picks the next rep. Naturally rotates without a separate counter.
 *
 * Idempotency: if the workflow is already routed and the routing is still
 * fresh (within ROUTING_FRESH_MS) we no-op so a hot follow-up message
 * doesn't bounce the assignment to a different rep mid-conversation.
 * Once that window passes, a new hot inbound rotates to the next rep.
 *
 * Universal-queue insertion: NOT done yet. The actual CX-queue boost
 * depends on phone→case lookup at SMS ingest, which is still pending.
 * Until that lands, the stamped routedToAgentId is the source of truth
 * for ownership and the rep's inbox UI is the only surface.
 */

const {
  agentStateRepository,
  conversationWorkflowRepository,
} = require("../../shared-repositories/src");
const { AgentState } = require("../../shared-models/src");

// How recent the heartbeat must be for the agent to count as "active in
// the CX shell". Five minutes is wide enough to span a coffee break but
// narrow enough to drop reps who closed the browser.
const HEARTBEAT_FRESH_MS = 5 * 60 * 1000;

// How long a routing assignment stays "owned" by the picked rep. After
// this window, a fresh hot inbound on the same thread reopens routing.
const ROUTING_FRESH_MS = 30 * 60 * 1000;

function isAvailableForHotIntent(agent) {
  if (!agent) return false;
  if (agent.cxRouting?.desiredAvailability !== "available") return false;
  const lastSeen = agent.appPresence?.lastSeenAt
    ? new Date(agent.appPresence.lastSeenAt).getTime()
    : 0;
  if (!lastSeen) return false;
  return Date.now() - lastSeen <= HEARTBEAT_FRESH_MS;
}

/**
 * Returns the list of agents currently in the round-robin pool. Empty
 * list means no one's available — caller falls back to "no rep routed,
 * stays in the inbox unrouted until someone toggles on".
 *
 * @param {string} domain - "WYNN" / "TAG" (filters by AgentState.company)
 */
async function listAvailableHotIntentAgents(domain) {
  const all = await agentStateRepository.listAgentStates({
    company: String(domain || "").toUpperCase(),
  });
  return all.filter(isAvailableForHotIntent);
}

/**
 * Pick the next agent to route to using least-recently-routed-wins.
 * Agents that have never been routed (lastHotIntentRoutedAt == null)
 * sort first via the null-safe key.
 */
function pickNextRoundRobin(agents) {
  if (!Array.isArray(agents) || agents.length === 0) return null;
  const sorted = [...agents].sort((a, b) => {
    const at = a.cxRouting?.lastHotIntentRoutedAt
      ? new Date(a.cxRouting.lastHotIntentRoutedAt).getTime()
      : 0;
    const bt = b.cxRouting?.lastHotIntentRoutedAt
      ? new Date(b.cxRouting.lastHotIntentRoutedAt).getTime()
      : 0;
    return at - bt;
  });
  return sorted[0];
}

/**
 * Route a hot-intent SMS workflow to the next available rep.
 *
 * @param {Object} input
 * @param {string} input.workflowId   - ConversationWorkflow._id
 * @param {string} input.domain       - "WYNN" / "TAG"
 * @param {string} [input.reason]     - classifier hot_intent_reason, for logging
 * @returns {Promise<{
 *   routed: boolean,
 *   skipReason?: string,
 *   agent?: { extensionId: string, name: string },
 *   workflow?: Object,
 * }>}
 */
async function autoRouteHotInboundWorkflow(input = {}) {
  const workflowId = String(input.workflowId || "").trim();
  if (!workflowId) {
    return { routed: false, skipReason: "no-workflow-id" };
  }
  const domain = String(input.domain || "WYNN").toUpperCase();

  const workflow = await conversationWorkflowRepository.findConversationWorkflowById(workflowId);
  if (!workflow) {
    return { routed: false, skipReason: "workflow-not-found" };
  }

  // Idempotency: already routed and still fresh → leave alone.
  const existingRoutedAt = workflow.routedAt
    ? new Date(workflow.routedAt).getTime()
    : 0;
  if (
    workflow.routedToAgentId &&
    existingRoutedAt &&
    Date.now() - existingRoutedAt < ROUTING_FRESH_MS
  ) {
    return {
      routed: false,
      skipReason: "already-routed-and-fresh",
      agent: {
        extensionId: workflow.routedToAgentId,
        name: workflow.routedToAgentName || "",
      },
      workflow,
    };
  }

  const available = await listAvailableHotIntentAgents(domain);
  const pick = pickNextRoundRobin(available);
  if (!pick) {
    return { routed: false, skipReason: "no-available-agents", workflow };
  }

  const now = new Date();
  const updatedWorkflow = await conversationWorkflowRepository.updateConversationWorkflowById(
    workflowId,
    {
      routedToAgentId: String(pick.extensionId),
      routedToAgentName: String(pick.name || ""),
      routedAt: now,
      // routedQueueItemId stays null until phone→case lookup lands and
      // we can actually create/boost a universal-queue item.
    },
  );

  // Bump the cursor on the picked rep so the next hot inbound goes to
  // the next agent in rotation. Use a direct model update to keep this
  // service self-contained (the repository doesn't expose a "bump
  // cursor" helper).
  await AgentState.updateOne(
    { extensionId: pick.extensionId },
    { $set: { "cxRouting.lastHotIntentRoutedAt": now } },
  );

  return {
    routed: true,
    agent: {
      extensionId: pick.extensionId,
      name: pick.name,
    },
    workflow: updatedWorkflow,
  };
}

module.exports = {
  autoRouteHotInboundWorkflow,
  isAvailableForHotIntent,
  listAvailableHotIntentAgents,
  pickNextRoundRobin,
  HEARTBEAT_FRESH_MS,
  ROUTING_FRESH_MS,
};
