import { InboxWorkspace } from "@/workspaces/inbox/InboxWorkspace";

/**
 * WYNN-only SMS inbox for the CX (agent) shell.
 *
 * Reuses the full admin InboxWorkspace component but forces the domain
 * to WYNN so reps can't accidentally surface TAG client traffic from
 * their workspace. The domain switcher hidden inside the admin shell
 * doesn't render here because the underlying component reads
 * `forcedDomain` first and skips the dropdown.
 *
 * Path: /cx/inbox  (sits alongside /cx and /cx/clients in CXShell nav)
 */
export function WynnInboxWorkspace() {
  return <InboxWorkspace forcedDomain="WYNN" />;
}
