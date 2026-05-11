import React from "react";
import ReactDOM from "react-dom/client";
import "@/design/globals.css";
import { AppProviders } from "@/app/Providers";
import { AppRoutes } from "@/app/routes";

const CHUNK_RECOVERY_KEY = "__parallel_chunk_recovery_at__";

function triggerChunkRecovery() {
  if (typeof window === "undefined") return false;
  const now = Date.now();
  const lastAttemptRaw = window.sessionStorage.getItem(CHUNK_RECOVERY_KEY);
  const lastAttempt = Number(lastAttemptRaw || 0);
  if (Number.isFinite(lastAttempt) && now - lastAttempt < 15000) {
    return false;
  }
  window.sessionStorage.setItem(CHUNK_RECOVERY_KEY, String(now));
  window.location.reload();
  return true;
}

if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", (event) => {
    event.preventDefault?.();
    triggerChunkRecovery();
  });

  window.addEventListener("error", (event) => {
    const message = String((event as ErrorEvent)?.message || "");
    if (message.includes("Failed to fetch dynamically imported module")) {
      triggerChunkRecovery();
    }
  });
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found");
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <AppProviders>
      <AppRoutes />
    </AppProviders>
  </React.StrictMode>,
);
