"use strict";
const {
  getCompanyConfig,
  getFbPageToken,
  getIgPageToken,
  getCompanyKeys,
  resolveCompanyFromFbPageId,
} = require("../../shared-config/src");
const {
  socialResponderConfigRepository,
} = require("../../shared-repositories/src");
const { emitHourlyJobEvent } = require("./hourlyJobEventService");

const GRAPH_API = "https://graph.facebook.com/v21.0";
const conversations = {
  facebook: new Map(),
  instagram: new Map(),
};
const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;
const EVENT_DEDUPE_TTL_MS = 15 * 60 * 1000;
const recentWebhookEvents = {
  facebook: new Map(),
  instagram: new Map(),
};
const DEFAULT_KEYWORDS = Object.freeze([
  "relief",
  "help",
  "owe",
  "irs",
  "tax",
  "debt",
  "garnish",
  "levy",
  "lien",
  "qualify",
  "solution",
  "info",
  "plan",
  "options",
]);

const DEFAULT_TEMPLATES = Object.freeze({
  facebook: {
    commentReplyTemplate:
      "Thanks for reaching out, {{firstName}}. Send us a message with {{keyword}} and we’ll help you get started.",
    directReplyTemplate:
      "Hi {{firstName}} — thanks for your message to {{brandName}}. A team member can help you get started. Reply here and we’ll follow up.",
  },
  instagram: {
    commentReplyTemplate:
      "Thanks for reaching out, {{firstName}}. Send us a DM @{{brandHandle}} with {{keyword}} and we’ll help you get started.",
    directReplyTemplate:
      "Hi {{firstName}} — thanks for messaging {{brandName}}. A team member can help you get started. Reply here and we’ll follow up.",
  },
});
const QUESTIONS = Object.freeze({
  q1_tax_issue: {
    text: "Hi there! I'm here to help you find out if you may qualify for tax relief.\n\nDo you currently have a tax debt or unfiled tax returns?",
    quickReplies: [
      { title: "Yes", payload: "Q1_YES" },
      { title: "No", payload: "Q1_NO" },
      { title: "Not sure", payload: "Q1_NOTSURE" },
    ],
    next: (payload) => {
      if (payload === "Q1_NO") return "exit_no_issue";
      return "q2_tax_type";
    },
  },
  q2_tax_type: {
    text: "What type of tax is this related to?",
    quickReplies: [
      { title: "Income tax", payload: "Q2_INCOME" },
      { title: "Payroll tax", payload: "Q2_PAYROLL" },
      { title: "Sales/Use tax", payload: "Q2_SALES" },
      { title: "Unemployment tax", payload: "Q2_UNEMPLOYMENT" },
    ],
    next: (payload) => {
      if (payload === "Q2_SALES" || payload === "Q2_UNEMPLOYMENT") {
        return "exit_wrong_type";
      }
      return "q3_jurisdiction";
    },
    storeAs: "taxType",
    valueMap: {
      Q2_INCOME: "income",
      Q2_PAYROLL: "payroll",
      Q2_SALES: "sales",
      Q2_UNEMPLOYMENT: "unemployment",
    },
  },
  q3_jurisdiction: {
    text: "Is this issue with the IRS, a state tax agency, or both?",
    quickReplies: [
      { title: "IRS", payload: "Q3_IRS" },
      { title: "State", payload: "Q3_STATE" },
      { title: "Both", payload: "Q3_BOTH" },
    ],
    next: () => "q4_debt_amount",
    storeAs: "jurisdiction",
    valueMap: {
      Q3_IRS: "irs",
      Q3_STATE: "state",
      Q3_BOTH: "both",
    },
  },
  q4_debt_amount: {
    text: "Roughly how much do you owe?",
    quickReplies: [
      { title: "Under $10k", payload: "Q4_UNDER10K" },
      { title: "$10k-$25k", payload: "Q4_10K_25K" },
      { title: "$25k-$50k", payload: "Q4_25K_50K" },
      { title: "$50k-$100k", payload: "Q4_50K_100K" },
      { title: "$100k+", payload: "Q4_OVER100K" },
    ],
    next: () => "q5_state",
    storeAs: "debtAmount",
    valueMap: {
      Q4_UNDER10K: "<10000",
      Q4_10K_25K: "10000-25000",
      Q4_25K_50K: "25000-50000",
      Q4_50K_100K: "50000-100000",
      Q4_OVER100K: ">100000",
    },
  },
  q5_state: {
    text: "What state are you in?",
    freeText: true,
    next: () => "send_link",
    storeAs: "state",
  },
  exit_no_issue: {
    text: "No problem. If you ever have tax questions in the future, we're here to help.",
    terminal: true,
  },
  exit_wrong_type: {
    text: "Thanks for sharing. We mainly help with income and payroll tax issues, so this may need a different specialist.",
    terminal: true,
  },
  send_link: {
    terminal: true,
  },
});

