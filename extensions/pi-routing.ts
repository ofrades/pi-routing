import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  applyRoute,
  highestThinkingLevel,
  isRouteName,
  loadConfig,
  resolveRouteState,
  restoreRoute,
  ROUTE_ORDER,
  setStatus,
  withConfig,
  type RouteName,
} from "../src/mode-core.ts";

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
      config.routing?.activeRoute ? `route:${config.routing.activeRoute}` : undefined,
    );
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
      const routingEnabled = config.routing?.enabled !== false;

      if (params.action === "status") {
        return {
          content: [
            {
              type: "text",
              text: `Task routing is ${routingEnabled ? "enabled" : "disabled"}.${
                config.routing?.activeRoute ? ` Active route: ${config.routing.activeRoute}.` : ""
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
        const previous = config.routing?.previous;
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
