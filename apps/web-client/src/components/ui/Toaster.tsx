import { Toaster as SonnerToaster } from "sonner";
import { useResolvedTheme } from "@/lib/theme/ThemeProvider";

export function Toaster() {
  // Follow the app-wide theme so toasts don't pop as a bright rectangle
  // on a dark canvas.
  const theme = useResolvedTheme();
  return (
    <SonnerToaster
      position="bottom-right"
      closeButton
      theme={theme}
      richColors
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-card group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lift",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
    />
  );
}

export { toast } from "sonner";
