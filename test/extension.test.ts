import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	type Credential,
	getSupportedThinkingLevels,
	hasApi,
	normalizeContext,
	type Provider,
	type ThinkingLevel,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.ts";

interface Request {
	url: string;
	authorization: string | null;
}

let requests: Request[] = [];
// Bodies of the chat requests, as the model server receives them.
let sent: Record<string, unknown>[] = [];
let catalog: unknown = { data: [] };
let status = 200;
const realFetch = globalThis.fetch;

beforeEach(() => {
	requests = [];
	sent = [];
	catalog = { data: [] };
	status = 200;
	globalThis.fetch = async (input, init) => {
		if (String(input).endsWith("/chat/completions")) {
			sent.push(JSON.parse(String(init?.body)));
			const reply = 'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
			return new Response(reply, { headers: { "content-type": "text/event-stream" } });
		}
		requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
		return new Response(JSON.stringify(catalog), { status });
	};
});

afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env.ILAAS_API_KEY;
	delete process.env.IA4DEV_API_KEY;
	delete process.env.IA4DEV_ILAAS_BASE_URL;
});

function load(): Map<string, Provider> {
	const providers = new Map<string, Provider>();
	const pi = { registerProvider: (provider: Provider) => providers.set(provider.id, provider) };
	extension(pi as unknown as ExtensionAPI);
	return providers;
}

function provider(id: string): Provider {
	const found = load().get(id);
	assert.ok(found, `provider ${id} is registered`);
	return found;
}

async function refresh(target: Provider, options: { credential?: Credential; allowNetwork?: boolean } = {}) {
	assert.ok(target.refreshModels, "provider discovers its models");
	await target.refreshModels({
		credential: options.credential,
		allowNetwork: options.allowNetwork ?? true,
		signal: new AbortController().signal,
		publish: async ({ update }) => {
			update?.();
			return true;
		},
	});
	return target.getModels();
}

function model(models: ReturnType<Provider["getModels"]>, id: string) {
	const found = models.find((m) => m.id === id);
	assert.ok(found, `model ${id} is listed`);
	assert.ok(hasApi(found, "openai-completions"), `model ${id} speaks the OpenAI Chat Completions API`);
	return found;
}

const key: Credential = { type: "api_key", key: "sk-test" };

/** Sends one prompt at the given thinking level and returns the reasoning fields of the request. */
async function reasoningSent(providerId: string, modelId: string, level: ThinkingLevel | "off") {
	catalog = { data: [{ id: modelId }] };
	const target = provider(providerId);
	const chat = model(await refresh(target, { credential: key }), modelId);
	const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
	const stream = target.streamSimple(chat, context, { apiKey: "sk-test", reasoning: level === "off" ? undefined : level });
	for await (const event of stream) {
		if (event.type === "error") assert.fail(event.error.errorMessage);
	}
	const body = sent.at(-1);
	assert.ok(body, "a chat request was sent");
	return { chat_template_kwargs: body.chat_template_kwargs, reasoning_effort: body.reasoning_effort };
}

describe("registration", () => {
	it("registers the ILAAS and IA4Dev providers on their servers", () => {
		const providers = load();
		assert.deepEqual(
			[...providers.values()].map((p) => [p.id, p.baseUrl]),
			[
				["ia4dev-ilaas", "https://devllm.ilaas.fr/v1"],
				["ia4dev-gricad", "https://ia4dev-owui.univ-grenoble-alpes.fr/api"],
			],
		);
	});

	it("takes the base URL from <ID>_BASE_URL, with dashes turned into underscores", () => {
		process.env.IA4DEV_ILAAS_BASE_URL = "http://localhost:1234/v1";
		assert.equal(provider("ia4dev-ilaas").baseUrl, "http://localhost:1234/v1");
	});
});

