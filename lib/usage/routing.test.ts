import { describe, expect, it } from "vitest";
import {
  activeAccounts,
  activeFirst,
  modelLabel,
  parsePins,
  routingNote,
  type RoutableAccount,
  type Routing,
} from "./routing";

const claudeMain: RoutableAccount = { id: "anthropic:main@example.com", provider: "anthropic" };
const claudeSpare: RoutableAccount = { id: "anthropic:spare@example.com", provider: "anthropic" };
const codexMain: RoutableAccount = { id: "codex:main@example.com", provider: "codex" };

const byAuthId = new Map<string, RoutableAccount>([
  ["claude-1-main@example.com.json", claudeMain],
  ["claude-2-spare@example.com.json", claudeSpare],
  ["codex-1-main@example.com-pro.json", codexMain],
]);

const pin = (authId: string, model: string, missingSince: string | null = null) => ({
  provider: "claude",
  model,
  auth_id: authId,
  pinned_at: "2026-10-09T19:14:40Z",
  last_picked_at: "2026-10-09T19:30:02Z",
  missing_since: missingSince,
});

const routing = (...pins: ReadonlyArray<ReturnType<typeof pin>>): Routing => {
  const parsed = parsePins({ pins });
  if (parsed === null) throw new Error("pins did not parse");
  return { status: "available", accounts: activeAccounts(parsed, byAuthId) };
};

describe("parsePins", () => {
  it("reads the plugin response and drops malformed pins", () => {
    expect(
      parsePins({
        pins: [
          pin("claude-1-main@example.com.json", "claude-opus-5-5"),
          pin("claude-2-spare@example.com.json", "claude-haiku-4-5", "2026-10-09T19:40:00Z"),
          { auth_id: 3, model: "x", missing_since: null },
          { auth_id: "a.json", model: "x", missing_since: 5 },
          "nonsense",
        ],
      }),
    ).toEqual([
      { authId: "claude-1-main@example.com.json", model: "claude-opus-5-5", missingSince: null },
      {
        authId: "claude-2-spare@example.com.json",
        model: "claude-haiku-4-5",
        missingSince: "2026-10-09T19:40:00Z",
      },
    ]);
  });

  it("rejects a body that is not a pin list", () => {
    expect(parsePins({ error: "not found" })).toBeNull();
    expect(parsePins("<html>")).toBeNull();
    expect(parsePins({ pins: [] })).toEqual([]);
  });
});

describe("routingNote", () => {
  it("marks the single account a pool is routed to", () => {
    const current = routing(
      pin("claude-1-main@example.com.json", "claude-opus-5-5"),
      pin("claude-1-main@example.com.json", "claude-haiku-4-5"),
      pin("codex-1-main@example.com-pro.json", "gpt-6-astra"),
    );
    expect(routingNote(claudeMain, current)).toBe("active");
    expect(routingNote(claudeSpare, current)).toBeNull();
    expect(routingNote(codexMain, current)).toBe("active");
  });

  it("names the models when a pool is split across accounts", () => {
    const current = routing(
      pin("claude-1-main@example.com.json", "claude-haiku-4-5"),
      pin("claude-2-spare@example.com.json", "claude-opus-5-5"),
      pin("claude-2-spare@example.com.json", "claude-sonnet-5-5"),
    );
    expect(routingNote(claudeMain, current)).toBe("active · haiku");
    expect(routingNote(claudeSpare, current)).toBe("active · opus, sonnet");
  });

  it("flags an account whose pin is about to move", () => {
    const current = routing(
      pin("claude-1-main@example.com.json", "claude-opus-5-5", "2026-10-09T19:40:00Z"),
    );
    expect(routingNote(claudeMain, current)).toBe("active · switching");
  });

  it("makes no claim before the first request or when routing is unknown", () => {
    expect(routingNote(claudeMain, routing())).toBeNull();
    expect(routingNote(claudeMain, { status: "unavailable" })).toBeNull();
  });

  it("ignores pins for auth files the dashboard does not show", () => {
    const current = routing(pin("claude-9-removed@example.com.json", "claude-opus-5-5"));
    expect(current).toEqual({ status: "available", accounts: [] });
    expect(routingNote(claudeMain, current)).toBeNull();
  });
});

describe("activeFirst", () => {
  const accounts = [claudeSpare, claudeMain, codexMain];

  it("moves routed accounts to the front and keeps the rest in order", () => {
    const current = routing(pin("claude-1-main@example.com.json", "claude-opus-5-5"));
    expect(activeFirst(accounts, current)).toEqual([claudeMain, claudeSpare, codexMain]);
  });

  it("keeps the order when nothing is routed or routing is unknown", () => {
    expect(activeFirst(accounts, routing())).toEqual(accounts);
    expect(activeFirst(accounts, { status: "unavailable" })).toEqual(accounts);
  });
});

describe("modelLabel", () => {
  it("keeps the distinguishing part of a model ID", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("opus");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(modelLabel("gpt-5.6-sol")).toBe("sol");
    expect(modelLabel("gpt-6-astra")).toBe("astra");
    expect(modelLabel("gpt-5")).toBe("gpt-5");
  });
});
