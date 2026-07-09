import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

/** Server-only - deliberately NOT prefixed NEXT_PUBLIC_, so it never gets
 *  inlined into the client bundle. Put a paid/keyed RPC endpoint here (e.g.
 *  Tatum, Ankr, QuickNode) and it stays server-side; the browser only ever
 *  talks to this same-origin /api/rpc route, never the real upstream URL or
 *  its API key. Falls back to a public endpoint if unset. */
const UPSTREAM_RPC_URL = process.env.RPC_URL || "https://bsc-rpc.publicnode.com";

const UPSTREAM_TIMEOUT_MS = 15_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;

/** This proxy is only ever used by the dashboard's own read-only viem
 *  public client (contract reads, event logs, block/gas queries, filter
 *  polling for live event watching) - it never needs to submit or sign
 *  anything; wallet-initiated transactions go straight through the
 *  connected wallet's own provider (MetaMask/WalletConnect/etc.), bypassing
 *  this route entirely. Blocking write/introspection methods here means the
 *  worst an outside caller can do by hitting this now-public endpoint is
 *  burn read-request quota, not spend funds or extract node-admin info. */
const BLOCKED_METHOD_PREFIXES = ["personal_", "debug_", "admin_", "wallet_", "miner_", "txpool_"];
const BLOCKED_METHODS = new Set(["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "eth_signTransaction"]);

/** Simple in-memory sliding-window limiter, per client IP - resets on
 *  restart and isn't shared across multiple instances, which is fine for
 *  this project's single-container deployment (see docker-compose.yml).
 *  Its purpose is blunting casual abuse of a possibly-metered upstream RPC
 *  key, not serving as a hardened DDoS defense. */
const rateLimitBuckets = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (rateLimitBuckets.get(ip) ?? []).filter((t) => t > windowStart);
  timestamps.push(now);
  rateLimitBuckets.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

function isBlockedMethod(method: unknown): boolean {
  if (typeof method !== "string") return true;
  if (BLOCKED_METHODS.has(method)) return true;
  return BLOCKED_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix));
}

interface JsonRpcRequestLike {
  method?: unknown;
}

function validateBody(body: unknown): { ok: true } | { ok: false; error: string } {
  const items = Array.isArray(body) ? body : [body];
  if (items.length === 0 || items.length > 50) {
    return { ok: false, error: "Invalid batch size" };
  }
  for (const item of items) {
    if (!item || typeof item !== "object" || !("method" in item)) {
      return { ok: false, error: "Invalid JSON-RPC request" };
    }
    const method = (item as JsonRpcRequestLike).method;
    if (isBlockedMethod(method)) {
      return { ok: false, error: `Method not allowed through this proxy: ${String(method)}` };
    }
  }
  return { ok: true };
}

export async function POST(request: NextRequest) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";

  if (isRateLimited(ip)) {
    return NextResponse.json({ error: "Rate limit exceeded - try again shortly" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateBody(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstreamRes = await fetch(UPSTREAM_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await upstreamRes.text();
    return new NextResponse(text, {
      status: upstreamRes.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Upstream RPC request failed: ${(err as Error).message}` },
      { status: 502 }
    );
  } finally {
    clearTimeout(timer);
  }
}
