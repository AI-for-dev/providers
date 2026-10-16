import {
	createProvider,
	envApiKeyAuth,
	type Model,
	openAICompletionsApi,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ChatModel = Model<"openai-completions">;

/**
 * How a model handles reasoning, measured against the real servers:
 * - "toggle": off by default, switched on with chat_template_kwargs.enable_thinking (vLLM).
 * - "always": always reasons and ignores every switch.
 * - "none": no reasoning; any reasoning parameter makes the server fail.
 */
type Thinking = "toggle" | "always" | "none";

interface ModelTuning {
	contextWindow?: number;
	maxTokens?: number;
	vision?: boolean;
	thinking?: Thinking;
	// Listed by the server but unusable for the course.
	hidden?: boolean;
}

interface Endpoint {
	id: string;
	name: string;
	baseUrl: string;
	envVar: string;
	models: Record<string, ModelTuning>;
}

const ENDPOINTS: Endpoint[] = [
	{
		id: "ia4dev-ilaas",
		name: "ILAAS",
		baseUrl: "https://devllm.ilaas.fr/v1",
		envVar: "ILAAS_API_KEY",
		models: {
			"scaleway/glm-5.2": { contextWindow: 256_000, maxTokens: 16_384, vision: false, thinking: "always" },
			"scaleway/glm-5.3": { contextWindow: 256_000, maxTokens: 16_384, vision: false, thinking: "always" },
			"scaleway/deepseek-v4.1-flash": { contextWindow: 256_000, maxTokens: 32_768, vision: true, thinking: "always" },
			"scaleway/deepseek-v4-flash-0731": { contextWindow: 256_000, maxTokens: 32_768, vision: false, thinking: "always" },
			"qwen-3.6-35b-instruct": { contextWindow: 262_144, vision: true, thinking: "toggle" },
			"gemma-4-31b": { contextWindow: 131_072, vision: true, thinking: "toggle" },
			"llama-3.1-8b": { hidden: true },
			"gpt-oss-120b": { hidden: true },
			"mistral-small-4-119b": { contextWindow: 128_000, vision: true, thinking: "none" },
			"mistral-medium-latest": { contextWindow: 128_000, vision: true, thinking: "none" },
		},
	},
	{
		id: "ia4dev-gricad",
		name: "IA4Dev",
		baseUrl: "https://ia4dev-owui.univ-grenoble-alpes.fr/api",
		envVar: "IA4DEV_API_KEY",
		models: {
			"qwen-3.8-27b": { vision: true, thinking: "toggle" },
			"ARES/DeepSeek-V4.1-Flash": { vision: true, thinking: "toggle" },
			"gemma-4-31b": { vision: true, thinking: "toggle" },
		},
	},
];

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 32_768;
const FETCH_TIMEOUT_MS = 10_000;

// Effort levels mean nothing to these servers: reasoning is either on or off.
const THINKING_LEVELS: Record<Exclude<Thinking, "none">, ChatModel["thinkingLevelMap"]> = {
	toggle: { minimal: null, low: null, medium: null },
	always: { off: null, minimal: null, low: null, medium: null },
};

interface RemoteModel {
	id: string;
	// LiteLLM tags embedding and reranking models with a mode; they cannot chat.
	mode?: string;
	// vLLM reports max_model_len, LiteLLM max_input_tokens and max_output_tokens.
	max_model_len?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
}

function toModel(endpoint: Endpoint, remote: RemoteModel): ChatModel {
	const tuning = endpoint.models[remote.id] ?? {};
	const thinking = tuning.thinking ?? "none";
	const contextWindow =
		tuning.contextWindow ?? remote.max_model_len ?? remote.max_input_tokens ?? DEFAULT_CONTEXT_WINDOW;
	const maxTokens = tuning.maxTokens ?? remote.max_output_tokens ?? DEFAULT_MAX_TOKENS;
	return {
		id: remote.id,
		name: remote.id,
		api: "openai-completions",
		provider: endpoint.id,
		baseUrl: endpoint.baseUrl,
		input: tuning.vision ? ["text", "image"] : ["text"],
		reasoning: thinking !== "none",
		thinkingLevelMap: thinking === "none" ? undefined : THINKING_LEVELS[thinking],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: Math.min(maxTokens, contextWindow),
		compat: {
			// These gateways reject the newer OpenAI-only fields.
			supportsDeveloperRole: false,
			supportsStore: false,
			// reasoning_effort is ignored by vLLM chat templates and crashes the Mistral models.
			supportsReasoningEffort: false,
			...(thinking === "toggle" ? { thinkingFormat: "qwen-chat-template" as const } : {}),
		},
	};
}

async function fetchModels(endpoint: Endpoint, context: RefreshModelsContext): Promise<ChatModel[]> {
	const key = context.credential?.type === "api_key" ? context.credential.key : process.env[endpoint.envVar];
	if (!context.allowNetwork || !key) return [];

	const response = await fetch(`${endpoint.baseUrl}/models`, {
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.any([context.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
	});
	if (!response.ok) {
		throw new Error(`${endpoint.name}: GET /models a répondu ${response.status}`);
	}
	const body = (await response.json()) as { data?: RemoteModel[] };
	return (body.data ?? [])
		.filter((m) => typeof m.id === "string" && (m.mode === undefined || m.mode === "chat"))
		.filter((m) => !endpoint.models[m.id]?.hidden)
		.map((m) => toModel(endpoint, m));
}

export default function (pi: ExtensionAPI) {
	for (const base of ENDPOINTS) {
		// <ID>_BASE_URL (ex: IA4DEV_ILAAS_BASE_URL) remplace l'URL par défaut, pour tester ou changer de serveur.
		const urlVar = `${base.id.toUpperCase().replaceAll("-", "_")}_BASE_URL`;
		const endpoint = { ...base, baseUrl: process.env[urlVar] ?? base.baseUrl };
		pi.registerProvider(
			createProvider<"openai-completions">({
				id: endpoint.id,
				name: endpoint.name,
				baseUrl: endpoint.baseUrl,
				auth: { apiKey: envApiKeyAuth(`${endpoint.name} API key`, [endpoint.envVar]) },
				models: [],
				fetchModels: (context) => fetchModels(endpoint, context),
				api: openAICompletionsApi(),
			}),
		);
	}
}
