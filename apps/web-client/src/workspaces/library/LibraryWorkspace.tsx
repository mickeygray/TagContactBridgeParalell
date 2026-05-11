import { Mail, MessageSquare, Package } from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card, CardContent, CardHeader, CardTitle, KpiCard } from "@/components/ui/Card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { EmptyState, GapCard } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { useDomainStore } from "@/lib/domain/domainStore";
import { useLibraryWorkspace } from "@/lib/api/queries/library";
import { formatNumber } from "@/lib/utils/format";

export function LibraryWorkspace() {
  const domain = useDomainStore((s) => s.domain);
  const library = useLibraryWorkspace(domain);

  const data = library.data;
  const sms = data?.catalogs.textMessages ?? [];
  const emails = data?.catalogs.emailTemplates ?? [];

  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="Workspace"
        title="Contact Library"
        description="Browse the original text and email campaign material through 5001 so one-off jobs and scheduled campaigns draw from the same catalog."
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <KpiCard label="SMS templates" value={formatNumber(data?.summary.smsCount)} icon={<MessageSquare className="h-4 w-4" />} />
        <KpiCard label="Email templates" value={formatNumber(data?.summary.emailCount)} icon={<Mail className="h-4 w-4" />} />
        <KpiCard
          label="Recent usage"
          value={formatNumber((data?.recentUsage?.smsDispatches?.length ?? 0) + (data?.recentUsage?.emailDispatches?.length ?? 0))}
          hint="Dispatch lists referencing library content"
          icon={<Package className="h-4 w-4" />}
        />
      </div>

      {library.isError ? <ErrorState error={library.error} onRetry={() => library.refetch()} /> : null}

      <Tabs defaultValue="text">
        <TabsList>
          <TabsTrigger value="text">
            <MessageSquare className="mr-1 h-3.5 w-3.5" />
            Text
          </TabsTrigger>
          <TabsTrigger value="email">
            <Mail className="mr-1 h-3.5 w-3.5" />
            Email
          </TabsTrigger>
          <TabsTrigger value="mail">
            <Package className="mr-1 h-3.5 w-3.5" />
            Mail pieces
          </TabsTrigger>
        </TabsList>

        <TabsContent value="text">
          <Card>
            <CardHeader>
              <CardTitle>Text templates</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {library.isLoading ? (
                <SkeletonRow count={5} />
              ) : sms.length === 0 ? (
                <EmptyState
                  icon={<MessageSquare />}
                  title="No text templates loaded"
                  description="5001 should surface textMessageLibrary entries here."
                />
              ) : (
                <LibraryList
                  items={sms}
                  meta={(item) => [item.category, item.brand, item.stage].filter(Boolean).join(" · ")}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="email">
          <Card>
            <CardHeader>
              <CardTitle>Email templates</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {library.isLoading ? (
                <SkeletonRow count={5} />
              ) : emails.length === 0 ? (
                <EmptyState
                  icon={<Mail />}
                  title="No email templates loaded"
                  description="5001 should surface legacy .hbs files here."
                />
              ) : (
                <LibraryList
                  items={emails}
                  meta={(item) => [item.brand, item.category, item.subject].filter(Boolean).join(" · ")}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="mail">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <GapCard
              title="Mail piece library"
              description="The text and email catalogs are live now. Mail pieces still need their own materialized library behind 5001."
              routes={[
                "GET /api/read/library/mail-pieces",
                "POST /api/commands/library/mail-piece",
                "PUT /api/commands/library/mail-piece/:id",
              ]}
            />
            <Card>
              <CardHeader>
                <CardTitle>Library notes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 pt-0 text-sm text-muted-foreground">
                {(data?.notes ?? []).map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function LibraryList({
  items,
  meta,
}: {
  items: Array<{
    id: string;
    name?: string;
    preview?: string;
    sourcePath?: string;
    brand?: string;
    category?: string;
    stage?: string;
    subject?: string;
  }>;
  meta: (item: {
    id: string;
    name?: string;
    preview?: string;
    sourcePath?: string;
    brand?: string;
    category?: string;
    stage?: string;
    subject?: string;
  }) => string;
}) {
  return (
    <ul className="divide-y divide-border">
      {items.slice(0, 30).map((item) => (
        <li key={item.id} className="py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="text-sm font-medium text-foreground">{item.name ?? item.id}</div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {meta(item) || "library item"}
              </div>
              {item.preview ? (
                <p className="line-clamp-2 text-sm text-muted-foreground">{item.preview}</p>
              ) : null}
            </div>
            {item.sourcePath ? (
              <span className="max-w-[220px] truncate text-[11px] text-muted-foreground">
                {item.sourcePath}
              </span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
