import { CXWorkspace as LegacyCXWorkspace } from "./CXWorkspace";
import { CXWorkspaceSlowSingle } from "./slow-single/CXWorkspaceSlowSingle";
import { CXWorkspaceBulkLoad } from "./CXWorkspaceBulkLoad";

type CxWorkspaceMode = "legacy_emergency" | "slow_single" | "bulk_load";

function readCxWorkspaceMode(): CxWorkspaceMode {
  const raw = String(import.meta.env.VITE_CX_WORKSPACE_MODE || "").trim().toLowerCase();
  if (raw === "slow_single" || raw === "slow-single") return "slow_single";
  if (raw === "bulk_load" || raw === "bulk-load") return "bulk_load";
  return "legacy_emergency";
}

export function CXWorkspaceRouter() {
  const mode = readCxWorkspaceMode();
  if (mode === "slow_single") {
    return <CXWorkspaceSlowSingle />;
  }
  if (mode === "bulk_load") {
    return <CXWorkspaceBulkLoad />;
  }
  return <LegacyCXWorkspace />;
}
