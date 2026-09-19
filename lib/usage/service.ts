import "server-only";

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const defaultPath = (...segments: string[]) => join(home, ...segments);
import {
  normalizeAnthropicUsage,
  normalizeCodexUsage,
  normalizeGrokUsage,
  normalizeOpencodeGoUsage,
  normalizeZaiUsage,
  zaiPlan,
} from "./normalize";
import type { ActivityBucket, ProviderId, UsageAccount, UsageSnapshot, UsageWindow } from "./types";

type JsonRecord = Record<string, unknown>;

type Credential = {
  readonly fileName: string;
  readonly type: "claude" | "codex" | "xai";
  readonly email: string;
  readonly accessToken: string;
  readonly accountId: string | null;
  readonly priority: number;
  readonly disabled: boolean;
};

type RuntimeMetadata = {
  readonly fileName: string;
  readonly status: string;
  readonly statusMessage: string | null;
  readonly activity: ReadonlyArray<ActivityBucket>;
  readonly priority: number | null;
  readonly plan: string | null;
  readonly quotaPayload: unknown;
};

const providerOrder: Record<ProviderId, number> = {
  anthropic: 0,
  codex: 1,
  xai: 2,
  zai: 3,
  "opencode-go": 4,
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringValue = (value: unknown) => (typeof value === "string" ? value : null);
const numberValue = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const readText = async (path: string) => (await readFile(path, "utf8")).trim();

const readEnvValue = async (path: string, name: string): Promise<string | null> => {
  const content = await readText(path);
  const line = content
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(`${name}=`));

  if (!line) return null;

  const value = line.slice(name.length + 1).trim();
  return value.replace(/^(['"])(.*)\1$/, "$2") || null;
};

const readZaiKey = async (path: string): Promise<string | null> => {
  const content = await readText(path);
  let inProvider = false;

  for (const line of content.split(/\r?\n/)) {
    const provider = line.match(/^\s*-\s+name:\s*["']?([^"']+)["']?\s*$/);
    if (provider) inProvider = provider[1] === "zai-coding-plan";
    if (!inProvider) continue;

    const key = line.match(/^\s*-?\s*api-key:\s*["']?([^\s"']+)["']?\s*$/);
    if (key) return key[1];
  }

  return null;
};

const fetchJson = async (
  url: string,
  headers: HeadersInit,
  timeoutMs = 15_000,
): Promise<unknown> => {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "usage-dashboard/0.1",
      ...headers,
    },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status === 401 || response.status === 403) throw new Error("authentication failed");
  if (response.status === 429) throw new Error("rate limited");
  if (!response.ok) throw new Error(`request failed (${response.status})`);

  return response.json();
};

const loadCredentials = async (directory: string): Promise<ReadonlyArray<Credential>> => {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name);

  const credentials = await Promise.all(
    files.map(async (fileName) => {
      const payload: unknown = JSON.parse(await readText(join(directory, fileName)));
      if (!isRecord(payload)) return null;
      const type = payload.type;
      if (type !== "claude" && type !== "codex" && type !== "xai") return null;
      const email = stringValue(payload.email);
      const accessToken = stringValue(payload.access_token);
      if (!email || !accessToken) return null;

      return {
        fileName,
        type,
        email,
        accessToken,
        accountId: stringValue(payload.account_id),
        priority: numberValue(payload.priority) ?? 0,
        disabled: payload.disabled === true,
      } satisfies Credential;
    }),
  );

  return credentials.filter(
    (credential): credential is Credential => credential !== null && !credential.disabled,
  );
};

const activityBuckets = (value: unknown): ReadonlyArray<ActivityBucket> => {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const time = stringValue(item.time);
    const success = numberValue(item.success);
    const failed = numberValue(item.failed);
    if (time === null || success === null || failed === null) return [];

    return [{ time, success, failed }];
  });
};

const loadRuntimeMetadata = async (): Promise<Map<string, RuntimeMetadata>> => {
  const keyPath = process.env.CPA_MANAGEMENT_KEY_FILE ?? defaultPath("subs", "management.key");
  const baseUrl = process.env.CPA_BASE_URL ?? "http://127.0.0.1:8317";
  const managementKey = await readText(keyPath);
  const payload = await fetchJson(`${baseUrl}/v0/management/auth-files`, {
    Authorization: `Bearer ${managementKey}`,
  });
  if (!isRecord(payload) || !Array.isArray(payload.files)) return new Map();

  const rows = payload.files.flatMap((row) => {
    if (!isRecord(row)) return [];
    const fileName = stringValue(row.name);
    if (!fileName) return [];
    const quota = row.quota;
    const quotaSignals = isRecord(quota) && isRecord(quota.signals) ? quota.signals : undefined;

    return [
      {
        fileName,
        status: stringValue(row.status) ?? "unknown",
        statusMessage: stringValue(row.status_message),
        activity: activityBuckets(row.recent_requests),
        priority: numberValue(row.priority),
        plan: quotaSignals ? stringValue(quotaSignals["X-Codex-Plan-Type"]) : null,
        quotaPayload: quota,
      } satisfies RuntimeMetadata,
    ];
  });

  return new Map(rows.map((row) => [row.fileName, row]));
};

