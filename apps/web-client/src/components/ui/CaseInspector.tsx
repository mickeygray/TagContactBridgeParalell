import * as React from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { StatusPill, toneFromStatus } from "@/components/ui/StatusPill";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/ErrorState";
import { useClientDetail } from "@/lib/api/queries/clients";
import { useCaseInspectorStore } from "@/lib/caseInspector/caseInspectorStore";
import { useSession } from "@/lib/auth/useSession";
import {
  formatDate,
  formatDateTime,
  formatRelative,
} from "@/lib/utils/format";

/**
 * Mounted once at each shell. Global zustand state drives what it shows.
 */
export function CaseInspector() {
  const { domain, caseId, open, close, reset } = useCaseInspectorStore();
  const navigate = useNavigate();
  const { user } = useSession();
  const query = useClientDetail(domain ?? "", caseId);

  const isAdmin = user?.audience === "admin";

  // Once the user closes the drawer, wait a tick before clearing state so the
  // exit animation finishes cleanly.
  React.useEffect(() => {
    if (open) return;
    const t = window.setTimeout(() => {
      if (!useCaseInspectorStore.getState().open) {
        reset();
      }
    }, 200);
    return () => window.clearTimeout(t);
  }, [open, reset]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : close())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {query.data?.name ?? (caseId ? `Case ${caseId}` : "Case")}
            {query.data?.status ? (
              <StatusPill tone={toneFromStatus(query.data.status)}>
                {query.data.status}
              </StatusPill>
            ) : null}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap gap-3">
            <span className="font-mono text-xs">{caseId}</span>
            {domain ? <span>· {domain}</span> : null}
            {query.data?.intakeSource ? (
              <span>· {query.data.intakeSource}</span>
            ) : null}
            {query.data?.intakeDate ? (
              <span>· intake {formatDate(query.data.intakeDate)}</span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : query.isLoading ? (
          <SkeletonRow count={5} />
        ) : !query.data ? (
          <p className="py-4 text-sm text-muted-foreground">
            No detail returned for this case.
          </p>
        ) : (
          <div className="space-y-5">
            <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
              <Field label="Phone" value={query.data.phone ?? "—"} />
              <Field label="Email" value={query.data.email ?? "—"} />
              <Field label="Status id" value={query.data.statusId ?? "—"} />
            </dl>

            {query.data.enrichment &&
            Object.keys(query.data.enrichment).length > 0 ? (
              <Section title="Enrichment">
                <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
                  {Object.entries(query.data.enrichment)
                    .slice(0, 9)
                    .map(([k, v]) => (
                      <Field
                        key={k}
                        label={k}
                        value={
                          v === null || v === undefined || v === "" ? "—" : String(v)
                        }
                      />
                    ))}
                </dl>
              </Section>
            ) : null}

            {query.data.timeline && query.data.timeline.length > 0 ? (
              <Section title="Recent activity">
                <ul className="relative space-y-3 border-l border-border pl-5">
                  {query.data.timeline.slice(0, 8).map((entry, i) => (
                    <li key={i} className="relative">
                      <span className="absolute -left-[22px] top-1.5 h-2 w-2 rounded-full bg-primary" />
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {String(entry.label ?? entry.eventType)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatRelative(entry.timestamp)}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatDateTime(entry.timestamp)}
                      </div>
                      {entry.detail ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {String(entry.detail)}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {query.data.payments && query.data.payments.length > 0 ? (
              <Section title={`Payments (${query.data.payments.length})`}>
                <ul className="divide-y divide-border text-sm">
                  {query.data.payments.slice(0, 5).map((p, i) => {
                    const r = p as Record<string, unknown>;
                    return (
                      <li
                        key={String(r._id ?? i)}
                        className="flex items-center justify-between py-2"
                      >
                        <span className="text-muted-foreground">
                          {r.paymentDate
                            ? formatDate(String(r.paymentDate))
                            : "—"}
                        </span>
                        <span className="numeric font-medium">
                          {typeof r.amount === "number"
                            ? `$${r.amount.toLocaleString()}`
                            : String(r.amount ?? "—")}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Section>
            ) : null}
          </div>
        )}

        <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => query.refetch()}
            isLoading={query.isFetching && !query.isLoading}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
          <div className="flex gap-2">
            {isAdmin ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  close();
                  navigate("/admin/clients");
                }}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open in Clients
              </Button>
            ) : null}
            <Button size="sm" onClick={close}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 font-medium text-foreground">{value}</dd>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}
