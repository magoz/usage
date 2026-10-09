// Which account each pool is currently routed to, as reported by the CLIProxyAPI
// sticky-fill-first scheduler plugin. Pure and I/O-free so it can be unit tested and
// shared with the client; `service.ts` fetches the pins.
import type { ProviderId } from "./types";

// One sticky pin: a provider+model route and the auth file currently serving it.
export type Pin = {
  readonly authId: string;
  readonly model: string;
  // Set while the pinned account is unavailable, i.e. the pin may move soon.
  readonly missingSince: string | null;
};

export type ActiveAccount = {
  readonly accountId: string;
  readonly provider: ProviderId;
  // Base model IDs routed to this account, sorted.
  readonly models: ReadonlyArray<string>;
  readonly switching: boolean;
};

// "unavailable" when the plugin route cannot be read (plugin missing, gateway down…):
// the dashboard then makes no routing claims at all rather than guessing from priority.
export type Routing =
  | { readonly status: "unavailable" }
  | { readonly status: "available"; readonly accounts: ReadonlyArray<ActiveAccount> };

export type RoutableAccount = { readonly id: string; readonly provider: ProviderId };

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Parses `GET /v0/management/plugins/sticky-fill-first/pins`. Malformed pins are dropped;
// a malformed body yields null.
export const parsePins = (payload: unknown): ReadonlyArray<Pin> | null => {
  if (!isRecord(payload) || !Array.isArray(payload.pins)) return null;

  return payload.pins.flatMap((value): ReadonlyArray<Pin> => {
    if (!isRecord(value)) return [];
    const { auth_id: authId, model, missing_since: missingSince } = value;
    if (typeof authId !== "string" || authId === "" || typeof model !== "string") return [];
    if (missingSince !== null && typeof missingSince !== "string") return [];
    return [{ authId, model, missingSince }];
  });
};

// Groups pins by the dashboard account they point at. Pins for auth files the dashboard
// does not show (disabled, removed, non-file credentials) are ignored.
export const activeAccounts = (
  pins: ReadonlyArray<Pin>,
  accountsByAuthId: ReadonlyMap<string, RoutableAccount>,
): ReadonlyArray<ActiveAccount> => {
  const grouped = new Map<
    string,
    { account: RoutableAccount; models: Set<string>; switching: boolean }
  >();
  for (const pin of pins) {
    const account = accountsByAuthId.get(pin.authId);
    if (!account) continue;
    const entry = grouped.get(account.id) ?? { account, models: new Set(), switching: false };
    entry.models.add(pin.model);
    entry.switching ||= pin.missingSince !== null;
    grouped.set(account.id, entry);
  }

  return [...grouped.values()]
    .map(({ account, models, switching }) => ({
      accountId: account.id,
      provider: account.provider,
      models: [...models].sort(),
      switching,
    }))
    .sort((left, right) => left.accountId.localeCompare(right.accountId));
};

// Short display label for a model ID: drops vendor prefixes and version or date
// segments ("claude-opus-5-5" → "opus", "gpt-5.6-sol" → "sol").
export const modelLabel = (model: string): string => {
  const words = model
    .toLowerCase()
    .split("-")
    .filter((word) => word !== "" && word !== "claude" && word !== "gpt" && !/^[\d.]+$/.test(word));
  return words.length > 0 ? words.join("-") : model;
};

// The note shown next to an account's plan, or null when it is not routed to.
// Model names are listed only when a provider's routes are split across accounts.
export const routingNote = (account: RoutableAccount, routing: Routing): string | null => {
  if (routing.status !== "available") return null;
  const active = routing.accounts.find((entry) => entry.accountId === account.id);
  if (!active) return null;

  const split = routing.accounts.filter((entry) => entry.provider === account.provider).length > 1;
  const models = split ? ` · ${[...new Set(active.models.map(modelLabel))].join(", ")}` : "";
  return `active${models}${active.switching ? " · switching" : ""}`;
};
