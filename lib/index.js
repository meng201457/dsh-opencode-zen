/**
 * dsh-opencode-zen — OpenCode Zen/Go client-identity headers at the fetch layer.
 *
 * Why this shape (and not a source patch): `dsh-llm-pi-ai`'s `requestHeaders()`
 * merges `attributionHeaders()` LAST and drops any user header whose name
 * collides, so `user-agent` from settings.yaml can never reach the wire. The
 * fetch layer sees the fully merged, final request — overwriting there works
 * without racing anyone, survives reinstalls, and needs no file patching.
 *
 * Two seams, both verified against DSH 0.1.6-alpha.1:
 *  - `llm/stream` waterfall: wraps each adapter stream iteration in
 *    AsyncLocalStorage carrying `GenerateOptions.sessionId`, so fetches issued
 *    while streaming inherit the DSH conversation id.
 *  - fetch middleware: rewrites identity headers ONLY when the request host is
 *    on the allowlist (default `opencode.ai` + subdomains). Every other host
 *    passes through byte-for-byte untouched. The same middleware also satisfies
 *    the free tier's tool-name gate — see the "free-tier tool gate" section
 *    below; that part is a body rewrite, not a header rewrite.
 *
 * Headers alone are NOT sufficient: the free tier also refuses any tool-calling
 * request whose `tools` array lacks a tool named `bash` or `read`, and DSH names
 * its shell tool `pwsh`. Both halves are needed for a DSH request to succeed.
 *
 * `@deepseek-ai/dsh-http-proxy` documents that "the pi-ai provider stack"
 * reaches `globalThis.fetch`, and pi-ai passes no explicit `fetch` to the
 * OpenAI SDK, so the SDK resolves the global at per-request client
 * construction. Verified empirically, not assumed.
 */
import { AsyncLocalStorage } from "node:async_hooks";
// DSH resolves `@deepseek-ai/schemastery`, not the bare `schemastery` package:
// `.volatile()` (the marker that projects a Config field into the settings form)
// exists only in the scoped fork, and only from 3.18.3. The bare npm package
// that the old `"schemastery": "*"` spec resolved to is 3.18.0 and has no
// `.volatile()`, which silently yields a Config with no editable fields.
import z from "@deepseek-ai/schemastery";

export const name = "dsh-opencode-zen";

/** Default allowlist: Zen/Go live on opencode.ai; subdomains match too. */
export const DEFAULT_HOSTS = ["opencode.ai"];

/** Session id used outside an LLM call (e.g. model discovery). */
export const DEFAULT_FALLBACK_SESSION = "dsh-default";

/**
 * Default user-agent.
 *
 * Its content is load-bearing again as of 2026-09-19: the Zen free tier now
 * parses the client version out of this header. A value naming no
 * `opencode/<version>`, or naming one below {@link MIN_CLIENT_VERSION}, is
 * refused. `1.18.30` clears both gates with room to spare.
 *
 * (On 2026-09-15 this header's content genuinely did not matter — a bare
 * `deepseek-harness/...`, `curl/8.7.1`, and no UA at all all returned 200. That
 * measurement is no longer valid; see the README's 2026-09-19 section.)
 */
export const DEFAULT_USER_AGENT = "opencode/latest/1.18.30/cli";

/**
 * Lowest OpenCode client version the Zen free tier still serves, as
 * `[major, minor, patch]`.
 *
 * Measured 2026-09-19 against `mimo-v2.5-free`, holding every other header at a
 * known-good state and varying only `user-agent` (each cell 2/2, healthy
 * controls interleaved):
 *
 * | user-agent | result |
 * |---|---|
 * | `opencode/1.0.0` / `opencode/1.10.0` | `426 UpgradeRequired` |
 * | `opencode/1.18.0` | `200` |
 * | `opencode/1.18.23`, `opencode/1.18.30`, `opencode/2.0.0` | `200` |
 *
 * The 426 body names the rule verbatim: "OpenCode 1.18.0 or newer is required
 * to use the free tier". This is a separate gate from the id-shape one — it
 * fires on a well-formed session id.
 */