setInterval(() => {
  const now = Date.now();
  for (const map of Object.values(conversations)) {
    for (const [senderId, convo] of map.entries()) {
      if (now - Number(convo.updatedAt || 0) > CONVERSATION_TTL_MS) {
        map.delete(senderId);
      }
    }
  }
  for (const map of Object.values(recentWebhookEvents)) {
    for (const [key, seenAt] of map.entries()) {
      if (now - Number(seenAt || 0) > EVENT_DEDUPE_TTL_MS) {
        map.delete(key);
      }
    }
  }
}, 60 * 60 * 1000).unref?.();

function normalizeDomain(domain) {
  return String(domain || "TAG").trim().toUpperCase();
}

function normalizePlatform(platform) {
  return String(platform || "facebook").trim().toLowerCase();
}

function getDefaultResponderConfig(domain, platform) {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedPlatform = normalizePlatform(platform);
  const companyConfig = getCompanyConfig(normalizedDomain);
  const defaultTemplates =
    DEFAULT_TEMPLATES[normalizedPlatform] || DEFAULT_TEMPLATES.facebook;
  const brandHandle =
    normalizedDomain === "TAG" ? "taxadvocategroup" : "wynntaxsolutions";

  return {
    domain: normalizedDomain,
    platform: normalizedPlatform,
    enabled: false,
    triggerKeywords: [...DEFAULT_KEYWORDS],
    commentReplyTemplate: defaultTemplates.commentReplyTemplate,
    directReplyTemplate: defaultTemplates.directReplyTemplate,
    stats: {
      totalWebhookEvents: 0,
      matchedEvents: 0,
      repliesSent: 0,
      lastWebhookAt: null,
      lastMatchedAt: null,
      lastReplyAt: null,
      lastEventType: null,
      lastKeyword: null,
      lastSenderId: null,
      lastError: null,
      lastErrorAt: null,
    },
    updatedBy: { email: null, name: null },
    listener: {
      pageId:
        normalizedPlatform === "instagram"
          ? companyConfig.integrations?.instagram?.pageId || null
          : companyConfig.integrations?.facebook?.pageId || null,
      tokenConfigured:
        normalizedPlatform === "instagram"
          ? Boolean(getIgPageToken(normalizedDomain))
          : Boolean(getFbPageToken(normalizedDomain)),
      brandName: companyConfig.name,
      brandHandle,
    },
  };
}

async function getMergedResponderConfig(domain, platform) {
  const fallback = getDefaultResponderConfig(domain, platform);
  const stored = await socialResponderConfigRepository.findSocialResponderConfig(
    domain,
    platform,
  );
  if (!stored) return fallback;
  return {
    ...fallback,
    ...stored,
    listener: fallback.listener,
    triggerKeywords:
      Array.isArray(stored.triggerKeywords) && stored.triggerKeywords.length > 0
        ? stored.triggerKeywords
        : fallback.triggerKeywords,
    commentReplyTemplate:
      stored.commentReplyTemplate || fallback.commentReplyTemplate,
    directReplyTemplate:
      stored.directReplyTemplate || fallback.directReplyTemplate,
    stats: {
      ...fallback.stats,
      ...(stored.stats || {}),
    },
    updatedBy: {
      ...fallback.updatedBy,
      ...(stored.updatedBy || {}),
    },
  };
}

