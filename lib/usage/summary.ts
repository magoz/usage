import type { UsageAccount, UsageWindow } from "./types";

const isModelScoped = (window: UsageWindow) => window.id.startsWith("weekly-scoped-");

/**
 * Window used for a pool's headline figure: the account's longest allowance (weekly for Claude
 * and Codex, monthly for OpenCode Go), the budget that lasts. Model-scoped weekly limits (e.g.
 * Fable) only bind one model, so they never drive the headline; they stay visible as detail rows
 * on the account card. Without any duration, the first account-wide window.
 */
export const summaryWindow = (account: UsageAccount): UsageWindow | undefined => {
  const binding = account.windows.filter((window) => !isModelScoped(window));
  const longest = binding.reduce<UsageWindow | undefined>(
    (best, window) =>
      window.durationMinutes !== null &&
      (best?.durationMinutes == null || window.durationMinutes > best.durationMinutes)
        ? window
        : best,
    undefined,
  );
  return longest ?? binding[0];
};
