import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";

export type RouteName = "vision" | "handoff" | "search" | "review" | "oracle" | "librarian";

export type RouteState = {
  provider?: string;
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  description?: string;
  restore?: boolean;
};

export type CostEntry = {
  timestamp: number;
  mode: RouteName | string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  cost: number;
};

export type TurnEntry = {
  turnId: string;
  timestamp: number;
  provider: string;
  model: string;
  route?: RouteName;
  thinkingLevel: ModelThinkingLevel;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  autoRouted: boolean;
  cost: number;
};

export type Config = {
  enabled?: boolean;
  activeRoute?: RouteName;
  previous?: {
    provider?: string;
    model?: string;
    thinkingLevel?: ModelThinkingLevel;
  };
  routes?: Partial<Record<RouteName, Partial<RouteState>>>;
};

export const ROUTE_ORDER: RouteName[] = ["vision", "handoff", "search", "review", "oracle", "librarian"];

export function isRouteName(value: string): value is RouteName {
  return (ROUTE_ORDER as readonly string[]).includes(value);
}

const ROUTE_METADATA: Record<
  RouteName,
  { description: string; recommendedModel: string; restore: boolean }
> = {
  vision: {
    description: "Image and screenshot understanding; use when prompts include image paths or image reads.",
    recommendedModel: "Gemini 3 Flash",
    restore: true,
  },
  handoff: {
    description: "Compact context transfer and continuation prompts.",
    recommendedModel: "Gemini 3 Flash",
    restore: true,
  },
  search: {
    description: "Fast retrieval-oriented codebase search and context gathering.",
    recommendedModel: "Gemini 3 Flash",
    restore: true,
  },
  review: {
    description: "Code review, bug finding, regression/security/maintainability checks.",
    recommendedModel: "Gemini 3.1 Pro",
    restore: true,
  },
  oracle: {
    description: "Complex reasoning, planning, consistency checks, and architectural tradeoffs.",
    recommendedModel: "GPT-5.4",
    restore: true,
  },
  librarian: {
    description: "External docs, dependencies, APIs, and unfamiliar library research.",
    recommendedModel: "Claude Sonnet 4.6",
    restore: true,
  },
};

const THINKING_LEVELS_DESC: ModelThinkingLevel[] = [
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "off",
];

const SETTINGS_PATH = join(getAgentDir(), "settings.json");
export const COST_LOG_PATH = join(getAgentDir(), "cost-log.jsonl");

let settingsReadError: string | undefined;

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readSettings(): Record<string, unknown> {
  try {
    settingsReadError = undefined;
    return existsSync(SETTINGS_PATH) ? JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) : {};
  } catch (error) {
    settingsReadError = formatError(error);
    return {};
  }
}

function saveConfig(config: Config) {
  const settings = readSettings();
  if (settingsReadError) {
    throw new Error(`Refusing to overwrite unreadable settings.json: ${settingsReadError}`);
  }

  settings.routing = config;
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

export function notify(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

export function setStatus(ctx: ExtensionContext, key: string, value: string | undefined): void {
  if (ctx.hasUI) ctx.ui.setStatus(key, value);
}

export function costLabel(cost: number): string {
  return cost < 0.01 && cost > 0 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

export function activeCostBucket(config: Config): string {
  return config.activeRoute ?? "custom";
}

export function appendCostEntry(entry: CostEntry): void {
  mkdirSync(dirname(COST_LOG_PATH), { recursive: true });
  appendFileSync(COST_LOG_PATH, `${JSON.stringify(entry)}\n`);
}

function jsonlDate(timestamp = Date.now()): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function turnLogPath(cwd: string, timestamp = Date.now()): string {
  return join(cwd, ".pi-agent", `session-${jsonlDate(timestamp)}.jsonl`);
}

export function appendTurnEntry(cwd: string, entry: TurnEntry): void {
  const path = turnLogPath(cwd, entry.timestamp);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

export function readTurnLog(cwd: string, timestamp = Date.now()): TurnEntry[] {
  const path = turnLogPath(cwd, timestamp);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\n+/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TurnEntry];
      } catch {
        return [];
      }
    });
}

export function formatTurnLog(entries: TurnEntry[]): string {
  return entries
    .map((entry) => {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      const route = entry.route ? ` route:${entry.route}` : "";
      return `${time} ${entry.provider}/${entry.model}${route} thinking:${entry.thinkingLevel} ${costLabel(entry.cost)} (${entry.promptTokens}→${entry.completionTokens}, ${entry.durationMs}ms)`;
    })
    .join("\n");
}

export function readCostLog(): CostEntry[] {
  if (!existsSync(COST_LOG_PATH)) return [];
  return readFileSync(COST_LOG_PATH, "utf8")
    .split(/\n+/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as CostEntry];
      } catch {
        return [];
      }
    });
}

