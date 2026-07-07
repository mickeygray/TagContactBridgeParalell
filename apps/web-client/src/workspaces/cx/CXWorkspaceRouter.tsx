import { CXWorkspaceBulkLoad } from "./CXWorkspaceBulkLoad";

// ONE LANE (Mickey, 2026-07-07: "merge down to one file — there is no multiple lanes,
// just bulk"). The env-mode fork is dead: /cx IS the bulk workspace, unconditionally.
//
// History, so nobody re-lives 2026-07-07's confusion: this router used to pick a
// workspace off VITE_CX_WORKSPACE_MODE — a BUILD-TIME Vite var — and defaulted to a
// ~6,800-line legacy fork twin ("legacy_emergency") whenever the flag was missing.
// A box that built without the flag (the tag-webhook/ngrok local deployment) silently
// served the old pipeline on /cx. The twins are in the attic:
//   attic/CXWorkspace.legacy-emergency.attic.tsx  (legacy fork, incl. the coach cockpit)
//   attic/cx-slow-single/                          (the slow-single lane)
// VITE_CX_WORKSPACE_MODE is no longer read anywhere.
export function CXWorkspaceRouter() {
  return <CXWorkspaceBulkLoad />;
}
