import { Hero } from "@/components/landing/hero";
import { LiveStats } from "@/components/landing/live-stats";
import { SecuritySection } from "@/components/landing/security-section";
import { AuditSection } from "@/components/landing/audit-section";
import { PartnersSection } from "@/components/landing/partners-section";
import { FaqSection } from "@/components/landing/faq-section";
import { RoadmapSection } from "@/components/landing/roadmap-section";

export default function Home() {
  return (
    <div>
      <Hero />
      <LiveStats />
      <PartnersSection />
      <SecuritySection />
      <AuditSection />
      <RoadmapSection />
      <FaqSection />
    </div>
  );
}