async function buildSocialResponderWorkspace(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const [facebook, instagram] = await Promise.all([
    getMergedResponderConfig(normalizedDomain, "facebook"),
    getMergedResponderConfig(normalizedDomain, "instagram"),
  ]);

  const verifyTokenConfigured = Boolean(
    String(process.env.META_WEBHOOK_VERIFY_TOKEN || process.env.FB_VERIFY_TOKEN || "").trim(),
  );

  return {
    domain: normalizedDomain,
    listener: {
      webhookPath: "/fb/webhook",
      verifyTokenConfigured,
      supportedObjects: ["page", "instagram"],
    },
    responders: [facebook, instagram],
    notes: [
      "Facebook and Instagram comment/message auto replies now read from Parallel-owned settings instead of hardcoded keyword arrays.",
      "Listening uses /fb/webhook so Meta can keep one webhook target while Parallel handles both page and instagram payload objects.",
      "Instagram currently uses its own optional IG token env when available, otherwise it falls back to the Facebook page token for the brand.",
    ],
  };
}

async function saveSocialResponderConfig(domain, platform, input, actor) {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedPlatform = normalizePlatform(platform);
  const fallback = getDefaultResponderConfig(normalizedDomain, normalizedPlatform);
  const nextKeywords = Array.isArray(input.triggerKeywords)
    ? input.triggerKeywords
    : fallback.triggerKeywords;

  const saved = await socialResponderConfigRepository.upsertSocialResponderConfig(
    normalizedDomain,
    normalizedPlatform,
    {
      enabled: input.enabled,
      triggerKeywords: nextKeywords,
      commentReplyTemplate:
        input.commentReplyTemplate || fallback.commentReplyTemplate,
      directReplyTemplate:
        input.directReplyTemplate || fallback.directReplyTemplate,
    },
    actor,
  );

  return getMergedResponderConfig(
    saved.domain || normalizedDomain,
    saved.platform || normalizedPlatform,
  );
}

function detectKeyword(text, keywords = []) {
  const lower = String(text || "").toLowerCase();
  return (keywords || []).find((keyword) => lower.includes(String(keyword || "").toLowerCase())) || null;
}

function renderTemplate(template, context = {}) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    return String(context[key] ?? "");
  });
}

function getConversation(platform, senderId) {
  return conversations[platform]?.get(senderId) || null;
}

function setConversation(platform, senderId, payload) {
  conversations[platform]?.set(senderId, {
    ...payload,
    updatedAt: Date.now(),
  });
}

function clearConversation(platform, senderId) {
  conversations[platform]?.delete(senderId);
}

function markRecentWebhookEvent(platform, key) {
  const map = recentWebhookEvents[platform];
  if (!map || !key) return false;
  const now = Date.now();
  const existing = Number(map.get(key) || 0);
  if (existing && now - existing < EVENT_DEDUPE_TTL_MS) {
    return true;
  }
  map.set(key, now);
  return false;
}

function buildCommentEventKey(platform, pageId, change = {}) {
  const value = change.value || {};
  const commentId = value.comment_id || value.id || "unknown-comment";
  const senderId = value.from?.id || "unknown-sender";
  return `${platform}:comment:${pageId || "unknown-page"}:${commentId}:${senderId}`;
}

function buildMessageEventKey(platform, pageId, event = {}) {
  const senderId = event.sender?.id || "unknown-sender";
  const recipientId = event.recipient?.id || "unknown-recipient";
  const mid = event.message?.mid || event.delivery?.mids?.[0] || event.read?.mid || null;
  if (mid) {
    return `${platform}:message:${pageId || "unknown-page"}:${mid}`;
  }
  const text = String(event.message?.text || "").trim();
  const payload = String(event.message?.quick_reply?.payload || "").trim();
  const timestamp = Number(event.timestamp || 0);
  return `${platform}:message:${pageId || "unknown-page"}:${senderId}:${recipientId}:${text}:${payload}:${timestamp}`;
}

function buildQuickReplies(options = []) {
  if (!Array.isArray(options) || options.length === 0) return undefined;
  return options.map((option) => ({
    content_type: "text",
    title: option.title,
    payload: option.payload,
  }));
}

