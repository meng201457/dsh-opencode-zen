/**
 * dsh-opencode-zen — OpenCode Zen CLI-header patch auto-repair.
 *
 * Why this exists:
 *   The OpenCode Zen backend (https://opencode.ai/zen) rate-limits anonymous
 *   clients. The official opencode-CLI header set (x-opencode-client: cli,
 *   opencode/... User-Agent, random session/request/project ids) is injected
 *   into every Zen request by a patch in dsh-llm-pi-ai's lib/index.js
 *   (opencodeClientHeaders). Any reinstall of the @deepseek-ai/dsh dependency
 *   tree wipes that patch (the file is a junction from the profile into the
 *   installed tree, so both views share one physical file).
 *
 * This plugin makes the patch self-healing: on every boot it checks whether
 * the module still contains the injection and re-applies it when missing.
 * Installing this plugin (one insert entry in cordis.patch.yml) means the
 * patch is restored automatically after any update — no manual fixups.
 *
 * Pure ESM, zero runtime dependencies (node:fs / node:module only).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const name = "dsh-opencode-zen";

/** The exact code block inserted ahead of `requestHeaders` (matches the manual patch). */
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
const OLD_CALL = "\t\t\t\t\theaders: requestHeaders(profile.headers)";
const NEW_CALL =
	"\t\t\t\t\theaders: { ...requestHeaders(profile.headers), ...opencodeClientHeaders(model) }";

/**
 * Resolve the physical dsh-llm-pi-ai entry, trying the canonical profile
 * junction path, the installed-tree path, and module resolution.
 */
function candidateTargets() {
	const viaRequire = (() => {
		try {
			return createRequire(import.meta.url).resolve("@deepseek-ai/dsh-llm-pi-ai");
		} catch {
			return void 0;
		}
	})();
	return [
		viaRequire,
		"C:\\Users\\YURi\\.dsh\\profiles\\node_modules\\@deepseek-ai\\dsh-llm-pi-ai\\lib\\index.js",
		"E:\\Dev Tools\\Node.js\\apps\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\dsh-llm-pi-ai\\lib\\index.js"
	].filter((path) => typeof path === "string" && existsSync(path));
}

/**
 * Apply the patch to one target file. Idempotent.
 * @returns "patched" | "already" | "layout-mismatch"
 */
export function patchFile(target) {
	const src = readFileSync(target, "utf8");
	if (src.includes("opencodeClientHeaders")) return "already";
	if (!src.includes(ANCHOR)) return "layout-mismatch";
	if (!src.includes(OLD_CALL)) return "layout-mismatch";
	writeFileSync(target, src.replace(ANCHOR, FUNC_BLOCK + ANCHOR).replace(OLD_CALL, NEW_CALL));
	return "patched";
}

/** Cordis plugin entry: repair the patch on every boot. */
function apply(ctx) {
	const targets = candidateTargets();
	if (targets.length === 0) {
		ctx.logger.warn("dsh-opencode-zen: dsh-llm-pi-ai entry not found; nothing to patch (update the hard-coded candidates if paths changed)");
		return;
	}
	for (const target of targets) {
		try {
			const status = patchFile(target);
			if (status === "patched") ctx.logger.info(`dsh-opencode-zen: re-applied opencodeClientHeaders patch -> ${target}`);
			else if (status === "already") ctx.logger.info(`dsh-opencode-zen: patch already present -> ${target}`);
			else ctx.logger.warn(`dsh-opencode-zen: ${target} layout changed; opencodeClientHeaders patch not applied — the module no longer matches the expected structure`);
		} catch (error) {
			ctx.logger.warn(`dsh-opencode-zen: failed to patch ${target}: ${error?.message ?? error}`);
		}
	}
}

export { name, apply };
