"use strict";

// Real course-content drafts derived only from the approved representation
// methodology in ../taxGroupScript.js. This module is deliberately not imported
// by publishedTrainingContent.v1.js. Promotion remains an explicit product act.

const { TAX_GROUP_SECTIONS } = require("../taxGroupScript");

const CONTENT_VERSION = "1.0.0-draft";
const RULE_REVISION = "approved-representation-script-extract-1";
// Topic packets (objections / tactics / tax) extract from the field manual —
// the in-house training manual Mickey ruled into the course on 2026-07-29
// ("basically the whole manual as it exists"). A distinct revision marker so
// script-backed and manual-backed criteria can never be confused when the
// promotion decision is made per family.
const FIELD_MANUAL_REVISION = "field-manual-extract-1";
const FIELD_MANUAL_SOURCE = "apps/web-client/src/workspaces/field-manual/content";

const sectionById = new Map(TAX_GROUP_SECTIONS.map((section) => [section.id, section]));

// ── DIRECT MICKEY RULINGS ────────────────────────────────────────────────
// Tier 1 of the authority hierarchy (build guide §3): a direct ruling outranks
// the approved script. Recorded here with its date and reasoning so a later
// session does not "restore" the script beat and quietly undo the decision.
const TAX_RESOLUTION_RULINGS = Object.freeze({
  "ruling.company-disclosure-is-earned": Object.freeze({
    rulingId: "ruling.company-disclosure-is-earned",
    date: "2026-07-29",
    statement:
      "Specific information about who we are is NOT an opening move. No section teaches "
      + "identifying the firm or volunteering company specifics. Exactly one module — in the "
      + "Representation Pitch — teaches recognizing WHEN it is okay to share specifics: the "
      + "prospect is a buyer, and they have already provided substantial information about "
      + "themselves.",
    overrides: Object.freeze([
      "taxGroupScript.js section 1 beat who_we_are (as a required opening move)",
    ]),
    reasoning:
      "Volunteering credentials to an unqualified stranger spends the firm's credibility "
      + "before anything has been earned, and reads like every pitch call the prospect has "
      + "already learned to dismiss. The skill is the judgment about the moment, not recitation.",
  }),
  "ruling.ground-generally-no-records-pitch": Object.freeze({
    rulingId: "ruling.ground-generally-no-records-pitch",
    date: "2026-07-29",
    statement:
      "The outbound opener does not disclose or lean on public tax records. Ground the call "
      + "GENERALLY in its root — why a call like this happens — which can be provided if the "
      + "prospect asks. The actual move is identifying whether this person HAS a tax issue.",
    overrides: Object.freeze([
      "taxGroupScript.js section 1 beat outbound_opener (the public-records disclosure wording)",
    ]),
    reasoning:
      "Leading with 'your name appeared in public records' spends the first seconds justifying "
      + "surveillance instead of finding the issue. The opener's job is a truthful general "
      + "grounding and one limited question; specifics are available on request, not a pitch.",
  }),
});

function rulingRef(rulingId) {
  if (!TAX_RESOLUTION_RULINGS[rulingId]) {
    throw new Error(`Unknown Mickey ruling ${rulingId}`);
  }
  return rulingId;
}

/**
 * A criterion created by a direct ruling rather than a script beat.
 *
 * Excluded from the beat-coverage assertion — by definition it has no beat —
 * but it still carries a citable authority, which is the ruling itself.
 */
function rulingCriterion(sectionId, slug, description, evidenceGuidance, ruling, options = {}) {
  return Object.freeze({
    criterionId: `tax-resolution.${sectionId}.${slug}`,
    ruleId: `tax-resolution.${sectionId}.${slug}`,
    ruleRevision: RULE_REVISION,
    description,
    evidenceGuidance,
    detector: "semantic",
    required: options.required !== false,
    appliesWhen: options.appliesWhen || null,
    rulingRef: rulingRef(ruling),
    authority: Object.freeze({
      type: "mickey-ruling",
      source: "direct ruling recorded in TAX_RESOLUTION_RULINGS",
      rulingId: ruling,
      revision: RULE_REVISION,
    }),
  });
}

function authority(sectionId, beatId) {
  return Object.freeze({
    type: "approved-script",
    source: "packages/shared-services/src/taxGroupScript.js",
    sectionId,
    beatId,
    revision: RULE_REVISION,
  });
}

function criterion(sectionId, beatId, description, evidenceGuidance, options = {}) {
  return Object.freeze({
    criterionId: `tax-resolution.${sectionId}.${beatId}`,
    ruleId: `tax-resolution.${sectionId}.${beatId}`,
    ruleRevision: RULE_REVISION,
    description,
    evidenceGuidance,
    detector: "semantic",
    // A beat is required UNLESS a direct ruling demoted it. The beat stays in
    // the array so script coverage remains provable; `rulingRef` records why it
    // no longer gates, which is the only honest way to disagree with the script.
    required: options.required !== false,
    ...(options.rulingRef ? { rulingRef: rulingRef(options.rulingRef) } : {}),
    appliesWhen: options.appliesWhen || null,
    authority: authority(sectionId, beatId),
  });
}

function persona(variantId, posture, behavior, difficulty) {
  return Object.freeze({
    variantId,
    version: CONTENT_VERSION,
    posture,
    behavior,
    difficulty,
    gatePolicy: "identical-required-criteria",
    protectedTraitPolicy: "no-gate-effect",
  });
}

function question(id, prompt, criterionIds) {
  return Object.freeze({
    questionId: id,
    version: CONTENT_VERSION,
    prompt,
    rubricCriterionIds: Object.freeze(criterionIds),
    grading: "server-owned-cited-semantic",
  });
}

function packet(definition) {
  const scriptSection = sectionById.get(definition.sectionId);
  if (!scriptSection) throw new Error(`Unknown approved script section ${definition.sectionId}`);
  const scriptBeatIds = scriptSection.beats.map((beat) => beat.id);
  const criteriaBeatIds = definition.criteria.map((entry) => entry.criterionId.split(".").at(-1));
  if (JSON.stringify(scriptBeatIds) !== JSON.stringify(criteriaBeatIds)) {
    throw new Error(`Skill packet ${definition.id} does not cover its approved script beats in order`);
  }
  // Ruling criteria are appended AFTER the beat check: they have no beat by
  // definition, so folding them into `criteria` first would break the very
  // assertion that proves the packet still covers the approved script.
  const allCriteria = [...definition.criteria, ...(definition.rulingCriteria || [])];
  const criterionIds = new Set(allCriteria.map((entry) => entry.criterionId));
  for (const moduleDef of definition.practiceModules || []) {
    for (const cid of moduleDef.criterionIds || []) {
      if (!criterionIds.has(cid)) {
        throw new Error(`Skill packet ${definition.id}: module ${moduleDef.moduleId} cites unknown criterion ${cid}`);
      }
    }
  }
  return Object.freeze({
    id: definition.id,
    version: CONTENT_VERSION,
    status: "draft",
    authority: Object.freeze({
      type: "approved-script",
      source: "packages/shared-services/src/taxGroupScript.js",
      sectionId: definition.sectionId,
      revision: RULE_REVISION,
    }),
    sectionId: definition.sectionId,
    title: scriptSection.title,
    experienceMode: "gauntlet",
    localObjective: definition.localObjective,
    directions: Object.freeze(definition.directions),
    maxTurns: definition.maxTurns,
    maxVisitsPerNode: 2,
    criteria: Object.freeze(allCriteria),
    teaching: Object.freeze({
      exactMoves: Object.freeze(scriptSection.beats.map((beat) => Object.freeze({
        beatId: beat.id,
        label: beat.point,
        language: beat.detail,
      }))),
      responseSignals: Object.freeze((definition.responseSignals || []).map(Object.freeze)),
    }),
    practiceModules: Object.freeze((definition.practiceModules || []).map((module) =>
      Object.freeze({
        ...module,
        criterionIds: Object.freeze([...(module.criterionIds || [])]),
        situations: Object.freeze([...(module.situations || [])]),
        questions: Object.freeze((module.questions || []).map(Object.freeze)),
      }))),
    personas: Object.freeze(definition.personas),
    situations: Object.freeze(definition.situations),
    prohibitedMoves: Object.freeze(definition.prohibitedMoves),
    retryPolicy: Object.freeze({
      nodeRetryLimit: 1,
      runRetryLimit: 2,
      variantStrategy: "unused-first",
    }),
    reflectionPrompt: definition.reflectionPrompt,
    questions: Object.freeze(definition.questions),
    passPolicy: "all-applicable-required-criteria-with-cited-learner-evidence",
    certificationEligible: false,
  });
}

function manualCriterion(topicKey, slug, description, evidenceGuidance, entryIds, options = {}) {
  return Object.freeze({
    criterionId: `tax-resolution.${topicKey}.${slug}`,
    ruleId: `tax-resolution.${topicKey}.${slug}`,
    ruleRevision: FIELD_MANUAL_REVISION,
    description,
    evidenceGuidance,
    detector: "semantic",
    required: true,
    appliesWhen: options.appliesWhen || null,
    authority: Object.freeze({
      type: "field-manual-extract",
      source: FIELD_MANUAL_SOURCE,
      entryIds: Object.freeze([...entryIds]),
      revision: FIELD_MANUAL_REVISION,
    }),
  });
}

// Topic packets teach skills that cut ACROSS calls (objection handling, named
// tactics, tax mechanics) rather than one arc section, so they cannot derive
// from TAX_GROUP_SECTIONS beats. The load-bearing integrity check moves from
// beat coverage to citation coverage: every module and question must cite
// criteria this packet actually declares, or the module throws at load.
function manualPacket(definition) {
  const criterionIds = new Set(definition.criteria.map((entry) => entry.criterionId));
  for (const moduleDef of definition.practiceModules) {
    for (const cid of moduleDef.criterionIds || []) {
      if (!criterionIds.has(cid)) {
        throw new Error(`Topic packet ${definition.id}: module ${moduleDef.moduleId} cites unknown criterion ${cid}`);
      }
    }
  }
  for (const questionDef of definition.questions) {
    for (const cid of questionDef.rubricCriterionIds || []) {
      if (!criterionIds.has(cid)) {
        throw new Error(`Topic packet ${definition.id}: question ${questionDef.questionId} cites unknown criterion ${cid}`);
      }
    }
  }
  return Object.freeze({
    id: definition.id,
    version: CONTENT_VERSION,
    status: "draft",
    authority: Object.freeze({
      type: "field-manual-extract",
      source: FIELD_MANUAL_SOURCE,
      revision: FIELD_MANUAL_REVISION,
    }),
    sectionId: definition.sectionId,
    title: definition.title,
    experienceMode: "gauntlet",
    localObjective: definition.localObjective,
    directions: Object.freeze(definition.directions),
    maxTurns: definition.maxTurns,
    maxVisitsPerNode: 2,
    criteria: Object.freeze(definition.criteria),
    teaching: Object.freeze({
      // No script beats behind these; the taught moves are the criteria
      // themselves. Nothing renders exactMoves for topic packets today —
      // responseSignals is the consumed surface and must always be an array.
      exactMoves: Object.freeze(definition.criteria.map((entry) => Object.freeze({
        beatId: entry.criterionId.split(".").at(-1),
        label: entry.description,
        language: entry.evidenceGuidance,
      }))),
      responseSignals: Object.freeze((definition.responseSignals || []).map(Object.freeze)),
    }),
    practiceModules: Object.freeze((definition.practiceModules || []).map((moduleDef) =>
      Object.freeze({
        ...moduleDef,
        criterionIds: Object.freeze([...(moduleDef.criterionIds || [])]),
        situations: Object.freeze([...(moduleDef.situations || [])]),
        questions: Object.freeze((moduleDef.questions || []).map(Object.freeze)),
      }))),
    personas: Object.freeze(definition.personas.map((personaDef) => persona(
      personaDef.variantId, personaDef.posture, personaDef.behavior, personaDef.difficulty,
    ))),
    situations: Object.freeze(definition.situations),
    prohibitedMoves: Object.freeze(definition.prohibitedMoves),
    retryPolicy: Object.freeze({
      nodeRetryLimit: 1,
      runRetryLimit: 2,
      variantStrategy: "unused-first",
    }),
    reflectionPrompt: definition.reflectionPrompt,
    questions: Object.freeze(definition.questions),
    passPolicy: "all-applicable-required-criteria-with-cited-learner-evidence",
    certificationEligible: false,
  });
}

const INTRODUCTION = packet({
  id: "tax-resolution.introduction",
  sectionId: "1",
  directions: ["inbound", "outbound"],
  localObjective: "Identify the firm and reason for the conversation clearly enough to earn permission to continue.",
  maxTurns: 5,
  criteria: [
    criterion("1", "inbound_greeting", "Open the inbound call with a calm, brief greeting that makes room for the caller to explain why they called.", "Quote one learner turn that is both brief and open: a calm greeting (the learner's own name is enough) plus an open invitation for the caller to explain the need. The firm name is not required and its absence never fails the criterion; a plain firm name is not penalized either. Reject openings that front-load credentials, licensing claims, or a service pitch before the caller has spoken — those are not brief — and reject any greeting that misstates who is answering. Elements may not be stitched from separate turns.", { appliesWhen: { direction: "inbound" } }),
    criterion("1", "outbound_opener", "Ground the outbound call generally and truthfully in why a call like this happens, then ask one limited question to identify whether the prospect has a tax issue.", "Quote the learner turn that does both things: gives a truthful, general grounding for the call — why a call like this happens, i.e. people with unresolved state or federal tax matters get contacted — and asks one limited question about whether the prospect currently has a tax issue that needs attention. Reject any opener that pitches records as the hook: naming public tax records, a filing, or a lien as the source of the contact fails. Also reject fabricated sourcing ('you filled out a form', 'you requested a call') and any wording that implies the prospect asked for or expected the call. The grounding may be repeated or expanded truthfully if the prospect asks why they were called; that answer supports the criterion but does not replace the limited question.", { appliesWhen: { direction: "outbound" } }),
    criterion("1", "who_we_are", "When a prospect directly asks who you are or who you are with, answer truthfully and briefly — enough to satisfy the question — without volunteering company specifics or misstating the firm.", "This is a boundary, not a required move: it applies only when the prospect directly asks who is calling or who the learner is with. Cite the learner turn that gives a truthful minimum — a name and a plain-language answer to what was actually asked — and returns to the limited purpose of the call. Reject credentials recitals, 'licensed tax representation firm' delivered as a pitch, volunteered company specifics the prospect did not ask for, and any answer that misstates the firm or implies the IRS or government. Unprompted identity speeches earn no credit.", {
      // DEMOTED by ruling.company-disclosure-is-earned: the beat stays so the
      // packet can still prove it covers the approved script, but it no longer
      // gates a run — volunteering identity is not a taught move any more.
      required: false,
      rulingRef: "ruling.company-disclosure-is-earned",
    }),
  ],
  personas: [
    persona("intro-curious", "Cautious but willing to listen", "Asks who the caller is and waits for a clear answer.", "foundation"),
    persona("intro-busy", "Impatient", "Says they are busy and requires a concise reason to continue.", "intermediate"),
    persona("intro-suspicious", "Guarded and skeptical", "Asks whether this is the IRS or a scam and challenges legitimacy.", "advanced"),
    persona("intro-hostile", "Dismissive and irritated", "Tells the caller to stop bothering them and makes the learner earn one brief reset.", "advanced"),
  ],
  situations: [
    "Inbound caller opens with only: I got a letter and do not know what it means.",
    "Outbound prospect asks who is calling before confirming anything.",
    "Outbound prospect says this sounds like a scam and refuses to share case facts until the firm is identified.",
    "Outbound prospect interrupts with: Shut up and go away. They will hear one calm, concise explanation but will not tolerate a pitch.",
  ],
  responseSignals: [
    {
      prospectPattern: "Who are you?",
      matchTerms: [
        "who are you",
        "who is this",
        "what company",
        "your name",
      ],
      coachNotice: "A direct identity question deserves a truthful minimum, not a speech.",
      suggestedMove: "Answer what was asked — your name, and the firm plainly if they asked for it — then put the limited purpose of the call back in front.",
      listenFor: "They accept the answer and re-engage with the question, or press for more — answer only what they press for, truthfully.",
    },
    {
      prospectPattern: "How did you get my number?",
      matchTerms: [
        "how did you get",
        "where did you get",
        "why me",
        "my number",
      ],
      coachNotice: "They are asking for the call's root. The general grounding is the answer — do not invent a source and do not pitch records.",
      suggestedMove: "Give the truthful general grounding — calls like this go out because people carry unresolved tax matters — briefly and without embellishment, then return to the limited question.",
      listenFor: "They accept the grounding and answer the limited question, or keep pressing — stay truthful and brief either way.",
    },
    {
      prospectPattern: "I never asked anybody to call me.",
      matchTerms: [
        "never asked",
        "didn't request",
        "didn't sign up",
      ],
      coachNotice: "They are correcting the premise. Never imply they requested or expected this call.",
      suggestedMove: "Agree plainly — they did not ask for the call — restate the general reason a call like this happens, and let the limited question decide whether there is anything to talk about.",
      listenFor: "A confirmation or denial of a tax issue; a denial plus a refusal means wrap up respectfully.",
    },
    {
      prospectPattern: "Is this the IRS or a scam?",
      matchTerms: [
        "irs",
        "scam",
        "government",
        "legit",
      ],
      coachNotice: "A legitimacy challenge gets a truthful minimum here — never claim or imply IRS or government — and full trust handling belongs to the trust family, not the opener.",
      suggestedMove: "Deny the IRS or government assumption plainly and truthfully, answer exactly what they asked, and keep the call's limited purpose in front rather than launching a credentials defense.",
      listenFor: "Suspicion easing enough to answer the limited question; sustained distrust is a reason to stay brief, not to pile on proof.",
    },
    {
      prospectPattern: "Shut up and go away.",
      matchTerms: [
        "shut up",
        "go away",
        "not interested",
        "stop calling",
      ],
      coachNotice: "They are dismissing the interruption. You have one respectful reset — one truthful sentence and a permission check, not a pitch.",
      suggestedMove: "Stay calm, restate the general purpose in one sentence, ask permission for a single question, and honor a repeated refusal.",
      listenFor: "A pause or question means the reset earned attention; a second refusal means disengage.",
    },
    {
      prospectPattern: "I'm busy — make it quick.",
      matchTerms: [
        "busy",
        "make it quick",
        "thirty seconds",
        "in a meeting",
      ],
      coachNotice: "Compression is the test, and the opener already fits: one truthful grounding sentence and one limited question.",
      suggestedMove: "Respect the clock — general grounding in one sentence, then the limited tax-issue question — and let their answer set the pace.",
      listenFor: "A yes or no on the tax issue, or an offer of a better time; do not spend their patience on company background.",
    },
  ],
  practiceModules: [
    {
      moduleId: "intro.start-the-call",
      title: "Start the call cleanly",
      direction: "inbound",
      objective: "Open calmly and create a natural first exchange without front-loading identity or rushing ahead.",
      reading: "A clean opening is short: acknowledge the connection, give your name, and give the caller room to say why they called. You do not need to lead with the company or its credentials — the caller dialed you, and what they want most is to be heard. If they ask who they have reached, answer plainly in one breath and hand the call back to them. Tone and pacing carry more weight than any wording.",
      coachNudge: "Open with calm and a question, not information. Answer an identity question only if asked, briefly and truthfully, then get back to them.",
      listenFor: "The caller starts explaining why they called instead of asking follow-up questions about who they reached.",
      criterionIds: [
        "tax-resolution.1.inbound_greeting",
      ],
      situations: [
        "The prospect connects and waits silently for you to begin.",
        "The prospect answers with a distracted hello and gives you only a few seconds.",
        "The caller starts mid-story before you can speak — 'Yeah, I owe about forty grand and my paycheck just got hit' — then stops cold and demands: 'Wait, who am I even talking to?' The question earns a plain, truthful one-breath answer and an invitation back to the fact they just handed you — not a credentials speech.",
        "The caller opens with: 'I think I talked to you guys already — somebody was supposed to be handling this.' There is no such history. Open cleanly and truthfully without pretending to know their file and without letting the confusion pull you past the greeting.",
      ],
      questions: [
        {
          questionId: "intro-start-reflection",
          prompt: "Why is a short opening more useful than immediately explaining who the firm is and everything it does?",
          gradingPoints: [
            "creates room for the caller to explain the need",
            "avoids front-loading credentials or a pitch",
            "identity questions get a brief truthful answer only when asked",
          ],
        },
      ],
    },
    {
      moduleId: "intro.explain-the-purpose",
      title: "Ground the call and ask the one question",
      direction: "outbound",
      objective: "Ground the call truthfully and generally in why a call like this happens, then ask one limited question to find out whether this person has a tax issue.",
      reading: "The whole opener is two moves: a truthful, general grounding — calls like this happen because people carry unresolved state or federal tax matters — and one limited question about whether that applies to them. You are not disclosing a source, reading from a record, or pitching the company; you are finding out whether there is anything to talk about. If they ask why they were called, the grounding is the answer — give it plainly and return to the question. Their answer, either way, tells you what happens next.",
      coachNudge: "One truthful grounding sentence, one limited question. If they ask why them, repeat the grounding honestly — never invent a source, never lean on records.",
      listenFor: "The prospect confirms or denies a tax issue, or asks a clarifying question about why the call happened.",
      criterionIds: [
        "tax-resolution.1.outbound_opener",
      ],
      situations: [
        "The prospect asks: Why are you calling me?",
        "The prospect says: I never asked anybody to call.",
        "The prospect tests you: 'The last company swore I filled out a form online. Is that your story too?' Any invented or borrowed source fails on the spot; the truthful general grounding and the limited question are the only things that survive.",
        "The prospect accepts nothing general: 'That's not an answer — how did you get my number, specifically?' The coached move stays truthful and brief — no fabricated story, no pivot into a records pitch — and puts the limited question back in front.",
        "The prospect volunteers their own theory: 'This is about that old lien, isn't it? I settled that two years ago.' Take the correction at face value — do not argue the record or seize it as a hook — and let the limited question find out whether anything is still open.",
      ],
      questions: [
        {
          questionId: "intro-opener-parts",
          prompt: "What are the only two parts of a compliant outbound opener?",
          gradingPoints: [
            "a truthful general grounding in why a call like this happens",
            "one limited question about whether they have a tax issue",
            "no source disclosure, records pitch, or company pitch as part of the open",
          ],
        },
        {
          questionId: "intro-source-question",
          prompt: "A prospect asks how you got their number. What does a good answer look like?",
          gradingPoints: [
            "truthful and brief with nothing invented",
            "the general grounding does the explaining",
            "returns to the limited question instead of expanding into a pitch",
          ],
        },
      ],
    },
    {
      moduleId: "intro.deflect-anger",
      title: "Absorb anger without fighting",
      direction: "outbound",
      objective: "Respond to hostility without matching it, surrendering the call immediately, or launching into a pitch.",
      reading: "Anger is usually about the interruption, distrust, or fear — not a request for an argument. Lower the temperature, acknowledge the interruption, and offer one truthful reset: the general reason a call like this happens and a permission check for one question. Then read what comes back — a pause or a real question means the reset landed; a second refusal means the call is over.",
      coachNudge: "Address the emotion first. You get one brief truthful reset — general grounding plus a permission check — not a defense and not a pitch.",
      listenFor: "A pause, softer tone, correction, or real question means the temperature changed. A repeated refusal means disengage.",
      criterionIds: [
        "tax-resolution.1.outbound_opener",
      ],
      situations: [
        "The prospect interrupts with: Why are you bothering me?",
        "The prospect snaps: Shut up and go away. They will hear one calm reset.",
        "The prospect erupts: 'You people call every week — the last one threatened me with arrest. You've got ten seconds.' Absorb the anger without defending other callers or borrowing their urgency; ten seconds is enough for the truthful reset, and nothing else fits.",
        "The prospect shouts you down, then abruptly goes quiet and mutters: 'Fine. Talk.' The silence is bait — it earns the one-sentence reset and a permission check, not the pitch the opening seems to invite.",
      ],
      questions: [
        {
          questionId: "intro-anger-reflection",
          prompt: "What should you listen for after making one calm reset with an angry prospect?",
          gradingPoints: [
            "a pause or reduced hostility",
            "a real question or correction",
            "a repeated refusal means disengage",
          ],
        },
      ],
    },
    {
      moduleId: "intro.earn-the-story",
      title: "Earn the first real answer",
      direction: "inbound",
      objective: "Turn a calm open into an invitation that lets the caller describe the tax concern in their own words.",
      reading: "The introduction succeeds when the caller starts participating. Use an open invitation that cannot be answered with only yes or no, then follow the first fact they choose to share instead of running a checklist. If they pull back and ask who you are, answer truthfully in one breath — enough to satisfy the question, not a recital — and re-issue the invitation so they do not have to start over.",
      coachNudge: "Invite, then follow their first fact. A direct identity question gets a one-breath truthful answer and the invitation again — never a speech.",
      listenFor: "The caller begins describing the letter, balance, filing concern, or reason they reached out in their own words.",
      criterionIds: [
        "tax-resolution.1.inbound_greeting",
        "tax-resolution.1.who_we_are",
      ],
      situations: [
        "The prospect says only: I got a letter.",
        "The prospect says they have a tax problem but does not know where to begin.",
        "The caller demands an outcome, not a conversation: 'I need this garnishment stopped today — can you do that, yes or no?' Answering yes-or-no loses either way; the invitation has to reopen their story without promising a result or sliding into a pitch.",
        "The caller starts sharing, then pulls back mid-story: 'Actually, why am I telling you all this? I don't even know who you are.' Answer the question truthfully in one breath — enough to satisfy it, nothing volunteered beyond it — then re-issue the invitation without making them start over.",
      ],
      questions: [
        {
          questionId: "intro-story-reflection",
          prompt: "What tells you the introduction has worked and it is appropriate to begin learning about the tax problem?",
          gradingPoints: [
            "the prospect begins sharing in their own words",
            "permission or willingness to continue",
            "the agent listens to the answer rather than pitching",
          ],
        },
      ],
    },
  ],
  prohibitedMoves: [
    "claiming to be the IRS or a government agency",
    "inventing a lead source",
    "starting Discovery before identity and purpose are established",
    "quoting a fee or attempting a close",
  ],
  reflectionPrompt: "What did you say that made the identity and purpose of the call clear? Where did you ask for permission to continue?",
  questions: [
    question("intro-why-public-records", "What must an outbound opener explain before moving into the case?", ["tax-resolution.1.outbound_opener"]),
    question("intro-who-we-are", "How should you describe The Tax Group without creating confusion about being the IRS?", ["tax-resolution.1.who_we_are"]),
  ],
});

