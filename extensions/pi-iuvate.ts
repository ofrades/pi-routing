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
import {
  getSupportedThinkingLevels,
  StringEnum,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export type RouteName = "search" | "vision" | "review" | "oracle" | "librarian";

const ROUTE_ORDER: RouteName[] = ["search", "vision", "review", "oracle", "librarian"];

type RouteConfig = {
  provider: string;
  model: string;
  thinkingLevel?: ModelThinkingLevel;
};

type Config = {
  routes?: Partial<Record<RouteName, RouteConfig>>;
};

const DEFAULT_CONFIG: Config = {};

const ROUTE_METADATA: Record<
  RouteName,
  { description: string; recommendedModel: string; systemPrompt: string }
> = {
  search: {
    description: "Fast retrieval-oriented codebase search and context gathering.",
    recommendedModel: "Gemini 3 Flash",
    systemPrompt:
      "You are a search subagent. Use local code search tools to find relevant files, functions, and context. Prefer reading over guessing. Do not edit files. Bash is for read-only commands only. Return concise findings: relevant files and line ranges, key symbols, important excerpts, and the recommended starting point.",
  },
  vision: {
    description: "Image and screenshot understanding.",
    recommendedModel: "Gemini 3 Flash",
    systemPrompt:
      "You are a vision subagent. Describe images, screenshots, and visual content precisely and completely. Include all text, UI elements, layout, colors, and any information visible. Be thorough — the main agent will rely entirely on your description.",
  },
  review: {
    description: "Code review, bug finding, regression/security/maintainability checks.",
    recommendedModel: "Gemini 3.1 Pro",
    systemPrompt:
      "You are a review subagent. Check for correctness, regressions, security issues, unnecessary complexity, and missing tests. Be specific: include file paths, line numbers, and concrete suggestions. Do not edit files. Bash is for read-only commands only.",
  },
  oracle: {
    description: "Complex reasoning, planning, tradeoffs, and strategic advice when stuck.",
    recommendedModel: "Claude Opus / GPT-5",
    systemPrompt:
      "You are an oracle subagent. Challenge assumptions, identify risks and tradeoffs, and recommend a clear path. Think carefully before answering. Do not edit files. Return: recommendation, tradeoffs, risks, next steps.",
  },
  librarian: {
    description: "External docs, dependencies, APIs, and unfamiliar library research.",
    recommendedModel: "Claude Sonnet 4.6",
    systemPrompt:
      "You are a librarian subagent. Research external documentation, APIs, libraries, and public source code. Cite URLs and source names. Return actionable findings. Do not edit files. Bash is for read-only commands only.",
  },
};

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

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
  const raw = settings.iuvate ?? settings.luvate ?? settings["help-me"] ?? settings.routing;
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
  const r = raw as Record<string, unknown>;
  return {
    routes: (r.routes as Config["routes"]) ?? undefined,
  };
}

