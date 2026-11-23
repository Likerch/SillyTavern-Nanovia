import fs, { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import http from "node:http";
import fs$1 from "node:fs/promises";
import readline from "node:readline";
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
/** The Management API (API keys with limits, model presets). Its own host path, no CORS, no fallback host. */
var NANOGPT_MGMT_BASE = "https://nano-gpt.com/api/management/v1";
/** Every Management token starts with this; a normal inference key (`sk-nano-<uuid>`) does not work there. */
var MGMT_TOKEN_PREFIX = "sk-nano-mgmt-";
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
function isRecord$7(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value) {
	return isRecord$7(value) ? value : {};
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
function text$2(value) {
	return typeof value === "string" ? value.trim() : "";
}
function strings(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) {
		const s = text$2(item);
		if (s) out.push(s);
	}
	return out;
}
/** Cleans float noise of unit conversions (0.0000042 * 1000 = 0.004200000000000001). */
function roundUsd$1(value) {
	return Math.round(value * 1e9) / 1e9;
}
/** NanoGPT lists `…Per1kTokens`; the contracts hold USD per 1M tokens. */
function per1kToPer1m(value) {
	return roundUsd$1(value * 1e3);
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
	if (!isRecord$7(raw)) return null;
	const id = text$2(raw["id"]);
	if (!id) return null;
	const caps = record(raw["capabilities"]);
	const price = record(raw["pricing"]);
	const sub = record(raw["subscription"]);
	const cacheRead = nonNegative(price["cacheReadInputPer1kTokens"]);
	return {
		id,
		name: text$2(raw["name"]) || id,
		description: text$2(raw["description"]),
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
			prompt: roundUsd$1(nonNegative(price["prompt"]) ?? 0),
			completion: roundUsd$1(nonNegative(price["completion"]) ?? 0),
			cacheRead: cacheRead === null ? null : per1kToPer1m(cacheRead)
		},
		category: text$2(raw["category"]) || null,
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
	const list = Array.isArray(rawList) ? rawList : isRecord$7(rawList) && Array.isArray(rawList["data"]) ? rawList["data"] : [];
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
	const label = text$2(raw);
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
	const n = isRecord$7(raw) ? nonNegative(raw["uptimePct"]) : nonNegative(raw);
	return n !== null && n <= 100 ? n : null;
}
/** `features` is an object of flags (`{ toolCalling: true, … }`): the names that are true. A list of names is kept. */
function featuresOf(raw) {
	if (Array.isArray(raw)) return strings(raw);
	if (!isRecord$7(raw)) return [];
	return Object.keys(raw).filter((key) => raw[key] === true);
}
function normalizeEndpoint(raw) {
	if (!isRecord$7(raw)) return null;
	const id = text$2(raw["provider"]);
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
	if (!isRecord$7(raw)) return null;
	const hosts = raw["providers"];
	if (!(Array.isArray(hosts) || typeof raw["supportsProviderSelection"] === "boolean" || typeof raw["canonicalId"] === "string")) return null;
	const id = text$2(modelId) || text$2(raw["canonicalId"]);
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
	const p = isRecord$6(patch) ? patch : {};
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
	if (isRecord$6(p["routing"])) next.routing = mergeRouting(next.routing, p["routing"]);
	if (isRecord$6(p["reasoning"])) next.reasoning = mergeReasoning(next.reasoning, p["reasoning"]);
	if (isRecord$6(p["memory"])) {
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
	if (!isRecord$6(raw)) return null;
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
	if (isRecord$6(p["maxPrice"])) {
		const mp = p["maxPrice"];
		if (mp["prompt"] === null || isPrice$1(mp["prompt"])) next.maxPrice.prompt = mp["prompt"];
		if (mp["completion"] === null || isPrice$1(mp["completion"])) next.maxPrice.completion = mp["completion"];
	}
	if (typeof p["allowFallbacks"] === "boolean") next.allowFallbacks = p["allowFallbacks"];
	if (typeof p["requireParameters"] === "boolean") next.requireParameters = p["requireParameters"];
	if (typeof p["zdr"] === "boolean") next.zdr = p["zdr"];
	if (p["preferredMaxLatency"] === null || isPrice$1(p["preferredMaxLatency"])) {
		if ("preferredMaxLatency" in p) next.preferredMaxLatency = p["preferredMaxLatency"];
	}
	if (p["preferredMinThroughput"] === null || isPrice$1(p["preferredMinThroughput"])) {
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
function isRecord$6(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}
/** A non-negative finite number (a price, a latency or a throughput). */
function isPrice$1(value) {
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
var MGMT_FILE = "mgmt.json";
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
	/** Deletes the file and the aside copy of a corrupt one (no error when they are not there); forgets the cache. */
	remove() {
		const file = this.file();
		fs.rmSync(file, { force: true });
		fs.rmSync(`${file}.corrupt`, { force: true });
		this.cache = null;
		this.corrupt = false;
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
	if (!isRecord$5(raw) || !Array.isArray(raw["connections"])) return [];
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
	if (!isRecord$5(raw) || !isRecord$5(raw["tokens"])) return registry;
	for (const [hash, entry] of Object.entries(raw["tokens"])) {
		if (!TOKEN_HASH.test(hash) || !isRecord$5(entry)) continue;
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
var MGMT_ERRORS = [
	"mgmt_token_invalid",
	"upstream_unreachable",
	"upstream_timeout",
	"upstream_error",
	"rate_limited"
];
var STORABLE_TOKEN = /^[!-~]{1,512}$/;
/** A record needs a token that is one printable word; the check block is optional and read leniently. */
function parseMgmt(raw) {
	if (!isRecord$5(raw)) return null;
	const token = raw["token"];
	if (typeof token !== "string" || !STORABLE_TOKEN.test(token)) return null;
	const check = isRecord$5(raw["check"]) ? raw["check"] : {};
	const error = MGMT_ERRORS.find((code) => code === check["error"]) ?? null;
	const checkedAt = check["checkedAt"];
	return {
		token,
		check: {
			valid: typeof check["valid"] === "boolean" ? check["valid"] : null,
			checkedAt: typeof checkedAt === "number" && Number.isFinite(checkedAt) ? checkedAt : null,
			error
		}
	};
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
	const mgmtFiles = /* @__PURE__ */ new Map();
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
	const mgmtFile = (userRoot) => {
		let file = mgmtFiles.get(userRoot);
		if (!file) {
			file = new JsonFile(() => path.join(userRoot, USER_DIR_NAME, MGMT_FILE), parseMgmt, (record) => ({
				version: 1,
				...record
			}), () => null, log);
			mgmtFiles.set(userRoot, file);
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
		mgmt: {
			read: (userRoot) => mgmtFile(userRoot).read(),
			write: (userRoot, record) => mgmtFile(userRoot).write(record),
			clear: (userRoot) => mgmtFile(userRoot).remove()
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
function isRecord$5(value) {
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
		if (!isRecord$4(raw) || raw["version"] !== 1 || !Array.isArray(raw["models"])) return null;
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
function isRecord$4(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** The fields the rest of the plugin reads from a stored model; the file is ours but may be edited or truncated. */
function isStoredModel(value) {
	if (!isRecord$4(value)) return false;
	return typeof value["id"] === "string" && value["id"] !== "" && typeof value["name"] === "string" && isRecord$4(value["capabilities"]) && isRecord$4(value["pricing"]) && typeof value["pricing"]["prompt"] === "number" && typeof value["pricing"]["completion"] === "number" && isRecord$4(value["subscription"]) && Array.isArray(value["providerIds"]) && Array.isArray(value["reasoningEfforts"]);
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
		providerSelection: init.providerSelection ?? null,
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
		},
		resolved: null
	};
}
// src/domain/usage.ts
function emptyUsage() {
	return {
		present: false,
		promptTokens: null,
		completionTokens: null,
		totalTokens: null,
		cachedTokens: null,
		cacheWriteTokens: null,
		reasoningTokens: null,
		costUsd: null,
		currency: null,
		paidOtherCurrency: false,
		estimated: false,
		estimateUsd: null,
		requestId: null
	};
}
/**
* Normalises usage. `raw` is a response body or SSE chunk (then `usage` and the top-level `x_nanogpt_pricing` are read)
* or a bare usage object. Anything else gives an empty result.
*
* Cost rules: `usage.cost` (then `total_cost`) as a number or decimal string wins; negative, NaN or garbage counts as
* absent. A currency other than USD makes the cost unusable as dollars (null) except an exact 0, which is 0 in any
* currency; a missing currency means USD (the OpenRouter convention). Without a usable cost, `x_nanogpt_pricing.cost`
* is the real cost only when the block says `isEstimate: false`; otherwise it is kept as `estimateUsd`.
*/
function normalizeUsage(raw) {
	if (!isRecord$3(raw)) return emptyUsage();
	const nested = raw["usage"];
	if (nested !== void 0 && !isRecord$3(nested)) return emptyUsage();
	const usage = isRecord$3(nested) ? nested : raw;
	const pricingRaw = raw["x_nanogpt_pricing"] ?? usage["x_nanogpt_pricing"];
	const pricing = isRecord$3(pricingRaw) ? pricingRaw : null;
	const promptDetails = isRecord$3(usage["prompt_tokens_details"]) ? usage["prompt_tokens_details"] : {};
	const completionDetails = isRecord$3(usage["completion_tokens_details"]) ? usage["completion_tokens_details"] : {};
	const promptTokens = firstCount(usage["prompt_tokens"], usage["input_tokens"], pricing?.["inputTokens"]);
	const completionTokens = firstCount(usage["completion_tokens"], usage["output_tokens"], pricing?.["outputTokens"]);
	const totalTokens = firstCount(usage["total_tokens"]);
	const cachedTokens = preferPositive(promptDetails["cached_tokens"], usage["cache_read_input_tokens"], usage["prompt_cache_hit_tokens"], pricing?.["cacheReadInputTokens"]);
	const cacheWriteTokens = preferPositive(usage["cache_creation_input_tokens"], promptDetails["cache_write_tokens"], pricing?.["cacheCreationInputTokens"]);
	const reasoningTokens = firstCount(completionDetails["reasoning_tokens"], usage["reasoning_tokens"]);
	const currency = typeof usage["currency"] === "string" && usage["currency"].trim() ? usage["currency"].trim().toUpperCase() : null;
	const dollars = currency === null || currency === "USD";
	const reported = firstCost(usage["cost"], usage["total_cost"]);
	let costUsd = null;
	let paidOtherCurrency = false;
	if (reported !== null) {
		if (dollars || reported === 0) costUsd = reported;
		else paidOtherCurrency = true;
	}
	const pricingCost = pricing ? firstCost(pricing["cost"]) : null;
	let estimateUsd = null;
	if (pricingCost !== null) {
		if (reported === null && dollars && pricing?.["isEstimate"] === false) costUsd = pricingCost;
		else estimateUsd = pricingCost;
	}
	const estimated = costUsd === null && !paidOtherCurrency && estimateUsd !== null;
	const requestId = typeof pricing?.["requestId"] === "string" && pricing["requestId"].trim() ? pricing["requestId"].trim() : null;
	const present = [
		promptTokens,
		completionTokens,
		totalTokens,
		cachedTokens,
		cacheWriteTokens,
		reasoningTokens,
		reported,
		pricingCost
	].some((v) => v !== null);
	if (!present) return emptyUsage();
	return {
		present,
		promptTokens,
		completionTokens,
		totalTokens,
		cachedTokens,
		cacheWriteTokens,
		reasoningTokens,
		costUsd,
		currency,
		paidOtherCurrency,
		estimated,
		estimateUsd,
		requestId
	};
}
/** Rounds a USD amount to 1e-9 so sums of floats print cleanly (`0.1 + 0.2`). */
function roundUsd(value) {
	return Math.round(value * 1e9) / 1e9;
}
/**
* Sums records with `range.from <= at < range.to` in total, per day (`dayOf` names the day, so the zone is the
* caller's), per connection and per model. Real cost and pay-as-you-go equivalent stay separate; unknown values count as
* 0; every record counts as a request, a subscription one with cost 0. Pure and deterministic: days ascend, the other
* lists go by real cost, equivalent, requests (descending) and then name.
*/
function summarizeUsage(records, range, dayOf, filter = {}) {
	const total = emptyTotals();
	const days = /* @__PURE__ */ new Map();
	const connections = /* @__PURE__ */ new Map();
	const models = /* @__PURE__ */ new Map();
	for (const record of records) {
		if (!(record.at >= range.from && record.at < range.to)) continue;
		if (filter.connectionId !== void 0 && record.connectionId !== filter.connectionId) continue;
		addRecord(total, record);
		addRecord(bucket(days, dayOf(record.at)), record);
		addRecord(bucket(connections, record.connectionId), record);
		addRecord(bucket(models, record.model), record);
	}
	const byDay = [...days].map(([day, totals]) => ({
		day,
		...finish(totals)
	})).sort((a, b) => compareText(a.day, b.day));
	const byConnection = [...connections].map(([connectionId, totals]) => ({
		connectionId,
		...finish(totals)
	})).sort((a, b) => byWeight(a, b) || compareText(a.connectionId ?? "", b.connectionId ?? ""));
	const byModel = [...models].map(([model, totals]) => ({
		model,
		...finish(totals)
	})).sort((a, b) => byWeight(a, b) || compareText(a.model, b.model));
	return {
		from: range.from,
		to: range.to,
		total: finish(total),
		byDay,
		byConnection,
		byModel
	};
}
function emptyTotals() {
	return {
		requests: 0,
		costUsd: 0,
		equivalentUsd: 0,
		promptTokens: 0,
		completionTokens: 0,
		cachedTokens: 0
	};
}
function bucket(map, key) {
	let totals = map.get(key);
	if (!totals) {
		totals = emptyTotals();
		map.set(key, totals);
	}
	return totals;
}
function addRecord(totals, record) {
	totals.requests += 1;
	totals.costUsd += amount$2(record.costUsd);
	totals.equivalentUsd += amount$2(record.equivalentUsd);
	totals.promptTokens += amount$2(record.promptTokens);
	totals.completionTokens += amount$2(record.completionTokens);
	totals.cachedTokens += amount$2(record.cachedTokens);
}
function finish(totals) {
	return {
		...totals,
		costUsd: roundUsd(totals.costUsd),
		equivalentUsd: roundUsd(totals.equivalentUsd)
	};
}
/** A stored number counts when it is finite and not negative; anything else (null, NaN, a negative) counts as 0. */
function amount$2(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
function byWeight(a, b) {
	return b.costUsd - a.costUsd || b.equivalentUsd - a.equivalentUsd || b.requests - a.requests;
}
function compareText(a, b) {
	return a < b ? -1 : a > b ? 1 : 0;
}
function isRecord$3(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
var DECIMAL$2 = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/** A USD amount from a number or a decimal string; null for negatives, NaN, infinities and anything else. */
function parseCost(value) {
	let n;
	if (typeof value === "number") n = value;
	else if (typeof value === "string" && DECIMAL$2.test(value.trim())) n = Number(value.trim());
	else return null;
	if (!Number.isFinite(n) || n < 0) return null;
	return n === 0 ? 0 : n;
}
/** A token count: a finite number that is not negative. */
function parseCount(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value === 0 ? 0 : value : null;
}
function firstCount(...values) {
	for (const value of values) {
		const n = parseCount(value);
		if (n !== null) return n;
	}
	return null;
}
function firstCost(...values) {
	for (const value of values) {
		const n = parseCost(value);
		if (n !== null) return n;
	}
	return null;
}
/** The first positive count, else the first valid count (a real 0), else null: one source saying 0 must not hide another. */
function preferPositive(...values) {
	let zero = null;
	for (const value of values) {
		const n = parseCount(value);
		if (n === null) continue;
		if (n > 0) return n;
		zero = 0;
	}
	return zero;
}
// src/domain/cost.ts
/**
* What the request would cost at pay-as-you-go prices (USD): uncached prompt tokens at the prompt price, cached ones at
* the cache-read price (the prompt price when the model has none), completion tokens at the completion price. Cache
* writes are part of the prompt tokens and have no separate catalog price. With the model unknown the answer is NanoGPT's
* own estimate (`x_nanogpt_pricing.cost`) when there is one, otherwise null; null too when no token count is known.
*/
function equivalentCostUsd(model, u) {
	if (model) {
		const priced = priceTokens(model, u);
		if (priced !== null) return priced;
	}
	return u.estimateUsd;
}
function priceTokens(model, u) {
	if (u.promptTokens === null && u.completionTokens === null) return null;
	const { prompt, completion, cacheRead } = model.pricing;
	if (!isPrice(prompt) || !isPrice(completion)) return null;
	const promptTokens = u.promptTokens ?? 0;
	const cached = Math.min(u.cachedTokens ?? 0, promptTokens);
	const cachePrice = cacheRead !== null && isPrice(cacheRead) ? cacheRead : prompt;
	return roundUsd(((promptTokens - cached) * prompt + cached * cachePrice + (u.completionTokens ?? 0) * completion) / 1e6);
}
function isPrice(value) {
	return Number.isFinite(value) && value >= 0;
}
/**
* Where the money for a request came from.
* paygo: a cost above zero, a payment in another currency, or pay-as-you-go forced or implied by explicit routing.
* subscription: the cost is exactly 0, the model is in the subscription and nothing forced pay-as-you-go.
* unknown: everything else (no cost reported, an estimate only, a free or unknown model).
*/
function classifyBilling(args) {
	const cost = args.estimated ? null : args.costUsd;
	if (args.billingModeForced || args.explicitRouting) return "paygo";
	if (cost !== null && cost > 0) return "paygo";
	if (!args.estimated && args.paidOtherCurrency === true) return "paygo";
	if (cost === 0 && args.model?.subscription.included === true) return "subscription";
	return "unknown";
}
/**
* Billing, real cost and equivalent of one request from its usage (null = the response had none). The equivalent falls
* back to the real cost for a pay-as-you-go request whose model has no catalog price.
*/
function resolveCost(usage, ctx) {
	if (!usage || !usage.present) return {
		billing: classifyBilling({
			model: ctx.model,
			costUsd: null,
			billingModeForced: ctx.billingModeForced,
			explicitRouting: ctx.explicitRouting,
			estimated: false
		}),
		costUsd: null,
		equivalentUsd: null
	};
	const billing = classifyBilling({
		model: ctx.model,
		costUsd: usage.costUsd,
		billingModeForced: ctx.billingModeForced,
		explicitRouting: ctx.explicitRouting,
		estimated: usage.estimated,
		paidOtherCurrency: usage.paidOtherCurrency
	});
	const costUsd = billing === "subscription" ? 0 : usage.costUsd;
	let equivalentUsd = equivalentCostUsd(ctx.model, usage);
	if (equivalentUsd === null && billing === "paygo") equivalentUsd = costUsd;
	return {
		billing,
		costUsd,
		equivalentUsd
	};
}
/**
* The record written to `usage-YYYY-MM-DD.jsonl`. A failed request without usage is `unknown` with no cost (nothing
* proves it was billed); token counts are null when the response did not report them.
*/
function buildUsageRecord(args) {
	const failed = args.error !== null || args.status >= 400;
	const hasUsage = args.usage !== null && args.usage.present;
	const resolved = resolveCost(args.usage, args);
	const usage = hasUsage ? args.usage : null;
	return {
		at: args.at,
		connectionId: args.connectionId,
		requestId: args.requestId ?? usage?.requestId ?? null,
		model: args.modelId,
		billing: failed && !hasUsage ? "unknown" : resolved.billing,
		costUsd: resolved.costUsd,
		equivalentUsd: resolved.equivalentUsd,
		promptTokens: usage?.promptTokens ?? null,
		completionTokens: usage?.completionTokens ?? null,
		cachedTokens: usage?.cachedTokens ?? null,
		reasoningTokens: usage?.reasoningTokens ?? null,
		latencyMs: args.latencyMs,
		status: args.status,
		stream: args.stream,
		consumer: args.consumer,
		error: args.error
	};
}
// src/domain/shim.ts
/** Works out billing, cost and request id of a body or chunk; null when it carries no usable usage. */
function resolveUsage(json, ctx) {
	if (!isRecord$3(json) || !isRecord$3(json["usage"])) return null;
	const usage = normalizeUsage(json);
	if (!usage.present) return null;
	return {
		...resolveCost(usage, ctx),
		usage,
		requestId: ctx.requestId ?? usage.requestId
	};
}
/**
* Rewrites the `usage` of a response body. prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details.cached_tokens
* (and cache_write_tokens when known) and completion_tokens_details.reasoning_tokens are always numbers (0 when the upstream
* did not report them, as OpenRouter does); `cost` is real USD, 0 for a subscription request, and is left out when the real
* cost is unknown (never a guess); `currency` and `total_cost` are dropped so no foreign-currency figure can be mistaken for
* dollars. `usage.nanovia` = { billing, equivalent_usd, request_id }. A body without a usable `usage` is returned as a copy
* with nothing invented.
*/
function shimResponse(json, ctx) {
	const resolved = resolveUsage(json, ctx);
	const original = json["usage"];
	if (!resolved || !isRecord$3(original)) return {
		body: { ...json },
		resolved: null
	};
	const { usage } = resolved;
	const out = { ...original };
	const prompt = usage.promptTokens ?? 0;
	const completion = usage.completionTokens ?? 0;
	out["prompt_tokens"] = prompt;
	out["completion_tokens"] = completion;
	out["total_tokens"] = usage.totalTokens ?? prompt + completion;
	const promptDetails = {
		...isRecord$3(original["prompt_tokens_details"]) ? original["prompt_tokens_details"] : {},
		cached_tokens: usage.cachedTokens ?? 0
	};
	if (usage.cacheWriteTokens !== null) promptDetails["cache_write_tokens"] = usage.cacheWriteTokens;
	out["prompt_tokens_details"] = promptDetails;
	out["completion_tokens_details"] = {
		...isRecord$3(original["completion_tokens_details"]) ? original["completion_tokens_details"] : {},
		reasoning_tokens: usage.reasoningTokens ?? 0
	};
	delete out["total_cost"];
	delete out["currency"];
	if (resolved.costUsd !== null) out["cost"] = resolved.costUsd;
	else delete out["cost"];
	out["nanovia"] = {
		billing: resolved.billing,
		equivalent_usd: resolved.equivalentUsd,
		request_id: resolved.requestId
	};
	return {
		body: {
			...json,
			usage: out
		},
		resolved
	};
}
/**
* Rewrites the payload of one SSE `data:` field the same way. `[DONE]`, anything that is not a JSON object and every
* chunk without a usable `usage` (including the `"usage": null` of ordinary chunks) come back as the same string.
*/
function shimSsePayload(data, ctx) {
	const unchanged = {
		data,
		resolved: null
	};
	if (!data.includes("usage")) return unchanged;
	let parsed;
	try {
		parsed = JSON.parse(data);
	} catch {
		return unchanged;
	}
	if (!isRecord$3(parsed)) return unchanged;
	const { body, resolved } = shimResponse(parsed, ctx);
	return resolved ? {
		data: JSON.stringify(body),
		resolved
	} : unchanged;
}
// src/domain/sse.ts
/**
* Cuts a byte or text stream into SSE events. Every returned string is one event exactly as received, with its blank-line
* terminator, so the concatenation of all returned strings plus nothing else is the input. Line ends may be LF, CRLF or CR
* (a CR at the end of a chunk waits for the next one). Multi-byte UTF-8 split across chunks is decoded correctly (invalid
* bytes become U+FFFD, a BOM stays as a character). Blank lines before the first field of an event travel with it.
*/
var SseSplitter = class {
	decoder = new TextDecoder("utf-8", {
		fatal: false,
		ignoreBOM: true
	});
	/** Text of the event being collected (and any complete events not yet returned). */
	buf = "";
	/** Scan position inside `buf`; always the start of a line. */
	pos = 0;
	/** The event being collected already has a non-blank line. */
	content = false;
	/** Adds a chunk and returns the events that are now complete (in order, possibly none). */
	feed(chunk) {
		this.buf += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
		return this.drain(false);
	}
	/** End of stream: returns what is left (an event the server never terminated) as one string, or nothing. */
	flush() {
		this.buf += this.decoder.decode();
		const out = this.drain(true);
		if (this.buf.length > 0) out.push(this.buf);
		this.buf = "";
		this.pos = 0;
		this.content = false;
		return out;
	}
	drain(final) {
		const out = [];
		const buf = this.buf;
		let from = 0;
		let pos = this.pos;
		for (;;) {
			const line = scanLine(buf, pos, final);
			if (line === null) break;
			const next = pos + line.length + line.terminator;
			if (line.length > 0) this.content = true;
			else if (this.content) {
				out.push(buf.slice(from, next));
				from = next;
				this.content = false;
			}
			pos = next;
		}
		if (from > 0) this.buf = buf.slice(from);
		this.pos = pos - from;
		return out;
	}
};
/** The line starting at `pos`: its length without the terminator and the terminator's length; null while it is incomplete. */
function scanLine(buf, pos, final) {
	for (let i = pos; i < buf.length; i++) {
		const c = buf.charCodeAt(i);
		if (c === 10) return {
			length: i - pos,
			terminator: 1
		};
		if (c === 13) {
			if (i + 1 < buf.length) return {
				length: i - pos,
				terminator: buf.charCodeAt(i + 1) === 10 ? 2 : 1
			};
			return final ? {
				length: i - pos,
				terminator: 1
			} : null;
		}
	}
	return null;
}
var DATA_LINE = new RegExp(`^(${String.fromCharCode(65279)}?data:)( ?)([\\s\\S]*)$`);
/**
* Rewrites one raw event (as the splitter returns it) when its `data` field is a JSON chunk with usage. Comments, `event:`,
* `id:` and `retry:` lines, line endings and the blank-line terminator are kept; a multi-line `data` field (joined with
* newlines, as the SSE rules say) becomes one line. Events without usage, `[DONE]` and non-JSON data are returned untouched.
*/
function rewriteSseEvent(rawEvent, ctx) {
	const unchanged = {
		text: rawEvent,
		resolved: null
	};
	if (!rawEvent.includes("usage")) return unchanged;
	const lines = splitLines(rawEvent);
	const dataLines = [];
	lines.forEach((line, index) => {
		const match = DATA_LINE.exec(line.text);
		if (match) dataLines.push({
			index,
			match
		});
	});
	const first = dataLines[0];
	if (!first) return unchanged;
	const { data, resolved } = shimSsePayload(dataLines.map((d) => d.match[3] ?? "").join("\n"), ctx);
	if (!resolved) return unchanged;
	const drop = new Set(dataLines.slice(1).map((d) => d.index));
	let text = "";
	lines.forEach((line, index) => {
		if (drop.has(index)) return;
		text += (index === first.index ? `${first.match[1]}${first.match[2]}${data}` : line.text) + line.end;
	});
	return {
		text,
		resolved
	};
}
function splitLines(raw) {
	const lines = [];
	let start = 0;
	while (start < raw.length) {
		let i = start;
		while (i < raw.length && raw.charCodeAt(i) !== 10 && raw.charCodeAt(i) !== 13) i++;
		let end = "";
		if (i < raw.length) end = raw.charCodeAt(i) === 13 && raw.charCodeAt(i + 1) === 10 ? "\r\n" : raw.charAt(i);
		lines.push({
			text: raw.slice(start, i),
			end
		});
		start = i + end.length;
	}
	return lines;
}
// src/server/usage-capture.ts
/** What the shim needs to know about the request; the upstream request id is known once the upstream answered. */
function shimContextOf(ctx) {
	return {
		model: ctx.model,
		billingModeForced: ctx.connection.billing === "paygo",
		explicitRouting: ctx.plan.billing.reasons.some((reason) => reason.code === "routing.explicit"),
		requestId: ctx.upstream?.requestId ?? null
	};
}
/** Rewrites the usage of a complete JSON reply. Anything that is not a JSON object, or is an error, is returned as is. */
function shimJsonBody(raw, shim) {
	const untouched = {
		body: raw,
		resolved: null
	};
	let json;
	try {
		json = JSON.parse(raw.toString("utf8"));
	} catch {
		return untouched;
	}
	if (!isRecord$3(json) || json["error"] !== void 0 && json["error"] !== null) return untouched;
	const result = shimResponse(json, shim);
	if (!result.resolved) return untouched;
	return {
		body: Buffer.from(JSON.stringify(result.body), "utf8"),
		resolved: result.resolved
	};
}
/**
* Passes an SSE stream through chunk by chunk. `push` returns the bytes to write for a chunk (null: only part of an
* event arrived, it is held until its blank line); `end` returns what is left when the upstream finished. Events are
* decoded and encoded as UTF-8, which is what SSE is, so an event without usage comes out byte-identical.
*/
var SseUsageShim = class {
	shim;
	splitter = new SseSplitter();
	latest = null;
	constructor(shim) {
		this.shim = shim;
	}
	/** The facts of the last event that carried usage; null while there was none. */
	get resolved() {
		return this.latest;
	}
	push(chunk) {
		return this.encode(this.splitter.feed(chunk));
	}
	end() {
		return this.encode(this.splitter.flush());
	}
	encode(events) {
		if (events.length === 0) return null;
		let text = "";
		for (const event of events) text += this.forward(event);
		return Buffer.from(text, "utf8");
	}
	forward(event) {
		if (!event.includes("usage")) return event;
		try {
			const rewritten = rewriteSseEvent(event, this.shim);
			if (rewritten.resolved) this.latest = rewritten.resolved;
			return rewritten.text;
		} catch {
			return event;
		}
	}
};
/** Fills `ctx.usage` from what is known: the status and error the proxy set, the usage the response carried, the plan. */
function applyUsageRecord(ctx) {
	const { requestId, ...costContext } = shimContextOf(ctx);
	Object.assign(ctx.usage, buildUsageRecord({
		...costContext,
		requestId,
		at: ctx.startedAt,
		connectionId: ctx.connection.id,
		modelId: ctx.plan.model,
		usage: ctx.resolved?.usage ?? null,
		latencyMs: ctx.usage.latencyMs,
		status: ctx.usage.status,
		stream: ctx.stream,
		consumer: ctx.hints.consumer,
		error: ctx.usage.error
	}));
}
/**
* Response step. A non-streamed 2xx body goes through the shim here (before the reply is written); then the usage record
* is completed. A streamed reply was shimmed while it flowed (`ctx.resolved` is already set); an error reply is not touched.
*/
var usageStep = (ctx) => {
	const info = ctx.upstream;
	if (info && !info.stream && info.body !== null && info.status >= 200 && info.status < 300) {
		const result = shimJsonBody(info.body, shimContextOf(ctx));
		info.body = result.body;
		ctx.resolved = result.resolved;
	}
	applyUsageRecord(ctx);
};
// src/domain/routing.ts
/**
* Names (RoutingConfig keys) of the settings that select a provider or a route, in a fixed order. These are the
* settings NanoGPT bills as an explicit provider selection (pay-as-you-go plus markup). `zdr` is not among them: it only
* narrows the platform's own routing. Looks at the fields only; whether routing is enabled is the caller's question
* (see hasExplicitRouting).
*/
function routingFields(r) {
	const fields = [];
	if (r.order.length > 0) fields.push("order");
	if (r.only.length > 0) fields.push("only");
	if (r.ignore.length > 0) fields.push("ignore");
	if (r.sort !== "default") fields.push("sort");
	if (r.quantizations.length > 0) fields.push("quantizations");
	if (r.minQuantization !== null) fields.push("minQuantization");
	if (isSet(r.maxPrice.prompt) || isSet(r.maxPrice.completion)) fields.push("maxPrice");
	if (r.allowFallbacks === false) fields.push("allowFallbacks");
	if (r.requireParameters) fields.push("requireParameters");
	if (isSet(r.preferredMaxLatency)) fields.push("preferredMaxLatency");
	if (isSet(r.preferredMinThroughput)) fields.push("preferredMinThroughput");
	if (r.cachingRoute) fields.push("cachingRoute");
	return fields;
}
/** True when routing is enabled and at least one setting of routingFields is in use. `zdr` alone is not explicit. */
function hasExplicitRouting(r) {
	return r.enabled && routingFields(r).length > 0;
}
/**
* Maps the config to NanoGPT's `provider` object. null when routing is disabled or there is nothing to send. Provider
* ids are lower-cased. `data_collection` is never emitted (NanoGPT refuses `deny`). `zdrOnly` keeps just `zdr`: the
* only field that does not bypass the subscription.
* `cachingRoute` is not part of `provider`: it is the top-level `caching: true` and is set by planUpstream.
*/
function buildProviderObject(r, opts) {
	if (!r.enabled) return null;
	const out = {};
	if (!opts.zdrOnly) {
		const order = normalizeIds(r.order);
		const only = normalizeIds(r.only);
		const ignore = normalizeIds(r.ignore);
		if (order.length > 0) out["order"] = order;
		if (only.length > 0) out["only"] = only;
		if (ignore.length > 0) out["ignore"] = ignore;
		if (r.sort !== "default") out["sort"] = r.sort;
		if (r.quantizations.length > 0) out["quantizations"] = [...r.quantizations];
		if (r.minQuantization !== null) out["min_quantization"] = r.minQuantization;
		const maxPrice = {};
		if (isSet(r.maxPrice.prompt)) maxPrice["prompt"] = r.maxPrice.prompt;
		if (isSet(r.maxPrice.completion)) maxPrice["completion"] = r.maxPrice.completion;
		if (Object.keys(maxPrice).length > 0) out["max_price"] = maxPrice;
		if (r.allowFallbacks === false) out["allow_fallbacks"] = false;
		if (r.requireParameters) out["require_parameters"] = true;
	}
	if (r.zdr) out["zdr"] = true;
	if (!opts.zdrOnly) {
		if (isSet(r.preferredMaxLatency)) out["preferred_max_latency"] = r.preferredMaxLatency;
		if (isSet(r.preferredMinThroughput)) out["preferred_min_throughput"] = r.preferredMinThroughput;
	}
	return Object.keys(out).length > 0 ? out : null;
}
/**
* Settings that look meaningful but do nothing, or conflict. Empty when routing is disabled (nothing is sent).
* - `routing.preferenceNeedsSort`: preferred latency/throughput without a sort.
* - `routing.onlyAndOrder`: `only` and `order` together (`only` already limits the candidates, `order` is redundant).
*/
function routingWarnings(r) {
	if (!r.enabled) return [];
	const warnings = [];
	if ((isSet(r.preferredMaxLatency) || isSet(r.preferredMinThroughput)) && r.sort === "default") warnings.push({ code: "routing.preferenceNeedsSort" });
	if (r.only.length > 0 && r.order.length > 0) warnings.push({ code: "routing.onlyAndOrder" });
	return warnings;
}
function normalizeIds(list) {
	const out = [];
	for (const item of list) {
		const id = item.trim().toLowerCase();
		if (id && !out.includes(id)) out.push(id);
	}
	return out;
}
function isSet(value) {
	return typeof value === "number" && Number.isFinite(value);
}
// src/domain/billing.ts
/**
* The routing a 'subscription' ("safe") connection really uses: every bypassing setting is reset to its neutral value,
* `zdr` stays. `stripped` names what was removed (RoutingConfig keys). Nothing is stripped while routing is disabled
* (it sends nothing). Does not look at `connection.billing`: callers apply it in safe mode, and a panel can call it to
* offer "make this subscription-safe". `_model` is reserved for model-specific rules.
*/
function subscriptionSafeOverrides(connection, _model) {
	const r = connection.routing;
	const stripped = r.enabled ? routingFields(r) : [];
	if (stripped.length === 0) return {
		routing: cloneRouting(r),
		stripped
	};
	return {
		routing: {
			...r,
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
			preferredMaxLatency: null,
			preferredMinThroughput: null,
			cachingRoute: false
		},
		stripped
	};
}
/**
* What this connection does to the billing of a request to `model` (null = not in the catalog).
* `providerSelection` is ModelProviders.supportsProviderSelection: false means NanoGPT ignores routing for the model,
* null means unknown (treated as true). `subscriptionSafe` speaks about settings only (nothing bypasses the
* subscription and billing is not forced to pay-as-you-go); whether the model itself is covered is `outcome`.
*/
function analyzeBilling(connection, model, providerSelection) {
	const forced = connection.billing === "paygo";
	const safe = connection.billing === "subscription";
	const { routing, stripped } = safe ? subscriptionSafeOverrides(connection, model) : {
		routing: connection.routing,
		stripped: []
	};
	const explicit = hasExplicitRouting(routing);
	const selectionIgnored = providerSelection === false;
	const bypass = explicit && !selectionIgnored;
	const reasons = [];
	if (forced) reasons.push({ code: "billing.forced" });
	else if (model !== null && !model.subscription.included) {
		reasons.push({
			code: "model.notIncluded",
			params: { model: model.id }
		});
		if (safe) reasons.push({
			code: "billing.modelNotCoverable",
			params: { model: model.id }
		});
	}
	if (explicit) {
		const fields = routingFields(routing).join(", ");
		reasons.push({
			code: selectionIgnored ? "routing.unsupportedByModel" : "routing.explicit",
			params: { fields }
		});
	} else if (routing.enabled && routing.zdr && !selectionIgnored && !forced) reasons.push({ code: "routing.zdrOnly" });
	if (connection.webSearch) reasons.push({ code: "search.billedSeparately" });
	if (connection.memory.enabled) reasons.push({ code: "memory.billedSeparately" });
	let outcome;
	if (forced || bypass) outcome = "paygo";
	else if (model === null) outcome = "unknown";
	else outcome = model.subscription.included ? "subscription" : "paygo";
	if (model !== null && outcome === "subscription" && model.subscription.inputTokenMultiplier > 1) reasons.push({
		code: "subscription.multiplier",
		params: { value: model.subscription.inputTokenMultiplier }
	});
	return {
		outcome,
		markupPercent: bypass ? 5 : 0,
		subscriptionSafe: !forced && !bypass,
		reasons,
		stripped
	};
}
function cloneRouting(r) {
	return {
		...r,
		order: [...r.order],
		only: [...r.only],
		ignore: [...r.ignore],
		quantizations: [...r.quantizations],
		maxPrice: { ...r.maxPrice }
	};
}
// src/domain/reasoning.ts
/** The effort ladder, lowest first. The distance between two levels is the distance of their indices. */
var EFFORT_ORDER$1 = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** ST's effort vocabulary (and a few spellings seen in the wild) mapped to the ladder. */
var HINT_VOCABULARY = /* @__PURE__ */ new Map([
	["min", "none"],
	["off", "none"],
	["none", "none"],
	["minimal", "minimal"],
	["low", "low"],
	["medium", "medium"],
	["high", "high"],
	["xhigh", "xhigh"],
	["x-high", "xhigh"],
	["extra-high", "xhigh"],
	["max", "max"],
	["auto", "auto"]
]);
/**
* Normalises the effort a request carried (X-Nanovia-Effort or ST's `reasoning_effort`).
* 'min'/'off'/'none' mean "no reasoning" and give 'none'; 'auto' stays 'auto' (the caller expressed no preference);
* an empty or unknown value gives null.
*/
function normalizeEffortHint(hint) {
	if (typeof hint !== "string") return null;
	return HINT_VOCABULARY.get(hint.trim().toLowerCase()) ?? null;
}
/**
* The supported level closest to `wanted` on the ladder none < minimal < low < medium < high < xhigh < max.
* A tie goes to the lower level. Entries of `supported` that are not on the ladder are ignored; null when nothing
* usable is left. `supported` may lack 'none'.
*/
function nearestEffort(wanted, supported) {
	const target = EFFORT_ORDER$1.indexOf(wanted);
	if (target < 0) return null;
	let best = -1;
	for (const level of supported) {
		const index = ladderIndex(level);
		if (index < 0) continue;
		if (best < 0) {
			best = index;
			continue;
		}
		const distance = Math.abs(index - target);
		const bestDistance = Math.abs(best - target);
		if (distance < bestDistance || distance === bestDistance && index < best) best = index;
	}
	return best < 0 ? null : EFFORT_ORDER$1[best] ?? null;
}
/**
* Decides what to put into the request's `reasoning` object.
*
* - policy 'default', or a model that is known not to reason: nothing (null, no warning).
* - 'off': the model lists 'none' -> `{ effort: 'none' }`; it only lists other efforts (it always reasons) -> its lowest
*   effort with the text excluded and the warning `reasoning.cannotDisable`; it has no efforts -> `{ enabled: false }`.
* - 'fixed': `config.effort` mapped to a supported level (warning `reasoning.effortAdjusted` when it had to change);
*   without an effort it behaves like 'default'.
* - 'follow': the request's hint, normalised and mapped the same way; no (or 'auto') hint -> nothing, except for a
*   'background' consumer, which then behaves as 'off'.
* - A model that reasons but lists no efforts has no dial: 'none' becomes `{ enabled: false }`, anything else
*   `{ enabled: true }`.
* - An unknown model (null) gets the normalised effort as it is, with the warning `reasoning.modelUnknown`.
* - `hideThoughts` adds `exclude: true` to every non-null result (so it has no effect while nothing is sent).
*/
function planReasoning(model, config, hints) {
	const nothing = {
		reasoning: null,
		warnings: []
	};
	if (config.policy === "default") return nothing;
	if (model !== null && !model.capabilities.reasoning) return nothing;
	const warnings = [];
	let params;
	if (config.policy === "off") params = planOff(model, warnings);
	else if (config.policy === "fixed") params = config.effort === null ? null : planWanted(model, config.effort, warnings);
	else {
		const hint = normalizeEffortHint(hints.effort);
		if (hint !== null && hint !== "auto") params = planWanted(model, hint, warnings);
		else params = hints.consumer === "background" ? planOff(model, warnings) : null;
	}
	if (params === null) return nothing;
	if (config.hideThoughts) params.exclude = true;
	return {
		reasoning: params,
		warnings
	};
}
function planOff(model, warnings) {
	if (model === null) {
		warnings.push({ code: "reasoning.modelUnknown" });
		return { effort: "none" };
	}
	const lowest = lowestEffort(model.reasoningEfforts);
	if (lowest === null) return { enabled: false };
	if (lowest === "none") return { effort: "none" };
	warnings.push({
		code: "reasoning.cannotDisable",
		params: {
			model: model.id,
			efforts: model.reasoningEfforts.join(", ")
		}
	});
	return {
		effort: lowest,
		exclude: true
	};
}
function planWanted(model, wanted, warnings) {
	if (model === null) {
		warnings.push({ code: "reasoning.modelUnknown" });
		return { effort: wanted };
	}
	const applied = nearestEffort(wanted, model.reasoningEfforts);
	if (applied === null) return { enabled: wanted !== "none" };
	if (applied !== wanted) warnings.push({
		code: "reasoning.effortAdjusted",
		params: {
			requested: wanted,
			applied
		}
	});
	return { effort: applied };
}
function lowestEffort(supported) {
	let best = -1;
	for (const level of supported) {
		const index = ladderIndex(level);
		if (index >= 0 && (best < 0 || index < best)) best = index;
	}
	return best < 0 ? null : EFFORT_ORDER$1[best] ?? null;
}
function ladderIndex(level) {
	return EFFORT_ORDER$1.indexOf(level.trim().toLowerCase());
}
// src/domain/upstream.ts
/** Fields ST sends with a neutral value that some NanoGPT routes reject. */
var NEUTRAL_SAMPLERS = [
	["top_k", 0],
	["top_a", 0],
	["min_p", 0],
	["repetition_penalty", 1]
];
function planUpstream(input) {
	const { connection, hints } = input;
	const body = structuredClone(input.body);
	const safe = connection.billing === "subscription";
	const model = withSuffixes(chooseModel(connection.modelLock, connection.modelId, body["model"]), connection);
	body["model"] = model;
	if (connection.stripNeutralSamplers) stripNeutralSamplers(body);
	body["usage"] = {
		...isRecord$2(body["usage"]) ? body["usage"] : {},
		include: true
	};
	if (body["stream"] === true) body["stream_options"] = {
		...isRecord$2(body["stream_options"]) ? body["stream_options"] : {},
		include_usage: true
	};
	const reasoning = planReasoning(input.model, connection.reasoning, hints);
	if (reasoning.reasoning !== null) {
		body["reasoning"] = {
			...isRecord$2(body["reasoning"]) ? body["reasoning"] : {},
			...reasoning.reasoning
		};
		delete body["reasoning_effort"];
	}
	const routing = safe ? subscriptionSafeOverrides(connection, input.model).routing : connection.routing;
	if (safe) {
		delete body["caching"];
		if (isRecord$2(body["provider"])) {
			const zdr = body["provider"]["zdr"];
			if (zdr === void 0) delete body["provider"];
			else body["provider"] = { zdr };
		}
	}
	const fixedRoute = input.providerSelection === false;
	const provider = buildProviderObject(routing, { zdrOnly: fixedRoute });
	if (provider !== null) body["provider"] = {
		...isRecord$2(body["provider"]) ? body["provider"] : {},
		...provider
	};
	if (!fixedRoute && routing.enabled && routing.cachingRoute) body["caching"] = true;
	const headers = {};
	if (connection.billing === "paygo") {
		headers["X-Billing-Mode"] = "paygo";
		body["billing_mode"] = "paygo";
	}
	const warnings = [...reasoning.warnings, ...routingWarnings(routing)];
	return {
		model,
		body,
		headers,
		billing: analyzeBilling(connection, input.model, input.providerSelection),
		warnings
	};
}
/** The locked connection model, else the model of the request when it names one, else the connection's model. */
function chooseModel(locked, connectionModel, requested) {
	if (locked) return connectionModel;
	if (typeof requested === "string" && requested.trim()) return requested.trim();
	return connectionModel;
}
/** Appends `:online` and `:memory[-days]` unless the id already carries them. */
function withSuffixes(modelId, connection) {
	const segments = modelId.split(":").slice(1);
	let id = modelId;
	if (connection.webSearch && !segments.some((s) => s === "online" || s.startsWith("online/"))) id += ":online";
	if (connection.memory.enabled && !segments.some((s) => /^memory(-\d+)?$/.test(s))) {
		const days = connection.memory.expirationDays;
		id += days !== null && Number.isFinite(days) && days >= 1 ? `:memory-${Math.trunc(days)}` : ":memory";
	}
	return id;
}
function stripNeutralSamplers(body) {
	for (const [key, neutral] of NEUTRAL_SAMPLERS) if (body[key] === neutral) delete body[key];
	const bias = body["logit_bias"];
	if (isRecord$2(bias) && Object.keys(bias).length === 0) delete body["logit_bias"];
}
function isRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
// src/server/pipeline/steps/plan.ts
/** The model the request is about before suffixes: the locked connection model, else the request's, else the connection's. */
function requestedModelId(connection, body) {
	if (connection.modelLock) return connection.modelId;
	const requested = body["model"];
	return typeof requested === "string" && requested.trim() ? requested.trim() : connection.modelId;
}
/** `:online`, `:online/<level>`, `:memory`, `:memory-<days>`: routing suffixes that are not part of the catalog id. */
var SERVICE_SUFFIX = /:(?:online(?:\/[^:]*)?|memory(?:-\d+)?)$/;
/** The model id without the service suffixes of NanoGPT (`:thinking` and friends are catalog ids of their own). */
function stripServiceSuffixes(modelId) {
	let id = modelId;
	for (let i = 0; i < 4 && SERVICE_SUFFIX.test(id); i++) id = id.replace(SERVICE_SUFFIX, "");
	return id;
}
/**
* What the catalog says about a model, tolerant of every failure: a catalog that is missing, still loading or throwing
* means "unknown" (null), never a failed request. The exact id wins over the id without service suffixes.
*/
function lookupCatalog(deps, modelId) {
	const bare = stripServiceSuffixes(modelId);
	const candidates = bare === modelId ? [modelId] : [modelId, bare];
	let model = null;
	for (const id of candidates) {
		model = safely(() => deps.lookupModel(id));
		if (model) break;
	}
	const selectionId = model?.id ?? bare;
	const selection = deps.providerSelection ? safely(() => deps.providerSelection?.(selectionId) ?? null) : null;
	return {
		model,
		providerSelection: typeof selection === "boolean" ? selection : null
	};
}
function safely(read) {
	try {
		return read() ?? null;
	} catch {
		return null;
	}
}
function planStep(ctx) {
	const plan = planUpstream({
		connection: ctx.connection,
		model: ctx.model,
		body: ctx.body,
		hints: ctx.hints,
		providerSelection: ctx.providerSelection
	});
	ctx.plan.model = plan.model;
	ctx.plan.body = plan.body;
	ctx.plan.headers = {
		...ctx.plan.headers,
		...plan.headers
	};
	ctx.plan.billing = plan.billing;
	ctx.plan.warnings = plan.warnings;
}
// src/server/pipeline/index.ts
/** Run in order before the upstream call. `planStep` goes first: it builds the plan the other steps refine. */
var REQUEST_STEPS = [planStep];
/** Run once the upstream answer is complete. `usageStep` shims a whole body and completes the usage record. */
var RESPONSE_STEPS = [usageStep];
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
		const catalog = lookupCatalog(deps, requestedModelId(connection, incoming));
		const ctx = createProxyContext({
			localId: randomBytes(4).toString("hex"),
			now: startedAt,
			user,
			connection,
			key,
			model: catalog.model,
			providerSelection: catalog.providerSelection,
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
			const shim = new SseUsageShim(shimContextOf(ctx));
			try {
				for await (const chunk of upstream.body) {
					upstream.touch();
					const out = shim.push(chunk);
					if (out) await writeChunk(res, out);
					if (clientGone(ctx)) break;
				}
				if (!clientGone(ctx)) {
					const tail = shim.end();
					if (tail) await writeChunk(res, tail);
				}
			} catch (error) {
				failure = error instanceof UpstreamError ? error : new UpstreamError("unreachable", null);
			}
			ctx.resolved = shim.resolved;
			if (failure && failure.kind !== "aborted" && !res.destroyed) {
				const text = failure.kind === "timeout" ? "The upstream stopped sending data" : "The upstream connection broke";
				const code = failure.kind === "timeout" ? "upstream_timeout" : "upstream_unreachable";
				res.write(`data: ${JSON.stringify(errorBody$1("upstream_error", code, text))}\n\n`);
			}
			const aborted = clientGone(ctx) || failure?.kind === "aborted";
			ctx.usage.status = aborted ? 499 : failure ? failure.kind === "timeout" ? 504 : 502 : info.status;
			ctx.usage.error = aborted ? "client_aborted" : failure ? failure.kind === "timeout" ? "upstream_timeout" : "upstream_unreachable" : null;
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
		if (!ok) ctx.usage.error = ctx.key.redact(upstreamErrorCode(body) ?? `http_${info.status}`);
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
	/** The one usage record of the request. Bookkeeping never fails a request: a broken log is a warning. */
	async function finish(ctx, userRoot) {
		ctx.usage.latencyMs = Math.max(0, deps.now() - ctx.startedAt);
		try {
			await deps.usage.append(userRoot, ctx.usage);
		} catch (error) {
			log.warn(`usage record not written (${describe$1(error, ctx.key)})`);
		}
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
			ctx.usage.error = "client_aborted";
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
function errorBody$1(type, code, message) {
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
	sendJson$1(res, status, errorBody$1(type, code, message), {
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
	return Buffer.from(JSON.stringify(errorBody$1("upstream_error", "upstream_error", message)));
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
// src/server/routes/nanogpt.ts
var CALL_TIMEOUT_MS$1 = 15e3;
var MAX_KEY_ID_LENGTH = 200;
/** The first value of a query parameter as a trimmed string; null when it is absent or empty. */
function queryText(req, name) {
	const raw = req.query?.[name];
	const value = Array.isArray(raw) ? raw[0] : raw;
	return typeof value === "string" && value.trim() ? value.trim() : null;
}
/** `?keyId`: an id of GET /keys, or null for the active key. */
function keyIdOf$1(req) {
	const id = queryText(req, "keyId");
	if (id !== null && id.length > MAX_KEY_ID_LENGTH) throw new HttpError(400, "invalid_request", "\"keyId\" is not a key id");
	return id;
}
/** The NanoGPT key to call with: the chosen one, else the active one (the config file's key when ST's store is missing). */
function resolveKey(deps, user, keyId) {
	const { st, config } = deps;
	if (!st.available) {
		if (keyId === null && config.nanogptKey) return new SecretValue(config.nanogptKey);
		throw new HttpError(503, "secrets_unavailable", "ST secret store is unavailable");
	}
	if (keyId !== null) {
		const value = st.listSecrets(user.handle, "api_key_nanogpt").some((s) => s.id === keyId) ? st.readSecret(user.handle, SECRET_KEY_NANOGPT, keyId) : "";
		if (!value) throw new HttpError(404, "not_found", "Unknown key");
		return new SecretValue(value);
	}
	const value = st.readSecret(user.handle, SECRET_KEY_NANOGPT, null);
	if (!value) throw new HttpError(409, "no_key", "No NanoGPT key is stored; add one in SillyTavern");
	return new SecretValue(value);
}
/** One call to NanoGPT. Resolves for any HTTP status (the caller decides); rejects only for transport failures. */
async function callNanogpt(deps, key, request) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS$1);
	timer.unref?.();
	try {
		const headers = { accept: "application/json" };
		if (request.auth === "bearer") headers["authorization"] = `Bearer ${key.reveal()}`;
		else headers["x-api-key"] = key.reveal();
		if (request.body !== void 0) headers["content-type"] = "application/json";
		const response = await deps.fetch(request.url, {
			method: request.method,
			headers,
			...request.body !== void 0 ? { body: request.body } : {},
			signal: controller.signal
		});
		const text = key.redact(await response.text());
		let json = null;
		try {
			json = JSON.parse(text);
		} catch {}
		return {
			status: response.status,
			json
		};
	} catch {
		if (controller.signal.aborted) throw new HttpError(504, "upstream_timeout", "NanoGPT did not answer in time");
		throw new HttpError(502, "upstream_unreachable", "NanoGPT could not be reached");
	} finally {
		clearTimeout(timer);
	}
}
/** The HttpError for an answer the route cannot use. The upstream's own message is not echoed. */
function rejectedAnswer(status) {
	if (status === 401 || status === 403) return new HttpError(502, "key_rejected", `NanoGPT rejected the key (HTTP ${status})`);
	if (status === 429) return new HttpError(429, "rate_limited", "NanoGPT is rate limiting this key");
	return new HttpError(502, "upstream_error", `NanoGPT answered HTTP ${status}`);
}
function isOk(status) {
	return status >= 200 && status < 300;
}
// src/server/routes/account.ts
var DECIMAL$1 = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
var REQUEST_ID = /^[A-Za-z0-9._:-]{1,200}$/;
/** Answers that mean "this key has no subscription endpoint" rather than "the call failed". */
var NO_SUBSCRIPTION_STATUSES = /* @__PURE__ */ new Set([
	403,
	404,
	405,
	410,
	501
]);
/** A Unix timestamp below this is in seconds, at or above it in milliseconds (1e11 s is the year 5138, 1e11 ms is 1973). */
var SECONDS_LIMIT$1 = 1e11;
/** A number from a JSON number or a decimal string; null for anything else (a balance may be any finite value). */
function amount$1(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && DECIMAL$1.test(value.trim())) {
		const n = Number(value.trim());
		return Number.isFinite(n) ? n : null;
	}
	return null;
}
/** `check-balance`: `usd_balance` and `nano_balance` are decimal strings. */
function mapBalance(payload, fetchedAt) {
	return {
		usdBalance: amount$1(payload["usd_balance"] ?? payload["usdBalance"]),
		nanoBalance: amount$1(payload["nano_balance"] ?? payload["nanoBalance"]),
		fetchedAt
	};
}
function timestamp(value) {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < SECONDS_LIMIT$1 ? Math.round(value * 1e3) : value;
	if (typeof value === "string" && value.trim()) {
		const parsed = DECIMAL$1.test(value.trim()) ? timestamp(Number(value.trim())) : Date.parse(value);
		return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}
/** One window of the quota document: `{ used, remaining, percentUsed, resetAt }`, or null/absent for "no such window". */
function quotaWindow(raw, limit) {
	const window = isRecord$3(raw) ? raw : null;
	const used = window ? amount$1(window["used"]) : null;
	const remaining = window ? amount$1(window["remaining"]) : null;
	return {
		used,
		limit: amount$1(limit) ?? (used !== null && remaining !== null ? used + remaining : null),
		resetsAt: window ? timestamp(window["resetAt"] ?? window["resetsAt"]) : null
	};
}
/**
* NanoGPT's `GET /api/subscription/v1/usage` as SubscriptionUsage; null when the payload is not a quota document. The
* limits sit in `limits.*InputTokens`, the usage in `dailyInputTokens` / `weeklyInputTokens` (`null` when there is no such
* window); `routing.recommendedMode` says what NanoGPT advises right now ('unavailable' and anything else become null).
*/
function mapSubscriptionUsage(payload) {
	if (!isRecord$3(payload)) return null;
	const limits = isRecord$3(payload["limits"]) ? payload["limits"] : {};
	const routing = isRecord$3(payload["routing"]) ? payload["routing"] : {};
	const state = payload["state"];
	const active = typeof payload["active"] === "boolean" ? payload["active"] : typeof state === "string" ? state === "active" : null;
	const daily = quotaWindow(payload["dailyInputTokens"], limits["dailyInputTokens"]);
	const weekly = quotaWindow(payload["weeklyInputTokens"], limits["weeklyInputTokens"]);
	const hasWindow = isRecord$3(payload["dailyInputTokens"]) || isRecord$3(payload["weeklyInputTokens"]);
	if (active === null && !hasWindow) return null;
	const mode = routing["recommendedMode"];
	return {
		active: active ?? true,
		daily,
		weekly,
		recommendedMode: mode === "subscription" || mode === "paygo" ? mode : null
	};
}
var accountRoutes = (router, deps) => {
	router.get("/account/balance", route(deps.log, async (req, res) => {
		const answer = await callNanogpt(deps, resolveKey(deps, userOf(req, deps), keyIdOf$1(req)), {
			method: "POST",
			url: `${deps.config.siteBase}/api/check-balance`,
			auth: "x-api-key",
			body: "{}"
		});
		if (!isOk(answer.status)) throw rejectedAnswer(answer.status);
		if (!isRecord$3(answer.json)) throw new HttpError(502, "bad_response", "NanoGPT answered with something else than JSON");
		sendJson(res, 200, mapBalance(answer.json, deps.now()));
	}));
	router.get("/account/subscription", route(deps.log, async (req, res) => {
		const answer = await callNanogpt(deps, resolveKey(deps, userOf(req, deps), keyIdOf$1(req)), {
			method: "GET",
			url: `${deps.config.siteBase}/api/subscription/v1/usage`,
			auth: "bearer"
		});
		const none = {
			subscription: null,
			fetchedAt: deps.now()
		};
		if (NO_SUBSCRIPTION_STATUSES.has(answer.status)) return sendJson(res, 200, none);
		if (!isOk(answer.status)) throw rejectedAnswer(answer.status);
		sendJson(res, 200, {
			subscription: mapSubscriptionUsage(answer.json),
			fetchedAt: deps.now()
		});
	}));
	router.post("/lookup/:requestId", route(deps.log, async (req, res) => {
		const user = userOf(req, deps);
		const requestId = req.params["requestId"] ?? "";
		if (!REQUEST_ID.test(requestId)) throw new HttpError(400, "invalid_request", "Not a request id");
		const answer = await callNanogpt(deps, resolveKey(deps, user, keyIdOf$1(req)), {
			method: "GET",
			url: `${deps.config.upstreamBase}/usage/requests/${encodeURIComponent(requestId)}`,
			auth: "bearer"
		});
		if (answer.status === 404) return sendJson(res, 200, {
			requestId,
			ready: false,
			costUsd: null
		});
		if (!isOk(answer.status)) throw rejectedAnswer(answer.status);
		if (!isRecord$3(answer.json)) throw new HttpError(502, "bad_response", "NanoGPT answered with something else than JSON");
		sendJson(res, 200, {
			requestId,
			ready: true,
			costUsd: lookupCost(answer.json)
		});
	}));
};
/** The charge in USD: `cost` is a decimal string. 0 in any currency is 0; a paid amount in another currency is not dollars. */
function lookupCost(payload) {
	const cost = parseCost(payload["cost"]);
	if (cost === null) return null;
	const currency = typeof payload["currency"] === "string" ? payload["currency"].trim().toUpperCase() : "";
	return currency === "" || currency === "USD" || cost === 0 ? cost : null;
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
var MAX_LABEL_LENGTH$1 = 100;
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
		const label = (typeof rawLabel === "string" ? rawLabel.trim() : "").slice(0, MAX_LABEL_LENGTH$1) || DEFAULT_LABEL;
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
/**
* The shape of a Management token: `sk-nano-mgmt-` plus at least MGMT_TOKEN_MIN_BODY printable characters, no spaces, at
* most MGMT_TOKEN_MAX_LENGTH in all. Surrounding whitespace (a pasted newline) is dropped. A normal inference key
* (`sk-nano-<uuid>`) is told apart, because pasting it into the wrong box is the likely mistake.
*/
function checkMgmtToken(raw) {
	if (typeof raw !== "string") return {
		ok: false,
		issue: "not_string"
	};
	const token = raw.trim();
	if (!token) return {
		ok: false,
		issue: "empty"
	};
	if (token.length > 512) return {
		ok: false,
		issue: "too_long"
	};
	if (!token.startsWith("sk-nano-mgmt-")) return {
		ok: false,
		issue: token.startsWith("sk-nano-") ? "inference_key" : "prefix"
	};
	if (!/^[!-~]+$/.test(token)) return {
		ok: false,
		issue: "characters"
	};
	if (token.length - 13 < 8) return {
		ok: false,
		issue: "too_short"
	};
	return {
		ok: true,
		token
	};
}
/** English text for an issue; never contains the value. */
function describeTokenIssue(issue) {
	switch (issue) {
		case "not_string": return "\"token\" must be a string";
		case "empty": return "\"token\" is empty";
		case "inference_key": return `This is an inference API key. A Management token starts with ${MGMT_TOKEN_PREFIX}`;
		case "prefix": return `A Management token starts with ${MGMT_TOKEN_PREFIX}`;
		case "too_short": return "The token is too short";
		case "too_long": return "The token is too long";
		case "characters": return "The token must not contain spaces or special characters";
	}
}
var KEY_LIMIT_KINDS = [
	"requests",
	"usd",
	"inputTokens",
	"subscriptionInputTokens"
];
var KEY_LIMIT_PERIODS = [
	"daily",
	"weekly",
	"monthly"
];
/** Wire field names of the twelve limits. */
var KEY_LIMIT_FIELDS = {
	requests: {
		daily: "daily_rpd_limit",
		weekly: "weekly_request_limit",
		monthly: "monthly_request_limit"
	},
	usd: {
		daily: "daily_usd_limit",
		weekly: "weekly_usd_limit",
		monthly: "monthly_usd_limit"
	},
	inputTokens: {
		daily: "daily_input_token_limit",
		weekly: "weekly_input_token_limit",
		monthly: "monthly_input_token_limit"
	},
	subscriptionInputTokens: {
		daily: "daily_subscription_input_token_limit",
		weekly: "weekly_subscription_input_token_limit",
		monthly: "monthly_subscription_input_token_limit"
	}
};
var INT_MAX = 2147483647;
/** What a limit may be: `integer` and the largest value per period (the smallest is 0). USD steps are 0.0001. */
var KEY_LIMIT_RANGES = {
	requests: {
		integer: true,
		max: {
			daily: 1e7,
			weekly: INT_MAX,
			monthly: INT_MAX
		}
	},
	usd: {
		integer: false,
		max: {
			daily: 1e5,
			weekly: 1e5,
			monthly: 1e5
		}
	},
	inputTokens: {
		integer: true,
		max: {
			daily: INT_MAX,
			weekly: INT_MAX,
			monthly: INT_MAX
		}
	},
	subscriptionInputTokens: {
		integer: true,
		max: {
			daily: INT_MAX,
			weekly: INT_MAX,
			monthly: INT_MAX
		}
	}
};
var USD_STEP = 1e4;
var ZDR_POLICIES = [
	"zdr",
	"off",
	"unset"
];
var REASONING_EFFORTS = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
var RESPONSE_FORMATS = ["text", "json_object"];
var REASONING_SUMMARIES = [
	"auto",
	"concise",
	"detailed"
];
var VERBOSITIES = [
	"low",
	"medium",
	"high"
];
var ROUTINGS = [
	"auto",
	"speed",
	"throughput",
	"latency",
	"price",
	"caching"
];
var SERVICE_TIERS = [
	"auto",
	"default",
	"flex",
	"priority",
	"ultrafast"
];
var CACHE_TTLS = ["5m", "1h"];
var PRESET_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
var PRESET_PROMPT_MAX_LENGTH = 12e3;
var PRESET_BODY_LIMIT_BYTES = 16384;
var DECIMAL = /^[+-]?\d+(?:\.\d+)?$/;
/** A Unix timestamp below this is in seconds, at or above it in milliseconds. */
var SECONDS_LIMIT = 1e11;
function numeric(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && DECIMAL.test(value.trim())) return Number(value.trim());
	return null;
}
function epochMs(value) {
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value <= 0) return null;
		return value < SECONDS_LIMIT ? Math.round(value * 1e3) : value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}
function pick$1(value, allowed) {
	if (typeof value !== "string") return null;
	const wanted = value.trim().toLowerCase();
	return allowed.find((item) => item === wanted) ?? null;
}
function text$1(value) {
	return typeof value === "string" ? value : null;
}
function flag(value) {
	return typeof value === "boolean" ? value : null;
}
/** The array of a list payload: `{ data: [...] }` (the API's shape), a bare array, or null for anything else. */
function listOf(raw) {
	if (Array.isArray(raw)) return raw;
	if (isRecord$3(raw) && Array.isArray(raw["data"])) return raw["data"];
	return null;
}
function emptyLimits() {
	const empty = () => ({
		daily: null,
		weekly: null,
		monthly: null
	});
	return {
		requests: empty(),
		usd: empty(),
		inputTokens: empty(),
		subscriptionInputTokens: empty()
	};
}
/** One element of `GET /api-keys`, or the answer of POST/PATCH: tolerant of missing and extra fields. null: no usable id. */
function normalizeManagedKey(raw) {
	if (!isRecord$3(raw)) return null;
	const rawId = raw["id"];
	const id = typeof rawId === "number" && Number.isFinite(rawId) ? String(rawId) : typeof rawId === "string" ? rawId.trim() : "";
	if (!id) return null;
	const limits = emptyLimits();
	for (const kind of KEY_LIMIT_KINDS) for (const period of KEY_LIMIT_PERIODS) {
		const value = numeric(raw[KEY_LIMIT_FIELDS[kind][period]]);
		limits[kind][period] = value !== null && value >= 0 ? value : null;
	}
	return {
		id,
		name: typeof raw["name"] === "string" ? raw["name"] : "",
		status: raw["status"] === "expired" ? "expired" : "active",
		createdAt: epochMs(raw["created_at"]),
		expiresAt: epochMs(raw["expires_at"]),
		limits,
		zdrPolicy: pick$1(raw["zdr_policy"], ZDR_POLICIES)
	};
}
/** `GET /api-keys`: every usable key, in the API's order, once per id. null when the payload is not a list at all. */
function normalizeManagedKeys(raw) {
	const items = listOf(raw);
	if (!items) return null;
	const seen = /* @__PURE__ */ new Set();
	const keys = [];
	for (const item of items) {
		const key = normalizeManagedKey(item);
		if (!key || seen.has(key.id)) continue;
		seen.add(key.id);
		keys.push(key);
	}
	return keys;
}
function readThinking(raw) {
	if (typeof raw === "boolean") return {
		enabled: raw,
		budgetTokens: null
	};
	if (!isRecord$3(raw)) return null;
	const budget = numeric(raw["budget_tokens"]);
	return {
		enabled: raw["type"] === "enabled",
		budgetTokens: budget !== null && Number.isInteger(budget) && budget > 0 ? budget : null
	};
}
function readCaching(raw) {
	if (typeof raw === "boolean") return {
		enabled: raw,
		ttl: null
	};
	if (!isRecord$3(raw) || typeof raw["enabled"] !== "boolean") return null;
	return {
		enabled: raw["enabled"],
		ttl: pick$1(raw["ttl"], CACHE_TTLS)
	};
}
/** One element of `GET /model-presets` or the answer of PUT. null: no usable name. */
function normalizeModelPreset(raw) {
	if (!isRecord$3(raw)) return null;
	const name = typeof raw["name"] === "string" ? raw["name"].trim().toLowerCase() : "";
	if (!name) return null;
	return {
		name,
		model: typeof raw["model"] === "string" ? raw["model"] : "",
		systemPrompt: text$1(raw["system_prompt"]),
		maxTokens: numeric(raw["max_tokens"]),
		topK: numeric(raw["top_k"]),
		temperature: numeric(raw["temperature"]),
		topP: numeric(raw["top_p"]),
		minP: numeric(raw["min_p"]),
		topA: numeric(raw["top_a"]),
		frequencyPenalty: numeric(raw["frequency_penalty"]),
		presencePenalty: numeric(raw["presence_penalty"]),
		repetitionPenalty: numeric(raw["repetition_penalty"]),
		responseFormat: pick$1(raw["response_format_type"], RESPONSE_FORMATS),
		structuredOutputs: flag(raw["structured_outputs"]),
		reasoningEffort: pick$1(raw["reasoning_effort"], REASONING_EFFORTS),
		reasoningSummary: pick$1(raw["reasoning_summary"], REASONING_SUMMARIES),
		verbosity: pick$1(raw["verbosity"], VERBOSITIES),
		routing: pick$1(raw["provider_routing_preference"], ROUTINGS),
		serviceTier: pick$1(raw["service_tier"], SERVICE_TIERS),
		thinking: readThinking(raw["thinking"]),
		promptCaching: readCaching(raw["prompt_caching"]),
		createdAt: epochMs(raw["created_at"]),
		updatedAt: epochMs(raw["updated_at"])
	};
}
/** `GET /model-presets`: every usable preset, once per name. null when the payload is not a list at all. */
function normalizeModelPresets(raw) {
	const items = listOf(raw);
	if (!items) return null;
	const seen = /* @__PURE__ */ new Set();
	const presets = [];
	for (const item of items) {
		const preset = normalizeModelPreset(item);
		if (!preset || seen.has(preset.name)) continue;
		seen.add(preset.name);
		presets.push(preset);
	}
	return presets;
}
/** `field: message; field: message`, at most five, for an error message. */
function describeIssues(issues) {
	const shown = issues.slice(0, 5).map((issue) => `${issue.field}: ${issue.message}`);
	if (issues.length > shown.length) shown.push(`and ${issues.length - shown.length} more`);
	return shown.join("; ");
}
function checked(value, issues) {
	return issues.length === 0 ? {
		ok: true,
		value
	} : {
		ok: false,
		issues
	};
}
/** The keys of `raw` outside `allowed` and `ignored`: one `unknown_field` issue each. */
function rejectUnknown(raw, allowed, ignored, issues) {
	for (const key of Object.keys(raw)) {
		if (allowed.includes(key) || ignored.includes(key)) continue;
		issues.push({
			field: key,
			code: "unknown_field",
			message: "is not a field of this request"
		});
	}
}
function checkName(value, field, issues) {
	if (typeof value !== "string") {
		issues.push({
			field,
			code: "type",
			message: "must be a string"
		});
		return null;
	}
	const name = value.trim();
	if (!name || name.length > 120) {
		issues.push({
			field,
			code: "length",
			message: `must be 1 to 120 characters, not blank`
		});
		return null;
	}
	return name;
}
function checkExpiry(value, issues) {
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || !Number.isFinite(new Date(value).getTime())) {
		issues.push({
			field: "expiresAt",
			code: "type",
			message: "must be null or a time in ms since epoch"
		});
		return;
	}
	return Math.round(value);
}
function checkPolicy(value, allowed, issues) {
	const policy = pick$1(value, allowed);
	if (policy === null) {
		issues.push({
			field: "zdrPolicy",
			code: "enum",
			message: `must be one of: ${allowed.join(", ")}`
		});
		return;
	}
	return policy;
}
function checkLimits(raw, issues) {
	if (!isRecord$3(raw)) {
		issues.push({
			field: "limits",
			code: "type",
			message: "must be an object"
		});
		return;
	}
	const out = {};
	for (const key of Object.keys(raw)) {
		const kind = KEY_LIMIT_KINDS.find((k) => k === key);
		if (!kind) {
			issues.push({
				field: `limits.${key}`,
				code: "unknown_field",
				message: "is not a limit kind"
			});
			continue;
		}
		const periods = raw[kind];
		if (!isRecord$3(periods)) {
			issues.push({
				field: `limits.${kind}`,
				code: "type",
				message: "must be an object"
			});
			continue;
		}
		const range = KEY_LIMIT_RANGES[kind];
		const kept = {};
		for (const name of Object.keys(periods)) {
			const period = KEY_LIMIT_PERIODS.find((p) => p === name);
			const field = `limits.${kind}.${name}`;
			if (!period) {
				issues.push({
					field,
					code: "unknown_field",
					message: "is not a period"
				});
				continue;
			}
			const value = periods[period];
			if (value === null) {
				kept[period] = null;
				continue;
			}
			if (typeof value !== "number" || !Number.isFinite(value)) {
				issues.push({
					field,
					code: "type",
					message: "must be null (unlimited) or a number"
				});
				continue;
			}
			if (range.integer && !Number.isInteger(value)) {
				issues.push({
					field,
					code: "integer",
					message: "must be a whole number"
				});
				continue;
			}
			const cleaned = range.integer ? value : Math.round(value * USD_STEP) / USD_STEP;
			if (!range.integer && Math.abs(value * USD_STEP - Math.round(value * USD_STEP)) > 1e-6) {
				issues.push({
					field,
					code: "step",
					message: "must be a multiple of 0.0001"
				});
				continue;
			}
			if (cleaned < 0 || cleaned > range.max[period]) {
				issues.push({
					field,
					code: "range",
					message: `must be between 0 and ${range.max[period]}`
				});
				continue;
			}
			kept[period] = cleaned;
		}
		if (Object.keys(kept).length > 0) out[kind] = kept;
	}
	return out;
}
/** Fields of a ManagedKey a client may send back untouched (an edit form posts the whole key): ignored, not rejected. */
var KEY_READ_ONLY = [
	"id",
	"status",
	"createdAt"
];
/**
* Checks a PATCH of a key (KeyLimitsPatch): the name trimmed, USD amounts cleaned of float noise, limits within the
* API's ranges and steps, the zdr policy one of zdr/off/unset. Unknown fields are refused (a typo must not silently do
* nothing); the read-only fields of a ManagedKey are ignored. An input that changes nothing is refused: the API needs at
* least one field.
*/
function sanitizeKeyLimitsPatch(raw) {
	if (!isRecord$3(raw)) return checked({}, [{
		field: "body",
		code: "type",
		message: "must be a JSON object"
	}]);
	const issues = [];
	rejectUnknown(raw, [
		"name",
		"expiresAt",
		"zdrPolicy",
		"limits"
	], KEY_READ_ONLY, issues);
	const patch = {};
	if (raw["name"] !== void 0) {
		const name = checkName(raw["name"], "name", issues);
		if (name !== null) patch.name = name;
	}
	if (raw["expiresAt"] !== void 0) {
		const expiresAt = checkExpiry(raw["expiresAt"], issues);
		if (expiresAt !== void 0) patch.expiresAt = expiresAt;
	}
	if (raw["zdrPolicy"] !== void 0) {
		const policy = checkPolicy(raw["zdrPolicy"], ZDR_POLICIES, issues);
		if (policy) patch.zdrPolicy = policy;
	}
	if (raw["limits"] !== void 0) {
		const limits = checkLimits(raw["limits"], issues);
		if (limits && Object.keys(limits).length > 0) patch.limits = limits;
	}
	if (issues.length === 0 && Object.keys(patch).length === 0) issues.push({
		field: "body",
		code: "empty",
		message: "must change at least one field"
	});
	return checked(patch, issues);
}
/** Checks a new key (KeyCreateInput). Same rules as the patch; the name is required and `unset` is not a choice. */
function sanitizeKeyCreateInput(raw) {
	if (!isRecord$3(raw)) return checked({ name: "" }, [{
		field: "body",
		code: "type",
		message: "must be a JSON object"
	}]);
	const issues = [];
	rejectUnknown(raw, [
		"name",
		"expiresAt",
		"zdrPolicy",
		"limits"
	], [], issues);
	const input = { name: "" };
	if (raw["name"] === void 0) issues.push({
		field: "name",
		code: "required",
		message: "is required"
	});
	else input.name = checkName(raw["name"], "name", issues) ?? "";
	if (raw["expiresAt"] !== void 0) {
		const expiresAt = checkExpiry(raw["expiresAt"], issues);
		if (expiresAt !== void 0) input.expiresAt = expiresAt;
	}
	if (raw["zdrPolicy"] !== void 0) {
		const policy = checkPolicy(raw["zdrPolicy"], ["zdr", "off"], issues);
		if (policy === "zdr" || policy === "off") input.zdrPolicy = policy;
	}
	if (raw["limits"] !== void 0) {
		const limits = checkLimits(raw["limits"], issues);
		if (limits && Object.keys(limits).length > 0) input.limits = limits;
	}
	return checked(input, issues);
}
function limitsToWire(limits, wire) {
	if (!limits) return;
	for (const kind of KEY_LIMIT_KINDS) {
		const periods = limits[kind];
		if (!periods) continue;
		for (const period of KEY_LIMIT_PERIODS) {
			const value = periods[period];
			if (value !== void 0) wire[KEY_LIMIT_FIELDS[kind][period]] = value;
		}
	}
}
/** The PATCH body of the API for a checked patch (only the fields the patch carries; null clears). */
function keyPatchToWire(patch) {
	const wire = {};
	if (patch.name !== void 0) wire["name"] = patch.name;
	if (patch.expiresAt !== void 0) wire["expires_at"] = patch.expiresAt === null ? null : new Date(patch.expiresAt).toISOString();
	if (patch.zdrPolicy !== void 0) wire["zdr_policy"] = patch.zdrPolicy;
	limitsToWire(patch.limits, wire);
	return wire;
}
/** The POST body of the API for a checked new key. */
function keyCreateToWire(input) {
	const wire = { name: input.name };
	if (input.expiresAt !== void 0) wire["expires_at"] = input.expiresAt === null ? null : new Date(input.expiresAt).toISOString();
	if (input.zdrPolicy !== void 0) wire["zdr_policy"] = input.zdrPolicy;
	limitsToWire(input.limits, wire);
	return wire;
}
/** A NanoGPT key id: a positive integer as a string. null for anything else. */
function checkKeyId(raw) {
	return typeof raw === "string" && /^[1-9][0-9]{0,17}$/.test(raw) ? raw : null;
}
/** A preset name as the API takes it (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$`), lower-cased as the API returns it. */
function checkPresetName(raw) {
	return typeof raw === "string" && PRESET_NAME_PATTERN.test(raw) ? raw.toLowerCase() : null;
}
/** Every setting key: the type forces this list to stay complete. */
var SETTING_KEYS = {
	systemPrompt: true,
	maxTokens: true,
	topK: true,
	temperature: true,
	topP: true,
	minP: true,
	topA: true,
	frequencyPenalty: true,
	presencePenalty: true,
	repetitionPenalty: true,
	responseFormat: true,
	structuredOutputs: true,
	reasoningEffort: true,
	reasoningSummary: true,
	verbosity: true,
	routing: true,
	serviceTier: true,
	thinking: true,
	promptCaching: true
};
/** What a form may send back untouched from a ModelPreset: ignored, not rejected. */
var PRESET_READ_ONLY = [
	"name",
	"createdAt",
	"updatedAt"
];
function checkNumber(raw, field, rule, issues) {
	const value = raw[field];
	if (value === void 0 || value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		issues.push({
			field,
			code: "type",
			message: "must be a number or null"
		});
		return null;
	}
	if (rule.integer && !Number.isInteger(value)) {
		issues.push({
			field,
			code: "integer",
			message: "must be a whole number"
		});
		return null;
	}
	if (value < rule.min || value > rule.max) {
		issues.push({
			field,
			code: "range",
			message: `must be between ${rule.min} and ${rule.max}`
		});
		return null;
	}
	return value;
}
function checkEnum(raw, field, allowed, issues) {
	const value = raw[field];
	if (value === void 0 || value === null) return null;
	const found = typeof value === "string" ? allowed.find((item) => item === value) ?? null : null;
	if (found === null) issues.push({
		field,
		code: "enum",
		message: `must be one of: ${allowed.join(", ")}`
	});
	return found;
}
function checkFlag(raw, field, issues) {
	const value = raw[field];
	if (value === void 0 || value === null) return null;
	if (typeof value !== "boolean") {
		issues.push({
			field,
			code: "type",
			message: "must be true, false or null"
		});
		return null;
	}
	return value;
}
function checkThinking(raw, issues) {
	const value = raw["thinking"];
	if (value === void 0 || value === null) return null;
	if (!isRecord$3(value) || typeof value["enabled"] !== "boolean") {
		issues.push({
			field: "thinking",
			code: "type",
			message: "must be null or { enabled: boolean, budgetTokens }"
		});
		return null;
	}
	const rawBudget = value["budgetTokens"];
	let budget = null;
	if (rawBudget !== void 0 && rawBudget !== null) {
		if (typeof rawBudget !== "number" || !Number.isInteger(rawBudget) || rawBudget < 1 || rawBudget > 1e6) {
			issues.push({
				field: "thinking.budgetTokens",
				code: "range",
				message: "must be a whole number from 1 to 1000000"
			});
			return null;
		}
		budget = rawBudget;
	}
	if (budget !== null && !value["enabled"]) {
		issues.push({
			field: "thinking.budgetTokens",
			code: "conflict",
			message: "needs thinking to be enabled"
		});
		return null;
	}
	return {
		enabled: value["enabled"],
		budgetTokens: budget
	};
}
function checkCaching(raw, issues) {
	const value = raw["promptCaching"];
	if (value === void 0 || value === null) return null;
	if (!isRecord$3(value) || typeof value["enabled"] !== "boolean") {
		issues.push({
			field: "promptCaching",
			code: "type",
			message: "must be null or { enabled: boolean, ttl }"
		});
		return null;
	}
	const ttl = value["ttl"];
	if (ttl === void 0 || ttl === null) return {
		enabled: value["enabled"],
		ttl: null
	};
	const found = typeof ttl === "string" ? CACHE_TTLS.find((item) => item === ttl) ?? null : null;
	if (found === null) {
		issues.push({
			field: "promptCaching.ttl",
			code: "enum",
			message: `must be one of: ${CACHE_TTLS.join(", ")}`
		});
		return null;
	}
	return {
		enabled: value["enabled"],
		ttl: found
	};
}
var SAMPLER = {
	integer: false,
	min: 0,
	max: 1
};
var PENALTY = {
	integer: false,
	min: -2,
	max: 2
};
/**
* Checks what a client sends for a preset and fills every setting that was left out with null (a PUT replaces the whole
* preset, so "left out" and null mean the same). Ranges, enums and lengths are the API's own; two rules cross fields:
* `structuredOutputs: true` needs `responseFormat: 'json_object'`, and the flex / priority service tiers cannot go with
* ranked routing (speed, throughput, latency, price). Unknown fields are refused; the read-only fields of a ModelPreset
* are ignored. The serialised body must fit the API's 16 KiB.
*/
function sanitizePresetInput(raw) {
	const empty = sanitizedEmpty();
	if (!isRecord$3(raw)) return checked(empty, [{
		field: "body",
		code: "type",
		message: "must be a JSON object"
	}]);
	const issues = [];
	rejectUnknown(raw, ["model", ...Object.keys(SETTING_KEYS)], PRESET_READ_ONLY, issues);
	let model = "";
	const rawModel = raw["model"];
	if (rawModel === void 0 || rawModel === null) issues.push({
		field: "model",
		code: "required",
		message: "is required"
	});
	else if (typeof rawModel !== "string") issues.push({
		field: "model",
		code: "type",
		message: "must be a string"
	});
	else {
		model = rawModel.trim();
		if (!model || model.length > 256) {
			issues.push({
				field: "model",
				code: "length",
				message: `must be 1 to 256 characters`
			});
			model = "";
		}
	}
	let systemPrompt = null;
	const rawPrompt = raw["systemPrompt"];
	if (rawPrompt !== void 0 && rawPrompt !== null) {
		if (typeof rawPrompt !== "string") issues.push({
			field: "systemPrompt",
			code: "type",
			message: "must be a string or null"
		});
		else if (rawPrompt.length > 12e3) issues.push({
			field: "systemPrompt",
			code: "length",
			message: `must be at most ${PRESET_PROMPT_MAX_LENGTH} characters`
		});
		else systemPrompt = rawPrompt;
	}
	const input = {
		model,
		systemPrompt,
		maxTokens: checkNumber(raw, "maxTokens", {
			integer: true,
			min: 1,
			max: 1e6
		}, issues),
		topK: checkNumber(raw, "topK", {
			integer: true,
			min: 0,
			max: 1e6
		}, issues),
		temperature: checkNumber(raw, "temperature", {
			integer: false,
			min: 0,
			max: 2
		}, issues),
		topP: checkNumber(raw, "topP", SAMPLER, issues),
		minP: checkNumber(raw, "minP", SAMPLER, issues),
		topA: checkNumber(raw, "topA", SAMPLER, issues),
		frequencyPenalty: checkNumber(raw, "frequencyPenalty", PENALTY, issues),
		presencePenalty: checkNumber(raw, "presencePenalty", PENALTY, issues),
		repetitionPenalty: checkNumber(raw, "repetitionPenalty", PENALTY, issues),
		responseFormat: checkEnum(raw, "responseFormat", RESPONSE_FORMATS, issues),
		structuredOutputs: checkFlag(raw, "structuredOutputs", issues),
		reasoningEffort: checkEnum(raw, "reasoningEffort", REASONING_EFFORTS, issues),
		reasoningSummary: checkEnum(raw, "reasoningSummary", REASONING_SUMMARIES, issues),
		verbosity: checkEnum(raw, "verbosity", VERBOSITIES, issues),
		routing: checkEnum(raw, "routing", ROUTINGS, issues),
		serviceTier: checkEnum(raw, "serviceTier", SERVICE_TIERS, issues),
		thinking: checkThinking(raw, issues),
		promptCaching: checkCaching(raw, issues)
	};
	if (input.structuredOutputs === true && input.responseFormat !== "json_object") issues.push({
		field: "structuredOutputs",
		code: "conflict",
		message: "needs responseFormat \"json_object\""
	});
	const rankedRouting = input.routing === "speed" || input.routing === "throughput" || input.routing === "latency" || input.routing === "price";
	if ((input.serviceTier === "flex" || input.serviceTier === "priority") && rankedRouting) issues.push({
		field: "serviceTier",
		code: "conflict",
		message: "flex and priority cannot go with speed, throughput, latency or price routing"
	});
	if (issues.length === 0 && new TextEncoder().encode(JSON.stringify(presetToWire(input))).length > 16384) issues.push({
		field: "body",
		code: "too_large",
		message: `must be at most ${PRESET_BODY_LIMIT_BYTES} bytes`
	});
	return checked(input, issues);
}
function sanitizedEmpty() {
	return {
		model: "",
		systemPrompt: null,
		maxTokens: null,
		topK: null,
		temperature: null,
		topP: null,
		minP: null,
		topA: null,
		frequencyPenalty: null,
		presencePenalty: null,
		repetitionPenalty: null,
		responseFormat: null,
		structuredOutputs: null,
		reasoningEffort: null,
		reasoningSummary: null,
		verbosity: null,
		routing: null,
		serviceTier: null,
		thinking: null,
		promptCaching: null
	};
}
/** The PUT body of the API for a checked preset: settings that are null are left out (the API reads them as null). */
function presetToWire(preset) {
	const thinking = preset.thinking;
	const caching = preset.promptCaching;
	const wire = {
		model: preset.model,
		system_prompt: preset.systemPrompt,
		max_tokens: preset.maxTokens,
		top_k: preset.topK,
		temperature: preset.temperature,
		top_p: preset.topP,
		min_p: preset.minP,
		top_a: preset.topA,
		frequency_penalty: preset.frequencyPenalty,
		presence_penalty: preset.presencePenalty,
		repetition_penalty: preset.repetitionPenalty,
		response_format_type: preset.responseFormat,
		structured_outputs: preset.structuredOutputs,
		reasoning_effort: preset.reasoningEffort,
		reasoning_summary: preset.reasoningSummary,
		verbosity: preset.verbosity,
		provider_routing_preference: preset.routing,
		service_tier: preset.serviceTier,
		thinking: !thinking ? null : thinking.enabled && thinking.budgetTokens !== null ? {
			type: "enabled",
			budget_tokens: thinking.budgetTokens
		} : thinking.enabled,
		prompt_caching: !caching ? null : caching.ttl === null ? caching.enabled : {
			enabled: caching.enabled,
			ttl: caching.ttl
		}
	};
	for (const key of Object.keys(wire)) if (wire[key] === null) delete wire[key];
	return wire;
}
// src/server/routes/mgmt-api.ts
var CALL_TIMEOUT_MS = 15e3;
var MAX_DETAIL_LENGTH = 200;
/** One call to the Management API at `config.mgmtBase`, and nowhere else. Resolves for any HTTP status; rejects with an HttpError for transport failures. */
async function callMgmt(deps, token, request) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
	timer.unref?.();
	try {
		const headers = {
			accept: "application/json",
			authorization: `Bearer ${token.reveal()}`
		};
		if (request.body !== void 0) headers["content-type"] = "application/json";
		if (request.idempotencyKey) headers["idempotency-key"] = request.idempotencyKey;
		const response = await deps.fetch(`${deps.config.mgmtBase}${request.path}`, {
			method: request.method,
			headers,
			...request.body !== void 0 ? { body: JSON.stringify(request.body) } : {},
			signal: controller.signal
		});
		const text = token.redact(await response.text());
		let json = null;
		try {
			json = JSON.parse(text);
		} catch {}
		return {
			status: response.status,
			json
		};
	} catch {
		if (controller.signal.aborted) throw new HttpError(504, "upstream_timeout", "NanoGPT did not answer in time");
		throw new HttpError(502, "upstream_unreachable", "NanoGPT could not be reached");
	} finally {
		clearTimeout(timer);
	}
}
/** `{ error: { code, message, request_id, details } }` of the Management API, read leniently. */
function errorBody(json) {
	const error = isRecord$3(json) && isRecord$3(json["error"]) ? json["error"] : {};
	const code = typeof error["code"] === "string" ? error["code"] : null;
	const parts = [];
	if (Array.isArray(error["details"])) {
		for (const item of error["details"]) if (isRecord$3(item) && typeof item["field"] === "string" && typeof item["issue"] === "string") parts.push(`${item["field"]}: ${item["issue"]}`);
	}
	return {
		code,
		detail: parts.join("; ").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_DETAIL_LENGTH)
	};
}
/**
* The HttpError for an answer a route cannot use. NanoGPT's own text is not echoed, except the `field: issue` pairs of a
* 400 and the code of a 409. 401 and 403 never go back as such: ST's front end reads them as "log in again".
*/
function mgmtFailure(answer, needed) {
	const { code, detail } = errorBody(answer.json);
	switch (answer.status) {
		case 400: return new HttpError(400, "invalid_request", `NanoGPT refused the request${detail ? `: ${detail}` : ""}`);
		case 401: return new HttpError(502, "mgmt_token_invalid", "NanoGPT rejected the Management token (revoked, expired or wrong)");
		case 403:
			if (code === "insufficient_scope") return new HttpError(409, "mgmt_scope_missing", `The Management token lacks the ${needed ?? "required"} scope`);
			return new HttpError(502, "upstream_error", "NanoGPT answered HTTP 403");
		case 404: return new HttpError(404, "not_found", "NanoGPT has no such key or preset");
		case 409: return new HttpError(409, code !== null && /^[a-z][a-z0-9_]{2,63}$/.test(code) ? code : "conflict", "NanoGPT refused the change as a conflict");
		case 413: return new HttpError(413, "payload_too_large", "The request body is too large for NanoGPT");
		case 429: return new HttpError(429, "rate_limited", "NanoGPT is rate limiting this token; try again later");
		default: return new HttpError(502, "upstream_error", `NanoGPT answered HTTP ${answer.status}`);
	}
}
function isScopeRefusal(answer) {
	return answer.status === 403 && errorBody(answer.json).code === "insufficient_scope";
}
/**
* Proves a token with one cheap read call (`GET /api-keys`). NanoGPT recognising the token is what counts: a 403
* insufficient_scope also means "known token, lacks api_keys:read" (a usage-only token, say), so it is valid. Never
* throws; trouble reaching NanoGPT leaves `valid: null`.
*/
async function probeToken(deps, token) {
	const checkedAt = deps.now();
	try {
		const answer = await callMgmt(deps, token, {
			method: "GET",
			path: "/api-keys"
		});
		if (isOk(answer.status) || isScopeRefusal(answer)) return {
			valid: true,
			checkedAt,
			error: null
		};
		if (answer.status === 401) return {
			valid: false,
			checkedAt,
			error: "mgmt_token_invalid"
		};
		return {
			valid: null,
			checkedAt,
			error: answer.status === 429 ? "rate_limited" : "upstream_error"
		};
	} catch (error) {
		return {
			valid: null,
			checkedAt,
			error: error instanceof HttpError && error.code === "upstream_timeout" ? "upstream_timeout" : "upstream_unreachable"
		};
	}
}
function statusOf(record) {
	if (!record) return {
		present: false,
		valid: null,
		checkedAt: null,
		error: null
	};
	return {
		present: true,
		...record.check
	};
}
/** The HttpError a failed check turns into when the token is not to be stored. */
function refusedCheck(check) {
	if (check.valid === false) return new HttpError(502, "mgmt_token_invalid", "NanoGPT rejected the Management token; nothing was stored");
	const note = "; nothing was stored (store it anyway with force=1)";
	if (check.error === "upstream_timeout") return new HttpError(504, "upstream_timeout", `NanoGPT did not answer in time${note}`);
	if (check.error === "rate_limited") return new HttpError(429, "rate_limited", `NanoGPT is rate limiting this token${note}`);
	return new HttpError(502, check.error === "upstream_error" ? "upstream_error" : "upstream_unreachable", `NanoGPT could not confirm the token${note}`);
}
/** Writes a check into the stored record, if that token is still the stored one (it may be replaced while a call runs). */
function storeCheck(deps, user, token, check) {
	const current = deps.store.mgmt.read(user.root);
	if (current && current.token === token) deps.store.mgmt.write(user.root, {
		token,
		check
	});
}
/** The outcome of a call that carried the stored token: written only when the state changed (a read costs no disk write). */
function rememberCheck(deps, user, token, check) {
	const current = deps.store.mgmt.read(user.root);
	if (current && current.check.valid === check.valid && current.check.error === check.error) return;
	storeCheck(deps, user, token, check);
}
/**
* A call with the user's stored token. No token: 409 mgmt_token_missing. A 401 turns the stored status to invalid and
* answers 502 mgmt_token_invalid; a success (or a scope refusal) turns it to valid. Any other status outside 2xx and
* `options.allow` becomes the HttpError of mgmtFailure. `needed` names the scope for the error text.
*/
async function callStored(deps, user, needed, request, options = {}) {
	const record = deps.store.mgmt.read(user.root);
	if (!record) throw new HttpError(409, "mgmt_token_missing", "No Management token is stored; add one first");
	const answer = await callMgmt(deps, new SecretValue(record.token), request);
	if (answer.status === 401) rememberCheck(deps, user, record.token, {
		valid: false,
		checkedAt: deps.now(),
		error: "mgmt_token_invalid"
	});
	else if (isOk(answer.status) || isScopeRefusal(answer)) rememberCheck(deps, user, record.token, {
		valid: true,
		checkedAt: deps.now(),
		error: null
	});
	if (isOk(answer.status) || options.allow?.includes(answer.status)) return answer;
	throw mgmtFailure(answer, needed);
}
// src/server/routes/mgmt.ts
var MAX_LABEL_LENGTH = 100;
/** The value of a checked input, or the HttpError that tells the client what to fix (413 for an oversized body). */
function accepted(result) {
	if (result.ok) return result.value;
	const tooLarge = result.issues.some((issue) => issue.code === "too_large");
	throw new HttpError(tooLarge ? 413 : 400, tooLarge ? "payload_too_large" : "invalid_request", describeIssues(result.issues));
}
function flagOf(value) {
	return value === "1" || value === "true";
}
function badAnswer(what) {
	return new HttpError(502, "bad_response", `NanoGPT answered with something else than ${what}`);
}
function keyIdOf(raw) {
	const id = checkKeyId(raw);
	if (id === null) throw new HttpError(400, "invalid_request", "The key id must be a positive whole number");
	return id;
}
function presetNameOf(raw) {
	const name = checkPresetName(raw);
	if (name === null) throw new HttpError(400, "invalid_request", "The preset name is 1 to 80 letters, digits, dashes or underscores, starting with a letter or digit");
	return name;
}
function presetOf(answer) {
	const preset = normalizeModelPreset(answer.json);
	if (!preset) throw badAnswer("a preset");
	return preset;
}
var mgmtRoutes = (router, deps) => {
	const { store, st, log } = deps;
	router.get("/mgmt/status", route(log, async (req, res) => {
		const user = userOf(req, deps);
		const record = store.mgmt.read(user.root);
		if (record && flagOf(queryText(req, "verify"))) {
			const check = await probeToken(deps, new SecretValue(record.token));
			if (check.valid === null) return sendJson(res, 200, statusOf({
				...record,
				check
			}));
			storeCheck(deps, user, record.token, check);
			return sendJson(res, 200, statusOf({
				...record,
				check
			}));
		}
		sendJson(res, 200, statusOf(record));
	}));
	router.put("/mgmt/token", route(log, async (req, res) => {
		const user = userOf(req, deps);
		const shape = checkMgmtToken(bodyObject(req)["token"]);
		if (!shape.ok) throw new HttpError(400, "mgmt_token_malformed", describeTokenIssue(shape.issue));
		const check = await probeToken(deps, new SecretValue(shape.token));
		if (!flagOf(queryText(req, "force")) && check.valid !== true) throw refusedCheck(check);
		store.mgmt.write(user.root, {
			token: shape.token,
			check
		});
		log.info(`Management token stored (${check.valid === true ? "recognised by NanoGPT" : "not verified"})`);
		sendJson(res, 200, statusOf({
			token: shape.token,
			check
		}));
	}));
	router.delete("/mgmt/token", route(log, (req, res) => {
		store.mgmt.clear(userOf(req, deps).root);
		log.info("Management token removed");
		sendJson(res, 200, { ok: true });
	}));
	router.get("/mgmt/keys", route(log, async (req, res) => {
		const keys = normalizeManagedKeys((await callStored(deps, userOf(req, deps), "api_keys:read", {
			method: "GET",
			path: "/api-keys"
		})).json);
		if (!keys) throw badAnswer("a key list");
		sendJson(res, 200, {
			keys,
			fetchedAt: deps.now()
		});
	}));
	router.post("/mgmt/keys", route(log, async (req, res) => {
		const user = userOf(req, deps);
		const input = accepted(sanitizeKeyCreateInput(req.body));
		if (!st.available) throw new HttpError(503, "secrets_unavailable", "ST secret store is unavailable");
		const request = {
			method: "POST",
			path: "/api-keys",
			body: keyCreateToWire(input),
			idempotencyKey: `nanovia-${randomUUID()}`
		};
		let answer;
		try {
			answer = await callStored(deps, user, "api_keys:write", request);
		} catch (error) {
			if (!(error instanceof HttpError && ["upstream_unreachable", "upstream_timeout"].includes(error.code))) throw error;
			answer = await callStored(deps, user, "api_keys:write", request);
		}
		const key = normalizeManagedKey(answer.json);
		const secret = isRecord$3(answer.json) && typeof answer.json["key"] === "string" ? answer.json["key"] : "";
		if (!key || !secret) throw badAnswer("a created key");
		let secretId;
		try {
			const label = `${SECRET_LABEL_PREFIX}${key.name}`.slice(0, MAX_LABEL_LENGTH);
			secretId = st.writeSecret(user.handle, SECRET_KEY_NANOGPT, secret, label, { keepActive: true });
		} catch {
			log.error(`NanoGPT key ${key.id} was created but ST could not store it`);
			throw new HttpError(500, "secrets_failed", `Key ${key.id} was created at NanoGPT but could not be stored; revoke it from the list`);
		}
		sendJson(res, 200, {
			key,
			secretId
		});
	}));
	router.patch("/mgmt/keys/:id", route(log, async (req, res) => {
		const user = userOf(req, deps);
		const id = keyIdOf(req.params["id"]);
		const patch = accepted(sanitizeKeyLimitsPatch(req.body));
		const key = normalizeManagedKey((await callStored(deps, user, "api_keys:write", {
			method: "PATCH",
			path: `/api-keys/${id}`,
			body: keyPatchToWire(patch)
		})).json);
		if (!key) throw badAnswer("a key");
		sendJson(res, 200, { key });
	}));
	router.delete("/mgmt/keys/:id", route(log, async (req, res) => {
		await callStored(deps, userOf(req, deps), "api_keys:write", {
			method: "DELETE",
			path: `/api-keys/${keyIdOf(req.params["id"])}`
		});
		sendJson(res, 200, { ok: true });
	}));
	router.get("/mgmt/presets", route(log, async (req, res) => {
		const presets = normalizeModelPresets((await callStored(deps, userOf(req, deps), "model_presets:read", {
			method: "GET",
			path: "/model-presets"
		})).json);
		if (!presets) throw badAnswer("a preset list");
		sendJson(res, 200, {
			presets,
			fetchedAt: deps.now()
		});
	}));
	router.post("/mgmt/presets", route(log, async (req, res) => {
		const user = userOf(req, deps);
		const body = bodyObject(req);
		const name = presetNameOf(body["name"]);
		const rest = { ...body };
		delete rest["name"];
		const input = accepted(sanitizePresetInput(rest));
		if ((await callStored(deps, user, "model_presets:read", {
			method: "GET",
			path: `/model-presets/${encodeURIComponent(name)}`
		}, { allow: [404] })).status !== 404) throw new HttpError(409, "preset_exists", "A preset with this name exists; replace it with PUT instead");
		sendJson(res, 200, { preset: presetOf(await callStored(deps, user, "model_presets:write", {
			method: "PUT",
			path: `/model-presets/${encodeURIComponent(name)}`,
			body: presetToWire(input)
		})) });
	}));
	router.put("/mgmt/presets/:name", route(log, async (req, res) => {
		const user = userOf(req, deps);
		const name = presetNameOf(req.params["name"]);
		const input = accepted(sanitizePresetInput(req.body));
		sendJson(res, 200, { preset: presetOf(await callStored(deps, user, "model_presets:write", {
			method: "PUT",
			path: `/model-presets/${encodeURIComponent(name)}`,
			body: presetToWire(input)
		})) });
	}));
	router.delete("/mgmt/presets/:name", route(log, async (req, res) => {
		const user = userOf(req, deps);
		const name = presetNameOf(req.params["name"]);
		await callStored(deps, user, "model_presets:write", {
			method: "DELETE",
			path: `/model-presets/${encodeURIComponent(name)}`
		});
		sendJson(res, 200, { ok: true });
	}));
};
// src/server/usage-log.ts
var FILE_PATTERN = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** The days a log can name: from the epoch to the last instant of year 9999 (so a day is always YYYY-MM-DD). */
var MAX_TIME = 0xe677d21fdbff;
function usageFileName(at) {
	return `usage-${new Date(at).toISOString().slice(0, 10)}.jsonl`;
}
/** The UTC day (`YYYY-MM-DD`) of an instant; clamped to 1970..9999 so any number gives a day. */
function utcDay(at) {
	return new Date(Math.min(MAX_TIME, Math.max(0, Number.isFinite(at) ? at : 0))).toISOString().slice(0, 10);
}
var OUTCOMES = [
	"subscription",
	"paygo",
	"unknown"
];
var CONSUMERS = [
	"main",
	"background",
	"unknown"
];
function count(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function text(value) {
	return typeof value === "string" ? value : null;
}
/** One line of a usage file as a UsageRecord, tolerant of missing fields; null when it is not a record at all. */
function parseUsageRecord(line) {
	let raw;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const r = raw;
	const at = count(r["at"]);
	if (at === null) return null;
	const billing = OUTCOMES.find((o) => o === r["billing"]);
	const consumer = CONSUMERS.find((c) => c === r["consumer"]);
	return {
		at,
		connectionId: text(r["connectionId"]),
		requestId: text(r["requestId"]),
		model: text(r["model"]) ?? "unknown",
		billing: billing ?? "unknown",
		costUsd: count(r["costUsd"]),
		equivalentUsd: count(r["equivalentUsd"]),
		promptTokens: count(r["promptTokens"]),
		completionTokens: count(r["completionTokens"]),
		cachedTokens: count(r["cachedTokens"]),
		reasoningTokens: count(r["reasoningTokens"]),
		latencyMs: count(r["latencyMs"]) ?? 0,
		status: count(r["status"]) ?? 0,
		stream: r["stream"] === true,
		consumer: consumer ?? "unknown",
		error: text(r["error"])
	};
}
function createUsageLog(log) {
	return {
		async append(userRoot, record) {
			try {
				const dir = path.join(userRoot, USER_DIR_NAME);
				await fs$1.mkdir(dir, { recursive: true });
				await fs$1.appendFile(path.join(dir, usageFileName(record.at)), `${JSON.stringify(record)}\n`, "utf8");
			} catch (error) {
				log.warn(`usage record not written (${error instanceof Error ? error.message : "unknown error"})`);
			}
		},
		async read(userRoot, range) {
			const dir = path.join(userRoot, USER_DIR_NAME);
			let names;
			try {
				names = await fs$1.readdir(dir);
			} catch {
				return [];
			}
			const first = utcDay(range.from);
			const last = utcDay(range.to - 1);
			const files = names.flatMap((name) => {
				const day = FILE_PATTERN.exec(name)?.[1];
				return day !== void 0 && day >= first && day <= last ? [{
					name,
					day
				}] : [];
			}).sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
			const records = [];
			for (const file of files) try {
				await readLines(path.join(dir, file.name), (line) => {
					const record = parseUsageRecord(line);
					if (record && record.at >= range.from && record.at < range.to) records.push(record);
				});
			} catch (error) {
				log.warn(`usage file ${file.name} not read (${error instanceof Error ? error.message : "unknown error"})`);
			}
			return records;
		}
	};
}
async function readLines(file, onLine) {
	const input = createReadStream(file, { encoding: "utf8" });
	const lines = readline.createInterface({
		input,
		crlfDelay: Infinity
	});
	try {
		for await (const line of lines) if (line.trim()) onLine(line);
	} finally {
		lines.close();
		input.destroy();
	}
}
// src/server/routes/spend.ts
var DAY_MS = 864e5;
var DEFAULT_SPAN_DAYS = 30;
var MAX_CONNECTION_ID_LENGTH = 64;
function instant(raw, name) {
	if (raw === null) return null;
	const value = Number(raw);
	if (!Number.isFinite(value)) throw new HttpError(400, "invalid_request", `"${name}" must be milliseconds since epoch`);
	return value;
}
var spendRoutes = (router, deps) => {
	router.get("/spend", route(deps.log, async (req, res) => {
		const user = userOf(req, deps);
		const requestedFrom = instant(queryText(req, "from"), "from");
		const to = instant(queryText(req, "to"), "to") ?? deps.now() + 1;
		const from = requestedFrom ?? to - DEFAULT_SPAN_DAYS * DAY_MS;
		if (from >= to) throw new HttpError(400, "invalid_request", "\"from\" must be earlier than \"to\"");
		const connectionId = queryText(req, "connectionId");
		if (connectionId !== null && connectionId.length > MAX_CONNECTION_ID_LENGTH) throw new HttpError(400, "invalid_request", "\"connectionId\" is not a connection id");
		const range = {
			from,
			to
		};
		sendJson(res, 200, summarizeUsage(await deps.usage.read(user.root, range), range, utcDay, connectionId === null ? {} : { connectionId }));
	}));
};
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
	catalogRoutes,
	accountRoutes,
	spendRoutes,
	mgmtRoutes
];
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
		mgmtBase: NANOGPT_MGMT_BASE,
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
	const mgmt = pick(file["mgmtBase"], env["NANOVIA_MGMT"]);
	if (mgmt !== void 0) {
		const base = cleanBase(mgmt);
		if (base) config.mgmtBase = base;
		else warnings.push("mgmtBase is not an http(s) URL; default used");
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
