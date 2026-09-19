import { Suspense } from "react";
import { connection } from "next/server";
import { UsageDashboard } from "./usage-dashboard";
import { getUsageSnapshot } from "@/lib/usage/service";

async function DashboardContent() {
  await connection();
  const snapshot = await getUsageSnapshot();

  return <UsageDashboard initialSnapshot={snapshot} />;
}

function DashboardLoading() {
  return (
    <main className="shell" aria-busy="true">
      <h1 className="sr-only">Account pools</h1>
      <section className="accounts" aria-label="Loading accounts">
        {Array.from({ length: 6 }, (_, index) => (
          <div className="account loading-card" key={index} aria-hidden="true">
            <div className="loading-line" />
            <div className="loading-bar" />
            <div className="loading-bar" />
          </div>
        ))}
      </section>
    </main>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<DashboardLoading />}>
      <DashboardContent />
    </Suspense>
  );
}
