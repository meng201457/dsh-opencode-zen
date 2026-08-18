#!/usr/bin/env node
/**
 * Re-apply the OpenCode Zen local patch to dsh-llm-pi-ai.
 *
 * The OpenCode Zen backend (opencode.ai/zen) rate-limits anonymous clients.
 * The official opencode-CLI header set (x-opencode-client: cli, opencode/...
 * User-Agent, random session/request/project ids) is injected by this patch so
 * requests look like they come from the official opencode CLI. Any reinstall
 * of the @deepseek-ai/dsh dependency tree wipes it; run this script to restore:
 *
 *   node "D:\工作项目\DSH\scripts\dsh-opencode-zen-patch.mjs"
 *
 * Idempotent: exits early if the patch is already applied.
 *
 * Usage: node dsh-opencode-zen-patch.mjs [target-file]
 *   default target: E:\Dev Tools\Node.js\apps\node_modules\@deepseek-ai\dsh\
 *     node_modules\@deepseek-ai\dsh-llm-pi-ai\lib\index.js
 *   (C:\Users\YURi\.dsh\profiles\node_modules\@deepseek-ai\dsh-llm-pi-ai is a
 *   junction to that file, so patching one patches both.)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const TARGET =
	process.argv[2] ??
	"E:\\Dev Tools\\Node.js\\apps\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\dsh-llm-pi-ai\\lib\\index.js";

const FUNC_BLOCK = `/**
 * Official opencode-CLI header set required by the OpenCode Zen backend to
 * accept requests from this client. The Zen backend rate-limits anonymous
 * clients, so requests are labeled with the official opencode CLI header set
 * (x-opencode-client: cli, opencode/... User-Agent, random session/request/
 * project ids). Injected AFTER attribution, which would otherwise overwrite
 * the \`opencode/...\` User-Agent. LOCAL PATCH: re-apply after reinstalling
 * packages (see the note in ~/.dsh/settings.yaml).
 */
function randomId() {
	const cryptoApi = globalThis.crypto;
	if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
		const r = Math.random() * 16 | 0;
		const v = ch === "x" ? r : (r & 0x3 | 0x8);
		return v.toString(16);
	});
}
function opencodeClientHeaders(model) {
	const baseUrl = model?.baseUrl ?? "";
	if (model?.provider !== "opencode" && model?.provider !== "opencode-go" && !baseUrl.includes("opencode.ai")) return {};
	return {
		"x-opencode-client": "cli",
		"x-opencode-session": randomId(),
		"x-opencode-request": randomId(),
		"x-opencode-project": randomId(),
		"user-agent": "opencode/latest/1.3.15/cli"
	};
}
`;

const ANCHOR =
	"/** Merge deployment headers while removing case-insensitive attribution collisions. */\nfunction requestHeaders(headers) {";
const OLD_CALL =
	"\t\t\t\t\theaders: requestHeaders(profile.headers)";
const NEW_CALL =
	"\t\t\t\t\theaders: { ...requestHeaders(profile.headers), ...opencodeClientHeaders(model) }";

if (!existsSync(TARGET)) {
	console.error(`[opencode-zen-patch] target not found: ${TARGET}`);
	process.exit(1);
}

let src = readFileSync(TARGET, "utf8");

if (src.includes("opencodeClientHeaders")) {
	console.log("[opencode-zen-patch] already applied — nothing to do.");
	process.exit(0);
}
if (!src.includes(ANCHOR)) {
	console.error("[opencode-zen-patch] anchor (requestHeaders) not found — file layout changed?");
	process.exit(1);
}
if (!src.includes(OLD_CALL)) {
	console.error("[opencode-zen-patch] call site not found — file layout changed?");
	process.exit(1);
}

src = src.replace(ANCHOR, FUNC_BLOCK + ANCHOR);
src = src.replace(OLD_CALL, NEW_CALL);
writeFileSync(TARGET, src);

console.log(`[opencode-zen-patch] applied -> ${TARGET}`);
console.log("[opencode-zen-patch] restart DSH for it to take effect.");
