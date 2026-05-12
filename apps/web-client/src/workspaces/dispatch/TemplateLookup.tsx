import { Mail, MessageSquare } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { useDomainStore } from "@/lib/domain/domainStore";
import { useLibraryWorkspace } from "@/lib/api/queries/library";

// Reference panel: operators composing a blast can scan the existing
// text/email template catalog without leaving Dispatch. Read-only —
// editing the catalog itself isn't an operator workflow (templates
// are managed at the source via the 5001 library files).
export function TemplateLookup() {
  const domain = useDomainStore((s) => s.domain);
  const library = useLibraryWorkspace(domain);

  const data = library.data;
  const sms = data?.catalogs.textMessages ?? [];
  const emails = data?.catalogs.emailTemplates ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Template lookup</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {library.isError ? (
          <ErrorState error={library.error} onRetry={() => library.refetch()} />
        ) : (
          <Tabs defaultValue="text">
            <TabsList>
              <TabsTrigger value="text">
                <MessageSquare className="mr-1 h-3.5 w-3.5" />
                Text ({sms.length})
              </TabsTrigger>
              <TabsTrigger value="email">
                <Mail className="mr-1 h-3.5 w-3.5" />
                Email ({emails.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="text">
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
                  meta={(item) =>
                    [item.category, item.brand, item.stage].filter(Boolean).join(" · ")
                  }
                />
              )}
            </TabsContent>

            <TabsContent value="email">
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
                  meta={(item) =>
                    [item.brand, item.category, item.subject].filter(Boolean).join(" · ")
                  }
                />
              )}
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
}

type LibraryItem = {
  id: string;
  name?: string;
  preview?: string;
  sourcePath?: string;
  brand?: string;
  category?: string;
  stage?: string;
  subject?: string;
};

function LibraryList({
  items,
  meta,
}: {
  items: LibraryItem[];
  meta: (item: LibraryItem) => string;
}) {
  return (
    <ul className="divide-y divide-border">
      {items.slice(0, 30).map((item) => (
        <li key={item.id} className="py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="text-sm font-medium text-foreground">
                {item.name ?? item.id}
              </div>
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
