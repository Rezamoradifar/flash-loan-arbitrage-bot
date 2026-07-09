"use client";

import { useAccount, useReadContract } from "wagmi";
import { ShieldAlert } from "lucide-react";
import { CONTRACT_ADDRESS } from "@/lib/contract";
import { EXECUTOR_ABI } from "@/lib/executorAbi";

export function OwnerGuard({ children }: { children: React.ReactNode }) {
  const { address, isConnected } = useAccount();
  const { data: owner, isLoading, isError } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: EXECUTOR_ABI,
    functionName: "owner",
    query: { retry: 2 },
  });

  const isOwner = !!address && !!owner && address.toLowerCase() === (owner as string).toLowerCase();

  if (isConnected && isLoading) {
    return <p className="text-sm text-muted px-4 sm:px-6 py-10">Verifying ownership...</p>;
  }

  if (isConnected && isError) {
    return (
      <div className="mx-auto max-w-lg px-4 py-24 text-center">
        <ShieldAlert className="mx-auto mb-4 text-danger" size={32} />
        <h1 className="text-xl font-semibold mb-2">Could Not Verify Ownership</h1>
        <p className="text-sm text-muted">
          Failed to read the contract owner from the configured RPC. Check NEXT_PUBLIC_RPC_URL and try again.
        </p>
      </div>
    );
  }

  if (!isConnected || !isOwner) {
    return (
      <div className="mx-auto max-w-lg px-4 py-24 text-center">
        <ShieldAlert className="mx-auto mb-4 text-danger" size={32} />
        <h1 className="text-xl font-semibold mb-2">Owner Access Required</h1>
        <p className="text-sm text-muted">
          {isConnected
            ? "The connected wallet is not the contract owner. Switch to the owner wallet to access admin controls."
            : "Connect the contract owner's wallet to access admin controls."}
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
