# Caller-ID Reputation Runbook — the "Suspect" / Spam-Flag Problem

Date: 2026-07-09. Scope: our RingCX outbound floor (all caller IDs are RingCentral-hosted / `paymentType: Local`).
Two halves, as asked: **when it happens** (detect → heal) and **how to stop it** (prevent).

Every claim below is tagged: **[CONFIRMED]** = primary source (FCC / RingCentral / CTIA / registry operators),
**[INFERRED]** = strongly supported by the evidence but not a directly verified fact, **[VERIFY]** = must be
confirmed with the vendor/carrier before you bet on it. Sources at the bottom.

---

## The one thing to internalize first

**RingCX "Suspect" is a symptom; the disease is carrier-side reputational labeling of the *number*, driven by
your *call pattern* — and it is a SEPARATE system from STIR/SHAKEN attestation.** [CONFIRMED]

- A-level attestation only certifies a number **wasn't spoofed**. It does **not** mean "not spam" and does **not**
  prevent a "Spam Likely" flag. The FCC's own 2025 data: **93.4%** of the most prolific robocallers' traffic is
  already A-attested, ~48% of *illegal* calls are A-attested, and TNS says scams are A-attested **>50%** of the
  time. [CONFIRMED — FCC 25-76 / Triennial Efficacy Report]
- So **do not spend your effort chasing attestation to fix labeling.** Attestation is table-stakes hygiene, not
  the cure. The cure is dialing behavior + registration + resting burned numbers.

This matches our own 07-08 incident exactly: RingCX "Suspect" lockouts diagnosed as **carrier ANI-blocking
upstream of CX**, burn pattern = **volume + short-duration no-answers per number**. That burn pattern *is* the
textbook reputational-flag trigger.

---

# PART 1 — WHEN IT HAPPENS (detect → confirm → triage → heal)

### Step 1 — Detect it in minutes, not an hour (the 07-08 lesson)
The floor felt "app suspicion" for an hour before the real cause (carrier block) was found. Fix that with the
**connect-rate canary** already on the backlog:
- Rolling **15-min connect-rate** line in `cx-floor-watch`, per-ANI, with a **red flag when it falls off a cliff**.
  The drain/watcher already sees every dial's outcome — this is a read on data we already have.
- **Signature of a carrier block:** connect rate on specific ANIs craters while the rest of the stack is healthy;
  RingCX shows "Suspect" lockouts. That combination = carrier ANI block, not our code.

