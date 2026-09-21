# dsh-opencode-zen

给 **DeepSeek Harness (DSH)** 发往 `opencode.ai` 的请求注入 OpenCode 客户端标识头（Zen / Go 免费档与粘性路由所需），并在需要时补齐免费档要求的工具名，带独立的 **Web 设置界面**。

只作用于 `opencode.ai` 及其子域名；其他任何主机原样放行，一个字节不改。

---

## 它解决什么问题

OpenCode 的网关要求推理请求携带客户端标识头。缺了会直接失败：

| 报错 | 原因 | 本机实测 |
|---|---|---|
| `403 FreeTierError` | 免费档门禁：`x-opencode-session` 的形状不对 | ✅ 2026-09-17 复现并定位 |
| `403 FreeTierError` | 免费档门禁：UA 里没有 `opencode/版本号` | ✅ 2026-09-19 复现并定位 |
| `426 UpgradeRequired` | UA 里的 `opencode/版本` **低于 1.18.0** | ✅ 2026-09-19 复现并定位 |
| `403 FreeTierError` | 免费档门禁：`tools` 里没有名为 `bash` / `read` 的工具 | ✅ 2026-09-21 复现并定位 |
| `400` | 缺 `x-opencode-session`（Go 自 2026-09-05 起强制） | ✅ 已复现 |
| `429 FreeUsageLimitError` | 瞬时限流 / 配额，**与头无关** | ⚠️ 见下文 |

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

```powershell
# 1) profile 的 package.json 加依赖与 bundle
#    依赖: "dsh-opencode-zen": "file:D:/工作项目/DSH/常规/dsh-opencode-zen"
#    bundles 里加 "dsh-opencode-zen"
pnpm install --dir "%USERPROFILE%\.dsh\profiles\web"

# 2) 重启 dsh web（宿主端代码在启动时装载）
```

启动日志应出现：

```
dsh-opencode-zen: identity headers installed (hosts=opencode.ai, enabled=true, gateTools=bash+read)
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
| User-Agent | `opencode/latest/1.18.30/cli` | **硬门禁**：必须含 `opencode/<版本号>` 且版本 ≥ **1.18.0**，否则 403 / 426。低于 1.18.0 时设置界面直接判为非法，宿主启动也会打 warn。默认值已过线，**别乱改** |
| 会话 ID 模式 | `session` | `session` 按会话稳定（推荐，粘性路由命中率高）/ `random` 每请求随机 |
| 路由名 | `opencode` | 影响 `x-opencode-project` 的默认值 |
| 项目标识 | 空 | 留空 = 按路由名生成 `proj_xxxxxxxx` |
| 兜底会话 ID | `dsh-default` | 模型探测等无会话上下文的请求用它 |
| 生效域名 | `opencode.ai` | 匹配该域名及子域名 |
| 额外请求头 | 空 | 每行 `名字: 值`，官方改头名时不用改代码 |
| **补齐免费档要求的工具名** | `true` | 请求若缺 `bash` / `read`，自动补一个占位工具定义（占位工具的描述写明「不要调用」）。只在请求**已经有**工具列表时生效 |
| **必须存在的工具名** | `bash` `read` | 每行一个。官方改规则时在这里改，不用改代码 |
| 调试日志 | `false` | 打印每次注入的头和补的工具 |

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
`^[0-9a-f]{12}[0-9A-Za-z]{14}$` —— 前 12 位小写十六进制（官方客户端在这里编码
`Date.now()`），总长 26。违反任一条都会被 403 挡下，见下文。

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

## 风险

伪装客户端头属灰色手段，官方随时可能收紧策略，社区有报告称会标记非官方客户端流量。介意请用小号 Key 或付费模型。

> **本插件已被收紧过四次**（9-05 强制 session 头 → 9-17 校验 id 形状 → 9-19 校验客户端版本
> → 9-21 校验工具名）。
> 上游随时可能再加一道门。真到那天，先看 [开发与测试](#开发与测试) 里的复现脚本，
> 用 `gate*.mjs` 的对照法定位新门禁，再改 `lib/index.js`。工具名这道门已经做成了
> 设置项，改名字不用改代码。

## 开发与测试

```powershell
node --check lib/index.js && node --check lib/client.js
node test/smoke.mjs          # 纯函数 + fetch 中间件 + llm/stream 监听 + 工具门禁（40 项）
node test/mount.mjs          # apply(ctx) 注册行为（inject/effect/on/schema/teardown）
node test/client-smoke.mjs   # 浏览器端 section 冒烟（vm 模拟 __ModuleLoader__）
```

宿主端导出的纯函数（`hostMatches` / `buildZenHeaders` / `stableZenId` /
`parseClientVersion` / `clientVersionMeetsFloor` / `createZenHeaderMiddleware` /
`createLlmStreamListener` / `detectToolShape` / `ensureGateTools` /
`rewriteGateTools`）便于单独测试，无需 DSH 启动。

### 上游再改策略时怎么查

`../.repro/zen-test/` 下是这套结论的复现脚本。**方法比脚本本身重要**：

```powershell
node gate39.mjs 300 25   # 端到端：对照 + 宿主单独 + 插件开启
node gate37.mjs 200 15 2 # 只变一个变量，每格两侧夹对照
```

1. **每轮先等 ≥120s 冷却**（`gate39` 建议 300s），请求间隔 ≥15–20s。
2. **每个用例两侧都夹一个对照**（抓包里的真实 CLI 头 + 抓包的真实 body）。
   对照不健康 → 该轮作废重跑，**不要**据此下结论。
3. **一次只变一个变量**，且顺序轮换（第二轮倒序），防止"靠前的请求通过"伪装成结论。
4. 对照组就是 `captured/req-2.headers.json` + `captured/req-2.json`——真实
   `opencode` CLI（1.18.23）经本地 relay 抓下来的原始请求。relay 用 `node relay.mjs`，
   再把 CLI 的 `baseURL` 指到 `http://127.0.0.1:4599/zen/v1`。

> 踩过的坑：`gate26` 全 403 是限流不是结论；`gate17` 因为每个形状复用同一个随机值，
> 得出了错误的"字符集"结论，`gate18` 才推翻它；`gate38` 的"对照"误传了
> `enabled:false`，导致两组完全等价。**对照写错比不做对照更危险。**

## 设计说明

- **fetch 管线挂在 `Symbol.for("dsh-opencode-zen.fetch.pipeline.v1")` 下**，与其他同样包装 `globalThis.fetch` 的插件（dsh-api-proxy、dsh-opencode-session-header 等）互不覆盖；`installFetchPipeline` 用 getter 定义 `globalThis.fetch`，并在他人赋值时重新组合链条。
- **`settingsNamespace()` 已被 `@deepseek-ai/dsh-settings` 移除**（该包现只导出 `SettingsConflictError` / `SettingsProvider` / `default` / `redactSecrets`）。命名空间现在直接传字符串，由服务自身校验。`dshmarket/lib/settings.js` 的注释确认了这一移除。

## License

MIT