describe("authentication", () => {
	it("offers an API key login named after the server", () => {
		const auth = provider("ia4dev-ilaas").auth.apiKey;
		assert.equal(auth?.name, "ILAAS API key");
		assert.ok(auth?.login, "/login can prompt for the key");
	});

	it("falls back to the server's environment variable", async () => {
		const auth = provider("ia4dev-gricad").auth.apiKey;
		const result = await auth?.resolve({
			ctx: { env: async (name) => (name === "IA4DEV_API_KEY" ? "sk-env" : undefined), fileExists: async () => false },
			signal: new AbortController().signal,
		});
		assert.equal(result?.auth.apiKey, "sk-env");
	});
});

describe("model discovery", () => {
	it("asks the server's /models endpoint with the stored key", async () => {
		await refresh(provider("ia4dev-ilaas"), { credential: key });
		assert.deepEqual(requests, [{ url: "https://devllm.ilaas.fr/v1/models", authorization: "Bearer sk-test" }]);
	});

	it("uses the environment variable when nothing is stored", async () => {
		process.env.ILAAS_API_KEY = "sk-env";
		await refresh(provider("ia4dev-ilaas"));
		assert.equal(requests[0]?.authorization, "Bearer sk-env");
	});

	it("stays offline without a key or without network access", async () => {
		assert.deepEqual(await refresh(provider("ia4dev-ilaas")), []);
		assert.deepEqual(await refresh(provider("ia4dev-ilaas"), { credential: key, allowNetwork: false }), []);
		assert.equal(requests.length, 0);
	});

	it("keeps chat models only and drops the hidden ones", async () => {
		catalog = {
			data: [
				{ id: "gemma-4-31b", mode: "chat" },
				{ id: "scaleway/glm-5.3" },
				{ id: "bge-m3", mode: "embedding" },
				{ id: "bge-reranker-v2-m3", mode: "rerank" },
				{ id: "llama-3.1-8b", mode: "chat" },
				{ id: "gpt-oss-120b" },
			],
		};
		const models = await refresh(provider("ia4dev-ilaas"), { credential: key });
		assert.deepEqual(
			models.map((m) => m.id),
			["gemma-4-31b", "scaleway/glm-5.3"],
		);
	});

	it("reports a server error instead of listing nothing", async () => {
		status = 401;
		await assert.rejects(refresh(provider("ia4dev-ilaas"), { credential: key }), /401/);
	});
});

describe("model tuning", () => {
	it("lets a toggle model switch reasoning on and off through the chat template", async () => {
		catalog = { data: [{ id: "gemma-4-31b", max_model_len: 159_488 }] };
		const gemma = model(await refresh(provider("ia4dev-gricad"), { credential: key }), "gemma-4-31b");
		assert.equal(gemma.reasoning, true);
		assert.deepEqual(getSupportedThinkingLevels(gemma), ["off", "high"]);
		assert.equal(gemma.compat?.thinkingFormat, "qwen-chat-template");
		assert.deepEqual(gemma.input, ["text", "image"]);
	});

	it("offers only high for a model that always reasons", async () => {
		catalog = { data: [{ id: "scaleway/glm-5.2", max_input_tokens: 256_000, max_output_tokens: 16_384 }] };
		const glm = model(await refresh(provider("ia4dev-ilaas"), { credential: key }), "scaleway/glm-5.2");
		assert.deepEqual(getSupportedThinkingLevels(glm), ["high"]);
		assert.equal(glm.compat?.thinkingFormat, undefined);
		assert.deepEqual(glm.input, ["text"]);
	});

	it("sends no reasoning parameter to a model without reasoning", async () => {
		catalog = { data: [{ id: "mistral-small-4-119b", mode: "chat" }] };
		const mistral = model(await refresh(provider("ia4dev-ilaas"), { credential: key }), "mistral-small-4-119b");
		assert.equal(mistral.reasoning, false);
		assert.deepEqual(getSupportedThinkingLevels(mistral), ["off"]);
		assert.equal(mistral.compat?.supportsReasoningEffort, false);
	});

	it("prefers measured limits over what the server announces", async () => {
		catalog = { data: [{ id: "gemma-4-31b", max_input_tokens: 1_000 }] };
		const gemma = model(await refresh(provider("ia4dev-ilaas"), { credential: key }), "gemma-4-31b");
		assert.equal(gemma.contextWindow, 131_072);
	});

	it("takes an unknown model's limits from the server, then from safe defaults", async () => {
		catalog = {
			data: [
				{ id: "vllm-model", max_model_len: 1_048_576 },
				{ id: "litellm-model", max_input_tokens: 64_000, max_output_tokens: 4_096 },
				{ id: "bare-model" },
				{ id: "small-model", max_model_len: 8_192 },
			],
		};
		const models = await refresh(provider("ia4dev-gricad"), { credential: key });
		const limits = (id: string) => {
			const m = model(models, id);
			return [m.contextWindow, m.maxTokens, m.reasoning, m.input];
		};
		assert.deepEqual(limits("vllm-model"), [1_048_576, 32_768, false, ["text"]]);
		assert.deepEqual(limits("litellm-model"), [64_000, 4_096, false, ["text"]]);
		assert.deepEqual(limits("bare-model"), [128_000, 32_768, false, ["text"]]);
		// The output limit never exceeds the context it has to fit in.
		assert.deepEqual(limits("small-model"), [8_192, 8_192, false, ["text"]]);
	});
});

