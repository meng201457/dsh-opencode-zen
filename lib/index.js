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
 *    passes through byte-for-byte untouched.
 *
 * `@deepseek-ai/dsh-http-proxy` documents that "the pi-ai provider stack"
 * reaches `globalThis.fetch`, and pi-ai passes no explicit `fetch` to the
 * OpenAI SDK, so the SDK resolves the global at per-request client
 * construction. Verified empirically, not assumed.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import z from "schemastery";

export const name = "dsh-opencode-zen";

/** Settings namespace owned by this plugin (lowercase, digits, dashes only). */
export const SETTINGS_NAMESPACE = "opencode-zen";

/** Default allowlist: Zen/Go live on opencode.ai; subdomains match too. */
export const DEFAULT_HOSTS = ["opencode.ai"];

/** Session id used outside an LLM call (e.g. model discovery). */
export const DEFAULT_FALLBACK_SESSION = "dsh-default";

/**
 * Default user-agent. Measured on 2026-09-15: the Zen gateway returned 200 for
 * this value, for a bare `deepseek-harness/...`, for `curl/8.7.1`, and for no
 * user-agent at all — so UA content was NOT the 200/429 switch in that run.
 * The official docs still ask clients to identify themselves, and the value is
 * a setting so upstream tightening costs an edit rather than a rebuild.
 */
export const DEFAULT_USER_AGENT = "opencode/latest/1.18.30/cli";

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

/**
 * Stable 16-hex-char id derived from a seed. Stability is the point: Zen routes
 * by hashing the tail of `x-opencode-session`, so a per-request random id sends
 * every turn to a different (often unavailable) upstream and tanks the hit rate.
 */
export function stableZenId(seed) {
	const h = fnv1a32(seed);
	return `${h.toString(16).padStart(8, "0")}${(Math.imul(h, 2654435761) >>> 0).toString(16).padStart(8, "0")}`;
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
		return next(input, { ...init, headers: merged });
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

export const SettingsSchema = z.object({
	enabled: z.boolean().default(true),
	userAgent: z.string().default(DEFAULT_USER_AGENT),
	project: z.string().default(""),
	sessionMode: z.union([z.const("session"), z.const("random")]).default("session"),
	hosts: z.array(z.string()).default([...DEFAULT_HOSTS]),
	fallbackSession: z.string().default(DEFAULT_FALLBACK_SESSION),
	provider: z.string().default("opencode"),
	extraHeaders: z.dict(z.string()).default({}),
	debug: z.boolean().default(false)
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
		debug: false
	};
}

// ---------------------------------------------------------------------------
// cordis plugin surface
// ---------------------------------------------------------------------------

/**
 * Mount the plugin: register the settings namespace, install the fetch
 * middleware, observe `llm/stream` for the session id.
 * @param ctx - the host cordis context.
 */
export function apply(ctx) {
	ctx.inject(["settings"], (settingsCtx) => {
		// `settingsNamespace()` was REMOVED from @deepseek-ai/dsh-settings; the
		// namespace is now a plain string validated by the service itself.
		const scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, SettingsSchema, {
			base: defaultSettings()
		});
		const readSettings = () => ({ ...defaultSettings(), ...(scope.get() ?? {}) });

		ctx.effect(() => {
			registerFetchMiddleware({
				name: "dsh-opencode-zen-identity",
				priority: 8,
				middleware: createZenHeaderMiddleware({ getSettings: readSettings })
			});
			return () => unregisterFetchMiddleware("dsh-opencode-zen-identity");
		}, "dsh-opencode-zen: fetch middleware");

		ctx.on("llm/stream", createLlmStreamListener(requestSessionContext));

		const resolved = readSettings();
		ctx.logger.info(`dsh-opencode-zen: identity headers installed (hosts=${resolved.hosts.join(", ")}, enabled=${resolved.enabled === true})`);
	});
}

export default apply;
