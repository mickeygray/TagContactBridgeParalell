import * as React from "react";
import { FileSearch } from "lucide-react";
import { useCaseInspectorStore } from "@/lib/caseInspector/caseInspectorStore";
import { useDomainStore } from "@/lib/domain/domainStore";
import { cn } from "@/lib/utils/cn";

export interface CaseLinkProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  caseId: string | number | null | undefined;
  /** Override the active domain — useful for CX where domain comes from the user. */
  domain?: string | null;
  /** Hide the leading icon for dense cells. */
  compact?: boolean;
  /** Text override; default is `Case {caseId}`. */
  children?: React.ReactNode;
}

/**
 * Clickable case id. Opens the global Case Inspector drawer. No-op (renders
 * muted em-dash) if the case id is missing.
 */
export const CaseLink = React.forwardRef<HTMLButtonElement, CaseLinkProps>(
  function CaseLink(
    { caseId, domain, compact, className, children, ...rest },
    ref,
  ) {
    const activeDomain = useDomainStore((s) => s.domain);
    const openCase = useCaseInspectorStore((s) => s.openCase);

    if (caseId == null || caseId === "") {
      return <span className="text-muted-foreground">—</span>;
    }

    const targetDomain = domain || activeDomain;
    const id = String(caseId);

    return (
      <button
        ref={ref}
        type="button"
        {...rest}
        onClick={(e) => {
          e.stopPropagation();
          if (!targetDomain) return;
          openCase(targetDomain, id);
        }}
        className={cn(
          "inline-flex items-center gap-1 rounded-md font-mono text-xs text-primary underline-offset-2 transition-colors hover:underline",
          compact ? "px-0" : "px-1.5 py-0.5 hover:bg-primary/5",
          className,
        )}
      >
        {compact ? null : (
          <FileSearch className="h-3 w-3 text-muted-foreground" aria-hidden />
        )}
        {children ?? <>Case {id}</>}
      </button>
    );
  },
);
