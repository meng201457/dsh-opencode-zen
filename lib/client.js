/**
 * dsh-opencode-zen — browser half (hand-written client bundle, lazy-CJS factory).
 *
 * Format contract (@deepseek-ai/dsh-client-modules):
 *  - registers ONE factory with `window.__ModuleLoader__.load({id, factory})`;
 *  - `factory(require)` materializes on import and returns `module.exports`;
 *  - the bundle is adopted as a browser-side cordis plugin entry by the web
 *    kernel, so it must export `apply(ctx)` and `inject`;
 *  - `dsh.client.inject` in package.json declares the module-graph suppliers.
 *
 * Registers this package's configuration into the Plugins page's
 * `plugins.bundle.config` slot (keyed by the package name), so the form opens
 * from Plugins → dsh-opencode-zen beside that package's own switch. It edits
 * the Host plugin entry `opencode-zen` through `ctx.configForms.get(entryId)`
 * and shows up only while the Host serves that entry's configuration.
 *
 * DSH 0.1.7 replaced `ctx.settingsScope` with `ctx.configForms`: the Host no
 * longer registers a namespace through the settings service, it exports a
 * `Config` schema whose `.volatile()` fields `@deepseek-ai/dsh-settings`
 * projects into a form keyed by the plugin entry id. `whileServed` is the
 * official gate for "register this page only while that entry is described".
 */
