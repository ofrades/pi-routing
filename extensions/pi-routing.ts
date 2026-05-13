import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  convertToLlm,
  createBashTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
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

type DelegationContext = "fresh" | "fork";

type InternalSubagentResponse = {
  agent: string;
  task: string;
  context: DelegationContext;
  model: string;
  cwd: string;
  text: string;
  messages: AgentMessage[];
};

function defaultAgentForRoute(routeName: RouteName): string {
  switch (routeName) {
    case "search":
      return "scout";
    case "review":
      return "reviewer";
    case "oracle":
      return "oracle";
    case "librarian":
      return "researcher";
    case "handoff":
    case "vision":
      return "delegate";
  }
}

function extractTextFromDelegatedMessages(messages: unknown[] | undefined): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    if ((message as { role?: unknown }).role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (!block || typeof block !== "object") continue;
      if ((block as { type?: unknown }).type !== "text") continue;
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) return text.trim();
    }
  }
  return "";
}

function modelSupportsImages(model: unknown): boolean {
  const input = (model as { input?: unknown }).input;
  return Array.isArray(input) && input.includes("image");
}

function textMentionsImagePath(text: string): boolean {
  return /(?:^|\s)(?:\.?\.?\/|~\/|\/)[^\s`'"<>]+\.(?:png|jpe?g|gif|webp|bmp|tiff?)(?:\s|$)/i.test(text);
}

function requestContainsImage(event: { prompt?: unknown; images?: unknown }): boolean {
  if (Array.isArray(event.images) && event.images.length > 0) return true;
  return typeof event.prompt === "string" && textMentionsImagePath(event.prompt);
}

function toolsForRoute(routeName: RouteName, cwd: string) {
  const readOnly = [
    createReadTool(cwd),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
  ];

  switch (routeName) {
    case "search":
    case "librarian":
      return [...readOnly, createBashTool(cwd)];
    case "review":
    case "oracle":
    case "handoff":
    case "vision":
      return readOnly;
  }
}

function systemPromptForRoute(routeName: RouteName, agent: string): string {
  const base = [
    `You are a focused ${agent} subagent for the ${routeName} route.`,
    "Work independently and keep output concise.",
    "Prefer reading/searching over guessing. Include relevant file paths, commands, and sources.",
    "Do not edit files; return findings and recommendations only.",
  ];

  if (routeName === "search") {
    base.push("Use local code search first. If external/current information is required, use bash with network tools such as curl when available.");
  }
  if (routeName === "librarian") {
    base.push("Focus on external documentation. Use bash with network tools such as curl when available, and cite URLs or source names.");
  }
  if (routeName === "review") {
    base.push("Focus on correctness, regressions, security, tests, and unnecessary complexity.");
  }
  if (routeName === "oracle") {
    base.push("Challenge assumptions and identify risks/tradeoffs before recommending a path.");
  }

  return base.join("\n");
}

async function runInternalSubagent(
  ctx: ExtensionContext,
  routeName: RouteName,
  request: {
    agent: string;
    task: string;
    context: DelegationContext;
    model: string;
    cwd: string;
    thinkingLevel: ModelThinkingLevel;
  },
  signal?: AbortSignal,
): Promise<InternalSubagentResponse> {
  const [provider, ...modelParts] = request.model.split("/");
  const modelId = modelParts.join("/");
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) throw new Error(`Model unavailable for delegated route: ${request.model}`);

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);

  const seedMessages: AgentMessage[] = [];
  if (request.context === "fork") {
    seedMessages.push(...ctx.sessionManager.getBranch()
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message));
  }

  const agent = new Agent({
    initialState: {
      model,
      thinkingLevel: request.thinkingLevel,
      systemPrompt: systemPromptForRoute(routeName, request.agent),
      tools: toolsForRoute(routeName, request.cwd),
      messages: seedMessages,
    },
    convertToLlm,
    getApiKey: async () => auth.apiKey,
    toolExecution: "parallel",
  });

  let turns = 0;
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "turn_start") {
      turns += 1;
      if (ctx.hasUI) ctx.ui.setStatus("route-delegate", `delegating to ${request.agent} · turn ${turns}`);
    } else if (event.type === "tool_execution_start") {
      if (ctx.hasUI) ctx.ui.setStatus("route-delegate", `delegating to ${request.agent} · ${event.toolName}`);
    }
  });

  try {
    if (ctx.hasUI) ctx.ui.setStatus("route-delegate", `delegating to ${request.agent}`);
    await agent.prompt(request.task);
  } finally {
    unsubscribe();
    if (ctx.hasUI) ctx.ui.setStatus("route-delegate", undefined);
  }

  if (signal?.aborted) agent.abort();

  const messages = agent.state.messages;
  const text = extractTextFromDelegatedMessages(messages) || "(no delegated output)";
  return {
    agent: request.agent,
    task: request.task,
    context: request.context,
    model: request.model,
    cwd: request.cwd,
    text,
    messages,
  };
}

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
  let autoRestoreRoute: RouteName | undefined;

  async function autoRouteImageRequest(
    ctx: ExtensionContext,
    event: { prompt?: unknown; text?: unknown; images?: unknown },
  ): Promise<void> {
    config = withConfig(ctx);
    if (config.enabled === false) return;
    const prompt = typeof event.prompt === "string" ? event.prompt : event.text;
    if (!requestContainsImage({ prompt, images: event.images })) return;

    if (ctx.model && modelSupportsImages(ctx.model)) return;

    const route = resolveRouteState(config, "vision");
    if (!route.provider || !route.model) {
      notify(ctx, "Image detected, but the vision route is not configured.", "warning");
      return;
    }

    const model = ctx.modelRegistry.find(route.provider, route.model);
    if (!model) {
      notify(ctx, `Image detected, but the vision route model is unavailable: ${route.provider}/${route.model}`, "warning");
      return;
    }

    if (!modelSupportsImages(model)) {
      notify(ctx, `Image detected, but the configured vision model does not advertise image input: ${route.provider}/${route.model}`, "error");
      return;
    }

    const ok = await applyRoute(ctx, pi, config, "vision");
    if (!ok) return;
    autoRestoreRoute = route.restore === false ? undefined : "vision";
    notify(ctx, `Auto-routed image request to vision: ${route.provider}/${route.model}`, "info");
  }

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    await autoRouteImageRequest(ctx, event);
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await autoRouteImageRequest(ctx, event);
  });

  pi.on("agent_end", async (_event, ctx) => {
    config = withConfig(ctx);
    if (autoRestoreRoute) {
      autoRestoreRoute = undefined;
      await restoreRoute(ctx, pi, config);
      return;
    }
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
    name: "task_delegate",
    label: "Task Delegate",
    description:
      "Delegate a routed task to an internal focused subagent using the route's configured model, without changing the main session model.",
    promptSnippet:
      "Use task_delegate when a route-specific model should perform a concrete subtask now and return results, especially for search, review, oracle, or librarian work.",
    promptGuidelines: [
      "Prefer context='fresh' for cheap search/librarian/review tasks when the prompt includes enough detail.",
      "Use context='fork' only when the child needs the current conversation context; forked context costs more.",
      "Use task_delegate with task='vision' for immediate image/PDF/media analysis when a path is mentioned and the current model may not support images.",
      "Use task_model switch only for changing the main session model; use task_delegate for immediate routed work.",
    ],
    parameters: Type.Object({
      task: StringEnum(ROUTE_ORDER),
      prompt: Type.String({ description: "The concrete task to give the delegated child agent." }),
      agent: Type.Optional(Type.String({ description: "Override subagent name. Defaults by route: search=scout, review=reviewer, oracle=oracle, librarian=researcher, others=delegate." })),
      context: Type.Optional(StringEnum(["fresh", "fork"] as const)),
      cwd: Type.Optional(Type.String({ description: "Working directory for the subagent. Defaults to current cwd." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      config = withConfig(ctx);
      const routingEnabled = config.enabled !== false;
      if (!routingEnabled) throw new Error("Task routing is disabled.");

      const task = params.task as RouteName;
      if (!isRouteName(task)) {
        throw new Error(`task is required. Use one of: ${ROUTE_ORDER.join(", ")}`);
      }

      const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
      if (!prompt) throw new Error("prompt is required for delegated route execution.");

      const route = resolveRouteState(config, task);
      if (!route.provider || !route.model) {
        throw new Error(
          `Route "${task}" is not configured with provider/model in settings. ${route.description}`,
        );
      }
      const model = ctx.modelRegistry.find(route.provider, route.model);
      if (!model) throw new Error(`Route "${task}" model is not available: ${route.provider}/${route.model}`);

      const agent =
        typeof params.agent === "string" && params.agent.trim()
          ? params.agent.trim()
          : defaultAgentForRoute(task);
      const context = params.context === "fork" ? "fork" : "fresh";
      const cwd = typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : ctx.cwd;
      const modelSpec = `${route.provider}/${route.model}`;
      const thinking = route.thinkingLevel ?? highestThinkingLevel(model);
      const delegatedPrompt = [
        `[Routed task: ${task}]`,
        `Use model route ${modelSpec} with thinking:${thinking}.`,
        "Return concise, actionable results. Include file paths and commands when relevant.",
        "",
        prompt,
      ].join("\n");

      notify(ctx, `Delegating ${task} to internal ${agent} on ${modelSpec}`, "info");
      const response = await runInternalSubagent(
        ctx,
        task,
        {
          agent,
          task: delegatedPrompt,
          context,
          model: modelSpec,
          cwd,
          thinkingLevel: thinking,
        },
        signal,
      );

      const text = response.text;
      return {
        content: [
          {
            type: "text",
            text: `Delegated ${task} to internal ${agent} using ${modelSpec} (${context} context).\n\n${text}`,
          },
        ],
        details: response,
      };
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
