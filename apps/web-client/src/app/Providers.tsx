import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "@/components/ui/Toaster";
import { ClientRuntimeSentinel } from "@/app/ClientRuntimeSentinel";
import { ApiError } from "@/lib/api/client";
import { ThemeProvider } from "@/lib/theme/ThemeProvider";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiError) {
            if (error.isUnauthorized) return false;
            if (error.status >= 400 && error.status < 500) return false;
          }
          return failureCount < 2;
        },
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(() => makeQueryClient());

  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <BrowserRouter>
          {children}
          <ClientRuntimeSentinel />
          <Toaster />
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
