# Parallel Inbound Vendor Posting Guide

Last updated: 2026-05-04

## Scope

This guide is for vendors posting inbound leads into the Parallel app on port `4001`.

Current production posture:

- All vendor lead intake is treated as **Wynn Tax Solutions** intake.
- TAG-branded outbound contact is intentionally not enabled for this cutover.
- LD and affiliate routes are route-locked in code so vendor-provided source names cannot accidentally become the Logics campaign.
- Accepted leads create a Wynn Logics case, write a Parallel `LeadCadence` row, then port `4002` sends due SMS, email, and RVM cadence work.

## Base URL

Use the active public tunnel or production host for the inbound gateway:

```text
https://tagcontactbridge.ngrok.app
```

If the tunnel changes, keep every path below the same and replace only the host.

## Authentication

All vendor JSON posting routes require the shared inbound webhook secret.

Recommended header:

```http
x-webhook-secret: <LEAD_WEBHOOK_SECRET>
```

Also accepted:

```http
x-inbound-secret: <LEAD_WEBHOOK_SECRET>
Authorization: Bearer <LEAD_WEBHOOK_SECRET>
```

Legacy compatibility routes also accept:

```http
x-webhook-key: <LEAD_WEBHOOK_SECRET>
```

The current environment already has `LEAD_WEBHOOK_SECRET` configured in `.env`. Do not commit or paste the live secret into this guide; send the actual value to vendors out-of-band. If rotating before vendor launch, use a 64-character hex value and update `LEAD_WEBHOOK_SECRET` in the runtime environment.

Generate a fresh 64-character hex secret if needed:

```powershell
$bytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
```

## Common Request Rules

Every request must be JSON:

```http
Content-Type: application/json
```

For this cutover, include:

```json
{
  "company": "WYNN"
}
```

LD, affiliate, generic website/vendor, and direct social lead endpoints are forced to Wynn in code for this cutover. Still include `company: "WYNN"` on every post so payloads are already future-clean.

## Common Lead Fields

Preferred fields:

```json
{
  "company": "WYNN",
  "externalLeadId": "vendor-unique-id-123",
  "firstName": "Jane",
  "lastName": "Doe",
  "phone": "5551234567",
  "email": "jane@example.com",
  "city": "Los Angeles",
  "state": "CA",
  "trustedFormCertUrl": "https://cert.trustedform.com/...",
  "jornayaLeadId": "01234567-89ab-cdef-0123-456789abcdef",
  "vendor": "Vendor Name",
  "sourceName": "Vendor Internal Campaign",
  "trackingNumber": "8005551212"
}
```

Accepted aliases:

| Meaning | Accepted fields |
| --- | --- |
| Company | `company`, `Company` |
| First name | `firstName`, `first_name`, `firstname` |
| Last name | `lastName`, `last_name`, `lastname` |
| Full name | `name`, `fullName`, `full_name` |
| Phone | `phone`, `primaryPhone`, `cellPhone`, `mobile`, `tel` |
| Email | `email` |
| City | `city` |
| State | `state`, `State` |
| Vendor/source | `partner`, `vendor`, `affiliate`, `source`, `trafficSource`, `utm_source`, `sourceName` |
| External id | `externalLeadId`, `lead_id`, `leadId`, `id`, `contactId` |
| TrustedForm | `trustedFormCertUrl`, `trustedform_cert_url`, `trusted_form_cert_url`, `xxTrustedFormCertUrl`, `xxTrustedFormCertURL`, `tcpa_cert_url`, `trustedFormUrl`, `tf` |
| Jornaya | `jornayaLeadId`, `jornaya_lead_id`, `leadid_token`, `leadIdToken`, `jornayaId`, `jl` |
| Tracking number | `trackingNumber`, `tracking_number`, `destination_number`, `destinationNumber`, `callrailTrackingNumber`, `callrail_tracking_number` |
| Affiliate postback | `postback_url`, `postbackUrl`, `callback_url`, `callbackUrl`, `return_url`, `returnUrl`, `result_url`, `resultUrl`, `ping_url` |

Name normalization:

