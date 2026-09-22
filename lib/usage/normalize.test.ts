import { describe, expect, it } from "vitest";
import {
  normalizeAnthropicUsage,
  normalizeCodexResetCredits,
  normalizeCodexUsage,
  normalizeGrokUsage,
  normalizeOpencodeGoUsage,
  normalizeZaiUsage,
} from "./normalize";

describe("usage normalization", () => {
  it("normalizes Anthropic windows as remaining allowance", () => {
    expect(
      normalizeAnthropicUsage({
        five_hour: { utilization: 4, resets_at: "2026-09-19T20:00:00Z" },
        seven_day: { utilization: 18, resets_at: "2026-09-25T20:00:00Z" },
        limits: [
          {
            kind: "weekly_scoped",
            percent: 100,
            resets_at: "2026-09-25T20:00:00Z",
            scope: { model: { id: null, display_name: "Fable" } },
          },
        ],
      }),
    ).toMatchObject([
      { label: "5-hour", usedPercent: 4, remainingPercent: 96 },
      { label: "Weekly", usedPercent: 18, remainingPercent: 82 },
      {
        id: "weekly-scoped-fable",
        label: "Fable weekly",
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: "2026-09-25T20:00:00.000Z",
      },
    ]);
  });

  it("derives Codex labels and reset times", () => {
    const now = Date.parse("2026-09-19T12:00:00Z");
    expect(
      normalizeCodexUsage(
        {
          rate_limit: {
            primary_window: {
              used_percent: 25,
              limit_window_seconds: 18_000,
              reset_after_seconds: 60,
            },
            secondary_window: {
              used_percent: 50,
              limit_window_seconds: 604_800,
              reset_at: 1_790_000_000,
            },
          },
        },
        now,
      ),
    ).toMatchObject([
      { label: "5-hour", remainingPercent: 75, resetsAt: "2026-09-19T12:01:00.000Z" },
      { label: "Weekly", remainingPercent: 50 },
    ]);
  });

  it("keeps the soonest available Codex reset credit", () => {
    const now = Date.parse("2026-09-22T20:00:00Z");
    expect(
      normalizeCodexResetCredits(
        {
          available_count: 2,
          credits: [
            { status: "available", expires_at: "2026-09-25T20:00:00Z" },
            { status: "available", expires_at: 1_790_500_000 },
            { status: "redeemed", expires_at: "2026-09-23T20:00:00Z" },
          ],
        },
        now,
      ),
    ).toEqual({
      available: 2,
      expiresAt: "2026-09-25T20:00:00.000Z",
    });
  });

  it("reports a Codex account with no reset credits", () => {
    expect(normalizeCodexResetCredits({ available_count: 0, credits: [] })).toEqual({
      available: 0,
      expiresAt: null,
    });
  });

  it("normalizes Grok billing periods", () => {
    expect(
      normalizeGrokUsage({
        config: {
          creditUsagePercent: 5,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-25T12:00:00Z" },
        },
      }),
    ).toMatchObject([{ label: "Weekly", remainingPercent: 95 }]);
  });

  it("normalizes OpenCode Go windows", () => {
    expect(
      normalizeOpencodeGoUsage({
        usage: {
          rolling: { percent: 9, resetsAt: "2026-09-19T20:00:00Z" },
          weekly: { percent: 12, resetsAt: "2026-09-25T20:00:00Z" },
        },
      }),
    ).toMatchObject([
      { label: "5-hour", remainingPercent: 91 },
      { label: "Weekly", remainingPercent: 88 },
    ]);
  });

  it("accepts Z.AI credit limits", () => {
    expect(
      normalizeZaiUsage({
        data: {
          level: "max",
          limits: [
            { type: "CREDIT_LIMIT", unit: 3, percentage: 1, nextResetTime: 1_790_000_000_000 },
            { type: "CREDIT_LIMIT", unit: 6, percentage: 54, nextResetTime: 1_790_500_000_000 },
          ],
        },
      }),
    ).toMatchObject([
      { label: "5-hour", remainingPercent: 99 },
      { label: "Weekly", remainingPercent: 46 },
    ]);
  });
});