describe("reasoning sent to the server", () => {
	it("maps each level to Qwen 3.8's reasoning effort", async () => {
		const sentAt = (level: ThinkingLevel | "off") => reasoningSent("ia4dev-gricad", "qwen-3.8-27b", level);
		assert.deepEqual(await sentAt("off"), {
			chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
			reasoning_effort: undefined,
		});
		for (const [level, effort] of [["low", "low"], ["medium", "medium"], ["high", "xhigh"]] as const) {
			assert.deepEqual(await sentAt(level), {
				chat_template_kwargs: { enable_thinking: true, preserve_thinking: true, reasoning_effort: effort },
				reasoning_effort: undefined,
			});
		}
	});

	it("maps each level to DeepSeek V4.1's reasoning effort", async () => {
		for (const [level, effort] of [["low", "low"], ["medium", "high"], ["high", "max"]] as const) {
			const { chat_template_kwargs } = await reasoningSent("ia4dev-gricad", "ARES/DeepSeek-V4.1-Flash", level);
			assert.deepEqual(chat_template_kwargs, { enable_thinking: true, preserve_thinking: true, reasoning_effort: effort });
		}
	});

	it("offers off, low, medium and high for an effort model", async () => {
		catalog = { data: [{ id: "qwen-3.8-27b" }] };
		const qwen = model(await refresh(provider("ia4dev-gricad"), { credential: key }), "qwen-3.8-27b");
		assert.deepEqual(getSupportedThinkingLevels(qwen), ["off", "low", "medium", "high"]);
	});

	it("only switches a toggle model on and off", async () => {
		assert.deepEqual(await reasoningSent("ia4dev-gricad", "gemma-4-31b", "high"), {
			chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
			reasoning_effort: undefined,
		});
		assert.deepEqual(await reasoningSent("ia4dev-gricad", "gemma-4-31b", "off"), {
			chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
			reasoning_effort: undefined,
		});
	});

	it("sends nothing to models that always reason or never do", async () => {
		const nothing = { chat_template_kwargs: undefined, reasoning_effort: undefined };
		assert.deepEqual(await reasoningSent("ia4dev-ilaas", "scaleway/glm-5.2", "high"), nothing);
		assert.deepEqual(await reasoningSent("ia4dev-ilaas", "scaleway/qwen3.8-27b", "high"), nothing);
		assert.deepEqual(await reasoningSent("ia4dev-ilaas", "mistral-small-4-119b", "off"), nothing);
	});
});
