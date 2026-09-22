/**
 * Host-half mount test: drives `apply(ctx, config)` against a fake cordis
 * context and a real `Config` schema, then asserts the observable behaviour.
 *
 * This is the test that catches an `effect`/`on` wiring mistake that
 * unit-testing the pure helpers would never see, and it pins the 0.1.7 host
 * contract: `Config` is exported, its fields are volatile references, and
 * `apply` reads them with `.get()` — there is no `settings.register` anymore.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const mod = await import(new URL("../lib/index.js", import.meta.url).href);

// ── the exported Config schema is the 0.1.7 host contract ──────────────────
assert.ok(mod.Config, "exports a Config schema (the Loader picks this up as runtime.Config)");

const resolved = mod.Config["~standard"].validate({});
assert.equal(resolved.issues, undefined, "Config validates an empty object");

// Every editable field must be volatile, or @deepseek-ai/dsh-settings projects
// no form for it and the Plugins page shows nothing to edit.
const expectedFields = [
	"enabled", "userAgent", "project", "sessionMode", "hosts", "fallbackSession",
	"provider", "extraHeaders", "injectGateTools", "gateToolNames", "debug"
];
for (const field of expectedFields) {
	const ref = resolved.value[field];
	assert.ok(ref !== undefined, `Config declares ${field}`);
	assert.equal(typeof ref.get, "function", `${field} resolves to a volatile reference (.get)`);
}
assert.deepEqual(Object.keys(resolved.value).sort(), [...expectedFields].sort(), "Config declares exactly the editable fields");

// Defaults resolve through the references.
assert.equal(resolved.value.enabled.get(), true, "enabled defaults to true");
assert.equal(resolved.value.sessionMode.get(), "session", "union default resolves");
assert.deepEqual(JSON.parse(JSON.stringify(resolved.value.hosts.get())), ["opencode.ai"]);
assert.equal(resolved.value.userAgent.get(), mod.DEFAULT_USER_AGENT);
assert.equal(resolved.value.fallbackSession.get(), "dsh-default");
assert.equal(resolved.value.provider.get(), "opencode");
assert.equal(resolved.value.injectGateTools.get(), true, "gate-tool injection defaults on");
assert.deepEqual(JSON.parse(JSON.stringify(resolved.value.gateToolNames.get())), ["bash", "read"]);
assert.equal(resolved.value.debug.get(), false);

// A profile layer overrides a field without disturbing the others.
const overridden = mod.Config["~standard"].validate({ enabled: false, sessionMode: "random" });
assert.equal(overridden.value.enabled.get(), false, "a supplied value overrides the default");
assert.equal(overridden.value.sessionMode.get(), "random");
assert.equal(overridden.value.provider.get(), "opencode", "untouched fields keep their defaults");

// unknown sessionMode is rejected by the union
assert.ok(
	mod.Config["~standard"].validate({ sessionMode: "nonsense" }).issues,
	"union rejects unknown values"
);

assert.deepEqual(
	JSON.parse(JSON.stringify(mod.defaultSettings())).gateToolNames,
	["bash", "read"],
	"defaultSettings mirrors the schema default"
);

// ── readConfig reads every reference and tolerates a missing layer ─────────
const read = mod.readConfig(resolved.value);
assert.equal(read.enabled, true);
assert.equal(read.provider, "opencode");
assert.deepEqual(read.gateToolNames, ["bash", "read"]);
assert.deepEqual(
	mod.readConfig(undefined),
	mod.defaultSettings(),
	"readConfig falls back to the defaults when no config was resolved"
);

// ── fake cordis ctx ────────────────────────────────────────────────────────
const effects = [];
const listeners = [];

const ctx = {
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

mod.apply(ctx, resolved.value);

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

// ── the middleware reads the live reference, not a startup snapshot ────────
// This is the 0.1.7 behaviour that replaces the old settings scope: editing the
// field in the Plugins page must be visible to the next request with no restart.
const live = mod.Config["~standard"].validate({ enabled: true, project: "before" });
const liveCtx = {
	effect(fn) { fn(); return () => {}; },
	on() { return () => {}; },
	logger: { info: () => {}, warn: () => {}, error: () => {} }
};
mod.apply(liveCtx, live.value);
const liveState = globalThis[Symbol.for("dsh-opencode-zen.fetch.pipeline.v1")];
const middleware = liveState.middlewares.find((entry) => entry.name === "dsh-opencode-zen-identity");
assert.ok(middleware, "the live middleware is the one this apply installed");

/** Run one request through the middleware and return the headers that reached `next`. */
const headersFor = async () => {
	let seen = null;
	await middleware.middleware({
		input: "https://opencode.ai/zen/v1/chat/completions",
		init: { headers: {} },
		next: async (_input, init) => {
			seen = init.headers;
			return new Response("ok");
		}
	});
	return seen;
};
const first = await headersFor();
assert.equal(first.get("x-opencode-project"), "before", "reads the project field");

// The reference is frozen and updated in place by the owning runtime, which is
// exactly what the Loader does on a settings write; emulate that update.
live.value.project[Symbol.for("cosmokit.volatile.write")]("after");
const second = await headersFor();
assert.equal(second.get("x-opencode-project"), "after", "a later write is visible without remounting");

// ── teardown restores the chain ────────────────────────────────────────────
liveState.middlewares.length = 0;
effects.length = 0;
mod.apply(ctx, resolved.value);
assert.equal(
	globalThis[Symbol.for("dsh-opencode-zen.fetch.pipeline.v1")].middlewares.length,
	1,
	"a fresh apply installs one middleware"
);
effects[0].dispose();
assert.equal(
	globalThis[Symbol.for("dsh-opencode-zen.fetch.pipeline.v1")].middlewares.length,
	0,
	"effect disposer unregisters the middleware"
);

console.log("dsh-opencode-zen host mount: all check groups passed");
console.log("  Config/volatile fields, defaults, readConfig, effect, llm/stream listener, live writes, teardown — OK");
