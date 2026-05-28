# Case Pitch Prep Tool

## Intent

Build an internal tool where an agent enters a Logics case ID and gets a pitch-prep packet:

- what is valid to pitch based on the client facts and documents
- payment and invoice posture
- current client temperature from activities and payment behavior
- key document snippets that explain why the pitch is appropriate
- a suggested approach, not a canned script

This should reuse the same architecture as the Logics activity-review/dispatch model: gather case facts, gather recent activity, run deterministic guards first, then ask AI to summarize risk and opportunity. The initial product should be read-only and agent-facing. Later it can become an input to client text/email dispatch, but it should not send anything automatically until we trust the review output.

## User Flow

1. Agent opens Pitch Prep.
2. Agent selects database (`TAG`, `WYNN`, `AMITY`) and enters a case ID.
3. Backend builds a case packet from Logics, payment history, activities, invoices, and known documents.
4. Backend optionally reads attached source documents: tax organizer, wage and income transcript, Lexis file, notices, and any uploaded supporting docs.
5. AI produces a structured prep packet:
   - client temperature
   - collection urgency
   - payment posture
   - document-backed pitch angles
   - invalid or risky pitch angles to avoid
   - recommended opener and discovery questions
   - evidence snippets with document/source references
6. Agent reviews the packet before a call or follow-up.

## Existing Code To Reuse

### Logics Case Data

- `packages/shared-services/src/logicsFacadeService.js`
  - `createLogicsFacade(domain)`
  - `fetchCaseInfo(caseId)`
  - `fetchBillingSummary(caseId)`
  - `fetchInvoices(caseId)`
  - `fetchActivities(caseId)`
  - `fetchTasks(caseId)` if task context matters later

- `packages/shared-services/src/logicsActivityReviewService.js`
  - current notice/suspended detection
  - activity temperature rules
  - case enrichment pattern for billing/invoices/activity context
  - good reference for how to collapse activity signals into a CSV/report shape

- `packages/shared-services/src/activityAiReviewService.js`
  - `reviewCaseActivities(domain, caseId, options)`
  - already persists an AI contact-safety read to `ActivityAiReview` and `CaseProfile`
  - useful baseline for "should we contact this person" and negative activity flags

- `packages/shared-services/src/contactEligibilityService.js`
  - consumes AI activity review status for outbound contact safety
  - later dispatch/texting should keep using this gate

### Payment And Case Profile Context

- `packages/shared-services/src/caseProfilePaymentSyncService.js`
  - useful for the current payment-field model

- `packages/shared-repositories/src/paymentLedgerRepository.js`
  - persisted payment records if we need history beyond Logics billing summary

- `packages/shared-repositories/src/caseProfileRepository.js`
  - existing place to cache computed case-level facts and AI review summaries

### Documents

- `packages/shared-integrations/src/googleDriveClient.js`
  - Drive search/list/download primitives
  - can download tax organizers, WIT files, Lexis files, and archived source docs once file IDs/folders are known

- `packages/shared-services/src/recordingStorageService.js`
  - reference pattern for Drive config and archive metadata

- `apps/control-plane/src/routes/readCx.js`
  - existing Drive-backed listing/playback pattern
  - useful for authenticated Drive proxy design and permission checks

- `scripts/archive-eod-recordings.js`
  - good example of Drive-side idempotency and appProperties metadata

### Tax Resolution / Coach Knowledge

- `packages/shared-services/src/taxResolutionSalesTrainerPrompt.md`
  - existing tax-resolution pitch/coaching language and mistake taxonomy
  - should be mined for pitch-prep categories, objection handling, and "do not say" rules

- `packages/shared-services/src/taxResolutionSalesTrainerService.js`
  - existing model-client patterns, structured output patterns, and prompt conventions

## Proposed New Backend Shape

Create a dedicated shared service:

`packages/shared-services/src/casePitchPrepService.js`

Primary public functions:

- `buildCasePitchPrep(domain, caseId, options)`
- `buildCasePitchPrepPacket(rawContext, options)`
- `extractPitchEvidenceFromDocuments(documents, options)`
- `evaluatePitchAngles(context, evidence, options)`

Suggested result shape:

```js
{
  ok: true,
  domain: "TAG",
  caseId: 47685,
  generatedAt: "...",
  case: {
    name,
    statusName,
    statusTier,
    taxLiability,
    saleDate,
    assignedTo,
  },
  money: {
    totalFees,
    paidAmount,
    balance,
    amountDue,
    pastDue,
    invoiceCount,
    paymentTrend,
    paymentRisk,
  },
  activityRead: {
    status,
    confidence,
    recommendedAction,
    riskFlags,
    evidence,
  },
  documents: [
    {
      sourceType: "tax_organizer|wit|lexis|notice|other",
      name,
      fileId,
      extractedTextAvailable: true,
      keySnippets: [],
      warnings: [],
    },
  ],
  pitchAngles: [
    {
      key,
      label,
      confidence,
      valid: true,
      why,
      evidenceSnippets: [],
      suggestedLanguage,
      avoidSaying,
    },
  ],
  opener,
  discoveryQuestions: [],
  avoid: [],
}
```

