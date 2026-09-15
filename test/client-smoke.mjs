/**
 * Smoke test for the dsh-opencode-zen browser half.
 *
 * Simulates the client module system without a browser:
 *  - provides `window.__ModuleLoader__.load` and captures the factory;
 *  - materializes the factory with a stub `require("react")`;
 *  - calls the exported `apply(ctx)` against a fake cordis ctx + settings scope;
 *  - drives the section controller (draft, validation, save -> scope.set) and
 *    renders the section component to verify it builds an element tree.
 */
import vm from "node:vm";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

let captured = null;
const windowObj = {
	__ModuleLoader__: {
		load(item) {
			captured = item;
		}
	}
};

const fakeReact = {
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
	useState: (init) => [init, () => {}]
};

const context = vm.createContext({
	window: windowObj,
	console,
	URL,
	Set,
	Map,
	Object,
	Array,
	JSON,
	Date,
	Math,
	Symbol,
	RegExp,
	Error,
	undefined
});
vm.runInContext(source, context, { filename: "client.js" });

assert.ok(captured !== null, "factory registered via __ModuleLoader__.load");
assert.equal(captured.id, "dsh-opencode-zen");

const moduleExports = captured.factory(function require(specifier) {
	if (specifier === "react") return fakeReact;
	throw new Error(`unexpected require: ${specifier}`);
});
assert.equal(typeof moduleExports.apply, "function");
assert.equal([...moduleExports.inject].join(","), "slots,locale,settingsScope");

// ── parser unit checks (exported for exactly this) ──
// NOTE: values produced inside the vm realm have foreign prototypes, so compare
// structurally via JSON rather than deepStrictEqual.
const json = (v) => JSON.stringify(v);
assert.equal(json(moduleExports.parseHosts("opencode.ai\n\n  api.opencode.ai  ")), json(["opencode.ai", "api.opencode.ai"]));
assert.equal(json(moduleExports.parseExtraHeaders("x-a: 1\n\nnot a header\nx-b: two")), json({ "x-a": "1", "x-b": "two" }));
assert.equal(moduleExports.validUserAgent("opencode/latest/1.18.30/cli"), true);
assert.equal(moduleExports.validUserAgent("opencode/1.18.30"), true);
assert.equal(moduleExports.validUserAgent("curl/8.7.1"), true);
assert.equal(moduleExports.validUserAgent(""), false);
assert.equal(moduleExports.validUserAgent("no-slash-here"), false);
assert.equal(moduleExports.validHosts("opencode.ai\napi.opencode.ai"), true);
assert.equal(moduleExports.validHosts("has space.com"), false);
assert.equal(moduleExports.validHosts("not a domain"), false);

// ── fake cordis ctx + settings scope ──
const writes = [];
const seeded = {
	enabled: true,
	userAgent: "opencode/latest/1.18.30/cli",
	project: "",
	sessionMode: "session",
	hosts: ["opencode.ai"],
	fallbackSession: "dsh-default",
	provider: "opencode",
	extraHeaders: {},
	debug: false
};
let currentValue = JSON.parse(JSON.stringify(seeded));
const scopeListeners = new Set();
const fakeScope = {
	getSnapshot() {
		return { status: "ready", writable: true, value: currentValue, base: {}, user: {}, revision: 1 };
	},
	subscribe(fn) {
		scopeListeners.add(fn);
		return () => scopeListeners.delete(fn);
	},
	async set(field, value) {
		writes.push([field, value]);
		currentValue = { ...currentValue, [field]: JSON.parse(JSON.stringify(value)) };
		for (const fn of [...scopeListeners]) {
			try { fn(); } catch (e) { console.error("listener error:", e); }
		}
	}
};
const slotsInjectCalls = [];
const registered = [];
const fakeCtx = {
	settingsScope: { bind: (spec) => { assert.equal(spec.namespace, "opencode-zen"); return fakeScope; } },
	slots: {
		register(options, component) {
			return { ...options, component };
		},
		inject(name, callback) {
			slotsInjectCalls.push(name);
			for (const d of callback() ?? []) registered.push(d);
			return () => {};
		}
	},
	locale: {
		register(ns, dict) {
			assert.equal(ns, "dsh-opencode-zen");
			assert.ok(dict.zh && dict.en);
			return () => {};
		},
		getSnapshot: () => ({ active: "zh-CN", locales: [], revision: 0 })
	},
	effect(fn) {
		const ret = fn();
		return typeof ret === "function" ? ret : () => {};
	}
};
moduleExports.apply(fakeCtx);

assert.deepEqual(slotsInjectCalls, ["settings.section"], "registers a dedicated settings SECTION");
assert.equal(registered.length, 1);
const section = registered[0];
assert.equal(section.name, "settings.section");
assert.equal(section.id, "opencode-zen");
assert.equal(section.locale, "dsh-opencode-zen");
assert.equal(section.label(), "OpenCode Zen", "nav label follows the active locale");