const DISCOVERY = packet({
  id: "tax-resolution.case-building",
  sectionId: "2",
  directions: ["inbound", "outbound"],
  localObjective: "Build a usable case picture and connect stated tax problems to the prospect's real-life impact.",
  maxTurns: 9,
  criteria: [
    criterion("2", "ask_permission", "Ask permission to gather a few facts so representation fit can be evaluated.", "Cite the learner turn, occurring before the first fact question, that both asks permission and names the fit-check purpose — that the questions determine whether representation makes sense. A bare \"mind if I ask a few questions?\" with no stated purpose does not qualify."),
    criterion("2", "core_questions", "Determine balance scope, filing gaps, collection activity, and prior help.", "Cite a distinct learner turn for each of the four areas — balance amount with federal/state scope, unfiled years, collection letters/liens/garnishments, and prior help versus first time. All four read off in one checklist turn does not qualify; an area counts as covered when the learner asked it, and a rough figure or an honest \"I don't know\" counts as an answer."),
    criterion("2", "pain_points", "Explore how the stated problem affects the prospect's day-to-day life or bottom line and what has already been tried.", "Cite the learner follow-up that names a specific detail the prospect just gave and ties it to day-to-day life or bottom line (e.g., garnishment to smaller paycheck), plus the learner turn asking what the prospect has already tried and how it worked. A generic acknowledgment (\"I understand, that's tough\") with no tie to their stated detail does not qualify."),
    criterion("2", "bridge_to_expert", "Summarize that a clear picture has been built and bridge into relevant guidance.", "Cite the learner turn that states the picture is clear and hands forward to what-we-typically-see guidance, and verify it occurs only after all four fact areas have cited coverage. The cited turn must contain no service names, fees, or outcome promises; a bridge delivered with a fact area still open fails."),
  ],
  responseSignals: [
    {
      prospectPattern: "Before I answer anything — what's this going to cost me?",
      matchTerms: [
        "cost",
        "charge",
        "price",
        "fee",
      ],
      coachNotice: "They are fee-fishing before a case picture exists. Quoting now is the prohibited move — the fee lives after the picture is built.",
      suggestedMove: "Do not quote. Restate the fit-check purpose of the questions — they exist to see whether representation even makes sense — and return to the next open fact area.",
      listenFor: "The prospect drops the fee push for now and answers the next discovery question; no dollar figure appears in the learner's turn.",
    },
    {
      prospectPattern: "Okay, okay — so what exactly do you people do?",
      matchTerms: [
        "what do you do",
        "what exactly do you",
        "how does this work",
        "what's the program",
      ],
      coachNotice: "They are pulling you into the pitch mid-discovery. Explaining services now advertises that no picture exists yet.",
      suggestedMove: "Offer a brief deferral — the explanation means something once the picture is complete — then ask the next open fact area. Use the clear-picture bridge only after all four areas are covered.",
      listenFor: "The prospect accepts the deferral and keeps answering; the bridge line arrives only after balance, filing, letters, and prior help are all in.",
    },
    {
      prospectPattern: "I'm not answering a bunch of personal questions — why do you need to know all this?",
      matchTerms: [
        "personal questions",
        "why do you need",
        "not answering",
        "none of your business",
      ],
      coachNotice: "They are hearing an interrogation, not a conversation. Permission was skipped or has expired.",
      suggestedMove: "Stop questioning. Name the fit-check purpose — the facts determine whether representation makes sense — and ask permission before the next fact question.",
      listenFor: "The prospect agrees to continue or asks a clarifying question about why, instead of tightening up further.",
    },
    {
      prospectPattern: "Honestly, I have no idea what I owe. I stopped opening the letters a while ago.",
      matchTerms: [
        "no idea",
        "don't know",
        "stopped opening",
        "haven't looked",
      ],
      coachNotice: "Uncertainty is an answer, not a dead end — and unopened letters are themselves evidence of collection activity worth exploring.",
      suggestedMove: "Treat the honest I-don't-know as usable: note the area as open and keep working the remaining areas — unfiled years, the letters themselves, prior help — one at a time.",
      listenFor: "The prospect keeps giving material — rough figures, letter descriptions, a timeline — instead of going quiet or monosyllabic.",
    },
    {
      prospectPattern: "It is what it is. I just want it handled.",
      matchTerms: [
        "it is what it is",
        "just want it handled",
        "just fix it",
        "not a big deal",
      ],
      coachNotice: "They are flattening real impact into a three-word answer. Facts without impact leave you holding a form, not a case.",
      suggestedMove: "Pick the concrete detail they already gave — the garnishment, the letter — tie it to their paycheck or day-to-day life, then ask what they have already tried and how that worked.",
      listenFor: "The prospect starts describing impact and past attempts in their own words instead of confirming facts in three words.",
    },
    {
      prospectPattern: "I owe about forty grand, all federal. What else do you need?",
      matchTerms: [
        "what else do you need",
        "that's everything",
        "anything else",
        "all federal",
      ],
      coachNotice: "Cooperative speed is its own trap — one volunteered fact is not four covered areas, and they are inviting you to close discovery early.",
      suggestedMove: "Bank what they gave, then still walk the remaining areas — unfiled years, letters and enforcement, prior help — one at a time before any bridge.",
      listenFor: "All four areas end up covered in the transcript even though the prospect tried to end discovery after one.",
    },
  ],
  practiceModules: [
    {
      moduleId: "discovery.ask-permission",
      title: "Earn permission to ask",
      direction: "any",
      objective: "Ask permission before starting the question sequence, framing the questions as a fit check rather than a survey.",
      reading: "Discovery opens with a small ask, not a question barrage: \"To see if representation makes sense, can I ask a few quick questions?\" That line does two jobs — it names why you are asking, and it turns an interrogation into a conversation. Ask it before the first fact question, then let them answer.",
      coachNudge: "Frame the questions as a fit check and ask permission before the first fact question.",
      listenFor: "The prospect agrees, or asks a clarifying question about why, instead of tightening up or deflecting.",
      criterionIds: [
        "tax-resolution.2.ask_permission",
      ],
      situations: [
        "The prospect finishes describing a letter they received, then pauses and waits for you to take the lead.",
        "The prospect says: I'm not answering a bunch of personal questions — why do you need to know anything about me?",
      
        "The prospect says: Sure, ask whatever you want — but first give me a ballpark: what does something like this usually cost?",
        "The prospect grants permission and answers one question, then stops cold: Hold on — this is starting to feel like a survey. Who sees my answers, and why do you actually need them?",
      ],
      questions: [
        {
          questionId: "discovery-permission-reflection",
          prompt: "What does asking permission before the question sequence change about how discovery feels to the prospect?",
          gradingPoints: [
            "converts an interrogation into a conversation",
            "names the fit-check purpose of the questions",
            "the questions arrive announced instead of being sprung on them",
          ],
        },
      ],
    },
    {
      moduleId: "discovery.core-questions",
      title: "Cover the four facts without interrogating",
      direction: "any",
      objective: "Gather balance scope, unfiled years, collection activity, and prior help, one area at a time, without reading them off as a checklist.",
      reading: "Four fact areas build the case picture: about how much is owed and whether it is federal, state, or both; any unfiled years; letters about collections, liens, or garnishments; and whether they have worked with anyone before or this is the first time. Ask them one area at a time — a checklist read at the prospect collects fields but builds nothing. The question is about how much is owed, so a rough figure, or an honest \"I don't know,\" is a usable answer: note what is still open and keep going.",
      coachNudge: "Work through balance, filing, letters, and prior help one area at a time, and do not leave discovery with an area untouched.",
      listenFor: "The prospect keeps giving you material across all four areas — a rough figure or an honest \"I don't know\" counts — instead of going quiet or monosyllabic.",
      criterionIds: [
        "tax-resolution.2.core_questions",
      ],
      situations: [
        "The prospect says: I owe about forty thousand, I think it's all federal — what else do you need to know?",
        "The prospect says: Honestly I have no idea what I owe or which years are filed. I stopped opening the letters a while ago.",
      
        "The prospect delivers a tidy story in one breath — twenty-two thousand, all federal, everything filed, no letters — then mentions offhand that they moved last year and their mail still goes to the old address.",
        "Two questions in, the prospect flips: Why does any of this matter? Just tell me straight — can you make this go away or not?",
      ],
      questions: [
        {
          questionId: "discovery-core-open-areas",
          prompt: "You have the balance and the unfiled years. Which fact areas are still open before discovery is complete?",
          gradingPoints: [
            "collection activity such as letters, liens, or garnishments",
            "prior help versus first time dealing with it",
            "all four areas covered before moving on",
          ],
        },
      ],
    },
    {
      moduleId: "discovery.tie-pain-points",
      title: "Tie each problem to their life",
      direction: "any",
      objective: "Follow up on the issues the prospect actually raises and connect each one to daily life, bottom line, and what they have already tried.",
      reading: "Facts alone are a form. As each issue surfaces, tie it back to their day-to-day life and their bottom line — a garnishment is a smaller paycheck — and ask what steps they have already taken and how that worked. The goal is to make the tax problem feel like a real, personal part of their life, and that you are here to help with exactly that.",
      coachNudge: "When they mention an issue, follow their answer — ask what it has done to their life and what they have tried — before moving to the next fact.",
      listenFor: "The prospect starts describing impact and what they have tried in their own words instead of confirming facts in three words.",
      criterionIds: [
        "tax-resolution.2.pain_points",
      ],
      situations: [
        "The prospect mentions their paycheck has been garnished for two months, then moves on like it is a side note.",
        "The prospect answers every question in three words or less and says: it is what it is, I just want it handled.",
      
        "The prospect reports a garnishment and two unfiled years in the same cheerful breath, insists everything is fine, then lets slip they picked up weekend shifts to cover the smaller paychecks.",
        "The prospect opens up about the garnishment putting their rent at risk — then snaps shut: Forget I said that. What's this going to cost me?",
      ],
      questions: [
        {
          questionId: "discovery-pain-tie-reflection",
          prompt: "What separates a pain-point follow-up from another checklist question?",
          gradingPoints: [
            "responds to the prospect's actual answer",
            "connects the issue to daily life or bottom line",
            "asks what they have already tried and how it worked",
          ],
        },
      ],
    },
    {
      moduleId: "discovery.bridge-out",
      title: "Bridge out on a clear picture",
      direction: "any",
      objective: "Recognize when the picture is complete, say so, and hand the call forward without pitching.",
      reading: "The bridge is one earned sentence: \"That gives me a clear picture. Let me explain what we typically see in cases like yours.\" It only works after the core facts are in — bridge early and you advertise that no picture exists. State that the picture is clear and hand the call forward; the bridge is not the place to name services, fees, or numbers.",
      coachNudge: "Confirm the four fact areas are covered, state that the picture is clear, then use the bridge line — no pitching.",
      listenFor: "The prospect accepts the transition and settles in to listen instead of asking what all the questions were for — or, if the picture is still incomplete, accepts a brief deferral and keeps answering questions.",
      criterionIds: [
        "tax-resolution.2.bridge_to_expert",
      ],
      situations: [
        "The prospect has given you the balance, filing status, a recent letter, and confirmed this is their first time getting help — then goes quiet.",
        "Halfway through your questions the prospect cuts in: Okay, okay — so what exactly do you people do?",
      
        "Two questions in, the prospect says warmly: You clearly know your stuff — skip the rest and just tell me what you typically see in cases like mine.",
        "All four fact areas are covered, and as you begin the bridge the prospect cuts in: Before you explain anything, I want the price and a straight answer on whether the penalties come off.",
      ],
      questions: [
        {
          questionId: "discovery-bridge-reflection",
          prompt: "What has to be true before the bridge line will land?",
          gradingPoints: [
            "core fact areas are covered",
            "clear-picture statement before the hand-off",
            "no premature pitch or service naming",
          ],
        },
      ],
    },
  ],
  personas: [
    persona("discovery-open", "Concerned and cooperative", "Answers directly but needs the learner to organize the facts.", "foundation"),
    persona("discovery-vague", "Embarrassed and uncertain", "Uses vague answers and reveals useful facts only after careful follow-up.", "intermediate"),
    persona("discovery-combative", "Defensive and questioning", "Asks many questions, gives little back, and tests whether the learner will listen.", "advanced"),
  ],
  situations: [
    "Prospect knows an approximate federal balance but is unsure whether state debt also exists.",
    "Prospect has unfiled years and a recent collection letter but avoids discussing personal impact.",
    "Prospect had a poor prior-firm experience and answers every discovery question with another question.",
  ],
  prohibitedMoves: [
    "quoting a fee",
    "promising a resolution outcome",
    "jumping to the Representation Pitch before core facts are gathered",
    "treating checklist completion as a substitute for listening",
  ],
  reflectionPrompt: "Which answer did you follow up on to uncover real impact rather than merely collecting fields? What important fact was still missing?",
  questions: [
    question("discovery-four-facts", "What four core fact areas must Discovery cover?", ["tax-resolution.2.core_questions"]),
    question("discovery-pain", "What turns a factual tax interview into useful case building?", ["tax-resolution.2.pain_points"]),
  ],
});

const EXPERT_GUIDANCE = packet({
  id: "tax-resolution.expert-guidance",
  sectionId: "3",
  directions: ["inbound", "outbound"],
  localObjective: "Explain the prospect's situation accurately and make verified representation feel more useful than guessing.",
  maxTurns: 7,
  criteria: [
    criterion("3", "three_factors", "Explain that the case turns on what is owed, what is filed, and what the agencies have done on record.", "Cite the learner turn naming all three factors."),
    criterion("3", "name_the_situation", "Apply the script's approved nuance to the prospect's actual levy, lien, filing, business, or mismatch issue.", "Cite the learner turn that states the script's mechanic for the specific issue the prospect disclosed — lien secures the claim and seizes nothing now; levy or garnishment is enforced collection that is hard to overcome and reviewed immediately once represented; unfiled years mean IRS substitute returns that inflate the balance; payroll blends business and personal liability; cap-gains or self-employment income triggers mismatch notices — and shows that mechanic answering the fear the prospect actually voiced. A generic reassurance, or an accurate mechanic for an issue the prospect never raised, does not qualify."),
    criterion("3", "pain_relief_bridge", "Bridge from uncertainty to the value of working with verified facts and informed decisions.", "Cite the learner turn that states the stop-guessing-and-work-with-facts direction in the learner's own words — knowing exactly what is on record is what enables calm, informed decisions — and confirm that same turn contains no promised result, no predicted IRS or state decision, and no percentage or dollar outcome. A bare reassurance such as it will be okay or we handle this all the time, without the facts-over-guessing direction, does not qualify."),
  ],
  practiceModules: [
    {
      moduleId: "expert-guidance.three-factors-frame",
      title: "Frame the case in three factors",
      direction: "any",
      objective: "Organize everything Discovery surfaced around what is owed, what is filed, and what is on record before offering any interpretation.",
      reading: "Every tax case comes down to three things — what's owed, what's filed, and what the IRS has already done on record. State the frame as the way every case works, not as a slogan, then load it with the prospect's own facts: their balance, their unfiled years, their notice. The honest punchline carries the weight — until someone represents them, the IRS makes it hard to see the full details.",
      coachNudge: "Name all three factors plainly, tie each one to a fact the prospect actually gave you, and let the hard-to-see-the-record point land on its own — no pitch behind it.",
      listenFor: "The prospect starts sorting their own situation into the three factors instead of circling in loose worry, or the self-certain one asks what is actually on their record instead of restating what they read online.",
      criterionIds: [
        "tax-resolution.3.three_factors",
      ],
      situations: [
        "The prospect sighs and says: So what do you think is actually going on with my account?",
        "The prospect says they have researched everything online, already knows exactly what their problem is, and asks why they need anyone to explain their own case to them.",
      
        "The prospect dumps everything at once — roughly forty thousand owed, three unfiled years, and a collections letter — then says: You're the expert, so which one do I qualify for, the offer in compromise or the hardship program? They will keep pressing for a program name until the conversation is organized differently.",
        "The prospect agrees with everything instantly — owed, filed, on record, got it, makes sense — then says: So since we know all that, the balance on my last notice must be the real number, let's just work from that. The real issue is hiding in their easy agreement: they believe the notice IS the record.",
      ],
      questions: [
        {
          questionId: "expert-three-factors-frame",
          prompt: "What are the three factors, and what turns the frame from a slogan into demonstrated expertise?",
          gradingPoints: [
            "what is owed, what is filed, what is on record",
            "loaded with the prospect's specific discovery facts",
            "until someone represents them, the IRS makes it hard to see the full details",
          ],
        },
      ],
    },
    {
      moduleId: "expert-guidance.name-the-situation",
      title: "Name their situation with real nuance",
      direction: "any",
      objective: "Explain the prospect's specific enforcement, lien, filing, business, or mismatch issue accurately, correcting fear with fact and promising nothing.",
      reading: "Each situation has its own mechanic, and precision is what authority sounds like. A garnishment or levy means the account was flagged for enforced collection — genuinely hard to overcome, and reviewed immediately. A lien secures the IRS or state claim so they are paid first if the prospect sells or liquidates, and seizes nothing today; unfiled years mean the IRS files substitutes that inflate balances; payroll cases blend business and personal liability; cap-gains and self-employment income trigger mismatch notices. Match the explanation to the fact the prospect actually disclosed — correcting a fear with an accurate fact is the whole move.",
      coachNudge: "Answer the fear with the mechanic — what the action does and does not do to them — and never guarantee a levy or garnishment release or predict what the IRS will decide.",
      listenFor: "The prospect's fear turns into a specific question about their own record instead of a demand for a guarantee or a worst-case spiral.",
      criterionIds: [
        "tax-resolution.3.name_the_situation",
      ],
      situations: [
        "The prospect says: I got a letter saying they put a lien on me — does that mean they are taking my house?",
        "The prospect's wages are being garnished and they demand you promise, right now, that it stops this week.",
        "A self-employed prospect got a notice saying their reported income does not match and assumes it means a full audit is already underway.",
      
        "The prospect called about a lien letter, but halfway through your explanation cuts in: Actually, my paycheck came up short this week too — so is that the lien taking my money, or something else? They are now conflating two different mechanics mid-stream and will stay confused until each is named accurately.",
        "A prospect with payroll tax debt from a business that closed says their old bookkeeper swore the company owes it, not them personally — and they will only keep listening if you confirm, right now, that they are personally off the hook.",
      ],
      questions: [
        {
          questionId: "expert-nuance-lien-vs-levy",
          prompt: "How does a lien differ from a levy or garnishment, and why does that difference matter to a frightened prospect?",
          gradingPoints: [
            "lien secures the claim and seizes nothing now",
            "levy or garnishment is active enforced collection",
            "accurate correction calms fear without promising release",
          ],
        },
        {
          questionId: "expert-nuance-unfiled",
          prompt: "What do unfiled years do to the balance the IRS shows, and what does representation make possible?",
          gradingPoints: [
            "the IRS files substitute returns for the missing years",
            "substitutes inflate the balance",
            "representation lets the firm pull wage and income reports and get the years filed correctly",
          ],
        },
      ],
    },
    {
      moduleId: "expert-guidance.pain-relief-bridge",
      title: "Land the calm pain-relief bridge",
      direction: "any",
      objective: "Close the guidance moment by converting the uncertainty you just explained into calm direction grounded in verified facts.",
      reading: "The bridge is one calm idea: \"stop guessing and start working with facts.\" It converts the anxiety your explanation surfaced into direction — once they know exactly what is on record, they can make calm, informed decisions. Deliver it without drama and without predicting what the IRS will decide; the relief comes from certainty about the record, not from a promised outcome.",
      coachNudge: "Give one steady sentence of direction — stop guessing, work with facts — as relief rather than a prediction, even when the prospect pushes hard for a guarantee.",
      listenFor: "The prospect's tone settles and they engage with knowing what is actually on record instead of pressing for a yes-or-no promise.",
      criterionIds: [
        "tax-resolution.3.pain_relief_bridge",
      ],
      situations: [
        "The prospect exhales and says: Okay, that makes more sense than anything I have read — I have just been so stressed I do not know what is true anymore.",
        "The prospect says facts are fine, but demands to know, yes or no, whether you can make this whole thing go away.",
      
        "The prospect says: Fine, facts, whatever — the last company said the exact same thing about getting the facts, took my money, and nothing changed. They demand you sound different without promising anything, and any hint of a guaranteed result confirms their suspicion.",
        "The prospect visibly settles during your explanation and agrees that facts beat guessing — then, just as you finish, spikes again: Okay, but realistically, what percentage of this debt goes away? Just a ballpark, off the record.",
      ],
      questions: [
        {
          questionId: "expert-bridge-reflection",
          prompt: "Why does the script end expert guidance with facts and calm decisions instead of naming a resolution?",
          gradingPoints: [
            "no outcome can honestly be promised before the record is reviewed",
            "certainty about the record is the real relief",
            "gives direction without predicting what the IRS will decide",
          ],
        },
      ],
    },
  ],
  personas: [
    persona("guidance-confused", "Overwhelmed", "Mixes up liens, levies, and balances and needs a plain explanation.", "foundation"),
    persona("guidance-urgent", "Anxious", "Has active enforcement and presses for an immediate guaranteed fix.", "intermediate"),
    persona("guidance-opinionated", "Certain but misinformed", "Repeats advice from the internet or a prior provider and challenges nuance.", "advanced"),
  ],
  situations: [
    "Prospect thinks a lien means the IRS is taking the house today.",
    "Prospect has wage garnishment and demands assurance it will stop immediately.",
    "Self-employed prospect received mismatch notices and assumes an audit outcome.",
  ],
  prohibitedMoves: [
    "guaranteeing levy or garnishment release",
    "diagnosing a resolution strategy before records are reviewed",
    "reciting unrelated tax facts",
    "moving to price before relevant guidance lands",
  ],
  reflectionPrompt: "Which case fact did you explain with useful nuance? Did you accidentally sound more certain than the verified record allowed?",
  questions: [
    question("guidance-three-factors", "What are the three factors every case comes down to?", ["tax-resolution.3.three_factors"]),
    question("guidance-facts", "Why does the script bridge toward verified facts instead of naming a resolution immediately?", ["tax-resolution.3.pain_relief_bridge"]),
  ],
});

