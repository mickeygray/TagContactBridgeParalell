import * as React from "react";
import { Loader2 } from "lucide-react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AdminShell } from "@/app/AdminShell";
import { CXShell } from "@/app/CXShell";
import { AuthGate, RoleSplash } from "@/app/AuthGate";
import { CxAuthGuard } from "@/app/CxAuthGuard";
import { CxWorkHoursGuard } from "@/app/CxWorkHoursGuard";
import { LoginPage } from "@/workspaces/auth/LoginPage";

// Route-level code splitting — each workspace ships its own chunk and is
// only fetched when the user lands on it. Keeps the initial admin payload
// small and avoids the 500kB chunk-size warning.
const MetricsWorkspace = React.lazy(() =>
  import("@/workspaces/metrics/MetricsWorkspace").then((m) => ({ default: m.MetricsWorkspace })),
);
const RingBridgeWorkspace = React.lazy(() =>
  import("@/workspaces/ringbridge/RingBridgeWorkspace").then((m) => ({ default: m.RingBridgeWorkspace })),
);
const LiveCoachWallboardWorkspace = React.lazy(() =>
  import("@/workspaces/live-coach/LiveCoachWallboardWorkspace").then((m) => ({
    default: m.LiveCoachWallboardWorkspace,
  })),
);
const CoachCockpitWorkspace = React.lazy(() =>
  import("@/workspaces/live-coach/CoachCockpitWorkspace").then((m) => ({
    default: m.CoachCockpitWorkspace,
  })),
);
const InboxWorkspace = React.lazy(() =>
  import("@/workspaces/inbox/InboxWorkspace").then((m) => ({ default: m.InboxWorkspace })),
);
const DispatchWorkspace = React.lazy(() =>
  import("@/workspaces/dispatch/DispatchWorkspace").then((m) => ({ default: m.DispatchWorkspace })),
);
const PostDatesWorkspace = React.lazy(() =>
  import("@/workspaces/postdates/PostDatesWorkspace").then((m) => ({ default: m.PostDatesWorkspace })),
);
const CleaningWorkspace = React.lazy(() =>
  import("@/workspaces/cleaning/CleaningWorkspace").then((m) => ({ default: m.CleaningWorkspace })),
);
const UsersWorkspace = React.lazy(() =>
  import("@/workspaces/users/UsersWorkspace").then((m) => ({ default: m.UsersWorkspace })),
);
const CxCallTrackerWorkspace = React.lazy(() =>
  import("@/workspaces/cx-call-tracker/CxCallTrackerWorkspace").then((m) => ({
    default: m.CxCallTrackerWorkspace,
  })),
);
const DeployWorkspace = React.lazy(() =>
  import("@/workspaces/deploy/DeployWorkspace").then((m) => ({ default: m.DeployWorkspace })),
);
const CXWorkspace = React.lazy(() =>
  import("@/workspaces/cx/CXWorkspaceRouter").then((m) => ({ default: m.CXWorkspaceRouter })),
);
const WynnInboxWorkspace = React.lazy(() =>
  import("@/workspaces/inbox/WynnInboxWorkspace").then((m) => ({
    default: m.WynnInboxWorkspace,
  })),
);
const SalesTrainerWorkspace = React.lazy(() =>
  import("@/workspaces/trainer/SalesTrainerWorkspace").then((m) => ({ default: m.SalesTrainerWorkspace })),
);
const ResolutionWorkspace = React.lazy(() =>
  import("@/workspaces/resolution/ResolutionWorkspace").then((m) => ({ default: m.ResolutionWorkspace })),
);
const FieldManualWorkspace = React.lazy(() =>
  import("@/workspaces/field-manual/FieldManualWorkspace").then((m) => ({
    default: m.FieldManualWorkspace,
  })),
);

