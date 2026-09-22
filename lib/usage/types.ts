export type ProviderId = "anthropic" | "codex" | "xai" | "zai" | "opencode-go";

export type UsageWindow = {
  readonly id: string;
  readonly label: string;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly durationMinutes: number | null;
};

export type ResetCredits = {
  readonly available: number;
  readonly expiresAt: string | null;
};

export type ActivityBucket = {
  readonly time: string;
  readonly success: number;
  readonly failed: number;
};

export type UsageAccount = {
  readonly id: string;
  readonly provider: ProviderId;
  readonly providerName: string;
  readonly account: string;
  readonly plan: string | null;
  readonly priority: number;
  readonly primary: boolean;
  readonly status: "fresh" | "stale" | "unavailable";
  readonly updatedAt: string | null;
  readonly refreshIntervalMinutes: number;
  readonly windows: ReadonlyArray<UsageWindow>;
  readonly resetCredits: ResetCredits | null;
  readonly activity: ReadonlyArray<ActivityBucket>;
  readonly message: string | null;
};

export type UsageSnapshot = {
  readonly generatedAt: string;
  readonly accounts: ReadonlyArray<UsageAccount>;
  readonly warnings: ReadonlyArray<string>;
};