const codexSignalsFallback = (payload: unknown): ReadonlyArray<UsageWindow> => {
  if (!isRecord(payload) || !isRecord(payload.signals)) return [];
  const signals = payload.signals;
  const windows = [
    {
      id: "primary",
      label: "Primary",
      used: Number(signals["X-Codex-Primary-Used-Percent"]),
      reset: Number(signals["X-Codex-Primary-Reset-At"]),
      minutes: Number(signals["X-Codex-Primary-Window-Minutes"]),
    },
    {
      id: "secondary",
      label: "Secondary",
      used: Number(signals["X-Codex-Secondary-Used-Percent"]),
      reset: Number(signals["X-Codex-Secondary-Reset-At"]),
      minutes: Number(signals["X-Codex-Secondary-Window-Minutes"]),
    },
  ];

  return windows.flatMap((window) => {
    if (!Number.isFinite(window.used) || !Number.isFinite(window.minutes) || window.minutes <= 0)
      return [];
    const label =
      window.minutes === 300 ? "5-hour" : window.minutes === 10_080 ? "Weekly" : window.label;
    const remaining = Math.max(0, Math.min(100, 100 - window.used));

    return [
      {
        id: window.id,
        label,
        usedPercent: 100 - remaining,
        remainingPercent: remaining,
        resetsAt:
          Number.isFinite(window.reset) && window.reset > 0
            ? new Date(window.reset * 1000).toISOString()
            : null,
        durationMinutes: window.minutes,
      },
    ];
  });
};

const providerName = (provider: ProviderId) =>
  ({
    anthropic: "Claude",
    codex: "Codex",
    xai: "xAI",
    zai: "Z.AI",
    "opencode-go": "OpenCode Go",
  })[provider];

const accountResult = async (input: {
  provider: ProviderId;
  account: string;
  plan?: string | null;
  priority?: number;
  primary?: boolean;
  refreshIntervalMinutes: number;
  activity?: ReadonlyArray<ActivityBucket>;
  load: () => Promise<{ windows: ReadonlyArray<UsageWindow>; plan?: string | null }>;
}): Promise<UsageAccount> => {
  const updatedAt = new Date().toISOString();

  try {
    const result = await input.load();
    if (result.windows.length === 0) throw new Error("usage windows unavailable");

    return {
      id: `${input.provider}:${input.account}`,
      provider: input.provider,
      providerName: providerName(input.provider),
      account: input.account,
      plan: result.plan ?? input.plan ?? null,
      priority: input.priority ?? 0,
      primary: input.primary ?? false,
      status: "fresh",
      updatedAt,
      refreshIntervalMinutes: input.refreshIntervalMinutes,
      windows: result.windows,
      activity: input.activity ?? [],
      message: null,
    };
  } catch (error) {
    return {
      id: `${input.provider}:${input.account}`,
      provider: input.provider,
      providerName: providerName(input.provider),
      account: input.account,
      plan: input.plan ?? null,
      priority: input.priority ?? 0,
      primary: input.primary ?? false,
      status: "unavailable",
      updatedAt: null,
      refreshIntervalMinutes: input.refreshIntervalMinutes,
      windows: [],
      activity: input.activity ?? [],
      message: error instanceof Error ? error.message : "request failed",
    };
  }
};

const loadNativeAccounts = async (
  credentials: ReadonlyArray<Credential>,
  runtime: Map<string, RuntimeMetadata>,
): Promise<ReadonlyArray<UsageAccount>> => {
  const highestCodexPriority = Math.max(
    ...credentials
      .filter((credential) => credential.type === "codex")
      .map((credential) => credential.priority),
    0,
  );

  return Promise.all(
    credentials.map((credential) => {
      const metadata = runtime.get(credential.fileName);
      const priority = metadata?.priority ?? credential.priority;
      const common = {
        account: credential.email,
        priority,
        primary: credential.type === "codex" && priority === highestCodexPriority,
        activity: metadata?.activity ?? [],
      };

      if (credential.type === "claude") {
        return accountResult({
          provider: "anthropic",
          ...common,
          refreshIntervalMinutes: 10,
          load: async () => ({
            windows: normalizeAnthropicUsage(
              await fetchJson("https://api.anthropic.com/api/oauth/usage", {
                Authorization: `Bearer ${credential.accessToken}`,
                "anthropic-beta": "oauth-2025-04-20",
              }),
            ),
          }),
        });
      }

      if (credential.type === "xai") {
        return accountResult({
          provider: "xai",
          ...common,
          refreshIntervalMinutes: 5,
          load: async () => ({
            windows: normalizeGrokUsage(
              await fetchJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
                Authorization: `Bearer ${credential.accessToken}`,
                "X-XAI-Token-Auth": "xai-grok-cli",
              }),
            ),
          }),
        });
      }

      return accountResult({
        provider: "codex",
        ...common,
        plan: metadata?.plan ?? (credential.fileName.includes("-pro.") ? "Pro" : null),
        refreshIntervalMinutes: 5,
        load: async () => {
          try {
            const headers: Record<string, string> = {
              Authorization: `Bearer ${credential.accessToken}`,
            };
            if (credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;
            const windows = normalizeCodexUsage(
              await fetchJson("https://chatgpt.com/backend-api/wham/usage", headers),
            );
            if (windows.length > 0) return { windows };
          } catch {
            // CLIProxyAPI's observed quota headers are a safe fallback when the direct endpoint is unavailable.
          }

          return { windows: codexSignalsFallback(metadata?.quotaPayload) };
        },
      });
    }),
  );
};

