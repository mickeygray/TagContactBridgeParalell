import * as React from "react";
import { Layers } from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { StatusPill, toneFromStatus } from "@/components/ui/StatusPill";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { DataTable, type ColumnDef } from "@/components/ui/DataTable";
import { useDomainStore } from "@/lib/domain/domainStore";
import { useDispatchLists, useWorklists } from "@/lib/api/queries/dispatch";
import { formatDateTime, formatNumber } from "@/lib/utils/format";
import type { DispatchList } from "@/lib/api/types";
import { CampaignBuilder } from "./CampaignBuilder";
import { TemplateLookup } from "./TemplateLookup";

export function DispatchWorkspace() {
  const domain = useDomainStore((s) => s.domain);
  const dispatch = useDispatchLists(domain);
  const worklists = useWorklists(domain);

  const dispatchColumns = React.useMemo<ColumnDef<DispatchList>[]>(
    () => [
      {
        accessorKey: "family",
        header: "Family",
        cell: (info) => (
          <StatusPill tone="accent">
            {(info.getValue<string>() ?? "—").toUpperCase()}
          </StatusPill>
        ),
      },
      {
        accessorKey: "subtype",
        header: "Subtype",
        cell: (info) => (
          <span className="text-sm">{info.getValue<string>() ?? "—"}</span>
        ),
      },
      {
        accessorKey: "channel",
        header: "Channel",
        cell: (info) => (
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            {info.getValue<string>() ?? "—"}
          </span>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: (info) => (
          <StatusPill tone={toneFromStatus(info.getValue<string>())}>
            {info.getValue<string>() ?? "—"}
          </StatusPill>
        ),
      },
      {
        accessorKey: "prospectCount",
        header: () => <span className="block text-right">Prospects</span>,
        cell: (info) => (
          <div className="numeric text-right">
            {formatNumber(info.getValue<number>())}
          </div>
        ),
      },
      {
        accessorKey: "createdAt",
        header: "Created",
        cell: (info) => (
          <span className="text-xs text-muted-foreground">
            {formatDateTime(info.getValue<string>())}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="Workspace"
        title="Dispatch"
        description="Manual text, email, RVM, and mail jobs. Writes become dispatch/worklist commands on 5001 — never direct calls to execution ports."
      />

      <CampaignBuilder />

      <Card>
        <CardHeader>
          <CardTitle>Dispatch lists</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {dispatch.isError ? (
            <ErrorState error={dispatch.error} onRetry={() => dispatch.refetch()} />
          ) : dispatch.isLoading ? (
            <SkeletonRow count={4} />
          ) : !dispatch.data || dispatch.data.length === 0 ? (
            <EmptyState
              icon={<Layers />}
              title="No dispatch lists yet"
              description="Use the audience builder (coming next) to stage a campaign."
            />
          ) : (
            <DataTable
              columns={dispatchColumns}
              data={dispatch.data}
              density="cozy"
              className="border-0 shadow-none"
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Work lists</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {worklists.isError ? (
            <ErrorState error={worklists.error} onRetry={() => worklists.refetch()} />
          ) : worklists.isLoading ? (
            <SkeletonRow count={3} />
          ) : !worklists.data || worklists.data.length === 0 ? (
            <EmptyState
              icon={<Layers />}
              title="No worklists"
              description="Worklists live alongside dispatch lists and share the build/queue pattern."
            />
          ) : (
            <DataTable
              columns={dispatchColumns}
              data={worklists.data}
              density="cozy"
              className="border-0 shadow-none"
            />
          )}
        </CardContent>
      </Card>

      <TemplateLookup />
    </div>
  );
}
