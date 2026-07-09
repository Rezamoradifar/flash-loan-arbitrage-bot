"use client";

import { ShieldCheck } from "lucide-react";
import { OwnerGuard } from "@/components/admin/owner-guard";
import { CurrentConfigCard } from "@/components/admin/current-config-card";
import { AdminActionForm } from "@/components/admin/admin-action-form";
import { GlassCard } from "@/components/ui/glass-card";
import { ADMIN_GROUPS } from "@/lib/adminActions";

export default function AdminPage() {
  return (
    <OwnerGuard>
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-10">
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck size={20} className="text-gold" />
          <h1 className="text-2xl font-semibold">Admin Panel</h1>
        </div>
        <p className="text-sm text-muted mb-8">
          Owner-only controls. Every action below sends a real on-chain transaction from your connected wallet -
          nothing here is simulated.
        </p>

        <div className="mb-6">
          <CurrentConfigCard />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {ADMIN_GROUPS.map((group) => (
            <GlassCard key={group.key}>
              <h3 className="font-medium mb-1">{group.title}</h3>
              <p className="text-xs text-muted mb-4">{group.description}</p>
              <div className="flex flex-col gap-3">
                {group.actions.map((action) => (
                  <AdminActionForm key={action.functionName} spec={action} />
                ))}
              </div>
            </GlassCard>
          ))}
        </div>
      </div>
    </OwnerGuard>
  );
}
