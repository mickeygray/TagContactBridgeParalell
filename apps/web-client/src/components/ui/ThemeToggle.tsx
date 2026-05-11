import * as React from "react";
import { Laptop, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useThemeStore, type ThemePreference } from "@/lib/theme/themeStore";
import { useResolvedTheme } from "@/lib/theme/ThemeProvider";
import { cn } from "@/lib/utils/cn";

/**
 * Cycling toggle: light → dark → system → light.
 *
 * Kept as a single button rather than a dropdown so we don't introduce
 * a new UI primitive (the app has no DropdownMenu component yet). The
 * icon reflects the currently-active *preference*, not the resolved
 * theme, so it's visually obvious when you're in "system" mode even if
 * the system happens to be dark right now.
 */
const CYCLE: Record<ThemePreference, ThemePreference> = {
  light: "dark",
  dark: "system",
  system: "light",
};

const ICONS: Record<ThemePreference, React.ComponentType<{ className?: string }>> = {
  light: Sun,
  dark: Moon,
  system: Laptop,
};

const LABELS: Record<ThemePreference, string> = {
  light: "Light theme",
  dark: "Dark theme",
  system: "Follow system theme",
};

export function ThemeToggle({ className }: { className?: string }) {
  const preference = useThemeStore((state) => state.preference);
  const setPreference = useThemeStore((state) => state.setPreference);
  const resolved = useResolvedTheme();

  const Icon = ICONS[preference];
  const nextPreference = CYCLE[preference];

  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("h-8 w-8 p-0", className)}
      onClick={() => setPreference(nextPreference)}
      title={`${LABELS[preference]} — click to switch to ${nextPreference}${
        preference === "system" ? ` (currently ${resolved})` : ""
      }`}
      aria-label={LABELS[preference]}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}
