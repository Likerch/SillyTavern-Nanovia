import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash, randomBytes, randomInt } from "node:crypto";
import http from "node:http";
import fs$1 from "node:fs/promises";
// src/shared/constants.ts
/** Server plugin id (ST mounts its router at `/api/plugins/<id>`). */
var PLUGIN_ID = "nanovia";
/** The local proxy: its own HTTP listener, because ST's own router would demand a session cookie and a CSRF token. */
var PROXY_HOST = "127.0.0.1";
var DEFAULT_PROXY_PORT = 8787;
/** NanoGPT API bases. `api.nano-gpt.com` is IPv4-only and takes bodies up to 32 MiB; `nano-gpt.com` is the fallback. */
var NANOGPT_API_BASE = "https://api.nano-gpt.com/api/v1";
var NANOGPT_API_BASE_FALLBACK = "https://nano-gpt.com/api/v1";
var NANOGPT_SITE = "https://nano-gpt.com";
/** Names of ST secrets (src/endpoints/secrets.js SECRET_KEYS). Several values per key, each with an id and a label. */
var SECRET_KEY_NANOGPT = "api_key_nanogpt";
var SECRET_KEY_CUSTOM = "api_key_custom";
/** Prefix of the label of every secret Nanovia writes into ST's secret store. */
var SECRET_LABEL_PREFIX = "Nanovia: ";
/**
* Hint headers the browser hook adds to a request through the proxy (via ST's `custom_include_headers`), so the
* proxy can honour what ST itself knew about the request. All optional; names are lower case.
*/
var HINT_HEADERS = {
	/** The reasoning effort ST/the caller asked for, in ST's vocabulary (min/low/medium/high/max/none/auto). */
	effort: "x-nanovia-effort",
	/** 'main' for the chat generation, 'background' for extension requests, otherwise absent. */
	consumer: "x-nanovia-consumer",
	/** '1' when the browser wants the reasoning text back (ST's show-thoughts). */
	thoughts: "x-nanovia-thoughts"
};
/** Headers the proxy adds to every response so a caller can see what happened to the request. */
var RESPONSE_HEADERS = {
	connection: "x-nanovia-connection",
	billing: "x-nanovia-billing",
	requestId: "x-nanovia-request-id",
	warnings: "x-nanovia-warnings"
};
// src/domain/catalog.ts
/** Weight precisions from the coarsest to the finest. `unknown` is outside the scale. */
var QUANTIZATION_ORDER = [
	"int4",
	"fp4",
	"fp6",
	"int8",
	"fp8",
	"fp16",
	"bf16",
	"fp32"
];
function isRecord$5(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value) {
	return isRecord$5(value) ? value : {};
}
function finite(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function nonNegative(value) {
	const n = finite(value);
	return n !== null && n >= 0 ? n : null;
}
function positive(value) {
	const n = finite(value);
	return n !== null && n > 0 ? n : null;
}
function text(value) {
	return typeof value === "string" ? value.trim() : "";
}
function strings(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) {
		const s = text(item);
		if (s) out.push(s);
	}
	return out;
}
/** Cleans float noise of unit conversions (0.0000042 * 1000 = 0.004200000000000001). */
function roundUsd(value) {
	return Math.round(value * 1e9) / 1e9;
}
/** NanoGPT lists `…Per1kTokens`; the contracts hold USD per 1M tokens. */
function per1kToPer1m(value) {
	return roundUsd(value * 1e3);
}
/** `created` is seconds in NanoGPT's list; a millisecond value is tolerated. */
function toSeconds(value) {
	const n = positive(value);
	if (n === null) return null;
	return n > 1e11 ? Math.floor(n / 1e3) : Math.floor(n);
}
/**
* One entry of `GET /api/v1/models?detailed=true`. Null when it has no id. Everything else is tolerated: a missing
* price becomes 0 (NanoGPT lists a few models as "varies by modality" without a price), a missing window becomes null.
* `pricing.prompt/completion` are already USD per 1M; `cacheReadInputPer1kTokens` is per 1k and converted.
*/
function normalizeCatalogModel(raw) {
	if (!isRecord$5(raw)) return null;
	const id = text(raw["id"]);
	if (!id) return null;
	const caps = record(raw["capabilities"]);
	const price = record(raw["pricing"]);
	const sub = record(raw["subscription"]);
	const cacheRead = nonNegative(price["cacheReadInputPer1kTokens"]);
	return {
		id,
		name: text(raw["name"]) || id,
		description: text(raw["description"]),
		contextLength: positive(raw["context_length"]),
		maxOutputTokens: positive(raw["max_output_tokens"]),
		capabilities: {
			vision: caps["vision"] === true,
			reasoning: caps["reasoning"] === true,
			toolCalling: caps["tool_calling"] === true,
			structuredOutput: caps["structured_output"] === true
		},
		reasoningEfforts: strings(raw["reasoning_efforts"]),
		openWeights: raw["open_weights"] === true,
		pricing: {
			prompt: roundUsd(nonNegative(price["prompt"]) ?? 0),
			completion: roundUsd(nonNegative(price["completion"]) ?? 0),
			cacheRead: cacheRead === null ? null : per1kToPer1m(cacheRead)
		},
		category: text(raw["category"]) || null,
		subscription: {
			included: sub["included"] === true,
			inputTokenMultiplier: positive(sub["inputTokenMultiplier"]) ?? 1
		},
		providerIds: strings(raw["providers"]),
		created: toSeconds(raw["created"])
	};
}
/**
* The whole answer of the models endpoint: the `{ data: [...] }` envelope or a bare array. Junk entries are skipped,
* the order is kept, and a repeated id keeps its first entry.
*/
function normalizeCatalog(rawList) {
	const list = Array.isArray(rawList) ? rawList : isRecord$5(rawList) && Array.isArray(rawList["data"]) ? rawList["data"] : [];
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const item of list) {
		const model = normalizeCatalogModel(item);
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		out.push(model);
	}
	return out;
}
/** Spellings of a host's weight precision (compared without case, spaces, `-`, `_` and `.`). */
var QUANTIZATION_ALIASES = {
	fp4: "fp4",
	mxfp4: "fp4",
	nvfp4: "fp4",
	int4: "int4",
	"4bit": "int4",
	fp6: "fp6",
	mxfp6: "fp6",
	int8: "int8",
	"8bit": "int8",
	fp8: "fp8",
	mxfp8: "fp8",
	float8: "fp8",
	fp8e4m3: "fp8",
	fp8e5m2: "fp8",
	fp16: "fp16",
	float16: "fp16",
	half: "fp16",
	bf16: "bf16",
	bfloat16: "bf16",
	fp32: "fp32",
	float32: "fp32"
};
/**
* Maps what a host reports to the contract: `quantization` is the normalised precision (mxfp4/nvfp4 -> fp4, native,
* unknown, `-` and labels we do not know -> 'unknown'); both fields are null when the host reports nothing.
* `rawQuantization` keeps the label as the host wrote it.
*/
function mapQuantization(raw) {
	const label = text(raw);
	if (!label) return {
		quantization: null,
		rawQuantization: null
	};
	return {
		quantization: QUANTIZATION_ALIASES[label.toLowerCase().replace(/[\s_\-.]/g, "")] ?? "unknown",
		rawQuantization: label
	};
}
function priceOf(raw) {
	const p = record(raw);
	const input = nonNegative(p["inputPer1kTokens"]);
	const output = nonNegative(p["outputPer1kTokens"]);
	if (input === null || output === null) return null;
	const cacheRead = nonNegative(p["cacheReadInputPer1kTokens"]);
	return {
		prompt: per1kToPer1m(input),
		completion: per1kToPer1m(output),
		cacheRead: cacheRead === null ? null : per1kToPer1m(cacheRead)
	};
}
/** NanoGPT reports `uptime: { uptimePct }` (percent); a bare number is taken as percent too. */
function uptimeOf(raw) {
	const n = isRecord$5(raw) ? nonNegative(raw["uptimePct"]) : nonNegative(raw);
	return n !== null && n <= 100 ? n : null;
}
/** `features` is an object of flags (`{ toolCalling: true, … }`): the names that are true. A list of names is kept. */
function featuresOf(raw) {
	if (Array.isArray(raw)) return strings(raw);
	if (!isRecord$5(raw)) return [];
	return Object.keys(raw).filter((key) => raw[key] === true);
}
function normalizeEndpoint(raw) {
	if (!isRecord$5(raw)) return null;
	const id = text(raw["provider"]);
	if (!id || raw["available"] === false) return null;
	const { quantization, rawQuantization } = mapQuantization(raw["quantization"]);
	return {
		id,
		quantization,
		rawQuantization,
		pricing: priceOf(raw["pricing"]),
		tps: positive(raw["tps"]),
		ttftMs: positive(raw["ttftMs"]),
		uptime: uptimeOf(raw["uptime"]),
		maxOutputTokens: positive(raw["maxOutputTokens"]),
		features: featuresOf(raw["features"])
	};
}
/**
* The answer of `GET /api/models/:id/providers`. `modelId` is the id the caller asked for (the answer's `canonicalId`
* fills in when it is empty). A model without provider selection answers `supportsProviderSelection: false` and no host
* list: that is a valid result with no hosts. Null when the body is not recognisable (an error shape, junk).
* Prices become USD per 1M; unavailable hosts are dropped; a repeated host keeps its first entry.
*/
function normalizeModelProviders(modelId, raw) {
	if (!isRecord$5(raw)) return null;
	const hosts = raw["providers"];
	if (!(Array.isArray(hosts) || typeof raw["supportsProviderSelection"] === "boolean" || typeof raw["canonicalId"] === "string")) return null;
	const id = text(modelId) || text(raw["canonicalId"]);
	if (!id) return null;
	const rate = finite(raw["autoCacheReadRate"]);
	const seen = /* @__PURE__ */ new Set();
	const providers = [];
	for (const item of Array.isArray(hosts) ? hosts : []) {
		const endpoint = normalizeEndpoint(item);
		if (!endpoint || seen.has(endpoint.id)) continue;
		seen.add(endpoint.id);
		providers.push(endpoint);
	}
	return {
		modelId: id,
		supportsProviderSelection: raw["supportsProviderSelection"] !== false,
		autoCacheReadRate: rate !== null && rate >= 0 && rate <= 1 ? rate : null,
		autoTps: positive(raw["autoTps"]),
		autoTtftMs: positive(raw["autoTtftMs"]),
		providers
	};
}
/** Position on the precision scale (int4 lowest); null for 'unknown', null and undefined. */
function quantizationRank(q) {
	if (!q) return null;
	const index = QUANTIZATION_ORDER.indexOf(q);
	return index < 0 ? null : index;
}
/**
* Does precision `q` reach the floor `min`? No floor (null or 'unknown') always passes. A host with an unknown precision
* gives null: it cannot be checked, and what NanoGPT does with it is up to NanoGPT.
*/
function meetsMinQuantization(q, min) {
	const floor = quantizationRank(min);
	if (floor === null) return true;
	const rank = quantizationRank(q);
	return rank === null ? null : rank >= floor;
}
new Intl.Collator("en", {
	numeric: true,
	sensitivity: "base"
});
// src/domain/connection.ts
var QUANTIZATIONS = [
	"int4",
	"fp4",
	"fp6",
	"int8",
	"fp8",
	"fp16",
	"bf16",
	"fp32",
	"unknown"
];
var SORTS = [
	"default",
	"price",
	"throughput",
	"latency",
	"speed"
];
var MODES$1 = [
	"auto",
	"plugin",
	"direct"
];
var BILLING$1 = [
	"auto",
	"subscription",
	"paygo"
];
var POLICIES = [
	"follow",
	"fixed",
	"off",
	"default"
];
var EFFORTS = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
var CONNECTION_ID_PATTERN = /^[a-z0-9]{6,16}$/;
function isValidConnectionId(value) {
	return typeof value === "string" && CONNECTION_ID_PATTERN.test(value);
}
function defaultRouting() {
	return {
		enabled: false,
		order: [],
		only: [],
		ignore: [],
		sort: "default",
		quantizations: [],
		minQuantization: null,
		maxPrice: {
			prompt: null,
			completion: null
		},
		allowFallbacks: true,
		requireParameters: false,
		zdr: false,
		preferredMaxLatency: null,
		preferredMinThroughput: null,
		cachingRoute: false
	};
}
function defaultReasoning() {
	return {
		policy: "follow",
		effort: null,
		hideThoughts: false
	};
}
/** A new connection with every field at its default. `id` and `now` come from the caller. */
function createConnection(input, id, now) {
	return mergeConnection({
		id,
		name: input.name,
		modelId: input.modelId,
		modelLock: false,
		mode: "auto",
		keyId: null,
		billing: "auto",
		routing: defaultRouting(),
		reasoning: defaultReasoning(),
		webSearch: false,
		memory: {
			enabled: false,
			expirationDays: null
		},
		stripNeutralSamplers: true,
		note: "",
		createdAt: now,
		updatedAt: now
	}, {
		...input,
		id,
		createdAt: now
	}, now);
}
/** Applies a patch (already typed or raw) over a connection; unknown or invalid fields are ignored. */
function mergeConnection(base, patch, now) {
	const p = isRecord$4(patch) ? patch : {};
	const next = {
		...base,
		routing: {
			...base.routing,
			maxPrice: { ...base.routing.maxPrice },
			order: [...base.routing.order]
		},
		reasoning: { ...base.reasoning },
		memory: { ...base.memory }
	};
	if (typeof p["name"] === "string" && p["name"].trim()) next.name = clip(p["name"].trim(), 80);
	if (typeof p["modelId"] === "string" && p["modelId"].trim()) next.modelId = clip(p["modelId"].trim(), 200);
	if (typeof p["modelLock"] === "boolean") next.modelLock = p["modelLock"];
	if (isOneOf(MODES$1, p["mode"])) next.mode = p["mode"];
	if (p["keyId"] === null) next.keyId = null;
	else if (typeof p["keyId"] === "string" && p["keyId"].trim()) next.keyId = clip(p["keyId"].trim(), 100);
	if (isOneOf(BILLING$1, p["billing"])) next.billing = p["billing"];
	if (typeof p["webSearch"] === "boolean") next.webSearch = p["webSearch"];
	if (typeof p["stripNeutralSamplers"] === "boolean") next.stripNeutralSamplers = p["stripNeutralSamplers"];
	if (typeof p["note"] === "string") next.note = clip(p["note"], 1e3);
	if (isRecord$4(p["routing"])) next.routing = mergeRouting(next.routing, p["routing"]);
	if (isRecord$4(p["reasoning"])) next.reasoning = mergeReasoning(next.reasoning, p["reasoning"]);
	if (isRecord$4(p["memory"])) {
		const m = p["memory"];
		if (typeof m["enabled"] === "boolean") next.memory.enabled = m["enabled"];
		if (m["expirationDays"] === null) next.memory.expirationDays = null;
		else if (isNumber(m["expirationDays"])) next.memory.expirationDays = clamp(Math.round(m["expirationDays"]), 1, 365);
	}
	if (isNumber(p["createdAt"])) next.createdAt = p["createdAt"];
	next.updatedAt = now;
	return next;
}
/**
* Sanitises a connection read from disk or the wire. Returns null when it cannot be a connection (no valid id, name or
* model). Everything else falls back to defaults, so a hand-edited file never crashes the plugin.
*/
function normalizeConnection(raw, now) {
	if (!isRecord$4(raw)) return null;
	const id = raw["id"];
	const name = raw["name"];
	const modelId = raw["modelId"];
	if (!isValidConnectionId(id) || typeof name !== "string" || !name.trim()) return null;
	if (typeof modelId !== "string" || !modelId.trim()) return null;
	const created = isNumber(raw["createdAt"]) ? raw["createdAt"] : now;
	return mergeConnection(createConnection({
		name: name.trim(),
		modelId: modelId.trim()
	}, id, created), raw, isNumber(raw["updatedAt"]) ? raw["updatedAt"] : now);
}
function mergeRouting(base, p) {
	const next = {
		...base,
		maxPrice: { ...base.maxPrice }
	};
	if (typeof p["enabled"] === "boolean") next.enabled = p["enabled"];
	if (Array.isArray(p["order"])) next.order = ids(p["order"]);
	if (Array.isArray(p["only"])) next.only = ids(p["only"]);
	if (Array.isArray(p["ignore"])) next.ignore = ids(p["ignore"]);
	if (isOneOf(SORTS, p["sort"])) next.sort = p["sort"];
	if (Array.isArray(p["quantizations"])) next.quantizations = [...new Set(p["quantizations"].filter((q) => isOneOf(QUANTIZATIONS, q)))];
	if (p["minQuantization"] === null) next.minQuantization = null;
	else if (isOneOf(QUANTIZATIONS, p["minQuantization"])) next.minQuantization = p["minQuantization"];
	if (isRecord$4(p["maxPrice"])) {
		const mp = p["maxPrice"];
		if (mp["prompt"] === null || isPrice(mp["prompt"])) next.maxPrice.prompt = mp["prompt"];
		if (mp["completion"] === null || isPrice(mp["completion"])) next.maxPrice.completion = mp["completion"];
	}
	if (typeof p["allowFallbacks"] === "boolean") next.allowFallbacks = p["allowFallbacks"];
	if (typeof p["requireParameters"] === "boolean") next.requireParameters = p["requireParameters"];
	if (typeof p["zdr"] === "boolean") next.zdr = p["zdr"];
	if (p["preferredMaxLatency"] === null || isPrice(p["preferredMaxLatency"])) {
		if ("preferredMaxLatency" in p) next.preferredMaxLatency = p["preferredMaxLatency"];
	}
	if (p["preferredMinThroughput"] === null || isPrice(p["preferredMinThroughput"])) {
		if ("preferredMinThroughput" in p) next.preferredMinThroughput = p["preferredMinThroughput"];
	}
	if (typeof p["cachingRoute"] === "boolean") next.cachingRoute = p["cachingRoute"];
	return next;
}
function mergeReasoning(base, p) {
	const next = { ...base };
	if (isOneOf(POLICIES, p["policy"])) next.policy = p["policy"];
	if (p["effort"] === null) next.effort = null;
	else if (isOneOf(EFFORTS, p["effort"])) next.effort = p["effort"];
	if (typeof p["hideThoughts"] === "boolean") next.hideThoughts = p["hideThoughts"];
	return next;
}
function ids(list) {
	const out = [];
	for (const item of list) {
		if (typeof item !== "string") continue;
		const v = item.trim().toLowerCase();
		if (v && v.length <= 100 && !out.includes(v)) out.push(v);
	}
	return out;
}
function isRecord$4(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}
/** A non-negative finite number (a price, a latency or a throughput). */
function isPrice(value) {
	return isNumber(value) && value >= 0;
}
function isOneOf(list, value) {
	return typeof value === "string" && list.includes(value);
}
function clip(value, max) {
	return value.length > max ? value.slice(0, max) : value;
}
function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}
var CONNECTIONS_FILE = "connections.json";
var REGISTRY_FILE = "registry.json";
var USER_DIR_NAME = "nanovia";
var GLOBAL_DIR_NAME = "_nanovia";
/** A JSON file with an mtime cache, atomic writes and tolerant reads. */
var JsonFile = class {
	file;
	parse;
	serialize;
	empty;
	log;
	cache = null;
	/** The file on disk could not be parsed at the last read: it is copied aside before the next write. */
	corrupt = false;
	constructor(file, parse, serialize, empty, log) {
		this.file = file;
		this.parse = parse;
		this.serialize = serialize;
		this.empty = empty;
		this.log = log;
	}
	read() {
		const file = this.file();
		let stat;
		try {
			stat = fs.statSync(file);
		} catch {
			this.cache = null;
			return this.empty();
		}
		if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) return structuredClone(this.cache.value);
		let value;
		try {
			value = this.parse(JSON.parse(fs.readFileSync(file, "utf8")));
			this.corrupt = false;
		} catch {
			this.log.warn(`${path.basename(file)} is unreadable and is treated as empty`);
			this.corrupt = true;
			value = this.empty();
		}
		this.cache = {
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			value
		};
		return structuredClone(value);
	}
	write(value) {
		const file = this.file();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		if (this.corrupt) {
			try {
				fs.copyFileSync(file, `${file}.corrupt`);
			} catch {}
			this.corrupt = false;
		}
		writeFileAtomic(file, `${JSON.stringify(this.serialize(value), null, 2)}\n`);
		try {
			const stat = fs.statSync(file);
			this.cache = {
				mtimeMs: stat.mtimeMs,
				size: stat.size,
				value: structuredClone(value)
			};
		} catch {
			this.cache = null;
		}
	}
};
/** Writes to a temp file next to the target and renames it over it, so a reader never sees half a file. */
function writeFileAtomic(file, text) {
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(tmp, text, {
			encoding: "utf8",
			mode: 384
		});
		let lastError;
		for (let attempt = 0; attempt < 5; attempt++) try {
			fs.renameSync(tmp, file);
			return;
		} catch (error) {
			lastError = error;
		}
		throw lastError;
	} catch (error) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {}
		throw error;
	}
}
function parseConnections(raw, now) {
	if (!isRecord$3(raw) || !Array.isArray(raw["connections"])) return [];
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const item of raw["connections"]) {
		const connection = normalizeConnection(item, now);
		if (!connection || seen.has(connection.id)) continue;
		seen.add(connection.id);
		out.push(connection);
	}
	return out;
}
var TOKEN_HASH = /^[0-9a-f]{64}$/;
function parseRegistry(raw) {
	const registry = emptyRegistry();
	if (!isRecord$3(raw) || !isRecord$3(raw["tokens"])) return registry;
	for (const [hash, entry] of Object.entries(raw["tokens"])) {
		if (!TOKEN_HASH.test(hash) || !isRecord$3(entry)) continue;
		const { connectionId, userHandle, tokenSecretId } = entry;
		if (!isValidConnectionId(connectionId) || typeof userHandle !== "string" || !userHandle) continue;
		registry.tokens[hash] = {
			connectionId,
			userHandle,
			tokenSecretId: typeof tokenSecretId === "string" && tokenSecretId ? tokenSecretId : null
		};
	}
	return registry;
}
function emptyRegistry() {
	return {
		version: 1,
		tokens: {}
	};
}
function createStore(options) {
	const { dataRoot, now, log } = options;
	const userFiles = /* @__PURE__ */ new Map();
	const connectionsFile = (userRoot) => {
		let file = userFiles.get(userRoot);
		if (!file) {
			file = new JsonFile(() => path.join(userRoot, USER_DIR_NAME, CONNECTIONS_FILE), (raw) => parseConnections(raw, now()), (connections) => ({
				version: 1,
				connections
			}), () => [], log);
			userFiles.set(userRoot, file);
		}
		return file;
	};
	const registryFile = new JsonFile(() => path.join(dataRoot(), GLOBAL_DIR_NAME, REGISTRY_FILE), parseRegistry, (registry) => registry, emptyRegistry, log);
	return {
		userDir: (userRoot) => path.join(userRoot, USER_DIR_NAME),
		connections: {
			list: (userRoot) => connectionsFile(userRoot).read(),
			get: (userRoot, id) => connectionsFile(userRoot).read().find((c) => c.id === id) ?? null,
			save: (userRoot, connections) => connectionsFile(userRoot).write(connections)
		},
		registry: {
			read: () => registryFile.read(),
			lookup: (tokenHash) => {
				const tokens = registryFile.read().tokens;
				return Object.hasOwn(tokens, tokenHash) ? tokens[tokenHash] ?? null : null;
			},
			mutate: (change) => {
				const registry = registryFile.read();
				change(registry);
				registryFile.write(registry);
			}
		}
	};
}
function isRecord$3(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
// src/server/upstream.ts
var UpstreamError = class extends Error {
	kind;
	code;
	constructor(kind, code) {
		super(kind === "aborted" ? "upstream request aborted" : `upstream ${kind}${code ? ` (${code})` : ""}`);
		this.kind = kind;
		this.code = code;
		this.name = "UpstreamError";
	}
};
/** Codes that mean "never connected": the only failures that are safe to retry on another base. */
var CONNECT_CODES = /* @__PURE__ */ new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ETIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT"
]);
var FORBIDDEN_HEADERS = /* @__PURE__ */ new Set([
	"authorization",
	"host",
	"content-length",
	"connection",
	"transfer-encoding"
]);
function errorCode(error) {
	let current = error;
	for (let depth = 0; depth < 4 && current; depth++) if (typeof current === "object" && current !== null) {
		const rec = current;
		if (typeof rec.code === "string" && rec.code) return rec.code;
		if (typeof rec.errno === "string" && rec.errno) return rec.errno;
		current = rec.cause;
	} else break;
	return null;
}
function isConnectError(error) {
	const code = errorCode(error);
	return code !== null && CONNECT_CODES.has(code);
}
function chatCompletionsUrl(base) {
	return `${base.replace(/\/+$/, "")}/chat/completions`;
}
async function callUpstream(options) {
	const { signal, timeoutMs } = options;
	if (signal.aborted) throw new UpstreamError("aborted", null);
	const controller = new AbortController();
	let timedOut = false;
	let timer;
	let closed = false;
	let finished = false;
	const clear = () => {
		if (timer !== void 0) clearTimeout(timer);
		timer = void 0;
	};
	const arm = () => {
		clear();
		timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		timer.unref?.();
	};
	const onClientAbort = () => controller.abort();
	signal.addEventListener("abort", onClientAbort, { once: true });
	const release = () => {
		clear();
		signal.removeEventListener("abort", onClientAbort);
	};
	const headers = {
		"content-type": "application/json",
		accept: options.stream ? "text/event-stream" : "application/json",
		"accept-encoding": "identity",
		"user-agent": options.userAgent
	};
	for (const [name, value] of Object.entries(options.headers)) if (!FORBIDDEN_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
	headers["authorization"] = `Bearer ${options.key.reveal()}`;
	const attempt = (base) => options.fetch(chatCompletionsUrl(base), {
		method: "POST",
		headers,
		body: options.body,
		signal: controller.signal
	});
	arm();
	let response;
	let usedBase = options.base;
	try {
		try {
			response = await attempt(options.base);
		} catch (error) {
			if (!options.fallbackBase || !isConnectError(error) || controller.signal.aborted) throw error;
			usedBase = options.fallbackBase;
			arm();
			response = await attempt(options.fallbackBase);
		}
	} catch (error) {
		release();
		if (signal.aborted) throw new UpstreamError("aborted", null);
		if (timedOut) throw new UpstreamError("timeout", null);
		throw new UpstreamError("unreachable", errorCode(error));
	}
	const responseHeaders = {};
	response.headers.forEach((value, name) => {
		responseHeaders[name.toLowerCase()] = value;
	});
	arm();
	const source = response.body ?? emptyBody();
	async function* body() {
		try {
			for await (const chunk of source) yield chunk;
			finished = true;
		} catch (error) {
			if (signal.aborted) throw new UpstreamError("aborted", null);
			if (timedOut) throw new UpstreamError("timeout", null);
			throw new UpstreamError("unreachable", errorCode(error));
		}
	}
	return {
		status: response.status,
		headers: responseHeaders,
		base: usedBase,
		body: body(),
		touch() {
			if (!closed) arm();
		},
		close() {
			if (closed) return;
			closed = true;
			release();
			if (!finished) controller.abort();
		}
	};
}
async function* emptyBody() {}
// src/server/catalog.ts
var CATALOG_FILE = "catalog.json";
/** A fetch that did not give usable data; `reason` is a short code for the log. */
var FetchFailure = class extends Error {
	reason;
	constructor(reason) {
		super(reason);
		this.reason = reason;
		this.name = "FetchFailure";
	}
};
function createCatalogService(options) {
	const { fetch, log, now } = options;
	const siteBase = options.siteBase.replace(/\/+$/, "");
	const autoFetch = options.autoFetch ?? false;
	const ttlMs = options.ttlMs ?? 6e5;
	const providersTtlMs = options.providersTtlMs ?? 3e5;
	const timeoutMs = options.timeoutMs ?? 15e3;
	const capacity = Math.max(1, options.providersCapacity ?? 200);
	const backoffMs = options.failureBackoffMs ?? 6e4;
	let snapshot = null;
	let inflight = null;
	let failedAt = null;
	let closed = false;
	/** The first successful fetch of this run has been logged. */
	let announced = false;
	const providerEntries = /* @__PURE__ */ new Map();
	const providerFlights = /* @__PURE__ */ new Map();
	const controllers = /* @__PURE__ */ new Set();
	/** One public GET. 2xx bodies are parsed as JSON; any other status comes back with `json: null`. */
	async function getJson(url) {
		if (closed) throw new FetchFailure("closed");
		const controller = new AbortController();
		controllers.add(controller);
		let timer;
		const timeout = new Promise((_resolve, reject) => {
			timer = setTimeout(() => {
				reject(new FetchFailure("timeout"));
				controller.abort();
			}, timeoutMs);
			timer.unref?.();
		});
		const work = (async () => {
			const response = await fetch(url, {
				method: "GET",
				headers: {
					accept: "application/json",
					"user-agent": `Nanovia/${options.version}`
				},
				signal: controller.signal
			});
			const body = response.status >= 200 && response.status < 300 ? await response.text() : "";
			return {
				status: response.status,
				body
			};
		})();
		work.catch(() => {});
		try {
			const { status, body } = await Promise.race([work, timeout]);
			if (status < 200 || status >= 300) return {
				status,
				json: null
			};
			try {
				return {
					status,
					json: JSON.parse(body)
				};
			} catch {
				throw new FetchFailure("invalid JSON");
			}
		} catch (error) {
			if (error instanceof FetchFailure) throw error;
			throw new FetchFailure(closed ? "closed" : errorCode(error) ?? "unreachable");
		} finally {
			if (timer !== void 0) clearTimeout(timer);
			controllers.delete(controller);
		}
	}
	function makeSnapshot(models, fetchedAt) {
		return {
			models,
			fetchedAt,
			byId: new Map(models.map((m) => [m.id, m]))
		};
	}
	function cacheFile() {
		return path.join(options.dataRoot(), GLOBAL_DIR_NAME, CATALOG_FILE);
	}
	function persist(value) {
		try {
			const file = cacheFile();
			fs.mkdirSync(path.dirname(file), { recursive: true });
			writeFileAtomic(file, JSON.stringify({
				version: 1,
				fetchedAt: value.fetchedAt,
				models: value.models
			}));
		} catch (error) {
			log.warn(`catalog cache could not be written (${errorCode(error) ?? "io error"})`);
		}
	}
	function loadCacheFile() {
		let raw;
		try {
			raw = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
		} catch (error) {
			if (errorCode(error) !== "ENOENT") log.warn("catalog cache is unreadable and is ignored");
			return null;
		}
		if (!isRecord$2(raw) || raw["version"] !== 1 || !Array.isArray(raw["models"])) return null;
		const at = raw["fetchedAt"];
		if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return null;
		const seen = /* @__PURE__ */ new Set();
		const models = [];
		for (const item of raw["models"]) {
			if (!isStoredModel(item) || seen.has(item.id)) continue;
			seen.add(item.id);
			models.push(item);
		}
		return models.length > 0 ? makeSnapshot(models, Math.min(at, now())) : null;
	}
	async function fetchCatalog() {
		try {
			const { status, json } = await getJson(`${siteBase}/api/v1/models?detailed=true`);
			if (status < 200 || status >= 300) throw new FetchFailure(`http ${status}`);
			const models = normalizeCatalog(json);
			if (models.length === 0) throw new FetchFailure("no models in the answer");
			const next = makeSnapshot(models, now());
			if (closed) return false;
			const quiet = announced && failedAt === null;
			snapshot = next;
			failedAt = null;
			announced = true;
			persist(next);
			if (!quiet) log.info(`catalog loaded: ${models.length} models`);
			return true;
		} catch (error) {
			if (closed) return false;
			const reason = error instanceof FetchFailure ? error.reason : errorCode(error) ?? "error";
			if (failedAt === null) log.warn(`catalog fetch failed (${reason})${snapshot ? "; the stored copy is used" : ""}`);
			failedAt = now();
			return false;
		}
	}
	/** Single-flight: every caller during a fetch gets the same promise. Resolves true when new data arrived; never rejects. */
	function refresh() {
		if (inflight) return inflight;
		const running = fetchCatalog().finally(() => {
			if (inflight === running) inflight = null;
		});
		inflight = running;
		return running;
	}
	const isExpired = (value) => now() - value.fetchedAt >= ttlMs;
	const backingOff = (at) => at !== null && now() - at < backoffMs;
	/** A fetch nobody waits for; honours `autoFetch`, a running fetch and the failure backoff. */
	function kickCatalog() {
		if (!autoFetch || closed || inflight || backingOff(failedAt)) return;
		refresh();
	}
	function start() {
		if (closed) return;
		snapshot ??= loadCacheFile();
		if (!snapshot || isExpired(snapshot)) kickCatalog();
	}
	function respond(value, source) {
		return {
			models: value.models,
			fetchedAt: value.fetchedAt,
			source
		};
	}
	async function catalog(opts = {}) {
		const held = snapshot;
		if (held && !opts.refresh) {
			if (!isExpired(held)) return respond(held, "cache");
			if (inflight || backingOff(failedAt)) return respond(held, "stale");
		}
		const fetched = await refresh();
		const current = snapshot;
		if (!current) return null;
		return respond(current, fetched ? "live" : "stale");
	}
	/** The exact id, else the id with trailing `:suffix` parts peeled off (`:online`, `:memory-7`, `:thinking:max`). */
	function lookupModel(modelId) {
		const held = snapshot;
		if (!held) {
			kickCatalog();
			return null;
		}
		if (isExpired(held)) kickCatalog();
		let id = typeof modelId === "string" ? modelId.trim() : "";
		for (;;) {
			const model = held.byId.get(id);
			if (model) return model;
			const cut = id.lastIndexOf(":");
			if (cut <= 0) return null;
			id = id.slice(0, cut);
		}
	}
	/** The key of a model's host list: its catalog id when the catalog knows the model, else the id as given. */
	function providersKey(modelId) {
		return lookupModel(modelId)?.id ?? (typeof modelId === "string" ? modelId.trim() : "");
	}
	/** Reads an entry and marks it as recently used. */
	function touch(key) {
		const entry = providerEntries.get(key);
		if (entry) {
			providerEntries.delete(key);
			providerEntries.set(key, entry);
		}
		return entry;
	}
	function putEntry(key, entry) {
		providerEntries.delete(key);
		providerEntries.set(key, entry);
		while (providerEntries.size > capacity) {
			const oldest = providerEntries.keys().next();
			if (oldest.done) break;
			providerEntries.delete(oldest.value);
		}
	}
	function noteProvidersFailure(key, failure) {
		const previous = providerEntries.get(key);
		putEntry(key, {
			value: previous?.value ?? null,
			fetchedAt: previous?.fetchedAt ?? 0,
			failedAt: now(),
			failure
		});
	}
	async function fetchProviders(key) {
		try {
			const { status, json } = await getJson(`${siteBase}/api/models/${encodeURIComponent(key)}/providers`);
			if (status === 404) {
				noteProvidersFailure(key, "not_found");
				return false;
			}
			if (status < 200 || status >= 300) throw new FetchFailure(`http ${status}`);
			const value = normalizeModelProviders(key, json);
			if (!value) throw new FetchFailure("unrecognised answer");
			if (closed) return false;
			putEntry(key, {
				value,
				fetchedAt: now(),
				failedAt: null,
				failure: null
			});
			return true;
		} catch (error) {
			if (closed) return false;
			const reason = error instanceof FetchFailure ? error.reason : errorCode(error) ?? "error";
			if (!providerEntries.get(key)?.failedAt) log.warn(`providers fetch failed (${reason})`);
			noteProvidersFailure(key, "unavailable");
			return false;
		}
	}
	function refreshProviders(key) {
		const running = providerFlights.get(key);
		if (running) return running;
		const flight = fetchProviders(key).finally(() => {
			if (providerFlights.get(key) === flight) providerFlights.delete(key);
		});
		providerFlights.set(key, flight);
		return flight;
	}
	function kickProviders(key, entry) {
		if (!autoFetch || closed || !key || providerFlights.has(key) || backingOff(entry?.failedAt ?? null)) return;
		refreshProviders(key);
	}
	function answer(value, fetchedAt) {
		return {
			ok: true,
			value: {
				...value,
				fetchedAt
			}
		};
	}
	async function providers(modelId, opts = {}) {
		const key = providersKey(modelId);
		if (!key) return {
			ok: false,
			reason: "not_found"
		};
		const held = touch(key);
		if (held?.value && !opts.refresh && now() - held.fetchedAt < providersTtlMs) return answer(held.value, held.fetchedAt);
		await refreshProviders(key);
		const current = touch(key);
		if (current?.value) return answer(current.value, current.fetchedAt);
		return {
			ok: false,
			reason: current?.failure ?? "unavailable"
		};
	}
	function providerSelection(modelId) {
		const key = providersKey(modelId);
		if (!key) return null;
		const entry = touch(key);
		if (entry?.value) {
			if (now() - entry.fetchedAt >= providersTtlMs) kickProviders(key, entry);
			return entry.value.supportsProviderSelection;
		}
		kickProviders(key, entry);
		return null;
	}
	async function settled() {
		while (inflight || providerFlights.size > 0) await Promise.all([inflight, ...providerFlights.values()]);
	}
	function close() {
		closed = true;
		for (const controller of controllers) controller.abort();
		controllers.clear();
	}
	return {
		start,
		catalog,
		lookupModel,
		providers,
		providerSelection,
		settled,
		close
	};
}
function isRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** The fields the rest of the plugin reads from a stored model; the file is ours but may be edited or truncated. */
function isStoredModel(value) {
	if (!isRecord$2(value)) return false;
	return typeof value["id"] === "string" && value["id"] !== "" && typeof value["name"] === "string" && isRecord$2(value["capabilities"]) && isRecord$2(value["pricing"]) && typeof value["pricing"]["prompt"] === "number" && typeof value["pricing"]["completion"] === "number" && isRecord$2(value["subscription"]) && Array.isArray(value["providerIds"]) && Array.isArray(value["reasoningEfforts"]);
}
// src/server/context.ts
function unknownBilling() {
	return {
		outcome: "unknown",
		markupPercent: 0,
		subscriptionSafe: false,
		reasons: [],
		stripped: []
	};
}
/** `RequestHints` from the HINT_HEADERS of a request (header names lower case). */
function parseHints(headers) {
	const first = (name) => {
		const raw = headers[name];
		const value = Array.isArray(raw) ? raw[0] : raw;
		return typeof value === "string" && value.trim() ? value.trim().slice(0, 40) : null;
	};
	const consumer = first(HINT_HEADERS.consumer);
	const thoughts = first(HINT_HEADERS.thoughts);
	return {
		effort: first(HINT_HEADERS.effort),
		consumer: consumer === "main" || consumer === "background" ? consumer : "unknown",
		thoughts: thoughts === "1" || thoughts === "true"
	};
}
function createProxyContext(init) {
	const { connection, body } = init;
	const requestedModel = typeof body["model"] === "string" && body["model"] ? body["model"] : connection.modelId;
	const plan = {
		model: requestedModel,
		body: { ...body },
		headers: {},
		billing: unknownBilling(),
		warnings: []
	};
	return {
		localId: init.localId,
		startedAt: init.now,
		user: init.user,
		connection,
		key: init.key,
		model: init.model,
		hints: init.hints,
		body,
		stream: body["stream"] === true,
		signal: init.signal,
		plan,
		upstream: null,
		responseHeaders: {},
		usage: {
			at: init.now,
			connectionId: connection.id,
			requestId: null,
			model: requestedModel,
			billing: "unknown",
			costUsd: null,
			equivalentUsd: null,
			promptTokens: null,
			completionTokens: null,
			cachedTokens: null,
			reasoningTokens: null,
			latencyMs: 0,
			status: 0,
			stream: body["stream"] === true,
			consumer: init.hints.consumer,
			error: null
		}
	};
}
// src/server/pipeline/steps/model.ts
function chooseModel(ctx) {
	if (ctx.connection.modelLock) return ctx.connection.modelId;
	const requested = ctx.body["model"];
	return typeof requested === "string" && requested.trim() ? requested.trim() : ctx.connection.modelId;
}
function modelStep(ctx) {
	const model = chooseModel(ctx);
	ctx.plan.model = model;
	ctx.plan.body["model"] = model;
}
// src/server/pipeline/steps/strip-samplers.ts
/** Removes the neutral values from `body` in place and returns the names it removed. */
function stripNeutralSamplers(body) {
	const removed = [];
	for (const [name, value] of [
		["top_k", 0],
		["top_a", 0],
		["min_p", 0],
		["repetition_penalty", 1]
	]) if (body[name] === value) {
		delete body[name];
		removed.push(name);
	}
	const bias = body["logit_bias"];
	if (typeof bias === "object" && bias !== null && !Array.isArray(bias) && Object.keys(bias).length === 0) {
		delete body["logit_bias"];
		removed.push("logit_bias");
	}
	return removed;
}
function stripSamplersStep(ctx) {
	if (ctx.connection.stripNeutralSamplers) stripNeutralSamplers(ctx.plan.body);
}
// src/server/pipeline/index.ts
/** Run in order before the upstream call. */
var REQUEST_STEPS = [modelStep, stripSamplersStep];
/** Run once the upstream answer is complete. Empty in stage 0.1; usage and cost land here in stage 0.4. */
var RESPONSE_STEPS = [];
// src/server/secret-value.ts
var REDACTED = "[redacted]";
var SecretValue = class {
	#value;
	constructor(value) {
		this.#value = value;
	}
	/** The secret itself. Call it only at the moment the value goes on the wire. */
	reveal() {
		return this.#value;
	}
	/** Replaces every occurrence of the secret in a text (an upstream error message, say). */
	redact(text) {
		return this.#value && text.includes(this.#value) ? text.split(this.#value).join(REDACTED) : text;
	}
	toJSON() {
		return REDACTED;
	}
	toString() {
		return REDACTED;
	}
	[Symbol.for("nodejs.util.inspect.custom")]() {
		return "SecretValue [redacted]";
	}
};
/** Masks a secret for display: at most the first 8 and the last 4 characters, fewer for short values. */
function maskSecret(value) {
	if (!value) return "";
	const head = Math.min(8, Math.floor(value.length / 3));
	const tail = Math.min(4, Math.floor(value.length / 4));
	return `${value.slice(0, head)}…${tail > 0 ? value.slice(value.length - tail) : ""}`;
}
// src/server/tokens.ts
function generateToken() {
	return randomBytes(32).toString("base64url");
}
function hashToken(token) {
	return createHash("sha256").update(token, "utf8").digest("hex");
}
var ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** A new connection id, [a-z0-9]{8}, not among `taken`. */
function generateConnectionId(taken) {
	for (;;) {
		let id = "";
		for (let i = 0; i < 8; i++) id += ID_ALPHABET[randomInt(36)];
		if (!taken.has(id)) return id;
	}
}
function tokenLabel(connection) {
	return SECRET_LABEL_PREFIX + connection.name;
}
function createTokenService(deps) {
	const { st, store } = deps;
	const entriesOf = (user, connectionId) => {
		const out = [];
		for (const [hash, entry] of Object.entries(store.registry.read().tokens)) if (entry.userHandle === user && entry.connectionId === connectionId) out.push([hash, entry.tokenSecretId]);
		return out;
	};
	const secretExists = (user, id) => !!id && st.listSecrets(user, "api_key_custom").some((s) => s.id === id);
	const dropSecret = (user, id) => {
		if (!id) return;
		try {
			st.deleteSecret(user, SECRET_KEY_CUSTOM, id);
		} catch {}
	};
	const create = (user, connection) => {
		const token = generateToken();
		const secretId = st.writeSecret(user, SECRET_KEY_CUSTOM, token, tokenLabel(connection), { keepActive: true });
		try {
			const hash = hashToken(token);
			store.registry.mutate((registry) => {
				registry.tokens[hash] = {
					connectionId: connection.id,
					userHandle: user,
					tokenSecretId: secretId
				};
			});
		} catch (error) {
			dropSecret(user, secretId);
			throw error;
		}
		return secretId;
	};
	const service = {
		secretId(user, connectionId) {
			if (!st.available) return null;
			const existing = entriesOf(user, connectionId).find(([, id]) => secretExists(user, id));
			return existing ? existing[1] : null;
		},
		ensure(user, connection) {
			if (!st.available) return null;
			const current = service.secretId(user, connection.id);
			if (current) return current;
			service.revoke(user, connection.id);
			return create(user, connection);
		},
		rotate(user, connection) {
			if (!st.available) return null;
			const old = entriesOf(user, connection.id);
			const secretId = create(user, connection);
			store.registry.mutate((registry) => {
				for (const [hash] of old) delete registry.tokens[hash];
			});
			for (const [, id] of old) dropSecret(user, id);
			return secretId;
		},
		revoke(user, connectionId) {
			const old = entriesOf(user, connectionId);
			if (old.length > 0) store.registry.mutate((registry) => {
				for (const [hash] of old) delete registry.tokens[hash];
			});
			if (st.available) for (const [, id] of old) dropSecret(user, id);
		},
		relabel(user, connection) {
			if (!st.available) return;
			const id = service.secretId(user, connection.id);
			if (!id) return;
			try {
				st.renameSecret(user, SECRET_KEY_CUSTOM, id, tokenLabel(connection));
			} catch {}
		}
	};
	return service;
}
var ROUTE = /^\/c\/([a-z0-9]{6,16})\/v1\/(models|chat\/completions)\/?$/;
var REQUEST_ID_HEADERS = [
	"x-request-id",
	"x-nanogpt-request-id",
	"request-id"
];
function createProxyServer(deps, steps = {
	request: REQUEST_STEPS,
	response: RESPONSE_STEPS
}) {
	const { config, log } = deps;
	let state = {
		up: false,
		host: PROXY_HOST,
		port: config.port,
		error: null
	};
	const server = http.createServer((req, res) => {
		res.on("error", () => {});
		handle(req, res).catch((error) => {
			log.error(`proxy request failed (${describe$1(error)})`);
			if (!res.headersSent) sendError$1(res, 500, "server_error", "internal_error", "Internal error");
			else res.destroy();
		});
	});
	async function handle(req, res) {
		const pathname = (req.url ?? "/").split("?")[0] ?? "/";
		if (pathname === "/health") {
			if (req.method !== "GET") return sendMethodNotAllowed(res, "GET");
			return sendJson$1(res, 200, {
				ok: true,
				version: deps.version
			});
		}
		const match = ROUTE.exec(pathname);
		if (!match) return sendError$1(res, 404, "invalid_request_error", "not_found", "Unknown path");
		const connectionId = match[1];
		const endpoint = match[2];
		const wanted = endpoint === "models" ? "GET" : "POST";
		if (req.method !== wanted) return sendMethodNotAllowed(res, wanted);
		const auth = authenticate(req, connectionId);
		if (!auth.ok) return sendError$1(res, 401, "authentication_error", auth.code, auth.message);
		const connection = deps.store.connections.get(auth.userRoot, connectionId);
		if (!connection) return sendError$1(res, 404, "invalid_request_error", "connection_not_found", "This connection does not exist");
		if (endpoint === "models") return sendJson$1(res, 200, {
			object: "list",
			data: [{
				id: connection.modelId,
				object: "model",
				created: Math.floor(connection.createdAt / 1e3),
				owned_by: "nanogpt"
			}]
		}, { [RESPONSE_HEADERS.connection]: connection.id });
		await chatCompletions(req, res, auth.user, auth.userRoot, connection);
	}
	function authenticate(req, connectionId) {
		const token = presentedToken(req);
		if (!token) return {
			ok: false,
			code: "missing_token",
			message: "Missing proxy token"
		};
		const entry = deps.store.registry.lookup(hashToken(token));
		if (!entry || entry.connectionId !== connectionId) return {
			ok: false,
			code: "invalid_token",
			message: "Invalid proxy token for this connection"
		};
		try {
			return {
				ok: true,
				user: entry.userHandle,
				userRoot: deps.st.userRoot(entry.userHandle)
			};
		} catch {
			return {
				ok: false,
				code: "invalid_token",
				message: "Invalid proxy token for this connection"
			};
		}
	}
	async function chatCompletions(req, res, user, userRoot, connection) {
		const startedAt = deps.now();
		const clientAbort = new AbortController();
		res.on("close", () => {
			if (!res.writableFinished) clientAbort.abort();
		});
		const connectionHeader = { [RESPONSE_HEADERS.connection]: connection.id };
		/** Answers with an error before a context exists and keeps the attempt in the usage log. */
		const early = async (status, type, code, message, stream = false) => {
			sendError$1(res, status, type, code, message, connectionHeader);
			await deps.usage.append(userRoot, {
				...blankUsage(connection.id, connection.modelId, startedAt, deps.now()),
				status,
				stream,
				error: code
			});
		};
		const parsed = await readJsonBody(req);
		if (!parsed.ok) return early(parsed.status, "invalid_request_error", parsed.code, parsed.message);
		const incoming = parsed.value;
		const stream = incoming["stream"] === true;
		let key;
		try {
			key = resolveKey(user, connection.keyId);
		} catch {
			return early(500, "server_error", "secrets_error", "The secret store could not be read", stream);
		}
		if (!key) return early(409, "invalid_request_error", "no_key", connection.keyId ? "The NanoGPT key chosen for this connection no longer exists" : "No NanoGPT key is stored; add one in SillyTavern", stream);
		const ctx = createProxyContext({
			localId: randomBytes(4).toString("hex"),
			now: startedAt,
			user,
			connection,
			key,
			model: deps.lookupModel(typeof incoming["model"] === "string" ? incoming["model"] : connection.modelId),
			hints: parseHints(req.headers),
			body: incoming,
			signal: clientAbort.signal
		});
		try {
			for (const step of steps.request) await step(ctx);
		} catch (error) {
			log.error(`request step failed (${describe$1(error, key)})`);
			ctx.usage.model = ctx.plan.model;
			return finishWithError(ctx, res, userRoot, 500, "server_error", "internal_error", "Internal error");
		}
		ctx.usage.model = ctx.plan.model;
		let upstream;
		try {
			upstream = await callUpstream({
				fetch: deps.fetch,
				base: config.upstreamBase,
				fallbackBase: config.upstreamFallbackBase,
				body: JSON.stringify(ctx.plan.body),
				headers: ctx.plan.headers,
				key,
				stream: ctx.stream,
				timeoutMs: config.timeoutMs,
				signal: clientAbort.signal,
				userAgent: `Nanovia/${deps.version}`
			});
		} catch (error) {
			return failUpstream(ctx, res, userRoot, error);
		}
		try {
			await relay(ctx, upstream, res, userRoot);
		} finally {
			upstream.close();
		}
	}
	/** Passes the upstream answer to the client, runs the response steps and writes the usage record. */
	async function relay(ctx, upstream, res, userRoot) {
		const ok = upstream.status >= 200 && upstream.status < 300;
		const sse = ctx.stream && ok && (upstream.headers["content-type"] ?? "").includes("text/event-stream");
		const info = {
			status: upstream.status,
			headers: upstream.headers,
			requestId: firstHeader(upstream.headers, REQUEST_ID_HEADERS),
			base: upstream.base,
			stream: sse,
			body: null
		};
		ctx.upstream = info;
		ctx.usage.requestId = info.requestId;
		if (sse) {
			let failure = null;
			res.writeHead(info.status, clientHeaders(ctx, info, true));
			res.flushHeaders();
			res.socket?.setNoDelay(true);
			try {
				for await (const chunk of upstream.body) {
					upstream.touch();
					await writeChunk(res, chunk);
					if (clientGone(ctx)) break;
				}
			} catch (error) {
				failure = error instanceof UpstreamError ? error : new UpstreamError("unreachable", null);
			}
			if (failure && failure.kind !== "aborted" && !res.destroyed) {
				const text = failure.kind === "timeout" ? "The upstream stopped sending data" : "The upstream connection broke";
				const code = failure.kind === "timeout" ? "upstream_timeout" : "upstream_unreachable";
				res.write(`data: ${JSON.stringify(errorBody("upstream_error", code, text))}\n\n`);
			}
			const aborted = clientGone(ctx) || failure?.kind === "aborted";
			ctx.usage.status = aborted ? 499 : failure ? failure.kind === "timeout" ? 504 : 502 : info.status;
			ctx.usage.error = aborted ? "client_closed" : failure ? failure.kind === "timeout" ? "upstream_timeout" : "upstream_unreachable" : null;
			if (!res.writableEnded && !res.destroyed) res.end();
			await runResponseSteps(ctx);
			await finish(ctx, userRoot);
			return;
		}
		const chunks = [];
		try {
			for await (const chunk of upstream.body) {
				upstream.touch();
				chunks.push(Buffer.from(chunk));
			}
		} catch (error) {
			return failUpstream(ctx, res, userRoot, error);
		}
		let body = Buffer.concat(chunks);
		if (!ok) body = normalizeErrorBody(info.status, body, ctx.key);
		info.body = body;
		ctx.usage.status = info.status;
		if (!ok) ctx.usage.error = upstreamErrorCode(body) ?? `http_${info.status}`;
		await runResponseSteps(ctx);
		const out = info.body ?? Buffer.alloc(0);
		if (!res.destroyed) {
			res.writeHead(info.status, {
				...clientHeaders(ctx, info, false),
				"content-length": String(out.length)
			});
			res.end(out);
		}
		await finish(ctx, userRoot);
	}
	function clientGone(ctx) {
		return ctx.signal.aborted;
	}
	async function runResponseSteps(ctx) {
		for (const step of steps.response) try {
			await step(ctx);
		} catch (error) {
			log.warn(`response step failed (${describe$1(error, ctx.key)})`);
		}
	}
	async function finish(ctx, userRoot) {
		ctx.usage.latencyMs = Math.max(0, deps.now() - ctx.startedAt);
		await deps.usage.append(userRoot, ctx.usage);
	}
	async function finishWithError(ctx, res, userRoot, status, type, code, message) {
		sendError$1(res, status, type, code, message, { [RESPONSE_HEADERS.connection]: ctx.connection.id });
		ctx.usage.status = status;
		ctx.usage.error = code;
		await finish(ctx, userRoot);
	}
	async function failUpstream(ctx, res, userRoot, error) {
		const failure = error instanceof UpstreamError ? error : new UpstreamError("unreachable", null);
		if (failure.kind === "aborted") {
			ctx.usage.status = 499;
			ctx.usage.error = "client_closed";
			return finish(ctx, userRoot);
		}
		const timeout = failure.kind === "timeout";
		const code = timeout ? "upstream_timeout" : "upstream_unreachable";
		log.warn(`upstream ${failure.kind} for connection ${ctx.connection.id}${failure.code ? ` (${failure.code})` : ""}`);
		return finishWithError(ctx, res, userRoot, timeout ? 504 : 502, "upstream_error", code, timeout ? "NanoGPT did not answer in time" : "NanoGPT could not be reached");
	}
	function resolveKey(user, keyId) {
		if (!deps.st.available) return config.nanogptKey ? new SecretValue(config.nanogptKey) : null;
		const value = deps.st.readSecret(user, SECRET_KEY_NANOGPT, keyId);
		return value ? new SecretValue(value) : null;
	}
	return {
		status: () => state,
		listen() {
			return new Promise((resolve) => {
				const onError = (error) => {
					state = {
						up: false,
						host: PROXY_HOST,
						port: config.port,
						error: error.code ?? "ERROR"
					};
					log.error(error.code === "EADDRINUSE" ? `port ${config.port} is already in use: the proxy is not running (set NANOVIA_PORT or "port" in config.json)` : `the proxy listener failed (${error.code ?? error.message})`);
					resolve(state);
				};
				server.once("error", onError);
				server.listen(config.port, PROXY_HOST, () => {
					server.off("error", onError);
					server.on("error", (error) => log.error(`proxy listener error (${error.code ?? error.message})`));
					state = {
						up: true,
						host: PROXY_HOST,
						port: server.address().port,
						error: null
					};
					resolve(state);
				});
			});
		},
		close() {
			return new Promise((resolve) => {
				const wasUp = state.up;
				state = {
					...state,
					up: false
				};
				if (!wasUp) return resolve();
				server.close(() => resolve());
				server.closeAllConnections();
			});
		}
	};
}
function presentedToken(req) {
	const authorization = req.headers["authorization"];
	if (typeof authorization === "string") {
		const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
		if (m?.[1]) return m[1];
	}
	const apiKey = req.headers["x-api-key"];
	if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim();
	return null;
}
function readJsonBody(req) {
	return new Promise((resolve) => {
		const declared = Number(req.headers["content-length"]);
		if (Number.isFinite(declared) && declared > 33554432) {
			resolve(tooLarge());
			return;
		}
		const chunks = [];
		let size = 0;
		let done = false;
		let overflow = false;
		const settle = (result) => {
			if (done) return;
			done = true;
			resolve(result);
		};
		req.on("data", (chunk) => {
			if (overflow) return;
			size += chunk.length;
			if (size > 33554432) {
				overflow = true;
				chunks.length = 0;
				settle(tooLarge());
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (size === 0) {
				settle(invalid("invalid_json", "The request body is empty"));
				return;
			}
			let value;
			try {
				value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				settle(invalid("invalid_json", "The request body is not valid JSON"));
				return;
			}
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				settle(invalid("invalid_request", "The request body must be a JSON object"));
				return;
			}
			settle({
				ok: true,
				value
			});
		});
		req.on("error", () => settle(invalid("invalid_request", "The request could not be read")));
		req.on("close", () => settle(invalid("invalid_request", "The request was cut off")));
	});
}
function invalid(code, message) {
	return {
		ok: false,
		status: 400,
		code,
		message
	};
}
function tooLarge() {
	return {
		ok: false,
		status: 413,
		code: "payload_too_large",
		message: "The request body is larger than 32 MiB"
	};
}
function blankUsage(connectionId, model, startedAt, now) {
	return {
		at: startedAt,
		connectionId,
		requestId: null,
		model,
		billing: "unknown",
		costUsd: null,
		equivalentUsd: null,
		promptTokens: null,
		completionTokens: null,
		cachedTokens: null,
		reasoningTokens: null,
		latencyMs: Math.max(0, now - startedAt),
		status: 0,
		stream: false,
		consumer: "unknown",
		error: null
	};
}
function errorBody(type, code, message) {
	return { error: {
		message,
		type,
		code
	} };
}
function sendJson$1(res, status, body, headers = {}) {
	if (res.headersSent || res.destroyed) return;
	const payload = Buffer.from(JSON.stringify(body));
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(payload.length),
		"cache-control": "no-store",
		...headers
	});
	res.end(payload);
}
function sendError$1(res, status, type, code, message, headers = {}) {
	sendJson$1(res, status, errorBody(type, code, message), {
		...headers,
		...status === 413 ? { connection: "close" } : {}
	});
}
function sendMethodNotAllowed(res, allow) {
	sendError$1(res, 405, "invalid_request_error", "method_not_allowed", "Method not allowed", { allow });
}
/** Headers of the reply to the client: what the upstream said about the content, plus ours. */
function clientHeaders(ctx, info, stream) {
	const headers = {};
	headers["content-type"] = info.headers["content-type"] ?? (stream ? "text/event-stream" : "application/json");
	const cacheControl = info.headers["cache-control"];
	if (cacheControl) headers["cache-control"] = cacheControl;
	else if (stream) headers["cache-control"] = "no-cache";
	if (stream) headers["x-accel-buffering"] = "no";
	const retryAfter = info.headers["retry-after"];
	if (retryAfter && info.status >= 400) headers["retry-after"] = headerSafe(retryAfter);
	headers[RESPONSE_HEADERS.connection] = ctx.connection.id;
	headers[RESPONSE_HEADERS.billing] = ctx.plan.billing.outcome;
	if (info.requestId) headers[RESPONSE_HEADERS.requestId] = headerSafe(info.requestId);
	if (ctx.plan.warnings.length > 0) headers[RESPONSE_HEADERS.warnings] = headerSafe(ctx.plan.warnings.map((w) => w.code).join(","));
	for (const [name, value] of Object.entries(ctx.responseHeaders)) headers[name.toLowerCase()] = headerSafe(value);
	return headers;
}
function headerSafe(value) {
	return value.replace(/[^\x20-\x7e]/g, "").slice(0, 500);
}
function firstHeader(headers, names) {
	for (const name of names) {
		const value = headers[name];
		if (value) return value;
	}
	return null;
}
/** Writes a chunk and waits for the socket to drain, so a slow client slows the upstream read instead of buffering. */
function writeChunk(res, chunk) {
	if (res.destroyed || res.writableEnded) return Promise.resolve();
	if (res.write(chunk)) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			res.off("drain", done);
			res.off("close", done);
			resolve();
		};
		res.once("drain", done);
		res.once("close", done);
	});
}
/**
* A non-2xx upstream body goes through untouched when it is already an OpenAI-shaped error; anything else (an HTML page
* from a gateway, plain text) is wrapped into that shape so every client can read it.
*/
function normalizeErrorBody(status, body, key) {
	try {
		const parsed = JSON.parse(body.toString("utf8"));
		if (typeof parsed === "object" && parsed !== null && "error" in parsed) return body;
	} catch {}
	const text = key.redact(body.toString("utf8")).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
	const message = text ? `NanoGPT answered HTTP ${status}: ${text}` : `NanoGPT answered HTTP ${status}`;
	return Buffer.from(JSON.stringify(errorBody("upstream_error", "upstream_error", message)));
}
function upstreamErrorCode(body) {
	try {
		const code = JSON.parse(body.toString("utf8"))?.error?.code;
		if (typeof code === "string" && code) return code.slice(0, 80);
		if (typeof code === "number") return String(code);
	} catch {}
	return null;
}
function describe$1(error, key) {
	const text = error instanceof Error ? error.message : "unknown error";
	return key ? key.redact(text) : text;
}
// src/domain/catalog-hints.ts
/** Lower-cased fragments of the model id that put a model in a family. */
var GLM_ID_MARKERS = ["glm"];
var DEEPSEEK_V4_ID_MARKERS = ["deepseek-v4"];
var UNCENSORED_ID_MARKERS = [
	"uncensored",
	"abliterated",
	"heretic"
];
var UNCENSORED_CATEGORY = "uncensored";
/** The precision GLM's own (official) hosts serve; hosts below it are re-quantised copies. */
var GLM_REFERENCE_QUANTIZATION = "fp8";
/** DeepSeek V4 experts are natively MXFP4: that label is the original, any other 4-bit label is a re-quantisation. */
var DEEPSEEK_NATIVE_LABEL = "mxfp4";
/** `hosts.few` fires at this many hosts or fewer (but at least one). */
var FEW_HOSTS_MAX = 2;
/** `cache.lowRate` fires below this share of the prompt read from cache under automatic routing. */
var LOW_CACHE_RATE = .6;
/** The reasoning ladder, lowest first. */
var EFFORT_ORDER = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
function idHas(model, markers) {
	const id = model.id.toLowerCase();
	return markers.some((m) => id.includes(m));
}
function names(hosts) {
	return hosts.map((h) => h.id).join(", ");
}
/** The number of hosts the model has: the loaded list when there is one, else what the catalog entry names. */
function hostCount(ctx) {
	return ctx.mp ? ctx.mp.providers.length : ctx.model.providerIds.length;
}
/** The rule table, in the order the hints are listed (warnings are moved to the front, the order inside is kept). */
var HINT_RULES = [
	{
		code: "quant.glmFp8",
		severity: "warn",
		evaluate({ model, mp }) {
			if (!idHas(model, GLM_ID_MARKERS)) return null;
			const suggestion = {
				enabled: true,
				minQuantization: GLM_REFERENCE_QUANTIZATION
			};
			if (!mp) {
				if (model.providerIds.length === 0) return null;
				return {
					severity: "info",
					params: {
						model: model.id,
						hostsKnown: false
					},
					suggestedRouting: suggestion
				};
			}
			const low = mp.providers.filter((h) => meetsMinQuantization(h.quantization, GLM_REFERENCE_QUANTIZATION) === false);
			if (low.length === 0) return null;
			const unknown = mp.providers.filter((h) => meetsMinQuantization(h.quantization, GLM_REFERENCE_QUANTIZATION) === null);
			const ok = mp.providers.length - low.length - unknown.length;
			const params = {
				model: model.id,
				hostsKnown: true,
				lowHosts: low.length,
				low: names(low),
				unknownHosts: unknown.length,
				okHosts: ok
			};
			return ok > 0 ? {
				params,
				suggestedRouting: suggestion
			} : { params };
		}
	},
	{
		code: "quant.deepseekNative",
		severity: "warn",
		evaluate({ model, mp }) {
			if (!mp || !idHas(model, DEEPSEEK_V4_ID_MARKERS)) return null;
			const fourBit = mp.providers.filter((h) => h.quantization === "fp4" || h.quantization === "int4");
			const suspicious = fourBit.filter((h) => (h.rawQuantization ?? "").toLowerCase() !== DEEPSEEK_NATIVE_LABEL);
			if (suspicious.length === 0) return null;
			return {
				params: {
					model: model.id,
					suspiciousHosts: suspicious.length,
					suspicious: names(suspicious),
					nativeHosts: fourBit.length - suspicious.length
				},
				suggestedRouting: {
					enabled: true,
					ignore: suspicious.map((h) => h.id)
				}
			};
		}
	},
	{
		code: "hosts.few",
		severity: "warn",
		evaluate(ctx) {
			const count = hostCount(ctx);
			return count >= 1 && count <= FEW_HOSTS_MAX ? { params: { hosts: count } } : null;
		}
	},
	{
		code: "routing.fixedRoute",
		severity: "info",
		evaluate({ model, mp }) {
			return mp?.supportsProviderSelection === false ? { params: { model: model.id } } : null;
		}
	},
	{
		code: "cache.lowRate",
		severity: "info",
		evaluate({ mp }) {
			const rate = mp?.autoCacheReadRate;
			return rate !== null && rate !== void 0 && rate < LOW_CACHE_RATE ? { params: {
				percent: Math.round(rate * 100),
				threshold: Math.round(LOW_CACHE_RATE * 100)
			} } : null;
		}
	},
	{
		code: "reasoning.alwaysOn",
		severity: "info",
		evaluate({ model }) {
			const efforts = model.reasoningEfforts;
			if (efforts.length === 0 || efforts.includes("none")) return null;
			const rank = (e) => {
				const i = EFFORT_ORDER.indexOf(e);
				return i < 0 ? EFFORT_ORDER.length : i;
			};
			const lowest = [...efforts].sort((a, b) => rank(a) - rank(b))[0] ?? "";
			return { params: {
				efforts: efforts.join(", "),
				lowest
			} };
		}
	},
	{
		code: "shelf.uncensoredUnmeasured",
		severity: "info",
		evaluate({ model }) {
			const byShelf = (model.category ?? "").toLowerCase() === UNCENSORED_CATEGORY;
			if (!byShelf && !idHas(model, UNCENSORED_ID_MARKERS)) return null;
			return { params: {
				model: model.id,
				byShelf
			} };
		}
	}
];
/** Added after the rules when a suggestion would leave the subscription (explicit routing is billed with a markup). */
var BILLING_BYPASS_CODE = "billing.bypass";
[...HINT_RULES.map((r) => r.code)];
/**
* Hints for one model. `mp` is the loaded host list or null; rules that need hosts stay quiet without it. Warnings come
* first, then infos, each group in table order; `billing.bypass` closes the list when a subscription-included model gets
* a suggested routing.
*/
function routingHints(model, mp) {
	const hints = [];
	for (const rule of HINT_RULES) {
		const outcome = rule.evaluate({
			model,
			mp
		});
		if (!outcome) continue;
		const hint = {
			code: rule.code,
			severity: outcome.severity ?? rule.severity,
			params: outcome.params
		};
		if (outcome.suggestedRouting) hint.suggestedRouting = outcome.suggestedRouting;
		hints.push(hint);
	}
	if (model.subscription.included && hints.some((h) => h.suggestedRouting)) {
		const source = hints.find((h) => h.suggestedRouting);
		hints.push({
			code: BILLING_BYPASS_CODE,
			severity: "info",
			params: {
				markupPercent: 5,
				because: source?.code ?? ""
			}
		});
	}
	const rank = (h) => h.severity === "warn" ? 0 : 1;
	return hints.sort((a, b) => rank(a) - rank(b));
}
// src/server/routes/http.ts
var DEFAULT_USER_HANDLE = "default-user";
function userOf(req, deps) {
	const raw = req.user?.profile?.handle;
	const handle = typeof raw === "string" && raw ? raw : DEFAULT_USER_HANDLE;
	const root = req.user?.directories?.root;
	return {
		handle,
		root: typeof root === "string" && root ? root : deps.st.userRoot(handle)
	};
}
var HttpError = class extends Error {
	status;
	code;
	constructor(status, code, message) {
		super(message);
		this.status = status;
		this.code = code;
		this.name = "HttpError";
	}
};
function sendJson(res, status, body) {
	res.set("Cache-Control", "no-store");
	res.status(status).json(body);
}
function sendError(res, status, code, message) {
	sendJson(res, status, { error: {
		code,
		message
	} });
}
/** Wraps a handler: HttpError becomes its status, anything else a generic 500 (the message is not echoed). */
function route(log, handler) {
	return async (req, res) => {
		try {
			await handler(req, res);
		} catch (error) {
			if (error instanceof HttpError) return sendError(res, error.status, error.code, error.message);
			log.error(`admin route failed (${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"})`);
			sendError(res, 500, "internal_error", "Internal error");
		}
	};
}
function bodyObject(req) {
	const body = req.body;
	if (body === void 0 || body === null) return {};
	if (typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_request", "The request body must be a JSON object");
	return body;
}
// src/server/routes/catalog.ts
var MAX_MODEL_ID_LENGTH = 300;
/** `?id=` wins over the path segment; Express has already decoded both. */
function modelIdOf(req) {
	const fromQuery = req.query?.["id"];
	const raw = typeof fromQuery === "string" && fromQuery.trim() ? fromQuery : req.params["id"];
	const id = typeof raw === "string" ? raw.trim() : "";
	if (!id || id.length > MAX_MODEL_ID_LENGTH || /\p{Cc}/u.test(id)) throw new HttpError(400, "invalid_request", "A model id is required");
	return id;
}
function wantsRefresh(req) {
	const value = req.query?.["refresh"];
	return value === "1" || value === "true";
}
var catalogRoutes = (router, deps) => {
	const catalog = deps.catalog;
	if (!catalog) return;
	const providersHandler = route(deps.log, async (req, res) => {
		const result = await catalog.providers(modelIdOf(req), { refresh: wantsRefresh(req) });
		if (result.ok) return sendJson(res, 200, result.value);
		if (result.reason === "not_found") throw new HttpError(404, "model_not_found", "NanoGPT does not know this model");
		throw new HttpError(502, "providers_unavailable", "The host list of this model could not be fetched from NanoGPT");
	});
	const hintsHandler = route(deps.log, async (req, res) => {
		const id = modelIdOf(req);
		let model = catalog.lookupModel(id);
		if (!model) {
			if (!await catalog.catalog()) throw new HttpError(502, "catalog_unavailable", "The NanoGPT catalog is unavailable and no copy is stored");
			model = catalog.lookupModel(id);
			if (!model) throw new HttpError(404, "model_not_found", "This model is not in the catalog");
		}
		const providers = await catalog.providers(model.id);
		const mp = providers.ok ? providers.value : null;
		sendJson(res, 200, { hints: routingHints(model, mp) });
	});
	router.get("/catalog", route(deps.log, async (req, res) => {
		const result = await catalog.catalog({ refresh: wantsRefresh(req) });
		if (!result) throw new HttpError(502, "catalog_unavailable", "The NanoGPT catalog is unavailable and no copy is stored");
		sendJson(res, 200, result);
	}));
	router.get("/catalog/providers", providersHandler);
	router.get("/catalog/hints", hintsHandler);
	router.get("/catalog/:id/providers", providersHandler);
	router.get("/catalog/:id/hints", hintsHandler);
};
// src/server/routes/connections.ts
var MODES = [
	"auto",
	"plugin",
	"direct"
];
var BILLING = [
	"auto",
	"subscription",
	"paygo"
];
var BOOLEAN_FIELDS = [
	"modelLock",
	"webSearch",
	"stripNeutralSamplers"
];
var OBJECT_FIELDS = [
	"routing",
	"reasoning",
	"memory"
];
function toView(deps, user, connection) {
	const proxy = deps.proxy();
	return {
		...connection,
		proxyUrl: `http://${proxy.host}:${proxy.port}/c/${connection.id}/v1`,
		directUrl: NANOGPT_API_BASE,
		tokenSecretId: connection.mode === "direct" ? null : deps.tokens.secretId(user.handle, connection.id)
	};
}
/** Checks the types of the fields a client may send; values inside routing/reasoning/memory are merged leniently. */
function validateInput(body, create) {
	const patch = {};
	for (const field of ["name", "modelId"]) {
		const value = body[field];
		if (value === void 0 && !create) continue;
		if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "invalid_request", `"${field}" must be a non-empty string`);
		patch[field] = value;
	}
	for (const field of BOOLEAN_FIELDS) {
		const value = body[field];
		if (value === void 0) continue;
		if (typeof value !== "boolean") throw new HttpError(400, "invalid_request", `"${field}" must be a boolean`);
		patch[field] = value;
	}
	for (const [field, allowed] of [["mode", MODES], ["billing", BILLING]]) {
		const value = body[field];
		if (value === void 0) continue;
		if (typeof value !== "string" || !allowed.includes(value)) throw new HttpError(400, "invalid_request", `"${field}" must be one of: ${allowed.join(", ")}`);
		patch[field] = value;
	}
	if (body["keyId"] !== void 0) {
		const value = body["keyId"];
		if (value !== null && (typeof value !== "string" || !value.trim())) throw new HttpError(400, "invalid_request", "\"keyId\" must be a non-empty string or null");
		patch["keyId"] = value;
	}
	if (body["note"] !== void 0) {
		if (typeof body["note"] !== "string") throw new HttpError(400, "invalid_request", "\"note\" must be a string");
		patch["note"] = body["note"];
	}
	for (const field of OBJECT_FIELDS) {
		const value = body[field];
		if (value === void 0) continue;
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "invalid_request", `"${field}" must be an object`);
		patch[field] = value;
	}
	return patch;
}
function tokenFailure(error) {
	if (error instanceof HttpError) throw error;
	throw new HttpError(500, "secrets_failed", "The proxy token could not be stored");
}
var connectionRoutes = (router, deps) => {
	const { store, tokens, st } = deps;
	router.get("/connections", route(deps.log, (req, res) => {
		const user = userOf(req, deps);
		sendJson(res, 200, { connections: store.connections.list(user.root).map((c) => toView(deps, user, c)) });
	}));
	router.post("/connections", route(deps.log, (req, res) => {
		const user = userOf(req, deps);
		const patch = validateInput(bodyObject(req), true);
		const list = store.connections.list(user.root);
		const connection = createConnection(patch, generateConnectionId(new Set(list.map((c) => c.id))), deps.now());
		if (connection.mode !== "direct") try {
			tokens.ensure(user.handle, connection);
		} catch (error) {
			tokenFailure(error);
		}
		try {
			store.connections.save(user.root, [...list, connection]);
		} catch (error) {
			tokens.revoke(user.handle, connection.id);
			throw error;
		}
		sendJson(res, 200, { connection: toView(deps, user, connection) });
	}));
	router.put("/connections/:id", route(deps.log, (req, res) => {
		const user = userOf(req, deps);
		const list = store.connections.list(user.root);
		const index = list.findIndex((c) => c.id === req.params["id"]);
		const existing = list[index];
		if (!existing) throw new HttpError(404, "not_found", "Unknown connection");
		const next = mergeConnection(existing, validateInput(bodyObject(req), false), deps.now());
		const proxied = next.mode !== "direct";
		if (proxied) try {
			tokens.ensure(user.handle, next);
			if (next.name !== existing.name) tokens.relabel(user.handle, next);
		} catch (error) {
			tokenFailure(error);
		}
		list[index] = next;
		store.connections.save(user.root, list);
		if (!proxied && existing.mode !== "direct") tokens.revoke(user.handle, next.id);
		sendJson(res, 200, { connection: toView(deps, user, next) });
	}));
	router.delete("/connections/:id", route(deps.log, (req, res) => {
		const user = userOf(req, deps);
		const list = store.connections.list(user.root);
		const existing = list.find((c) => c.id === req.params["id"]);
		if (!existing) throw new HttpError(404, "not_found", "Unknown connection");
		store.connections.save(user.root, list.filter((c) => c.id !== existing.id));
		tokens.revoke(user.handle, existing.id);
		sendJson(res, 200, { ok: true });
	}));
	router.post("/connections/:id/rotate-token", route(deps.log, (req, res) => {
		const user = userOf(req, deps);
		const existing = store.connections.get(user.root, req.params["id"] ?? "");
		if (!existing) throw new HttpError(404, "not_found", "Unknown connection");
		if (existing.mode === "direct") throw new HttpError(409, "direct_mode", "A connection in direct mode has no proxy token");
		if (!st.available) throw new HttpError(503, "secrets_unavailable", "ST secret store is unavailable");
		try {
			tokens.rotate(user.handle, existing);
		} catch (error) {
			tokenFailure(error);
		}
		sendJson(res, 200, { connection: toView(deps, user, existing) });
	}));
};
// src/server/routes/keys.ts
var MAX_KEY_LENGTH = 512;
var MAX_LABEL_LENGTH = 100;
var DEFAULT_LABEL = "NanoGPT";
var CHECK_TIMEOUT_MS = 15e3;
function toInfo(entry) {
	return {
		id: entry.id,
		label: entry.label,
		active: entry.active,
		masked: maskSecret(entry.value ?? "")
	};
}
var keyRoutes = (router, deps) => {
	const { st } = deps;
	const requireSecrets = () => {
		if (!st.available) throw new HttpError(503, "secrets_unavailable", "ST secret store is unavailable");
	};
	router.get("/keys", route(deps.log, (req, res) => {
		const user = userOf(req, deps);
		sendJson(res, 200, { keys: st.available ? st.listSecrets(user.handle, SECRET_KEY_NANOGPT).map(toInfo) : [] });
	}));
	router.post("/keys", route(deps.log, (req, res) => {
		requireSecrets();
		const user = userOf(req, deps);
		const body = bodyObject(req);
		const value = typeof body["value"] === "string" ? body["value"].trim() : "";
		if (!value || value.length > MAX_KEY_LENGTH || /[\u0000-\u001f\u007f\s]/.test(value)) throw new HttpError(400, "invalid_request", "\"value\" must be a key without spaces or line breaks");
		const rawLabel = body["label"];
		if (rawLabel !== void 0 && typeof rawLabel !== "string") throw new HttpError(400, "invalid_request", "\"label\" must be a string");
		const label = (typeof rawLabel === "string" ? rawLabel.trim() : "").slice(0, MAX_LABEL_LENGTH) || DEFAULT_LABEL;
		const id = st.writeSecret(user.handle, SECRET_KEY_NANOGPT, value, label);
		const written = st.listSecrets(user.handle, SECRET_KEY_NANOGPT).find((s) => s.id === id);
		sendJson(res, 200, { key: written ? toInfo(written) : {
			id,
			label,
			active: true,
			masked: maskSecret(value)
		} });
	}));
	router.delete("/keys/:id", route(deps.log, (req, res) => {
		requireSecrets();
		const user = userOf(req, deps);
		const id = req.params["id"] ?? "";
		if (!id || !st.listSecrets(user.handle, "api_key_nanogpt").some((s) => s.id === id)) throw new HttpError(404, "not_found", "Unknown key");
		st.deleteSecret(user.handle, SECRET_KEY_NANOGPT, id);
		sendJson(res, 200, { ok: true });
	}));
	router.post("/keys/:id/check", route(deps.log, async (req, res) => {
		requireSecrets();
		const user = userOf(req, deps);
		const id = req.params["id"] ?? "";
		const entry = st.listSecrets(user.handle, SECRET_KEY_NANOGPT).find((s) => s.id === id);
		const value = id && entry ? st.readSecret(user.handle, SECRET_KEY_NANOGPT, id) : "";
		if (!value) throw new HttpError(404, "not_found", "Unknown key");
		sendJson(res, 200, await checkBalance(deps, new SecretValue(value)));
	}));
};
/** `POST <site>/api/check-balance` with the key in `x-api-key`. Never throws; the outcome is the KeyCheck. */
async function checkBalance(deps, key) {
	const failed = (error) => ({
		ok: false,
		usdBalance: null,
		nanoBalance: null,
		error
	});
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
	timer.unref?.();
	try {
		const response = await deps.fetch(`${deps.config.siteBase}/api/check-balance`, {
			method: "POST",
			headers: {
				"x-api-key": key.reveal(),
				accept: "application/json",
				"content-type": "application/json"
			},
			body: "{}",
			signal: controller.signal
		});
		const text = key.redact(await response.text());
		let parsed = {};
		try {
			const json = JSON.parse(text);
			if (typeof json === "object" && json !== null && !Array.isArray(json)) parsed = json;
		} catch {}
		if (response.status < 200 || response.status >= 300) {
			const detail = typeof parsed["error"] === "string" ? parsed["error"] : typeof parsed["message"] === "string" ? parsed["message"] : "";
			return failed(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
		}
		const usd = amount(parsed["usd_balance"] ?? parsed["usdBalance"]);
		const nano = amount(parsed["nano_balance"] ?? parsed["nanoBalance"]);
		if (usd === null && nano === null) return failed("The balance is missing in the answer");
		return {
			ok: true,
			usdBalance: usd,
			nanoBalance: nano,
			error: null
		};
	} catch {
		return failed(controller.signal.aborted ? "The balance check timed out" : "NanoGPT could not be reached");
	} finally {
		clearTimeout(timer);
	}
}
function amount(value) {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return null;
}
// src/server/routes/status.ts
var statusRoutes = (router, deps) => {
	router.get("/status", route(deps.log, (req, res) => {
		const proxy = deps.proxy();
		sendJson(res, 200, {
			version: deps.version,
			plugin: true,
			proxy: {
				up: proxy.up,
				host: proxy.host,
				port: proxy.port
			},
			secrets: deps.st.available,
			user: userOf(req, deps).handle
		});
	}));
};
// src/server/routes/index.ts
var ROUTE_MODULES = [
	statusRoutes,
	connectionRoutes,
	keyRoutes,
	catalogRoutes
];
// src/server/usage-log.ts
function usageFileName(at) {
	return `usage-${new Date(at).toISOString().slice(0, 10)}.jsonl`;
}
function createUsageLog(log) {
	return { async append(userRoot, record) {
		try {
			const dir = path.join(userRoot, USER_DIR_NAME);
			await fs$1.mkdir(dir, { recursive: true });
			await fs$1.appendFile(path.join(dir, usageFileName(record.at)), `${JSON.stringify(record)}\n`, "utf8");
		} catch (error) {
			log.warn(`usage record not written (${error instanceof Error ? error.message : "unknown error"})`);
		}
	} };
}
// src/server/version.ts
var PLUGIN_VERSION = "0.0.1";
// src/server/app.ts
/**
* Opens the stores, starts the proxy listener (a taken port is logged and leaves the proxy down; the admin routes
* still work) and registers the admin routes on `router`.
*/
async function startNanovia(router, options) {
	const { config, st, log } = options;
	const now = options.now ?? Date.now;
	const store = createStore({
		dataRoot: () => st.dataRoot(),
		now,
		log
	});
	let proxy = null;
	const version = options.version ?? PLUGIN_VERSION;
	const catalog = createCatalogService({
		...options.catalog,
		siteBase: config.siteBase,
		dataRoot: () => st.dataRoot(),
		fetch: options.fetch,
		version,
		now,
		log
	});
	const deps = {
		version,
		config,
		st,
		store,
		tokens: createTokenService({
			st,
			store
		}),
		usage: createUsageLog(log),
		fetch: options.fetch,
		proxy: () => proxy?.status() ?? {
			up: false,
			host: "127.0.0.1",
			port: config.port,
			error: null
		},
		catalog,
		lookupModel: options.lookupModel ?? ((modelId) => catalog.lookupModel(modelId)),
		providerSelection: options.providerSelection ?? ((modelId) => catalog.providerSelection(modelId)),
		now,
		log
	};
	catalog.start();
	proxy = options.steps ? createProxyServer(deps, options.steps) : createProxyServer(deps);
	const status = await proxy.listen();
	for (const register of options.routes ?? ROUTE_MODULES) register(router, deps);
	const running = proxy;
	return {
		deps,
		proxy: running,
		status,
		close: async () => {
			catalog.close();
			await running.close();
		}
	};
}
// src/server/config.ts
var DEFAULT_TIMEOUT_MS = 3e5;
var MIN_TIMEOUT_MS = 1e3;
var MAX_TIMEOUT_MS = 36e5;
function defaultConfig() {
	return {
		port: DEFAULT_PROXY_PORT,
		upstreamBase: NANOGPT_API_BASE,
		upstreamFallbackBase: NANOGPT_API_BASE_FALLBACK,
		siteBase: NANOGPT_SITE,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		nanogptKey: null
	};
}
/**
* @param fileText the content of config.json, or null when there is no file
* @param env the environment (process.env)
*/
function parseConfig(fileText, env) {
	const config = defaultConfig();
	const warnings = [];
	let file = {};
	if (fileText !== null) try {
		const parsed = JSON.parse(fileText);
		if (isRecord$1(parsed)) file = parsed;
		else warnings.push("config.json is not an object; ignored");
	} catch {
		warnings.push("config.json is not valid JSON; ignored");
	}
	const port = pick(file["port"], env["NANOVIA_PORT"]);
	if (port !== void 0) {
		const n = typeof port === "number" ? port : Number(String(port).trim());
		if (Number.isInteger(n) && n >= 0 && n <= 65535) config.port = n;
		else warnings.push("port is not an integer 0..65535; default used");
	}
	const upstream = pick(file["upstreamBase"], env["NANOVIA_UPSTREAM"]);
	let upstreamOverridden = false;
	if (upstream !== void 0) {
		const base = cleanBase(upstream);
		if (base) {
			config.upstreamBase = base;
			upstreamOverridden = true;
		} else warnings.push("upstreamBase is not an http(s) URL; default used");
	}
	if (upstreamOverridden) config.upstreamFallbackBase = null;
	if (file["upstreamFallbackBase"] === null) config.upstreamFallbackBase = null;
	else if (file["upstreamFallbackBase"] !== void 0) {
		const base = cleanBase(file["upstreamFallbackBase"]);
		if (base) config.upstreamFallbackBase = base;
		else warnings.push("upstreamFallbackBase is not an http(s) URL; ignored");
	}
	const site = pick(file["siteBase"], env["NANOVIA_SITE"]);
	if (site !== void 0) {
		const base = cleanBase(site);
		if (base) config.siteBase = base;
		else warnings.push("siteBase is not an http(s) URL; default used");
	}
	if (file["timeoutMs"] !== void 0) {
		const n = file["timeoutMs"];
		if (typeof n === "number" && Number.isFinite(n) && n >= MIN_TIMEOUT_MS && n <= MAX_TIMEOUT_MS) config.timeoutMs = Math.round(n);
		else warnings.push(`timeoutMs must be ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}; default used`);
	}
	if (typeof file["nanogptKey"] === "string" && file["nanogptKey"].trim()) config.nanogptKey = file["nanogptKey"].trim();
	return {
		config,
		warnings
	};
}
function pick(fileValue, envValue) {
	if (typeof envValue === "string" && envValue.trim()) return envValue;
	return fileValue;
}
/** `https://host/path/` -> `https://host/path`; null when it is not an http(s) URL. */
function cleanBase(value) {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
	} catch {
		return null;
	}
}
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
// src/server/st.ts
/** Default locations: two levels up from the plugin folder. */
function defaultStModuleUrls(base = import.meta.url) {
	return {
		secrets: new URL("../../src/endpoints/secrets.js", base).href,
		users: new URL("../../src/users.js", base).href
	};
}
/** A handle is a directory name; anything that could leave the data root is refused. */
function assertSafeHandle(handle) {
	if (!handle || handle === "." || handle === ".." || /[\\/\0]/.test(handle)) throw new Error("invalid user handle");
}
function currentDataRoot() {
	const root = globalThis.DATA_ROOT;
	return typeof root === "string" && root ? root : path.join(process.cwd(), "data");
}
/** The adapter when ST's internals are missing: no secrets, user directories under the data root. */
function createUnavailableSt() {
	return {
		available: false,
		dataRoot: currentDataRoot,
		userRoot(handle) {
			assertSafeHandle(handle);
			return path.join(currentDataRoot(), handle);
		},
		listSecrets: () => [],
		readSecret: () => "",
		writeSecret() {
			throw new Error("the ST secret store is unavailable");
		},
		renameSecret() {},
		deleteSecret() {}
	};
}
function createStServicesFromModules(secrets, users) {
	const manager = (handle) => {
		assertSafeHandle(handle);
		return new secrets.SecretManager(users.getUserDirectories(handle));
	};
	return {
		available: true,
		dataRoot: currentDataRoot,
		userRoot(handle) {
			assertSafeHandle(handle);
			return users.getUserDirectories(handle).root;
		},
		listSecrets(handle, key) {
			const all = manager(handle).getAllSecrets()[key];
			if (!Array.isArray(all)) return [];
			const out = [];
			for (const item of all) {
				if (!isRecord(item) || typeof item["id"] !== "string") continue;
				out.push({
					id: item["id"],
					label: typeof item["label"] === "string" ? item["label"] : "",
					active: item["active"] === true,
					value: typeof item["value"] === "string" ? item["value"] : void 0
				});
			}
			return out;
		},
		readSecret(handle, key, id) {
			return manager(handle).readSecret(key, id);
		},
		writeSecret(handle, key, value, label, options) {
			const m = manager(handle);
			const previous = options?.keepActive ? readActiveId(m, key) : null;
			const id = m.writeSecret(key, value, label);
			if (previous) try {
				m.rotateSecret(key, previous);
			} catch {}
			return id;
		},
		renameSecret(handle, key, id, label) {
			manager(handle).renameSecret(key, id, label);
		},
		deleteSecret(handle, key, id) {
			if (!id) return;
			manager(handle).deleteSecret(key, id);
		}
	};
}
/**
* Loads ST's modules and builds the adapter; resolves to the degraded adapter when they are unavailable.
* `urls` is injectable for tests.
*/
async function createStServices(log, urls = defaultStModuleUrls()) {
	try {
		const secrets = await import(
			/* @vite-ignore */
			urls.secrets
);
		const users = await import(
			/* @vite-ignore */
			urls.users
);
		if (typeof secrets.SecretManager !== "function" || typeof users.getUserDirectories !== "function") throw new Error("unexpected shape of the ST modules");
		return createStServicesFromModules(secrets, users);
	} catch (error) {
		log.warn(`SillyTavern internals unavailable, running without the secret store (${describe(error)})`);
		return createUnavailableSt();
	}
}
function readActiveId(manager, key) {
	const all = manager.getAllSecrets()[key];
	if (!Array.isArray(all)) return null;
	for (const item of all) if (isRecord(item) && item["active"] === true && typeof item["id"] === "string") return item["id"];
	return null;
}
function describe(error) {
	return error instanceof Error ? error.message : String(error);
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
// src/server/index.ts
var info = {
	id: PLUGIN_ID,
	name: "Nanovia",
	description: "NanoGPT for SillyTavern: a local OpenAI-compatible proxy with per-connection routing, billing awareness and a usage log. Keeps the NanoGPT key on the server."
};
var LOG_PREFIX = "[Nanovia]";
var log = {
	info: (message) => console.info(LOG_PREFIX, message),
	warn: (message) => console.warn(LOG_PREFIX, message),
	error: (message) => console.error(LOG_PREFIX, message)
};
var running = null;
function readConfigFile() {
	try {
		return fs.readFileSync(fileURLToPath(new URL("./config.json", import.meta.url)), "utf8");
	} catch {
		return null;
	}
}
/** ST's node-fetch honours its request-proxy settings; Node's own fetch is the fallback. */
async function loadFetch() {
	try {
		const mod = await import(
			/* @vite-ignore */
			"node-fetch"
);
		if (typeof mod.default === "function") return mod.default;
	} catch {}
	return globalThis.fetch;
}
async function init(router) {
	await exit();
	const { config, warnings } = parseConfig(readConfigFile(), process.env);
	for (const warning of warnings) log.warn(warning);
	const st = await createStServices(log);
	running = await startNanovia(router, {
		config,
		st,
		fetch: await loadFetch(),
		log,
		catalog: { autoFetch: true }
	});
	const proxy = running.status;
	log.info(`v${PLUGIN_VERSION} ready (secrets: ${st.available ? "ST" : "unavailable"}, proxy: ${proxy.up ? `http://${proxy.host}:${proxy.port}` : `down (${proxy.error ?? "unknown"})`})`);
}
async function exit() {
	const current = running;
	running = null;
	await current?.close();
}
export { exit, info, init };
