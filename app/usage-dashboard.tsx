"use client";

import { useEffect, useMemo, useState } from "react";
import { ProviderIcon } from "./provider-icon";
import type { ProviderId, UsageAccount, UsageSnapshot, UsageWindow } from "@/lib/usage/types";

const POLL_INTERVAL_MS = 60_000;

const providerOrder: ReadonlyArray<ProviderId> = [
  "codex",
  "anthropic",
  "xai",
  "zai",
  "opencode-go",
];

const percentText = (value: number) => (value > 0 && value < 1 ? "<1" : `${Math.round(value)}`);

const formatCountdown = (target: string | null, now: number) => {
  if (!target) return "—";
  const delta = Date.parse(target) - now;
  if (!Number.isFinite(delta)) return "—";
  if (delta <= 0) return "pending";
  const minutes = Math.ceil(delta / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days} d ${hours} hr`;
  if (hours > 0) return `${hours} hr ${mins} min`;
  return `${mins} min`;
};

const formatAge = (iso: string, now: number) => {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} hr` : `${Math.floor(hours / 24)} d`;
};

const primaryWindow = (account: UsageAccount): UsageWindow | undefined =>
  account.windows.find((window) => window.durationMinutes === 10_080) ?? account.windows[0];

function PoolSummary({
  provider,
  accounts,
}: Readonly<{ provider: ProviderId; accounts: ReadonlyArray<UsageAccount> }>) {
  const windows = accounts.map((account) => primaryWindow(account));
  const reporting = windows.filter((window): window is UsageWindow => window !== undefined);
  const remaining = reporting.reduce((total, window) => total + window.remainingPercent, 0);
  const capacity = reporting.length * 100;
  const label = reporting[0]?.label ?? "Weekly";
  const providerName = accounts[0]?.providerName ?? provider;

  return (
    <div className="pool" data-provider={provider}>
      <div className="pool-head">
        <ProviderIcon provider={provider} />
        <span className="pool-name">{providerName}</span>
      </div>
      {reporting.length === 0 ? (
        <p className="pool-empty">Usage unavailable</p>
      ) : (
        <>
          <p className="pool-figure">
            <span className="pool-percent">{percentText(remaining)}</span>
            <span className="pool-unit">%</span>
            <span className="pool-of">of {capacity}%</span>
          </p>
          <p className="pool-label">
            <span>{label} window</span>
            <span>
              {accounts.length} {accounts.length === 1 ? "account" : "accounts"}
            </span>
          </p>
          <div className="segments" aria-hidden="true">
            {reporting.map((window, index) => (
              <span className="segment" key={index}>
                <span style={{ width: `${window.remainingPercent}%` }} />
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function AccountCard({ account, now }: Readonly<{ account: UsageAccount; now: number }>) {
  const unavailable = account.status === "unavailable";

  return (
    <section className="account" data-provider={account.provider} aria-label={account.account}>
      <header className="account-head">
        <div>
          <h2>{account.account}</h2>
          <p className="account-plan">
            <span className="account-plan-name">{account.plan ?? account.providerName}</span>
            {account.primary ? <span className="account-note"> · pool first</span> : null}
            {account.status === "stale" ? (
              <span className="account-note">
                {" "}
                · stale{account.updatedAt ? ` ${formatAge(account.updatedAt, now)}` : ""}
              </span>
            ) : null}
          </p>
        </div>
        <ProviderIcon provider={account.provider} />
      </header>

      <div className="account-windows">
        {unavailable ? (
          <p className="account-empty">
            Usage unavailable{account.message ? ` · ${account.message}` : ""}
          </p>
        ) : (
          account.windows.map((window) => (
            <div className="window" key={window.id}>
              <div className="window-row">
                <span>{window.label} window</span>
                <span className="window-left">
                  <span className="window-reset">{formatCountdown(window.resetsAt, now)}</span>
                  {percentText(window.remainingPercent)}% left
                </span>
              </div>
              <div
                className="bar"
                role="meter"
                aria-label={`${window.label} window`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(window.remainingPercent)}
              >
                <span style={{ width: `${Math.max(window.remainingPercent, 0)}%` }} />
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export function UsageDashboard({ initialSnapshot }: Readonly<{ initialSnapshot: UsageSnapshot }>) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    const poll = async () => {
      try {
        const response = await fetch("/api/usage", { cache: "no-store" });
        if (!response.ok) throw new Error("Usage request failed");
        setSnapshot((await response.json()) as UsageSnapshot);
      } catch {
        // Keep the last snapshot until the next poll succeeds.
      }
    };
    const interval = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, []);

  const pools = useMemo(
    () =>
      providerOrder
        .map((provider) => ({
          provider,
          accounts: snapshot.accounts.filter((account) => account.provider === provider),
        }))
        .filter((pool) => pool.accounts.length > 0),
    [snapshot],
  );

  return (
    <main className="shell">
      <h1 className="sr-only">Account pools</h1>

      {pools.length === 0 ? (
        <p className="empty">No subscriptions to show.</p>
      ) : (
        <>
          <section className="pools" aria-label="Provider pools">
            {pools.map((pool) => (
              <PoolSummary key={pool.provider} provider={pool.provider} accounts={pool.accounts} />
            ))}
          </section>

          <section className="accounts" aria-label="Accounts">
            {pools.flatMap((pool) =>
              pool.accounts.map((account) => (
                <AccountCard key={account.id} account={account} now={now} />
              )),
            )}
          </section>
        </>
      )}
      <p className="updated">
        Updated {formatAge(snapshot.generatedAt, now)}
        {snapshot.generatedAt && formatAge(snapshot.generatedAt, now) !== "just now" ? " ago" : ""}
      </p>
    </main>
  );
}
