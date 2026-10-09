// Per-account sampling, throttling and snapshot-cache policy. Kept free of
// `server-only` and I/O so it can be unit tested; `service.ts` wires it up.
import type {
  ActivityBucket,
  ProviderId,
  ResetCredits,
  UsageAccount,
  UsageSnapshot,
  UsageWindow,
} from "./types";

export type AccountSample = {
  readonly account: UsageAccount;
  readonly nextAllowedAt: number;
};

// Snapshots that contain a stale/unavailable account are cached at most this long,
// so one upstream failure does not blank an account for the whole cache TTL.
export const NON_FRESH_SNAPSHOT_TTL_MS = 60_000;

export const snapshotTtlMs = (
  snapshot: Pick<UsageSnapshot, "accounts">,
  configuredTtlMs: number,
): number =>
  snapshot.accounts.every((account) => account.status === "fresh")
    ? configuredTtlMs
    : Math.min(configuredTtlMs, NON_FRESH_SNAPSHOT_TTL_MS);

export class RateLimitedError extends Error {
  readonly retryAfterMs: number | null;

  constructor(retryAfter: string | null) {
    super("rate limited");
    const seconds = Number(retryAfter);
    const at = retryAfter === null ? NaN : Date.parse(retryAfter);
    this.retryAfterMs = Number.isFinite(seconds)
      ? Math.max(0, seconds) * 1000
      : Number.isFinite(at)
        ? Math.max(0, at - Date.now())
        : null;
  }
}

const providerName = (provider: ProviderId) =>
  ({
    anthropic: "Claude",
    codex: "Codex",
    "opencode-go": "OpenCode Go",
  })[provider];

export type AccountInput = {
  provider: ProviderId;
  account: string;
  plan?: string | null;
  priority?: number;
  refreshIntervalMinutes: number;
  activity?: ReadonlyArray<ActivityBucket>;
  load: () => Promise<{
    windows: ReadonlyArray<UsageWindow>;
    plan?: string | null;
    resetCredits?: ResetCredits | null;
  }>;
};

// Returns the account's current reading. Providers are only re-queried once their
// own interval (or backoff) has elapsed, regardless of how often this is called.
// `onSample` is invoked only when a new sample was recorded (i.e. an upstream call happened).
export const resolveAccount = async (
  samples: Map<string, AccountSample>,
  input: AccountInput,
  onSample?: () => void,
): Promise<UsageAccount> => {
  const id = `${input.provider}:${input.account}`;
  const now = Date.now();
  const previous = samples.get(id);
  const base = {
    id,
    provider: input.provider,
    providerName: providerName(input.provider),
    account: input.account,
    priority: input.priority ?? 0,
    refreshIntervalMinutes: input.refreshIntervalMinutes,
    activity: input.activity ?? [],
  };
  const intervalMs = input.refreshIntervalMinutes * 60_000;

  if (previous && now < previous.nextAllowedAt) {
    return { ...previous.account, ...base, plan: previous.account.plan };
  }

  try {
    const result = await input.load();
    if (result.windows.length === 0) throw new Error("usage windows unavailable");

    const account: UsageAccount = {
      ...base,
      plan: result.plan ?? input.plan ?? null,
      status: "fresh",
      updatedAt: new Date(now).toISOString(),
      windows: result.windows,
      resetCredits: result.resetCredits ?? null,
      message: null,
    };
    samples.set(id, { account, nextAllowedAt: now + intervalMs });
    onSample?.();
    return account;
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    const retryAfterMs = error instanceof RateLimitedError ? error.retryAfterMs : null;
    const backoffMs = Math.max(60_000, Math.min(retryAfterMs ?? intervalMs, 60 * 60_000));
    const account: UsageAccount =
      previous && previous.account.windows.length > 0
        ? { ...previous.account, ...base, status: "stale", message }
        : {
            ...base,
            plan: input.plan ?? null,
            status: "unavailable",
            updatedAt: null,
            windows: [],
            resetCredits: null,
            message,
          };
    samples.set(id, { account, nextAllowedAt: now + backoffMs });
    onSample?.();
    return account;
  }
};