function buildQualifyUrl(domain, source = "messenger") {
  const config = getCompanyConfig(domain);
  const base =
    domain === "TAG"
      ? "https://www.taxadvocategroup.com/qualify-now/"
      : "https://www.wynntaxsolutions.com/qualify-now/";
  return base;
}

async function replyToComment(pageToken, commentId, message, platform = "facebook") {
  const suffix = platform === "instagram" ? "replies" : "comments";
  const url =
    platform === "instagram"
      ? `${GRAPH_API}/${commentId}/${suffix}`
      : `${GRAPH_API}/${commentId}/${suffix}?access_token=${encodeURIComponent(pageToken)}`;
  const response = await fetch(url, {
    method: "POST",
    headers:
      platform === "instagram"
        ? {
            Authorization: `Bearer ${pageToken}`,
            "Content-Type": "application/json",
          }
        : {
            "Content-Type": "application/json",
          },
    body: JSON.stringify({ message }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = payload?.error?.message || response.statusText;
    throw new Error(detail);
  }
  return response.json().catch(() => ({}));
}

async function sendDirectMessage(pageToken, recipientId, message) {
  const response = await fetch(
    `${GRAPH_API}/me/messages?access_token=${encodeURIComponent(pageToken)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: message },
        messaging_type: "RESPONSE",
      }),
    },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = payload?.error?.message || response.statusText;
    throw new Error(detail);
  }
  return response.json().catch(() => ({}));
}

async function sendStructuredMessage(pageToken, recipientId, payload) {
  const response = await fetch(
    `${GRAPH_API}/me/messages?access_token=${encodeURIComponent(pageToken)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: payload,
        messaging_type: "RESPONSE",
      }),
    },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error?.message || response.statusText);
  }
  return response.json().catch(() => ({}));
}

async function startConversation(platform, domain, pageToken, recipientId, sourceMeta = {}) {
  const step = "q1_tax_issue";
  const question = QUESTIONS[step];
  setConversation(platform, recipientId, {
    step,
    domain,
    sourceMeta,
    answers: {},
    startedAt: Date.now(),
  });
  await sendStructuredMessage(pageToken, recipientId, {
    text: question.text,
    quick_replies: buildQuickReplies(question.quickReplies),
  });
}

async function sendQualifyLink(platform, domain, pageToken, recipientId, convo) {
  const qualifyUrl = buildQualifyUrl(
    domain,
    platform === "instagram" ? "instagram-messenger" : "facebook-messenger",
  );
  const brandName =
    domain === "TAG" ? "Tax Advocate Group" : "Wynn Tax Solutions";
  const message =
    `Thanks — based on what you shared, you may qualify for tax relief.\n\n` +
    `Enter your contact info here and we’ll reach out to you:\n\n${qualifyUrl}\n\n` +
    `A team member from ${brandName} will follow up directly.`;
  await sendDirectMessage(pageToken, recipientId, message);
  clearConversation(platform, recipientId);
  return convo;
}

async function advanceConversation(platform, domain, pageToken, recipientId, text, payload) {
  const convo = getConversation(platform, recipientId);
  if (!convo) {
    await startConversation(platform, domain, pageToken, recipientId, {
      source: "direct-message",
    });
    return;
  }

  const currentStep = convo.step;
  const question = QUESTIONS[currentStep];
  if (!question || question.terminal) return;

  if (question.storeAs) {
    let value = payload || text || "";
    if (question.valueMap && payload) {
      value = question.valueMap[payload] || payload;
    } else if (question.freeText) {
      value = String(text || "").trim();
    }
    convo.answers[question.storeAs] = value;
  }

  const nextStep = question.next(payload || String(text || "").toUpperCase().trim());
  if (!nextStep) return;

  if (nextStep === "send_link") {
    await sendQualifyLink(platform, domain, pageToken, recipientId, convo);
    return;
  }

  const nextQuestion = QUESTIONS[nextStep];
  if (nextQuestion?.terminal) {
    await sendDirectMessage(pageToken, recipientId, nextQuestion.text);
    clearConversation(platform, recipientId);
    return;
  }

  convo.step = nextStep;
  setConversation(platform, recipientId, convo);
  await sendStructuredMessage(pageToken, recipientId, {
    text: nextQuestion.text,
    quick_replies: buildQuickReplies(nextQuestion.quickReplies),
  });
}

