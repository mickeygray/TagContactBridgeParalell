import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertCircle, CheckCircle2, Link2, Search } from "lucide-react";
import { Input, Label } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { StatusPill } from "@/components/ui/StatusPill";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { useResolveAccountIdentity, useUnassignedExtensions } from "@/lib/api/queries/accounts";
import type {
  AccountIdentityResolveResult,
  AccountRecord,
  AuthAudience,
  AuthRole,
  CreateAccountInput,
} from "@/lib/api/types";

const ROLE_OPTIONS: Array<{
  value: AuthRole;
  label: string;
  audience: AuthAudience;
  hint: string;
}> = [
  { value: "admin", label: "Admin", audience: "admin", hint: "Full access to every workspace." },
  {
    value: "internal-agent",
    label: "Internal agent",
    audience: "user",
    hint: "CX shell with extended read access to contacts.",
  },
  {
    value: "widget-user",
    label: "CX user",
    audience: "user",
    hint: "Narrow CX shell — calls, tasks, Logics, SMS.",
  },
];

const MANUAL_QUEUE_DEFAULTS = {
  firstTouchEligible: true,
  freshTargetOpen: 15,
  day2to15TargetOpen: 15,
  agedTargetOpen: 5,
};

const NO_LEAD_QUEUE_DEFAULTS = {
  firstTouchEligible: false,
  freshTargetOpen: 0,
  day2to15TargetOpen: 0,
  agedTargetOpen: 0,
};

export const COMPANY_OPTIONS = ["TAG", "WYNN", "AMITY"] as const;

const baseSchema = z.object({
  email: z.string().email("Enter a valid email"),
  name: z.string().min(1, "Name is required"),
  role: z.enum(["admin", "internal-agent", "widget-user"]),
  company: z.enum(COMPANY_OPTIONS),
  extensionId: z.string().optional(),
  extensionNumber: z.string().optional(),
  cxAgentId: z.string().optional(),
  ringcxUsername: z.string().optional(),
  stationLabel: z.string().optional(),
  phone: z.string().optional(),
  cxFirstTouchEligible: z.boolean().optional(),
  cxFreshTargetOpen: z.string().optional(),
  cxDay2To15TargetOpen: z.string().optional(),
  cxAgedTargetOpen: z.string().optional(),
  logicsUserId: z.string().optional(),
  logicsDisplayName: z.string().optional(),
  tagLogicsId: z.string().optional(),
  tagSOId: z.string().optional(),
  tagEmail: z.string().optional(),
  tagLogicsName: z.string().optional(),
  tagLogicsRoles: z.string().optional(),
  wynnLogicsId: z.string().optional(),
  wynnSOId: z.string().optional(),
  wynnEmail: z.string().optional(),
  wynnLogicsName: z.string().optional(),
  wynnLogicsRoles: z.string().optional(),
  logicsCredentialMode: z.string().optional(),
  logicsCredentialStatus: z.string().optional(),
  logicsScopes: z.string().optional(),
  logicsPermissionsLabel: z.string().optional(),
  logicsExternalSecretRef: z.string().optional(),
});

export type UserFormValues = z.infer<typeof baseSchema>;

export interface UserFormProps {
  /** Initial values when editing an existing account. */
  initial?: Partial<AccountRecord> | null;
  /** Disable the email field when editing — email is the primary key. */
  lockEmail?: boolean;
  /** Called with a fully-normalized payload ready for create/update mutations. */
  onSubmit: (payload: CreateAccountInput) => Promise<void> | void;
  /** Render prop for the submit/cancel buttons. */
  footer: (
    state: {
      submit: () => void;
      isSubmitting: boolean;
      isDirty: boolean;
    },
  ) => React.ReactNode;
  /**
   * Optional extra extension to always show in the dropdown, so edit dialogs
   * can still display the account's currently-paired extension (which is not
   * returned by the unpaired list).
   */
  includeCurrentExtension?: {
    extensionId: string;
    extensionNumber?: string | null;
    name?: string | null;
  } | null;
  /** Defer `useUnassignedExtensions` call when the parent already has data. */
  defaultCompany?: (typeof COMPANY_OPTIONS)[number];
}