export const MIN_CLIENT_VERSION = Object.freeze([1, 18, 0]);

/**
 * The client version a user-agent names, or undefined when it names none.
 *
 * The relay matches `opencode/` case-insensitively anywhere in the string and
 * then reads the first version-shaped run of digits after it, skipping any
 * intervening path segments: `Mozilla/5.0 opencode/1.18.23` passes, and so does
 * `opencode/latest/1.18.30/cli` (the default here). A string naming no digits at
 * all (`opencode/latest`) is not a version, and neither is one with no
 * `opencode/` (`opencode 1.0`, `deepseek-harness/0.1.6`).
 * @param userAgent - the header value to parse.
 * @returns `[major, minor, patch]` (patch 0 when absent), or undefined.
 */
export function parseClientVersion(userAgent) {
	const match = /opencode\/[^\s]*?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i.exec(String(userAgent ?? ""));
	if (match === null) return undefined;
	return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/**
 * Whether a user-agent clears both free-tier gates: it must name an
 * `opencode/<version>`, and that version must be >= {@link MIN_CLIENT_VERSION}.
 * @param userAgent - the header value to judge.
 * @returns true when the relay would accept this client version.
 */
export function clientVersionMeetsFloor(userAgent) {
	const parsed = parseClientVersion(userAgent);
	if (parsed === undefined) return false;
	for (let index = 0; index < MIN_CLIENT_VERSION.length; index += 1) {
		if (parsed[index] > MIN_CLIENT_VERSION[index]) return true;
		if (parsed[index] < MIN_CLIENT_VERSION[index]) return false;
	}
	return true;
}

/** Carries the DSH session id across one `llm/stream` call. */
export const requestSessionContext = new AsyncLocalStorage();

// ---------------------------------------------------------------------------
// fetch pipeline
//
// Keyed under this plugin's own Symbol so other fetch-wrapping plugins
// (dsh-api-proxy, dsh-opencode-session-header, ...) never clobber each other's
// chains. `installFetchPipeline` replaces globalThis.fetch with a getter that
// always returns the freshly composed chain, and re-composes whenever someone
// else assigns to globalThis.fetch.
// ---------------------------------------------------------------------------

const FETCH_PIPELINE_KEY = Symbol.for("dsh-opencode-zen.fetch.pipeline.v1");

function ensureFetchPipeline() {
	const g = globalThis;
	if (g[FETCH_PIPELINE_KEY]) return g[FETCH_PIPELINE_KEY];
	let underlyingFetch = globalThis.fetch;
	const state = {
		getUnderlyingFetch: () => underlyingFetch,
		setUnderlyingFetch: (next) => {
			underlyingFetch = next;
		},
		middlewares: [],
		installed: false,
		patchedFetch: undefined
	};
	g[FETCH_PIPELINE_KEY] = state;
	return state;
}

function compose(state) {
	const ordered = [...state.middlewares].sort((a, b) => a.priority - b.priority);
	const callAt = (index, input, init) => {
		if (index >= ordered.length) return state.getUnderlyingFetch()(input, init);
		return ordered[index].middleware({
			input,
			init,
			next: (nextInput, nextInit) => callAt(index + 1, nextInput, nextInit)
		});
	};
	return (input, init) => callAt(0, input, init);
}

function installFetchPipeline() {
	const state = ensureFetchPipeline();
	if (state.installed) {
		state.patchedFetch = compose(state);
		return;
	}
	const prevDesc = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	state.patchedFetch = compose(state);
	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		enumerable: prevDesc?.enumerable ?? true,
		get() {
			return state.patchedFetch;
		},
		set(newFetch) {
			if (newFetch === state.patchedFetch) return;
			prevDesc?.set?.call(globalThis, newFetch);
			state.setUnderlyingFetch(newFetch);
			state.patchedFetch = compose(state);
		}
	});
	state.installed = true;
}

/** Register (or replace, by name) a fetch middleware and ensure installation. */
export function registerFetchMiddleware(registration) {
	const state = ensureFetchPipeline();
	const index = state.middlewares.findIndex((m) => m.name === registration.name);
	if (index >= 0) state.middlewares.splice(index, 1, registration);
	else state.middlewares.push(registration);
	installFetchPipeline();
}