- Extra whitespace is collapsed.
- First and last names are title-cased.
- Full-name-only posts are split into first name and last name.
- If only one name is provided, last name becomes `Prospect`.
- Numeric or email-like name values are ignored.

## Shared Intake Scrubs

The app refuses a lead before Logics case creation when:

- The request is missing a valid secret.
- No TrustedForm certificate URL or Jornaya lead ID is present.
- There is no phone and no email.
- Phone validation identifies a litigator record.
- Phone and email validation leave no deliverable channel.

The app does **not** let vendor `sourceName` override the route campaign for LD or affiliate:

- LD posts become `SourceName: "LD Lead"` or `SourceName: "LD Posting Lead"`.
- Affiliate posts become `SourceName: "Affiliate Lead"`.
- Vendor/source detail is preserved as `partnerSource` and `vendorSourceName`.

## Responses

Accepted lead:

```json
{
  "ok": true,
  "accepted": true,
  "domain": "WYNN",
  "caseId": 123456,
  "leadCadenceId": "...",
  "validation": {
    "phoneCanCall": true,
    "phoneCanText": true,
    "emailCanSend": true
  }
}
```

Rejected or skipped lead:

```json
{
  "ok": false,
  "accepted": false,
  "skipped": true,
  "reason": "no-consent-artifact",
  "code": "NO_DELIVERABLE_CHANNEL",
  "detail": "Human-readable reason"
}
```

Common status codes:

| Status | Meaning |
| --- | --- |
| `200` | LD pre-ping accepted or rejected with a pre-ping-specific result |
| `202` | Lead accepted into Logics and Parallel cadence |
| `400` | LD pre-ping missing/failed required pre-ping checks |
| `401` | Invalid or missing webhook secret |
| `422` | Intake scrub rejected before Logics create |
| `500` | Unexpected server/provider error |

## Route 1: LD Pre-Ping

Use this before posting a full LD lead when LD wants an age/duplicate pre-check.

```http
POST /api/inbound/ld/pre-ping
```

Legacy equivalent:

```http
POST /lead-contact/pre-ping
```

Required fields:

- `state` or `State`
- Date of birth as `dob`, `DOB`, `Date Of Birth`, or `Date  Of  Birth`
- Email or email hash:
  - Preferred: `email_hash` as lowercase MD5 of the normalized email.
  - Also accepted: clear `email`; the app will hash it.
- Optional callback URL: `callback_url`, `callbackUrl`, or `ping_url`

Pre-ping payload:

```json
{
  "company": "WYNN",
  "state": "CA",
  "dob": "1968-04-15",
  "email_hash": "55502f40dc8b7c769880b10874abc9d0",
  "callback_url": "https://vendor.example.com/parallel/preping-result"
}
```

Pre-ping curl:

```bash
curl -X POST "https://tagcontactbridge.ngrok.app/api/inbound/ld/pre-ping" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: <LEAD_WEBHOOK_SECRET>" \
  -d '{
    "company": "WYNN",
    "state": "CA",
    "dob": "1968-04-15",
    "email_hash": "55502f40dc8b7c769880b10874abc9d0",
    "callback_url": "https://vendor.example.com/parallel/preping-result"
  }'
```

Pre-ping accepted:

```json
{
  "ok": true,
  "accepted": true,
  "domain": "WYNN",
  "message": "Lead accepted - proceed with full submission to /api/inbound/ld/lead",
  "checks": {
    "age": 58,
    "emailNew": true
  },
  "callbackUrl": "https://vendor.example.com/parallel/preping-result",
  "statusCode": 200
}
```

Pre-ping rejects:

- `MISSING_STATE`
- `INVALID_DOB`
- `AGE_TOO_YOUNG`
- `MISSING_EMAIL_HASH`
- `DUPLICATE_EMAIL`

## Route 2: LD Full Lead Post

```http
POST /api/inbound/ld/lead
```

Use this for LD full post after pre-ping or for direct LD posts.

If a matching pre-ping exists for the same email hash, the route becomes `ld-posting-lead` and the Logics source becomes `LD Posting Lead`. Otherwise the route is `ld-lead` and the Logics source is `LD Lead`.

