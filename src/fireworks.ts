import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const CACHE_PATH = join(homedir(), ".pi/agent/.fireworks-model-cache.json");
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface FirectlMeta {
	display_name?: string;
	context_length?: number;
	supports_image_input?: boolean;
	sku_infos?: Array<{
		sku: string;
		amount: { currency_code: string; units?: string; nanos?: number };
		unit: string;
	}>;
}

interface CacheEntry {
	ts: number;
	meta: FirectlMeta | null;
}

function getApiKey(): string | undefined {
	if (process.env.FIREWORKS_API_KEY) return process.env.FIREWORKS_API_KEY;
	try {
		const auth = JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf-8"));
		if (auth.fireworks?.type === "api_key" && auth.fireworks.key) return auth.fireworks.key;
		if (auth.fireworks?.access) return auth.fireworks.access;
	} catch {}
	return undefined;
}

async function getFirectlMeta(id: string): Promise<FirectlMeta | null> {
	try {
		const { stdout } = await execAsync(`firectl model get "${id}" --output json`, {
			timeout: 10000,
			stdio: ["pipe", "pipe", "ignore"],
		});
		return JSON.parse(stdout) as FirectlMeta;
	} catch {
		return null;
	}
}

function loadCache(): Map<string, FirectlMeta | null> {
	try {
		if (!existsSync(CACHE_PATH)) return new Map();
		const raw = JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as Record<string, CacheEntry>;
		const now = Date.now();
		const valid = new Map<string, FirectlMeta | null>();
		for (const [id, entry] of Object.entries(raw)) {
			if (now - entry.ts < CACHE_TTL_MS) valid.set(id, entry.meta);
		}
		return valid;
	} catch {
		return new Map();
	}
}

function saveCache(cache: Map<string, FirectlMeta | null>) {
	try {
		const record: Record<string, CacheEntry> = {};
		const now = Date.now();
		for (const [id, meta] of cache) record[id] = { ts: now, meta };
		writeFileSync(CACHE_PATH, JSON.stringify(record, null, 2));
	} catch {}
}

function parsePrice(meta: FirectlMeta["sku_infos"]) {
	let input = 0, output = 0, cacheRead = 0;
	for (const sku of meta || []) {
		const dollars = parseInt(sku.amount.units || "0", 10) + (sku.amount.nanos || 0) / 1_000_000_000;
		if (sku.sku.includes("uncached") || (sku.sku.includes("input") && !sku.sku.includes("cached"))) {
			input = dollars;
		} else if (sku.sku.includes("cached")) {
			cacheRead = dollars;
		} else if (sku.sku.includes("output")) {
			output = dollars;
		}
	}
	return { input, output, cacheRead, cacheWrite: 0 };
}

// Models we always want registered (API discovery might miss some)
const BASE_MODELS = new Set([
	"accounts/fireworks/models/kimi-k2p6",
	"accounts/fireworks/models/llama-v3p1-405b-instruct",
	"accounts/fireworks/models/deepseek-r1",
	"accounts/fireworks/models/minimax-m2p7",
	"accounts/fireworks/models/glm-5p1",
	"accounts/fireworks/models/qwen3p6-plus",
]);

// Known reasoning models
const REASONING_MODELS = new Set([
	"accounts/fireworks/models/kimi-k2p6",
	"accounts/fireworks/models/deepseek-r1",
]);

// Compat flags from native PR — all Fireworks models need these
const FIREWORKS_COMPAT = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsStore: false,
};

export default async function (pi: ExtensionAPI) {
	const apiKey = getApiKey();

	pi.on("before_provider_request", (event) => {
		if (event.provider !== "fireworks") return;
		console.log(`[fireworks] → ${event.model}`);
	});

	pi.on("after_provider_response", (event) => {
		if (event.provider !== "fireworks") return;
		if (event.status === 429) console.warn("[fireworks] 429 RATE LIMITED");
		for (const [k, v] of Object.entries(event.headers)) {
			if (k.startsWith("x-ratelimit-"))
				console.log(`[fireworks] ${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
		}
	});

	const allIds = new Set(BASE_MODELS);

	if (apiKey) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5000);
			const res = await fetch("https://api.fireworks.ai/inference/v1/models", {
				headers: { Authorization: `Bearer ${apiKey}` },
				signal: controller.signal,
			});
			clearTimeout(timeout);

			if (res.ok) {
				const payload = (await res.json()) as { data: Array<{ id: string }> };
				for (const m of payload.data) {
					if (m.id.startsWith("accounts/fireworks/models/")) allIds.add(m.id);
				}
				console.log(`[fireworks] Discovered ${payload.data.length} models from API`);
			}
		} catch (err) {
			console.warn("[fireworks] API discovery failed:", err);
		}
	}

	// Load cache and figure out which models need firectl calls
	const cache = loadCache();
	const idsToFetch: string[] = [];
	for (const id of allIds) {
		if (!cache.has(id)) idsToFetch.push(id);
	}

	if (idsToFetch.length > 0) {
		console.log(`[fireworks] Fetching metadata for ${idsToFetch.length} models...`);
		const start = performance.now();
		// Parallel firectl calls
		const results = await Promise.all(
			idsToFetch.map(async (id) => ({ id, meta: await getFirectlMeta(id) })),
		);
		for (const { id, meta } of results) cache.set(id, meta);
		saveCache(cache);
		console.log(`[fireworks] Metadata fetched in ${Math.round(performance.now() - start)}ms`);
	} else {
		console.log("[fireworks] Using cached metadata");
	}

	const models: any[] = [];
	for (const id of allIds) {
		const meta = cache.get(id) ?? null;
		const shortName = id.replace("accounts/fireworks/models/", "");

		if (meta) {
			const cost = parsePrice(meta.sku_infos);
			const ctx = meta.context_length || 128000;
			models.push({
				id,
				name: meta.display_name || shortName,
				reasoning: REASONING_MODELS.has(id),
				input: meta.supports_image_input ? ["text", "image"] : ["text"],
				cost,
				contextWindow: ctx,
				maxTokens: ctx,
				compat: FIREWORKS_COMPAT,
			});
		} else {
			// Fallback if firectl isn't installed or model not found
			models.push({
				id,
				name: shortName,
				reasoning: REASONING_MODELS.has(id),
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 128000,
				compat: FIREWORKS_COMPAT,
			});
		}
	}

	console.log(`[fireworks] Registered ${models.length} models`);

	pi.registerProvider("fireworks", {
		baseUrl: "https://api.fireworks.ai/inference/v1",
		apiKey: apiKey || "FIREWORKS_API_KEY",
		api: "openai-completions",
		authHeader: true,
		models,
	});
}
