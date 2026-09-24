/**
 * Loader-contract test: pins the export form the Cordis Loader actually
 * consumes.
 *
 * Why this file exists. `mount.mjs` asserts `mod.Config` on the *module
 * namespace*, which is not the object the Loader reads. `cordis-plugin-loader`
 * runs the namespace through `unwrapExports()` first, and that function's very
 * first statement is `exports = exports.default ?? exports`. An ESM namespace
 * has no `__esModule`, so `unwrapExports` returns immediately after that line:
 *
 *     unwrapExports(exports) {
 *       if (isNullable(exports)) return exports;
 *       exports = exports.default ?? exports;   // ← an `export default` wins here
 *       if (!exports.__esModule) return exports;
 *       return exports.default ?? exports;
 *     }
 *
 * So a plugin that ships `export function apply` *and* `export default apply`
 * hands the Loader the bare `apply` function, and every other named export —
 * `Config` above all — is silently dropped. `registry.plugin()` then stores
 * `Config: plugin.Config` as `undefined`, and `@deepseek-ai/dsh-settings`
 * filters an entry with no schema out of `describe()`. Net effect: the plugin
 * still works, but its configuration form is empty and no error is raised.
 *
 * `unwrapExports` is not importable from this package (`@deepseek-ai/cordis-plugin-loader`
 * is not a dependency and does not resolve here), so the five-line algorithm is
 * reproduced below. It is short, frozen in a released runtime, and quoted
 * verbatim above; the alternative — resolving it out of the runtime asar —
 * would make the test depend on an install path that differs per machine.
 * `_dsh_probe/probe-unwrap-real.mjs` cross-checks this reproduction against the
 * real implementation.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mod = await import(new URL("../lib/index.js", import.meta.url).href);
const source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");

/** Reproduce `cordis-plugin-loader`'s `unwrapExports` (see the note above). */
function unwrapExports(exports) {
	if (exports === null || exports === undefined) return exports;
	exports = exports.default ?? exports;
	if (!exports.__esModule) return exports;
	return exports.default ?? exports;
}

const plugin = unwrapExports(mod);

// ── the namespace itself must not carry a default export ───────────────────
assert.equal(
	Object.prototype.hasOwnProperty.call(mod, "default"),
	false,
	"lib/index.js must not have a default export — `unwrapExports` would return it and drop every named export"
);
assert.doesNotMatch(
	source,
	/^\s*export\s+default\b/mu,
	"no `export default` statement in the source"
);

// ── what the Loader ends up holding ────────────────────────────────────────
assert.equal(typeof plugin, "object", "unwrapExports yields the namespace, not a bare function");
assert.notEqual(plugin, null);

// `registry.plugin()` resolves the callback with `typeof plugin === "function"
// ? plugin : plugin.apply`, and only accepts an object carrying `apply`.
assert.equal(typeof plugin.apply, "function", "the unwrapped plugin carries `apply` (the activation callback)");

// `runtime.Config` is read straight off the unwrapped object. If this is
// undefined, `dsh-settings.describe()` drops the entry and the Plugins page
// renders no form for it — the exact regression this file guards.
assert.notEqual(plugin.Config, undefined, "the unwrapped plugin carries `Config` (the settings schema)");
assert.equal(typeof plugin.Config["~standard"]?.validate, "function", "`Config` is a real schemastery schema");

// `runtime.name` is also read off the unwrapped object, so a default export
// would leave the entry unnamed in the Loader's runtime record.
assert.equal(plugin.name, "dsh-opencode-zen", "the unwrapped plugin carries `name`");

// The loader must not be the only thing that works: `apply` has to be callable
// with the fake context `mount.mjs` uses.
assert.equal(typeof plugin.apply, "function");

// ── the failure mode, demonstrated ─────────────────────────────────────────
// Guard against a future refactor "simplifying" this file away: prove that the
// namespace-with-default shape really does lose `Config` through the same
// algorithm, so the assertion above is not vacuous.
const namespaceWithDefault = { ...mod, default: mod.apply };
const broken = unwrapExports(namespaceWithDefault);
assert.equal(typeof broken, "function", "a default export does collapse the plugin to a bare function");
assert.equal(broken.Config, undefined, "…which is why `Config` would be lost");

console.log("export form: lib/index.js survives unwrapExports with Config and name intact");