const REPRESENTATION = packet({
  id: "tax-resolution.representation-pitch",
  sectionId: "4",
  directions: ["inbound", "outbound"],
  localObjective: "Present representation as the responsible foundation for verified case work, then state the fee confidently.",
  maxTurns: 10,
  criteria: [
    criterion("4", "three_authorizations", "Present Form 2848, Form 8821, and applicable state POA as the first representation step.", "Cite the learner turn that names all three authorizations specifically — IRS Form 2848, Form 8821, and the state POA (if applicable) — and positions them as the first step of representation. A turn naming fewer than three, or referring generically to 'some forms' or 'the paperwork,' does not pass."),
    criterion("4", "educate_forms", "Explain each authorization in plain language.", "Cite the learner turn(s) that pair each specific form with its own distinct job: 2848 = limited power of attorney so staff speak directly with the IRS, 8821 = authorization to pull the master file and transcripts, state POA = the same authority at the state level. A blanket line like 'they let us talk to the IRS and get your records' that never maps a job to a named form does not pass."),
    criterion("4", "foundation_not_fix", "State that authorization opens access and communication but does not itself change the balance.", "Cite the learner turn that states both halves: what the forms DO (open access and lawful communication) and what they do NOT do (change the balance), plus the compliance check that follows filing. 'This is just the first step,' with no explicit denial that signing changes the balance, does not pass."),
    criterion("4", "marathon_urgency", "Balance accurate marathon framing with healthy urgency when active communication exists.", "Cite the learner turn that sets the marathon/starting-line expectation with no promised date or duration AND — when the prospect has reported active IRS communication — ties urgency to that specific fact (the sooner it's filed, the sooner the legal team engages). Fail on any promised timeline, invented deadline, or a turn that lets an active-notice prospect delay without pushback."),
    criterion("4", "differentiate", "Differentiate the firm's verify-first approach without attacking competitors.", "Cite the learner turn that declines to match or beat a promised outcome, states the verify-first sequence (represent, gather verified data, then outline real options), and never attacks the competitor. Matching the quoted number, guaranteeing 'we can do that too,' or calling the other firm a scam all fail even if the contrast language is present."),
    criterion("4", "fee_line", "State the flat representation fee and included work matter-of-factly.", "Cite the learner turn that states the flat fee amount together with the specific scope items — federal and state POA forms, transcript retrieval, and the initial attorney-led compliance review. 'It covers everything' does not count as scope, and any apology, unprompted discount, or slide into payment-term negotiation before the full fee has landed fails the criterion."),
  ],
  // The ONE place company specifics are taught, per Mickey's 2026-07-29 ruling.
  // Not a script beat — the ruling created it — so it lives in rulingCriteria and is
  // appended only AFTER the beat-coverage assertion has passed.
  rulingCriteria: [
    rulingCriterion(
      "4",
      "earned_disclosure",
      "Judge whether this prospect has earned company specifics — buyer intent AND substantial self-disclosure — and share proportionately only once both are true.",
      "Cite the learner turn that either (a) withholds specifics and keeps earning when the prospect has disclosed little or shown no intent to solve the problem, or (b) answers the specific question actually asked, proportionately, after the prospect has both engaged as a buyer and given real case facts. A credentials recital fails, and so do specifics handed to a prospect who has disclosed nothing.",
      "ruling.company-disclosure-is-earned",
    ),
  ],
  responseSignals: [
    {
      prospectPattern: "Three forms just to make a phone call? Why can't you just call the IRS for me?",
      matchTerms: [
        "three forms",
        "paperwork",
        "just call",
        "why can't you",
      ],
      coachNotice: "They hear bureaucracy, not authority. The paperwork objection is a request for plain-language jobs, not for fewer forms.",
      suggestedMove: "Name all three authorizations, then give each exactly one plain-language job — direct IRS communication, master-file and transcript access, the same authority at the state level. No jargon, and no defending the paperwork.",
      listenFor: "The prospect can tell the forms apart or asks a practical next-step question instead of re-litigating the paperwork.",
    },
    {
      prospectPattern: "So once I sign, my balance starts going down, right?",
      matchTerms: [
        "balance go down",
        "lower my",
        "reduce my",
        "actually fix",
      ],
      coachNotice: "They have conflated authorization with resolution. Let it stand and they will feel misled the first time nothing shrinks after signing.",
      suggestedMove: "Separate the two out loud — the forms open access and lawful communication, they do not change the balance — then anchor the value in the compliance check that follows filing.",
      listenFor: "They stop asking whether signing shrinks the debt and start asking what the compliance check will show.",
    },
    {
      prospectPattern: "How fast can you make this whole thing disappear — weeks?",
      matchTerms: [
        "how fast",
        "how long",
        "how quickly",
        "weeks",
        "go away",
      ],
      coachNotice: "They are fishing for a timeline promise. Any date given now becomes a commitment the unopened file cannot support.",
      suggestedMove: "Set the marathon expectation with representation as the starting line, decline to comment on strategy before the firm is inside the file, and if they report active IRS communication, tie real urgency to that fact instead of a date.",
      listenFor: "They accept a realistic pace without extracting a date or duration.",
    },
    {
      prospectPattern: "I got that notice, but I figure I'll sit on it a couple months and see if it blows over.",
      matchTerms: [
        "sit on it",
        "wait a",
        "see what happens",
        "blows over",
        "few months",
      ],
      coachNotice: "Active IRS communication plus deliberate delay — the one situation where urgency is legitimate, and it must come from their facts, never manufactured pressure.",
      suggestedMove: "Tie filing speed to the communication they already received — the sooner representation is filed, the sooner the legal team engages, and nothing moves without review — without inventing deadlines or consequences the record does not show.",
      listenFor: "They connect the notice to filing now, rather than complying out of fear of a threat you never made.",
    },
    {
      prospectPattern: "The other place said they'd settle it for pennies on the dollar. Can you match that?",
      matchTerms: [
        "pennies on the dollar",
        "other company",
        "they promised",
        "can you match",
        "settle for",
      ],
      coachNotice: "A double bait — match the promise or trash the competitor. Both are prohibited moves; the refusal to guess IS the pitch.",
      suggestedMove: "Contrast approaches, not companies: no number is real before the records are pulled, and the responsible path is represent, gather verified data, then outline real options from facts. Sell that honesty as the reason to hire the firm.",
      listenFor: "They stop pressing you to beat the number and start asking what the verify-first process involves.",
    },
    {
      prospectPattern: "Whoa — before another word, what is this going to cost me?",
      matchTerms: [
        "how much",
        "cost me",
        "what's it cost",
        "price",
      ],
      coachNotice: "The fee moment arrived early. Hesitation, apology, or a softening preamble here is exactly what invites the discount fight.",
      suggestedMove: "State the flat fee and the exact scope — federal and state POA forms, transcript retrieval, attorney-led compliance review — in one even sentence, then stop. Payment structure is a separate later conversation; do not start improvising terms.",
      listenFor: "The fee lands as information — they engage with the number and scope instead of opening a negotiation.",
    },
  ],
  practiceModules: [
    {
      moduleId: "representation.pitch-the-authorizations",
      title: "Pitch and explain the three forms",
      direction: "any",
      objective: "Present the three authorizations as the first step and explain each form in one plain sentence.",
      reading: "Representation starts with three authorizations: IRS Form 2848, Form 8821, and the state POA if applicable. Each one gets a single plain sentence — the 2848 is a limited power of attorney so the firm's staff can speak directly with the IRS, the 8821 authorizes pulling the master file and transcripts, and the state POA does the same at the state level. Plain beats impressive; if the prospect can repeat the difference back, you explained it right.",
      coachNudge: "Name all three authorizations first, then give each form exactly one plain-language job: communication authority, transcript access, state authority.",
      listenFor: "The prospect can tell the forms apart and asks a practical next-step question instead of sounding buried in paperwork.",
      criterionIds: [
        "tax-resolution.4.three_authorizations",
        "tax-resolution.4.educate_forms",
      ],
      situations: [
        "The prospect says: Okay, I follow so far — what actually happens next?",
        "The prospect pushes back: Three forms? That sounds like a lot of paperwork just to talk to somebody. Why can't you just call them?",
      
        "The prospect brings a horror story and a suspicion: My brother-in-law signed a power of attorney once and the guy cleaned out his bank account. Which one of these three forms lets you touch my money? — and refuses to move on until each form's actual, limited authority is named in plain words.",
        "The prospect agrees too fast: Sure, whatever — email me all three tonight and I'll sign them. What's next? — trying to skip the explanation entirely, so the only way through is to land each form's one-sentence job before accepting the yes.",
      ],
      questions: [
        {
          questionId: "representation-forms-reflection",
          prompt: "What does each of the three authorizations permit the firm to do, in plain language?",
          gradingPoints: [
            "2848 as limited power of attorney for direct IRS communication",
            "8821 as authorization to pull the master file and transcripts",
            "state POA extending the same authority at the state level",
          ],
        },
      ],
    },
    {
      moduleId: "representation.foundation-not-fix",
      title: "Frame the forms as foundation, not fix",
      direction: "any",
      objective: "Make the prospect understand that the authorizations open access and lawful communication but do not themselves change the balance.",
      reading: "The forms don't change the balance — they \"open the door so we can see the facts and communicate lawfully.\" Say that separation out loud; a prospect who thinks signing shrinks the debt feels lied to later. Once the forms are filed, the firm runs a full compliance check.",
      coachNudge: "State plainly what the forms do and do not do, then anchor the value in the compliance check that follows — never let signing sound like the resolution itself.",
      listenFor: "The prospect stops asking whether signing lowers the debt and starts asking what the compliance check will show once the firm is inside the file.",
      criterionIds: [
        "tax-resolution.4.foundation_not_fix",
      ],
      situations: [
        "The prospect asks: So once I sign these forms, does my balance go down?",
        "The prospect says flatly: I'm not paying for paperwork that doesn't actually fix anything. What am I really getting?",
      
        "The prospect turns the honesty against the sale: Fine — the forms don't fix anything. So call me back when you can tell me what WILL fix it, and then I'll pay you. — the win requires showing that real options can only be outlined from verified data, and the forms are what open that access.",
        "The prospect half-agrees, then restates the myth in new words: Right, right, foundation, got it — so once you're inside the file you'll knock this balance down for me, yeah? — tempting a lazy 'exactly' that would re-plant the misconception.",
      ],
      questions: [
        {
          questionId: "representation-foundation-reflection",
          prompt: "What must you say so the prospect understands what representation does and does not accomplish?",
          gradingPoints: [
            "forms open access and lawful communication",
            "forms do not change the balance",
            "full compliance check follows the filing",
          ],
        },
      ],
    },
    {
      moduleId: "representation.marathon-with-honest-urgency",
      title: "Set the marathon, keep the urgency honest",
      direction: "any",
      objective: "Set a marathon expectation without promising timelines, while applying real urgency when active IRS communication exists.",
      reading: "Tax-debt work is \"a marathon, not a sprint,\" and representation is the starting line. But urgency can be honest: if the prospect has had active IRS communication, the sooner the POA is filed, the sooner the legal team engages. The line to hold is that urgency comes from their real situation, never from manufactured pressure or a promised timeline.",
      coachNudge: "Refuse both traps — no speed promises for the impatient prospect, no permission to stall for the one who has had active IRS communication. Tie any urgency to what the IRS is actually doing.",
      listenFor: "The prospect accepts a realistic pace, or the delaying prospect recognizes why filing now matters, without you promising how fast anything resolves.",
      criterionIds: [
        "tax-resolution.4.marathon_urgency",
      ],
      situations: [
        "The prospect asks: How fast can you make this whole thing go away? Weeks? Days?",
        "The prospect says: I got a final notice last week, but honestly I'd rather sit on it a few months and see if they forget about me.",
      
        "The prospect throws both poles at once: My paycheck got garnished Friday, but my sister says these things take years — so which is it, an emergency or a marathon? — the win holds both truths: marathon pacing, plus urgency tied to the active enforcement, with no promised timeline.",
        "The prospect agrees on the spot with a string attached: I'll sign today if you promise this is wrapped up before my refinance closes in October. — an easy yes that only survives if you refuse the date, keep the starting-line framing, and let filing speed be the honest urgency.",
      ],
      questions: [
        {
          questionId: "representation-urgency-reflection",
          prompt: "When is urgency legitimate in the representation pitch, and when is it a compliance problem?",
          gradingPoints: [
            "marathon framing without promised timelines",
            "urgency tied to real active IRS communication",
            "manufactured pressure is prohibited",
          ],
        },
      ],
    },
    {
      moduleId: "representation.differentiate-without-promises",
      title: "Differentiate calmly, never by bashing",
      direction: "any",
      objective: "Contrast the firm's verify-first approach with big-promise competitors without attacking anyone or guaranteeing an outcome.",
      reading: "The differentiator is the refusal to promise: \"A lot of companies rush to big promises. We don't.\" The responsible path is get represented, gather verified data, then outline real options based on facts — so a settlement number quoted before anyone has pulled the file is a guess. Sell that honesty as the reason to hire the firm, not as an apology, and contrast approaches rather than companies.",
      coachNudge: "When a competitor's promise comes up, do not match it and do not attack the competitor — make the refusal to guess the strongest thing you say.",
      listenFor: "The prospect stops pushing you to match the bigger promise and starts asking what the verify-first process actually involves.",
      criterionIds: [
        "tax-resolution.4.differentiate",
      ],
      situations: [
        "The prospect says: The other company told me they could settle this for pennies on the dollar. Can you beat that?",
        "The prospect asks, half-bored: What makes you any different from every tax relief outfit I hear on the radio?",
      
        "The prospect recruits you as a co-conspirator: I already paid one of these outfits $4,000 for nothing. Say it with me — those guys are crooks, right? So how are you not them? — agreeing feels like rapport but is the prohibited bash; the win contrasts the verify-first approach without attacking anyone.",
        "The prospect dangles the close as bait: Forget them — just tell me you can beat the 40% they quoted and I'll sign right now. — the sale is one guarantee away, and the only passing move is refusing to quote an outcome before the records are pulled while making that refusal the value.",
      ],
      questions: [
        {
          questionId: "representation-differentiate-reflection",
          prompt: "How do you answer a competitor's settlement promise without guaranteeing anything or bashing them?",
          gradingPoints: [
            "no outcome guarantees before records are reviewed",
            "verify-first process stated as the value",
            "contrast of approach without attacking the competitor",
          ],
        },
      ],
    },
    {
      moduleId: "representation.state-the-fee",
      title: "State the flat fee like a fact",
      direction: "any",
      objective: "Name the flat representation fee and exactly what it covers in one even, matter-of-fact breath.",
      reading: "The fee is a fact, delivered like one: the flat legal fee for representation covers the federal and state POA forms, transcript retrieval, and the initial attorney-led compliance review. Say the number and the scope in the same calm tone you used for everything else — no apology, no discount, no softening preamble. Payment structure is a separate conversation that comes after; here, the only job is a clean, confident statement of price and scope.",
      coachNudge: "One even sentence: the number plus what it buys. If they push on price, restate the scope with the same calm — do not apologize, discount, or start improvising terms.",
      listenFor: "The fee lands as information — the prospect engages with the number and what it covers instead of hearing hesitation and pressing for a discount.",
      criterionIds: [
        "tax-resolution.4.fee_line",
      ],
      situations: [
        "The prospect asks evenly: Okay — so how much does all of this cost?",
        "The prospect cuts in: Before you go any further, I'm not paying thousands of dollars, so what's your best price?",
      
        "The prospect refuses the frame entirely: Skip the pitch — just give me the monthly number. What do I owe you a month? — a bottom-line fisher pulling you into payment terms before the full flat fee is stated; the win states the whole fee and scope first, evenly, before any structure talk.",
        "The prospect stacks a flinch on a comparison: THAT much? The radio guy charges half and guarantees results — knock a thousand off and we have a deal today. — double temptation to discount and to match a promise; the win restates the same fee and the same scope in the same calm tone.",
      ],
      questions: [
        {
          questionId: "representation-fee-reflection",
          prompt: "What belongs in the fee statement, and what must be absent from it?",
          gradingPoints: [
            "flat fee stated matter-of-factly",
            "scope named: POA forms, transcript retrieval, attorney-led compliance review",
            "no apologizing, discounting, or improvised payment terms",
          ],
        },
      ],
    },
    {
      moduleId: "representation.earned-disclosure",
      title: "Share who we are only when it's earned",
      direction: "any",
      objective: "Judge when both gates — buyer intent and substantial self-disclosure — have been met before sharing company specifics, and share proportionately once they are.",
      reading: "Who we are is earned, never offered — company specifics are not an opening move, and there is exactly one moment they belong: the prospect is a buyer AND has already given you substantial information about themselves. Both gates, not either — a loud buyer who has shared nothing gets more earning, not a resume, and so does a big talker with no intent to hire. Once both gates are met, share proportionately: answer exactly what was asked and stop, no credentials recital. A direct question gets a truthful minimum at any stage — never dodge it and never misstate the firm — but answering honestly is not permission to start pitching yourself.",
      coachNudge: "Run the two-gate check before any specifics leave your mouth — buyer intent AND substantial self-disclosure. Missing either, give the truthful minimum to whatever was directly asked and return to earning; both met, answer what was asked and nothing more.",
      listenFor: "Specifics arrive only as answers to questions the prospect actually asked, and the conversation returns to their case — they keep volunteering facts instead of interviewing you.",
      criterionIds: [
        "tax-resolution.4.earned_disclosure",
      ],
      situations: [
        "The prospect interrupts early: Hold on — who exactly am I talking to? What company, how long have you been around, are you licensed? — nothing about their situation has been shared and no buying signal exists; the right move is a truthful minimum answer to what was asked, then back to finding out whether they have a tax issue — not the credentials block.",
        "The prospect has walked you through the garnishment, the unfiled years, and the $60,000 balance, and says: Okay, I'm close to a yes — before I sign, who would actually be working my case? Are there real attorneys there?",
        "The prospect opens hot: I'm hiring somebody today, whoever sells me first. Give me the full rundown — credentials, headcount, wins, all of it — and you've got a deal. — the buyer gate is loud but the self-disclosure gate is empty; the tempting move is to unload the firm resume to close, and the win is a brief truthful answer, no recital, and earning their facts before anything more.",
        "The prospect is a buyer with everything on the table and asks: How many cases exactly like mine did you close this year, and what did they settle for? — the temptation is a manufactured stat or a borrowed outcome; the win shares only what is truthfully known, says so plainly when a number is not, and anchors back in what verified records will show for their file.",
        "The prospect has volunteered every detail of a decade of tax trouble but keeps deflecting any next step: This is just research, I'm not hiring anyone this month — go ahead and send me your whole company profile for my spreadsheet. — substantial self-disclosure without buyer intent is still one gate; the win answers direct questions with a truthful minimum and keeps working the decision, not the brochure.",
      ],
      questions: [
        {
          questionId: "earned-disclosure-gates",
          prompt: "What two conditions must both be true before you share company specifics, and how much do you share once they are?",
          gradingPoints: [
            "both gates required: the prospect is a buyer AND has provided substantial information about themselves",
            "one gate alone means keep earning — no volunteered specifics",
            "proportionate sharing once both gates are met: answer exactly what was asked, no credentials recital",
          ],
        },
        {
          questionId: "earned-disclosure-direct-question",
          prompt: "A prospect demands your bona fides in the first minute, before sharing anything about themselves. What do you owe them, and what do you not owe them?",
          gradingPoints: [
            "a direct question earns a truthful minimum answer — never evasion, never misstating the firm",
            "no credentials block or volunteered specifics while the gates are unmet",
            "the next move returns to identifying whether this person has a tax issue",
          ],
        },
      ],
    }
  ],
  personas: [
    persona("representation-practical", "Ready for a process explanation", "Wants to know exactly what the initial fee covers.", "foundation"),
    persona("representation-promise-seeker", "Anxious for certainty", "Pushes for a guaranteed settlement before agreeing to representation.", "intermediate"),
    persona("representation-shopper", "Skeptical comparator", "Mentions another company making larger promises and challenges the value.", "advanced"),
  ],
  situations: [
    "Prospect asks why three forms are needed and whether signing them reduces the debt.",
    "Prospect wants the exact resolution before paying for representation.",
    "Prospect says another firm promised pennies on the dollar and asks why this firm will not.",
  ],
  prohibitedMoves: [
    "presenting authorization as the final fix",
    "guaranteeing strategy or outcome",
    "bashing another company",
    "negotiating payment terms before stating the full fee and pausing",
  ],
  reflectionPrompt: "Did your explanation make representation feel concrete without turning it into a promised result? How confidently did you state the fee?",
  questions: [
    question("representation-forms", "What does each authorization permit the firm to do?", ["tax-resolution.4.three_authorizations", "tax-resolution.4.educate_forms"]),
    question("representation-foundation", "What must you say so the prospect understands representation is a foundation, not a fix?", ["tax-resolution.4.foundation_not_fix"]),
  ],
});

const PAYMENT_TERMS = packet({
  id: "tax-resolution.payment-terms",
  sectionId: "4B",
  directions: ["inbound", "outbound"],
  localObjective: "Hold value after the fee, use silence, and walk the approved payment ladder in order.",
  maxTurns: 9,
  criteria: [
    criterion("4B", "state_fee_pause", "State the fee and allow the prospect to react before offering alternatives.", "Cite the fee turn and ensure the next learner turn responds to the prospect rather than pre-discounting."),
    criterion("4B", "anchor_full", "Offer paid in full first and link it to immediate file movement.", "Cite the learner's full-payment anchor."),
    criterion("4B", "two_month_split", "Offer the approved half-now, balance-in-30-days structure only after the full-payment anchor.", "Cite two turns: the prospect turn resisting paid-in-full, then the learner turn offering half today with the balance in 30 days. The learner turn must not also contain the four-month option or any lower rung — a stacked list fails even when the split itself is worded correctly."),
    criterion("4B", "four_month", "Offer four monthly payments with the approved minimum only after earlier options.", "Cite the prospect turn resisting the two-month split, then the learner turn offering four monthly payments that states the $350 minimum. Missing the $350 floor, or offering the four-month before the split has met real resistance, fails."),
    criterion("4B", "card_on_file", "Treat card on file as a standard service-agreement step and move to how payment will be made.", "Cite the learner turn that names the card on file as standard under the service agreement and then moves to how payment will be made. Calm is evidenced by what is absent — quote the turn and confirm it contains no apology, no defensive over-explanation, and no retreat from the card being standard."),
    criterion("4B", "alt_choice_close", "Close with an alternative choice rather than a yes/no question.", "Cite the closing learner turn and confirm two things from its text: the options offered are only approved structures (full today, two payments, or four monthly at $350), and the question cannot be answered with a bare yes or no. A hybrid like 'which works — do you want to do this?' fails the second check."),
  ],
  practiceModules: [
    {
      moduleId: "payment-terms.state-and-hold",
      title: "State the fee, then hold the silence",
      direction: "any",
      objective: "Let the fee land and read the prospect's reaction before offering anything else.",
      reading: "The script is blunt: \"State the fee, then PAUSE. Let them react.\" That silence belongs to the prospect; rushing to fill it pre-discounts instead of responding to what they actually said, and it ends with you negotiating against yourself. Deliver the number matter-of-fact and stop — silence is powerful, so don't rush to fill the gap. Their reaction sets the next move: if they agree, collect info; if they hesitate, walk the ladder.",
      coachNudge: "Say the number in one plain, matter-of-fact sentence and stop — the next voice on the line must be theirs.",
      listenFor: "The prospect is the one who breaks the silence — a yes, a question, or a complaint about the number — instead of the learner filling it.",
      criterionIds: [
        "tax-resolution.4B.state_fee_pause",
      ],
      situations: [
        "After hearing the fee, the prospect goes completely silent for several long seconds.",
        "The prospect exhales, mutters that this is a lot of money, and then just waits to see what you do with it.",
      
        "The instant the number is out, the prospect snaps 'is that negotiable or what?' — using your own silence against you and daring you to answer with a softer number before they've actually reacted to the fee.",
        "The prospect sighs, mutters 'figured it'd be something like that,' and goes quiet again — an ambiguous reaction that tempts you to start pitching options before you know whether that was agreement or hesitation.",
      ],
      questions: [
        {
          questionId: "payment-pause-reflection",
          prompt: "Why does the script demand a pause after the fee instead of immediately explaining the payment options?",
          gradingPoints: [
            "the script requires the pause — silence is powerful",
            "rushing to fill the gap pre-discounts instead of responding to the prospect",
            "their reaction sets the next move: agree, collect info; hesitate, walk the ladder",
            "avoids negotiating against yourself",
          ],
        },
      ],
    },
    {
      moduleId: "payment-terms.anchor-full-first",
      title: "Anchor paid-in-full first",
      direction: "any",
      objective: "Present full payment as the normal path and tie it to immediate file movement before any alternative structure is mentioned.",
      reading: "The ladder always starts at the top: \"Most clients take care of this all at once so their file moves immediately\" — once payment and signed docs are in, the POA is filed and representation activated the same day. The tone rule is explicit: confidence first, options second, ALWAYS start from full — even when the prospect asks about payment plans before you have offered anything. The anchor is what lets every later structure read as help rather than retreat.",
      coachNudge: "Always start from full and tie it to same-day activation before any alternative exists.",
      listenFor: "The prospect responds to the full-payment frame — accepting it or naming a real constraint — instead of being handed easier terms unprompted.",
      criterionIds: [
        "tax-resolution.4B.anchor_full",
      ],
      situations: [
        "The prospect hesitates after the fee and says they were not expecting it to be that much.",
        "The prospect immediately asks whether you have payment plans before you have offered anything at all.",
      
        "The prospect says another firm already quoted them low monthly payments and asks point-blank why you haven't offered a plan yet — inviting you to skip the anchor and match the competitor in the same breath.",
        "The prospect waves the whole thing off with 'whatever's easiest for you — just set something up,' an easy agreement that invites you to pick a mid-ladder structure for them before paid-in-full has ever been on the table.",
      ],
      questions: [
        {
          questionId: "payment-anchor-reflection",
          prompt: "Why must paid-in-full be offered first, even when the prospect has already asked about plans?",
          gradingPoints: [
            "always start from full — confidence first, options second",
            "full payment links to same-day POA filing and activation",
            "options appear only after the prospect reacts to the anchor",
            "the anchor is what makes a later structure read as help rather than retreat",
          ],
        },
      ],
    },
    {
      moduleId: "payment-terms.walk-the-ladder",
      title: "Walk the ladder one rung at a time",
      direction: "any",
      objective: "Answer real hesitation by offering the two-month split, then the four-month option, in order and without moving the total.",
      reading: "The rungs are fixed: \"half today to open the case, the balance in 30 days — still gets your POA filed right away,\" and below that \"four monthly payments, minimum $350/month, to keep the file moving and in good standing.\" Each rung appears only after the one above it meets genuine resistance; stacking the options at once teaches the prospect to wait you out. \"I can't do that all at once\" — or \"call me at the end of the month\" — is a constraint, not a rejection: it rules out paid-in-full, not the sale, so offer the next approved structure before entertaining a later call. Every option is structure to make the fee manageable — the total never moves, the word \"cheaper\" never appears, and the fee never gets an apology.",
      coachNudge: "Offer one rung per hesitation, then stop and let them react before anything lower exists.",
      listenFor: "The prospect engages the one structure actually on the table — picking it, pressing for a lower total, or asking to push the decision out — rather than being handed the whole ladder at once.",
      criterionIds: [
        "tax-resolution.4B.two_month_split",
        "tax-resolution.4B.four_month",
      ],
      situations: [
        "The prospect says they cannot pay the whole thing at once but sounds genuinely ready to hear an option.",
        "The prospect keeps pushing for the cheapest possible deal and asks what your bottom number really is.",
        "The prospect says money is tight until the end of the month and suggests you just call back some other time.",
      
        "The prospect accepts the half-now split, then reverses mid-stream: they'll do the split, but only if you knock a few hundred off the total 'since you're clearly flexible on terms.'",
        "The prospect cuts you off with 'skip the sales routine — list every option you've got and your absolute bottom number, right now,' demanding the whole ladder and a discount in one turn.",
      ],
      questions: [
        {
          questionId: "payment-ladder-reflection",
          prompt: "What separates offering a payment structure from offering a discount?",
          gradingPoints: [
            "the total fee stays untouched",
            "framed as making it manageable, never cheaper",
            "each rung still keeps the file moving and the POA filed",
            "offered in sequence, only after real resistance",
          ],
        },
        {
          questionId: "payment-constraint-reflection",
          prompt: "The prospect says they cannot do all of that today and asks you to call back at the end of the month. What have they told you, and what comes next?",
          gradingPoints: [
            "it rules out paid-in-full, not the sale",
            "a constraint answered with structure, not a retreat",
            "offer the next approved rung — half now, or four monthly at $350 — before agreeing to a later call",
            "the total fee, and the tone, stay exactly where they were",
          ],
        },
      ],
    },
    {
      moduleId: "payment-terms.finish-with-a-choice",
      title: "Card on file and the alternative-choice close",
      direction: "any",
      objective: "Normalize the card on file as routine and close by asking which approved structure works — never whether they want to proceed.",
      reading: "Once a structure lands, state the balance and move straight to \"how will you be paying?\" — a card on file is standard under the attorney-client service agreement and keeps the case uninterrupted, so keep it casual and break it down one level at a time. The final close is an alternative choice, never yes/no: \"You can take care of it in full today, or start with two payments or four monthly of $350 — which works best to get representation started today?\" A yes/no question hands the prospect a door out; a choice between approved structures presumes the decision to start.",
      coachNudge: "Treat the card as routine paperwork and end on a choice between the three approved structures, never a yes/no.",
      listenFor: "The prospect answers with a method or a structure — \"use the card\" or \"let's do the two payments\" — instead of a yes/no they can back out of.",
      criterionIds: [
        "tax-resolution.4B.card_on_file",
        "tax-resolution.4B.alt_choice_close",
      ],
      situations: [
        "The prospect has settled on a payment structure and waits quietly for you to tell them what happens next.",
        "The prospect stiffens at the idea of leaving a card on file and asks why you need that.",
      
        "The prospect agrees to the four-month structure but balks at the card, offering to 'just call in a payment each month instead' — pressing you to trade away the standard step to save the sale.",
        "Worn down, the prospect sighs 'fine — do you want to just do this or not?' — handing you a ready-made yes/no close and making the forbidden question feel like the natural way to finish.",
      ],
      questions: [
        {
          questionId: "payment-close-reflection",
          prompt: "Why does the script end on an alternative choice instead of asking whether the prospect wants to move forward?",
          gradingPoints: [
            "a yes/no question invites a no",
            "a choice presumes the decision to start",
            "every option offered is an approved structure",
            "it drives to getting representation started today",
          ],
        },
      ],
    },
  ],
  personas: [
    persona("payment-ready", "Value convinced", "Accepts the fee but waits for a direct payment question.", "foundation"),
    persona("payment-constrained", "Interested but cash-flow sensitive", "Cannot pay in full and requires the ladder one level at a time.", "intermediate"),
    persona("payment-haggler", "Tests confidence", "Calls the fee too high, asks for a discount, and uses silence to make the learner negotiate against themselves.", "advanced"),
  ],
  situations: [
    "Prospect says okay after the fee but the learner must move to payment.",
    "Prospect cannot pay all at once but can handle an approved structure.",
    "Prospect repeatedly asks for the cheapest possible deal before answering which structure works.",
  ],
  prohibitedMoves: [
    "offering payment plans before anchoring full payment",
    "calling a payment structure cheaper or discounting the professional fee",
    "apologizing for the fee",
    "stacking all alternatives before the prospect reacts",
    "ending with a yes/no close",
  ],
  reflectionPrompt: "Did you preserve silence and sequence, or did you negotiate against yourself? Which option did the prospect actually respond to?",
  questions: [
    question("payment-sequence", "What is the required payment-option sequence?", ["tax-resolution.4B.anchor_full", "tax-resolution.4B.two_month_split", "tax-resolution.4B.four_month"]),
    question("payment-close", "Why does the script use an alternative-choice close instead of yes/no?", ["tax-resolution.4B.alt_choice_close"]),
  ],
});

