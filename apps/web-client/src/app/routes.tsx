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
const InboxWorkspace = React.lazy(() =>
  import("@/workspaces/inbox/InboxWorkspace").then((m) => ({ default: m.InboxWorkspace })),
);
const ClientsWorkspace = React.lazy(() =>
  import("@/workspaces/clients/ClientsWorkspace").then((m) => ({ default: m.ClientsWorkspace })),
);
const DispatchWorkspace = React.lazy(() =>
  import("@/workspaces/dispatch/DispatchWorkspace").then((m) => ({ default: m.DispatchWorkspace })),
);
const PostDatesWorkspace = React.lazy(() =>
  import("@/workspaces/postdates/PostDatesWorkspace").then((m) => ({ default: m.PostDatesWorkspace })),
);
const SocialWorkspace = React.lazy(() =>
  import("@/workspaces/social/SocialWorkspace").then((m) => ({ default: m.SocialWorkspace })),
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
  import("@/workspaces/cx/CXWorkspace").then((m) => ({ default: m.CXWorkspace })),
);
const WynnInboxWorkspace = React.lazy(() =>
  import("@/workspaces/inbox/WynnInboxWorkspace").then((m) => ({
    default: m.WynnInboxWorkspace,
  })),
);
const SalesTrainerWorkspace = React.lazy(() =>
  import("@/workspaces/trainer/SalesTrainerWorkspace").then((m) => ({ default: m.SalesTrainerWorkspace })),
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
            path="inbox"
            element={
              <Suspended>
                <InboxWorkspace />
              </Suspended>
            }
          />
          <Route
            path="clients"
            element={
              <Suspended>
                <ClientsWorkspace />
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
            path="social"
            element={
              <Suspended>
                <SocialWorkspace />
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
            path="clients"
            element={
              <Suspended>
                <ClientsWorkspace />
              </Suspended>
            }
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
        </Route>
      </Route>

      <Route element={<AuthGate />}>
        <Route path="/" element={<RoleSplash />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
