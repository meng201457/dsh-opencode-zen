# dsh-opencode-zen

给 **DeepSeek Harness (DSH)** 发往 `opencode.ai` 的请求注入 OpenCode 客户端标识头（Zen / Go 免费档与粘性路由所需），带独立的 **Web 设置界面**。

只作用于 `opencode.ai` 及其子域名；其他任何主机原样放行，一个字节不改。

---

## 它解决什么问题

OpenCode 的网关要求推理请求携带客户端标识头。缺了会直接失败：

| 报错 | 原因 | 本机实测 |
|---|---|---|
| `400` | 缺 `x-opencode-session`（Go 自 2026-09-05 起强制） | ✅ 已复现 |
| `429 FreeUsageLimitError` | 瞬时限流 / 配额，**与头无关** | ⚠️ 见下文 |

官方文档（[opencode.ai/docs/go](https://opencode.ai/docs/go/)）要求客户端：发送典型 coding agent 流量、**用自己的 UA 标识自己**、**每个对话发稳定的 `x-opencode-session`**。DSH 被官方列在「Known Problematic Clients」中，因为它的 session 头只在部分模型路径上送达。

> **先看 [实测结论](#实测结论2026-09-15本机mimo-v2-5-free)**——我实测下来只有 `x-opencode-session` 是硬性必需，429 是配额而非头的问题。这与社区流传的说法不完全一致。

### 为什么不能靠 settings.yaml 配 headers

`dsh-llm-pi-ai` 的 `requestHeaders()` 先按名字过滤掉与 attribution 冲突的用户头，**再**展开 `attributionHeaders()`：

```js
const reserved = new Set(Object.keys(attribution).map((n) => n.toLowerCase()));
return {
  ...Object.fromEntries(Object.entries(headers ?? {}).filter(([n]) => !reserved.has(n.toLowerCase()))),
  ...attribution          // ← 覆盖，用户配的 user-agent 永远出不去
};
```

而 `attributionHeaders()` 的注释写死了「nothing can suppress attribution entirely」。所以**在 pi-ai 内部无解**——除非改它的源码。

### 为什么本插件改 fetch 层

fetch 层拿到的是**已经完全合并好的最终请求**，直接覆盖即可，不跟任何人抢展开顺序。

- `@deepseek-ai/dsh-http-proxy` 官方文档明确：the pi-ai provider stack 经由 `globalThis.fetch` 出网；
- pi-ai 的 `profileOptions()` 不含 `fetch` 键，所以 OpenAI SDK 回落到全局 fetch；
- SDK 的 client 是**每请求构造**的（`new OpenAI({... fetch })`），构造时惰性取全局。

三点均已在本机实测确认，不是推断。

---

## 安装

```powershell
# 1) profile 的 package.json 加依赖与 bundle
#    依赖: "dsh-opencode-zen": "file:D:/工作项目/DSH/常规/dsh-opencode-zen"
#    bundles 里加 "dsh-opencode-zen"
pnpm install --dir "%USERPROFILE%\.dsh\profiles\web"

# 2) 重启 dsh web（宿主端代码在启动时装载）
```

启动日志应出现：

```
dsh-opencode-zen: identity headers installed (hosts=opencode.ai, enabled=true)
```

> **改代码后必须同步**：`file:` 依赖是安装时的拷贝快照，不会自动跟进。
> ```powershell
> Copy-Item lib\index.js,lib\client.js "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-opencode-zen\lib\" -Force
> ```
> `client.js` 由 `dsh-client-modules` 实时读盘，同步后**刷新浏览器**即可；宿主端 `index.js` 需**重启**。

---

## 设置

**设置 → OpenCode Zen**（独立一栏）。

| 字段 | 默认 | 说明 |
|---|---|---|
| 启用 | `true` | 关掉 = 所有请求原样放行 |
| User-Agent | `opencode/latest/1.18.30/cli` | 官方识别客户端的依据，格式随版本变；**不生效时优先改这里** |
| 会话 ID 模式 | `session` | `session` 按会话稳定（推荐，粘性路由命中率高）/ `random` 每请求随机 |
| 路由名 | `opencode` | 影响 `x-opencode-project` 的默认值 |
| 项目标识 | 空 | 留空 = 按路由名生成 `proj_xxxxxxxx` |
| 兜底会话 ID | `dsh-default` | 模型探测等无会话上下文的请求用它 |
| 生效域名 | `opencode.ai` | 匹配该域名及子域名 |
| 额外请求头 | 空 | 每行 `名字: 值`，官方改头名时不用改代码 |
| 调试日志 | `false` | 打印每次注入的头 |

保存即生效，**不用重启**。

### 注入的头

| Header | 值 |
|---|---|
| `user-agent` | 设置里的值 |
| `x-opencode-client` | `cli` |
| `x-opencode-session` | `ses_` + 16 位十六进制（按会话稳定） |
| `x-opencode-request` | `usr_` + 16 位十六进制 |
| `x-opencode-project` | `proj_` + 8 位十六进制（按路由名） |

会话 ID 必须稳定：Zen 按 `x-opencode-session` 的**尾部哈希**路由到上游，每请求随机会让每轮落到不同（常常不可用的）上游，命中率骤降。

---

## 实测结论（2026-09-15，本机，`mimo-v2.5-free`）

用真实 Key 对 `https://opencode.ai/zen/v1/chat/completions` 打过三轮，结论如下。

### 400 是硬门禁，卡在 `x-opencode-session`

| 发送的头 | 结果 |
|---|---|
| 只带 `authorization` | `400` |
| 只带 `x-opencode-client` | `400` |
| 只带 `x-opencode-project` | `400` |
| 只带 `x-opencode-request` | `400` |
| **带 `x-opencode-session`** | **通过（不再 400）** |

四个头里**只有 `x-opencode-session` 是必需的**。这与官方文档一致：Go 要求「Send a stable session ID in `x-opencode-session` for each conversation」。

### 429 是配额，不是头的问题

同一组头在不同时间返回不同结果：`session only` 先 `200` 后 `429`；完整头组先 `429` 后 `200`（拿到真实回复 `"OK"`）。

**这说明 429 是瞬时限流，与头内容无关。** 我先前在 README 里写「UA 内容决定成败」是**错的**，已更正。

### `User-Agent` 的内容未被证明有影响

| UA | 结果 |
|---|---|
| 不发送 UA | `200` |
| `deepseek-harness/0.1.2` | `200` |
| `curl/8.7.1` | `200` |
| `opencode/latest/1.18.30/cli` | `200` |
| 只发官方 UA（无 `x-opencode-*`） | `400` |

**四组都通过。** 社区（[dsh-zen-proxy](https://github.com/Yee-h/dsh-zen-proxy)）声称「`x-opencode-*` + dsh UA → 429，必须配官方 UA」——**在本机未能复现**。

官方文档确实要求客户端「用自己的 UA 标识自己」，所以默认值仍设成 OpenCode 形态；但它**不是** 200/429 的开关。留着设置项是为了官方一旦收紧能立刻改。

### 真正需要担心的

- **429 会自己来**：即使头完全正确，配额/负载也会导致 429。这是环境问题，改头解决不了。
- 探测本身会烧配额——我这三轮测试就撞到过。

## 已知不确定项

- `User-Agent` 的**具体字符串**无权威来源，社区三个插件各写一个且互相矛盾。官方只要求「用你自己的 UA 标识自己」，未公布匹配规则。**所以它被做成了设置项**。
- 本机实测中 `big-pickle`、`deepseek-v4-flash-free` 返回 `401`（后者不在官方免费模型列表里，属正常；前者原因未查）。
- 免费额度按 IP + 客户端指纹共享，充值不解锁免费模型。

## 风险

伪装客户端头属灰色手段，官方随时可能收紧策略，社区有报告称会标记非官方客户端流量。介意请用小号 Key 或付费模型。

## 开发与测试

```powershell
node --check lib/index.js && node --check lib/client.js
node test/smoke.mjs          # 纯函数 + fetch 中间件 + llm/stream 监听（19 项）
node test/mount.mjs          # apply(ctx) 注册行为（inject/effect/on/schema/teardown）
node test/client-smoke.mjs   # 浏览器端 section 冒烟（vm 模拟 __ModuleLoader__）
```

宿主端导出的纯函数（`hostMatches` / `buildZenHeaders` / `stableZenId` / `createZenHeaderMiddleware` / `createLlmStreamListener`）便于单独测试，无需 DSH 启动。

## 设计说明

- **fetch 管线挂在 `Symbol.for("dsh-opencode-zen.fetch.pipeline.v1")` 下**，与其他同样包装 `globalThis.fetch` 的插件（dsh-api-proxy、dsh-opencode-session-header 等）互不覆盖；`installFetchPipeline` 用 getter 定义 `globalThis.fetch`，并在他人赋值时重新组合链条。
- **`settingsNamespace()` 已被 `@deepseek-ai/dsh-settings` 移除**（该包现只导出 `SettingsConflictError` / `SettingsProvider` / `default` / `redactSecrets`）。命名空间现在直接传字符串，由服务自身校验。`dshmarket/lib/settings.js` 的注释确认了这一移除。

## License

MIT