/** Remove a middleware by name; the chain recomposes immediately. */
export function unregisterFetchMiddleware(name) {
	const state = ensureFetchPipeline();
	const index = state.middlewares.findIndex((m) => m.name === name);
	if (index >= 0) state.middlewares.splice(index, 1);
	if (state.installed) state.patchedFetch = compose(state);
}

// ---------------------------------------------------------------------------
// pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Resolve a fetch input to a URL, or undefined when it is not a URL-ish input. */
export function requestUrlOf(input) {
	try {
		if (typeof input === "string") return new URL(input);
		if (input && typeof input === "object" && typeof input.url === "string") return new URL(input.url);
	} catch {}
	return undefined;
}

/** Exact host or any subdomain of a listed entry, case-insensitive. */
export function hostMatches(hostname, hosts) {
	const h = String(hostname ?? "").toLowerCase();
	if (h === "") return false;
	return (hosts ?? []).some((entry) => {
		const target = String(entry).toLowerCase().trim();
		if (target === "") return false;
		return h === target || h.endsWith(`.${target}`);
	});
}

/** FNV-1a 32-bit, rendered as 8 lowercase hex chars. */
function fnv1a32(text) {
	let hash = 2166136261;
	for (const ch of String(text)) {
		hash ^= ch.codePointAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

/** Base62 alphabet the Zen relay accepts in the random tail of a session id. */
const ID_TAIL_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Body length after the `ses_`/`msg_` prefix that the relay accepts. */
const ID_BODY_LENGTH = 26;
/** Leading lowercase-hex run; the real client encodes a millisecond timestamp here. */
const ID_HEAD_LENGTH = 12;

/**
 * Stable id derived from a seed, shaped like the official opencode client's
 * ids: 12 lowercase hex characters followed by 14 base62 characters.
 *
 * Both halves of that shape are load-bearing. The Zen relay refuses an id whose
 * leading 12 characters are not lowercase hex, and refuses any body length
 * other than 26; it answers such a request with `FreeTierError` regardless of
 * which other identity headers accompany it. The previous FNV-1a 16-hex shape
 * here was rejected on both counts.
 *
 * Stability is still the point: Zen routes by hashing the tail of
 * `x-opencode-session`, so a per-request random id sends every turn to a
 * different (often unavailable) upstream and tanks the hit rate.
 */
export function stableZenId(seed) {
	const head = `${fnv1a32(`${seed}:h0`).toString(16).padStart(8, "0")}${fnv1a32(`${seed}:h1`).toString(16).padStart(8, "0")}`.slice(0, ID_HEAD_LENGTH);
	let tail = "";
	for (let index = 0; tail.length < ID_BODY_LENGTH - ID_HEAD_LENGTH; index += 1) {
		tail += ID_TAIL_ALPHABET[fnv1a32(`${seed}:t${index}`) % ID_TAIL_ALPHABET.length];
	}
	return head + tail;
}

/** Stable per-provider project id: two Zen routes never share one. */
export function opencodeProjectId(provider) {
	return `proj_${fnv1a32(provider ?? "opencode").toString(16).padStart(8, "0")}`;
}

/**
 * Build the identity headers for one request. Pure: every input is explicit.
 * @param settings - resolved plugin settings.
 * @param sessionId - DSH conversation id, or "" outside an LLM call.
 * @returns the headers to stamp (never empty unless the plugin is disabled).
 */
export function buildZenHeaders(settings, sessionId) {
	const seed = sessionId !== undefined && sessionId !== null && String(sessionId) !== "" ? String(sessionId) : String(settings.fallbackSession ?? DEFAULT_FALLBACK_SESSION);
	const provider = String(settings.provider ?? "opencode");
	const sessionIdValue = settings.sessionMode === "random"
		? `ses_${stableZenId(`${seed}:${provider}:${Math.random()}`)}`
		: `ses_${stableZenId(`${seed}:${provider}`)}`;
	const headers = {
		"user-agent": String(settings.userAgent ?? DEFAULT_USER_AGENT),
		"x-opencode-client": "cli",
		"x-opencode-session": sessionIdValue,
		"x-opencode-request": `usr_${stableZenId(`${seed}:${provider}:request`)}`,
		"x-opencode-project": settings.project !== undefined && String(settings.project) !== ""
			? String(settings.project)
			: opencodeProjectId(provider)
	};
	return { ...headers, ...(settings.extraHeaders ?? {}) };
}

// ---------------------------------------------------------------------------
// free-tier tool gate
//
// Measured 2026-09-21 (gate53/gate54, every control healthy): the Zen free tier
// refuses a tool-calling request whose `tools` array lacks a tool NAMED `bash`
// or a tool NAMED `read`. Nothing else about the array matters:
//
// | tools sent                              | result |
// |---|---|
// | cli tools (bash..write, 11)             | 200 |
// | cli tools[0:6]                          | 200 |
// | cli tools[0:6] minus `read`             | 403 |
// | cli tools[0:6] minus `bash`             | 403 |
// | cli tools[0:4] (no `read`)              | 403 |
// | cli tools[0:4] + 2 dummy tools          | 403 |
// | {bash, edit, read, skill} only          | 200 |
// | DSH tools (51, ships `pwsh` not `bash`) | 403 |
// | DSH tools + minimal synthetic `bash`    | 200 |
// | DSH tools with `pwsh` renamed to `bash` | 200 |
// | DSH tools + `bash`, minus `read`        | 403 |
// | {bash, read} stubs alone (2 tools)      | 200 |
//
// So count, byte size, `$schema`, `required`, `strict` and descriptions are all
// irrelevant — the check is two literal names. That is why a DSH request 403s
// no matter how correct its identity headers are: DSH names its shell tool
// `pwsh` and never sends `bash`.
//
// The stubs below are therefore a compatibility shim, not tools: they exist to
// satisfy the name check, and their descriptions say so, so a model that reads
// the tool list is steered to the real tools instead of calling them.
// ---------------------------------------------------------------------------

/** Tool names the Zen free tier requires to be present in `tools`. */
export const GATE_TOOL_NAMES = Object.freeze(["bash", "read"]);

/** Descriptions/parameters for the shim tools, per name. */
const GATE_TOOL_STUBS = Object.freeze({
	bash: Object.freeze({
		description: "Compatibility shim required by the OpenCode Zen free tier, which refuses any tool list without a tool named `bash`. This tool is NOT implemented — never call it; use `pwsh` to run shell commands.",
		parameters: Object.freeze({
			type: "object",
			properties: Object.freeze({ command: Object.freeze({ type: "string", description: "Unused: this tool is not implemented." }) }),
			required: Object.freeze(["command"])
		})
	}),
	read: Object.freeze({
		description: "Compatibility shim required by the OpenCode Zen free tier, which refuses any tool list without a tool named `read`. This tool is NOT implemented — never call it; use the filesystem tools to read files.",
		parameters: Object.freeze({
			type: "object",
			properties: Object.freeze({ filePath: Object.freeze({ type: "string", description: "Unused: this tool is not implemented." }) }),
			required: Object.freeze(["filePath"])
		})
	})
});

/**
 * Which tool-declaration shape a `tools` array uses.
 *
 * The three wires DSH speaks differ, and the gate matches on the name wherever
 * it sits, so the stub must be built in the shape the endpoint already expects:
 *  - `chat`      openai-completions: `{type, function:{name, description, parameters}}`
 *  - `responses` openai-responses:   `{type, name, description, parameters}`
 *  - `anthropic` anthropic-messages: `{name, description, input_schema}`
 * @param tools - the outgoing `tools` array.
 * @returns the shape name, or undefined when it cannot be told from the array.
 */
export function detectToolShape(tools) {
	for (const tool of tools ?? []) {
		if (tool === null || typeof tool !== "object") continue;
		if (tool.function !== null && typeof tool.function === "object") return "chat";
		if (tool.input_schema !== undefined) return "anthropic";
		if (typeof tool.name === "string" && tool.parameters !== undefined) return "responses";
	}
	return undefined;
}

/** The wire path implied by an endpoint URL, used when `tools` is empty. */
export function shapeForUrl(url) {
	const path = String(url?.pathname ?? "");
	if (path.includes("/messages")) return "anthropic";
	if (path.includes("/responses")) return "responses";
	return "chat";
}

/** Build one shim tool in the given wire shape. */
export function buildGateTool(name, shape) {
	const stub = GATE_TOOL_STUBS[name];
	if (stub === undefined) throw new TypeError(`no gate-tool stub for ${JSON.stringify(String(name))}`);
	if (shape === "anthropic") return { name, description: stub.description, input_schema: stub.parameters };
	if (shape === "responses") return { type: "function", name, description: stub.description, parameters: stub.parameters };
	return { type: "function", function: { name, description: stub.description, parameters: stub.parameters } };
}

/** The name a tool declaration carries, whichever wire shape it uses. */
export function toolNameOf(tool) {
	const nested = tool?.function?.name;
	if (typeof nested === "string") return nested;
	return typeof tool?.name === "string" ? tool.name : undefined;
}

/**
 * Append a shim for every required name that is missing.
 *
 * Appends rather than prepends so the existing (cacheable) prefix of the tool
 * list is untouched, and a fully-compliant list is returned unmodified so no
 * request is re-serialized needlessly.
 * @param tools - the outgoing `tools` array.
 * @param shape - wire shape for any stub added.
 * @param names - required names; defaults to {@link GATE_TOOL_NAMES}.
 * @returns `{ tools, injected }`; `injected` is empty when nothing was missing.
 */
export function ensureGateTools(tools, shape, names = GATE_TOOL_NAMES) {
	const present = new Set();
	for (const tool of tools ?? []) {
		const toolName = toolNameOf(tool);
		if (toolName !== undefined) present.add(toolName);
	}
	const next = [...(tools ?? [])];
	const injected = [];
	for (const name of names) {
		if (present.has(name)) continue;
		next.push(buildGateTool(name, shape));
		injected.push(name);
	}
	return { tools: next, injected };
}

/** Read a fetch body of any of the forms Node's fetch accepts, as UTF-8 text. */
async function readBodyText(body) {
	if (body === undefined || body === null) return undefined;
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(body);
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
	if (typeof body.getReader === "function") {
		const reader = body.getReader();
		const chunks = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done === true) break;
			const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
			chunks.push(bytes);
			total += bytes.length;
		}
		const all = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			all.set(chunk, offset);
			offset += chunk.length;
		}
		return new TextDecoder().decode(all);
	}
	return undefined;
}

