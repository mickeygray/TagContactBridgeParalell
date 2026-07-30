import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3001,
    strictPort: true,
    proxy: {
      // Defaults to the real control plane. Point it elsewhere to develop
      // against a local stand-in — e.g. the trainer draft preview on 5099 —
      // so a dev tool never has to squat the control plane's port to be
      // reachable. A hardcoded target is what made that collision tempting.
      "/api": process.env.WEB_CLIENT_API_TARGET || "http://127.0.0.1:5001",
    },
  },
  build: {
    outDir: "build",
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react-router-dom"],
          "query-vendor": ["@tanstack/react-query", "@tanstack/react-table"],
          "radix-vendor": [
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-popover",
            "@radix-ui/react-select",
            "@radix-ui/react-slot",
            "@radix-ui/react-tabs",
            "@radix-ui/react-tooltip",
          ],
          "form-vendor": ["react-hook-form", "zod", "@hookform/resolvers"],
          "utils-vendor": ["date-fns", "clsx", "tailwind-merge", "class-variance-authority"],
          "icons-vendor": ["lucide-react"],
        },
      },
    },
  },
});
