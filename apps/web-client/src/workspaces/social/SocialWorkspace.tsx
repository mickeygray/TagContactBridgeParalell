// ⚠️ PARKED — intentionally NOT routed and NOT in the nav (phase-out 2026-06-16).
// The Meta/social responder webhooks (/fb, /tt) and socialResponderService still
// run on stored config; only this admin management UI is unserved. To restore:
// re-add the lazy import + <Route path="social"> in app/routes.tsx and the
// `social` entry in app/workspaceRegistry.ts. Do NOT delete this file.
import * as React from "react";
import {
  CheckCircle2,
  Facebook,
  Instagram,
  MessageSquareText,
  Save,
  Webhook,
  WebhookOff,
} from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, KpiCard } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { StatusPill } from "@/components/ui/StatusPill";
import { Input, Label } from "@/components/ui/Input";
import { toast } from "@/components/ui/Toaster";
import { useActiveDomain } from "@/lib/domain/useActiveDomain";
import { useSaveSocialResponderConfig, useSocialResponderWorkspace } from "@/lib/api/queries/social";
import type { SocialResponderConfigRecord } from "@/lib/api/types";
import { formatNumber, formatRelative } from "@/lib/utils/format";

type DraftMap = Record<
  string,
  {
    enabled: boolean;
    keywords: string;
    commentReplyTemplate: string;
    directReplyTemplate: string;
  }
>;

function toDraft(config: SocialResponderConfigRecord) {
  return {
    enabled: Boolean(config.enabled),
    keywords: (config.triggerKeywords ?? []).join(", "),
    commentReplyTemplate: config.commentReplyTemplate ?? "",
    directReplyTemplate: config.directReplyTemplate ?? "",
  };
}