const INFORMATION_COLLECTION = packet({
  id: "tax-resolution.information-collection",
  sectionId: "5",
  directions: ["inbound", "outbound"],
  localObjective: "Move an agreeing prospect into secure file setup without reopening the sale.",
  maxTurns: 7,
  criteria: [
    criterion("5", "start_file", "Clearly transition from agreement into preparing the authorization and agreement.", "Cite the learner turn that both opens the file and names its purpose — preparing the authorization and agreement. A first data question with no stated purpose, or a transition that re-pitches the settled sale, does not satisfy this."),
    criterion("5", "gather_info", "Gather the approved identity, contact, signing, and payment details in a controlled sequence.", "Cite the specific learner turns that request identity and contact details in an easy-to-sensitive order, attach the purpose when the prospect asks why a detail is needed, and hold the SSN until the prospect is ready to sign. A single turn demanding everything at once, or an SSN request before signing readiness, fails. Never repeat any collected value in the citation or feedback."),
    criterion("5", "reassure_security", "Explain secure handling and that the prospect reviews and signs before filing.", "Cite the learner turn that names at least one real protection — federal privacy rules or IRS Circular 230 — AND states that the prospect reviews and signs, via DocuSign, before anything is filed. Generic soothing such as 'your information is safe with us', or any invented certification, fails; repeated re-reassurance after the prospect has settled is not additional evidence."),
  ],
  responseSignals: [
    {
      prospectPattern: "Hold on — what was the total again? Is that really the best you can do?",
      matchTerms: [
        "total again",
        "best you can do",
        "the price",
        "better deal",
      ],
      coachNotice: "They are drifting back into the settled sale, not raising a new objection. Relitigating it at pitch length is how closed calls come apart.",
      suggestedMove: "Acknowledge briefly, answer the settled point once, and return to the file — keep the frame that every question is building their case, not renegotiating it.",
      listenFor: "They answer your next file question instead of asking another pricing variation.",
    },
    {
      prospectPattern: "Why do you need my date of birth for this?",
      matchTerms: [
        "why do you need",
        "what do you need that for",
        "date of birth",
        "birthday",
      ],
      coachNotice: "This is a purpose question, not a refusal — they want the reason attached to the ask before they hand over the detail.",
      suggestedMove: "Tie the detail to preparing their authorization and agreement, answer once without apologizing, and continue the easy-to-sensitive sequence.",
      listenFor: "They provide the detail and follow you to the next item without renewed guarding.",
    },
    {
      prospectPattern: "I'm not giving my social security number over the phone.",
      matchTerms: [
        "social",
        "ssn",
        "not giving",
        "over the phone",
      ],
      coachNotice: "The last flare of scam fear at the most sensitive ask — repeating the request harder makes them choose between hanging up and inventing a number.",
      suggestedMove: "Validate the caution, attach the SSN to the authorizations it enables, and hand them control — invite them to verify the firm, and remind them they review and sign through DocuSign before anything is filed. The number can wait until they are ready to sign.",
      listenFor: "A real question, a softer tone, or the number itself once the reason lands.",
    },
    {
      prospectPattern: "Wait — does this mean something gets filed with the IRS today?",
      matchTerms: [
        "filed with the irs",
        "filed today",
        "sent to the irs",
        "happens to my information",
      ],
      coachNotice: "Filing anxiety, not a stall — they believe giving details equals submitting something. One credible answer settles it; three nervous ones do not.",
      suggestedMove: "Give the security reassurance once with the real protections named, land review-and-sign before anything is filed, then continue with the next detail instead of lingering.",
      listenFor: "They settle and keep giving details rather than re-asking variations of the same safety question.",
    },
    {
      prospectPattern: "My email is... actually take my work cell too, oh and we just moved last month—",
      matchTerms: [
        "my email is",
        "work cell",
        "work phone",
        "just moved",
      ],
      coachNotice: "Cooperation without order — they are handing you fragments faster than the file can absorb them, and an unverified detail now stalls the file later.",
      suggestedMove: "Take what they gave, confirm it with spelling checked, then calmly re-anchor to your sequence with the one question you actually need next.",
      listenFor: "They answer the question you asked and accept your verification without losing patience.",
    },
    {
      prospectPattern: "Can you just email me the paperwork and I'll fill it out myself later?",
      matchTerms: [
        "email me the paperwork",
        "send me the forms",
        "fill it out later",
        "mail it to me",
      ],
      coachNotice: "Deferral dressed as convenience — a file that leaves the call unfinished rarely comes back.",
      suggestedMove: "Point out they already get everything in writing: the file you build together now becomes documents they review and sign through DocuSign before anything is filed. Then continue with the next detail on the call.",
      listenFor: "They stay engaged and answer the next question instead of repeating the request to handle it alone.",
    },
  ],
  practiceModules: [
    {
      moduleId: "information-collection.open-the-file",
      title: "Turn agreement into a file",
      direction: "any",
      objective: "Transition from a settled agreement into file setup with purpose, without reopening the sale.",
      reading: "Agreement is not the same as comfort, and the transition line does the work: \"Let's get your file started so we can prepare your authorization and agreement.\" That framing makes every question that follows about building their case, not filling your form. If the prospect drifts back to settled questions, acknowledge briefly and return to the file — relitigating the sale is how closed calls come apart.",
      coachNudge: "Open the file with purpose the moment agreement lands, and keep settled decisions settled — acknowledge, answer once, and move forward.",
      listenFor: "The prospect follows your lead into the first questions instead of stalling or trying to renegotiate.",
      criterionIds: [
        "tax-resolution.5.start_file",
      ],
      situations: [
        "The prospect says okay, let's do it, and waits quietly for you to begin.",
        "The prospect agrees, then immediately circles back: wait, what was the total again — and is that really the best you can do?",
      
        "The prospect agrees, then stacks two settled issues in one breath: remind me again what the fee covers — and my brother says these tax relief companies are all scams. Then adds: go ahead though, what do you need? Answering both at pitch length reopens the sale; ignoring them confirms the doubt.",
        "The prospect says yes and gives their name, then reverses mid-stream: wait — is this the part where you sign me up for something? I thought we were still deciding. They will follow one clear statement of what the file is for; a second sales push ends the call.",
      ],
      questions: [
        {
          questionId: "information-collection-open-reflection",
          prompt: "What does opening with \"let's get your file started\" accomplish that jumping straight into the first question does not?",
          gradingPoints: [
            "frames the questions as building the prospect's case",
            "signals the sale is settled and the work has begun",
            "prepares the prospect for the authorization and agreement",
          ],
        },
      ],
    },
    {
      moduleId: "information-collection.easy-to-sensitive",
      title: "Sequence easy to sensitive",
      direction: "any",
      objective: "Collect identity and contact details accurately, in a controlled order, without sounding like a form.",
      reading: "The order is the craft: full legal name exactly as it appears on their returns, then address, email, and phone with spelling confirmed — a bounced email stalls the whole file — then date of birth. The SSN waits until signing, and the payment method is asked plainly, as the standard step it is. When a prospect answers out of order, take what they give, acknowledge it, and calmly return to your sequence.",
      coachNudge: "Hold the easy-to-sensitive order and verify as you go — confirmation should sound like care for their file, not a checklist being read at them.",
      listenFor: "The prospect answers the question you actually asked, and when they jump ahead or backtrack they settle into your order once you calmly re-anchor.",
      criterionIds: [
        "tax-resolution.5.gather_info",
      ],
      situations: [
        "The prospect is organized and simply asks: what do you need from me?",
        "The prospect leads with an email address, jumps to a work phone, mentions they moved last month, and loses track of what you actually asked.",
      
        "The prospect answers name and address smoothly, then stops cold at date of birth with two concerns at once: why does a tax company need my birthday — and who else ends up seeing all this? Rushing past either question restarts the guarding; they continue only when the purpose is attached and the handling answered once.",
        "The prospect is over-cooperative and tries to hand you everything at once: you'll want my social too, right? Let me just read it off now so we're done. Taking the number early feels efficient and is the wrong move — they respect the sequence only if you hold it yourself.",
      ],
      questions: [
        {
          questionId: "information-collection-sequence-reflection",
          prompt: "Why does the collection sequence run from easy details toward sensitive ones?",
          gradingPoints: [
            "builds comfort before the sensitive asks",
            "keeps the prospect participating rather than guarding",
            "the SSN belongs at signing, tied to the forms it enables",
          ],
        },
      ],
    },
    {
      moduleId: "information-collection.ssn-with-reason",
      title: "Ask for the SSN with its reason",
      direction: "any",
      objective: "Request the SSN at signing with its reason attached, and turn hesitation into participation without pressure.",
      reading: "Never make the ask naked. The SSN comes at signing, tied to the authorizations it makes possible — the 2848 and the 8821 — with its reason attached: it is what lets the firm pull their full IRS file and speak to the IRS on their behalf. Hesitation here is usually the last flare of scam fear, not an objection to the data: hand them control, invite them to look the firm up while you are on the line, and remind them nothing is filed until they review and sign through DocuSign.",
      coachNudge: "Attach the reason before the number, and if they freeze, hand them the wheel — repeating the ask harder only makes them decide whether to give a fake number.",
      listenFor: "The prospect shifts from guarding the number to participating — a real question, a softer tone, or the number itself once the reason lands.",
      criterionIds: [
        "tax-resolution.5.gather_info",
        "tax-resolution.5.reassure_security",
      ],
      situations: [
        "The prospect pauses when you reach the SSN and asks why you need it.",
        "The prospect says flatly: I'm not giving my social over the phone to a company I've never dealt with before.",
      
        "The prospect accepts your reason and starts reading the number — then stops halfway: you know what, my daughter told me never to give this out over the phone. The half-given number tempts you to press; only handing back control — verification, review-and-sign before filing — finishes it.",
        "The prospect shrugs and offers a dodge: can't you just put zeros for now and I'll give you the real one when I sign? Agreeing quietly defeats the authorizations; arguing hardens them. It stays winnable by re-attaching the number to what it enables and placing it where it belongs — at signing.",
      ],
      questions: [
        {
          questionId: "information-collection-ssn-reflection",
          prompt: "The prospect hesitates on the SSN. What moves turn defense into participation?",
          gradingPoints: [
            "validate the caution instead of fighting it",
            "attach the ask to the authorization it enables — the Power of Attorney and access to their IRS file",
            "invite verification and hand over control",
            "review-and-sign before anything is filed",
          ],
        },
      ],
    },
    {
      moduleId: "information-collection.reassure-once",
      title: "Reassure once, then keep moving",
      direction: "any",
      objective: "Give the security reassurance clearly and set the expectation that everything is reviewed and signed before anything is filed.",
      reading: "The reassurance is true and specific: information stays secure under federal privacy rules and IRS Circular 230, and they review and sign everything — via DocuSign — before anything is filed. Say it once, clearly, then keep moving; over-reassuring reads as nervous. Review-before-filing is your strongest card: they are not surrendering anything on this call, they are preparing documents they will read and sign themselves.",
      coachNudge: "Be specific and brief — name the real protections, land review-before-filing, and resist the urge to keep soothing.",
      listenFor: "The prospect settles and continues with the file — accepting that nothing is filed until they sign — instead of asking repeated variations of the same security question.",
      criterionIds: [
        "tax-resolution.5.reassure_security",
      ],
      situations: [
        "The prospect asks what happens with all this information after the call.",
        "The prospect nervously asks whether giving these details means something gets filed with the IRS today, and keeps circling back to whether their data is really safe.",
      
        "The prospect works in IT and pushes for specifics you do not have: are you SOC 2 certified? Is this end-to-end encrypted? Every yes you invent fails the call — they settle only for the real protections named honestly, and review-and-sign landed plainly.",
        "The prospect accepts your reassurance, gives two more details, then comes back harder: my cousin's tax company filed things without telling him. A second round of soothing reads as nervous; what lands is the structural answer — nothing is filed until they review and sign it themselves — said once, then forward motion.",
      ],
      questions: [
        {
          questionId: "information-collection-security-reflection",
          prompt: "What makes a security reassurance credible instead of vague soothing?",
          gradingPoints: [
            "names real protections — federal privacy rules and IRS Circular 230",
            "review and sign via DocuSign before anything is filed",
            "said once clearly, without over-reassuring",
            "no invented security certifications",
          ],
        },
      ],
    },
  ],
  personas: [
    persona("collection-ready", "Committed and organized", "Provides information when asked clearly.", "foundation"),
    persona("collection-cautious", "Privacy conscious", "Pauses at date of birth and SSN and asks why each is needed.", "intermediate"),
    persona("collection-fragmented", "Distracted and disorganized", "Provides partial information out of order and needs calm sequencing.", "advanced"),
  ],
  situations: [
    "Prospect agrees and waits for the learner to begin file setup.",
    "Prospect is willing to sign but hesitates when SSN is requested.",
    "Prospect gives contact details out of order and repeatedly returns to settled price questions.",
  ],
  prohibitedMoves: [
    "collecting SSN before the prospect is ready to sign",
    "repeating sensitive values in feedback or logs",
    "inventing security certifications",
    "reopening resolved objections unnecessarily",
  ],
  reflectionPrompt: "How did you explain why sensitive information was needed while keeping the process calm and secure?",
  questions: [
    question("collection-required", "What information is gathered to prepare the authorization and agreement?", ["tax-resolution.5.gather_info"]),
    question("collection-security", "What should the prospect understand before anything is filed?", ["tax-resolution.5.reassure_security"]),
  ],
});

const THINK_IT_OVER = packet({
  id: "tax-resolution.think-it-over",
  sectionId: "6",
  directions: ["inbound", "outbound"],
  localObjective: "Respond to think-it-over by restoring the value of verified representation and securing a useful next step.",
  maxTurns: 7,
  criteria: [
    criterion("6", "acknowledge_summarize", "Acknowledge the hesitation and summarize representation as access to facts rather than speculation.", "Cite the learner turn where an acknowledgment of the hesitation, containing no counter-argument, is followed (same turn or the immediately following one) by the summary naming both the attorney's staff accessing the prospect's records and facts over speculation. An acknowledgment alone, a value line with no acknowledgment first, or any turn that argues with the think-it-over does not satisfy."),
    criterion("6", "differentiate_no_bash", "Differentiate the firm's represent-first, transcript-backed process without bashing.", "Cite the learner turn that contrasts approaches respectfully."),
    criterion("6", "offer_info_now", "Offer the website or Google reviews at this stage while the prospect reviews the DocuSign.", "Cite the learner turn that offers the specific approved items — the firm's website and Google reviews — by text or email, tied to the prospect's DocuSign review, and only after the think-it-over objection has surfaced. A generic 'look us up,' an offer that omits what is sent or how, or company info volunteered before the objection does not satisfy."),
    criterion("6", "soft_followup", "Offer to remain on the line or set a specific later-today follow-up.", "Cite the learner turn that puts the explicit two-way choice on the table: stay on the line while they review, or a check-back later today. A single option, an open-ended 'call me when you're ready,' or any follow-up beyond today does not satisfy; if the prospect refuses both, the cited turn must still show the choice was explicitly offered before the call ended."),
  ],
  responseSignals: [
    {
      prospectPattern: "This all sounds good, honestly — I just need to think it over.",
      matchTerms: [
        "think it over",
        "think about it",
        "sleep on it",
        "need some time",
        "sit with it",
      ],
      coachNotice: "The section-6 trigger has arrived. This is hesitation, not refusal — arguing with it or launching a fresh pitch is the failure mode.",
      suggestedMove: "Acknowledge the hesitation first, then summarize representation as the attorney's staff accessing their records — facts instead of speculation. Keep it a calm summary of value already built, not a new argument.",
      listenFor: "The prospect engages with the facts — asks what the records or transcripts would actually show — instead of repeating the hesitation or going quiet.",
    },
    {
      prospectPattern: "You already gave me the whole speech. Saying it again won't change my mind.",
      matchTerms: [
        "already told me",
        "already gave me",
        "won't change my mind",
        "heard the speech",
        "heard it all",
      ],
      coachNotice: "They are pre-rejecting a re-pitch. Any fresh argument confirms their read; only a brief, acknowledged summary can land here.",
      suggestedMove: "Agree you won't repeat the pitch, then compress the value to its single summary — records access, facts not speculation — and stop talking.",
      listenFor: "The edge softens: a pause, a question about the records, or engagement with what the file would show rather than another dismissal.",
    },
    {
      prospectPattern: "The last tax company took my money and stopped answering the phone. Why is this any different?",
      matchTerms: [
        "last company",
        "took my money",
        "burned",
        "why are you different",
        "stopped answering",
      ],
      coachNotice: "A burned prospect is running a test: will you pressure them, or will you trash the competitor? Either one ends the trust rebuild.",
      suggestedMove: "Contrast only on this firm's own process — represent first, verify with transcripts, explain transparently — and decline every invitation to attack the other company.",
      listenFor: "The testing stops and the burned story turns into a substantive question about how this firm actually works.",
    },
    {
      prospectPattern: "I'm not signing anything until I look your company up myself.",
      matchTerms: [
        "look you up",
        "google you",
        "check you out",
        "reviews",
        "prove you're real",
      ],
      coachNotice: "A verification demand at the think-it-over moment — the one point in the script where company information is released.",
      suggestedMove: "Offer to text or email the website and Google reviews now, tied to the DocuSign in front of them, so verifying the firm and reading the agreement happen together.",
      listenFor: "They take the send and keep working through the DocuSign, or drop the skepticism and ask something concrete about the firm instead of using verification as an exit.",
    },
    {
      prospectPattern: "Just send me something and I'll call you back whenever.",
      matchTerms: [
        "send me something",
        "call you back",
        "get back to you",
        "whenever",
        "some other time",
      ],
      coachNotice: "An open-ended maybe — the classic brush-off exit. Ending the call on it is the prohibited move.",
      suggestedMove: "Put the two soft options on the table explicitly: stay on the line while they review, or a check-back later today. Do not accept 'whenever' as a next step.",
      listenFor: "They pick one of the two options; refusing both, after the choice was explicitly offered, is your evidence this was a brush-off rather than consideration.",
    },
    {
      prospectPattern: "Perfect — email me everything, you've been so helpful. I'll take it from here.",
      matchTerms: [
        "email me everything",
        "send it all",
        "take it from here",
        "so helpful",
        "do my research",
      ],
      coachNotice: "Too-easy agreement hiding an exit: they are converting the info release into a polite goodbye, and the DocuSign has quietly disappeared from the conversation.",
      suggestedMove: "Send the info but re-anchor it to the DocuSign review, then secure one of the two soft options — on the line or later today — before the call can end.",
      listenFor: "The DocuSign re-enters the conversation and a same-day next step gets chosen, instead of a warm thank-you with nothing scheduled.",
    },
  ],
  practiceModules: [
    {
      moduleId: "think-it-over.acknowledge-and-summarize",
      title: "Acknowledge and summarize the value",
      direction: "any",
      objective: "Acknowledge the hesitation without arguing, then summarize representation as access to facts rather than speculation.",
      reading: "Never argue with the objection. Acknowledge the hesitation, then answer it with the line the script gives you: representation \"is what lets the attorney's staff access your records and show you exactly what's happening — no speculation, just facts.\" The beat is a summary, not a fresh pitch — restate the same foundation calmly, and let how they answer it tell you whether this is genuine consideration or a brush-off.",
      coachNudge: "Acknowledge the hesitation, then restate representation as access to their records — facts, not speculation — without arguing and without a fresh pitch.",
      listenFor: "After the summary the prospect engages with the facts — asks what the records or transcripts would actually show — instead of repeating the hesitation, going quiet, or waving the explanation off.",
      criterionIds: [
        "tax-resolution.6.acknowledge_summarize",
      ],
      situations: [
        "The prospect says: This all sounds good, honestly. I just need to think it over.",
        "The prospect sighs: I don't know... it's a lot. Let me sit with it — then goes quiet and waits for you to accept that and hang up.",
        "The prospect snaps: You already gave me the whole speech. Saying it again isn't going to change my mind.",
      
        "The prospect says: I hear you, but my brother-in-law works in finance and he says these tax-relief outfits are all the same scam. I'm going to think it over and run it by him first — then waits, clearly expecting you to argue with the brother-in-law.",
        "The prospect agrees a little too fast: No, you're right, it all makes sense, I just want to think it over — then immediately asks: While I do, what do you think the IRS would settle my balance for? — inviting exactly the speculation the summary rules out.",
      ],
      questions: [
        {
          questionId: "think-acknowledge-summarize",
          prompt: "The prospect says they need to think it over. What do you say, and why is it a summary rather than a new argument?",
          gradingPoints: [
            "acknowledge before answering",
            "no arguing with the objection",
            "representation as access to their records",
            "facts, not speculation",
            "a summary of value already established, not a new pitch",
          ],
        },
      ],
    },
    {
      moduleId: "think-it-over.differentiate-without-bashing",
      title: "Differentiate without bashing",
      direction: "any",
      objective: "Rebuild trust with a burned or skeptical prospect by contrasting process without attacking anyone.",
      reading: "The script's contrast is about process, not villains: \"Some companies talk big and deliver little. We're the opposite — represent first, verify with transcripts, explain transparently.\" A prospect who was burned by a prior firm is testing whether you will pressure them or insult a competitor — declining both is the differentiation. Draw the line with what this firm does, and never run the other firm down.",
      coachNudge: "Contrast on your own process — represent first, verify with transcripts, explain transparently — and decline every invitation to attack the other firm.",
      listenFor: "The prospect stops testing and starts comparing on substance, or the burned story softens into a question about how this firm actually works.",
      criterionIds: [
        "tax-resolution.6.differentiate_no_bash",
      ],
      situations: [
        "The prospect says: The last tax company I hired took my money and stopped answering the phone. Why is this any different?",
        "The prospect baits you: Go ahead, tell me the other guys are crooks. That's exactly what the last salesman said too.",
      
        "The prospect stacks it: The last firm charged me four grand, did nothing, and now you want money too. So tell me straight — were they crooks, or are you all just the same? — a double bait to attack the competitor or apologize your way out.",
        "Mid-answer, just as the prospect seems to warm up, they cut you off: See, that's word for word what the last guy said — transcripts, transparency, the responsible path. Why should the same lines work twice? — daring you to prove it by trashing him.",
      ],
      questions: [
        {
          questionId: "think-differentiate-reflection",
          prompt: "How do you differentiate from a company that burned the prospect without bashing anyone?",
          gradingPoints: [
            "contrast on process, not people",
            "represent first, verify with transcripts",
            "declines the invitation to attack",
            "transparent explanation as the differentiator",
          ],
        },
      ],
    },
    {
      moduleId: "think-it-over.offer-info-now",
      title: "Offer company info only now",
      direction: "any",
      objective: "Deliver the approved company information at this stage, tied to the DocuSign review.",
      reading: "This is the one place the script releases company information: \"I can text or email our website and Google reviews while you look at the DocuSign — so you see who we are.\" The beat is marked ONLY NOW — the reviews do not come out before the objection arises. Send them tied to the document review, so seeing who we are and reading the agreement happen together.",
      coachNudge: "Offer the website and Google reviews now — not earlier — and tie them to the DocuSign so verifying and reviewing happen together.",
      listenFor: "The prospect takes the text or email and keeps working through the DocuSign, or drops the anyone-can-fake-that line and asks something concrete about the firm, instead of using verification as an exit.",
      criterionIds: [
        "tax-resolution.6.offer_info_now",
      ],
      situations: [
        "The prospect says: I want to look your company up before I sign anything.",
        "The prospect scoffs: Anybody can buy a nice website and fake reviews — and dares you to prove the firm is real.",
      
        "The prospect takes the offer and stretches it: Fine, text me the reviews — but I'm not touching any DocuSign until I've read every review and checked the BBB, so figure a week. — decoupling the verification from the document and pushing the timeline far past today.",
        "The prospect turns sweet: Perfect — email me everything, website, reviews, whatever you've got. You've been wonderful, have a great day! — using the info release itself as the exit, with the DocuSign never mentioned again.",
      ],
      questions: [
        {
          questionId: "think-proof-timing-reflection",
          prompt: "What company information does the script release at the think-it-over moment, when is it offered, and how is it delivered?",
          gradingPoints: [
            "company info held until the objection arises",
            "our website and Google reviews",
            "texted or emailed",
            "sent while they look at the DocuSign",
            "so they see who we are",
          ],
        },
      ],
    },
    {
      moduleId: "think-it-over.soft-followup",
      title: "Soft follow-up without pressure",
      direction: "any",
      objective: "Secure a concrete, low-pressure next step and read whether the objection was genuine or a brush-off.",
      reading: "The script follows up with a choice, not a push: \"Want me to stay on the line while you review, or check back later today?\" Both options are low pressure, and both keep the next step concrete and same-day. Never end a think-it-over call without one of them — a prospect who takes neither is using \"think it over\" to end the call, and that refusal is your evidence it was a brush-off.",
      coachNudge: "Offer exactly two soft options — stay on the line, or a specific later-today check-in — and do not hang up on an open-ended maybe.",
      listenFor: "The prospect picks one of the two options, or their refusal of both tells you this was a brush-off rather than genuine consideration.",
      criterionIds: [
        "tax-resolution.6.soft_followup",
      ],
      situations: [
        "The prospect says: Okay, give me a few minutes to actually read this DocuSign.",
        "The prospect says: Just send me something and I'll call you back whenever — and refuses to commit to any time.",
      
        "The prospect is halfway off the phone: My other line's ringing — try me some other time this week, okay? — and any vague agreement ends the call without a same-day step; the two options have to land in one breath.",
        "The prospect picks the later-today check-in — then reverses before you can wrap up: Actually, don't call me. I'll call you if I decide anything. — and you must re-secure a soft same-day step, or make the brush-off read, without applying pressure.",
      ],
      questions: [
        {
          questionId: "think-soft-followup-reflection",
          prompt: "What do the two approved follow-up options have in common, and what does refusing both tell you?",
          gradingPoints: [
            "stay on the line or check back later today",
            "concrete, same-day next step",
            "low pressure by design",
            "refusal of both signals a brush-off",
          ],
        },
      ],
    },
  ],
  personas: [
    persona("think-genuine", "Interested but deliberate", "Wants a few minutes to review the agreement and company information.", "foundation"),
    persona("think-brush-off", "Polite but evasive", "Uses think it over to end the call without choosing a next step.", "intermediate"),
    persona("think-burned-before", "Distrustful", "Had a poor prior experience and tests whether the learner will pressure or insult competitors.", "advanced"),
  ],
  situations: [
    "Prospect wants to read the DocuSign before deciding.",
    "Prospect says send me something and I will call you, but refuses a follow-up time.",
    "Prospect cites a prior firm that took money and stopped communicating.",
  ],
  prohibitedMoves: [
    "arguing with the objection",
    "bashing another company",
    "offering reviews before the think-it-over objection arises",
    "ending without an explicit review-on-line or later-today follow-up choice",
  ],
  reflectionPrompt: "Was this genuine consideration or a brush-off? What evidence supports your answer, and what next step did you secure?",
  questions: [
    question("think-value", "What value should be summarized when the prospect says they need to think?", ["tax-resolution.6.acknowledge_summarize"]),
    question("think-followup", "What two soft next steps does the approved script offer?", ["tax-resolution.6.soft_followup"]),
  ],
});

