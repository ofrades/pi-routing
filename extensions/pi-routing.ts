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
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, StringEnum, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";

// --- Domain ---

export type RouteName = "eagle" | "search" | "review" | "oracle" | "librarian";

const ROUTE_ORDER: RouteName[] = ["eagle", "search", "review", "oracle", "librarian"];

type RouteConfig = {
  provider: string;
  model: string;
  thinkingLevel?: ModelThinkingLevel;
};

type Config = {
  routes?: Partial<Record<RouteName, RouteConfig>>;
};

const ROUTE_METADATA: Record<
  RouteName,
  { description: string; recommendedModel: string; systemPrompt: string }
> = {
  eagle: {
    description:
      "Image and screenshot understanding. Describe visual content precisely so the main agent can act on it.",
    recommendedModel: "Gemini 3 Flash",
    systemPrompt:
      "You are an eagle subagent. Describe images, screenshots, and visual content precisely and completely. Include all text, UI elements, layout, colors, and any information visible. Be thorough — the main agent will rely entirely on your description.",
  },
  search: {
    description: "Fast retrieval-oriented codebase search and context gathering.",
    recommendedModel: "Gemini 3 Flash",
    systemPrompt:
      "You are a search subagent. Use local code search tools to find relevant files, functions, and context. Prefer reading over guessing. Do not edit files. Bash is for read-only commands only, such as rg, git grep, find, ls, and other inspection commands. Return concise findings with: relevant files and line ranges, key symbols/functions, important excerpts, and the recommended starting point.",
  },
  review: {
    description: "Code review, bug finding, regression/security/maintainability checks.",
    recommendedModel: "Gemini 3.1 Pro",
    systemPrompt:
      "You are a review subagent. Check for correctness, regressions, security issues, unnecessary complexity, and missing tests. Be specific: include file paths, line numbers, and concrete suggestions. Do not edit files. Bash is for read-only commands only, such as git diff, git log, git show, and listing/searching files. Return concise findings with: files reviewed, critical issues, warnings, suggestions, and a brief summary.",
  },
  oracle: {
    description: "Complex reasoning, planning, consistency checks, and architectural tradeoffs.",
    recommendedModel: "GPT-5.4",
    systemPrompt:
      "You are an oracle subagent. Challenge assumptions, identify risks and tradeoffs, and recommend a clear path. Think carefully before answering. Do not edit files. Return concise findings with: recommendation, tradeoffs, risks, and next steps.",
  },
  librarian: {
    description: "External docs, dependencies, APIs, and unfamiliar library research.",
    recommendedModel: "Claude Sonnet 4.6",
    systemPrompt:
      "You are a librarian subagent. Research external documentation, APIs, libraries, and public source code using available tools. Cite URLs and source names. Return actionable findings. Do not edit files. Bash is for read-only commands only, such as curl, package-manager metadata queries, git/gh read operations, and local inspection commands. Return concise findings with: sources/URLs, key findings, and actionable implications.",
  },
};

// --- Config persistence ---

const SETTINGS_PATH = join(getAgentDir(), "settings.json");

function readSettings(): Record<string, unknown> {
  try {
    return existsSync(SETTINGS_PATH) ? JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) : {};
  } catch {
    return {};
  }
}

function loadConfig(): Config {
  const settings = readSettings();
  const routing = settings.routing;
  return routing && typeof routing === "object" ? (routing as Config) : {};
}