function persistConfig(ctx: ExtensionContext, config: Config): void {
  try {
    const settings = readSettings();
    settings.iuvate = config;
    delete settings.luvate;
    delete settings["help-me"];
    delete settings.routing;
    writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (err) {
    notify(
      ctx,
      `Could not save config: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  }
}

// ---------------------------------------------------------------------------
// Subagent utilities
// ---------------------------------------------------------------------------

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
    return order.find((l) => new Set(levels).has(l)) ?? "off";
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
  return routeName === "search" || routeName === "librarian" || routeName === "review"
    ? [...readOnly, createBashTool(cwd)]
    : readOnly;
}

function toolNamesForRoute(routeName: RouteName): string[] {
  const readOnly = ["read", "grep", "find", "ls"];
  return routeName === "search" || routeName === "librarian" || routeName === "review"
    ? [...readOnly, "bash"]
    : readOnly;
}

function extractLastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: unknown; content?: unknown };
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j] as { type?: unknown; text?: unknown };
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        return block.text.trim();
      }
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Vision subagent — in-process (needs image bytes)
// ---------------------------------------------------------------------------

type ImageInput = { type: "image"; data: string; mimeType: string };

async function runVisionSubagent(
  ctx: ExtensionContext,
  prompt: string,
  routeConfig: RouteConfig,
  images: ImageInput[],
  signal?: AbortSignal,
  onUpdate?: (text: string, status: string) => void,
): Promise<string> {
  const model = ctx.modelRegistry.find(routeConfig.provider, routeConfig.model);
  if (!model) throw new Error(`Model not found: ${routeConfig.provider}/${routeConfig.model}`);

  const thinkingLevel = routeConfig.thinkingLevel ?? highestThinkingLevel(model);
  const agent = new Agent({
    initialState: {
      model,
      thinkingLevel,
      systemPrompt: ROUTE_METADATA.vision.systemPrompt,
      tools: toolsForRoute("vision", ctx.cwd),
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
    if (ctx.hasUI) ctx.ui.setStatus("pi-iuvate-vision", `[vision] ${modelLabel} · ${status}`);
    onUpdate?.(latestText, status);
  };

  const unsub = agent.subscribe((event) => {
    if (event.type === "turn_start") emit("thinking", true);
    else if (event.type === "message_update") {
      const text = extractLastAssistantText([event.message]);
      if (text) latestText = text;
      emit("responding");
    } else if (event.type === "tool_execution_start") emit(event.toolName, true);
    else if (event.type === "tool_execution_end") emit(`${event.toolName} done`, true);
  });

  const onAbort = () => agent.abort();
  if (signal) {
    if (signal.aborted) agent.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    notify(ctx, `[vision] → ${modelLabel} (thinking:${thinkingLevel})`, "info");
    emit("starting", true);
    await agent.prompt(prompt, images);
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    unsub();
    if (ctx.hasUI) ctx.ui.setStatus("pi-iuvate-vision", undefined);
    notify(ctx, `[vision] ← done`, "info");
  }

  return extractLastAssistantText(agent.state.messages) || "(no output)";
}

// ---------------------------------------------------------------------------
// Subprocess subagent — all non-vision routes
// ---------------------------------------------------------------------------

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

function modelSpecForRoute(ctx: ExtensionContext, routeConfig: RouteConfig): string {
  const base = `${routeConfig.provider}/${routeConfig.model}`;
  if (routeConfig.thinkingLevel) return `${base}:${routeConfig.thinkingLevel}`;
  const model = ctx.modelRegistry.find(routeConfig.provider, routeConfig.model);
  return model ? `${base}:${highestThinkingLevel(model)}` : base;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(execName)
    ? { command: "pi", args }
    : { command: process.execPath, args };
}

function assistantTextFromMessage(message: unknown): string {
  const msg = message as { role?: unknown; content?: unknown };
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return "";
  return (msg.content as any[])
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
    .trim();
}

async function runSubprocess(
  ctx: ExtensionContext,
  routeName: RouteName,
  prompt: string,
  routeConfig: RouteConfig,
  signal?: AbortSignal,
  onUpdate?: (text: string, status: string) => void,
): Promise<SubprocessResult> {
  const modelSpec = modelSpecForRoute(ctx, routeConfig);
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-iuvate-"));
  const promptPath = join(tmpDir, `${routeName}.md`);
  writeFileSync(promptPath, ROUTE_METADATA[routeName].systemPrompt, {
    encoding: "utf8",
    mode: 0o600,
  });

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
  const usage: UsageStats = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let wasAborted = false;

  notify(ctx, `[${routeName}] → ${routeConfig.provider}/${routeConfig.model}`, "info");
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
          const next = `${nonJsonStdout}${line}\n`;
          nonJsonStdout =
            next.length > 64 * 1024 ? `${next.slice(-64 * 1024)}\n[truncated]\n` : next;
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
          if (event.type === "message_end") {
            const u = event.message?.usage;
            if (u && typeof u === "object") {
              usage.input += u.input ?? 0;
              usage.output += u.output ?? 0;
              usage.cacheRead += u.cacheRead ?? 0;
              usage.cacheWrite += u.cacheWrite ?? 0;
              usage.contextTokens = u.totalTokens ?? usage.contextTokens;
              usage.cost += typeof u.cost === "number" ? u.cost : (u.cost?.total ?? 0);
            }
          }
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
      const settle = (code: number) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", killProc);
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
      proc.on("error", (err) => {
        stderr += err instanceof Error ? err.message : String(err);
        settle(1);
      });

      if (signal?.aborted) killProc();
      else signal?.addEventListener("abort", killProc, { once: true });
    });

    notify(ctx, `[${routeName}] ← done`, "info");
    if (wasAborted) throw new Error("Subagent aborted");
    return {
      text: latestText || "(no output)",
      stderr,
      nonJsonStdout,
      exitCode,
      usage,
      stopReason,
      errorMessage,
    };
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function iuvateExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, _ctx) => ({
    systemPrompt:
      event.systemPrompt +
      "\n\n## iuvate\n" +
      "Use `iuvate` when you lack a capability, want a second opinion, or are stuck:\n" +
      "- route='search' — find code/context you cannot locate\n" +
      "- route='vision' — describe an image or screenshot you cannot see\n" +
      "- route='review' — catch bugs after making changes\n" +
      "- route='oracle' — strategy, planning, tradeoffs, or when stuck in a loop\n" +
      "- route='librarian' — external docs, APIs, unfamiliar libraries",
  }));

  pi.registerTool({
    name: "iuvate",
    label: "Iuvate",
    description:
      "Delegate to a focused subagent when you lack a capability or are stuck. Routes: search, vision, review, oracle, librarian. The subagent is read-only and returns findings.",
    promptSnippet: "Use iuvate when you need a capability you lack or strategic advice when stuck.",
    promptGuidelines: [
      "Use route='vision' for any image or screenshot you cannot see.",
      "Use route='search' or 'librarian' to gather context before making changes.",
      "Use route='review' after making changes.",
      "Use route='oracle' for architectural decisions or when stuck in a loop.",
    ],
    parameters: Type.Object({
      route: StringEnum(ROUTE_ORDER),
      prompt: Type.String({ description: "The task or question for the subagent." }),
      image_path: Type.Optional(
        Type.String({
          description: "Image file path. Required for route='vision' when working from a file.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = loadConfig();
      const routeName = params.route as RouteName;
      const routeConfig = config.routes?.[routeName];
      if (!routeConfig) {
        throw new Error(
          `Route "${routeName}" not configured. Use /iuvate set ${routeName} <provider/model>.`,
        );
      }

      if (routeName === "vision") {
        let images: ImageInput[] = [];
        if (params.image_path) {
          const imagePath = params.image_path.startsWith("/")
            ? params.image_path
            : join(ctx.cwd, params.image_path);
          if (!existsSync(imagePath)) throw new Error(`Image not found: ${imagePath}`);
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
          images = [
            { type: "image", data: (await readFile(imagePath)).toString("base64"), mimeType },
          ];
        }
        const description = await runVisionSubagent(
          ctx,
          params.prompt,
          routeConfig,
          images,
          signal,
          (text, status) =>
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: text ? `[vision · ${status}]\n\n${text}` : `[vision · ${status}]`,
                },
              ],
              details: { status },
            }),
        );
        return {
          content: [{ type: "text" as const, text: description }],
          details: {
            route: routeName,
            model: `${routeConfig.provider}/${routeConfig.model}`,
          },
        };
      }

      const result = await runSubprocess(
        ctx,
        routeName,
        params.prompt,
        routeConfig,
        signal,
        (latestText, status) =>
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
          }),
      );

      const isError =
        result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
      if (isError) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Subagent ${result.stopReason || "failed"}: ${result.errorMessage || result.stderr || result.text || "(no output)"}`,
            },
          ],
          details: {
            route: routeName,
            model: `${routeConfig.provider}/${routeConfig.model}`,
            ...result,
          },
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `[${routeName} via ${routeConfig.provider}/${routeConfig.model}]\n\n${result.text}`,
          },
        ],
        details: {
          route: routeName,
          model: `${routeConfig.provider}/${routeConfig.model}`,
          usage: result.usage,
        },
      };
    },
  });

  pi.registerCommand("iuvate", {
    description: "Configure routes: /iuvate list | set <route> <provider/model>",
    getArgumentCompletions: (prefix) => {
      const [first = ""] = prefix.trimStart().split(/\s+/);
      return ["list", "set"]
        .filter((s) => s.startsWith(first))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const config = loadConfig();
      const [subcommand, routeName, modelSpec] = (args ?? "").trim().split(/\s+/);

      if (!subcommand || subcommand === "list") {
        const lines = ROUTE_ORDER.map((name) => {
          const route = config.routes?.[name];
          const meta = ROUTE_METADATA[name];
          const configured = route
            ? `${route.provider}/${route.model}${route.thinkingLevel ? ` (${route.thinkingLevel})` : ""}`
            : `unconfigured (recommended: ${meta.recommendedModel})`;
          return `  ${name}: ${configured} — ${meta.description}`;
        });
        notify(ctx, `Routes:\n${lines.join("\n")}`, "info");
        return;
      }

      if (subcommand === "set") {
        if (!routeName || !ROUTE_ORDER.includes(routeName as RouteName)) {
          notify(ctx, `Unknown route "${routeName}". Options: ${ROUTE_ORDER.join(", ")}`, "error");
          return;
        }
        if (!modelSpec?.includes("/")) {
          notify(ctx, `Usage: /iuvate set <route> <provider/model>`, "error");
          return;
        }
        const slash = modelSpec.indexOf("/");
        config.routes ??= {};
        config.routes[routeName as RouteName] = {
          provider: modelSpec.slice(0, slash),
          model: modelSpec.slice(slash + 1),
        };
        persistConfig(ctx, config);
        notify(ctx, `Route "${routeName}" → ${modelSpec}`, "info");
        return;
      }

      notify(ctx, `Unknown subcommand "${subcommand}". Use: list or set`, "error");
    },
  });
}
