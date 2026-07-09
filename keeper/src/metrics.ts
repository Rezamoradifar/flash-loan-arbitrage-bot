/**
 * Lightweight, dependency-free metrics tracker (observability requirement).
 * Deliberately not wired to Prometheus/StatsD/etc. - that would mean adding
 * a metrics-server dependency and an HTTP endpoint neither asked for nor
 * exercised by anything in this repo. What's here is the same counters you'd
 * expose that way: call `.summary()` on whatever cadence you want (this
 * bot logs it once per scan) or serialize `.snapshot()` yourself if you wire
 * up a real exporter later.
 */
export class Metrics {
  private evaluated = 0;
  private accepted = 0;
  private rejectedByReason = new Map<string, number>();
  private cumulativeAcceptedNetProfitByAsset = new Map<string, bigint>();
  private scanCount = 0;
  private lastScanMs = 0;
  private startedAt = Date.now();

  recordEvaluated(): void {
    this.evaluated++;
  }

  recordAccepted(assetSymbol: string, netProfit: bigint): void {
    this.accepted++;
    const prev = this.cumulativeAcceptedNetProfitByAsset.get(assetSymbol) ?? 0n;
    this.cumulativeAcceptedNetProfitByAsset.set(assetSymbol, prev + netProfit);
  }

  /** category should be a short, stable bucket (e.g. "negative-after-premium",
   *  "below-threshold", "no-liquidity") - not the full free-text reason string,
   *  so counts are actually aggregable. */
  recordRejected(category: string): void {
    this.rejectedByReason.set(category, (this.rejectedByReason.get(category) ?? 0) + 1);
  }

  recordScanDuration(ms: number): void {
    this.scanCount++;
    this.lastScanMs = ms;
  }

  snapshot() {
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      scanCount: this.scanCount,
      lastScanMs: this.lastScanMs,
      evaluated: this.evaluated,
      accepted: this.accepted,
      rejected: this.evaluated - this.accepted,
      rejectedByReason: Object.fromEntries(this.rejectedByReason),
      cumulativeAcceptedNetProfitByAsset: Object.fromEntries(
        [...this.cumulativeAcceptedNetProfitByAsset.entries()].map(([k, v]) => [k, v.toString()])
      ),
    };
  }

  summary(): string {
    const s = this.snapshot();
    const rejectParts = Object.entries(s.rejectedByReason)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    const profitParts = Object.entries(s.cumulativeAcceptedNetProfitByAsset)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    return (
      `[metrics] uptime=${s.uptimeSec}s scans=${s.scanCount} lastScan=${s.lastScanMs}ms ` +
      `evaluated=${s.evaluated} accepted=${s.accepted} rejected=${s.rejected}` +
      (rejectParts ? ` | rejected-by-reason: ${rejectParts}` : "") +
      (profitParts ? ` | cumulative accepted net profit: ${profitParts}` : "")
    );
  }
}
