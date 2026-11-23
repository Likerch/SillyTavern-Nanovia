// package.json
var version = "0.0.1";
// src/core/bus.ts
/**
* Nanovia's internal event bus. Handlers run in registration order; one failing handler does not stop the others, and
* one removed while an emit is under way is not called by it.
*/
var EventBus = class {
	log;
	handlers = /* @__PURE__ */ new Map();
	constructor(log) {
		this.log = log;
	}
	on(event, handler) {
		let set = this.handlers.get(event);
		if (!set) {
			set = /* @__PURE__ */ new Set();
			this.handlers.set(event, set);
		}
		set.add(handler);
		return () => {
			set.delete(handler);
		};
	}
	async emit(event, payload) {
		const set = this.handlers.get(event);
		if (!set) return;
		for (const handler of [...set]) {
			if (!set.has(handler)) continue;
			try {
				await handler(payload);
			} catch (error) {
				this.log.error(`bus handler for ${String(event)} failed`, error);
			}
		}
	}
	/** Drops every handler (app stop). */
	clear() {
		this.handlers.clear();
	}
};
function createBus(log) {
	return new EventBus(log);
}
// src/domain/connection.ts
var QUANTIZATIONS$1 = [
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
var SORTS$1 = [
	"default",
	"price",
	"throughput",
	"latency",
	"speed"
];
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
	const p = isRecord$7(patch) ? patch : {};
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
	if (isOneOf(MODES, p["mode"])) next.mode = p["mode"];
	if (p["keyId"] === null) next.keyId = null;
	else if (typeof p["keyId"] === "string" && p["keyId"].trim()) next.keyId = clip(p["keyId"].trim(), 100);
	if (isOneOf(BILLING, p["billing"])) next.billing = p["billing"];
	if (typeof p["webSearch"] === "boolean") next.webSearch = p["webSearch"];
	if (typeof p["stripNeutralSamplers"] === "boolean") next.stripNeutralSamplers = p["stripNeutralSamplers"];
	if (typeof p["note"] === "string") next.note = clip(p["note"], 1e3);
	if (isRecord$7(p["routing"])) next.routing = mergeRouting(next.routing, p["routing"]);
	if (isRecord$7(p["reasoning"])) next.reasoning = mergeReasoning(next.reasoning, p["reasoning"]);
	if (isRecord$7(p["memory"])) {
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
	if (!isRecord$7(raw)) return null;
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
	if (isOneOf(SORTS$1, p["sort"])) next.sort = p["sort"];
	if (Array.isArray(p["quantizations"])) next.quantizations = [...new Set(p["quantizations"].filter((q) => isOneOf(QUANTIZATIONS$1, q)))];
	if (p["minQuantization"] === null) next.minQuantization = null;
	else if (isOneOf(QUANTIZATIONS$1, p["minQuantization"])) next.minQuantization = p["minQuantization"];
	if (isRecord$7(p["maxPrice"])) {
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
function isRecord$7(value) {
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
// src/host/events.ts
function createHostEvents(ctx, log) {
	const registrations = /* @__PURE__ */ new Set();
	function name(key) {
		const types = ctx().eventTypes ?? {};
		if (!Object.prototype.hasOwnProperty.call(types, key)) return void 0;
		const value = types[key];
		return typeof value === "string" ? value : void 0;
	}
	function resolve(event) {
		return name(event) ?? event;
	}
	return {
		on(event, handler) {
			const raw = resolve(event);
			let active = true;
			const listener = (...args) => {
				if (!active) return void 0;
				try {
					const result = handler(...args);
					if (result instanceof Promise) return result.catch((error) => log.error(`listener for ${raw} failed`, error));
					return result;
				} catch (error) {
					log.error(`listener for ${raw} failed`, error);
					return;
				}
			};
			const registration = {
				event: raw,
				listener
			};
			ctx().eventSource.on(raw, listener);
			registrations.add(registration);
			return () => {
				if (!active) return;
				active = false;
				registrations.delete(registration);
				ctx().eventSource.removeListener(raw, listener);
			};
		},
		emit(event, ...args) {
			return ctx().eventSource.emit(resolve(event), ...args);
		},
		name,
		dispose() {
			const source = ctx().eventSource;
			for (const registration of [...registrations]) try {
				source.removeListener(registration.event, registration.listener);
			} catch (error) {
				log.warn(`could not remove ${registration.event} listener`, error);
			}
			registrations.clear();
		}
	};
}
// src/host/modules.ts
/** Module paths, relative to the ST web root (public/). */
var ST_MODULE_PATHS = {
	secrets: "/scripts/secrets.js",
	script: "/script.js"
};
var importByUrl = async (url) => await import(
	/* @vite-ignore */
	url
);
function pageOrigin() {
	return window.location.origin;
}
/**
* @param importer replaced in tests; the default is a native dynamic import.
* @param origin page origin (window.location.origin).
*/
function createHostModules(log, importer = importByUrl, origin = pageOrigin) {
	const cache = /* @__PURE__ */ new Map();
	function url(path) {
		const base = origin();
		const normalized = path.startsWith("/") ? path : path.startsWith("scripts/") ? `/${path}` : `/scripts/${path}`;
		const resolved = new URL(normalized, base);
		if (resolved.origin !== new URL(base).origin) throw new Error(`refusing to import a module from another origin: ${path}`);
		return resolved.href;
	}
	function load(path) {
		let href;
		try {
			href = url(path);
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		const cached = cache.get(href);
		if (cached) return cached;
		const pending = importer(href).catch((error) => {
			cache.delete(href);
			log.warn(`could not import ST module ${path}`, error);
			throw error;
		});
		cache.set(href, pending);
		return pending;
	}
	return {
		secrets: () => load(ST_MODULE_PATHS.secrets),
		script: () => load(ST_MODULE_PATHS.script),
		load,
		url
	};
}
// src/shared/constants.ts
/** Global of the public API (docs/ARCHITECTURE.md §9). Members are only ever added; `version` stays 1. */
var NANOVIA_API_GLOBAL = "NANOVIA_API";
/** Dispatched on `window` (CustomEvent, detail `{ version: 1 }`) once the API object is installed. */
var NANOVIA_API_READY_EVENT = "nanovia-api-ready";
/** Key under `extension_settings`: interface preferences only, never a secret and never a connection. */
var NANOVIA_SETTINGS_KEY = "nanovia";
var PLUGIN_ADMIN_BASE = "/api/plugins/nanovia";
/** The local proxy: its own HTTP listener, because ST's own router would demand a session cookie and a CSRF token. */
var PROXY_HOST = "127.0.0.1";
/** NanoGPT API bases. `api.nano-gpt.com` is IPv4-only and takes bodies up to 32 MiB; `nano-gpt.com` is the fallback. */
var NANOGPT_API_BASE = "https://api.nano-gpt.com/api/v1";
var NANOGPT_API_BASE_FALLBACK = "https://nano-gpt.com/api/v1";
var SECRET_KEY_CUSTOM = "api_key_custom";
/** Prefix of the label of every secret Nanovia writes into ST's secret store. */
var SECRET_LABEL_PREFIX = "Nanovia: ";
/** Prefix of the name of every Connection Manager profile Nanovia creates. */
var PROFILE_NAME_PREFIX = "Nanovia · ";
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
// src/host/plugin-client.ts
/** Errors that mean "the plugin itself is not there", as opposed to "the plugin refused this request". */
function isPluginDown(error) {
	return error.code === "unreachable" || error.code === "timeout" || error.code === "not_installed";
}
var DEFAULT_TTL_MS = 5e3;
var DEFAULT_TIMEOUT_MS = 1e4;
var CHECK_TIMEOUT_MS = 3e4;
function isRecord$6(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value) {
	return typeof value === "string" ? value : null;
}
function invalid$1(what) {
	return {
		ok: false,
		error: {
			code: "invalid_response",
			message: `unexpected ${what}`,
			status: null
		}
	};
}
/** A connection of the wire as the browser uses it; null when it is not one. */
function parseConnectionView(raw, now = Date.now()) {
	const config = normalizeConnection(raw, now);
	if (!config || !isRecord$6(raw)) return null;
	const proxyUrl = str(raw["proxyUrl"]);
	const directUrl = str(raw["directUrl"]);
	if (proxyUrl === null || directUrl === null) return null;
	const token = raw["tokenSecretId"];
	return {
		...config,
		proxyUrl,
		directUrl,
		tokenSecretId: typeof token === "string" && token ? token : null
	};
}
function parseStatus(raw) {
	if (!isRecord$6(raw) || !isRecord$6(raw["proxy"])) return null;
	const proxy = raw["proxy"];
	const version = str(raw["version"]);
	const host = str(proxy["host"]);
	const port = proxy["port"];
	if (version === null || host === null || typeof port !== "number" || !Number.isFinite(port)) return null;
	return {
		version,
		plugin: true,
		proxy: {
			up: proxy["up"] === true,
			host,
			port
		},
		secrets: raw["secrets"] === true,
		user: str(raw["user"]) ?? ""
	};
}
function parseKey(raw) {
	if (!isRecord$6(raw)) return null;
	const id = str(raw["id"]);
	if (!id) return null;
	return {
		id,
		label: str(raw["label"]) ?? "",
		active: raw["active"] === true,
		masked: str(raw["masked"]) ?? ""
	};
}
function parseKeyCheck(raw) {
	if (!isRecord$6(raw) || typeof raw["ok"] !== "boolean") return null;
	return {
		ok: raw["ok"],
		usdBalance: str(raw["usdBalance"]),
		nanoBalance: str(raw["nanoBalance"]),
		error: str(raw["error"])
	};
}
function createPluginClient(deps) {
	const { ctx, log } = deps;
	const now = deps.now ?? Date.now;
	const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
	const defaultTimeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const doFetch = (input, init) => (deps.fetchImpl ?? globalThis.fetch)(input, init);
	let cached = null;
	let last = null;
	let inflight = null;
	function noteAnswered() {
		cached = {
			at: now(),
			up: true
		};
	}
	function noteDown() {
		cached = {
			at: now(),
			up: false
		};
		last = null;
	}
	async function call(method, path, body, timeoutMs = defaultTimeout) {
		const hasBody = body !== void 0;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let response;
		try {
			const headers = ctx().getRequestHeaders({ omitContentType: !hasBody });
			response = await doFetch(`${PLUGIN_ADMIN_BASE}${path}`, {
				method,
				headers,
				body: hasBody ? JSON.stringify(body) : void 0,
				signal: controller.signal,
				cache: "no-cache"
			});
		} catch (error) {
			clearTimeout(timer);
			const timedOut = controller.signal.aborted;
			noteDown();
			log.debug(`plugin ${method} ${path}: ${timedOut ? "timeout" : "no answer"}`);
			return {
				ok: false,
				error: {
					code: timedOut ? "timeout" : "unreachable",
					message: error instanceof Error ? error.message : String(error),
					status: null
				}
			};
		}
		try {
			const text = await response.text();
			let json = void 0;
			let parsedOk = false;
			if (text) try {
				json = JSON.parse(text);
				parsedOk = true;
			} catch {
				parsedOk = false;
			}
			if (!response.ok) {
				const wire = isRecord$6(json) && isRecord$6(json["error"]) ? json["error"] : null;
				const code = wire ? str(wire["code"]) : null;
				const message = (wire ? str(wire["message"]) : null) ?? `HTTP ${response.status}`;
				let resolved = code ?? `http_${response.status}`;
				if (!code) {
					if (response.status === 404) resolved = "not_installed";
					else if (response.status === 401 || response.status === 403) resolved = "forbidden";
				}
				if (resolved === "not_installed") noteDown();
				return {
					ok: false,
					error: {
						code: resolved,
						message,
						status: response.status
					}
				};
			}
			noteAnswered();
			if (!parsedOk) return invalid$1("response (not JSON)");
			return {
				ok: true,
				data: json
			};
		} catch (error) {
			noteDown();
			return {
				ok: false,
				error: {
					code: "unreachable",
					message: error instanceof Error ? error.message : String(error),
					status: response.status
				}
			};
		} finally {
			clearTimeout(timer);
		}
	}
	function map(result, read, what) {
		if (!result.ok) return result;
		const value = read(result.data);
		return value === null ? invalid$1(what) : {
			ok: true,
			data: value
		};
	}
	function viewOf(data) {
		return isRecord$6(data) ? parseConnectionView(data["connection"], now()) : null;
	}
	const client = {
		async status() {
			const result = map(await call("GET", "/status"), parseStatus, "status");
			if (result.ok) {
				last = result.data;
				noteAnswered();
			} else noteDown();
			return result;
		},
		async available(options) {
			if (!options?.fresh && cached && now() - cached.at < ttl) return cached.up;
			if (inflight) return inflight;
			inflight = client.status().then((result) => result.ok).finally(() => {
				inflight = null;
			});
			return inflight;
		},
		lastStatus: () => last,
		invalidate() {
			cached = null;
		},
		request(method, path, options) {
			return call(method, path, options?.body, options?.timeoutMs);
		},
		async listConnections() {
			return map(await call("GET", "/connections"), (data) => {
				if (!isRecord$6(data) || !Array.isArray(data["connections"])) return null;
				const views = [];
				for (const item of data["connections"]) {
					const view = parseConnectionView(item, now());
					if (view) views.push(view);
					else log.warn("the plugin sent a connection that could not be read; skipped");
				}
				return views;
			}, "connection list");
		},
		async createConnection(input) {
			return map(await call("POST", "/connections", input), viewOf, "connection");
		},
		async updateConnection(id, patch) {
			return map(await call("PUT", `/connections/${encodeURIComponent(id)}`, patch), viewOf, "connection");
		},
		async deleteConnection(id) {
			const result = await call("DELETE", `/connections/${encodeURIComponent(id)}`);
			return result.ok ? {
				ok: true,
				data: true
			} : result;
		},
		async rotateToken(id) {
			return map(await call("POST", `/connections/${encodeURIComponent(id)}/rotate-token`, {}), viewOf, "connection");
		},
		async listKeys() {
			return map(await call("GET", "/keys"), (data) => {
				if (!isRecord$6(data) || !Array.isArray(data["keys"])) return null;
				return data["keys"].map(parseKey).filter((key) => key !== null);
			}, "key list");
		},
		async addKey(label, value) {
			return map(await call("POST", "/keys", {
				label,
				value
			}), (data) => isRecord$6(data) ? parseKey(data["key"]) : null, "key");
		},
		async deleteKey(id) {
			const result = await call("DELETE", `/keys/${encodeURIComponent(id)}`);
			return result.ok ? {
				ok: true,
				data: true
			} : result;
		},
		async checkKey(id) {
			return map(await call("POST", `/keys/${encodeURIComponent(id)}/check`, {}, CHECK_TIMEOUT_MS), parseKeyCheck, "key check");
		}
	};
	return client;
}
// src/host/targets.ts
var PROXY_PATH = /^\/c\/([a-z0-9]{6,16})\/v1\/?$/;
var PROXY_HOSTS = /* @__PURE__ */ new Set([PROXY_HOST, "localhost"]);
/** The connection id and port of a Nanovia proxy URL; null for any other URL. */
function parseProxyUrl(value) {
	if (typeof value !== "string" || !value) return null;
	let url;
	try {
		url = new URL(value.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "http:" || !PROXY_HOSTS.has(url.hostname) || !url.port) return null;
	if (url.username || url.password || url.search || url.hash) return null;
	const connectionId = PROXY_PATH.exec(url.pathname)?.[1];
	const port = Number(url.port);
	if (!connectionId || !isValidConnectionId(connectionId) || !Number.isInteger(port) || port <= 0) return null;
	return {
		connectionId,
		port
	};
}
function trimSlash(value) {
	return value.replace(/\/+$/, "");
}
/** true when the URL is NanoGPT's API base (either host) or a path under it. */
function isNanoGptUrl(value) {
	if (typeof value !== "string" || !value) return false;
	const url = trimSlash(value.trim()).toLowerCase();
	return [NANOGPT_API_BASE, NANOGPT_API_BASE_FALLBACK].some((base) => {
		const lower = base.toLowerCase();
		return url === lower || url.startsWith(`${lower}/`);
	});
}
// src/host/profiles.ts
/** Name of a profile for a connection called `name`. */
function profileName(name) {
	return `${PROFILE_NAME_PREFIX}${name}`;
}
var PROFILE_API = "custom";
var CM_EXTENSION = "connection-manager";
function isRecord$5(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** The managed fields of `profile` that differ from `spec`. Pure. */
function profileDrift(profile, spec) {
	const out = [];
	const name = typeof profile.name === "string" ? profile.name : "";
	if (name !== spec.name && !new RegExp(`^${escapeRegExp(spec.name)} \\(\\d+\\)$`).test(name)) out.push("name");
	if (profile.mode !== "cc") out.push("mode");
	if (profile.api !== "custom") out.push("api");
	if (profile.model !== spec.model) out.push("model");
	if (profile["api-url"] !== spec.apiUrl) out.push("api-url");
	if (profile["secret-id"] !== spec.secretId) out.push("secret-id");
	return out;
}
function uniqueName(wanted, taken) {
	if (!taken.has(wanted)) return wanted;
	for (let n = 2;; n++) {
		const candidate = `${wanted} (${n})`;
		if (!taken.has(candidate)) return candidate;
	}
}
function createProfilesHost(deps) {
	const { ctx, events, log } = deps;
	const newId = deps.newId ?? (() => ctx().uuidv4());
	function available() {
		const disabled = ctx().extensionSettings?.["disabledExtensions"];
		return !(Array.isArray(disabled) && disabled.includes(CM_EXTENSION));
	}
	/** Connection Manager's settings; created when CM is enabled but has not initialised yet (its init keeps what is there). */
	function manager(create) {
		if (!available()) return null;
		const store = ctx().extensionSettings;
		const value = store["connectionManager"];
		if (isRecord$5(value) && Array.isArray(value["profiles"])) return value;
		if (!create) return null;
		const fresh = {
			profiles: [],
			selectedProfile: null
		};
		store["connectionManager"] = fresh;
		return fresh;
	}
	function valid(profile) {
		return isRecord$5(profile) && typeof profile["id"] === "string";
	}
	/** CM renders its profile list once; rebuild it the way CM does so a new profile is selectable without a reload. */
	function syncDropdown(settings) {
		try {
			const doc = globalThis.document;
			if (!doc) return;
			const select = doc.getElementById("connection_profiles");
			if (!(select instanceof HTMLSelectElement)) return;
			if (select.options.length === 0 || select.options[0]?.value !== "") return;
			const selected = settings.selectedProfile ?? "";
			while (select.options.length > 1) select.remove(1);
			const sorted = settings.profiles.filter(valid).sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
			for (const profile of sorted) {
				const option = doc.createElement("option");
				option.value = profile.id;
				option.textContent = profile.name ?? profile.id;
				select.appendChild(option);
			}
			select.value = selected;
		} catch (error) {
			log.debug("could not refresh the Connection Manager dropdown", error);
		}
	}
	async function announce(key, ...args) {
		if (events.name(key) === void 0) return;
		try {
			await events.emit(key, ...args);
		} catch (error) {
			log.debug(`${key} listeners failed`, error);
		}
	}
	const host = {
		available,
		list: () => (manager(false)?.profiles ?? []).filter(valid),
		get: (profileId) => manager(false)?.profiles.find((profile) => valid(profile) && profile.id === profileId) ?? null,
		isOurs(profile) {
			const url = profile["api-url"];
			if (parseProxyUrl(url)) return true;
			return isNanoGptUrl(url) && typeof profile.name === "string" && profile.name.startsWith("Nanovia · ");
		},
		connectionIdOf: (profile) => parseProxyUrl(profile["api-url"])?.connectionId ?? null,
		drift(profileId, spec) {
			const profile = host.get(profileId);
			return profile ? profileDrift(profile, spec) : null;
		},
		async upsert(profileId, spec) {
			if (!spec.secretId || !spec.apiUrl || !spec.model.trim()) return {
				ok: false,
				reason: "invalid"
			};
			const settings = manager(true);
			if (!settings) return {
				ok: false,
				reason: "unavailable"
			};
			const existing = profileId ? settings.profiles.find((profile) => valid(profile) && profile.id === profileId) : void 0;
			const others = settings.profiles.filter((profile) => profile !== existing && valid(profile));
			const name = uniqueName(spec.name, new Set(others.map((profile) => String(profile.name ?? ""))));
			if (existing) {
				const before = structuredClone(existing);
				if (profileDrift(existing, {
					...spec,
					name
				}).length === 0) return {
					ok: true,
					profileId: existing.id,
					created: false,
					changed: false
				};
				existing.name = name;
				existing.mode = "cc";
				existing.api = PROFILE_API;
				existing.model = spec.model;
				existing["api-url"] = spec.apiUrl;
				existing["secret-id"] = spec.secretId;
				if (!Array.isArray(existing.exclude)) existing.exclude = [];
				ctx().saveSettingsDebounced();
				syncDropdown(settings);
				await announce("CONNECTION_PROFILE_UPDATED", before, existing);
				log.debug(`profile «${name}» updated`);
				return {
					ok: true,
					profileId: existing.id,
					created: false,
					changed: true
				};
			}
			const profile = {
				id: newId(),
				mode: "cc",
				name,
				api: PROFILE_API,
				model: spec.model,
				"api-url": spec.apiUrl,
				"secret-id": spec.secretId,
				exclude: []
			};
			settings.profiles.push(profile);
			ctx().saveSettingsDebounced();
			syncDropdown(settings);
			await announce("CONNECTION_PROFILE_CREATED", profile);
			log.debug(`profile «${name}» created`);
			return {
				ok: true,
				profileId: profile.id,
				created: true,
				changed: true
			};
		},
		async remove(profileId) {
			const settings = manager(false);
			if (!settings) return false;
			const index = settings.profiles.findIndex((profile) => valid(profile) && profile.id === profileId);
			if (index < 0) return false;
			const [profile] = settings.profiles.splice(index, 1);
			if (settings.selectedProfile === profileId) settings.selectedProfile = null;
			ctx().saveSettingsDebounced();
			syncDropdown(settings);
			if (profile) await announce("CONNECTION_PROFILE_DELETED", profile);
			log.debug(`profile ${profileId} removed`);
			return true;
		}
	};
	return host;
}
// src/host/secrets.ts
function isRecord$4(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function createSecretsHost(deps) {
	const { ctx, log } = deps;
	const doFetch = (input, init) => (deps.fetchImpl ?? globalThis.fetch)(input, init);
	async function post(path, body) {
		const headers = ctx().getRequestHeaders({ omitContentType: body === void 0 });
		return doFetch(path, {
			method: "POST",
			headers,
			body: body === void 0 ? void 0 : JSON.stringify(body)
		});
	}
	/** The secrets of `api_key_custom` (ids, labels, activity); values are never read out of the answer. */
	async function readState() {
		try {
			const response = await post("/api/secrets/read");
			if (!response.ok) return null;
			const json = await response.json();
			const list = isRecord$4(json) ? json[SECRET_KEY_CUSTOM] : null;
			if (list === null || list === void 0) return [];
			if (!Array.isArray(list)) return null;
			const states = [];
			for (const item of list) {
				if (!isRecord$4(item) || typeof item["id"] !== "string") continue;
				states.push({
					id: item["id"],
					label: typeof item["label"] === "string" ? item["label"] : "",
					active: item["active"] === true
				});
			}
			return states;
		} catch {
			return null;
		}
	}
	async function changed() {
		try {
			await deps.afterChange?.();
		} catch (error) {
			log.debug("could not refresh ST secret list", error);
		}
	}
	return {
		async write(value, label) {
			const secret = value.trim();
			if (!secret) return {
				ok: false,
				error: "empty"
			};
			const previouslyActive = (await readState())?.find((item) => item.active)?.id ?? null;
			let id;
			try {
				const response = await post("/api/secrets/write", {
					key: SECRET_KEY_CUSTOM,
					value: secret,
					label
				});
				if (!response.ok) return {
					ok: false,
					error: `HTTP ${response.status}`
				};
				const json = await response.json();
				const written = isRecord$4(json) ? json["id"] : null;
				if (typeof written !== "string" || !written) return {
					ok: false,
					error: "no id in the answer"
				};
				id = written;
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : "request failed"
				};
			}
			if (previouslyActive && previouslyActive !== id) try {
				const response = await post("/api/secrets/rotate", {
					key: SECRET_KEY_CUSTOM,
					id: previouslyActive
				});
				if (!response.ok) log.warn(`could not put the previous Custom key back (HTTP ${response.status})`);
			} catch {
				log.warn("could not put the previous Custom key back");
			}
			await changed();
			return {
				ok: true,
				id
			};
		},
		async remove(id) {
			if (!id) return false;
			try {
				if (!(await post("/api/secrets/delete", {
					key: "api_key_custom",
					id
				})).ok) return false;
			} catch {
				return false;
			}
			await changed();
			return true;
		},
		async has(id) {
			const state = await readState();
			return state === null ? null : state.some((item) => item.id === id);
		}
	};
}
// src/host/yaml-merge.ts
/** `key:` at the start of a top-level line: quoted, or plain without ':' and '#'. */
var KEY_LINE = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#'"\-?:[\]{}&*!|>%@`,][^:#]*?|-[^\s:#][^:#]*?))[ \t]*:(?:[ \t]|$)/;
var PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
var RESERVED_KEY = /^(?:true|false|null|yes|no|on|off|y|n)$/i;
function isRecord$3(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function formatKey(key) {
	return PLAIN_KEY.test(key) && !RESERVED_KEY.test(key) ? key : JSON.stringify(key);
}
function decodeKey(match) {
	if (match[1] !== void 0) try {
		return JSON.parse(`"${match[1]}"`);
	} catch {
		return match[1];
	}
	if (match[2] !== void 0) return match[2].replace(/''/g, "'");
	return (match[3] ?? "").trim();
}
function split(entries, has) {
	const add = [];
	const kept = [];
	for (const [key, value] of Object.entries(entries)) {
		if (value === void 0) continue;
		if (has(key)) kept.push(key);
		else add.push([key, value]);
	}
	return {
		add,
		kept
	};
}
/** Merges `entries` into the YAML `existing`; ok:false (with a reason for the debug log) when it cannot do it safely. */
function mergeYamlEntries(existing, entries, options = {}) {
	const text = typeof existing === "string" ? existing : "";
	const fold = (key) => options.ignoreCase ? key.toLowerCase() : key;
	const lines = text.split(/\r?\n/);
	const isBlank = (line) => line.trim() === "" || line.trim().startsWith("#");
	const first = lines.find((line) => !isBlank(line));
	if (first === void 0) {
		const { add, kept } = split(entries, () => false);
		if (add.length === 0) return {
			ok: true,
			text,
			added: [],
			kept
		};
		return {
			ok: true,
			text: `${text === "" || text.endsWith("\n") ? text : `${text}\n`}${add.map(([key, value]) => `${formatKey(key)}: ${JSON.stringify(value)}`).join("\n")}\n`,
			added: add.map(([key]) => key),
			kept
		};
	}
	const lead = first.trimStart();
	if (lead.startsWith("{") || lead.startsWith("[")) return mergeJson(text, entries, fold);
	if (/^\s/.test(first)) return {
		ok: false,
		reason: "the first entry is indented"
	};
	if (lead === "-" || lead.startsWith("- ")) return {
		ok: false,
		reason: "a block sequence"
	};
	const present = /* @__PURE__ */ new Set();
	for (const line of lines) {
		if (isBlank(line) || /^\s/.test(line)) continue;
		if (/^(?:---|\.\.\.)(?:\s|$)/.test(line)) return {
			ok: false,
			reason: "a document marker"
		};
		const match = KEY_LINE.exec(line);
		if (!match) return {
			ok: false,
			reason: "a top-level line that is not a plain \"key: value\""
		};
		present.add(fold(decodeKey(match)));
	}
	const { add, kept } = split(entries, (key) => present.has(fold(key)));
	if (add.length === 0) return {
		ok: true,
		text,
		added: [],
		kept
	};
	return {
		ok: true,
		text: `${text.endsWith("\n") ? text : `${text}\n`}${add.map(([key, value]) => `${formatKey(key)}: ${JSON.stringify(value)}`).join("\n")}\n`,
		added: add.map(([key]) => key),
		kept
	};
}
function mergeJson(text, entries, fold) {
	let parsed;
	try {
		parsed = JSON.parse(text.trim());
	} catch {
		return {
			ok: false,
			reason: "a flow collection that is not plain JSON"
		};
	}
	if (isRecord$3(parsed)) {
		const present = new Set(Object.keys(parsed).map(fold));
		const { add, kept } = split(entries, (key) => present.has(fold(key)));
		if (add.length === 0) return {
			ok: true,
			text,
			added: [],
			kept
		};
		const merged = { ...parsed };
		for (const [key, value] of add) merged[key] = value;
		return {
			ok: true,
			text: JSON.stringify(merged),
			added: add.map(([key]) => key),
			kept
		};
	}
	if (Array.isArray(parsed) && parsed.every(isRecord$3)) {
		const present = new Set(parsed.flatMap((item) => Object.keys(item).map(fold)));
		const { add, kept } = split(entries, (key) => present.has(fold(key)));
		if (add.length === 0) return {
			ok: true,
			text,
			added: [],
			kept
		};
		const extra = {};
		for (const [key, value] of add) extra[key] = value;
		return {
			ok: true,
			text: JSON.stringify([...parsed, extra]),
			added: add.map(([key]) => key),
			kept
		};
	}
	return {
		ok: false,
		reason: "JSON that is not an object or a list of objects"
	};
}
// src/host/fetch-hook.ts
var GENERATE_PATH = "/api/backends/chat-completions/generate";
var STATE_KEY = Symbol.for("nanovia.fetchHook");
function isRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Where a generate body goes and who sends it. Pure. */
function inspectGenerateBody(body) {
	let target = null;
	if (body["chat_completion_source"] === "custom") {
		const proxy = parseProxyUrl(body["custom_url"]);
		if (proxy) target = {
			kind: "proxy",
			connectionId: proxy.connectionId,
			port: proxy.port
		};
		else if (isNanoGptUrl(body["custom_url"])) target = { kind: "direct" };
	}
	const secretId = typeof body["secret_id"] === "string" && body["secret_id"] ? body["secret_id"] : null;
	const type = body["type"];
	return {
		target,
		secretId,
		consumer: typeof type === "string" && type !== "quiet" ? "main" : "background"
	};
}
/** What ST itself knew about the request, in the vocabulary of the hint headers. Pure. */
function hintsOf(request) {
	const effort = request.body["reasoning_effort"];
	return {
		effort: typeof effort === "string" && effort ? effort : null,
		consumer: request.consumer,
		thoughts: request.body["include_reasoning"] === true
	};
}
function mergeInto(request, field, entries, ignoreCase) {
	const current = request.body[field];
	const result = mergeYamlEntries(typeof current === "string" ? current : "", entries, { ignoreCase });
	if (!result.ok) {
		request.log.debug(`${field} left alone: ${result.reason}`);
		return;
	}
	if (result.added.length > 0) request.body[field] = result.text;
}
/** Adds headers through `custom_include_headers`; entries the user already set (any case) stay as they are. */
function addIncludeHeaders(request, headers) {
	mergeInto(request, "custom_include_headers", headers, true);
}
/** Proxy mode: tells the proxy what ST knew (effort, main/background, show-thoughts) through hint headers. */
var proxyHintsHook = (request) => {
	if (request.target?.kind !== "proxy") return;
	const hints = hintsOf(request);
	const headers = { [HINT_HEADERS.consumer]: hints.consumer };
	if (hints.effort) headers[HINT_HEADERS.effort] = hints.effort;
	if (hints.thoughts) headers[HINT_HEADERS.thoughts] = "1";
	addIncludeHeaders(request, headers);
};
/** Direct mode: stage 0.2 fills this with the plan of `planUpstream()` (body and headers through the include fields). */
var directModeHook = (request) => {
	if (request.target?.kind !== "direct") return;
	request.log.debug("direct-mode request seen; planning arrives with stage 0.2");
};
function urlOf(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}
function methodOf(input, init) {
	if (init?.method) return init.method.toUpperCase();
	if (typeof input === "object" && !(input instanceof URL) && typeof input.method === "string") return input.method.toUpperCase();
	return "GET";
}
function isGenerateUrl(raw, scope) {
	try {
		const base = scope.location?.href ?? "http://localhost/";
		return new URL(raw, base).pathname.endsWith(GENERATE_PATH);
	} catch {
		return false;
	}
}
async function patchInit(state, scope, input, init) {
	if (state.hooks.size === 0 || typeof init?.body !== "string") return void 0;
	if (methodOf(input, init) !== "POST" || !isGenerateUrl(urlOf(input), scope)) return void 0;
	let body;
	try {
		body = JSON.parse(init.body);
	} catch {
		return;
	}
	if (!isRecord$2(body)) return void 0;
	const before = JSON.stringify(body);
	const request = {
		body,
		...inspectGenerateBody(body),
		log: state.log
	};
	for (const hook of [...state.hooks]) {
		if (!state.hooks.has(hook)) continue;
		try {
			await hook(request);
		} catch (error) {
			state.log.warn("a request hook failed; the request goes on as it was", error);
		}
	}
	const after = JSON.stringify(request.body);
	return after === before ? void 0 : {
		...init,
		body: after
	};
}
/**
* Wraps `scope.fetch` once. Calling it again while our wrapper is still in place returns a handle to the same wrapper
* (and its hooks); if something replaced `fetch` in the meantime, a fresh wrapper goes around the current one.
*/
function installFetchHook(log, scope = globalThis) {
	const holder = scope;
	const existing = holder[STATE_KEY];
	let state;
	if (existing && holder.fetch === existing.wrapper) {
		existing.active = true;
		existing.log = log;
		state = existing;
	} else {
		if (existing) existing.active = false;
		const created = {
			original: holder.fetch,
			hooks: /* @__PURE__ */ new Set(),
			active: true,
			log,
			wrapper: void 0
		};
		created.wrapper = async (input, init) => {
			let effective = init;
			if (created.active) try {
				effective = await patchInit(created, holder, input, init) ?? init;
			} catch (error) {
				created.log.warn("request hooks failed; the request goes on as it was", error);
			}
			return created.original(input, effective);
		};
		holder.fetch = created.wrapper;
		holder[STATE_KEY] = created;
		state = created;
	}
	return {
		register(hook) {
			state.hooks.add(hook);
			return () => {
				state.hooks.delete(hook);
			};
		},
		hookCount: () => state.hooks.size,
		uninstall() {
			state.hooks.clear();
			state.active = false;
			if (holder.fetch === state.wrapper) holder.fetch = state.original;
			if (holder[STATE_KEY] === state) delete holder[STATE_KEY];
		}
	};
}
// src/host/index.ts
function context() {
	return SillyTavern.getContext();
}
function createHost(log) {
	const events = createHostEvents(context, log.scope("events"));
	return {
		ctx: context,
		events,
		modules: createHostModules(log.scope("modules")),
		headers: (options) => context().getRequestHeaders(options),
		locale() {
			try {
				const value = context().getCurrentLocale?.();
				return typeof value === "string" && value ? value : void 0;
			} catch {
				return;
			}
		},
		async confirm(message, title) {
			const ctx = context();
			if (typeof ctx.callGenericPopup === "function" && typeof document !== "undefined") {
				const body = document.createElement("div");
				if (title) {
					const heading = document.createElement("h3");
					heading.textContent = title;
					body.appendChild(heading);
				}
				const text = document.createElement("div");
				text.textContent = message;
				text.style.whiteSpace = "pre-wrap";
				body.appendChild(text);
				try {
					return await ctx.callGenericPopup(body, ctx.POPUP_TYPE.CONFIRM) === ctx.POPUP_RESULT.AFFIRMATIVE;
				} catch (error) {
					log.warn("confirmation popup failed", error);
					return false;
				}
			}
			return typeof globalThis.confirm === "function" ? globalThis.confirm(message) : false;
		},
		notify(kind, text) {
			try {
				globalThis.toastr?.[kind](text);
			} catch (error) {
				log.debug("toast failed", error);
			}
		},
		dispose() {
			events.dispose();
		}
	};
}
// src/core/connections.ts
/** auto = the plugin when it answers, otherwise direct. */
function effectiveMode(mode, pluginUp) {
	if (mode === "plugin") return "plugin";
	if (mode === "direct") return "direct";
	return pluginUp ? "plugin" : "direct";
}
var ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** A fresh connection id, [a-z0-9]{10}. */
function randomConnectionId(length = 10) {
	const bytes = new Uint8Array(length);
	if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(bytes);
	else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
	let id = "";
	for (const byte of bytes) id += ID_ALPHABET[byte % 36];
	return id;
}
/** The ConnectionConfig inside a plugin view. */
function configOf(view) {
	const { proxyUrl: _proxyUrl, directUrl: _directUrl, tokenSecretId: _tokenSecretId, ...config } = view;
	return config;
}
/** A config as a patch for the plugin: everything it lets the browser set. */
function patchOf(config) {
	const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...patch } = config;
	return patch;
}
function fail(code, params) {
	return {
		ok: false,
		error: params ? {
			code,
			params
		} : { code }
	};
}
function pluginFailure(error) {
	return isPluginDown(error) ? fail("plugin_down") : fail("plugin_error", {
		message: error.message,
		status: error.status ?? 0
	});
}
function createConnectionsService(deps) {
	const { settings, plugin, profiles, secrets, bus, log } = deps;
	const now = deps.now ?? Date.now;
	const newId = deps.newId ?? (() => randomConnectionId());
	let up = false;
	let asked = false;
	let status = null;
	let error = null;
	/** Views the plugin sent, by connection id. Survives a failed refresh, so a short outage keeps the proxy URLs. */
	const views = /* @__PURE__ */ new Map();
	let entries = [];
	const listeners = /* @__PURE__ */ new Set();
	let queue = Promise.resolve();
	let refreshing = null;
	function run(task) {
		const fresh = () => {
			rebuild();
			return task();
		};
		const result = queue.then(fresh, fresh);
		queue = result.catch(() => void 0);
		return result;
	}
	function specFor(config, mode) {
		const view = views.get(config.id) ?? null;
		if (mode === "plugin") {
			if (!view?.tokenSecretId) return null;
			return {
				name: profileName(config.name),
				model: config.modelId,
				apiUrl: view.proxyUrl,
				secretId: view.tokenSecretId
			};
		}
		const secretId = settings.get().directSecrets[config.id];
		if (!secretId) return null;
		return {
			name: profileName(config.name),
			model: config.modelId,
			apiUrl: view?.directUrl ?? "https://api.nano-gpt.com/api/v1",
			secretId
		};
	}
	function profileStateOf(config, mode) {
		if (!profiles.available()) return "unavailable";
		const spec = specFor(config, mode);
		const profileId = settings.get().profiles[config.id];
		if (!profileId) return spec ? "none" : "blocked";
		if (!profiles.get(profileId)) return "missing";
		if (!spec) return "linked";
		return (profiles.drift(profileId, spec)?.length ?? 0) > 0 ? "drifted" : "linked";
	}
	/** Rebuilds `entries` from the mirror and what the plugin said. */
	function rebuild() {
		const s = settings.get();
		const byId = /* @__PURE__ */ new Map();
		for (const config of s.mirror) byId.set(config.id, config);
		const next = [];
		for (const config of byId.values()) {
			const view = views.get(config.id) ?? null;
			const mode = effectiveMode(config.mode, up);
			const profileId = s.profiles[config.id] ?? null;
			next.push({
				config,
				view,
				effectiveMode: mode,
				profileId: profileId && profiles.get(profileId) ? profileId : null,
				profileState: profileStateOf(config, mode),
				hasDirectKey: Boolean(s.directSecrets[config.id]),
				pending: s.pending.includes(config.id),
				orphan: up && view === null && config.mode !== "direct" && !s.pending.includes(config.id)
			});
		}
		next.sort((a, b) => a.config.name.localeCompare(b.config.name) || a.config.id.localeCompare(b.config.id));
		entries = next;
	}
	function changed() {
		rebuild();
		bus.emit("connections:changed", { count: entries.length });
		for (const listener of [...listeners]) try {
			listener();
		} catch (err) {
			log.error("connections listener failed", err);
		}
	}
	/** Replaces (or adds) the mirror entry of `config`. */
	function putMirror(config) {
		settings.update((s) => {
			const index = s.mirror.findIndex((item) => item.id === config.id);
			if (index >= 0) s.mirror[index] = config;
			else s.mirror.push(config);
		}, "mirror");
	}
	function rekey(from, to) {
		if (from === to) return;
		settings.update((s) => {
			s.mirror = s.mirror.filter((item) => item.id !== from);
			for (const map of [s.profiles, s.directSecrets]) {
				const value = map[from];
				if (value !== void 0) {
					map[to] = value;
					delete map[from];
				}
			}
			s.pending = s.pending.map((id) => id === from ? to : id);
		});
		if (views.get(from)) views.delete(from);
	}
	function setPending(id, pending) {
		if (settings.get().pending.includes(id) === pending) return;
		settings.update((draft) => {
			draft.pending = pending ? [...draft.pending, id] : draft.pending.filter((item) => item !== id);
		}, "pending");
	}
	/**
	* Writes the Connection Manager profile of a connection and remembers its id. With `keep` (the profile as it is) the
	* name and model are updated and the target (URL and secret) stays what it is.
	*/
	async function syncProfile(config, mode, keep = null) {
		if (!profiles.available()) return { code: "profile_unavailable" };
		const spec = (keep && typeof keep["api-url"] === "string" && typeof keep["secret-id"] === "string" ? {
			name: profileName(config.name),
			model: config.modelId,
			apiUrl: keep["api-url"],
			secretId: keep["secret-id"]
		} : null) ?? specFor(config, mode);
		if (!spec) return { code: mode === "plugin" ? "profile_needs_token" : "profile_needs_key" };
		const result = await profiles.upsert(settings.get().profiles[config.id] ?? null, spec);
		if (!result.ok) return { code: result.reason === "unavailable" ? "profile_unavailable" : "profile_failed" };
		if (settings.get().profiles[config.id] !== result.profileId) settings.update((s) => {
			s.profiles[config.id] = result.profileId;
		}, "profiles");
		return null;
	}
	/** Sends the connections edited while the plugin was down. */
	async function pushPending() {
		for (const id of [...settings.get().pending]) {
			const local = settings.get().mirror.find((item) => item.id === id);
			if (!local) {
				setPending(id, false);
				continue;
			}
			if (views.get(id)) {
				const result = await plugin.updateConnection(id, patchOf(local));
				if (result.ok) {
					views.set(id, result.data);
					setPending(id, false);
				} else log.warn(`could not send the edit of connection ${id} to the plugin: ${result.error.code}`);
			} else if (local.mode !== "direct") {
				const result = await plugin.createConnection({ ...local });
				if (result.ok) {
					rekey(id, result.data.id);
					views.set(result.data.id, result.data);
					setPending(result.data.id, false);
				} else log.warn(`could not create connection ${id} on the plugin: ${result.error.code}`);
			} else setPending(id, false);
		}
	}
	/** Makes the mirror equal to the plugin's list plus the connections only the browser has. */
	function syncMirror() {
		const next = [];
		const seen = /* @__PURE__ */ new Set();
		const { pending, mirror } = settings.get();
		for (const view of views.values()) {
			const local = pending.includes(view.id) ? mirror.find((item) => item.id === view.id) : void 0;
			next.push(local ?? configOf(view));
			seen.add(view.id);
		}
		for (const config of settings.get().mirror) if (!seen.has(config.id)) next.push(config);
		if (JSON.stringify(next) === JSON.stringify(settings.get().mirror)) return;
		settings.update((s) => {
			s.mirror = next;
		}, "mirror");
	}
	/** Brings profiles that drifted back in line (name, model, URL, secret). Never creates one. */
	async function reconcileProfiles() {
		if (!profiles.available()) return;
		for (const config of settings.get().mirror) {
			const profileId = settings.get().profiles[config.id];
			if (!profileId || !profiles.get(profileId)) continue;
			const spec = specFor(config, effectiveMode(config.mode, true));
			if (!spec) continue;
			if ((profiles.drift(profileId, spec)?.length ?? 0) === 0) continue;
			const result = await profiles.upsert(profileId, spec);
			if (!result.ok) log.warn(`could not repair the profile of connection ${config.id}: ${result.reason}`);
		}
	}
	async function doRefresh() {
		const state = await plugin.status();
		asked = true;
		if (!state.ok) {
			up = false;
			status = null;
			error = state.error;
		} else {
			const list = await plugin.listConnections();
			if (list.ok) {
				up = true;
				status = state.data;
				error = null;
				views.clear();
				for (const view of list.data) views.set(view.id, view);
				await pushPending();
				syncMirror();
				await reconcileProfiles();
			} else {
				up = false;
				status = state.data;
				error = list.error;
			}
		}
		bus.emit("plugin:status", {
			up,
			status
		});
		changed();
	}
	async function doSave(input) {
		const existing = input.id ? entries.find((entry) => entry.config.id === input.id) ?? null : null;
		if (input.id && !existing) return fail("not_found");
		const patch = input.patch;
		const name = typeof patch.name === "string" ? patch.name.trim() : existing?.config.name ?? "";
		const modelId = typeof patch.modelId === "string" ? patch.modelId.trim() : existing?.config.modelId ?? "";
		if (!name) return fail("invalid", { field: "name" });
		if (!modelId) return fail("invalid", { field: "modelId" });
		const pluginUp = await plugin.available({ fresh: true });
		up = pluginUp;
		asked = true;
		const modeAfter = patch.mode ?? existing?.config.mode ?? "auto";
		if (modeAfter === "plugin" && !pluginUp) return fail("plugin_down");
		const typedKey = modeAfter === "plugin" ? "" : input.directKey?.trim() ?? "";
		const knownSecret = existing ? settings.get().directSecrets[existing.config.id] : void 0;
		if ((modeAfter === "direct" || !existing && modeAfter === "auto" && !pluginUp) && !typedKey && !knownSecret) return fail("direct_key_required");
		const draft = existing ? mergeConnection(existing.config, {
			...patch,
			name,
			modelId
		}, now()) : createConnection({
			...patch,
			name,
			modelId
		}, newId(), now());
		const warnings = [];
		let newSecret = null;
		if (typedKey) {
			const written = await secrets.write(typedKey, `${SECRET_LABEL_PREFIX}${draft.name} (direct)`);
			if (!written.ok) return fail("key_write_failed", { message: written.error });
			newSecret = written.id;
		}
		const undoKey = async () => {
			if (newSecret) await secrets.remove(newSecret);
		};
		let config = draft;
		const onPlugin = existing?.view != null;
		const mayBeOnPlugin = modeAfter !== "direct" || existing !== null && existing.config.mode !== "direct";
		if (pluginUp && (modeAfter !== "direct" || onPlugin)) {
			const result = onPlugin ? await plugin.updateConnection(draft.id, patchOf(draft)) : await plugin.createConnection({ ...draft });
			if (!result.ok) {
				await undoKey();
				return pluginFailure(result.error);
			}
			views.set(result.data.id, result.data);
			config = configOf(result.data);
			if (result.data.id !== draft.id) {
				if (existing) rekey(draft.id, result.data.id);
				views.delete(draft.id);
			}
		} else if (!pluginUp && mayBeOnPlugin) warnings.push({ code: "saved_locally" });
		putMirror(config);
		setPending(config.id, !pluginUp && mayBeOnPlugin);
		if (newSecret) {
			const old = settings.get().directSecrets[config.id];
			settings.update((s) => {
				s.directSecrets[config.id] = newSecret;
			}, "directSecrets");
			if (old && old !== newSecret) await secrets.remove(old);
		}
		const linked = settings.get().profiles[config.id];
		const keep = !pluginUp && config.mode === "auto" && linked ? profiles.get(linked) : null;
		const issue = await syncProfile(config, effectiveMode(config.mode, pluginUp), keep);
		if (issue) warnings.push(issue);
		changed();
		return {
			ok: true,
			data: { id: config.id },
			warnings
		};
	}
	async function doRemove(id) {
		const entry = entries.find((item) => item.config.id === id);
		if (!entry) return fail("not_found");
		if (entry.config.mode !== "direct") {
			const answering = await plugin.available({ fresh: true });
			up = answering;
			asked = true;
			if (!answering) return fail("plugin_down");
			const result = await plugin.deleteConnection(id);
			if (!result.ok && result.error.code !== "not_found") return pluginFailure(result.error);
		}
		const warnings = [];
		views.delete(id);
		const s = settings.get();
		const profileId = s.profiles[id];
		const secretId = s.directSecrets[id];
		if (profileId) await profiles.remove(profileId);
		if (secretId && !await secrets.remove(secretId)) warnings.push({ code: "key_not_removed" });
		settings.update((draft) => {
			draft.mirror = draft.mirror.filter((item) => item.id !== id);
			draft.pending = draft.pending.filter((item) => item !== id);
			delete draft.profiles[id];
			delete draft.directSecrets[id];
		});
		changed();
		return {
			ok: true,
			data: null,
			warnings
		};
	}
	async function doRotate(id) {
		const entry = entries.find((item) => item.config.id === id);
		if (!entry) return fail("not_found");
		if (!entry.view) return fail("not_on_plugin");
		const result = await plugin.rotateToken(id);
		if (!result.ok) return pluginFailure(result.error);
		views.set(id, result.data);
		const warnings = [];
		const config = configOf(result.data);
		putMirror(config);
		if (settings.get().profiles[id] && effectiveMode(config.mode, true) === "plugin") {
			const issue = await syncProfile(config, "plugin");
			if (issue) warnings.push(issue);
		}
		changed();
		return {
			ok: true,
			data: null,
			warnings
		};
	}
	async function doRepair(id) {
		const entry = entries.find((item) => item.config.id === id);
		if (!entry) return fail("not_found");
		const issue = await syncProfile(entry.config, entry.effectiveMode);
		changed();
		return issue ? fail(issue.code, issue.params) : {
			ok: true,
			data: null,
			warnings: []
		};
	}
	function summaryOf(entry) {
		return {
			id: entry.config.id,
			name: entry.config.name,
			modelId: entry.config.modelId,
			mode: entry.config.mode,
			effectiveMode: entry.effectiveMode,
			billing: entry.config.billing,
			profileId: entry.profileId
		};
	}
	rebuild();
	return {
		list() {
			rebuild();
			return entries;
		},
		get(id) {
			rebuild();
			return entries.find((entry) => entry.config.id === id) ?? null;
		},
		pluginUp: () => up,
		checked: () => asked,
		pluginStatus: () => status,
		pluginError: () => error,
		refresh() {
			if (refreshing) return refreshing;
			refreshing = run(doRefresh).catch((err) => {
				log.error("refresh failed", err);
			}).finally(() => {
				refreshing = null;
			});
			return refreshing;
		},
		save: (input) => run(() => doSave(input)),
		remove: (id) => run(() => doRemove(id)),
		rotateToken: (id) => run(() => doRotate(id)),
		repairProfile: (id) => run(() => doRepair(id)),
		switchToDirect: (id, directKey) => run(async () => {
			const result = await doSave({
				id,
				patch: { mode: "direct" },
				directKey
			});
			return result.ok ? {
				ok: true,
				data: null,
				warnings: result.warnings
			} : result;
		}),
		sendToPlugin: (id) => run(async () => {
			const result = await doSave({
				id,
				patch: {}
			});
			return result.ok ? {
				ok: true,
				data: null,
				warnings: result.warnings
			} : result;
		}),
		summaries() {
			rebuild();
			return entries.map(summaryOf);
		},
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	};
}
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
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value) {
	return isRecord$1(value) ? value : {};
}
function finite$1(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function nonNegative$1(value) {
	const n = finite$1(value);
	return n !== null && n >= 0 ? n : null;
}
function positive$1(value) {
	const n = finite$1(value);
	return n !== null && n > 0 ? n : null;
}
function text(value) {
	return typeof value === "string" ? value.trim() : "";
}
function strings$1(value) {
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
function round4(value) {
	return Math.round(value * 1e4) / 1e4;
}
/** NanoGPT lists `…Per1kTokens`; the contracts hold USD per 1M tokens. */
function per1kToPer1m(value) {
	return roundUsd(value * 1e3);
}
function clamp01(value) {
	return Math.min(1, Math.max(0, value));
}
function compareNumbers(a, b) {
	return a < b ? -1 : a > b ? 1 : 0;
}
/** `created` is seconds in NanoGPT's list; a millisecond value is tolerated. */
function toSeconds(value) {
	const n = positive$1(value);
	if (n === null) return null;
	return n > 1e11 ? Math.floor(n / 1e3) : Math.floor(n);
}
/**
* One entry of `GET /api/v1/models?detailed=true`. Null when it has no id. Everything else is tolerated: a missing
* price becomes 0 (NanoGPT lists a few models as "varies by modality" without a price), a missing window becomes null.
* `pricing.prompt/completion` are already USD per 1M; `cacheReadInputPer1kTokens` is per 1k and converted.
*/
function normalizeCatalogModel(raw) {
	if (!isRecord$1(raw)) return null;
	const id = text(raw["id"]);
	if (!id) return null;
	const caps = record(raw["capabilities"]);
	const price = record(raw["pricing"]);
	const sub = record(raw["subscription"]);
	const cacheRead = nonNegative$1(price["cacheReadInputPer1kTokens"]);
	return {
		id,
		name: text(raw["name"]) || id,
		description: text(raw["description"]),
		contextLength: positive$1(raw["context_length"]),
		maxOutputTokens: positive$1(raw["max_output_tokens"]),
		capabilities: {
			vision: caps["vision"] === true,
			reasoning: caps["reasoning"] === true,
			toolCalling: caps["tool_calling"] === true,
			structuredOutput: caps["structured_output"] === true
		},
		reasoningEfforts: strings$1(raw["reasoning_efforts"]),
		openWeights: raw["open_weights"] === true,
		pricing: {
			prompt: roundUsd(nonNegative$1(price["prompt"]) ?? 0),
			completion: roundUsd(nonNegative$1(price["completion"]) ?? 0),
			cacheRead: cacheRead === null ? null : per1kToPer1m(cacheRead)
		},
		category: text(raw["category"]) || null,
		subscription: {
			included: sub["included"] === true,
			inputTokenMultiplier: positive$1(sub["inputTokenMultiplier"]) ?? 1
		},
		providerIds: strings$1(raw["providers"]),
		created: toSeconds(raw["created"])
	};
}
/**
* The whole answer of the models endpoint: the `{ data: [...] }` envelope or a bare array. Junk entries are skipped,
* the order is kept, and a repeated id keeps its first entry.
*/
function normalizeCatalog(rawList) {
	const list = Array.isArray(rawList) ? rawList : isRecord$1(rawList) && Array.isArray(rawList["data"]) ? rawList["data"] : [];
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
	const input = nonNegative$1(p["inputPer1kTokens"]);
	const output = nonNegative$1(p["outputPer1kTokens"]);
	if (input === null || output === null) return null;
	const cacheRead = nonNegative$1(p["cacheReadInputPer1kTokens"]);
	return {
		prompt: per1kToPer1m(input),
		completion: per1kToPer1m(output),
		cacheRead: cacheRead === null ? null : per1kToPer1m(cacheRead)
	};
}
/** NanoGPT reports `uptime: { uptimePct }` (percent); a bare number is taken as percent too. */
function uptimeOf(raw) {
	const n = isRecord$1(raw) ? nonNegative$1(raw["uptimePct"]) : nonNegative$1(raw);
	return n !== null && n <= 100 ? n : null;
}
/** `features` is an object of flags (`{ toolCalling: true, … }`): the names that are true. A list of names is kept. */
function featuresOf(raw) {
	if (Array.isArray(raw)) return strings$1(raw);
	if (!isRecord$1(raw)) return [];
	return Object.keys(raw).filter((key) => raw[key] === true);
}
function normalizeEndpoint(raw) {
	if (!isRecord$1(raw)) return null;
	const id = text(raw["provider"]);
	if (!id || raw["available"] === false) return null;
	const { quantization, rawQuantization } = mapQuantization(raw["quantization"]);
	return {
		id,
		quantization,
		rawQuantization,
		pricing: priceOf(raw["pricing"]),
		tps: positive$1(raw["tps"]),
		ttftMs: positive$1(raw["ttftMs"]),
		uptime: uptimeOf(raw["uptime"]),
		maxOutputTokens: positive$1(raw["maxOutputTokens"]),
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
	if (!isRecord$1(raw)) return null;
	const hosts = raw["providers"];
	if (!(Array.isArray(hosts) || typeof raw["supportsProviderSelection"] === "boolean" || typeof raw["canonicalId"] === "string")) return null;
	const id = text(modelId) || text(raw["canonicalId"]);
	if (!id) return null;
	const rate = finite$1(raw["autoCacheReadRate"]);
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
		autoTps: positive$1(raw["autoTps"]),
		autoTtftMs: positive$1(raw["autoTtftMs"]),
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
/** Case-folds for search: lower case, ё = е, compatibility forms unified. No `\w`, so Cyrillic is safe. */
function fold(value) {
	return value.normalize("NFKC").toLowerCase().replace(/ё/g, "е");
}
/** The models that pass every field of the query, in their incoming order. */
function filterCatalog(models, query) {
	const words = fold(query.text ?? "").split(/\s+/).filter(Boolean);
	const categories = (query.categories ?? []).map(fold);
	const caps = query.capabilities ?? {};
	const minContext = finite$1(query.minContext);
	const maxPrompt = finite$1(query.maxPromptPrice);
	return models.filter((m) => {
		if (words.length > 0) {
			const haystack = fold(`${m.id}\n${m.name}\n${m.description}`);
			if (!words.every((w) => haystack.includes(w))) return false;
		}
		if (categories.length > 0 && !categories.includes(fold(m.category ?? ""))) return false;
		if (query.subscriptionOnly && !m.subscription.included) return false;
		if (caps.vision && !m.capabilities.vision) return false;
		if (caps.reasoning && !m.capabilities.reasoning) return false;
		if (caps.tools && !m.capabilities.toolCalling) return false;
		if (caps.structured && !m.capabilities.structuredOutput) return false;
		if (minContext !== null && (m.contextLength === null || m.contextLength < minContext)) return false;
		if (maxPrompt !== null && m.pricing.prompt > maxPrompt) return false;
		if (query.openWeightsOnly && !m.openWeights) return false;
		return true;
	});
}
/** The shelves of the list with their sizes, the biggest first (equal sizes keep the order of first appearance). */
function listCategories(models) {
	const counts = /* @__PURE__ */ new Map();
	for (const m of models) counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
	return [...counts].map(([category, count]) => ({
		category,
		count
	})).sort((a, b) => b.count - a.count);
}
var NAME_COLLATOR = new Intl.Collator("en", {
	numeric: true,
	sensitivity: "base"
});
/** Unknown values (null) always go last, whichever way the order runs. */
function compareNullable(a, b, direction) {
	if (a === null) return b === null ? 0 : 1;
	if (b === null) return -1;
	return direction * compareNumbers(a, b);
}
/** A sorted copy; see `CatalogSort` for the orders. `reverse` turns the order around. Ties keep their incoming order. */
function sortCatalog(models, sort, reverse = false) {
	const dir = reverse ? -1 : 1;
	const price = (m) => m.pricing.prompt + m.pricing.completion;
	const compare = (a, b) => {
		switch (sort) {
			case "name": return dir * NAME_COLLATOR.compare(a.name, b.name);
			case "price": return dir * compareNumbers(price(a), price(b));
			case "context": return compareNullable(a.contextLength, b.contextLength, reverse ? 1 : -1);
			case "newest": return compareNullable(a.created, b.created, reverse ? 1 : -1);
			case "subscription": return dir * (Number(b.subscription.included) - Number(a.subscription.included));
		}
	};
	return [...models].sort(compare);
}
/** The part of the id before the first `/`, lower case (`z-ai/glm-5.3` -> `z-ai`, `TEE/glm-5.3` -> `tee`); else 'other'. */
function vendorOf(id) {
	const slash = id.indexOf("/");
	return (slash > 0 ? id.slice(0, slash).trim().toLowerCase() : "") || "other";
}
/** Groups by vendor. Groups come in the order their first model appears, so a prior sort carries over. */
function groupByVendor(models) {
	const groups = /* @__PURE__ */ new Map();
	for (const model of models) {
		const vendor = vendorOf(model.id);
		const group = groups.get(vendor);
		if (group) group.models.push(model);
		else groups.set(vendor, {
			vendor,
			models: [model]
		});
	}
	return [...groups.values()];
}
function tokens(value) {
	return nonNegative$1(value) ?? 0;
}
/**
* Pay-as-you-go cost of one turn in USD. The cached part of the prompt is billed at `pricing.cacheRead` (the plain
* prompt price when the model has none). A subscription-included model costs nothing real: that is for the caller.
*/
function estimateTurnCost(model, usage) {
	const prompt = tokens(usage.promptTokens);
	const completion = tokens(usage.completionTokens);
	const cached = prompt * clamp01(finite$1(usage.cachedShare) ?? 0);
	const { prompt: promptPrice, completion: completionPrice, cacheRead } = model.pricing;
	return roundUsd(((prompt - cached) * promptPrice + cached * (cacheRead ?? promptPrice) + completion * completionPrice) / 1e6);
}
function normalisedWeights(criteria) {
	const w = (v) => nonNegative$1(v) ?? 0;
	const price = w(criteria.weightPrice);
	const speed = w(criteria.weightSpeed);
	const uptime = w(criteria.weightUptime);
	const sum = price + speed + uptime;
	return sum > 0 ? {
		price: price / sum,
		speed: speed / sum,
		uptime: uptime / sum
	} : {
		price: 1 / 3,
		speed: 1 / 3,
		uptime: 1 / 3
	};
}
function numbersOf(values) {
	return values.filter((v) => v !== null);
}
/** Order inside the ranking: hosts over the price cap last, then hosts below the preferred precision. */
function tierOf(overMaxPrice, meets, hasPreference) {
	if (overMaxPrice) return 3;
	if (meets === false) return 2;
	return hasPreference && meets === null ? 1 : 0;
}
/**
* Ranks the hosts of one model for the given priorities. Components and the total are described at `HostScore`;
* hosts in the same tier (see `tierOf`) are ordered by total, then by their incoming order.
*/
function scoreHosts(providers, criteria) {
	const weights = normalisedWeights(criteria);
	const blended = providers.map((p) => p.pricing ? p.pricing.prompt + p.pricing.completion : null);
	const cheapest = Math.min(...numbersOf(blended));
	const bestTps = Math.max(...numbersOf(providers.map((p) => positive$1(p.tps))));
	const bestTtft = Math.min(...numbersOf(providers.map((p) => positive$1(p.ttftMs))));
	const preference = criteria.preferQuantization;
	const hasPreference = quantizationRank(preference) !== null;
	const cap = criteria.maxPrice;
	const scored = providers.map((p, index) => {
		const missing = [];
		const own = blended[index] ?? null;
		let price = 0;
		if (own === null) missing.push("price");
		else price = own <= cheapest ? 1 : cheapest / own;
		const parts = [];
		const tps = positive$1(p.tps);
		const ttft = positive$1(p.ttftMs);
		if (tps !== null) parts.push(tps / bestTps);
		if (ttft !== null) parts.push(bestTtft / ttft);
		let speed = 0;
		if (parts.length === 0) missing.push("speed");
		else speed = parts.reduce((sum, v) => sum + v, 0) / parts.length;
		let uptime = 0;
		if (p.uptime === null) missing.push("uptime");
		else uptime = clamp01((p.uptime - 90) / 10);
		const overMaxPrice = !!cap && !!p.pricing && (cap.prompt !== null && p.pricing.prompt > cap.prompt || cap.completion !== null && p.pricing.completion > cap.completion);
		const meetsQuantization = hasPreference ? meetsMinQuantization(p.quantization, preference) : null;
		const total = weights.price * price + weights.speed * speed + weights.uptime * uptime;
		return {
			index,
			tier: tierOf(overMaxPrice, meetsQuantization, hasPreference),
			score: {
				providerId: p.id,
				rank: 0,
				total: round4(total),
				price: round4(price),
				speed: round4(speed),
				uptime: round4(uptime),
				missing,
				overMaxPrice,
				meetsQuantization
			}
		};
	});
	scored.sort((a, b) => a.tier - b.tier || b.score.total - a.score.total || a.index - b.index);
	return scored.map((entry, i) => ({
		...entry.score,
		rank: i + 1
	}));
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
// src/host/catalog-source.ts
var CATALOG_TIMEOUT_MS$1 = 2e4;
var PROVIDERS_TIMEOUT_MS$1 = 15e3;
function createDirectCatalogSource(deps) {
	const { log } = deps;
	const site = (deps.site ?? "https://nano-gpt.com").replace(/\/+$/, "");
	const doFetch = (input, init) => (deps.fetchImpl ?? globalThis.fetch)(input, init);
	/** One public GET: 2xx -> parsed JSON; any other status -> a failure carrying it. */
	async function getJson(url, timeoutMs) {
		const controller = new AbortController();
		let timer;
		const timeout = new Promise((resolve) => {
			timer = setTimeout(() => {
				resolve("timeout");
				controller.abort();
			}, timeoutMs);
		});
		const work = (async () => {
			const response = await doFetch(url, {
				method: "GET",
				headers: { accept: "application/json" },
				credentials: "omit",
				cache: "no-store",
				signal: controller.signal
			});
			const ok = response.status >= 200 && response.status < 300;
			return {
				status: response.status,
				body: ok ? await response.text() : ""
			};
		})();
		work.catch(() => {});
		try {
			const outcome = await Promise.race([work, timeout]);
			if (outcome === "timeout") return {
				ok: false,
				code: "timeout",
				message: "timeout",
				status: null
			};
			if (outcome.status === 404) return {
				ok: false,
				code: "not_found",
				message: "HTTP 404",
				status: 404
			};
			if (outcome.status < 200 || outcome.status >= 300) return {
				ok: false,
				code: `http_${outcome.status}`,
				message: `HTTP ${outcome.status}`,
				status: outcome.status
			};
			try {
				return {
					ok: true,
					data: JSON.parse(outcome.body)
				};
			} catch {
				return {
					ok: false,
					code: "invalid_response",
					message: "not JSON",
					status: null
				};
			}
		} catch (error) {
			return {
				ok: false,
				code: "unreachable",
				message: error instanceof Error ? error.message : String(error),
				status: null
			};
		} finally {
			if (timer !== void 0) clearTimeout(timer);
		}
	}
	return {
		async catalog() {
			const result = await getJson(`${site}/api/v1/models?detailed=true`, deps.catalogTimeoutMs ?? CATALOG_TIMEOUT_MS$1);
			if (!result.ok) {
				log.debug(`direct catalog fetch failed (${result.code})`);
				return result;
			}
			const models = normalizeCatalog(result.data);
			if (models.length === 0) return {
				ok: false,
				code: "invalid_response",
				message: "no models in the answer",
				status: null
			};
			return {
				ok: true,
				data: models
			};
		},
		async providers(modelId) {
			const result = await getJson(`${site}/api/models/${encodeURIComponent(modelId)}/providers`, deps.providersTimeoutMs ?? PROVIDERS_TIMEOUT_MS$1);
			if (!result.ok) {
				log.debug(`direct providers fetch failed (${result.code})`);
				return result;
			}
			const value = normalizeModelProviders(modelId, result.data);
			if (!value) return {
				ok: false,
				code: "invalid_response",
				message: "unrecognised answer",
				status: null
			};
			return {
				ok: true,
				data: value
			};
		}
	};
}
var DB_NAME = "nanovia";
var STORE_NAME = "catalog";
var SNAPSHOT_KEY = "snapshot";
/** Keeps the snapshot in memory only (the fallback, and what tests use). */
function createMemoryCatalogStorage(initial = null) {
	let held = initial;
	return {
		load: async () => held,
		save: async (value) => {
			held = value;
		}
	};
}
function isStored(value) {
	if (typeof value !== "object" || value === null) return false;
	const record = value;
	return record["version"] === 1 && typeof record["fetchedAt"] === "number" && Number.isFinite(record["fetchedAt"]) && Array.isArray(record["models"]);
}
/** IndexedDB through ST's localforage; falls back to memory when it cannot be opened or used. */
function createCatalogStorage(log) {
	const memory = createMemoryCatalogStorage();
	let instance;
	function store() {
		if (instance !== void 0) return instance;
		try {
			const forage = globalThis.SillyTavern?.libs?.localforage;
			instance = forage ? forage.createInstance({
				name: DB_NAME,
				storeName: STORE_NAME
			}) : null;
		} catch (error) {
			log.debug("localforage is not usable; the catalog is kept in memory", error);
			instance = null;
		}
		return instance;
	}
	return {
		async load() {
			const forage = store();
			if (forage) try {
				const value = await forage.getItem(SNAPSHOT_KEY);
				if (isStored(value)) return value;
			} catch (error) {
				log.debug("the stored catalog could not be read", error);
			}
			return memory.load();
		},
		async save(value) {
			await memory.save(value);
			const forage = store();
			if (!forage) return;
			try {
				await forage.setItem(SNAPSHOT_KEY, value);
			} catch (error) {
				log.debug("the catalog could not be stored", error);
			}
		}
	};
}
// src/host/plugin-catalog.ts
/** The catalog is ~700 KB: give the plugin more than the default call time when it has to fetch NanoGPT first. */
var CATALOG_TIMEOUT_MS = 3e4;
var PROVIDERS_TIMEOUT_MS = 2e4;
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finite(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function positive(value) {
	const n = finite(value);
	return n !== null && n > 0 ? n : null;
}
function nonNegative(value) {
	const n = finite(value);
	return n !== null && n >= 0 ? n : null;
}
function strings(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((item) => typeof item === "string" && item.length > 0);
}
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
/** One model of the contract shape (`CatalogModel`); null when it has no id or no usable prices. */
function readCatalogModel(raw) {
	if (!isRecord(raw)) return null;
	const id = typeof raw["id"] === "string" ? raw["id"].trim() : "";
	if (!id) return null;
	const caps = isRecord(raw["capabilities"]) ? raw["capabilities"] : {};
	const price = isRecord(raw["pricing"]) ? raw["pricing"] : {};
	const sub = isRecord(raw["subscription"]) ? raw["subscription"] : {};
	return {
		id,
		name: typeof raw["name"] === "string" && raw["name"].trim() ? raw["name"].trim() : id,
		description: typeof raw["description"] === "string" ? raw["description"] : "",
		contextLength: positive(raw["contextLength"]),
		maxOutputTokens: positive(raw["maxOutputTokens"]),
		capabilities: {
			vision: caps["vision"] === true,
			reasoning: caps["reasoning"] === true,
			toolCalling: caps["toolCalling"] === true,
			structuredOutput: caps["structuredOutput"] === true
		},
		reasoningEfforts: strings(raw["reasoningEfforts"]),
		openWeights: raw["openWeights"] === true,
		pricing: {
			prompt: nonNegative(price["prompt"]) ?? 0,
			completion: nonNegative(price["completion"]) ?? 0,
			cacheRead: nonNegative(price["cacheRead"])
		},
		category: typeof raw["category"] === "string" && raw["category"] ? raw["category"] : null,
		subscription: {
			included: sub["included"] === true,
			inputTokenMultiplier: positive(sub["inputTokenMultiplier"]) ?? 1
		},
		providerIds: strings(raw["providerIds"]),
		created: positive(raw["created"])
	};
}
/** A list of models of the contract shape: junk entries are skipped, a repeated id keeps its first entry. */
function readCatalogModels(raw) {
	if (!Array.isArray(raw)) return [];
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const item of raw) {
		const model = readCatalogModel(item);
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		out.push(model);
	}
	return out;
}
function readEndpoint(raw) {
	if (!isRecord(raw)) return null;
	const id = typeof raw["id"] === "string" ? raw["id"].trim() : "";
	if (!id) return null;
	const price = isRecord(raw["pricing"]) ? raw["pricing"] : null;
	const prompt = price ? nonNegative(price["prompt"]) : null;
	const completion = price ? nonNegative(price["completion"]) : null;
	const quantization = raw["quantization"];
	return {
		id,
		quantization: typeof quantization === "string" && QUANTIZATIONS.includes(quantization) ? quantization : null,
		rawQuantization: typeof raw["rawQuantization"] === "string" && raw["rawQuantization"] ? raw["rawQuantization"] : null,
		pricing: price && prompt !== null && completion !== null ? {
			prompt,
			completion,
			cacheRead: nonNegative(price["cacheRead"])
		} : null,
		tps: positive(raw["tps"]),
		ttftMs: positive(raw["ttftMs"]),
		uptime: nonNegative(raw["uptime"]),
		maxOutputTokens: positive(raw["maxOutputTokens"]),
		features: strings(raw["features"])
	};
}
/** A host list of the contract shape (`ModelProviders` + `fetchedAt`); null when it is not one. */
function readModelProviders(raw, fallbackFetchedAt) {
	if (!isRecord(raw)) return null;
	const modelId = typeof raw["modelId"] === "string" ? raw["modelId"].trim() : "";
	if (!modelId || !Array.isArray(raw["providers"])) return null;
	const seen = /* @__PURE__ */ new Set();
	const providers = [];
	for (const item of raw["providers"]) {
		const endpoint = readEndpoint(item);
		if (!endpoint || seen.has(endpoint.id)) continue;
		seen.add(endpoint.id);
		providers.push(endpoint);
	}
	const rate = finite(raw["autoCacheReadRate"]);
	return {
		modelId,
		supportsProviderSelection: raw["supportsProviderSelection"] !== false,
		autoCacheReadRate: rate !== null && rate >= 0 && rate <= 1 ? rate : null,
		autoTps: positive(raw["autoTps"]),
		autoTtftMs: positive(raw["autoTtftMs"]),
		providers,
		fetchedAt: positive(raw["fetchedAt"]) ?? fallbackFetchedAt
	};
}
function invalid(what) {
	return {
		ok: false,
		error: {
			code: "invalid_response",
			message: `unexpected ${what}`,
			status: null
		}
	};
}
function createPluginCatalogClient(plugin, log, now = Date.now) {
	return {
		async catalog(options) {
			const result = await plugin.request("GET", options?.refresh ? "/catalog?refresh=1" : "/catalog", { timeoutMs: CATALOG_TIMEOUT_MS });
			if (!result.ok) return result;
			const data = result.data;
			if (!isRecord(data) || !Array.isArray(data["models"])) return invalid("catalog answer");
			const models = readCatalogModels(data["models"]);
			if (models.length === 0) return invalid("catalog answer (no models)");
			if (models.length < data["models"].length) log.debug("the plugin sent models that could not be read; skipped");
			const source = data["source"];
			return {
				ok: true,
				data: {
					models,
					fetchedAt: positive(data["fetchedAt"]) ?? now(),
					source: source === "live" || source === "cache" || source === "stale" ? source : "cache"
				}
			};
		},
		async providers(modelId, options) {
			const query = `id=${encodeURIComponent(modelId)}${options?.refresh ? "&refresh=1" : ""}`;
			const result = await plugin.request("GET", `/catalog/providers?${query}`, { timeoutMs: PROVIDERS_TIMEOUT_MS });
			if (!result.ok) return result;
			const value = readModelProviders(result.data, now());
			return value ? {
				ok: true,
				data: value
			} : invalid("host list");
		}
	};
}
function createCatalogStore(deps) {
	const { plugin, pluginCatalog, direct, storage, bus, log } = deps;
	const now = deps.now ?? Date.now;
	const freshMs = deps.freshMs ?? 6e5;
	const providersFreshMs = deps.providersFreshMs ?? 3e5;
	const capacity = Math.max(1, deps.providersCapacity ?? 200);
	const backoffMs = deps.failureBackoffMs ?? 3e4;
	let snapshot = null;
	let source = null;
	let via = null;
	let error = null;
	let failedAt = null;
	let triedStorage = false;
	let inflight = null;
	let inflightForced = false;
	const entries = /* @__PURE__ */ new Map();
	const flights = /* @__PURE__ */ new Map();
	const listeners = /* @__PURE__ */ new Set();
	function changed() {
		for (const listener of [...listeners]) try {
			listener();
		} catch (failure) {
			log.error("a catalog listener failed", failure);
		}
		bus.emit("catalog:changed", { count: snapshot?.models.length ?? 0 });
	}
	/** The exact id, else the id with trailing `:suffix` parts peeled off one by one (`:thinking:max` -> `:thinking` -> base). */
	function lookup(id) {
		const held = snapshot;
		if (!held || typeof id !== "string") return null;
		let key = id.trim();
		for (;;) {
			const model = held.byId.get(key);
			if (model) return model;
			const cut = key.lastIndexOf(":");
			if (cut <= 0) return null;
			key = key.slice(0, cut);
		}
	}
	/** The key of a model's host list: its catalog id when the catalog knows the model, else the id as given. */
	function providersKey(id) {
		return lookup(id)?.id ?? (typeof id === "string" ? id.trim() : "");
	}
	function touch(key) {
		const entry = entries.get(key);
		if (entry) {
			entries.delete(key);
			entries.set(key, entry);
		}
		return entry;
	}
	function putEntry(key, entry) {
		entries.delete(key);
		entries.set(key, entry);
		while (entries.size > capacity) {
			const oldest = entries.keys().next();
			if (oldest.done) break;
			entries.delete(oldest.value);
		}
	}
	function makeSnapshot(models, fetchedAt) {
		return {
			models,
			byId: new Map(models.map((m) => [m.id, m])),
			fetchedAt: Math.min(fetchedAt, now())
		};
	}
	const isFresh = (value) => now() - value.fetchedAt < freshMs;
	/** Reads the copy stored in the browser, once. It only fills an empty store. */
	async function restore() {
		triedStorage = true;
		let stored = null;
		try {
			stored = await storage.load();
		} catch (failure) {
			log.debug("the stored catalog could not be read", failure);
		}
		if (!stored || snapshot || stored.version !== 1) return;
		const models = readCatalogModels(stored.models);
		if (models.length === 0) return;
		snapshot = makeSnapshot(models, stored.fetchedAt);
		source = isFresh(snapshot) ? "cache" : "stale";
		via = "storage";
		error = null;
		changed();
	}
	function persist(value) {
		storage.save({
			version: 1,
			fetchedAt: value.fetchedAt,
			models: value.models
		}).catch((failure) => log.debug("the catalog could not be stored", failure));
	}
	async function pluginIsUp() {
		try {
			return await plugin.available();
		} catch {
			return false;
		}
	}
	/** The plugin first, then NanoGPT itself. null with the last error code when neither delivered. */
	async function fetchSnapshot(force) {
		if (await pluginIsUp()) {
			const result = await pluginCatalog.catalog({ refresh: force });
			if (result.ok) {
				const { models, fetchedAt, source: kind } = result.data;
				return {
					ok: true,
					value: {
						models,
						fetchedAt,
						source: kind,
						via: "plugin"
					}
				};
			}
			log.debug(`the plugin could not deliver the catalog (${result.error.code}); asking NanoGPT directly`);
		}
		const result = await direct.catalog();
		if (result.ok) return {
			ok: true,
			value: {
				models: result.data,
				fetchedAt: now(),
				source: "live",
				via: "direct"
			}
		};
		return {
			ok: false,
			code: result.code
		};
	}
	async function load(force) {
		if (!triedStorage && !snapshot) await restore();
		if (snapshot && !force) {
			if (isFresh(snapshot)) return;
			if (failedAt !== null && now() - failedAt < backoffMs) return;
		}
		const result = await fetchSnapshot(force);
		if (result.ok) {
			const { value } = result;
			if (!snapshot || Math.min(value.fetchedAt, now()) >= snapshot.fetchedAt) {
				snapshot = makeSnapshot(value.models, value.fetchedAt);
				source = value.source;
				via = value.via;
				persist(snapshot);
			}
			error = null;
			failedAt = null;
			changed();
			return;
		}
		failedAt = now();
		error = result.code;
		log.warn(`the catalog could not be loaded (${result.code})${snapshot ? "; the old copy is kept" : ""}`);
		if (snapshot) source = "stale";
		changed();
	}
	function refresh(force = false) {
		if (inflight) {
			if (!force || inflightForced) return inflight;
			return inflight.then(() => refresh(true));
		}
		inflightForced = force;
		const running = load(force).catch((failure) => {
			log.error("the catalog load failed unexpectedly", failure);
		}).finally(() => {
			if (inflight === running) inflight = null;
		});
		inflight = running;
		return running;
	}
	async function fetchProviders(key, held) {
		let value = null;
		if (await pluginIsUp()) {
			const result = await pluginCatalog.providers(key);
			if (result.ok) value = result.data;
			else log.debug(`the plugin could not deliver the hosts (${result.error.code}); asking NanoGPT directly`);
		}
		if (!value) {
			const result = await direct.providers(key);
			if (result.ok) value = {
				...result.data,
				fetchedAt: now()
			};
		}
		if (value) {
			putEntry(key, {
				value,
				fetchedAt: Math.min(value.fetchedAt, now()),
				failedAt: null
			});
			changed();
			return value;
		}
		log.debug("the host list could not be loaded");
		putEntry(key, {
			value: held?.value ?? null,
			fetchedAt: held?.fetchedAt ?? 0,
			failedAt: now()
		});
		return held?.value ?? null;
	}
	async function ensureProviders(id, options) {
		try {
			const key = providersKey(id);
			if (!key) return null;
			const held = touch(key);
			if (!options?.force) {
				if (held?.value && now() - held.fetchedAt < providersFreshMs) return held.value;
				if (held?.failedAt != null && now() - held.failedAt < backoffMs) return held.value;
			}
			const running = flights.get(key);
			if (running) return await running;
			const flight = fetchProviders(key, held).finally(() => {
				if (flights.get(key) === flight) flights.delete(key);
			});
			flights.set(key, flight);
			return await flight;
		} catch (failure) {
			log.error("loading a host list failed unexpectedly", failure);
			return null;
		}
	}
	return {
		models: () => snapshot?.models ?? [],
		model: lookup,
		providers: (id) => touch(providersKey(id))?.value ?? null,
		ensureProviders,
		hints(id) {
			const model = lookup(id);
			return model ? routingHints(model, touch(model.id)?.value ?? null) : [];
		},
		status: () => ({
			loaded: snapshot !== null,
			fetchedAt: snapshot?.fetchedAt ?? null,
			source,
			error,
			via
		}),
		refresh,
		onChange(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
}
/** The store as the app wires it: the plugin client, a direct source, and IndexedDB storage. */
function createBrowserCatalogStore(deps) {
	return createCatalogStore({
		plugin: deps.plugin,
		pluginCatalog: createPluginCatalogClient(deps.plugin, deps.log),
		direct: createDirectCatalogSource({ log: deps.log }),
		storage: createCatalogStorage(deps.log),
		bus: deps.bus,
		log: deps.log
	});
}
// src/core/i18n.ts
/**
* Both dictionaries are bundled: every feature registers its parts on init, so the manifest needs no locale files and
* there is no merge step. Russian is the primary language; a key missing in the chosen language falls back to the other
* one (English first), and a key missing everywhere shows as itself.
*/
var Translations = class {
	resolveLocale;
	en = {};
	ru = {};
	constructor(resolveLocale) {
		this.resolveLocale = resolveLocale;
	}
	register(parts) {
		Object.assign(this.en, parts.en);
		Object.assign(this.ru, parts.ru);
	}
	locale() {
		return this.resolveLocale();
	}
	t(key, params) {
		const text = (this.locale() === "ru" ? this.ru[key] ?? this.en[key] : this.en[key] ?? this.ru[key]) ?? key;
		if (!params) return text;
		return text.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
	}
	has(key) {
		return Object.hasOwn(this.en, key) || Object.hasOwn(this.ru, key);
	}
	/** Keys present in English but missing in Russian (used by tests). */
	missingRussian() {
		return Object.keys(this.en).filter((key) => !Object.hasOwn(this.ru, key));
	}
	/** Keys present in Russian but missing in English (used by tests). */
	missingEnglish() {
		return Object.keys(this.ru).filter((key) => !Object.hasOwn(this.en, key));
	}
};
/** ST keeps the UI language in `getCurrentLocale()` (and localStorage 'language', e.g. 'ru-ru'). */
function hostLocale(getLocale) {
	let value;
	try {
		value = getLocale?.() ?? globalThis.localStorage?.getItem("language") ?? void 0;
	} catch {
		value = void 0;
	}
	return value?.toLowerCase().startsWith("ru") ? "ru" : "en";
}
function createI18n(resolveLocale) {
	return new Translations(resolveLocale);
}
// src/core/logger.ts
var ORDER = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40
};
var MAX_LINES = 300;
/** Console logger (`[Nanovia:scope]`) with a ring buffer of warnings and errors. Never pass a secret to it. */
var ConsoleLogger = class ConsoleLogger {
	prefix;
	static threshold = "info";
	static lines = [];
	constructor(prefix = "Nanovia") {
		this.prefix = prefix;
	}
	static setLevel(level) {
		ConsoleLogger.threshold = level;
	}
	/** Warnings and errors since the page loaded (newest last). */
	static recent() {
		return [...ConsoleLogger.lines];
	}
	static clear() {
		ConsoleLogger.lines = [];
	}
	scope(name) {
		return new ConsoleLogger(`${this.prefix}:${name}`);
	}
	debug(...args) {
		this.write("debug", args);
	}
	info(...args) {
		this.write("info", args);
	}
	warn(...args) {
		this.write("warn", args);
	}
	error(...args) {
		this.write("error", args);
	}
	write(level, args) {
		if (ORDER[level] >= ORDER.warn) {
			ConsoleLogger.lines.push({
				at: Date.now(),
				level,
				scope: this.prefix,
				text: args.map(stringify).join(" ")
			});
			if (ConsoleLogger.lines.length > MAX_LINES) ConsoleLogger.lines.splice(0, ConsoleLogger.lines.length - MAX_LINES);
		}
		if (ORDER[level] < ORDER[ConsoleLogger.threshold]) return;
		const tag = `[${this.prefix}]`;
		if (level === "debug") console.debug(tag, ...args);
		else if (level === "info") console.info(tag, ...args);
		else if (level === "warn") console.warn(tag, ...args);
		else console.error(tag, ...args);
	}
};
function stringify(value) {
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
function createLogger() {
	return new ConsoleLogger();
}
// src/core/settings.ts
var SETTINGS_KEY = NANOVIA_SETTINGS_KEY;
var UI_LANGUAGES = [
	"auto",
	"ru",
	"en"
];
function defaultSettings() {
	return {
		schemaVersion: 1,
		debug: false,
		uiLanguage: "auto",
		lastTab: "",
		profiles: {},
		directSecrets: {},
		mirror: [],
		pending: []
	};
}
/**
* Migration steps by the schema they start from: `SETTINGS_MIGRATIONS[1]` moves 1 -> 2, and so on. Add a step and bump
* SETTINGS_SCHEMA_VERSION together. Schema 0 is "no version stored" (first run): nothing to move.
*/
var SETTINGS_MIGRATIONS = {};
function isDict(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
/** A connectionId -> string map with junk entries dropped. */
function idMap(value) {
	const out = {};
	if (!isDict(value)) return out;
	for (const [key, item] of Object.entries(value)) if (isValidConnectionId(key) && typeof item === "string" && item.trim()) out[key] = item;
	return out;
}
function mirrorList(value, now) {
	if (!Array.isArray(value)) return [];
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const raw of value) {
		const config = normalizeConnection(raw, now);
		if (!config || seen.has(config.id)) continue;
		seen.add(config.id);
		out.push(config);
	}
	return out;
}
function idList(value) {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter(isValidConnectionId))];
}
/**
* Runs the migration steps from the stored schema up to `target`, then rebuilds the object from known keys only:
* defaults for missing or wrongly typed values, the mirror re-validated through the connection model. Never throws: a
* failing step is logged and skipped.
*/
function migrateSettings(raw, log, migrations = SETTINGS_MIGRATIONS, target = 1, now = Date.now()) {
	const source = isDict(raw) ? raw : {};
	const stored = typeof source["schemaVersion"] === "number" ? source["schemaVersion"] : 0;
	let version = stored;
	while (version < target) {
		const step = migrations[version];
		if (step) try {
			step(source);
		} catch (error) {
			log?.error(`settings migration from schema ${version} failed`, error);
		}
		version++;
	}
	const defaults = defaultSettings();
	const language = source["uiLanguage"];
	return {
		schemaVersion: Math.max(target, stored),
		debug: typeof source["debug"] === "boolean" ? source["debug"] : defaults.debug,
		uiLanguage: language === "ru" || language === "en" || language === "auto" ? language : defaults.uiLanguage,
		lastTab: typeof source["lastTab"] === "string" ? source["lastTab"] : defaults.lastTab,
		profiles: idMap(source["profiles"]),
		directSecrets: idMap(source["directSecrets"]),
		mirror: mirrorList(source["mirror"], now),
		pending: idList(source["pending"])
	};
}
var Settings = class {
	getStore;
	persist;
	log;
	listeners = /* @__PURE__ */ new Set();
	root;
	constructor(getStore, persist, log) {
		this.getStore = getStore;
		this.persist = persist;
		this.log = log;
		this.root = this.load();
	}
	/** Re-reads extensionSettings (ST may replace the object after a settings reload). */
	reload() {
		this.root = this.load();
	}
	get() {
		return this.root;
	}
	set(key, value) {
		this.root[key] = value;
		this.save();
		this.notify(key);
	}
	update(mutator, key = "*") {
		mutator(this.root);
		this.save();
		this.notify(key);
	}
	save() {
		try {
			this.persist();
		} catch (error) {
			this.log.error("could not save settings", error);
		}
	}
	/** Lifecycle `clean`: drops everything Nanovia stored in settings. */
	reset() {
		delete this.getStore()[SETTINGS_KEY];
		this.root = this.load();
		this.save();
		this.notify("*");
	}
	onChange(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	notify(key) {
		for (const listener of [...this.listeners]) try {
			listener(key);
		} catch (error) {
			this.log.error("settings listener failed", error);
		}
	}
	load() {
		const store = this.getStore();
		const root = migrateSettings(store[SETTINGS_KEY], this.log);
		store[SETTINGS_KEY] = root;
		return root;
	}
};
// src/ui/format.ts
/** Strips trailing zeros of a fixed-point number: 1.50 -> 1.5, 2.00 -> 2. */
function trimZeros(text) {
	return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}
/** USD per 1M tokens, three significant digits: 0.0387 -> "0.0387", 0.6 -> "0.6", 15 -> "15", 0 -> "0". */
function formatPrice(usdPer1M) {
	if (!Number.isFinite(usdPer1M) || usdPer1M <= 0) return "0";
	const text = String(Number(usdPer1M.toPrecision(3)));
	return text.includes("e") ? trimZeros(usdPer1M.toFixed(9)) : text;
}
/** A price pair for a list row: "0.6 / 1.1". */
function formatPricePair(prompt, completion) {
	return `${formatPrice(prompt)} / ${formatPrice(completion)}`;
}
/**
* Tokens as K/M. A round decimal count stays decimal (200000 -> "200K", 512000 -> "512K", 1000000 -> "1M"); a multiple of
* 1024 that is not one counts in 1024s (131072 -> "128K", 1048576 -> "1M", 49152 -> "48K"); null -> "?".
*/
function formatContext(tokens) {
	if (tokens === null || !Number.isFinite(tokens) || tokens <= 0) return "?";
	const k = tokens % 1e3 !== 0 && tokens % 1024 === 0 ? 1024 : 1e3;
	if (tokens >= k * k) return `${trimZeros((tokens / (k * k)).toFixed(1))}M`;
	if (tokens >= k) return `${trimZeros((tokens / k).toFixed(1))}K`;
	return String(tokens);
}
// src/features/catalog/view-model.ts
/** A cost in USD for a turn: "$0.0123", "$1.50", "<$0.0001", "$0". */
function formatUsd(usd) {
	if (!Number.isFinite(usd) || usd <= 0) return "$0";
	if (usd < 1e-4) return "<$0.0001";
	const trimmed = trimZeros(usd >= 1 ? usd.toFixed(2) : usd.toFixed(4));
	return `$${(trimmed.includes(".") ? trimmed.split(".")[1]?.length ?? 0 : 0) >= 2 ? trimmed : Number(trimmed).toFixed(2)}`;
}
function formatPercent(share) {
	return `${Math.round(share * 100)}%`;
}
function formatCount(value, unit) {
	return value === null ? "—" : `${trimZeros(value.toFixed(1))}${unit}`;
}
/** "5 min ago" and friends; `now` is passed in so the function stays pure. */
function formatAge(at, now, t) {
	const seconds = Math.max(0, Math.round((now - at) / 1e3));
	if (seconds < 60) return t("catalog.age.now");
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return t("catalog.age.minutes", { n: minutes });
	const hours = Math.round(minutes / 60);
	if (hours < 48) return t("catalog.age.hours", { n: hours });
	return t("catalog.age.days", { n: Math.round(hours / 24) });
}
/** A number typed into a field ("1,5", " 20000 "); null when empty, not a number or negative. */
function parseNumber(text) {
	const cleaned = text.trim().replace(/\s+/g, "").replace(",", ".");
	if (!cleaned) return null;
	const value = Number(cleaned);
	return Number.isFinite(value) && value >= 0 ? value : null;
}
var KNOWN_CATEGORIES = {
	uncensored: "uncensored",
	"roleplay/storytelling models": "roleplay",
	"private/tee": "tee",
	more: "more"
};
/** The shelf of a model in the user's language; an unknown shelf shows as NanoGPT names it, no shelf as "Other". */
function categoryLabel(category, t) {
	if (category === null || category === "") return t("catalog.category.none");
	const known = KNOWN_CATEGORIES[category.toLowerCase()];
	return known ? t(`catalog.category.${known}`) : category;
}
function vendorLabel(vendor, t) {
	return vendor === "other" ? t("catalog.vendor.other") : vendor;
}
var CAPABILITIES = [
	{
		key: "vision",
		icon: "eye",
		has: (m) => m.capabilities.vision
	},
	{
		key: "reasoning",
		icon: "brain",
		has: (m) => m.capabilities.reasoning
	},
	{
		key: "tools",
		icon: "screwdriver-wrench",
		has: (m) => m.capabilities.toolCalling
	},
	{
		key: "structured",
		icon: "code",
		has: (m) => m.capabilities.structuredOutput
	}
];
var SORTS = [
	"name",
	"price",
	"context",
	"newest",
	"subscription"
];
/** Minimum context choices of the filter (tokens); 0 = no requirement. */
var CONTEXT_CHOICES = [
	0,
	8192,
	32768,
	131072,
	2e5,
	1048576
];
function defaultFilters() {
	return {
		text: "",
		categories: [],
		subscriptionOnly: false,
		vision: false,
		reasoning: false,
		tools: false,
		structured: false,
		minContext: 0,
		maxPromptPrice: null,
		openWeightsOnly: false,
		sort: "name",
		reverse: false,
		groupByVendor: false
	};
}
function queryOf(state) {
	const query = {};
	if (state.text.trim()) query.text = state.text;
	if (state.categories.length > 0) query.categories = state.categories;
	if (state.subscriptionOnly) query.subscriptionOnly = true;
	const capabilities = {
		...state.vision ? { vision: true } : {},
		...state.reasoning ? { reasoning: true } : {},
		...state.tools ? { tools: true } : {},
		...state.structured ? { structured: true } : {}
	};
	if (Object.keys(capabilities).length > 0) query.capabilities = capabilities;
	if (state.minContext > 0) query.minContext = state.minContext;
	if (state.maxPromptPrice !== null) query.maxPromptPrice = state.maxPromptPrice;
	if (state.openWeightsOnly) query.openWeightsOnly = true;
	return query;
}
/** Whether any filter (not the sort or the grouping) is set: the "reset" button and the empty-result message use it. */
function hasActiveFilters(state) {
	return Object.keys(queryOf(state)).length > 0;
}
/** The state with the filters cleared and the sort and grouping kept. */
function clearedFilters(state) {
	return {
		...defaultFilters(),
		sort: state.sort,
		reverse: state.reverse,
		groupByVendor: state.groupByVendor
	};
}
/** Toggles a shelf in the selection (key '' = no shelf). */
function toggleCategory(state, key) {
	const has = state.categories.includes(key);
	return {
		...state,
		categories: has ? state.categories.filter((item) => item !== key) : [...state.categories, key]
	};
}
function subscriptionBadge(model, t) {
	if (!model.subscription.included) return null;
	const multiplier = model.subscription.inputTokenMultiplier;
	if (multiplier === 1) return {
		label: t("catalog.sub.included"),
		title: t("catalog.sub.includedHint")
	};
	return {
		label: t("catalog.sub.includedMultiplier", { multiplier: trimZeros(String(multiplier)) }),
		title: t("catalog.sub.multiplierHint", { multiplier: trimZeros(String(multiplier)) })
	};
}
function rowOf(model, t) {
	return {
		id: model.id,
		name: model.name,
		price: formatPricePair(model.pricing.prompt, model.pricing.completion),
		context: formatContext(model.contextLength),
		capabilities: CAPABILITIES.filter((cap) => cap.has(model)).map((cap) => cap.key),
		openWeights: model.openWeights,
		subscription: subscriptionBadge(model, t)
	};
}
function categoryChips(models, state, t) {
	return listCategories(models).map(({ category, count }) => {
		const key = category ?? "";
		return {
			key,
			label: categoryLabel(category, t),
			count,
			active: state.categories.includes(key)
		};
	});
}
/** The filtered, sorted (and optionally grouped) list, cut to the first `limit` models. */
function buildList(models, state, limit, t) {
	const matched = sortCatalog(filterCatalog(models, queryOf(state)), state.sort, state.reverse);
	const cut = Math.max(0, Math.min(limit, matched.length));
	const drawn = matched.slice(0, cut);
	let sections;
	if (state.groupByVendor) {
		const sizes = new Map(groupByVendor(matched).map((group) => [group.vendor, group.models.length]));
		sections = groupByVendor(drawn).map((group) => ({
			vendor: group.vendor,
			vendorLabel: vendorLabel(group.vendor, t),
			count: sizes.get(group.vendor) ?? group.models.length,
			rows: group.models.map((model) => rowOf(model, t))
		}));
	} else sections = drawn.length ? [{
		vendor: null,
		vendorLabel: null,
		count: matched.length,
		rows: drawn.map((model) => rowOf(model, t))
	}] : [];
	return {
		total: models.length,
		matched: matched.length,
		shown: cut,
		remaining: matched.length - cut,
		sections,
		chips: categoryChips(models, state, t)
	};
}
var KNOWN_ERRORS = [
	"unreachable",
	"timeout",
	"invalid_response",
	"not_found"
];
function errorText(code, t) {
	if (KNOWN_ERRORS.includes(code)) return t(`catalog.error.${code}`);
	const http = /^http_(\d+)$/.exec(code);
	if (http) return t("catalog.error.http", { status: http[1] ?? "" });
	return t("catalog.error.other", { code });
}
function statusView(status, count, now, t) {
	if (!status.loaded) {
		if (status.error) return {
			kind: "error",
			text: t("catalog.status.failed"),
			notice: errorText(status.error, t)
		};
		return {
			kind: "muted",
			text: t("catalog.status.loading"),
			notice: null
		};
	}
	const via = status.via ? t(`catalog.via.${status.via}`) : null;
	const age = status.fetchedAt !== null ? t("catalog.status.updated", { age: formatAge(status.fetchedAt, now, t) }) : null;
	const text = [
		t("catalog.status.count", { count }),
		via,
		age
	].filter((part) => part !== null).join(" · ");
	if (status.source === "stale") return {
		kind: "warn",
		text,
		notice: status.error ? t("catalog.status.staleError", { error: errorText(status.error, t) }) : t("catalog.status.stale")
	};
	return {
		kind: "ok",
		text,
		notice: null
	};
}
function detailOf(model, t) {
	return {
		id: model.id,
		name: model.name,
		description: model.description,
		category: categoryLabel(model.category, t),
		context: formatContext(model.contextLength),
		maxOutput: model.maxOutputTokens === null ? null : formatContext(model.maxOutputTokens),
		prices: {
			prompt: formatPrice(model.pricing.prompt),
			completion: formatPrice(model.pricing.completion),
			cacheRead: model.pricing.cacheRead === null ? null : formatPrice(model.pricing.cacheRead)
		},
		capabilities: CAPABILITIES.map((cap) => ({
			key: cap.key,
			on: cap.has(model)
		})),
		openWeights: model.openWeights,
		efforts: model.reasoningEfforts,
		alwaysReasons: model.reasoningEfforts.length > 0 && !model.reasoningEfforts.includes("none"),
		subscription: subscriptionBadge(model, t),
		hostCount: model.providerIds.length
	};
}
var DEFAULT_COST_INPUTS = {
	promptTokens: 2e4,
	completionTokens: 1500,
	cachedPercent: 80
};
/** Reads the three fields of the estimate; an empty or wrong field keeps its default, the share is clamped to 0..100. */
function parseCostInputs(prompt, completion, cached) {
	const clampPercent = (value) => Math.min(100, Math.max(0, value));
	const cachedValue = parseNumber(cached);
	return {
		promptTokens: parseNumber(prompt) ?? DEFAULT_COST_INPUTS.promptTokens,
		completionTokens: parseNumber(completion) ?? DEFAULT_COST_INPUTS.completionTokens,
		cachedPercent: cachedValue === null ? DEFAULT_COST_INPUTS.cachedPercent : clampPercent(cachedValue)
	};
}
function costView(model, inputs, t) {
	const usage = {
		promptTokens: inputs.promptTokens,
		completionTokens: inputs.completionTokens,
		cachedShare: inputs.cachedPercent / 100
	};
	const turn = estimateTurnCost(model, usage);
	const noCachePrice = model.pricing.cacheRead === null;
	const plain = estimateTurnCost(model, {
		...usage,
		cachedShare: 0
	});
	const sub = model.subscription;
	return {
		turn: formatUsd(turn),
		withoutCache: !noCachePrice && inputs.cachedPercent > 0 ? formatUsd(plain) : null,
		hundredTurns: formatUsd(turn * 100),
		noCachePrice,
		subscriptionNote: sub.included ? sub.inputTokenMultiplier === 1 ? t("catalog.cost.subscription") : t("catalog.cost.subscriptionMultiplier", { multiplier: trimZeros(String(sub.inputTokenMultiplier)) }) : null
	};
}
var HOST_PRIORITIES = [
	"balanced",
	"price",
	"speed",
	"uptime"
];
var PRIORITY_WEIGHTS = {
	balanced: {
		weightPrice: 1,
		weightSpeed: 1,
		weightUptime: 1
	},
	price: {
		weightPrice: 3,
		weightSpeed: 1,
		weightUptime: 1
	},
	speed: {
		weightPrice: 1,
		weightSpeed: 3,
		weightUptime: 1
	},
	uptime: {
		weightPrice: 1,
		weightSpeed: 1,
		weightUptime: 3
	}
};
function defaultHostCriteria() {
	return {
		priority: "balanced",
		preferQuantization: "",
		maxPrompt: null,
		maxCompletion: null
	};
}
function criteriaOf(state) {
	return {
		...PRIORITY_WEIGHTS[state.priority],
		...state.preferQuantization ? { preferQuantization: state.preferQuantization } : {},
		...state.maxPrompt !== null || state.maxCompletion !== null ? { maxPrice: {
			prompt: state.maxPrompt,
			completion: state.maxCompletion
		} } : {}
	};
}
function quantizationText(host) {
	if (host.quantization === null) return "?";
	if (host.rawQuantization && host.rawQuantization.toLowerCase() !== host.quantization) return `${host.quantization} (${host.rawQuantization})`;
	return host.quantization;
}
/** The hosts of a model, ranked for the criteria. */
function hostRows(providers, state) {
	const scores = scoreHosts(providers.providers, criteriaOf(state));
	const byId = new Map(providers.providers.map((host) => [host.id, host]));
	const rows = [];
	for (const score of scores) {
		const host = byId.get(score.providerId);
		if (!host) continue;
		rows.push({
			rank: score.rank,
			id: host.id,
			quantization: quantizationText(host),
			price: host.pricing ? formatPricePair(host.pricing.prompt, host.pricing.completion) : "—",
			tps: formatCount(host.tps, ""),
			ttft: host.ttftMs === null ? "—" : String(Math.round(host.ttftMs)),
			uptime: formatCount(host.uptime, "%"),
			features: host.features,
			score: String(Math.round(score.total * 100)),
			overMaxPrice: score.overMaxPrice,
			belowQuantization: score.meetsQuantization === false,
			unknownQuantization: state.preferQuantization !== "" && score.meetsQuantization === null,
			missing: score.missing
		});
	}
	return rows;
}
function hostsSummary(providers) {
	return {
		selection: providers.supportsProviderSelection,
		autoTps: providers.autoTps === null ? null : formatCount(providers.autoTps, ""),
		autoTtft: providers.autoTtftMs === null ? null : String(Math.round(providers.autoTtftMs)),
		autoCache: providers.autoCacheReadRate === null ? null : formatPercent(providers.autoCacheReadRate)
	};
}
/**
* The i18n key of a hint. A rule with two readings (hosts known or not, found by the id or the shelf) has one text per
* reading, chosen from its params.
*/
function hintKey(hint) {
	const base = `catalog.hint.${hint.code}`;
	const { params } = hint;
	if (hint.code === "quant.glmFp8") {
		if (params["hostsKnown"] === false) return `${base}.unknown`;
		if (params["okHosts"] === 0) return `${base}.noneOk`;
	}
	if (hint.code === "shelf.uncensoredUnmeasured" && params["byShelf"] === false) return `${base}.byId`;
	return base;
}
/** Hint params as translate params: booleans become words nobody prints, the rest keep their value. */
function hintParams(params) {
	const out = {};
	for (const [key, value] of Object.entries(params)) out[key] = typeof value === "boolean" ? String(value) : value;
	return out;
}
/** A routing patch in words. Only the fields a hint suggests are named; anything else is listed as `name: value`. */
function suggestionText(patch, t) {
	const parts = [];
	for (const [key, value] of Object.entries(patch)) {
		if (key === "enabled") continue;
		switch (key) {
			case "minQuantization":
				parts.push(t("catalog.suggest.minQuantization", { value: String(value) }));
				break;
			case "ignore":
				parts.push(t("catalog.suggest.ignore", { hosts: value.join(", ") }));
				break;
			case "only":
				parts.push(t("catalog.suggest.only", { hosts: value.join(", ") }));
				break;
			case "order":
				parts.push(t("catalog.suggest.order", { hosts: value.join(", ") }));
				break;
			case "quantizations":
				parts.push(t("catalog.suggest.quantizations", { value: value.join(", ") }));
				break;
			default: parts.push(`${key}: ${JSON.stringify(value)}`);
		}
	}
	return parts.length > 0 ? parts.join("; ") : t("catalog.suggest.enable");
}
function hintViews(hints, t) {
	return hints.map((hint) => ({
		code: hint.code,
		severity: hint.severity,
		text: t(hintKey(hint), hintParams(hint.params)),
		suggestion: hint.suggestedRouting !== void 0,
		suggestionText: hint.suggestedRouting ? suggestionText(hint.suggestedRouting, t) : null,
		bypass: hint.code === "billing.bypass"
	}));
}
/** Several routing patches as one: lists (order, only, ignore, quantizations) are united, anything else the last one wins. */
function mergeRoutingPatches(patches) {
	const merged = {};
	for (const patch of patches) for (const [key, value] of Object.entries(patch)) {
		const before = merged[key];
		if (Array.isArray(value) && Array.isArray(before)) merged[key] = [.../* @__PURE__ */ new Set([...before, ...value])];
		else merged[key] = Array.isArray(value) ? [...value] : value;
	}
	return merged;
}
/**
* What "Create a connection with this model" saves: the model, a name taken from it, the defaults of
* `createConnection` for everything else, and the routing of the hints the user ticked (none = untouched routing).
*/
function newConnectionPatch(model, hints, applied) {
	const routing = mergeRoutingPatches(hints.flatMap((hint) => applied.has(hint.code) && hint.suggestedRouting ? [hint.suggestedRouting] : []));
	const patch = {
		name: model.name.trim().slice(0, 80) || model.id,
		modelId: model.id
	};
	if (Object.keys(routing).length > 0) patch.routing = {
		...defaultRouting(),
		...routing,
		enabled: true
	};
	return patch;
}
// src/features/catalog/session.ts
function createSession() {
	return {
		filters: defaultFilters(),
		shown: 50,
		selected: null,
		cost: { ...DEFAULT_COST_INPUTS },
		hosts: defaultHostCriteria()
	};
}
// src/features/catalog/strings.ts
var CATALOG_STRINGS = {
	en: {
		"catalog.tab": "Catalog",
		"catalog.status.loading": "Loading the catalog…",
		"catalog.status.failed": "The catalog could not be loaded.",
		"catalog.status.count": "{count} models",
		"catalog.status.updated": "updated {age}",
		"catalog.status.stale": "Showing stored data: NanoGPT was not reachable for the last refresh.",
		"catalog.status.staleError": "Showing stored data: the last refresh failed ({error}).",
		"catalog.via.plugin": "via the plugin",
		"catalog.via.direct": "straight from NanoGPT",
		"catalog.via.storage": "from the copy stored in this browser",
		"catalog.age.now": "just now",
		"catalog.age.minutes": "{n} min ago",
		"catalog.age.hours": "{n} h ago",
		"catalog.age.days": "{n} d ago",
		"catalog.error.unreachable": "no answer from the network",
		"catalog.error.timeout": "the answer took too long",
		"catalog.error.invalid_response": "the answer was not a model list",
		"catalog.error.not_found": "not found",
		"catalog.error.http": "HTTP {status}",
		"catalog.error.other": "error {code}",
		"catalog.refresh": "Refresh",
		"catalog.retry": "Try again",
		"catalog.filter.search": "Search models",
		"catalog.filter.searchPlaceholder": "Name, id or description",
		"catalog.filter.categories": "Shelves",
		"catalog.filter.subscriptionOnly": "Included in the subscription",
		"catalog.filter.openWeights": "Open weights only",
		"catalog.filter.minContext": "Context at least",
		"catalog.filter.minContext.any": "Any",
		"catalog.filter.maxPrice": "Max prompt price, USD per 1M",
		"catalog.filter.maxPricePlaceholder": "No limit",
		"catalog.filter.sort": "Sort by",
		"catalog.filter.reverse": "Reverse order",
		"catalog.filter.group": "Group by vendor",
		"catalog.filter.reset": "Reset filters",
		"catalog.sort.name": "Name",
		"catalog.sort.price": "Price",
		"catalog.sort.context": "Context",
		"catalog.sort.newest": "Newest",
		"catalog.sort.subscription": "Subscription first",
		"catalog.list.count": "Showing {shown} of {matched} models ({total} in the catalog)",
		"catalog.list.empty": "No model matches the filters.",
		"catalog.list.showMore": "Show {count} more",
		"catalog.list.priceTitle": "USD per 1M tokens: prompt / completion",
		"catalog.list.priceUnit": "USD per 1M",
		"catalog.list.contextTitle": "Context window",
		"catalog.category.uncensored": "Uncensored",
		"catalog.category.roleplay": "Roleplay and storytelling",
		"catalog.category.tee": "Private / TEE",
		"catalog.category.more": "More",
		"catalog.category.none": "No shelf",
		"catalog.vendor.other": "other",
		"catalog.sub.included": "In subscription",
		"catalog.sub.includedHint": "Covered by the NanoGPT subscription.",
		"catalog.sub.includedMultiplier": "In subscription ×{multiplier}",
		"catalog.sub.multiplierHint": "Covered by the subscription, but input tokens count ×{multiplier} against the quota.",
		"catalog.cap.vision": "Images in",
		"catalog.cap.reasoning": "Reasoning",
		"catalog.cap.tools": "Tool calling",
		"catalog.cap.structured": "Structured output",
		"catalog.cap.openWeights": "Open weights",
		"catalog.detail.back": "Back to the list",
		"catalog.detail.category": "Shelf",
		"catalog.detail.context": "Context window",
		"catalog.detail.maxOutput": "Max reply length",
		"catalog.detail.noDescription": "No description.",
		"catalog.detail.prices": "Prices, USD per 1M tokens",
		"catalog.detail.price.prompt": "Prompt",
		"catalog.detail.price.completion": "Completion",
		"catalog.detail.price.cacheRead": "Cached prompt",
		"catalog.detail.capabilities": "Capabilities",
		"catalog.detail.efforts": "Reasoning efforts",
		"catalog.detail.efforts.alwaysOn": "This model always reasons: it cannot be switched off, only lowered to the smallest effort.",
		"catalog.detail.efforts.optional": "Reasoning can be switched off.",
		"catalog.detail.efforts.none": "No choice of effort.",
		"catalog.cost.title": "Cost of a turn",
		"catalog.cost.hint": "Pay-as-you-go price of one chat turn with the numbers below.",
		"catalog.cost.prompt": "Prompt tokens",
		"catalog.cost.completion": "Reply tokens",
		"catalog.cost.cached": "Prompt read from cache, %",
		"catalog.cost.turn": "One turn",
		"catalog.cost.withoutCache": "without cache",
		"catalog.cost.hundred": "100 turns",
		"catalog.cost.noCachePrice": "This model has no cache price: the cached share changes nothing.",
		"catalog.cost.subscription": "In the subscription this costs nothing extra; the figures are what pay-as-you-go would charge.",
		"catalog.cost.subscriptionMultiplier": "In the subscription this costs nothing extra (input tokens count ×{multiplier} against the quota); the figures are what pay-as-you-go would charge.",
		"catalog.hosts.title": "Hosts",
		"catalog.hosts.loading": "Loading the hosts…",
		"catalog.hosts.unavailable": "The host list could not be loaded.",
		"catalog.hosts.none": "NanoGPT lists no separate hosts for this model.",
		"catalog.hosts.fixedRoute": "This model runs on a fixed route: choosing hosts does nothing, so the routing settings of a connection have no effect on it.",
		"catalog.hosts.auto": "Automatic routing: {tps} tokens/s, first token after {ttft} ms, {cache} of the prompt from cache.",
		"catalog.hosts.priority": "Rank by",
		"catalog.hosts.priority.balanced": "Balanced",
		"catalog.hosts.priority.price": "Cheapest first",
		"catalog.hosts.priority.speed": "Fastest first",
		"catalog.hosts.priority.uptime": "Most reliable first",
		"catalog.hosts.prefer": "Prefer precision",
		"catalog.hosts.prefer.none": "No preference",
		"catalog.hosts.maxPrompt": "Hosts: max prompt price, USD per 1M",
		"catalog.hosts.maxCompletion": "Hosts: max completion price, USD per 1M",
		"catalog.hosts.col.rank": "#",
		"catalog.hosts.col.host": "Host",
		"catalog.hosts.col.quantization": "Precision",
		"catalog.hosts.col.price": "Price in / out",
		"catalog.hosts.col.tps": "tok/s",
		"catalog.hosts.col.ttft": "TTFT, ms",
		"catalog.hosts.col.uptime": "Uptime",
		"catalog.hosts.col.features": "Features",
		"catalog.hosts.col.score": "Score",
		"catalog.hosts.flag.overPrice": "over the price limit",
		"catalog.hosts.flag.belowQuantization": "below the preferred precision",
		"catalog.hosts.flag.unknownQuantization": "precision not reported",
		"catalog.hosts.note": "The score blends price, speed and uptime (100 is the best of this list on all three). Hosts over the price limit or below the preferred precision go last.",
		"catalog.hints.title": "Notes on routing",
		"catalog.hints.none": "Nothing special to know about this model.",
		"catalog.hints.apply": "Use this routing in the new connection",
		"catalog.hint.quant.glmFp8": "Some hosts of {model} serve it below fp8 ({lowHosts}: {low}). GLM’s own hosts run fp8, so a lower precision is a re-quantised copy and may write worse. A precision floor of fp8 keeps the original quality ({okHosts} hosts reach it).",
		"catalog.hint.quant.glmFp8.unknown": "{model} is a GLM model. GLM’s own hosts run fp8, while some other hosts serve lower precisions. The host list shows which; a precision floor of fp8 keeps the original quality.",
		"catalog.hint.quant.glmFp8.noneOk": "Some hosts of {model} serve it below fp8 ({lowHosts}: {low}), and none is known to reach fp8, so a floor would leave nothing to route to. The quality of the hosts is unverified.",
		"catalog.hint.quant.deepseekNative": "The experts of {model} are natively MXFP4, so a host labelled mxfp4 serves the original. {suspiciousHosts} host(s) serve a 4-bit copy under another label ({suspicious}); it may be re-quantised, and you can ignore those hosts.",
		"catalog.hint.hosts.few": "Few hosts serve this model ({hosts}): if one goes down there is little to fall back on.",
		"catalog.hint.routing.fixedRoute": "NanoGPT runs {model} on a fixed route: provider selection does nothing for it (order, only, ignore and precision settings are not applied).",
		"catalog.hint.cache.lowRate": "Under automatic routing only {percent}% of the prompt is read from cache (below {threshold}%). Caching saves the most when a connection stays on one host; consider the caching route or a fixed host.",
		"catalog.hint.reasoning.alwaysOn": "This model always reasons (efforts: {efforts}) and cannot be switched off; the lowest effort is {lowest}. Expect thinking tokens on every reply: a connection can only lower the effort.",
		"catalog.hint.shelf.uncensoredUnmeasured": "{model} is on NanoGPT’s Uncensored shelf. How uncensored it really is, is not measured: try it before relying on it.",
		"catalog.hint.shelf.uncensoredUnmeasured.byId": "The name of {model} says uncensored, abliterated or heretic, but NanoGPT does not put it on the Uncensored shelf. Such labels are not measured: try the model before relying on it.",
		"catalog.hint.billing.bypass": "Choosing hosts explicitly (any routing suggestion above) takes a subscription model off the subscription: NanoGPT bills an explicit provider choice pay-as-you-go with about {markupPercent}% markup.",
		"catalog.suggest.minQuantization": "precision floor {value}",
		"catalog.suggest.ignore": "ignore hosts {hosts}",
		"catalog.suggest.only": "only hosts {hosts}",
		"catalog.suggest.order": "try hosts in order {hosts}",
		"catalog.suggest.quantizations": "only precisions {value}",
		"catalog.suggest.enable": "turn provider routing on",
		"catalog.action.create": "Create a connection with this model",
		"catalog.action.createHint": "A new connection with this model, default settings and the ticked routing.",
		"catalog.action.useIn": "Use in connection…",
		"catalog.action.useIn.select": "Connection",
		"catalog.action.useIn.apply": "Use this model",
		"catalog.action.useIn.none": "No connections yet: create one first.",
		"catalog.notice.created": "Connection \"{name}\" created.",
		"catalog.notice.updated": "Connection \"{name}\" now uses {model}."
	},
	ru: {
		"catalog.tab": "Каталог",
		"catalog.status.loading": "Загружаю каталог…",
		"catalog.status.failed": "Каталог не удалось загрузить.",
		"catalog.status.count": "моделей: {count}",
		"catalog.status.updated": "обновлён {age}",
		"catalog.status.stale": "Показаны сохранённые данные: при последнем обновлении NanoGPT не ответил.",
		"catalog.status.staleError": "Показаны сохранённые данные: последнее обновление не удалось ({error}).",
		"catalog.via.plugin": "через плагин",
		"catalog.via.direct": "напрямую с NanoGPT",
		"catalog.via.storage": "из копии в этом браузере",
		"catalog.age.now": "только что",
		"catalog.age.minutes": "{n} мин назад",
		"catalog.age.hours": "{n} ч назад",
		"catalog.age.days": "{n} дн назад",
		"catalog.error.unreachable": "сеть не ответила",
		"catalog.error.timeout": "ответ шёл слишком долго",
		"catalog.error.invalid_response": "ответ не похож на список моделей",
		"catalog.error.not_found": "не найдено",
		"catalog.error.http": "HTTP {status}",
		"catalog.error.other": "ошибка {code}",
		"catalog.refresh": "Обновить",
		"catalog.retry": "Повторить",
		"catalog.filter.search": "Поиск по моделям",
		"catalog.filter.searchPlaceholder": "Название, id или описание",
		"catalog.filter.categories": "Полки",
		"catalog.filter.subscriptionOnly": "Входят в подписку",
		"catalog.filter.openWeights": "Только открытые веса",
		"catalog.filter.minContext": "Контекст не меньше",
		"catalog.filter.minContext.any": "Любой",
		"catalog.filter.maxPrice": "Макс. цена промпта, USD за 1M",
		"catalog.filter.maxPricePlaceholder": "Без ограничения",
		"catalog.filter.sort": "Сортировать",
		"catalog.filter.reverse": "В обратном порядке",
		"catalog.filter.group": "Группировать по разработчику",
		"catalog.filter.reset": "Сбросить фильтры",
		"catalog.sort.name": "По названию",
		"catalog.sort.price": "По цене",
		"catalog.sort.context": "По контексту",
		"catalog.sort.newest": "Сначала новые",
		"catalog.sort.subscription": "Сначала из подписки",
		"catalog.list.count": "Показано {shown} из {matched} моделей (в каталоге {total})",
		"catalog.list.empty": "Ни одна модель не подходит под фильтры.",
		"catalog.list.showMore": "Показать ещё {count}",
		"catalog.list.priceTitle": "USD за 1M токенов: промпт / ответ",
		"catalog.list.priceUnit": "USD за 1M",
		"catalog.list.contextTitle": "Окно контекста",
		"catalog.category.uncensored": "Без цензуры",
		"catalog.category.roleplay": "Ролевые игры и истории",
		"catalog.category.tee": "Приватные / TEE",
		"catalog.category.more": "Остальные",
		"catalog.category.none": "Без полки",
		"catalog.vendor.other": "прочие",
		"catalog.sub.included": "В подписке",
		"catalog.sub.includedHint": "Покрывается подпиской NanoGPT.",
		"catalog.sub.includedMultiplier": "В подписке ×{multiplier}",
		"catalog.sub.multiplierHint": "Покрывается подпиской, но входные токены считаются в квоту с коэффициентом ×{multiplier}.",
		"catalog.cap.vision": "Принимает картинки",
		"catalog.cap.reasoning": "Рассуждения",
		"catalog.cap.tools": "Вызов инструментов",
		"catalog.cap.structured": "Структурированный вывод",
		"catalog.cap.openWeights": "Открытые веса",
		"catalog.detail.back": "К списку",
		"catalog.detail.category": "Полка",
		"catalog.detail.context": "Окно контекста",
		"catalog.detail.maxOutput": "Макс. длина ответа",
		"catalog.detail.noDescription": "Описания нет.",
		"catalog.detail.prices": "Цены, USD за 1M токенов",
		"catalog.detail.price.prompt": "Промпт",
		"catalog.detail.price.completion": "Ответ",
		"catalog.detail.price.cacheRead": "Промпт из кэша",
		"catalog.detail.capabilities": "Возможности",
		"catalog.detail.efforts": "Уровни рассуждений",
		"catalog.detail.efforts.alwaysOn": "Эта модель рассуждает всегда: отключить нельзя, можно только снизить до наименьшего уровня.",
		"catalog.detail.efforts.optional": "Рассуждения можно отключить.",
		"catalog.detail.efforts.none": "Выбора уровня нет.",
		"catalog.cost.title": "Цена хода",
		"catalog.cost.hint": "Цена одного хода чата при оплате по факту, с числами ниже.",
		"catalog.cost.prompt": "Токенов в промпте",
		"catalog.cost.completion": "Токенов в ответе",
		"catalog.cost.cached": "Промпт из кэша, %",
		"catalog.cost.turn": "Один ход",
		"catalog.cost.withoutCache": "без кэша",
		"catalog.cost.hundred": "100 ходов",
		"catalog.cost.noCachePrice": "У этой модели нет цены кэша: доля кэша ничего не меняет.",
		"catalog.cost.subscription": "По подписке это ничего не стоит сверх неё; цифры показывают, сколько взяли бы при оплате по факту.",
		"catalog.cost.subscriptionMultiplier": "По подписке это ничего не стоит сверх неё (входные токены идут в квоту ×{multiplier}); цифры показывают, сколько взяли бы при оплате по факту.",
		"catalog.hosts.title": "Хосты",
		"catalog.hosts.loading": "Загружаю хосты…",
		"catalog.hosts.unavailable": "Список хостов не удалось загрузить.",
		"catalog.hosts.none": "NanoGPT не показывает отдельных хостов у этой модели.",
		"catalog.hosts.fixedRoute": "Эта модель идёт по фиксированному маршруту: выбор хостов ничего не меняет, поэтому настройки маршрутизации подключения на неё не действуют.",
		"catalog.hosts.auto": "Автоматическая маршрутизация: {tps} токенов/с, первый токен через {ttft} мс, {cache} промпта из кэша.",
		"catalog.hosts.priority": "Ранжировать по",
		"catalog.hosts.priority.balanced": "Сбалансированно",
		"catalog.hosts.priority.price": "Сначала дешёвые",
		"catalog.hosts.priority.speed": "Сначала быстрые",
		"catalog.hosts.priority.uptime": "Сначала надёжные",
		"catalog.hosts.prefer": "Предпочитать точность",
		"catalog.hosts.prefer.none": "Без предпочтения",
		"catalog.hosts.maxPrompt": "Хосты: макс. цена промпта, USD за 1M",
		"catalog.hosts.maxCompletion": "Хосты: макс. цена ответа, USD за 1M",
		"catalog.hosts.col.rank": "№",
		"catalog.hosts.col.host": "Хост",
		"catalog.hosts.col.quantization": "Точность",
		"catalog.hosts.col.price": "Цена вх. / исх.",
		"catalog.hosts.col.tps": "ток/с",
		"catalog.hosts.col.ttft": "TTFT, мс",
		"catalog.hosts.col.uptime": "Аптайм",
		"catalog.hosts.col.features": "Возможности",
		"catalog.hosts.col.score": "Балл",
		"catalog.hosts.flag.overPrice": "дороже лимита цены",
		"catalog.hosts.flag.belowQuantization": "ниже предпочитаемой точности",
		"catalog.hosts.flag.unknownQuantization": "точность не указана",
		"catalog.hosts.note": "Балл сводит цену, скорость и аптайм (100 — лучший в этом списке по всем трём). Хосты дороже лимита или ниже предпочитаемой точности идут в конце.",
		"catalog.hints.title": "Заметки о маршрутизации",
		"catalog.hints.none": "Об этой модели нечего особо знать.",
		"catalog.hints.apply": "Применить этот маршрут в новом подключении",
		"catalog.hint.quant.glmFp8": "Часть хостов {model} отдаёт её ниже fp8 ({lowHosts}: {low}). Собственные хосты GLM работают в fp8, так что меньшая точность — пережатая копия, она может писать хуже. Нижняя граница fp8 сохраняет исходное качество (её достигают хостов: {okHosts}).",
		"catalog.hint.quant.glmFp8.unknown": "{model} — модель GLM. Собственные хосты GLM работают в fp8, а некоторые другие отдают меньшую точность. Какие именно, видно в списке хостов; нижняя граница fp8 сохраняет исходное качество.",
		"catalog.hint.quant.glmFp8.noneOk": "Часть хостов {model} отдаёт её ниже fp8 ({lowHosts}: {low}), и ни про один не известно, что он достигает fp8, поэтому граница оставила бы маршрутизацию без вариантов. Качество хостов не проверено.",
		"catalog.hint.quant.deepseekNative": "Эксперты {model} родом в MXFP4, поэтому хост с меткой mxfp4 отдаёт оригинал. Хостов с 4-битной копией под другой меткой: {suspiciousHosts} ({suspicious}); она может быть пережатой, такие хосты можно игнорировать.",
		"catalog.hint.hosts.few": "Эту модель отдаёт мало хостов ({hosts}): если один упадёт, запасных почти нет.",
		"catalog.hint.routing.fixedRoute": "NanoGPT ведёт {model} по фиксированному маршруту: выбор провайдера на неё не действует (порядок, only, ignore и точность не применяются).",
		"catalog.hint.cache.lowRate": "При автоматической маршрутизации из кэша читается только {percent}% промпта (меньше {threshold}%). Кэш выгоднее всего, когда подключение остаётся на одном хосте; подумайте о маршруте с кэшем или о фиксированном хосте.",
		"catalog.hint.reasoning.alwaysOn": "Эта модель рассуждает всегда (уровни: {efforts}), отключить нельзя; наименьший уровень — {lowest}. Ждите токены размышлений в каждом ответе: подключение может только снизить уровень.",
		"catalog.hint.shelf.uncensoredUnmeasured": "{model} стоит на полке NanoGPT «Без цензуры». Насколько она на деле без цензуры, не измерено: проверьте сами, прежде чем полагаться.",
		"catalog.hint.shelf.uncensoredUnmeasured.byId": "В названии {model} есть uncensored, abliterated или heretic, но NanoGPT не ставит её на полку «Без цензуры». Такие метки не измерены: проверьте модель сами, прежде чем полагаться.",
		"catalog.hint.billing.bypass": "Явный выбор хостов (любая подсказка выше) выводит модель из подписки: NanoGPT берёт за явный выбор провайдера плату по факту с наценкой около {markupPercent}%.",
		"catalog.suggest.minQuantization": "нижняя граница точности {value}",
		"catalog.suggest.ignore": "игнорировать хосты {hosts}",
		"catalog.suggest.only": "только хосты {hosts}",
		"catalog.suggest.order": "пробовать хосты по порядку {hosts}",
		"catalog.suggest.quantizations": "только точности {value}",
		"catalog.suggest.enable": "включить выбор провайдера",
		"catalog.action.create": "Создать подключение с этой моделью",
		"catalog.action.createHint": "Новое подключение с этой моделью, настройками по умолчанию и отмеченным маршрутом.",
		"catalog.action.useIn": "Использовать в подключении…",
		"catalog.action.useIn.select": "Подключение",
		"catalog.action.useIn.apply": "Взять эту модель",
		"catalog.action.useIn.none": "Подключений пока нет: сначала создайте одно.",
		"catalog.notice.created": "Подключение «{name}» создано.",
		"catalog.notice.updated": "Подключение «{name}» теперь использует {model}."
	}
};
// src/ui/dom.ts
function classNames(value) {
	if (!value) return "";
	if (typeof value === "string") return value;
	return value.filter((item) => typeof item === "string" && item.length > 0).join(" ");
}
function append(parent, children) {
	if (children === void 0) return;
	const list = Array.isArray(children) ? children : [children];
	for (const child of list) {
		if (child === null || child === void 0 || child === false) continue;
		parent.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
	}
}
function el(tag, props = {}, children) {
	const element = document.createElement(tag);
	const className = classNames(props.class);
	if (className) element.className = className;
	if (props.text !== void 0) element.textContent = props.text;
	if (props.title !== void 0) element.setAttribute("title", props.title);
	if (props.data) for (const [key, value] of Object.entries(props.data)) element.dataset[key] = String(value);
	if (props.attrs) for (const [key, value] of Object.entries(props.attrs)) {
		if (value === false || value === null || value === void 0) continue;
		element.setAttribute(key, value === true ? "" : String(value));
	}
	if (props.on) {
		for (const [name, handler] of Object.entries(props.on)) if (handler) element.addEventListener(name, handler);
	}
	append(element, children);
	return element;
}
function clear(node) {
	while (node.firstChild) node.removeChild(node.firstChild);
}
/** Font Awesome icon (ST ships FA 6). */
function icon(name, extra) {
	return el("i", {
		class: [
			"fa-solid",
			name.startsWith("fa-") ? name : `fa-${name}`,
			"fa-fw",
			extra
		],
		attrs: { "aria-hidden": "true" }
	});
}
var reportButtonError = (error) => console.error("[Nanovia:ui]", error);
/** Where failures of async button handlers go (the app routes them to its logger). */
function setButtonErrorHandler(handler) {
	reportButtonError = handler;
}
/** A ST-styled button. Async handlers disable the button while they run (no double taps on a phone). */
function button(options) {
	const node = el("button", {
		class: [
			"menu_button",
			"nanovia-btn",
			options.kind && options.kind !== "default" ? `nanovia-btn-${options.kind}` : null,
			options.className
		],
		title: options.title,
		attrs: {
			type: "button",
			disabled: options.disabled === true,
			"aria-label": options.label ? void 0 : options.title
		}
	}, [options.icon ? icon(options.icon) : null, options.label ? el("span", { text: options.label }) : null]);
	if (options.onClick) {
		const handler = options.onClick;
		node.addEventListener("click", (event) => {
			if (node.disabled) return;
			let result;
			try {
				result = handler(event);
			} catch (error) {
				reportButtonError(error);
				return;
			}
			if (result instanceof Promise) {
				node.disabled = true;
				node.classList.add("nanovia-busy");
				result.catch((error) => reportButtonError(error)).finally(() => {
					node.disabled = options.disabled === true;
					node.classList.remove("nanovia-busy");
				});
			}
		});
	}
	return node;
}
// src/ui/controls.ts
var nextId = 0;
/** Unique id for label/for pairs. */
function uid(prefix = "nanovia") {
	nextId += 1;
	return `${prefix}-${nextId}`;
}
function toggle(options) {
	const id = uid("nanovia-toggle");
	const input = el("input", { attrs: {
		type: "checkbox",
		id,
		disabled: options.disabled === true
	} });
	input.checked = options.checked;
	input.addEventListener("change", () => {
		options.onChange(input.checked);
	});
	return el("label", {
		class: "checkbox_label nanovia-toggle",
		attrs: { for: id },
		title: options.hint
	}, [input, el("span", { text: options.label })]);
}
function select(options) {
	const node = el("select", {
		class: "text_pole nanovia-select",
		attrs: {
			"aria-label": options.label,
			disabled: options.disabled === true
		}
	});
	for (const option of options.options) node.appendChild(el("option", {
		text: option.label,
		attrs: { value: option.value }
	}));
	node.value = options.options.some((option) => option.value === options.value) ? options.value : options.options[0]?.value ?? "";
	node.addEventListener("change", () => {
		const chosen = options.options.find((option) => option.value === node.value);
		if (chosen) options.onChange(chosen.value);
	});
	return node;
}
function textInput(options) {
	const secret = options.type === "password";
	const node = el("input", {
		class: "text_pole nanovia-text",
		attrs: {
			type: options.type ?? "text",
			placeholder: options.placeholder,
			"aria-label": options.label,
			maxlength: options.maxLength,
			disabled: options.disabled === true,
			autocomplete: secret ? "off" : void 0,
			autocapitalize: "off",
			spellcheck: "false"
		}
	});
	node.value = options.value;
	if (options.onInput) {
		const handler = options.onInput;
		node.addEventListener("input", () => handler(node.value));
	}
	if (options.onChange) {
		const handler = options.onChange;
		node.addEventListener("change", () => void handler(node.value));
	}
	return node;
}
function textArea(options) {
	const node = el("textarea", {
		class: "text_pole nanovia-textarea",
		attrs: {
			rows: options.rows ?? 3,
			placeholder: options.placeholder,
			"aria-label": options.label,
			maxlength: options.maxLength
		}
	});
	node.value = options.value;
	if (options.onInput) {
		const handler = options.onInput;
		node.addEventListener("input", () => handler(node.value));
	}
	return node;
}
/** A small coloured label: a status, a mode, a billing outcome. */
function chip(label, kind = "muted", title) {
	return el("span", {
		class: ["nanovia-chip", `nanovia-chip-${kind}`],
		text: label,
		title
	});
}
/** A labelled row: label on the left (top on phones), control on the right, optional hint below. */
function field(label, control, hint) {
	return el("div", { class: "nanovia-field" }, [
		el("div", {
			class: "nanovia-field-label",
			text: label
		}),
		el("div", { class: "nanovia-field-control" }, [control]),
		hint ? el("div", {
			class: "nanovia-field-hint",
			text: hint
		}) : null
	]);
}
// src/ui/panel.ts
var PANEL_ROOT_ID = "nanovia-settings";
var SettingsPanel = class {
	deps;
	tabs = /* @__PURE__ */ new Map();
	/** The tab the user wants open: the last one chosen (or remembered); it may be registered later than the others. */
	preferred;
	activeId = "";
	disposeBody = null;
	root = null;
	title = null;
	bar = null;
	body = null;
	constructor(deps) {
		this.deps = deps;
		this.preferred = deps.getLastTab();
	}
	/** Puts the drawer into the Extensions panel. false when the panel is not in the page (yet). */
	mount() {
		if (this.root) return true;
		if (typeof document === "undefined") return false;
		const container = document.querySelector("#extensions_settings2") ?? document.querySelector("#extensions_settings");
		if (!container) {
			this.deps.log.debug("extensions panel not found; the Nanovia drawer is not mounted");
			return false;
		}
		document.getElementById(PANEL_ROOT_ID)?.remove();
		this.title = el("b", { text: this.deps.i18n.t("ui.title") });
		this.bar = el("div", {
			class: "nanovia-tabs",
			attrs: { role: "tablist" }
		});
		this.body = el("div", {
			class: "nanovia-tab-body",
			attrs: { role: "tabpanel" }
		});
		this.root = el("div", {
			class: "extension_container nanovia-ui",
			attrs: { id: PANEL_ROOT_ID }
		}, [el("div", { class: "inline-drawer" }, [el("div", { class: "inline-drawer-toggle inline-drawer-header" }, [this.title, el("div", { class: "inline-drawer-icon fa-solid fa-circle-chevron-down down" })]), el("div", { class: "inline-drawer-content nanovia-panel" }, [this.bar, this.body])])]);
		container.appendChild(this.root);
		this.activeId = this.pick();
		this.renderBar();
		this.renderBody();
		return true;
	}
	registerTab(tab) {
		if (this.tabs.has(tab.id)) this.deps.log.warn(`tab "${tab.id}" replaced`);
		this.tabs.set(tab.id, tab);
		this.refresh();
		return () => {
			if (this.tabs.get(tab.id) !== tab) return;
			this.tabs.delete(tab.id);
			this.refresh();
		};
	}
	/** Opens a tab by id (no-op for an unknown id). */
	select(id) {
		if (!this.tabs.has(id)) return;
		this.preferred = id;
		this.deps.setLastTab(id);
		this.refresh();
	}
	activeTab() {
		return this.activeId;
	}
	tabIds() {
		return this.ordered().map((tab) => tab.id);
	}
	/** The language changed: titles and the open tab are built again. */
	relabel() {
		if (this.title) this.title.textContent = this.deps.i18n.t("ui.title");
		this.renderBar();
		this.renderBody();
	}
	dispose() {
		this.releaseBody();
		this.tabs.clear();
		this.root?.remove();
		this.root = null;
		this.title = null;
		this.bar = null;
		this.body = null;
		this.activeId = "";
	}
	ordered() {
		return [...this.tabs.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
	}
	pick() {
		return this.tabs.has(this.preferred) ? this.preferred : this.ordered()[0]?.id ?? "";
	}
	/** Rebuilds the tab bar; the body only when the open tab changed (so a new tab does not wipe a form being filled). */
	refresh() {
		const next = this.pick();
		const changed = next !== this.activeId;
		this.activeId = next;
		this.renderBar();
		if (changed) this.renderBody();
	}
	renderBar() {
		if (!this.bar) return;
		clear(this.bar);
		for (const tab of this.ordered()) {
			const active = tab.id === this.activeId;
			this.bar.appendChild(el("button", {
				class: [
					"menu_button",
					"nanovia-tab",
					active && "nanovia-tab-active"
				],
				text: this.deps.i18n.t(tab.titleKey),
				data: { tab: tab.id },
				attrs: {
					type: "button",
					role: "tab",
					"aria-selected": String(active)
				},
				on: { click: () => this.select(tab.id) }
			}));
		}
	}
	renderBody() {
		this.releaseBody();
		if (!this.body) return;
		clear(this.body);
		const tab = this.tabs.get(this.activeId);
		if (!tab) return;
		try {
			const dispose = tab.render(this.body, this.deps.ctx());
			this.disposeBody = typeof dispose === "function" ? dispose : null;
		} catch (error) {
			this.deps.log.error(`tab ${tab.id} failed to render`, error);
			this.body.appendChild(el("div", {
				class: "nanovia-error-text",
				text: this.deps.i18n.t("ui.tab.failed")
			}));
		}
	}
	releaseBody() {
		const dispose = this.disposeBody;
		this.disposeBody = null;
		try {
			dispose?.();
		} catch (error) {
			this.deps.log.error("tab cleanup failed", error);
		}
	}
};
// src/ui/general-settings.ts
var GENERAL_TAB_ID = "general";
function generalTab(deps) {
	const { settings, i18n, version } = deps;
	return {
		id: GENERAL_TAB_ID,
		titleKey: "ui.tab.general",
		order: 1e3,
		render(root) {
			const t = i18n.t.bind(i18n);
			const options = UI_LANGUAGES.map((value) => ({
				value,
				label: t(`ui.general.language.${value}`)
			}));
			root.append(el("div", {
				class: "nanovia-muted",
				text: t("ui.general.about")
			}), el("div", {
				class: "nanovia-muted",
				text: t("ui.general.version", { version })
			}), el("div", { class: "nanovia-group" }, [field(t("ui.general.language"), select({
				value: settings.get().uiLanguage,
				options,
				label: t("ui.general.language"),
				onChange: (value) => settings.set("uiLanguage", value)
			})), toggle({
				label: t("ui.general.debug"),
				hint: t("ui.general.debugHint"),
				checked: settings.get().debug,
				onChange: (checked) => settings.set("debug", checked)
			})]));
		}
	};
}
// src/ui/strings.ts
var UI_STRINGS = {
	en: {
		"ui.title": "Nanovia",
		"ui.tab.failed": "This tab could not be shown. Details are in the browser console.",
		"ui.tab.general": "General",
		"ui.general.about": "NanoGPT as a first-class provider: connections, billing awareness and routing.",
		"ui.general.version": "Version {version}",
		"ui.general.language": "Interface language",
		"ui.general.language.auto": "Follow SillyTavern",
		"ui.general.language.ru": "Russian",
		"ui.general.language.en": "English",
		"ui.general.debug": "Debug logging",
		"ui.general.debugHint": "Prints Nanovia details to the browser console. Keys and tokens are never printed.",
		"ui.picker.loading": "Loading the model catalog… You can type the id by hand.",
		"ui.picker.unavailable": "The model catalog is not available. Type the model id by hand.",
		"ui.picker.noMatch": "No catalog model matches. The text is used as the model id.",
		"ui.picker.more": "{count} more: keep typing to narrow the list.",
		"ui.picker.sub": "sub",
		"ui.picker.subTitle": "Included in the subscription",
		"ui.picker.priceTitle": "USD per 1M tokens: prompt / completion"
	},
	ru: {
		"ui.title": "Nanovia",
		"ui.tab.failed": "Эту вкладку не удалось показать. Подробности в консоли браузера.",
		"ui.tab.general": "Общие",
		"ui.general.about": "NanoGPT как полноценный провайдер: подключения, учёт тарифа и маршрутизация.",
		"ui.general.version": "Версия {version}",
		"ui.general.language": "Язык интерфейса",
		"ui.general.language.auto": "Как в SillyTavern",
		"ui.general.language.ru": "Русский",
		"ui.general.language.en": "English",
		"ui.general.debug": "Подробный журнал",
		"ui.general.debugHint": "Пишет подробности работы Nanovia в консоль браузера. Ключи и токены не выводятся никогда.",
		"ui.picker.loading": "Загружаю каталог моделей… Id можно ввести и вручную.",
		"ui.picker.unavailable": "Каталог моделей недоступен. Введите id модели вручную.",
		"ui.picker.noMatch": "В каталоге нет такой модели. Введённый текст будет использован как id модели.",
		"ui.picker.more": "Ещё {count}: продолжайте вводить, чтобы сузить список.",
		"ui.picker.sub": "подп.",
		"ui.picker.subTitle": "Входит в подписку",
		"ui.picker.priceTitle": "USD за 1M токенов: промпт / ответ"
	}
};
// src/features/connections/view-model.ts
var CONNECTION_MODES = [
	"auto",
	"plugin",
	"direct"
];
var BILLING_MODES = [
	"auto",
	"subscription",
	"paygo"
];
var REASONING_POLICIES = [
	"follow",
	"fixed",
	"off",
	"default"
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
function emptyForm() {
	return {
		id: null,
		name: "",
		modelId: "",
		mode: "auto",
		keyId: "",
		billing: "auto",
		reasoningPolicy: "follow",
		reasoningEffort: "",
		hideThoughts: false,
		webSearch: false,
		note: "",
		directKey: ""
	};
}
function formFromConfig(config) {
	return {
		id: config.id,
		name: config.name,
		modelId: config.modelId,
		mode: config.mode,
		keyId: config.keyId ?? "",
		billing: config.billing,
		reasoningPolicy: config.reasoning.policy,
		reasoningEffort: config.reasoning.effort ?? "",
		hideThoughts: config.reasoning.hideThoughts,
		webSearch: config.webSearch,
		note: config.note,
		directKey: ""
	};
}
/** The part of a ConnectionConfig the form controls. Everything else (routing, memory …) is left to be. */
function patchFromForm(form) {
	const patch = {
		name: form.name.trim(),
		modelId: form.modelId.trim(),
		mode: form.mode,
		billing: form.billing,
		webSearch: form.webSearch,
		note: form.note,
		reasoning: {
			policy: form.reasoningPolicy,
			effort: form.reasoningPolicy === "fixed" ? effortOf(form) : null,
			hideThoughts: form.hideThoughts
		}
	};
	if (form.mode !== "direct") patch.keyId = form.keyId || null;
	return patch;
}
function effortOf(form) {
	return form.reasoningEffort === "" ? "medium" : form.reasoningEffort;
}
/** Whether the form must ask for the NanoGPT key (shown as a field and required). */
function needsDirectKey(form, ctx) {
	if (ctx.hasDirectKey) return false;
	if (form.mode === "direct") return true;
	return form.mode === "auto" && !ctx.pluginUp && form.id === null;
}
/** Whether the key field is shown at all (also to replace a key on file). */
function showsDirectKey(form, ctx) {
	return form.mode === "direct" || needsDirectKey(form, ctx);
}
function validateForm(form, ctx) {
	const issues = [];
	if (!form.name.trim()) issues.push({
		field: "name",
		code: "required"
	});
	if (!form.modelId.trim()) issues.push({
		field: "modelId",
		code: "required"
	});
	if (needsDirectKey(form, ctx) && !form.directKey.trim()) issues.push({
		field: "directKey",
		code: "required"
	});
	return issues;
}
/** The chips of one connection card, in display order. */
function chipsFor(entry, pluginUp, t) {
	const chips = [];
	const { config } = entry;
	if (config.mode === "auto") {
		const key = entry.effectiveMode === "plugin" ? "connections.chip.mode.autoPlugin" : "connections.chip.mode.autoDirect";
		chips.push({
			label: t(key),
			kind: "info"
		});
	} else chips.push({
		label: t(`connections.chip.mode.${config.mode}`),
		kind: "info"
	});
	chips.push({
		label: t(`connections.chip.billing.${config.billing}`),
		kind: config.billing === "subscription" ? "ok" : "muted"
	});
	if (entry.effectiveMode === "direct" && !entry.hasDirectKey) chips.push({
		label: t("connections.chip.noKey"),
		kind: "error",
		title: t("connections.chip.noKey.hint")
	});
	chips.push({
		label: t(`connections.chip.profile.${entry.profileState}`),
		kind: {
			linked: "ok",
			drifted: "warn",
			missing: "warn",
			none: "muted",
			blocked: "warn",
			unavailable: "error"
		}[entry.profileState],
		title: entry.profileState === "blocked" ? t("connections.chip.profile.blocked.hint") : void 0
	});
	if (entry.pending) chips.push({
		label: t("connections.chip.pending"),
		kind: "warn",
		title: t("connections.chip.pending.hint")
	});
	if (entry.orphan && pluginUp) chips.push({
		label: t("connections.chip.orphan"),
		kind: "warn",
		title: t("connections.chip.orphan.hint")
	});
	return chips;
}
/** The buttons a connection card offers right now. */
function actionsFor(entry, pluginUp, t) {
	const actions = [{
		id: "edit",
		label: t("connections.action.edit"),
		kind: "default"
	}];
	if (pluginUp && entry.view && entry.config.mode !== "direct") actions.push({
		id: "rotate",
		label: t("connections.action.rotate"),
		title: t("connections.action.rotate.hint"),
		kind: "default"
	});
	if (!pluginUp && entry.config.mode !== "direct") actions.push({
		id: "switchDirect",
		label: t("connections.action.switchDirect"),
		title: t("connections.action.switchDirect.hint"),
		kind: "default"
	});
	if (entry.orphan && pluginUp) actions.push({
		id: "sendToPlugin",
		label: t("connections.action.sendToPlugin"),
		kind: "default"
	});
	if (entry.profileState === "none" || entry.profileState === "missing") actions.push({
		id: "repairProfile",
		label: t("connections.action.repairProfile"),
		kind: "default"
	});
	else if (entry.profileState === "drifted") actions.push({
		id: "repairProfile",
		label: t("connections.action.repairProfile.fix"),
		kind: "default"
	});
	actions.push({
		id: "delete",
		label: t("connections.action.delete"),
		kind: "danger"
	});
	return actions;
}
/** What the plugin status chip says. `checked` is false until the plugin has been asked once. */
function bannerFor(status, error, pluginUp, t, checked = true) {
	if (!checked && !pluginUp) return {
		state: "checking",
		up: false,
		title: t("connections.status.checking"),
		detail: "",
		advice: null
	};
	if (pluginUp && status) return {
		state: "up",
		up: true,
		title: t("connections.status.up"),
		detail: t("connections.status.upDetail", {
			port: status.proxy.port,
			version: status.version
		}),
		advice: status.proxy.up ? null : t("connections.status.proxyDown", { port: status.proxy.port })
	};
	const known = [
		"not_installed",
		"unreachable",
		"timeout",
		"forbidden"
	];
	const code = error?.code ?? "unreachable";
	const reason = known.includes(code) ? t(`connections.status.reason.${code}`) : t("connections.status.reason.other", { code });
	return {
		state: "down",
		up: false,
		title: t("connections.status.down"),
		detail: reason,
		advice: t("connections.status.installHint")
	};
}
/** Text of an operation's error or warning. */
function issueText(issue, t) {
	const params = {};
	for (const [key, value] of Object.entries(issue.params ?? {})) params[key] = value;
	if (issue.code === "invalid" && typeof params["field"] === "string") params["field"] = t(`connections.field.${params["field"]}`);
	return t(`connections.issue.${issue.code}`, params);
}
/** Label of a select option of a key the plugin knows. */
function keyLabel(key, t) {
	const base = key.label ? `${key.label} · ${key.masked}` : key.masked;
	return key.active ? `${base} (${t("connections.form.keyActive")})` : base;
}
// src/features/catalog/detail.ts
function kv(label, value) {
	if (value === null) return null;
	return el("div", { class: "nanovia-kv" }, [el("span", {
		class: "nanovia-kv-key nanovia-muted",
		text: label
	}), typeof value === "string" ? el("span", {
		class: "nanovia-kv-value",
		text: value
	}) : value]);
}
function renderDetail(host, deps) {
	const { ctx, session, modelId } = deps;
	const t = ctx.t;
	const model = ctx.catalog.model(modelId);
	let disposed = false;
	/** Hints whose suggested routing goes into the new connection. */
	const applied = /* @__PURE__ */ new Set();
	let hostsState = ctx.catalog.providers(modelId) ? "ready" : "loading";
	let lastProviders = ctx.catalog.providers(modelId);
	let chosenConnection = "";
	if (!model) {
		host.appendChild(el("div", {
			class: "nanovia-muted",
			text: t("catalog.list.empty")
		}));
		return {
			refresh: () => {},
			dispose: () => {}
		};
	}
	const current = model;
	const view = detailOf(current, t);
	const costResult = el("div", {
		class: "nanovia-cost-result",
		attrs: { "aria-live": "polite" }
	});
	const hostsHost = el("div", { class: "nanovia-detail-block nanovia-hosts-block" });
	const hintsHost = el("div", { class: "nanovia-detail-block nanovia-hints-block" });
	const noticeHost = el("div", {
		class: "nanovia-notice-host",
		attrs: { "aria-live": "polite" }
	});
	const actionsHost = el("div", { class: "nanovia-detail-block nanovia-actions-block" });
	const chips = [chip(view.category, "muted")];
	if (view.subscription) chips.push(chip(view.subscription.label, "ok", view.subscription.title));
	if (view.openWeights) chips.push(chip(t("catalog.cap.openWeights"), "info"));
	const capabilities = el("div", { class: "nanovia-row nanovia-caps-row" }, view.capabilities.map((cap) => {
		const spec = CAPABILITIES.find((item) => item.key === cap.key);
		return el("span", {
			class: ["nanovia-cap-line", cap.on ? "nanovia-cap-on" : "nanovia-cap-off"],
			data: {
				cap: cap.key,
				on: cap.on ? "yes" : "no"
			}
		}, [icon(spec?.icon ?? "circle"), el("span", { text: t(`catalog.cap.${cap.key}`) })]);
	}));
	const efforts = view.efforts.length > 0 ? [el("div", { class: "nanovia-row" }, [el("span", {
		class: "nanovia-muted",
		text: t("catalog.detail.efforts")
	}), ...view.efforts.map((effort) => chip(effort, "info"))]), el("div", {
		class: "nanovia-muted",
		text: t(view.alwaysReasons ? "catalog.detail.efforts.alwaysOn" : "catalog.detail.efforts.optional")
	})] : [el("div", {
		class: "nanovia-muted",
		text: t("catalog.detail.efforts.none")
	})];
	function drawCost() {
		clear(costResult);
		const cost = costView(current, session.cost, t);
		append(costResult, [
			kv(t("catalog.cost.turn"), cost.withoutCache ? `${cost.turn} (${t("catalog.cost.withoutCache")} ${cost.withoutCache})` : cost.turn),
			kv(t("catalog.cost.hundred"), cost.hundredTurns),
			cost.noCachePrice ? el("div", {
				class: "nanovia-muted",
				text: t("catalog.cost.noCachePrice")
			}) : null,
			cost.subscriptionNote ? el("div", {
				class: "nanovia-muted",
				text: cost.subscriptionNote
			}) : null
		]);
	}
	const promptInput = textInput({
		value: String(session.cost.promptTokens),
		label: t("catalog.cost.prompt"),
		onInput: () => updateCost()
	});
	const completionInput = textInput({
		value: String(session.cost.completionTokens),
		label: t("catalog.cost.completion"),
		onInput: () => updateCost()
	});
	const cachedInput = textInput({
		value: String(session.cost.cachedPercent),
		label: t("catalog.cost.cached"),
		onInput: () => updateCost()
	});
	function updateCost() {
		session.cost = parseCostInputs(promptInput.value, completionInput.value, cachedInput.value);
		drawCost();
	}
	const costBlock = el("div", { class: "nanovia-detail-block" }, [
		el("h5", { text: t("catalog.cost.title") }),
		el("div", {
			class: "nanovia-muted",
			text: t("catalog.cost.hint")
		}),
		el("div", { class: "nanovia-cost-inputs" }, [
			labelled(t("catalog.cost.prompt"), promptInput),
			labelled(t("catalog.cost.completion"), completionInput),
			labelled(t("catalog.cost.cached"), cachedInput)
		]),
		costResult
	]);
	function criteriaControls(table) {
		const priorities = HOST_PRIORITIES.map((value) => ({
			value,
			label: t(`catalog.hosts.priority.${value}`)
		}));
		const precisions = [{
			value: "",
			label: t("catalog.hosts.prefer.none")
		}, ...QUANTIZATION_ORDER.map((value) => ({
			value,
			label: value
		}))];
		const maxPrompt = textInput({
			value: session.hosts.maxPrompt === null ? "" : String(session.hosts.maxPrompt),
			label: t("catalog.hosts.maxPrompt"),
			placeholder: t("catalog.filter.maxPricePlaceholder"),
			onInput: (value) => {
				session.hosts.maxPrompt = parseNumber(value);
				drawTable(table);
			}
		});
		const maxCompletion = textInput({
			value: session.hosts.maxCompletion === null ? "" : String(session.hosts.maxCompletion),
			label: t("catalog.hosts.maxCompletion"),
			placeholder: t("catalog.filter.maxPricePlaceholder"),
			onInput: (value) => {
				session.hosts.maxCompletion = parseNumber(value);
				drawTable(table);
			}
		});
		return el("div", { class: "nanovia-criteria" }, [
			labelled(t("catalog.hosts.priority"), select({
				value: session.hosts.priority,
				options: priorities,
				label: t("catalog.hosts.priority"),
				onChange: (value) => {
					session.hosts.priority = value;
					drawTable(table);
				}
			})),
			labelled(t("catalog.hosts.prefer"), select({
				value: session.hosts.preferQuantization,
				options: precisions,
				label: t("catalog.hosts.prefer"),
				onChange: (value) => {
					const known = QUANTIZATION_ORDER.find((item) => item === value);
					session.hosts.preferQuantization = known ?? "";
					drawTable(table);
				}
			})),
			labelled(t("catalog.hosts.maxPrompt"), maxPrompt),
			labelled(t("catalog.hosts.maxCompletion"), maxCompletion)
		]);
	}
	function hostCell(row) {
		const flags = [];
		if (row.overMaxPrice) flags.push(chip(t("catalog.hosts.flag.overPrice"), "warn"));
		if (row.belowQuantization) flags.push(chip(t("catalog.hosts.flag.belowQuantization"), "warn"));
		if (row.unknownQuantization) flags.push(chip(t("catalog.hosts.flag.unknownQuantization"), "muted"));
		return el("td", {}, [el("div", { class: "nanovia-host-name" }, [el("b", { text: row.id }), ...flags])]);
	}
	function drawTable(table) {
		clear(table);
		const providers = ctx.catalog.providers(modelId);
		if (!providers || providers.providers.length === 0) return;
		const rows = hostRows(providers, session.hosts);
		table.appendChild(el("table", { class: "nanovia-hosts" }, [el("thead", {}, [el("tr", {}, [
			"rank",
			"host",
			"quantization",
			"price",
			"tps",
			"ttft",
			"uptime",
			"features",
			"score"
		].map((name) => el("th", { text: t(`catalog.hosts.col.${name}`) })))]), el("tbody", {}, rows.map((row) => el("tr", { data: {
			host: row.id,
			rank: row.rank
		} }, [
			el("td", { text: String(row.rank) }),
			hostCell(row),
			el("td", { text: row.quantization }),
			el("td", {
				class: "nanovia-nowrap",
				text: row.price
			}),
			el("td", { text: row.tps }),
			el("td", { text: row.ttft }),
			el("td", { text: row.uptime }),
			el("td", {
				class: "nanovia-host-features nanovia-muted",
				text: row.features.join(", ")
			}),
			el("td", { text: row.score })
		])))]));
	}
	function drawHosts() {
		clear(hostsHost);
		hostsHost.appendChild(el("h5", { text: t("catalog.hosts.title") }));
		const providers = ctx.catalog.providers(modelId);
		if (!providers) {
			if (hostsState === "failed") hostsHost.append(el("div", {
				class: "nanovia-error-text",
				text: t("catalog.hosts.unavailable")
			}), button({
				label: t("catalog.retry"),
				icon: "rotate",
				onClick: () => loadHosts(true)
			}));
			else hostsHost.appendChild(el("div", {
				class: "nanovia-muted",
				text: t("catalog.hosts.loading")
			}));
			return;
		}
		const summary = hostsSummary(providers);
		if (!summary.selection) hostsHost.appendChild(el("div", {
			class: "nanovia-muted",
			text: t("catalog.hosts.fixedRoute")
		}));
		if (summary.autoTps !== null || summary.autoTtft !== null || summary.autoCache !== null) hostsHost.appendChild(el("div", {
			class: "nanovia-muted",
			text: t("catalog.hosts.auto", {
				tps: summary.autoTps ?? "—",
				ttft: summary.autoTtft ?? "—",
				cache: summary.autoCache ?? "—"
			})
		}));
		if (providers.providers.length === 0) {
			if (summary.selection) hostsHost.appendChild(el("div", {
				class: "nanovia-muted",
				text: t("catalog.hosts.none")
			}));
			return;
		}
		const table = el("div", { class: "nanovia-hosts-scroll" });
		hostsHost.append(criteriaControls(table), table, el("div", {
			class: "nanovia-muted",
			text: t("catalog.hosts.note")
		}));
		drawTable(table);
	}
	async function loadHosts(force = false) {
		hostsState = "loading";
		drawHosts();
		const result = await ctx.catalog.ensureProviders(modelId, { force });
		if (disposed) return;
		hostsState = result ? "ready" : "failed";
		lastProviders = ctx.catalog.providers(modelId);
		drawHosts();
		drawHints();
	}
	function drawHints() {
		clear(hintsHost);
		hintsHost.appendChild(el("h5", { text: t("catalog.hints.title") }));
		const views = hintViews(ctx.catalog.hints(modelId), t);
		if (views.length === 0) {
			hintsHost.appendChild(el("div", {
				class: "nanovia-muted",
				text: t("catalog.hints.none")
			}));
			return;
		}
		for (const hint of views) hintsHost.appendChild(el("div", {
			class: [
				"nanovia-hint",
				`nanovia-hint-${hint.severity}`,
				hint.bypass && "nanovia-hint-bypass"
			],
			data: { hint: hint.code }
		}, [el("div", { class: "nanovia-hint-text" }, [icon(hint.severity === "warn" ? "triangle-exclamation" : "circle-info"), el("span", { text: hint.text })]), hint.suggestion ? toggle({
			label: `${t("catalog.hints.apply")}: ${hint.suggestionText ?? ""}`,
			checked: applied.has(hint.code),
			onChange: (checked) => {
				if (checked) applied.add(hint.code);
				else applied.delete(hint.code);
			}
		}) : null]));
	}
	function notify(kind, text) {
		clear(noticeHost);
		noticeHost.appendChild(el("div", {
			class: ["nanovia-notice", `nanovia-notice-${kind}`],
			text
		}));
	}
	function report(result, success) {
		if (!result.ok) {
			notify("error", issueText(result.error, t));
			return;
		}
		const warnings = result.warnings;
		if (warnings.length === 0) notify("ok", success);
		else notify("warn", [success, ...warnings.map((warning) => issueText(warning, t))].join(" "));
	}
	function drawActions() {
		clear(actionsHost);
		const entries = ctx.connections.list();
		actionsHost.appendChild(el("div", { class: "nanovia-row" }, [button({
			label: t("catalog.action.create"),
			title: t("catalog.action.createHint"),
			icon: "plus",
			kind: "primary",
			onClick: async () => {
				const patch = newConnectionPatch(current, ctx.catalog.hints(modelId), applied);
				report(await ctx.connections.save({ patch }), t("catalog.notice.created", { name: patch.name }));
			}
		})]));
		if (entries.length === 0) {
			actionsHost.appendChild(el("div", {
				class: "nanovia-muted",
				text: t("catalog.action.useIn.none")
			}));
			return;
		}
		if (!entries.some((entry) => entry.config.id === chosenConnection)) chosenConnection = entries[0]?.config.id ?? "";
		const options = entries.map((entry) => ({
			value: entry.config.id,
			label: `${entry.config.name} · ${entry.config.modelId}`
		}));
		actionsHost.appendChild(el("div", { class: "nanovia-row" }, [
			el("span", {
				class: "nanovia-muted",
				text: t("catalog.action.useIn")
			}),
			select({
				value: chosenConnection,
				options,
				label: t("catalog.action.useIn.select"),
				onChange: (value) => void (chosenConnection = value)
			}),
			button({
				label: t("catalog.action.useIn.apply"),
				onClick: async () => {
					const entry = ctx.connections.get(chosenConnection);
					if (!entry) return;
					report(await ctx.connections.save({
						id: entry.config.id,
						patch: { modelId }
					}), t("catalog.notice.updated", {
						name: entry.config.name,
						model: view.name
					}));
				}
			})
		]));
	}
	host.append(el("div", { class: "nanovia-row" }, [button({
		label: t("catalog.detail.back"),
		icon: "arrow-left",
		kind: "ghost",
		onClick: () => deps.back()
	})]), el("div", { class: "nanovia-detail-head" }, [
		el("h4", {
			class: "nanovia-detail-name",
			text: view.name
		}),
		el("div", {
			class: "nanovia-muted nanovia-detail-id",
			text: view.id
		}),
		el("div", { class: "nanovia-row nanovia-chips" }, chips)
	]), el("div", {
		class: "nanovia-detail-description",
		text: view.description || t("catalog.detail.noDescription")
	}), el("div", { class: "nanovia-detail-block" }, [
		el("h5", { text: t("catalog.detail.prices") }),
		kv(t("catalog.detail.price.prompt"), view.prices.prompt),
		kv(t("catalog.detail.price.completion"), view.prices.completion),
		kv(t("catalog.detail.price.cacheRead"), view.prices.cacheRead),
		kv(t("catalog.detail.context"), view.context),
		kv(t("catalog.detail.maxOutput"), view.maxOutput)
	]), el("div", { class: "nanovia-detail-block" }, [
		el("h5", { text: t("catalog.detail.capabilities") }),
		capabilities,
		...efforts
	]), costBlock, hostsHost, hintsHost, noticeHost, actionsHost);
	drawCost();
	drawHosts();
	drawHints();
	drawActions();
	if (hostsState === "loading") loadHosts();
	return {
		refresh() {
			if (disposed) return;
			const providers = ctx.catalog.providers(modelId);
			if (providers !== lastProviders) {
				lastProviders = providers;
				if (providers) hostsState = "ready";
				drawHosts();
				drawHints();
			}
			drawActions();
		},
		dispose() {
			disposed = true;
		}
	};
}
/** A label above a control (the cost and criteria forms are narrow and stack on phones). */
function labelled(label, control) {
	return el("label", { class: "nanovia-labelled" }, [el("span", {
		class: "nanovia-muted",
		text: label
	}), control]);
}
// src/features/catalog/view.ts
function renderCatalogTab(root, ctx, session) {
	const t = ctx.t;
	let disposed = false;
	let detail = null;
	const statusHost = el("div", { class: "nanovia-catalog-status" });
	const filtersHost = el("div", { class: "nanovia-filters" });
	const countHost = el("div", {
		class: "nanovia-muted nanovia-list-count",
		attrs: { "aria-live": "polite" }
	});
	const listHost = el("div", { class: "nanovia-model-list" });
	const moreHost = el("div", { class: "nanovia-row" });
	const listPane = el("div", { class: "nanovia-catalog-list-pane" }, [
		filtersHost,
		countHost,
		listHost,
		moreHost
	]);
	const detailPane = el("div", {
		class: "nanovia-catalog-detail-pane",
		attrs: { hidden: true }
	});
	root.append(statusHost, listPane, detailPane);
	let chipsHost = el("div");
	let resetButton = button({});
	function drawStatus() {
		clear(statusHost);
		const view = statusView(ctx.catalog.status(), ctx.catalog.models().length, Date.now(), t);
		const modifier = {
			ok: "up",
			error: "down",
			muted: "checking",
			warn: "warn"
		}[view.kind];
		const box = el("div", { class: ["nanovia-banner", `nanovia-banner-${modifier}`] }, [el("div", { class: "nanovia-row" }, [el("span", {
			class: "nanovia-status-text",
			text: view.text
		}), button({
			label: t("catalog.refresh"),
			icon: "rotate",
			kind: "ghost",
			onClick: () => ctx.catalog.refresh(true)
		})]), view.notice ? el("div", {
			class: view.kind === "error" ? "nanovia-error-text" : "nanovia-muted",
			text: view.notice
		}) : null]);
		statusHost.appendChild(box);
	}
	function change(next) {
		session.filters = next;
		session.shown = 50;
		drawChips();
		drawList();
		resetButton.hidden = !hasActiveFilters(session.filters);
	}
	function drawChips() {
		clear(chipsHost);
		for (const entry of categoryChips(ctx.catalog.models(), session.filters, t)) chipsHost.appendChild(el("button", {
			class: [
				"nanovia-chip",
				"nanovia-chip-toggle",
				entry.active && "nanovia-chip-active"
			],
			text: `${entry.label} (${entry.count})`,
			data: { category: entry.key },
			attrs: {
				type: "button",
				"aria-pressed": String(entry.active)
			},
			on: { click: () => change(toggleCategory(session.filters, entry.key)) }
		}));
	}
	function buildFilters() {
		clear(filtersHost);
		const f = session.filters;
		const flag = (label, checked, apply) => toggle({
			label,
			checked,
			onChange: (on) => change(apply(session.filters, on))
		});
		chipsHost = el("div", {
			class: "nanovia-row nanovia-category-chips",
			attrs: {
				role: "group",
				"aria-label": t("catalog.filter.categories")
			}
		});
		resetButton = button({
			label: t("catalog.filter.reset"),
			icon: "filter-circle-xmark",
			kind: "ghost",
			onClick: () => {
				session.filters = clearedFilters(session.filters);
				session.shown = 50;
				buildFilters();
				drawList();
			}
		});
		resetButton.hidden = !hasActiveFilters(f);
		const contextOptions = CONTEXT_CHOICES.map((value) => ({
			value: String(value),
			label: value === 0 ? t("catalog.filter.minContext.any") : formatContext(value)
		}));
		const sortOptions = SORTS.map((value) => ({
			value,
			label: t(`catalog.sort.${value}`)
		}));
		filtersHost.append(textInput({
			value: f.text,
			label: t("catalog.filter.search"),
			placeholder: t("catalog.filter.searchPlaceholder"),
			onInput: (value) => change({
				...session.filters,
				text: value
			})
		}), chipsHost, el("div", { class: "nanovia-row nanovia-toggles" }, [
			flag(t("catalog.filter.subscriptionOnly"), f.subscriptionOnly, (s, on) => ({
				...s,
				subscriptionOnly: on
			})),
			...CAPABILITIES.map((cap) => flag(t(`catalog.cap.${cap.key}`), f[cap.key], (s, on) => ({
				...s,
				[cap.key]: on
			}))),
			flag(t("catalog.filter.openWeights"), f.openWeightsOnly, (s, on) => ({
				...s,
				openWeightsOnly: on
			}))
		]), field(t("catalog.filter.minContext"), select({
			value: String(f.minContext),
			options: contextOptions,
			label: t("catalog.filter.minContext"),
			onChange: (value) => change({
				...session.filters,
				minContext: Number(value)
			})
		})), field(t("catalog.filter.maxPrice"), textInput({
			value: f.maxPromptPrice === null ? "" : String(f.maxPromptPrice),
			label: t("catalog.filter.maxPrice"),
			placeholder: t("catalog.filter.maxPricePlaceholder"),
			onInput: (value) => change({
				...session.filters,
				maxPromptPrice: parseNumber(value)
			})
		})), field(t("catalog.filter.sort"), select({
			value: f.sort,
			options: sortOptions,
			label: t("catalog.filter.sort"),
			onChange: (value) => change({
				...session.filters,
				sort: value
			})
		})), el("div", { class: "nanovia-row nanovia-toggles" }, [
			flag(t("catalog.filter.reverse"), f.reverse, (s, on) => ({
				...s,
				reverse: on
			})),
			flag(t("catalog.filter.group"), f.groupByVendor, (s, on) => ({
				...s,
				groupByVendor: on
			})),
			resetButton
		]));
		drawChips();
	}
	function renderRow(row) {
		const caps = el("span", { class: "nanovia-caps" }, [...CAPABILITIES.filter((cap) => row.capabilities.includes(cap.key)).map((cap) => el("span", {
			class: "nanovia-cap",
			data: { cap: cap.key },
			title: t(`catalog.cap.${cap.key}`),
			attrs: {
				role: "img",
				"aria-label": t(`catalog.cap.${cap.key}`)
			}
		}, [icon(cap.icon)])), row.openWeights ? el("span", {
			class: "nanovia-cap",
			data: { cap: "openWeights" },
			title: t("catalog.cap.openWeights"),
			attrs: {
				role: "img",
				"aria-label": t("catalog.cap.openWeights")
			}
		}, [icon("lock-open")]) : null]);
		return el("button", {
			class: "nanovia-model-row",
			data: { model: row.id },
			attrs: { type: "button" },
			on: { click: () => openDetail(row.id) }
		}, [
			el("span", { class: "nanovia-model-head" }, [el("b", {
				class: "nanovia-model-name",
				text: row.name
			}), row.subscription ? chip(row.subscription.label, "ok", row.subscription.title) : null]),
			el("span", {
				class: "nanovia-muted nanovia-model-id",
				text: row.id
			}),
			el("span", { class: "nanovia-model-meta" }, [
				el("span", {
					class: "nanovia-model-price",
					text: row.price,
					title: t("catalog.list.priceTitle")
				}),
				el("span", {
					class: "nanovia-muted nanovia-model-unit",
					text: t("catalog.list.priceUnit")
				}),
				el("span", {
					class: "nanovia-model-context",
					text: row.context,
					title: t("catalog.list.contextTitle")
				}),
				caps
			])
		]);
	}
	function drawList() {
		clear(listHost);
		clear(moreHost);
		countHost.textContent = "";
		const status = ctx.catalog.status();
		if (!status.loaded) {
			if (status.error) listHost.append(el("div", {
				class: "nanovia-error-text nanovia-empty",
				text: t("catalog.status.failed")
			}), button({
				label: t("catalog.retry"),
				icon: "rotate",
				onClick: () => ctx.catalog.refresh(true)
			}));
			else listHost.appendChild(el("div", {
				class: "nanovia-muted nanovia-empty",
				text: t("catalog.status.loading")
			}));
			return;
		}
		const list = buildList(ctx.catalog.models(), session.filters, session.shown, t);
		if (list.matched === 0) {
			listHost.appendChild(el("div", {
				class: "nanovia-muted nanovia-empty",
				text: t("catalog.list.empty")
			}));
			return;
		}
		countHost.textContent = t("catalog.list.count", {
			shown: list.shown,
			matched: list.matched,
			total: list.total
		});
		for (const section of list.sections) {
			const group = el("div", { class: "nanovia-model-group" });
			if (section.vendorLabel !== null) group.appendChild(el("div", {
				class: "nanovia-vendor-head",
				text: `${section.vendorLabel} (${section.count})`,
				data: { vendor: section.vendor ?? "" }
			}));
			for (const row of section.rows) group.appendChild(renderRow(row));
			listHost.appendChild(group);
		}
		if (list.remaining > 0) moreHost.appendChild(button({
			label: t("catalog.list.showMore", { count: Math.min(50, list.remaining) }),
			onClick: () => {
				session.shown += 50;
				drawList();
			}
		}));
	}
	function showDetail(id) {
		detail?.dispose();
		clear(detailPane);
		listPane.hidden = true;
		detailPane.hidden = false;
		detail = renderDetail(detailPane, {
			ctx,
			session,
			modelId: id,
			back: closeDetail
		});
		detailPane.scrollIntoView?.({ block: "start" });
	}
	function openDetail(id) {
		session.selected = id;
		showDetail(id);
	}
	function closeDetail() {
		detail?.dispose();
		detail = null;
		session.selected = null;
		clear(detailPane);
		detailPane.hidden = true;
		listPane.hidden = false;
		drawList();
	}
	const offCatalog = ctx.catalog.onChange(() => {
		if (disposed) return;
		drawStatus();
		if (session.selected) {
			if (ctx.catalog.model(session.selected)) detail?.refresh();
			else closeDetail();
			return;
		}
		drawChips();
		drawList();
	});
	const offConnections = ctx.connections.onChange(() => {
		if (!disposed && session.selected) detail?.refresh();
	});
	drawStatus();
	buildFilters();
	drawList();
	if (session.selected) {
		if (ctx.catalog.model(session.selected)) showDetail(session.selected);
		else session.selected = null;
	}
	ctx.catalog.refresh();
	return () => {
		disposed = true;
		offCatalog();
		offConnections();
		detail?.dispose();
		detail = null;
	};
}
// src/features/catalog/index.ts
var CATALOG_FEATURE_ID = "catalog";
var CATALOG_TAB_ID = "catalog";
/** Starts the first catalog load once the page is idle, so it never competes with SillyTavern's own start. */
function scheduleIdle(task, timeoutMs = 4e3) {
	const host = globalThis;
	if (typeof host.requestIdleCallback === "function") {
		const handle = host.requestIdleCallback(task, { timeout: timeoutMs });
		return () => host.cancelIdleCallback?.(handle);
	}
	const timer = setTimeout(task, 1e3);
	return () => clearTimeout(timer);
}
/** Tab «Catalog»: NanoGPT's models with filters, prices, hosts and routing hints, and a way to turn one into a connection. */
var catalogFeature = {
	id: CATALOG_FEATURE_ID,
	init(ctx) {
		ctx.i18n.register(CATALOG_STRINGS);
		const session = createSession();
		const cancelIdle = scheduleIdle(() => void ctx.catalog.refresh());
		const removeTab = ctx.panel.registerTab({
			id: CATALOG_TAB_ID,
			titleKey: "catalog.tab",
			order: 200,
			render: (root, tabCtx) => renderCatalogTab(root, tabCtx, session)
		});
		return () => {
			cancelIdle();
			removeTab();
		};
	}
};
// src/features/connections/strings.ts
var CONNECTIONS_STRINGS = {
	en: {
		"connections.tab": "Connections",
		"connections.status.checking": "Checking the plugin…",
		"connections.status.up": "Plugin is running",
		"connections.status.upDetail": "port {port} · version {version}",
		"connections.status.proxyDown": "The plugin answers, but its proxy is not listening on port {port}. Plugin-mode connections will not work until it does.",
		"connections.status.down": "Plugin is not answering",
		"connections.status.reason.not_installed": "SillyTavern does not know the Nanovia plugin: it is not installed or not enabled.",
		"connections.status.reason.unreachable": "There was no answer from the SillyTavern server.",
		"connections.status.reason.timeout": "The plugin did not answer in time.",
		"connections.status.reason.forbidden": "SillyTavern refused the request (session or CSRF check). Reload the page.",
		"connections.status.reason.other": "The plugin sent an unexpected answer ({code}).",
		"connections.status.installHint": "To use plugin mode, copy the plugin folder to plugins/nanovia inside your SillyTavern folder, set enableServerPlugins: true in config.yaml and restart the server. Until then connections can work in direct mode.",
		"connections.refresh": "Refresh",
		"connections.new": "New connection",
		"connections.empty": "No connections yet. A connection is a named bundle (model, key, billing, reasoning) that shows up in SillyTavern as a Connection Manager profile.",
		"connections.chip.mode.plugin": "Plugin",
		"connections.chip.mode.direct": "Direct",
		"connections.chip.mode.autoPlugin": "Auto → plugin",
		"connections.chip.mode.autoDirect": "Auto → direct",
		"connections.chip.billing.auto": "Billing: auto",
		"connections.chip.billing.subscription": "Subscription only",
		"connections.chip.billing.paygo": "Pay as you go",
		"connections.chip.profile.linked": "Profile linked",
		"connections.chip.profile.drifted": "Profile differs",
		"connections.chip.profile.missing": "Profile missing",
		"connections.chip.profile.none": "No profile",
		"connections.chip.profile.blocked": "Profile blocked",
		"connections.chip.profile.unavailable": "No Connection Manager",
		"connections.chip.pending": "Waiting for the plugin",
		"connections.chip.orphan": "Not on the plugin",
		"connections.chip.noKey": "No direct key",
		"connections.chip.noKey.hint": "Direct mode needs your NanoGPT key. Edit the connection and enter it once.",
		"connections.chip.pending.hint": "Edited while the plugin was down; it will be sent when the plugin answers.",
		"connections.chip.orphan.hint": "The plugin does not have this connection. Send it to the plugin or delete it.",
		"connections.chip.profile.blocked.hint": "A profile needs a proxy token (plugin mode) or a key (direct mode).",
		"connections.action.edit": "Edit",
		"connections.action.delete": "Delete",
		"connections.action.rotate": "New token",
		"connections.action.rotate.hint": "Issues a new proxy token and updates the profile.",
		"connections.action.switchDirect": "Switch to direct mode",
		"connections.action.switchDirect.hint": "Connects straight to NanoGPT while the plugin is down.",
		"connections.action.repairProfile": "Create profile",
		"connections.action.repairProfile.fix": "Repair profile",
		"connections.action.sendToPlugin": "Send to plugin",
		"connections.confirm.title": "Delete connection",
		"connections.confirm.delete": "Delete the connection \"{name}\", its Connection Manager profile and its stored key?",
		"connections.form.titleNew": "New connection",
		"connections.form.titleEdit": "Edit connection",
		"connections.form.name": "Name",
		"connections.form.nameHint": "Shown in the list and in the profile name (\"Nanovia · …\").",
		"connections.form.model": "Model id",
		"connections.form.modelHint": "NanoGPT model id, for example deepseek/deepseek-v4. Variants such as :thinking are part of the id.",
		"connections.form.mode": "How it connects",
		"connections.mode.auto": "Automatic",
		"connections.mode.plugin": "Through the plugin",
		"connections.mode.direct": "Direct to NanoGPT",
		"connections.mode.auto.hint": "Through the plugin while it answers, directly otherwise.",
		"connections.mode.plugin.hint": "Through the local Nanovia proxy: routing, billing safety and usage tracking work.",
		"connections.mode.direct.hint": "Straight from the browser to NanoGPT. Needs your NanoGPT key, entered once.",
		"connections.form.key": "NanoGPT key",
		"connections.form.keyActive": "The active key",
		"connections.form.keyHint": "Which of the keys the plugin knows this connection uses.",
		"connections.form.keysUnavailable": "The key list needs the plugin.",
		"connections.key.add": "Add a key",
		"connections.key.name": "Key name",
		"connections.key.value": "Paste the key here",
		"connections.key.save": "Save key",
		"connections.key.hint": "The key goes to the plugin and is never shown again.",
		"connections.key.added": "Key added.",
		"connections.form.directKey": "NanoGPT key",
		"connections.form.directKeyHint": "Written to SillyTavern's secret store once; Nanovia keeps only its id.",
		"connections.form.directKeyOnFile": "A key is on file. Type a new one only to replace it.",
		"connections.form.billing": "Billing",
		"connections.billing.auto": "Automatic",
		"connections.billing.subscription": "Subscription only",
		"connections.billing.paygo": "Pay as you go",
		"connections.billing.auto.hint": "Any setting is allowed; Nanovia warns when a setting takes a request out of your subscription.",
		"connections.billing.subscription.hint": "Settings that would bill outside the subscription are blocked or removed.",
		"connections.billing.paygo.hint": "Always billed pay-as-you-go, whatever the model offers.",
		"connections.form.reasoning": "Reasoning",
		"connections.reasoning.follow": "Follow the request",
		"connections.reasoning.fixed": "Fixed effort",
		"connections.reasoning.off": "Off",
		"connections.reasoning.default": "Model default",
		"connections.reasoning.follow.hint": "Takes the effort SillyTavern asked for and translates it to what the model supports.",
		"connections.reasoning.fixed.hint": "Always the effort below.",
		"connections.reasoning.off.hint": "No reasoning when the model allows it; the lowest effort, text hidden, when it always reasons.",
		"connections.reasoning.default.hint": "Sends nothing: the model decides.",
		"connections.form.effort": "Reasoning effort",
		"connections.effort.none": "None",
		"connections.effort.minimal": "Minimal",
		"connections.effort.low": "Low",
		"connections.effort.medium": "Medium",
		"connections.effort.high": "High",
		"connections.effort.xhigh": "Extra high",
		"connections.effort.max": "Max",
		"connections.form.hideThoughts": "Leave the reasoning text out of the reply",
		"connections.form.webSearch": "Web search (adds :online, billed separately)",
		"connections.form.note": "Note",
		"connections.form.save": "Save",
		"connections.form.cancel": "Cancel",
		"connections.form.offline": "The plugin is not answering. Plugin-mode settings are saved here and sent when it is back.",
		"connections.field.name": "name",
		"connections.field.modelId": "model id",
		"connections.notice.saved": "Connection saved.",
		"connections.notice.deleted": "Connection deleted.",
		"connections.notice.rotated": "New token issued and the profile updated.",
		"connections.notice.profile": "Profile updated.",
		"connections.notice.sent": "Sent to the plugin.",
		"connections.notice.switched": "Switched to direct mode.",
		"connections.notice.refreshed": "Refreshed.",
		"connections.issue.plugin_down": "The plugin is not answering. Choose direct mode, or start the plugin and try again.",
		"connections.issue.plugin_error": "The plugin refused the request: {message}",
		"connections.issue.direct_key_required": "Enter your NanoGPT key: direct mode needs it once.",
		"connections.issue.key_write_failed": "SillyTavern did not accept the key ({message}).",
		"connections.issue.not_found": "This connection no longer exists.",
		"connections.issue.invalid": "The {field} is required.",
		"connections.issue.not_on_plugin": "The plugin does not have this connection.",
		"connections.issue.saved_locally": "Saved here; it will be sent to the plugin when it answers.",
		"connections.issue.profile_unavailable": "Connection Manager is not installed or is disabled, so no profile was written.",
		"connections.issue.profile_needs_token": "No proxy token yet, so the profile was not written.",
		"connections.issue.profile_needs_key": "No NanoGPT key on file, so the profile was not written.",
		"connections.issue.profile_failed": "The profile could not be written.",
		"connections.issue.key_not_removed": "The stored key could not be removed from SillyTavern; delete it there if you like."
	},
	ru: {
		"connections.tab": "Подключения",
		"connections.status.checking": "Проверяю плагин…",
		"connections.status.up": "Плагин работает",
		"connections.status.upDetail": "порт {port} · версия {version}",
		"connections.status.proxyDown": "Плагин отвечает, но его прокси не слушает порт {port}. Подключения через плагин не заработают, пока это так.",
		"connections.status.down": "Плагин не отвечает",
		"connections.status.reason.not_installed": "SillyTavern не знает плагин Nanovia: он не установлен или не включён.",
		"connections.status.reason.unreachable": "Сервер SillyTavern не ответил.",
		"connections.status.reason.timeout": "Плагин не ответил вовремя.",
		"connections.status.reason.forbidden": "SillyTavern отклонил запрос (проверка сессии или CSRF). Перезагрузите страницу.",
		"connections.status.reason.other": "Плагин прислал неожиданный ответ ({code}).",
		"connections.status.installHint": "Чтобы работать через плагин, скопируйте папку плагина в plugins/nanovia внутри папки SillyTavern, включите enableServerPlugins: true в config.yaml и перезапустите сервер. Пока этого нет, подключения могут работать напрямую.",
		"connections.refresh": "Обновить",
		"connections.new": "Новое подключение",
		"connections.empty": "Подключений пока нет. Подключение — это именованный набор (модель, ключ, тариф, рассуждения), который появляется в SillyTavern как профиль Connection Manager.",
		"connections.chip.mode.plugin": "Плагин",
		"connections.chip.mode.direct": "Напрямую",
		"connections.chip.mode.autoPlugin": "Авто → плагин",
		"connections.chip.mode.autoDirect": "Авто → напрямую",
		"connections.chip.billing.auto": "Тариф: авто",
		"connections.chip.billing.subscription": "Только подписка",
		"connections.chip.billing.paygo": "Оплата по факту",
		"connections.chip.profile.linked": "Профиль связан",
		"connections.chip.profile.drifted": "Профиль отличается",
		"connections.chip.profile.missing": "Профиль пропал",
		"connections.chip.profile.none": "Нет профиля",
		"connections.chip.profile.blocked": "Профиль не создать",
		"connections.chip.profile.unavailable": "Нет Connection Manager",
		"connections.chip.pending": "Ждёт плагин",
		"connections.chip.orphan": "Нет в плагине",
		"connections.chip.noKey": "Нет ключа",
		"connections.chip.noKey.hint": "Для прямого режима нужен ваш ключ NanoGPT. Откройте подключение и введите его один раз.",
		"connections.chip.pending.hint": "Изменено, пока плагин не отвечал; уйдёт в плагин, когда он ответит.",
		"connections.chip.orphan.hint": "В плагине нет этого подключения. Отправьте его в плагин или удалите.",
		"connections.chip.profile.blocked.hint": "Для профиля нужен токен прокси (режим плагина) или ключ (прямой режим).",
		"connections.action.edit": "Изменить",
		"connections.action.delete": "Удалить",
		"connections.action.rotate": "Новый токен",
		"connections.action.rotate.hint": "Выпускает новый токен прокси и обновляет профиль.",
		"connections.action.switchDirect": "Перейти на прямой режим",
		"connections.action.switchDirect.hint": "Подключается прямо к NanoGPT, пока плагин не отвечает.",
		"connections.action.repairProfile": "Создать профиль",
		"connections.action.repairProfile.fix": "Починить профиль",
		"connections.action.sendToPlugin": "Отправить в плагин",
		"connections.confirm.title": "Удаление подключения",
		"connections.confirm.delete": "Удалить подключение «{name}», его профиль Connection Manager и сохранённый ключ?",
		"connections.form.titleNew": "Новое подключение",
		"connections.form.titleEdit": "Изменение подключения",
		"connections.form.name": "Название",
		"connections.form.nameHint": "Показывается в списке и в названии профиля («Nanovia · …»).",
		"connections.form.model": "Идентификатор модели",
		"connections.form.modelHint": "Идентификатор модели NanoGPT, например deepseek/deepseek-v4. Варианты вроде :thinking входят в идентификатор.",
		"connections.form.mode": "Как подключаться",
		"connections.mode.auto": "Автоматически",
		"connections.mode.plugin": "Через плагин",
		"connections.mode.direct": "Напрямую в NanoGPT",
		"connections.mode.auto.hint": "Через плагин, пока он отвечает, иначе напрямую.",
		"connections.mode.plugin.hint": "Через локальный прокси Nanovia: работают маршрутизация, защита подписки и учёт расхода.",
		"connections.mode.direct.hint": "Из браузера прямо в NanoGPT. Нужен ваш ключ NanoGPT, вводится один раз.",
		"connections.form.key": "Ключ NanoGPT",
		"connections.form.keyActive": "Активный ключ",
		"connections.form.keyHint": "Какой из ключей, известных плагину, использует это подключение.",
		"connections.form.keysUnavailable": "Список ключей доступен только через плагин.",
		"connections.key.add": "Добавить ключ",
		"connections.key.name": "Название ключа",
		"connections.key.value": "Вставьте ключ сюда",
		"connections.key.save": "Сохранить ключ",
		"connections.key.hint": "Ключ уходит в плагин и больше нигде не показывается.",
		"connections.key.added": "Ключ добавлен.",
		"connections.form.directKey": "Ключ NanoGPT",
		"connections.form.directKeyHint": "Записывается в хранилище секретов SillyTavern один раз; Nanovia помнит только его идентификатор.",
		"connections.form.directKeyOnFile": "Ключ уже сохранён. Вводите новый, только если хотите заменить.",
		"connections.form.billing": "Тариф",
		"connections.billing.auto": "Автоматически",
		"connections.billing.subscription": "Только подписка",
		"connections.billing.paygo": "Оплата по факту",
		"connections.billing.auto.hint": "Разрешены любые настройки; Nanovia предупредит, если настройка выводит запрос за пределы подписки.",
		"connections.billing.subscription.hint": "Настройки, из-за которых запрос оплачивался бы вне подписки, блокируются или убираются.",
		"connections.billing.paygo.hint": "Всегда оплата по факту, что бы ни предлагала модель.",
		"connections.form.reasoning": "Рассуждения",
		"connections.reasoning.follow": "Как в запросе",
		"connections.reasoning.fixed": "Фиксированный уровень",
		"connections.reasoning.off": "Выключены",
		"connections.reasoning.default": "По умолчанию модели",
		"connections.reasoning.follow.hint": "Берёт уровень, который запросил SillyTavern, и переводит в то, что поддерживает модель.",
		"connections.reasoning.fixed.hint": "Всегда уровень, выбранный ниже.",
		"connections.reasoning.off.hint": "Без рассуждений, если модель позволяет; если рассуждает всегда — минимальный уровень со скрытым текстом.",
		"connections.reasoning.default.hint": "Ничего не отправляет: решает модель.",
		"connections.form.effort": "Уровень рассуждений",
		"connections.effort.none": "Нет",
		"connections.effort.minimal": "Минимальный",
		"connections.effort.low": "Низкий",
		"connections.effort.medium": "Средний",
		"connections.effort.high": "Высокий",
		"connections.effort.xhigh": "Очень высокий",
		"connections.effort.max": "Максимальный",
		"connections.form.hideThoughts": "Не включать текст рассуждений в ответ",
		"connections.form.webSearch": "Веб-поиск (добавляет :online, оплачивается отдельно)",
		"connections.form.note": "Заметка",
		"connections.form.save": "Сохранить",
		"connections.form.cancel": "Отмена",
		"connections.form.offline": "Плагин не отвечает. Настройки режима плагина сохранятся здесь и уйдут в плагин, когда он вернётся.",
		"connections.field.name": "название",
		"connections.field.modelId": "идентификатор модели",
		"connections.notice.saved": "Подключение сохранено.",
		"connections.notice.deleted": "Подключение удалено.",
		"connections.notice.rotated": "Выпущен новый токен, профиль обновлён.",
		"connections.notice.profile": "Профиль обновлён.",
		"connections.notice.sent": "Отправлено в плагин.",
		"connections.notice.switched": "Переключено на прямой режим.",
		"connections.notice.refreshed": "Обновлено.",
		"connections.issue.plugin_down": "Плагин не отвечает. Выберите прямой режим или запустите плагин и повторите.",
		"connections.issue.plugin_error": "Плагин отклонил запрос: {message}",
		"connections.issue.direct_key_required": "Введите ключ NanoGPT: для прямого режима он нужен один раз.",
		"connections.issue.key_write_failed": "SillyTavern не принял ключ ({message}).",
		"connections.issue.not_found": "Такого подключения уже нет.",
		"connections.issue.invalid": "Поле «{field}» обязательно.",
		"connections.issue.not_on_plugin": "В плагине нет этого подключения.",
		"connections.issue.saved_locally": "Сохранено здесь; уйдёт в плагин, когда он ответит.",
		"connections.issue.profile_unavailable": "Connection Manager не установлен или выключен, поэтому профиль не записан.",
		"connections.issue.profile_needs_token": "Токена прокси ещё нет, поэтому профиль не записан.",
		"connections.issue.profile_needs_key": "Нет сохранённого ключа NanoGPT, поэтому профиль не записан.",
		"connections.issue.profile_failed": "Профиль не удалось записать.",
		"connections.issue.key_not_removed": "Сохранённый ключ не удалось убрать из SillyTavern; при желании удалите его там."
	}
};
/** The models to offer for what is typed: id and name matches, those that start with it first; nothing typed = all. */
function pickerMatches(models, text) {
	const query = text.trim();
	if (!query) return sortCatalog(models, "subscription");
	const matched = filterCatalog(models, { text: query });
	const lower = query.toLowerCase();
	const rank = (model) => model.id.toLowerCase() === lower ? 0 : model.id.toLowerCase().startsWith(lower) ? 1 : 2;
	return matched.map((model, index) => ({
		model,
		index,
		rank: rank(model)
	})).sort((a, b) => a.rank - b.rank || a.index - b.index).map((entry) => entry.model);
}
function modelPicker(options) {
	const { catalog, t } = options;
	const listId = uid("nanovia-picker");
	const input = el("input", {
		class: "text_pole nanovia-text",
		attrs: {
			type: "text",
			role: "combobox",
			"aria-label": options.label,
			"aria-autocomplete": "list",
			"aria-expanded": "false",
			"aria-controls": listId,
			placeholder: options.placeholder,
			maxlength: options.maxLength,
			disabled: options.disabled === true,
			autocomplete: "off",
			autocapitalize: "off",
			spellcheck: "false"
		}
	});
	input.value = options.value;
	const list = el("div", {
		class: "nanovia-picker-list",
		attrs: {
			id: listId,
			role: "listbox",
			hidden: true
		}
	});
	const root = el("div", { class: "nanovia-picker" }, [input, list]);
	let open = false;
	let active = -1;
	let shown = [];
	let unsubscribe = null;
	function setActive(index) {
		active = index;
		[...list.querySelectorAll(".nanovia-picker-option")].forEach((node, i) => {
			node.classList.toggle("nanovia-picker-active", i === index);
			node.setAttribute("aria-selected", String(i === index));
			if (i === index) node.scrollIntoView?.({ block: "nearest" });
		});
	}
	function pick(model) {
		input.value = model.id;
		options.onInput(model.id);
		close();
	}
	function note(text) {
		return el("div", {
			class: "nanovia-picker-note nanovia-muted",
			text
		});
	}
	function render() {
		clear(list);
		active = -1;
		const models = catalog.models();
		if (models.length === 0) {
			shown = [];
			list.appendChild(note(t(catalog.status().error ? "ui.picker.unavailable" : "ui.picker.loading")));
			return;
		}
		const matches = pickerMatches(models, input.value);
		shown = matches.slice(0, 30);
		if (matches.length === 0) {
			list.appendChild(note(t("ui.picker.noMatch")));
			return;
		}
		for (const model of shown) {
			const free = model.subscription.included;
			const row = el("div", {
				class: "nanovia-picker-option",
				data: { model: model.id },
				attrs: {
					role: "option",
					"aria-selected": "false"
				}
			}, [el("div", { class: "nanovia-picker-main" }, [el("span", {
				class: "nanovia-picker-name",
				text: model.name
			}), free ? el("span", {
				class: "nanovia-picker-sub",
				text: t("ui.picker.sub"),
				title: t("ui.picker.subTitle")
			}) : null]), el("div", { class: "nanovia-picker-detail nanovia-muted" }, [el("span", {
				class: "nanovia-picker-id",
				text: model.id
			}), el("span", {
				class: "nanovia-picker-price",
				text: formatPricePair(model.pricing.prompt, model.pricing.completion),
				title: t("ui.picker.priceTitle")
			})])]);
			row.addEventListener("mousedown", (event) => event.preventDefault());
			row.addEventListener("click", () => pick(model));
			list.appendChild(row);
		}
		if (matches.length > shown.length) list.appendChild(note(t("ui.picker.more", { count: matches.length - shown.length })));
	}
	function openList() {
		if (options.disabled) return;
		if (!open) {
			open = true;
			list.hidden = false;
			input.setAttribute("aria-expanded", "true");
			unsubscribe = catalog.onChange(() => {
				if (!root.isConnected) return close();
				if (open) render();
			});
			catalog.refresh();
		}
		render();
	}
	function close() {
		open = false;
		list.hidden = true;
		input.setAttribute("aria-expanded", "false");
		unsubscribe?.();
		unsubscribe = null;
		active = -1;
	}
	input.addEventListener("focus", openList);
	input.addEventListener("click", openList);
	input.addEventListener("blur", close);
	input.addEventListener("input", () => {
		options.onInput(input.value);
		openList();
	});
	input.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			if (open) event.preventDefault();
			close();
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (!open) openList();
			if (shown.length === 0) return;
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActive(active < 0 ? step > 0 ? 0 : shown.length - 1 : (active + step + shown.length) % shown.length);
			return;
		}
		if (event.key === "Enter" && open && active >= 0) {
			const model = shown[active];
			if (model) {
				event.preventDefault();
				pick(model);
			}
		}
	});
	return root;
}
// src/features/connections/form.ts
/** A hint line that follows the value of the control above it. */
function hintLine(text) {
	return el("div", {
		class: "nanovia-field-hint",
		text
	});
}
function renderConnectionForm(deps) {
	const { ctx, form, entry } = deps;
	const t = ctx.t;
	const pluginUp = ctx.connections.pluginUp();
	const formCtx = {
		pluginUp,
		hasDirectKey: entry?.hasDirectKey ?? false
	};
	const modeOptions = CONNECTION_MODES.map((value) => ({
		value,
		label: t(`connections.mode.${value}`)
	}));
	const modeHint = hintLine(t(`connections.mode.${form.mode}.hint`));
	const modeRow = field(t("connections.form.mode"), select({
		value: form.mode,
		options: modeOptions,
		label: t("connections.form.mode"),
		onChange: (value) => {
			form.mode = value;
			deps.redraw();
		}
	}));
	modeRow.appendChild(modeHint);
	const billingOptions = BILLING_MODES.map((value) => ({
		value,
		label: t(`connections.billing.${value}`)
	}));
	const billingHint = hintLine(t(`connections.billing.${form.billing}.hint`));
	const billingRow = field(t("connections.form.billing"), select({
		value: form.billing,
		options: billingOptions,
		label: t("connections.form.billing"),
		onChange: (value) => {
			form.billing = value;
			billingHint.textContent = t(`connections.billing.${value}.hint`);
		}
	}));
	billingRow.appendChild(billingHint);
	const policyOptions = REASONING_POLICIES.map((value) => ({
		value,
		label: t(`connections.reasoning.${value}`)
	}));
	const policyHint = hintLine(t(`connections.reasoning.${form.reasoningPolicy}.hint`));
	const policyRow = field(t("connections.form.reasoning"), select({
		value: form.reasoningPolicy,
		options: policyOptions,
		label: t("connections.form.reasoning"),
		onChange: (value) => {
			form.reasoningPolicy = value;
			deps.redraw();
		}
	}));
	policyRow.appendChild(policyHint);
	const children = [
		el("h4", {
			class: "nanovia-form-title",
			text: t(entry ? "connections.form.titleEdit" : "connections.form.titleNew")
		}),
		field(t("connections.form.name"), textInput({
			value: form.name,
			label: t("connections.form.name"),
			maxLength: 80,
			onInput: (value) => void (form.name = value)
		}), t("connections.form.nameHint")),
		field(t("connections.form.model"), modelPicker({
			catalog: ctx.catalog,
			t,
			value: form.modelId,
			label: t("connections.form.model"),
			maxLength: 200,
			onInput: (value) => void (form.modelId = value)
		}), t("connections.form.modelHint")),
		modeRow
	];
	if (form.mode !== "direct") children.push(renderKeyPicker(deps, pluginUp));
	if (showsDirectKey(form, formCtx)) {
		const onFile = formCtx.hasDirectKey;
		children.push(field(t("connections.form.directKey"), textInput({
			value: form.directKey,
			type: "password",
			label: t("connections.form.directKey"),
			placeholder: onFile ? t("connections.form.directKeyOnFile") : "",
			onInput: (value) => void (form.directKey = value)
		}), needsDirectKey(form, formCtx) ? t("connections.form.directKeyHint") : t("connections.form.directKeyOnFile")));
	}
	children.push(billingRow, policyRow);
	if (form.reasoningPolicy === "fixed") {
		const effortOptions = REASONING_EFFORTS.map((value) => ({
			value,
			label: t(`connections.effort.${value}`)
		}));
		children.push(field(t("connections.form.effort"), select({
			value: form.reasoningEffort === "" ? "medium" : form.reasoningEffort,
			options: effortOptions,
			label: t("connections.form.effort"),
			onChange: (value) => {
				form.reasoningEffort = REASONING_EFFORTS.find((effort) => effort === value) ?? "medium";
			}
		})));
		if (form.reasoningEffort === "") form.reasoningEffort = "medium";
	}
	children.push(toggle({
		label: t("connections.form.hideThoughts"),
		checked: form.hideThoughts,
		onChange: (checked) => void (form.hideThoughts = checked)
	}), toggle({
		label: t("connections.form.webSearch"),
		checked: form.webSearch,
		onChange: (checked) => void (form.webSearch = checked)
	}), field(t("connections.form.note"), textArea({
		value: form.note,
		rows: 2,
		label: t("connections.form.note"),
		maxLength: 1e3,
		onInput: (value) => void (form.note = value)
	})));
	if (!pluginUp && form.mode !== "direct") children.push(el("div", {
		class: "nanovia-muted",
		text: t("connections.form.offline")
	}));
	children.push(el("div", { class: "nanovia-row nanovia-form-actions" }, [button({
		label: t("connections.form.save"),
		icon: "check",
		kind: "primary",
		onClick: () => deps.save()
	}), button({
		label: t("connections.form.cancel"),
		onClick: () => deps.cancel()
	})]));
	return el("form", {
		class: "nanovia-form",
		on: { submit: (event) => event.preventDefault() }
	}, children);
}
/** The key select (keys the plugin knows) and the small «add a key» form under it. */
function renderKeyPicker(deps, pluginUp) {
	const { ctx, form, keys } = deps;
	const t = ctx.t;
	const wrapper = el("div", { class: "nanovia-keys" });
	if (!pluginUp || keys === null) {
		wrapper.appendChild(field(t("connections.form.key"), chip(t("connections.form.keysUnavailable"), "muted")));
		return wrapper;
	}
	const options = [{
		value: "",
		label: t("connections.form.keyActive")
	}, ...keys.map((key) => ({
		value: key.id,
		label: keyLabel(key, t)
	}))];
	if (form.keyId && !options.some((option) => option.value === form.keyId)) options.push({
		value: form.keyId,
		label: form.keyId
	});
	wrapper.appendChild(field(t("connections.form.key"), select({
		value: form.keyId,
		options,
		label: t("connections.form.key"),
		onChange: (value) => void (form.keyId = value)
	}), t("connections.form.keyHint")));
	let keyName = "";
	let keyValue = "";
	const valueInput = textInput({
		value: "",
		type: "password",
		label: t("connections.key.value"),
		placeholder: t("connections.key.value"),
		onInput: (value) => void (keyValue = value)
	});
	const addBox = el("div", { class: "nanovia-keys-add" }, [
		textInput({
			value: "",
			label: t("connections.key.name"),
			placeholder: t("connections.key.name"),
			maxLength: 80,
			onInput: (value) => void (keyName = value)
		}),
		valueInput,
		button({
			label: t("connections.key.save"),
			icon: "key",
			onClick: async () => {
				const value = keyValue;
				const label = keyName.trim() || t("connections.key.add");
				keyValue = "";
				valueInput.value = "";
				if (!value.trim()) return;
				await deps.addKey(label, value);
			}
		}),
		el("div", {
			class: "nanovia-field-hint",
			text: t("connections.key.hint")
		})
	]);
	const details = el("details", { class: "nanovia-details" }, [el("summary", { text: t("connections.key.add") }), addBox]);
	wrapper.appendChild(details);
	return wrapper;
}
// src/features/connections/view.ts
function renderConnectionsTab(root, ctx) {
	const t = ctx.t;
	const state = {
		editing: null,
		keys: null,
		notice: null
	};
	let disposed = false;
	const bannerHost = el("div", { class: "nanovia-banner-host" });
	const noticeHost = el("div", {
		class: "nanovia-notice-host",
		attrs: { "aria-live": "polite" }
	});
	const bodyHost = el("div", { class: "nanovia-connections-body" });
	root.append(bannerHost, noticeHost, bodyHost);
	function notify(kind, text) {
		state.notice = {
			kind,
			text
		};
		drawNotice();
	}
	/** Shows the outcome of an operation: its error, or its success text followed by any warnings. */
	function report(result, success) {
		if (!result.ok) {
			notify("error", issueText(result.error, t));
			return false;
		}
		const warnings = result.warnings;
		if (warnings.length === 0) notify("ok", success);
		else notify("warn", [success, ...warnings.map((warning) => issueText(warning, t))].join(" "));
		return true;
	}
	function drawBanner() {
		clear(bannerHost);
		const up = ctx.connections.pluginUp();
		const banner = bannerFor(ctx.connections.pluginStatus(), ctx.connections.pluginError(), up, t, ctx.connections.checked());
		const header = el("div", { class: "nanovia-row" }, [
			chip(banner.title, banner.state === "up" ? "ok" : banner.state === "down" ? "error" : "muted"),
			banner.detail ? el("span", {
				class: "nanovia-muted",
				text: banner.detail
			}) : null,
			button({
				label: t("connections.refresh"),
				icon: "rotate",
				kind: "ghost",
				onClick: async () => {
					await ctx.connections.refresh();
					notify("ok", t("connections.notice.refreshed"));
				}
			})
		]);
		const box = el("div", { class: ["nanovia-banner", `nanovia-banner-${banner.state}`] }, [header]);
		if (banner.advice) box.appendChild(el("div", {
			class: banner.up ? "nanovia-error-text" : "nanovia-muted",
			text: banner.advice
		}));
		bannerHost.appendChild(box);
	}
	function drawNotice() {
		clear(noticeHost);
		if (!state.notice) return;
		noticeHost.appendChild(el("div", {
			class: ["nanovia-notice", `nanovia-notice-${state.notice.kind}`],
			text: state.notice.text
		}));
	}
	function drawBody() {
		clear(bodyHost);
		if (state.editing) {
			const { form, entry } = state.editing;
			bodyHost.appendChild(renderConnectionForm({
				ctx,
				form,
				entry,
				keys: state.keys,
				redraw: drawBody,
				save: saveForm,
				cancel: closeForm,
				addKey
			}));
			return;
		}
		bodyHost.appendChild(el("div", { class: "nanovia-row" }, [button({
			label: t("connections.new"),
			icon: "plus",
			kind: "primary",
			onClick: () => openForm(emptyForm(), null)
		})]));
		const entries = ctx.connections.list();
		if (entries.length === 0) {
			bodyHost.appendChild(el("div", {
				class: "nanovia-muted nanovia-empty",
				text: t("connections.empty")
			}));
			return;
		}
		const list = el("div", { class: "nanovia-cards" });
		for (const entry of entries) list.appendChild(renderCard(entry));
		bodyHost.appendChild(list);
	}
	function renderCard(entry) {
		const pluginUp = ctx.connections.pluginUp();
		const chips = chipsFor(entry, pluginUp, t).map((spec) => chip(spec.label, spec.kind, spec.title));
		const actions = actionsFor(entry, pluginUp, t).map((action) => button({
			label: action.label,
			title: action.title,
			kind: action.kind === "danger" ? "danger" : "default",
			onClick: () => runAction(action.id, entry)
		}));
		return el("div", {
			class: "nanovia-card",
			data: { connection: entry.config.id }
		}, [
			el("div", { class: "nanovia-card-head" }, [el("b", {
				class: "nanovia-card-name",
				text: entry.config.name
			}), el("span", {
				class: "nanovia-muted nanovia-card-model",
				text: entry.config.modelId
			})]),
			el("div", { class: "nanovia-row nanovia-chips" }, chips),
			entry.config.note ? el("div", {
				class: "nanovia-muted nanovia-card-note",
				text: entry.config.note
			}) : null,
			el("div", { class: "nanovia-row nanovia-card-actions" }, actions)
		]);
	}
	function drawAll() {
		drawBanner();
		drawNotice();
		drawBody();
	}
	async function loadKeys() {
		if (!ctx.connections.pluginUp()) {
			state.keys = null;
			return;
		}
		const result = await ctx.plugin.listKeys();
		state.keys = result.ok ? result.data : null;
	}
	async function openForm(form, entry) {
		state.notice = null;
		drawNotice();
		state.editing = {
			form,
			entry
		};
		drawBody();
		if (form.mode !== "direct" && ctx.connections.pluginUp()) {
			await loadKeys();
			if (!disposed && state.editing?.form === form) drawBody();
		}
	}
	function closeForm() {
		state.editing = null;
		drawBody();
	}
	async function saveForm() {
		const editing = state.editing;
		if (!editing) return;
		const { form, entry } = editing;
		const formCtx = {
			pluginUp: ctx.connections.pluginUp(),
			hasDirectKey: entry?.hasDirectKey ?? false
		};
		const first = validateForm(form, formCtx)[0];
		if (first) {
			notify("error", issueText(first.field === "directKey" ? { code: "direct_key_required" } : {
				code: "invalid",
				params: { field: first.field }
			}, t));
			return;
		}
		if (report(await ctx.connections.save({
			id: form.id ?? void 0,
			patch: patchFromForm(form),
			directKey: showsDirectKey(form, formCtx) ? form.directKey || void 0 : void 0
		}), t("connections.notice.saved"))) {
			form.directKey = "";
			state.editing = null;
			drawBody();
		}
	}
	async function addKey(label, value) {
		const result = await ctx.plugin.addKey(label, value);
		if (!result.ok) {
			notify("error", issueText({
				code: "plugin_error",
				params: { message: result.error.message }
			}, t));
			return;
		}
		await loadKeys();
		if (state.editing) state.editing.form.keyId = result.data.id;
		notify("ok", t("connections.key.added"));
		drawBody();
	}
	async function runAction(action, entry) {
		const id = entry.config.id;
		switch (action) {
			case "edit":
				await openForm(formFromConfig(entry.config), entry);
				return;
			case "delete":
				if (!await ctx.host.confirm(t("connections.confirm.delete", { name: entry.config.name }), t("connections.confirm.title"))) return;
				report(await ctx.connections.remove(id), t("connections.notice.deleted"));
				return;
			case "rotate":
				report(await ctx.connections.rotateToken(id), t("connections.notice.rotated"));
				return;
			case "switchDirect":
				if (entry.hasDirectKey) report(await ctx.connections.switchToDirect(id), t("connections.notice.switched"));
				else await openForm({
					...formFromConfig(entry.config),
					mode: "direct"
				}, entry);
				return;
			case "repairProfile":
				report(await ctx.connections.repairProfile(id), t("connections.notice.profile"));
				return;
			case "sendToPlugin":
				report(await ctx.connections.sendToPlugin(id), t("connections.notice.sent"));
				return;
		}
	}
	const off = ctx.connections.onChange(() => {
		if (disposed) return;
		drawBanner();
		if (!state.editing) drawBody();
	});
	drawAll();
	return () => {
		disposed = true;
		off();
		state.editing = null;
	};
}
// src/features/connections/index.ts
var CONNECTIONS_FEATURE_ID = "connections";
var CONNECTIONS_TAB_ID = "connections";
// src/features/index.ts
var FEATURES = [{
	id: CONNECTIONS_FEATURE_ID,
	init(ctx) {
		ctx.i18n.register(CONNECTIONS_STRINGS);
		return ctx.panel.registerTab({
			id: CONNECTIONS_TAB_ID,
			titleKey: "connections.tab",
			order: 100,
			render: (root, tabCtx) => renderConnectionsTab(root, tabCtx)
		});
	}
}, catalogFeature];
// src/app/api.ts
function createApiPublisher(deps) {
	const { connections, profiles, settings, log } = deps;
	/** The connection a Connection Manager profile belongs to: by the id we stored, then by a proxy URL it carries. */
	function connectionIdOf(profileId) {
		for (const [connectionId, linked] of Object.entries(settings.get().profiles)) if (linked === profileId) return connectionId;
		const profile = profiles.get(profileId);
		return profile ? profiles.connectionIdOf(profile) : null;
	}
	function describeProfile(profileId) {
		if (typeof profileId !== "string" || !profileId) return null;
		const id = connectionIdOf(profileId);
		const entry = id ? connections.get(id) : null;
		if (!entry) return null;
		const { config } = entry;
		return {
			connectionId: config.id,
			name: config.name,
			modelId: config.modelId,
			reasoning: { ...config.reasoning },
			billing: config.billing,
			capabilities: null
		};
	}
	const api = {
		version: 1,
		nanoviaVersion: deps.version,
		features: deps.features(),
		connections: () => connections.summaries(),
		describeProfile
	};
	const holder = globalThis;
	return {
		api,
		publish() {
			holder[NANOVIA_API_GLOBAL] = api;
			try {
				if (typeof window !== "undefined" && typeof CustomEvent === "function") window.dispatchEvent(new CustomEvent(NANOVIA_API_READY_EVENT, { detail: { version: 1 } }));
			} catch (error) {
				log.warn("could not announce NANOVIA_API", error);
			}
		},
		dispose() {
			if (holder["NANOVIA_API"] === api) delete holder[NANOVIA_API_GLOBAL];
		}
	};
}
// src/app/app.ts
var NANOVIA_VERSION = version;
async function startNanovia(options = {}) {
	const features = options.features ?? FEATURES;
	const log = createLogger();
	const host = createHost(log.scope("host"));
	const settings = new Settings(() => host.ctx().extensionSettings, () => host.ctx().saveSettingsDebounced(), log.scope("settings"));
	ConsoleLogger.setLevel(settings.get().debug ? "debug" : "info");
	setButtonErrorHandler((error) => log.scope("ui").error("a button handler failed", error));
	const i18n = createI18n(() => {
		const choice = settings.get().uiLanguage;
		if (choice === "ru" || choice === "en") return choice;
		return hostLocale(() => host.locale());
	});
	i18n.register(UI_STRINGS);
	const bus = createBus(log.scope("bus"));
	const requests = installFetchHook(log.scope("request"));
	requests.register(proxyHintsHook);
	requests.register(directModeHook);
	const plugin = createPluginClient({
		ctx: host.ctx,
		log: log.scope("plugin")
	});
	const profiles = createProfilesHost({
		ctx: host.ctx,
		events: host.events,
		log: log.scope("profiles")
	});
	const secrets = createSecretsHost({
		ctx: host.ctx,
		log: log.scope("secrets"),
		afterChange: async () => {
			const read = (await host.modules.secrets())["readSecretState"];
			if (typeof read === "function") await read();
		}
	});
	const connections = createConnectionsService({
		settings,
		plugin,
		profiles,
		secrets,
		bus,
		log: log.scope("connections")
	});
	const catalog = createBrowserCatalogStore({
		plugin,
		bus,
		log: log.scope("catalog")
	});
	const ctx = {};
	const panel = new SettingsPanel({
		i18n,
		log: log.scope("panel"),
		ctx: () => ctx,
		getLastTab: () => settings.get().lastTab,
		setLastTab: (id) => settings.set("lastTab", id)
	});
	Object.assign(ctx, {
		version: NANOVIA_VERSION,
		host,
		settings,
		plugin,
		connections,
		catalog,
		profiles,
		secrets,
		registerRequestHook: (hook) => requests.register(hook),
		panel,
		i18n,
		t: i18n.t.bind(i18n),
		bus,
		log
	});
	const owned = [];
	owned.push(panel.registerTab(generalTab({
		settings,
		i18n,
		version: NANOVIA_VERSION
	})));
	const running = [];
	for (const feature of features) try {
		const dispose = feature.init(ctx);
		running.push(feature);
		if (typeof dispose === "function") owned.push(dispose);
	} catch (error) {
		log.error(`feature "${feature.id}" failed to start`, error);
	}
	if (!panel.mount()) owned.push(host.events.on("APP_READY", () => void panel.mount()));
	owned.push(settings.onChange((key) => {
		if (key === "debug" || key === "*") ConsoleLogger.setLevel(settings.get().debug ? "debug" : "info");
		if (key === "uiLanguage" || key === "*") panel.relabel();
		bus.emit("settings:changed", { key });
	}));
	const api = createApiPublisher({
		version: NANOVIA_VERSION,
		features: () => running.map((feature) => feature.id),
		connections,
		profiles,
		settings,
		log: log.scope("api")
	});
	api.publish();
	if (!options.skipInitialRefresh) connections.refresh().catch((error) => log.error("first refresh failed", error));
	log.info(`${NANOVIA_VERSION} started`);
	return {
		ctx,
		settings,
		connections,
		panel,
		api,
		async stop() {
			for (const off of owned.splice(0).reverse()) try {
				off();
			} catch (error) {
				log.error("cleanup failed", error);
			}
			api.dispose();
			panel.dispose();
			requests.uninstall();
			bus.clear();
			host.dispose();
		}
	};
}
// src/index.ts
var runtime = null;
var starting = null;
/** hooks.activate */
async function onActivate() {
	if (runtime || starting) return;
	starting = startNanovia();
	try {
		runtime = await starting;
		console.info("[Nanovia] activated");
	} catch (error) {
		console.error("[Nanovia] activation failed", error);
	} finally {
		starting = null;
	}
}
/** hooks.disable: quick cleanup within ST's 5 s window (NANOVIA_API and the fetch wrapper go away with it). */
async function onDisable() {
	const pending = starting;
	if (pending) await pending.catch(() => void 0);
	const current = runtime;
	runtime = null;
	await current?.stop();
}
/** hooks.enable */
async function onEnable() {}
/** hooks.install */
async function onInstall() {}
/** hooks.update */
async function onUpdate() {}
/** hooks.delete */
async function onDelete() {
	await onDisable();
}
/**
* hooks.clean: removes Nanovia's settings. Connection Manager profiles and ST secrets that Nanovia wrote stay (the
* profiles are recognisable by their name prefix); the user deletes them in ST if they want them gone.
*/
async function onClean() {
	const current = runtime;
	await onDisable();
	if (current) {
		current.settings.reset();
		return;
	}
	try {
		const context = SillyTavern.getContext();
		delete context.extensionSettings[SETTINGS_KEY];
		context.saveSettingsDebounced();
	} catch (error) {
		console.error("[Nanovia] could not clean settings", error);
	}
}
export { onActivate, onClean, onDelete, onDisable, onEnable, onInstall, onUpdate };

//# sourceMappingURL=index.js.map