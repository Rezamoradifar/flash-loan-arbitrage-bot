"use client";

import { useReadContract, useChainId, useBlockNumber } from "wagmi";
import { FileText } from "lucide-react";
import { GlassCard } from "@/components/ui/glass-card";
import { CONTRACT_ADDRESS, BSCSCAN_ADDRESS_URL } from "@/lib/contract";
import { EXECUTOR_ABI } from "@/lib/executorAbi";
import { shortenAddress } from "@/lib/utils";

export function ContractInfoCard() {
  const chainId = useChainId();
  const { data: blockNumber } = useBlockNumber({ watch: true });
  const { data: owner } = useReadContract({ address: CONTRACT_ADDRESS, abi: EXECUTOR_ABI, functionName: "owner" });
  const { data: keeper } = useReadContract({ address: CONTRACT_ADDRESS, abi: EXECUTOR_ABI, functionName: "keeper" });
  const { data: profitRecipient } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: EXECUTOR_ABI,
    functionName: "profitRecipient",
  });
  const { data: paused } = useReadContract({ address: CONTRACT_ADDRESS, abi: EXECUTOR_ABI, functionName: "paused" });

  const rows: Array<[string, React.ReactNode]> = [
    ["Contract", <a key="c" href={BSCSCAN_ADDRESS_URL(CONTRACT_ADDRESS)} target="_blank" rel="noreferrer" className="hover:text-gold">{shortenAddress(CONTRACT_ADDRESS, 6)}</a>],
    ["Owner", owner ? shortenAddress(owner as string, 6) : "—"],
    ["Keeper", keeper ? shortenAddress(keeper as string, 6) : "—"],
    ["Profit Recipient", profitRecipient ? shortenAddress(profitRecipient as string, 6) : "—"],
    ["Chain ID", chainId.toString()],
    ["Latest Block", blockNumber ? blockNumber.toString() : "—"],
    ["Status", paused ? "Paused" : "Active"],
  ];

  return (
    <GlassCard>
      <div className="flex items-center gap-2 mb-4">
        <FileText size={16} className="text-gold" />
        <h3 className="font-medium">Smart Contract</h3>
      </div>
      <div className="flex flex-col gap-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label as string} className="flex items-center justify-between">
            <span className="text-muted">{label}</span>
            <span className="font-medium">{value}</span>
          </div>
        ))}
      </div>
    </GlassCard>
  );
}
