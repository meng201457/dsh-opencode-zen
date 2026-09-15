/**
 * dsh-opencode-zen smoke test — no DSH boot, no network.
 *
 * Exercises the pure helpers plus the fetch middleware and the llm/stream
 * listener against a stub transport. Run: node test/smoke.mjs
 */
import assert from "node:assert/strict";
import {
	buildZenHeaders,
	createLlmStreamListener,
	createZenHeaderMiddleware,
	defaultSettings,
	hostMatches,
	opencodeProjectId,
	requestSessionContext,
	stableZenId,
	SettingsSchema
} from "../lib/index.js";

let passed = 0;
const check = (label, fn) => {
	fn();
	passed += 1;
	console.log(`  ok  ${label}`);
};

console.log("dsh-opencode-zen smoke\n");

// ── host matching ──────────────────────────────────────────────────────────
check("hostMatches: exact + subdomain, case-insensitive", () => {
	assert.equal(hostMatches("opencode.ai", ["opencode.ai"]), true);
	assert.equal(hostMatches("api.opencode.ai", ["opencode.ai"]), true);
	assert.equal(hostMatches("API.OpenCode.AI", ["opencode.ai"]), true);
});
check("hostMatches: no false positives on lookalikes", () => {
	assert.equal(hostMatches("opencode.ai.evil.com", ["opencode.ai"]), false);
	assert.equal(hostMatches("notopencode.ai", ["opencode.ai"]), false);
	assert.equal(hostMatches("", ["opencode.ai"]), false);
	assert.equal(hostMatches("opencode.ai", []), false);
});

// ── id derivation ──────────────────────────────────────────────────────────
check("stableZenId: deterministic, 16 hex chars", () => {
	const a = stableZenId("abc:opencode");
	assert.equal(a, stableZenId("abc:opencode"));
	assert.match(a, /^[0-9a-f]{16}$/);
	assert.notEqual(a, stableZenId("abd:opencode"));
});
check("opencodeProjectId: differs per provider, prefixed", () => {
	assert.notEqual(opencodeProjectId("opencode"), opencodeProjectId("opencode-go"));
	assert.match(opencodeProjectId("opencode"), /^proj_[0-9a-f]{8}$/);
});

// ── header construction ────────────────────────────────────────────────────
check("buildZenHeaders: full set for a session", () => {
	const h = buildZenHeaders(defaultSettings(), "sess-1");
	assert.equal(h["x-opencode-client"], "cli");
	assert.match(h["x-opencode-session"], /^ses_[0-9a-f]{16}$/);
	assert.match(h["x-opencode-request"], /^usr_[0-9a-f]{16}$/);
	assert.match(h["x-opencode-project"], /^proj_[0-9a-f]{8}$/);
	assert.equal(h["user-agent"], "opencode/latest/1.18.30/cli");
});
check("buildZenHeaders: session id is stable per conversation", () => {
	assert.equal(buildZenHeaders(defaultSettings(), "sess-1")["x-opencode-session"], buildZenHeaders(defaultSettings(), "sess-1")["x-opencode-session"]);
	assert.notEqual(buildZenHeaders(defaultSettings(), "sess-1")["x-opencode-session"], buildZenHeaders(defaultSettings(), "sess-2")["x-opencode-session"]);
});
check("buildZenHeaders: empty session falls back", () => {
	const fallback = buildZenHeaders(defaultSettings(), "");
	assert.equal(fallback["x-opencode-session"], buildZenHeaders(defaultSettings(), "dsh-default")["x-opencode-session"]);
});
check("buildZenHeaders: sessionMode=random varies per call", () => {
	const settings = { ...defaultSettings(), sessionMode: "random" };
	assert.notEqual(buildZenHeaders(settings, "s")["x-opencode-session"], buildZenHeaders(settings, "s")["x-opencode-session"]);
});
check("buildZenHeaders: extraHeaders override wins", () => {
	const h = buildZenHeaders({ ...defaultSettings(), extraHeaders: { "user-agent": "custom/1.0" } }, "s");
	assert.equal(h["user-agent"], "custom/1.0");
});

