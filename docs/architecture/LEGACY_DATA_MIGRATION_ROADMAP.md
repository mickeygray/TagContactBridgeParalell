# Legacy Data Migration Roadmap

## Intent

This app is **not** a greenfield restart.

The purpose of `TagContactBridgeParallel` is to:

- preserve the legacy operational and historical data
- improve the control-plane, attribution, review, and frontend architecture
- fix bugs and incomplete workflows from the prior app
- cut over readers and writers gradually without losing history

The standing rule is:

- **no destructive reset**
- **no throwing away legacy collections**
- **mirror first**
- **normalize only when history is preserved**

## Core Policy

### 1. Legacy data remains the system memory

The old app database remains the durable historical source until a given collection family has been:

- mirrored into the parallel database
- validated in reads
- validated in operational workflows
- validated in historical totals

Only after that should we consider changing the writer of record.

### 2. Parallel owns the new service layer

`5001` should become the primary read/control surface even before every writer moves.

That means:

- legacy data may continue to originate in old collections
- parallel should expose the reads
- parallel should progressively mirror and absorb the write side

### 3. No historical loss during normalization

If an older collection shape does not match the newer model:

- keep the original rows
- mirror the raw row
- add normalized fields beside it
- track provenance (`_mirroredFromDb`, `_mirroredAt`, version notes)

Do **not** destroy or truncate the original meaning just to satisfy a cleaner schema.

## Current Proven Pattern

The metrics stack now demonstrates the correct migration pattern:

1. identify the old materialized collections
2. add a `5001` read bridge
3. add a mirror into the parallel DB
4. prefer the mirror locally
5. fall back to the old DB only when needed
6. compare counts and outputs before changing writers

That is the preferred playbook for the rest of the app.

## Migration Modes

There are only three acceptable migration modes:

### Mode A: Legacy Read-Through

Use when:

- the parallel collection is empty
- we need immediate historical visibility
- the old collection is already materialized and stable

Behavior:

- `5001` reads the old DB directly
- frontend gets real data immediately
- no writer cutover yet

### Mode B: Mirrored Local Read

Use when:

- the old collection is valuable and stable
- we want the new app to read from its own DB
- we still need a reversible fallback

Behavior:

- old DB is mirrored into parallel DB
- `5001` prefers the mirrored collection
- counts and sample outputs are compared against legacy
- fallback remains available until confidence is high

### Mode C: Native Parallel Ownership

Use when:

- the parallel writer is complete
- reads match legacy expectations
- historical backfill is already present
- ongoing writes have been validated

Behavior:

- parallel becomes the writer of record
- legacy can remain as archive/reference
- cutover should still preserve old history

## Collection Families

### 1. Metrics and Attribution

Status:

- already in active migration

Legacy collections:

- `dailyspends`
- `dailypaymentsummaries`
- `dailysummaries`
- `rb_dailycallstats`
- `rb_paymentalerts`
- `rb_sourcecanonicals`
- `mailerconfigs`

Parallel strategy:

- keep mirroring
- compare mirror counts vs legacy counts
- use local mirror for reads
- move writer ownership one collection family at a time

Writer cutover order:

1. spend sync
2. daily call stats
3. payment alert / redline generation
4. source canonical sync
5. mailer/toll-free ownership sync

Acceptance criteria:

- top metrics cards match expected legacy values
- source rows match old app totals closely enough for operations
- mail costs and call counts are populated and believable
- redline counts and rows are intact

### 2. Clients, Prospects, and Cadence

Status:

- parallel writes exist
- old app still contains valuable historical records

Legacy families to preserve and compare:

- prospects / shallow contact records
- clients / case-linked views
- lead cadence state
- case profile equivalents

Strategy:

- do not delete old shallow/client records
- compare searchability by:
  - phone
  - email
  - case id
  - name
- mirror old data where the parallel collections do not yet provide sufficient historical depth

Normalization guidance:

- keep legacy raw fields if names changed
- add normalized fields instead of rewriting old meaning
- preserve original notes and status history

### 3. Messaging and Review History

Status:

