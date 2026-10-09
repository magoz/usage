import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountSample } from "./sampling";
import { STATE_VERSION, loadState, saveState, stateFilePath } from "./state-store";
import type { UsageAccount } from "./types";

const account = (overrides: Partial<UsageAccount> = {}): UsageAccount => ({
  id: "anthropic:someone@example.com",
  provider: "anthropic",
  providerName: "Claude",
  account: "someone@example.com",
  plan: null,
  priority: 0,
  status: "fresh",
  updatedAt: "2026-09-28T09:00:00.000Z",
  refreshIntervalMinutes: 10,
  windows: [
    {
      id: "five-hour",
      label: "5-hour",
      remainingPercent: 80,
      usedPercent: 20,
      resetsAt: "2026-09-28T12:00:00.000Z",
      durationMinutes: 300,
    },
  ],
  resetCredits: { available: 1, expiresAt: null },
  activity: [{ time: "2026-09-28T09:00:00Z", success: 3, failed: 0 }],
  message: null,
  ...overrides,
});

const sample = (overrides: Partial<UsageAccount> = {}, nextAllowedAt = 1_000): AccountSample => ({
  account: account(overrides),
  nextAllowedAt,
});

let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "usage-state-"));
  path = join(directory, "nested", "state.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("state store", () => {
  it("round-trips samples (without live activity)", async () => {
    const first = sample();
    const second = sample(
      {
        id: "codex:other@example.com",
        provider: "codex",
        providerName: "Codex",
        account: "other@example.com",
        status: "stale",
        message: "rate limited",
        resetCredits: null,
      },
      2_000,
    );
    await saveState(path, [
      [first.account.id, first],
      [second.account.id, second],
    ]);

    const loaded = await loadState(path);
    expect(loaded.problem).toBeNull();
    expect(Object.fromEntries(loaded.samples)).toEqual({
      [first.account.id]: { account: { ...first.account, activity: [] }, nextAllowedAt: 1_000 },
      [second.account.id]: { account: { ...second.account, activity: [] }, nextAllowedAt: 2_000 },
    });
  });

  it("writes atomically with mode 0600 in a 0700 directory and leaves no temp files", async () => {
    const entry = sample();
    await saveState(path, [[entry.account.id, entry]]);
    await saveState(path, [[entry.account.id, entry]]);

    const parent = join(directory, "nested");
    expect(await readdir(parent)).toEqual(["state.json"]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(parent)).mode & 0o777).toBe(0o700);
  });

  it("never persists credential-like fields", async () => {
    const tainted = {
      ...account(),
      accessToken: "secret-token",
      access_token: "secret-token",
      Authorization: "Bearer secret-token",
    } as UsageAccount;
    await saveState(path, [[tainted.id, { account: tainted, nextAllowedAt: 1 }]]);

    const text = await readFile(path, "utf8");
    expect(text).not.toMatch(/accessToken|access_token|authorization|secret-token/i);
    const saved = JSON.parse(text) as { version: number; samples: Record<string, unknown> };
    expect(saved.version).toBe(STATE_VERSION);
    expect(Object.keys(saved.samples)).toEqual([tainted.id]);
  });

  it("starts empty when the file is missing, without reporting a problem", async () => {
    expect(await loadState(path)).toEqual({ samples: new Map(), problem: null });
  });

  it.each([
    ["corrupt", "{not json"],
    ["wrong version", JSON.stringify({ version: 999, samples: {} })],
    ["wrong shape", JSON.stringify([1, 2, 3])],
  ])("starts empty and reports a problem for a %s file", async (_name, content) => {
    const file = join(directory, "state.json");
    await writeFile(file, content);
    const loaded = await loadState(file);
    expect(loaded.samples.size).toBe(0);
    expect(loaded.problem).toEqual(expect.any(String));
  });

  it("drops malformed entries but keeps valid ones", async () => {
    const file = join(directory, "state.json");
    const valid = sample();
    await writeFile(
      file,
      JSON.stringify({
        version: STATE_VERSION,
        samples: {
          [valid.account.id]: valid,
          "codex:broken": { account: { id: "codex:broken" }, nextAllowedAt: 5 },
        },
      }),
    );
    const loaded = await loadState(file);
    expect([...loaded.samples.keys()]).toEqual([valid.account.id]);
    expect(loaded.problem).toMatch(/1 malformed/);
  });

  it("loads state saved with the retired priority-based `primary` flag", async () => {
    const file = join(directory, "state.json");
    const legacy = sample();
    await writeFile(
      file,
      JSON.stringify({
        version: STATE_VERSION,
        samples: {
          [legacy.account.id]: { ...legacy, account: { ...legacy.account, primary: true } },
        },
      }),
    );
    const loaded = await loadState(file);
    expect(loaded.problem).toBeNull();
    expect(loaded.samples.get(legacy.account.id)?.account).not.toHaveProperty("primary");
  });
});

describe("stateFilePath", () => {
  it("prefers USAGE_STATE_FILE, then STATE_DIRECTORY, then ~/.local/state", () => {
    expect(stateFilePath({ USAGE_STATE_FILE: "/x/state.json", STATE_DIRECTORY: "/y" })).toBe(
      "/x/state.json",
    );
    expect(stateFilePath({ STATE_DIRECTORY: "/var/lib/usage:/var/lib/other" })).toBe(
      "/var/lib/usage/state.json",
    );
    expect(stateFilePath({})).toMatch(/\/\.local\/state\/usage\/state\.json$/);
  });
});