// ── settings schema ────────────────────────────────────────────────────────
check("SettingsSchema: defaults resolve", () => {
	const resolved = SettingsSchema(defaultSettings());
	assert.equal(resolved.enabled, true);
	assert.equal(resolved.sessionMode, "session");
	assert.deepEqual(resolved.hosts, ["opencode.ai"]);
});
check("SettingsSchema: sessionMode rejects unknown values", () => {
	assert.throws(() => SettingsSchema({ ...defaultSettings(), sessionMode: "nonsense" }));
});

// ── fetch middleware ───────────────────────────────────────────────────────
const makeMiddleware = (settings) => createZenHeaderMiddleware({ getSettings: () => settings });
const passthrough = (input, init) => ({ input, init });

console.log("\nfetch middleware\n");

await (async () => {
	const settings = defaultSettings();

	let seen;
	await makeMiddleware(settings)({
		input: "https://opencode.ai/zen/v1/chat/completions",
		init: { headers: { authorization: "Bearer k" } },
		next: (input, init) => { seen = { input, init }; return passthrough(input, init); }
	});
	const headers = new Headers(seen.init.headers);
	check("stamps identity headers on opencode.ai", () => {
		assert.equal(headers.get("x-opencode-client"), "cli");
		assert.equal(headers.get("user-agent"), "opencode/latest/1.18.30/cli");
		assert.ok(headers.get("x-opencode-session"));
	});
	check("preserves unrelated headers", () => {
		assert.equal(headers.get("authorization"), "Bearer k");
	});

	let other;
	await makeMiddleware(settings)({
		input: "https://api.deepseek.com/v1/chat/completions",
		init: { headers: { authorization: "Bearer k" } },
		next: (input, init) => { other = { input, init }; return passthrough(input, init); }
	});
	check("leaves other hosts untouched (same init object)", () => {
		assert.equal(new Headers(other.init.headers).get("user-agent"), null);
		assert.equal(other.init.headers.get, undefined, "init.headers must pass through as-is, not be rebuilt");
	});

	let disabled;
	await makeMiddleware({ ...settings, enabled: false })({
		input: "https://opencode.ai/zen/v1/chat/completions",
		init: { headers: {} },
		next: (input, init) => { disabled = init; return passthrough(input, init); }
	});
	check("enabled=false injects nothing", () => {
		assert.equal(new Headers(disabled.headers).get("x-opencode-client"), null);
	});

	let viaRequest;
	await makeMiddleware(settings)({
		input: new Request("https://opencode.ai/zen/v1/models"),
		init: undefined,
		next: (input, init) => { viaRequest = init; return passthrough(input, init); }
	});
	check("merges from Request.headers when init is absent", () => {
		assert.equal(new Headers(viaRequest.headers).get("x-opencode-client"), "cli");
	});

	let withinContext;
	await requestSessionContext.run("conversation-42", async () => {
		await makeMiddleware(settings)({
			input: "https://opencode.ai/zen/v1/chat/completions",
			init: { headers: {} },
			next: (input, init) => { withinContext = init; return passthrough(input, init); }
		});
	});
	const outside = new Headers(
		(await makeMiddleware(settings)({
			input: "https://opencode.ai/zen/v1/chat/completions",
			init: { headers: {} },
			next: (input, init) => { return passthrough(input, init); }
		})).init.headers
	).get("x-opencode-session");
	check("llm/stream context reaches the middleware", () => {
		const inCtx = new Headers(withinContext.headers).get("x-opencode-session");
		assert.equal(inCtx, `ses_${stableZenId("conversation-42:opencode")}`);
		assert.notEqual(inCtx, outside);
	});

	// ── llm/stream listener ──────────────────────────────────────────────────
	console.log("\nllm/stream listener\n");

	const listener = createLlmStreamListener(requestSessionContext);
	let observed;
	const downstream = {
		async *[Symbol.asyncIterator]() {
			observed = requestSessionContext.getStore();
			yield 1;
			yield 2;
		}
	};
	const wrapped = listener({ sessionId: "conv-7" }, () => downstream);
	const chunks = [];
	for await (const chunk of wrapped) chunks.push(chunk);
	check("propagates sessionId into the downstream iterator", () => {
		assert.equal(observed, "conv-7");
		assert.deepEqual(chunks, [1, 2]);
	});
	check("context does not leak past the stream", () => {
		assert.equal(requestSessionContext.getStore(), undefined);
	});
})();

console.log(`\n${passed} assertions passed`);