const loadExternalAccounts = async (
  runtime: Map<string, RuntimeMetadata>,
): Promise<ReadonlyArray<UsageAccount>> => {
  const results: Array<Promise<UsageAccount>> = [];

  const openCodePath =
    process.env.OPENCODE_GO_ENV_FILE ?? defaultPath(".config", "subs", "opencode-go.env");
  try {
    const key = await readEnvValue(openCodePath, "OPENCODE_GO_API_KEY");
    if (key) {
      const metadata = [...runtime.values()].find((item) => item.fileName.includes("opencode-go"));
      results.push(
        accountResult({
          provider: "opencode-go",
          account: "Go subscription",
          plan: "Go",
          priority: 0,
          refreshIntervalMinutes: 5,
          activity: metadata?.activity ?? [],
          load: async () => ({
            windows: normalizeOpencodeGoUsage(
              await fetchJson("https://opencode.ai/zen/go/v1/usage", {
                Authorization: `Bearer ${key}`,
              }),
            ),
          }),
        }),
      );
    }
  } catch {
    // Optional provider: omission is reported by the empty card set rather than exposing file details.
  }

  const configPath = process.env.CPA_CONFIG_FILE ?? defaultPath("subs", "config.yaml");
  try {
    const key = await readZaiKey(configPath);
    if (key) {
      results.push(
        accountResult({
          provider: "zai",
          account: "Coding Plan",
          refreshIntervalMinutes: 5,
          load: async () => {
            const payload = await fetchJson("https://api.z.ai/api/monitor/usage/quota/limit", {
              Authorization: key,
            });
            return { windows: normalizeZaiUsage(payload), plan: zaiPlan(payload) };
          },
        }),
      );
    }
  } catch {
    // Optional provider: omission is reported by the empty card set rather than exposing file details.
  }

  return Promise.all(results);
};

let cachedSnapshot: UsageSnapshot | null = null;
let snapshotPromise: Promise<UsageSnapshot> | null = null;

const createSnapshot = async (): Promise<UsageSnapshot> => {
  const warnings: string[] = [];
  let runtime = new Map<string, RuntimeMetadata>();

  try {
    runtime = await loadRuntimeMetadata();
  } catch {
    warnings.push("CLIProxyAPI activity metadata is temporarily unavailable.");
  }

  const authDirectory = process.env.CPA_AUTH_DIR ?? defaultPath("subs", "auth");
  const credentials = await loadCredentials(authDirectory);
  const accounts = [
    ...(await loadNativeAccounts(credentials, runtime)),
    ...(await loadExternalAccounts(runtime)),
  ].sort((left, right) => {
    const providerDifference = providerOrder[left.provider] - providerOrder[right.provider];
    if (providerDifference !== 0) return providerDifference;
    if (left.provider === "codex" && right.provider === "codex")
      return right.priority - left.priority;
    return left.account.localeCompare(right.account);
  });

  return {
    generatedAt: new Date().toISOString(),
    accounts,
    warnings,
  };
};

export const getUsageSnapshot = async (options?: { force?: boolean }): Promise<UsageSnapshot> => {
  const ttl = Number(process.env.USAGE_CACHE_TTL_MS ?? 300_000);
  const age = cachedSnapshot
    ? Date.now() - Date.parse(cachedSnapshot.generatedAt)
    : Number.POSITIVE_INFINITY;

  if (!options?.force && cachedSnapshot && age < ttl) return cachedSnapshot;
  if (snapshotPromise) return snapshotPromise;

  snapshotPromise = createSnapshot()
    .then((snapshot) => {
      cachedSnapshot = snapshot;
      return snapshot;
    })
    .finally(() => {
      snapshotPromise = null;
    });

  return snapshotPromise;
};
