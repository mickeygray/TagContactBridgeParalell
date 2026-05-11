import * as React from "react";
import { useThemeStore } from "@/lib/theme/themeStore";

/**
 * Resolved theme after considering `system` preference. Used by
 * components that need to know "are we currently light or dark?" (e.g.
 * Sonner toaster, anything that embeds a third-party widget that takes
 * a literal theme prop).
 */
type ResolvedTheme = "light" | "dark";

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Mounts a listener that applies the resolved theme to `document.documentElement`
 * (adds / removes the `.dark` class) and re-resolves when either the
 * user's preference or the OS preference changes.
 *
 * Wrapped as a provider component so `<Providers>` can compose it into
 * the tree without ordering mishaps.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const preference = useThemeStore((state) => state.preference);
  const [systemTheme, setSystemTheme] = React.useState<ResolvedTheme>(getSystemTheme);

  // Subscribe to OS-level theme changes so a user toggling their
  // system appearance while the tab is open sees the app follow along
  // (only matters when `preference === "system"` but the listener is
  // cheap so we always attach).
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);

  const resolved: ResolvedTheme =
    preference === "system" ? systemTheme : preference;

  // Apply `.dark` class on `<html>`. Tailwind's `darkMode: "class"`
  // reads from `document.documentElement.classList` so this is the
  // single source-of-truth write.
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (resolved === "dark") {
      root.classList.add("dark");
      root.style.colorScheme = "dark";
    } else {
      root.classList.remove("dark");
      root.style.colorScheme = "light";
    }
  }, [resolved]);

  return <ThemeContext.Provider value={{ resolved }}>{children}</ThemeContext.Provider>;
}

interface ThemeContextValue {
  resolved: ResolvedTheme;
}

const ThemeContext = React.createContext<ThemeContextValue>({ resolved: "light" });

export function useResolvedTheme(): ResolvedTheme {
  return React.useContext(ThemeContext).resolved;
}