window.__ModuleLoader__.load({
	id: "dsh-opencode-zen",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var react = require("react");
		var h = react.createElement;

		/**
		 * Host plugin entry id this form edits. `@deepseek-ai/dsh-settings` keys a
		 * configuration form by `entry.options.id`, which is the id the profile
		 * layer gives the row in cordis.patch.yml (`- id: opencode-zen`), NOT the
		 * package name and not a free-form namespace string.
		 */
		var ENTRY_ID = "opencode-zen";
		/** This package's name — the key the Plugins page files a bundle's configuration under. */
		var BUNDLE_NAME = "dsh-opencode-zen";
		/** Locale namespace for the form copy. */
		var LOCALE_NS = "dsh-opencode-zen";

		/** Services this browser plugin needs from the browser cordis tree. */
		var inject = ["slots", "locale", "configForms"];

		var DEFAULT_USER_AGENT = "opencode/latest/1.18.30/cli";

		/**
		 * Lowest OpenCode client version the Zen free tier still serves, as
		 * [major, minor, patch]. Measured 2026-09-19: `opencode/1.10.0` gets
		 * `426 UpgradeRequired` ("OpenCode 1.18.0 or newer is required to use
		 * the free tier") while `opencode/1.18.0` passes. Keep in sync with
		 * MIN_CLIENT_VERSION in lib/index.js.
		 */
		var MIN_CLIENT_VERSION = [1, 18, 0];

		/** The client version a user-agent names, or undefined when it names none. */
		function parseClientVersion(value) {
			var match = /opencode\/[^\s]*?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i.exec(String(value ?? ""));
			if (match === null) return undefined;
			return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
		}

		/** Whether a user-agent clears the free tier's version floor. */
		function clientVersionMeetsFloor(value) {
			var parsed = parseClientVersion(value);
			if (parsed === undefined) return false;
			for (var i = 0; i < MIN_CLIENT_VERSION.length; i += 1) {
				if (parsed[i] > MIN_CLIENT_VERSION[i]) return true;
				if (parsed[i] < MIN_CLIENT_VERSION[i]) return false;
			}
			return true;
		}

		// ── tiny snapshot store (getSnapshot/subscribe is the observableHook contract) ──
		function createStore(init) {
			var state = init;
			var listeners = new Set();
			return {
				getSnapshot: function () { return state; },
				set: function (next) {
					state = next;
					for (var fn of [...listeners]) fn();
				},
				subscribe: function (fn) {
					listeners.add(fn);
					return function () { listeners.delete(fn); };
				}
			};
		}

		function defaultDraft() {
			return {
				enabled: true,
				userAgent: DEFAULT_USER_AGENT,
				project: "",
				sessionMode: "session",
				hosts: ["opencode.ai"],
				fallbackSession: "dsh-default",
				provider: "opencode",
				extraHeaders: {},
				injectGateTools: true,
				gateToolNames: ["bash", "read"],
				debug: false
			};
		}

		// ── validation ──
		function validUserAgent(value) {
			var text = String(value ?? "").trim();
			if (text === "") return false;
			if (/[\r\n]/.test(text)) return false;
			// The gateway matches on the client name; a bare library name is not it.
			if (!/^[a-z0-9._-]+\/\S+/i.test(text)) return false;
			// And it parses the version out of this header: anything naming no
			// `opencode/<version>` at or above the floor gets 403/426. Refusing it
			// here turns a silent outage into a visible field error.
			return clientVersionMeetsFloor(text);
		}
		function validHosts(lines) {
			var parts = String(lines ?? "").split(/\r?\n/);
			for (var part of parts) {
				var t = part.trim();
				if (t === "") continue;
				if (/\s/.test(t)) return false;
				if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(t)) return false;
			}
			return true;
		}
		function parseHosts(text) {
			return String(text ?? "")
				.split(/\r?\n/)
				.map(function (s) { return s.trim().toLowerCase(); })
				.filter(function (s) { return s !== ""; });
		}
		// Tool names the Zen free tier insists on. They are matched literally, so
		// anything that is not a plausible tool name is a field error rather than
		// a silent 403 at request time.
		function validGateToolNames(lines) {
			var parts = String(lines ?? "").split(/\r?\n/);
			for (var part of parts) {
				var t = part.trim();
				if (t === "") continue;
				if (/\s/.test(t)) return false;
				if (!/^[a-z0-9_.-]+$/i.test(t)) return false;
			}
			return true;
		}
		function parseGateToolNames(text) {
			return String(text ?? "")
				.split(/\r?\n/)
				.map(function (s) { return s.trim(); })
				.filter(function (s) { return s !== ""; });
		}
		function parseExtraHeaders(text) {
			var out = {};
			var lines = String(text ?? "").split(/\r?\n/);
			for (var line of lines) {
				var t = line.trim();
				if (t === "") continue;
				var idx = t.indexOf(":");
				if (idx <= 0) continue;
				var name = t.slice(0, idx).trim().toLowerCase();
				var value = t.slice(idx + 1).trim();
				if (name !== "") out[name] = value;
			}
			return out;
		}
		function formatExtraHeaders(obj) {
			if (obj === null || typeof obj !== "object") return "";
			return Object.keys(obj).map(function (k) { return k + ": " + obj[k]; }).join("\n");
		}

		// ── controller: drafts + write-through scope ──
		var ZenController = /** @class */ function () {
			function ZenController(scope) {
				this.scope = scope;
				this.saving = false;
				this.failed = false;
				this.draft = defaultDraft();
				this.hostsText = "opencode.ai";
				this.headersText = "";
				this.gateToolsText = "bash\nread";
				this.store = createStore({
					available: false, writable: false, dirty: false, invalid: false,
					saving: false, failed: false, draft: this.draft,
					hostsText: "", headersText: "", gateToolsText: ""
				});
				var self = this;
				scope.subscribe(function () { self.onScope(); });
				this.onScope();
			}
			ZenController.prototype.onScope = function () {
				var snap = this.scope.getSnapshot();
				// Never re-seed over a failed save: the Host's recovery read may land
				// after the rejection, and seeding there would silently revert the edit
				// the user is still looking at. `discard` clears the flag explicitly.
				if (snap.status === "ready" && !this.saving && !this.failed) this.seed(snap.value);
				this.publish();
			};
			ZenController.prototype.publish = function () {
				var snap = this.scope.getSnapshot();
				if (snap.status !== "ready") {
					this.store.set({
						available: false, writable: false, dirty: false, invalid: false,
						saving: this.saving, failed: this.failed, draft: this.draft,
						hostsText: this.hostsText, headersText: this.headersText,
						gateToolsText: this.gateToolsText
					});
					return;
				}
				var value = snap.value !== void 0 && snap.value !== null ? snap.value : defaultDraft();
				this.store.set({
					available: true,
					writable: snap.writable !== false,
					dirty: JSON.stringify(this.draft) !== JSON.stringify(value),
					invalid: this.invalid(),
					saving: this.saving,
					failed: this.failed,
					draft: this.draft,
					hostsText: this.hostsText,
					headersText: this.headersText,
					gateToolsText: this.gateToolsText
				});
			};
			ZenController.prototype.seed = function (value) {
				this.draft = {
					enabled: value.enabled === true,
					userAgent: typeof value.userAgent === "string" ? value.userAgent : DEFAULT_USER_AGENT,
					project: typeof value.project === "string" ? value.project : "",
					sessionMode: value.sessionMode === "random" ? "random" : "session",
					hosts: Array.isArray(value.hosts) ? value.hosts.slice() : ["opencode.ai"],
					fallbackSession: typeof value.fallbackSession === "string" ? value.fallbackSession : "dsh-default",
					provider: typeof value.provider === "string" ? value.provider : "opencode",
					extraHeaders: value.extraHeaders !== null && typeof value.extraHeaders === "object" ? Object.assign({}, value.extraHeaders) : {},
					injectGateTools: value.injectGateTools !== false,
					gateToolNames: Array.isArray(value.gateToolNames) ? value.gateToolNames.slice() : ["bash", "read"],
					debug: value.debug === true
				};
				this.hostsText = this.draft.hosts.join("\n");
				this.headersText = formatExtraHeaders(this.draft.extraHeaders);
				this.gateToolsText = this.draft.gateToolNames.join("\n");
			};
			ZenController.prototype.invalid = function () {
				if (this.draft.enabled !== true) return false;
				if (!validUserAgent(this.draft.userAgent)) return true;
				if (!validHosts(this.hostsText)) return true;
				if (!validGateToolNames(this.gateToolsText)) return true;
				return this.draft.hosts.length === 0;
			};
			ZenController.prototype.patch = function (partial) {
				this.draft = Object.assign({}, this.draft, partial);
				this.publish();
			};
			ZenController.prototype.editHosts = function (text) {
				this.hostsText = text;
				this.draft = Object.assign({}, this.draft, { hosts: parseHosts(text) });
				this.publish();
			};
			ZenController.prototype.editGateToolNames = function (text) {
				this.gateToolsText = text;
				this.draft = Object.assign({}, this.draft, { gateToolNames: parseGateToolNames(text) });
				this.publish();
			};
			ZenController.prototype.editHeaders = function (text) {
				this.headersText = text;
				this.draft = Object.assign({}, this.draft, { extraHeaders: parseExtraHeaders(text) });
				this.publish();
			};
			ZenController.prototype.discard = function () {
				var snap = this.scope.getSnapshot();
				if (snap.status === "ready") this.seed(snap.value);
				this.failed = false;
				this.publish();
			};
			ZenController.prototype.save = async function () {
				if (this.saving || this.invalid()) return;
				this.saving = true;
				this.failed = false;
				this.publish();
				var draft = this.draft;
				// One atomic mutation rather than eleven independent writes: the Host
				// applies the whole batch under a single revision fence, so a form
				// save can never be observed half-applied and cannot lose a race with
				// a concurrent edit on another page.
				var ops = [
					{ op: "set", path: ["enabled"], value: draft.enabled === true },
					{ op: "set", path: ["userAgent"], value: String(draft.userAgent ?? "").trim() },
					{ op: "set", path: ["project"], value: String(draft.project ?? "").trim() },
					{ op: "set", path: ["sessionMode"], value: draft.sessionMode === "random" ? "random" : "session" },
					{ op: "set", path: ["hosts"], value: draft.hosts.slice() },
					{ op: "set", path: ["fallbackSession"], value: String(draft.fallbackSession ?? "").trim() },
					{ op: "set", path: ["provider"], value: String(draft.provider ?? "").trim() },
					{ op: "set", path: ["extraHeaders"], value: Object.assign({}, draft.extraHeaders) },
					{ op: "set", path: ["injectGateTools"], value: draft.injectGateTools !== false },
					{ op: "set", path: ["gateToolNames"], value: draft.gateToolNames.slice() },
					{ op: "set", path: ["debug"], value: draft.debug === true }
				];
				var accepted = false;
				try {
					accepted = await this.scope.mutate(ops);
				} catch {
					this.saving = false;
					this.failed = true;
					this.publish();
					return;
				}
				this.saving = false;
				// `mutate` resolves false when the Host rejected the write. The draft is
				// deliberately NOT re-seeded from the snapshot in that case: the mirror
				// may have been reloaded behind us, and silently reverting would discard
				// the edit the user is looking at. The form stays dirty and reports the
				// failure so they can retry or discard.
				this.failed = accepted === false;
				if (accepted !== false) {
					var snap = this.scope.getSnapshot();
					if (snap.status === "ready") this.seed(snap.value);
				}
				this.publish();
			};
			ZenController.prototype.actions = function () {
				var self = this;
				return {
					editEnabled: function (v) { self.patch({ enabled: v }); },
					editUserAgent: function (t) { self.patch({ userAgent: t }); },
					editProject: function (t) { self.patch({ project: t }); },
					editSessionMode: function (v) { self.patch({ sessionMode: v === "random" ? "random" : "session" }); },
					editProvider: function (t) { self.patch({ provider: t }); },
					editFallbackSession: function (t) { self.patch({ fallbackSession: t }); },
					editHosts: function (t) { self.editHosts(t); },
					editHeaders: function (t) { self.editHeaders(t); },
					editInjectGateTools: function (v) { self.patch({ injectGateTools: v === true }); },
					editGateToolNames: function (t) { self.editGateToolNames(t); },
					editDebug: function (v) { self.patch({ debug: v === true }); },
					save: function () { return self.save(); },
					discard: function () { self.discard(); }
				};
			};
			ZenController.prototype.inject = function () {
				return Object.assign({ hooks: { opencodeZenSettings: this.store } }, this.actions());
			};
			return ZenController;
		}();

		// ── locale copy ──
		var zh = {
			intro: "给发往 opencode.ai 的请求加上 OpenCode 客户端标识头。Zen 的免费档按这些头识别客户端，缺了会被限流或直接拒绝。只影响 opencode.ai，其他域名完全不动。",
			noteTitle: "说明",
			note1: "保存后立即生效，不用重启。",
			note2: "只在请求域名命中下面列表时才加头。",
			note3: "User-Agent 是网关识别客户端和版本的依据：必须含 opencode/版本号，且版本 ≥ 1.18.0，否则免费档直接 403/426。不生效时优先改这里。",
			note4: "免费档还要求工具列表里必须存在名为 bash 和 read 的工具（实测：两个极简 stub 即可通过，与数量、大小、schema 无关）。DSH 的 shell 工具叫 pwsh，所以下面会自动补上占位工具；这只是为了过检查，模型不应调用它们。",
			enabled: "启用",
			enabledHint: "关掉 = 所有请求原样放行。",
			uaTitle: "User-Agent",
			uaHint: "必须含 opencode/版本号，且版本 ≥ 1.18.0，例如 opencode/1.18.30 或 opencode/latest/1.18.30/cli。低于 1.18.0 会被 426 拒绝。",
			uaPlaceholder: "opencode/latest/1.18.30/cli",
			sessionMode: "会话 ID 模式",
			sessionModeSession: "按会话稳定（推荐）",
			sessionModeRandom: "每请求随机",
			sessionModeHint: "Zen 按会话 ID 尾部哈希路由到上游；按会话稳定能提高命中率。",
			provider: "路由名",
			providerHint: "影响 x-opencode-project 的默认值。opencode 与 opencode-go 各自独立。",
			project: "项目标识（可选）",
			projectPlaceholder: "留空 = 按路由名自动生成 proj_xxxxxxx",
			fallbackSession: "兜底会话 ID",
			fallbackSessionHint: "模型探测等没有会话上下文的请求用它。",
			hostsTitle: "生效域名（每行一个）",
			hostsPlaceholder: "opencode.ai",
			hostsHint: "匹配该域名及其子域名。留空 = 不注入任何请求。",
			headersTitle: "额外请求头（可选）",
			headersPlaceholder: "x-opencode-project: global",
			headersHint: "每行一个「名字: 值」。官方改了头名或值，在这里补，不用改代码。",
			gateTools: "补齐免费档要求的工具名",
			gateToolsHint: "免费档拒绝工具列表里没有 bash / read 的请求。开启后，发往 opencode.ai 的请求若缺这些名字，会自动补一个占位工具定义（占位工具带「不要调用」说明）。",
			gateToolNamesTitle: "必须存在的工具名（每行一个）",
			gateToolNamesPlaceholder: "bash\nread",
			gateToolNamesHint: "实测门槛就是这两个名字。官方若改规则，在这里改，不用改代码。",
			debug: "调试日志",
			debugHint: "在宿主日志里打印每次注入的头。",
			save: "保存",
			discard: "放弃修改",
			saving: "保存中…",
			saveFailed: "保存失败，请检查后重试。",
			unsaved: "有未保存的修改",
			readOnly: "当前设置是只读的。",
			invalidFields: "请检查：启用后 User-Agent 必须含 opencode/版本号且版本 ≥ 1.18.0，域名一行一个且不含空格，工具名一行一个且只含字母数字与 _ . -，且至少一个域名。"
		};
		var en = {
			intro: "Adds OpenCode client identity headers to requests bound for opencode.ai. Zen's free tier fingerprints clients by these headers; without them requests get rate-limited or refused. Affects opencode.ai only \u2014 every other host is untouched.",
			noteTitle: "Notes",
			note1: "Effective immediately after Save \u2014 no restart.",
			note2: "Headers are added only when the request host matches the list below.",
			note3: "User-Agent is how the gateway identifies the client and its version: it must contain opencode/<version> with a version of at least 1.18.0, or the free tier refuses the request with 403/426. Change it here before changing code.",
			note4: "The free tier also requires a tool named bash and a tool named read to be present in the tool list (measured: two minimal stubs suffice \u2014 count, size and schema are irrelevant). DSH names its shell tool pwsh, so a placeholder is added below automatically; it exists only to satisfy that check and the model should not call it.",
			enabled: "Enabled",
			enabledHint: "Off = every request passes through unchanged.",
			uaTitle: "User-Agent",
			uaHint: "Must contain opencode/<version> with a version of at least 1.18.0, e.g. opencode/1.18.30 or opencode/latest/1.18.30/cli. Lower versions are refused with 426.",
			uaPlaceholder: "opencode/latest/1.18.30/cli",
			sessionMode: "Session id mode",
			sessionModeSession: "Stable per conversation (recommended)",
			sessionModeRandom: "Random per request",
			sessionModeHint: "Zen routes upstream by hashing the session id's tail; a stable id raises the hit rate.",
			provider: "Route name",
			providerHint: "Drives the default x-opencode-project. opencode and opencode-go never share one.",
			project: "Project id (optional)",
			projectPlaceholder: "Empty = derive proj_xxxxxxx from the route name",
			fallbackSession: "Fallback session id",
			fallbackSessionHint: "Used by requests with no conversation context, e.g. model discovery.",
			hostsTitle: "Hosts to affect (one per line)",
			hostsPlaceholder: "opencode.ai",
			hostsHint: "Matches the domain and its subdomains. Empty = nothing is injected.",
			headersTitle: "Extra headers (optional)",
			headersPlaceholder: "x-opencode-project: global",
			headersHint: "One \u201cname: value\u201d per line. If upstream renames a header, patch it here instead of the code.",
			gateTools: "Add the tool names the free tier requires",
			gateToolsHint: "The free tier refuses any request whose tool list lacks bash / read. When on, a request bound for opencode.ai that is missing those names gets a placeholder tool definition added (its description says not to call it).",
			gateToolNamesTitle: "Required tool names (one per line)",
			gateToolNamesPlaceholder: "bash\nread",
			gateToolNamesHint: "Measured: the gate is exactly these two names. If upstream changes the rule, edit it here instead of the code.",
			debug: "Debug logging",
			debugHint: "Print each injected header set to the host log.",
			save: "Save",
			discard: "Discard",
			saving: "Saving\u2026",
			saveFailed: "Save failed; fix the input and retry.",
			unsaved: "Unsaved changes",
			readOnly: "Settings are read-only here.",
			invalidFields: "Check your input: when enabled, User-Agent must contain opencode/<version> at or above 1.18.0, hosts must be one per line with no spaces, tool names must be one per line using only letters, digits and _ . - , and at least one host is required."
		};

		// ── styles: follow the host UI's design tokens so the section looks native ──
		const UI_CSS =
			".dshoz-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px}" +
			".dshoz-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:2px 0 8px}" +
			".dshoz-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;margin:4px 0 12px;max-width:640px}" +
			".dshoz-steps{padding:14px 16px;display:flex;flex-direction:column;gap:4px}" +
			".dshoz-stepsTitle{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4;margin:0 0 2px}" +
			".dshoz-step{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.7;margin:0}" +
			".dshoz-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}" +
			".dshoz-field+.dshoz-field{border-top:1px solid var(--dsw-alias-border-l2)}" +
			".dshoz-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}" +
			".dshoz-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}" +
			".dshoz-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5;flex:1}" +
			".dshoz-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}" +
			".dshoz-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}" +
			".dshoz-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}" +
			".dshoz-textarea{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box;resize:vertical;min-height:64px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}" +
			".dshoz-textarea:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}" +
			".dshoz-textarea:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}" +
			".dshoz-inline{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}" +
			".dshoz-col{flex:1 1 200px;min-width:0}" +
			".dshoz-check{flex-direction:row;align-items:center;gap:10px;padding:0}" +
			".dshoz-check input{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);margin:0;flex:none}" +
			".dshoz-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}" +
			".dshoz-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}" +
			".dshoz-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}" +
			".dshoz-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}" +
			".dshoz-btn:disabled{opacity:.4;cursor:default}" +
			".dshoz-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;margin-left:auto}" +
			".dshoz-readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}" +
			".dshoz-select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:13px;width:100%;box-sizing:border-box}";
		const UI_CSS_TAG = "dsh-opencode-zen/ui.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(UI_CSS_TAG) + "]") === null) {
			try {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-opencode-zen";
				tag.dataset.pluginCss = UI_CSS_TAG;
				tag.textContent = UI_CSS;
				document.head.appendChild(tag);
			} catch {}
		}

		/**
		 * This bundle's configuration form, rendered by the Plugins page on the
		 * package's own page between its description and its rows. The page draws
		 * the title, the icon and the crumb itself, so the form starts at its
		 * explanatory lead and owns everything below it.
		 */
		function ZenBundleConfig(props) {
			var state = props.useOpencodeZenSettings(function (s) { return s; });
			if (state === void 0 || !state.available) return null;
			var t = props.t;
			var draft = state.draft;
			var disabled = !state.writable;
			var blocked = !state.dirty || state.invalid || state.saving;

			var field = function (labelText, control, hintText, cls) {
				return h("div", { className: "dshoz-field" + (cls ? " " + cls : "") }, [
					h("label", { className: "dshoz-label" }, labelText),
					control,
					hintText ? h("p", { className: "dshoz-hint" }, hintText) : null
				]);
			};
			var textInput = function (value, onChange, placeholder) {
				return h("input", {
					type: "text",
					value: value,
					disabled: disabled,
					placeholder: placeholder,
					onChange: function (e) { onChange(e.target.value); },
					className: "dshoz-input"
				});
			};
			var checkField = function (labelText, checked, onChange, hintText) {
				return field(labelText,
					h("input", { type: "checkbox", checked: checked, disabled: disabled, onChange: function (e) { onChange(e.target.checked); } }),
					hintText, "dshoz-check");
			};

			return h("div", { style: { display: "flex", flexDirection: "column", minWidth: 0, maxWidth: 680 } }, [
				h("p", { className: "dshoz-desc" }, t("intro")),
				h("div", { className: "dshoz-card" }, [
					h("div", { className: "dshoz-steps" }, [
						h("h3", { className: "dshoz-stepsTitle" }, t("noteTitle")),
						h("p", { className: "dshoz-step" }, "· " + t("note1")),
						h("p", { className: "dshoz-step" }, "· " + t("note2")),
						h("p", { className: "dshoz-step" }, "· " + t("note3")),
						h("p", { className: "dshoz-step" }, "· " + t("note4"))
					]),
					h("div", { className: "dshoz-body" }, [
						!state.writable ? h("p", { role: "status", className: "dshoz-readOnly" }, t("readOnly")) : null,
						checkField(t("enabled"), draft.enabled === true, function (v) { props.editEnabled(v); }, t("enabledHint")),
						field(t("uaTitle"), textInput(draft.userAgent, function (v) { props.editUserAgent(v); }, t("uaPlaceholder")), t("uaHint")),
						h("div", { className: "dshoz-inline" }, [
							h("div", { className: "dshoz-col" }, field(t("sessionMode"),
								h("select", {
									value: draft.sessionMode,
									disabled: disabled,
									onChange: function (e) { props.editSessionMode(e.target.value); },
									className: "dshoz-select"
								}, [
									h("option", { value: "session" }, t("sessionModeSession")),
									h("option", { value: "random" }, t("sessionModeRandom"))
								]),
								t("sessionModeHint"))),
							h("div", { className: "dshoz-col" }, field(t("provider"),
								textInput(draft.provider, function (v) { props.editProvider(v); }),
								t("providerHint")))
						]),
						h("div", { className: "dshoz-inline" }, [
							h("div", { className: "dshoz-col" }, field(t("project"),
								textInput(draft.project, function (v) { props.editProject(v); }, t("projectPlaceholder")))),
							h("div", { className: "dshoz-col" }, field(t("fallbackSession"),
								textInput(draft.fallbackSession, function (v) { props.editFallbackSession(v); }),
								t("fallbackSessionHint")))
						]),
						field(t("hostsTitle"),
							h("textarea", {
								rows: 2,
								value: state.hostsText,
								disabled: disabled,
								placeholder: t("hostsPlaceholder"),
								onChange: function (e) { props.editHosts(e.target.value); },
								className: "dshoz-textarea"
							}),
							t("hostsHint")),
						field(t("headersTitle"),
							h("textarea", {
								rows: 3,
								value: state.headersText,
								disabled: disabled,
								placeholder: t("headersPlaceholder"),
								onChange: function (e) { props.editHeaders(e.target.value); },
								className: "dshoz-textarea"
							}),
							t("headersHint")),
						checkField(t("gateTools"), draft.injectGateTools !== false, function (v) { props.editInjectGateTools(v); }, t("gateToolsHint")),
						field(t("gateToolNamesTitle"),
							h("textarea", {
								rows: 2,
								value: state.gateToolsText,
								disabled: disabled || draft.injectGateTools === false,
								placeholder: t("gateToolNamesPlaceholder"),
								onChange: function (e) { props.editGateToolNames(e.target.value); },
								className: "dshoz-textarea"
							}),
							t("gateToolNamesHint")),
						checkField(t("debug"), draft.debug === true, function (v) { props.editDebug(v); }, t("debugHint")),
						h("div", { className: "dshoz-footer" }, [
							state.failed ? h("p", { role: "status", className: "dshoz-invalid" }, t("saveFailed")) : null,
							state.invalid ? h("p", { role: "status", className: "dshoz-invalid" }, t("invalidFields")) : null,
							state.dirty ? h("span", { className: "dshoz-pending" }, t("unsaved")) : null,
							h("button", {
								type: "button", className: "dshoz-btn dshoz-discard",
								disabled: !state.dirty || state.saving,
								onClick: function () { props.discard(); }
							}, t("discard")),
							h("button", {
								type: "button", className: "dshoz-btn dshoz-save",
								disabled: blocked || disabled,
								onClick: function () { props.save(); }
							}, t(state.saving ? "saving" : "save"))
						])
					])
				])
			]);
		}

		/**
		 * Contribute this bundle's configuration to the Plugins page.
		 *
		 * The slot is keyed by the package name, which is how the page pairs a
		 * bundle with its form: the entry appears on this package's own page
		 * beside its switch. Registration rides `configForms.whileServed`, so a
		 * deployment that never composed the host half shows no form at all
		 * rather than an empty one.
		 */
		function apply(ctx) {
			var controller = new ZenController(ctx.configForms.get(ENTRY_ID));
			ctx.effect(function () {
				return ctx.locale.register(LOCALE_NS, { zh: zh, en: en });
			}, "dsh-opencode-zen: form dictionaries");
			var injectFace = function () { return controller.inject(); };
			ctx.effect(function () {
				return ctx.configForms.whileServed([ENTRY_ID], function () {
					return ctx.slots.inject("plugins.bundle.config", function () {
						return ctx.slots.register({
							name: "plugins.bundle.config",
							key: BUNDLE_NAME,
							locale: LOCALE_NS,
							inject: injectFace
						}, ZenBundleConfig);
					});
				});
			}, "dsh-opencode-zen: plugin configuration form");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.ZenController = ZenController;
		exports.parseHosts = parseHosts;
		exports.parseExtraHeaders = parseExtraHeaders;
		exports.validUserAgent = validUserAgent;
		exports.validHosts = validHosts;
		exports.validGateToolNames = validGateToolNames;
		exports.parseGateToolNames = parseGateToolNames;
		exports.parseClientVersion = parseClientVersion;
		exports.clientVersionMeetsFloor = clientVersionMeetsFloor;
		return module.exports;
	}
});
