# dsh-opencode-zen

给 **DeepSeek Harness (DSH)** 发往 `opencode.ai` 的请求注入 OpenCode 客户端标识头（Zen / Go 免费档与粘性路由所需），并补齐免费档现在要求的另外两样：工具名与 `stream: true`，配置界面挂在官方 **Plugins** 页里。

只作用于 `opencode.ai` 及其子域名；其他任何主机原样放行，一个字节不改。

> **DSH 版本要求：`0.1.7-alpha.1` 及以上（实测于 `0.1.7-rc.1`）。** 0.1.7 改掉了插件配置的两侧 API
> （客户端 `settingsScope` → `configForms`，宿主 `settings.register()` → 导出
> `.volatile()` 的 `Config`），本版本已跟进，**不能**在 0.1.6 上运行。

---

## 它解决什么问题

OpenCode 的网关要求推理请求携带客户端标识头。缺了会直接失败：

| 报错 | 原因 | 本机实测 |
|---|---|---|
| `403 FreeTierError` | 免费档门禁：`x-opencode-session` 的形状不对 | ✅ 2026-09-17 复现并定位 |
| `403 FreeTierError` | 免费档门禁：UA 里没有 `opencode/版本号` | ✅ 2026-09-19 复现并定位 |
| `426 UpgradeRequired` | UA 里的 `opencode/版本` **低于 1.18.0** | ✅ 2026-09-19 复现并定位 |
| `403 FreeTierError` | 免费档门禁：`tools` 里没有名为 `bash` / `read` 的工具 | ✅ 2026-09-21 复现并定位 |
| `403 FreeTierError` | 免费档门禁：请求体不是流式（缺 `stream: true`） | ✅ 2026-10-16 复现并定位 |
| `403 FreeTierError` | 免费档门禁：`x-opencode-session` 头部低位不是官方客户端的计数位 | ✅ 2026-10-16 复现并定位 |
| `403 RegionError` | 该模型在出口 IP 所在地区不可用，**与插件无关** | ✅ 2026-10-16（`muse-spark-*-contributor-free`） |
| `400` | 缺 `x-opencode-session`（Go 自 2026-09-05 起强制） | ✅ 已复现 |
| `401` `authentication_error` / `api_key_expired` | **Key 本身过期**，与插件无关；原文写明「重新登录不会续期」 | ✅ 2026-10-18 复现 |
| `429 FreeUsageLimitError` + `retry-after` ≈ 22h | 免费档按日额度耗尽，到 UTC 00:00 重置；**换 key、换出口 IP 都没用** | ✅ 2026-10-18 实测 |
| `429 FreeUsageLimitError` | 瞬时限流 / 配额，**与头无关** | ⚠️ 见下文 |

