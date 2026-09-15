/**
 * Host-half mount test: drives `apply(ctx)` against a fake cordis context and a
 * fake settings service, then asserts the observable registration behaviour.
 *
 * This is the test that catches an `inject`/`effect`/`on` wiring mistake that
 * unit-testing the pure helpers would never see.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const settingsUrl = pathToFileURL(require.resolve("@deepseek-ai/dsh-settings", { paths: ["C:/Users/YURi/.dsh/profiles/web"] }));

const mod = await import(new URL("../lib/index.js", import.meta.url).href);

// ── fake cordis ctx ────────────────────────────────────────────────────────
const effects = [];
const listeners = [];
let injectedWith = null;
let registeredNs = null;
let registeredSchema = null;
let currentValue = null;

const fakeScope = {
	get: () => currentValue,
	watch: () => () => {},
	subscribe: () => () => {}
};

const ctx = {
	inject(services, callback) {
		injectedWith = services;
		// The real service provides `settings.register(ns, schema, opts)`.
		const settingsCtx = {
			settings: {
				register(ns, schema, options) {
					registeredNs = ns;
					registeredSchema = schema;
					currentValue = { ...(options?.base ?? {}) };
					return fakeScope;
				}
			}
		};
		return callback(settingsCtx);
	},
	effect(fn, label) {
		const dispose = fn();
		effects.push({ label, dispose });
		return () => {};
	},
	on(name, listener) {
		listeners.push({ name, listener });
		return () => {};
	},
	logger: { info: () => {}, warn: () => {}, error: () => {} }
};

mod.apply(ctx);

assert.deepEqual(injectedWith, ["settings"], "requires the settings service");
assert.equal(registeredNs, "opencode-zen", "registers the opencode-zen namespace as a plain string");
assert.ok(registeredSchema, "passes a schema");

// ── the schema resolves defaults through schemastery ───────────────────────
const resolved = registeredSchema({});
assert.equal(resolved.enabled, true, "enabled defaults to true");
assert.equal(resolved.sessionMode, "session", "union default resolves");
assert.deepEqual(JSON.parse(JSON.stringify(resolved.hosts)), ["opencode.ai"]);
assert.equal(resolved.userAgent, mod.DEFAULT_USER_AGENT);
assert.equal(resolved.fallbackSession, "dsh-default");
assert.equal(resolved.provider, "opencode");
assert.equal(resolved.debug, false);

// unknown sessionMode is rejected by the union
assert.throws(() => registeredSchema({ sessionMode: "nonsense" }), "union rejects unknown values");

// ── effect + listener wiring ───────────────────────────────────────────────
assert.equal(effects.length, 1, "installs exactly one effect (the fetch middleware)");
assert.match(effects[0].label, /fetch middleware/);
assert.equal(listeners.length, 1, "subscribes exactly one event");
assert.equal(listeners[0].name, "llm/stream", "observes llm/stream for the session id");

// ── the middleware actually reaches globalThis.fetch ───────────────────────
const state = globalThis[Symbol.for("dsh-opencode-zen.fetch.pipeline.v1")];
assert.ok(state, "fetch pipeline state installed on globalThis under the plugin's symbol");
assert.equal(state.middlewares.length, 1, "one middleware registered");
assert.equal(state.middlewares[0].name, "dsh-opencode-zen-identity");

// installing the pipeline replaces globalThis.fetch with a live getter
assert.equal(typeof globalThis.fetch, "function", "globalThis.fetch still callable after install");

// ── teardown restores the chain ────────────────────────────────────────────
effects[0].dispose();
assert.equal(state.middlewares.length, 0, "effect disposer unregisters the middleware");

console.log("dsh-opencode-zen host mount: all check groups passed");
console.log("  inject, namespace, schema defaults, effect, llm/stream listener, teardown — OK");
