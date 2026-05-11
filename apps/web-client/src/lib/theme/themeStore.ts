import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/**
 * User-facing theme preference. "system" follows `prefers-color-scheme`
 * at the OS level — the default so new users land on whatever their
 * device is configured for, which feels polite.
 *
 * The resolved light/dark value is computed by the `useResolvedTheme`
 * hook below and applied via a `.dark` class on `<html>` in
 * `ThemeProvider`.
 */
export type ThemePreference = "light" | "dark" | "system";

interface ThemeState {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      preference: "system",
      setPreference: (preference) => set({ preference }),
    }),
    {
      name: "web-client-theme",
      storage: createJSONStorage(() => window.localStorage),
    },
  ),
);