function WorkspaceFallback() {
  return (
    <div className="flex h-[60vh] items-center justify-center text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}

function Suspended({ children }: { children: React.ReactNode }) {
  return <React.Suspense fallback={<WorkspaceFallback />}>{children}</React.Suspense>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/trainer"
        element={
          <Suspended>
            <SalesTrainerWorkspace />
          </Suspended>
        }
      />

      <Route element={<AuthGate audience="admin" />}>
        <Route path="/admin" element={<AdminShell />}>
          <Route index element={<Navigate to="metrics" replace />} />
          <Route
            path="metrics"
            element={
              <Suspended>
                <MetricsWorkspace />
              </Suspended>
            }
          />
          <Route
            path="ringbridge"
            element={
              <Suspended>
                <RingBridgeWorkspace />
              </Suspended>
            }
          />
          <Route
            path="live-coach"
            element={
              <Suspended>
                <LiveCoachWallboardWorkspace />
              </Suspended>
            }
          />
          <Route
            path="live-coach/cockpit"
            element={
              <Suspended>
                <CoachCockpitWorkspace />
              </Suspended>
            }
          />
          <Route
            path="inbox"
            element={
              <Suspended>
                <InboxWorkspace />
              </Suspended>
            }
          />
          <Route
            path="dispatch"
            element={
              <Suspended>
                <DispatchWorkspace />
              </Suspended>
            }
          />
          <Route
            path="postdates"
            element={
              <Suspended>
                <PostDatesWorkspace />
              </Suspended>
            }
          />
          <Route
            path="cleaning"
            element={
              <Suspended>
                <CleaningWorkspace />
              </Suspended>
            }
          />
          <Route
            path="users"
            element={
              <Suspended>
                <UsersWorkspace />
              </Suspended>
            }
          />
          <Route
            path="cx-call-tracker"
            element={
              <Suspended>
                <CxCallTrackerWorkspace />
              </Suspended>
            }
          />
          <Route
            path="deploy"
            element={
              <Suspended>
                <DeployWorkspace />
              </Suspended>
            }
          />
        </Route>
      </Route>

      <Route element={<AuthGate audience="user" />}>
        <Route path="/cx" element={<CXShell />}>
          <Route
            index
            element={
              <Suspended>
                <CxWorkHoursGuard>
                  <CxAuthGuard>
                    <CXWorkspace />
                  </CxAuthGuard>
                </CxWorkHoursGuard>
              </Suspended>
            }
          />
          <Route
            path="prep"
            element={
              <Suspended>
                <CxWorkHoursGuard>
                  <CxAuthGuard
                    startPath="/api/auth/cx/prep/start"
                    defaultFinalRedirectTo="/cx/prep"
                  >
                    <CXWorkspace />
                  </CxAuthGuard>
                </CxWorkHoursGuard>
              </Suspended>
            }
          />
          <Route
            path="clients"
            element={<Navigate to="/cx" replace />}
          />
          <Route
            path="inbox"
            element={
              <Suspended>
                <WynnInboxWorkspace />
              </Suspended>
            }
          />
          <Route
            path="call-library"
            element={
              <Suspended>
                <CxCallTrackerWorkspace scope="user" />
              </Suspended>
            }
          />
          <Route
            path="coach"
            element={
              <Suspended>
                <SalesTrainerWorkspace />
              </Suspended>
            }
          />
          <Route
            path="manual"
            element={
              <Suspended>
                <FieldManualWorkspace />
              </Suspended>
            }
          />
        </Route>
      </Route>

      {/* Resolution intelligence — permission-gated (resolution.read per-user
          grant; admins implicit). The workspace double-checks server-side via
          /api/resolution/access, so this route only needs authentication. */}
      <Route element={<AuthGate />}>
        <Route
          path="/resolution"
          element={
            <Suspended>
              <ResolutionWorkspace />
            </Suspended>
          }
        />
      </Route>

      <Route element={<AuthGate />}>
        <Route path="/" element={<RoleSplash />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
