/**
 * dsh-opencode-zen proxy test — no DSH boot, no external network.
 *
 * Runs the real `sendViaProxy` transport and the real fetch middleware against
 * a local origin plus a local CONNECT proxy, so the tunnel, header handling,
 * body handling, decompression and the direct-fallback path are all covered
 * without touching opencode.ai. The `https:` arm is the same code path with one
 * extra TLS hop on the tunneled socket; that hop needs a certificate, so it is
 * exercised live instead (see the README's proxy section).
 *
 * Run: node test/proxy.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";
import {
	Config,
	createZenHeaderMiddleware,
	defaultSettings,
	parseProxyUrl,
	sendViaProxy
} from "../lib/index.js";

let passed = 0;
const check = async (label, fn) => {
	await fn();
	passed += 1;
	console.log(`  ok  ${label}`);
};

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

console.log("dsh-opencode-zen proxy\n");

// ── proxy URL parsing ──────────────────────────────────────────────────────
console.log("proxy URL\n");

await check("empty setting means no proxy", () => {
	assert.equal(parseProxyUrl(""), undefined);
	assert.equal(parseProxyUrl("   "), undefined);
	assert.equal(parseProxyUrl(undefined), undefined);
});

await check("host:port and http://host:port both parse", () => {
	const bare = parseProxyUrl("192.168.1.199:7890");
	assert.equal(bare.protocol, "http:");
	assert.equal(bare.hostname, "192.168.1.199");
	assert.equal(bare.port, "7890");
	const full = parseProxyUrl("http://user:p%40ss@proxy.local:3128");
	assert.equal(full.hostname, "proxy.local");
	assert.equal(full.port, "3128");
	assert.equal(full.username, "user");
	assert.equal(full.password, "p%40ss", "credentials stay percent-encoded here and are decoded per request");
});

await check("only http:// is accepted; socks/https/garbage are refused", () => {
	assert.equal(parseProxyUrl("socks5://192.168.1.199:7891"), undefined);
	assert.equal(parseProxyUrl("https://192.168.1.199:7890"), undefined);
	assert.equal(parseProxyUrl("http://"), undefined);
	assert.equal(parseProxyUrl(":::"), undefined);
});

await check("Config exposes proxyUrl, defaulted to off", () => {
	assert.equal(defaultSettings().proxyUrl, "");
	assert.equal(Config["~standard"].validate({ ...defaultSettings(), proxyUrl: "192.168.1.199:7890" }).issues, undefined);
});

// ── local origin + local CONNECT proxy ─────────────────────────────────────
const connects = [];

const origin = http.createServer((request, response) => {
	const chunks = [];
	request.on("data", (chunk) => chunks.push(chunk));
	request.on("end", () => {
		const body = Buffer.concat(chunks).toString("utf8");
		if (request.url === "/gz") {
			const payload = zlib.gzipSync(JSON.stringify({ ok: true, path: request.url }));
			response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(payload.length) });
			response.end(payload);
			return;
		}
		if (request.url === "/stream") {
			// SSE-shaped: two chunks with a gap, so a caller that only got the
			// response after the stream closed would be visibly wrong.
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write("data: 1\n\n");
			setTimeout(() => {
				response.write("data: 2\n\n");
				response.end();
			}, 60);
			return;
		}
		if (request.url === "/redirect-same") {
			response.writeHead(303, { location: "/after" });
			response.end();
			return;
		}
		if (request.url === "/redirect-other") {
			response.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
			response.end();
			return;
		}
		response.writeHead(201, { "content-type": "application/json", "x-origin": "local" });
		response.end(JSON.stringify({ method: request.method, path: request.url, headers: request.headers, body }));
	});
});

let refuseConnect = false;
const proxy = http.createServer((request, response) => {
	response.writeHead(405, { "content-type": "text/plain" });
	response.end("this proxy only tunnels");
});
proxy.on("connect", (request, clientSocket, head) => {
	connects.push(request.url);
	if (refuseConnect) {
		clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
		return;
	}
	const separator = request.url.lastIndexOf(":");
	const host = request.url.slice(0, separator);
	const port = Number(request.url.slice(separator + 1));
	const upstream = net.connect(port, host, () => {
		clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (head !== null && head.length > 0) upstream.write(head);
		upstream.pipe(clientSocket);
		clientSocket.pipe(upstream);
	});
	upstream.on("error", () => clientSocket.destroy());
	clientSocket.on("error", () => upstream.destroy());
});

const originPort = await listen(origin);
const proxyPort = await listen(proxy);
const originUrl = `http://127.0.0.1:${originPort}`;
const proxyUrl = `http://127.0.0.1:${proxyPort}`;

try {
	console.log("\ntunnel\n");

	await check("POST through the proxy arrives with body and headers intact", async () => {
		connects.length = 0;
		const response = await sendViaProxy(new URL(`${originUrl}/zen/v1/chat/completions?x=1`), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer k",
				"x-opencode-session": "ses_test",
				connection: "keep-alive"
			},
			body: JSON.stringify({ model: "m", messages: [] })
		}, proxyUrl);
		assert.equal(response.status, 201);
		assert.deepEqual(connects, [`127.0.0.1:${originPort}`], "the tunnel is opened with CONNECT host:port");
		const echoed = await response.json();
		assert.equal(echoed.method, "POST");
		assert.equal(echoed.path, "/zen/v1/chat/completions?x=1");
		assert.equal(echoed.body, JSON.stringify({ model: "m", messages: [] }));
		assert.equal(echoed.headers.authorization, "Bearer k");
		assert.equal(echoed.headers["x-opencode-session"], "ses_test");
		assert.equal(echoed.headers.connection, "close", "the caller's connection header is not forwarded; node supplies its own (keepAlive is off)");
		assert.equal(echoed.headers["content-length"], String(Buffer.byteLength(echoed.body)), "length is recomputed for the body actually sent");
		assert.equal(response.headers.get("x-origin"), "local");
	});

	await check("GET without a body sends no content-length", async () => {
		const response = await sendViaProxy(new URL(`${originUrl}/models`), { method: "GET" }, proxyUrl);
		const echoed = await response.json();
		assert.equal(echoed.method, "GET");
		assert.equal(echoed.headers["content-length"], undefined);
		assert.equal(echoed.body, "");
	});

	await check("a gzipped response is decoded and the header dropped", async () => {
		const response = await sendViaProxy(new URL(`${originUrl}/gz`), { method: "GET" }, proxyUrl);
		assert.equal(response.headers.get("content-encoding"), null);
		assert.deepEqual(await response.json(), { ok: true, path: "/gz" });
	});

	await check("a streaming response streams through (SSE is the normal 200 body)", async () => {
		const response = await sendViaProxy(new URL(`${originUrl}/stream`), { method: "POST", body: "{}" }, proxyUrl);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "text/event-stream");
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		const first = decoder.decode((await reader.read()).value ?? new Uint8Array());
		assert.match(first, /data: 1/, "the first event arrives while the origin is still writing");
		let rest = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			rest += decoder.decode(value);
		}
		assert.match(rest, /data: 2/);
	});

	await check("a same-host redirect is followed, and 303 turns the POST into a bodyless GET", async () => {
		const response = await sendViaProxy(new URL(`${originUrl}/redirect-same`), { method: "POST", body: "payload" }, proxyUrl);
		assert.equal(response.status, 201, "the final hop's response is what the caller sees");
		const echoed = await response.json();
		assert.equal(echoed.path, "/after");
		assert.equal(echoed.method, "GET");
		assert.equal(echoed.body, "");
		assert.equal(echoed.headers["content-length"], undefined);
	});

	await check("a cross-host redirect is NOT followed (the identity headers stay home)", async () => {
		const response = await sendViaProxy(new URL(`${originUrl}/redirect-other`), { method: "GET" }, proxyUrl);
		assert.equal(response.status, 302);
		assert.equal(response.headers.get("location"), "http://127.0.0.1:1/elsewhere");
	});

	await check("a refused CONNECT rejects", async () => {
		refuseConnect = true;
		await assert.rejects(
			sendViaProxy(new URL(`${originUrl}/x`), { method: "GET" }, proxyUrl),
			/refused CONNECT .* with HTTP 502/
		);
		refuseConnect = false;
	});

	await check("an abort signal cancels the request", async () => {
		const controller = new AbortController();
		const pending = sendViaProxy(new URL(`${originUrl}/x`), { method: "GET", signal: controller.signal }, proxyUrl);
		controller.abort();
		await assert.rejects(pending, /abort/i);
	});

	await check("a non-http proxy setting rejects instead of sending", async () => {
		await assert.rejects(sendViaProxy(new URL(`${originUrl}/x`), { method: "GET" }, "socks5://127.0.0.1:7891"), /not an HTTP proxy URL/);
	});

	console.log("\nmiddleware\n");

	await check("a matching request goes through the proxy and never calls next()", async () => {
		connects.length = 0;
		let nextCalls = 0;
		const middleware = createZenHeaderMiddleware({ getSettings: () => ({ ...defaultSettings(), hosts: ["127.0.0.1"], proxyUrl }) });
		const response = await middleware({
			input: `${originUrl}/zen/v1/chat/completions`,
			init: {
				method: "POST",
				headers: { authorization: "Bearer k" },
				body: JSON.stringify({ messages: [], tools: [{ type: "function", function: { name: "pwsh", parameters: { type: "object", properties: {} } } }] })
			},
			next: () => { nextCalls += 1; throw new Error("next() must not run when the proxy is up"); }
		});
		assert.equal(nextCalls, 0);
		assert.equal(connects.length, 1);
		const echoed = await response.json();
		assert.equal(echoed.headers["x-opencode-client"], "cli", "identity headers ride the proxied request");
		const sent = JSON.parse(echoed.body);
		assert.equal(sent.stream, true, "forceStream still applies before the request leaves");
		const names = sent.tools.map((tool) => tool.function?.name);
		assert.ok(names.includes("bash") && names.includes("read"), "gate tools still apply");
	});

	await check("an unreachable proxy falls back to next() with the body intact", async () => {
		let seen;
		const middleware = createZenHeaderMiddleware({
			getSettings: () => ({ ...defaultSettings(), hosts: ["127.0.0.1"], proxyUrl: "http://127.0.0.1:1" }),
			logger: { warn: () => {} }
		});
		const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
		const result = await middleware({
			input: `${originUrl}/zen/v1/chat/completions`,
			init: { method: "POST", headers: {}, body },
			next: (input, init) => { seen = init; return { input, init }; }
		});
		assert.ok(result.input, "next() produced the response");
		const forwarded = JSON.parse(seen.body);
		assert.deepEqual(forwarded.messages, [{ role: "user", content: "hi" }], "the body is not drained by the failed attempt");
		assert.equal(forwarded.stream, true, "the rewrites that ran before the proxy attempt are still in the body");
		assert.ok(new Headers(seen.headers).get("x-opencode-session"));
	});

	await check("a non-matching host never touches the proxy", async () => {
		connects.length = 0;
		let seen;
		const middleware = createZenHeaderMiddleware({ getSettings: () => ({ ...defaultSettings(), proxyUrl }) });
		await middleware({
			input: "https://api.deepseek.com/v1/chat/completions",
			init: { method: "POST", headers: {}, body: "{}" },
			next: (input, init) => { seen = { input, init }; return { input, init }; }
		});
		assert.equal(connects.length, 0);
		assert.equal(seen.init.headers.get, undefined, "init passes through untouched");
	});
} finally {
	origin.close();
	proxy.close();
}

console.log(`\n${passed} checks passed`);