export function SocialWorkspace() {
  const domain = useActiveDomain();
  const workspace = useSocialResponderWorkspace(domain);
  const save = useSaveSocialResponderConfig(domain);
  const [drafts, setDrafts] = React.useState<DraftMap>({});

  React.useEffect(() => {
    if (!workspace.data?.responders) return;
    setDrafts((current) => {
      const next = { ...current };
      for (const config of workspace.data.responders) {
        if (!next[config.platform]) {
          next[config.platform] = toDraft(config);
        }
      }
      return next;
    });
  }, [workspace.data]);

  const responders = workspace.data?.responders ?? [];
  const totalReplies = responders.reduce(
    (sum, config) => sum + Number(config.stats?.repliesSent ?? 0),
    0,
  );
  const totalMatched = responders.reduce(
    (sum, config) => sum + Number(config.stats?.matchedEvents ?? 0),
    0,
  );

  async function onSave(platform: string) {
    const draft = drafts[platform];
    if (!draft) return;

    try {
      await save.mutateAsync({
        platform,
        input: {
          enabled: draft.enabled,
          triggerKeywords: draft.keywords
            .split(",")
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean),
          commentReplyTemplate: draft.commentReplyTemplate,
          directReplyTemplate: draft.directReplyTemplate,
        },
      });
      workspace.refetch();
      toast.success("Auto responder updated", {
        description: `${domain} ${platform}`,
      });
    } catch (error) {
      toast.error("Save failed", {
        description: (error as Error).message,
      });
    }
  }

  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="Operations"
        title="Meta Auto Responders"
        description="Edit the keyword triggers and default reply text for Facebook and Instagram, and confirm Parallel is listening on the Meta webhook."
        actions={
          <StatusPill
            dotted
            tone={
              workspace.data?.listener.verifyTokenConfigured ? "success" : "warning"
            }
          >
            {workspace.data?.listener.verifyTokenConfigured
              ? "Webhook ready"
              : "Verify token missing"}
          </StatusPill>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <KpiCard
          label="Webhook path"
          value={workspace.data?.listener.webhookPath ?? "/fb/webhook"}
          hint="Meta verification + event intake"
          icon={
            workspace.data?.listener.verifyTokenConfigured ? (
              <Webhook className="h-4 w-4" />
            ) : (
              <WebhookOff className="h-4 w-4" />
            )
          }
        />
        <KpiCard
          label="Matched events"
          value={formatNumber(totalMatched)}
          hint="Keyword-triggered comments or DMs"
          icon={<MessageSquareText className="h-4 w-4" />}
        />
        <KpiCard
          label="Replies sent"
          value={formatNumber(totalReplies)}
          hint="Across both platforms"
          icon={<CheckCircle2 className="h-4 w-4" />}
        />
      </div>

      {workspace.isError ? (
        <ErrorState error={workspace.error} onRetry={() => workspace.refetch()} />
      ) : null}

      {workspace.isLoading && !workspace.data ? (
        <SkeletonRow count={6} />
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {responders.map((config) => {
            const draft = drafts[config.platform] ?? toDraft(config);
            const platformIcon =
              config.platform === "instagram" ? (
                <Instagram className="h-4 w-4" />
              ) : (
                <Facebook className="h-4 w-4" />
              );

            return (
              <Card key={config.platform}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <CardTitle className="flex items-center gap-2 capitalize">
                        {platformIcon}
                        {config.platform}
                      </CardTitle>
                      <CardDescription>
                        {config.listener?.brandName || domain} · page id{" "}
                        {config.listener?.pageId || "not configured"}
                      </CardDescription>
                    </div>
                    <StatusPill
                      dotted
                      tone={draft.enabled ? "success" : "warning"}
                    >
                      {draft.enabled ? "enabled" : "disabled"}
                    </StatusPill>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4 pt-0">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <StatChip
                      label="Last webhook"
                      value={
                        config.stats?.lastWebhookAt
                          ? formatRelative(config.stats.lastWebhookAt)
                          : "never"
                      }
                    />
                    <StatChip
                      label="Replies"
                      value={formatNumber(config.stats?.repliesSent)}
                    />
                    <StatChip
                      label="Last keyword"
                      value={config.stats?.lastKeyword || "—"}
                    />
                    <StatChip
                      label="Token"
                      value={config.listener?.tokenConfigured ? "configured" : "missing"}
                    />
                  </div>

                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [config.platform]: {
                            ...draft,
                            enabled: event.target.checked,
                          },
                        }))
                      }
                    />
                    Enable {config.platform} auto replies
                  </label>

                  <div className="space-y-2">
                    <Label>Trigger keywords</Label>
                    <Input
                      value={draft.keywords}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [config.platform]: {
                            ...draft,
                            keywords: event.target.value,
                          },
                        }))
                      }
                      placeholder="relief, help, irs, tax"
                    />
                    <p className="text-xs text-muted-foreground">
                      Comma-separated. A comment or DM only gets a reply when one of
                      these shows up.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>Comment reply template</Label>
                    <textarea
                      className="min-h-[104px] w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
                      value={draft.commentReplyTemplate}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [config.platform]: {
                            ...draft,
                            commentReplyTemplate: event.target.value,
                          },
                        }))
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Direct message reply template</Label>
                    <textarea
                      className="min-h-[104px] w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
                      value={draft.directReplyTemplate}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [config.platform]: {
                            ...draft,
                            directReplyTemplate: event.target.value,
                          },
                        }))
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      Available placeholders: {"{{firstName}}"}, {"{{brandName}}"}, {"{{brandHandle}}"}, {"{{keyword}}"}.
                    </p>
                  </div>

                  {config.stats?.lastError ? (
                    <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                      Last error: {config.stats.lastError}
                    </div>
                  ) : null}

                  <div className="flex items-center justify-between gap-3 pt-1">
                    <div className="text-xs text-muted-foreground">
                      Updated by {config.updatedBy?.name || config.updatedBy?.email || "—"}
                    </div>
                    <Button
                      onClick={() => void onSave(config.platform)}
                      isLoading={
                        save.isPending && save.variables?.platform === config.platform
                      }
                    >
                      <Save className="h-4 w-4" />
                      Save
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Implementation notes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 pt-0 text-sm text-muted-foreground">
          {(workspace.data?.notes ?? []).map((note) => (
            <p key={note}>{note}</p>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function StatChip({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/70 bg-muted/40 px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm font-medium text-foreground">{value}</div>
    </div>
  );
}
