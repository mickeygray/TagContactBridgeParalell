# CX Stale Ownership Bug Family - 2026-07-08

## Core Pattern

The no-show release problem and the stale Chris browser problem are the same class of
bug: an owner disappears or gets replaced, but one of its artifacts keeps behaving as if
that owner is still authoritative.

The product rule is simple: the current owner must be proven before work is served,
displayed, or completed. If ownership is stale, clean up or rebind without inventing an
outcome.

## Inventory-Side Instance: 8:30 No-Show Release

Stale owner:

- An agent who was staged leads but never started work.

Stale artifacts:

- RingCX copies published into that agent's campaign.
- Mongo rows still assigned or route-stamped to that absent agent.

Failure mode:

- The agent arrives late, goes available, and stale RingCX inventory can double-dial or
  conflict with the redistributed queue.

Correct recovery:

1. Cancel RingCX copies first, using only our publish stamps and extern-scoped cancels.
2. Release undialed Mongo rows with no priority/weight boost.
3. Redistribute by explicit mode: `pool` or `bottom`.
4. Never touch rows with `placedCalls > 0`.
5. Never create a second active row for the same case.

Open verification before coding the final pass:

- Confirm whether released rows must be re-stamped for the next agent's route-lock, or
  whether `pool` mode should clear route stamps and let the eventual reserving session
  own the new route.

## Client-Side Instance: Stale Browser Bound To Dead Session

Stale owner:

- A browser tab bound to a killed/replaced bulk session.

Stale artifacts:

- Middle card pinned to a lead from the old session.
- Buttons posting against a session id that is no longer the server's current running
  session.

Failure mode:

- Server is healthy and has a newer running session with buffered leads, but the agent's
  browser still shows the old lead and dead controls.

Correct recovery:

1. Treat the server's running session as canonical.
2. If the session id returned by `/api/cx/bulk-load/session` differs from the client-held
   session id, rebind the UI to the server session.
3. Clear stale middle-card/button state during rebind; do not submit outcomes against a
   replaced session.
4. If a stale button click reaches the server, fail closed with a structured stale-session
   response instead of applying an outcome.
5. Log the rebind event with masked identity:
   `cx.alpha.client_session.stale_binding` and `cx.alpha.client_session.rebound`.

## Shared Design Rule

This family should not be solved with autonomous judgment about whether work is "good"
or "bad." The machine's job is only to prove ownership, cancel the stale copy, release or
rebind the artifact, and let the normal flow continue.

Good fixes are mechanical:

- stale RingCX copy -> cancel;
- stale Mongo assignment -> release;
- stale browser session -> rebind;
- stale button command -> reject and refresh;
- dialed row -> never release as undialed.

## Next Safe Coding Steps

1. Update `noshow-release` to match the final spec: RingCX cleanout first, no weight,
   `pool|bottom` distribution, and no receiver requirement for the default `pool` mode.
2. Add tests for cancel-before-release ordering and route-stamp behavior under route-lock.
3. Add a client rebind guard in the bulk workspace around the canonical session id.
4. Add a server stale-session response on disposition routes when a request targets a
   killed/replaced session.
5. Add a small stale-tab test: old session killed, new session running, client poll sees
   new id, old card clears and buttons re-enable only for the new session.
