import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  ModelSelectorComponent,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  applyRoute,
  highestThinkingLevel,
  isRouteName,
  loadConfig,
  notify,
  persistConfig,
  resolveRouteState,
  restoreRoute,
  ROUTE_ORDER,
  setStatus,
  supportedThinkingLevels,
  withConfig,
  type Config,
  type RouteName,
} from "../src/mode-core.ts";

async function pickModel(
  ctx: ExtensionContext,
  config: Config,
  routeName: RouteName,
): Promise<{ provider: string; model: string } | undefined> {
  const route = resolveRouteState(config, routeName);
  const currentModel =
    (route.provider && route.model
      ? ctx.modelRegistry.find(route.provider, route.model)
      : undefined) ?? ctx.model;
  const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir());

  const selected = await ctx.ui.custom<import("@earendil-works/pi-ai").Model<any> | null>(
    (tui, _theme, _kb, done) =>
      new ModelSelectorComponent(
        tui,
        currentModel,
        settingsManager,
        ctx.modelRegistry,
        [],
        (model) => done(model),
        () => done(null),
      ),
  );

  return selected ? { provider: selected.provider, model: selected.id } : undefined;
}

async function pickThinkingLevel(
  ctx: ExtensionContext,
  config: Config,
  routeName: RouteName,
): Promise<ModelThinkingLevel | undefined> {
  const route = resolveRouteState(config, routeName);
  const model =
    route.provider && route.model
      ? ctx.modelRegistry.find(route.provider, route.model)
      : undefined;
  const current = route.thinkingLevel ?? highestThinkingLevel(model);
  const levels = [current, ...supportedThinkingLevels(model).filter((level) => level !== current)];
  const labels = levels.map((level) => (level === current ? `${level} [current]` : level));
  const selected = await ctx.ui.select(`Thinking for ${routeName}`, labels);
  return selected ? levels[labels.indexOf(selected)] : undefined;
}

async function showRouteSelector(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  config: Config,
): Promise<void> {
  let selectedIndex = Math.max(
    0,
    ROUTE_ORDER.indexOf(config.activeRoute ?? "vision"),
  );

  while (true) {
    const result = await ctx.ui.custom<{
      action: "confirm" | "thinking" | "model" | "toggle" | "cancel";
      routeName: RouteName;
    }>((tui, theme, _kb, done) => ({
      render(_width: number) {
        const enabled = config.enabled ?? false;
        const lines: string[] = [
          theme.fg("accent", theme.bold(`Routing · ${enabled ? "on" : "off"}`)),
        ];
        for (const [index, name] of ROUTE_ORDER.entries()) {
          const route = resolveRouteState(config, name);
          const configured =
            route.provider && route.model
              ? `${route.provider}/${route.model}`
              : "unconfigured";
          const thinking = route.thinkingLevel ? ` · thinking:${route.thinkingLevel}` : "";
          const line = `${index === selectedIndex ? "→ " : "  "}${name} — ${configured}${thinking}${
            name === config.activeRoute ? " [active]" : ""
          }`;
          lines.push(index === selectedIndex ? theme.fg("accent", line) : line);
        }
        lines.push(
          theme.fg(
            "dim",
            "↑↓/j/k choose • Enter apply • t thinking • c model • e toggle • Esc cancel",
          ),
        );
        return lines;
      },
      invalidate() {},
      handleInput(data: string) {
        const routeName = ROUTE_ORDER[selectedIndex];
        if (data === "\r" || data === "\n") done({ action: "confirm", routeName });
        else if (data === "t" || data === "T") done({ action: "thinking", routeName });
        else if (data === "c" || data === "C") done({ action: "model", routeName });
        else if (data === "e" || data === "E") done({ action: "toggle", routeName });
        else if (data === "\u001b[A" || data === "k") {
          selectedIndex = (selectedIndex - 1 + ROUTE_ORDER.length) % ROUTE_ORDER.length;
          tui.requestRender();
        } else if (data === "\u001b[B" || data === "j") {
          selectedIndex = (selectedIndex + 1) % ROUTE_ORDER.length;
          tui.requestRender();
        } else if (data === "\u001b" || data.startsWith("\u001b")) {
          done({ action: "cancel", routeName });
        }
      },
    }));

    if (!result || result.action === "cancel") return;
    selectedIndex = ROUTE_ORDER.indexOf(result.routeName);

    if (result.action === "toggle") {
      config.enabled = !(config.enabled ?? false);
      persistConfig(ctx, config);
      notify(ctx, `Task routing ${config.enabled ? "enabled" : "disabled"}`, "info");
    } else if (result.action === "thinking") {
      const level = await pickThinkingLevel(ctx, config, result.routeName);
      if (level) {
        config.routes ??= {};
        config.routes[result.routeName] = {
          ...config.routes[result.routeName],
          thinkingLevel: level,
        };
        persistConfig(ctx, config);
      }
    } else if (result.action === "model") {
      const model = await pickModel(ctx, config, result.routeName);
      if (model) {
        config.routes ??= {};
        config.routes[result.routeName] = {
          ...config.routes[result.routeName],
          provider: model.provider,
          model: model.model,
        };
        persistConfig(ctx, config);
      }
    } else {
      const ok = await applyRoute(ctx, pi, config, result.routeName);
      if (!ok) {
        notify(
          ctx,
          `Route "${result.routeName}" is not configured or routing is disabled.`,
          "error",
        );
        continue;
      }
      return;
    }
  }
}

