import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import type { Provider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import extension, { ENDPOINTS, modelsJson } from "../extensions/index.ts";

// The JSON schema pi ships for models.json, generated from the one it validates with.
const schemaUrl = new URL("../schemas/models.schema.json", import.meta.resolve("@earendil-works/pi-coding-agent"));
const schema = Compile(JSON.parse(readFileSync(schemaUrl, "utf8")));

interface ExportedProvider {
	baseUrl: string;
	apiKey: string;
	models: Record<string, unknown>[];
}

function exported(): Record<string, ExportedProvider> {
	return modelsJson().providers as Record<string, ExportedProvider>;
}

afterEach(() => {
	delete process.env.IA4DEV_ILAAS_BASE_URL;
});

describe("models.json export", () => {
	it("writes a file pi accepts", () => {
		const json = modelsJson();
		assert.ok(schema.Check(json), JSON.stringify([...schema.Errors(json)], null, 2));
	});

	it("names each provider and its key as the extension does", () => {
		assert.deepEqual(
			Object.entries(exported()).map(([id, p]) => [id, p.baseUrl, p.apiKey]),
			[
				["ia4dev-ilaas", "https://devllm.ilaas.fr/v1", "$ILAAS_API_KEY"],
				["ia4dev-gricad", "https://ia4dev-owui.univ-grenoble-alpes.fr/api", "$IA4DEV_API_KEY"],
			],
		);
	});

	it("takes the base URL from <ID>_BASE_URL", () => {
		process.env.IA4DEV_ILAAS_BASE_URL = "https://llm.ilaas.fr/v1";
		assert.equal(exported()["ia4dev-ilaas"]?.baseUrl, "https://llm.ilaas.fr/v1");
	});

	it("lists every model of the table but the hidden ones", () => {
		const ilaas = exported()["ia4dev-ilaas"]?.models.map((m) => m.id) ?? [];
		assert.ok(ilaas.includes("gemma-4-31b"));
		assert.ok(!ilaas.includes("llama-3.1-8b"));
		assert.ok(!ilaas.includes("gpt-oss-120b"));
	});

	it("describes each model exactly as the extension registers it", async () => {
		for (const endpoint of ENDPOINTS) {
			const providers = new Map<string, Provider>();
			const pi = { registerProvider: (p: Provider) => providers.set(p.id, p) };
			extension(pi as unknown as ExtensionAPI);
			const live = providers.get(endpoint.id);
			assert.ok(live?.refreshModels);

			// The server lists every model of the table, and announces nothing about them.
			const realFetch = globalThis.fetch;
			globalThis.fetch = async () =>
				new Response(JSON.stringify({ data: Object.keys(endpoint.models).map((id) => ({ id })) }));
			try {
				await live.refreshModels({
					credential: { type: "api_key", key: "sk-test" },
					allowNetwork: true,
					signal: new AbortController().signal,
					publish: async ({ update }) => {
						update?.();
						return true;
					},
				});
			} finally {
				globalThis.fetch = realFetch;
			}
			const registered = live.getModels().map(({ provider, api, baseUrl, ...model }) => model);
			// Through JSON both ways, so an undefined field counts as absent on each side.
			assert.deepEqual(
				JSON.parse(JSON.stringify(exported()[endpoint.id]?.models)),
				JSON.parse(JSON.stringify(registered)),
			);
		}
	});

	it("refuses a model whose context size the table does not give", () => {
		const endpoint = { ...ENDPOINTS[0]!, models: { "new-model": { thinking: "toggle" as const } } };
		assert.throws(() => modelsJson([endpoint]), /new-model has no contextWindow/);
	});

	it("prints the file from the export script", () => {
		const out = execFileSync(process.execPath, ["scripts/export-models.ts"], { encoding: "utf8" });
		assert.deepEqual(JSON.parse(out), JSON.parse(JSON.stringify(modelsJson())));
	});
});