/**
 * Add the required shim tools to a JSON request body.
 *
 * @param body - the outgoing fetch body.
 * @param url - the resolved request URL, used to pick a shape.
 * @param settings - resolved plugin settings.
 * @returns `{ text, injected }` where `text` is ALWAYS the body the caller must
 *   send, or undefined when the body could not be read at all (a `Blob`/
 *   `FormData` body, which is left untouched and never consumed).
 *
 * The "always return the text" contract matters: reading a stream body consumes
 * it, so a caller that kept the original on a parse failure would send a drained
 * body. A body with no tool surface, or one that is not JSON, comes back
 * unchanged with an empty `injected`.
 */
export async function rewriteGateTools(body, url, settings) {
	const text = await readBodyText(body);
	if (text === undefined) return undefined;
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		// Not JSON — pass the original bytes through, but still hand back the text
		// so a consumed stream is replaced rather than sent empty.
		return { text, injected: [] };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { text, injected: [] };
	if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) return { text, injected: [] };
	const shape = detectToolShape(parsed.tools) ?? shapeForUrl(url);
	const { tools, injected } = ensureGateTools(parsed.tools, shape, settings?.gateToolNames ?? GATE_TOOL_NAMES);
	if (injected.length === 0) return { text, injected };
	return { text: JSON.stringify({ ...parsed, tools }), injected };
}