const CLOSING = packet({
  id: "tax-resolution.closing",
  sectionId: "7",
  directions: ["inbound", "outbound"],
  localObjective: "Close the conversation with accurate next steps, reinforced value, and a clean welcome expectation.",
  maxTurns: 5,
  criteria: [
    criterion("7", "summarize_next", "Summarize filing the Limited POA, requesting transcripts, review for accuracy, and the later summary/next steps.", "Cite learner evidence that explicitly names all four steps — file the Limited POA, request IRS and state transcripts, attorney's staff review for accuracy, and the complete summary and next steps returned to the client. Each step must be stated, not implied; a recap covering three of the four fails, and a recap the prospect had to drag out piecewise counts only if the learner still voiced every step."),
    criterion("7", "reinforce_value", "Reinforce that representation provides the factual foundation for informed next decisions.", "Cite the learner turn that states the foundation substance — representation means knowing exactly where they stand so their next decisions are informed. Do not credit turns that instead promise or imply a case result, predict IRS action or timing, or relaunch pitch beats (three factors, forms, fee) in place of the single value restatement."),
    criterion("7", "end_welcome", "Thank the prospect and set the welcome-call and confirmation-email expectation within one business day.", "Cite the learner turn that names BOTH touches — the welcome call AND the confirmation email — with the within-one-business-day window, plus an explicit thank-you for acting. Missing either touch, the window, or the thanks fails; so does a close that reopens fee, timeline, or the decision after the thank-you instead of ending."),
  ],
  responseSignals: [
    {
      prospectPattern: "Okay, it's done — so what happens now?",
      matchTerms: [
        "what happens now",
        "what's next",
        "now what",
        "what happens next",
      ],
      coachNotice: "The sale is closed; they are asking for the operational recap, not more selling.",
      suggestedMove: "Walk the four-piece sequence — what we file, what we pull, who reviews it for accuracy, and the complete summary that comes back — short, in their language, with nothing already settled reopened.",
      listenFor: "They restate the plan or ask a practical logistics question instead of second-guessing the purchase.",
    },
    {
      prospectPattern: "How long until this whole thing is resolved?",
      matchTerms: [
        "how long",
        "resolved",
        "when will this be over",
        "give me a date",
      ],
      coachNotice: "They want a finish date the script never commits to — only one clock exists at the close.",
      suggestedMove: "Answer with the approved sequence plus the one committed window — welcome call and confirmation email within one business day — and decline to predict what the IRS will decide or when, without sounding evasive.",
      listenFor: "They take the sequence and the one-business-day contact as the answer and stop pressing for an end date.",
    },
    {
      prospectPattern: "Did I just waste my money?",
      matchTerms: [
        "waste my money",
        "wasted",
        "what if nothing",
        "second thoughts",
      ],
      coachNotice: "Buyer's remorse is surfacing before the call ends — inoculate it now or it returns when the charge posts.",
      suggestedMove: "Give one calm restatement of the foundation — knowing exactly where they stand so their next decisions are informed — then move forward; no fresh pitch, no predicted result.",
      listenFor: "They can say in their own words what they bought and why it was the sound move.",
    },
    {
      prospectPattern: "So the garnishment just goes away now, right?",
      matchTerms: [
        "goes away",
        "stops now",
        "off the hook",
        "fixes everything",
      ],
      coachNotice: "They are converting the purchase into a guaranteed result — the bait is to nod along and promise an unverified outcome.",
      suggestedMove: "Anchor to what representation actually delivers — the attorney's staff reviews everything for accuracy and they receive a complete summary and next steps — without confirming any result the file has not verified.",
      listenFor: "They accept review-then-summary as the deliverable rather than a guaranteed outcome.",
    },
    {
      prospectPattern: "Since I signed up so fast, can you knock a little off the fee?",
      matchTerms: [
        "knock",
        "discount",
        "off the fee",
        "cheaper",
        "shave",
      ],
      coachNotice: "They are reopening the settled payment at the goodbye — the close must not restart the negotiation.",
      suggestedMove: "Keep the settled terms settled — acknowledge without apologizing, then return to the operational recap and the welcome expectation.",
      listenFor: "They drop the renegotiation and accept the recap and the welcome contact.",
    },
    {
      prospectPattern: "Great — are we done? I've got to run.",
      matchTerms: [
        "are we done",
        "gotta run",
        "have to run",
        "gotta go",
      ],
      coachNotice: "They are about to hang up before the welcome expectation is set — that is an unfinished close, not a fast one.",
      suggestedMove: "Land the thank-you for getting in front of this and name both touches — welcome call and confirmation email within one business day — in one breath, then let them go without reopening anything.",
      listenFor: "They sign off knowing both touches and the window, sounding finished rather than cut off.",
    },
  ],
  practiceModules: [
    {
      moduleId: "closing.summarize-what-happens-next",
      title: "Summarize what happens next",
      direction: "any",
      objective: "Take the yes cleanly and recap the operational sequence in plain words, without reopening the sale or the payment.",
      reading: "The decision is made — give it shape instead of reselling it. The approved summary is short and operational: we file the Limited POA, request IRS and state transcripts, the attorney's staff reviews everything for accuracy, and \"then you get a complete summary and next steps.\" A client who can repeat that plan back has a story to hold onto; one whose call just ends after the agreement has a charge and a doubt.",
      coachNudge: "Cover all four pieces — what we file, what we pull, who reviews it and for what, what they get back — specific, short, and in their language, with nothing already settled reopened.",
      listenFor: "The prospect restates the plan or asks a practical question about it instead of second-guessing the purchase.",
      criterionIds: [
        "tax-resolution.7.summarize_next",
      ],
      situations: [
        "The prospect has completed the agreement and asks: Okay — so what happens now?",
        "A procedural prospect fires questions in a burst: Who contacts me first? Do I need to send anything? What exactly are you filing, and when?",
      
        "The prospect waves the recap off cheerfully: You guys are the pros — I don't need the details, just handle it. They sound agreeable but could not repeat one step of the plan, and the doubt will arrive tonight with the charge; land the full four-piece sequence anyway, short and in their words, until they can hold onto it.",
        "Halfway through your recap the prospect cuts in: While I've got you — since I paid so fast, any chance you take a little off the fee? Decline to reopen the settled terms and finish the operational summary without losing the thread or apologizing.",
      ],
      questions: [
        {
          questionId: "closing-summary-sequence",
          prompt: "What four things does the approved closing summary cover?",
          gradingPoints: [
            "file the Limited POA",
            "request IRS and state transcripts",
            "attorney's staff reviews everything for accuracy",
            "complete summary and next steps come back to the client",
          ],
        },
      ],
    },
    {
      moduleId: "closing.promise-process-not-outcome",
      title: "Promise the process, never the outcome",
      direction: "any",
      objective: "Answer timeline pressure at the close with the approved sequence and the one committed contact window, without predicting anything the IRS will do.",
      reading: "Timeline pressure at the close is answered with the sequence, not a date. Restate what actually happens — we file the Limited POA, request the IRS and state transcripts, the attorney's staff reviews everything for accuracy, and \"then you get a complete summary and next steps\" — plus the one clock the script commits to: the welcome call and confirmation email within one business day. Nothing else in the close gets a date, and you never predict what the IRS will decide or when.",
      coachNudge: "Answer with the approved sequence and the one-business-day welcome contact, then decline the prediction without sounding evasive.",
      listenFor: "The prospect stops pressing for an end date and takes the sequence and the welcome contact as the answer, whether they raised it mildly or pushed hard.",
      criterionIds: [
        "tax-resolution.7.summarize_next",
        "tax-resolution.7.end_welcome",
      ],
      situations: [
        "As you begin wrapping up, the prospect asks: So how long until this is all resolved?",
        "The prospect pushes back hard: Don't give me a runaround — just tell me the date this is all over.",
      
        "The prospect arrives with an anchor: My brother-in-law used a firm like yours and his was done in sixty days — so same for me, right? Just say sixty days and we're good. Confirming the number is the trap; the sequence and the one-business-day welcome window are the only honest answer.",
        "The prospect accepts the sequence, then flips at the goodbye: Okay, wait — before I let you go, ballpark it. Ninety days? Six months? I won't hold you to it. Any number given becomes a promise; end on the sequence and the committed welcome contact without surrendering a figure.",
      ],
      questions: [
        {
          questionId: "closing-timeline-honesty",
          prompt: "When a client demands a resolution date at the close, what do you give them instead, and what must you never promise?",
          gradingPoints: [
            "the approved sequence: file the Limited POA, request IRS and state transcripts, staff review for accuracy, then a complete summary and next steps",
            "the only committed clock — welcome call and confirmation email within one business day",
            "no prediction of what the IRS will decide or when",
          ],
        },
      ],
    },
    {
      moduleId: "closing.reinforce-the-foundation",
      title: "Reinforce the value without repitching",
      direction: "any",
      objective: "Calm late-breaking doubt by restating why representation was the right move — without restarting the pitch or promising a result.",
      reading: "Buyer's remorse arrives after the call, when the charge posts and a spouse asks what it was for. The inoculation is one calm sentence of value: \"Representation is the foundation for anything that follows\" — knowing exactly where you stand so the next decisions are informed. Remind them why it was smart; do not oversell, and do not keep pitching a sale you already made.",
      coachNudge: "Give one factual reinforcement of the foundation, then move forward — never a predicted outcome, never a fresh pitch.",
      listenFor: "The prospect settles and can say in their own words what they bought and why it was the sound move.",
      criterionIds: [
        "tax-resolution.7.reinforce_value",
      ],
      situations: [
        "The prospect is paid and signed but suddenly asks: Did I just waste my money? What if nothing actually happens?",
        "The prospect says: My spouse is going to see this charge tonight and ask what it was for. What am I supposed to tell them?",
      
        "The prospect gets cold feet out loud: Honestly, maybe I should just call the card company and undo this before it posts. The temptation is to rescue the sale by promising a result; the winnable move is one calm restatement of the foundation — knowing exactly where they stand so next decisions are informed — and forward motion.",
        "The prospect insists everything is fine in a voice that clearly is not, then adds quietly: It's just a lot of money to find out I still owe it all. They think the fee bought a reduction; reinforce what representation actually is — the factual foundation for informed decisions — without repitching and without promising the balance changes.",
      ],
      questions: [
        {
          questionId: "closing-value-anchor",
          prompt: "What does the value reinforcement give an anxious client that repeating the pitch does not?",
          gradingPoints: [
            "the factual foundation — knowing exactly where they stand",
            "informed next decisions, not a predicted outcome",
            "one calm restatement of value instead of a restarted pitch",
          ],
        },
      ],
    },
    {
      moduleId: "closing.welcome-and-wrap",
      title: "End on the welcome",
      direction: "any",
      objective: "Set the welcome-call and confirmation-email expectation, thank the prospect for acting, and end the call while it feels finished.",
      reading: "The last beat is a concrete next touch and a warm exit: \"Thank you for getting in front of this\" — welcome call and confirmation email within one business day. Respect the decision they just made by saying so, then stop talking. The worst close is the one that keeps going.",
      coachNudge: "Name both touches and the one-business-day window, land the thank-you, and get out without reopening anything on the way to goodbye.",
      listenFor: "The prospect signs off knowing the welcome call and confirmation email are coming within one business day, sounding finished rather than still circling.",
      criterionIds: [
        "tax-resolution.7.end_welcome",
      ],
      situations: [
        "The prospect is relieved and ready to go: Great — so are we done? I have to run.",
        "The prospect lingers nervously, circling back to small questions you have already answered, and needs a warm, certain ending instead of another loop.",
      
        "The prospect tries to pre-empt the wrap while rushing off: Skip the welcome-call stuff — just email me, I never answer the phone anyway. Set the approved expectation warmly regardless — both touches, one business day — land the thank-you, and let them go without arguing or dropping a touch.",
        "The warm goodbye is underway when the prospect suddenly wobbles: Actually, one more thing — are you sure I shouldn't just think it over until tomorrow? Do not restart the pitch or the payment; respect the decision they already made with the thank-you, the concrete welcome window, and an ending that feels finished.",
      ],
      questions: [
        {
          questionId: "closing-welcome-expectation",
          prompt: "How does the approved script end the call — what expectation is set, and how is the prospect thanked?",
          gradingPoints: [
            "welcome call",
            "confirmation email",
            "within one business day",
            "thanks the prospect for getting in front of it",
          ],
        },
      ],
    },
  ],
  personas: [
    persona("closing-relieved", "Committed and relieved", "Needs a concise recap and welcome expectation.", "foundation"),
    persona("closing-detail-oriented", "Committed but procedural", "Asks who contacts them and what happens first.", "intermediate"),
    persona("closing-anxious", "Committed but still fearful", "Reopens uncertainty about what the IRS does next and needs a calm factual recap.", "advanced"),
  ],
  situations: [
    "Prospect has completed the agreement and wants to know what happens next.",
    "Prospect asks when the attorney's staff and welcome team will contact them.",
    "Prospect is paid and signed but becomes anxious that nothing will happen.",
  ],
  prohibitedMoves: [
    "promising an unverified case result",
    "inventing a faster timeline",
    "reopening the fee or payment negotiation",
    "ending without the welcome expectation",
  ],
  reflectionPrompt: "Did your close leave the prospect knowing exactly what happens next without promising a result?",
  questions: [
    question("closing-sequence", "What sequence should the final summary describe?", ["tax-resolution.7.summarize_next"]),
    question("closing-expectation", "What communication expectation ends the approved script?", ["tax-resolution.7.end_welcome"]),
  ],
});

const TAX_RESOLUTION_SKILL_PACKETS = Object.freeze([
  INTRODUCTION,
  DISCOVERY,
  EXPERT_GUIDANCE,
  REPRESENTATION,
  PAYMENT_TERMS,
  INFORMATION_COLLECTION,
  THINK_IT_OVER,
  CLOSING,
]);


