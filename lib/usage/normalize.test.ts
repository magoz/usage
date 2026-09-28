import { describe, expect, it } from "vitest";
import {
  anthropicResetIneligibility,
  normalizeAnthropicResetCredits,
  normalizeAnthropicUsage,
  normalizeCodexResetCredits,
  normalizeCodexUsage,
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
            scope: { model: { id: null, display_name: "Opus" } },
          },
        ],
      }),
    ).toMatchObject([
      { label: "5-hour", usedPercent: 4, remainingPercent: 96 },
      { label: "Weekly", usedPercent: 18, remainingPercent: 82 },
      {
        id: "weekly-scoped-opus",
        label: "Opus weekly",
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: "2026-09-25T20:00:00.000Z",
      },
    ]);
  });

  it("drops scoped limits for hidden models such as Fable", () => {
    const windows = normalizeAnthropicUsage({
      seven_day: { utilization: 18, resets_at: "2026-09-25T20:00:00Z" },
      limits: [
        {
          kind: "weekly_scoped",
          percent: 0,
          scope: { model: { id: null, display_name: "Fable" } },
        },
        {
          kind: "weekly_scoped",
          percent: 5,
          scope: { model: { id: "claude-fable-5-1", display_name: "Fable 5.1" } },
        },
      ],
    });
    expect(windows.map((window) => window.id)).toEqual(["weekly"]);
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

  describe("Claude limit resets", () => {
    const now = Date.parse("2026-09-28T09:00:00Z");
    const grant = (overrides: Record<string, unknown> = {}) => ({
      id: "opus55-launch-promax-20260921",
      resets_total: 1,
      resets_left: 1,
      starts_at: "2026-09-22T16:00:00+00:00",
      ends_at: "2026-10-22T16:00:00+00:00",
      paused: false,
      usable_now: true,
      ...overrides,
    });
    const status = (grants: unknown[], extra: Record<string, unknown> = {}) => ({
      cedar_ember: { eligible: true, ineligible_reason: null, grants, ...extra },
    });

    it("counts usable resets and keeps the soonest expiry", () => {
      expect(
        normalizeAnthropicResetCredits(
          status([grant(), grant({ id: "b", resets_left: 2, ends_at: "2026-10-05T00:00:00Z" })]),
          now,
        ),
      ).toEqual({ available: 3, expiresAt: "2026-10-05T00:00:00.000Z" });
    });

    it("skips paused, used up, expired, and not-yet-started grants", () => {
      expect(
        normalizeAnthropicResetCredits(
          status([
            grant({ paused: true }),
            grant({ resets_left: 0 }),
            grant({ ends_at: "2026-09-27T00:00:00Z" }),
            grant({ starts_at: "2026-10-01T00:00:00Z" }),
          ]),
          now,
        ),
      ).toEqual({ available: 0, expiresAt: null });
    });

    it("treats an ineligible or missing status as unknown, not as zero resets", () => {
      const surface = {
        cedar_ember: { eligible: false, ineligible_reason: "surface", grants: [] },
      };
      expect(normalizeAnthropicResetCredits(surface, now)).toBeNull();
      expect(
        normalizeAnthropicResetCredits({ cedar_ember: { eligible: null, grants: [] } }, now),
      ).toBeNull();
      expect(normalizeAnthropicResetCredits({ five_hour: {} }, now)).toBeNull();
      expect(anthropicResetIneligibility(surface)).toBe("surface");
      expect(anthropicResetIneligibility({ cedar_ember: { eligible: null } })).toBe(
        "eligibility unknown",
      );
      expect(anthropicResetIneligibility({})).toBe("cedar_ember block missing");
      expect(anthropicResetIneligibility(status([grant()]))).toBeNull();
    });
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
