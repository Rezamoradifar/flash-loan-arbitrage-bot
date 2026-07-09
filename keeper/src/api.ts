import { createServer, type Server } from "node:http";
import type { Metrics } from "./metrics.js";
import type { Opportunity } from "./scanner.js";

/**
 * Minimal, dependency-free HTTP API (no Express, just node:http) so the
 * frontend's "live opportunities" page has something real to poll. Exposes
 * the most recent dynamic-mode scan cycle's ranked opportunities and metrics
 * snapshot. Read-only - this server never accepts writes, and never handles
 * private keys or signing; it only serializes state the keeper process
 * already computed for its own logging.
 *
 * Deliberately in-memory / single-process: this is a monitoring surface for
 * one keeper instance, not a durable store. If the process restarts, history
 * resets - that's fine for "what is the bot seeing right now."
 */
interface LatestScan {
  lastScanAt: number | null;
  durationMs: number | null;
  opportunities: Opportunity[];
}

const latest: LatestScan = { lastScanAt: null, durationMs: null, opportunities: [] };
let latestMetrics: Metrics | null = null;

export function recordScanResult(opportunities: Opportunity[], durationMs: number, metrics: Metrics): void {
  latest.lastScanAt = Date.now();
  latest.durationMs = durationMs;
  latest.opportunities = opportunities;
  latestMetrics = metrics;
}

function serializeOpportunity(o: Opportunity) {
  return {
    name: o.candidate.name,
    baseAsset: o.candidate.baseAsset,
    amount: o.amount.toString(),
    grossOut: o.candidate.grossOut.toString(),
    netProfit: o.netProfit.toString(),
    executable: o.executable,
    breakdown: o.breakdown ?? null,
  };
}

function send(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

export interface StatusInfo {
  chainId: string;
  keeperAddress: string | null;
  executorAddress: string | null;
  scanMode: string;
  triggerMode: string;
  dryRun: boolean;
}

export function startApiServer(port: number, getStatus: () => StatusInfo): Server {
  const server = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      });
      res.end();
      return;
    }

    const url = req.url?.split("?")[0];
    if (req.method !== "GET") {
      send(res, 405, { error: "GET only - this API is read-only" });
    } else if (url === "/api/status") {
      send(res, 200, getStatus());
    } else if (url === "/api/opportunities") {
      send(res, 200, {
        lastScanAt: latest.lastScanAt,
        durationMs: latest.durationMs,
        count: latest.opportunities.length,
        opportunities: latest.opportunities.map(serializeOpportunity),
      });
    } else if (url === "/api/metrics") {
      send(res, 200, latestMetrics ? latestMetrics.snapshot() : { note: "no scan has completed yet" });
    } else {
      send(res, 404, { error: "not found", routes: ["/api/status", "/api/opportunities", "/api/metrics"] });
    }
  });

  server.listen(port, () => {
    console.log(`[api] listening on http://0.0.0.0:${port} (routes: /api/status, /api/opportunities, /api/metrics)`);
  });

  return server;
}
