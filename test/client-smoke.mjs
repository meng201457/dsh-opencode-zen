/**
 * Smoke test for the dsh-opencode-zen browser half.
 *
 * Simulates the client module system without a browser:
 *  - provides `window.__ModuleLoader__.load` and captures the factory;
 *  - materializes the factory with a stub `require("react")`;
 *  - calls the exported `apply(ctx)` against a fake cordis ctx exposing the
 *    0.1.7 `configForms` service (`get` / `whileServed`) plus `slots` and
 *    `locale`;
 *  - drives the configuration controller (draft, validation, save -> mutate),
 *    checks the served-entry gate, and renders the component to verify it
 *    builds an element tree.
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
assert.equal(
	[...moduleExports.inject].join(","),
	"slots,locale,configForms",
	"0.1.7 client services: settingsScope is gone, configForms replaces it"
);

// ── parser unit checks (exported for exactly this) ──
// NOTE: values produced inside the vm realm have foreign prototypes, so compare
// structurally via JSON rather than deepStrictEqual.
const json = (v) => JSON.stringify(v);
assert.equal(json(moduleExports.parseHosts("opencode.ai\n\n  api.opencode.ai  ")), json(["opencode.ai", "api.opencode.ai"]));
assert.equal(json(moduleExports.parseExtraHeaders("x-a: 1\n\nnot a header\nx-b: two")), json({ "x-a": "1", "x-b": "two" }));
assert.equal(moduleExports.validUserAgent("opencode/latest/1.18.30/cli"), true);
assert.equal(moduleExports.validUserAgent("opencode/1.18.30"), true);
assert.equal(moduleExports.validUserAgent("opencode/1.18.0"), true);
// The Zen free tier parses the version out of this header and refuses anything
// below 1.18.0 with 426, so a UA that names no usable version is invalid here.
assert.equal(moduleExports.validUserAgent("opencode/1.10.0"), false);
assert.equal(moduleExports.validUserAgent("opencode/latest"), false);
assert.equal(moduleExports.validUserAgent("curl/8.7.1"), false);
assert.equal(moduleExports.validUserAgent(""), false);
assert.equal(moduleExports.validUserAgent("no-slash-here"), false);
assert.equal(json(moduleExports.parseClientVersion("opencode/latest/1.18.30/cli")), json([1, 18, 30]));
assert.equal(moduleExports.clientVersionMeetsFloor("opencode/1.18.0"), true);
assert.equal(moduleExports.clientVersionMeetsFloor("opencode/1.17.99"), false);
assert.equal(moduleExports.validHosts("opencode.ai\napi.opencode.ai"), true);
assert.equal(moduleExports.validHosts("has space.com"), false);
assert.equal(moduleExports.validHosts("not a domain"), false);

// ── fake configForms form (the 0.1.7 shared ConfigForm) ──
const mutations = [];
let mutateAccepts = true;
const seeded = {
	enabled: true,
	userAgent: "opencode/latest/1.18.30/cli",
	project: "",
	sessionMode: "session",
	hosts: ["opencode.ai"],
	fallbackSession: "dsh-default",
	provider: "opencode",
	extraHeaders: {},
	injectGateTools: true,
	gateToolNames: ["bash", "read"],
	forceStream: true,
	debug: false
};
let currentValue = JSON.parse(JSON.stringify(seeded));
const formListeners = new Set();
const fakeForm = {
	getSnapshot() {
		return { status: "ready", writable: true, value: currentValue, base: {}, user: {}, revision: 1, mode: "host" };
	},
	subscribe(fn) {
		formListeners.add(fn);
		return () => formListeners.delete(fn);
	},
	async mutate(ops) {
		mutations.push(ops);
		if (!mutateAccepts) return false;
		const next = JSON.parse(JSON.stringify(currentValue));
		for (const op of ops) next[op.path[0]] = JSON.parse(JSON.stringify(op.value));
		currentValue = next;
		for (const fn of [...formListeners]) {
			try { fn(); } catch (e) { console.error("listener error:", e); }
		}
		return true;
	}
};
const slotsInjectCalls = [];
const registered = [];
const formIdsRequested = [];
// The Plugins page serves a bundle's configuration only while the Host serves
// the namespace, so the client half gates registration through `whileServed`.
let servedNamespaces = ["opencode-zen"];
const describeListeners = new Set();
const fakeDescribe = {
	getSnapshot: () => ({ view: { namespaces: servedNamespaces.map((ns) => ({ ns })) } }),
	subscribe(fn) {
		describeListeners.add(fn);
		return () => describeListeners.delete(fn);
	},
	ensure() {}
};
const publishServed = () => { for (const fn of [...describeListeners]) fn(); };
const fakeCtx = {
	configForms: {
		get(entryId) {
			formIdsRequested.push(entryId);
			return fakeForm;
		},
		// Mirrors @deepseek-ai/dsh-client-ui-settings: register once a watched
		// namespace is in the describe mirror, dispose when none is.
		whileServed(namespaces, register) {
			let off;
			const sync = () => {
				const served = new Set(fakeDescribe.getSnapshot().view?.namespaces.map((view) => view.ns) ?? []);
				const watched = namespaces.some((namespace) => served.has(namespace));
				if (watched && off === void 0) off = register(served);
				else if (!watched && off !== void 0) { off(); off = void 0; }
			};
			const unsubscribe = fakeDescribe.subscribe(sync);
			fakeDescribe.ensure();
			sync();
			return () => { unsubscribe(); if (off !== void 0) off(); off = void 0; };
		}
	},
	slots: {
		register(options, component) {
			const entry = { ...options, component };
			registered.push(entry);
			return () => {
				const index = registered.indexOf(entry);
				if (index >= 0) registered.splice(index, 1);
			};
		},
		inject(name, callback) {
			slotsInjectCalls.push(name);
			// The real contract: the callback returns one disposer (or an iterable
			// of them), installed through the caller's `ctx.effect`.
			const ret = callback();
			const disposers = typeof ret === "function" ? [ret] : [...(ret ?? [])];
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				for (const dispose of disposers) if (typeof dispose === "function") dispose();
			};
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

assert.deepEqual(
	formIdsRequested,
	["opencode-zen"],
	"asks configForms for the Host entry id from cordis.patch.yml, not the package name"
);
assert.deepEqual(slotsInjectCalls, ["plugins.bundle.config"], "registers into the Plugins page's bundle-configuration slot");
assert.equal(registered.length, 1);
const section = registered[0];
assert.equal(section.name, "plugins.bundle.config");
assert.equal(section.key, "dsh-opencode-zen", "keyed by this package's name");
assert.equal(section.locale, "dsh-opencode-zen");

// The form is withheld while the Host does not serve the entry, and appears
// when it starts to — the page pairs a bundle with its form by name, so a
// deployment without the host half must show no form at all.
servedNamespaces = ["someone-else"];
publishServed();
assert.equal(registered.length, 0, "the registration is withdrawn while the entry is unserved");
servedNamespaces = ["opencode-zen"];
publishServed();
assert.equal(registered.length, 1, "registers once the entry is served");
assert.equal(registered[0].key, "dsh-opencode-zen");

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

// gate-tool names round-trip, and reject a name that could never match
face.editGateToolNames("bash\nread\nskill");
assert.equal(json(face.hooks.opencodeZenSettings.getSnapshot().draft.gateToolNames), json(["bash", "read", "skill"]));
assert.equal(face.hooks.opencodeZenSettings.getSnapshot().invalid, false);
face.editGateToolNames("has space");
assert.equal(face.hooks.opencodeZenSettings.getSnapshot().invalid, true, "a tool name with a space is invalid");
face.editGateToolNames("bash\nread");

// the force-stream toggle round-trips through the draft
face.editForceStream(false);
assert.equal(face.hooks.opencodeZenSettings.getSnapshot().draft.forceStream, false);
face.editForceStream(true);
assert.equal(face.hooks.opencodeZenSettings.getSnapshot().draft.forceStream, true);

await face.save();
// One atomic mutation, not eleven independent writes: the Host applies the whole
// batch under a single revision fence.
assert.equal(mutations.length, 1, "save issues exactly one mutate call");
const ops = mutations[0];
assert.equal(
	json(ops.map((op) => op.path[0])),
	json(["enabled", "userAgent", "project", "sessionMode", "hosts", "proxyUrl", "fallbackSession", "provider", "extraHeaders",
		"injectGateTools", "gateToolNames", "forceStream", "debug"])
);
assert.equal(ops.every((op) => op.op === "set"), true, "every op is a set");
const valueOf = (field) => ops.find((op) => op.path[0] === field).value;
assert.equal(valueOf("userAgent"), "opencode/1.18.30");
assert.equal(valueOf("sessionMode"), "random");
assert.equal(json(valueOf("extraHeaders")), json({ "x-opencode-project": "global", "x-extra": "1" }));
assert.equal(valueOf("injectGateTools"), true);
assert.equal(json(valueOf("gateToolNames")), json(["bash", "read"]));
assert.equal(valueOf("forceStream"), true);

const afterSave = face.hooks.opencodeZenSettings.getSnapshot();
assert.equal(afterSave.dirty, false);
assert.equal(afterSave.draft.provider, "opencode-go");
assert.equal(afterSave.headersText, "x-opencode-project: global\nx-extra: 1");
assert.equal(afterSave.failed, false);

// a rejected mutation reports the failure and keeps the draft
mutateAccepts = false;
face.editProvider("rejected-provider");
await face.save();
snap = face.hooks.opencodeZenSettings.getSnapshot();
assert.equal(snap.failed, true, "a rejected mutate surfaces as failed");
assert.equal(snap.draft.provider, "rejected-provider", "the draft survives a rejected write");
mutateAccepts = true;
face.discard();

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
	editProxyUrl: face.editProxyUrl,
	editHeaders: face.editHeaders,
	editInjectGateTools: face.editInjectGateTools,
	editGateToolNames: face.editGateToolNames,
	editForceStream: face.editForceStream,
	editDebug: face.editDebug,
	save: face.save,
	discard: face.discard
};
const tree = component(props);
assert.equal(tree.type, "div", "the form renders a div (the page supplies the title)");
const text = JSON.stringify(tree);
assert.ok(text.includes("opencode.ai"), "renders the host list");
assert.ok(text.includes("opencode-go"), "renders the current provider");
assert.ok(text.includes("save"), "renders the save action");
assert.ok(text.includes("x-opencode-project"), "renders the extra-header textarea");
assert.ok(text.includes("gateTools"), "renders the gate-tool toggle");
assert.ok(text.includes("forceStream"), "renders the force-stream toggle");
assert.ok(text.includes("bash"), "renders the required tool-name textarea");

// The tool-name field stays visible but disabled while injection is off
// (the stub createElement keeps children on `node.children`, not props).
const textareas = (node, found = []) => {
	if (node === null || typeof node !== "object") return found;
	if (Array.isArray(node)) { for (const child of node) textareas(child, found); return found; }
	if (node.props?.className === "dshoz-textarea") found.push(node);
	textareas(node.children, found);
	return found;
};
// Look fields up by placeholder, not by index: the layout groups them, so
// document order is a presentation choice and must not be pinned by the test.
const areaFor = (root, placeholderKey) => textareas(root).find((node) => node.props?.placeholder === placeholderKey);
const tree0 = component(props);
assert.equal(textareas(tree0).length, 3, "renders hosts, tool-name and extra-header textareas");
const gateArea = areaFor(tree0, "gateToolNamesPlaceholder");
assert.equal(gateArea.props.value, "bash\nread", "the tool-name textarea shows the required names");
assert.equal(gateArea.props.disabled, false);

face.editInjectGateTools(false);
const offTree = component({ ...props, useOpencodeZenSettings: (sel) => sel(face.hooks.opencodeZenSettings.getSnapshot()) });
const offArea = areaFor(offTree, "gateToolNamesPlaceholder");
assert.equal(offArea.props.disabled, true, "the tool-name field is disabled when injection is off");
assert.equal(textareas(offTree).length, 3, "the tool-name field stays visible when injection is off");
face.editInjectGateTools(true);
face.discard();

// ── layout: grouped fields, no explanatory copy ──
// The form is five named groups of labels and controls. Every hint, the lead
// paragraph and the collapsible notes block are gone, and that is pinned here:
// they are the shape of the form, and re-adding prose is a decision, not a
// refactor.
const titles = [];
const classes = new Set();
const types = new Set();
const walk = (node) => {
	if (node === null || typeof node !== "object") return;
	if (Array.isArray(node)) { node.forEach(walk); return; }
	if (typeof node.type === "string") types.add(node.type);
	if (node.props?.className === "dshoz-groupTitle") titles.push(Array.isArray(node.children) ? node.children[0] : node.children);
	for (const name of String(node.props?.className ?? "").split(" ")) if (name !== "") classes.add(name);
	walk(node.children);
};
walk(tree0);
assert.deepEqual(
	titles,
	["groupBasics", "groupIdentity", "groupNetwork", "groupFreeTier", "groupAdvanced"],
	"the fields are grouped into five named sections, in reading order"
);
for (const gone of ["dshoz-desc", "dshoz-notes", "dshoz-notesBody", "dshoz-step", "dshoz-hint", "dshoz-groupHint"]) {
	assert.equal(classes.has(gone), false, `no ${gone} element is rendered`);
}
assert.equal(types.has("details"), false, "no collapsible notes block");
assert.equal(classes.has("dshoz-check"), true, "switches still render as compact rows");
assert.equal(
	JSON.stringify(tree0).includes("'intro'") || JSON.stringify(tree0).includes('"intro"'),
	false,
	"no lead paragraph"
);
const checkboxRows = (() => {
	const stack = [tree0];
	let count = 0;
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === null || typeof node !== "object") continue;
		if (Array.isArray(node)) { stack.push(...node); continue; }
		if (node.props?.className === "dshoz-field dshoz-check") count += 1;
		if (node.children) stack.push(node.children);
	}
	return count;
})();
assert.equal(checkboxRows, 4, "the four switches keep the compact checkbox row");

console.log("dsh-opencode-zen client smoke: all check groups passed");
console.log("  parsers, validation, configForms entry id, bundle-config registration, served gate, mutate, discard, render — OK");