function persistConfig(ctx: ExtensionContext, config: Config): void {
  try {
    const settings = readSettings();
    settings.routing = config;
    writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (error) {
    notify(
      ctx,
      `Could not save routing config: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

// --- Utilities ---

function notify(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function highestThinkingLevel(model: unknown): ModelThinkingLevel {
  try {
    const levels = getSupportedThinkingLevels(
      model as Parameters<typeof getSupportedThinkingLevels>[0],
    );
    const order: ModelThinkingLevel[] = ["xhigh", "high", "medium", "low", "minimal", "off"];
    const supported = new Set(levels);
    return order.find((l) => supported.has(l)) ?? "off";
  } catch {
    return "off";
  }
}

function toolsForRoute(routeName: RouteName, cwd: string) {
  const readOnly = [
    createReadTool(cwd),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
  ];
  if (routeName === "search" || routeName === "librarian" || routeName === "review") {
    return [...readOnly, createBashTool(cwd)];
  }
  return readOnly;
}

function extractLastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    if ((msg as { role?: unknown }).role !== "assistant") continue;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if ((block as { type?: unknown })?.type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string" && text.trim()) return text.trim();
      }
    }
  }
  return "";
}

// --- Subagent runner ---

type ImageInput = { type: "image"; data: string; mimeType: string };

async function runSubagent(
  ctx: ExtensionContext,
  routeName: RouteName,
  prompt: string,
  routeConfig: RouteConfig,
  signal?: AbortSignal,
  onUpdate?: (text: string, status: string) => void,
  images?: ImageInput[],
): Promise<string> {
  const model = ctx.modelRegistry.find(routeConfig.provider, routeConfig.model);
  if (!model) throw new Error(`Model not available: ${routeConfig.provider}/${routeConfig.model}`);

  const thinkingLevel = routeConfig.thinkingLevel ?? highestThinkingLevel(model);
  const meta = ROUTE_METADATA[routeName];

  const agent = new Agent({
    initialState: {
      model,
      thinkingLevel,
      systemPrompt: meta.systemPrompt,
      tools: toolsForRoute(routeName, ctx.cwd),
      messages: [],
    },
    convertToLlm,
    toolExecution: "parallel",
  });

  let latestText = "";
  let lastUpdateAt = 0;

  const modelLabel = `${routeConfig.provider}/${routeConfig.model}`;

  const emit = (status: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastUpdateAt < 250) return;
    lastUpdateAt = now;
    if (ctx.hasUI) ctx.ui.setStatus("route-delegate", `[${routeName}] ${modelLabel} · ${status}`);
    onUpdate?.(latestText, status);
  };

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "turn_start") {
      emit("thinking", true);
    } else if (event.type === "message_update") {
      const text = extractLastAssistantText([event.message]);
      if (text) latestText = text;
      emit("responding");
    } else if (event.type === "tool_execution_start") {
      emit(event.toolName, true);
    } else if (event.type === "tool_execution_end") {
      emit(`${event.toolName} done`, true);
    }
  });

  const onAbort = () => agent.abort();
  if (signal) {
    if (signal.aborted) agent.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    notify(ctx, `[${routeName}] → ${modelLabel} (thinking:${thinkingLevel})`, "info");
    emit("starting", true);
    await agent.prompt(prompt, images);
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    unsubscribe();
    if (ctx.hasUI) ctx.ui.setStatus("route-delegate", undefined);
    notify(ctx, `[${routeName}] ← done`, "info");
  }

  return extractLastAssistantText(agent.state.messages) || "(no output)";
}

// --- Pi subprocess subagent runner ---

type UsageStats = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
};

type SubprocessResult = {
  text: string;
  stderr: string;
  nonJsonStdout: string;
  exitCode: number;
  usage: UsageStats;
  stopReason?: string;
  errorMessage?: string;
};

function toolNamesForRoute(routeName: RouteName): string[] {
  const readOnly = ["read", "grep", "find", "ls"];
  if (routeName === "search" || routeName === "librarian" || routeName === "review") {
    return [...readOnly, "bash"];
  }
  return readOnly;
}

function modelSpecForRoute(ctx: ExtensionContext, routeConfig: RouteConfig): string {
  const base = `${routeConfig.provider}/${routeConfig.model}`;
  if (routeConfig.thinkingLevel) return `${base}:${routeConfig.thinkingLevel}`;

  const model = ctx.modelRegistry.find(routeConfig.provider, routeConfig.model);
  if (!model) return base;
  return `${base}:${highestThinkingLevel(model)}`;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };

  return { command: "pi", args };
}

function assistantTextFromMessage(message: unknown): string {
  const msg = message as { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown };
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return "";
  const texts = msg.content
    .filter((part): part is { type: string; text: string } =>
      Boolean(
        part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      ),
    )
    .map((part) => part.text)
    .join("");
  return texts.trim();
}

function createUsageStats(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function addMessageUsage(usageStats: UsageStats, message: unknown): void {
  const msg = message as { role?: unknown; usage?: unknown };
  if (msg.role !== "assistant") return;

  const usage = msg.usage as
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        totalTokens?: number;
        cost?: { total?: number } | number;
      }
    | undefined;
  if (!usage || typeof usage !== "object") return;

  usageStats.input += usage.input ?? 0;
  usageStats.output += usage.output ?? 0;
  usageStats.cacheRead += usage.cacheRead ?? 0;
  usageStats.cacheWrite += usage.cacheWrite ?? 0;
  // totalTokens reflects the current request/context total, so keep the latest observed value.
  usageStats.contextTokens = usage.totalTokens ?? usageStats.contextTokens;
  usageStats.cost += typeof usage.cost === "number" ? usage.cost : usage.cost?.total ?? 0;
}

async function runPiSubagent(
  ctx: ExtensionContext,
  routeName: RouteName,
  prompt: string,
  routeConfig: RouteConfig,
  signal?: AbortSignal,
  onUpdate?: (text: string, status: string) => void,
): Promise<SubprocessResult> {
  const modelSpec = modelSpecForRoute(ctx, routeConfig);
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-routing-subagent-"));
  const promptPath = join(tmpDir, `${routeName}.md`);
  writeFileSync(promptPath, ROUTE_METADATA[routeName].systemPrompt, { encoding: "utf8", mode: 0o600 });

  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--model",
    modelSpec,
    "--tools",
    toolNamesForRoute(routeName).join(","),
    "--append-system-prompt",
    promptPath,
    `Task: ${prompt}`,
  ];

  let latestText = "";
  let stderr = "";
  let nonJsonStdout = "";
  const usage = createUsageStats();
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let wasAborted = false;

  const modelLabel = `${routeConfig.provider}/${routeConfig.model}`;
  notify(ctx, `[${routeName}] → ${modelLabel} (--no-session)`, "info");
  onUpdate?.("", "starting");

  try {
    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: ctx.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buffer = "";
      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          const nextStdout = `${nonJsonStdout}${line}\n`;
          const maxStdoutBytes = 64 * 1024;
          nonJsonStdout =
            nextStdout.length > maxStdoutBytes
              ? `${nextStdout.slice(-maxStdoutBytes)}\n[truncated earlier non-JSON stdout]\n`
              : nextStdout;
          return;
        }

        if (event.type === "turn_start") {
          usage.turns += 1;
          onUpdate?.(latestText, "thinking");
        } else if (event.type === "message_update" || event.type === "message_end") {
          const text = assistantTextFromMessage(event.message);
          if (text) latestText = text;
          if (event.message?.stopReason) stopReason = event.message.stopReason;
          if (event.message?.errorMessage) errorMessage = event.message.errorMessage;
          if (event.type === "message_end") addMessageUsage(usage, event.message);
          onUpdate?.(latestText, "responding");
        } else if (event.type === "tool_execution_start") {
          onUpdate?.(latestText, String(event.toolName ?? "tool"));
        } else if (event.type === "tool_execution_end") {
          onUpdate?.(latestText, `${String(event.toolName ?? "tool")} done`);
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      let settled = false;
      const cleanupAbortListener = () => signal?.removeEventListener("abort", killProc);
      const settle = (code: number) => {
        if (settled) return;
        settled = true;
        cleanupAbortListener();
        resolve(code);
      };
      const killProc = () => {
        if (settled) return;
        wasAborted = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        settle(code ?? 0);
      });
      proc.on("error", (error) => {
        stderr += error instanceof Error ? error.message : String(error);
        settle(1);
      });

      if (signal?.aborted) killProc();
      else signal?.addEventListener("abort", killProc, { once: true });
    });

    notify(ctx, `[${routeName}] ← done`, "info");
    if (wasAborted) throw new Error("Subagent was aborted");
    return { text: latestText || "(no output)", stderr, nonJsonStdout, exitCode, usage, stopReason, errorMessage };
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors so they do not mask the subagent result/error.
    }
  }
}

// --- Extension ---

export default function routingExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "describe_image",
    label: "Describe Image",
    description:
      "Read an image file from disk and describe its contents using the configured eagle model. Use this whenever you encounter an image path you cannot see directly.",
    promptSnippet:
      "Use describe_image whenever the user references an image file path and you cannot see it. Pass the exact path.",
    promptGuidelines: [
      "Call this before acting on any image the user references by path.",
      "The returned description is the full visual context — treat it as ground truth for that image.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Absolute or relative path to the image file." }),
      prompt: Type.Optional(
        Type.String({ description: "Optional question or focus for the description." }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = loadConfig();
      const eagleRoute = config.routes?.eagle;
      if (!eagleRoute) {
        throw new Error(
          "Eagle route is not configured. Use /routing set eagle <provider/model>.",
        );
      }

      const imagePath = params.path.startsWith("/") ? params.path : join(ctx.cwd, params.path);
      if (!existsSync(imagePath)) {
        throw new Error(`Image file not found: ${imagePath}`);
      }

      const ext = imagePath.split(".").pop()?.toLowerCase() ?? "";
      const mimeMap: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        bmp: "image/bmp",
      };
      const mimeType = mimeMap[ext];
      if (!mimeType) throw new Error(`Unsupported image type: .${ext}`);

      const data = (await readFile(imagePath)).toString("base64");
      const describePrompt = params.prompt?.trim()
        ? params.prompt.trim()
        : "Describe everything visible in this image in detail. Include all text, UI elements, layout, data, and any other relevant visual information. A coding agent will act on your description.";

      notify(
        ctx,
        `[eagle] → ${eagleRoute.provider}/${eagleRoute.model} · describing ${params.path}`,
        "info",
      );

      const description = await runSubagent(
        ctx,
        "eagle",
        describePrompt,
        eagleRoute,
        signal,
        (text, status) => {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: text ? `[eagle · ${status}]\n\n${text}` : `[eagle · ${status}]`,
              },
            ],
            details: { status },
          });
        },
        [{ type: "image" as const, data, mimeType }],
      );

      return {
        content: [{ type: "text", text: description }],
        details: { path: imagePath, mimeType },
      };
    },
  });

  pi.registerCommand("routing", {
    description: "Configure task routes: /routing list | /routing set <route> <provider/model>",
    getArgumentCompletions: (prefix) => {
      const [first = ""] = prefix.trimStart().split(/\s+/);
      return ["list", "set"]
        .filter((s) => s.startsWith(first))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const config = loadConfig();
      const [subcommand, routeName, modelSpec] = args.trim().split(/\s+/);

      if (!subcommand || subcommand === "list") {
        const lines = ROUTE_ORDER.map((name) => {
          const route = config.routes?.[name];
          const meta = ROUTE_METADATA[name];
          const configured = route
            ? `${route.provider}/${route.model}`
            : `unconfigured (recommended: ${meta.recommendedModel})`;
          return `  ${name}: ${configured} — ${meta.description}`;
        });
        notify(ctx, `Routes:\n${lines.join("\n")}`, "info");
        return;
      }

      if (subcommand === "set") {
        if (!routeName || !ROUTE_ORDER.includes(routeName as RouteName)) {
          notify(
            ctx,
            `Unknown route "${routeName}". Use one of: ${ROUTE_ORDER.join(", ")}`,
            "error",
          );
          return;
        }
        if (!modelSpec || !modelSpec.includes("/")) {
          notify(ctx, `Usage: /routing set <route> <provider/model>`, "error");
          return;
        }
        const slashIndex = modelSpec.indexOf("/");
        const provider = modelSpec.slice(0, slashIndex);
        const model = modelSpec.slice(slashIndex + 1);
        config.routes ??= {};
        config.routes[routeName as RouteName] = { provider, model };
        persistConfig(ctx, config);
        notify(ctx, `Route "${routeName}" set to ${provider}/${model}`, "info");
        return;
      }

      notify(ctx, `Unknown subcommand "${subcommand}". Use: list, set`, "error");
    },
  });

  pi.registerTool({
    name: "task_delegate",
    label: "Task Delegate",
    description:
      "Delegate a task to a focused subagent using a named route's configured model. Returns the subagent's text output.",
    promptSnippet:
      "Use task_delegate for search, review, oracle, librarian, or eagle work. The subagent runs independently and returns findings — it does not edit files.",
    promptGuidelines: [
      "Use route='eagle' to describe images or screenshots before acting on them. Using describe_image is preferred for image file paths.",
      "Use route='search' or 'librarian' to gather context before making changes.",
      "Use route='review' after making changes to catch issues.",
      "Use route='oracle' for architectural decisions or complex tradeoffs.",
    ],
    parameters: Type.Object({
      route: StringEnum(ROUTE_ORDER),
      prompt: Type.String({ description: "The task to give the subagent." }),
      cwd: Type.Optional(
        Type.String({ description: "Working directory. Defaults to current cwd." }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = loadConfig();
      const routeName = params.route as RouteName;
      const routeConfig = config.routes?.[routeName];

      if (!routeConfig) {
        throw new Error(
          `Route "${routeName}" is not configured. Use /routing set ${routeName} <provider/model>.`,
        );
      }

      const cwd = typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : ctx.cwd;

      const result = await runPiSubagent(
        { ...ctx, cwd },
        routeName,
        params.prompt,
        routeConfig,
        signal,
        (latestText, status) => {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: latestText
                  ? `[${routeName} · ${status}]\n\n${latestText}`
                  : `[${routeName} · ${status}]`,
              },
            ],
            details: { route: routeName, status },
          });
        },
      );

      const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
      if (isError) {
        const errorText = result.errorMessage || result.stderr || result.nonJsonStdout || result.text || "(no output)";
        return {
          content: [{ type: "text", text: `Subagent ${result.stopReason || "failed"}: ${errorText}` }],
          details: {
            route: routeName,
            model: `${routeConfig.provider}/${routeConfig.model}`,
            text: result.text,
            stderr: result.stderr,
            nonJsonStdout: result.nonJsonStdout,
            usage: result.usage,
            exitCode: result.exitCode,
            stopReason: result.stopReason,
            errorMessage: result.errorMessage,
          },
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `[${routeName} via ${routeConfig.provider}/${routeConfig.model}]\n\n${result.text}`,
          },
        ],
        details: {
          route: routeName,
          model: `${routeConfig.provider}/${routeConfig.model}`,
          text: result.text,
          stderr: result.stderr,
          nonJsonStdout: result.nonJsonStdout,
          usage: result.usage,
          exitCode: result.exitCode,
        },
      };
    },
  });
}
