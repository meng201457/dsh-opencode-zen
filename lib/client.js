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
				proxyUrl: "",
				fallbackSession: "dsh-default",
				provider: "opencode",
				extraHeaders: {},
				injectGateTools: true,
				gateToolNames: ["bash", "read"],
				forceStream: true,
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
		// An empty setting means "no proxy"; anything else must be an http:// proxy.
		// `socks5://` is refused here rather than at request time: the host half has
		// no SOCKS client, so accepting it would turn a setting into a silent
		// direct-connection fallback.
		function validProxyUrl(value) {
			var text = String(value ?? "").trim();
			if (text === "") return true;
			var url;
			try {
				url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : "http://" + text);
			} catch {
				return false;
			}
			return url.protocol === "http:" && url.hostname !== "";
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
					dirty: JSON.stringify(this.draft) !== JSON.stringify(this.normalizeDraft(value)),
					invalid: this.invalid(),
					saving: this.saving,
					failed: this.failed,
					draft: this.draft,
					hostsText: this.hostsText,
					headersText: this.headersText,
					gateToolsText: this.gateToolsText
				});
			};
			/**
			 * The draft shape a Host value maps to. Both `seed` and the dirty check
			 * go through it, so a field the Host does not serve yet (an older host
			 * half after a client reload) is a default rather than a phantom edit.
			 */
			ZenController.prototype.normalizeDraft = function (value) {
				return {
					enabled: value.enabled === true,
					userAgent: typeof value.userAgent === "string" ? value.userAgent : DEFAULT_USER_AGENT,
					project: typeof value.project === "string" ? value.project : "",
					sessionMode: value.sessionMode === "random" ? "random" : "session",
					hosts: Array.isArray(value.hosts) ? value.hosts.slice() : ["opencode.ai"],
					proxyUrl: typeof value.proxyUrl === "string" ? value.proxyUrl : "",
					fallbackSession: typeof value.fallbackSession === "string" ? value.fallbackSession : "dsh-default",
					provider: typeof value.provider === "string" ? value.provider : "opencode",
					extraHeaders: value.extraHeaders !== null && typeof value.extraHeaders === "object" ? Object.assign({}, value.extraHeaders) : {},
					injectGateTools: value.injectGateTools !== false,
					gateToolNames: Array.isArray(value.gateToolNames) ? value.gateToolNames.slice() : ["bash", "read"],
					forceStream: value.forceStream !== false,
					debug: value.debug === true
				};
			};
			ZenController.prototype.seed = function (value) {
				this.draft = this.normalizeDraft(value);
				this.hostsText = this.draft.hosts.join("\n");
				this.headersText = formatExtraHeaders(this.draft.extraHeaders);
				this.gateToolsText = this.draft.gateToolNames.join("\n");
			};
			ZenController.prototype.invalid = function () {
				if (this.draft.enabled !== true) return false;
				if (!validUserAgent(this.draft.userAgent)) return true;
				if (!validHosts(this.hostsText)) return true;
				if (!validProxyUrl(this.draft.proxyUrl)) return true;
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
					{ op: "set", path: ["proxyUrl"], value: String(draft.proxyUrl ?? "").trim() },
					{ op: "set", path: ["fallbackSession"], value: String(draft.fallbackSession ?? "").trim() },
					{ op: "set", path: ["provider"], value: String(draft.provider ?? "").trim() },
					{ op: "set", path: ["extraHeaders"], value: Object.assign({}, draft.extraHeaders) },
					{ op: "set", path: ["injectGateTools"], value: draft.injectGateTools !== false },
					{ op: "set", path: ["gateToolNames"], value: draft.gateToolNames.slice() },
					{ op: "set", path: ["forceStream"], value: draft.forceStream !== false },
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
					editProxyUrl: function (t) { self.patch({ proxyUrl: t }); },
					editHeaders: function (t) { self.editHeaders(t); },
					editInjectGateTools: function (v) { self.patch({ injectGateTools: v === true }); },
					editGateToolNames: function (t) { self.editGateToolNames(t); },
					editForceStream: function (v) { self.patch({ forceStream: v === true }); },
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
			groupBasics: "基础",
			groupIdentity: "身份与会话",
			groupNetwork: "出网范围",
			groupFreeTier: "免费档兼容",
			groupAdvanced: "高级与排障",
			enabled: "启用",
			uaTitle: "User-Agent",
			uaPlaceholder: "opencode/latest/1.18.30/cli",
			sessionMode: "会话 ID 模式",
			sessionModeSession: "按会话稳定（推荐）",
			sessionModeRandom: "每请求随机",
			provider: "路由名",
			project: "项目标识（可选）",
			projectPlaceholder: "proj_xxxxxxxx",
			fallbackSession: "兜底会话 ID",
			hostsTitle: "生效域名（每行一个）",
			hostsPlaceholder: "opencode.ai",
			proxyTitle: "代理地址（可选）",
			proxyPlaceholder: "http://192.168.1.199:7890",
			headersTitle: "额外请求头（可选）",
			headersPlaceholder: "x-opencode-project: global",
			gateTools: "补齐免费档要求的工具名",
			gateToolNamesTitle: "必须存在的工具名（每行一个）",
			gateToolNamesPlaceholder: "bash\nread",
			forceStream: "强制流式请求",
			debug: "调试日志",
			save: "保存",
			discard: "放弃修改",
			saving: "保存中…",
			saveFailed: "保存失败，请检查后重试。",
			unsaved: "有未保存的修改",
			readOnly: "当前设置是只读的。",
			invalidFields: "请检查：启用后 User-Agent 必须含 opencode/版本号且版本 ≥ 1.18.0，域名一行一个且不含空格，工具名一行一个且只含字母数字与 _ . -，代理地址必须是 http:// 主机:端口（或留空），且至少一个域名。"
		};
		var en = {
			groupBasics: "Basics",
			groupIdentity: "Identity and session",
			groupNetwork: "Egress scope",
			groupFreeTier: "Free-tier compatibility",
			groupAdvanced: "Advanced and troubleshooting",
			enabled: "Enabled",
			uaTitle: "User-Agent",
			uaPlaceholder: "opencode/latest/1.18.30/cli",
			sessionMode: "Session id mode",
			sessionModeSession: "Stable per conversation (recommended)",
			sessionModeRandom: "Random per request",
			provider: "Route name",
			project: "Project id (optional)",
			projectPlaceholder: "proj_xxxxxxxx",
			fallbackSession: "Fallback session id",
			hostsTitle: "Hosts to affect (one per line)",
			hostsPlaceholder: "opencode.ai",
			proxyTitle: "Proxy (optional)",
			proxyPlaceholder: "http://192.168.1.199:7890",
			headersTitle: "Extra headers (optional)",
			headersPlaceholder: "x-opencode-project: global",
			gateTools: "Add the tool names the free tier requires",
			gateToolNamesTitle: "Required tool names (one per line)",
			gateToolNamesPlaceholder: "bash\nread",
			forceStream: "Force streaming requests",
			debug: "Debug logging",
			save: "Save",
			discard: "Discard",
			saving: "Saving\u2026",
			saveFailed: "Save failed; fix the input and retry.",
			unsaved: "Unsaved changes",
			readOnly: "Settings are read-only here.",
			invalidFields: "Check your input: when enabled, User-Agent must contain opencode/<version> at or above 1.18.0, hosts must be one per line with no spaces, tool names must be one per line using only letters, digits and _ . - , the proxy must be an http:// host:port (or empty), and at least one host is required."
		};

		// ── styles: follow the host UI's design tokens so the section looks native ──
		const UI_CSS =
			".dshoz-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:2px 16px 6px}" +
			// Group separators: one heading per concern, so the thirteen fields read
			// as five decisions instead of one flat list.
			".dshoz-groupTitle{margin:18px 0 0;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l2);font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);line-height:1.4}" +
			".dshoz-groupTitle:first-of-type{margin-top:10px;padding-top:0;border-top:0}" +
			".dshoz-field{flex-direction:column;gap:6px;padding:10px 0;display:flex;min-width:0}" +
			".dshoz-field+.dshoz-field{border-top:1px solid var(--dsw-alias-border-l2)}" +
			// A dependent field hangs off its switch instead of looking like a peer.
			".dshoz-nested{margin:0;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2)}" +
			".dshoz-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}" +
			".dshoz-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5;flex:1}" +
			".dshoz-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}" +
			".dshoz-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}" +
			".dshoz-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}" +
			".dshoz-textarea{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box;resize:vertical;min-height:64px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}" +
			".dshoz-textarea:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}" +
			".dshoz-textarea:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}" +
			".dshoz-inline{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start}" +
			".dshoz-col{flex:1 1 200px;min-width:0}" +
			// Switches wrap: the hint owns the second line, so the label never gets
			// squeezed into a one-character column (which is what a flex row with a
			// 100%-basis hint does to it).
			".dshoz-check{flex-direction:row;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:10px 0}" +
			".dshoz-check input{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);margin:0;flex:none}" +
			".dshoz-check .dshoz-label{flex:1 1 auto;min-width:0;cursor:pointer}" +
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

			// Labels are linked to their control with htmlFor/id, so clicking the text
			// focuses the field or flips the switch.
			var fieldId = 0;
			var field = function (labelText, control) {
				fieldId += 1;
				var id = "dshoz-field-" + fieldId;
				var linked = control !== null && typeof control === "object" && control.props !== undefined
					? Object.assign({}, control, { props: Object.assign({}, control.props, { id: id }) })
					: control;
				return h("div", { className: "dshoz-field" }, [
					h("label", { className: "dshoz-label", htmlFor: id }, labelText),
					linked
				]);
			};
			var textInput = function (value, onChange, placeholder) {
				return h("input", {
					type: "text",
					value: value,
					disabled: disabled,
					placeholder: placeholder,
					autoComplete: "off",
					spellCheck: false,
					onChange: function (e) { onChange(e.target.value); },
					className: "dshoz-input"
				});
			};
			var textArea = function (value, onChange, placeholder, rows, off) {
				return h("textarea", {
					rows: rows,
					value: value,
					disabled: disabled || off === true,
					placeholder: placeholder,
					spellCheck: false,
					onChange: function (e) { onChange(e.target.value); },
					className: "dshoz-textarea"
				});
			};
			var checkId = 0;
			var checkField = function (labelText, checked, onChange) {
				checkId += 1;
				var id = "dshoz-check-" + checkId;
				return h("div", { className: "dshoz-field dshoz-check" }, [
					h("input", { id: id, type: "checkbox", checked: checked, disabled: disabled, onChange: function (e) { onChange(e.target.checked); } }),
					h("label", { className: "dshoz-label", htmlFor: id }, labelText)
				]);
			};
			var sectionTitle = function (titleKey) {
				return h("h4", { className: "dshoz-groupTitle" }, t(titleKey));
			};

			return h("div", { className: "dshoz-root", style: { display: "flex", flexDirection: "column", minWidth: 0, maxWidth: 720 } }, [
				h("div", { className: "dshoz-card" }, [
					!state.writable ? h("p", { role: "status", className: "dshoz-readOnly" }, t("readOnly")) : null,
					sectionTitle("groupBasics"),
					checkField(t("enabled"), draft.enabled === true, function (v) { props.editEnabled(v); }),
					field(t("uaTitle"), textInput(draft.userAgent, function (v) { props.editUserAgent(v); }, t("uaPlaceholder"))),
					sectionTitle("groupIdentity"),
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
							]))),
						h("div", { className: "dshoz-col" }, field(t("provider"),
							textInput(draft.provider, function (v) { props.editProvider(v); })))
					]),
					h("div", { className: "dshoz-inline" }, [
						h("div", { className: "dshoz-col" }, field(t("project"),
							textInput(draft.project, function (v) { props.editProject(v); }, t("projectPlaceholder")))),
						h("div", { className: "dshoz-col" }, field(t("fallbackSession"),
							textInput(draft.fallbackSession, function (v) { props.editFallbackSession(v); })))
					]),
					sectionTitle("groupNetwork"),
					field(t("hostsTitle"),
						textArea(state.hostsText, function (v) { props.editHosts(v); }, t("hostsPlaceholder"), 2)),
					field(t("proxyTitle"),
						textInput(draft.proxyUrl, function (v) { props.editProxyUrl(v); }, t("proxyPlaceholder"))),
					sectionTitle("groupFreeTier"),
					checkField(t("gateTools"), draft.injectGateTools !== false, function (v) { props.editInjectGateTools(v); }),
					h("div", { className: "dshoz-nested" }, [
						field(t("gateToolNamesTitle"),
							textArea(state.gateToolsText, function (v) { props.editGateToolNames(v); }, t("gateToolNamesPlaceholder"), 2, draft.injectGateTools === false))
					]),
					checkField(t("forceStream"), draft.forceStream !== false, function (v) { props.editForceStream(v); }),
					sectionTitle("groupAdvanced"),
					field(t("headersTitle"),
						textArea(state.headersText, function (v) { props.editHeaders(v); }, t("headersPlaceholder"), 3)),
					checkField(t("debug"), draft.debug === true, function (v) { props.editDebug(v); }),
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
		exports.validProxyUrl = validProxyUrl;
		exports.validGateToolNames = validGateToolNames;
		exports.parseGateToolNames = parseGateToolNames;
		exports.parseClientVersion = parseClientVersion;
		exports.clientVersionMeetsFloor = clientVersionMeetsFloor;
		return module.exports;
	}
});
