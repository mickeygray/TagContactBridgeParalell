# Control Plane Collection Shape

This locks in the current control-plane collection split for the parallel
workspace.

## Collections

### `MasterProspectIndex`

Purpose:

- shallow index of all known prospect and pre-conversion cases
- minimal contact and status backbone
- supports monthly imports, lead-contact intake, and mailer uploads
- supports status refresh loops without bloating `CaseProfile`

Core fields:

- `domain`
- `caseId`
- `statusId`
- `statusLabelRaw`
- `statusCategory`
- `sourceId`
- `sourceCanonicalId`
- minimal contact info
- normalized phones
- refresh timestamps and refresh flags
- optional `caseProfileId` once converted

### `PaymentLedger`

Purpose:

- one row per payment event
- single truth for ROI and payment-based summaries
- should be written by both automation and manual workflows

Core fields:

- `domain`
- `caseId`
- `casePaymentId`
- `paymentDate`
- `amount`
- `paymentType`
- `transactionStatus`
- `sourceCanonicalId`
- `caseProfileId`
- `masterProspectId`

### `CaseProfile`

Purpose:

- converted/enriched case aggregate
- compact client-level read model
- points to canonical source and supporting collections

Core fields:

- `domain`
- `caseId`
- `masterProspectId`
- `sourceCanonicalId`
- contact summary
- conversion and payment rollups
- small arrays of `paymentIds` and `contactActivityIds`
- attribution decision metadata

### `SourceCanonical`

Purpose:

- one canonical source record per real source
- referenced by `sourceCanonicalId` from other collections

Decision:

- do not store large arrays of matching case ids on the source record
- `CaseProfile` and `MasterProspectIndex` hold the source reference instead
- source-to-case relationships are queryable by indexed `sourceCanonicalId`

## Current Direction

- non-client cases can stay shallow in `MasterProspectIndex`
- conversion materializes or updates `CaseProfile`
- payments stay normalized in `PaymentLedger`
- attribution should resolve to a single `sourceCanonicalId`