/**
 * Build the fetch middleware.
 * @param options - `{ getSettings }`, consulted per matching request so edits
 *   take effect without a restart.
 */
export function createZenHeaderMiddleware(options) {
	const getSettings = options.getSettings;
	return async function zenHeaderMiddleware({ input, init, next }) {
		const settings = getSettings();
		if (settings?.enabled !== true) return next(input, init);
		const url = requestUrlOf(input);
		if (url === undefined) return next(input, init);
		if (!hostMatches(url.hostname, settings.hosts ?? DEFAULT_HOSTS)) return next(input, init);

		const store = requestSessionContext.getStore();
		const headers = buildZenHeaders(settings, store ?? "");

		// Per the fetch spec, `init.headers` (when present) replaces the Request's
		// own headers, so merge whichever source would actually reach the wire.
		const source = init && init.headers !== undefined
			? init.headers
			: input && typeof input === "object" && input.headers
				? input.headers
				: undefined;
		const merged = new Headers(source ?? undefined);
		for (const [headerName, value] of Object.entries(headers)) {
			if (value === undefined || value === null) continue;
			merged.set(headerName, String(value));
		}

		const nextInit = { ...init, headers: merged };

		// `init.body` wins over a Request's own body, so mirror the header logic.
		let body = init?.body;
		if (body === undefined && input !== null && typeof input === "object" && input.body !== undefined && input.body !== null) {
			body = input.body;
		}
		if (settings.injectGateTools !== false && body !== undefined && body !== null) {
			const rewritten = await rewriteGateTools(body, url, settings);
			if (rewritten !== undefined) {
				// A stream body has now been consumed, so the text must replace it even
				// when nothing was injected — otherwise the request would go out with a
				// drained body. For a string body with nothing injected this reassigns
				// the identical string, so it is a no-op.
				nextInit.body = rewritten.text;
				if (rewritten.injected.length > 0) {
					// The body grew, so any inherited length is now wrong.
					merged.delete("content-length");
					if (settings.debug === true) {
						options.logger?.info?.(`dsh-opencode-zen: injected gate tool(s) ${rewritten.injected.join(", ")} into ${url.pathname}`);
					}
				}
			}
		}
		return next(input, nextInit);
	};
}

