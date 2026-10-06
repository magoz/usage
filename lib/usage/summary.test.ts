import { describe, expect, it } from "vitest";
import { summaryWindow } from "./summary";
import type { UsageAccount, UsageWindow } from "./types";

const window = (
  id: string,
  label: string,
  remaining: number,
  durationMinutes: number | null,
): UsageWindow => ({
  id,
  label,
  remainingPercent: remaining,
  usedPercent: 100 - remaining,
  resetsAt: null,
  durationMinutes,
});

const account = (provider: UsageAccount["provider"], windows: ReadonlyArray<UsageWindow>) =>
  ({ provider, windows }) as unknown as UsageAccount;

describe("summaryWindow", () => {
  it("uses the overall Claude weekly window, not a model-scoped one", () => {
    const summary = summaryWindow(
      account("anthropic", [
        window("five-hour", "5-hour", 71, 300),
        window("weekly-scoped-fable", "Fable weekly", 100, 10_080),
        window("weekly", "Weekly", 65, 10_080),
      ]),
    );
    expect(summary?.id).toBe("weekly");
    expect(summary?.remainingPercent).toBe(65);
  });

  it("uses the longest account-wide window when there is no weekly window", () => {
    const summary = summaryWindow(
      account("anthropic", [
        window("weekly-scoped-fable", "Fable weekly", 100, 10_080),
        window("five-hour", "5-hour", 40, 300),
      ]),
    );
    expect(summary?.id).toBe("five-hour");
  });

  it("never headlines a scoped-only account", () => {
    expect(
      summaryWindow(
        account("anthropic", [window("weekly-scoped-fable", "Fable weekly", 100, 10_080)]),
      ),
    ).toBeUndefined();
  });

  it("uses OpenCode Go's monthly window, its longest", () => {
    const summary = summaryWindow(
      account("opencode-go", [
        window("rolling", "5-hour", 100, 300),
        window("weekly", "Weekly", 99, 10_080),
        window("monthly", "Monthly", 32, 43_200),
      ]),
    );
    expect(summary?.id).toBe("monthly");
  });

  it("keeps Codex on its weekly window", () => {
    const summary = summaryWindow(
      account("codex", [
        window("primary", "5-hour", 90, 300),
        window("secondary", "Weekly", 80, 10_080),
      ]),
    );
    expect(summary?.id).toBe("secondary");
  });
});