async function processFacebookEntry(entry, runtime) {
  const domain = resolveCompanyFromFbPageId(entry.id);
  const config = await getMergedResponderConfig(domain, "facebook");
  const pageToken = getFbPageToken(domain);
  const logger = runtime?.logger || console;
  const pageId = entry.id || null;

  if (!config.enabled) return { matched: 0, replied: 0, skipped: "disabled" };
  if (!pageToken) return { matched: 0, replied: 0, skipped: "missing-token" };

  let matched = 0;
  let replied = 0;

  for (const change of entry.changes || []) {
    if (change.field !== "feed" || change.value?.item !== "comment") continue;

    const commentText = String(change.value?.message || change.value?.text || "");
    const keyword = detectKeyword(commentText, config.triggerKeywords);
    const senderId = change.value?.from?.id || null;
    const commentId = change.value?.comment_id || change.value?.id || null;
    const parentId = change.value?.parent_id || null;
    const postId = change.value?.post_id || change.value?.post?.id || null;

    if (pageId && senderId && String(senderId) === String(pageId)) continue;
    if (parentId && postId && String(parentId) !== String(postId)) continue;
    if (markRecentWebhookEvent("facebook", buildCommentEventKey("facebook", pageId, change))) {
      continue;
    }

    await socialResponderConfigRepository.recordSocialResponderEvent(domain, "facebook", {
      eventType: "comment",
      senderId,
      keyword: keyword || undefined,
    });

    if (!keyword) continue;

    const senderName = String(change.value?.from?.name || "").trim();
    const firstName = senderName.split(" ")[0] || "there";
    const reply = renderTemplate(config.commentReplyTemplate, {
      firstName,
      brandName: config.listener.brandName,
      brandHandle: config.listener.brandHandle,
      keyword: keyword.toUpperCase(),
      commentText,
    });

    try {
      await replyToComment(pageToken, commentId, reply, "facebook");
      matched += 1;
      replied += 1;
      await socialResponderConfigRepository.recordSocialResponderEvent(domain, "facebook", {
        eventType: "comment-reply",
        senderId,
        keyword,
        replied: true,
      });
    } catch (error) {
      logger.warn("social.facebook.comment_reply_failed", {
        domain,
        message: error.message,
      });
      await socialResponderConfigRepository.recordSocialResponderEvent(domain, "facebook", {
        eventType: "comment-reply-error",
        senderId,
        keyword,
        error: error.message,
      });
      await emitHourlyJobEvent({
        lane: "hourly",
        domain,
        eventType: "social.facebook.comment.reply.retry",
        targetService: "inbound-gateway",
        handlerKey: "retrySocialReply",
        aggregateType: "social-responder",
        aggregateId: commentId || senderId || "facebook-comment",
        caseId: null,
          payload: {
            step: "comment-reply",
            args: {
              domain,
              pageToken,
              commentId,
              message: reply,
            },
            platform: "facebook",
            mode: "comment",
            commentId,
            senderId,
            keyword,
        },
        resolutionCheckKey: "social-reply-state",
        resolutionContext: {
          platform: "facebook",
          mode: "comment",
          recipientId: senderId,
        },
        dedupeKey: `${String(domain || "").toUpperCase()}:social:facebook:comment:${change.value?.comment_id || change.value?.id || senderId || "unknown"}`,
        emittedBy: "inbound-gateway",
        priority: 35,
        severity: "warning",
        immediateRetryAttempts: 1,
        immediateRetryDelayMs: 1000,
        provideSummary: false,
        firstError: error.message,
        notify: false,
      }).catch(() => null);
    }
  }

  for (const event of entry.messaging || []) {
    if (!event.message || event.message?.is_echo) continue;
    const text = String(event.message?.text || "");
    const payload = event.message?.quick_reply?.payload || "";
    const keyword = detectKeyword(text, config.triggerKeywords);
    const senderId = event.sender?.id || null;

    if (pageId && senderId && String(senderId) === String(pageId)) continue;
    if (markRecentWebhookEvent("facebook", buildMessageEventKey("facebook", pageId, event))) {
      continue;
    }

    await socialResponderConfigRepository.recordSocialResponderEvent(domain, "facebook", {
      eventType: "message",
      senderId,
      keyword: keyword || undefined,
    });

    if (!senderId) continue;

    try {
      const convo = getConversation("facebook", senderId);
      if (!convo) {
        await startConversation("facebook", domain, pageToken, senderId, {
          source: keyword ? "keyword-message" : "message",
        });
      } else {
        await advanceConversation("facebook", domain, pageToken, senderId, text, payload);
      }
      if (keyword) matched += 1;
      replied += 1;
      await socialResponderConfigRepository.recordSocialResponderEvent(domain, "facebook", {
        eventType: "message-reply",
        senderId,
        keyword: keyword || undefined,
        replied: true,
      });
    } catch (error) {
      logger.warn("social.facebook.message_reply_failed", {
        domain,
        message: error.message,
      });
      await socialResponderConfigRepository.recordSocialResponderEvent(domain, "facebook", {
        eventType: "message-reply-error",
        senderId,
        keyword,
        error: error.message,
      });
      // Do not auto-retry Messenger conversation sends. Interactive
      // message state is hard to reconstruct safely and can create
      // duplicate-start loops for the same user.
    }
  }

  return { matched, replied, skipped: null };
}