LD payload:

```json
{
  "company": "WYNN",
  "externalLeadId": "ld-987654",
  "firstName": "Jane",
  "lastName": "Doe",
  "phone": "5551234567",
  "email": "jane@example.com",
  "city": "Los Angeles",
  "state": "CA",
  "trustedFormCertUrl": "https://cert.trustedform.com/abc123",
  "jornayaLeadId": "01234567-89ab-cdef-0123-456789abcdef",
  "vendor": "Lead Distributor Name",
  "sourceName": "Vendor Campaign 42",
  "trackingNumber": "8005551212"
}
```

LD curl:

```bash
curl -X POST "https://tagcontactbridge.ngrok.app/api/inbound/ld/lead" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: <LEAD_WEBHOOK_SECRET>" \
  -d '{
    "company": "WYNN",
    "externalLeadId": "ld-987654",
    "firstName": "Jane",
    "lastName": "Doe",
    "phone": "5551234567",
    "email": "jane@example.com",
    "city": "Los Angeles",
    "state": "CA",
    "trustedFormCertUrl": "https://cert.trustedform.com/abc123",
    "vendor": "Lead Distributor Name",
    "sourceName": "Vendor Campaign 42"
  }'
```

Route attribution:

- `domain`: forced to `WYNN`
- `intakeSource`: `ld` or `ld-posting`
- `sourceChannel`: `lead-distribution`
- Logics `SourceName`: `LD Lead` or `LD Posting Lead`
- Vendor-provided `sourceName`: preserved as `vendorSourceName`

## Route 3: Affiliate Lead Post

```http
POST /api/inbound/affiliate/lead
```

Use this for affiliate/NID/rev-share form posts.

Affiliate payload:

```json
{
  "company": "WYNN",
  "externalLeadId": "aff-123456",
  "firstName": "Robert",
  "lastName": "Smith",
  "phone": "5552223333",
  "email": "robert@example.com",
  "city": "Phoenix",
  "state": "AZ",
  "trustedFormCertUrl": "https://cert.trustedform.com/abc123",
  "affiliate": "Affiliate Partner Name",
  "affiliateClickId": "click-abc-123",
  "affiliateSub1": "sub-source",
  "sourceName": "Affiliate Campaign 7",
  "postback_url": "https://affiliate.example.com/postback"
}
```

Affiliate curl:

```bash
curl -X POST "https://tagcontactbridge.ngrok.app/api/inbound/affiliate/lead" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: <LEAD_WEBHOOK_SECRET>" \
  -d '{
    "company": "WYNN",
    "externalLeadId": "aff-123456",
    "firstName": "Robert",
    "lastName": "Smith",
    "phone": "5552223333",
    "email": "robert@example.com",
    "state": "AZ",
    "trustedFormCertUrl": "https://cert.trustedform.com/abc123",
    "affiliate": "Affiliate Partner Name",
    "affiliateClickId": "click-abc-123",
    "sourceName": "Affiliate Campaign 7",
    "postback_url": "https://affiliate.example.com/postback"
  }'
```

Route attribution:

- `domain`: forced to `WYNN`
- `intakeSource`: `affiliate`
- `sourceChannel`: `affiliate`
- Logics `SourceName`: `Affiliate Lead`
- Vendor-provided `sourceName`: preserved as `vendorSourceName`

Affiliate postback:

If `postback_url` or an equivalent callback field is provided, Parallel sends a JSON result back to that URL after intake. The postback body includes:

- `accepted`
- `domain`
- `caseId`
- `leadCadenceId`
- `externalLeadId`
- `phone`
- `email`
- `sourceName`
- `partnerSource`
- `affiliateClickId`
- `statusCode`
- `error`
- `code`

## Route 4: Generic Lead Vendor / Website Post

```http
POST /api/inbound/website/lead
```

Use this only for simple non-LD, non-affiliate vendor or website posts.

Generic payload:

```json
{
  "company": "WYNN",
  "externalLeadId": "vendor-123",
  "name": "Mary Johnson",
  "phone": "5554447777",
  "email": "mary@example.com",
  "state": "CA",
  "trustedFormCertUrl": "https://cert.trustedform.com/abc123",
  "source": "Generic Vendor Name",
  "sourceName": "Generic Vendor Lead"
}
```

Notes:

- This route is not LD/affiliate campaign-locked, but it is forced to Wynn for this cutover.
- Always include `company: "WYNN"`.
- Do not send TAG source naming during this cutover.

## Route 5: Social Direct Lead Posts

These direct routes are for manual/direct lead payload posting, not platform webhook subscription setup.

```http
POST /api/inbound/facebook/lead
POST /api/inbound/instagram/lead
POST /api/inbound/tiktok/lead
```

All require the shared inbound webhook secret.

Facebook/Instagram lead shape can include Meta-style `field_data`:

```json
{
  "company": "WYNN",
  "lead_id": "meta-lead-123",
  "ad_name": "Tax Relief Ad",
  "campaign_name": "Wynn Meta Campaign",
  "field_data": [
    { "name": "first_name", "values": ["Sarah"] },
    { "name": "last_name", "values": ["Williams"] },
    { "name": "phone_number", "values": ["5559998888"] },
    { "name": "email", "values": ["sarah@example.com"] },
    { "name": "state", "values": ["CA"] }
  ],
  "trustedFormCertUrl": "https://cert.trustedform.com/abc123"
}
```

TikTok direct shape:

```json
{
  "company": "WYNN",
  "lead_id": "tt-lead-123",
  "campaign_name": "Wynn TikTok Campaign",
  "firstName": "Sarah",
  "lastName": "Williams",
  "phone_number": "5559998888",
  "email": "sarah@example.com",
  "state": "CA",
  "trustedFormCertUrl": "https://cert.trustedform.com/abc123"
}
```

Platform webhooks:

- `POST /fb/webhook` uses Meta signature validation when `FB_APP_SECRET`/`META_APP_SECRET` is configured.
- `POST /tt/webhook` uses TikTok signature validation when TikTok signing secret env vars are configured.
- Platform webhook setup is separate from vendor JSON posting and should not be handed to normal lead vendors.

## Route 6: Legacy Compatibility

```http
POST /lead-contact
POST /test-lead
```

Use only when a vendor cannot switch to the modern route names.

The legacy route tries to infer route type from `source`, `trafficSource`, `partner`, `vendor`, or `utm_source`:

- `affiliate`, `nid`, `revshare` -> affiliate intake
- `ld`, `lead dist`, `posting` -> LD intake
- `facebook`, `meta` -> Facebook intake
- `instagram`, `ig` -> Instagram intake
- `tiktok`, `tt` -> TikTok intake
- Otherwise -> website intake

For cutover, prefer the modern route names because they are less ambiguous.

## Outbound Contact Behavior After Acceptance

After acceptance:

1. Parallel validates consent and contact channels.
2. Parallel creates or dedupes the Wynn Logics case.
3. Parallel writes `LeadCadence`.
4. Port `4002` cadence sweep queues due SMS, email, and RVM work.
5. SMS is sent through Wynn CallRail tracking config.
6. Email uses Wynn templates/assets.
7. RVM uses Wynn Drop campaign config.

SMS content:

- The cadence text copy says the company name naturally, e.g. `this is Wynn Tax Solutions`.
- Leading `[TAG]` or `[WYNN]` prefixes are stripped before sending so test labels do not reach consumers.

## Vendor Cutover Checklist

Before sending production volume:

- Confirm the vendor has the active base URL.
- Send the webhook secret out-of-band.
- Confirm every payload includes `company: "WYNN"`.
- Confirm every payload includes TrustedForm or Jornaya.
- Confirm every payload includes phone or email.
- For LD, run pre-ping first if the vendor supports it.
- Send one real test lead per vendor route.
- Confirm the response includes `accepted: true`, `domain: "WYNN"`, and a `caseId`.
- Confirm the lead appears in Wynn Logics with the expected route source.
- Confirm Parallel cadence row has `routeCampaignKey` of `ld` or `affiliate` where applicable.