- parallel conversation workflows and review items exist
- older message/conversation state may still matter for operator trust

Strategy:

- preserve historical SMS / inbox / review artifacts
- if old conversations are needed in the new inbox, mirror them as imported threads
- mark imported records clearly so operator actions remain auditable

Special rule:

- STOP / DNC / compliance-relevant history should never be discarded during migration

### 4. Consent / TCPA / TrustedForm

Status:

- parallel capture/read path now exists

Strategy:

- preserve all legacy consent rows
- mirror immutable consent artifacts
- never “clean” consent records by overwriting the original payload
- if normalization is needed, store normalized consent metadata beside the raw artifact

### 5. Lexis / Mail House / NCOA

Status:

- operational backend path exists in parallel

Strategy:

- preserve historical Lexis and NCOA operational records
- mirror old mail-house/NCOA history if it matters for case tracing or attribution
- keep original uploaded rows or file-level metadata where feasible

Special rule:

- when mail-house returns produce Logics case ids, maintain the original upload linkage

### 6. RingCentral / Telephony Runtime

Status:

- parallel runtime spine exists
- older app may still contain historical RC event logs and agent activity

Strategy:

- preserve historical RC/runtime logs
- only migrate the parts that help:
  - diagnostics
  - call history
  - attribution tracing
  - agent review/debugging

Do not force a large historical RC import if it adds little product value, but do not delete it.

## Hygiene Rules For Legacy Data

“Cleaning” is allowed.

“Cleaning away” is not.

Approved hygiene actions:

- add normalized fields
- add mirrored metadata
- backfill missing derived values
- re-key into newer collections
- mark obviously corrupt records as invalid
- add review flags for broken legacy rows

Not approved:

- dropping old rows because the shape is ugly
- rewriting old history to match a new naming preference
- removing raw fields that might still be useful in audits

If a legacy row is malformed:

- keep the row
- preserve the raw data
- add a normalized interpretation if possible
- push it into review if the system cannot trust it

## Cutover Rules

For any collection family, do **not** switch the writer until all of the following are true:

1. the parallel read surface is already serving the frontend
2. mirrored historical data is present locally
3. counts are reconciled
4. spot checks pass
5. the native writer has run successfully in production-like conditions
6. fallback to legacy is still available if needed

For any cutover, document:

- old writer
- new writer
- mirrored collections involved
- comparison method
- rollback path

## Validation Checklist

For every migrated family:

### Count Validation

- legacy count
- mirrored count
- parallel-native count

### Shape Validation

- can the frontend render the rows
- are required fields present
- do filters and sorts behave correctly

### Historical Validation

- does a known old record still appear
- do recent and long-tail totals both exist
- can operators still find older cases/prospects/messages

### Operational Validation

- do current writes still land correctly
- do old and new data coexist without double counting
- are alerts/review items created when normalization fails

## Immediate Roadmap

### Phase 1: Mirror the high-value legacy collections

Priority:

1. metrics and attribution
2. client/prospect/cadence history where thin
3. compliance/consent history
4. messaging/review history as needed

### Phase 2: Compare and harden reads

For each read surface:

- verify count parity
- verify recent sample records
- verify old sample records
- verify filters/sorts/searches

### Phase 3: Move writers one family at a time

Never move all writers at once.

Move:

1. the cleanest, most materialized writer first
2. verify behavior in production-like use
3. keep rollback easy
4. then move the next family

### Phase 4: Archive, don’t erase

Even after successful cutover:

- keep legacy collections available for reference/archive
- keep migration provenance
- keep raw history accessible for debugging and audit

## What Success Looks Like

Success is **not**:

- a perfectly clean new database with missing history

Success **is**:

- the new app serves real old and new data seamlessly
- the control plane is clearer and more capable
- old history is preserved
- new bugs are easier to diagnose
- readers/writers can switch gradually without operational loss

## Standing Decision

If there is tension between:

- preserving historical operational truth
- and forcing a cleaner new schema

the default decision is:

- preserve the history
- mirror it
- normalize around it
- review weird rows rather than deleting them