export function UserForm({
  initial,
  lockEmail,
  onSubmit,
  footer,
  includeCurrentExtension,
  defaultCompany = "TAG",
}: UserFormProps) {
  // `tagLogicsRoles` / `wynnLogicsRoles` are already comma-separated strings
  // as stored on the UA (same shape as the Logics roster). No array parsing.
  const csvArray = (values?: string[] | null) =>
    values && values.length > 0 ? values.join(", ") : "";
  const parseNumber = (value?: string) => {
    if (!value || !value.trim()) return null;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  };
  const parseNonNegativeNumber = (value?: string) => {
    const parsed = parseNumber(value);
    return parsed == null ? null : Math.max(Math.trunc(parsed), 0);
  };
  const parseCsvArray = (value?: string) =>
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  const initialMetadata =
    initial?.metadata && typeof initial.metadata === "object"
      ? (initial.metadata as Record<string, unknown>)
      : {};
  const initialRingcxUsername = String(
    initialMetadata.ringcxUsername ||
      initialMetadata.ringcxAgentUsername ||
      initialMetadata.cxUsername ||
      "",
  );
  const initialCxQueueDefaults =
    initial?.role === "admin" || initial?.audience === "admin"
      ? NO_LEAD_QUEUE_DEFAULTS
      : MANUAL_QUEUE_DEFAULTS;

  const form = useForm<UserFormValues>({
    resolver: zodResolver(baseSchema),
    defaultValues: {
      email: initial?.email ?? "",
      name: initial?.name ?? "",
      role: (initial?.role as UserFormValues["role"]) ?? "internal-agent",
      company:
        (COMPANY_OPTIONS.includes(
          (initial?.company ?? defaultCompany) as (typeof COMPANY_OPTIONS)[number],
        )
          ? (initial?.company ?? defaultCompany)
          : defaultCompany) as (typeof COMPANY_OPTIONS)[number],
      extensionId: initial?.extensionId ?? "",
      extensionNumber: initial?.extensionNumber ?? "",
      cxAgentId: initial?.cxAgentId ?? "",
      ringcxUsername: initialRingcxUsername,
      stationLabel: initial?.stationLabel ?? "",
      phone: initial?.phone ?? "",
      cxFirstTouchEligible:
        initial?.cxQueuePolicy?.fresh?.firstTouchEligible ??
        initial?.cxQueuePolicy?.fresh?.eligible ??
        initialCxQueueDefaults.firstTouchEligible,
      cxFreshTargetOpen:
        initial?.cxQueuePolicy?.fresh?.targetOpen != null
          ? String(initial.cxQueuePolicy?.fresh?.targetOpen)
          : String(initialCxQueueDefaults.freshTargetOpen),
      cxDay2To15TargetOpen:
        initial?.cxQueuePolicy?.day2to15?.targetOpen != null
          ? String(initial.cxQueuePolicy?.day2to15?.targetOpen)
          : String(initialCxQueueDefaults.day2to15TargetOpen),
      cxAgedTargetOpen:
        initial?.cxQueuePolicy?.aged?.targetOpen != null
          ? String(initial.cxQueuePolicy?.aged?.targetOpen)
          : String(initialCxQueueDefaults.agedTargetOpen),
      logicsUserId: initial?.logicsUserId != null ? String(initial.logicsUserId) : "",
      logicsDisplayName: initial?.logicsDisplayName ?? "",
      tagLogicsId: initial?.tagLogicsId != null ? String(initial.tagLogicsId) : "",
      tagSOId: initial?.tagSOId != null ? String(initial.tagSOId) : "",
      tagEmail: initial?.tagEmail ?? "",
      tagLogicsName: initial?.tagLogicsName ?? "",
      tagLogicsRoles: initial?.tagLogicsRoles ?? "",
      wynnLogicsId: initial?.wynnLogicsId != null ? String(initial.wynnLogicsId) : "",
      wynnSOId: initial?.wynnSOId != null ? String(initial.wynnSOId) : "",
      wynnEmail: initial?.wynnEmail ?? "",
      wynnLogicsName: initial?.wynnLogicsName ?? "",
      wynnLogicsRoles: initial?.wynnLogicsRoles ?? "",
      logicsCredentialMode: initial?.logicsAuth?.credentialMode ?? "",
      logicsCredentialStatus: initial?.logicsAuth?.credentialStatus ?? "",
      logicsScopes: csvArray(initial?.logicsAuth?.scopes),
      logicsPermissionsLabel: initial?.logicsAuth?.permissionsLabel ?? "",
      logicsExternalSecretRef: initial?.logicsAuth?.externalSecretRef ?? "",
    },
  });

  const company = form.watch("company");
  const role = form.watch("role");
  const cxFreshTargetOpen = form.watch("cxFreshTargetOpen");
  const cxDay2To15TargetOpen = form.watch("cxDay2To15TargetOpen");
  const cxAgedTargetOpen = form.watch("cxAgedTargetOpen");
  const extensionId = form.watch("extensionId") || "";
  const roleDef = ROLE_OPTIONS.find((r) => r.value === role);
  const cxLeadListSize =
    Number(parseNonNegativeNumber(cxFreshTargetOpen) || 0) +
    Number(parseNonNegativeNumber(cxDay2To15TargetOpen) || 0) +
    Number(parseNonNegativeNumber(cxAgedTargetOpen) || 0);
  const extensions = useUnassignedExtensions(company);
  const resolveIdentity = useResolveAccountIdentity();
  const [identityResult, setIdentityResult] =
    React.useState<AccountIdentityResolveResult | null>(null);
  const lockInlineUnpair = Boolean(initial?.extensionId && includeCurrentExtension?.extensionId);

  const options = React.useMemo(() => {
    const base = extensions.data ?? [];
    if (!includeCurrentExtension) return base;
    const existingIds = new Set(base.map((e) => e.extensionId));
    if (existingIds.has(includeCurrentExtension.extensionId)) return base;
    return [
      {
        extensionId: includeCurrentExtension.extensionId,
        extensionNumber: includeCurrentExtension.extensionNumber ?? null,
        name: includeCurrentExtension.name ?? null,
        company: company,
        cxAgentId: null,
        status: null,
        exPresenceStatus: "paired-to-this-user",
        lastStatusChange: null,
        lastEventReceived: null,
      },
      ...base,
    ];
  }, [extensions.data, includeCurrentExtension, company]);

  const [isSubmitting, setSubmitting] = React.useState(false);

  const setSuggestedValue = React.useCallback(
    (
      key: keyof UserFormValues,
      value: unknown,
      { overwrite = false }: { overwrite?: boolean } = {},
    ) => {
      const normalized = value == null ? "" : String(value).trim();
      if (!normalized) return;
      const current = form.getValues(key);
      if (!overwrite && String(current || "").trim()) return;
      form.setValue(key, normalized as never, {
        shouldDirty: true,
        shouldValidate: true,
      });
    },
    [form],
  );

  const applyIdentitySuggestion = React.useCallback(
    (suggestion?: Partial<CreateAccountInput> | null) => {
      if (!suggestion) return;
      setSuggestedValue("email", suggestion.email);
      setSuggestedValue("name", suggestion.name);
      if (COMPANY_OPTIONS.includes(suggestion.company as (typeof COMPANY_OPTIONS)[number])) {
        setSuggestedValue("company", suggestion.company);
      }
      setSuggestedValue("extensionId", suggestion.extensionId);
      setSuggestedValue("extensionNumber", suggestion.extensionNumber);
      setSuggestedValue("cxAgentId", suggestion.cxAgentId);
      setSuggestedValue("phone", suggestion.phone);
      setSuggestedValue("logicsUserId", suggestion.logicsUserId);
      setSuggestedValue("logicsDisplayName", suggestion.logicsDisplayName);
      setSuggestedValue("tagLogicsId", suggestion.tagLogicsId);
      setSuggestedValue("tagSOId", suggestion.tagSOId);
      setSuggestedValue("tagEmail", suggestion.tagEmail);
      setSuggestedValue("tagLogicsName", suggestion.tagLogicsName);
      setSuggestedValue("tagLogicsRoles", suggestion.tagLogicsRoles);
      setSuggestedValue("wynnLogicsId", suggestion.wynnLogicsId);
      setSuggestedValue("wynnSOId", suggestion.wynnSOId);
      setSuggestedValue("wynnEmail", suggestion.wynnEmail);
      setSuggestedValue("wynnLogicsName", suggestion.wynnLogicsName);
      setSuggestedValue("wynnLogicsRoles", suggestion.wynnLogicsRoles);

      const metadata =
        suggestion.metadata && typeof suggestion.metadata === "object"
          ? (suggestion.metadata as Record<string, unknown>)
          : {};
      setSuggestedValue(
        "ringcxUsername",
        metadata.ringcxUsername || metadata.ringcxAgentUsername || metadata.cxUsername,
      );
    },
    [setSuggestedValue],
  );

  const runIdentityLookup = React.useCallback(async () => {
    const values = form.getValues();
    const result = await resolveIdentity.mutateAsync({
      email: values.email,
      username: values.ringcxUsername || values.email,
      ringcxUsername: values.ringcxUsername,
      name: values.name,
      company: values.company,
      extensionId: values.extensionId,
      extensionNumber: values.extensionNumber,
      cxAgentId: values.cxAgentId,
    });
    setIdentityResult(result);
    applyIdentitySuggestion(result.suggestion);
  }, [applyIdentitySuggestion, form, resolveIdentity]);

  const submit = form.handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      const audience = roleDef?.audience ?? "user";
      const freshTargetOpen = parseNonNegativeNumber(values.cxFreshTargetOpen) ?? 0;
      const day2to15TargetOpen = parseNonNegativeNumber(values.cxDay2To15TargetOpen) ?? 0;
      const agedTargetOpen = parseNonNegativeNumber(values.cxAgedTargetOpen) ?? 0;
      const firstTouchEligible = Boolean(values.cxFirstTouchEligible);
      const queueEnabled =
        firstTouchEligible
        || freshTargetOpen > 0
        || day2to15TargetOpen > 0
        || agedTargetOpen > 0;
      const payload: CreateAccountInput = {
        email: values.email.trim().toLowerCase(),
        name: values.name.trim(),
        role: values.role as AuthRole,
        audience,
        company: values.company,
        extensionId: values.extensionId?.trim() || null,
        extensionNumber: values.extensionNumber?.trim() || null,
        cxAgentId: values.cxAgentId?.trim() || null,
        stationLabel: values.stationLabel?.trim() || undefined,
        phone: values.phone?.trim() || null,
        cxQueuePolicy: {
          ...(initial?.cxQueuePolicy || {}),
          enabled: queueEnabled,
          fresh: {
            ...(initial?.cxQueuePolicy?.fresh || {}),
            eligible: firstTouchEligible || freshTargetOpen > 0,
            firstTouchEligible,
            targetOpen: freshTargetOpen,
          },
          day2to15: {
            ...(initial?.cxQueuePolicy?.day2to15 || {}),
            targetOpen: day2to15TargetOpen,
          },
          aged: {
            ...(initial?.cxQueuePolicy?.aged || {}),
            targetOpen: agedTargetOpen,
          },
        },
        logicsUserId: parseNumber(values.logicsUserId),
        logicsDisplayName: values.logicsDisplayName?.trim() || null,
        tagLogicsId: parseNumber(values.tagLogicsId),
        tagSOId: parseNumber(values.tagSOId),
        tagEmail: values.tagEmail?.trim() || null,
        tagLogicsName: values.tagLogicsName?.trim() || null,
        tagLogicsRoles: values.tagLogicsRoles?.trim() || null,
        wynnLogicsId: parseNumber(values.wynnLogicsId),
        wynnSOId: parseNumber(values.wynnSOId),
        wynnEmail: values.wynnEmail?.trim() || null,
        wynnLogicsName: values.wynnLogicsName?.trim() || null,
        wynnLogicsRoles: values.wynnLogicsRoles?.trim() || null,
      };
      // Keep RingCX identity hints in metadata; token material stays only
      // in the CX OAuth storage subdocs.
      const metadata = { ...initialMetadata };
      const ringcxUsername = values.ringcxUsername?.trim().toLowerCase();
      if (ringcxUsername) {
        metadata.ringcxUsername = ringcxUsername;
        metadata.ringcxAgentUsername = ringcxUsername;
        metadata.cxUsername = ringcxUsername;
      } else {
        delete metadata.ringcxUsername;
        delete metadata.ringcxAgentUsername;
        delete metadata.cxUsername;
      }
      if (identityResult) {
        metadata.identityLastCheckedAt = identityResult.checkedAt;
        metadata.identityCheck = {
          exMatched: Boolean(identityResult.matches.ex.match),
          cxMatched: Boolean(identityResult.matches.cx.match),
          oauthConfigured: Boolean(identityResult.oauth?.configured),
        };
        const suggestedMetadata =
          identityResult.suggestion?.metadata &&
          typeof identityResult.suggestion.metadata === "object"
            ? (identityResult.suggestion.metadata as Record<string, unknown>)
            : {};
        for (const key of ["ringcxAgentId", "ringcxAgentGroupId", "ringcxRcUserId"]) {
          if (suggestedMetadata[key]) metadata[key] = suggestedMetadata[key];
        }
      }
      if (Object.keys(metadata).length > 0) {
        payload.metadata = metadata;
      }

      // Build logicsAuth only with fields the admin actually set; mongoose
      // enum validation rejects `null` on credentialMode/credentialStatus,
      // so we omit empty keys instead of passing explicit nulls.
      const mode = values.logicsCredentialMode?.trim();
      const status = values.logicsCredentialStatus?.trim();
      const scopes = parseCsvArray(values.logicsScopes);
      const permissionsLabel = values.logicsPermissionsLabel?.trim();
      const externalSecretRef = values.logicsExternalSecretRef?.trim();
      const logicsAuth: NonNullable<CreateAccountInput["logicsAuth"]> = {};
      if (mode) logicsAuth.credentialMode = mode;
      if (status) logicsAuth.credentialStatus = status;
      if (scopes.length > 0) logicsAuth.scopes = scopes;
      if (permissionsLabel) logicsAuth.permissionsLabel = permissionsLabel;
      if (externalSecretRef) logicsAuth.externalSecretRef = externalSecretRef;
      if (Object.keys(logicsAuth).length > 0) {
        payload.logicsAuth = logicsAuth;
      }
      await onSubmit(payload);
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Email" error={form.formState.errors.email?.message}>
          <Input
            type="email"
            autoComplete="email"
            placeholder="you@taxadvocategroup.com"
            disabled={lockEmail}
            autoFocus={!lockEmail}
            {...form.register("email")}
          />
        </Field>
        <Field label="Name" error={form.formState.errors.name?.message}>
          <Input
            autoFocus={lockEmail}
            placeholder="Jane Agent"
            {...form.register("name")}
          />
        </Field>
        <Field label="Role">
          <Select
            value={role}
            onValueChange={(v) => form.setValue("role", v as UserFormValues["role"], { shouldDirty: true })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {roleDef ? (
            <p className="text-[11px] text-muted-foreground">{roleDef.hint}</p>
          ) : null}
        </Field>
        <Field label="Company">
          <Select
            value={company}
            onValueChange={(v) =>
              form.setValue("company", v as UserFormValues["company"], { shouldDirty: true })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMPANY_OPTIONS.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto] md:items-end">
          <Field label="RingCX username">
            <Input
              placeholder="agent@taxadvocategroup.com"
              {...form.register("ringcxUsername")}
            />
          </Field>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void runIdentityLookup().catch(() => undefined);
            }}
            isLoading={resolveIdentity.isPending}
          >
            <Search className="h-3.5 w-3.5" />
            Find EX/CX
          </Button>
        </div>
        <IdentityLookupSummary
          result={identityResult}
          error={resolveIdentity.error as Error | null}
        />
      </div>

      <Field
        label="RingCentral extension"
        hint={
          extensions.isLoading
            ? "Loading unpaired extensions…"
            : lockInlineUnpair
              ? "Use the explicit unlink button in the users table to unpair."
            : options.length === 0
              ? "No unpaired extensions in this company."
              : `${options.length} available.`
        }
      >
        <Select
          value={extensionId || "none"}
          onValueChange={(v) => {
            const selected = options.find((ext) => ext.extensionId === v);
            form.setValue("extensionId", v === "none" ? "" : v, { shouldDirty: true });
            form.setValue("extensionNumber", selected?.extensionNumber || "", {
              shouldDirty: true,
            });
          }}
        >
          <SelectTrigger>
            <span className="flex items-center gap-2">
              <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
              <SelectValue placeholder="Leave unpaired for now" />
            </span>
          </SelectTrigger>
          <SelectContent>
            {!lockInlineUnpair ? <SelectItem value="none">Leave unpaired</SelectItem> : null}
            {options.map((ext) => (
              <SelectItem key={ext.extensionId} value={ext.extensionId}>
                {(ext.name ?? "ext") + " · "}
                {ext.extensionId}
                {ext.exPresenceStatus ? ` · ${ext.exPresenceStatus}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <div className="grid grid-cols-1 gap-4 rounded-md border border-border/60 bg-muted/20 p-3 md:grid-cols-5">
        <Field label="List size">
          <div
            className="flex h-10 items-center rounded-md border border-input bg-background px-3 text-sm font-semibold"
            title="Green + blue + red"
          >
            {cxLeadListSize}
          </div>
        </Field>
        <Field label="0 contact">
          <label className="flex h-10 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              {...form.register("cxFirstTouchEligible")}
            />
            Enabled
          </label>
        </Field>
        <Field label="Green count">
          <Input
            type="number"
            min={0}
            step={1}
            {...form.register("cxFreshTargetOpen")}
          />
        </Field>
        <Field label="Blue count">
          <Input
            type="number"
            min={0}
            step={1}
            {...form.register("cxDay2To15TargetOpen")}
          />
        </Field>
        <Field label="Red count">
          <Input
            type="number"
            min={0}
            step={1}
            {...form.register("cxAgedTargetOpen")}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Ext number">
          <Input placeholder="101" {...form.register("extensionNumber")} />
        </Field>
        <Field label="CX agent id">
          <Input placeholder="optional" {...form.register("cxAgentId")} />
        </Field>
        <Field label="Station label">
          <Input placeholder="CX Desk 3" {...form.register("stationLabel")} />
        </Field>
        <Field label="Phone">
          <Input placeholder="+1..." {...form.register("phone")} />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Primary Logics user id" hint="Legacy fallback when tenant-specific ids are missing.">
          <Input placeholder="433" {...form.register("logicsUserId")} />
        </Field>
        <Field label="Logics display name">
          <Input placeholder="Phil Olson" {...form.register("logicsDisplayName")} />
        </Field>
      </div>

      <div className="rounded-xl border border-border/60 bg-muted/20 p-4 space-y-4">
        <div>
          <p className="text-sm font-medium">TAG identity</p>
          <p className="text-[11px] text-muted-foreground">
            Used when the agent is acting inside TAG cases/tasks.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="TAG Logics id">
            <Input placeholder="433" {...form.register("tagLogicsId")} />
          </Field>
          <Field label="TAG SO id" hint="Sent to Logics as SetOfficerID on postdate/deal.">
            <Input placeholder="433" {...form.register("tagSOId")} />
          </Field>
          <Field label="TAG email">
            <Input placeholder="polson@taxadvocategroup.com" {...form.register("tagEmail")} />
          </Field>
          <Field label="TAG name">
            <Input placeholder="Phil Olson" {...form.register("tagLogicsName")} />
          </Field>
          <Field label="TAG roles" hint="Comma-separated.">
            <Input placeholder="Case Worker, Opener" {...form.register("tagLogicsRoles")} />
          </Field>
        </div>
      </div>

      <div className="rounded-xl border border-border/60 bg-muted/20 p-4 space-y-4">
        <div>
          <p className="text-sm font-medium">WYNN identity</p>
          <p className="text-[11px] text-muted-foreground">
            Used when the agent is acting inside WYNN cases/tasks.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="WYNN Logics id">
            <Input placeholder="38" {...form.register("wynnLogicsId")} />
          </Field>
          <Field label="WYNN SO id" hint="Sent to Logics as SetOfficerID on postdate/deal.">
            <Input placeholder="38" {...form.register("wynnSOId")} />
          </Field>
          <Field label="WYNN email">
            <Input placeholder="agent@wynntaxsolutions.com" {...form.register("wynnEmail")} />
          </Field>
          <Field label="WYNN name">
            <Input placeholder="Agent Name" {...form.register("wynnLogicsName")} />
          </Field>
          <Field label="WYNN roles" hint="Comma-separated.">
            <Input placeholder="Case Manager, Tax Preparer" {...form.register("wynnLogicsRoles")} />
          </Field>
        </div>
      </div>

      <div className="rounded-xl border border-border/60 bg-muted/20 p-4 space-y-4">
        <div>
          <p className="text-sm font-medium">Logics credential state</p>
          <p className="text-[11px] text-muted-foreground">
            Metadata only for now. Secret material stays elsewhere.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Credential mode">
            <Input placeholder="company or user" {...form.register("logicsCredentialMode")} />
          </Field>
          <Field label="Credential status">
            <Input placeholder="pending / active / revoked" {...form.register("logicsCredentialStatus")} />
          </Field>
          <Field label="Scopes" hint="Comma-separated.">
            <Input placeholder="task.write, activity.write" {...form.register("logicsScopes")} />
          </Field>
          <Field label="Permissions label">
            <Input placeholder="Minimal write" {...form.register("logicsPermissionsLabel")} />
          </Field>
          <Field label="Secret reference" hint="Vault key or external secret ref.">
            <Input placeholder="vault://logics/polson" {...form.register("logicsExternalSecretRef")} />
          </Field>
        </div>
      </div>

      {footer({
        submit,
        isSubmitting: isSubmitting || form.formState.isSubmitting,
        isDirty: form.formState.isDirty,
      })}
    </form>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {hint && !error ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function IdentityLookupSummary({
  result,
  error,
}: {
  result: AccountIdentityResolveResult | null;
  error: Error | null;
}) {
  if (error) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-destructive">
        <AlertCircle className="h-3.5 w-3.5" />
        {error.message}
      </div>
    );
  }
  if (!result) {
    return null;
  }

  const exMatched = Boolean(result.matches.ex.match);
  const cxMatched = Boolean(result.matches.cx.match);
  const logicsMatched = Boolean(result.matches.logics?.found);
  const oauthReady = Boolean(result.oauth?.configured);
  const existing = result.existing;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <StatusPill dotted tone={exMatched ? "success" : result.matches.ex.error ? "danger" : "warning"}>
        EX {exMatched ? "found" : result.matches.ex.error ? "error" : "missing"}
      </StatusPill>
      <StatusPill dotted tone={cxMatched ? "success" : result.matches.cx.error ? "danger" : "warning"}>
        CX {cxMatched ? "found" : result.matches.cx.error ? "error" : "missing"}
      </StatusPill>
      <StatusPill dotted tone={logicsMatched ? "success" : "neutral"}>
        Logics {logicsMatched ? "found" : "none"}
      </StatusPill>
      <StatusPill dotted tone={oauthReady ? "success" : "warning"}>
        OAuth {oauthReady ? "ready" : "not configured"}
      </StatusPill>
      {existing ? (
        <StatusPill tone="accent">
          <CheckCircle2 className="h-3 w-3" />
          Existing {existing.status}
        </StatusPill>
      ) : null}
    </div>
  );
}
