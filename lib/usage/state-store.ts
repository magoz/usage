// Disk persistence for per-account samples, so a restart keeps last-good readings
// and honours per-account backoff. Only UsageAccount snapshots (account emails,
// quota windows, reset credits, status) are stored — never credentials.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AccountSample } from "./sampling";
import type { ProviderId, ResetCredits, UsageAccount, UsageWindow } from "./types";

export const STATE_VERSION = 1;

// Activity is live CLIProxyAPI data that is always replaced, so it is not stored.
export type PersistedAccount = Omit<UsageAccount, "activity">;

export type PersistedState = {
  readonly version: typeof STATE_VERSION;
  readonly samples: Readonly<
    Record<string, { readonly account: PersistedAccount; readonly nextAllowedAt: number }>
  >;
};

export type LoadedState = {
  readonly samples: Map<string, AccountSample>;
  // Why the file was ignored (corrupt, wrong version…); null when loaded or simply absent.
  readonly problem: string | null;
};

export const stateFilePath = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const explicit = env.USAGE_STATE_FILE?.trim();
  if (explicit) return explicit;
  // systemd `StateDirectory=` sets STATE_DIRECTORY (colon-separated if several).
  const stateDirectory = env.STATE_DIRECTORY?.split(":")[0]?.trim();
  if (stateDirectory) return join(stateDirectory, "state.json");
  return join(homedir(), ".local", "state", "usage", "state.json");
};

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const providers: ReadonlyArray<ProviderId> = ["anthropic", "codex", "opencode-go"];
const statuses: ReadonlyArray<UsageAccount["status"]> = ["fresh", "stale", "unavailable"];

const toWindow = (value: unknown): UsageWindow | null => {
  if (!isRecord(value)) return null;
  const { id, label, remainingPercent, usedPercent, resetsAt, durationMinutes } = value;
  if (!isString(id) || !isString(label) || !isNumber(remainingPercent) || !isNumber(usedPercent))
    return null;
  if (!isNullableString(resetsAt)) return null;
  if (durationMinutes !== null && !isNumber(durationMinutes)) return null;
  return { id, label, remainingPercent, usedPercent, resetsAt, durationMinutes };
};

const toResetCredits = (value: unknown): ResetCredits | null | undefined => {
  if (value === null) return null;
  if (!isRecord(value) || !isNumber(value.available) || !isNullableString(value.expiresAt))
    return undefined;
  return { available: value.available, expiresAt: value.expiresAt };
};

// Rebuilds a UsageAccount from known fields only. Used on both save and load, so
// nothing beyond the UsageAccount shape can ever reach (or come back from) disk.
export const toPersistedAccount = (value: unknown): PersistedAccount | null => {
  if (!isRecord(value)) return null;
  const { id, provider, providerName, account, plan, priority, primary, status } = value;
  const { updatedAt, refreshIntervalMinutes, windows, message } = value;
  if (!isString(id) || !isString(providerName) || !isString(account)) return null;
  if (!providers.includes(provider as ProviderId)) return null;
  if (!statuses.includes(status as UsageAccount["status"])) return null;
  if (!isNullableString(plan) || !isNullableString(updatedAt) || !isNullableString(message))
    return null;
  if (!isNumber(priority) || !isNumber(refreshIntervalMinutes) || typeof primary !== "boolean")
    return null;
  if (!Array.isArray(windows)) return null;
  const parsedWindows = windows.map(toWindow);
  if (parsedWindows.some((window) => window === null)) return null;
  const resetCredits = toResetCredits(value.resetCredits);
  if (resetCredits === undefined) return null;

  return {
    id,
    provider: provider as ProviderId,
    providerName,
    account,
    plan,
    priority,
    primary,
    status: status as UsageAccount["status"],
    updatedAt,
    refreshIntervalMinutes,
    windows: parsedWindows as ReadonlyArray<UsageWindow>,
    resetCredits,
    message,
  };
};

const toSample = (value: unknown): AccountSample | null => {
  if (!isRecord(value) || !isNumber(value.nextAllowedAt)) return null;
  const account = toPersistedAccount(value.account);
  return account
    ? { account: { ...account, activity: [] }, nextAllowedAt: value.nextAllowedAt }
    : null;
};

export const serializeState = (samples: Iterable<readonly [string, AccountSample]>): string => {
  const entries: Record<string, PersistedState["samples"][string]> = {};
  for (const [id, sample] of samples) {
    const account = toPersistedAccount(sample.account);
    if (account && account.id === id && Number.isFinite(sample.nextAllowedAt))
      entries[id] = { account, nextAllowedAt: sample.nextAllowedAt };
  }
  const state: PersistedState = { version: STATE_VERSION, samples: entries };
  return `${JSON.stringify(state, null, 2)}\n`;
};

export const loadState = async (path: string): Promise<LoadedState> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { samples: new Map(), problem: code === "ENOENT" ? null : `unreadable (${code})` };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { samples: new Map(), problem: "not valid JSON" };
  }
  if (!isRecord(payload) || !isRecord(payload.samples))
    return { samples: new Map(), problem: "unexpected format" };
  if (payload.version !== STATE_VERSION)
    return { samples: new Map(), problem: `unsupported version ${String(payload.version)}` };

  const samples = new Map<string, AccountSample>();
  let dropped = 0;
  for (const [id, value] of Object.entries(payload.samples)) {
    const sample = toSample(value);
    if (sample && sample.account.id === id) samples.set(id, sample);
    else dropped += 1;
  }

  return { samples, problem: dropped > 0 ? `ignored ${dropped} malformed entries` : null };
};

// Atomic write: temp file (0600) in the same directory, fsync, then rename over the target.
export const saveState = async (
  path: string,
  samples: Iterable<readonly [string, AccountSample]>,
): Promise<void> => {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.state-${process.pid}-${randomUUID()}.tmp`);

  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serializeState(samples), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};