export default function routingExtension(pi: ExtensionAPI) {
  let config = loadConfig();
  let pendingModelReassert:
    | { provider: string; model: string; thinkingLevel?: ModelThinkingLevel; routeName?: RouteName }
    | undefined;

  pi.on("agent_end", async (_event, ctx) => {
    config = withConfig(ctx);
    if (!pendingModelReassert) return;
    const target = pendingModelReassert;
    pendingModelReassert = undefined;
    const model = ctx.modelRegistry.find(target.provider, target.model);
    if (!model) return;
    if (await pi.setModel(model)) {
      pi.setThinkingLevel(target.thinkingLevel ?? highestThinkingLevel(model));
      setStatus(ctx, "route", target.routeName ? `route:${target.routeName}` : undefined);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    config = withConfig(ctx);
    setStatus(
      ctx,
      "route",
      config.activeRoute ? `route:${config.activeRoute}` : undefined,
    );
  });

  pi.registerCommand("routing", {
    description: "Select or configure task routes",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      const [first = ""] = trimmed.split(/\s+/);
      return ["on", "off"]
        .filter((name) => name.startsWith(first))
        .map((name) => ({ value: name, label: name }));
    },
    handler: async (args, ctx) => {
      config = withConfig(ctx);
      const arg = args.trim();

      if (arg === "on") {
        config.enabled = true;
        persistConfig(ctx, config);
        notify(ctx, "Task routing enabled", "info");
        return;
      }

      if (arg === "off") {
        config.enabled = false;
        persistConfig(ctx, config);
        notify(ctx, "Task routing disabled", "info");
        return;
      }

      if (arg) {
        notify(
          ctx,
          `Unknown argument "${arg}". Use: on, off, or no argument for the selector.`,
          "error",
        );
        return;
      }

      await showRouteSelector(ctx, pi, config);
    },
  });

  pi.registerTool({
    name: "task_model",
    label: "Task Model",
    description:
      "Task-aware model router for listing, switching to, and restoring named route models. Inline route execution is intentionally left to prompt-template/subagent extensions.",
    promptSnippet:
      "Use task_model to inspect named route models or switch the session to a specialized route when explicitly needed. Prefer prompt-template/subagent workflows for delegated one-shot work.",
    promptGuidelines: [
      "Use action='list' or action='status' to inspect route configuration.",
      "Use action='switch' only when you need to hand off the session to a different route model. Use action='restore' when done.",
      "For one-shot delegated work, prefer installed prompt-template/subagent commands instead of task_model.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "switch", "restore", "status"] as const),
      task: Type.Optional(StringEnum(ROUTE_ORDER)),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      config = withConfig(ctx);
      const routingEnabled = config.enabled !== false;

      if (params.action === "status") {
        return {
          content: [
            {
              type: "text",
              text: `Task routing is ${routingEnabled ? "enabled" : "disabled"}.${
                config.activeRoute ? ` Active route: ${config.activeRoute}.` : ""
              }`,
            },
          ],
          details: undefined,
        };
      }

      if (params.action === "list") {
        const lines = ROUTE_ORDER.map((routeName) => {
          const route = resolveRouteState(config, routeName);
          const configured =
            route.provider && route.model ? `${route.provider}/${route.model}` : "unconfigured";
          const model =
            route.provider && route.model
              ? ctx.modelRegistry.find(route.provider, route.model)
              : undefined;
          const thinkingLevel =
            route.thinkingLevel ?? (model ? highestThinkingLevel(model) : undefined);
          return `- ${routeName}: ${configured}${
            thinkingLevel ? ` · thinking:${thinkingLevel}` : ""
          } · ${route.description}`;
        });
        return {
          content: [
            {
              type: "text",
              text: `Task routing: ${routingEnabled ? "enabled" : "disabled"}\n${lines.join("\n")}`,
            },
          ],
          details: undefined,
        };
      }

      if (params.action === "restore") {
        const previous = config.previous;
        const ok = await restoreRoute(ctx, pi, config);
        if (!ok) throw new Error("Could not restore previous/main model.");
        pendingModelReassert =
          previous?.provider && previous.model
            ? {
                provider: previous.provider,
                model: previous.model,
                thinkingLevel: previous.thinkingLevel,
              }
            : undefined;
        return {
          content: [{ type: "text", text: "Restored previous/main model." }],
          details: undefined,
        };
      }

      const task = params.task as RouteName | undefined;
      if (!task || !isRouteName(task)) {
        throw new Error(`task is required. Use one of: ${ROUTE_ORDER.join(", ")}`);
      }
      if (!routingEnabled) {
        throw new Error("Task routing is disabled.");
      }

      const route = resolveRouteState(config, task);
      if (!route.provider || !route.model) {
        throw new Error(
          `Route "${task}" is not configured with provider/model in settings. ${route.description}`,
        );
      }

      const model = ctx.modelRegistry.find(route.provider, route.model);
      const thinkingLevel = route.thinkingLevel ?? highestThinkingLevel(model);
      const ok = await applyRoute(ctx, pi, config, task);
      if (!ok) throw new Error(`Failed to switch to ${task}: ${route.provider}/${route.model}`);

      pendingModelReassert = {
        provider: route.provider,
        model: route.model,
        thinkingLevel: route.thinkingLevel ?? thinkingLevel,
        routeName: task,
      };

      return {
        content: [
          {
            type: "text",
            text: `Switched to ${task}: ${route.provider}/${route.model} · thinking:${thinkingLevel}. IMPORTANT: pi model changes take effect on the next user turn, not the current turn. Call action='restore' when the specialized work is complete.`,
          },
        ],
        details: undefined,
      };
    },
  });
}
