import { CalendarClock, Phone } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import type { CxAppointment } from "@/lib/api/types";

function formatAppointmentDateTime(value?: string | null) {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function AppointmentList({
  appointments,
  onCallNow,
  onRelease,
  callingAppointmentId,
  isReleasing,
  isCallingNow,
}: {
  appointments: CxAppointment[];
  onCallNow: (appointment: CxAppointment) => void;
  onRelease: (appointment: CxAppointment) => void;
  callingAppointmentId?: string | null;
  isReleasing: boolean;
  isCallingNow: boolean;
}) {
  const visible = (appointments || []).filter((appointment) =>
    ["scheduled", "due", "fired", "blocked"].includes(String(appointment.status || "")),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <CalendarClock className="h-4 w-4" />
          Appointments
        </CardTitle>
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
            No scheduled callbacks.
          </div>
        ) : (
          <div className="space-y-2">
            {visible.map((appointment) => (
              <div
                key={appointment.appointmentId}
                className="rounded-md border border-border bg-card/50 p-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-foreground">
                      {appointment.prospectName || `Case ${appointment.caseId}`}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {formatAppointmentDateTime(appointment.legalDialAt || appointment.appointmentAt)}
                    </div>
                  </div>
                  <StatusPill tone={appointment.status === "blocked" ? "warning" : "info"}>
                    {appointment.status}
                  </StatusPill>
                </div>
                <div className="mt-1 truncate text-[11px] text-muted-foreground">
                  Case {appointment.caseId}
                  {appointment.phone ? ` | ${appointment.phone}` : ""}
                </div>
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    disabled={!appointment.phone || isCallingNow}
                    isLoading={isCallingNow && callingAppointmentId === appointment.appointmentId}
                    onClick={() => onCallNow(appointment)}
                  >
                    <Phone className="h-3.5 w-3.5" />
                    Call now
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={isReleasing}
                    onClick={() => onRelease(appointment)}
                  >
                    Release
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
