# PhoneBurner Google Multi-Account Popup — Capture & Repro Runbook (2026-07-23)

## Symptom

Agent dials normally in PhoneBurner (Chrome) with Google account A. A second Google
account (B) is signed into the same browser for an unrelated task. At a random point
mid-shift, PhoneBurner shows a popup and dialing stops.

Related investigation family: RingCX SUSPECT (agent Chrome environment interfering
with telephony web apps). Different mechanism, same class.

## Two candidate mechanisms — the popup text decides

| Popup says roughly | Mechanism | Notes |
| --- | --- | --- |
| "Session expired" / "Please sign in again" / Google-branded dialog | **SSO silent-refresh breakage**: PhoneBurner's background token renewal (Google OAuth, `prompt=none`) pins to the browser's default Google account (`authuser=0`). Adding account B can change which account answers; renewal returns interaction_required and the session dies. | Most likely if agent uses "Sign in with Google". |
| "Logged in from another location" / "signed in elsewhere" | **Single-session enforcement**: PhoneBurner was opened a second time (other profile/tab/device), kicking the first session. | Check whether any link opened PB in the other profile. |

## Step 0 — facts to collect from the agent

1. Exact popup wording (screenshot next occurrence).
2. How they log into PhoneBurner: Google SSO or username/password.
3. Whether account B was added to the SAME Chrome profile or a separate profile.
4. Approximate time of the popup (for server-side correlation).

## Client-side capture (agent machine, start of shift)

1. Open the PhoneBurner tab → F12 → Network tab → check **Preserve log**.
2. Optional deeper capture: `chrome://net-export` → Start Logging (strip private info OK).
3. When the popup fires: Network tab → right-click any row → **Save all as HAR with content**.
4. Note the wall-clock time of the popup.

What to look for in the HAR near the popup timestamp:
- `accounts.google.com/o/oauth2/*` or `/gsi/*` requests returning errors /
  `interaction_required` / redirects to account chooser → mechanism 1.
- A PhoneBurner API response flipping to 401/session-invalid → either mechanism;
  body usually says which.

## Server-side correlation (our data)

Every ordinary completion posts a `call_done` webhook captured as a
`LeadDeliveryEvent` (provider=phoneburner, `safePayload.sourceAgentId`). For an
incident at time T, pull the agent's event timeline for the day: the last
`call_done` before a silent gap is the session death, to the second. Pair that
timestamp with the popup screenshot for a PhoneBurner support ticket — they can
pull their session/auth logs for the account at that exact minute.

## Controlled reproduction protocol

1. Fresh Chrome profile (no other Google accounts).
2. Sign into Google account A → log into PhoneBurner (same method as the agent).
3. Start a dial session; confirm normal operation.
4. In a new tab, add Google account B to the same profile (accounts.google.com →
   Add account) and do real activity in it (Gmail/Sheets).
5. Keep DevTools preserve-log running on the PB tab. Idle/work through a token
   refresh interval (15–60 min).
6. Accelerator variant: sign out of all Google accounts, sign in B FIRST (B becomes
   `authuser=0`), then A; return to the still-logged-in PB tab and wait for the next
   silent renewal. This most reliably breaks `prompt=none` flows.
7. On popup: save HAR, screenshot, note time. Compare against a control run
   (identical, but never add account B) to confirm causality.

## Mitigation candidates (pending confirmation)

- Dedicated Chrome profile for PhoneBurner only — no second Google account in that
  profile (agent uses a separate profile/window for other tasks). Cheapest fix and
  also aligns with SUSPECT hygiene (keep the telephony tab foregrounded/unthrottled).
- If SSO-related: switch affected agents to username/password login for PhoneBurner.
