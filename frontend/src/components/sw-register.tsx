"use client";

import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* best-effort - PWA install/offline shell caching is a progressive enhancement */
      });
    }
  }, []);
  return null;
}
