import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const BASE_URL = "http://kronk:9100/v1";
const ROOT_URL = "http://kronk:9100";
const PROVIDER = "llama-swap";
const LOAD_TIMEOUT_MS = 15 * 60 * 1_000;

type PiThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

type ThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null>>;

interface LlamaSwapModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  capabilities?: {
    function_calling?: boolean;
    vision?: boolean;
  };
  meta?: {
    llamaswap?: {
      type?: "model" | "alias";
      reasoning?: boolean;
      vision?: boolean;
      maxTokens?: number;
      max_tokens?: number;
      max_completion_tokens?: number;
      max_output_tokens?: number;
      reasoning_control?: string;
      reasoning_param?: string;
      reasoning_options?: Array<{
        type?: string;
        values?: string[];
      }>;
      reasoning_prompt_template?: string;
      recommended_reasoning_level?: string;
      thinking_level_map?: ThinkingLevelMap;
      thinking_levels?: string[];
    };
  };
}

interface ModelsResponse {
  data?: LlamaSwapModel[];
}

interface RunningModel {
  model: string;
  state: string;
  name?: string;
}

interface RunningResponse {
  running?: RunningModel[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelPath(modelId: string): string {
  return encodeURIComponent(modelId);
}

async function checkedFetch(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.text()).trim();
    throw new Error(
      `HTTP ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`,
    );
  }
  return response;
}

async function loadModel(modelId: string, signal?: AbortSignal): Promise<void> {
  const timeoutSignal = AbortSignal.timeout(LOAD_TIMEOUT_MS);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  await checkedFetch(
    `${ROOT_URL}/upstream/${modelPath(modelId)}/health`,
    { signal: requestSignal },
  );
}

async function runningModels(): Promise<RunningModel[]> {
  const response = await checkedFetch(`${ROOT_URL}/running`, {
    signal: AbortSignal.timeout(5_000),
  });
  const payload = (await response.json()) as RunningResponse;
  return payload.running ?? [];
}