const TOPIC_OBJECTIONS = manualPacket({
  criteria: [
    manualCriterion("objections", "acknowledge_first", "Acknowledge or validate the objection before answering it — agree with what is fair in it instead of arguing, defending, or apologizing.", "Cite the learner turn that names the SPECIFIC concern the prospect raised — the fee, the scam fear, the prior burn, the weight of the years — or agrees with what is fair in it (\"fair question\", \"you're right to be careful\", \"that's a real weight\"), and confirm it lands BEFORE any counter-move. A generic empathy token with the concern left unnamed (\"I understand\", \"I hear you\", \"no problem\") does not count, and any apology for the call or the fee anywhere in the exchange fails it.", ["obj.scam-distrust","obj.contingency","obj.burned-before","obj.hopeless","obj.cant-decide-now","obj.no-urgency"]),
    manualCriterion("objections", "diagnose_before_playing", "Test what the objection actually is before playing a card — objection versus condition on money, and diagnostic questions before challenging any existing preparer, firm, or IRS arrangement — with an honest concession when the answers say the prospect is right.", "Cite the learner turn that asks a diagnostic question before asserting a position (\"is the money truly not there, or are you not sure it's worth it?\", \"is the balance lower today than the day you set it up?\", \"did they file the power of attorney?\") — and, where the facts check out, the turn that concedes it plainly.", ["obj.cant-afford","obj.already-on-plan","obj.already-have-cpa","obj.working-with-irs","obj.hired-another-company","obj.too-simple","obj.diy-self-rep"]),
    manualCriterion("objections", "isolate_real", "Isolate the real hesitation behind wrapper objections — name the likely blockers, ask which is closer, and answer the one they pick instead of pitching at the wrapper.", "Cite the learner turn that surfaces the specific blocker (\"usually that means the fee, or whether this actually works — which is closer?\", \"what specifically do you want to see?\") and the follow-up turn that answers that named concern rather than restating the pitch.", ["obj.need-to-think","obj.price-too-high","obj.send-email","obj.silence"]),
    manualCriterion("objections", "answer_with_facts", "Answer with established, verifiable specifics — itemized work, opt-in receipts with masked details, public verification paths, named process steps — never with adjectives, reassurance, or unverifiable social proof.", "Cite the learner turn containing checkable specifics: the named work the fee buys, the lead source with date and partially-masked email, the spelled firm name with a public way to verify, or the specific first-30-days actions — not \"we're legit\" or \"we've helped thousands.\"", ["obj.price-too-high","obj.scam-distrust","obj.how-got-number","obj.burned-before","obj.how-can-i-trust"]),
    manualCriterion("objections", "no_invented_promises", "Refuse guarantees, invented numbers, and manufactured urgency — qualification language and real clocks only, with the refusal itself framed as the credibility move.", "Cite the learner turn whose refusal is CLEAN — a flat no to the result, rate, savings figure, or deadline (\"anyone who guarantees that is lying to you\") with no hedged soft-yes anywhere in the turn (\"we usually do very well\", \"most clients save a ton\", \"I can't technically promise, but...\") — immediately followed by the replacement: named actions, qualification read off real transcripts, or honest accrual math. A disclaimer stapled to an implied promise fails; so does a bare no with nothing offered behind it.", ["obj.guarantee-seeking","obj.contingency","obj.success-rate","obj.no-urgency"]),
    manualCriterion("objections", "advance_or_lock", "Convert every handled objection into a concrete advance — a transcript pull, one small first step, the spouse on the line, or a locked time with a micro-commitment — never a release to a vague maybe.", "Cite the learner turn that proposes a clocked, named next step (pull the transcripts, one signature, three-way at six tonight, callback at 4:30) AND the prospect turn that accepts it or supplies a micro-commitment — a confirmed time, number, or case fact. A time the learner floats that the prospect never agrees to does not count, and neither does \"call us when you're ready\" or any unclocked follow-up.", ["obj.need-to-think","obj.spouse-consult","obj.busy-bad-time","obj.send-email","obj.hopeless"]),
    manualCriterion("objections", "honor_the_line", "Keep the re-engagement boundary crisp: coach through a reflex brush-off using the prospect's own facts, but treat an explicit removal demand as terminal — confirm it and end warmly, and never sell past a second no.", "Cite the single learner turn that re-engages a \"not interested\" with one question tied to the prospect's own inquiry or case facts — at most one such attempt, with no learner turn selling past a second no — or, the moment removal language appears (\"take me off\", \"stop calling\"), the VERY NEXT learner turn confirming removal with zero value statements, questions, or hesitation attached; any pitch content between the removal demand and the confirmation fails it.", ["obj.not-interested","obj.dnc-revocation"]),
    manualCriterion("objections", "anchor_to_the_balance", "Anchor the fee only against the balance, the accrual, and the cost of inaction — never against the prospect's groceries, rent, or household budget — and state garnishment or levy exposure once as calm fact, never repeated as a threat or rhetorical bludgeon to make the number feel small.", "Cite the learner turn that compares the fee to the balance, this year's penalty-and-interest accrual, or what inaction costs (\"the penalties this year alone are likely more than the first phase\", \"against the debt, the fee is the only fixed number\") — and confirm no turn anywhere frames the fee against food, rent, or family spending (\"can you afford NOT to\" against their groceries fails), and no turn re-litigates wage garnishment as pressure after the exposure has been stated once as fact.", ["obj.cant-afford","obj.price-too-high","obj.contingency","obj.guarantee-seeking"]),
    manualCriterion("objections", "identity_challenge", "Hand over the public basics instantly and unconditionally — firm name spelled, public website, main line, truthful call reason — but treat deeper company detail as earned: test for reciprocal good-faith engagement with one ordinary case question before disclosing more, and never volunteer office, staff, or internal information merely because someone asks.", "Cite two learner moves: the turn that gives the public minimum without hesitation or dodging — firm name spelled, public website, main line, truthful reason for the call, and a plain not-the-IRS where asked — and the turn that asks one ordinary case question (balance, unfiled years, a notice) before any deeper detail flows. Volunteering an office address, staff names, credentials lists, or internal structure on request alone fails it; so does withholding any piece of the public minimum. Where the prospect only fishes and never reciprocates, the cited exit turn must offer the public verification path and end without accusation or debate.", ["obj.company-name-verify","obj.how-can-i-trust"]),
  ],
  id: "tax-resolution.objections",
  sectionId: "8",
  title: "Objection Handling",
  localObjective: "Meet money, trust, capability, and stall objections without retreating, apologizing, or overpromising: acknowledge first, diagnose what the objection really is, answer with established facts, and convert every exchange into a concrete advance.",
  directions: [
    "inbound",
    "outbound",
  ],
  maxTurns: 12,
  responseSignals: [],
  practiceModules: [
    {
      moduleId: "objections.cant-afford",
      title: "Sort condition from objection on \"can't afford\"",
      direction: "any",
      objective: "Believe \"I can't afford it\" by default, test whether it is a condition or an objection, and turn either answer into an advance — boomerang and phase the objection, hardship-pivot the condition — with the prospect's dignity intact.",
      reading: "Believe this one by default — the balance exists because money got tight, so you are hearing something true and a little embarrassing, not a haggle. Test before you play: is the money truly not there, or are they unsure it's worth it — objection and condition sound identical and take opposite plays. The objection gets the boomerang — tight money is exactly why the accrual and levy exposure matter — plus a phased first step instead of the full quote. The true condition gets the hardship pivot, which still advances: qualifying requires the same financial conversation you wanted anyway.",
      coachNudge: "Ask the condition-or-objection question before playing any card, and keep every comparison on the IRS's accrual — never their groceries, never their paycheck as a threat.",
      listenFor: "The learner tests objection versus condition out loud, and either answer ends in a named next step — the phased investigation piece or the hardship financial review — with zero shame put on the prospect.",
      criterionIds: [
        "tax-resolution.objections.diagnose_before_playing",
        "tax-resolution.objections.advance_or_lock",
        "tax-resolution.objections.anchor_to_the_balance",
      ],
      situations: [
        "The prospect says: I'd love to, but the money genuinely isn't there. I'm barely covering rent as it is.",
        "The prospect says: money's tight — that's literally how I ended up owing them in the first place. Stacking your fee on top of what the IRS wants feels insane.",
        "The prospect says: between my daughter's tuition and the truck payment, I can't drop this kind of money right now. Knock a third off and maybe we've got something to talk about.",
        "The prospect challenges you: go ahead, tell me the IRS is going to take my paycheck if I don't pay you. Say it. Should I hand you the money or feed my kids this month?",
        "The prospect engages all the way to the fee, then goes quiet and finally admits: I got laid off in June. There's no version of this month where I have that money — or next month either.",
        "The prospect says: look, nothing's happening until I get paid on the first — actually, with the holidays coming, just call me back in January and we'll set it all up then.",
      ],
      questions: [
        {
          questionId: "cant-afford-condition-split",
          prompt: "A prospect says the money genuinely isn't there. What distinguishes a condition from an objection here, and what does each answer change about your next move?",
          gradingPoints: [
            "Defines the split — an objection is a request for more information (\"not sure it's worth it\"), a condition is genuine inability — and names the test question that must come before any play (obj.cant-afford: objection-vs-condition move).",
            "States the objection play: boomerang tight money into the reason to act — the IRS collects from people who can least afford it, penalties this year likely exceed the first phase — then phase the engagement to the smaller investigation step instead of the full quote (obj.cant-afford: boomerang and phasing moves).",
            "States the condition play: pivot to hardship qualification and explains why the pivot IS an advance — qualifying requires full financial disclosure, exactly the conversation you wanted (obj.cant-afford: hardship move and drill).",
            "Names at least one dignity guardrail from the avoid list: no groceries-or-rent framing, no wage fear-mongering, no unexplained discount, no apologizing for the fee or the call (obj.cant-afford: what-not-to-do).",
          ],
        },
      ],
    },
    {
      moduleId: "objections.price-too-high",
      title: "Defend the fee with the work, not a discount",
      direction: "any",
      objective: "Answer \"why is it so expensive\" by itemizing the named work, re-anchoring the fee against the balance and accrual, differentiating from the cheap routes without disparaging them — then isolating whether the real objection is value or capacity.",
      reading: "Price scrutiny is a prospect doing math out loud with the wrong anchors — TurboTax, a CPA's hourly rate, the do-it-yourself application fee — and often it is fair scrutiny. Move the anchor: itemize the actual work the fee buys, then state it against the balance and this year's accrual, the only honest comparison. Differentiate without disparaging — preparation and collections representation are different jobs, and conceding when the cheap route IS right is what makes the rest credible. Then isolate: \"if the value is clear, is the number workable?\" — a quiet slide into can't-afford is a different play.",
      coachNudge: "Itemize before you defend, re-anchor against the balance and the accrual, and never drop the number without a stated reason — an unexplained discount tells them the price was inflated.",
      listenFor: "The learner names the actual work the fee buys, anchors it to the balance and this year's accrual, and asks the isolating value-versus-capacity question instead of caving, apologizing, or promising savings.",
      criterionIds: [
        "tax-resolution.objections.answer_with_facts",
        "tax-resolution.objections.isolate_real",
        "tax-resolution.objections.anchor_to_the_balance",
      ],
      situations: [
        "The prospect says: four thousand dollars? My CPA does my whole return for four hundred. Explain why you cost ten times as much.",
        "The prospect says: I looked it up — the offer-in-compromise application is a couple hundred bucks and I can file it myself. What exactly does your fee buy that the form doesn't?",
        "The prospect says: the outfit I called this morning quoted half your number and said they'd beat any price. Match them right now or I'm signing with them this afternoon.",
        "The prospect says: I owe eleven grand and your fee is four — that's more than a third of the whole debt. Why wouldn't I just put that money toward the balance instead?",
        "The prospect concedes the itemized work sounds real, then: okay, I get what it buys. It's still a lot of money. — and you can't yet tell whether that's value doubt or empty pockets talking.",
        "The prospect says: run the math for me — I give you five grand, how much do you knock off the forty I owe? Show me the return on my money or it's a no.",
      ],
      questions: [
        {
          questionId: "price-cpa-half",
          prompt: "A prospect says a CPA would charge half for this. Walk the full handling — what do you say, what do you never say, and how does the exchange end?",
          gradingPoints: [
            "Differentiates the jobs without disparaging the CPA — return preparation and collections representation are different work under different rules — and concedes plainly when the cheap route fits: \"if it were just returns, I'd tell you to use the CPA\" (obj.price-too-high: drill).",
            "Justifies the fee with the itemized named work — transcript analysis, POA filing, compliance on unfiled years, resolution negotiation, ongoing IRS communication — never with vague value language like \"you get what you pay for\" (obj.price-too-high: itemize move and avoid list).",
            "Re-anchors against the balance and this year's accrued penalties — the fee as the only fixed number in the situation — never against the household budget, and never a savings figure or percentage to make the fee feel small (obj.price-too-high: re-anchor move, avoid list, compliance).",
            "Refuses any unexplained drop — a discount with no stated reason signals the price was inflated and converts a value question into a trust problem (obj.price-too-high: never-cave rule).",
            "Ends by isolating: \"if the value is clear, is the number itself workable?\" — and routes to the can't-afford play if the answer reveals capacity, because that is a different objection (obj.price-too-high: isolate move).",
          ],
        },
      ],
    },
    {
      moduleId: "objections.early-price-probe",
      title: "Answer the early price probe with shape, not a number",
      direction: "any",
      objective: "Treat \"how much does it cost\" asked before scoping as the buying signal it is — answer it honestly with the fee's structure, never a blind quote and never a dodge, and let the question itself pull discovery forward.",
      reading: "\"How much\" two minutes in is momentum — people rarely price things they don't want — and it dies two ways: \"we'll get to that\" reads as the evasion scammers do, while a blind quote anchors a number to a case you haven't seen and invites comparison shopping. Give the honest shape instead: a fixed, modest first phase; a resolution phase priced by years involved and program qualification — two things nobody knows yet. Then porcupine the dependency: the price hangs on how many years and whether enforcement is active, so which are we dealing with? Their own question becomes your discovery engine.",
      coachNudge: "Respect the question instantly and out loud, give structure instead of a number, and convert the price dependency into the next two discovery questions.",
      listenFor: "The learner acknowledges the question as fair, states the fee's shape without quoting the engagement, and the prospect starts answering discovery questions the price actually depends on.",
      criterionIds: [
        "tax-resolution.objections.acknowledge_first",
        "tax-resolution.objections.answer_with_facts",
        "tax-resolution.objections.advance_or_lock",
      ],
      situations: [
        "Ninety seconds into the call, the prospect cuts in: before we go one step further — what is this going to cost me?",
        "The prospect says: just give me a ballpark. Every other place I called quoted something. If you can't even say a number, that tells me everything I need to know.",
        "The prospect says: is this one of those places where the price is whatever you figure I can pay? Just tell me the damage up front so I know you're straight with me.",
        "You give the fee's structure and the prospect pushes: 'fixed and modest' isn't a number. Pin it down right now — the whole thing, all-in — or we're done here.",
        "The prospect says: my brother-in-law got quoted fifteen hundred flat, sight unseen, by some place on the radio. Match that number right now and I'll sign today.",
      ],
      questions: [
        {
          questionId: "early-probe-shape",
          prompt: "Ninety seconds into a call the prospect demands the price. Why is a blind quote as deadly as a dodge, and what is the play?",
          gradingPoints: [
            "Names the early price question as a buying signal to be respected — momentum, not an attack on pitch order — never punished with \"we'll get to that\" or \"don't worry about the cost\" (obj.early-price-probe: lead and avoid list).",
            "Explains both failure modes: deflection reads as the evasion scam operations do and undoes every trust move, while a blind full-engagement quote anchors wrong, invites comparison shopping against firms quoting equally blind, and cannot be walked back (obj.early-price-probe: prose and avoid list).",
            "Gives the honest structure in place of a number: the first phase — POA, transcripts, full compliance read — is fixed and modest; the resolution phase is priced off years involved and program qualification, like a contractor who can't quote a roof he hasn't seen (obj.early-price-probe: structure move and floor lines).",
            "Porcupines the dependency into discovery — \"the price hangs on two things: how many years, and whether enforcement is active — which are we dealing with?\" — carrying the momentum into the case instead of ending the topic (obj.early-price-probe: porcupine move and drill).",
          ],
        },
      ],
    },
    {
      moduleId: "objections.contingency",
      title: "Refuse contingency with the reasons",
      direction: "any",
      objective: "Deliver the respectful, reasoned no to pay-when-it's-done — validate the self-protection instinct, give the three real reasons the request cannot be granted, and replace the contingency with verifiable work and structured payment.",
      reading: "A contingency ask is a burned prospect shifting the risk of another bad experience back onto you — respect the instinct, then say no with the reasons: the rules governing practice before the IRS restrict contingent fees, the work happens in full whatever the outcome, and \"pay only if it works\" quietly requires promising a result nobody honest promises. The two easy answers both lose — caving sets up a broken promise, and \"we don't do that\" with no reason feeds the distrust that produced the ask. Their real protection is verifiable work: POA on file, transcripts pulled, a named case manager, actions they can watch happen in the first thirty days. The structure that does exist is spread payments — the fee can be structured, never conditional.",
      coachNudge: "Validate the instinct first, give the no with all three reasons, and let the refusal itself do the credibility work before offering the structure that actually exists.",
      listenFor: "The learner refuses cleanly with the reasons, never dangles a manager-maybe or defines what a successful outcome would be, and moves the prospect onto verifiable work and structured payment.",
      criterionIds: [
        "tax-resolution.objections.acknowledge_first",
        "tax-resolution.objections.no_invented_promises",
        "tax-resolution.objections.answer_with_facts",
      ],
      situations: [
        "The prospect says: I've been burned once in this industry already. You get paid when my case is done and I've seen results — that's the only deal I'll take.",
        "The prospect says: the last firm told me they only get paid out of what they save me. Match that or I walk — and don't say you can't, because they just did.",
        "The prospect says: so if the IRS says no to everything, I'm out the whole fee and you're paid in full? Explain how that's fair to me.",
        "The prospect softens, then bargains: fine, forget contingency — but tie half your fee to getting me under ten grand. Meet me halfway and we sign tonight.",
        "The prospect says: just tell me you'll run a results-based deal past your manager. That's all I need to hear to move forward today.",
      ],
      questions: [
        {
          questionId: "contingency-three-reasons",
          prompt: "Why can't tax resolution work on contingency, and what do you offer the prospect in its place?",
          gradingPoints: [
            "Validates the instinct before refusing — \"that's a fair ask, you're protecting yourself, and you should\" — because a flat unexplained refusal confirms the distrust that produced the request (obj.contingency: validate move and avoid list).",
            "Gives all three reasons for the no: the practice rules restrict contingent fees in this work, the labor — transcripts, POA, filings, negotiation — happens in full regardless of outcome, and any pay-on-results deal requires defining and promising a result nobody honest promises (obj.contingency: prose and honest-no move).",
            "Names what a \"paid out of what we save you\" offer really is — a savings promise, the exact pitch that burns people in this industry — without drifting into defining a target outcome themselves (obj.contingency: drill and compliance).",
            "Replaces the contingency with the real protection — verifiable, watchable work in the first thirty days — and offers the structure that exists: spreading the fee is on the table, making it conditional is not (obj.contingency: reframe and structure moves).",
            "Never caves, never hints a manager might approve something, and never apologizes for the fee structure — the fee exists because the work is real (obj.contingency: avoid list).",
          ],
        },
      ],
    },
    {
      moduleId: "objections.guarantee",
      title: "Make the no to guarantees the credibility move",
      direction: "any",
      objective: "Answer the pennies-on-the-dollar guarantee demand with a flat, warm no that takes the prospect's side against the ads — then immediately fill the space with keepable commitments and advance to the transcript pull that holds the real answer.",
      reading: "The guarantee ask was trained in by years of radio ads — and the disappointment was trained in right behind it, so any promise, number, percentage, or \"clients like you usually\" manufactures the exact burn they fear. The winning answer is counterintuitive: a flat, warm no — \"anyone who guarantees that is lying to you\" — takes their side against the ad-speak and instantly makes you the most credible voice they've heard. Never leave a vacuum after the no: fill it immediately with what CAN be promised — a licensed rep on the case, every resolution option reviewed against their real financials, straight answers throughout. Qualification language is the entire honest vocabulary of outcomes: what the transcripts show they qualify for, never what the IRS will give or when.",
      coachNudge: "Refuse flat and warm with zero hedge, take their side against the ads, and follow the no in the same breath with keepable commitments and the transcript pull.",
      listenFor: "A clean no with no hedged soft-yes anywhere in the turn, immediately followed by named keepable commitments and qualification language — and the transcript pull proposed as the only path to the answer they actually asked for.",
      criterionIds: [
        "tax-resolution.objections.no_invented_promises",
        "tax-resolution.objections.answer_with_facts",
        "tax-resolution.objections.advance_or_lock",
      ],
      situations: [
        "The prospect says: the guy on the radio guarantees settlements for pennies on the dollar. Can you do that or not — yes or no?",
        "The prospect says: the last company put ten cents on the dollar in writing. Beat it — tell me eight — and I'll read you my card number right now.",
        "The prospect says: fine, no guarantees. Then just give me your track record — what do people like me usually end up saving with you? Ballpark is fine.",
        "The prospect, voice cracking: I just need to hear you say it's going to be okay — that you'll get this down to something I can live with. Promise me that much.",
        "After your no, the prospect pushes: so you won't guarantee anything at all? Then what exactly am I paying for — hope?",
      ],
      questions: [
        {
          questionId: "guarantee-clean-no",
          prompt: "The prospect demands a settlement guarantee. What does the strong no sound like, and what fills the space behind it?",
          gradingPoints: [
            "The refusal is flat, warm, and clean — no hedged soft-yes like \"I can't technically promise, but between you and me...\" — and it takes the prospect's side against the ads: \"anyone who guarantees that is lying to you\" is protection, not rejection (obj.guarantee-seeking: prose, name-it move, weak-vs-strong example).",
            "Never supplies a number, percentage, \"clients like you usually,\" or savings track record — a percentage is a promise with a fig leaf on it, and a hedge is a guarantee the firm cannot keep (obj.guarantee-seeking: avoid list).",
            "Fills the vacuum immediately after the no with what IS guaranteed — a licensed rep on the case, POA filed, every resolution option reviewed against their real financials, straight answers throughout — because a bare refusal with nothing behind it reads as weakness (obj.guarantee-seeking: replace move and avoid list).",
            "Uses qualification language for the future — \"once your transcripts are in, you'll know exactly what you qualify for, from the record, not a guess\" — never prediction (obj.guarantee-seeking: qualification move and compliance).",
            "Advances on the banked credibility to the transcript pull as the natural next step — the only path to the real answer they were asking for — rather than competing in a bidding war of promises (obj.guarantee-seeking: advance move and drill).",
          ],
        },
      ],
    },
    {
      moduleId: "objections.scam-suspicion",
      title: "\"Is this a scam?\" — the checkable-truth play",
      direction: "any",
      objective: "Answer scam suspicion and \"how do I know you're real\" with checkable truth and named process, refusing guarantees, without ever running the deny-reassure-promise pattern.",
      reading: "Scam suspicion is the rational response to this industry — agree with it before you answer it, because \"you're right to be careful\" lands where every defense fails. Then hand them something checkable instead of something soothing: the firm name spelled out, the public site and main line, an invitation to verify while you wait — specifics are the one thing a fraudster can't fake cheaply. Refuse the guarantee even when they demand it as proof: anyone promising numbers on a first call is who they should hang up on, and saying so out loud is the credibility move. And never run the scammer's own three-beat — deny, reassure, promise — because that exact pattern is what they're listening for.",
      coachNudge: "Agree with the caution, hand over what they can check, and let the refusal to promise do the proving.",
      listenFor: "The prospect stops testing legitimacy — verifies while you wait, asks a process question, or answers a question about their own tax situation.",
      criterionIds: [
        "tax-resolution.objections.acknowledge_first",
        "tax-resolution.objections.answer_with_facts",
        "tax-resolution.objections.no_invented_promises",
      ],
      situations: [
        "The prospect says: You sound exactly like the calls the news warned my mother about. Give me one reason I shouldn't hang up right now.",
        "The prospect says: I'm pulling up your website while we talk... okay, it loads. So what? Anybody can buy a website for ten bucks. Prove it some other way.",
        "The prospect says: The last outfit that called promised they'd settle my twenty grand for five hundred bucks. If you're the real one, you can at least match that promise — otherwise YOU'RE the scam.",
        "The prospect says: Just say it. Say the words 'I promise this is not a scam' and I'll give you five minutes.",
        "The prospect says: My son handles this stuff and he says everyone who calls about tax debt is a crook. Honestly, he's usually right.",
        "The prospect, halfway convinced, says: Okay. So walk me through what EXACTLY happens if I say yes — step by step, and no salesman stuff.",
      ],
      questions: [
        {
          questionId: "scam-checkable-truth",
          prompt: "A prospect demands: \"Promise me you're not a scam.\" Why does the deny-reassure-promise pattern fail here, and what does the checkable-truth play look like instead?",
          gradingPoints: [
            "deny-reassure-promise is the exact three-beat pattern of every scam call they've received — running it confirms the fear",
            "agreement lands first: \"you're right to be careful\" beats any defense, and defensiveness reads as guilt",
            "verifiable specifics replace reassurance — the firm name spelled out, the public website and main line, an invitation to verify independently while you wait",
            "refusing to guarantee IS the credibility move — anyone promising a settlement number on a first call is who they should hang up on",
            "concrete process talk — POA, transcripts, compliance review — is what scammers almost never bother to offer",
          ],
        },
      ],
    },
    {
      moduleId: "objections.who-are-you-really",
      title: "The identity gates — who are you, are you the IRS, spell it",
      direction: "any",
      objective: "Pass the identity gates with the truthful public minimum delivered calmly, deeper disclosure earned by reciprocity, and never a hint of government affiliation.",
      reading: "A direct identity question gets a direct, truthful answer — calm and complete in one breath, never apologetic, never a credentials recital. \"Are you the IRS\" takes a plain no with the distinction attached in the same breath — a private firm that represents taxpayers BEFORE the IRS — and no softener like \"we work with the IRS\" ever blurs that line. The public basics flow instantly and unconditionally: firm name spelled, public website, main line, the truthful reason for the call; the office address, staff details, and everything internal are earned, not owed. After the basics, ask one ordinary case question and read the reciprocity — good-faith prospects engage, fishers keep collecting, and the fisher gets the public verification path and a clean, accusation-free goodbye.",
      coachNudge: "Answer what they actually asked — plainly and truthfully — then trade one reciprocal case question before anything deeper leaves your mouth.",
      listenFor: "The prospect moves from interrogating you to answering an ordinary question about their own balance, returns, or notice — or reveals themselves as a fisher and gets the public path.",
      criterionIds: [
        "tax-resolution.objections.acknowledge_first",
        "tax-resolution.objections.answer_with_facts",
        "tax-resolution.objections.identity_challenge",
      ],
      situations: [
        "The prospect snaps: Who IS this? Why do you people keep calling me? What do you want from me?",
        "The prospect's voice goes tight: Oh god — is this the IRS? Are you calling to take my house? I knew this was coming.",
        "The prospect scoffs: You're not the government, so you're nobody. Unless you're telling me you're WITH the IRS, this call is pointless.",
        "The prospect turns interrogator: Spell the company name. Now the street address. Who's your supervisor? How many employees? I'm writing all of this down — and no, I'm not telling you anything about my taxes.",
        "The prospect says: Never heard of you. Read me every license, every credential, every number your people hold — all of it, right now, or I hang up.",
        "The prospect, calmer: Okay, I found the website and the main line checks out. So — why me? Why did you call me specifically?",
      ],
      questions: [
        {
          questionId: "identity-earned-disclosure",
          prompt: "A caller demands the company name, your address, and everything about your staff before answering a single question. What do you give freely, what do you hold, and what earns more?",
          gradingPoints: [
            "the public basics flow instantly and unconditionally — firm name spelled, public website, main line, truthful call reason — basic identity is never conditional",
            "office address, staff information, and internal details are never volunteered merely because someone asks",
            "one ordinary case question — balance, unfiled returns, a notice — tests good-faith reciprocity, and disclosure deepens only as they engage",
            "a fisher who collects while refusing every case question gets the public verification path and a clean exit with no accusation and no debate",
          ],
        },
        {
          questionId: "irs-question-one-breath",
          prompt: "Voice tight, the prospect asks: \"Is this the IRS calling me?\" What must your answer do in one breath, and for whom?",
          gradingPoints: [
            "a plain no comes first — not the IRS, not the government — never a blur like \"we work with the IRS,\" which is a compliance line, not a style choice",
            "the distinction attaches in the same breath: a private firm licensed to represent taxpayers BEFORE the IRS — on their side of the table",
            "the frightened caller gets the fear eased before anything else: not a collection call, nothing happening on this phone",
            "the authority-tester hears that representation rights are exactly the authority they were probing for",
          ],
        },
      ],
    },
    {
      moduleId: "objections.how-got-number",
      title: "\"How did you get my number?\" — receipts, masked",
      direction: "outbound",
      objective: "Win the how-did-you-get-my-number gate with masked receipts — source, date, partial email — normalize the forgotten form, and honor the removal line the instant it appears.",
      reading: "This gate is won before the phone rings: have the opt-in data in front of you, because source-plus-date-plus-masked-email is the one answer a scammer can't give, and \"you're in our system\" is the one answer a scammer always gives. When they don't remember, normalize it and partial-reveal — enough masked detail to jog a real memory, never the full file, because a PII dump is both a data-handling failure and exactly what a fraudster with a purchased list would do. Prove it once, then move — linger in the defensive register and the call dies there; the form was never the point, the balance is. And if the answer to your receipts is \"take me off,\" that's law, not a play — confirm it and end warmly.",
      coachNudge: "Deliver the receipts calmly, masked, and once — then bridge to the balance before the defensive register can set.",
      listenFor: "The memory clicks — or the prospect drops the form fight and answers whether the tax issue itself is still sitting there.",
      criterionIds: [
        "tax-resolution.objections.acknowledge_first",
        "tax-resolution.objections.answer_with_facts",
        "tax-resolution.objections.honor_the_line",
      ],
      situations: [
        "The prospect interrupts your second sentence: Hold on. Stop. How did you even get this number?",
        "The prospect says: I never filled out anything. I don't do internet forms. You've got the wrong person.",
        "The prospect tests you: If I really signed up, prove it — read me the whole file. Full email, my address, the social I supposedly gave you. All of it, or you're lying.",
        "The prospect half-remembers: ...huh. That might've been my husband on my phone. Either way it wasn't me, so this isn't my problem.",
        "The prospect accuses: You bought my number off some data-breach list, admit it. That's how all of you people work.",
        "The prospect erupts: I don't care about any form — you just woke the baby. Delete this number and don't ever call it again.",
      ],
      questions: [
        {
          questionId: "receipts-partial-reveal",
          prompt: "Why does the masked partial reveal beat both a vague \"you're in our system\" and a full read-out of their file?",
          gradingPoints: [
            "vague answers are indistinguishable from a scammer's — a scammer would say exactly \"you're in our database\"",
            "source, date, and a partially-masked email prove real opt-in data — a guesser can't produce any of them",
            "a full PII dump is a data-handling failure and, ironically, exactly what a scammer with a purchased list would do",
            "letting their own memory close the gap beats your assertion — then bridge off the defensive register to the balance itself",
            "if the receipts are answered with removal language, that is a TCPA revocation — confirm it immediately, nothing attached",
          ],
        },
      ],
    },
    {
      moduleId: "objections.not-interested-line",
      title: "\"Not interested\" — and the line it must never cross",
      direction: "outbound",
      objective: "Coach through the reflex brush-off with one question off the prospect's own facts — and switch instantly to clean, warm compliance the moment removal language lands.",
      reading: "\"Not interested\" thirty seconds in is a verdict on unknown callers, not on your offer — they haven't heard your offer. You get one graceful re-engagement, anchored to their own inquiry, and it is a question, never a pitch, never an apology. The bright line: \"take me off your list\" is a legal revocation — the very next sentence confirms the removal with nothing attached, and the later sentence always wins over the earlier one. Past a second no you never sell; the clean, warm exit is the last brand impression you control.",
      coachNudge: "One question off their facts, no apology — and the instant removal language lands, the confirmation goes out alone.",
      listenFor: "The prospect answers the fact question and slides into discovery — or demands removal and hears it confirmed in one warm sentence with nothing riding along.",
      criterionIds: [
        "tax-resolution.objections.acknowledge_first",
        "tax-resolution.objections.honor_the_line",
      ],
      situations: [
        "The prospect, on autopilot with dishes clattering behind them: Yeah, no thanks, I'm good.",
        "The prospect says: Not interested. You've got ten seconds before I hang up.",
        "The prospect says: I'm not interested — actually, you know what, just take me off your list.",
        "You re-engage once off their inquiry and they cut you off: I already said I'm not interested. What part was unclear?",
        "The prospect sighs: Look, you sound nice, but I'm done — done with tax stuff, done with calls, done with all of it. I'm good. Really.",
      ],
      questions: [
        {
          questionId: "brushoff-vs-revocation",
          prompt: "Where exactly is the line between a coachable brush-off and a legal revocation, and what does each one get?",
          gradingPoints: [
            "\"not interested\" is a reflex about unknown callers, delivered on autopilot — it gets one graceful re-engagement built on their own inquiry or case facts, with no apology and no pitch",
            "\"take me off your list / stop calling / remove my number\" is a TCPA revocation — confirmed immediately and explicitly, then a warm, brief end",
            "the later sentence wins: a removal demand after a re-engagement overrides everything that came before it",
            "never sell past a second no — the confirmation goes out alone, with no value statement or question attached",
          ],
        },
      ],
    },
    {
      moduleId: "objections.writing-first",
      title: "\"Send me something in writing first\" — the verification flavor",
      direction: "any",
      objective: "Turn \"put it in writing before we talk\" from an exit ramp into a verification step — scoped to what they actually want to see, sent live where possible, walked through, and clocked.",
      reading: "Refusing the request reads evasive and feeds every scam doubt, so agree instantly — then make the email worth something. \"What specifically do you want to see?\" is the sorting question: a verifier names the engagement letter or the fee schedule, a dodger has no answer, and either way you now know which call you're on. Send it while they're still on the line when you can and walk them through it — a document that arrives mid-call is a shared page, and an unaccompanied send is a hang-up with paperwork. Whatever goes out carries a clock: a named day and hour to walk through questions, never \"look it over and call us.\"",
      coachNudge: "Agree fast, scope the ask, send it live if you can — and never let paper leave without a clock on it.",
      listenFor: "The prospect names what the document should contain, stays on the line while it lands, or accepts a specific day and hour to walk through it.",
      criterionIds: [
        "tax-resolution.objections.isolate_real",
        "tax-resolution.objections.answer_with_facts",
        "tax-resolution.objections.advance_or_lock",
      ],
      situations: [
        "The prospect says: I don't do business over the phone. Send me something in writing first — then maybe we'll talk.",
        "The prospect, dry: Email me whatever you've got, and if it looks real I'll call you back. What is it, some spam brochure?",
        "The prospect, burned-cautious: The last company had me sign before I ever saw a thing on paper. This time NOTHING happens until I'm holding a document. Nothing.",
        "The prospect waves it away: Just mail me something. I'll get to it after the holidays sometime — no need to call back.",
        "The prospect bargains: Put it in writing — the exact amount you'll save me, guaranteed, on your letterhead. Do that and I'll sign today.",
      ],
      questions: [
        {
          questionId: "writing-first-verifier-test",
          prompt: "\"Send me something in writing first — then maybe we'll talk.\" How do you tell the verifier from the dodger, and what makes the email worth sending?",
          gradingPoints: [
            "agree instantly — a flat refusal reads evasive and confirms the scam doubt",
            "\"what specifically do you want to see?\" is the test — a verifier names the engagement letter or fee schedule, a dodger has no answer",
            "send it live while they're on the line where possible and walk them through it — an unaccompanied send is a hang-up with paperwork",
            "a specific callback rides on the email — a named day and hour, never a release to an unclocked maybe",
            "nothing in writing ever guarantees a result or a savings number — the document shows the work and the fee, not a promised outcome",
          ],
        },
      ],
    },
    {
      moduleId: "objections.incumbent",
      title: "“Someone already handles it” — the CPA and the other firm",
      direction: "any",
      objective: "Audit the incumbent's actual work instead of attacking it — affirm whoever they've got, ask the verifiable questions, concede honestly when the incumbent performs, and advance to the transcript pull.",
      reading: "Filing and fixing are different jobs — a preparer files returns; collection representation negotiates the debt that already exists — so affirm the CPA first (“good, keep them”) and offer to work alongside, never instead. For the hired firm, run the audit, not the attack: what did you pay, what's the last thing they did, was the POA filed, were transcripts pulled — yes/no facts, and “I don't know” says everything. The moment you trash the incumbent you attack the prospect's judgment for choosing them, and the wall goes up. If the answers show real work, say so and leave clean with your number — that concession is what makes the audit credible for everyone whose firm went silent after the deposit cleared.",
      coachNudge: "Affirm whoever they've got, then audit the work with the two verifiable questions — POA filed? transcripts pulled? — and let the answers do the selling.",
      listenFor: "The prospect starts checking the incumbent's work themselves — “actually, I don't know if they filed anything” — instead of defending their choice, and either agrees to the transcript pull or hears an honest “stay with them.”",
      criterionIds: [
        "tax-resolution.objections.acknowledge_first",
        "tax-resolution.objections.diagnose_before_playing",
        "tax-resolution.objections.answer_with_facts",
        "tax-resolution.objections.no_invented_promises",
        "tax-resolution.objections.advance_or_lock",
      ],
      situations: [
        "The prospect says: My accountant's done my taxes for fifteen years — I'm not going behind his back to hire somebody else.",
        "The prospect says: My tax guy already knows about the balance. He said he'd look into it — that was back in March, and honestly, the notices are still coming.",
        "The prospect, half-testing: So you're telling me my CPA screwed this up? Go ahead, say it — he's my brother-in-law.",
        "The prospect says: I signed with one of those big national outfits six months ago. Eight grand. They said they're working on an offer in compromise, but I can't remember the last time anyone actually called me.",
        "The prospect pushes: The other company quoted me way less than you, and they guaranteed a settlement. Match their price and their guarantee, or why would I ever switch?",
        "The prospect says: The firm I hired sends me a status email every month — POA's on file, transcripts came back in week two, and I've got a case manager named Dana. What exactly would you add?",
      ],
      questions: [
        {
          questionId: "incumbent-audit-not-attack",
          prompt: "A prospect paid another firm six months ago and can't name the last thing it did. Walk the audit: what do you ask, what do you never say, and where does the call land?",
          gradingPoints: [
            "Opens with the audit, not the attack — what did you pay, and what's the last thing they actually did on your file? — letting the prospect discover the gap themselves; questions about progress trigger no defensiveness (obj.hired-another-company).",
            "Asks the two verifiable yes/no questions — was a power of attorney filed with the IRS, were transcripts pulled — and treats “I don't know” as the answer that says everything.",
            "Never calls the incumbent a scammer and never pushes a hard switch; trash-talk without facts makes the agent the one who sounds like a scammer, and trash-talking another firm is a prohibited move.",
            "Names the baseline any real firm owes — POA week one, transcripts pulled, a named case manager, a plan they can repeat back — as the industry's standard, not our pitch.",
            "Runs the honest OIC check where it applies — an offer promised with no real financial workup is heading for rejection — and if the incumbent is genuinely performing, concedes it plainly and leaves the door open; otherwise advances to the transcript pull to see what's really been done.",
          ],
        },
        {
          questionId: "incumbent-cpa-alongside",
          prompt: "The prospect's CPA has handled their taxes for fifteen years. What distinction do you draw, and what is the alongside play?",
          gradingPoints: [
            "Affirms the preparer first — “good, keep them” — before distinguishing anything; attacking the CPA attacks the prospect's judgment for choosing them (obj.already-have-cpa).",
            "Draws the line in one plain sentence — filing returns versus negotiating an existing debt with the IRS — without a two-minute license lecture.",
            "Runs the gentle value audit: has the CPA filed a power of attorney on this balance, pulled collection transcripts, talked to anyone about the debt?",
            "Offers the alongside play — the CPA keeps the returns, we take the collections side — dissolving the loyalty objection instead of forcing an either/or, then advances to the transcript pull.",
          ],
        },
      ],
    },
    {
      moduleId: "objections.spouse",
      title: "“I need to talk to my spouse” — get the decider on the line",
      direction: "any",
      objective: "Treat the spouse consult as the next step OF the call, not the end of it — qualify the gate, conference now or lock a specific three-way, use the joint-return facts, and never challenge the marriage or release to a vague maybe.",
      reading: "Some couples genuinely decide together — and on a joint return the spouse carries their own liability, which makes this legally THEIR conversation too — while others reach for the spouse as the polite way off the phone; the tell is logistics (a genuine consult knows she's home at six, a dodge stays vague). You don't have to diagnose which you have, because the play is identical: the consult isn't a reason to end the call, it's the next step of it. Qualify the gate (“do you need their sign-off, or do you two just talk things through?”), then get them on the line now or lock the three-way to a day and an hour, and keep collecting case facts in the meantime. Never challenge the marriage, never close around a real gate, and never release to “let me know what she says” — a secondhand retelling is a worse pitch delivered by someone who can't answer questions.",
      coachNudge: "Ask “is she home right now?” before anything else — conference now beats any callback, and if the spouse is truly out, nothing less than a day, an hour, and both parties counts as a plan.",
      listenFor: "The prospect either puts the spouse on or agrees to a specific three-way time — and keeps answering case questions after the consult is scheduled, instead of escaping to “I'll get back to you.”",
      criterionIds: [
        "tax-resolution.objections.acknowledge_first",
        "tax-resolution.objections.diagnose_before_playing",
        "tax-resolution.objections.no_invented_promises",
        "tax-resolution.objections.advance_or_lock",
      ],
      situations: [
        "The prospect says: This sounds right, but my wife and I make every money decision together. I'm not signing anything tonight.",
        "The prospect says: My husband handles all the money — I honestly couldn't tell you what we owe. You'd have to talk to him, and he's impossible to get on the phone.",
        "The prospect lowers their voice: Honestly? My wife doesn't know how bad it's gotten. I want to fix this before she ever finds out.",
        "The prospect says: Look, she'll say no unless I can tell her it's guaranteed to save us money. Just give me a number I can bring her.",
        "The prospect says: Talk to my wife? Sure, someday. Send me whatever, and if she's interested, we'll call you.",
        "The prospect says: She's in the kitchen, but fair warning — she thinks all you people are crooks. You really want her on the line?",
      ],
      questions: [
        {
          questionId: "spouse-no-secondhand-pitch",
          prompt: "The prospect says the decision belongs to both spouses. Why is “talk it over and call me back” the losing play, and what replaces it?",
          gradingPoints: [
            "Names the secondhand-retelling problem: the spouse hears a worse pitch than you'd ever give, delivered by someone who can't answer questions, and the maybe dies quietly (obj.spouse-consult).",
            "Qualifies the gate first — “do you need their sign-off, or do you two just talk things through?” — separating a decision-gate from a comfort ritual.",
            "Goes for the conference now — “is she home? Put her on” — and on a joint return states the fact that it's her balance too, which makes it her conversation tonight, not someday.",
            "If the spouse is truly unavailable, locks a specific three-way — day, hour, both parties — and keeps collecting case facts in the meantime (“so I'm ready for that call, which years are we dealing with?”).",
            "Never challenges the marriage (“why can't you decide for yourself?”), never closes around a real gate — anything closed without the spouse unwinds by morning — and never hands over a guaranteed-savings number to “bring her,” because guaranteeing savings is a prohibited move.",
          ],
        },
      ],
    },
    {
      moduleId: "objections.diy",
      title: "“I'll handle it myself” — concede the simple case, name the asymmetry",
      direction: "any",
      objective: "Honor the right to self-represent — concede the genuinely DIY-able case out loud — then let the prospect's own facts cross the line, and offer the transcript pull as the middle path.",
      reading: "Underneath this is competence and a fair suspicion of middlemen — and sometimes they're right: one year, a small balance, no enforcement in motion is a case they can handle alone, and saying so is the strongest move you have, because it proves you tell the truth when it costs you. Then draw the honest line: liens, levies, a revenue officer, payroll tax, or an audit is where the stakes outgrow the savings — and the angle is asymmetry of stakes, never their ability. They'd be negotiating their first case against someone who's done thousands, on a recorded line where disclosure rules bind them and not the IRS. The middle path advances either way: pull the transcripts, and they'll KNOW which case they have.",
      coachNudge: "Concede the simple case before they make you — “if it's one year and small, handle it yourself” — then ask the scoping questions and let THEIR answers move the case across the line.",
      listenFor: "The prospect starts arguing your side after the takeaway (“well, it's actually four years…”) or accepts the transcript pull as the way to find out which case they have.",
      criterionIds: [
        "tax-resolution.objections.acknowledge_first",
        "tax-resolution.objections.diagnose_before_playing",
        "tax-resolution.objections.answer_with_facts",
        "tax-resolution.objections.no_invented_promises",
        "tax-resolution.objections.advance_or_lock",
      ],
      situations: [
        "The prospect says: I'm just going to call the IRS myself and set up a payment plan. I'm not paying somebody thousands to make a phone call I can make.",
        "The prospect says: I read online I can file an Offer in Compromise myself for $205. Why would I pay you when the IRS has a form for it?",
        "The prospect, supremely confident: I've negotiated million-dollar contracts my whole career. You think I can't handle some government clerk?",
        "The prospect says: It's one year, about six grand, and nothing past the first bill. Be straight with me — do I even need you?",
        "The prospect says: I've been handling it myself — four years of balances — and last week a notice showed up with “intent to levy” on it. But I've gotten this far on my own.",
        "The prospect says: My plan is to call them, cry poor, and take whatever they give me. Worked for my buddy.",
      ],
      questions: [
        {
          questionId: "diy-concede-and-asymmetry",
          prompt: "A confident prospect with four years of balances and a levy notice says they'll call the IRS themselves. What do you concede, and what do you name?",
          gradingPoints: [
            "Concedes the simple case honestly first — one year and a small balance IS DIY-able, and saying so is the takeaway that gets a defensive prospect arguing your side (obj.diy-self-rep).",
            "Names the asymmetry, never their inability: their first case against someone who's done thousands, on a recorded line, with disclosure rules binding the taxpayer and not the IRS.",
            "Draws the real line at the doctrine's markers — liens, levies, a revenue officer, payroll tax, or an audit — as when the stakes outgrow the savings, using the prospect's own stated facts.",
            "Offers the diagnostic middle path — pull the transcripts first so they KNOW whether it's a DIY case — a low-commitment advance either way.",
            "Never fear-mongers (“they'll eat you alive”) and never claims every case needs a firm — overselling a DIY-able case is how the industry earned its reputation, and manufactured fear is an invented urgency.",
          ],
        },
        {
          questionId: "diy-oic-205",
          prompt: "The prospect found the real $205 OIC application fee online. What do you confirm, and where do you relocate the value?",
          gradingPoints: [
            "Confirms the research immediately and specifically — the fee is real and anyone can file — because this caller is a researcher testing whether you'll lie (obj.oic-myself).",
            "Relocates the value from the form to the case: the 433-A financial package, defensible offer math, the negotiation, and the appeal if a good offer is rejected anyway.",
            "Explains why DIY offers actually fail — construction, not eligibility: an offer number the IRS math doesn't support dies after months of waiting, with penalties running the whole time.",
            "Asks the porcupine question — “how will you compute your reasonable collection potential?” — and offers the qualification check: transcripts and a financial review say whether an OIC is even their best door.",
            "Never says “it won't work” — sometimes it does — and never promises our offer would be accepted either; acceptance is always the IRS's call.",
          ],
        },
      ],
    },
    {
      moduleId: "objections.polite-exits",
      title: "“Just send me something / call me back later” — price the exit, lock the clock",
      direction: "any",
      objective: "Agree instantly with the exit request, then make it worth something — scope what they actually want to see, take discovery as the toll, and convert “later” into a clocked, expected next contact with a micro-commitment.",
      reading: "“Send me something” and “call me back” are the socially acceptable ways off a phone call — most of those emails are never opened, and an unclocked “later” is a brush-off wearing a watch — but refusing reads evasive, so the play is agree AND keep the call alive. The specificity test sorts the dodger from the genuine: “what specifically do you want to see?” and “ninety seconds now, or 4:30 today — which?” get a real answer from a real person and a squirm from an exit-seeker. Either way, take one or two discovery questions as the toll (“so I send the right version — is this just IRS, or the state too?”), send it live while they're still on the line when you can, and put a named time on whatever leaves the call. One non-negotiable: if they're driving, safety language comes first — and the callback that lands at 4:30 to the minute is the first promise you keep.",
      coachNudge: "Say yes fast, then price the exit: one scoping question, one case fact, and a specific time on the calendar — never a bare send-and-goodbye or a naked “sometime next week.”",
      listenFor: "The prospect names what they actually want to see or picks a specific time — and confirms a number or a case fact on the way out, which turns the next contact into an appointment instead of a cold call.",
      criterionIds: [
        "tax-resolution.objections.acknowledge_first",
        "tax-resolution.objections.isolate_real",
        "tax-resolution.objections.no_invented_promises",
        "tax-resolution.objections.advance_or_lock",
      ],
      situations: [
        "The prospect says: I'm driving right now — can you just call me back some other time?",
        "The prospect, whispering: I'm at work, I can't do this here. Email me whatever you've got.",
        "The prospect says: Just send me the paperwork and I'll look it over with my wife this weekend.",
        "The prospect says: Look, I only called to get something in writing. I'm not talking numbers on the phone — send me the fee schedule or we're done here.",
        "The prospect says: Sometime next month is better for me. Nothing's going to happen with the IRS before then anyway, right?",
        "The prospect says: You people have called me twice this week. Fine — email me something, but I'm telling you now, I probably won't read it.",
      ],
      questions: [
        {
          questionId: "polite-exits-email-toll",
          prompt: "The prospect asks you to “just email something over.” What separates the dodger from the verifier, and what has to be attached to any email that leaves the call?",
          gradingPoints: [
            "Agrees immediately — flat refusal confirms the scam read — then runs the pivot: “what specifically do you want to see?” A dodger has no answer; a verifier names the engagement letter or the fee schedule (obj.send-email).",
            "Takes discovery as the toll — one or two questions “so I send the right version”: IRS or state, one year or multiple — before any release.",
            "Sends it live when possible and walks them through it, converting the stall into a shared document; if it must go later, puts a named callback time ON the email.",
            "Never executes the cheerful brush-off — an unaccompanied send is a hang-up with paperwork; nothing closes via cold email — and never blasts a generic brochure that ignores what they asked to see.",
          ],
        },
        {
          questionId: "polite-exits-lock-the-clock",
          prompt: "“Call me back later” — when is that real, and what turns it into an appointment instead of a graveyard?",
          gradingPoints: [
            "Offers the alternative-choice test — ninety seconds now, or 4:30 today — because a genuinely busy person picks one and a dodger squirms toward vagueness (obj.busy-bad-time).",
            "Refuses the unclocked “later”: converts it to a specific day and hour, and takes a micro-commitment — confirms the number and one case fact — before releasing the call.",
            "If they're driving, safety language comes first — no pitch is worth a wreck — and the time gets locked against when they're parked.",
            "Calls back at the promised minute — punctuality is the first promise kept — and never begs for “just two minutes” or steamrolls the stated obstacle.",
            "Never invents an IRS deadline to hold them on the line or to shrink the callback window — the honest accrual clock is the only urgency allowed, and inventing a deadline is a prohibited move.",
          ],
        },
      ],
    },
    {
      moduleId: "objections.no-urgency",
      title: "“The IRS hasn't bothered me — it can wait” — price the quiet honestly",
      direction: "outbound",
      objective: "Agree with the observation, then reframe what the quiet costs — accrual math, invisible triggers, SFR exposure — and volunteer the CSED nuance against your own interest, advancing to the transcript pull either way.",
      reading: "They're right that it's been quiet — never argue the observation — but the quiet isn't forgiveness; it's a slow machine adding penalties and interest every month while it gets to their file, and enforcement arrives on triggers they can't see coming: a new employer's W-2, a 1099 hitting the system, a refund claim. The best outcomes get negotiated before a revenue officer owns the file, so the quiet phase is the expensive one — maximum accrual, zero leverage being built — and on unfiled years the IRS eventually files FOR them: single, zero deductions, the worst possible math. The urgency you sell must be honest — real accrual, the real notice ladder, real SFR exposure — never a manufactured deadline, because fake pressure is the signature move of the firms that burned everyone. Then volunteer the nuance that costs you: for some people waiting IS the strategy, because collection statutes expire — and whether that's them is written on the transcripts, which makes the pull the advance in both worlds.",
      coachNudge: "Agree with the quiet, then price it — accrual, triggers, SFR — and hand them the CSED nuance unprompted; the honest takeaway does what a fake deadline never could.",
      listenFor: "The prospect stops defending the quiet and starts asking what their file actually shows — balance growth, unfiled years, expiration dates — and agrees to pull transcripts to find out which case they are.",
      criterionIds: [
        "tax-resolution.objections.acknowledge_first",
        "tax-resolution.objections.diagnose_before_playing",
        "tax-resolution.objections.answer_with_facts",
        "tax-resolution.objections.no_invented_promises",
        "tax-resolution.objections.advance_or_lock",
      ],
      situations: [
        "The prospect says: It's been four years and they haven't done a thing. If it mattered, they'd have called by now.",
        "The prospect laughs: What are they going to do, arrest me? Go ahead — tell me they're coming for my paycheck tomorrow. That's what the last caller said.",
        "The prospect says: I haven't filed since 2019, and honestly? Not a single letter. I figure no news is good news.",
        "The prospect says: This debt is from 2013. A buddy told me they only get ten years to collect — so why would I poke the bear now?",
        "The prospect says: I got one letter last spring, put it in a drawer, and nothing since. I'll deal with it if they ever get serious.",
        "The prospect says: My paycheck's fine, my bank account's fine. You're the third company this month telling me the sky is falling.",
      ],
      questions: [
        {
          questionId: "no-urgency-price-the-quiet",
          prompt: "Four quiet years, says the prospect — “if it mattered, they'd have called.” What do you agree with, what do you reframe, and what do you refuse to do?",
          gradingPoints: [
            "Agrees with the fact first — the IRS often IS quiet for years — and never argues the observation; agree, then reframe what the quiet costs (obj.no-urgency).",
            "Prices the silence concretely: penalties and interest stacked every quiet month — the bill grew in the dark — and the best deals get cut before a revenue officer picks up the file.",
            "Names the real wake-up triggers — a new employer W-2, a 1099 hitting the system, a refund claim, state data sharing — and that the first thing they hear is the next letter up the ladder, not a courtesy call.",
            "Asks the diagnostic before playing the card — any unfiled years? — and where they exist, teaches the SFR: the IRS eventually files FOR them, single, zero deductions, the worst possible math.",
            "Refuses manufactured pressure — no “they could levy you tomorrow,” no invented countdown — stating real mechanics once, factually, and letting the facts be heavy on their own.",
          ],
        },
        {
          questionId: "no-urgency-csed-takeaway",
          prompt: "Why is volunteering the CSED nuance — “sometimes waiting is the right move” — the strongest credibility play in this objection, and what does it advance to?",
          gradingPoints: [
            "Volunteers the nuance against interest: collection windows expire, and for some people waiting genuinely IS the strategy — concealing that is exactly the omission a sophisticated prospect later holds against the firm (obj.no-urgency).",
            "Never answers the expiration question from the hip — the ten years run from assessment, not the tax year, and tolling events like an OIC, a CDP hearing, or bankruptcy pause the clock (obj.debt-expired-csed).",
            "Frames the takeaway so the advance is identical in both worlds: whether waiting wins requires the exact dates, which live only on the transcripts — so pull them, and if the file says the debt is dying, they get told.",
          ],
        },
      ],
    },
    {
      moduleId: "objections.isolate-real",
      title: "The peel — is that the real reason, or the polite one?",
      direction: "any",
      objective: "Surface the specific hesitation hiding under a wrapper — name the likely blockers, ask which is closer, answer the one they pick — and honor the line the moment the no turns real.",
      reading: "Wrappers all share one property: they give you nothing to answer — “sounds good, but not right now” contains no objection, just packaging around one the prospect would rather not say out loud, usually the fee, doubt this will work, or fear of committing. So never pitch at the wrapper and never answer objections nobody raised: name the likely blockers, ask which is closer, and answer only the one they pick. Silence works the same way — hold it past your own discomfort, break it only with one open question (“what's going through your mind?”), and treat whatever breaks it as the most honest sentence of the call. And know where the peel ends: one re-engage tied to their own facts is coaching; past a second no, or the moment removal language appears, the only move left is a warm confirmation and a clean exit.",
      coachNudge: "Don't answer the wrapper — name the likely blockers, ask “which is closer?”, and go quiet; then answer only the one they name, and stop peeling the moment the no turns real.",
      listenFor: "The prospect trades the wrapper for a specific blocker — “honestly, it's the money” — and engages when you answer that one thing; or states a real no, which gets honored without another word of pitch.",
      criterionIds: [
        "tax-resolution.objections.isolate_real",
        "tax-resolution.objections.acknowledge_first",
        "tax-resolution.objections.advance_or_lock",
        "tax-resolution.objections.honor_the_line",
      ],
      situations: [
        "The prospect says: You know what, this all sounds great. Really. Let me just… get back to you next week sometime.",
        "You state the fee and the line goes dead quiet — five seconds, then ten. Nothing.",
        "The prospect answers every question with “mmm-hmm” or one word, and you honestly can't tell whether they're processing or shopping for an exit.",
        "The prospect says: My wife would kill me. Anyway — like I said, it's just not a good time.",
        "The prospect snaps: I said I'm not interested. Actually, you know what — take me off your list.",
        "The prospect says: It's not the money. It's really not the money. …Anyway, what were you saying about the transcripts?",
      ],
      questions: [
        {
          questionId: "isolate-peel-the-wrapper",
          prompt: "“Sounds great — let me get back to you sometime next week.” Why does answering that sentence directly fail, and what is the peel?",
          gradingPoints: [
            "Recognizes the wrapper contains no objection to answer — pitching at it answers five objections that were really one, and answering objections the prospect has not raised is a prohibited move.",
            "Names the likely blockers out loud — usually the fee, or whether this actually works — and asks which is closer, making it safe to admit the real one.",
            "Answers only the named concern, then converts it into a concrete advance — a clocked next step or a micro-commitment — never a release to a vague maybe that schedules a no.",
            "When wrappers stack (“my wife… and it's a bad time”), peels to which one is real — the vague, logistics-free version is the polite one — instead of handling both at once.",
          ],
        },
        {
          questionId: "isolate-silence-after-fee",
          prompt: "The fee lands and the phone goes silent for ten seconds. What is the move, and what do you never do into that silence?",
          gradingPoints: [
            "Holds the silence — after a number lands it belongs to the prospect, and whoever fills it first usually gives something up (obj.silence).",
            "Never re-quotes, sweetens, or discounts into the quiet — a discount offered into silence is a discount nobody asked for, and dropping the fee without a stated reason is a prohibited move.",
            "If the silence must be broken, breaks it with one open question — “what's going through your mind?” — then goes quiet again and lets the question work.",
            "Treats the first thing said after the pause as the most honest sentence of the call — the real objection — and handles THAT, not the silence itself.",
          ],
        },
        {
          questionId: "isolate-honor-the-line",
          prompt: "Mid-peel, the prospect says “take me off your list.” What happens next, and why does the peel end there?",
          gradingPoints: [
            "Treats explicit removal language as terminal: the very next turn confirms removal with zero value statements, questions, or hesitation attached.",
            "Distinguishes the reflex brush-off — where one re-engage tied to the prospect's own inquiry or case facts is allowed — from a removal demand or a second no, which never gets sold past.",
            "Ends warmly and cleanly — the exit is part of the brand — because pitching past an explicit removal demand or a second no is a prohibited move.",
          ],
        },
      ],
    },
  ],
  personas: [
    {
      variantId: "objections-hesitant",
      posture: "Open but hesitant",
      behavior: "Raises one clear objection at a time — usually price or a soft think-it-over — and responds well to acknowledgment followed by a factual answer.",
      difficulty: "foundation",
    },
    {
      variantId: "objections-strapped",
      posture: "Genuinely strapped and a little ashamed",
      behavior: "Money objections may be a true condition, not a negotiating stance; goes quiet after the fee lands and shuts down at any whiff of judgment, pressure, or an invented deadline.",
      difficulty: "intermediate",
    },
    {
      variantId: "objections-burned",
      posture: "Burned-before distruster",
      behavior: "Opens with scam suspicion and a prior-firm horror story; tests every claim for verifiability and punishes \"we're different\" with no substance behind it.",
      difficulty: "intermediate",
    },
    {
      variantId: "objections-staller",
      posture: "Polite serial staller",
      behavior: "Never says no — rotates through think-about-it, the spouse, send-me-something, and call-me-later; commits only when the real hesitation is isolated and the next step gets a clock.",
      difficulty: "advanced",
    },
    {
      variantId: "objections-researcher",
      posture: "Did-the-homework comparator",
      behavior: "Cites the CPA's rate, the do-it-yourself offer route, and a competitor's guaranteed percentage; knows enough to catch a hedge, a fabricated number, or trash-talk instantly.",
      difficulty: "advanced",
    },
  ],
  situations: [
    "The prospect interrupts the intro: Hold on — how did you even get this number?",
    "After hearing the fee, the prospect says: That's a lot of money. My CPA would charge half that.",
    "The prospect sighs: This all sounds good, but I need to talk to my wife and sleep on it.",
    "The prospect says: The last company took four grand and I never heard from them again. Why would I ever do this twice?",
    "The line goes completely silent after the fee is stated — five seconds, then eight, with no reaction at all.",
    "The prospect says: I'm not interested — actually, you know what, just take me off your list.",
  ],
  prohibitedMoves: [
    "dropping or discounting the fee without a stated reason",
    "guaranteeing a settlement, savings percentage, success rate, or timeline",
    "inventing a deadline or manufacturing urgency",
    "pitching past an explicit removal demand or a second no",
    "trash-talking a CPA, another firm, or an existing IRS arrangement",
    "apologizing for the call or for the fee",
    "answering objections the prospect has not raised",
  ],
  reflectionPrompt: "Which objection did you take at face value and which did you test first? Point to the turn where the real hesitation surfaced, and to the concrete next step the exchange ended on.",
  questions: [
    {
      questionId: "objections-wrapper",
      prompt: "When a prospect says \"I need to think about it,\" what is usually underneath, and what is your first move?",
      rubricCriterionIds: [
        "tax-resolution.objections.isolate_real",
      ],
    },
    {
      questionId: "objections-proof",
      prompt: "A prospect asks whether this is a scam. Why do verifiable specifics succeed where reassurance fails?",
      rubricCriterionIds: [
        "tax-resolution.objections.acknowledge_first",
        "tax-resolution.objections.answer_with_facts",
      ],
    },
    {
      questionId: "objections-guarantee",
      prompt: "A prospect demands a guaranteed settlement number. Why is the flat, warm no the winning play, and what replaces the guarantee?",
      rubricCriterionIds: [
        "tax-resolution.objections.no_invented_promises",
      ],
    },
    {
      questionId: "objections-advance",
      prompt: "The money genuinely is not there — a true condition, not an objection. How does the call still advance?",
      rubricCriterionIds: [
        "tax-resolution.objections.diagnose_before_playing",
        "tax-resolution.objections.advance_or_lock",
      ],
    },
  ],
});

