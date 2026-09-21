import type { UsageWindow } from "./types";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const clamp = (value: number) => Math.max(0, Math.min(100, value));

const usageWindow = (
  id: string,
  label: string,
  usedPercent: number,
  resetsAt: number | undefined,
  durationMinutes: number | null,
): UsageWindow => {
  const used = clamp(usedPercent);

  return {
    id,
    label,
    usedPercent: used,
    remainingPercent: clamp(100 - used),
    resetsAt: resetsAt === undefined ? null : new Date(resetsAt).toISOString(),
    durationMinutes,
  };
};

const parseReset = (value: unknown) => {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  const numeric = finiteNumber(value);
  if (numeric === undefined) return undefined;

  return numeric > 10_000_000_000 ? numeric : numeric * 1000;
};

export const normalizeAnthropicUsage = (payload: unknown): ReadonlyArray<UsageWindow> => {
  if (!isRecord(payload)) return [];

  const standard = [
    ["five-hour", "5-hour", payload.five_hour, 300],
    ["weekly", "Weekly", payload.seven_day, 10_080],
  ].flatMap(([id, label, raw, duration]) => {
    if (!isRecord(raw)) return [];
    const used = finiteNumber(raw.utilization);
    if (used === undefined) return [];

    return [
      usageWindow(String(id), String(label), used, parseReset(raw.resets_at), Number(duration)),
    ];
  });

  const scoped = Array.isArray(payload.limits)
    ? payload.limits.flatMap((raw, index) => {
        if (!isRecord(raw) || raw.kind !== "weekly_scoped") return [];
        const scope = isRecord(raw.scope) ? raw.scope : undefined;
        const model = scope && isRecord(scope.model) ? scope.model : undefined;
        const displayName = model?.display_name;
        const used = finiteNumber(raw.percent);
        if (typeof displayName !== "string" || displayName.length === 0 || used === undefined)
          return [];

        const modelId =
          typeof model?.id === "string" && model.id.length > 0
            ? model.id
            : displayName.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");

        return [
          usageWindow(
            `weekly-scoped-${modelId || index}`,
            `${displayName} weekly`,
            used,
            parseReset(raw.resets_at),
            10_080,
          ),
        ];
      })
    : [];

  return [...standard, ...scoped];
};

const codexWindow = (
  id: string,
  fallbackLabel: string,
  raw: unknown,
  now: number,
): UsageWindow | undefined => {
  if (!isRecord(raw)) return undefined;
  const used = finiteNumber(raw.used_percent);
  if (used === undefined) return undefined;
  const durationSeconds = finiteNumber(raw.limit_window_seconds);
  const absolute = parseReset(raw.reset_at);
  const relative = finiteNumber(raw.reset_after_seconds);
  const reset =
    absolute ?? (relative === undefined ? undefined : now + Math.max(0, relative) * 1000);
  const durationMinutes = durationSeconds === undefined ? null : durationSeconds / 60;
  const label =
    durationMinutes === 300 ? "5-hour" : durationMinutes === 10_080 ? "Weekly" : fallbackLabel;

  return usageWindow(id, label, used, reset, durationMinutes);
};

export const normalizeCodexUsage = (
  payload: unknown,
  now = Date.now(),
): ReadonlyArray<UsageWindow> => {
  if (!isRecord(payload) || !isRecord(payload.rate_limit)) return [];

  return [
    codexWindow("primary", "Primary", payload.rate_limit.primary_window, now),
    codexWindow("secondary", "Secondary", payload.rate_limit.secondary_window, now),
  ].filter((window): window is UsageWindow => window !== undefined);
};

export const normalizeGrokUsage = (payload: unknown): ReadonlyArray<UsageWindow> => {
  if (!isRecord(payload) || !isRecord(payload.config)) return [];
  const used = finiteNumber(payload.config.creditUsagePercent);
  if (used === undefined) return [];
  const period = isRecord(payload.config.currentPeriod) ? payload.config.currentPeriod : undefined;
  const type = period?.type;
  const label =
    type === "USAGE_PERIOD_TYPE_WEEKLY"
      ? "Weekly"
      : type === "USAGE_PERIOD_TYPE_MONTHLY"
        ? "Monthly"
        : "Usage";
  const durationMinutes =
    type === "USAGE_PERIOD_TYPE_WEEKLY"
      ? 10_080
      : type === "USAGE_PERIOD_TYPE_MONTHLY"
        ? 43_200
        : null;

  return [usageWindow("credits", label, used, parseReset(period?.end), durationMinutes)];
};

const opencodeWindow = (
  id: string,
  label: string,
  raw: unknown,
  now: number,
  durationMinutes: number | null,
): UsageWindow | undefined => {
  if (!isRecord(raw)) return undefined;
  const used =
    finiteNumber(raw.percent) ?? finiteNumber(raw.usage_percent) ?? finiteNumber(raw.usagePercent);
  if (used === undefined) return undefined;
  const absolute = parseReset(raw.resetsAt ?? raw.resets_at);
  const relative =
    finiteNumber(raw.resets_in_seconds) ??
    finiteNumber(raw.resetInSec) ??
    finiteNumber(raw.reset_after_seconds);
  const reset =
    absolute ?? (relative === undefined ? undefined : now + Math.max(0, relative) * 1000);

  return usageWindow(id, label, used, reset, durationMinutes);
};

export const normalizeOpencodeGoUsage = (
  payload: unknown,
  now = Date.now(),
): ReadonlyArray<UsageWindow> => {
  if (!isRecord(payload) || !isRecord(payload.usage)) return [];

  return [
    opencodeWindow("rolling", "5-hour", payload.usage.rolling, now, 300),
    opencodeWindow("weekly", "Weekly", payload.usage.weekly, now, 10_080),
    opencodeWindow("monthly", "Monthly", payload.usage.monthly, now, 43_200),
  ].filter((window): window is UsageWindow => window !== undefined);
};

export const normalizeZaiUsage = (payload: unknown): ReadonlyArray<UsageWindow> => {
  if (!isRecord(payload) || !isRecord(payload.data)) return [];
  const data = payload.data;
  const limits = data.limits;
  if (!Array.isArray(limits)) return [];

  const allowedTypes = new Set(["TOKENS_LIMIT", "CREDIT_LIMIT"]);

  return [
    { unit: 3, id: "short", label: "5-hour", durationMinutes: 300 },
    { unit: 6, id: "weekly", label: "Weekly", durationMinutes: 10_080 },
  ].flatMap((spec) => {
    const entry = limits.find(
      (candidate) =>
        isRecord(candidate) &&
        allowedTypes.has(String(candidate.type)) &&
        candidate.unit === spec.unit,
    );
    if (!isRecord(entry)) return [];
    const used = finiteNumber(entry.percentage);
    if (used === undefined) return [];

    return [
      usageWindow(spec.id, spec.label, used, parseReset(entry.nextResetTime), spec.durationMinutes),
    ];
  });
};

export const zaiPlan = (payload: unknown): string | null => {
  if (!isRecord(payload) || !isRecord(payload.data)) return null;

  return typeof payload.data.level === "string" ? payload.data.level : null;
};
