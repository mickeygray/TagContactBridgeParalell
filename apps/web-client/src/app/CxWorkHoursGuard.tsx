import * as React from "react";
import { useNavigate } from "react-router-dom";
import { Clock, Headphones, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { api } from "@/lib/api/client";
import { useSession } from "@/lib/auth/useSession";

type WorkHoursResponse = {
  ok: boolean;
  limited?: boolean;
  cxWorkspace?: {
    allowed?: boolean;
    open?: boolean;
    timezone?: string;
    startHour?: number;
    endHour?: number;
  };
  error?: string;
};

function formatHour(hour: number | null | undefined): string {
  if (!Number.isFinite(hour)) return "";
  const value = Number(hour);
  const suffix = value >= 12 ? "PM" : "AM";
  const display = value % 12 || 12;
  return `${display}:00 ${suffix}`;
}

export function CxWorkHoursGuard({ children }: { children: React.ReactNode }) {
  const { user } = useSession();
  const navigate = useNavigate();
  const [state, setState] = React.useState<{
    loading: boolean;
    data: WorkHoursResponse | null;
    error: string | null;
  }>({ loading: true, data: null, error: null });

  React.useEffect(() => {
    if (user?.role === "admin") {
      setState({ loading: false, data: { ok: true, cxWorkspace: { allowed: true } }, error: null });
      return;
    }

    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    api
      .get<WorkHoursResponse>("/api/auth/work-hours")
      .then((data) => {
        if (!cancelled) setState({ loading: false, data, error: null });
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            loading: false,
            data: null,
            error: error instanceof Error ? error.message : "Could not check work hours",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [user?.role]);

  if (state.loading) {
    return (
      <div className="flex h-[50vh] items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const workspace = state.data?.cxWorkspace;
  if (!state.error && workspace?.allowed !== false) {
    return <>{children}</>;
  }

  const start = formatHour(workspace?.startHour);
  const end = formatHour(workspace?.endHour);
  const windowLabel = start && end
    ? `${start} to ${end}${workspace?.timezone ? ` ${workspace.timezone}` : ""}`
    : workspace?.timezone || "configured business hours";

  return (
    <div className="mx-auto flex min-h-[50vh] max-w-xl items-center">
      <Card className="w-full">
        <CardContent className="p-6 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Clock className="h-5 w-5" />
          </div>
          <h2 className="text-base font-semibold">CX workspace is closed</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Dialing and active CX work are limited to {windowLabel}. Call recordings are still available.
          </p>
          {state.error ? (
            <p className="mt-2 text-xs text-destructive">{state.error}</p>
          ) : null}
          <div className="mt-5 flex justify-center gap-2">
            <Button variant="primary" size="sm" onClick={() => navigate("/cx/call-library")}>
              <Headphones className="h-3.5 w-3.5" />
              Listen to calls
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