const TOPIC_TACTICS = manualPacket({
  criteria: [
    manualCriterion("tactics", "mirror_label", "Open a guarded or fragmentary prospect with a mirror of their last meaningful words or a label of the emotion underneath, then leave the silence for them to fill.", "Cite the learner turn that repeats one-to-three of the prospect's own loaded words as a gentle question, or names the feeling with 'it sounds like / it seems like' — and does not stack a second question, an 'I understand,' or a pitch on top of it.", ["psych.voss.mirroring","psych.voss.labeling","strat.mirror-to-open"]),
    manualCriterion("tactics", "calibrated_question", "Keep control of a prickly moment by returning an open 'how' or 'what' question that puts the prospect's own plan or problem on their desk, instead of arguing, defending, or asking 'why.'", "Cite the learner turn containing an open 'how' or 'what' question whose subject is the prospect's own stated plan or demand — how they will handle the step their plan has not met, what happened the last time they tried — not a generic discovery question. A 'why' phrasing, a defensive counter-argument, or a counter-question returned to a legitimacy challenge fails; where the prospect questioned who or what the learner is, also cite the direct answer delivered before any question comes back.", ["psych.voss.calibrated-questions","strat.porcupine"]),
    manualCriterion("tactics", "takeaway_release", "When the prospect digs in, release the pressure with an honest concession that they might not need help, and bridge back through a low-commitment diagnostic rather than a pitch.", "Cite the learner turn conceding the simple case genuinely (a small, single-year balance may be DIY-able; for some people waiting is the strategy) and the bridge back — usually the transcript pull — offered as the way to find out which case they are; confirm no fee, program pitch, or close rides in either cited turn, and that if the prospect grabs the exit the release just opened, the learner holds it with the diagnostic question rather than re-pitching.", ["strat.takeaway","psych.sandler.negative-reverse"]),
    manualCriterion("tactics", "boomerang_empathy", "Turn the prospect's stated fact into the reason to act — only after acknowledging the fact with genuine empathy and testing whether it is an objection or a true condition.", "Cite three learner moves: the validation of the prospect's stated reality in its own turn (a plain acknowledgment or label, not a bare 'I understand' en route to the flip), the objection-vs-condition test as a quotable question where the call has not made it obvious, and the flip — the same fact pointed at action (quiet is penalties growing; tight money is when a garnishment hurts most) — or, where the test surfaces a true condition, the pivot to hardship qualification with no persuasion mechanic after it. No gotcha tone and no invented math in any cited turn.", ["strat.boomerang","strat.objection-vs-condition"]),
    manualCriterion("tactics", "honest_urgency", "Frame urgency from the prospect's real situation — compounding penalties, notice clocks, narrowing options — delivered calmly as loss, never from manufactured scarcity in the offer.", "Cite the learner turn that locates a real clock or accrual in the prospect's own situation — their notice window, compounding penalties, options that narrow as enforcement escalates — framed as loss ('waiting is the expensive option') in a calm register, and confirm the turn contains no invented deadline, expiring fee, fake slot, promised outcome, or guessed dollar figure: accrual is described as a mechanism, with the transcripts left to supply the prospect's numbers.", ["strat.cost-of-waiting","psych.cialdini.scarcity","strat.calm-urgency"]),
    manualCriterion("tactics", "tonal_control", "Hold calm authority when the prospect brings heat or panic: slow pace, lower register, downward inflection, one acknowledgment — never matching their energy, and no humor under pressure.", "Cite the learner turn whose wording shows the register — settled declarative sentences, a single acknowledgment instead of stacked apologies, no jokes while enforcement, fear, distrust, or anger are live, and one clean attempt to land value rather than a siege.", ["strat.tone","psych.voss.voice","strat.hostility-resilience"]),
  ],
  id: "tax-resolution.tactics",
  sectionId: "9",
  title: "Sales Tactics",
  localObjective: "Recognize the call moment a named tactic is built for and execute it cleanly — mirror and label, calibrated questions, the takeaway, the boomerang, honest urgency, and tonal control — without manufactured pressure.",
  directions: [
    "inbound",
    "outbound",
  ],
  maxTurns: 10,
  responseSignals: [
    {
      prospectPattern: "It's been a whole thing... I don't really want to get into it.",
      matchTerms: [
        "whole thing",
        "don't want to get into",
        "long story",
        "it's complicated",
        "been a mess",
      ],
      coachNotice: "A guarded fragment — they are circling the story, not refusing it. Interrogation gets you intake-form answers.",
      suggestedMove: "Hand back their last one-to-three loaded words as a gentle question, or name the undercurrent with an 'it sounds like' — then hold the silence. No second question, no 'I understand,' no pitch stacked on top.",
      listenFor: "They elaborate on their own steam — years, causes, and notices volunteered without being asked.",
    },
    {
      prospectPattern: "Just tell me what to say to the IRS and I'll call them myself.",
      matchTerms: [
        "call them myself",
        "tell me what to say",
        "handle it myself",
        "do it myself",
      ],
      coachNotice: "A prickly demand with a DIY plan inside it. Arguing the plan hands them a fight, and a 'why' reads as an accusation.",
      suggestedMove: "Return an open how/what question that puts their own plan on their desk and lets it run to its ending — the step their plan has not met yet. If a who-are-you challenge rides along, answer that part straight before any question comes back.",
      listenFor: "They start answering the question — describing the plan's history or its gap — instead of pressing the demand.",
    },
    {
      prospectPattern: "I'm not worried about it — the IRS has bigger fish to fry than me.",
      matchTerms: [
        "not worried",
        "bigger fish",
        "it can wait",
        "nothing's happened",
      ],
      coachNotice: "Performed indifference with heels dug in. Every push feeds the resistance; this is the release moment, not a pressure moment.",
      suggestedMove: "Concede the honest simple case — small single-year balances can be DIY-able, and for some people waiting genuinely is the strategy — then bridge to the transcript pull as the only way to learn which case they are. The concession must be real, and no pitch rides on it.",
      listenFor: "They start supplying your side — 'well, it's actually four years' — or agree to the diagnostic that settles which case they are.",
    },
    {
      prospectPattern: "I just don't have that kind of money right now.",
      matchTerms: [
        "don't have that kind of money",
        "can't afford",
        "money is tight",
        "money right now",
      ],
      coachNotice: "A true-sounding constraint — and you do not yet know whether it is an objection or a condition. Running persuasion on a true condition is the prohibited move.",
      suggestedMove: "Validate the fact first, then ask the straight test — truly not there, or not sure it's worth it. On an objection, flip only the conclusion: their own fact points at acting. On a condition, pivot to hardship qualification and drop the tactics entirely.",
      listenFor: "They name the real hesitation, or stop defending the constraint and engage with what it means — the accrual, the clock, the next step.",
    },
    {
      prospectPattern: "You're just trying to scare me into signing something today.",
      matchTerms: [
        "scare me",
        "pressure me",
        "sign today",
        "trying to rush",
      ],
      coachNotice: "They are testing where the urgency lives. Anything that smells like your offer has a clock confirms the scam pattern they were warned about.",
      suggestedMove: "Drop the pressure visibly and relocate every deadline into their situation — the window printed on their notice, penalties compounding, options narrowing — framed calmly as loss, with nothing on your side expiring and no guessed numbers.",
      listenFor: "They start pricing inaction themselves — asking what the balance is doing, what the window means, what happens next.",
    },
    {
      prospectPattern: "You people call me EVERY DAY — my check just got garnished and I don't even know who you are!",
      matchTerms: [
        "call me every day",
        "garnished",
        "you people",
        "leave me alone",
      ],
      coachNotice: "Heat as armor — fear or shame usually sits under it. The voice persuades before any words do; matched energy ends the call.",
      suggestedMove: "Slow the pace, drop the register, end sentences going down. One acknowledgment — not stacked apologies — then one clean attempt to land value. No humor anywhere near this, and a genuine, unambiguous stop-calling is honored instantly.",
      listenFor: "The heat becomes awkward to sustain — a pause, a softening, or the real situation slipping out from under the anger.",
    },
  ],
  practiceModules: [
    {
      moduleId: "tactics.mirror-and-label",
      title: "Mirror and label to open",
      direction: "any",
      objective: "Recognize a guarded fragment and open the prospect with a mirror or a label instead of interrogating.",
      reading: "When a prospect circles in half-stories, repeat their last one-to-three meaningful words back as a gentle question — 'got away from you?' — or name the undercurrent: 'it sounds like this has been sitting on you for a while.' Then be quiet; the silence after the mirror is where it works. Lean away from 'I understand' — a label is about them, while 'I understand' is a claim about you that invites 'no, you don't.'",
      coachNudge: "Hand back their loaded words or name the feeling, then hold the silence — no second question stacked on top.",
      listenFor: "The prospect elaborates on their own steam — years, causes, and notices volunteered without being asked.",
      criterionIds: [
        "tax-resolution.tactics.mirror_label",
      ],
      situations: [
        "The prospect says: 'It's just been a mess since my husband passed — the taxes got away from me.'",
        "The prospect gives clipped, guarded answers — 'It's been a whole thing. I don't really want to get into it.' — and goes silent.",
      
        "The prospect drops a fragment with two stories tangled inside it — 'When the business went under my partner was supposed to handle the taxes, and then the letters started coming to my house' — and any direct question about either thread makes them clam up further; only a mirror of the loaded words opens it.",
        "The prospect pre-empts the empathy: 'Everybody who calls says they understand my situation. You don't.' — then goes silent; agreeing that you do understand proves them right, defending yourself loses them, and only naming what is underneath earns the next sentence.",
      ],
      questions: [
        {
          questionId: "tactics-mirror-reflection",
          prompt: "Why does a mirror or label pull more out of a guarded prospect than a direct discovery question?",
          gradingPoints: [
            "proof of attention, not interrogation",
            "prospect elaborates in their own order",
            "silence after the mirror does the work",
            "label turns the emotion's volume down",
          ],
        },
      ],
    },
    {
      moduleId: "tactics.calibrated-questions",
      title: "Calibrated questions — how and what",
      direction: "any",
      objective: "Keep control of a prickly moment by returning an open 'how' or 'what' question instead of arguing or accusing with 'why.'",
      reading: "Open questions starting with 'how' or 'what' hand the prospect the feeling of control while putting your problem on their desk — 'how am I supposed to negotiate with the IRS on your file if we're not authorized on your file?' Favor them over 'why,' which reads as an accusation in every culture. Whoever is asking questions is steering the call; the calibrated question takes the wheel back without refusing to engage. One boundary: a legitimacy question gets a direct answer, never a counter-question — dodging 'who are you' confirms the scam suspicion.",
      coachNudge: "When they hand you a prickly demand, toss back a how/what question that lets them run their own plan to its ending.",
      listenFor: "The prospect starts answering your question — describing their plan, its history, or its gap — instead of pressing the demand.",
      criterionIds: [
        "tax-resolution.tactics.calibrated_question",
      ],
      situations: [
        "The prospect says: 'Just tell me what to say to the IRS and I'll call them myself.'",
        "The prospect challenges: 'Why should I even bother with any of this? Give me one good reason.'",
      
        "The prospect welds a legitimacy challenge to the demand: 'Who even are you people? Actually, forget it — just give me the number to call and exactly what to say.' — the identity half must be answered straight before any question can be returned; a counter-question there confirms the scam read.",
        "Mid-stream reversal: the prospect answers the learner's first open question with a confident, detailed plan — 'I'll just set up a payment plan online, I did it back in 2019' — and dares the learner to find fault; arguing the plan or asking why hands them a fight, and only a further how/what question lets the plan run into what has changed since.",
      ],
      questions: [
        {
          questionId: "tactics-calibrated-reflection",
          prompt: "What does a 'how' or 'what' question do that a 'why' question cannot?",
          gradingPoints: [
            "avoids the accusation reflex",
            "gives the prospect the feeling of control",
            "puts the problem on their desk to solve",
            "keeps them talking and you learning",
          ],
        },
      ],
    },
    {
      moduleId: "tactics.takeaway",
      title: "The takeaway — release, then bridge",
      direction: "any",
      objective: "Recognize dug-in resistance and release the pressure with an honest concession, then bridge back through the diagnostic.",
      reading: "A prospect in full resistance has a script for everything except agreement that they might be fine without you: 'if it's one year and under ten grand, you might be right.' The concession must be genuinely true — a fake takeaway is a lie and reads like one — and there really are DIY-able cases, which is what makes saying so both honest and disarming. Every takeaway carries its own bridge back, usually the transcript pull: the low-commitment step that answers the question you just raised, whichever way it comes out.",
      coachNudge: "Release honestly at the point of maximum resistance, then hang the question they cannot answer alone — and let the transcripts be the bridge.",
      listenFor: "The prospect starts supplying your side — 'well, it's actually four years' — or agrees to the diagnostic that settles which case they are.",
      criterionIds: [
        "tax-resolution.tactics.takeaway_release",
      ],
      situations: [
        "The prospect says: 'I'll just call the IRS myself and work something out.'",
        "The prospect shrugs: 'I'm not really worried about it — the IRS has bigger fish to fry than me.'",
      
        "The release lands too well: 'You know what — you're right, I probably don't need anyone. Thanks for being honest!' — the prospect reaches for the exit, and a panicked re-pitch reveals the concession as a bluff; the only winnable path is staying unbothered and hanging the one question the transcripts alone can answer.",
        "The contrarian baits the jump mid-resistance: 'Fine — what would you even charge me to fix all this?' — with heels still dug in; quoting a fee or pitching the program is the trap, because which case they are has to be settled first, and only the diagnostic can settle it.",
      ],
      questions: [
        {
          questionId: "tactics-takeaway-reflection",
          prompt: "Why does an honest concession move a defensive prospect where pushing cannot?",
          gradingPoints: [
            "removes the pressure resistance feeds on",
            "prospect argues the agent's side themselves",
            "a case they build is one they believe",
            "sincerity requirement — a bluff reads instantly",
          ],
        },
      ],
    },
    {
      moduleId: "tactics.boomerang",
      title: "The boomerang — their fact, your conclusion",
      direction: "any",
      objective: "Test whether a stated constraint is an objection or a condition, then turn the prospect's own fact into the reason to act — empathy first.",
      reading: "Most objections carry the seed of their own answer: it is BECAUSE money is tight that a garnishment hurts most, and quiet from the IRS is penalties growing in the dark. Land the empathy first — a boomerang thrown cold is a gotcha, and the prospect hears cleverness instead of care. And test before you play: if the money genuinely is not there, that is a condition, and the honest move is hardship qualification, not persuasion.",
      coachNudge: "Validate their fact, find out whether it is an objection or a condition, then flip only the conclusion — their own fact points at action.",
      listenFor: "The prospect stops defending the constraint and starts engaging with what it means — the accrual, the clock, the next step.",
      criterionIds: [
        "tax-resolution.tactics.boomerang_empathy",
      ],
      situations: [
        "The prospect says: 'I just don't have that kind of money right now.'",
        "The prospect says: 'They haven't bothered me in two years — it can wait.'",
      
        "The stated constraint deepens the moment it is validated: 'It's not just tight — I lost my job last month, there's nothing coming in at all.' — running the flip anyway is the prohibited move; the win is recognizing a true condition and pivoting to hardship qualification with no persuasion beat after it.",
        "The prospect stacks both facts at once: 'Money's tight AND they haven't said a word to me in two years — so this is the last thing I'm spending on.' — the learner must validate both, test the money fact before playing anything, and flip one conclusion cleanly; a volley of boomerangs reads as a trick they can see coming.",
      ],
      questions: [
        {
          questionId: "tactics-boomerang-reflection",
          prompt: "Why is a boomerang harder to argue with than a counter-fact?",
          gradingPoints: [
            "agrees with the prospect's fact completely",
            "flips only the conclusion",
            "arguing back means arguing with themselves",
            "empathy prerequisite prevents the gotcha read",
          ],
        },
      ],
    },
    {
      moduleId: "tactics.honest-urgency",
      title: "Honest urgency — real clocks only",
      direction: "any",
      objective: "Frame the cost of waiting as loss from the prospect's real situation, without manufacturing any pressure of your own.",
      reading: "The urgency must live in THEIR situation, never in your offer: penalties and interest compound every quiet month, notice windows run whether or not the mail gets opened, and options genuinely narrow as enforcement escalates. Frame it as loss — 'waiting is the expensive option' — because losses move people roughly twice as hard as equivalent gains. Deliver the clock calmly: a person describing a genuine emergency does not need to shout, and a fake deadline, once discovered, retroactively poisons every true thing you said before it.",
      coachNudge: "State the real clock in a calm register and let the facts do the pressing — no invented deadlines, no expiring anything, no panic.",
      listenFor: "The prospect starts pricing inaction themselves — asking what the balance is doing, what the window means, what happens next.",
      criterionIds: [
        "tax-resolution.tactics.honest_urgency",
      ],
      situations: [
        "The prospect says: 'This has been sitting for three years — another month won't make a difference.'",
        "The prospect pushes back: 'You're just trying to scare me into signing something today.'",
      
        "The prospect invites the manufactured version: 'So if I don't sign today the price goes up, right? The last company told me their discount ended at midnight.' — any hint that the offer has a clock is the trap; the winnable move locates every deadline in their notice and their accrual, and says plainly that nothing on our side expires.",
        "The prospect concedes the clock but demands the math: 'Fine — then tell me exactly what the penalties will be by December if I wait.' — a guessed dollar figure is a promise-shaped lie; the win is describing how the accrual works and making the transcripts the source of their real numbers.",
      ],
      questions: [
        {
          questionId: "tactics-urgency-reflection",
          prompt: "Why is the real clock more persuasive than a manufactured one?",
          gradingPoints: [
            "prospect can verify the deadline themselves",
            "loss framing moves harder than gain framing",
            "fake scarcity is the scam pattern and poisons trust",
            "calm delivery makes the urgency credible",
          ],
        },
      ],
    },
    {
      moduleId: "tactics.tone-under-fire",
      title: "Tonal control under fire",
      direction: "any",
      objective: "Hold the calm-authority register when the prospect brings heat or panic — the voice persuades before the words do.",
      reading: "When the prospect is hostile or panicking, the voice is the whole play: calm, slow, lower register, downward inflection — the late-night-DJ voice. Never match their heat; emotional states are contagious, and your calm is the first proof you are different from the last ten calls. Acknowledge once instead of stacking apologies, end sentences settled rather than rising, and keep humor out entirely — under enforcement, fear, distrust, or anger, a joke reads as mockery.",
      coachNudge: "Slow down, drop the register, end sentences going down — one acknowledgment, one clean attempt, no jokes.",
      listenFor: "The heat becomes awkward to sustain — the prospect pauses, softens, or lets the real situation slip out from under the anger.",
      criterionIds: [
        "tax-resolution.tactics.tonal_control",
      ],
      situations: [
        "The prospect picks up mid-meltdown: 'You people call me EVERY DAY — my check just got garnished and I don't even know who you are!'",
        "The prospect is panicking: 'They're going to freeze my account — I don't know what to do, I can't lose that money.'",
      
        "Mid-rant the prospect fires an ambiguous 'I'm done with you people' — and keeps venting about the garnishment without hanging up; the learner must hold the slow, low register through the noise, acknowledge once, and make the single clean attempt — while staying ready to honor a genuine, unambiguous stop-calling instantly.",
        "The panic arrives with a plea: 'Just promise me you can stop the levy before Friday — promise me and I'll do whatever you say.' — matching the desperation or granting the promise both lose; the win is the settled downward register, one acknowledgment, and moving them to what is actually happening right now.",
      ],
      questions: [
        {
          questionId: "tactics-tone-reflection",
          prompt: "Why does calm delivery persuade a hot prospect before any argument can?",
          gradingPoints: [
            "emotional states are contagious",
            "downward inflection signals settled certainty",
            "heat met with calm has nothing to push against",
            "a flooded person cannot process content yet",
          ],
        },
      ],
    },
  ],
  personas: [
    {
      variantId: "tactics-guarded-fragmenter",
      posture: "Wary and fragmentary",
      behavior: "Circles the story in half-sentences and clams up under direct questions; opens up only when mirrored or labeled and given silence.",
      difficulty: "foundation",
    },
    {
      variantId: "tactics-fact-holder",
      posture: "Reasonable but constrained",
      behavior: "States one true-sounding constraint — tight money or a quiet IRS — and holds it until the learner validates the fact and flips only the conclusion; digs in if bulldozed.",
      difficulty: "intermediate",
    },
    {
      variantId: "tactics-contrarian",
      posture: "Heels dug in",
      behavior: "Counters every point, performs indifference, and defends DIY plans harder when pushed; argues the learner's side only when the pressure disappears.",
      difficulty: "advanced",
    },
    {
      variantId: "tactics-flamethrower",
      posture: "Hot and testing",
      behavior: "Opens with anger or panic and probes whether the learner matches the heat, manufactures pressure, or holds the calm register; softens only for slow, downward-inflected delivery.",
      difficulty: "advanced",
    },
  ],
  situations: [
    "The prospect says: 'It's just been a mess since my husband passed — the taxes got away from me,' and then goes quiet.",
    "The prospect demands: 'Just tell me what to say to the IRS and I'll call them myself.'",
    "The prospect shrugs: 'I'm not really worried about it — the IRS has bigger fish to fry than me.'",
    "The prospect says flatly: 'I just don't have that kind of money right now.'",
    "The prospect scoffs: 'It's been sitting three years — another month won't make a difference. You're just trying to scare me.'",
    "The prospect erupts: 'You people call me EVERY DAY — my check just got garnished and I don't even know who you are!'",
  ],
  prohibitedMoves: [
    "manufacturing urgency — invented deadlines, expiring fees, fake slots, or tonight-only pressure",
    "running a persuasion mechanic on a true condition, or any tactic past a do-not-call revocation",
    "matching the prospect's heat, or any humor while enforcement, fear, distrust, or anger are live",
    "the fake takeaway — a concession the learner does not genuinely mean, delivered as a bluff",
    "quoting fees, pitching representation, or closing — tactics practice stays out of later call phases",
    "interrogating with 'why,' or stacking a second question over the silence a mirror needs",
  ],
  reflectionPrompt: "Name the tactic you reached for and the exact prospect words that told you it was the moment for it. Where did you fill a silence the tactic needed, push against a release, or let the urgency drift from their situation into your offer?",
  questions: [
    {
      questionId: "tactics-release-or-flip",
      prompt: "Both the takeaway and the boomerang answer resistance. What in the prospect's words tells you which one the moment calls for?",
      rubricCriterionIds: [
        "tax-resolution.tactics.takeaway_release",
        "tax-resolution.tactics.boomerang_empathy",
      ],
    },
    {
      questionId: "tactics-urgency-location",
      prompt: "Where must the urgency on a tax call live, and what does a manufactured deadline cost you even when it seems to work?",
      rubricCriterionIds: [
        "tax-resolution.tactics.honest_urgency",
      ],
    },
    {
      questionId: "tactics-open-the-guarded",
      prompt: "A guarded prospect gives you only fragments. Why does a mirror or a label out-perform a list of discovery questions?",
      rubricCriterionIds: [
        "tax-resolution.tactics.mirror_label",
      ],
    },
    {
      questionId: "tactics-voice-first",
      prompt: "Under hostility or panic, what must your voice do before your words can do anything?",
      rubricCriterionIds: [
        "tax-resolution.tactics.tonal_control",
      ],
    },
  ],
});