### Step 2 — Confirm it's a carrier label (not us)
- **Lookup:** check the flagged ANIs on the analytics engines. **Free Caller Registry** and the engines'
  own lookups; free reputation-lookup tools (Numeracle / "Caller ID Reputation") for a fast read. [VERIFY — pull
  the current lookup URLs fresh; per-engine portals weren't captured as stable facts]
- **Ground truth:** call the flagged ANI from **real test handsets on each major carrier** (T-Mobile, AT&T,
  Verizon) and read the on-screen label. Labels **diverge wildly by engine/carrier** — in one study of 100
  never-used numbers, Hiya flagged 32%, TNS 24%, First Orion 0% [CONFIRMED-but-vendor-advocacy source, 2023] —
  so check all three carriers, not one.

### Step 3 — Triage the burned ANIs
- `scripts/rcx-shift-caller-ids.js` **list** mode = the burn map. Rank ANIs by the connect-rate cliff + dial
  volume + short-call ratio. These are the numbers to rest.

### Step 4 — Stop the bleeding (legitimately)
- **REST the burned ANIs** — pull them from active campaigns for a cooldown. Use the per-campaign CID swap
  (`rcx-shift-caller-ids.js`) to move a **rested/clean** number in. This is *resting a damaged asset*, not
  evasion-rotation.
- **Do NOT just swap a fresh number and keep dialing the same way — it re-burns.** [INFERRED — labeling is
  behavioral, so an unchanged pattern re-flags a new DID quickly. Treat as the operating assumption.] A swap
  only buys time; it is not the fix. Pair every swap with a pattern change (Part 2).

### Step 5 — Remediate the label
- **File remediation at the Free Caller Registry** — one submission reaches **all three** engines (First Orion,
  Hiya, TNS). It "supports" reputation; it does **not guarantee** de-flagging. [CONFIRMED] Register as **our own
  enterprise** — the registry excludes third parties/BPOs registering on another business's behalf. [CONFIRMED]
- **Per-engine remediation portals** (Hiya, TNS, First Orion) for anything the registry doesn't clear, plus
  carrier apps (T-Mobile Scam Shield, etc.) for carrier-native blocks. [VERIFY — exact portals, eligibility,
  and turnaround times were not confirmed; pull fresh at file time. A flag can be suppressed/cleared per engine,
  but reputation re-accrues from behavior.]
- **Open a RingCentral attestation ticket** — RC is our originating carrier. Confirm our current attestation
  level and get to **A** if eligible (see Part 2). Attestation won't clear the flag, but B-level is a needless
  risk input to remove. [CONFIRMED — RC signs client-caller-ID RingCX calls at B unless the DID was obtained
  from RC or passes substitution validation]
- **Escalation option:** a paid reputation-monitor/remediation vendor (Numeracle et al.) if this recurs — eyes
  open: pricing can be steep (a 2023 filing cites one engine at **>$40k/yr for 100 numbers**) [CONFIRMED-but-
  vendor-advocacy, unaudited] and it still doesn't fix behavior.

---

# PART 2 — HOW TO STOP IT (prevention — the durable fix)

Because reputation attaches to **entity + pattern** [INFERRED], the durable fix is behavioral hygiene +
being a *legibly legitimate, registered* caller. We are a real business with opted-in leads — lean into that;
we win by being known-good and well-behaved, not by out-running the flag.

### A. Dialing hygiene — the real lever
- **Per-ANI daily dial caps** (on the backlog) — spread volume across the DID pool so no single number spikes.
- **Kill the burn pattern:** cap attempts per number/day, **pace dialing**, and **stop re-slamming no-answers**
  (short-duration no-answers per number is our named burn signature).
- **Connect-rate telemetry is both the early-warning AND the tuning dial** — build the canary; a rising
  short-call/no-answer ratio on an ANI is the *pre-flag* signal.
- **List hygiene / DNC / consent:** honor opt-outs, scrub DNC, keep a clean consent basis. Consumer complaints
  are the single strongest reputational input — compliance *is* reputation management.
- ⚠️ **Numeric thresholds are unpublished.** [VERIFY — no engine publishes calls/DID/day, abandon/answer, or
  short-call cutoffs; they're NDA/vendor-contact only. Any specific numbers floating around are marketing.]
  So: set caps as **heuristics and tune them against our own connect-rate telemetry** — our data is the real
  threshold source, not a borrowed number.

### B. Registration & branding — table-stakes trust signals
- **Free Caller Registry** — register the **whole pool** as our enterprise. Free, reaches all three engines.
  Do this proactively, not just after a flag. [CONFIRMED]
- **CNAM** — set a consistent, accurate business name on every DID.
- **A-attestation** — confirm with RC and upgrade off B where possible. Our numbers are RC-hosted (`Local`),
  which *may* already qualify for A ("obtained directly from RingCentral") — **[VERIFY via RC ticket what level
  our Local DIDs actually get.]** Table-stakes, **not** the spam-flag fix. [CONFIRMED — mechanism]
- **Branded Calling ID (BCID)** — displays our name/logo/purpose to lift **answer rates** on T-Mobile and (as of
  Sept 2025) Verizon. It controls *display*, **not** labeling — a branded number can still be flagged, and BCID
  does not remove an existing flag. Treat as an answer-rate growth play, optional. [CONFIRMED]
- **Reputation monitoring** — a lightweight recurring lookup (free tools first) so a forming label is caught
  before the floor feels it.

### C. Governance
- **Size the DID pool to volume** — don't over-concentrate dials on too few numbers.
- **Rotation policy:** rest/replace burned numbers with clean recyclables **only when paired with a pattern
  fix**, on a **slow, documented cadence** framed as legitimate ANI health. **Do NOT rotate-to-evade.**
  - Legally: the **Truth in Caller ID rule bans caller-ID manipulation only when done with intent to defraud /
    cause harm** — rotation without that intent isn't a violation of *that specific rule*. [CONFIRMED]
  - **But** it's still the wrong move: a new number re-burns under an unchanged pattern [INFERRED], and there is
    **separate** FCC attention on DID rotation / "snowshoeing" as evasion (the Dec-2025 "Advanced Methods to
    Target and Eliminate Robocalls" proceeding + Robocall Mitigation Database obligations) that is a different
    regime from Truth in Caller ID. [VERIFY — scope of that proceeding re: rotation specifically.] Our earlier
    decision to **park rotation stands.**

---

## Known unknowns (confirm before betting on)
1. **Exact engine thresholds** (calls/DID/day, abandon/answer/short-call floors, pool-sizing ratios) — unpublished;
   confirmable only by contacting Hiya, TNS, First Orion directly. Our telemetry is the substitute.
2. **Per-engine remediation portals / process / turnaround** — pull fresh at file time; not a fixed SLA; a flag
   may be only suppressible per engine, not permanently cleared.
3. **Number-vs-entity re-burn** — strong inference (labeling is behavioral), not a proven fact; drives the
   "fix behavior, not just the number" strategy.
4. **Our actual attestation level** — is a RC-hosted `Local` DID getting A or B? One RC ticket answers it.

## The 5 concrete moves (priority order)
1. **Build the connect-rate canary + per-ANI caps** — detect blocks in minutes and prevent the burn pattern. (ours to build)
2. **Register the whole pool at the Free Caller Registry** + set consistent CNAM. (free, do now)
3. **RC ticket:** confirm attestation level, get A where eligible. (free-ish, do now)
4. **Rest-and-remediate playbook** for burned ANIs (this doc's Part 1) instead of blind rotation.
5. **Reputation monitoring** (free lookups first; paid vendor only if recurring) — and evaluate **BCID** for
   answer-rate uplift once the reputation floor is stable.

---

## Sources
- FCC 25-76 (attestation tiers; A ≠ lawful): https://docs.fcc.gov/public/attachments/FCC-25-76A1.pdf
- FCC Second Triennial STIR/SHAKEN Efficacy Report: https://docs.fcc.gov/public/attachments/DOC-416732A1.pdf
- RingCentral STIR/SHAKEN compliance (B-level for client caller IDs): https://support.ringcentral.com/article-v2/ringcentral-stir-shaken-compliance.html
- Free Caller Registry (one portal → 3 engines): https://www.freecallerregistry.com/ ; launch: https://tnsi.com/resource/com/first-orion-hiya-tns-launch-caller-registry-streamline-interactions-between-callers-blog/
- CTIA Branded Calling ID / Verizon (Sept 2025): https://www.ctia.org/news/new-consumer-tool-branded-calling-id-to-launch-on-verizons-network
- FCC Truth in Caller ID rule (intent standard): https://www.federalregister.gov/documents/2019/08/30/2019-18229/truth-in-caller-id-rules ; https://www.fcc.gov/consumers/guides/spoofing
- Divergent labeling / remediation-cost figures (vendor-advocacy, 2023): https://commsrisk.com/big-us-call-analytics-firms-hiya-and-tns-blasted-for-conflict-of-interest-over-incorrect-spam-labels/
- Full cited research: workflow wf_5c30155f-aa6
