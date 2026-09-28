import type { UsageAccount, UsageWindow } from "./types";

const WEEK_MINUTES = 10_080;

const isModelScoped = (window: UsageWindow) => window.id.startsWith("weekly-scoped-");

/**
 * Window used for a pool's headline figure: the account's overall weekly
 * allowance. Model-scoped weekly limits (e.g. Fable) share the weekly duration
 * but only bind one model, so they never drive the headline; they stay visible
 * as detail rows on the account card.
 */
export const summaryWindow = (account: UsageAccount): UsageWindow | undefined => {
  const weekly = account.windows.filter(
    (window) => window.durationMinutes === WEEK_MINUTES && !isModelScoped(window),
  );
  return weekly[0] ?? account.windows.find((window) => !isModelScoped(window));
};