## AI Responsibilities

Keep the AI output structured and auditable. It should not invent eligibility. It should only make a pitch angle valid when it can point to a case fact, activity, payment signal, or document snippet.

Suggested model passes:

1. **Context compression**
   - Input: Logics activities, case info, payments, invoices.
   - Output: concise case facts, temperature, risks, "do not contact" concerns.
   - Existing reference: `activityAiReviewService.js`.

2. **Document evidence extraction**
   - Input: tax organizer/WIT/Lexis/notice text.
   - Output: snippets and normalized facts: filing gaps, income sources, levy/lien/notice types, business indicators, payroll issues, state/federal split.

3. **Pitch strategy**
   - Input: compressed case facts + document evidence + trainer knowledge.
   - Output: valid pitch angles, opener, next-best questions, avoid list.

For first implementation, passes 1 and 3 can be one call after deterministic context assembly. Document extraction can be added once file discovery and OCR/text extraction are stable.

## UI Placement

Add this as an admin/workspace tool, not a CX dialer dependency at first.

Suggested frontend location:

- `apps/web-client/src/workspaces/review` or a new `apps/web-client/src/workspaces/pitch-prep`
- `apps/web-client/src/app/workspaceRegistry.ts` for navigation
- API query wrapper in `apps/web-client/src/lib/api/queries/pitchPrep.ts`

Suggested backend route:

- `apps/control-plane/src/routes/readPitchPrep.js`
- Mounted under `/api/read/pitch-prep/:domain/:caseId`

Use admin auth initially. Later, if agents use it directly, restrict rows by domain and role.

## Persistence

Do not recompute heavy AI on every screen refresh.

Add a repository/model later if needed:

- `casePitchPrepRepository`
- collection: `casepitchpreps`
- key: `{ domain, caseId, inputHash, promptVersion }`
- store generated packet, source document IDs, and model metadata

This mirrors the `ActivityAiReview` idea: a durable read that can power both the UI and future dispatch decisions.

## Document Discovery Plan

Start narrow and explicit:

- Use Logics activities to find "New document has been uploaded" activity rows.
- Extract document names using the same logic in `logicsActivityReviewService.js`.
- Classify document names:
  - tax organizer
  - WIT / wage and income transcript
  - Lexis
  - IRS/state notice
  - POA / tax analysis / soft pull are usually background context, not pitch evidence
- If Logics file download is not available, use Drive folders as the first stable source once those files are mirrored.

Open item: identify the canonical storage location for tax organizer/WIT/Lexis files. The Drive recording-library pattern is useful, but case document lookup needs its own folder conventions or metadata.

## Safety Rules

- Never present a pitch angle without evidence.
- Separate "valid to mention" from "valid to sell."
- Keep "avoid saying" visible when there are payment problems, legal-risk activities, stop-contact language, attorney representation, wrong-person signals, or hostile notes.
- Respect `contactEligibilityService` before this ever becomes a send-message feature.
- Do not let the tool auto-text or auto-email from this packet until it has been reviewed in read-only mode.

## Phases

### Phase 1: Read-only Case Packet

- Backend service reads Logics case, billing, invoices, activities.
- Reuses activity AI review.
- Produces temperature, payment posture, and suggested prep without document extraction.
- UI has a case ID search and packet display.

### Phase 2: Document Evidence

- Add document discovery and text extraction.
- Add snippets to pitch angles.
- Add invalid pitch-angle detection when documents contradict the pitch.

### Phase 3: Reusable Dispatch Backbone

- Persist pitch/contact reads.
- Add review queues for "notice happened" or "payment missed."
- Keep messages draft-only.
- Human approves before any contact.

### Phase 4: Controlled Automation

- Only after review accuracy is proven:
  - event triggers create draft contact recommendations
  - contact eligibility blocks unsafe cases
  - approved templates send via existing outbound channels

## Implementation Notes For Later

- Keep this separate from the live coach. The live coach is call-time tactical help; pitch prep is pre-call case intelligence.
- Use the same structured-output discipline as the trainer service.
- Start with a deterministic context packet before AI. The AI should judge from known facts, not retrieve on its own.
- Add prompt versioning from day one.
- For cost control, cache by input hash and expire on new payment/activity/document events.