async function unloadModel(modelId?: string): Promise<void> {
  const suffix = modelId ? `/${modelPath(modelId)}` : "";
  await checkedFetch(`${ROOT_URL}/api/models/unload${suffix}`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
}

function inferredContextWindow(model: LlamaSwapModel): number {
  if (model.context_length && model.context_length > 0) {
    return model.context_length;
  }

  const text = `${model.name ?? ""} ${model.description ?? ""}`;
  const match = text.match(/(?:~|\b)(\d+)k\b/i);
  return match ? Number(match[1]) * 1024 : 128_000;
}

function inputModalities(model: LlamaSwapModel): readonly ("text" | "image")[] {
  const reported = model.architecture?.input_modalities ?? [];
  const supportsImage =
    reported.includes("image") ||
    model.capabilities?.vision === true ||
    model.meta?.llamaswap?.vision === true;

  return supportsImage ? ["text", "image"] : ["text"];
}

function maxOutputTokens(model: LlamaSwapModel): number {
  return (
    model.meta?.llamaswap?.maxTokens ??
    model.meta?.llamaswap?.max_tokens ??
    model.meta?.llamaswap?.max_completion_tokens ??
    model.meta?.llamaswap?.max_output_tokens ??
    16_384
  );
}

function thinkingLevelMap(model: LlamaSwapModel): ThinkingLevelMap | undefined {
  const advertised = model.meta?.llamaswap?.thinking_level_map;
  if (advertised) return advertised;

  const levels = model.meta?.llamaswap?.thinking_levels;
  if (!levels || levels.length === 0) return undefined;

  const supported = new Set(levels);
  if (supported.has("off") && supported.has("on")) {
    return {
      off: "off",
      minimal: null,
      low: null,
      medium: null,
      high: "on",
      xhigh: null,
      max: null,
    };
  }

  const result: ThinkingLevelMap = {};
  for (const level of [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ] as const) {
    result[level] = supported.has(level) ? level : null;
  }
  return result;
}

function reasoningCompat(model: LlamaSwapModel) {
  const metadata = model.meta?.llamaswap;
  const effortControl = metadata?.reasoning_options?.some(
    (option) => option.type === "effort",
  );
  const toggleControl = metadata?.reasoning_options?.some(
    (option) => option.type === "toggle",
  );

  // Effort-controlled llama.cpp templates consume a per-request Jinja variable.
  if (effortControl) {
    return {
      supportsReasoningEffort: false,
      thinkingFormat: "chat-template" as const,
      chatTemplateKwargs: {
        [metadata?.reasoning_param ?? "reasoning_strength"]: {
          $var: "thinking.effort" as const,
        },
      },
    };
  }

  // Toggle-controlled templates need a boolean rather than Pi's level name.
  if (
    toggleControl &&
    metadata?.reasoning_control === "chat_template_kwargs" &&
    (metadata.reasoning_param ?? "enable_thinking") === "enable_thinking"
  ) {
    return {
      supportsReasoningEffort: false,
      // Supported natively by both Pi and OMP. Both encode the toggle as
      // chat_template_kwargs.enable_thinking.
      thinkingFormat: "qwen-chat-template" as const,
    };
  }

  return undefined;
}

function ompThinking(model: LlamaSwapModel) {
  const metadata = model.meta?.llamaswap;
  const effortOption = metadata?.reasoning_options?.find(
    (option) => option.type === "effort",
  );
  const efforts = (effortOption?.values ?? []).filter(
    (level): level is Exclude<PiThinkingLevel, "off"> =>
      level !== "off" &&
      ["minimal", "low", "medium", "high", "xhigh", "max"].includes(level),
  );

  if (efforts.length > 0) {
    const recommended = metadata?.recommended_reasoning_level;
    return {
      mode: "effort" as const,
      efforts,
      ...(recommended && efforts.includes(recommended as typeof efforts[number])
        ? { defaultLevel: recommended }
        : {}),
    };
  }

  const toggleControl = metadata?.reasoning_options?.some(
    (option) => option.type === "toggle",
  );
  // OMP models binary thinking as a one-rung effort ladder. `off` remains a
  // separate session state, while `high` means enabled.
  return toggleControl
    ? { mode: "effort" as const, efforts: ["high" as const] }
    : undefined;
}

export default async function (pi: ExtensionAPI) {
  try {
    const response = await fetch(`${BASE_URL}/models`, {
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as ModelsResponse;
    const models = (payload.data ?? []).filter(
      (model) => model.meta?.llamaswap?.type !== "alias",
    );

    if (models.length === 0) {
      throw new Error("the server returned no canonical models");
    }

    pi.registerProvider(PROVIDER, {
      baseUrl: BASE_URL,
      api: "openai-completions",
      apiKey: "llama-swap",
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
      models: models.map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        reasoning: model.meta?.llamaswap?.reasoning === true,
        thinkingLevelMap: thinkingLevelMap(model),
        // OMP's canonical reasoning-capability shape. Pi safely ignores it.
        thinking: ompThinking(model),
        compat: reasoningCompat(model),
        input: inputModalities(model),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: inferredContextWindow(model),
        maxTokens: maxOutputTokens(model),
      })),
    });

    const modelIds = models.map((model) => model.id);
    const modelIdSet = new Set(modelIds);
    const completions = (prefix: string) => {
      const normalized = prefix.trim().replace(/^llama-swap\//, "");
      const matches = modelIds
        .filter((id) => id.startsWith(normalized))
        .map((id) => ({ value: id, label: id }));
      return matches.length > 0 ? matches : null;
    };

    const resolveModelId = (
      value: string,
      current?: { provider: string; id: string },
    ) => {
      const requested = value.trim().replace(/^llama-swap\//, "");
      if (requested) return requested;
      return current?.provider === PROVIDER ? current.id : undefined;
    };

    let activePreload: AbortController | undefined;

    const discoveredById = new Map(models.map((model) => [model.id, model]));

    // Pi understands generic chat-template kwargs directly. OMP currently
    // doesn't, so also enforce effort-controlled llama.cpp variables at the
    // shared request-payload hook. On Pi this is an idempotent overwrite.
    pi.on("before_provider_request", (event, ctx) => {
      if (ctx.model?.provider !== PROVIDER) return;
      const model = discoveredById.get(ctx.model.id);
      const metadata = model?.meta?.llamaswap;
      const effortControl = metadata?.reasoning_options?.some(
        (option) => option.type === "effort",
      );
      if (!effortControl || !event.payload || typeof event.payload !== "object") {
        return;
      }

      const level = pi.getThinkingLevel();
      if (!level || level === "off") return;
      const supported = metadata?.reasoning_options
        ?.find((option) => option.type === "effort")
        ?.values;
      if (supported && !supported.includes(level)) return;

      const payload = event.payload as Record<string, unknown>;
      const existing =
        payload.chat_template_kwargs &&
        typeof payload.chat_template_kwargs === "object"
          ? (payload.chat_template_kwargs as Record<string, unknown>)
          : {};
      return {
        ...payload,
        chat_template_kwargs: {
          ...existing,
          [metadata?.reasoning_param ?? "reasoning_strength"]: level,
        },
      };
    });

    const preload = async (
      modelId: string,
      ctx: Pick<ExtensionContext, "ui">,
      controller?: AbortController,
    ) => {
      ctx.ui.setStatus("llama-swap", `loading ${modelId}…`);
      ctx.ui.notify(`llama-swap: loading ${modelId}…`, "info");
      try {
        await loadModel(modelId, controller?.signal);
        ctx.ui.notify(`llama-swap: ${modelId} is ready`, "info");
      } catch (error) {
        if (controller?.signal.aborted) return;
        ctx.ui.notify(
          `llama-swap: failed to load ${modelId}: ${errorMessage(error)}`,
          "error",
        );
      } finally {
        if (!controller || activePreload === controller) {
          ctx.ui.setStatus("llama-swap", undefined);
        }
      }
    };

    pi.on("model_select", (event, ctx) => {
      if (
        event.source !== "set" ||
        (event.model.provider === event.previousModel?.provider &&
          event.model.id === event.previousModel.id)
      ) {
        return;
      }

      activePreload?.abort();
      activePreload = undefined;
      if (event.model.provider !== PROVIDER) return;

      const controller = new AbortController();
      activePreload = controller;
      void preload(event.model.id, ctx, controller);
    });

    pi.registerCommand("swap", {
      description: "Load and warm a llama-swap model (defaults to the active model)",
      getArgumentCompletions: completions,
      handler: async (args, ctx) => {
        const modelId = resolveModelId(args, ctx.model);
        if (!modelId) {
          ctx.ui.notify("Usage: /swap <model>", "warning");
          return;
        }
        if (!modelIdSet.has(modelId)) {
          ctx.ui.notify(`Unknown llama-swap model: ${modelId}`, "error");
          return;
        }
        activePreload?.abort();
        activePreload = undefined;
        await preload(modelId, ctx);
      },
    });

    pi.registerCommand("swap-status", {
      description: "Show models currently managed by llama-swap",
      handler: async (_args, ctx) => {
        try {
          const running = await runningModels();
          const message = running.length
            ? running.map((item) => `${item.model}: ${item.state}`).join("\n")
            : "llama-swap: no models are running";
          ctx.ui.notify(message, "info");
        } catch (error) {
          ctx.ui.notify(
            `llama-swap status failed: ${errorMessage(error)}`,
            "error",
          );
        }
      },
    });

    pi.registerCommand("swap-unload", {
      description: "Unload a llama-swap model, or use 'all' to unload everything",
      getArgumentCompletions: (prefix) => {
        const values = ["all", ...modelIds];
        const matches = values
          .filter((value) => value.startsWith(prefix.trim()))
          .map((value) => ({ value, label: value }));
        return matches.length > 0 ? matches : null;
      },
      handler: async (args, ctx) => {
        const requested = args.trim().replace(/^llama-swap\//, "");
        const modelId = requested || resolveModelId("", ctx.model);
        if (!modelId) {
          ctx.ui.notify("Usage: /swap-unload <model|all>", "warning");
          return;
        }
        if (modelId !== "all" && !modelIdSet.has(modelId)) {
          ctx.ui.notify(`Unknown llama-swap model: ${modelId}`, "error");
          return;
        }
        if (
          modelId === "all" &&
          !(await ctx.ui.confirm(
            "Unload llama-swap models?",
            "Stop every model currently managed by llama-swap?",
          ))
        ) {
          return;
        }

        try {
          activePreload?.abort();
          activePreload = undefined;
          await unloadModel(modelId === "all" ? undefined : modelId);
          ctx.ui.notify(
            modelId === "all"
              ? "llama-swap: all models unloaded"
              : `llama-swap: ${modelId} unloaded`,
            "info",
          );
        } catch (error) {
          ctx.ui.notify(
            `llama-swap unload failed: ${errorMessage(error)}`,
            "error",
          );
        }
      },
    });
  } catch (error) {
    console.warn(
      `[llama-swap] Model discovery failed at ${BASE_URL}: ${errorMessage(error)}`,
    );
  }
}