async function processInstagramEntry(entry, runtime) {
  const domain = resolveCompanyFromFbPageId(entry.id);
  const config = await getMergedResponderConfig(domain, "instagram");
  const pageToken = getIgPageToken(domain) || getFbPageToken(domain);
  const logger = runtime?.logger || console;

  if (!config.enabled) return { matched: 0, replied: 0, skipped: "disabled" };
  if (!pageToken) return { matched: 0, replied: 0, skipped: "missing-token" };

  let matched = 0;
  let replied = 0;

  for (const change of entry.changes || []) {
    if (change.field !== "comments") continue;
    const commentText = String(change.value?.text || "");
    const keyword = detectKeyword(commentText, config.triggerKeywords);
    const senderId = change.value?.from?.id || null;
    await socialResponderConfigRepository.recordSocialResponderEvent(domain, "instagram", {
      eventType: "comment",
      senderId,
      keyword: keyword || undefined,
    });
    if (!keyword) continue;

    const senderName = String(change.value?.from?.name || "").trim();
    const firstName = senderName.split(" ")[0] || "there";
    const reply = renderTemplate(config.commentReplyTemplate, {
      firstName,
      brandName: config.listener.brandName,
      brandHandle: config.listener.brandHandle,
      keyword: keyword.toUpperCase(),
      commentText,
    });

    try {
      await replyToComment(pageToken, change.value?.id, reply, "instagram");
      matched += 1;
      replied += 1;
      await socialResponderConfigRepository.recordSocialResponderEvent(domain, "instagram", {
        eventType: "comment-reply",
        senderId,
        keyword,
        replied: true,
      });
    } catch (error) {
      logger.warn("social.instagram.comment_reply_failed", {
        domain,
        message: error.message,
      });
      await socialResponderConfigRepository.recordSocialResponderEvent(domain, "instagram", {
        eventType: "comment-reply-error",
        senderId,
        keyword,
        error: error.message,
      });
      await emitHourlyJobEvent({
        lane: "hourly",
        domain,
        eventType: "social.instagram.comment.reply.retry",
        targetService: "inbound-gateway",
        handlerKey: "retrySocialReply",
        aggregateType: "social-responder",
        aggregateId: change.value?.id || senderId || "instagram-comment",
        caseId: null,
          payload: {
            step: "comment-reply",
            args: {
              domain,
              pageToken,
              commentId: change.value?.id || null,
              message: reply,
            },
            platform: "instagram",
            mode: "comment",
            commentId: change.value?.id || null,
            senderId,
            keyword,
        },
        resolutionCheckKey: "social-reply-state",
        resolutionContext: {
          platform: "instagram",
          mode: "comment",
          recipientId: senderId,
        },
        dedupeKey: `${String(domain || "").toUpperCase()}:social:instagram:comment:${change.value?.id || senderId || "unknown"}`,
        emittedBy: "inbound-gateway",
        priority: 35,
        severity: "warning",
        immediateRetryAttempts: 1,
        immediateRetryDelayMs: 1000,
        provideSummary: false,
        firstError: error.message,
        notify: false,
      }).catch(() => null);
    }
  }

  for (const event of entry.messaging || []) {
    if (!event.message || event.message?.is_echo) continue;
    const text = String(event.message?.text || "");
    const payload = event.message?.quick_reply?.payload || "";
    const keyword = detectKeyword(text, config.triggerKeywords);
    const senderId = event.sender?.id || null;
    await socialResponderConfigRepository.recordSocialResponderEvent(domain, "instagram", {
      eventType: "message",
      senderId,
      keyword: keyword || undefined,
    });

    if (!senderId) continue;

    try {
      const convo = getConversation("instagram", senderId);
      if (!convo) {
        await startConversation("instagram", domain, pageToken, senderId, {
          source: keyword ? "keyword-message" : "message",
        });
      } else {
        await advanceConversation("instagram", domain, pageToken, senderId, text, payload);
      }
      if (keyword) matched += 1;
      replied += 1;
      await socialResponderConfigRepository.recordSocialResponderEvent(domain, "instagram", {
        eventType: "message-reply",
        senderId,
        keyword: keyword || undefined,
        replied: true,
      });
    } catch (error) {
      logger.warn("social.instagram.message_reply_failed", {
        domain,
        message: error.message,
      });
      await socialResponderConfigRepository.recordSocialResponderEvent(domain, "instagram", {
        eventType: "message-reply-error",
        senderId,
        keyword,
        error: error.message,
      });
      // Do not auto-retry Messenger conversation sends. Interactive
      // message state is hard to reconstruct safely and can create
      // duplicate-start loops for the same user.
    }
  }

  return { matched, replied, skipped: null };
}