> **2026-10-16 更新（重要）**：免费档不再只看"头长得像"，而是**解码**会话 ID 要求
> 它是官方客户端的真 id，并且要求请求体是**流式**。两条都是硬门禁，缺任一条 403
> `FreeTierError: OpenCode's free tier can only be used from within OpenCode`。
> 本插件 0.6.0 已自动处理。详见
> [实测结论（2026-10-16）](#实测结论2026-10-16免费档要求请求像官方客户端)。

> **2026-09-21 更新（重要）**：免费档还要求 `tools` 里**存在名为 `bash` 的工具**，
> **且存在名为 `read` 的工具**。DSH 的 shell 工具叫 `pwsh`、**从不发 `bash`**，
> 所以此前**任何**带工具的 DSH 请求都必然 403 —— 无论身份头多正确。
> 本插件现在会自动补占位工具。详见
> [实测结论（2026-09-21）](#实测结论2026-09-21免费档还要求工具名-bash-与-read)。

> **2026-09-19 更新**：Zen 免费档新增**客户端版本门禁**。`user-agent` 必须含
> `opencode/<版本号>`，且版本 **≥ 1.18.0**，否则 `426 UpgradeRequired`
> （响应体原文：`OpenCode 1.18.0 or newer is required to use the free tier`）。
> 插件默认 UA `opencode/latest/1.18.30/cli` 刚好过线，**不用改**。
> 详见 [实测结论（2026-09-19）](#实测结论2026-09-19免费档新增客户端版本门禁)。

> **2026-09-17 更新**：Zen 免费档现在按 **session id 的形状**放行，见
> [实测结论](#实测结论2026-09-17zen-免费档按-session-id-形状放行)。旧的 16 位十六进制
> 形状（本插件 ≤0.3.0 和 `dsh-llm-pi-ai` 内置实现都用它）**会被直接 403**。

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

> **2026-09-19 补充**：DSH `0.1.6-alpha.2` 把 `dsh-llm-pi-ai` 里内置的
> `opencodeClientHeaders()` / `stableZenId()` **整段删掉了**（全 `node_modules` 搜
> `x-opencode` 零命中）。现在宿主单独发出去的只有 `attributionHeaders()`，即
> `user-agent: deepseek-harness/<版本> (+url)`——**既没有 id，UA 也不含 `opencode/`**，
> 两道门都过不了。
>
> 实测（`gate39.mjs`，控制组 4/4 健康）：宿主单独 → `403`，插件开启 → `200`。
> 也就是说**本插件从「冗余覆盖」变成了唯一写入者**，不再是可选优化。

### 为什么本插件改 fetch 层

fetch 层拿到的是**已经完全合并好的最终请求**，直接覆盖即可，不跟任何人抢展开顺序。

- `@deepseek-ai/dsh-http-proxy` 官方文档明确：the pi-ai provider stack 经由 `globalThis.fetch` 出网；
- pi-ai 的 `profileOptions()` 不含 `fetch` 键，所以 OpenAI SDK 回落到全局 fetch；
- SDK 的 client 是**每请求构造**的（`new OpenAI({... fetch })`），构造时惰性取全局。

三点均已在本机实测确认，不是推断。

---

## 安装

用官方插件安装命令（在 profile 目录里跑 pnpm，并把声明了 `dsh.bundle` 的包自动追加进
`dsh.profile.bundles`）：

```powershell
dsh plugin --profile web add D:/工作项目/DSH/常规/dsh-opencode-zen

# 重启 dsh web（宿主端 index.js 在启动时装载）
```

> **升级 DSH 后要重新装一次。** 实测：`0.1.6-alpha.2` → `0.1.7-alpha.1` 的升级会把
> profile 重置回默认 bundles，本插件会从 `dependencies` 和 `dsh.profile.bundles`
> 里一起掉出去。`dsh.profile.bundles` **只在启动时读取**（没有热重载），所以发现
> 配置页不见了，先确认这两处还在不在，然后重启。

Web 界面等效路径：侧边栏 **Plugins → Add plugin**，填同一个路径，装完点 **Enable now**。

> 路径可以直接给绝对路径或 `link:` / `file:` 前缀。相对路径会按**你当前所在目录**
> 解析（不是 profile 目录），所以脚本里建议写绝对路径。

装完 profile 的 `package.json` 会变成：

```jsonc
{
  "dependencies": { "dsh-opencode-zen": "link:D:/工作项目/DSH/常规/dsh-opencode-zen" },
  "dsh": { "profile": { "bundles": ["...", "dsh-opencode-zen"] } }
}
```

`link:` 是**软链**（`node_modules\dsh-opencode-zen` 是指向源码目录的 junction），不是拷贝：

- **改 `lib/client.js` 不用任何同步操作** —— `dsh-client-hmr` 默认每 500ms 轮询一次
  bundle，热重载会自己把新代码换进已打开的页面（React 组件状态会丢，会话/连接保留）。
- **改 `lib/index.js`（宿主端）需要重启 dsh web**。

启动日志应出现：

```
dsh-opencode-zen: identity headers installed (hosts=opencode.ai, enabled=true, gateTools=bash+read)
```

> **别再用旧的 `file:` + 手动拷贝**：`file:` 依赖是安装时的拷贝快照，改代码不会跟进，
> 必须每次 `Copy-Item`。改用 `link:`（即上面的 `dsh plugin add`）就没这个问题。
> 若 profile 里已经是 `file:`，重新跑一次 `dsh plugin --profile web add <绝对路径>`
> 让它改写成 `link:`。

---

## 设置

**Plugins → dsh-opencode-zen**（该包的详情页，表单在描述下方、子行列表上方）。

> 早期版本把配置放在**设置 → OpenCode Zen** 这个独立一栏。现在改为注册进官方 Plugins 页，
> 不再占用独立的设置栏。
>
> 表单按 **基础 / 身份与会话 / 出网范围 / 免费档兼容 / 高级与排障** 五组排列，顶部五条实测说明
> 折叠起来（点开才展开）。开关是「方框 + 可点标签 + 独占一行的说明」——标签与控件用 `for`/`id`
> 关联，点文字就能切换/聚焦。

| 字段 | 默认 | 说明 |
|---|---|---|
| 启用 | `true` | 关掉 = 所有请求原样放行 |
| User-Agent | `opencode/latest/1.18.30/cli` | **硬门禁**：必须含 `opencode/<版本号>` 且版本 ≥ **1.18.0**，否则 403 / 426。低于 1.18.0 时设置界面直接判为非法，宿主启动也会打 warn。默认值已过线，**别乱改** |
| 会话 ID 模式 | `session` | `session` 按会话稳定（推荐，粘性路由命中率高）/ `random` 每请求随机 |
| 路由名 | `opencode` | 影响 `x-opencode-project` 的默认值 |
| 项目标识 | 空 | 留空 = 按路由名生成 `proj_xxxxxxxx` |
| 兜底会话 ID | `dsh-default` | 模型探测等无会话上下文的请求用它 |
| 生效域名 | `opencode.ai` | 匹配该域名及子域名 |
| **代理地址** | 空 | 命中生效域名的请求改从该 **HTTP** 代理出网，例如 `http://192.168.1.199:7890`（Clash/Mihomo 混合端口直接可用）。留空 = 直连；只支持 `http://`，`socks5://` 会被判非法；代理不通时**自动退回直连**并打 warn |
| 额外请求头 | 空 | 每行 `名字: 值`，官方改头名时不用改代码 |
| **补齐免费档要求的工具名** | `true` | 请求若缺 `bash` / `read`，自动补一个占位工具定义（占位工具的描述写明「不要调用」）。只在请求**已经有**工具列表时生效 |
| **必须存在的工具名** | `bash` `read` | 每行一个。官方改规则时在这里改，不用改代码 |
| **强制流式请求** | `true` | 免费档把非流式请求当成「原始 API 调用」直接 403。开启后，发往 `opencode.ai` 的对话型请求（带 `messages` / `input` / `tools` 的 JSON）若没写 `stream`，自动补 `stream: true`；已经在流式的请求一个字节都不动 |
| 调试日志 | `false` | 打印每次注入的头、补的工具和补的 `stream` |

保存即生效，**不用重启**。

### 注入的头

| Header | 值 |
|---|---|
| `user-agent` | 设置里的值。**必须含 `opencode/<版本>` 且版本 ≥ 1.18.0** |
| `x-opencode-client` | `cli` |
| `x-opencode-session` | `ses_` + 26 位（12 位小写十六进制 + 14 位 base62，按会话稳定） |
| `x-opencode-request` | `usr_` + 同上形状 |
| `x-opencode-project` | `proj_` + 8 位十六进制（按路由名） |

会话 ID 必须稳定：Zen 按 `x-opencode-session` 的**尾部哈希**路由到上游，每请求随机会让每轮落到不同（常常不可用的）上游，命中率骤降。

**形状同样是硬门禁**：`x-opencode-session` / `x-opencode-request` 的 id 体必须匹配
`^[0-9a-f]{9}ffe[0-9A-Za-z]{14}$` —— 前 12 位小写十六进制（官方客户端在这里编码
`Date.now() * 4096 + 计数器`），总长 26。**后三位固定 `ffe`**：那三位是计数器的补码，
官方客户端的第一个 id 就是 `ffe`，而免费档现在会解码并拒绝一个真客户端不可能产生的
计数（2026-10-16 新增）。违反任一条都会被 403 挡下，见下文。

**`user-agent` 同样过门禁**：不含 `opencode/版本号` 会被 403，版本低于 `1.18.0`
会被 `426 UpgradeRequired`。设置界面会直接判非法，宿主启动时也会打 warn。

### 补的工具（占位，非真实工具）

免费档要求 `tools` 里存在名为 `bash` 和 `read` 的工具。DSH 的工具集里**没有 `bash`**
（shell 工具叫 `pwsh`），所以插件会补上：

```jsonc
// 仅在缺少时追加；已有同名工具则完全不动
{ "type": "function",
  "function": {
    "name": "bash",
    "description": "Compatibility shim required by the OpenCode Zen free tier, which refuses
                    any tool list without a tool named `bash`. This tool is NOT implemented —
                    never call it; use `pwsh` to run shell commands.",
    "parameters": { "type": "object", "properties": { "command": { "type": "string" } }, "required": ["command"] }
  } }
```

三点设计取舍：

- **只追加，不前置**：现有工具列表的前缀保持逐字节不变（前缀常被上游缓存）。
- **只在请求本来就有 `tools` 时生效**：会话标题生成器（0 工具）不加，否则会给一个
  必须返回纯文本的请求塞进工具调用。
- **描述里写明「不要调用」**：模型读到工具列表时会被引导到真实工具（`pwsh`）上，
  而不是去调占位工具。占位工具没有服务端 handler，真被调用会失败一次。

三种 wire format 都覆盖：`openai-completions` 用 `{type,function:{...}}`、
`openai-responses` 用 `{type,name,parameters}`、`anthropic-messages` 用
`{name,input_schema}` —— 按请求体里已有的工具形状判断，形状判不出来时按 URL 路径兜底。

---

## 代理（0.7.0）

**目的**：给命中生效域名的请求一个可选的出口代理，用来绕开与出口地址相关的问题（地区不可用、将来若按 IP 计额）。

**为什么做在 fetch 层**：`globalThis.fetch` 没有标准的 per-request 代理开关（undici 的 `dispatcher` 不是标准选项），DSH 又把 `init` 原样透传，所以只能在这一层实现——它拿到的已经是可以直接出网的最终请求。

**实现**：HTTPS 走 HTTP `CONNECT` 隧道（Clash/Mihomo 混合端口 7890 就是这套），隧道里再自己握 TLS、自己发 HTTP/1.1。**没有新增依赖**：`socks5://` 需要 socks 客户端，因此在解析阶段就判为非法，而不是请求时才失败。

**行为边界**（都在 `test/proxy.mjs` 里有断言）：

- 只有命中**生效域名**的请求走代理，其他主机一个字节不动；
- 代理地址写错 / 隧道建不起来 → **退回直连**并打 warn（设置项写错不该让整站不可用，这是本文件对工具名那条同样的取舍）；
- 请求体**在隧道建立之后**才读取，所以代理失败时 `init.body` 仍然完整，退回直连不会发出空 body；
- 同域重定向最多跟 5 跳（303 会把 POST 降成无 body 的 GET）；**跨域重定向不跟**——跟了就把身份头和 `authorization` 送给别人；
- 响应里的 `content-encoding`（gzip/deflate/br/zstd）在这里自己解，否则绕过 undici 之后 `res.json()` 会拿到压缩字节。

**实测（2026-10-18，`http://192.168.1.199:7890`）**：

```
proxied egress = 104.28.163.26          ← 出口确实换了
zen 经中间件    -> 429   next() calls = 0
direct  429 retry-after=78791  deadline=2026-10-18T23:59:59Z
proxied 429 retry-after=78785  deadline=2026-10-18T23:59:59Z   ← 同一个 deadline
public(匿名) 经代理 -> 429  同一 deadline
```

所以**这一条不要误读**：代理链路确实通了（TLS、换 IP、中间件完全接管请求），但**当天的免费额度并没有因为换出口而恢复**——直连与代理、你自己的 key 与 `Bearer public`，拿到的都是同一个「到 UTC 00:00」的窗口。也就是说 10-18 这个 429**不是**按出口 IP 计的，换 IP 不解决问题。

按现有证据，代理真正有用的场景是 `403 RegionError`（该模型在出口地区不可用）这类**按出口地址判定**的拒绝，以及官方日后若真把免费额度改成按 IP 计。**它不能用来重置已耗尽的每日额度。**

> **还有一格没测到**：真正的 200 流式响应。当天额度已耗尽，Zen 只肯回 429，所以 TLS-over-CONNECT 的流式只在 `test/proxy.mjs` 里用本地源站验过（SSE 分块会在 origin 还在写的时候就到达 `res.body`）。等额度恢复后，`node .probe/proxy-live.mjs` 应能从 429 变成 200 + SSE，那才算这一格补齐。

---

## 实测结论（2026-10-16，免费档要求请求"像官方客户端"）

这一轮不是再加一道形状检查，而是**开始解码**：免费档会解析会话 ID、并要求请求体是
流式的。报错重新回到那句笼统的：

```json
{"type":"error","error":{"type":"FreeTierError",
 "message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."}}
```

**规则（在 `https://opencode.ai/zen/v1/chat/completions` 上实测）：**

1. `x-opencode-session` 必须是官方 `Identifier` 的 **descending** 形态，头部的低 12 位
   （12 位十六进制里的后 3 位）必须是 `ffe`。
2. 请求体必须 `stream: true`。

**方法**：本机装着官方 CLI（`opencode-ai@1.18.23`），把它指到本地中继（`.zen-probe/relay2.mjs`）
抓下**真实请求原文**，再由中继原样转发到真 relay —— 官方 CLI 拿到 200。之后所有用例
**两侧都夹这个官方请求作对照**（约 60 次请求，对照组 100% 200），一次只变一个变量。

| 请求 | 结果 |
|---|---|
| 官方 CLI 头 + 官方 CLI 体（对照） | ✅ 200 |
| 插件头 + 插件体 | ❌ 403 |
| 插件头 + 官方 CLI 体 | ❌ 403 |
| 官方 CLI 头 + 插件体 | ❌ 403 |
| 官方 CLI 体 + 插件的 `user-agent` / `x-opencode-project` / `x-opencode-request` | ✅ 200 |
| 官方 CLI 体，只把 `x-opencode-session` 换成插件的 | ❌ 403 |
| 官方 CLI 头 + 插件体 **加 `stream: true`** | ✅ 200 |
| 插件的头 + 插件的体 + 标记头 + `stream: true` | ✅ 200 |

**所以判据只有这两条**：会话 ID 的头部低位、以及 `stream`。`user-agent`、
`x-opencode-project`、`x-opencode-request` 的**值**都不校验（沿用插件的值一样 200）。

### 头部到底校验什么

官方 id 生成器（从 `opencode.exe` 里提取，两处实现一致）：

```js
const n = BigInt(Date.now()) * 4096n + BigInt(++counterPerMs);
if (descending) n = ~n;              // session 用 descending，message/request 用 ascending
head = hex48(n);                     // 12 位十六进制；解码：timestamp = BigInt("0x"+head) / 4096n
tail = 14 位随机 base62
```

低 12 位因此是**计数器的补码**（`0xfff - counter`）。扫描：

| 头部 | 结果 |
|---|---|
| 官方算法现算（含 −1h / −1d） | ✅ |
| **随机 36 位时间 + 低 12 位 `ffe`** | ✅ |
| counter 0（`fff`）/ 1（`ffe`）/ 2（`ffd`） | ✅ |
| counter 4095（低 12 位 `000`） | ❌ |
| ascending 形态（不取反） | ❌ |
| 14 位尾巴换成随机 | ✅（尾巴不校验） |

结论：**时间部分任意，低 12 位必须落在真客户端会产生的计数范围**。插件现在仍按会话
稳定地派生前 9 位，只把后 3 位钉成 `ffe`（0.6.0）。

### 怎么修、怎么验

插件 0.6.0 的两处改动都在 fetch 中间件里，配置项可关：

- `stableZenId()`：头部前 9 位仍由种子派生，后 3 位固定 `ffe`。
- `forceStream`（默认开）：发往 `opencode.ai` 的对话型 JSON body 若没有 `stream`，补
  `stream: true`；已经在流式的 body 逐字节不动。

**端到端验证**（`.zen-probe/verify-fix.mjs`，真实中间件 + 真实网络，两侧夹对照）：

```
CONTROL (official CLI shape)      -> 200
PLUGIN mimo-v2.6-flash-free
   sent session   = ses_9d3c98e39ffen2JYl0HWr6iTEz
   forced stream  = true   tools=pwsh,bash,read
   -> 200
```

### 顺带确认的两件事（不是插件的问题）

- **`muse-spark-1.2/1.3-contributor-free` 在本机出口 IP 所在地区不可用**：`403 RegionError`
  "This model is not available in your country"。用官方 CLI 的原始头/体、只换模型名同样
  403，所以是地区限制，不是门禁。`cordis.patch.yml` 里的 `opencode2` 就是它 —— 换一个
  免费模型（如 `nemotron-3.5-lightning-free`、`deepseek-v4.1-flash-free`、`glm-5.3-flash-free`）即可。
- **`mimo-v2.5-free` 已被上游废弃**（官方 CLI 明确回 "deprecated, use mimo-v2.6-flash-free"）。

---

## 实测结论（2026-09-21，免费档还要求工具名 `bash` 与 `read`）

这一节推翻了此前「`tools.length >= 2`」的表述。**数量是相关，不是因果**——
早期那 2 个工具恰好就叫 `bash` 和 `read`。

**规则：`tools` 数组里必须存在名为 `bash` 的工具，且存在名为 `read` 的工具。**
名字是唯一判据——数量、字节大小、`$schema`、`required`、`strict`、描述全无关。

`gate53`（9 个对照全 200）+ `gate54`（7 个对照全 200），冷却 240s、间隔 20s：

| `tools` | 结果 |
|---|---|
| cli 全量 11 个（bash…write） | ✅ 200 |
| cli 前 6 个 | ✅ 200 |
| cli 前 6 个 **去掉 `read`** | ❌ 403 |
| cli 前 6 个 **去掉 `bash`** | ❌ 403 |
| cli 前 4 个（无 `read`） | ❌ 403 |
| cli 前 4 个 + 2 个 dummy | ❌ 403 |
| `{bash,edit,read,skill}`（仅 4 个） | ✅ 200 |
| **DSH 全量 51 个**（shell 叫 `pwsh`） | ❌ 403 |
| DSH 51 个 + **极简合成 `bash`** | ✅ 200 |
| DSH 51 个，把 `pwsh` **改名**成 `bash` | ✅ 200 |
| DSH 51 个 + `bash`，**去掉 `read`** | ❌ 403 |
| **仅** `{bash,read}` 两个 stub | ✅ 200 |

**证伪的模型**：数量（`cli6-bash` 与 `cli6-skill` 都是 5 个工具，403 vs 200）、
字节大小（6671→403、10639→403、10446→200、50820→200，非单调）、
`strict:false`（`gate49`：`cli11+strict` → 200）。

**这解释了核心矛盾**：DSH 从不发 `bash`，所以身份头再正确也必然 403。

### 端到端验证

**1）真实 DSH 请求体走真实中间件（`gate55.mjs`，对照 4/4 健康）**

把**真实抓包的 DSH 请求体**（49922B / 51 工具）喂给**仓库里真实的插件中间件**，
由中间件自己的 `next` 真的发网络请求：

```
CTRL (captured CLI)                -> 200
ARM1 插件开启（真实 DSH body）      -> 200   ← 补到 52 个工具，bash=true read=true
CTRL                               -> 200
ARM2 插件关闭（同样中间件同样头）    -> 403   ← 51 个工具，bash=false
CTRL                               -> 200
ARM3 完全不经中间件                 -> 403   ← 用户报的那个 bug
CTRL                               -> 200
```

**ARM2 是关键对照**：头完全相同、中间件完全相同，只差 `injectGateTools` 一个开关，
403 → 200 的翻转只能归因于**请求体改写**本身。

**2）真实 DSH agent 回合（本机实测，配额可用时对照 2/2 健康）**

`gate56.mjs`：

```
CTRL cli             200
DSH plugin-on        200   ← 52 tools, bash=true read=true
DSH plugin-off       403   ← 51 tools, bash=false
CTRL cli             200
```

**3）真实 DSH 运行时抓包**

用一个隔离的 `DSH_HOME` + 本地 relay（`relay2.mjs`，转发到真实 `opencode.ai`）
跑真实的 web profile，发一条真实消息，抓到的请求：

```
POST /zen/v1/chat/completions  (40685 bytes)
  ua      : opencode/latest/1.18.30/cli
  session : ses_9d0c60109e0ccN8taL6rgRVkzE
  request : usr_121603291116VkzETixCZokVEz
  client  : cli
  project : proj_5fd19820
  tools   : 33  bash=true read=true
```

body 尾部就是插件补的那个占位 `bash`（DSH 自己的 32 个工具 + 补的 1 个）。
同一条请求在修复前是 `403 FreeTierError`。

> 抓包那轮上游回的是 `429 FreeUsageLimitError` —— 那是**限流**（gate53/54/55 连续打同一
> 个 IP 的后果），不是门禁：`gate56` 在配额恢复后拿到 200。

---

## 实测结论（2026-09-19，免费档新增客户端版本门禁）

用真实 Key 对 `https://opencode.ai/zen/v1/chat/completions`（`mimo-v2.5-free`）测量。
**所有其他头固定在已知可用状态，只变 `user-agent`**；每个格子 2/2，中间穿插对照
（抓包里的真实 CLI 头），对照 14 次里 12 次 200（两次 429 是限流，不是结论）。

| `user-agent` | 结果 |
|---|---|
| `opencode/1.0.0` | ❌ `426 UpgradeRequired` |
| `opencode/1.10.0` | ❌ `426 UpgradeRequired` |
| `opencode/1.18.0` | ✅ 2/2 |
| `opencode/1.18.23` | ✅ 2/2 |
| `opencode/1.18.30` | ✅ 2/2 |
| `opencode/2.0.0` | ✅ 2/2 |
| `opencode/latest`（无数字版本） | ❌ `403 FreeTierError` |
| `opencode/` | ❌ `403 FreeTierError` |
| `opencode 1.0`（无斜杠） | ❌ `403` |
| `opencode` | ❌ `403` |
| `deepseek-harness/0.1.6-alpha.2 (+url)` | ❌ `403` |
| 完全不带 `user-agent` | ❌ `403` |

`426` 的响应体把规则写明了：

```json
{"type":"error","error":{"type":"UpgradeRequired",
 "message":"Error from provider (Console): OpenCode 1.18.0 or newer is required to use the free tier"}}
```

### 由此确定

1. **`user-agent` 的内容重新变成硬门禁**（9-15 那轮"内容无关"的结论**已失效**）。
2. 匹配规则是「字符串里出现 `opencode/`，其后第一个数字串即版本」，**大小写不敏感、不锚定**：
   `Mozilla/5.0 opencode/1.18.23` 通过，`OPENCODE/2.0` 也通过（版本取 `2.0`）。
3. 版本门限是 **`1.18.0`**（含）：`1.10.0` 挂，`1.18.0` 过。
4. 版本号缺失（`opencode/latest`、`opencode/`）报的是 **403**，版本号太低报的是 **426** ——
   两个不同的分支，报错类型可用来区分。
5. 插件默认 UA `opencode/latest/1.18.30/cli` **两条都过**，无需改动。

> **方法学警告**：按 IP 限流依然存在，而且这轮更凶——连对照都会偶发 `429`。
> 任何结论都必须**每个用例两侧夹一个对照**，对照不健康时该轮作废重跑。
> 早期几轮（`gate33`–`gate36`）就因为对照失效产生过错误中间结论。

### DSH 侧的连带影响

DSH `0.1.6-alpha.2` 删掉了 `dsh-llm-pi-ai` 内置的 opencode 头生成器，宿主自己发出去的
`user-agent` 是 `deepseek-harness/...`（**既无 id，也不含 `opencode/`**）。
`gate39.mjs` 端到端验证（控制组 4/4 健康）：

```
C control (captured CLI headers)   -> 200
off  alpha.2 host alone            -> 403   ← 宿主单独：两道门都过不了
C control                          -> 200
on   plugin default UA + ids       -> 200   ← 插件开启
C control                          -> 200
cli  real CLI UA + plugin ids      -> 200
C control                          -> 200
```

**结论：插件修复有效，且从"冗余覆盖"变成了唯一写入者。**

---

## 实测结论（2026-09-17，Zen 免费档按 session id 形状放行）

用真实 Key 对 `https://opencode.ai/zen/v1/chat/completions`（`mimo-v2.5-free`）测量。
**注意必须先排除限流**：连续快速请求会让**任何**形状都返回 403，早期测量因此反复自相矛盾。
下列结果均按 ≥15 秒间隔、乱序、重复取样得出。

| 形状 | 结果 |
|---|---|
| `ses_` + 12 小写hex + 14 任意字母数字 | ✅ 3/3 通过 |
| `ses_` + 26 位全小写hex | ✅ 3/3 通过 |
| `ses_` + 12 小写hex + 14 大写 | ✅ 3/3 通过 |
| `ses_` + **11** 位hex + 15 位 | ❌ 0/3 |
| `ses_` + 12 位**大写**hex + 14 位 | ❌ 0/3 |
| `ses_` + 12 小写hex + 8 位（总长 20） | ❌ 0/3 |
| `ses_` + 12 小写hex + 20 位（总长 32） | ❌ 0/3 |
| 旧插件的 16 位hex | ❌ 0/3 |

### 由此确定

1. **门槛是 id 的形状**（`^[0-9a-f]{12}[0-9A-Za-z]{14}$`，总长 26），不是 id 的具体值。
2. **`Bearer public` 无关** —— 自己的 Key 同样通过；`public` 只是官方客户端的匿名哨兵值。
3. ~~**`user-agent` 内容无关**~~ —— **此条已于 2026-09-19 被推翻**，见上一节：
   UA 现在必须含 `opencode/<版本>` 且版本 ≥ 1.18.0。9-17 当时确实内容无关。
4. **`x-opencode-client` 无关**（去掉仍通过）。
5. **`dsh-llm-pi-ai` 内置的 `opencodeClientHeaders()` 用的是同一种坏形状**，
   且它 spread 在最后。本插件的 fetch 中间件在更晚的层覆盖它，实测生效
   （见 `integration.mjs`：插件值覆盖原生值后 200）。
   > 2026-09-19 起该内置实现已被 DSH `0.1.6-alpha.2` 删除，插件不再需要覆盖它，
   > 而是唯一写入者。

### 机制来源

从 `opencode.exe`（1.18.23）提取到的官方 id 生成器：

```js
function tU(_, Y = Date.now()) {
  let $ = BigInt(Y) * 0x1000n + BigInt(cU),
      U = /* 取 $ 的 6 字节 → 12 位小写十六进制 */,
      X = crypto.getRandomValues(new Uint8Array(14));
  return U + /* 14 位来自 "0-9A-Za-z" */;
}
```

配合二进制里的常量 `Aje = 26`，与实测规则完全吻合。

---

## 实测结论（2026-09-15，本机，`mimo-v2.5-free`）—— 历史记录

> 以下为 9-15 的结论，当时门禁是 `400`。9-17 起门禁变为上述 403 形状校验，
> 保留此节仅作对照。

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

### `User-Agent` 的内容未被证明有影响 —— ⚠️ 已推翻

> 下表是 **2026-09-15** 的结果。**2026-09-19 起该结论失效**：UA 必须含
> `opencode/<版本>` 且版本 ≥ 1.18.0，见 [实测结论（2026-09-19）](#实测结论2026-09-19免费档新增客户端版本门禁)。
> 保留此表以说明服务端策略换过至少三次。

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

- `User-Agent` 的**具体字符串**无权威来源，社区三个插件各写一个且互相矛盾。已知的硬规则只有两条：必须含 `opencode/<版本>`，且版本 ≥ 1.18.0。**所以它被做成了设置项**，且设置界面会校验这两条。
- 本机实测中 `big-pickle`、`deepseek-v4-flash-free` 返回 `401`（后者不在官方免费模型列表里，属正常；前者原因未查）。
- 免费额度按 IP + 客户端指纹共享，充值不解锁免费模型。
- **`429` 与门禁无关**：即使所有头都正确，配额/负载也会 429。排障时**必须先排除限流**，否则会把 429 误读成"这个形状被拒"。
- **会话 ID 的时间部分是否会被校验，未知。** 2026-10-16 实测任意 36 位都能过（时间部分是种子派生的随机值），但上游若加上"时间必须接近当前"这条，`stableZenId` 就得改成在会话首次使用时取一次 `Date.now()` 并记忆。
- **DSH 实际发出的 body 里是否已带 `stream`，未抓包验证。** `forceStream` 无条件补，正是为了不依赖这个假设；如果你的部署里有"故意非流式"的调用，把它关掉。

## 风险

伪装客户端头属灰色手段，官方随时可能收紧策略，社区有报告称会标记非官方客户端流量。介意请用小号 Key 或付费模型。

> **本插件已被收紧过五次**（9-05 强制 session 头 → 9-17 校验 id 形状 → 9-19 校验客户端版本
> → 9-21 校验工具名 → 10-16 解码 id 低位 + 要求流式）。
> 上游随时可能再加一道门。真到那天，先看 [开发与测试](#开发与测试) 里的复现方法与
> `.zen-probe/` 下的脚本，用对照法定位新门禁，再改 `lib/index.js`。工具名、域名、
> `stream` 开关都已经做成了设置项，改值不用改代码。

## 开发与测试

```powershell
node --check lib/index.js && node --check lib/client.js
node test/smoke.mjs            # 纯函数 + fetch 中间件 + llm/stream 监听 + 工具门禁 + 客户端门禁（52 项）
node test/proxy.mjs            # 真实 CONNECT 隧道：本地代理 + 本地源站，覆盖转发、gzip、SSE、重定向、退回直连（16 项）
node test/mount.mjs            # apply(ctx, config)：Config/volatile 字段、默认值、effect/on/teardown、活引用更新
node test/client-smoke.mjs     # 浏览器端冒烟：configForms 条目 id、bundle-config 注册、served 门禁、mutate、渲染（vm 模拟 __ModuleLoader__）
node test/loader-contract.mjs  # 导出形态：模块必须能通过 Loader 的 unwrapExports 且仍带 Config
```

改表单布局时不用启动 DSH：`.probe/preview.mjs` 把**真实组件 + 真实样式**渲成静态页
（`node .probe/preview.mjs "lang=zh"`，加 `state=errors` 可看「未保存 + 非法」的页脚极端态），
再用浏览器截图核对间距与换行。2026-10-18 那次改版就是靠它发现开关行被压成一字一行的。

宿主端导出的纯函数（`hostMatches` / `buildZenHeaders` / `stableZenId` /
`parseClientVersion` / `clientVersionMeetsFloor` / `createZenHeaderMiddleware` /
`createLlmStreamListener` / `detectToolShape` / `ensureGateTools` /
`rewriteRequestBody` / `requiresStream`）便于单独测试，无需 DSH 启动。

### 上游再改策略时怎么查

`../.zen-probe/` 下是 2026-10-16 这轮的复现脚本。**方法比脚本本身重要**：

```powershell
node relay2.mjs            # 本地抓包中继：把官方 CLI 的请求原文落盘再原样转发
node verify-fix.mjs 15000  # 端到端：真实中间件改写 → 真 relay，两侧夹官方对照
node alt2.mjs 12000        # 定向对照：一次只变一个变量，每格两侧夹对照
```

1. **先拿到官方客户端的真实请求**，别照着文档猜。装官方 CLI（`npm i -g opencode-ai`），
   用 `XDG_DATA_HOME`/`XDG_CONFIG_HOME` 指到临时目录并复制 `auth.json`，在
   `config/opencode/opencode.json` 里把 `provider.opencode.options.baseURL` 指向
   `http://127.0.0.1:4599/zen/v1`，然后 `opencode run -m opencode/<免费模型> hi`。
   中继会把头、体原文连上游状态一起记进 `capture.jsonl`。**注意 CLI 的模型列表来自
   models.dev 快照**，太新的模型它不认（会报 `ProviderModelNotFoundError`）。
2. **每个用例两侧都夹这个官方请求作对照**。对照不健康 → 该轮作废重跑，**不要**据此下结论。
3. **一次只变一个变量**。2026-10-16 这轮的教训是：`头全换` 和 `体全换` 各自都 403，
   而两个一起换是 200 —— 那不是"必须同时满足"，而是**两道独立的门，各自被踩中一道**。
   只有把落在同一侧的单变量用例补齐，才看得出这一点。
4. **200 的响应体是 SSE 长流**：只判状态码的话，拿到响应就把 `res.body.cancel()` 掉，
   探测才跑得动（60 次请求的矩阵靠这个才做得完）。
5. **`x-opencode-session` 是自造 id 时最容易被卡的地方**：它是唯一被"解码"而不是"看形状"
   的字段，所以单变量对照要专门为它留一格。

> 踩过的坑：`gate26` 全 403 是限流不是结论；`gate17` 因为每个形状复用同一个随机值，
> 得出了错误的"字符集"结论，`gate18` 才推翻它；`gate38` 的"对照"误传了
> `enabled:false`，导致两组完全等价；**而 10-16 这轮一开始差点把"两道门"读成
> "必须同时像官方才放行"**。**对照写错比不做对照更危险。**

## 设计说明

- **fetch 管线挂在 `Symbol.for("dsh-opencode-zen.fetch.pipeline.v1")` 下**，与其他同样包装 `globalThis.fetch` 的插件（dsh-api-proxy、dsh-opencode-session-header 等）互不覆盖；`installFetchPipeline` 用 getter 定义 `globalThis.fetch`，并在他人赋值时重新组合链条。
- **配置表单注册进 `plugins.bundle.config`，按包名做 key**（`dsh-opencode-zen`）。该槽位由 `@deepseek-ai/dsh-client-ui-plugin-manager` 在 `main` 面板的 `children` 里声明，`kind: 'keyed'`，key 就是 bundle 的包名 —— 页面对 bundle 和表单的配对规则。同一个包里另两个槽位是 `plugins.item`（官方 host-plane 配置页占用，卡片进 Official 分组）和 `plugins.row.config`（key 为 `<包名>#<rowId>`，配某个子行）。
- **宿主半边（0.1.7 起）导出 `Config` schema，字段标 `.volatile()`**。DSH `0.1.7-alpha.1` 删掉了 `settings.register(ns, schema, opts)`：Loader 现在把插件模块导出的 `Config` 校验后挂到 `entry.fiber.runtime.Config`，`@deepseek-ai/dsh-settings` 用 `volatileForm()` 只把标了 `.volatile()` 的字段投影成表单（未标字段仍是普通配置，只能改 patch 文件）。`apply(ctx, config)` 拿到的每个字段是**活引用**，用 `config.x.get()` 读 —— 所以页面保存后下一个请求立刻生效，不需要重启。
- **依赖必须用 `@deepseek-ai/schemastery`，不能是裸 `schemastery`**。`.volatile()` 只存在于 scoped fork，且 **3.18.3 才有**（3.18.2 及以下没有）。裸 `schemastery` 是 npm 原版 3.18.0，**没有 `.volatile()`** —— 用它不会报错，只会静默产出一个没有任何可编辑字段的 `Config`，页面上什么都不显示。这也是官方插件（如 `dsh-web-search-deepseek`）声明 `"@deepseek-ai/schemastery": "^3.18.3"` 的原因。
- **配置表单的键是插件条目 id，不是命名空间字符串**。`describe()` 里 `ns: entry.options.id`，即 profile 层给这一行的 id（本插件是 `cordis.patch.yml` 里的 `- id: opencode-zen`）。所以客户端必须 `configForms.get("opencode-zen")`，且它必须与 `cordis.patch.yml` 的 `id` 一致。
- **门禁用官方的 `configForms.whileServed([entryId], register)`**：该条目出现在 describe 镜像里才注册，消失就自动注销。没有宿主半边时页面不留空表单。返回值是 disposer，由调用方用 `ctx.effect` 包住 —— 这正是官方 `dsh-client-ui-settings-web-search` 的写法。
- **保存走一次原子 `mutate`**，而不是 11 次独立 `set`：宿主在单个 revision 栅栏下应用整批操作，表单保存不会被观察到半应用状态，也不会和其他页面的并发编辑抢跑。被拒绝时（`mutate` 解析为 `false`）保留草稿并报错，**不**回滚 —— 静默回退会丢掉用户正在看的编辑。
- **宿主半边绝对不能有 `export default`（v0.5.1 修）**。`cordis-plugin-loader` 的 `unwrapExports()` 第一句就是 `exports = exports.default ?? exports`；ESM namespace 没有 `__esModule`，于是**下一句直接 return**，默认导出把整个 namespace 顶掉。`registry.plugin()` 随后记的 `Config: plugin.Config` 就是 `undefined`，`dsh-settings.describe()` 把没有 schema 的条目**静默过滤掉** —— 插件照常工作（`apply` 仍是合法 callback），但 Plugins 页上**一个字段都不显示，且不报任何错**。官方文档写得很直白（"export one of these forms; do not mix them"），所有官方插件也都只用具名导出。这个 bug 由 `e734de3` 引入、藏了三个版本，因为 `mount.mjs` 断言的是**模块 namespace** 上的 `mod.Config`，而 Loader 读的是 unwrap 之后的对象 —— 两者在带默认导出时**不是同一个东西**。`test/loader-contract.mjs` 现在把这段 unwrap 算法照抄下来跑一遍真实模块，专门盯这个。
- **门禁占位工具对任意工具名都要能生成（v0.5.1 修）**。"必须存在的工具名"是给用户改的（上游改规则时不用改代码），但 `buildGateTool` 原先对 `bash`/`read` 之外的任何名字直接 `throw TypeError`，而 fetch 中间件**不 catch** —— 用户在设置页把工具名改成 `skill` 这类合法名字后，**发往 opencode.ai 的每一个请求都会失败**。现在未知名字会合成一个通用占位（描述里写明"未实现、别调用"并点名该工具），把"设置写错"从"整站不可用"降级为"多一个无害占位"。
- **卡片显示文字与图标来自 manifest，不来自代码（v0.5.1 加）**。Plugins 页在**不激活插件**的前提下读 `locale/en.json` 的 `meta.title` / `meta.description` 和 `package.json` 顶层的 `icon`；缺了就退回包名、包描述和默认图形。所以需要三处配套：`locale/*.json` 文件、`exports` 里的 `"./locale/*.json"`（否则 `ERR_PACKAGE_PATH_NOT_EXPORTED` 会让元数据整块读不到）、以及 `files` 里带上它们。图标必须是 manifest 目录内的相对路径、扩展名限 svg/png/jpg/jpeg/webp、≤256 KiB。
- **会话 ID 的后三位是钉死的常量，不是派生的（v0.6.0 改）**。免费档现在会解码头部：它取 12 位十六进制里的**低 12 位**当作官方客户端的"每毫秒计数器"补码，真客户端只可能产生很小的计数（实测 `fff`/`ffe`/`ffd` 通过，`000` 拒绝）。原先 FNV 派生的头部低位是均匀随机的，形状对、计数不对，照样 403。前 9 位仍由种子派生，会话稳定性（Zen 按尾部哈希做粘性路由）完全不受影响。
- **`stream: true` 是免费档的第三个硬门禁（v0.6.0 加）**。官方客户端永远发流式请求，非流式在它眼里就是"原始 API 调用"。中间件因此把 body 改写做成一件事的两个子步骤（补工具名 + 补 `stream`），共用一次 `readBodyText` —— 流式 body 只能读一次，分成两次改写会把 body 读空。已经在流式的 body 逐字节返回原文，不做无谓重序列化。


## License

MIT