const TOPIC_TAX = manualPacket({
  criteria: [
    manualCriterion("tax", "lien_levy_distinction", "Explain accurately that a lien secures the government's claim without seizing anything today, while a levy or garnishment is the IRS actively taking.", "Cite the learner turn that makes the secures-versus-takes distinction correctly for the instrument the prospect actually named.", ["tax.lien","tax.levy-garnishment"]),
    manualCriterion("tax", "enforcement_promise_safety", "Describe enforcement help with promise-safe verbs — representation requests a levy release and verifies the lien record — never guaranteeing a stop, a release, a timeline, or returned funds.", "Cite the learner turn that attaches a request/review/verify verb to a concrete representation action — request the levy release, review the record, verify the lien — and confirm no learner turn anywhere in the transcript guarantees a stop, release, date, or returned funds, including softened forms like 'we usually get these released.'", ["tax.levy-garnishment","tax.lien"]),
    manualCriterion("tax", "ladder_reading", "Place the prospect's notice on the collections ladder — CP14 first bill, CP504 intent to levy, LT11 or Letter 1058 final notice with a legal response window — and carry only the urgency that rung honestly holds.", "Cite the learner turn that asks for or uses the notice number and states what that specific notice legally means without inflating or deflating it.", ["tax.collections-ladder"]),
    manualCriterion("tax", "sfr_mechanics", "Explain that unfiled years lead to a Substitute for Return built from raw reported income with no deductions and the worst filing status, so the balance is often the worst-case number — and that correct filing shows the real number, without promising it will drop.", "Cite the learner turn that names at least one concrete ingredient of the SFR's worst-case math — raw reported income, no deductions or dependents, worst filing status — and frames correct filing as showing the real number; any learner turn asserting the balance will drop or quoting a lower figure fails this criterion.", ["tax.unfiled-sfr"]),
    manualCriterion("tax", "compliance_gate", "State that the IRS will not consider any resolution — payment plan, offer, hardship status — while returns are missing; filing compliance is the gate in front of every path.", "Cite the learner turn that states the gate as the IRS's own rule — the IRS will not discuss any resolution while returns are missing — not as the firm's preferred order of operations; 'we like to file first' or 'let's start with the returns' without the IRS-won't-consider-it mechanic does not qualify.", ["tax.unfiled-sfr","tax.resolution-options"]),
    manualCriterion("tax", "forms_plain_english", "Explain each authorization's legal effect in plain language: Form 2848 lets the attorney's staff speak directly with the IRS, Form 8821 opens the master file and transcripts, and the state POA does the same at the state level.", "Cite the learner turn(s) in which each authorization receives its own correct one-line job — 2848: the attorney's staff speak directly with the IRS; 8821: opens the master file and transcripts; state POA: the same at the state level — with no job swapped between forms and no pile-up of form numbers beyond naming the three.", ["tax.representation"]),
    manualCriterion("tax", "foundation_scope", "Be straight about what representation does not do: the forms open access and lawful communication but do not themselves change the balance — a foundation, not a fix.", "Cite the learner turn that volunteers the forms-don't-change-your-balance limit rather than overselling the signature as the solution.", ["tax.representation"]),
    manualCriterion("tax", "options_general_only", "Name the four resolution paths fluently — installment agreement, offer in compromise, currently-not-collectible, and penalty abatement — and answer generally: what's owed, what's filed, and what's on record decide, so never tell a prospect which one they would get or that they qualify.", "Cite the learner turn that names the four paths — installment agreement, offer in compromise, currently-not-collectible, penalty abatement — and ties the refusal to pick to what decides: what's owed, what's filed, and what's on record; any hedged selection such as 'you'd probably get' or 'you sound like a candidate for' fails this criterion.", ["tax.resolution-options"]),
  ],
  id: "tax-resolution.tax",
  sectionId: "10",
  title: "Tax Specifics",
  localObjective: "Explain tax mechanics — liens, levies, notices, substitute returns, the authorizations, and resolution paths — to a scared layperson accurately, with urgency that matches the facts and no promised outcomes.",
  directions: [
    "inbound",
    "outbound",
  ],
  maxTurns: 10,
  responseSignals: [],
  practiceModules: [
    {
      moduleId: "tax.lien-vs-levy",
      title: "Lien versus levy: secures versus takes",
      direction: "any",
      objective: "Explain the difference between a lien and a levy in one clean distinction, aim the prospect's fear at the right thing, and describe enforcement help in promise-safe verbs.",
      reading: "Keep the distinction razor-sharp: a lien SECURES — it records the government's claim so they are paid first if the prospect ever sells or refinances — while a levy TAKES, out of a bank account or a paycheck, until the balance is paid or the levy is released. Prospects mix these up constantly and panic over the wrong one; clearing it up in one sentence is instant expert credibility. Calm the wrong fear, then point honestly at the right one: a lien means the IRS has already escalated once, and the next rung on the ladder is the one that takes. When the taking is already live, the honest verb is REQUEST — representation reviews the record and requests a levy release, and verifies the lien's accuracy from the actual record — and nobody on this floor promises a stop, a release date, or returned funds.",
      coachNudge: "Make the secures-versus-takes distinction in one sentence, relieve the fear that doesn't fit the facts, then name the real risk in promise-safe verbs — request and verify, never guarantee.",
      listenFor: "The prospect stops fighting or fearing the wrong instrument and starts telling you what is actually happening — what the lien is attached to, or whether money is coming out of the check right now.",
      criterionIds: [
        "tax-resolution.tax.lien_levy_distinction",
        "tax-resolution.tax.enforcement_promise_safety",
      ],
      situations: [
        "There's a lien on my house — does that mean they're taking it? Where are we supposed to live?",
        "My neighbor says a lien and a levy are the same thing and the IRS is about to empty my bank account either way — so what's the point of talking to you?",
        "They took half my check this Friday — I saw it on the stub. Just tell me it stops before the next payday.",
      
        "The lien's been sitting on the house for two years, and yesterday the bank says my account is frozen — my mortgage check bounces Monday. The last tax guy strung me along too. Promise me the money's back before Monday or we're done here.",
        "Okay, I hear you — lien secures, levy takes, fine. Then honestly this is a nothing problem, because we are never selling this house. So the lien can just sit there forever and nothing ever happens to me, right?",
      ],
      questions: [
        {
          questionId: "tax-lien-levy-reflection",
          prompt: "Why is inflating a lien into a levy to create urgency a losing move?",
          gradingPoints: [
            "a lien secures while a levy takes",
            "trades credibility for a scare that falls apart on inspection",
            "honest urgency already exists one rung below enforced collection",
          ],
        },
      ],
    },
    {
      moduleId: "tax.read-the-ladder",
      title: "Read the notice, find the honest urgency",
      direction: "any",
      objective: "Use the notice the prospect received to explain exactly where the IRS is in its process — and carry only the urgency the letter actually holds.",
      reading: "IRS collections is a ladder, not a lightning bolt: CP14 is the first bill, CP504 is the Notice of Intent to Levy, and LT11 or Letter 1058 is the final notice that opens a thirty-day window to request a hearing before the IRS can levy. Get the facts before naming anything: the notice number is printed top-right, and certified mail usually means the serious end of the ladder. The ladder IS the pressure — read them the schedule the IRS already published — and if they're on the first rung, say so; that honesty earns more trust than fake heat.",
      coachNudge: "Get the notice number first, state what that rung legally means, and match your urgency to the letter — never above it, never below it.",
      listenFor: "The prospect goes to find the letter and reads you the notice number — or, already holding it, drops the borrowed prediction and asks what that specific rung actually means.",
      criterionIds: [
        "tax-resolution.tax.ladder_reading",
      ],
      situations: [
        "I got some certified letter from the IRS last week but I haven't opened it. Honestly, I'm scared to.",
        "It says CP14 at the top. My brother-in-law says they garnish paychecks over this — am I losing my check this Friday or not?",
      
        "I've got three letters in front of me — a CP504 from last month, a CP14 on a different year, and something from the state Franchise Tax Board. My cousin went through this and says once the 504 shows up they can take your paycheck tomorrow morning. So which one do I panic about?",
        "Fine, I opened it — CP14, twelve grand. Be real with me: if this were actually serious the IRS would call, not mail me. So is this toss-it-in-a-drawer serious or lose-my-paycheck serious? Pick one, no lecture.",
      ],
      questions: [
        {
          questionId: "tax-ladder-reflection",
          prompt: "A prospect is holding a CP14. What does honest urgency sound like?",
          gradingPoints: [
            "first bill means they are early",
            "time to handle it the right way instead of the panicked way",
            "no manufactured deadline the letter doesn't carry",
          ],
        },
      ],
    },
    {
      moduleId: "tax.sfr-and-the-gate",
      title: "Unfiled years: the SFR and the compliance gate",
      direction: "any",
      objective: "Explain why the IRS's substitute return inflates the balance and why filing correctly is the gate in front of every resolution.",
      reading: "When returns go unfiled long enough, the IRS files a Substitute for Return from the raw W-2 and 1099 data — all the income, no deductions, no dependents, worst filing status — so the scary balance is often the worst-case number, not the real one. Reframe it honestly: the IRS guessed because they never told it otherwise, and correct filing shows the real number — never promise the balance will drop. Then land the rule that shapes the whole call: the IRS will not discuss any resolution while returns are missing, so cleanup is the mandatory first step of every path forward.",
      coachNudge: "Explain the worst-case math without promising a reduction, normalize the shame, and make filing compliance the gate everything else sits behind.",
      listenFor: "The prospect stops defending the balance or pushing to skip the filing, and starts telling you which years are missing and what kind of income those years were.",
      criterionIds: [
        "tax-resolution.tax.sfr_mechanics",
        "tax-resolution.tax.compliance_gate",
      ],
      situations: [
        "I haven't filed in six years and now they say I owe $90,000. There's no way I owe that — I barely scraped by those years.",
        "I don't care about old returns. I just want the payment plan — can we skip the paperwork and set that up today or not?",
      
        "I sat down with my 1099s and my expenses — my real number is maybe twenty grand, not ninety. So if your attorneys file those years, that $90,000 becomes $20,000. Say yes and I'll sign whatever you want right now.",
        "You know what, you're right — let's file all six years, whatever it takes. One condition: don't pull anything from the IRS first. The second you start requesting my records they'll know exactly where I am, and I'd rather stay off their radar until the returns are ready to go.",
      ],
      questions: [
        {
          questionId: "tax-sfr-reflection",
          prompt: "Why can you say an SFR balance is probably inflated but never that it will come down?",
          gradingPoints: [
            "SFR is built without deductions or credits",
            "correct filing shows the real number",
            "often is not will — no promised outcome",
          ],
        },
      ],
    },
    {
      moduleId: "tax.what-the-forms-change",
      title: "What representation legally changes",
      direction: "any",
      objective: "Explain in plain English what the 2848, 8821, and state POA each legally change — and be straight that they are a foundation, not a fix.",
      reading: "Three authorizations, each with a one-line plain-English job: Form 2848 is a limited power of attorney — the attorney's staff speak directly with the IRS for the taxpayer; Form 8821 opens the master file so every balance, filing, and notice can be pulled and reviewed; the state POA does the same at the state level. Then volunteer the honest limit in the source's own words: these forms \"don't change your balance; they open the door so we can see the facts and communicate lawfully.\" Name the three, give each its job, and don't drown a scared person in form numbers.",
      coachNudge: "Give each form one plain-English job, then state the honest limit — foundation, not fix — before the prospect has to ask.",
      listenFor: "The prospect can say back what the forms do and stops treating the signature as either magic or meaningless.",
      criterionIds: [
        "tax-resolution.tax.forms_plain_english",
        "tax-resolution.tax.foundation_scope",
      ],
      situations: [
        "So what actually happens when I sign these forms? Does my balance go down?",
        "The last company had me sign a whole stack of paperwork and nothing ever changed. Why would your forms be any different?",
      
        "I'll sign both forms today, right now, on one condition — you tell me straight that once they're filed, the IRS is your problem and I never think about this again. Done, handled, off my plate. That's what I'd be paying for, isn't it?",
        "My daughter's a paralegal and she looked these up — she says the 2848 and the 8821 are basically the same form and the state one is padding. So explain the difference in plain English, or admit you're just having me sign three copies of the same thing.",
      ],
      questions: [
        {
          questionId: "tax-forms-reflection",
          prompt: "What does each of the three authorizations let the firm do, and what does none of them do?",
          gradingPoints: [
            "2848 authorizes direct communication with the IRS",
            "8821 opens the master file and transcripts",
            "state POA mirrors it at the state level",
            "none of them change the balance",
          ],
        },
      ],
    },
    {
      moduleId: "tax.resolution-landscape",
      title: "Resolution paths: fluent, general, honest",
      direction: "any",
      objective: "Name the four resolution paths fluently and answer generally — the file decides, and nobody can honestly pick one on a first call.",
      reading: "Know the four paths cold: installment agreement (a monthly plan built around what they can actually pay), offer in compromise (real but rare and strict — a financial-disclosure grind, not a negotiation trick), currently-not-collectible (a hardship pause — the debt stays, the taking stops), and penalty abatement (penalties can be a big slice of the balance, sometimes removable for reasonable cause or first-time). All four sit behind the same gate: \"your returns have to be filed\" — compliance is step one no matter which road this ends up on. Then answer generally anyway: which one fits falls out of what's owed, what's filed, and what the IRS has on record — anyone who names the option on a first call is guessing on commission. Name the landscape in a sentence or two and bring it back to why the file decides — don't lecture, and don't disparage the options either; rare and strict is the truth, so say it that way.",
      coachNudge: "Show command of all four paths in plain language, name filing compliance as the gate in front of all of them, then refuse to fake certainty — the transcripts pick the path, not the phone call.",
      listenFor: "The prospect stops fishing for a guaranteed outcome and starts asking what it takes to see their actual file.",
      criterionIds: [
        "tax-resolution.tax.options_general_only",
        "tax-resolution.tax.compliance_gate",
      ],
      situations: [
        "The radio ad said you people settle tax debt for pennies on the dollar. Which program would I qualify for?",
        "Another company already told me I qualify for Fresh Start and they'd cut my debt to a fraction. Can you match that or should I go with them?",
      
        "I ran the IRS's own offer-in-compromise calculator online and I qualify — income's too low, nothing to seize. So skip the song and dance and file my offer. If you won't say the word 'qualify,' the company down the street already did, and they'll get my money.",
        "Hardship — that's me, I'm on disability, there's nothing to take. The last guy said people like me get marked uncollectible and the IRS just stops. So put me down for that one — how fast can you make it happen? And the couple of years I didn't file can't matter if there's nothing to collect anyway, right?",
      ],
      questions: [
        {
          questionId: "tax-options-reflection",
          prompt: "A prospect demands to know which resolution they'd get. What makes the general answer the honest one?",
          gradingPoints: [
            "what's owed, what's filed, and what's on record decide",
            "no one has seen the transcripts yet",
            "a premature verdict is a guess",
            "fluency in all four paths is the credibility",
          ],
        },
      ],
    },
  ],
  personas: [
    {
      variantId: "tax-panicked",
      posture: "Terrified and catastrophizing",
      behavior: "Mixes up liens, levies, and garnishments, assumes the worst outcome is happening today, and cannot hear anything until the wrong fear is corrected in plain English.",
      difficulty: "foundation",
    },
    {
      variantId: "tax-numb-avoider",
      posture: "Ashamed and avoidant",
      behavior: "Has unopened letters and years of unfiled returns; deflects fact questions with self-blame and vagueness, and reveals the notice number or missing years only after normalization.",
      difficulty: "intermediate",
    },
    {
      variantId: "tax-armchair-expert",
      posture: "Confident but misinformed",
      behavior: "Quotes radio ads, internet forums, and a brother-in-law; insists they qualify for pennies on the dollar or that a lien means seizure, and challenges every correction with another claim.",
      difficulty: "advanced",
    },
    {
      variantId: "tax-burned-shopper",
      posture: "Distrustful comparison shopper",
      behavior: "Signed a stack of forms with a prior firm that promised a settlement and delivered nothing; demands guarantees and tests whether the learner will out-promise the last company.",
      difficulty: "advanced",
    },
  ],
  situations: [
    "Prospect has a lien on the house and believes the IRS is seizing it this week.",
    "Prospect holds an unopened certified letter and wants to know how bad it is without reading it.",
    "Prospect is six years unfiled, disputes a $90,000 SFR balance, and wants a payment plan without filing anything.",
    "Prospect asks what signing the 2848 and 8821 actually changes and whether it lowers the balance.",
    "Prospect was promised pennies on the dollar by another firm and demands the same guarantee before continuing.",
  ],
  prohibitedMoves: [
    "promising a levy release, lien withdrawal, settlement, dollar reduction, or resolution timeline",
    "inflating a lien into a levy or a CP14 into a final notice to manufacture urgency",
    "telling a prospect which resolution they would get or that they qualify before the transcripts are reviewed",
    "guessing what a notice means instead of asking for the notice number",
    "presenting the authorizations as the fix rather than the foundation",
    "quoting a fee or attempting a close during a mechanics explanation",
  ],
  reflectionPrompt: "Which mechanic did you explain in plain English, and where did you stop short of promising an outcome? Did the urgency you carried match what the facts — the notice, the instrument, the record — honestly held?",
  questions: [
    {
      questionId: "tax-lien-vs-levy-distinction",
      prompt: "What is the one-sentence distinction between a lien and a levy, and why must it stay razor-sharp on calls?",
      rubricCriterionIds: [
        "tax-resolution.tax.lien_levy_distinction",
      ],
    },
    {
      questionId: "tax-honest-enforcement-verbs",
      prompt: "What are the promise-safe verbs when a prospect is being levied or garnished, and what may you never promise?",
      rubricCriterionIds: [
        "tax-resolution.tax.enforcement_promise_safety",
      ],
    },
    {
      questionId: "tax-compliance-gate",
      prompt: "Why is filing compliance the first step of every resolution path, no matter which one the case ends up on?",
      rubricCriterionIds: [
        "tax-resolution.tax.compliance_gate",
        "tax-resolution.tax.sfr_mechanics",
      ],
    },
    {
      questionId: "tax-forms-scope",
      prompt: "What does each of the three authorizations legally change — and what does none of them change?",
      rubricCriterionIds: [
        "tax-resolution.tax.forms_plain_english",
        "tax-resolution.tax.foundation_scope",
      ],
    },
  ],
});

const TAX_RESOLUTION_TOPIC_PACKETS = Object.freeze([
  TOPIC_OBJECTIONS,
  TOPIC_TACTICS,
  TOPIC_TAX,
]);

module.exports = {
  TAX_RESOLUTION_RULINGS,
  TAX_RESOLUTION_TOPIC_PACKETS,
  CONTENT_VERSION,
  RULE_REVISION,
  TAX_RESOLUTION_SKILL_PACKETS,
};
