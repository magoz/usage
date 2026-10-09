import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NON_FRESH_SNAPSHOT_TTL_MS,
  RateLimitedError,
  resolveAccount,
  snapshotTtlMs,
  type AccountInput,
  type AccountSample,
} from "./sampling";
import { loadState, saveState } from "./state-store";
import type { UsageAccount, UsageSnapshot, UsageWindow } from "./types";

const window: UsageWindow = {
  id: "weekly",
  label: "Weekly",
  remainingPercent: 60,
  usedPercent: 40,
  resetsAt: null,
  durationMinutes: 10_080,
};

const snapshot = (
  statuses: ReadonlyArray<UsageAccount["status"]>,
): Pick<UsageSnapshot, "accounts"> => ({
  accounts: statuses.map((status) => ({ status }) as UsageAccount),
});

const input = (load: AccountInput["load"]): AccountInput => ({
  provider: "anthropic",
  account: "someone@example.com",
  refreshIntervalMinutes: 10,
  activity: [{ time: "t", success: 1, failed: 0 }],
  load,
});

describe("snapshotTtlMs", () => {
  it("uses the configured TTL when every account is fresh", () => {
    expect(snapshotTtlMs(snapshot(["fresh", "fresh"]), 300_000)).toBe(300_000);
    expect(snapshotTtlMs(snapshot([]), 300_000)).toBe(300_000);
  });

  it("caps the TTL when any account is stale or unavailable", () => {
    expect(snapshotTtlMs(snapshot(["fresh", "stale"]), 300_000)).toBe(NON_FRESH_SNAPSHOT_TTL_MS);
    expect(snapshotTtlMs(snapshot(["unavailable"]), 300_000)).toBe(60_000);
    expect(snapshotTtlMs(snapshot(["unavailable"]), 10_000)).toBe(10_000);
  });
});

describe("resolveAccount", () => {
  let directory: string | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = null;
  });

  // Simulates a restart: sample a provider, persist, then reload into a fresh map.
  const restartWith = async (samples: Map<string, AccountSample>) => {
    directory = await mkdtemp(join(tmpdir(), "usage-sampling-"));
    const path = join(directory, "state.json");
    await saveState(path, samples);
    return (await loadState(path)).samples;
  };

  it("records a fresh sample and throttles until the interval elapses", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-28T09:00:00Z") });
    const samples = new Map<string, AccountSample>();
    const load = vi.fn(async () => ({ windows: [window] }));
    const onSample = vi.fn();

    const first = await resolveAccount(samples, input(load), onSample);
    expect(first.status).toBe("fresh");
    vi.advanceTimersByTime(9 * 60_000);
    const second = await resolveAccount(samples, input(load), onSample);

    expect(load).toHaveBeenCalledTimes(1);
    expect(onSample).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("serves restored samples within nextAllowedAt without calling the loader", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-28T09:00:00Z") });
    const before = new Map<string, AccountSample>();
    await resolveAccount(
      before,
      input(async () => ({ windows: [window] })),
    );

    const restored = await restartWith(before);
    vi.advanceTimersByTime(60_000);
    const load = vi.fn(async () => ({ windows: [] }));
    const account = await resolveAccount(restored, input(load));

    expect(load).not.toHaveBeenCalled();
    expect(account.status).toBe("fresh");
    expect(account.windows).toEqual([window]);
    expect(account.activity).toEqual([{ time: "t", success: 1, failed: 0 }]);
  });

  it("honours a persisted rate-limit backoff after a restart", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-28T09:00:00Z") });
    const before = new Map<string, AccountSample>();
    const limited = await resolveAccount(
      before,
      input(async () => {
        throw new RateLimitedError("1800");
      }),
    );
    expect(limited.status).toBe("unavailable");

    const restored = await restartWith(before);
    vi.advanceTimersByTime(20 * 60_000);
    const load = vi.fn(async () => ({ windows: [window] }));
    const account = await resolveAccount(restored, input(load));

    expect(load).not.toHaveBeenCalled();
    expect(account.status).toBe("unavailable");
    expect(account.message).toBe("rate limited");
  });

  it("falls back to the restored last-good sample as stale when a fetch fails", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-28T09:00:00Z") });
    const before = new Map<string, AccountSample>();
    await resolveAccount(
      before,
      input(async () => ({ windows: [window] })),
    );

    const restored = await restartWith(before);
    vi.advanceTimersByTime(11 * 60_000);
    const load = vi.fn(async () => {
      throw new RateLimitedError(null);
    });
    const account = await resolveAccount(restored, input(load));

    expect(load).toHaveBeenCalledTimes(1);
    expect(account.status).toBe("stale");
    expect(account.windows).toEqual([window]);
    expect(account.updatedAt).toBe("2026-09-28T09:00:00.000Z");
    expect(account.message).toBe("rate limited");
  });
});
