/**
 * dsh-opencode-zen smoke test — no DSH boot, no network.
 *
 * Exercises the pure helpers plus the fetch middleware and the llm/stream
 * listener against a stub transport. Run: node test/smoke.mjs
 */
import assert from "node:assert/strict";
import {
	buildGateTool,
	buildZenHeaders,
	clientVersionMeetsFloor,
	Config,
	createLlmStreamListener,
	createZenHeaderMiddleware,
	defaultSettings,
	detectToolShape,
	ensureGateTools,
	GATE_TOOL_NAMES,
	hostMatches,
	ID_HEAD_MARKER,
	MIN_CLIENT_VERSION,
	opencodeProjectId,
	parseClientVersion,
	readConfig,
	requestSessionContext,
	requiresStream,
	rewriteRequestBody,
	shapeForUrl,
	stableZenId,
	toolNameOf
} from "../lib/index.js";

let passed = 0;
const check = (label, fn) => {
	fn();
	passed += 1;
	console.log(`  ok  ${label}`);
};
const acheck = async (label, fn) => {
	await fn();
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
check("stableZenId: deterministic, 26 chars, head marked 0xffe", () => {
	const a = stableZenId("abc:opencode");
	assert.equal(a, stableZenId("abc:opencode"));
	// 12 lowercase hex + 14 base62, with the head's low 12 bits pinned: the relay
	// decodes them as the official client's per-millisecond counter and refuses a
	// head whose counter a real client could not have produced (2026-10-16).
	assert.match(a, /^[0-9a-f]{9}ffe[0-9A-Za-z]{14}$/);
	assert.equal(a.length, 26);
	assert.equal(ID_HEAD_MARKER, "ffe");
	assert.notEqual(a, stableZenId("abd:opencode"));
	// The marker is what changed: everything before it still comes from the seed,
	// so two seeds still differ in more than the tail.
	assert.notEqual(stableZenId("abc:opencode").slice(0, 9), stableZenId("abd:opencode").slice(0, 9));
});
check("opencodeProjectId: differs per provider, prefixed", () => {
	assert.notEqual(opencodeProjectId("opencode"), opencodeProjectId("opencode-go"));
	assert.match(opencodeProjectId("opencode"), /^proj_[0-9a-f]{8}$/);
});

// ── the free tier's client-version floor ───────────────────────────────────
check("parseClientVersion: reads opencode/<version> anywhere, case-insensitively", () => {
	assert.deepEqual(parseClientVersion("opencode/1.18.30"), [1, 18, 30]);
	assert.deepEqual(parseClientVersion("opencode/latest/1.18.30/cli"), [1, 18, 30]);
	assert.deepEqual(parseClientVersion("opencode/1.18"), [1, 18, 0]);
	assert.deepEqual(parseClientVersion("Mozilla/5.0 opencode/1.18.23 x"), [1, 18, 23]);
	assert.deepEqual(parseClientVersion("OPENCODE/2.0"), [2, 0, 0]);
});
check("parseClientVersion: no version -> undefined", () => {
	assert.equal(parseClientVersion("opencode/latest"), undefined);
	assert.equal(parseClientVersion("opencode/"), undefined);
	assert.equal(parseClientVersion("opencode 1.0"), undefined);
	assert.equal(parseClientVersion("deepseek-harness/0.1.6-alpha.2 (+url)"), undefined);
	assert.equal(parseClientVersion(""), undefined);
	assert.equal(parseClientVersion(undefined), undefined);
});
check("clientVersionMeetsFloor: 1.18.0 is the measured floor", () => {
	// Measured 2026-09-19: 1.10.0 -> 426 UpgradeRequired, 1.18.0 -> 200.
	assert.equal(MIN_CLIENT_VERSION.join("."), "1.18.0");
	assert.equal(clientVersionMeetsFloor("opencode/1.0.0"), false);
	assert.equal(clientVersionMeetsFloor("opencode/1.17.99"), false);
	assert.equal(clientVersionMeetsFloor("opencode/1.18.0"), true);
	assert.equal(clientVersionMeetsFloor("opencode/1.18.23"), true);
	assert.equal(clientVersionMeetsFloor("opencode/2.0.0"), true);
	assert.equal(clientVersionMeetsFloor("opencode/latest"), false);
	assert.equal(clientVersionMeetsFloor("deepseek-harness/0.1.6-alpha.2"), false);
});
check("defaults clear the floor (a bad default would be a silent outage)", () => {
	assert.equal(clientVersionMeetsFloor(defaultSettings().userAgent), true);
});

// ── header construction ────────────────────────────────────────────────────
check("buildZenHeaders: full set for a session", () => {
	const h = buildZenHeaders(defaultSettings(), "sess-1");
	assert.equal(h["x-opencode-client"], "cli");
	assert.match(h["x-opencode-session"], /^ses_[0-9a-f]{9}ffe[0-9A-Za-z]{14}$/);
	assert.match(h["x-opencode-request"], /^usr_[0-9a-f]{9}ffe[0-9A-Za-z]{14}$/);
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
check("Config: defaults resolve through the volatile references", () => {
	const resolved = readConfig(Config["~standard"].validate({}).value);
	assert.equal(resolved.enabled, true);
	assert.equal(resolved.sessionMode, "session");
	assert.equal(resolved.forceStream, true);
	assert.deepEqual(resolved.hosts, ["opencode.ai"]);
});
check("Config: sessionMode rejects unknown values", () => {
	assert.ok(Config["~standard"].validate({ ...defaultSettings(), sessionMode: "nonsense" }).issues);
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

	// ── free-tier tool gate ──────────────────────────────────────────────────
	// The gate requires tools literally NAMED `bash` and `read`; see the long
	// comment in lib/index.js for the measured table behind each assertion.
	console.log("\nfree-tier tool gate\n");

	check("GATE_TOOL_NAMES is the measured pair", () => {
		assert.deepEqual([...GATE_TOOL_NAMES], ["bash", "read"]);
	});
	check("toolNameOf reads every wire shape", () => {
		assert.equal(toolNameOf({ type: "function", function: { name: "bash" } }), "bash");
		assert.equal(toolNameOf({ type: "function", name: "read" }), "read");
		assert.equal(toolNameOf({ name: "bash" }), "bash");
		assert.equal(toolNameOf({ description: "no name" }), undefined);
		assert.equal(toolNameOf(null), undefined);
	});
	check("detectToolShape tells the three wires apart", () => {
		assert.equal(detectToolShape([{ type: "function", function: { name: "bash" } }]), "chat");
		assert.equal(detectToolShape([{ name: "bash", input_schema: {} }]), "anthropic");
		assert.equal(detectToolShape([{ type: "function", name: "bash", parameters: {} }]), "responses");
		assert.equal(detectToolShape([]), undefined);
	});
	check("shapeForUrl is the fallback when tools is empty", () => {
		assert.equal(shapeForUrl(new URL("https://opencode.ai/zen/v1/messages")), "anthropic");
		assert.equal(shapeForUrl(new URL("https://opencode.ai/zen/v1/responses")), "responses");
		assert.equal(shapeForUrl(new URL("https://opencode.ai/zen/v1/chat/completions")), "chat");
	});
	check("buildGateTool emits the shape the endpoint expects", () => {
		const chat = buildGateTool("bash", "chat");
		assert.equal(chat.type, "function");
		assert.equal(chat.function.name, "bash");
		assert.equal(chat.function.parameters.type, "object");
		const anthropic = buildGateTool("read", "anthropic");
		assert.equal(anthropic.name, "read");
		assert.equal(anthropic.input_schema.type, "object");
		assert.equal(anthropic.function, undefined);
		const responses = buildGateTool("bash", "responses");
		assert.equal(responses.name, "bash");
		assert.equal(responses.parameters.type, "object");
		assert.equal(responses.function, undefined);
	});
	check("stub descriptions tell the model not to call them", () => {
		for (const name of GATE_TOOL_NAMES) {
			assert.match(buildGateTool(name, "chat").function.description, /not implemented/i);
		}
	});
	// The "required tool names" field is user-editable precisely so an upstream
	// rule change needs no code change, so an unknown name must produce a usable
	// stub rather than throw. A throw here escapes the fetch middleware, which
	// does not catch, and fails every request to the allowlisted host — a
	// settings typo turning into a total outage.
	check("buildGateTool synthesizes a stub for any name, in every shape", () => {
		// `description` sits at a different depth per wire shape, mirroring the
		// `parameters`/`input_schema` nesting each endpoint expects.
		const descriptionOf = (tool) => tool.function?.description ?? tool.description;
		for (const shape of ["chat", "anthropic", "responses"]) {
			const tool = buildGateTool("skill", shape);
			assert.equal(toolNameOf(tool), "skill", `${shape} names the tool`);
			assert.match(descriptionOf(tool), /not implemented/i, `${shape} labels the synthesized stub`);
			assert.match(descriptionOf(tool), /skill/, `${shape} names the required tool in the stub`);
		}
		assert.equal(buildGateTool("skill", "chat").function.parameters.type, "object");
		assert.equal(buildGateTool("skill", "anthropic").input_schema.type, "object");
		assert.equal(buildGateTool("skill", "responses").parameters.type, "object");
	});
	check("ensureGateTools honours a name with no hand-written stub", () => {
		const dsh = [{ type: "function", function: { name: "pwsh" } }];
		const { tools, injected } = ensureGateTools(dsh, "chat", ["bash", "read", "skill"]);
		assert.deepEqual(injected, ["bash", "read", "skill"]);
		assert.deepEqual(tools.map(toolNameOf), ["pwsh", "bash", "read", "skill"]);
	});
	check("ensureGateTools adds only what is missing", () => {
		const dsh = [{ type: "function", function: { name: "pwsh" } }, { type: "function", function: { name: "read" } }];
		const { tools, injected } = ensureGateTools(dsh, "chat");
		assert.deepEqual(injected, ["bash"]);
		assert.deepEqual(tools.map(toolNameOf), ["pwsh", "read", "bash"]);
		// Appended, so the pre-existing prefix (which a cache keys on) is intact.
		assert.deepEqual(tools.slice(0, 2), dsh);
	});
	check("ensureGateTools leaves a compliant list untouched", () => {
		const ok = [{ type: "function", function: { name: "bash" } }, { type: "function", function: { name: "read" } }];
		const { tools, injected } = ensureGateTools(ok, "chat");
		assert.deepEqual(injected, []);
		assert.equal(tools.length, 2);
	});
	check("ensureGateTools tolerates a missing tools array", () => {
		const { tools, injected } = ensureGateTools(undefined, "chat");
		assert.deepEqual(injected, ["bash", "read"]);
		assert.equal(tools.length, 2);
	});

	const dshBody = {
		model: "mimo-v2.5-free",
		messages: [{ role: "user", content: "hi" }],
		stream: true,
		tools: [{ type: "function", function: { name: "pwsh", description: "shell", parameters: { type: "object" } } }]
	};
	/** The same body as a one-shot call: since 2026-10-16 the relay refuses these. */
	const oneShotBody = { model: dshBody.model, messages: dshBody.messages, tools: dshBody.tools };

	check("requiresStream: chat-shaped bodies that are not streaming yet", () => {
		assert.equal(requiresStream({ messages: [], stream: false }), true);
		assert.equal(requiresStream({ messages: [] }), true);
		assert.equal(requiresStream({ input: [] }), true);
		assert.equal(requiresStream({ tools: [] }), true);
		// Already streaming, or no chat surface at all.
		assert.equal(requiresStream({ messages: [], stream: true }), false);
		assert.equal(requiresStream({ model: "m" }), false);
		assert.equal(requiresStream(null), false);
		assert.equal(requiresStream([1, 2]), false);
	});

	const rewritten = await rewriteRequestBody(JSON.stringify(dshBody), new URL("https://opencode.ai/zen/v1/chat/completions"), defaultSettings());
	await acheck("rewriteRequestBody injects into a real DSH-shaped body", async () => {
		assert.deepEqual(rewritten.injected, ["bash", "read"]);
		assert.equal(rewritten.streamForced, false);
		const parsed = JSON.parse(rewritten.text);
		assert.deepEqual(parsed.tools.map(toolNameOf), ["pwsh", "bash", "read"]);
		// Everything else about the body must survive verbatim.
		assert.equal(parsed.model, dshBody.model);
		assert.equal(parsed.stream, true);
		assert.deepEqual(parsed.messages, dshBody.messages);
	});
	await acheck("rewriteRequestBody forces stream:true on a one-shot chat body", async () => {
		const result = await rewriteRequestBody(JSON.stringify(oneShotBody), new URL("https://opencode.ai/zen/v1/chat/completions"), defaultSettings());
		assert.equal(result.streamForced, true);
		const parsed = JSON.parse(result.text);
		assert.equal(parsed.stream, true);
		assert.deepEqual(parsed.tools.map(toolNameOf), ["pwsh", "bash", "read"]);
		assert.equal(parsed.model, oneShotBody.model);
	});
	await acheck("rewriteRequestBody honours forceStream=false", async () => {
		const result = await rewriteRequestBody(JSON.stringify(oneShotBody), new URL("https://opencode.ai/zen/v1/chat/completions"), { ...defaultSettings(), forceStream: false });
		assert.equal(result.streamForced, false);
		assert.equal(JSON.parse(result.text).stream, undefined);
	});
	await acheck("rewriteRequestBody honours injectGateTools=false, independently of the stream gate", async () => {
		const result = await rewriteRequestBody(JSON.stringify(oneShotBody), new URL("https://opencode.ai/zen/v1/chat/completions"), { ...defaultSettings(), injectGateTools: false });
		assert.deepEqual(result.injected, []);
		assert.equal(JSON.parse(result.text).tools.length, 1);
		assert.equal(result.streamForced, true);
	});
	await acheck("rewriteRequestBody is byte-identical when nothing is needed", async () => {
		const ok = { ...dshBody, tools: [buildGateTool("bash", "chat"), buildGateTool("read", "chat")] };
		const text = JSON.stringify(ok);
		const result = await rewriteRequestBody(text, new URL("https://opencode.ai/zen/v1/chat/completions"), defaultSettings());
		assert.deepEqual(result.injected, []);
		assert.equal(result.streamForced, false);
		assert.equal(result.text, text);
	});
	await acheck("rewriteRequestBody skips a body with no tool surface", async () => {
		// The session-title generator sends no tools; adding any would invite tool
		// calls in a request that must return a plain title. The body still comes
		// back verbatim so a consumed stream can be replaced.
		const title = { model: "mimo-v2.5-free", messages: [{ role: "user", content: "title?" }], stream: true };
		const result = await rewriteRequestBody(JSON.stringify(title), new URL("https://opencode.ai/zen/v1/chat/completions"), defaultSettings());
		assert.deepEqual(result.injected, []);
		assert.equal(result.streamForced, false);
		assert.equal(result.text, JSON.stringify(title));
		const empty = await rewriteRequestBody(JSON.stringify({ ...title, tools: [] }), new URL("https://opencode.ai/zen/v1/chat/completions"), defaultSettings());
		assert.deepEqual(empty.injected, []);
		// ...but a title request is a chat body too, so the stream gate still applies.
		const oneShotTitle = { model: "mimo-v2.5-free", messages: [{ role: "user", content: "title?" }] };
		const forced = await rewriteRequestBody(JSON.stringify(oneShotTitle), new URL("https://opencode.ai/zen/v1/chat/completions"), defaultSettings());
		assert.equal(forced.streamForced, true);
		assert.equal(JSON.parse(forced.text).stream, true);
	});
	await acheck("rewriteRequestBody passes a non-JSON body through unchanged", async () => {
		const result = await rewriteRequestBody("not json", new URL("https://opencode.ai/zen/v1/chat/completions"), defaultSettings());
		assert.deepEqual(result.injected, []);
		assert.equal(result.streamForced, false);
		assert.equal(result.text, "not json");
		// A body it cannot read at all is left untouched and never consumed.
		assert.equal(await rewriteRequestBody(undefined, new URL("https://opencode.ai/zen/v1/chat/completions"), defaultSettings()), undefined);
	});
	await acheck("rewriteRequestBody reads a Uint8Array body", async () => {
		const bytes = new TextEncoder().encode(JSON.stringify(oneShotBody));
		const result = await rewriteRequestBody(bytes, new URL("https://opencode.ai/zen/v1/chat/completions"), defaultSettings());
		assert.deepEqual(result.injected, ["bash", "read"]);
		assert.equal(result.streamForced, true);
	});
	await acheck("rewriteRequestBody reads a stream body and returns the text", async () => {
		// Reading consumes the stream, so the caller MUST get text back to send.
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(JSON.stringify(oneShotBody)));
				controller.close();
			}
		});
		const result = await rewriteRequestBody(stream, new URL("https://opencode.ai/zen/v1/chat/completions"), defaultSettings());
		assert.deepEqual(result.injected, ["bash", "read"]);
		assert.deepEqual(JSON.parse(result.text).tools.map(toolNameOf), ["pwsh", "bash", "read"]);
		assert.equal(JSON.parse(result.text).stream, true);
	});
	await acheck("rewriteRequestBody honours a custom required-name list", async () => {
		const result = await rewriteRequestBody(JSON.stringify(dshBody), new URL("https://opencode.ai/zen/v1/chat/completions"), {
			...defaultSettings(),
			gateToolNames: ["read"]
		});
		assert.deepEqual(result.injected, ["read"]);
	});

	// ── middleware end-to-end: headers AND body in one pass ───────────────────
	let gateSeen;
	await makeMiddleware(settings)({
		input: "https://opencode.ai/zen/v1/chat/completions",
		init: { headers: {}, body: JSON.stringify(dshBody) },
		next: (input, init) => { gateSeen = init; return passthrough(input, init); }
	});
	await acheck("middleware injects the gate tools and clears a stale content-length", async () => {
		const parsed = JSON.parse(gateSeen.body);
		assert.deepEqual(parsed.tools.map(toolNameOf), ["pwsh", "bash", "read"]);
		assert.equal(new Headers(gateSeen.headers).get("content-length"), null);
		assert.equal(new Headers(gateSeen.headers).get("x-opencode-client"), "cli");
	});

	let oneShotSeen;
	await makeMiddleware(settings)({
		input: "https://opencode.ai/zen/v1/chat/completions",
		init: { headers: {}, body: JSON.stringify(oneShotBody) },
		next: (input, init) => { oneShotSeen = init; return passthrough(input, init); }
	});
	await acheck("middleware forces stream:true on a one-shot body", async () => {
		const parsed = JSON.parse(oneShotSeen.body);
		assert.equal(parsed.stream, true);
		assert.deepEqual(parsed.tools.map(toolNameOf), ["pwsh", "bash", "read"]);
		assert.equal(new Headers(oneShotSeen.headers).get("content-length"), null);
	});

	let offSeen;
	await makeMiddleware({ ...settings, injectGateTools: false })({
		input: "https://opencode.ai/zen/v1/chat/completions",
		init: { headers: {}, body: JSON.stringify(dshBody) },
		next: (input, init) => { offSeen = init; return passthrough(input, init); }
	});
	await acheck("injectGateTools=false leaves a streaming body byte-identical", async () => {
		assert.equal(offSeen.body, JSON.stringify(dshBody));
	});

	let offOneShotSeen;
	await makeMiddleware({ ...settings, injectGateTools: false })({
		input: "https://opencode.ai/zen/v1/chat/completions",
		init: { headers: {}, body: JSON.stringify(oneShotBody) },
		next: (input, init) => { offOneShotSeen = init; return passthrough(input, init); }
	});
	await acheck("injectGateTools=false still enforces the stream gate", async () => {
		const parsed = JSON.parse(offOneShotSeen.body);
		assert.equal(parsed.stream, true);
		assert.equal(parsed.tools.length, 1, "the tool list is untouched when injection is off");
	});

	let unforcedSeen;
	await makeMiddleware({ ...settings, forceStream: false })({
		input: "https://opencode.ai/zen/v1/chat/completions",
		init: { headers: {}, body: JSON.stringify(oneShotBody) },
		next: (input, init) => { unforcedSeen = init; return passthrough(input, init); }
	});
	await acheck("forceStream=false leaves the stream flag alone", async () => {
		assert.equal(JSON.parse(unforcedSeen.body).stream, undefined);
	});

	// End-to-end: a custom required-name list must reach the wire, not throw.
	let customSeen;
	await makeMiddleware({ ...settings, gateToolNames: ["bash", "read", "skill"] })({
		input: "https://opencode.ai/zen/v1/chat/completions",
		init: { headers: {}, body: JSON.stringify(dshBody) },
		next: (input, init) => { customSeen = init; return passthrough(input, init); }
	});
	await acheck("the middleware survives a required name with no hand-written stub", async () => {
		assert.deepEqual(JSON.parse(customSeen.body).tools.map(toolNameOf), ["pwsh", "bash", "read", "skill"]);
	});

	let otherSeen;
	const otherBody = JSON.stringify(dshBody);
	await makeMiddleware(settings)({
		input: "https://example.com/v1/chat/completions",
		init: { headers: {}, body: otherBody },
		next: (input, init) => { otherSeen = init; return passthrough(input, init); }
	});
	await acheck("a non-allowlisted host keeps its body and gains no headers", async () => {
		assert.equal(otherSeen.body, otherBody);
		assert.equal(new Headers(otherSeen.headers).get("x-opencode-client"), null);
	});
})();

console.log(`\n${passed} assertions passed`);
