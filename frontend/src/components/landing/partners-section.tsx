"use client";

const partners = [
  "Aave V3",
  "PancakeSwap V2",
  "PancakeSwap V3",
  "Biswap",
  "ApeSwap",
  "BakerySwap",
  "Wombat Exchange",
  "Chainlink",
];

export function PartnersSection() {
  return (
    <section className="mx-auto max-w-7xl px-4 sm:px-6 py-12">
      <p className="text-center text-xs uppercase tracking-widest text-muted mb-6">
        Integrated Protocols &amp; Liquidity Sources
      </p>
      <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4 opacity-80">
        {partners.map((p) => (
          <span key={p} className="text-sm font-medium text-foreground/70">
            {p}
          </span>
        ))}
      </div>
    </section>
  );
}