async function processMetaSocialWebhook(body, runtime = null) {
  const logger = runtime?.logger || console;
  const object = String(body?.object || "").toLowerCase();
  let processed = 0;
  let matched = 0;
  let replied = 0;

  if (object === "page") {
    for (const entry of body.entry || []) {
      const result = await processFacebookEntry(entry, runtime);
      processed += 1;
      matched += result.matched || 0;
      replied += result.replied || 0;
    }
  } else if (object === "instagram") {
    for (const entry of body.entry || []) {
      const result = await processInstagramEntry(entry, runtime);
      processed += 1;
      matched += result.matched || 0;
      replied += result.replied || 0;
    }
  } else {
    logger.info("social.meta.unsupported_object", { object });
  }

  return { object, processed, matched, replied };
}

function getMetaWebhookVerifyToken() {
  return String(
    process.env.META_WEBHOOK_VERIFY_TOKEN ||
      process.env.FB_VERIFY_TOKEN ||
      "",
  ).trim();
}

function listMetaWebhookDomains() {
  return getCompanyKeys().map((key) => {
    const config = getCompanyConfig(key);
    return {
      domain: key,
      facebookPageId: config.integrations?.facebook?.pageId || null,
      facebookTokenConfigured: Boolean(getFbPageToken(key)),
      instagramPageId: config.integrations?.instagram?.pageId || null,
      instagramTokenConfigured: Boolean(getIgPageToken(key)),
    };
  });
}

module.exports = {
  DEFAULT_KEYWORDS,
  buildSocialResponderWorkspace,
  getDefaultResponderConfig,
  getMergedResponderConfig,
  getMetaWebhookVerifyToken,
  listMetaWebhookDomains,
  processMetaSocialWebhook,
  // Exposed so hourly retry handler (`retrySocialReply`) can re-send a
  // single comment-reply or DM without reconstructing the full webhook
  // flow. Both are low-level Meta Graph calls — callers are responsible
  // for idempotency (check before calling on retry paths).
  replyToComment,
  saveSocialResponderConfig,
  sendDirectMessage,
};