/**
 * Build the `llm/stream` waterfall listener: re-emits the downstream stream with
 * every iterator step executed inside AsyncLocalStorage, so fetches issued while
 * iterating inherit this call's sessionId.
 */
export function createLlmStreamListener(sessionContext) {
	return function llmStreamObserver(options, next) {
		const sessionKey = String(options?.sessionId ?? "");
		const iterator = next()[Symbol.asyncIterator]();
		const doneResult = () => ({ done: true, value: undefined });
		const run = (fn) => sessionContext.run(sessionKey, fn);
		return {
			[Symbol.asyncIterator]() {
				return {
					next: () => run(() => iterator.next()),
					return: () => run(() => (iterator.return ? iterator.return() : Promise.resolve(doneResult()))),
					throw: (error) => run(() => (iterator.throw ? iterator.throw(error) : Promise.resolve(doneResult())))
				};
			}
		};
	};
}

// ---------------------------------------------------------------------------
// settings schema + defaults
// ---------------------------------------------------------------------------

/**
 * The plugin's editable configuration.
 *
 * DSH 0.1.7 replaced the old `settings.register(namespace, schema, opts)`
 * service API: a plugin now exports `Config`, the Loader validates it, and
 * `@deepseek-ai/dsh-settings` projects the fields marked `.volatile()` into a
 * form keyed by this entry's id. Unmarked fields stay ordinary configuration
 * (editable only through Cordis patch files), so every field here is marked.
 *
 * The plugin instance is then mounted with `apply(ctx, config)`, where each
 * field arrives as a live `Volatile` reference: read it with `.get()` and the
 * value always reflects the current profile layer.
 */
