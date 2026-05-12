import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card, CardContent, CardHeader, CardTitle, KpiCard } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { CaseLink } from "@/components/ui/CaseLink";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { useDomainStore } from "@/lib/domain/domainStore";
import { useConsentRecords, useConsentStats } from "@/lib/api/queries/consent";
import { formatDateTime, formatNumber } from "@/lib/utils/format";
import { NcoaUploadCard } from "./NcoaUploadCard";

// Internally still named CleaningWorkspace (file + export retained to
// keep the route + git history low-churn), but presented to operators
// as "Lead Intake" — the workspace now hosts the two intake-facing
// surfaces: NCOA CSV upload and the TCPA consent vault.
export function CleaningWorkspace() {
  const domain = useDomainStore((s) => s.domain);
  const consentStats = useConsentStats({ domain });
  const consentRecords = useConsentRecords({ domain, limit: 10 });

  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="Workspace"
        title="Lead Intake"
        description="NCOA CSV uploads to create Logics cases, and the TCPA consent vault for inbound leads."
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <KpiCard
          label="Consent records"
          value={formatNumber(consentStats.data?.total)}
          hint={`${formatNumber(consentStats.data?.withTrustedForm)} TrustedForm`}
        />
        <KpiCard
          label="Jornaya-tagged"
          value={formatNumber(consentStats.data?.withJornaya)}
        />
        <KpiCard
          label="TrustedForm-tagged"
          value={formatNumber(consentStats.data?.withTrustedForm)}
        />
      </div>

      <NcoaUploadCard />

      <Card>
        <CardHeader>
          <CardTitle>TCPA consent vault</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {consentRecords.isError ? (
            <ErrorState error={consentRecords.error} onRetry={() => consentRecords.refetch()} />
          ) : consentRecords.isLoading ? (
            <SkeletonRow count={4} />
          ) : !consentRecords.data?.records || consentRecords.data.records.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No consent records captured for {domain} yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2">Received</th>
                    <th className="py-2">Case</th>
                    <th className="py-2">Source</th>
                    <th className="py-2">Contact</th>
                    <th className="py-2">Vault</th>
                  </tr>
                </thead>
                <tbody>
                  {consentRecords.data.records.map((record) => (
                    <tr
                      key={record._id ?? `${record.caseId ?? "na"}-${record.receivedAt ?? "now"}`}
                      className="border-b border-border/60 last:border-b-0"
                    >
                      <td className="py-2 text-xs text-muted-foreground">
                        {formatDateTime(record.receivedAt)}
                      </td>
                      <td className="py-2">
                        {record.caseId ? (
                          <CaseLink caseId={record.caseId} domain={domain} compact />
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2">{record.source ?? record.intakeSource ?? "—"}</td>
                      <td className="py-2">
                        <div className="flex flex-col">
                          <span>{record.phone ?? "—"}</span>
                          <span className="text-xs text-muted-foreground">
                            {record.email ?? "—"}
                          </span>
                        </div>
                      </td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-2">
                          {record.trustedFormCertUrl ? (
                            <StatusPill tone="success">TrustedForm</StatusPill>
                          ) : null}
                          {record.jornayaLeadId ? (
                            <StatusPill tone="info">Jornaya</StatusPill>
                          ) : null}
                          {!record.trustedFormCertUrl && !record.jornayaLeadId ? (
                            <StatusPill tone="warning">Basic only</StatusPill>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