export function summarizeCosts(entries: CostEntry[]): string {
  const groups = new Map<string, { cost: number; input: number; output: number; count: number }>();
  for (const entry of entries) {
    const key = `${entry.mode} · ${entry.provider}/${entry.model}`;
    const group = groups.get(key) ?? { cost: 0, input: 0, output: 0, count: 0 };
    group.cost += entry.cost;
    group.input += entry.inputTokens;
    group.output += entry.outputTokens;
    group.count += 1;
    groups.set(key, group);
  }

  return [...groups.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(
      ([key, group]) =>
        `${key}: ${costLabel(group.cost)} (${group.input} in, ${group.output} out, ${group.count} calls)`,
    )
    .join("\n");
}

export function loadConfig(): Config {
  const settings = readSettings();
  const config = settings.routing;
  return config && typeof config === "object" ? (config as Config) : {};
}

export function persistConfig(ctx: ExtensionContext, config: Config): boolean {
  try {
    saveConfig(config);
    return true;
  } catch (error) {
    notify(ctx, `Could not save routing settings: ${formatError(error)}`, "error");
    return false;
  }
}

function findConfiguredModel(ctx: ExtensionContext, state: Partial<RouteState> | undefined) {
  return state?.provider && state.model ? ctx.modelRegistry.find(state.provider, state.model) : undefined;
}

export function supportedThinkingLevels(model: unknown): ModelThinkingLevel[] {
  try {
    const levels = getSupportedThinkingLevels(
      model as Parameters<typeof getSupportedThinkingLevels>[0],
    );
    return levels.length > 0 ? levels : ["off"];
  } catch {
    return ["off"];
  }
}

export function highestThinkingLevel(model: unknown): ModelThinkingLevel {
  if (!model) return "off";
  const supported = new Set(supportedThinkingLevels(model));
  return THINKING_LEVELS_DESC.find((level) => supported.has(level)) ?? "off";
}

export function resolveRouteState(config: Config, routeName: RouteName): RouteState {
  const meta = ROUTE_METADATA[routeName];
  const route = config.routes?.[routeName];
  return {
    provider: route?.provider,
    model: route?.model,
    thinkingLevel: route?.thinkingLevel,
    description:
      route?.description ?? `${meta.description} Recommended model: ${meta.recommendedModel}.`,
    restore: route?.restore ?? meta.restore,
  };
}

function ensureRoutingDefaults(ctx: ExtensionContext, config: Config) {
  if (config.activeRoute && !isRouteName(config.activeRoute)) {
    delete config.activeRoute;
  }

  config.enabled ??= false;
  config.routes ??= {};
  for (const routeName of ROUTE_ORDER) {
    const existing = config.routes[routeName] ?? {};
    const resolved = resolveRouteState(config, routeName);
    config.routes[routeName] = {
      ...existing,
      description: resolved.description,
      restore: resolved.restore,
    };
  }
}

export function withConfig(ctx: ExtensionContext): Config {
  const config = loadConfig();
  if (settingsReadError) {
    notify(
      ctx,
      `Could not read settings.json; using in-memory defaults and refusing to overwrite it: ${settingsReadError}`,
      "error",
    );
  }
  ensureRoutingDefaults(ctx, config);
  return config;
}

export async function applyRoute(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  config: Config,
  routeName: RouteName,
): Promise<boolean> {
  if (config.enabled === false) return false;
  const state = resolveRouteState(config, routeName);
  if (!state.provider || !state.model) return false;
  const model = ctx.modelRegistry.find(state.provider, state.model);
  if (!model) return false;

  if (ctx.model && !config.previous) {
    config.previous = {
      provider: ctx.model.provider,
      model: ctx.model.id,
      thinkingLevel: pi.getThinkingLevel(),
    };
  }

  if (!(await pi.setModel(model))) return false;
  pi.setThinkingLevel(state.thinkingLevel ?? highestThinkingLevel(model));
  config.activeRoute = routeName;
  persistConfig(ctx, config);
  setStatus(ctx, "route", `route:${routeName}`);
  return true;
}

export async function restoreRoute(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  config: Config,
): Promise<boolean> {
  const prev = config.previous;
  if (prev?.provider && prev.model) {
    const model = ctx.modelRegistry.find(prev.provider, prev.model);
    if (model && (await pi.setModel(model))) {
      pi.setThinkingLevel(prev.thinkingLevel ?? highestThinkingLevel(model));
      delete config.activeRoute;
      delete config.previous;
      persistConfig(ctx, config);
      setStatus(ctx, "route", undefined);
      return true;
    }
  }

  delete config.activeRoute;
  delete config.previous;
  persistConfig(ctx, config);
  setStatus(ctx, "route", undefined);
  return false;
}
