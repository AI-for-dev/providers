// The compat entry point: Pi maps the package root to it as well, and it is the one
// that exports openAICompletionsApi when the tests run under plain Node.
import {
	createProvider,
	envApiKeyAuth,
	type Model,
	openAICompletionsApi,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ChatModel = Model<"openai-completions">;

/**
 * How a model handles reasoning, measured against the real servers:
 * - "toggle": chat_template_kwargs.enable_thinking switches reasoning on and off, nothing finer.
 * - "always": always reasons and ignores every switch.
 * - "none": no reasoning; any reasoning parameter makes the server fail.
 * - Efforts: the chat template also reads a reasoning_effort, given here as the value
 *   to send for each of Pi's low, medium and high levels.
 */
type Thinking = "toggle" | "always" | "none" | Efforts;

interface Efforts {
	low: string;
	medium: string;
	high: string;
}

interface ModelTuning {
	contextWindow?: number;
	maxTokens?: number;
	vision?: boolean;
	thinking?: Thinking;
	// Listed by the server but unusable for the course.
	hidden?: boolean;
}

export interface Endpoint {
	id: string;
	name: string;
	baseUrl: string;
	envVar: string;
	models: Record<string, ModelTuning>;
}

export const ENDPOINTS: Endpoint[] = [
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
			// The chat template accepts low, medium and xhigh (its default).
			"qwen-3.8-27b": { contextWindow: 262_144, vision: true, thinking: { low: "low", medium: "medium", high: "xhigh" } },
			// The deployed chat template accepts low, high (its default) and max, but not medium.
			"ARES/DeepSeek-V4.1-Flash": { contextWindow: 1_048_576, vision: true, thinking: { low: "low", medium: "high", high: "max" } },
			"gemma-4-31b": { contextWindow: 159_488, vision: true, thinking: "toggle" },
		},
	},
];

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 32_768;
const FETCH_TIMEOUT_MS = 10_000;

type Reasoning = Pick<ChatModel, "reasoning" | "thinkingLevelMap"> & { compat: ChatModel["compat"] };

// Pi's levels without a counterpart on the server are mapped to null, which hides them.
function reasoningFor(thinking: Thinking): Reasoning {
	if (thinking === "none") return { reasoning: false, compat: {} };
	if (thinking === "always") {
		return { reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null }, compat: {} };
	}
	if (thinking === "toggle") {
		return {
			reasoning: true,
			thinkingLevelMap: { minimal: null, low: null, medium: null },
			compat: { thinkingFormat: "qwen-chat-template" },
		};
	}
	return {
		reasoning: true,
		thinkingLevelMap: { minimal: null, ...thinking },
		compat: {
			thinkingFormat: "chat-template",
			chatTemplateKwargs: {
				enable_thinking: { $var: "thinking.enabled" },
				preserve_thinking: true,
				reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
			},
		},
	};
}

interface RemoteModel {
	id: string;
	// LiteLLM tags embedding and reranking models with a mode; they cannot chat.
	mode?: string;
	// vLLM reports max_model_len, LiteLLM max_input_tokens and max_output_tokens.
	max_model_len?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
}

export function toModel(endpoint: Endpoint, remote: RemoteModel): ChatModel {
	const tuning = endpoint.models[remote.id] ?? {};
	const reasoning = reasoningFor(tuning.thinking ?? "none");
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
		reasoning: reasoning.reasoning,
		thinkingLevelMap: reasoning.thinkingLevelMap,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: Math.min(maxTokens, contextWindow),
		compat: {
			// These gateways reject the newer OpenAI-only fields.
			supportsDeveloperRole: false,
			supportsStore: false,
			// A top-level reasoning_effort is ignored by vLLM chat templates and crashes the
			// Mistral models; models that read an effort get it through the chat template.
			supportsReasoningEffort: false,
			...reasoning.compat,
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

// <ID>_BASE_URL (ex: IA4DEV_ILAAS_BASE_URL) remplace l'URL par défaut, pour tester ou changer de serveur.
function withBaseUrl(base: Endpoint): Endpoint {
	const urlVar = `${base.id.toUpperCase().replaceAll("-", "_")}_BASE_URL`;
	return { ...base, baseUrl: process.env[urlVar] ?? base.baseUrl };
}

/**
 * The same providers as a pi models.json, for tools that read that file but load no
 * extension, such as trysquare. Built from the table alone: no server is asked, so a
 * given version of this package always writes the same file. The key stays a `$VAR`
 * reference that pi resolves from the environment.
 */
export function modelsJson(endpoints: Endpoint[] = ENDPOINTS) {
	const providers: Record<string, unknown> = {};
	for (const base of endpoints) {
		const endpoint = withBaseUrl(base);
		const models = Object.entries(endpoint.models)
			.filter(([, tuning]) => !tuning.hidden)
			.map(([id, tuning]) => {
				// Without a server to ask, the default would pass for a measured value.
				if (tuning.contextWindow === undefined) {
					throw new Error(`${endpoint.name}: ${id} has no contextWindow in the table`);
				}
				// The provider entry already says these three.
				const { provider, api, baseUrl, ...model } = toModel(endpoint, { id });
				return model;
			});
		providers[endpoint.id] = {
			name: endpoint.name,
			baseUrl: endpoint.baseUrl,
			api: "openai-completions",
			apiKey: `$${endpoint.envVar}`,
			models,
		};
	}
	return { providers };
}

export default function (pi: ExtensionAPI) {
	for (const base of ENDPOINTS) {
		const endpoint = withBaseUrl(base);
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
