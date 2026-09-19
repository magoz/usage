import { Suspense } from "react";
import { connection } from "next/server";
import { UsageDashboard } from "./usage-dashboard";
import { getUsageSnapshot } from "@/lib/usage/service";

async function DashboardContent() {
  await connection();
  const snapshot = await getUsageSnapshot({ force: true });

  return <UsageDashboard initialSnapshot={snapshot} />;
}

function DashboardLoading() {
  return (
    <main className="shell" aria-busy="true">
      <h1 className="sr-only">Account pools</h1>
      <section className="pools" aria-label="Loading provider pools">
        {Array.from({ length: 5 }, (_, index) => (
          <div className="pool" key={index} aria-hidden="true">
            <div className="pool-head">
              <span className="glyph skeleton" />
              <span className="skeleton skeleton-text" style={{ width: 72 }} />
            </div>
            <div className="pool-figure">
              <span className="skeleton skeleton-figure" />
            </div>
            <p className="pool-label">
              <span className="skeleton skeleton-text" style={{ width: 88 }} />
              <span className="skeleton skeleton-text" style={{ width: 56 }} />
            </p>
            <div className="segments">
              <span className="segment" />
            </div>
          </div>
        ))}
      </section>
      <section className="accounts" aria-label="Loading accounts">
        {Array.from({ length: 6 }, (_, index) => (
          <div className="account" key={index} aria-hidden="true">
            <header className="account-head">
              <div>
                <span className="skeleton skeleton-title" style={{ width: 160 }} />
                <p className="account-plan">
                  <span className="skeleton skeleton-text" style={{ width: 40 }} />
                </p>
              </div>
              <span className="glyph skeleton" />
            </header>
            <div className="account-windows">
              <div className="window">
                <div className="window-row">
                  <span className="skeleton skeleton-text" style={{ width: 96 }} />
                  <span className="skeleton skeleton-text" style={{ width: 110 }} />
                </div>
                <div className="bar" />
              </div>
            </div>
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
