import { Building2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { KNOWN_DOMAINS, useDomainStore } from "@/lib/domain/domainStore";
import { cn } from "@/lib/utils/cn";

interface DomainSwitcherProps {
  className?: string;
  domains?: readonly string[];
}

export function DomainSwitcher({ className, domains = KNOWN_DOMAINS }: DomainSwitcherProps) {
  const domain = useDomainStore((s) => s.domain);
  const setDomain = useDomainStore((s) => s.setDomain);

  return (
    <Select value={domain} onValueChange={setDomain}>
      <SelectTrigger className={cn("h-8 w-[140px] text-xs", className)} aria-label="Domain">
        <span className="flex items-center gap-2 truncate">
          <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent>
        {domains.map((d) => (
          <SelectItem key={d} value={d}>
            {d}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
