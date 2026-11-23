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
	const p = isRecord$9(patch) ? patch : {};
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
	if (typeof p["name"] === "string" && p["name"].trim()) next.name = clip$1(p["name"].trim(), 80);
	if (typeof p["modelId"] === "string" && p["modelId"].trim()) next.modelId = clip$1(p["modelId"].trim(), 200);
	if (typeof p["modelLock"] === "boolean") next.modelLock = p["modelLock"];
	if (isOneOf(MODES, p["mode"])) next.mode = p["mode"];
	if (p["keyId"] === null) next.keyId = null;
	else if (typeof p["keyId"] === "string" && p["keyId"].trim()) next.keyId = clip$1(p["keyId"].trim(), 100);
	if (isOneOf(BILLING, p["billing"])) next.billing = p["billing"];
	if (typeof p["webSearch"] === "boolean") next.webSearch = p["webSearch"];
	if (typeof p["stripNeutralSamplers"] === "boolean") next.stripNeutralSamplers = p["stripNeutralSamplers"];
	if (typeof p["note"] === "string") next.note = clip$1(p["note"], 1e3);
	if (isRecord$9(p["routing"])) next.routing = mergeRouting(next.routing, p["routing"]);
	if (isRecord$9(p["reasoning"])) next.reasoning = mergeReasoning(next.reasoning, p["reasoning"]);
	if (isRecord$9(p["memory"])) {
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
	if (!isRecord$9(raw)) return null;
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
	if (isRecord$9(p["maxPrice"])) {
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
function isRecord$9(value) {
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
function clip$1(value, max) {
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
function isRecord$8(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value) {
	return typeof value === "string" ? value : null;
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
/** A connection of the wire as the browser uses it; null when it is not one. */
function parseConnectionView(raw, now = Date.now()) {
	const config = normalizeConnection(raw, now);
	if (!config || !isRecord$8(raw)) return null;
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
	if (!isRecord$8(raw) || !isRecord$8(raw["proxy"])) return null;
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
	if (!isRecord$8(raw)) return null;
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
	if (!isRecord$8(raw) || typeof raw["ok"] !== "boolean") return null;
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
				const wire = isRecord$8(json) && isRecord$8(json["error"]) ? json["error"] : null;
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
			if (!parsedOk) return invalid("response (not JSON)");
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
		return value === null ? invalid(what) : {
			ok: true,
			data: value
		};
	}
	function viewOf(data) {
		return isRecord$8(data) ? parseConnectionView(data["connection"], now()) : null;
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
		async listConnections() {
			return map(await call("GET", "/connections"), (data) => {
				if (!isRecord$8(data) || !Array.isArray(data["connections"])) return null;
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
				if (!isRecord$8(data) || !Array.isArray(data["keys"])) return null;
				return data["keys"].map(parseKey).filter((key) => key !== null);
			}, "key list");
		},
		async addKey(label, value) {
			return map(await call("POST", "/keys", {
				label,
				value
			}), (data) => isRecord$8(data) ? parseKey(data["key"]) : null, "key");
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
function trimSlash$1(value) {
	return value.replace(/\/+$/, "");
}
/** true when the URL is NanoGPT's API base (either host) or a path under it. */
function isNanoGptUrl(value) {
	if (typeof value !== "string" || !value) return false;
	const url = trimSlash$1(value.trim()).toLowerCase();
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
function isRecord$7(value) {
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
		if (isRecord$7(value) && Array.isArray(value["profiles"])) return value;
		if (!create) return null;
		const fresh = {
			profiles: [],
			selectedProfile: null
		};
		store["connectionManager"] = fresh;
		return fresh;
	}
	function valid(profile) {
		return isRecord$7(profile) && typeof profile["id"] === "string";
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
function isRecord$6(value) {
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
			const list = isRecord$6(json) ? json[SECRET_KEY_CUSTOM] : null;
			if (list === null || list === void 0) return [];
			if (!Array.isArray(list)) return null;
			const states = [];
			for (const item of list) {
				if (!isRecord$6(item) || typeof item["id"] !== "string") continue;
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
				const written = isRecord$6(json) ? json["id"] : null;
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
function isRecord$5(value) {
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
	if (isRecord$5(parsed)) {
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
	if (Array.isArray(parsed) && parsed.every(isRecord$5)) {
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
function isRecord$4(value) {
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
		return result;
	}
	if (result.added.length > 0) request.body[field] = result.text;
	return result;
}
/**
* Adds headers through `custom_include_headers`; entries the user already set (any case) stay as they are. The result
* says which entries were `added`, which `kept` (the user's own), or why nothing could be done.
*/
function addIncludeHeaders(request, headers) {
	return mergeInto(request, "custom_include_headers", headers, true);
}
/** Adds body fields through `custom_include_body`; fields the user already set stay as they are. Result as above. */
function addIncludeBody(request, fields) {
	return mergeInto(request, "custom_include_body", fields, false);
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
var UNTOUCHED = {
	init: void 0,
	request: null
};
async function patchInit(state, scope, input, init) {
	if (state.hooks.size === 0 || typeof init?.body !== "string") return UNTOUCHED;
	if (methodOf(input, init) !== "POST" || !isGenerateUrl(urlOf(input), scope)) return UNTOUCHED;
	let body;
	try {
		body = JSON.parse(init.body);
	} catch {
		return UNTOUCHED;
	}
	if (!isRecord$4(body)) return UNTOUCHED;
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
	return {
		init: after === before ? void 0 : {
			...init,
			body: after
		},
		request
	};
}
/** Tells the observers about a response. Nothing an observer does (or throws) reaches the caller of fetch. */
function notifyObservers(state, request, response, startedAt) {
	for (const observer of [...state.observers]) {
		if (!state.observers.has(observer)) continue;
		try {
			const result = observer({
				request,
				response,
				startedAt
			});
			if (result instanceof Promise) result.catch((error) => state.log.debug("a response observer failed", error));
		} catch (error) {
			state.log.debug("a response observer failed", error);
		}
	}
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
			observers: /* @__PURE__ */ new Set(),
			active: true,
			log,
			wrapper: void 0
		};
		created.wrapper = async (input, init) => {
			let effective = init;
			let hooked = null;
			if (created.active) try {
				const patched = await patchInit(created, holder, input, init);
				effective = patched.init ?? init;
				hooked = patched.request;
			} catch (error) {
				created.log.warn("request hooks failed; the request goes on as it was", error);
			}
			const startedAt = Date.now();
			const response = await created.original.call(scope, input, effective);
			if (hooked && created.active && created.observers.size > 0) notifyObservers(created, hooked, response, startedAt);
			return response;
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
		observe(observer) {
			state.observers.add(observer);
			return () => {
				state.observers.delete(observer);
			};
		},
		hookCount: () => state.hooks.size,
		uninstall() {
			state.hooks.clear();
			state.observers.clear();
			state.active = false;
			if (holder.fetch === state.wrapper) holder.fetch = state.original;
			if (holder[STATE_KEY] === state) delete holder[STATE_KEY];
		}
	};
}
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
		routing: cloneRouting$1(r),
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
function cloneRouting$1(r) {
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
var EFFORT_ORDER = [
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
	const target = EFFORT_ORDER.indexOf(wanted);
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
	return best < 0 ? null : EFFORT_ORDER[best] ?? null;
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
	return best < 0 ? null : EFFORT_ORDER[best] ?? null;
}
function ladderIndex(level) {
	return EFFORT_ORDER.indexOf(level.trim().toLowerCase());
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
		...isRecord$3(body["usage"]) ? body["usage"] : {},
		include: true
	};
	if (body["stream"] === true) body["stream_options"] = {
		...isRecord$3(body["stream_options"]) ? body["stream_options"] : {},
		include_usage: true
	};
	const reasoning = planReasoning(input.model, connection.reasoning, hints);
	if (reasoning.reasoning !== null) {
		body["reasoning"] = {
			...isRecord$3(body["reasoning"]) ? body["reasoning"] : {},
			...reasoning.reasoning
		};
		delete body["reasoning_effort"];
	}
	const routing = safe ? subscriptionSafeOverrides(connection, input.model).routing : connection.routing;
	if (safe) {
		delete body["caching"];
		if (isRecord$3(body["provider"])) {
			const zdr = body["provider"]["zdr"];
			if (zdr === void 0) delete body["provider"];
			else body["provider"] = { zdr };
		}
	}
	const fixedRoute = input.providerSelection === false;
	const provider = buildProviderObject(routing, { zdrOnly: fixedRoute });
	if (provider !== null) body["provider"] = {
		...isRecord$3(body["provider"]) ? body["provider"] : {},
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
	if (isRecord$3(bias) && Object.keys(bias).length === 0) delete body["logit_bias"];
}
function isRecord$3(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
	if (!isRecord$2(raw)) return emptyUsage();
	const nested = raw["usage"];
	if (nested !== void 0 && !isRecord$2(nested)) return emptyUsage();
	const usage = isRecord$2(nested) ? nested : raw;
	const pricingRaw = raw["x_nanogpt_pricing"] ?? usage["x_nanogpt_pricing"];
	const pricing = isRecord$2(pricingRaw) ? pricingRaw : null;
	const promptDetails = isRecord$2(usage["prompt_tokens_details"]) ? usage["prompt_tokens_details"] : {};
	const completionDetails = isRecord$2(usage["completion_tokens_details"]) ? usage["completion_tokens_details"] : {};
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
function isRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
var DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/** A USD amount from a number or a decimal string; null for negatives, NaN, infinities and anything else. */
function parseCost(value) {
	let n;
	if (typeof value === "number") n = value;
	else if (typeof value === "string" && DECIMAL.test(value.trim())) n = Number(value.trim());
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
	if (!isRecord$2(json) || !isRecord$2(json["usage"])) return null;
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
	if (!resolved || !isRecord$2(original)) return {
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
		...isRecord$2(original["prompt_tokens_details"]) ? original["prompt_tokens_details"] : {},
		cached_tokens: usage.cachedTokens ?? 0
	};
	if (usage.cacheWriteTokens !== null) promptDetails["cache_write_tokens"] = usage.cacheWriteTokens;
	out["prompt_tokens_details"] = promptDetails;
	out["completion_tokens_details"] = {
		...isRecord$2(original["completion_tokens_details"]) ? original["completion_tokens_details"] : {},
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
	if (!isRecord$2(parsed)) return unchanged;
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
// src/host/usage-tap.ts
/** The longest error text kept in a record. */
var MAX_ERROR_LENGTH = 300;
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function clip(text) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > MAX_ERROR_LENGTH ? `${flat.slice(0, MAX_ERROR_LENGTH)}…` : flat;
}
/** The message of an OpenAI-style error body (`{ error: { message } }` or `{ error: "…" }`); null when it is none. */
function errorOf(json) {
	if (!isRecord$1(json)) return null;
	const error = json["error"];
	if (typeof error === "string" && error) return clip(error);
	if (isRecord$1(error)) {
		for (const key of [
			"message",
			"code",
			"type"
		]) {
			const value = error[key];
			if (typeof value === "string" && value) return clip(value);
		}
		return "error";
	}
	return null;
}
function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return;
	}
}
/** The `data:` lines of one raw SSE event are handled by rewriteSseEvent; this only asks whether it can carry usage. */
function mayCarryUsage(event) {
	return event.includes("usage") || event.includes("x_nanogpt_pricing");
}
function headerOf(response, name) {
	try {
		const value = response.headers.get(name);
		return value && value.trim() ? value.trim() : null;
	} catch {
		return null;
	}
}
async function readJson(clone, ctx) {
	const json = parseJson(await clone.text());
	return {
		usage: resolveUsage(json, ctx)?.usage ?? null,
		error: errorOf(json)
	};
}
async function readStream(clone, ctx) {
	const reader = clone.body?.getReader();
	if (!reader) return {
		usage: null,
		error: null
	};
	const splitter = new SseSplitter();
	let latest = null;
	let error = null;
	const take = (events) => {
		for (const event of events) {
			if (!mayCarryUsage(event)) continue;
			const resolved = rewriteSseEvent(event, ctx).resolved;
			if (resolved) latest = resolved.usage;
		}
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			take(splitter.feed(value));
		}
		take(splitter.flush());
	} catch (cause) {
		take(splitter.flush());
		error = cause instanceof Error && cause.name === "AbortError" ? "client_aborted" : "stream_error";
	}
	return {
		usage: latest,
		error
	};
}
/** The Response of a stream: server-sent events. */
function isEventStream(contentType) {
	return contentType.toLowerCase().includes("text/event-stream");
}
/**
* Observes one response and emits its UsageRecord. Resolves when the whole body has been read (a stream: when it ended);
* never rejects. The `clone()` happens before the first `await`, so it is taken before ST can start reading.
*/
async function tapUsage(args) {
	try {
		const { response, info } = args;
		const clone = response.clone();
		const status = response.status;
		const requestId = headerOf(response, "x-request-id");
		const contentType = headerOf(response, "content-type") ?? "";
		const shim = {
			model: args.model,
			billingModeForced: info.billingModeForced,
			explicitRouting: info.explicitRouting,
			requestId
		};
		let outcome;
		let stream = args.stream;
		if (!response.ok) {
			const text = await clone.text();
			outcome = {
				usage: null,
				error: errorOf(parseJson(text)) ?? (clip(text) || `http_${status}`)
			};
		} else if (isEventStream(contentType) || args.stream && !contentType.toLowerCase().includes("json")) {
			stream = true;
			outcome = await readStream(clone, shim);
		} else {
			stream = false;
			outcome = await readJson(clone, shim);
		}
		const record = buildUsageRecord({
			at: args.startedAt,
			connectionId: info.connectionId,
			modelId: info.modelId,
			model: args.model,
			billingModeForced: info.billingModeForced,
			explicitRouting: info.explicitRouting,
			usage: outcome.usage,
			requestId,
			latencyMs: Math.max(0, args.now() - args.startedAt),
			status,
			stream,
			consumer: args.consumer,
			error: outcome.error
		});
		args.emit(record);
	} catch (error) {
		args.log.debug("the usage tap failed; no record was written", error);
	}
}
// src/host/direct-mode.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function trimSlash(value) {
	return value.replace(/\/+$/, "").toLowerCase();
}
var NANOGPT_BASES = [NANOGPT_API_BASE, NANOGPT_API_BASE_FALLBACK].map(trimSlash);
/**
* The connection a request to NanoGPT belongs to, or null (the request is somebody else's and stays as it is).
* 1. The `secret_id` of the request is the direct key of exactly one connection.
* 2. No secret id came along, `custom_url` is the NanoGPT base itself, and exactly one connection that runs direct has the
*    requested model as its model. A secret id that is not ours always means "not ours": a user's own NanoGPT profile.
*/
function matchDirectConnection(request, connections, directSecrets) {
	if (request.secretId) {
		for (const [connectionId, secretId] of Object.entries(directSecrets)) {
			if (secretId !== request.secretId) continue;
			const found = connections.find((ref) => ref.config.id === connectionId);
			if (found) return found.config;
		}
		return null;
	}
	const url = request.body["custom_url"];
	if (typeof url !== "string" || !NANOGPT_BASES.includes(trimSlash(url.trim()))) return null;
	const model = request.body["model"];
	if (typeof model !== "string" || !model.trim()) return null;
	const matches = connections.filter((ref) => ref.effectiveMode === "direct" && ref.config.modelId === model.trim());
	return matches.length === 1 ? matches[0]?.config ?? null : null;
}
/** Same JSON value (key order does not matter). */
function sameValue(a, b) {
	if (a === b) return true;
	if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
	if (isRecord(a) && isRecord(b)) {
		const keys = Object.keys(a);
		return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameValue(a[key], b[key]));
	}
	return false;
}
/** What separates the planned body from the body ST built. Pure. */
function planDifference(original, planned) {
	const set = {};
	for (const [key, value] of Object.entries(planned)) if (!(key in original) || !sameValue(original[key], value)) set[key] = value;
	return {
		set,
		remove: Object.keys(original).filter((key) => !(key in planned))
	};
}
/** Runs planUpstream for a request of a connection, with what the catalog knows. */
function planDirectRequest(deps, connection, request) {
	const hints = hintsOf(request);
	const sent = planUpstream({
		connection,
		model: null,
		body: { model: request.body["model"] },
		hints,
		providerSelection: null
	}).model;
	const model = deps.model(sent);
	const selection = deps.providers(model?.id ?? sent)?.supportsProviderSelection ?? null;
	return {
		plan: planUpstream({
			connection,
			model,
			body: request.body,
			hints,
			providerSelection: selection
		}),
		hints,
		model
	};
}
/** Writes a plan into the request: the difference through the include fields, the dropped fields removed. */
function applyPlan(request, plan) {
	const { set, remove } = planDifference(request.body, plan.body);
	for (const key of remove) delete request.body[key];
	if (Object.keys(set).length > 0) {
		const result = addIncludeBody(request, set);
		if (result.ok && result.kept.length > 0) request.log.debug(`custom_include_body already sets ${result.kept.join(", ")}; the user's value stays`);
	}
	if (Object.keys(plan.headers).length > 0) addIncludeHeaders(request, plan.headers);
}
/** The two halves of direct mode: the request hook (plan) and the response observer (usage tap). */
function createDirectMode(deps) {
	const now = deps.now ?? Date.now;
	const hook = (request) => {
		if (request.target?.kind !== "direct") return;
		const connection = matchDirectConnection(request, deps.connections(), deps.directSecrets());
		if (!connection) {
			request.log.debug("a request to NanoGPT that is not a Nanovia direct connection; left alone");
			return;
		}
		const { plan, model } = planDirectRequest(deps, connection, request);
		applyPlan(request, plan);
		request.direct = {
			connectionId: connection.id,
			modelId: plan.model,
			billingModeForced: connection.billing === "paygo",
			explicitRouting: plan.billing.reasons.some((reason) => reason.code === "routing.explicit")
		};
		const warnings = plan.warnings.map((warning) => warning.code);
		request.log.debug(`direct plan for ${connection.id}: ${plan.model}, ${plan.billing.outcome}` + (model ? "" : ", model not in the catalog") + (warnings.length > 0 ? `, warnings: ${warnings.join(", ")}` : ""));
	};
	const observer = ({ request, response, startedAt }) => {
		const info = request.direct;
		if (!info) return;
		tapUsage({
			response,
			info,
			consumer: request.consumer,
			stream: request.body["stream"] === true,
			startedAt,
			now,
			model: deps.model(info.modelId),
			emit: deps.emit,
			log: deps.log
		});
	};
	return {
		hook,
		observer
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
function patchOf$1(config) {
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
				const result = await plugin.updateConnection(id, patchOf$1(local));
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
			const result = onPlugin ? await plugin.updateConnection(draft.id, patchOf$1(draft)) : await plugin.createConnection({ ...draft });
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
// src/core/catalog.ts
/** A store that knows nothing: the default until a real one is wired in. */
function createEmptyCatalogStore() {
	return {
		models: () => [],
		model: () => null,
		providers: () => null,
		ensureProviders: async () => null,
		hints: () => [],
		status: () => ({
			loaded: false,
			fetchedAt: null,
			source: null,
			error: null
		}),
		refresh: async () => {},
		onChange: () => () => {}
	};
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
		"ui.general.debugHint": "Prints Nanovia details to the browser console. Keys and tokens are never printed."
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
		"ui.general.debugHint": "Пишет подробности работы Nanovia в консоль браузера. Ключи и токены не выводятся никогда."
	}
};
// src/features/connections/view-model.ts
var CONNECTION_MODES = [
	"auto",
	"plugin",
	"direct"
];
var BILLING_MODES$1 = [
	"auto",
	"subscription",
	"paygo"
];
var REASONING_POLICIES$1 = [
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
	const billingOptions = BILLING_MODES$1.map((value) => ({
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
	const policyOptions = REASONING_POLICIES$1.map((value) => ({
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
		field(t("connections.form.model"), textInput({
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
/** Tab «Connections»: the plugin status, the connections and their Connection Manager profiles. */
var connectionsFeature = {
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
};
// src/features/keys/strings.ts
var KEYS_STRINGS = {
	en: {
		"keys.tab": "Keys",
		"keys.title": "NanoGPT keys",
		"keys.refresh": "Refresh",
		"keys.notice.refreshed": "Refreshed.",
		"keys.loading": "Loading the keys…",
		"keys.none": "There is no NanoGPT key yet. Without one the plugin cannot reach NanoGPT: add your key below.",
		"keys.active": "Active",
		"keys.active.hint": "Connections that name no key use this one.",
		"keys.usedBy": "Used by: {names}",
		"keys.usedBy.byDefault": "{name} (by default)",
		"keys.unused": "No connection uses this key.",
		"keys.action.check": "Check balance",
		"keys.action.check.hint": "Asks NanoGPT what is left on this key.",
		"keys.action.delete": "Delete",
		"keys.check.running": "Checking…",
		"keys.check.ok": "Balance: {balance}",
		"keys.check.okNoBalance": "The key works; NanoGPT did not report a balance.",
		"keys.check.failed": "The check failed: {reason}",
		"keys.check.unknown": "no reason given",
		"keys.confirm.title": "Delete key",
		"keys.confirm.delete": "Delete the key \"{name}\" from SillyTavern’s secret store? This cannot be undone.",
		"keys.confirm.deleteUsed": "{count} connection(s) use it and will need another key.",
		"keys.delete.done": "Key deleted.",
		"keys.delete.failed": "The key was not deleted: {message}",
		"keys.add.title": "Add a key",
		"keys.add.name": "Key name",
		"keys.add.value": "Paste the key here",
		"keys.add.save": "Save key",
		"keys.add.hint": "The key goes to the plugin once and is never shown again, only its last characters.",
		"keys.add.defaultLabel": "NanoGPT key",
		"keys.add.empty": "Paste a key first.",
		"keys.add.added": "Key added.",
		"keys.add.failed": "The key was not added: {message}",
		"keys.down.title": "Plugin is not answering",
		"keys.down.hint": "Keys live in the Nanovia plugin. In direct mode a connection keeps its own key (set it in the Connections tab); the keys here are for connections that go through the plugin.",
		"keys.down.not_installed": "SillyTavern does not know the Nanovia plugin: it is not installed or not enabled.",
		"keys.down.unreachable": "There was no answer from the SillyTavern server.",
		"keys.down.timeout": "The plugin did not answer in time.",
		"keys.down.forbidden": "SillyTavern refused the request (session or CSRF check). Reload the page.",
		"keys.down.other": "The keys could not be loaded: {message}"
	},
	ru: {
		"keys.tab": "Ключи",
		"keys.title": "Ключи NanoGPT",
		"keys.refresh": "Обновить",
		"keys.notice.refreshed": "Обновлено.",
		"keys.loading": "Загружаю ключи…",
		"keys.none": "Ключа NanoGPT пока нет. Без него плагин не достучится до NanoGPT: добавьте свой ключ ниже.",
		"keys.active": "Активный",
		"keys.active.hint": "Подключения, у которых ключ не указан, используют этот.",
		"keys.usedBy": "Используют: {names}",
		"keys.usedBy.byDefault": "{name} (по умолчанию)",
		"keys.unused": "Ни одно подключение этот ключ не использует.",
		"keys.action.check": "Проверить баланс",
		"keys.action.check.hint": "Спрашивает у NanoGPT, сколько осталось на этом ключе.",
		"keys.action.delete": "Удалить",
		"keys.check.running": "Проверяю…",
		"keys.check.ok": "Баланс: {balance}",
		"keys.check.okNoBalance": "Ключ работает; NanoGPT не сообщил баланс.",
		"keys.check.failed": "Проверка не удалась: {reason}",
		"keys.check.unknown": "причина не указана",
		"keys.confirm.title": "Удаление ключа",
		"keys.confirm.delete": "Удалить ключ «{name}» из хранилища секретов SillyTavern? Это нельзя отменить.",
		"keys.confirm.deleteUsed": "Его используют подключений: {count}; им понадобится другой ключ.",
		"keys.delete.done": "Ключ удалён.",
		"keys.delete.failed": "Ключ не удалён: {message}",
		"keys.add.title": "Добавить ключ",
		"keys.add.name": "Название ключа",
		"keys.add.value": "Вставьте ключ сюда",
		"keys.add.save": "Сохранить ключ",
		"keys.add.hint": "Ключ уходит в плагин один раз и больше не показывается, только его последние символы.",
		"keys.add.defaultLabel": "Ключ NanoGPT",
		"keys.add.empty": "Сначала вставьте ключ.",
		"keys.add.added": "Ключ добавлен.",
		"keys.add.failed": "Ключ не добавлен: {message}",
		"keys.down.title": "Плагин не отвечает",
		"keys.down.hint": "Ключи хранятся в плагине Nanovia. В прямом режиме подключение держит собственный ключ (его задают на вкладке «Подключения»); ключи здесь нужны подключениям, которые идут через плагин.",
		"keys.down.not_installed": "SillyTavern не знает плагин Nanovia: он не установлен или не включён.",
		"keys.down.unreachable": "Сервер SillyTavern не ответил.",
		"keys.down.timeout": "Плагин не ответил вовремя.",
		"keys.down.forbidden": "SillyTavern отклонил запрос (проверка сессии или CSRF). Перезагрузите страницу.",
		"keys.down.other": "Не удалось загрузить ключи: {message}"
	}
};
// src/features/keys/view-model.ts
/**
* The keys with the connections that use them, the active key first. A direct-mode connection keeps its own key in
* SillyTavern's secret store and never uses the plugin's keys.
*/
function keyRows(keys, connections) {
	return keys.map((key) => {
		const users = [];
		for (const connection of connections) {
			if (connection.mode === "direct") continue;
			if (connection.keyId === key.id) users.push({
				name: connection.name,
				viaActive: false
			});
			else if (connection.keyId === null && key.active) users.push({
				name: connection.name,
				viaActive: true
			});
		}
		return {
			key,
			users
		};
	}).sort((a, b) => Number(b.key.active) - Number(a.key.active) || a.key.label.localeCompare(b.key.label, void 0, { numeric: true }));
}
/** What a key is called in a sentence: its label, or the masked value when it has none. */
function keyName(key) {
	return key.label.trim() || key.masked;
}
/** "Used by: Main, Backup (by default)"; null when nothing uses the key. */
function usersText(users, t) {
	if (users.length === 0) return null;
	return t("keys.usedBy", { names: users.map((user) => user.viaActive ? t("keys.usedBy.byDefault", { name: user.name }) : user.name).join(", ") });
}
function confirmDeleteText(row, t) {
	const base = t("keys.confirm.delete", { name: keyName(row.key) });
	return row.users.length > 0 ? `${base}\n${t("keys.confirm.deleteUsed", { count: row.users.length })}` : base;
}
/** The result of "check balance" in words. */
function checkLine(check, t) {
	if (!check.ok) return {
		kind: "error",
		text: t("keys.check.failed", { reason: check.error ?? t("keys.check.unknown") })
	};
	const parts = [];
	if (check.usdBalance !== null) parts.push(`$${check.usdBalance}`);
	if (check.nanoBalance !== null) parts.push(`${check.nanoBalance} XNO`);
	if (parts.length === 0) return {
		kind: "ok",
		text: t("keys.check.okNoBalance")
	};
	return {
		kind: "ok",
		text: t("keys.check.ok", { balance: parts.join(" · ") })
	};
}
/** Why the list of keys could not be loaded. */
function loadFailure(error, t) {
	const down = isPluginDown(error) || error.code === "forbidden";
	if ([
		"not_installed",
		"unreachable",
		"timeout",
		"forbidden"
	].includes(error.code)) return {
		down,
		text: t(`keys.down.${error.code}`)
	};
	return {
		down,
		text: t("keys.down.other", { message: error.message })
	};
}
// src/features/keys/view.ts
function renderKeysTab(root, ctx) {
	const t = ctx.t;
	let keys = null;
	let failure = null;
	let loading = true;
	let disposed = false;
	/** Balance checks by key id; 'pending' while one runs. Lives as long as the tab. */
	const checks = /* @__PURE__ */ new Map();
	const headHost = el("div", { class: "nanovia-row nanovia-keys-head" });
	const noticeHost = el("div", {
		class: "nanovia-notice-host",
		attrs: { "aria-live": "polite" }
	});
	const listHost = el("div", { class: "nanovia-keys-body" });
	const addHost = el("div", { class: "nanovia-keys-addhost" });
	root.append(headHost, noticeHost, listHost, addHost);
	function notify(kind, text) {
		clear(noticeHost);
		noticeHost.appendChild(el("div", {
			class: ["nanovia-notice", `nanovia-notice-${kind}`],
			text
		}));
	}
	function drawHead() {
		clear(headHost);
		headHost.append(el("b", { text: t("keys.title") }), button({
			label: t("keys.refresh"),
			icon: "rotate",
			kind: "ghost",
			onClick: async () => {
				await load();
				if (failure === null) notify("ok", t("keys.notice.refreshed"));
			}
		}));
	}
	function drawCard(row) {
		const { key } = row;
		const users = usersText(row.users, t);
		const check = checks.get(key.id);
		const line = check && check !== "pending" ? checkLine(check, t) : null;
		return el("div", {
			class: "nanovia-key-card",
			data: { key: key.id }
		}, [
			el("div", { class: "nanovia-row" }, [
				el("b", {
					class: "nanovia-key-name",
					text: keyName(key)
				}),
				el("code", {
					class: "nanovia-key-masked nanovia-muted",
					text: key.masked
				}),
				key.active ? chip(t("keys.active"), "ok", t("keys.active.hint")) : null
			]),
			el("div", {
				class: "nanovia-muted nanovia-key-users",
				text: users ?? t("keys.unused")
			}),
			line ? el("div", {
				class: ["nanovia-key-check", line.kind === "ok" ? "nanovia-ok-text" : "nanovia-error-text"],
				text: line.text
			}) : null,
			check === "pending" ? el("div", {
				class: "nanovia-muted nanovia-key-check",
				text: t("keys.check.running")
			}) : null,
			el("div", { class: "nanovia-row" }, [button({
				label: t("keys.action.check"),
				icon: "wallet",
				title: t("keys.action.check.hint"),
				disabled: check === "pending",
				onClick: () => runCheck(key)
			}), button({
				label: t("keys.action.delete"),
				icon: "trash",
				kind: "danger",
				onClick: () => remove(row)
			})])
		]);
	}
	function drawList() {
		clear(listHost);
		if (failure) {
			listHost.appendChild(el("div", { class: "nanovia-banner nanovia-banner-down" }, [
				el("div", { class: "nanovia-row" }, [chip(t("keys.down.title"), "error")]),
				el("div", {
					class: "nanovia-error-text",
					text: failure.text
				}),
				el("div", {
					class: "nanovia-muted",
					text: t("keys.down.hint")
				})
			]));
			return;
		}
		if (keys === null) {
			listHost.appendChild(el("div", {
				class: "nanovia-muted",
				text: loading ? t("keys.loading") : ""
			}));
			return;
		}
		if (keys.length === 0) {
			listHost.appendChild(el("div", {
				class: "nanovia-notice nanovia-notice-warn nanovia-no-keys",
				text: t("keys.none")
			}));
			return;
		}
		const configs = ctx.connections.list().map((entry) => entry.config);
		listHost.appendChild(el("div", { class: "nanovia-key-list" }, keyRows(keys, configs).map(drawCard)));
	}
	/** The add form is built once (so what is typed survives a redraw of the list) and hidden while the plugin is down. */
	function buildAddForm() {
		let keyLabel = "";
		let keyValue = "";
		const nameInput = textInput({
			value: "",
			label: t("keys.add.name"),
			placeholder: t("keys.add.name"),
			maxLength: 80,
			onInput: (value) => void (keyLabel = value)
		});
		const valueInput = textInput({
			value: "",
			type: "password",
			label: t("keys.add.value"),
			placeholder: t("keys.add.value"),
			onInput: (value) => void (keyValue = value)
		});
		const submit = button({
			label: t("keys.add.save"),
			icon: "key",
			kind: "primary",
			onClick: async () => {
				const value = keyValue;
				const label = keyLabel.trim() || t("keys.add.defaultLabel");
				keyValue = "";
				valueInput.value = "";
				if (!value.trim()) {
					notify("error", t("keys.add.empty"));
					return;
				}
				const result = await ctx.plugin.addKey(label, value);
				if (!result.ok) {
					notify("error", t("keys.add.failed", { message: result.error.message }));
					return;
				}
				keyLabel = "";
				nameInput.value = "";
				await load();
				notify("ok", t("keys.add.added"));
				ctx.connections.refresh();
			}
		});
		addHost.appendChild(el("details", {
			class: "nanovia-details",
			attrs: { open: true }
		}, [el("summary", { text: t("keys.add.title") }), el("div", { class: "nanovia-key-add" }, [
			nameInput,
			valueInput,
			submit,
			el("div", {
				class: "nanovia-field-hint",
				text: t("keys.add.hint")
			})
		])]));
	}
	function showAddForm() {
		addHost.hidden = failure !== null;
	}
	async function load() {
		loading = true;
		if (keys === null) drawList();
		const result = await ctx.plugin.listKeys();
		if (disposed) return;
		loading = false;
		if (result.ok) {
			keys = result.data;
			failure = null;
		} else {
			keys = null;
			failure = loadFailure(result.error, t);
		}
		drawList();
		showAddForm();
	}
	async function runCheck(key) {
		checks.set(key.id, "pending");
		drawList();
		const result = await ctx.plugin.checkKey(key.id);
		if (disposed) return;
		checks.set(key.id, result.ok ? result.data : {
			ok: false,
			usdBalance: null,
			nanoBalance: null,
			error: result.error.message
		});
		drawList();
	}
	async function remove(row) {
		if (!await ctx.host.confirm(confirmDeleteText(row, t), t("keys.confirm.title"))) return;
		const result = await ctx.plugin.deleteKey(row.key.id);
		if (!result.ok) {
			notify("error", t("keys.delete.failed", { message: result.error.message }));
			return;
		}
		checks.delete(row.key.id);
		await load();
		notify("ok", t("keys.delete.done"));
		ctx.connections.refresh();
	}
	const off = ctx.connections.onChange(() => {
		if (!disposed) drawList();
	});
	drawHead();
	buildAddForm();
	showAddForm();
	drawList();
	load();
	return () => {
		disposed = true;
		off();
		checks.clear();
	};
}
// src/features/keys/index.ts
var KEYS_FEATURE_ID = "keys";
var KEYS_TAB_ID = "keys";
/** Tab «Keys»: the NanoGPT keys the plugin holds, which connections use them, balance check, add and delete. */
var keysFeature = {
	id: KEYS_FEATURE_ID,
	init(ctx) {
		ctx.i18n.register(KEYS_STRINGS);
		return ctx.panel.registerTab({
			id: KEYS_TAB_ID,
			titleKey: "keys.tab",
			order: 300,
			render: (root, tabCtx) => renderKeysTab(root, tabCtx)
		});
	}
};
// src/core/billing-view.ts
/** `order, sort` (the `fields` parameter of a reason) as a list of labels in the interface language. */
function fieldList(value, t) {
	return value.split(",").map((part) => part.trim()).filter((part) => part.length > 0).map((name) => labelOrName(`billing.field.${name}`, name, t)).join(", ");
}
function labelOrName(key, fallback, t) {
	const text = t(key);
	return text === key ? fallback : text;
}
/** Label of one routing setting by its RoutingConfig name (`order` -> "Provider order"). */
function routingFieldLabel(name, t) {
	return labelOrName(`billing.field.${name}`, name, t);
}
function paramsOf(source, t) {
	const params = { markup: 5 };
	for (const [key, value] of Object.entries(source ?? {})) params[key] = typeof value === "boolean" ? String(value) : value;
	if (typeof params["fields"] === "string") params["fields"] = fieldList(params["fields"], t);
	for (const key of ["requested", "applied"]) {
		const effort = params[key];
		if (typeof effort === "string") params[key] = labelOrName(`billing.effort.${effort}`, effort, t);
	}
	return params;
}
function textOf(prefix, item, t) {
	const key = `${prefix}.${item.code}`;
	const text = t(key, paramsOf(item.params, t));
	return text === key ? item.code : text;
}
/** One reason of `BillingImpact.reasons` as a sentence. */
function billingReasonText(reason, t) {
	return textOf("billing.reason", reason, t);
}
/** One warning of `UpstreamPlan.warnings` as a sentence. */
function planWarningText(warning, t) {
	return textOf("plan.warning", warning, t);
}
/** "Subscription" / "Pay as you go" / "Unknown". */
function billingOutcomeLabel(outcome, t) {
	return t(`billing.outcome.${outcome}`);
}
/** Names of the settings the proxy strips in subscription-safe mode, as labels. */
function strippedLabels(stripped, t) {
	return stripped.map((name) => routingFieldLabel(name, t));
}
var BILLING_STRINGS = {
	en: {
		"billing.outcome.subscription": "Subscription",
		"billing.outcome.paygo": "Pay as you go",
		"billing.outcome.unknown": "Not known",
		"billing.reason.billing.forced": "This connection is set to pay as you go: every request is billed per token.",
		"billing.reason.model.notIncluded": "{model} is not included in the subscription, so it is billed per token.",
		"billing.reason.billing.modelNotCoverable": "Subscription only cannot be kept: {model} is outside the subscription.",
		"billing.reason.routing.explicit": "Explicit routing ({fields}) is billed pay as you go with about {markup}% markup and leaves the subscription.",
		"billing.reason.routing.unsupportedByModel": "This model runs on a fixed route: the routing settings ({fields}) are ignored, so they change nothing.",
		"billing.reason.routing.zdrOnly": "Zero data retention only narrows the platform’s own routing; the billing stays as it is.",
		"billing.reason.search.billedSeparately": "Web search (:online) is billed separately.",
		"billing.reason.memory.billedSeparately": "Context Memory is billed separately.",
		"billing.reason.subscription.multiplier": "This model counts {value}× of the input tokens against the subscription quota.",
		"plan.warning.reasoning.modelUnknown": "The model is not in the catalog, so the reasoning effort is sent as asked, unchecked.",
		"plan.warning.reasoning.cannotDisable": "{model} always reasons (efforts: {efforts}). Nanovia sends the lowest effort and hides the thoughts.",
		"plan.warning.reasoning.effortAdjusted": "The model does not offer the effort \"{requested}\"; \"{applied}\" is sent instead.",
		"plan.warning.routing.preferenceNeedsSort": "A preferred latency or throughput does nothing without a sort. Pick a sort.",
		"plan.warning.routing.onlyAndOrder": "\"Only these providers\" already limits the candidates; the provider order is redundant.",
		"billing.effort.none": "none",
		"billing.effort.minimal": "minimal",
		"billing.effort.low": "low",
		"billing.effort.medium": "medium",
		"billing.effort.high": "high",
		"billing.effort.xhigh": "extra high",
		"billing.effort.max": "max",
		"billing.field.order": "provider order",
		"billing.field.only": "only these providers",
		"billing.field.ignore": "ignored providers",
		"billing.field.sort": "sort",
		"billing.field.quantizations": "precision allowlist",
		"billing.field.minQuantization": "minimum precision",
		"billing.field.maxPrice": "price cap",
		"billing.field.allowFallbacks": "no fallbacks",
		"billing.field.requireParameters": "require parameters",
		"billing.field.preferredMaxLatency": "preferred latency",
		"billing.field.preferredMinThroughput": "preferred throughput",
		"billing.field.cachingRoute": "caching route"
	},
	ru: {
		"billing.outcome.subscription": "Подписка",
		"billing.outcome.paygo": "Оплата за токены",
		"billing.outcome.unknown": "Неизвестно",
		"billing.reason.billing.forced": "Подключение настроено на оплату за токены: каждый запрос оплачивается отдельно.",
		"billing.reason.model.notIncluded": "{model} не входит в подписку, поэтому оплачивается за токены.",
		"billing.reason.billing.modelNotCoverable": "Режим «только подписка» не удержать: {model} вне подписки.",
		"billing.reason.routing.explicit": "Явная маршрутизация ({fields}) оплачивается за токены с наценкой около {markup}% и уводит запрос из подписки.",
		"billing.reason.routing.unsupportedByModel": "Модель работает по фиксированному маршруту: настройки маршрутизации ({fields}) игнорируются и ни на что не влияют.",
		"billing.reason.routing.zdrOnly": "Нулевое хранение данных лишь сужает собственный выбор платформы; оплата не меняется.",
		"billing.reason.search.billedSeparately": "Веб-поиск (:online) оплачивается отдельно.",
		"billing.reason.memory.billedSeparately": "Context Memory оплачивается отдельно.",
		"billing.reason.subscription.multiplier": "Эта модель списывает {value}× входных токенов с квоты подписки.",
		"plan.warning.reasoning.modelUnknown": "Модели нет в каталоге, поэтому уровень рассуждений отправляется как запрошен, без проверки.",
		"plan.warning.reasoning.cannotDisable": "{model} рассуждает всегда (уровни: {efforts}). Nanovia отправит самый низкий уровень и скроет мысли.",
		"plan.warning.reasoning.effortAdjusted": "Модель не поддерживает уровень «{requested}»; вместо него отправляется «{applied}».",
		"plan.warning.routing.preferenceNeedsSort": "Желаемая задержка или скорость ничего не делают без сортировки. Выберите сортировку.",
		"plan.warning.routing.onlyAndOrder": "«Только эти провайдеры» уже ограничивает выбор; порядок провайдеров лишний.",
		"billing.effort.none": "нет",
		"billing.effort.minimal": "минимальный",
		"billing.effort.low": "низкий",
		"billing.effort.medium": "средний",
		"billing.effort.high": "высокий",
		"billing.effort.xhigh": "очень высокий",
		"billing.effort.max": "максимальный",
		"billing.field.order": "порядок провайдеров",
		"billing.field.only": "только эти провайдеры",
		"billing.field.ignore": "исключённые провайдеры",
		"billing.field.sort": "сортировка",
		"billing.field.quantizations": "список точностей",
		"billing.field.minQuantization": "минимальная точность",
		"billing.field.maxPrice": "потолок цены",
		"billing.field.allowFallbacks": "без запасных вариантов",
		"billing.field.requireParameters": "требовать параметры",
		"billing.field.preferredMaxLatency": "желаемая задержка",
		"billing.field.preferredMinThroughput": "желаемая скорость",
		"billing.field.cachingRoute": "маршрут с кешем"
	}
};
// src/features/routing/strings.ts
var ROUTING_STRINGS = {
	en: {
		"routing.tab": "Routing",
		"routing.connection": "Connection",
		"routing.save": "Save",
		"routing.revert": "Revert",
		"routing.dirty": "Unsaved changes",
		"routing.empty": "No connections yet. Create one in the Connections tab, then set its routing here.",
		"routing.confirm.title": "Unsaved changes",
		"routing.confirm.discard": "Discard the unsaved changes of this connection?",
		"routing.notice.saved": "Saved.",
		"routing.notice.reverted": "Changes discarded.",
		"routing.header.badge.hint": "What the settings below do to the billing of a request (live).",
		"routing.section.routing": "Routing",
		"routing.section.routing.hint": "NanoGPT’s provider preferences, OpenRouter style. Most of them select a host explicitly, which NanoGPT bills pay as you go instead of through the subscription.",
		"routing.enabled": "Send routing preferences",
		"routing.enabled.hint": "Off: nothing is sent and NanoGPT routes the request itself.",
		"routing.offNote": "Routing is off: the settings below are kept but nothing is sent.",
		"routing.fixedRoute": "This model runs on a fixed route: NanoGPT ignores the routing settings, only zero data retention is sent.",
		"routing.needsSortNow": "A preferred latency or throughput does nothing until a sort is chosen.",
		"routing.providers.placeholder": "Type a provider id, press Enter",
		"routing.providers.remove": "Remove {id}",
		"routing.field.noLimit": "No limit",
		"routing.disabled.subscriptionSafe": "Locked: subscription-only mode would strip this setting.",
		"routing.lockedNote": "This connection is subscription-only: the settings that leave the subscription are locked and Nanovia strips them from every request. Change the billing mode to use them.",
		"routing.field.order": "Provider order",
		"routing.field.order.hint": "Providers are tried in this order.",
		"routing.field.only": "Only these providers",
		"routing.field.only.hint": "No other provider is used, even when these fail.",
		"routing.field.ignore": "Never these providers",
		"routing.field.ignore.hint": "These providers are skipped.",
		"routing.field.sort": "Sort",
		"routing.sort.default": "Platform default",
		"routing.sort.price": "Cheapest first",
		"routing.sort.throughput": "Fastest throughput",
		"routing.sort.latency": "Lowest latency",
		"routing.sort.speed": "Speed",
		"routing.field.sort.hint": "How candidate providers are ranked.",
		"routing.field.quantizations": "Allowed precisions",
		"routing.field.quantizations.hint": "Only hosts that serve the weights in one of the ticked precisions.",
		"routing.field.minQuantization": "Minimum precision",
		"routing.field.minQuantization.none": "No floor",
		"routing.field.minQuantization.hint": "Hosts below this precision are skipped.",
		"routing.field.maxPrice": "Price cap (USD per 1M tokens)",
		"routing.field.maxPrice.prompt": "Prompt",
		"routing.field.maxPrice.completion": "Completion",
		"routing.field.maxPrice.hint": "Empty means no cap. Hosts above the cap are skipped.",
		"routing.field.allowFallbacks": "Allow fallbacks",
		"routing.field.allowFallbacks.hint": "Off: the request fails instead of moving to another provider.",
		"routing.field.requireParameters": "Require parameter support",
		"routing.field.requireParameters.hint": "Only hosts that support every parameter of the request.",
		"routing.field.zdr": "Zero data retention only",
		"routing.field.zdr.hint": "Only endpoints that keep no copy of your prompts.",
		"routing.field.zdr.keeps": "Keeps the subscription: it only narrows the platform’s own routing.",
		"routing.field.preferredMaxLatency": "Preferred latency (seconds)",
		"routing.field.preferredMaxLatency.hint": "Needs a sort: it is a preference the sort works with.",
		"routing.field.preferredMinThroughput": "Preferred throughput (tokens per second)",
		"routing.field.preferredMinThroughput.hint": "Needs a sort: it is a preference the sort works with.",
		"routing.field.cachingRoute": "Route for prompt caching",
		"routing.field.cachingRoute.hint": "Only providers with prompt caching; later requests stay on the same one.",
		"routing.bypass.order": "Leaves the subscription: a provider order is an explicit choice, pay as you go plus about {markup}%.",
		"routing.bypass.only": "Leaves the subscription: limiting to named providers is pay as you go plus about {markup}%.",
		"routing.bypass.ignore": "Leaves the subscription: excluding providers counts as routing, pay as you go plus about {markup}%.",
		"routing.bypass.sort": "Leaves the subscription: any sort but the default is pay as you go plus about {markup}%.",
		"routing.bypass.quantizations": "Leaves the subscription: choosing precisions selects hosts, pay as you go plus about {markup}%.",
		"routing.bypass.minQuantization": "Leaves the subscription: a precision floor selects hosts, pay as you go plus about {markup}%.",
		"routing.bypass.maxPrice": "Leaves the subscription: a price cap selects hosts, pay as you go plus about {markup}%.",
		"routing.bypass.allowFallbacks": "Leaves the subscription when fallbacks are off: pay as you go plus about {markup}%.",
		"routing.bypass.requireParameters": "Leaves the subscription: requiring parameters selects hosts, pay as you go plus about {markup}%.",
		"routing.bypass.preferredMaxLatency": "Leaves the subscription: a latency preference is routing, pay as you go plus about {markup}%.",
		"routing.bypass.preferredMinThroughput": "Leaves the subscription: a throughput preference is routing, pay as you go plus about {markup}%.",
		"routing.bypass.cachingRoute": "May leave the subscription: cache routing pins the host (to be confirmed live).",
		"routing.section.billing": "Billing",
		"routing.section.billing.hint": "Whether requests stay inside your NanoGPT subscription.",
		"routing.billing.mode": "Billing mode",
		"routing.billing.auto": "Automatic",
		"routing.billing.subscription": "Subscription only",
		"routing.billing.paygo": "Pay as you go",
		"routing.billing.auto.hint": "Any setting is allowed; the verdict below shows what leaves the subscription.",
		"routing.billing.subscription.hint": "Settings that would bill outside the subscription are locked, and Nanovia strips them from every request. Zero data retention stays.",
		"routing.billing.paygo.hint": "Always billed pay as you go, whatever the model offers.",
		"routing.verdict.title": "Verdict",
		"routing.verdict.markup": "+{percent}% markup",
		"routing.verdict.safe": "Nothing leaves the subscription",
		"routing.verdict.safe.hint": "No setting of this connection bypasses the subscription.",
		"routing.verdict.modelUnknown": "The catalog does not know this model yet, so the outcome is a guess. It improves when the catalog loads.",
		"routing.verdict.subscription": "Requests are covered by the subscription.",
		"routing.verdict.paygo": "Requests are billed per token.",
		"routing.verdict.unknown": "The billing of these requests cannot be told from the settings alone.",
		"routing.verdict.stripped": "Nanovia removes these settings from every request: {fields}.",
		"routing.verdict.makeSafe": "Remove what leaves the subscription",
		"routing.verdict.makeSafe.hint": "Resets the settings that bypass the subscription to neutral values; zero data retention stays.",
		"routing.section.reasoning": "Reasoning",
		"routing.reasoning.policy": "Reasoning policy",
		"routing.reasoning.follow": "Follow the request",
		"routing.reasoning.fixed": "Fixed effort",
		"routing.reasoning.off": "Off",
		"routing.reasoning.default": "Model default",
		"routing.reasoning.follow.hint": "Takes the effort SillyTavern asked for and maps it to what the model supports. Background tasks without an effort reason as little as possible.",
		"routing.reasoning.fixed.hint": "Always the effort below.",
		"routing.reasoning.off.hint": "No reasoning when the model allows it; the lowest effort with the text hidden when it always reasons.",
		"routing.reasoning.default.hint": "Sends nothing: the model decides.",
		"routing.reasoning.effort": "Effort",
		"routing.reasoning.effort.hint": "Limited to what the model offers when the catalog knows it.",
		"routing.reasoning.hide": "Leave the reasoning text out of the reply",
		"routing.reasoning.hide.hint": "Asks NanoGPT not to return the thoughts (reasoning.exclude).",
		"routing.reasoning.caps.unknown": "The catalog does not know this model: efforts are not limited and are sent as asked.",
		"routing.reasoning.caps.none": "This model does not reason: the settings above have no effect.",
		"routing.reasoning.caps.alwaysOn": "The model always reasons; it cannot be switched off.",
		"routing.reasoning.caps.canDisable": "The model can be switched off.",
		"routing.reasoning.caps.efforts": "Efforts: {efforts}.",
		"routing.reasoning.caps.noDial": "It has no effort dial, only on or off.",
		"routing.preview.title": "What would be sent",
		"routing.preview.nothing": "nothing, the model decides",
		"routing.preview.effort": "effort {effort}",
		"routing.preview.off": "reasoning off",
		"routing.preview.on": "reasoning on",
		"routing.preview.hidden": "text hidden",
		"routing.preview.row.main": "Chat, no effort asked",
		"routing.preview.row.mainNone": "Chat asks for no reasoning",
		"routing.preview.row.mainHigh": "Chat asks for high",
		"routing.preview.row.background": "Background task"
	},
	ru: {
		"routing.tab": "Маршрутизация",
		"routing.connection": "Подключение",
		"routing.save": "Сохранить",
		"routing.revert": "Отменить",
		"routing.dirty": "Есть несохранённые изменения",
		"routing.empty": "Подключений пока нет. Создайте его на вкладке «Подключения», затем настройте маршрутизацию здесь.",
		"routing.confirm.title": "Несохранённые изменения",
		"routing.confirm.discard": "Отбросить несохранённые изменения этого подключения?",
		"routing.notice.saved": "Сохранено.",
		"routing.notice.reverted": "Изменения отброшены.",
		"routing.header.badge.hint": "Что настройки ниже делают с оплатой запроса (обновляется сразу).",
		"routing.section.routing": "Маршрутизация",
		"routing.section.routing.hint": "Предпочтения по провайдерам NanoGPT в стиле OpenRouter. Большинство из них явно выбирают хост, а NanoGPT оплачивает такой выбор за токены, а не по подписке.",
		"routing.enabled": "Отправлять предпочтения маршрутизации",
		"routing.enabled.hint": "Выключено: ничего не отправляется, NanoGPT выбирает маршрут сам.",
		"routing.offNote": "Маршрутизация выключена: настройки ниже сохраняются, но ничего не отправляется.",
		"routing.fixedRoute": "Модель работает по фиксированному маршруту: NanoGPT игнорирует настройки маршрутизации, отправляется только нулевое хранение данных.",
		"routing.needsSortNow": "Желаемая задержка или скорость ничего не делают, пока не выбрана сортировка.",
		"routing.providers.placeholder": "Введите id провайдера и нажмите Enter",
		"routing.providers.remove": "Убрать {id}",
		"routing.field.noLimit": "Без ограничения",
		"routing.disabled.subscriptionSafe": "Заблокировано: режим «только подписка» убрал бы эту настройку.",
		"routing.lockedNote": "Подключение работает только по подписке: настройки, уводящие из подписки, заблокированы, а Nanovia убирает их из каждого запроса. Чтобы ими пользоваться, смените режим оплаты.",
		"routing.field.order": "Порядок провайдеров",
		"routing.field.order.hint": "Провайдеры пробуются в этом порядке.",
		"routing.field.only": "Только эти провайдеры",
		"routing.field.only.hint": "Других провайдеров не будет, даже если эти не отвечают.",
		"routing.field.ignore": "Никогда эти провайдеры",
		"routing.field.ignore.hint": "Эти провайдеры пропускаются.",
		"routing.field.sort": "Сортировка",
		"routing.sort.default": "По умолчанию платформы",
		"routing.sort.price": "Сначала дешёвые",
		"routing.sort.throughput": "Наибольшая скорость",
		"routing.sort.latency": "Наименьшая задержка",
		"routing.sort.speed": "Скорость",
		"routing.field.sort.hint": "Как ранжируются провайдеры-кандидаты.",
		"routing.field.quantizations": "Допустимые точности",
		"routing.field.quantizations.hint": "Только хосты, которые держат веса в одной из отмеченных точностей.",
		"routing.field.minQuantization": "Минимальная точность",
		"routing.field.minQuantization.none": "Без нижней границы",
		"routing.field.minQuantization.hint": "Хосты с точностью ниже этой пропускаются.",
		"routing.field.maxPrice": "Потолок цены (USD за 1 млн токенов)",
		"routing.field.maxPrice.prompt": "Запрос",
		"routing.field.maxPrice.completion": "Ответ",
		"routing.field.maxPrice.hint": "Пусто означает «без потолка». Хосты дороже потолка пропускаются.",
		"routing.field.allowFallbacks": "Разрешить запасные провайдеры",
		"routing.field.allowFallbacks.hint": "Выключено: запрос завершится ошибкой, а не уйдёт к другому провайдеру.",
		"routing.field.requireParameters": "Требовать поддержку параметров",
		"routing.field.requireParameters.hint": "Только хосты, которые поддерживают все параметры запроса.",
		"routing.field.zdr": "Только с нулевым хранением данных",
		"routing.field.zdr.hint": "Только точки, которые не хранят копии ваших запросов.",
		"routing.field.zdr.keeps": "Подписка сохраняется: это лишь сужает собственный выбор платформы.",
		"routing.field.preferredMaxLatency": "Желаемая задержка (секунды)",
		"routing.field.preferredMaxLatency.hint": "Нужна сортировка: это предпочтение, с которым она работает.",
		"routing.field.preferredMinThroughput": "Желаемая скорость (токенов в секунду)",
		"routing.field.preferredMinThroughput.hint": "Нужна сортировка: это предпочтение, с которым она работает.",
		"routing.field.cachingRoute": "Маршрут с кешем запросов",
		"routing.field.cachingRoute.hint": "Только провайдеры с кешем запросов; следующие запросы остаются на том же.",
		"routing.bypass.order": "Уводит из подписки: порядок провайдеров — явный выбор, оплата за токены плюс около {markup}%.",
		"routing.bypass.only": "Уводит из подписки: ограничение именованными провайдерами — оплата за токены плюс около {markup}%.",
		"routing.bypass.ignore": "Уводит из подписки: исключение провайдеров считается маршрутизацией, оплата за токены плюс около {markup}%.",
		"routing.bypass.sort": "Уводит из подписки: любая сортировка, кроме стандартной, — оплата за токены плюс около {markup}%.",
		"routing.bypass.quantizations": "Уводит из подписки: выбор точностей выбирает хосты, оплата за токены плюс около {markup}%.",
		"routing.bypass.minQuantization": "Уводит из подписки: нижняя граница точности выбирает хосты, оплата за токены плюс около {markup}%.",
		"routing.bypass.maxPrice": "Уводит из подписки: потолок цены выбирает хосты, оплата за токены плюс около {markup}%.",
		"routing.bypass.allowFallbacks": "Уводит из подписки, когда запасные провайдеры выключены: оплата за токены плюс около {markup}%.",
		"routing.bypass.requireParameters": "Уводит из подписки: требование параметров выбирает хосты, оплата за токены плюс около {markup}%.",
		"routing.bypass.preferredMaxLatency": "Уводит из подписки: предпочтение по задержке — маршрутизация, оплата за токены плюс около {markup}%.",
		"routing.bypass.preferredMinThroughput": "Уводит из подписки: предпочтение по скорости — маршрутизация, оплата за токены плюс около {markup}%.",
		"routing.bypass.cachingRoute": "Может увести из подписки: маршрут с кешем закрепляет хост (требует проверки вживую).",
		"routing.section.billing": "Оплата",
		"routing.section.billing.hint": "Остаются ли запросы внутри вашей подписки NanoGPT.",
		"routing.billing.mode": "Режим оплаты",
		"routing.billing.auto": "Автоматически",
		"routing.billing.subscription": "Только подписка",
		"routing.billing.paygo": "За токены",
		"routing.billing.auto.hint": "Разрешены любые настройки; вердикт ниже показывает, что уводит из подписки.",
		"routing.billing.subscription.hint": "Настройки, которые оплачивались бы вне подписки, заблокированы, а Nanovia убирает их из каждого запроса. Нулевое хранение данных остаётся.",
		"routing.billing.paygo.hint": "Всегда оплата за токены, что бы ни предлагала модель.",
		"routing.verdict.title": "Вердикт",
		"routing.verdict.markup": "наценка +{percent}%",
		"routing.verdict.safe": "Из подписки ничего не уходит",
		"routing.verdict.safe.hint": "Ни одна настройка этого подключения не обходит подписку.",
		"routing.verdict.modelUnknown": "Каталог пока не знает эту модель, поэтому итог — предположение. Он уточнится, когда каталог загрузится.",
		"routing.verdict.subscription": "Запросы покрываются подпиской.",
		"routing.verdict.paygo": "Запросы оплачиваются за токены.",
		"routing.verdict.unknown": "По одним настройкам нельзя сказать, как оплатятся эти запросы.",
		"routing.verdict.stripped": "Nanovia убирает эти настройки из каждого запроса: {fields}.",
		"routing.verdict.makeSafe": "Убрать то, что уводит из подписки",
		"routing.verdict.makeSafe.hint": "Сбрасывает настройки, обходящие подписку, к нейтральным значениям; нулевое хранение данных остаётся.",
		"routing.section.reasoning": "Рассуждения",
		"routing.reasoning.policy": "Политика рассуждений",
		"routing.reasoning.follow": "Как в запросе",
		"routing.reasoning.fixed": "Фиксированный уровень",
		"routing.reasoning.off": "Выключены",
		"routing.reasoning.default": "По умолчанию модели",
		"routing.reasoning.follow.hint": "Берёт уровень, который запросил SillyTavern, и подгоняет под возможности модели. Фоновые задачи без уровня рассуждают как можно меньше.",
		"routing.reasoning.fixed.hint": "Всегда уровень, выбранный ниже.",
		"routing.reasoning.off.hint": "Без рассуждений, если модель позволяет; если рассуждает всегда — самый низкий уровень со скрытым текстом.",
		"routing.reasoning.default.hint": "Ничего не отправляется: решает модель.",
		"routing.reasoning.effort": "Уровень",
		"routing.reasoning.effort.hint": "Ограничен тем, что предлагает модель, если каталог её знает.",
		"routing.reasoning.hide": "Не возвращать текст рассуждений в ответе",
		"routing.reasoning.hide.hint": "Просит NanoGPT не присылать мысли (reasoning.exclude).",
		"routing.reasoning.caps.unknown": "Каталог не знает эту модель: уровни не ограничены и отправляются как запрошены.",
		"routing.reasoning.caps.none": "Эта модель не рассуждает: настройки выше ни на что не влияют.",
		"routing.reasoning.caps.alwaysOn": "Модель рассуждает всегда; выключить нельзя.",
		"routing.reasoning.caps.canDisable": "Модель можно выключить.",
		"routing.reasoning.caps.efforts": "Уровни: {efforts}.",
		"routing.reasoning.caps.noDial": "Регулятора уровня нет, только вкл. и выкл.",
		"routing.preview.title": "Что будет отправлено",
		"routing.preview.nothing": "ничего, решает модель",
		"routing.preview.effort": "уровень: {effort}",
		"routing.preview.off": "рассуждения выключены",
		"routing.preview.on": "рассуждения включены",
		"routing.preview.hidden": "текст скрыт",
		"routing.preview.row.main": "Чат, уровень не задан",
		"routing.preview.row.mainNone": "Чат просит без рассуждений",
		"routing.preview.row.mainHigh": "Чат просит высокий",
		"routing.preview.row.background": "Фоновая задача"
	}
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
new Intl.Collator("en", {
	numeric: true,
	sensitivity: "base"
});
// src/features/routing/view-model.ts
var BILLING_MODES = [
	"auto",
	"subscription",
	"paygo"
];
var ROUTING_SORTS = [
	"default",
	"price",
	"throughput",
	"latency",
	"speed"
];
var REASONING_POLICIES = [
	"follow",
	"fixed",
	"off",
	"default"
];
var EFFORT_LADDER = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** The precisions a floor can be set to (`unknown` is outside the scale). */
var MIN_QUANTIZATIONS = QUANTIZATION_ORDER;
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
/** A deep copy of what the tab edits, so changing the draft never touches the live connection. */
function draftOf(config) {
	return {
		billing: config.billing,
		routing: cloneRouting(config.routing),
		reasoning: { ...config.reasoning }
	};
}
/** The connection as it would be with the draft applied: what the domain functions are asked about. */
function configWith(config, draft) {
	return {
		...config,
		billing: draft.billing,
		routing: cloneRouting(draft.routing),
		reasoning: { ...draft.reasoning }
	};
}
/** What gets saved. The effort only matters to the `fixed` policy and defaults to medium there. */
function patchOf(draft) {
	const fixed = draft.reasoning.policy === "fixed";
	return {
		billing: draft.billing,
		routing: cloneRouting(draft.routing),
		reasoning: {
			policy: draft.reasoning.policy,
			effort: fixed ? draft.reasoning.effort ?? "medium" : null,
			hideThoughts: draft.reasoning.hideThoughts
		}
	};
}
/** Whether the draft differs from the connection it was taken from. */
function isDirty(config, draft) {
	const saved = patchOf(draftOf(config));
	return JSON.stringify(saved) !== JSON.stringify(patchOf(draft));
}
/** A price, latency or throughput typed into a field: empty means "no limit", otherwise a number of zero or more. */
function parseNumberInput(text) {
	const trimmed = text.trim().replace(",", ".");
	if (trimmed === "") return {
		ok: true,
		value: null
	};
	if (!/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return { ok: false };
	const value = Number(trimmed);
	return Number.isFinite(value) && value >= 0 ? {
		ok: true,
		value
	} : { ok: false };
}
/** A stored limit back into a field. */
function numberText(value) {
	return value === null ? "" : String(value);
}
/** Provider ids as the domain sends them: trimmed, lower case, without duplicates. */
function normalizeProviderIds(values) {
	const out = [];
	for (const value of values) {
		const id = value.trim().toLowerCase();
		if (id && !out.includes(id)) out.push(id);
	}
	return out;
}
/** Adds the ids typed into a chip field (separated by commas, spaces or new lines) to a list. */
function addProviderIds(current, typed) {
	return normalizeProviderIds([...current, ...typed.split(/[\s,;]+/)]);
}
/** Host ids the catalog knows for the model that are not chosen yet, for the suggestion list. */
function providerSuggestions(providers, chosen) {
	if (!providers) return [];
	const taken = new Set(chosen.map((id) => id.toLowerCase()));
	return providers.providers.map((host) => host.id).filter((id) => !taken.has(id.toLowerCase()));
}
/** The settings NanoGPT bills as an explicit provider choice (domain/routing.ts routingFields), in display order. */
var BYPASS_FIELDS = [
	"order",
	"only",
	"ignore",
	"sort",
	"quantizations",
	"minQuantization",
	"maxPrice",
	"allowFallbacks",
	"requireParameters",
	"preferredMaxLatency",
	"preferredMinThroughput",
	"cachingRoute"
];
/** Which controls are locked. In subscription-safe mode every bypassing control is, with the reason; `zdr` never is. */
function controlStates(draft) {
	const locked = draft.billing === "subscription";
	const states = {};
	for (const name of BYPASS_FIELDS) states[name] = {
		bypass: true,
		disabled: locked,
		reason: locked ? "routing.disabled.subscriptionSafe" : null
	};
	states.zdr = {
		bypass: false,
		disabled: false,
		reason: null
	};
	states.enabled = {
		bypass: false,
		disabled: false,
		reason: null
	};
	return states;
}
/** The draft with every bypassing setting reset to neutral (what subscription-safe mode would do); `zdr` stays. */
function makeSubscriptionSafe(config, draft, model) {
	const { routing } = subscriptionSafeOverrides(configWith(config, draft), model);
	return {
		...draft,
		routing
	};
}
/** Whether "remove the settings that leave the subscription" has anything to remove. */
function hasBypassingSettings(draft) {
	return draft.routing.enabled && routingFields(draft.routing).length > 0;
}
/** A preferred latency or throughput is set but no sort is: NanoGPT ignores it (the domain's own warning). */
function preferenceNeedsSort(routing) {
	return routingWarnings({
		...routing,
		enabled: true
	}).some((warning) => warning.code === "routing.preferenceNeedsSort");
}
function reasoningCaps(model) {
	if (!model) return {
		known: false,
		reasons: true,
		efforts: [],
		alwaysOn: false,
		canDisable: true
	};
	const listed = new Set(model.reasoningEfforts.map((effort) => effort.trim().toLowerCase()));
	const efforts = EFFORT_LADDER.filter((effort) => listed.has(effort));
	const reasons = model.capabilities.reasoning;
	const alwaysOn = reasons && efforts.length > 0 && !efforts.includes("none");
	return {
		known: true,
		reasons,
		efforts,
		alwaysOn,
		canDisable: !alwaysOn
	};
}
/** The efforts the select offers: the model's list when it has one, the whole ladder otherwise; the chosen one stays. */
function effortChoices(caps, current) {
	const base = caps.known && caps.efforts.length > 0 ? [...caps.efforts] : [...EFFORT_LADDER];
	if (current && !base.includes(current)) base.push(current);
	return EFFORT_LADDER.filter((effort) => base.includes(effort));
}
/** One sentence about what the catalog says of the model's reasoning. */
function capabilityLine(caps, t) {
	if (!caps.known) return t("routing.reasoning.caps.unknown");
	if (!caps.reasons) return t("routing.reasoning.caps.none");
	const efforts = caps.efforts.map((effort) => t(`billing.effort.${effort}`)).join(", ");
	const parts = [caps.alwaysOn ? t("routing.reasoning.caps.alwaysOn") : t("routing.reasoning.caps.canDisable")];
	parts.push(efforts ? t("routing.reasoning.caps.efforts", { efforts }) : t("routing.reasoning.caps.noDial"));
	return parts.join(" ");
}
/** The requests the preview shows: the chat asking for nothing, for no reasoning, for high; a background task. */
var PREVIEW_SCENARIOS = [
	{
		id: "main",
		hints: {
			effort: null,
			consumer: "main",
			thoughts: false
		}
	},
	{
		id: "mainNone",
		hints: {
			effort: "none",
			consumer: "main",
			thoughts: false
		}
	},
	{
		id: "mainHigh",
		hints: {
			effort: "high",
			consumer: "main",
			thoughts: false
		}
	},
	{
		id: "background",
		hints: {
			effort: null,
			consumer: "background",
			thoughts: false
		}
	}
];
/** planReasoning for the sample requests. */
function reasoningPreview(model, reasoning) {
	return PREVIEW_SCENARIOS.map(({ id, hints }) => {
		const plan = planReasoning(model, reasoning, hints);
		return {
			id,
			params: plan.reasoning,
			warnings: plan.warnings
		};
	});
}
/** `effort high · text hidden`, `reasoning off`, or "nothing is sent". */
function describeReasoning(params, t) {
	if (params === null) return t("routing.preview.nothing");
	const parts = [];
	if (params.effort !== void 0) parts.push(t("routing.preview.effort", { effort: t(`billing.effort.${params.effort}`) }));
	if (params.enabled === false) parts.push(t("routing.preview.off"));
	if (params.enabled === true) parts.push(t("routing.preview.on"));
	if (params.exclude === true) parts.push(t("routing.preview.hidden"));
	return parts.join(" · ");
}
/**
* What the draft does to billing and to the request: the domain's BillingImpact plus the warnings of the plan the
* connection makes for an ordinary chat request that asks for nothing (routing warnings, and the reasoning warnings of
* the `fixed` and `off` policies, which do not depend on the request). What the `follow` policy does with a particular
* request is shown by the preview, not here. `providerSelection` is the catalog's `supportsProviderSelection` for the
* model (null = unknown).
*/
function verdictFor(config, draft, model, providerSelection) {
	const connection = configWith(config, draft);
	const impact = analyzeBilling(connection, model, providerSelection);
	const sample = planUpstream({
		connection,
		model,
		body: {
			model: connection.modelId,
			messages: []
		},
		hints: PREVIEW_SCENARIOS[0]?.hints ?? {
			effort: null,
			consumer: "main",
			thoughts: false
		},
		providerSelection
	});
	return {
		outcome: impact.outcome,
		markupPercent: impact.markupPercent,
		subscriptionSafe: impact.subscriptionSafe,
		reasons: impact.reasons,
		warnings: sample.warnings,
		stripped: impact.stripped,
		modelKnown: model !== null,
		providerSelection
	};
}
function outcomeKind(outcome) {
	return outcome === "subscription" ? "ok" : outcome === "paygo" ? "warn" : "muted";
}
/** The outcome badge: "Subscription", "Pay as you go · +5%" or "Not known". */
function outcomeBadge(verdict, t) {
	const label = billingOutcomeLabel(verdict.outcome, t);
	return {
		label: verdict.markupPercent > 0 ? `${label} · +${verdict.markupPercent}%` : label,
		kind: outcomeKind(verdict.outcome)
	};
}
/** A line of the panel that says why the outcome is what it is when no reason does (nothing special in the settings). */
function verdictSummaryKey(verdict) {
	if (!verdict.modelKnown) return "routing.verdict.modelUnknown";
	if (verdict.outcome === "subscription") return "routing.verdict.subscription";
	if (verdict.outcome === "paygo") return "routing.verdict.paygo";
	return "routing.verdict.unknown";
}
/** Whether the routing settings are ignored by the model (a fixed route): only `zdr` has an effect. */
function routingIgnored(verdict) {
	return verdict.providerSelection === false;
}
/** The connection names for the selector: "Name · model". */
function connectionLabel(config) {
	return `${config.name} · ${config.modelId}`;
}
// src/features/routing/chips.ts
function chipListInput(options) {
	let values = [...options.values];
	const listId = uid("nanovia-suggest");
	const chips = el("div", { class: "nanovia-chiplist-chips" });
	const datalist = el("datalist", { attrs: { id: listId } });
	const input = el("input", {
		class: "text_pole nanovia-text",
		attrs: {
			type: "text",
			list: listId,
			placeholder: options.placeholder,
			"aria-label": options.label,
			autocomplete: "off",
			autocapitalize: "off",
			spellcheck: "false"
		}
	});
	function draw() {
		clear(chips);
		for (const id of values) chips.appendChild(el("span", {
			class: "nanovia-chip nanovia-chip-info nanovia-chip-item",
			data: { id }
		}, [el("span", { text: id }), el("button", {
			class: "nanovia-chip-remove",
			text: "×",
			attrs: {
				type: "button",
				"aria-label": options.removeLabel(id)
			},
			on: { click: () => remove(id) }
		})]));
	}
	function commit() {
		const typed = input.value;
		input.value = "";
		if (!typed.trim()) return;
		const next = addProviderIds(values, typed);
		if (next.length === values.length) return;
		values = next;
		draw();
		options.onChange([...values]);
	}
	function remove(id) {
		values = values.filter((value) => value !== id);
		draw();
		options.onChange([...values]);
	}
	input.addEventListener("change", commit);
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === ",") {
			event.preventDefault();
			commit();
		}
	});
	draw();
	return {
		node: el("div", { class: "nanovia-chiplist" }, [
			chips,
			input,
			datalist
		]),
		setSuggestions(ids) {
			clear(datalist);
			for (const id of ids) datalist.appendChild(el("option", { attrs: { value: id } }));
		}
	};
}
// src/features/routing/sections.ts
function section(id, title, children) {
	return el("details", {
		class: "nanovia-section",
		attrs: { open: true },
		data: { section: id }
	}, [el("summary", {
		class: "nanovia-section-title",
		text: title
	}), ...children]);
}
function setDisabled(root, disabled) {
	for (const control of root.querySelectorAll("input, select, button")) control.disabled = disabled;
}
function options(values, label) {
	return values.map((value) => ({
		value,
		label: label(value)
	}));
}
function buildRoutingSection(env) {
	const { t, draft } = env;
	const routing = draft.routing;
	const rows = /* @__PURE__ */ new Map();
	const locks = /* @__PURE__ */ new Map();
	const suggestors = [];
	/** A row of a setting that leaves the subscription: the control, "what leaves the subscription", and the lock reason. */
	function bypassRow(name, control) {
		const lock = el("div", {
			class: "nanovia-field-hint nanovia-lock",
			attrs: { hidden: true }
		});
		locks.set(name, lock);
		const row = el("div", {
			class: "nanovia-row-block",
			data: { field: name }
		}, [
			control,
			el("div", {
				class: "nanovia-field-hint nanovia-bypass",
				text: t(`routing.bypass.${name}`, { markup: 5 })
			}),
			lock
		]);
		rows.set(name, row);
		return row;
	}
	function idsRow(name) {
		const list = chipListInput({
			label: t(`routing.field.${name}`),
			placeholder: t("routing.providers.placeholder"),
			values: routing[name],
			removeLabel: (id) => t("routing.providers.remove", { id }),
			onChange: (values) => {
				routing[name] = values;
				env.changed();
			}
		});
		suggestors.push({
			setSuggestions: list.setSuggestions,
			read: () => routing[name]
		});
		return bypassRow(name, field(t(`routing.field.${name}`), list.node, t(`routing.field.${name}.hint`)));
	}
	function numberRow(name, read, write) {
		const input = textInput({
			value: numberText(read()),
			label: t(`routing.field.${name}`),
			placeholder: t("routing.field.noLimit"),
			onInput: (value) => {
				const parsed = parseNumberInput(value);
				input.classList.toggle("nanovia-invalid", !parsed.ok);
				if (!parsed.ok) return;
				write(parsed.value);
				env.changed();
			}
		});
		return bypassRow(name, field(t(`routing.field.${name}`), input, t(`routing.field.${name}.hint`)));
	}
	function priceInput(side) {
		const input = textInput({
			value: numberText(routing.maxPrice[side]),
			label: t(`routing.field.maxPrice.${side}`),
			placeholder: t(`routing.field.maxPrice.${side}`),
			onInput: (value) => {
				const parsed = parseNumberInput(value);
				input.classList.toggle("nanovia-invalid", !parsed.ok);
				if (!parsed.ok) return;
				routing.maxPrice[side] = parsed.value;
				env.changed();
			}
		});
		return input;
	}
	function boolRow(name, read, write) {
		return bypassRow(name, toggle({
			label: t(`routing.field.${name}`),
			checked: read(),
			hint: t(`routing.field.${name}.hint`),
			onChange: (checked) => {
				write(checked);
				env.changed();
			}
		}));
	}
	const enabled = toggle({
		label: t("routing.enabled"),
		checked: routing.enabled,
		hint: t("routing.enabled.hint"),
		onChange: (checked) => {
			routing.enabled = checked;
			env.changed();
		}
	});
	const offNote = el("div", {
		class: "nanovia-muted nanovia-off-note",
		text: t("routing.offNote"),
		attrs: { hidden: true }
	});
	const lockedNote = el("div", {
		class: "nanovia-notice nanovia-notice-warn nanovia-locked-note",
		text: t("routing.lockedNote"),
		attrs: { hidden: true }
	});
	const fixedNote = el("div", {
		class: "nanovia-notice nanovia-notice-warn nanovia-fixed-note",
		text: t("routing.fixedRoute"),
		attrs: { hidden: true }
	});
	const needsSort = el("div", {
		class: "nanovia-field-hint nanovia-warn-text",
		text: t("routing.needsSortNow"),
		attrs: { hidden: true }
	});
	const quantizationBox = el("div", {
		class: "nanovia-checks",
		attrs: {
			role: "group",
			"aria-label": t("routing.field.quantizations")
		}
	}, QUANTIZATIONS.map((value) => toggle({
		label: value,
		checked: routing.quantizations.includes(value),
		onChange: (checked) => {
			routing.quantizations = checked ? [...routing.quantizations.filter((q) => q !== value), value] : routing.quantizations.filter((q) => q !== value);
			env.changed();
		}
	})));
	const minOptions = [{
		value: "",
		label: t("routing.field.minQuantization.none")
	}, ...MIN_QUANTIZATIONS.map((value) => ({
		value,
		label: value
	}))];
	const zdr = el("div", {
		class: "nanovia-row-block",
		data: { field: "zdr" }
	}, [toggle({
		label: t("routing.field.zdr"),
		checked: routing.zdr,
		hint: t("routing.field.zdr.hint"),
		onChange: (checked) => {
			routing.zdr = checked;
			env.changed();
		}
	}), el("div", {
		class: "nanovia-field-hint",
		text: t("routing.field.zdr.keeps")
	})]);
	rows.set("zdr", zdr);
	return {
		node: section("routing", t("routing.section.routing"), [
			el("div", {
				class: "nanovia-field-hint",
				text: t("routing.section.routing.hint")
			}),
			enabled,
			lockedNote,
			offNote,
			fixedNote,
			idsRow("order"),
			idsRow("only"),
			idsRow("ignore"),
			bypassRow("sort", field(t("routing.field.sort"), select({
				value: routing.sort,
				options: options(ROUTING_SORTS, (value) => t(`routing.sort.${value}`)),
				label: t("routing.field.sort"),
				onChange: (value) => {
					routing.sort = value;
					env.changed();
				}
			}), t("routing.field.sort.hint"))),
			bypassRow("quantizations", field(t("routing.field.quantizations"), quantizationBox, t("routing.field.quantizations.hint"))),
			bypassRow("minQuantization", field(t("routing.field.minQuantization"), select({
				value: routing.minQuantization ?? "",
				options: minOptions,
				label: t("routing.field.minQuantization"),
				onChange: (value) => {
					routing.minQuantization = MIN_QUANTIZATIONS.find((q) => q === value) ?? null;
					env.changed();
				}
			}), t("routing.field.minQuantization.hint"))),
			bypassRow("maxPrice", field(t("routing.field.maxPrice"), el("div", { class: "nanovia-row nanovia-pair" }, [priceInput("prompt"), priceInput("completion")]), t("routing.field.maxPrice.hint"))),
			boolRow("allowFallbacks", () => routing.allowFallbacks, (value) => void (routing.allowFallbacks = value)),
			boolRow("requireParameters", () => routing.requireParameters, (value) => void (routing.requireParameters = value)),
			zdr,
			numberRow("preferredMaxLatency", () => routing.preferredMaxLatency, (value) => void (routing.preferredMaxLatency = value)),
			numberRow("preferredMinThroughput", () => routing.preferredMinThroughput, (value) => void (routing.preferredMinThroughput = value)),
			needsSort,
			boolRow("cachingRoute", () => routing.cachingRoute, (value) => void (routing.cachingRoute = value))
		]),
		update(data) {
			const { controls, verdict } = data;
			for (const [name, row] of rows) {
				const state = controls[name];
				setDisabled(row, state.disabled);
				row.classList.toggle("nanovia-locked", state.disabled);
				if (name !== "zdr") {
					const lock = locks.get(name);
					if (lock) {
						lock.textContent = state.reason ? t(state.reason) : "";
						lock.hidden = !state.reason;
					}
				}
			}
			lockedNote.hidden = draft.billing !== "subscription";
			offNote.hidden = draft.routing.enabled;
			fixedNote.hidden = !routingIgnored(verdict);
			needsSort.hidden = !(draft.routing.enabled && draft.billing !== "subscription" && preferenceNeedsSort(draft.routing));
			for (const suggestor of suggestors) suggestor.setSuggestions(providerSuggestions(data.providers, suggestor.read()));
		}
	};
}
function buildBillingSection(env) {
	const { t, draft } = env;
	const modeHint = el("div", { class: "nanovia-field-hint" });
	const panel = el("div", {
		class: "nanovia-verdict",
		attrs: { "aria-live": "polite" }
	});
	const mode = field(t("routing.billing.mode"), select({
		value: draft.billing,
		options: options(BILLING_MODES, (value) => t(`routing.billing.${value}`)),
		label: t("routing.billing.mode"),
		onChange: (value) => {
			draft.billing = value;
			env.changed();
		}
	}));
	mode.appendChild(modeHint);
	function drawPanel(data) {
		const { verdict } = data;
		clear(panel);
		const head = el("div", { class: "nanovia-row nanovia-verdict-head" }, [
			el("b", { text: t("routing.verdict.title") }),
			chip(billingOutcomeLabel(verdict.outcome, t), outcomeKind(verdict.outcome)),
			verdict.markupPercent > 0 ? chip(t("routing.verdict.markup", { percent: verdict.markupPercent }), "warn") : null,
			verdict.subscriptionSafe ? chip(t("routing.verdict.safe"), "ok", t("routing.verdict.safe.hint")) : null
		]);
		panel.appendChild(head);
		panel.appendChild(el("div", {
			class: "nanovia-muted",
			text: t(verdictSummaryKey(verdict))
		}));
		if (verdict.reasons.length > 0) panel.appendChild(el("ul", { class: "nanovia-reasons" }, verdict.reasons.map((reason) => el("li", { text: billingReasonText(reason, t) }))));
		if (verdict.warnings.length > 0) panel.appendChild(el("ul", { class: "nanovia-warnings" }, verdict.warnings.map((warning) => el("li", { text: planWarningText(warning, t) }))));
		if (verdict.stripped.length > 0) panel.appendChild(el("div", {
			class: "nanovia-stripped",
			text: t("routing.verdict.stripped", { fields: strippedLabels(verdict.stripped, t).join(", ") })
		}));
		if (draft.billing !== "subscription" && hasBypassingSettings(draft)) panel.appendChild(el("div", { class: "nanovia-row" }, [button({
			label: t("routing.verdict.makeSafe"),
			title: t("routing.verdict.makeSafe.hint"),
			icon: "shield-halved",
			onClick: () => {
				Object.assign(draft.routing, makeSubscriptionSafe(data.config, draft, data.model).routing);
				env.rebuild();
			}
		})]));
	}
	return {
		node: section("billing", t("routing.section.billing"), [
			el("div", {
				class: "nanovia-field-hint",
				text: t("routing.section.billing.hint")
			}),
			mode,
			panel
		]),
		update(data) {
			modeHint.textContent = t(`routing.billing.${draft.billing}.hint`);
			drawPanel(data);
		}
	};
}
function buildReasoningSection(env) {
	const { t, draft } = env;
	const reasoning = draft.reasoning;
	const policyHint = el("div", { class: "nanovia-field-hint" });
	const capsLine = el("div", { class: "nanovia-muted nanovia-caps" });
	const preview = el("div", {
		class: "nanovia-preview",
		attrs: {
			role: "table",
			"aria-label": t("routing.preview.title")
		}
	});
	const policy = field(t("routing.reasoning.policy"), select({
		value: reasoning.policy,
		options: options(REASONING_POLICIES, (value) => t(`routing.reasoning.${value}`)),
		label: t("routing.reasoning.policy"),
		onChange: (value) => {
			reasoning.policy = value;
			env.changed();
		}
	}));
	policy.appendChild(policyHint);
	const effortHost = el("div", { class: "nanovia-effort" });
	let effortSignature = "";
	function drawEffort(caps) {
		const current = reasoning.effort ?? "medium";
		const choices = effortChoices(caps, current);
		const signature = `${choices.join(",")}|${current}`;
		effortHost.hidden = reasoning.policy !== "fixed";
		if (signature === effortSignature) return;
		effortSignature = signature;
		clear(effortHost);
		effortHost.appendChild(field(t("routing.reasoning.effort"), select({
			value: current,
			options: options(choices, (value) => t(`billing.effort.${value}`)),
			label: t("routing.reasoning.effort"),
			onChange: (value) => {
				reasoning.effort = value;
				env.changed();
			}
		}), t("routing.reasoning.effort.hint")));
	}
	function drawPreview(rows) {
		clear(preview);
		preview.appendChild(el("div", {
			class: "nanovia-field-hint",
			text: t("routing.preview.title")
		}));
		for (const row of rows) preview.appendChild(el("div", {
			class: "nanovia-preview-row",
			attrs: { role: "row" },
			data: { scenario: row.id }
		}, [
			el("span", {
				class: "nanovia-preview-case",
				text: t(`routing.preview.row.${row.id}`)
			}),
			el("code", {
				class: "nanovia-preview-result",
				text: describeReasoning(row.params, t)
			}),
			...row.warnings.map((warning) => el("div", {
				class: "nanovia-field-hint nanovia-preview-warning",
				text: planWarningText(warning, t)
			}))
		]));
	}
	return {
		node: section("reasoning", t("routing.section.reasoning"), [
			policy,
			effortHost,
			toggle({
				label: t("routing.reasoning.hide"),
				checked: reasoning.hideThoughts,
				hint: t("routing.reasoning.hide.hint"),
				onChange: (checked) => {
					reasoning.hideThoughts = checked;
					env.changed();
				}
			}),
			capsLine,
			preview
		]),
		update(data) {
			policyHint.textContent = t(`routing.reasoning.${reasoning.policy}.hint`);
			drawEffort(data.caps);
			capsLine.textContent = capabilityLine(data.caps, t);
			drawPreview(data.preview);
		}
	};
}
// src/features/routing/view.ts
function renderRoutingTab(root, ctx) {
	const t = ctx.t;
	let selected = null;
	let draft = null;
	let sections = [];
	/** The saved values the draft was taken from, as text: tells an edit of the user from a change of the connection. */
	let shownBaseline = "";
	let disposed = false;
	let notice = null;
	const headHost = el("div", { class: "nanovia-routing-head" });
	const noticeHost = el("div", {
		class: "nanovia-notice-host",
		attrs: { "aria-live": "polite" }
	});
	const bodyHost = el("div", { class: "nanovia-routing-body" });
	root.append(headHost, noticeHost, bodyHost);
	/** The chip that follows the draft in the header, filled in by `update()`. */
	const badgeHost = el("span", { class: "nanovia-routing-badge" });
	const dirtyHost = el("span", { class: "nanovia-routing-dirty" });
	function baselineOf(config) {
		return JSON.stringify(patchOf(draftOf(config)));
	}
	function current() {
		return selected ? ctx.connections.get(selected) : null;
	}
	function drawNotice() {
		clear(noticeHost);
		if (!notice) return;
		noticeHost.appendChild(el("div", {
			class: ["nanovia-notice", `nanovia-notice-${notice.kind}`],
			text: notice.text
		}));
	}
	function notify(kind, text) {
		notice = {
			kind,
			text
		};
		drawNotice();
	}
	function report(result, success) {
		if (!result.ok) {
			notify("error", issueText(result.error, t));
			return false;
		}
		if (result.warnings.length === 0) notify("ok", success);
		else notify("warn", [success, ...result.warnings.map((warning) => issueText(warning, t))].join(" "));
		return true;
	}
	function compute(data) {
		const { config } = data;
		const model = ctx.catalog.model(config.modelId);
		const providers = ctx.catalog.providers(model?.id ?? config.modelId);
		const verdict = verdictFor(config, data.draft, model, providers?.supportsProviderSelection ?? null);
		return {
			config,
			draft: data.draft,
			model,
			providers,
			verdict,
			controls: controlStates(data.draft),
			caps: reasoningCaps(model),
			preview: reasoningPreview(model, data.draft.reasoning)
		};
	}
	function update() {
		const entry = current();
		if (!entry || !draft) return;
		const data = compute({
			config: entry.config,
			draft
		});
		for (const view of sections) view.update(data);
		const badge = outcomeBadge(data.verdict, t);
		clear(badgeHost);
		badgeHost.appendChild(chip(badge.label, badge.kind, t("routing.header.badge.hint")));
		clear(dirtyHost);
		if (isDirty(entry.config, draft)) dirtyHost.appendChild(chip(t("routing.dirty"), "warn"));
	}
	function buildBody() {
		clear(bodyHost);
		sections = [];
		if (!current() || !draft) {
			bodyHost.appendChild(el("div", {
				class: "nanovia-muted nanovia-empty",
				text: t("routing.empty")
			}));
			return;
		}
		const env = {
			ctx,
			t,
			draft,
			changed: update,
			rebuild: () => {
				buildBody();
			}
		};
		sections = [
			buildRoutingSection(env),
			buildBillingSection(env),
			buildReasoningSection(env)
		];
		for (const view of sections) bodyHost.appendChild(view.node);
		update();
	}
	function drawHead() {
		clear(headHost);
		const entries = ctx.connections.list();
		if (entries.length === 0) return;
		const chooser = select({
			value: selected ?? "",
			options: entries.map((entry) => ({
				value: entry.config.id,
				label: connectionLabel(entry.config)
			})),
			label: t("routing.connection"),
			onChange: (id) => void choose(id)
		});
		headHost.appendChild(el("div", { class: "nanovia-row nanovia-routing-bar" }, [
			chooser,
			badgeHost,
			dirtyHost,
			button({
				label: t("routing.save"),
				icon: "check",
				kind: "primary",
				onClick: () => save()
			}),
			button({
				label: t("routing.revert"),
				icon: "rotate-left",
				onClick: () => revert()
			})
		]));
	}
	function loadHosts() {
		const entry = current();
		if (!entry) return;
		const modelId = entry.config.modelId;
		const id = ctx.catalog.model(modelId)?.id ?? modelId;
		ctx.catalog.ensureProviders(id).then(() => {
			if (!disposed && current()?.config.modelId === modelId) update();
		});
	}
	async function choose(id) {
		const entry = current();
		if (id === selected) return;
		if (entry && draft && isDirty(entry.config, draft)) {
			if (!await ctx.host.confirm(t("routing.confirm.discard"), t("routing.confirm.title"))) {
				drawHead();
				update();
				return;
			}
		}
		open(id);
	}
	function open(id) {
		selected = id;
		notice = null;
		drawNotice();
		const entry = current();
		draft = entry ? draftOf(entry.config) : null;
		shownBaseline = entry ? baselineOf(entry.config) : "";
		drawHead();
		buildBody();
		loadHosts();
	}
	function revert() {
		const entry = current();
		if (!entry) return;
		draft = draftOf(entry.config);
		shownBaseline = baselineOf(entry.config);
		buildBody();
		notify("ok", t("routing.notice.reverted"));
	}
	async function save() {
		const entry = current();
		if (!entry || !draft) return;
		report(await ctx.connections.save({
			id: entry.config.id,
			patch: patchOf(draft)
		}), t("routing.notice.saved"));
	}
	/** The connections changed (a save, a refresh): follow them unless the user has edits that would be lost. */
	function onConnections() {
		if (disposed) return;
		const entry = current();
		if (!entry) {
			open(ctx.connections.list()[0]?.config.id ?? null);
			return;
		}
		const baseline = baselineOf(entry.config);
		if (draft && JSON.stringify(patchOf(draft)) === shownBaseline && baseline !== shownBaseline) {
			draft = draftOf(entry.config);
			shownBaseline = baseline;
			drawHead();
			buildBody();
			return;
		}
		shownBaseline = baseline;
		drawHead();
		update();
	}
	const offConnections = ctx.connections.onChange(onConnections);
	const offCatalog = ctx.catalog.onChange(() => {
		if (!disposed) update();
	});
	open(ctx.connections.list()[0]?.config.id ?? null);
	return () => {
		disposed = true;
		offConnections();
		offCatalog();
		draft = null;
	};
}
// src/features/routing/index.ts
var ROUTING_FEATURE_ID = "routing";
var ROUTING_TAB_ID = "routing";
// src/features/index.ts
var FEATURES = [
	connectionsFeature,
	{
		id: ROUTING_FEATURE_ID,
		init(ctx) {
			ctx.i18n.register(BILLING_STRINGS);
			ctx.i18n.register(ROUTING_STRINGS);
			return ctx.panel.registerTab({
				id: ROUTING_TAB_ID,
				titleKey: "routing.tab",
				order: 200,
				render: (root, tabCtx) => renderRoutingTab(root, tabCtx)
			});
		}
	},
	keysFeature
];
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
	const catalog = createEmptyCatalogStore();
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
	const directMode = createDirectMode({
		connections: () => connections.list().map((entry) => ({
			config: entry.config,
			effectiveMode: entry.effectiveMode
		})),
		directSecrets: () => settings.get().directSecrets,
		model: (id) => ctx.catalog.model(id),
		providers: (id) => ctx.catalog.providers(id),
		emit: (record) => void bus.emit("usage:record", { record }),
		log: log.scope("direct")
	});
	const owned = [requests.register(directMode.hook), requests.observe(directMode.observer)];
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