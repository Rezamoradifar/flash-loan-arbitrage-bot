"use client";

import { useEffect, useState } from "react";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { isAddress } from "viem";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CONTRACT_ADDRESS, BSCSCAN_TX_URL } from "@/lib/contract";
import { EXECUTOR_ABI } from "@/lib/executorAbi";

export type FieldType = "address" | "uint" | "bool" | "bytes32" | "string";

export interface FieldSpec {
  name: string;
  type: FieldType;
  label: string;
  placeholder?: string;
}

export interface AdminActionSpec {
  functionName: string;
  title: string;
  description: string;
  fields: FieldSpec[];
  destructive?: boolean;
  confirmText?: string;
}

function parseField(type: FieldType, raw: string): unknown {
  if (type === "address") {
    if (!isAddress(raw)) throw new Error(`Invalid address: ${raw || "(empty)"}`);
    return raw;
  }
  if (type === "uint") {
    if (raw === "" || !/^\d+$/.test(raw)) throw new Error("Expected a non-negative integer");
    return BigInt(raw);
  }
  if (type === "bool") {
    return raw === "true";
  }
  if (type === "bytes32") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error("Expected a 32-byte hex string (0x + 64 hex chars)");
    return raw;
  }
  return raw;
}

export function AdminActionForm({ spec }: { spec: AdminActionSpec }) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(spec.fields.map((f) => [f.name, f.type === "bool" ? "true" : ""]))
  );

  const { data: hash, writeContract, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (isSuccess && hash) {
      toast.success(`${spec.title} confirmed`, {
        description: hash,
        action: { label: "View", onClick: () => window.open(BSCSCAN_TX_URL(hash), "_blank") },
      });
      reset();
    }
  }, [isSuccess, hash, spec.title, reset]);

  useEffect(() => {
    if (error) toast.error(`${spec.title} failed`, { description: error.message.slice(0, 180) });
  }, [error, spec.title]);

  function submit() {
    if (spec.destructive && !window.confirm(spec.confirmText ?? `Confirm: ${spec.title}?`)) return;
    try {
      const args = spec.fields.map((f) => parseField(f.type, values[f.name]));
      writeContract({
        address: CONTRACT_ADDRESS,
        abi: EXECUTOR_ABI,
        functionName: spec.functionName as never,
        args: args as never,
      });
      toast.loading(`Submitting ${spec.title}...`, { id: spec.functionName, duration: 3000 });
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const busy = isPending || isConfirming;

  return (
    <div className="rounded-xl border border-white/5 p-4">
      <div className="mb-3">
        <h4 className="text-sm font-medium">{spec.title}</h4>
        <p className="text-xs text-muted">{spec.description}</p>
      </div>
      {spec.fields.length > 0 && (
        <div className="mb-3 grid gap-2 sm:grid-cols-2">
          {spec.fields.map((f) => (
            <div key={f.name} className="flex flex-col gap-1">
              <label className="text-[11px] text-muted">{f.label}</label>
              {f.type === "bool" ? (
                <select
                  value={values[f.name]}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                  className="h-9 rounded-lg border border-white/10 bg-white/5 px-2 text-sm outline-none focus:border-gold/50"
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input
                  value={values[f.name]}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                  placeholder={f.placeholder}
                  className="h-9 rounded-lg border border-white/10 bg-white/5 px-3 text-sm outline-none focus:border-gold/50 font-mono"
                />
              )}
            </div>
          ))}
        </div>
      )}
      <Button
        size="sm"
        variant={spec.destructive ? "destructive" : "default"}
        disabled={busy}
        onClick={submit}
      >
        {busy && <Loader2 size={14} className="animate-spin" />}
        {isPending ? "Confirm in wallet..." : isConfirming ? "Waiting for confirmation..." : "Submit"}
      </Button>
    </div>
  );
}