// ── drive the controller ──
const face = section.inject();
assert.ok(face.hooks.opencodeZenSettings, "store exposed as hook source");

let snap = face.hooks.opencodeZenSettings.getSnapshot();
assert.equal(snap.available, true);
assert.equal(snap.dirty, false);
assert.equal(snap.draft.userAgent, "opencode/latest/1.18.30/cli");
assert.equal(snap.hostsText, "opencode.ai");

face.editUserAgent("opencode/1.18.30");
snap = face.hooks.opencodeZenSettings.getSnapshot();
assert.equal(snap.dirty, true);
assert.equal(snap.invalid, false);

// a UA without a slash is rejected
face.editUserAgent("bogus");
assert.equal(face.hooks.opencodeZenSettings.getSnapshot().invalid, true, "UA without name/version is invalid");
face.editUserAgent("opencode/1.18.30");

// enabled with no hosts is invalid
face.editHosts("");
assert.equal(face.hooks.opencodeZenSettings.getSnapshot().invalid, true, "enabled + no hosts is invalid");
face.editHosts("opencode.ai\napi.opencode.ai");
assert.equal(face.hooks.opencodeZenSettings.getSnapshot().invalid, false);

// a malformed host is invalid
face.editHosts("has space.com");
assert.equal(face.hooks.opencodeZenSettings.getSnapshot().invalid, true);
face.editHosts("opencode.ai");

// disabled short-circuits validation
face.editEnabled(false);
face.editUserAgent("bogus");
assert.equal(face.hooks.opencodeZenSettings.getSnapshot().invalid, false, "disabled ignores invalid fields");
face.editEnabled(true);
face.editUserAgent("opencode/1.18.30");

// extra headers round-trip through the textarea
face.editHeaders("x-opencode-project: global\nx-extra: 1");
assert.equal(json(face.hooks.opencodeZenSettings.getSnapshot().draft.extraHeaders), json({ "x-opencode-project": "global", "x-extra": "1" }));

face.editSessionMode("random");
face.editProvider("opencode-go");
face.editDebug(true);

await face.save();
assert.deepEqual(
	writes.map((w) => w[0]),
	["enabled", "userAgent", "project", "sessionMode", "hosts", "fallbackSession", "provider", "extraHeaders", "debug"]
);assert.equal(writes.find((w) => w[0] === "userAgent")[1], "opencode/1.18.30");
assert.equal(writes.find((w) => w[0] === "sessionMode")[1], "random");
assert.equal(json(writes.find((w) => w[0] === "extraHeaders")[1]), json({ "x-opencode-project": "global", "x-extra": "1" }));

const afterSave = face.hooks.opencodeZenSettings.getSnapshot();
assert.equal(afterSave.dirty, false);
assert.equal(afterSave.draft.provider, "opencode-go");
assert.equal(afterSave.headersText, "x-opencode-project: global\nx-extra: 1");

// discard restores the accepted value
face.editProvider("opencode");
assert.equal(face.hooks.opencodeZenSettings.getSnapshot().dirty, true);
face.discard();
snap = face.hooks.opencodeZenSettings.getSnapshot();
assert.equal(snap.dirty, false);
assert.equal(snap.draft.provider, "opencode-go", "discard re-seeds from the accepted value");

// ── render the section component ──
const component = section.component;
assert.ok(typeof component === "function", "section component captured via register payload");
const props = {
	t: (key) => String(key),
	useOpencodeZenSettings: (sel) => sel(face.hooks.opencodeZenSettings.getSnapshot()),
	editEnabled: face.editEnabled,
	editUserAgent: face.editUserAgent,
	editProject: face.editProject,
	editSessionMode: face.editSessionMode,
	editProvider: face.editProvider,
	editFallbackSession: face.editFallbackSession,
	editHosts: face.editHosts,
	editHeaders: face.editHeaders,
	editDebug: face.editDebug,
	save: face.save,
	discard: face.discard
};
const tree = component(props);
assert.equal(tree.type, "div", "section renders a div (settings page body)");
const text = JSON.stringify(tree);
assert.ok(text.includes("title"), "renders title copy");
assert.ok(text.includes("note1"), "renders the notes block");
assert.ok(text.includes("opencode.ai"), "renders the host list");
assert.ok(text.includes("opencode-go"), "renders the current provider");
assert.ok(text.includes("save"), "renders the save action");
assert.ok(text.includes("x-opencode-project"), "renders the extra-header textarea");

console.log("dsh-opencode-zen client smoke: all check groups passed");
console.log("  parsers, validation, section registration, save, discard, render — OK");
