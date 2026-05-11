# CX Document Transmission V2

## Purpose

Replace the low-value "Recent Activity" sales panel with a document transmission workspace that helps an agent send the right document packet from the active case context.

This is a V2 project. It should not block CX dialing, disposition, cadence, or queue hardening.

## Product Shape

The right-side CX utility panel should become a simple document action surface for the currently selected case.

Primary actions:

- Send Service Agreement
- Send Form 2848
- Send Form 8821
- Send Document Request
- Send Engagement Packet

Each action should clearly show whether the selected case has enough data to send. Missing required fields should be shown as a small checklist, not as a generic failure.

The panel should also show a compact document history:

- document type
- recipient
- status
- sent by
- sent at
- completed at
- resend/view controls where appropriate

## Why This Replaces Recent Activity

The current recent activity feed is operationally useful for engineering and audit work, but it is not useful enough for a sales agent during a live call. A sales agent needs next actions, not database noise.

Document transmission is better suited to that space because it supports the live call/deal moment:

- send a service agreement while the client is engaged
- send authorization forms without leaving CX
- track whether the client opened/signed/completed
- attach the document event back to the case profile

## Data Flow

1. Agent selects or receives a CX lead.
2. CX resolves the active domain and case id.
3. Backend builds a document context from the selected database:
   - domain
   - case id
   - client name
   - email
   - phone
   - address
   - spouse fields when present
   - assigned settlement officer / sales rep
   - invoice or deal fields when applicable
4. Agent chooses a document type.
5. Backend creates a DocuSign envelope from a configured template.
6. Backend writes a document transmission record.
7. DocuSign webhook updates envelope status.
8. Completed PDF and certificate are archived and linked to the case profile.

## Backend Components

Suggested modules:

- `documentTemplateCatalogService`
- `documentEnvelopeService`
- `docusignClient`
- `documentTransmissionRepository`
- `documentWebhookService`

Suggested API endpoints:

- `GET /api/cx/cases/:domain/:caseId/documents/context`
- `GET /api/cx/documents/templates`
- `POST /api/cx/cases/:domain/:caseId/documents/send`
- `GET /api/cx/cases/:domain/:caseId/documents`
- `POST /api/webhooks/docusign`

## Data Model

Suggested collection: `DocumentTransmission`

Fields:

- `domain`
- `caseId`
- `documentType`
- `templateId`
- `templateName`
- `envelopeId`
- `status`
- `recipientName`
- `recipientEmail`
- `sentByUserId`
- `sentByEmail`
- `sentAt`
- `viewedAt`
- `completedAt`
- `declinedAt`
- `voidedAt`
- `lastWebhookAt`
- `archive`
  - `signedPdfUri`
  - `certificateUri`
  - `storageProvider`
- `payloadSnapshot`
- `error`

## DocuSign Requirements

Needed before implementation:

- DocuSign account mode: sandbox or production
- OAuth strategy: JWT app auth or auth-code user consent
- integration key
- account id
- base path
- private key / secret handling plan
- webhook signing secret or validation method
- template ids for each packet
- template role names
- tab names for all required merge fields

## Template Mapping

Each template should declare:

- `documentType`
- `templateId`
- `roleName`
- `recipientSource`
- required case fields
- optional case fields
- tab mapping
- default email subject
- default email body

Example shape:

```json
{
  "documentType": "form-2848",
  "templateId": "DOCUSIGN_TEMPLATE_ID",
  "roleName": "Client",
  "requiredFields": ["firstName", "lastName", "email", "caseId"],
  "tabs": {
    "ClientName": "client.fullName",
    "ClientEmail": "client.email",
    "CaseId": "case.caseId"
  }
}
```

## UX Notes

The sales UI should stay minimal:

- no audit feed
- no raw webhook log
- no envelope JSON
- no admin terminology

Recommended panel layout:

1. Active case identity line: `WYNN 123456`
2. Document buttons
3. Missing-field checklist when needed
4. Recent document statuses

Status labels should be plain:

- Ready
- Sent
- Viewed
- Signed
- Completed
- Declined
- Failed

## Relationship To Post Dates

Post dates should become queue work later, not part of the document panel.

Future CX queue additions can include:

- My post dates
- Team post dates
- Today's callbacks
- Follow-up promises
- Deal processing handoff

Those belong in serving/queue logic because the agent action is to call or continue a sales workflow. Document transmission belongs in the utility panel because the agent action is to send or track paperwork.

## Phased Plan

Phase 1: internal skeleton

- add document catalog config
- add document transmission model/repository
- add mocked send endpoint
- replace Recent Activity with document panel UI
- write records with `status: draft_mocked`

Phase 2: DocuSign sandbox

- connect DocuSign sandbox credentials
- send one Service Agreement template
- store envelope id and status
- add webhook status updates

Phase 3: production packets

- add 2848, 8821, Service Agreement, Document Request
- validate required fields per packet
- archive completed PDFs/certificates
- link document records to case profile communications

Phase 4: operational polish

- resend flow
- void envelope flow
- admin template status page
- alert on failed webhook/archive
- optional Logics document upload if the API supports it cleanly

## Open Questions

- Which documents are required for day-one sales?
- Are Wynn and TAG using the same DocuSign account or separate accounts?
- Should envelopes send from a shared company sender or the logged-in agent?
- Do spouse forms need separate recipient routing?
- Where should completed PDFs live: Google Drive, local archive, S3-like storage, or Logics attachment?
- Should signed document completion trigger a task, email, or payment-processing handoff?

