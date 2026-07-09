"use client";

import "@rainbow-me/rainbowkit/styles.css";
import { RainbowKitProvider, darkTheme, lightTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WagmiProvider } from "wagmi";
import { Toaster } from "sonner";
import { wagmiConfig } from "@/lib/wagmiConfig";
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { LocaleProvider } from "@/components/locale-provider";
import { SettingsProvider } from "@/components/settings-provider";

const goldAccent = "#D4AF37";

function RainbowKitThemed({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <RainbowKitProvider
      theme={
        theme === "light"
          ? lightTheme({ accentColor: goldAccent, accentColorForeground: "#0A0A0B", borderRadius: "medium" })
          : darkTheme({ accentColor: goldAccent, accentColorForeground: "#0A0A0B", borderRadius: "medium" })
      }
    >
      {children}
      <Toaster richColors position="top-right" theme={theme === "light" ? "light" : "dark"} />
    </RainbowKitProvider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            refetchOnWindowFocus: false,
            // Bounded retries with a capped backoff - the wagmi/viem default
            // retry behavior otherwise compounds with our own transport-level
            // retries and can leave a failed read "loading" for a long time
            // before finally surfacing an error.
            retry: 2,
            retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
          },
        },
      })
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <LocaleProvider>
            <SettingsProvider>
              <RainbowKitThemed>{children}</RainbowKitThemed>
            </SettingsProvider>
          </LocaleProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