export const Config = z.object({
	enabled: z.boolean().default(true).volatile(),
	userAgent: z.string().default(DEFAULT_USER_AGENT).volatile(),
	project: z.string().default("").volatile(),
	sessionMode: z.union([z.const("session"), z.const("random")]).default("session").volatile(),
	hosts: z.array(z.string()).default([...DEFAULT_HOSTS]).volatile(),
	fallbackSession: z.string().default(DEFAULT_FALLBACK_SESSION).volatile(),
	provider: z.string().default("opencode").volatile(),
	extraHeaders: z.dict(z.string()).default({}).volatile(),
	injectGateTools: z.boolean().default(true).volatile(),
	gateToolNames: z.array(z.string()).default([...GATE_TOOL_NAMES]).volatile(),
	debug: z.boolean().default(false).volatile()
});

/** Defaults mirrored here so tests and fallbacks stay in sync without the Loader. */
export function defaultSettings() {
	return {
		enabled: true,
		userAgent: DEFAULT_USER_AGENT,
		project: "",
		sessionMode: "session",
		hosts: [...DEFAULT_HOSTS],
		fallbackSession: DEFAULT_FALLBACK_SESSION,
		provider: "opencode",
		extraHeaders: {},
		injectGateTools: true,
		gateToolNames: [...GATE_TOOL_NAMES],
		debug: false
	};
}

/**
 * Read every volatile field through its reference.
 *
 * A field's reference is always present (the schema defaults each one), but a
 * profile layer may leave it unresolved, so each read falls back to the plain
 * default rather than trusting the reference blindly.
 * @param config - the validated Config the Loader passed to `apply`.
 * @returns a plain settings object shaped like {@link defaultSettings}.
 */
export function readConfig(config) {
	const fallback = defaultSettings();
	if (config === undefined || config === null) return fallback;
	const out = {};
	for (const key of Object.keys(fallback)) {
		const ref = config[key];
		const value = ref !== undefined && ref !== null && typeof ref.get === "function" ? ref.get() : ref;
		out[key] = value === undefined ? fallback[key] : value;
	}
	return out;
}

// ---------------------------------------------------------------------------
// cordis plugin surface
// ---------------------------------------------------------------------------

/**
 * Mount the plugin: register the settings namespace, install the fetch
 * middleware, observe `llm/stream` for the session id.
 * @param ctx - the host cordis context.
 * @param config - the validated {@link Config}; each field is a live reference.
 */
export function apply(ctx, config) {
	// Settings reads ride the Config references directly. DSH 0.1.7 removed the
	// old `settings.register(ns, schema, opts)` service call, so there is no
	// namespace to register and no scope to read through: the Loader validates
	// `Config` and hands the resolved references here.
	const readSettings = () => readConfig(config);

	ctx.effect(() => {
		registerFetchMiddleware({
			name: "dsh-opencode-zen-identity",
			priority: 8,
			middleware: createZenHeaderMiddleware({ getSettings: readSettings, logger: ctx.logger })
		});
		return () => unregisterFetchMiddleware("dsh-opencode-zen-identity");
	}, "dsh-opencode-zen: fetch middleware");

	ctx.on("llm/stream", createLlmStreamListener(requestSessionContext));

	const resolved = readSettings();
	ctx.logger.info(`dsh-opencode-zen: identity headers installed (hosts=${resolved.hosts.join(", ")}, enabled=${resolved.enabled === true}, gateTools=${resolved.injectGateTools === false ? "off" : (resolved.gateToolNames ?? []).join("+") || "off"})`);
	// The free tier parses the client version out of user-agent and refuses
	// anything below MIN_CLIENT_VERSION, so a mis-set UA is a silent outage:
	// the plugin still stamps every header and the request still 403/426s.
	if (resolved.enabled === true && !clientVersionMeetsFloor(resolved.userAgent)) {
		ctx.logger.warn(`dsh-opencode-zen: user-agent ${JSON.stringify(String(resolved.userAgent))} names no OpenCode version >= ${MIN_CLIENT_VERSION.join(".")}; the Zen free tier will refuse every request (426 UpgradeRequired). Set the "User-Agent" field on the dsh-opencode-zen plugin page to at least opencode/${MIN_CLIENT_VERSION.join(".")}.`);
	}
}

export default apply;
