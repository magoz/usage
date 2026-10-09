import "server-only";

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const defaultPath = (...segments: string[]) => join(home, ...segments);
import {
  anthropicResetIneligibility,
  normalizeAnthropicResetCredits,
  normalizeAnthropicUsage,
  normalizeCodexResetCredits,
  normalizeCodexUsage,
  normalizeOpencodeGoUsage,
} from "./normalize";
import {
  RateLimitedError,
  resolveAccount,
  snapshotTtlMs,
  type AccountInput,
  type AccountSample,
} from "./sampling";
import { activeAccounts, parsePins, type RoutableAccount, type Routing } from "./routing";
import { loadState, saveState, stateFilePath } from "./state-store";
import type { ActivityBucket, ProviderId, UsageAccount, UsageSnapshot, UsageWindow } from "./types";

// A snapshot before routing is attached; routing is refreshed more often than usage.
type UsageReport = Omit<UsageSnapshot, "routing">;

type JsonRecord = Record<string, unknown>;

type Credential = {
  readonly fileName: string;
  readonly type: "claude" | "codex";
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
  "opencode-go": 2,
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

type ServiceState = {
  // Last reading per account, with the time its provider may next be queried.
  readonly samples: Map<string, AccountSample>;
  cachedSnapshot: UsageReport | null;
  snapshotPromise: Promise<UsageReport> | null;
  // Auth file name → dashboard account, from the latest report; resolves routing pins.
  accountsByAuthId: ReadonlyMap<string, RoutableAccount>;
  cachedRouting: {
    readonly at: number;
    readonly pins: Promise<ReturnType<typeof parsePins>>;
  } | null;
  restored: Promise<void> | null;
  dirty: boolean;
  persisting: Promise<void>;
  persistFailureLogged: boolean;
};

declare global {
  // Next.js bundles this module separately for the page and the route handler, so
  // module-level variables would give each its own cache and throttle. One
  // process-wide object keeps them shared.
  // oxlint-disable-next-line no-var
  var __usageDashboardState: ServiceState | undefined;
}

const state: ServiceState = (globalThis.__usageDashboardState ??= {
  samples: new Map(),
  cachedSnapshot: null,
  snapshotPromise: null,
  accountsByAuthId: new Map(),
  cachedRouting: null,
  restored: null,
  dirty: false,
  persisting: Promise.resolve(),
  persistFailureLogged: false,
});

// Loaded lazily on the first snapshot, never at import time.
const restoreSamples = () =>
  (state.restored ??= (async () => {
    const path = stateFilePath();
    try {
      const { samples, problem } = await loadState(path);
      if (problem) console.warn(`[usage] ignoring saved state in ${path} (${problem})`);
      for (const [id, sample] of samples) {
        if (!state.samples.has(id)) state.samples.set(id, sample);
      }
    } catch {
      console.warn(`[usage] could not read saved state in ${path}; starting empty`);
    }
  })());

// Written once per snapshot, and only when an upstream call produced a new sample.
const persistSamples = (accounts: ReadonlyArray<UsageAccount>) => {
  if (!state.dirty) return;
  state.dirty = false;
  const path = stateFilePath();
  const current = new Set(accounts.map((account) => account.id));
  const entries = [...state.samples].filter(([id]) => current.has(id));

  state.persisting = state.persisting
    .then(() => saveState(path, entries))
    .then(
      () => {
        state.persistFailureLogged = false;
      },
      (error: unknown) => {
        state.dirty = true;
        if (state.persistFailureLogged) return;
        state.persistFailureLogged = true;
        const code = (error as NodeJS.ErrnoException | null)?.code ?? "unknown error";
        console.warn(`[usage] could not save state to ${path} (${code})`);
      },
    );
};

const accountResult = (input: AccountInput): Promise<UsageAccount> =>
  resolveAccount(state.samples, input, () => {
    state.dirty = true;
  });

// Claude Code release Anthropic recognises for limit-reset status (older ones get none).
const claudeCliVersion = () => process.env.CLAUDE_CLI_VERSION?.trim() || "2.1.283";

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
  if (response.status === 429) throw new RateLimitedError(response.headers.get("retry-after"));
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
      if (type !== "claude" && type !== "codex") return null;
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

const fetchManagement = async (path: string, timeoutMs?: number): Promise<unknown> => {
  const keyPath = process.env.CPA_MANAGEMENT_KEY_FILE ?? defaultPath("subs", "management.key");
  const baseUrl = process.env.CPA_BASE_URL ?? "http://127.0.0.1:8317";
  const managementKey = await readText(keyPath);
  return fetchJson(
    `${baseUrl}/v0/management/${path}`,
    { Authorization: `Bearer ${managementKey}` },
    timeoutMs,
  );
};

const loadRuntimeMetadata = async (): Promise<Map<string, RuntimeMetadata>> => {
  const payload = await fetchManagement("auth-files");
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

const loadNativeAccounts = async (
  credentials: ReadonlyArray<Credential>,
  runtime: Map<string, RuntimeMetadata>,
): Promise<ReadonlyArray<UsageAccount>> => {
  return Promise.all(
    credentials.map((credential) => {
      const metadata = runtime.get(credential.fileName);
      const priority = metadata?.priority ?? credential.priority;
      const common = {
        account: credential.email,
        priority,
        activity: metadata?.activity ?? [],
      };

      if (credential.type === "claude") {
        return accountResult({
          provider: "anthropic",
          ...common,
          refreshIntervalMinutes: 10,
          load: async () => {
            // `cedar_ember=1` adds limit-reset status. Anthropic only reports it to a
            // current Claude Code CLI client, so identify as one (read-only call;
            // `skip_spend=1` mirrors Claude Code and omits spend details we do not use).
            const payload = await fetchJson(
              "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1",
              {
                Authorization: `Bearer ${credential.accessToken}`,
                "anthropic-beta": "oauth-2025-04-20",
                "User-Agent": `claude-cli/${claudeCliVersion()} (external, cli)`,
                "x-app": "cli",
              },
            );
            const ineligible = anthropicResetIneligibility(payload);
            if (ineligible) {
              console.warn(
                `[usage] Claude reset status unavailable for ${credential.email} (${ineligible}); ` +
                  "if this persists, raise CLAUDE_CLI_VERSION to the current Claude Code release",
              );
            }
            return {
              windows: normalizeAnthropicUsage(payload),
              resetCredits: normalizeAnthropicResetCredits(payload),
            };
          },
        });
      }

      return accountResult({
        provider: "codex",
        ...common,
        plan: metadata?.plan ?? (credential.fileName.includes("-pro.") ? "Pro" : null),
        refreshIntervalMinutes: 5,
        load: async () => {
          const headers: Record<string, string> = {
            Authorization: `Bearer ${credential.accessToken}`,
          };
          if (credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;
          const resetCredits = await fetchJson(
            "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
            headers,
          )
            .then((payload) => normalizeCodexResetCredits(payload))
            .catch(() => null);

          try {
            const windows = normalizeCodexUsage(
              await fetchJson("https://chatgpt.com/backend-api/wham/usage", headers),
            );
            if (windows.length > 0) return { windows, resetCredits };
          } catch {
            // CLIProxyAPI's observed quota headers are a safe fallback when the direct endpoint is unavailable.
          }

          return { windows: codexSignalsFallback(metadata?.quotaPayload), resetCredits };
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

  return Promise.all(results);
};

const nativeProvider = (credential: Credential): ProviderId =>
  credential.type === "claude" ? "anthropic" : "codex";

const createSnapshot = async (): Promise<UsageReport> => {
  const warnings: string[] = [];
  let runtime = new Map<string, RuntimeMetadata>();

  try {
    runtime = await loadRuntimeMetadata();
  } catch {
    warnings.push("CLIProxyAPI activity metadata is temporarily unavailable.");
  }

  const authDirectory = process.env.CPA_AUTH_DIR ?? defaultPath("subs", "auth");
  const credentials = await loadCredentials(authDirectory);
  state.accountsByAuthId = new Map(
    credentials.map((credential) => {
      const provider = nativeProvider(credential);
      return [credential.fileName, { id: `${provider}:${credential.email}`, provider }];
    }),
  );
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

// Pins change only when an account runs out, but the badge should follow within a poll.
const ROUTING_TTL_MS = 15_000;

const loadPins = () => {
  const now = Date.now();
  const cached = state.cachedRouting;
  if (cached && now - cached.at < ROUTING_TTL_MS) return cached.pins;
  const pins = fetchManagement("plugins/sticky-fill-first/pins", 5_000).then(parsePins, () => null);
  state.cachedRouting = { at: now, pins };
  return pins;
};

const currentRouting = async (): Promise<Routing> => {
  const pins = await loadPins();
  return pins === null
    ? { status: "unavailable" }
    : { status: "available", accounts: activeAccounts(pins, state.accountsByAuthId) };
};

export const getUsageSnapshot = async (options?: { force?: boolean }): Promise<UsageSnapshot> => {
  // Sequential: the report refreshes the auth-file map that routing pins resolve against.
  const report = await getUsageReport(options);
  return { ...report, routing: await currentRouting() };
};

const getUsageReport = async (options?: { force?: boolean }): Promise<UsageReport> => {
  const ttl = Number(process.env.USAGE_CACHE_TTL_MS ?? 300_000);
  const cached = state.cachedSnapshot;
  const age = cached ? Date.now() - Date.parse(cached.generatedAt) : Number.POSITIVE_INFINITY;

  if (!options?.force && cached && age < snapshotTtlMs(cached, ttl)) return cached;
  if (state.snapshotPromise) return state.snapshotPromise;

  state.snapshotPromise = restoreSamples()
    .then(createSnapshot)
    .then((snapshot) => {
      state.cachedSnapshot = snapshot;
      persistSamples(snapshot.accounts);
      return snapshot;
    })
    .finally(() => {
      state.snapshotPromise = null;
    });

  return state.snapshotPromise;
};
