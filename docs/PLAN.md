# Figma × DeepSeek Harness 插件技术实现方案

> 目标：把 Figma 的设计能力做成 DSH 里**可插拔的一等公民**——模型能用原生工具读懂一个 Figma 文件（结构 / 样式 / 变量 / 组件 / 截图），而不需要人肉截图粘贴。
>
> 状态：**设计定稿，等待开工指令**。包名 `figma-mcp-dsh`、交付形态 A only、只读、npm + GitHub 双通道分发——全部已定（§9）。P0 范围已冻结（§9.1.3）。文中所有关于 DSH 内部接口的结论，均已在本机部署上实测核对，出处标注在 §10。
>
> **项目将开源，但范围是 DeepSeek Harness 插件**（受众 = 其他 DSH 用户）。由此产生的约束见 §12：主要是**默认值要面向更弱的 Figma 席位**，以及配置/排障的易用性——**不含多宿主分发**。
>
> **交付形态已确认：仅 A**（DSH 原生 Cordis 插件，P0 交付）。MCP 适配器（B）当前不做，但保留了「可随时补回」的 CI 可检查不变量（§12.3.1）。**分发：npm + GitHub 双通道**（§12.9.1）。包名 `figma-mcp-dsh`（§9.1.2）。
>
> **脱敏说明**：本文中的 fileKey、节点 id 与文件名均写作**合成标识符**（如 fileKey `Aa1Bb2Cc3Dd4Ee5Ff6Gg7H`、文件名 `Design File A` / `Design File B`）。全部实测结论来自真实的私有设计文件，其真实标识符不随本仓库发布。合成 fileKey 仍是 22 位 `[A-Za-z0-9]`，所以文中关于长度、URL 形态与 `depth` 体积的陈述依然成立。

---

## 0. 结论先行（TL;DR）

这套东西**不需要从零实现 MCP 协议**。本机部署里已经有 `@deepseek-ai/dsh-mcp-client`，MCP 的「标准描述层 + 自动发现 + 调度协议」这三层 DSH 已经提供了，而且它读取的是 `tools/list` 返回的 JSON Schema——**任何东西只要能产出工具描述，就已经是一个 MCP server 的等价物**。

所以真正要做的只有两件事：

1. **能力底座**：把 Figma 的 REST API 包装成一张**声明式的 capability registry**（数据，不是代码）；
2. **上下文管道**：把 Figma 那种动辄几十 MB 的节点树，压成模型能读、且读得起的形状。

至于对外协议，做成**双适配器**：默认走 DSH 原生插件（进程内、零序列化、可直接复用 `ctx.credentials`），同时**顺手导出 MCP server**（~150 行），这样同一套能力以后能直接喂给 Claude Code / Codex / Cursor。核心不绑定协议。

预期最终形态：模型调用 `figma_capabilities` 发现能力 → `figma_call` 执行 → 返回**裁剪过的节点树 + 一个可复用的图片引用**。整条链路对模型而言就是 3 个工具，而不是 130 个。

---

## 0.1 理论地基：Cordis 的时空可组合性

本方案的所有生命周期设计都不是工程直觉，而是 Cordis 形式化基础的直接推论。参考：**Shi, Zhang, Cui, _A Programming Paradigm for Spatiotemporal Composability_, arXiv:2608.25512（北京大学 / DeepSeek-AI，2026-08-26）** —— 即 Cordis 框架的论文。

论文把"动态组合"拆成两个正交维度，并各自给出运行时机制：

| 论文概念 | 论文定义（意译） | 本方案里它落在哪 |
|---|---|---|
| **Revertible effects**（可逆效应） | 每一次上下文变换都携带一个由运行时保管的逆变换 → 时间可组合性 | 每个 `ctx.effect()` / `ctx.on()` / `ctx.tools.register()` 都自带 disposer：**桥断开时必须收回的子资源清单**（WebSocket、令牌桶计时器、缓存驱逐定时器、`figma/*` 监听器） |
| **Reactive coeffects**（反应式余效应） | 每一次上下文变化都与组件的 coeffect 规格比对，据此驱动组件的激活/失活 → 空间可组合性 | `inject: ['figmaBridge']`：桥出现则工具激活，桥消失则工具自动失活，**不需要手写探测** |
| **Context paradigm**（上下文范式） | 把 effect context 与 coeffect context 统一为单一 context 类型，所有 effect/coeffect 都经由它中介 | 就是 `ctx`：`ctx.tools.register()`（效应）与 `inject`（余效应）走同一根代理 |
| **Observational equivalence**（观测等价） | 中介诱导出一个等价关系，**不同组件的效应在此等价下交错而不互相干扰** | 这是"装/卸 Figma 插件不会扰动其他插件"的形式化保证；也是 DSH 敢做 `patchReload: live` 的理论依据 |

**三个具体的设计后果**（不是修辞，是改了设计）：

1. **§4.3 的 `figma_canvas` 从"手动降级"改成"依赖声明"**。我原稿写的是"桥离线时返回未就绪"——那是**命令式探测**，要在 `apply` 里轮询或缓存桥状态，而桥状态本身就成了一个会漂移的副本。改成让桥作为服务、`figma_canvas` 作为 `inject: ['figmaBridge']` 的子插件后，Cordis 的 coeffect 解析接管了激活/失活：**离线状态不再是一种运行期错误，而是一个可推理的静态状态**，工具表在离线时也不被无用定义占用上下文。
2. **分层纪律有了理论依据**。论文要求"组件"是自足单元（效应与余效应都在组件边界内可逆/可解析）。`core` 零 DSH 依赖因此不只是"方便测试"，而是让 `core` 成为一个真正的组件；协议适配器只是把它绑定到某个 context 上。这解释了为什么双适配器（原生 + MCP）是零成本抽象而不是额外负担。
3. **限流桶的单例归属得到确认**。令牌桶是进程级共享状态，跨 session 复用；它既不是某个组件的私有效应，也不能被某个 session 的卸载带走——所以它必须挂在一个**所有 session 都够得着的 context** 上，即 host 面（§2.1 的结论由此从"经验"变成"推论"）。

> 论文另有 92 页正文与 service broker（§5.7）等内容，对"多 Figma 账号并存、灰度切换提供方"这类未来需求有直接价值；本方案 P0–P1 不依赖它们。

---

## 1. 现状核查：地基比预想的厚

### 1.1 DSH 已经有的东西（实测）

| 能力 | 包 | 对本方案的意义 |
|---|---|---|
| MCP 客户端桥 | `dsh-mcp-client` | 消费任意 MCP server；工具名 `mcp__<server>__<tool>`；支持 stdio 与 streamable-http |
| 凭据服务 | `dsh-credentials` + `dsh-credentials-local` | 密钥不进配置文件；`ctx.credentials.resolve(ref)` **每次操作重新解析**（轮换后无需重启） |
| 工具注册表 | `dsh-tools` | `ctx.tools.register()` 是 Effect，插件卸载自动反注册；支持 `output` 规范化契约、`finalizeContent` |
| 出站代理 | `dsh-http-proxy` | 裸 `fetch()` 自动走 `HTTPS_PROXY`，**不需要**为代理写额外代码 |
| 图片管道 | `dsh-attachment` / `dsh-llm` | 工具结果里可以带**持久化 image block**；有精确的路由能力闸门与文本降级 |
| 热重载 | `cordis-plugin-loader` (`patchReload: live`) | 改 `cordis.patch.yml` 即时生效，开发循环极短 |
| 本地插件先例 | `~/.dsh/profiles/web/plugins/pale-green-tint` | 本机已有手写插件被正确挂载，照抄它的接线即可 |

### 1.2 四条硬约束（它们决定了整个设计）

**约束一：工具描述是永久上下文税。**
`dsh-mcp-client` 的文档写得很直白：*"Tool definitions add tokens to every model request"*。

本机实测（`Tool.listTools` 实测 + JSON 尺寸估算，见 §10）当前这个 session 有 **34 个工具**，光定义就约 **30.9k 字符 ≈ 8.6k tokens，每一次请求都要付**，平均每个工具约 250 tokens。据此外推：

| 暴露方式 | 每请求额外成本 |
|---|---|
| 把 20 个常用 Figma 端点各做一个工具 | +5.0k tokens |
| 把 50 个端点各做一个工具 | +12.6k tokens |
| 把 REST API 的 130+ 端点各做一个工具 | **+32.8k tokens（≈ 现有全部工具的 4 倍）** |
| **本方案：3 个固定工具** | **≈ +0.75k tokens** |

而且代价不只是钱：工具表一变动，KV cache 前缀从第一个变更的 schema token 起全部失效。130 个工具的表天然是"经常变动"的表。

> **推论：绝不"一个端点 = 一个工具"。能力层的粒度是「声明式 registry」，模型只看到固定 3 个工具，能力目录按需检索、按需展开。**

**约束二：Figma 限流比想象中狠得多。**
按官方最新（2025-11-17 生效）限流表，**Tier 1**（`GET file` / `GET file nodes` / `GET image`）的额度是：

| 席位 | Starter | Professional | Organization | Enterprise |
|---|---|---|---|---|
| View / Collab | 20 / **月** | 20 / **月** | 20 / **月** | 20 / **月** |
| Dev / Full | 10 / 分 | 10 / 分 | 15 / 分 | 20 / 分 |

Tier 2（组件、变量、版本、项目、评论）Dev/Full 席位为 25–100/分；Tier 3 为 50–150/分。429 会带 `Retry-After`（秒）、`X-Figma-Plan-Tier`、`X-Figma-Rate-Limit-Type`（`low`=Collab/Viewer，`high`=Full/Dev）、`X-Figma-Upgrade-Link`。

> **推论：缓存、请求合并、`depth` 优先，不是性能优化，是可用性前提。** 一个"帮我看看这个文件"的对话，如果模型连续三次拉全量文件，Full 席位一分钟额度就没了。

**约束三：`GET /v1/files/:key` 会返回整棵文档树。**
一个中等规模的社区文件、或任何有历史的设计系统文件，全量 JSON 几十 MB 是常态，`geometry=paths` 会让它更大。直接塞进 tool result 等于当场烧掉上下文。

> **推论：默认必须 `depth=1` 或按 `ids` 定点取；全量取只在显式要求时发生，且要落盘 spool。**

**约束四（隐性但关键）：插件权限模型不允许"随便发请求"。**
Figma 插件 manifest 的 `networkAccess.allowedDomains` 是**域名白名单**，不在名单里的域会被 Figma 直接拦掉（`["none"]` 表示禁止一切外部网络）。要连本地桥就必须显式声明，且**名单里出现 localhost / 开发服务器时 `reasoning` 字段是必填的**：

```json
"networkAccess": {
  "allowedDomains": ["ws://127.0.0.1:8790", "https://api.figma.com"],
  "reasoning": "读取当前画布选区并回传给本地开发工具链",
  "devAllowedDomains": ["ws://127.0.0.1:8790"]
}
```

同时，插件的 `main` 代码运行在 Figma 的受限沙箱中（无 socket / 无任意 fetch），只有 `ui` 声明的 iframe 具备网络能力，两者通过 `postMessage` 通信。这条决定了「Plugin API 桥」的拓扑（见 §5.3）。

### 1.3 已实测的 Figma API 行为（用你的 PAT 打一个私有设计文件）

P0 的第一件事做完了。下面是实测数据，其中**三条直接修正了原设计**：

**(1) `depth` 是唯一有效的体积防线，而且不做默认——危害极大。**

同一个节点 `ids=13:14`（一个 FRAME），只改 `depth`：

| 请求 | 响应体 |
|---|---|
| `/nodes?ids=13:14`（**不传 depth**） | **48,659 bytes** |
| `/nodes?ids=13:14&depth=1` | **2,491 bytes**（−95%） |
| `/nodes?ids=13:14&depth=2` | 4,529 bytes |
| `/nodes?ids=13:14&depth=3` | 6,928 bytes |
| `/nodes?ids=1:2`（**根 CANVAS，不传 depth**） | **1,193,266 bytes** ≈ 整个文件（`/v1/files/:key` 全量是 1,193,337 bytes） |

**结论**：`ids` 只决定"从哪开始"，**不限制取多少**；`depth` 才决定取多少。不传 `depth` 时返回**完整后代树**——所以 `?ids=<根节点>` 等于把整个文件拉回来。这不是隐患，是**必然踩到的坑**，因为模型对"取一个节点"的直觉预期是"取这一层"。

> **硬性要求**：`params` 里 `depth` 必须有插件侧默认值（2），且 `ids` 与 `depth` **成对使用**。`figma_call` 在 `ids` 存在而 `depth` 缺失时**自动补默认值**，而不是把球踢给模型。

**(2) `ETag` 存在，但条件请求不可用——缓存只能靠 TTL。**

- `GET /v1/files/:key/meta` **返回** `etag: W/"3b0-..."`；
- 带 `If-None-Match: <该 etag>` 重新请求，返回 **`200` + 完整 body，不是 304**；
- 且响应头明确 `cache-control: no-cache, no-store`；
- `GET /v1/files/:key` 与 `/nodes` **没有** `etag`。

> **结论**：原稿"用 `If-None-Match` 换 304 省额度"的方案**作废**。缓存只能用**短 TTL**（默认 60s）。所幸"304 是否消耗额度"这个悬而未决的问题**不再需要回答**——既然拿不到 304，它对方案没有影响。缓存失效判据改用 `/meta` 的 `version` / `last_touched_at`（便宜、Tier 3）做显式失效。

**(3) `/meta` 是最便宜的"指纹"端点，且自检很轻。**

`GET /v1/files/:key/meta` 返回 200、944 bytes、2.2s，含 `version`、`lastModified`、`last_touched_at`、`creator`、`role: owner`。自检与"文件是否变了"都靠它。

**(4) 图片导出：小 JSON + 需下载的预签名 URL。**

`GET /v1/images/:key?ids=1:2&format=png&scale=2` → `200`，**126 bytes**：
`{"err":null,"images":{"1:2":"https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/..."}}`。
拿到的只是 URL，必须再下载一次。§4.5(d) 的"立刻落盘 + 内容寻址"设计成立。

**(5) 限流实测**：在约 3 分钟窗口内对 Tier 1/Tier 3 端点共发出 ~12 次请求，**未出现 429**。这**不能**证明 Full 席位在 Pro 套餐下的上限高于 10/min——样本太小。保守预算仍然保留，等真实 429 出现后再用响应头校正。

**(6) 投影器已在真实数据上验证通过（这是最有价值的一条）。**

用你给的 `Design File A` 文件（1,219 个节点）里 `首页示例 / Box` 这个 FRAME（`11:12`，`depth=4`）跑了一遍白名单投影：

| | 大小 | 约合 tokens |
|---|---|---|
| Figma 原始节点 JSON | 20,859 chars | ~5,794 |
| 投影后 | 5,879 chars | ~1,633 |
| **压缩率** | **−72%** | |

且关键语义**完整保留**：

- **配色**（`color` 是 0–1 浮点 RGBA，投影时归一为 hex）：`#111827`（近黑正文）、`#9CA3AF`（次要灰）、`#C4CCC8`（浅边框灰）、`#F5F5F7`（卡片底）、`#FFFFFF`
- **字体层级**：`Inter 400 10.5px` / `Inter 400 12.5px` / `Inter 600 13.0px` / `Inter 700 18.0px` —— 4 级，干净
- **文案**（含中文与换行）：`欢迎使用示例应用`、`开始之前，建议先完成基础配置…`

**所以 §4.5(a) 的投影策略不是纸上设计，是已验证可行的**；`depth=4` 这种深度的单个画板产出约 1,600 tokens，8 个画板全读约 1.3 万 tokens——在预算内。

**(7) 实测中发现并修正了一个会静默取错颜色的 bug（重要）。**

Figma 的 paint 对象长这样：

```json
{ "blendMode": "NORMAL", "type": "SOLID",
  "color": { "r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0 } }
```

`color.a` 是**颜色的 alpha 通道**，**不是**图层的透明度；图层透明度是**另一个字段** `fill.opacity`。我的投影草稿把两者混用了（用 `color.a` 当 opacity），这在实测样本上**恰好没暴露**——因为该文件的 8 个 fill **全部** `a = 1.0`（实测 `fills with their own opacity: 0/8`）。

但只要有一个半透明色（如 `{r:0.5,g:0.5,b:0.5,a:0.3}`），草稿就会算出 `#4D4D4D` 而不是正确的 `#808080`，**而且不会报错——只是颜色静默错误**。这类 bug 在"模型读设计"的场景里最难发现，因为它看起来完全合理。

> **修正后的规则**：hex 只取 `r/g/b`（忽略 `a`）；透明度只读 `fill.opacity`，且仅在 `≠1` 时输出；`color.a` 单独作为 alpha 透传。**已写入 P0 的单元测试清单，并用半透明样本做回归。**

**(8) 其它结构事实**：整个 `/v1/files` payload 里 `document` 占 **100.0%**（1,305,357 / 1,305,964 bytes），顶层 `components` / `componentSets` / `styles` 都是空 map —— **所以体积全部来自文档树，`ids` + `depth` 就是正确的两个杠杆，没有第三个需要处理的膨胀源**。该文件有 8 个顶层画板（`保存流程示例`、`导出流程`/`导出流程2`、`整理流程`/`整理流程2`、`配置页`、`首页示例`、`识别流程`），每个画板内嵌一个 `Box` 深树。

### 1.4 第二个文件：设计系统 + 明暗主题（`Design File B`）

fileKey `Zz9Yy8Xx7Ww6Vv5Uu4Tt3S`，`link_access: plan_edit`，20 个顶层画板 = **10 对 `Light - Dashboard - N` / `Dark - Dashboard - N`**。这一轮验证了主题化配色提取，并**暴露两个新的实测坑**。

**(1) 主题配对验证通过——投影器能正确区分明暗两套配色。**

对同一仪表盘的明暗两版（`3:4` / `5:6`，各 **154 个节点**，均为 `depth=4`）跑投影：

| | LIGHT (`3:4`) | DARK (`5:6`) |
|---|---|---|
| 原始 JSON | 123,328 chars (~34,258 tok) | 122,961 chars (~34,156 tok) |
| 投影后 | 35,425 chars (~9,840 tok) | 35,105 chars (~9,751 tok) |
| 压缩率 | **−71%** | **−71%** |
| 配色数 | 9 | 12 |

提取到的配色**语义上完全正确**：

- **LIGHT**：`#FFFFFF`×104（底）、`#B8C5D3`×20、`#748AA1`×8、`#31394D`×6（深色文字/图形）、`#E8F0F8`×5、`#EBEDF4`×3、`#29CB97`×2（品牌绿）、`#D8D8D8`×2、`#F5F6FA`×1
- **DARK**：`#FFFFFF`×104、`#545F69`×13、`#748AA1`×8、`#B8C5D3`×7、`#2C3135`×5、`#292E33`×4、`#29CB97`×2（品牌绿**保持不变**）、`#D8D8D8`×2、`#33393F`×2、`#363C43`×2、`#1F2327`×1、`#16191C`×1

两个信号说明投影**没有把主题压平**：① 两版配色集合不同（9 vs 12）；② 中性色整体位移到深灰阶（`#2C3135`/`#292E33`/`#1F2327`/`#16191C`），而**品牌绿 `#29CB97` 在两版里都不变**——这正是设计系统该有的行为。字体两版一致（`Roboto 400 14/20/36px`），文本也一致（`Top places`、`60%`、`9.8%`）。

**(2) ⚠️【已修正】关于 `depth` 与文件级组件表——我上一轮的推断是错的。**

上一轮我看到三个 depth 下 `components` 都是 0 项，**推断是"`depth` 抑制了组件表的填充"**。用户把两个画板转成组件后重测，证明**这个推断是错的**：

| 请求 | 响应体 | `components` | `componentSets` | `styles` |
|---|---|---|---|---|
| `/files/:key`（不传 depth） | **5,547,625 B** | **2** | 0 | 0 |
| `/files/:key?depth=1` | 969 B | **0** | 0 | 0 |
| `/files/:key?depth=2` | 26,948 B | **2** | 0 | 0 |
| `/files/:key?depth=3` | 105,611 B | **2** | 0 | 0 |

**真实规律**：`depth=1` 只返回页面 canvas、**不含任何实际内容**，所以那时没有组件可报告——表是"因为内容里没有组件"而空，不是因为 `depth` 抑制了填充。**`depth≥2` 时组件表正常填充。**

> **教训（已写进 §11 纪律清单第 10 条）**：上一轮我从"三个 depth 都返回 0"推出"depth 抑制组件表"，**这个推断超出了证据**——它无法区分"被抑制"和"本来就没有"。用**改变输入**（真的加两个组件）来验证假设，而不是从同一组零值里推因果，是唯一可靠的判别方式。

顺带得到准确数字：**这个文件全量 `document` 树是 5.55 MB**（此前只有 `Design File A` 的 1.31 MB 作参考）。

**(2b) 组件语义实测：节点信息齐全，但还没有"使用"组件。**

用户转成组件的两个画板：`7:8` = `Dark - Dashboard - 10`，`9:10` = `Light - Dashboard - 10`。实测：

- **节点 id 不变**，但 `type` 从 `FRAME` 变成 **`COMPONENT`**（`9:10` 实测 `type: "COMPONENT"`）——投影器**必须把 `type` 当判据**，不能假设"顶层画板都是 FRAME"；
- **`components` map 的元数据字段全集**（实测，比文档更具体）：`key` / `name` / `description` / `remote` / `documentationLinks`。**没有 `componentSetId`、没有变体属性、没有尺寸**——想知道"属于哪个组件集/有哪些变体"，这些字段靠不住；
- **`containingFrame` 字段不存在**（文档提到过），不要依赖；
- **`componentId` 只出现在 `INSTANCE` 节点上**，`COMPONENT` 定义节点自己没有；
- **文件里 `INSTANCE` 节点数 = 0** —— 用户只"声明"了组件，**还没在任何地方"使用"**。所以 `componentId` 这条路径**仍未验证**；
- **`styles` 仍是 0**（未定义样式，节点上也无 `styleId` 引用）；
- `/nodes` 响应里**每个节点条目自带 `components` map**（结构 `{document, components, componentSets, schemaVersion, styles}`），组件元数据随节点响应返回，不必单独请求；
- `layoutGrids` 的颜色**也是 0–1 浮点 RGBA**（如 `{"r":0.72,…, "a":0.5}`）——处理网格线颜色时**同样适用"只取 rgb、`a` 是 alpha"规则**。

> **对 P1 的结论**：`components` spec 可按上面实测字段集实现；但 **`INSTANCE` / `componentId` / 变体解析必须等文件里有真实实例才能验证**（在画板里"使用"一下这些组件即可）。`variables` 依旧是 403（缺 scope）。

**(3) `variables/local` 确认需要额外 scope（P1 的降级路径实测到位）。**

`GET /v1/files/:key/variables/local` → **`403`**，错误体：
```
{"status":403,"error":true,"message":"Invalid scope(s): file_content:read, file_comments:read,
 library_content:read, library_assets:read, file_dev_resources:read, file_metadata:rea…"}
```
注意措辞是 **`Invalid scope(s)`**（多个 s），且**列出的是该令牌实际持有的 scope**，然后（被截断处）才是缺失的那一个。P1 实现时必须能优雅降级成"你这个令牌缺 `file_variables:read`，且该端点可能还需要企业版套餐"，而不是抛一个裸 403。

**(4) 规模警示：单个画板约 9,800 tokens。**

这条对预算设计很关键：**一个 Dashboard 投影后就是 ~9,800 tokens**。20 个画板全读 ≈ **196,000 tokens**——必然爆上下文。所以：

- **默认只投影、不返回原始树**（原稿的 `format: 'summary'` 默认值是对的）；
- **默认 `depth` 需要按"节点数"动态收紧，而不能固定为 2 或 4**。建议：预算驱动——先按 `depth=2` 取，若节点数预估超阈值则只返回结构骨架（页面/画板层级 + 计数），细节留给 `ids` 定点取；
- **spool 溢出的设计在这个文件上是必需的，不是保险**。

**(5) 图片导出全链路验证通过。**

`GET /v1/images/:key?ids=3:4&format=png&scale=1` → `200`，返回预签名 URL；下载得到 **264,688 bytes 的 PNG，1440×1024**（PNG IHDR 解析确认）。所以 §4.5(d) 的"取 URL → 立刻下载落盘 → 内容寻址命名 → 回传本地路径 + 持久 image block"链路成立。

**(6) 这个文件是视觉稿，不是装配式设计系统（用户后续补了两个组件，见 (2b)）。**

初次实测：`components: 0`、`componentSets: 0`、投影后 **`component instances: 0`**、**没有 `styleId`**。它本质是**一套视觉稿/资源稿**（20 个仪表盘稿），而非装配了 Figma 组件的设计系统。用户随后把两个画板转成组件（`7:8` / `9:10`），于是 `components` 变成 2 项——但 **`INSTANCE` 仍为 0、`componentSets` 仍为 0、`styles` 仍为 0**。

> **结论：P1 的 `components` 清单可以验证；但「实例引用 / 组件集 / 变体 / 样式」四条路径仍缺素材。** 验证它们需要在画板里**使用**这些组件（产生 `INSTANCE`），并定义至少一个 Style 和一个 Component Set（变体）。本轮的价值在于把**主题化配色**验证扎实，并纠正了一个我自己犯的推断错误（见 (2) 的教训）。

### 1.5 动态 `depth` 策略（由 §1.4 的规模问题推出）

固定 `depth` 在两种文件上行不通：`Design File A` 的 `Box` 在 `depth=4` 时只有 18 个节点（5,879 chars，很轻），而 `Design File B` 的 Dashboard 在同样的 `depth=4` 下有 **154 个节点 / 35,425 chars（~9,840 tok）**。差 6 倍。所以：

```
figma_call({ op:'file_nodes', ids, depth?, budget? })
  1. depth 未给 → 用默认 2（仅 ⚠️ 绝不允许缺省成"全树"）
  2. 取回后先数节点数，不急着返回
  3. 若 projected_size > budget（默认 8k tokens）：
       a. 收紧到 depth=1 重取一次（便宜，Tier 1 已花掉的那次计入缓存）
       b. 仍超 → 只回结构骨架：页面/画板层级 + 每层节点计数 + 配色/字体摘要
       c. 完整投影结果 spool 到 .figma/<hash>.json，结果里给路径
  4. 结果 meta 里回报：节点数、投影字节数、实际使用的 depth、是否 spool
```

第 4 条让**模型自己看得见成本**，它下一轮就会主动用 `ids` 收窄——这比插件单方面截断体验好得多。

---

## 2. MCP 五层 → DSH 运行时：映射与归属

用户给的 MCP 拆解（能力底座 / 标准描述层 / 自动发现 / 调度协议 / 上下文管道）在 DSH 里有非常干净的对应关系。**先看清哪几层要自己写，方案就不会跑偏**：

| MCP 层 | 在 DSH 里的对应物 | 谁提供 | 本方案要写的部分 |
|---|---|---|---|
| ① 能力底座 | Figma REST API + Plugin API | Figma | **capability spec 声明表**（把 API 变成数据） |
| ② 标准描述层 | `ToolDefinition`（name/description/parameters/output） | `dsh-tools` | **Figma 语义层的描述**：每个能力的中文/英文 description、参数文档、何时该用 |
| ③ 自动发现 | registry → 工具表 → prompt 组装自动同步 | `dsh-tools` | 目录检索接口：`figma_capabilities(query)` 按需展开 |
| ④ 调度协议 | JSON-RPC 派发 / 超时 / 中间件管线 | `dsh-tools` | **Figma 侧的调度**：限流桶、合并、重试、缓存、能力白名单校验 |
| ⑤ 上下文管道 | 工具结果规范化 + image block + 压缩 | `dsh-tools` + `dsh-llm` | **压缩投影器**：节点树 → 模型友好结构；图片 → 路径 + 持久 image block |

也就是说：**②③④ 的骨架 DSH 已经给了**，我们只需要在 Figma 语义上把 ①②④⑤ 补齐。这正是"不写协议也能拿到 MCP 全部好处"的原因。

### 2.1 归属：host 面还是 preset 面？

按本仓库 plane 规则判断：

- **Figma token 是进程级凭据**（一个 token 服务所有 session），不是某个 agent 的私有物；
- **限流桶必须是进程级单例**——如果每个 session 各持一个桶，10 req/min 的额度会被并发 session 直接击穿；
- **HTTP 连接池、LRU 缓存、插件桥 WebSocket 服务端**都只能有一份。

> **结论：capability registry / 限流器 / 缓存 / 插件桥 = HOST 面（`cordis.patch.yml`）；工具行也可以放 host 面**（与 `tool-bash`、`tool-fs` 同级）。将来若要让不同 agent 用不同 Figma 账号，再拆成 isolate realm + preset，但**默认不要**——那会让同一个进程出现多个限流桶。

---

## 3. 交付形态：三个方案与取舍

| | A. 直接用 Figma 官方 MCP | B. 自建 MCP server（走 stdio/HTTP） | C. 自建 DSH 原生插件（本方案） |
|---|---|---|---|
| 接入方式 | `dsh-mcp-client` 加一行 config | `dsh-mcp-client` 指向自建 server | `cordis.patch.yml` 挂插件 |
| 覆盖度 | 官方固定工具集 | 自定义 | 自定义 |
| 鉴权 | OAuth 登录 / Dev Mode 本地 | PAT | PAT |
| 能否 headless / CI | ❌ 依赖登录或 Figma 桌面端 | ✅ | ✅ |
| 上下文开销 | 固定工具集，不可裁剪 | 多一层 `mcp__` 前缀 + schema 双份 | **最小** |
| 可调试性 | 黑盒 | 进程边界清晰，可单独调试 | 同进程，能直接读 `ctx`、打点、热重载 |
| 图片落地 | 由官方决定 | 需自己过协议 | 直接产出持久 image block |
| 可移植到别的宿主 | 天然 | 天然 | 需再写 MCP 适配器 |

**方案 A 的真实限制**（值得知道，但不足以否掉它作为"先跑起来"的选项）：官方远程 MCP（`https://mcp.figma.com/mcp`）是 Figma 托管的、需要 OAuth 登录；本地 Dev Mode MCP 需要 **Figma 桌面客户端开着、且当前文件已打开**，端口是 `127.0.0.1:3845` 且只有 Dev/Full 席位可用。对我们「用户只给了一个 PAT，要在 headless 环境里读任意文件」的场景，A 覆盖不了。

**采用 C，并保留 B 的语言**：内部核心写成协议无关的 `ToolProvider` 接口，配两个适配器：

```
                    ┌──────────────────────────────┐
                    │  @figma-mcp-dsh/core (纯逻辑)  │
                    │  capability registry          │
                    │  scheduler / cache / ratelimit│
                    │  context projector            │
                    │  ToolProvider 接口             │
                    └───────────┬──────────────────┘
                                │
              ┌─────────────────┴─────────────────┐
              ▼                                   ▼
   ┌──────────────────────┐            ┌──────────────────────┐
   │ adapters/dsh          │            │ adapters/mcp          │
   │ Cordis 插件，原生工具   │            │ 独立 MCP server(P2)   │
   │ ← 本方案主线           │            │ → 喂给别的宿主         │
   └──────────────────────┘            └──────────────────────┘
```

**顺带说明：为什么"原生"和"仍是 MCP"不矛盾。** MCP 的价值在五层结构，不在那根网线。DSH 原生插件保有了全部五层语义，还额外拿到：省掉 `mcp__` 前缀与重复 schema、进程内直接读凭据服务、能参与 DSH 的审批/审计管线。同时因为核心是协议无关的，P2 加上 MCP 适配器就两栖，一份能力定义两处卖。

---

## 4. 模块设计

### 4.1 目录结构

```
figma-mcp-dsh/                 # 仓库根 = 包根（GitHub 分发要求，§12.9.1）
├── package.json                  # name: "figma-mcp-dsh"；main → lib/index.js
├── src/
│   ├── core/                     # ⛔ 零 DSH 依赖、无 ctx（CI 门禁）
│   │   ├── capability.ts         # CapabilitySpec 类型 + 校验（含只读断言）
│   │   ├── specs/                # ★ 能力声明表（数据）
│   │   │   ├── files.ts images.ts comments.ts
│   │   │   └── components.ts variables.ts projects.ts
│   │   ├── auth.ts               # TokenSource 薄接口（§12.1）+ 脱敏
│   │   ├── http.ts retry.ts      # fetch 封装、429 退避、禁自动重定向
│   │   ├── scheduler.ts cache.ts # 令牌桶 + 单飞；LRU + 纯 TTL
│   │   ├── projection.ts         # ★ 节点树 → 模型友好结构（颜色归一）
│   │   ├── budget.ts             # 动态 depth（§1.5）+ spool 溢出
│   │   ├── url.ts                # Figma URL → {fileKey, nodeId}
│   │   └── provider.ts           # 协议无关的 ToolProvider
│   └── adapter/                  # DSH 接线（唯一允许 import DSH 之处）
│       ├── index.ts              # apply(ctx, config)
│       ├── config.ts             # Schemastery config
│       └── tools.ts              # figma_capabilities / figma_call
├── lib/                          # 构建产物，提交进仓库
├── test/                         # node --test；core 的测试不 import DSH
└── docs/ · README.md · LICENSE · .github/
```

> 不再有 `packages/`、`pnpm-workspace.yaml`、`adapter-mcp/`（B 不做，§12.3.1）。将来若拆包，`src/core/` 已是自足目录，移动即可。



**硬性分层纪律**：`core` 不得 import 任何 `@deepseek-ai/*`。这条纪律是可测试性与可移植性的全部来源——core 用 `node:test` + 本地 mock server 就能装满覆盖，不需要起 DSH。

### 4.2 核心数据结构：CapabilitySpec

这是整个方案的支点。**每一个 Figma 能力都是一条数据**：

```ts
export interface CapabilitySpec {
  /** 稳定标识，也是 figma_call 的 op 值 */
  name: string
  /** 给模型看的一句话：做什么、什么时候用 */
  description: string
  /** 归类，用于 figma_capabilities 的过滤 */
  group: 'file' | 'node' | 'image' | 'comment' | 'component' | 'variable' | 'project' | 'plugin'
  /** 需要的 Figma scope，用于启动时自检与错误提示 */
  scopes?: string[]
  /** 'rest' 直连 Figma；'plugin' 需伴生插件在线 */
  transport: 'rest' | 'plugin'
  /** 只读能力：当前仅有 'GET'。保留联合类型是为了让 run-time 断言
   *  (spec.method === 'GET') 有意义——见 §9.2 的只读约束 */
  method: 'GET' | 'POST' | 'DELETE'
  /** REST 路径模板，:key / :nodeId 由参数填充 */
  path: string
  /** 参数声明：JSON Schema 子集 + 是否必填 + 文档 */
  params: Record<string, ParamSpec>
  /** 固定注入的 query（如 depth / geometry） */
  query?: Record<string, string>
  /** 速率档位，决定用哪个令牌桶 */
  tier: 1 | 2 | 3
  /** 缓存策略 */
  cache?: { ttlMs: number; keyBy: string[]; swr?: boolean }
  /** 结果投影器名（见 §4.5） */
  project: ProjectorName
  /** 结果量级预判，用于提前拒绝或强制落盘 */
  weight: 'tiny' | 'small' | 'large' | 'huge'
  /** 破坏性操作，需要人工确认 */
  mutating?: boolean
}
```

再加一条 `files.ts` 里的真实例子（说明"能力即数据"到什么程度）：

```ts
export const fileNodes: CapabilitySpec = {
  name: 'file_nodes',
  description: '按 node id 精确获取一个或多个节点子树。比取整个文件便宜得多，是读取设计的首选入口。',
  group: 'node',
  scopes: ['file_content:read'],
  transport: 'rest',
  method: 'GET',
  path: '/v1/files/:fileKey/nodes',
  params: {
    fileKey:  { type: 'string', required: true, doc: 'Figma 文件 key，可由任意 figma.com 设计链接解析得到' },
    nodeIds:  { type: 'array', items: 'string', required: true, doc: '形如 "12:345" 的节点 id，逗号分隔' },
    depth:    { type: 'integer', min: 1, max: 8, default: 2, doc: '子树深度，越大越贵' },
    geometry: { type: 'string', enum: ['paths'], doc: '需要矢量路径时传入，会显著增大结果' },
  },
  tier: 1,
  cache: { ttlMs: 60_000, keyBy: ['fileKey', 'nodeIds', 'depth'] },
  project: 'nodeTree',
  weight: 'large',
}
```

**新增一个 Figma 能力 = 加一条数据 + 可能加一个投影器。** 这是这个架构最重要的性质：能力扩张不触碰调度、鉴权、上下文管道，也不会让模型看到的工具表变长。

### 4.3 对模型暴露的工具面（3 个，固定）

这是"上下文税"约束的直接产物。

```ts
// 1) 目录检索 —— 渐进式披露
figma_capabilities({
  query?: string,          // 关键词，如 "变体" / "export" / "comment"
  group?: string,          // 按组过滤
  detail?: 'names' | 'full'  // names 只回名字+一句话；full 回完整参数 schema
})
// → 200 token 级目录，命中时才展开 1~3 条完整 schema

// 2) 统一执行入口
figma_call({
  op: string,              // 能力名，如 "file_nodes"
  args?: Record<string, unknown>,
  target?: string,         // 便捷写法：直接粘 figma.com 链接，自动解析 fileKey/nodeId
  max_bytes?: number,      // 显式预算覆盖
  format?: 'summary' | 'full'  // 默认 summary（投影后），full 需显式要求
})

// 3) 画布桥状态与操作（P3，插件未装时可无副作用地返回未就绪）
figma_canvas({
  action: 'status' | 'selection' | 'screenshot' | 'run',
  code?: string            // action=run 时：在 Figma 沙箱里执行并回传 JSON 结果
})
```

为什么 `figma_call` 要支持 `target`：**模型拿到的是人给的链接，不是 fileKey。** 把 URL 解析放进插件而不是放进模型的工作记忆，能省掉一整类"我猜这个 key 是哪一段"的失败。URL 形态需要覆盖 `/file/`、`/design/`、`/board/`、`/proto/`、`/slides/`，以及带 `?node-id=12-345` 的情况（注意 URL 里是 `-`，API 里是 `:`，这个转换必须做）。

**关于 `figma_canvas` 的降级：不要手写探测，用 coeffect 声明式表达。**
插件桥不在线时它必须返回"未就绪 + 如何启用"的确定性结果，而不是报错——但**不要**在 `apply` 里手写轮询或 `if (bridge.isUp())`。正确做法是把桥写成一个**服务**，让 `figma_canvas` 作为一个 `inject: ['figmaBridge']` 的子插件存在：

```
桥服务未注册  → 子插件停在 PENDING，工具不在表里（零副作用、零成本）
桥服务注册后  → Cordis 自动把它拉起来，工具出现
桥断开/卸载   → 依赖失效，工具自动消失
```

这正是 Cordis 论文里的 **reactive coeffect**（见 §0.1）。好处不只是代码更短：**它把"画布离线"从一种运行期错误，变成了一个编译期式可推理的状态**，而且工具表在桥离线时不会被无用的 `figma_canvas` 定义占着上下文。`figma_capabilities` / `figma_call` 两个 REST 工具则无条件常驻。

### 4.4 鉴权与配置

**token 不进配置文件**，走 DSH 凭据服务：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    # ⚠️ 注意：name = 包名（loader 据此解析模块）；id = Cordis 行 id（可短）
    - id: figma
      name: 'figma-mcp-dsh'
      config:
        credentialRef: FIGMA_TOKEN       # 由 ctx.credentials 解析
        cacheTtlMs: 60000
        maxResultBytes: 262144           # 单次结果软上限 256 KiB
        spoolDir: .figma                 # 溢出落盘目录（相对 session workspace）
        # ── 限流：按「端点档位 × 席位」声明，而不是一个全局数字 ──
        # 已确认席位为 Full/Dev。默认取最低档 10/min（Starter 套餐的 Full 席位
        # 就是这个值），并由启动自检 + 响应头动态上调，见下文。
        rateLimits:
          tier1: { perMinute: 10, burst: 2 }   # file / file nodes / image
          tier2: { perMinute: 25, burst: 4 }   # 组件 / 变量 / 版本 / 项目 / 评论
          tier3: { perMinute: 50, burst: 8 }   # me / file metadata / 组件与样式
        enablePluginBridge: false        # P3 打开
        bridgePort: 8790
        # 注：没有 allowWrites 之类的写开关——本插件只读，见 §9.2
```

**限流参数为什么要写成"档位 × 席位"而不是一个数字。** Figma 的限流是三个因子的乘积：**席位类型**、**端点档位**、**资源所在套餐**。已确认席位是 Full/Dev，但套餐维度仍会咬人——官方原话是：用 PAT 请求一个 Starter 套餐里的文件，即使你在别的套餐有 Full 席位，该文件也是 **6 次/月**级别。所以：

1. 默认按**最保守的 10/min** 起步（Starter 套餐下 Full 席位的 Tier 1 值），先安全再提速；
2. 自检探针用 **`GET /v1/files/:key/meta`（Tier 3）**，不用 `GET /v1/me`——**已实测**：本 token 的 scope 集合（`file_content:read`、`file_comments:read`、`library_content:read`、`library_assets:read`、`file_dev_resources:read`、`file_metadata:read`）**不含** `/v1/me` 所需的 `file_read` / `files:read` / `current_user:read`，实测返回 `403 Invalid scope: [...]`；而 `meta` 返回 `404 Not found`（说明认证通过、只是文件不存在），是正确的探针；
3. **`429` 时**读 `X-Figma-Plan-Tier` / `X-Figma-Rate-Limit-Type`（`high`=Full/Dev，`low`=View/Collab）**与 `Retry-After`**，据此修正本地估算。
   ⚠️ **已实测：这四个头只在 429 上出现**（成功响应不返回；它们出现在 `access-control-expose-headers` 里只是 CORS 暴露声明）。**所以不要把"读响应头"当成每次请求都能拿到的能力**——正常运行期只能按本地预算跑，靠 429 事后校正。这是原稿的一个设计错误，已修正。

`burst` 给得很小（2）是刻意的：Tier 1 只有 10/min，一次突发失败会让后续调用排队更久，不如串行化。

读凭据的代码（注意 `resolve` 是 per-call 的，**不要缓存**）：

```ts
const ref = credentialRef(config.credentialRef)          // 'FIGMA_TOKEN'
const hit = await ctx.credentials.resolve(ref)
if (hit === undefined) {
  // 不抛硬错误：返回可操作指引，让模型/用户知道下一步做什么
  return { kind: 'unconfigured', remedy: `在 ~/.dsh/.credentials.yaml 的 refs 下加 ${config.credentialRef}` }
}
```

解析顺序天然覆盖环境变量 → 托管存储 → `.env`，所以**用户"只给一个 API token"这件事，三种投递方式都成立**，插件不需要关心他用哪种。

请求头：**PAT 与计划访问令牌用 `X-Figma-Token`**（官方两种令牌的用法页都明确写这个头；REST API 限流页的示例用 `Authorization: Bearer`，两者都有效）。实现为：默认发 `X-Figma-Token`，并允许 config 覆盖成 `Authorization: Bearer` 以兼容。

### 4.4.1 令牌生命周期：会过期，而且两种令牌差别很大

**令牌会过期，这是设计约束而不是运维意外。** 官方事实：

| | 个人访问令牌（PAT） | 计划访问令牌（Plan token） |
|---|---|---|
| 最长有效期 | **90 天**（官方对比表原文 "Max expiration of 90 days"） | **1 年**（365 天） |
| 归属 | 绑定个人账号 | 绑定组织/企业套餐，不绑定个人 |
| 能否刷新 | ❌ **不能刷新**，只能删掉重建 | ✅ 可刷新，**旧密钥还会继续有效 24 小时**（优雅切换窗口） |
| 创建门槛 | 个人 Figma 设置 → Security 里自助生成 | 组织管理员 + 强制 MFA，在 `figma.com/developers/tokens` 生成 |
| 只读适配度 | 可以（勾只读 scope） | **极佳**——官方明确说明计划令牌**不支持** `file_variables:write`、`file_code_connect:write`、`file_comments:write` 这些写 scope；但**也不支持 `/v1/me` 与 `/v1/oembed`** |
| 可用范围 | 该用户能访问的一切 | 限制在套餐内，还可用资源白名单进一步收窄 |

**如果你们是 Organization / Enterprise 套餐，计划访问令牌明显更优**：1 年有效期 + 可刷新 + 24 小时重叠期 + 天然不支持写 scope（与本插件只读定位完全吻合），且不必担心"某人离职后 token 失效"。唯一代价是它不支持 `GET /v1/me`——所以 §4.4 第 2 条的自检探针改用 `GET /v1/files/:key/meta`（Tier 3，很轻，且两种令牌都支持）。

**令牌过期时 API 返回什么（已实测，修正原稿）**：Figma 对**无效/过期令牌返回 `401`**，响应体为 `{"status":401,"err":"Invalid token"}`。而 `403` 是**令牌有效但缺 scope**，响应体含 `"Invalid scope: [<该令牌实际持有的全部 scope>]"`。详见 §5.4 的实测对照表与判别规则。**原稿写的"Figma 用 403 而非 401"是错的，已修正。**

**轮换的体验设计**（这是本条信息真正影响的部分）：

1. **不做"自动刷新"**。PAT 不可刷新，只能删除重建；计划令牌可刷新，但刷新动作在 Figma 管理界面，不是 agent 该碰的东西。也不要为了省事去存 OAuth 授权记录（本项目只读且用户只给 token）。
2. **不做"提前预警"**。Figma 不通过 API 暴露令牌的签发时间或剩余有效期（实测响应头里没有任何相关字段），所以"还有 7 天过期、提醒你续期"**做不到**，只能失效后反应式处理。
3. **不在我们这边存"过期日期"**。存了就会漂移，还会给用户一种"系统知道什么时候过期"的错觉。**让 401 自己说话**：捕获到 `Invalid token` 后，按 **§5.4.1 的通道 A** 把补救步骤交给模型，由模型去要求用户重新申请。
4. **轮换无需重启，这件事由 DSH 已经保证**：`ctx.credentials.resolve()` 是**每次操作重新解析**的（官方文档明确要求不得跨操作缓存），加上凭据文件 `watch: true`，所以用户改完文件后，**下一个请求就用新令牌**——刚好覆盖"90 天到了、换一个"这个场景。
5. **降级而不是崩**：令牌失效时，插件要给出确定性的可操作错误，且**其他插件不受影响**（§0.1 的 observational equivalence）。不要把令牌失效做成插件卸载或启动失败。

> **给用户的一句话建议**：如果你们有 Org/Enterprise 套餐，用**计划访问令牌**（1 年 + 可刷新 + 无写权限）；否则用**只读 PAT**，并接受每 90 天换一次——换的时候直接改 `~/.dsh/.credentials.yaml`，保存即生效。

### 4.5 上下文管道（本方案的真正难点）

#### (a) 投影：把节点树变成"设计工程师看得懂的东西"

Figma 节点对象有近百个字段，其中大部分对模型毫无价值。投影器按白名单保留：

```
保留：id / name / type / layoutMode / itemSpacing / padding / primaryAxisSizingMode
     / absoluteBoundingBox(x,y,w,h) / cornerRadius / fills(→ 归一成 hex + opacity)
     / strokes / effects / styleId / characters / style(文本样式)
     / componentId / componentProperties / children

丢弃：id 内部的临时字段 / 各类 *InternalOnly / 冗余的 constraints / relativeTransform
     / 完整 paint 对象里的冷字段 / boundingBox(相对坐标，除非显式需要)
```

- **文本节点特殊处理**：`characters` 保留，但超过阈值截断，并记录被截断的长度——设计师的文案经常很长，全量塞进去性价比极低。
- **颜色归一（⚠️ 实测修正过，务必按此实现）**：Figma 的 `color` 是 0–1 浮点 RGBA，但
  **`color.a` 是 alpha 通道，不是图层透明度**；图层透明度在**另一个字段** `fill.opacity`。
  所以：hex **只取 `r/g/b`**（忽略 `a`）；透明度**只读 `fill.opacity`** 且仅在 `≠1` 时输出。
  混用两者会静默取错颜色（§1.3 第 7 条有完整的踩坑记录）。
  文本样式只保留 `KEEP = {fontFamily, fontWeight, fontSize, textAlignHorizontal, lineHeightPx, letterSpacing}`，
  丢掉 `fontPostScriptName` / `textAutoResize` / `lineHeightPercent*` / `lineHeightUnit` 这类实现细节。
- **几何信息按需**：`absoluteBoundingBox` 是回答"这两个元素对不对齐"的关键，默认给（压缩成 `box:{x,y,w,h}` 并取整）；`geometry=paths` 只在明确要矢量路径时给。
- **深度控制默认开**：`depth` 默认 2，**且 `ids` 存在时会自动补上这个默认值**（§1.3 第 1 条：不传 `depth` 会返回完整后代树，`?ids=<根>` 等于拉回整个文件）。这是防"一次调用烧掉整个上下文"的第一道闸。

#### (b) 预算与溢出（budget + spool）
```ts
if (bytes(result) > maxResultBytes) {
  const path = await spool(result)                 // 写 .figma/<hash>.json
  return {
    summary: project(result, { budget: maxResultBytes }),   // 结构 + 统计 + 节点计数
    full: { path, bytes, hint: '需要细节时用 read/grep 读取该文件' },
  }
}
```

关键点：**溢出不是失败**。模型仍然拿到可用的结构摘要和一句诚实的"完整数据在哪个路径"，需要用细节时它有自己的文件工具。这样超长响应永远不会炸掉会话。

#### (c) 缓存与请求合并

三级：

1. **请求合并（单飞）**：同一个 `(fileKey, nodeIds, depth)` 在飞行中只发一次 HTTP，多个并发调用共享结果。这对限流是直接收益。
2. **LRU + TTL**：默认 60s。同一轮对话里模型反复查同一节点是常态，命中率会很高。
3. **`ETag` / `If-None-Match`——已实测否决，不要实现**：`/meta` 虽返回 etag，但条件请求返回 `200` 全量而非 `304`，且 `cache-control: no-cache, no-store`；`/files` 与 `/nodes` 根本没有 etag。**缓存只能靠 TTL**（默认 60s），失效判据用 `/meta` 的 `version`。

缓存 key 必须包含**影响响应内容的全部参数**（含 `depth`、`geometry`、`version`）。漏参就是给模型喂错数据，比不缓存更糟。

#### (d) 图片：产出可复用的持久引用

`GET /v1/images/:key?ids=...&format=png&scale=2` 返回的是**短期 S3 链接**（URL 会过期）。设计上：

1. 立刻下载到 `.figma/images/<nodeId>@<scale>x.png`（内容寻址命名，避免"路径还在但内容已变"）；
2. 工具结果里同时给出：相对路径、绝对路径、尺寸、字节数、`nodeId→path` 映射表；
3. **同时把图片作为持久 image block 挂到结果上**（`dsh-llm` 的 typed content 支持嵌套 image block，MCP 桥也是这么做的）。这样模型当轮就能"看见"设计，不需要额外一次 `read_image` 往返；而路径又保证了它想复看时不必重新导出（导出要花 Tier 1 额度）。

注意闸门：只有路由模型声明了 image 输入能力时图片才会真的送达，否则 DSH 会自动降级为文本占位符——这是产品既有行为，插件不需要自己判断，但**要在工具返回值里保留文本描述**，这样降级路径下模型仍能工作。

#### (e) 限流：令牌桶 + 精确退避

因为额度太低（10–20/min），调度必须是"预算制"而不是"尽力而为"：

- 按 `tier` 维护令牌桶（Tier 1 / 2 / 3 三档，各自独立）；
- 桶空时**排队而不是丢弃**，并在工具结果里诚实说明排了多久；
- `429` 一律读 `Retry-After` 退避，绝不自研固定间隔重试；
- `X-Figma-Rate-Limit-Type: low` 时直接返回升级提示（把 `X-Figma-Upgrade-Link` 透给用户）——这是 Figma 官方建议的 UX；
- 长任务（比如"导出全部图标"）走 `ctx.jobs` 后台化，避免占用工具调用超时。

---

## 5. 关键实现细节

### 5.1 工具注册与生命周期

`ctx.tools.register()` 本身就是 Effect，插件卸载自动反注册，**不需要手写清理**。但下面这些必须显式包 `ctx.effect()`：

```ts
export function apply(ctx: Context, config: Config) {
  const provider = createFigmaProvider({ /* ... */ })

  // 工具：自带 Effect，撤回自动
  ctx.tools.register(defineTool(capabilitiesTool))
  ctx.tools.register(defineTool(callTool))
  ctx.tools.register(defineTool(canvasTool))

  // 外部资源：必须自己管
  ctx.effect(() => stopBridgeServer(bridge))       // WebSocket 服务端
}
```

### 5.2 `figma_call` 的执行骨架

```
figma_call({ op, args, target })
  ├─ 1. op 必须在 registry 中（白名单，防模型幻觉出不存在的端点）
  ├─ 2. 只读断言：spec.method === 'GET'，否则拒绝（§9.2 硬约束一）
  ├─ 3. target 存在则解析 URL → fileKey/nodeId（与 args 冲突时 args 优先并提示）
  ├─ 4. 参数按 ParamSpec 校验：类型、必填、范围、枚举
  ├─ 5. 查缓存 → 命中即返回（附 cache: 'hit'）
  ├─ 6. 取令牌（桶空则排队）
  ├─ 7. fetch（带 AbortSignal，接工具超时）
  ├─ 8. 429/5xx → 按 Retry-After 退避重试（上限 N 次）
  ├─ 9. 4xx → 归一为结构化错误（见 5.4），不重试
  ├─ 10. project() 投影
  ├─ 11. budget 检查 → 超限则 spool + 摘要
  └─ 12. 返回 { structuredContent, content[] }，附 meta{bytes,cached,ms,rate}
```

### 5.3 Plugin API 桥（P3，可选但值钱）

REST 拿不到的、只有 Plugin API 能给的：**当前选区、视口、当前页面、`pluginData`、按 Figma 语义遍历**。（Plugin API 也能写节点，但本插件只读，见 §9.2——桥只暴露读取语义。）

架构（受 §1.2 约束四约束）：

```
Figma 插件 (用户手动在 Figma 里运行一次)
├── main (QuickJS 沙箱, 无网络)  ──postMessage──▶  ui iframe (有网络)
└── ui iframe ──WebSocket(ws://127.0.0.1:8790)──▶  DSH host 进程内的 bridge server
                                                          │
                                        figma_canvas 工具 ←──┘
```

- 走 **`ws://127.0.0.1:8790`**（不是 `wss`）→ 必须在 `manifest.json` 的 `networkAccess.allowedDomains` 里声明，且因涉及本地服务器需要写 `reasoning`；
- `manifest.json` 还要设 `documentAccess: 'dynamic-page'`（Figma 对新插件已强制），否则每次运行都会触发整文件加载，在大文件上体验很糟；
- 协议用最朴素的 JSON 请求/响应 + `id` 关联，别引入 RPC 框架；
- **必须实现请求超时**：Figma 关了、插件被卸载，都要在秒级给出确定性错误，而不是让工具调用挂到超时；
- `action: 'run'`（在 Figma 沙箱里执行代码并回传 JSON）是这套桥的杀手锏——**用一次插件往返，换来"任意只读查询"能力**，比在 registry 里穷举几十个 plugin 能力划算得多。**沙箱侧只提供 `figma.*` 的读取 API，不注入任何写方法**（§9.2）。

### 5.4 错误归一

模型对错误信息的质量极其敏感。统一形状：

```ts
type FigmaError =
  | { kind: 'unconfigured'; remedy: string }              // 凭据未配置
  | { kind: 'token_invalid'; remedy: string }             // 401 "Invalid token"：令牌过期/被撤销/写错
  | { kind: 'forbidden_scope'; granted: string[]; missing: string[]; remedy: string }
  | { kind: 'not_found'; remedy: string }                 // 404：key 或 nodeId 错
  | { kind: 'rate_limited'; retryAfterSec: number; upgradeUrl?: string; tier?: string }
  | { kind: 'too_large'; bytes: number; spoolPath: string; suggestion: string }
  | { kind: 'bad_args'; field: string; reason: string }   // 参数校验失败
  | { kind: 'bridge_offline'; remedy: string }            // 插件桥不可用
  | { kind: 'upstream'; status: number; body: string }    // 其他
```

**⚠️ 这里原稿写错了，已按实测修正。** 我原先写"Figma 对过期令牌返回 403 而非 401"——**实测证明 401 才是令牌本身的问题**：

| 实测输入 | 状态 | 响应体 | 含义 |
|---|---|---|---|
| 故意用无效 token 请求 `/v1/files/:key/meta` | **401** | `{"status":401,"err":"Invalid token"}` | **令牌无效/过期** |
| 有效 token 请求 `/v1/me`（scope 不含所需） | **403** | `{"error":true,"status":403,"message":"Invalid scope: [...]"}` | **令牌有效，缺 scope** |

所以判别规则是：

- **`401` + `err: "Invalid token"` → `token_invalid`**（过期 / 被撤销 / 抄错）。remedy 指向"去 Figma → Settings → Security 重新生成，只读 scope，写回 `~/.dsh/.credentials.yaml`，保存即生效"。
- **`403` + `message` 含 `Invalid scope` → `forbidden_scope`**。实测两种措辞都出现过：`Invalid scope: [...]`（`/v1/me`）与 **`Invalid scope(s): [...]`**（`/variables/local`）——所以匹配要用 `Invalid scope` 前缀匹配，别写死单复数。Figma **会把该令牌当前持有的全部 scope 列在错误体里**，可以直接解析出 `granted[]`，据此告诉用户"你只有这几个 scope"。（实测例：`GET /v1/files/:key/variables/local` → `403`，`message` 为 `"Invalid scope(s): file_content:read, file_comments:read, …"`。）
- 官方文档把 403 描述为 *"token is invalid or expired"*，但**实测中令牌问题走 401**；为稳妥，**两种状态码都按认证失败处理**，再按响应体文案分流。

**两种都不自动重试**——重试不会让权限变多、也不会让令牌复活。

每条 `remedy` 都要是**可执行的下一步**（"给这个 PAT 加上 `file_variables:read` scope"），而不是复述错误。

### 5.4.1 令牌失效时如何"提示用户"（三种通道，按推荐度）

你问的"插件能不能提示用户重新申请令牌"——**能，而且检测和提示都可靠；但没有任何办法替用户自动完成申请**。

先划清能力边界，这决定了体验上限：

- ✅ **能检测**：`401` 明确、无歧义（上表实测）。
- ✅ **能提示**：三条通道见下。
- ❌ **不能自动续期**：PAT **不可刷新**（官方原文：无刷新机制，只能删除重建）；且 Figma 生成 token 时**明文只显示一次**，不存在任何 API 能让插件把新 token 取回来。**必须由人粘贴回来。**
- ❌ **不能提前预警**：Figma 不通过 API 暴露令牌的签发时间或剩余有效期（我实测过响应头，没有任何相关字段）。所以**做不了"还有 7 天过期，提醒你续期"**，只能失效后反应式处理。

**通道 A（推荐）：把错误变成"活跃的补救指令"，而不是失败的调用。**

`dsh-tools` 的语义是：抛出的调用会变成 `Error: <message>`，且**不会结束回合**（README 原文 "return finalized results without ending a turn on ordinary tool failures"）。所以：

- **不要 `throw`**。抛错会让模型只看到一句 `Error: ...`，它倾向于"我再试一次"或直接放弃；
- **返回一个成功的、带结构化字段的结果**，让模型读到明确的下一步：

```
令牌已失效（Figma 返回 401 Invalid token）。
原因：个人访问令牌最长 90 天且不可刷新，现在已过期或被撤销。
请用户执行：
  1. 打开 https://www.figma.com/settings → Security → Personal access tokens → Generate new token
  2. 勾选只读 scope：file_content:read, file_metadata:read, file_comments:read, file_dev_resources:read
  3. 把新令牌写入 ~/.dsh/.credentials.yaml 的 refs.FIGMA_TOKEN（保存即生效，无需重启）
  4. 写完后告诉我，我重试刚才的操作
```

关键在于最后一句：**模型被明确授权"重新申请 + 重试"这件事**，于是它会主动去找用户、说明原因、并在用户放好新令牌后自己重试——这才是"要求用户重新申请一次令牌"的完整闭环。

### 5.4.2 额度真实耗尽时长什么样（P1 验收被它咬了一口，实测记录）

这一条不是设计，是**踩过一次之后补的记录**，因为症状和"代码有 bug"几乎一样。

**事实**：Tier 1（`/files`、`/nodes`、`/image`）在个人/Starter 席位是**每月 20 次**，Professional 是每分钟 10–20 次。20 次/月意味着**验证一套真实数据测试就能把它花掉**。

**症状**：两个断言失败，耗时 **20,006 ms** 和 **20,003 ms**，报错都是 `false !== true`。

**为什么只有 20 秒这条线索**：`provider` 按通道 A 把失败编码为**成功返回 + 结构化 error**，所以 `assert.equal(result.ok, true)` 得到的是裸的 `false !== true`，而 `rate_limited` 的 `kind`、`Retry-After`、席位提示、升级链接**全部被丢掉**。`retry.js` 用 `delayMs = verdict.retryAfterMs ?? backoffDelay(...)`，Figma 的 `Retry-After` 覆盖本地退避——**20 秒就是它的指纹**。

**根因（两层，第二层才是真的）**：

1. 客户端限流器默认 `tier1: {perMinute: 5, burst: 1}`，是为最弱席位设计的，但 Figma 的**每月 20 次**是服务端窗口——**"20 次/月"这个约束在客户端无法防守**，只有 429 是权威信号；
2. 更关键的一层：那套真实数据测试**每次检查都新建一个 provider**。桶、缓存、single-flight 都是实例级状态，于是**测试边界把限流器重置了**，它永远看不到套件的真实请求数。第一次运行 4 次请求，把本地限流器根本看不见的额度耗尽；第二次运行就撞上 429。

> 这正是 §11 纪律第 6 条的反面教材：**"共享可变状态（限流桶、缓存）必须挂在 host 面 context，不能放进 per-session 域"**。真实数据套件无意中把"一个 session 一个桶"重演成了"N 个测试 N 个桶"，结果就是额度被乘以测试数。第 6 条原本是为了防止**第二个 session 把额度翻倍**；同一条推理，换成"第二个测试"一模一样成立。

**修法**：两个真实数据套件各自复用一个 provider（P0 侧按配置 memoize，因为它有一个检查需要更大的 token 预算）。这样本地桶能看到套件的真实请求数，429 回到它该在的位置——**意外事件的纠正，而不是主要预算机制**。

**并修掉诊断路径**：真实数据套件共用的 `read` 助手改为在 `ok === false` 时**抛出带 `kind` / `status` / `retryAfterSec` / `remedy` 的断言失败**。理由是流程性的：**一个把原因丢掉的失败，等于一个查不出原因的失败**。该助手放在 `test/fixtures/structured-read.js`——**不能**从 `*.test.js` 里导出，因为 import 一个 `*.test.js` 会执行它，等于把真实数据套件再跑一遍、再花一次额度。这条带了回归测试（`test/core/structured-read.test.js`，stub provider，不花额度）。

**顺带核实、并纠正一个我自己的错误推断**：共享 provider **并不**把 `components` / `component_sets` / `styles` 的三次读取并成一次请求。缓存 key 是 `[spec.name, ...keyBy]`（**首元素是能力名**），所以三个能力各自持有独立条目，**三次操作 = 三次请求**。用一个 stub provider 计数实测得到 `3 !== 1`，于是把"三次请求"这个事实**钉成断言**，防止以后有人把它误当成不存在的节省。

**代价要说清楚——实测，不是估算**：P1 套件跑完一轮要 **9 次 Tier 1 + 1 次 Tier 2**：

| 来源 | 次数 | 端点 |
|---|---|---|
| `components` / `component_sets` / `styles` 各 1 | 3 | `/v1/files/:key?depth=2`（Tier 1） |
| `file_nodes` ×3（styled node + 2 个 instance，节点不同则缓存不命中） | 3 | `/v1/files/:key/nodes`（Tier 1） |
| 断言 7 的 3 次资源读取 | 3 | `/v1/files/:key?depth=2`（Tier 1） |
| 断言 5 的图片读取 | 1 | `/v1/images/:key`（Tier 2） |

**9 次对"20 次/月"是一个必须提前说出口的数字**：验证一轮 P1 就花掉近一半月度额度。这直接推出两条操作纪律——**先探针后跑套件**（`scripts/probe-quota.mjs`，1 次请求），以及**不要为了"再确认一次"重复跑全套**。共享 provider 修好的是**限流器的有效性**与**诊断能力**，不是请求数。

我先前两次把这件事说错过：先声称共享 provider 能让三次资源读取合并成一次（错，缓存 key 以能力名开头，实测 `3 !== 1`），随后又低估成一个笼统的"4 次"。**数字不实测就不要写进文档**——这正是 §11 纪律第 10 条的同类错误。

**通道 B（可选，P3）：用 `ctx.userQuestions.ask()` 直接弹 UI。**

DSH 确实有这个能力：`ctx.userQuestions.ask({ questions: [...] })` 会走 scoped answerer 瀑布并等待人类回答（`AskUserQuestionItem` 支持 `options`，所以可以把 Figma 设置界面的链接做成一个可点选项）。这比让模型转述体验更好。

但用之前必须知道三个约束（都来自其文档）：

1. **不可用时是硬失败，不是降级**：`ask_user_question`（同一个 seam）"Without one, the tool call fails with an error instead of degrading"——没有交互式 answerer 时它是报错，不是返回 undefined。所以必须 `ctx.get('userQuestions')` + 存在性检查，并包 try/catch；
2. **只有"确切的活跃运行时根"才能问人**：文档明确 `owned child has no human answerer and would block forever`。即**子 agent / 后台任务里问不到人，会永久阻塞**——这正是必须 try/catch 且不能无条件开启的原因；
3. 拿到的只是一个选择结果，**新令牌仍然要人去 Figma 生成**，这一步省不掉。

**决策：P0 只做通道 A，通道 B 列为 P3 可选项。** 理由：A 零风险、覆盖全部场景（含子 agent 与后台任务）、且闭环完整；B 的收益是"弹窗更漂亮"，代价是阻塞与失败模式，不值得在 P0 引入。

**通道 C（不推荐）：直接返回 `isError: true`。** 可行，但模型倾向于把工具错误当成"暂时性故障"而重试，对"令牌过期"这种不可自愈的状态是错误引导。**不要用。**

**一个附带的设计要求**：`token_invalid` 要**在进程内记忆**（记住"这个凭据值已失效"直到凭据发生变化），使得同一次会话里的后续调用**立刻失败并复用同一份指引**，而不是每次都去撞一次 401。判据用凭据值的哈希，不用时间——这样用户放好新令牌后自动恢复。

### 5.4.3 P1 验收的实测记录（2026-09，全部 7 条）

记在这里而不是只留在对话里，因为**验收证据必须可回溯**：将来"这个行为当初验过没有"这个问题，只能靠文档回答。

| # | 断言 | 结果 | 实测证据 |
|---|---|---|---|
| 1 | `components` 从 `/files` 的 map 取值，非专用端点 | ✅ | `total=2`，各带 40 位 library key |
| 2 | 变体从名字解析出来 | ✅ | `base` + 解析出的 `k=v` 能**无损重建原名**；两成员共享同一 `base`、`variants` 不同 |
| 3 | `styles` 从 map 取值，判别字段是 `styleType` | ✅ | `styleType=FILL`、40 位 key、`total=1` |
| 4 | 空 `component_sets` 是正常结果而非失败 | ✅ | `component_sets -> 0 set(s), ok=true` |
| 5 | 节点 `styles.fill` 解析成可读名字 | ✅ | `{"fill":{"id":…,"name":…,"styleType":…}}` 三段齐全 |
| 6 | 实例保留 `componentId` | ✅ | 双向断言通过（`INSTANCE_A` 实为 `COMPONENT_B` 的实例） |
| 7 | 资源读取远小于全量 | ✅ | `3 resource reads, 6338 B each, GET /v1/files/:key?depth=2`（全量 1,564,042 B） |

**断言 7 的验证方式要说清楚**：它在**整轮运行**里失败过一次，原因是**我的断言写错了**（我断言了"后两次读取命中缓存"，而那个前提已被我自己用 `3 !== 1` 证伪）。改正断言后**单独重跑通过**（`--test-name-pattern`，3 次 Tier 1 请求）。其余 6 条来自整轮运行。**这不是"重跑一次就变绿"，而是断言从'假设缓存命中'改成'实测每次读取都在线上发生且大小受限'后通过**——两者含义不同，记清楚以免后人误读。

**P1 因此可以归档。** 剩余未做的两件事不属于 P1 验收缺口，已移入待办：`applyBudget` 对非数字 depth 的防御性抛错（§5 待办）、以及缓存 key 的分组（见 §5.4.2 末尾的成本表）。


### 5.5 安全

- token 只出现在请求头，**永不进入日志、错误体、工具结果**；插件侧做一次集中脱敏；
- `302`/`301` 重定向**不自动跟随**——避免 token 被带到非 Figma 域（这是最容易被忽略的凭据泄漏路径）；
- 能力白名单：只允许 registry 里声明的端点，模型无法构造任意 URL；
- `spool` 写盘路径固定在 session workspace 下，禁止路径穿越；
- **只读**：registry 里不存在任何写能力，运行期断言 `method === 'GET'`（§9.2）；
- 若需要 OAuth 而非 PAT，凭据服务的 `CredentialKey`/`modifyRecord` 已经支持「授权记录 + 串行化刷新」，不用自建 token 存储。

### 5.6 可观测

- 每次调用 `ctx.emit('figma/call', {...})`（只发叶子字段，**不要序列化 live 对象**）；
- 结果 meta 里回传 `bytes / cached / ms / ratelimitRemaining`，模型自己会据此调整策略（"刚才那次很贵，我换个方式"）；
- 自检：解析凭据 → 用 `GET /v1/files/:key/meta`（Tier 3）探一次 → 校验返回。失败只在日志告警，**不阻断加载**（避免一个坏 token 让整个 harness 起不来）。
  **已实测**：`GET /v1/me` 对本 token 返回 403（scope 不含 `current_user:read`），所以自检**必须**用 `meta` 而不是 `/v1/me`；且 `meta` 需要 `file_metadata:read`，该 token 已具备（列在 403 响应体的 granted 列表里）。

---

## 6. 分期与验收

### P0 — 打通链路（可独立验收，最有价值的一期）

- `core`：capability 类型 + `files/nodes/images` 三个 spec + URL 解析 + http/retry/scheduler/cache/projection/budget
- `adapter-dsh`：3 个工具 + 凭据接入 + config schema
- 接线到 `~/.dsh/profiles/web/`，热重载生效

**验收（端到端，不靠单元测试自我感动）**：
1. **【基准已建立，两只文件】**
   - `Design File A`（`Aa1Bb2Cc3Dd4Ee5Ff6Gg7H`，节点 `11:12` = `首页示例/Box`，`depth=4`）：投影 ≤ 6,000 chars（实测 5,879），配色报出 `#111827 / #9CA3AF / #C4CCC8 / #F5F5F7 / #FFFFFF`，字体 `Inter 400 10.5/12.5px`、`600 13px`、`700 18px`；
   - `Design File B`（`Zz9Yy8Xx7Ww6Vv5Uu4Tt3S`，节点 `3:4`/`5:6`，`depth=4`，各 154 节点）：投影 ~35,400 chars（−71%），且 **LIGHT/DARK 两版配色必须给出不同的集合**，品牌绿 `#29CB97` 在两版中都出现（§1.4(1) 有完整期望值，可直接作为断言）；

2. **投影回归测试（必测）**：构造一个**半透明** fill（如 `{r:0.5,g:0.5,b:0.5,a:0.3}`），断言 hex 为 `#808080` 且 `opacity` 来自 `fill.opacity`——**防止 §1.3 第 7 条那个静默取错颜色的 bug 回归**；
3. **`depth` 守卫测试**：传 `ids` 而不传 `depth` 时，断言插件自动补 `depth=2`，且响应体 < 10 KB（不得出现 48 KB / 1.19 MB 那种量级）；
4. 给一个真实 Figma 设计链接，模型能说出：文件里有哪些页面、顶层 Frame 的结构、主色调 hex、主要字体与字号；
5. 追问"某个 Frame 里的按钮长什么样"，模型用 `file_nodes` 定点取，**不重取整个文件**；
6. 导出该 Frame 的 PNG，模型当轮直接看到图；
7. 故意连续调用 12 次 Tier 1 能力，观察排队与 429 退避是否按预期工作；
8. **令牌失效闭环（§5.4.1 通道 A）**：把 `refs.FIGMA_TOKEN` 临时改成一个无效值，然后发起一次调用，**必须观察到**：
   - 工具**没有**抛错，而是返回结构化的 `token_invalid` + 可执行补救步骤；
   - 模型据此**主动向用户说明原因并要求重新申请令牌**（而不是无意义重试）；
   - 用户写回新令牌后（**不重启**），模型重试同一个操作并成功；
   - 期间 `Tool.listTools` 不变、其他插件不受影响。

### P1 — 设计系统语义

- 补 `components` / `variables` / `styles` / `versions` spec（企业版能力要优雅降级）
- `figma://` 作为 session reference 时自动注入文件摘要
- 把能力清单生成到 `docs/CAPABILITIES.md`（从 spec 表自动导出，永不与代码脱节）

**验收（分两级，因为素材限制）**：
- **现在可验收**：对 `Zz9Yy8Xx7Ww6Vv5Uu4Tt3S` 报出组件清单——`7:8` `Dark - Dashboard - 10`、`9:10` `Light - Dashboard - 10`，含各自 `key`；并断言**没有** `componentSetId` / 变体属性的字段假设（§1.4(2b) 的实测字段全集）；
- **需要补素材才能验收**：组件实例引用（`INSTANCE.componentId`）、组件集与变体、样式引用（`styleId`）。素材条件：在画板里**使用**已声明的组件、建一个 Component Set（变体）、定义一个 Style。`variables` 另需 `file_variables:read` scope（当前 403）。

### P2 — ~~MCP 适配器~~（当前不做，见 §12.3.1）

**当前不做**（用户 2026-09 决定）。下面保留的是"如果将来要做，需要注意什么"，不是待办：

- `adapter-mcp`：约 60–100 行，用 `@modelcontextprotocol/sdk`（本机已有 1.30.0），stdio 优先
- 前提是 §12.3.1 的三条不变量没被破坏（`core` 无 DSH import、无 `ctx`、接口宿主中立）
- 补做时的验收：`dsh-mcp-client` 配置一行指向它，桥接出的 `mcp__figma__*` 与本机工具行为等价

> 下面那段协议版本分析**依然值得读**——它解释了为什么无论何时补 B，都**不要硬编码协议版本**。

> ### ⚠️ P2 的 MCP 协议版本问题（已实测，并修正了原对策）
>
> **MCP 已经有两代协议，而本机部署的 SDK 只支持旧的那一代。**
>
> 实测本机 `@modelcontextprotocol/sdk@1.30.0`（`dsh-mcp-client` 的依赖）：
> ```
> LATEST_PROTOCOL_VERSION   = '2025-11-25'
> SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']
> ```
> 而 MCP 已有 **2026-07-28** 修订版，是一次**破坏性**变更（官方 changelog 原文）：
>
> | 2026-07-28 的变化 | 影响 |
> |---|---|
> | **移除 `initialize` / `notifications/initialized` 握手**，版本与客户端能力改由每请求 `_meta` 携带（`io.modelcontextprotocol/protocolVersion`/`clientCapabilities`） | 原稿 P2 写的"实现 initialize"在新协议下**根本不存在** |
> | 移除协议级 session 与 `Mcp-Session-Id` 头 | 服务端不再需要会话状态 |
> | 新增 `server/discover`（**MUST** 实现） | 新协议下的必需入口方法 |
> | 列表结果**必须**带 `ttlMs`/`cacheScope`；工具顺序**应当**确定 | 与 §4.5 的缓存思路同向，但字段强制 |
> | 移除 `ping`、`logging/setLevel`；任务改为扩展 `io.modelcontextprotocol/tasks` | — |
>
> **✅ 修正后的对策：不要硬编码协议版本，交给 SDK 协商。**
>
> 原稿写"P2 只实现 `2025-11-25`"——**这是错的，且是多余的**。实测 SDK 源码 `dist/esm/server/index.js:263`：
> ```js
> const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
>   ? requestedVersion : LATEST_PROTOCOL_VERSION;
> ```
> **SDK 已经内建版本协商**：客户端要哪个版本，SDK 就从它自己的支持列表里挑；挑不到就回落。所以：
>
> 1. **代码里永远不出现协议版本常量。** 用 `McpServer` + `StdioServerTransport`，让 SDK 决定。SDK 升级即自动获得 `2026-07-28` 支持（因为 `LATEST_PROTOCOL_VERSION` 是 SDK 自己的常量），**我们一行不用改**。这比"自己写一个版本分支"健壮得多。
> 2. **未来那次真正的迁移也已经在 SDK 里完成了**：`2026-07-28` 那一列的破坏性变更（去掉握手、会话、ping）**全部落在 SDK 内部**——这正是"不要手写协议"的价值。如果当初手写 `initialize`，这次迁移就是重写。
> 3. **上面第 1 条 ≠ 什么都不做**。有三件事与版本无关、且现在就该做，因为它们是**两个版本都受益**的语义（属 §5.1 的"能力"而非"协议"层）：
>    - `tools/list` 结果按**确定性顺序**返回（利于 LLM prompt cache 命中）；
>    - 在结果里带上 `ttlMs`：老协议会忽略未知字段，新协议下就是合规的 `CacheableResult`——**这是一次实现、两代兼容的写法**；
>    - 提供一个 `figma_doctor` 诊断能力（见 §12）：用户报问题时，"你的客户端走的是哪个协议版本"是第一个要问的问题。
> 4. **只有在 SDK 装死不跟进时**，才考虑手工实现 stateless 变体（估 0.5 天），且**只改 `adapter-mcp` 一个文件**——`core` 对 MCP 有几个版本完全无知（§0.1 组件自足性）。
> 5. **顺带的好处**：`2026-07-28` 的 `ttlMs`/`cacheScope` 与"服务器应返回确定性顺序的工具列表以提升 prompt cache 命中"这两条，和 §1.2/§4.5 的结论**完全同向**——说明"少而稳定的工具表 + 明确缓存语义"是行业共识，不是我们的偏好。
>
> ### 定位：MCP 适配器是**可选入口**，不是主渠道（已订正）
>
> 我上一版曾建议"MCP 是主分发渠道、P2 提为 P1.5、发三个包"——**那是基于错误的范围假设**（默认了"开源 = 面向所有 agent 宿主"）。
>
> 实际范围是**面向其他 DSH 用户**（用户 2026-09 澄清），而 DSH 用户能直接挂 Cordis 插件，MCP 不构成额外触达。所以：
>
> - **主线维持 DSH 原生插件**（工具名干净、直接读 `ctx.credentials`、上下文开销最小、支持热重载）；
> - **MCP 适配器降为可选 P2**，价值是"给想用 `dsh-mcp-client` 入口的 DSH 用户"以及"让你能脱离 DSH 单独调试与做基准"。
>
> 完整对比见 §12.3。

### P3 — 画布桥 + 可视化

- 伴生 Figma 插件（manifest / main / ui）+ bridge server
- `figma_canvas` 工具 + Client 侧 Slot 面板（桥状态、选区、截图预览）

**验收**：在 Figma 里选中一个图层，问"这个图层的问题在哪"，模型无需人给链接即可读到该图层；面板能实时显示连接状态。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Tier 1 额度只有 10–20/min | 连续操作直接不可用 | 令牌桶 + 单飞 + 缓存；默认 `depth` 限制；大任务后台化 |
| View/Collab 席位 20 次/月 | 几乎不可用 | 启动自检 `X-Figma-Rate-Limit-Type`，UI/错误明确提示升级 |
| 全量文件 JSON 撑爆上下文 | 会话报废 | **已实测风险真实**：不传 `depth` 时 `?ids=13:14` 返 48,659 B、`?ids=1:2`（根）返 1,193,266 B ≈ 整个文件。对策：`ids` 强制成对补 `depth` 默认值 + 超限 spool + 摘要，永不失败 |
| **静默取错颜色**（`color.a` 被当成透明度） | 模型读到错误配色，且不报错 | §1.3 第 7 条：hex 只取 rgb、opacity 只读 `fill.opacity`；半透明样本进回归测试 |
| 长会话里文档树反复被拉取 | 额度耗尽 | 默认 `depth` 限制 + LRU/TTL 60s + 同参单飞；**注意 `ETag`/304 不可用（已实测），缓存只能靠 TTL** |
| **单画板就 ~9,800 tokens**（实测） | 20 个画板全读 ≈ 196k tokens，必然爆上下文 | §1.5 动态 depth + 预算驱动收紧 + 骨架降级 + 强制 spool；结果 meta 回报成本让模型自我收窄 |
| ~~`depth` 抑制文件级组件表~~ **（推断已被推翻，见 §1.4(2)）** | — | 原对策作废：`depth≥2` 组件表正常填充；`depth=1` 只是"没有内容可报告"。真正的教训是**别从零值推因果** |
| 模型幻觉出不存在的 op | 无意义失败 | registry 白名单校验，错误里回带可用 op 列表 |
| 节点 id 的 `-`/`:` 混淆 | 高频低级失败 | 由 `target` URL 解析统一承担，并在错误里给出正确写法 |
| 企业版 API（变量）权限 | 421/403 难懂 | 单独 spec + 明确 remedy 文案，不与其他错误混同 |
| 插件桥依赖用户手动运行插件 | 体验断点 | 桥用 coeffect 声明，离线时工具根本不出现在表里（见 §4.3）；文档给出一次性接入步骤 |
| 图片 URL 短期有效 | 复看时 403 | 官方说明图片资源 **30 天后过期**（image fills 的 URL ≤14 天）；故立刻下载落盘 + 内容寻址命名，工具结果只给本地路径 |
| **令牌过期**（PAT 最长 90 天，且不可刷新） | 某天起全部调用 401 | 不存过期日期、不做提前预警（Figma 不暴露有效期）；捕获 401 报 `token_invalid` 并把补救步骤交给模型去要求用户重录；`resolve` per-call + 凭据文件 watch 保证**改完即生效免重启**（§4.4.1、§5.4.1） |
| 重定向泄漏 token | 凭据泄漏 | 禁用自动重定向 |
| Figma 改版限流策略 | 硬编码失效 | 限额做成 config（`tier` 档位），并读响应头自适应 |
| **MCP 协议版本分裂**（见 §6 P2） | P2 适配器可能白写 | 只实现部署现有 SDK 支持的 `2025-11-25`；stateless 版留到 SDK 升级后，且只改动适配器一个文件 |
| **误加写能力**（只读约束被破坏） | 模型可能改坏真实设计资产 | registry 里没有写 spec + 运行期 `method === 'GET'` 断言 + CI 门禁（§11 第 9 条） |

---

## 8. 工作量估算

| 阶段 | 内容 | 估时 | 状态 |
|---|---|---|---|
| P0 | core 骨架 + 3 spec + 3 工具 + DSH 接线 + 测试（**只读**） | 2–3 天 | 待开工 |
| P1 | 设计系统 spec + 能力文档生成 | 1–2 天 | — |
| P1.5 | 开源就绪项：`figma_doctor` + 更弱席位的安全默认值 + README/issue 模板 + CI 门禁 + **脱敏** + GitHub 装配路径打通（§12.2/12.4/12.9.1/12.10） | 1.5–2 天 | 开源必需 |
| P2 | ~~MCP 适配器~~ | — | **不做**（§12.3.1），门留着 |
| P3 | Figma 伴生插件 + 桥 + Client 面板 | 3–4 天 | — |
| P4 | ~~写操作~~ | — | **不做**（§9.2） |

P0 结束就已经是一个**你自己能天天用的东西**；**P1.5 结束才是一个别人能挂上的东西**（开源受众 = 其他 DSH 用户，所以开源就绪项就是这一期）。
P3 是锦上添花。P4 已确认不做，故不在估算内——将来若要做，按 §9.2 末尾的方式作为独立一期重新设计（估 +1.5 天）。

---

## 9. 已确认的两个决策

### 9.1 Figma 席位：Full/Dev ✅ 已确认

带来两个直接后果，已落到配置里（见 §4.4）：

- Tier 1（file / nodes / images）额度 **10–20/min**，Tier 2 为 25–100/min，Tier 3 为 50–150/min —— 方案可用，**但必须按"预算制"调度**：令牌桶（默认保守取 10/min）+ 请求合并 + 缓存，`burst` 给小。
- 仍然存在的坑：**限流是「席位 × 端点档位 × 资源所在套餐」三者乘积**。PAT 指向 Starter 套餐里的文件时，即使是 Full 席位也只有 6 次/月级别。所以桶上限不能写死，要读 `X-Figma-Rate-Limit-Type` 动态调整（§4.4）。

### 9.1.1 交付形态：**A only**（B 当前不做，但门留着）✅ 已确认

- **A = DSH 原生 Cordis 插件** —— **P0 交付，也是当前唯一的交付形态**。工具名干净、直接读 `ctx.credentials`、上下文开销最小、支持 `patchReload: live`。
- **B = MCP 适配器** —— **当前不做，且不保留在路线图里。** 但「以后可以补回来」是被 CI 守住的架构不变量，不是口头承诺，见 §12.3.1。

**成立前提（§4.1 的分层纪律）**：`core` 不含任何 DSH 依赖、不含 `ctx`，公开接口保持宿主中立。这条纪律**不是为了 B 才加的** —— 它是 §0.1 组件自足性的直接推论，同时买到三样东西：**可独立测试**（测试不启动 DSH、不联网）、抗 DSH 版本漂移、以及**依赖注入缝**（fetch / 时钟 / 睡眠都是注入的，限流、退避、缓存这些最难测的时间相关行为因此可以确定性重放）。

> **2026-10 修订**：这段话过去把第三条写成"将来补 B 时不用重构"。B 已明确放弃（§12.3.1 之外，本轮复核确认它不在路线图里），所以那个理由不再成立——但纪律本身照旧，因为它真正的买方是上面那三样。**一条纪律如果只剩下一个已经作废的理由，它就会被后人当成无主的债务。**

### 9.1.2 包名：**`figma-mcp-dsh`** ✅ 已定（2026-09-24 由 `dsh-plugin-figma` 整体改名，理由见文末存档）

最初定为 `dsh-figma`。**实测 npm registry 后发现该名已被占用**，故改用 `dsh-plugin-figma`。以下保留冲突证据以备将来查阅：

```
GET https://registry.npmjs.org/dsh-figma  ->  200（已存在）
  version     : 0.0.1
  published   : 2026-08-19
  description : "Figma bridge for dsh - name reserved; first release in development."
  repository  : github.com/dushaobindoudou/dsh-figma
  keywords    : ["dsh","dsh-plugin","deepseek-harness","cordis-plugin","figma","design"]
  license     : MIT
```

**这不只是名字被占，还是一个同类项目**：同一个人在一个月前就占了名、写好了相同关键词，但只发了 `0.0.1` 占位版，说明尚未发布可用版本。两点影响：

1. **`dsh-figma` 这个名字在 npm 上不可用**（即使能申诉，也不该抢——对方先到）；
2. **存在重复劳动的可能**。值得你在动手前花五分钟看一眼 `github.com/dushaobindoudou/dsh-figma`：如果对方已经做成了，也许协作比并行更好；如果只是个空占位，那就各做各的，但**名字必须换**。

**最终选择：`dsh-plugin-figma`**（已实测在 npm 上可用）。

> **演进过程（简短存档，避免后人重新纠结）**：最初选 `dsh-figma` → 实测发现**已被他人占用**（下文有证据） → 改用 `dsh-plugin-figma` → 一度改为 `dsh-figma-plugin` → **最终回到 `dsh-plugin-figma`**。
>
> **2026-09-24 追加：再次整体改名为 `figma-mcp-dsh`**（npm 与 GitHub 双通道可用性均已实测；`dsh-plugin-figma` 从未发布过 npm，无历史包袱）。改名理由：与本地工作目录名 `Figma-MCP-dsh` 对齐、突出 Figma 与 MCP 生态的关键词，且 `dsh-plugin-figma` 已公开的 GitHub 仓库可通过重命名自动重定向，成本为零。
>
> `dsh-plugin-figma` 与 `dsh-figma-plugin` 在 npm 上**都可用**（均已实测），所以名字本身不构成约束。回到 `dsh-plugin-figma` 的理由：它与生态里既有的 `dsh-*` 命名形态（如 `dsh-pale-green-tint`）更一致。

**命名统一表（这是唯一权威）**：

| 位置 | 值 | 说明 |
|---|---|---|
| npm `package.json` 的 `name` | **`figma-mcp-dsh`** | 唯一标识，安装与发布都用它 |
| 仓库名 / 本地目录名 | `figma-mcp-dsh` | 与包名一致，避免两套名字 |
| `cordis.patch.yml` 的 `name` 字段 | **`figma-mcp-dsh`** | loader 按此解析包（§12.9.1 实测） |
| `cordis.patch.yml` 的 `id` 字段 | `figma` | **Cordis 行 id，不是包名**，可自由取短名 |
| 插件模块导出的 `name` | **`figma`** | Cordis 插件名，用于日志/调试；**不必等于包名** |
| cordis 事件前缀 | `figma/*` | |
| 工具名前缀 | `figma_*` | 如 `figma_call`、`figma_capabilities` |

> ⚠️ **这是最容易搞混的一处**：`cordis.patch.yml` 里**同一个 row 有两个"名字"** —— `name:` 是**包名**（用于解析模块），`id:` 是**行 id**（用于 patch 定位与日志）。原稿把它们混用过（把 `name:` 写成包名之外的东西、或把 `id:` 当包名），现按上表固定。

### 9.1.3 P0 范围（已冻结，开工即按此执行）

**目标**：拿一个 Figma 设计链接，模型能读懂文件结构、配色、字体，并导出截图当轮可见。**只读。**

**`src/core/`**（零 DSH 依赖、无 `ctx`，§12.3.1 不变量。**注意是目录边界，不是单独的包** —— GitHub 分发要求仓库根即包根，见 §12.9.1）
- `capability.ts` —— `CapabilitySpec` 类型 + 运行时校验（含 `method` 只读断言）
- `specs/` —— files / nodes / images 三组声明式 spec（§4.2）
- `url.ts` —— Figma URL → `{fileKey, nodeId}`，覆盖 `/file/`、`/design/`、`/board/`、`/proto/`、`/slides/`，含 `?node-id=12-345` → `12:345` 转换
- `auth.ts` —— `TokenSource` 薄接口（§12.1）+ 集中脱敏
- `http.ts` / `retry.ts` —— fetch 封装、AbortSignal、429 读 `Retry-After` 退避、**禁止自动重定向**（防令牌泄漏）
- `scheduler.ts` —— 令牌桶（默认 5/min、burst 1，§12.2）+ 同参单飞
- `cache.ts` —— LRU + TTL 60s（**纯 TTL**，ETag/304 已实测不可用，§1.3）
- `projection.ts` —— 白名单投影 + **颜色归一（hex 只取 rgb、opacity 只读 `fill.opacity`）**（§4.5a）
- `budget.ts` —— 动态 `depth` 策略（§1.5）+ 超限 spool + 骨架降级
- `provider.ts` —— 协议无关的 `ToolProvider`

**`src/adapter/`**（唯一允许 import DSH 之处）
- `index.ts` —— `apply(ctx, config)`：`inject: ['tools','credentials']`、注册工具、全部副作用走 `ctx.effect()`
- `config.ts` —— Schemastery config（`credentialRef` / `cacheTtlMs` / `maxResultBytes` / `spoolDir` / `rateLimits` / `bridgePort`）
- `tools.ts` —— `figma_capabilities` / `figma_call`（3 个工具的 `figma_canvas` 留到 P3）

**接线**：`~/.dsh/profiles/web/` 的 `package.json` 加依赖 + `cordis.patch.yml` insert 一行。**依赖名与 `package.json` 的 `name` 均为 `figma-mcp-dsh`**；`cordis.patch.yml` 里 `name: 'figma-mcp-dsh'`、`id: figma`（§9.1.2 命名统一表）。

**验收**：§6 P0 的 8 条（含两只真实文件的基准断言、半透明颜色回归、depth 守卫、令牌失效闭环）。

### 9.2 写操作：**不做**（已确认，只读）✅

**决策：本插件只读。** 不实现任何会改变 Figma 云端真实数据的调用。这不是"默认关闭、可以打开的开关"，而是架构级约束——`allowWrites` 不作为可配置项暴露，因为**当前不存在任何合法取值**。

定义（我按此实现，也请按此验收）：所有会改变 Figma 数据的端点，**不在 capability registry 里出现**。它们不是"被禁用的能力"，而是**根本不存在的能力**：

| 类别 | 读（实现） | 写（不实现，registry 里没有） |
|---|---|---|
| 评论 | 列出评论 | 发表评论、删除评论 |
| 变量 | 读取本地/已发布变量 | 创建 / 修改 / 删除变量与变量集合 |
| Dev Resources | 列出 dev resources | 新增 / 更新 / 删除 dev resource |
| Webhook | 列出 | 创建 / 更新 / 删除 webhook |
| 文件 | 读节点、导出图 | 改文件名等 |

**实现层面的三条硬约束**（P0 起生效，已并入 §11 纪律清单）：

1. **能力白名单 + 方法白名单双重校验**：派发前断言 `spec.method === 'GET'`。即使有人误加了一条 `POST` spec，运行期也会拒绝——不依赖"我们不会写错"。
2. **只引导只读 scope**：文档与错误提示都指向 `file_content:read`、`file_comments:read`、`file_variables:read`、`file_dev_resources:read` 这类只读 scope。插件不请求、不使用任何写 scope。
3. **不留"预留接口"**：不写 dry-run 骨架、不写审批流钩子、不留 `TODO: writes`。未实现的东西留接口，只会让代码形状按错误的假设生长。

**这条决策的三个理由**（记录在案，便于将来重新评估时对照）：

1. **读错了只浪费一次额度，写错了是在改真实的设计资产**——评论会通知全团队，改变量会影响所有引用该变量的设计稿，且无撤销按钮。
2. **PAT 的能力边界由 scope 决定**，只读 token 是唯一能保证"模型再怎么幻觉也删不掉东西"的方式。
3. **写操作的额度消耗是隐性的**：一轮"批量改 40 个变量"在 Tier 2 的 25/min 下会排队很久，模型未必意识到自己触发了限流。

> 将来若确实需要（例如"让 agent 自动整理变量命名"），按独立一期重新设计：`mutating: true` 标记 + 逐次审批 + 强制 dry-run + 只读/写入双 token 物理隔离（§8 的 P4）。**不要在只读版代码里提前埋这些钩子。**

---

## 10. 事实出处（本机实测 + 官方文档）

**本机实测**（`/Users/n109meow/.npm/_npx/1e7f6d9597241db0/`、`~/.dsh/`）：
- `dsh-mcp-client@0.1.5-rc.2` 存在，README 说明工具命名 `mcp__<serverName>__<tool>`、*"Tool definitions add tokens to every model request"*、stdio/streamable-http 两种 transport、`notifications/tools/list_changed` 重同步、重连退避策略
- `dsh-credentials`：`resolve/describe/set/unset` + `readRecord/listRecords/modifyRecord`；文档明确要求 **per-operation 重新 resolve、不得缓存**，这正是 token 轮换免重启的机制
- `dsh-tools` README：`ctx.tools.register()` 为 Effect；管线 `tools/pre-execute` → `tools/execute` → `tools/post-execute` → `finalizeContent` → `tools/result`；PTC 模式下含图片的成功结果会在运行后附加为 context
- `dsh-llm/lib/types/content.d.ts`：模型内容支持 `image` 块（含嵌套 tool-result 内容），且有路由能力闸门与文本降级路径
- **§1.2 工具开销数字的来源**：用 `Tool.listTools` Inspect 拿到本 session 全部 34 个工具的真实定义（名称/description/parameters 全文），按其 JSON 结构逐项累加字符数得 ~30.9k 字符；token 数按 3.6 字符/token 换算为 ~8.6k。**这是一个工程近似值，不是 tokenizer 精确计数**——本机没有可离线调用的 DeepSeek tokenizer，所以按比例外推（"130 个工具 ≈ +32.8k tokens"）时请当作量级判断而非精确账单。
- `~/.dsh/profiles/web/package.json` + `cordis.patch.yml`：本地插件接线方式（`link:` 依赖 + `insert` 行）；`plugins/pale-green-tint` 是一个已在本机正常工作的手写插件先例
- `dsh plugin --profile web --help` 实际转发给 pnpm，即 `dsh plugin --profile web add <pkg>` = 在 profile 目录里 `pnpm add`

**Figma 认证的实测结果（用你自己的 PAT 打真实 API，未经中间层）**：

| 请求 | 状态 | 响应体 | 结论 |
|---|---|---|---|
| 有效 token → `GET /v1/me` | 403 | `{"error":true,"status":403,"message":"Invalid scope: [\"file_content:read\", \"file_comments:read\", \"library_content:read\", \"library_assets:read\", \"file_dev_resources:read\", \"file_metadata:read\"]. This endpoint requires the file_read or files:read or current_user:read scope."}` | 令牌有效；`/v1/me` 需要别的 scope。**这条同时把该令牌实际持有的 6 个 scope 全列了出来** |
| 有效 token → `GET /v1/files/<假 key>/meta` | 404 | `{"status":404,"err":"Not found"}` | 认证通过（若令牌坏会 401），文件不存在 |
| **故意无效 token** → 同一端点 | **401** | `{"status":401,"err":"Invalid token"}` | **令牌问题走 401** |
| 有效 token → `GET /v1/files/<假 key>/variables/local` | 404 | `{"status":404,"error":true,"message":"Not found"}` | 路径存在，只是文件不存在（企业版能力是否可用仍待真文件验证） |

其它实测所得：

- 成功响应**不返回** `Retry-After` / `X-Figma-Plan-Tier` / `X-Figma-Rate-Limit-Type` / `X-Figma-Upgrade-Link`；它们出现在 `access-control-expose-headers` 里只是 CORS 暴露声明，**只在 429 上真正出现**。
- `access-control-allow-headers: Content-Type, X-Figma-Token, Authorization` —— **两种认证头都被接受**，`vary: X-Figma-Token, Authorization` 进一步确认。
- 响应头里**没有任何**关于令牌签发时间 / 剩余有效期的字段 → §4.4.1 的"无法提前预警"结论由此而来。

**官方文档**：
- [Figma REST API 认证](https://developers.figma.com/docs/rest-api/authentication/)：OAuth / plan token / PAT 三种；scope 概念（如 `file_content:read`）
- [Figma 个人访问令牌](https://developers.figma.com/docs/rest-api/personal-access-tokens/)：最长 90 天；生成路径 Settings → Security；**用法页明确写 `X-Figma-Token` 头**；token 明文只显示一次
- [Figma 计划访问令牌](https://developers.figma.com/docs/rest-api/plan-access-tokens/)：最长 1 年；可刷新且**旧密钥续用 24 小时**；不支持 `file_variables:write` / `file_code_connect:write` / `file_comments:write` / `/v1/me` / `/v1/oembed`；需组织管理员 + MFA
- [Figma REST API 限流](https://developers.figma.com/docs/rest-api/rate-limits/)：2025-11-17 新表；Tier 1/2/3 × 席位 × 套餐；leaky bucket；429 头 `Retry-After`、`X-Figma-Plan-Tier`、`X-Figma-Rate-Limit-Type`、`X-Figma-Upgrade-Link`；示例用 `Authorization: Bearer`
- [Figma 文件端点](https://developers.figma.com/docs/rest-api/file-endpoints/)：`GET /v1/files/:key` 的 `ids`/`depth`/`geometry`/`version`/`plugin_data`/`branch_data` 参数；`GET /v1/files/:key/nodes`、`GET /v1/images/:key`（`scale` 0.01–4、`format` png/jpg/svg/pdf）、`GET /v1/files/:key/images`、`GET /v1/files/:key/meta`（Tier 3，只用 `file_metadata:read`）；**403 定义为「token invalid or expired」**；图片资源 30 天过期、image fill URL ≤14 天
- [Figma 插件 manifest](https://developers.figma.com/docs/plugins/manifest/)：`networkAccess.allowedDomains` 白名单机制、`ws`/`wss`/`http://localhost:<port>` 是合法 pattern、含本地服务器时 `reasoning` 必填、`documentAccess: 'dynamic-page'`
- [Figma Plugin API 参考](https://developers.figma.com/docs/plugins/api/api-reference/) / [REST API](https://developers.figma.com/docs/rest-api/)

**学术文献**：
- Shi, Y., Zhang, W., Cui, T. — *A Programming Paradigm for Spatiotemporal Composability*, arXiv:2608.25512 [cs.PL], 2026-08-26，92 页。北京大学 / DeepSeek-AI。即 Cordis 的形式化基础论文。原文：<https://arxiv.org/abs/2608.25512>；代码：<https://github.com/cordiverse/cordis>。§0.1 的四个概念（revertible effects / reactive coeffects / context paradigm / observational equivalence）均引自其摘要原文，未做引申。

**MCP 协议（已实测版本支持面）**：
- 本机 `@modelcontextprotocol/sdk@1.30.0`（`dsh-mcp-client` 的依赖）的 `LATEST_PROTOCOL_VERSION = '2025-11-25'`，`SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']`（读 `dist/esm/types.js` 得到）
- [MCP 规范 2026-07-28 变更日志](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md)：移除 `initialize` 握手与会话、新增 `server/discover`、列表结果强制 `ttlMs`/`cacheScope`、建议确定性工具顺序等（详见 §6 P2 的提示框）
- [Claude 官方对 MCP 2026-07-28 的说明](https://claude.com/blog/bringing-mcp-2026-07-28-to-claude)；[Google 关于 MCP stateless 的工程文章](https://developers.googleblog.com/en/scaling-ai-agent-infrastructure-with-the-mcp-stateless-updates/)

**本方案中我没有逐条核实的部分**（诚实标注，避免误导）：
- Figma 各端点在**其它文件类型**（FigJam / Slides / Dev Mode）上的返回字段差异；本次只在 `Design File A`（`editorType: figma`）上验证过。
- 企业版能力（`variables/local`）在**有权限的套餐**下的真实返回结构——本次该端点只返回了 `404`（文件不存在）。
- Figma 官方 MCP server（远程 `mcp.figma.com/mcp` 与本地 Dev Mode 端口）的当前工具清单与端口细节；§3 中对它的定位（需要 OAuth 登录 / 需要桌面端打开文件）足以支撑选型结论，但不作为实现依据。
- MCP `2026-07-28` 的字段级细节（`server/discover` 的精确 schema、MRTR 的 `inputRequests` 结构等）。P2 只实现 `2025-11-25`，届时若要做 stateless 适配器再逐条对照规范。
- 论文中 service broker 等章节的具体机制（§0.1 末尾提到但未展开），我只依据摘要层面的结论，没有逐节校对 92 页正文。

---

## 11. 设计纪律清单（源自 §0.1，逐条可验证）

这张表是给评审和 code review 用的：每条纪律都配一个**可执行/可观察**的检查方式，避免"听起来很对"的设计悄悄退化。实现时建议直接把这表变成 PR checklist。

**状态列是 2026-10 逐条复核的结果，不是承诺。** 标 ❌ 不等于设计错了，而是"目前还没有机器守着它"——评审者据此判断一条纪律的可信度，比读十条自我声明有用。

| # | 纪律 | 理论出处 | 怎么验证（不靠自觉） | 状态（2026-10 复核） |
|---|---|---|---|---|
| 1 | 每一份子资源都在 `apply()` 里注册 disposer（WebSocket、定时器、缓存驱逐、事件监听、工具） | revertible effects | 反复 `stop` / `update` 插件 20 次，观察句柄数与定时器数回到基线（`process._getActiveHandles()` 或计数器断言） | ❌ **未验证** —— 工具注册那一半已由 `test/adapter/unload.test.js` 覆盖（它断言每个注册都是 ctx 拥有的 effect）；"反复 stop/update 看句柄数"的实验仍未建 |
| 2 | 不使用不受管的全局副作用（模块级单例、`setInterval`、`process.on`） | revertible effects | CI 里 grep 禁止模式：`^const .* = new .*\(\)$`（模块级）、裸 `setInterval`、`process.on(` | ❌ **未验证（待建门禁）** —— 人工复核的实情：`src/` 中无 `setInterval`、无 `process.on(`，模块级 `new Set(...)` 全部是冻结的常量表；但没有门禁阻止下一个人加 |
| 3 | 依赖一律用 coeffect 声明，不手写探测 | reactive coeffects | code review 拒绝 `apply` 内的 `if (bridge.isUp())` / 轮询逻辑；离线行为由 PENDING 表达 | ❌ **未验证（review 项）** —— `inject: ['tools','credentials']` 是声明式的，但"apply 里没有手写探测"只能靠人读 |
| 4 | 可选依赖用 `ctx.get(name)` + undefined 检查，硬依赖用 `inject` | context paradigm | 缺服务时插件应停 PENDING 而非抛异常；用"临时摘掉 credentials 行"实测 | ⚠️ **部分验证** —— `test/adapter/adapter.test.js` 断言了 `inject` 的内容与名称；"摘掉 credentials 行 → 停在 PENDING 而非抛异常"是手工实验，未自动化 |
| 5 | `core` 不 import 任何 `@deepseek-ai/*` | 组件自足性 | `dependency-cruiser` 或简单 grep 作为 CI 门禁；`packages/core/package.json` 里没有 DSH 依赖 | ✅ **已验证** —— `npm run check:layering`（在 `npm run verify` 内）静态检查 19 个文件；`test/core/layering.test.js` 故意注入违规，证明门禁**会**失败 |
| 6 | 共享可变状态（限流桶、缓存）挂在 host 面 context，不放进 per-session 域 | observational equivalence | 开第二个 session，断言两 session 共用同一个桶实例（否则额度会被翻倍消耗） | ⚠️ **部分验证** —— `test/adapter/unload.test.js` 钉住"两个工具命中同一个 provider 实例"（缓存、限流桶、失效凭据记忆都在它内部）；**跨 session 共用同一实例的实验仍未建**（需要真启动两个 DSH session） |
| 7 | 跨组件通信只走 `ctx`（服务/事件），不 import 彼此实现 | observational equivalence | 适配器之间零 import；`core` 只暴露接口 | ⚠️ **部分验证** —— `core` 只暴露接口、`check:layering` 管住 core→宿主方向；反向（适配器互相 import）无门禁，因为当前只有一个适配器，还没有第二个可 import |
| 8 | 卸载后不得残留对模型的可见影响 | observational equivalence | 卸载插件后 `Tool.listTools` 必须回到装载前的工具集（做一次快照 diff） | ✅ **已验证** —— `test/adapter/unload.test.js`：镜像宿主 effect 语义的 mock ctx，装载→断言两个工具→逆序释放→断言回到装载前快照。镜像依据是安装源码逐行核对（`dsh-tools/lib/index.js:2878-2887` → `dsh-scope/lib/index.js:189-218` → cordis `Fiber._unload`） |
| 9 | **只读**：registry 中不存在写能力，派发前断言 `method === 'GET'` | 项目决策（§9.2） | CI 断言：所有 spec 的 `method` 均为 `GET`；故意注入一条 `POST` spec，运行期必须拒绝 | ✅ **已验证** —— `test/core/capability.test.js` 两条（校验期拒绝、派发期拒绝）+ `check:layering` 的静态断言，三处独立 |
| 10 | **不从零值推断因果**：任何"字段为空"的结论都必须先用**改变输入**验证 | §1.4(2) 的教训 | 遇到可疑空集时，先构造/索取一个非空样本重测，再下结论；写进 issue 模板 | ❌ **未验证（流程项）** —— 这条约束的是人的判断，没有机械化检查；`.github/ISSUE_TEMPLATE/bug.yml` 要求贴证据，但尚未把这条规则写进去 |

> 这张表的实际价值在第 6 条和第 8 条上：它们是最容易被"先跑通再说"牺牲掉的两条，而恰恰是它们决定了插件能不能在长跑的 harness 里共处。

> **关于第 5 条的动机（2026-10 修订）**：这条纪律过去被写成"为将来补 MCP 适配器铺路"。MCP 适配器已明确放弃（§12.3.1），所以那个理由**不再成立**，纪律本身保留是因为它真正买到的是另外两样：**离线可测性**（200 项测试不启动 DSH、不联网，见 `npm test`）与**依赖注入缝**（fetch / 时钟 / 睡眠都是注入的，所以限流、退避、缓存这些最难测的行为可以在毫秒内确定性复现）。一条纪律如果只剩下一个已经作废的理由，它就会被当成无主的债务。

---

---

## 12. 开源化改造：面向"别的 DSH 用户"

**范围已澄清（2026-09 用户确认）：这是一个 DeepSeek Harness 插件项目。开源受众 = 其他 DSH 用户，不是多宿主通用工具。**

这一条改变了本节的定位。上一版我按"多宿主分发"写了六条结构性改动，其中**多条超出了实际范围**，已按下表订正：

| 原建议 | 处置 | 原因 |
|---|---|---|
| MCP 提为 P1.5、当"主分发渠道" | ❌ **撤回** | 受众是 DSH 用户，而他们能直接装 Cordis 插件。MCP 不是触达途径 |
| 发布 3 个包（core / mcp / dsh） | ❌ **撤回** | DSH 专属适配器单独发包没有第二个消费者；仍按单包 + 清晰分层（§4.1） |
| 按最弱席位调安全默认值 | ✅ **保留**（理由改） | 不再是"因为陌生人席位弱"，而是**跨 workspace/账号的可移植性与防御性默认**（§12.2） |
| 凭据 provider 可插拔 | ✅ **保留**（理由改） | 不再是为了非 DSH 用户，而是**可测试 + 不被 DSH 内部 API 版本绑死**（§12.1） |
| `figma_doctor` | ✅ **保留** | 其他 DSH 用户照样会配错令牌/scope/席位 |
| 四平台令牌投递文档 | ⚠️ **收缩** | 主推 DSH 凭据服务（唯一正规路径）；环境变量作为 CI/临时兜底 |

**仍然成立的核心判断**：这是"为别人的环境设计"，而别人的环境与你的有两点真实差异——**席位可能更弱**、**配置可能配错**。下面只保留这两条线以及合规/卫生事项。

### 12.1 凭据层保持薄接口（理由：可测试 + 抗 DSH 版本漂移）

DSH 用户的唯一正规路径是 **`ctx.credentials.resolve('FIGMA_TOKEN')`**（§4.4），这一点不变。但在它外面包一层**只有一个方法的薄接口**：

```ts
interface TokenSource { resolve(): Promise<string | undefined> }
```

- `DshCredentialSource` —— 默认，包 `ctx.credentials`（生产路径）；
- `EnvTokenSource` —— 读 `FIGMA_TOKEN`，**给 CI、容器、以及"我就想临时试一下"的人**；
- `StaticTokenSource` —— 测试用，**这是保留它的主要理由**：让 `core` 的全部测试不依赖 DSH 运行时。

**纪律不变：`core` 里不出现 `ctx`。** 但动机是**可测试性与抗漂移**（DSH 目前是 `0.1.5-rc` 预发布版，内部 API 可能变），不是"服务别的宿主"。

优先级：`ctx.credentials` 优先，未配置时回落环境变量，并在结果里**回报凭据来源**（`source: 'dsh-credentials' | 'env'`）——排障时这一条能省很多时间。

同理 `spool` 目录：默认走 DSH 的 session workspace 概念是合理的，但加一个显式覆盖项（`spoolDir` 配置，已是 §4.4 现状），避免写死。

### 12.2 安全默认值面向"更弱的席位"（其他 DSH 用户不一定是 Full/Dev）

你的席位是 **Full/Dev**（Tier 1 = 10–20/min），原稿据此调参。但其他 DSH 用户**很可能是 View / Collab 席位——Tier 1 只有 20 次/月**，而且**调用前无法得知对方是哪种**。开源意味着默认值要为分布中最弱的那一档负责。

- 默认更保守：Tier 1 `5/min`、burst `1`（宁可慢，别撞月度上限）；
- **不得**把 "Full/Dev" 写进默认值或文档主路径；
- 首次 429 时读 `X-Figma-Rate-Limit-Type`，**进程内记住**并据此放宽/收紧（§4.4；这项从"优化"升级为"必需"）；
- **月度上限单独做一档错误**：View 席位撞到 20 次/月时，必须明确说"这是 Figma 套餐限制，重试无用"，并附 `X-Figma-Upgrade-Link`。**这类 issue 会占求助量很大比例。**

> 注意这条与"多宿主"无关——它纯粹是**用户席位分布**问题，所以在范围收缩后依然成立。

### 12.3 分发形态：维持 DSH 原生插件为主线（上一版的 MCP 主线建议已撤回）

上一版我建议"MCP 是主渠道、P2 提为 P1.5、发三个包"。**在 DSH-only 范围内这是错的**：DSH 用户能直接挂 Cordis 插件，MCP 不构成额外触达。撤回内容：

- ❌ 不再把 MCP 适配器提为 P1.5；
- ❌ 不再按"core / adapter-mcp / adapter-dsh"发三个包；
- ✅ 维持 §4.1 的单包 + 分层（`core` 无 DSH 依赖，适配器负责接线）。

**但 `adapter-mcp` 仍保留在路线图里（P2，可选）**，理由变成"面向 DSH 用户的可选入口"，而不是"多宿主分发"：

- 有的 DSH 用户更愿意用 `dsh-mcp-client` 挂一个 MCP server（他可能同时用别的宿主，或想复用同一份配置）；
- 它对**你**也仍然有用：可以在不启用 DSH 的情况下跑通、调试、做基准测试。

**代价对比（供决定用）**：

| | 原生 Cordis 插件（主线） | MCP server（可选 P2） |
|---|---|---|
| 工具名 | `figma_call`（干净） | `mcp__figma__figma_call`（多一层前缀） |
| 凭据 | 直接 `ctx.credentials` | 需环境变量传入，拿不到凭据服务 |
| 上下文开销 | 最小 | schema 多一层包装 |
| 装配复杂度 | 需要 `link:` + `cordis.patch.yml` 两处改动 | `dsh-mcp-client` 加一段 config |
| 热重载 | `patchReload: live` 直接生效 | 改配置重连 |

> **上一版把这条判断写反了，已订正。** 根本原因是我默认了"开源 = 面向所有 agent 宿主"，而实际范围是"面向 DSH 用户"。

### 12.3.1 MCP 适配器（B）：**当前不做**，但保留"可随时补回"的硬保证 ✅ 已决定

**决定（用户 2026-09）：B 不保留在路线图里。** 但用户同时问了"如果后面有需要，B 可以再补充吗"——**可以，而且这不是承诺，是可强制检查的架构不变量**：

- B 的全部工作量 ≈ **60–100 行**，前提是 `core` 协议无关。所以只要下面三条不变量被 CI 守住，补回 B **不需要重构**：
  1. **`core` 不 import 任何 `@deepseek-ai/*`**（CI：`packages/core/package.json` 无 DSH 依赖 + grep 门禁）；
  2. **`core` 里不出现 `ctx`**（CI：grep 门禁）；
  3. **`core` 的公开接口是宿主中立的**——例如 `TokenSource`（§12.1）而不是直接暴露 `ctx.credentials`（CI：类型检查 + review 检查点）。
- 这三条同时也是 §11 纪律清单里已有的条目（第 5 条等），**所以"B 可补回"这件事不额外花钱**，它本就是分层纪律的副产品。

**代价（做决定时已确认接受）**：不保留 B 意味着**当前没有任何非 DSH 入口**，也无法脱离 DSH 单独调试/做基准。将来若要补，按 60–100 行 + 复用仓内已有的 `@modelcontextprotocol/sdk` 估。

> 一句话：**B 现在不做，但门留着，且门是 CI 守的，不是靠记性。**

### 12.4 `figma_doctor` 诊断能力（开源项目的高杠杆投入）

陌生人第一次用会带着**各种**令牌状态来：scope 不全、席位不对、令牌过期、走代理、企业版缺权限。与其在 issue 里反复问，不如给一个自诊断工具：

```
figma_doctor()
  → 凭据来源（环境变量 / 配置文件 / DSH 凭据服务，只报来源不报值）
  → 令牌有效性（401 探测）
  → 该令牌实际持有的 scope 列表（从 403 响应体解析，§5.4 已实测可行）
  → 席位类型 / 限流档位（首次 429 后可得；否则报"未知"）
  → 一次端到端烟测：/meta 取一个公开示例文件
  → 代理是否生效（dsh-http-proxy 或 HTTPS_PROXY）
  → 输出一段可直接粘进 issue 的脱敏报告
```

**这一段"可直接粘进 issue 的脱敏报告"是重点**——它同时解决了用户不会描述问题、和你不愿让用户贴 token 两个难题。

### 12.5 令牌投递文档：以 DSH 凭据服务为主路径

受众是 DSH 用户，所以**主推唯一正规路径**，环境变量只作为 CI/临时兜底：

```yaml
# 主路径：~/.dsh/.credentials.yaml
refs:
  FIGMA_TOKEN: figd_xxx        # 保存即生效（watch，不用重启）
```

```bash
# 兜底：环境变量（CI / 容器 / 临时试用；注意启动环境提供的 key 对凭据服务是只读的）
export FIGMA_TOKEN=figd_xxx
```

**README 必须写清的三条预期管理**（能砍掉大量 issue）：

1. 本插件**只读**，永远不会改你的设计文件；
2. **PAT 最长 90 天且不可刷新**，到期需重新生成（Org/Enterprise 可改用计划访问令牌：1 年 + 可刷新）；
3. **View/Collab 席位下 Tier 1 只有 20 次/月**；Full/Dev 是 10–20 次/分。这是 Figma 套餐限制。

外加**只读 scope 清单**（照着勾即可）：`file_content:read`、`file_metadata:read`、`file_comments:read`、`file_dev_resources:read`，需要变量再加 `file_variables:read`。

### 12.6 移植性：范围收缩后剩下的三条

- **不需要**"多平台/多宿主"适配（之前那版过度设计），但三条仍要做：
  1. `engines` 声明 Node 版本（建议 `>=20`，依赖内建 `fetch`）；**零 native 依赖**，保证 `link:` 装配不折腾；
  2. **别依赖 DSH 的内部 API 细节**：DSH 是 `0.1.5-rc` 预发布版，`ctx.credentials` 等契约可能变。用 §12.1 的薄接口把它包起来，升级时只改一处；
  3. **网络失败要可区分**：Figma API 在部分网络环境不可达。首次失败时区分 DNS / TLS / 超时 / 代理，而不是笼统的 `fetch failed`——其他 DSH 用户遇到时才好自查。

### 12.7 issue 模板 + 文档先行

在写代码前先落两个文件，它们会显著影响实现的边界：

- `docs/TOKEN_SETUP.md`：四种投递方式 + 只读 scope 清单 + 席位影响 + 常见 403 对照表；
- `.github/ISSUE_TEMPLATE/bug.yml`：**必填 `figma_doctor` 报告**。这一条能把"帮我看看为什么不行"变成"贴报告"，省掉大量来回。

### 12.8 仓库与合规

- **LICENSE**：建议 **MIT**（与 DSH / Cordis 生态一致，`vendor/cordis` 亦为 MIT；对工具类项目门槛最低）。若更在意专利授权条款，用 Apache-2.0。
- **命名**：✅ 已定 **`figma-mcp-dsh`**（§9.1.2）——描述性命名，不宣称官方归属；README 明确"非 Figma 官方项目，未获 Figma 背书"。
- **`SECURITY.md`**：本工具处理 PAT，需说明"令牌不落日志/不进错误体/不跟随重定向"（§5.5 已设计），并给出私密报告渠道。
- ✅ **不要发布录制 fixtures**：§1.3/§1.4 的实测数据原本含真实 fileKey、节点 id、文件名与 Figma handle。**已脱敏**：两份文档里的标识符全部换成了合成值（见文首说明），`test/` 只用合成 fixture，`fixtures/recorded/` 仍在 `.gitignore` 里，并由 `scripts/check-secrets.mjs` 在 CI 中拦住再次泄漏。**新增实测数据时同样不要提交真实 fixture。**
- **CI**：`node --test` + 类型检查 + **§11 的纪律门禁**（只读断言、`core` 无 DSH import、卸载无残留）。
- **CONTRIBUTING.md**：明确"能力扩展 = 加一条 spec 数据"（§4.2），这是这个架构对贡献者最友好的地方，要在文档里讲清楚，否则没人知道怎么加能力。

### 12.9 对已定决策的复核（范围澄清后）

| 决策 | 变化 | 说明 |
|---|---|---|
| 席位 Full/Dev（你的） | ⚠️ **默认值不按它设** | 你的席位不变；但默认参数按更弱席位设，靠运行时探测放宽（§12.2） |
| 只读，不做写操作 | ✅ 不变，**开源后更有利** | 只读是别人愿意挂这个插件的前提 |
| 能力表驱动、只暴露 3 个工具 | ✅ 不变 | 对其他 DSH 用户一样重要：上下文开销可控 |
| DSH 原生插件为主线 | ✅ **维持**（上一版曾反转为 MCP 主线，已撤回） | §12.3 |
| MCP 适配器 | 🔸 **降为可选 P2** | 面向"想用 MCP 入口的 DSH 用户"，非多宿主分发 |
| 包结构 | ✅ **单包 + 分层**（撤回"发三个包"） | DSH 专属适配器没有第二个消费者 |

### 12.9.1 分发路径：**npm + GitHub 双通道**（已决定）+ 装配实测结果

**用户决定两条都做**：npm 公共仓库（一行装）**与** GitHub（无需占 npm 名）。两者共用同一个平铺包结构（§12.9.1 末段），`lib/` 提交进仓库对两者都有益（npm 端保证发布物与仓库一致，Git 端因为没有构建步骤而必需）。

**通道一：npm（推荐给用户，体验最好）**

```bash
dsh plugin --profile web add figma-mcp-dsh     # 等价于在 profile 目录里 pnpm add
```

- 前置：`package.json` **不能**设 `private: true`（根 `package.json` 已按此建好）、`license` / `repository` / `keywords` / `files` 已就位；
- `files` 只放 `lib/`（+ README/LICENSE），源码不进包；
- 加 `prepublishOnly` 跑构建 + 测试，**避免发出陈旧的 `lib/`**；
- 建议开启 npm provenance（`--provenance`，需 CI 从 GitHub Actions 发布）——对一个要处理用户 Figma 令牌的包，这是很有说服力的信任信号。
- ⚠️ **先解决包名冲突**：见 §9.1.2。

**通道二：GitHub（无需 npm 名）**

```bash
pnpm add github:<user>/figma-mcp-dsh
```

- 优点：不占 npm 名、无需 npm 账号；
- 代价：用户机器上要有 git；且**安装时不构建**，所以 `lib/` 必须已提交；
- ⚠️ **本机未能验证**（GitHub 吞吐极低，见下节）；README 里标注"备选，未在本机验证"。

**通道三（已实测通过，保留为最快路径）**：`clone + pnpm add link:<路径>`。见下。


#### ✅ `link:` 路径已端到端验证（2026-09，真机）

在隔离 profile `~/.dsh/profiles/wiring-test/` 上用真插件跑通，**没有碰正在使用的 web profile**：

| 验证项 | 结果 |
|---|---|
| 裸包名能否从 profile 的 `node_modules` 解析 | ✅ `import('<包名>')` → `name` 与 `apply` 都在 |
| `cordis.patch.yml` 的 insert 行是否进入组合 | ✅ `--dump-config` 输出末段含 `- id: figma` / `name: <包名>` |
| DSH 是否**真的加载并激活** | ✅ 启动日志出现 `wiring probe loaded` 标记 |
| 卸载时 disposer 是否执行 | ✅ 同一次会话出现 `wiring probe unloaded` 标记 |
| 有无加载错误 | ✅ 无 |

**结论：`pnpm add link:<clone 路径>` 这条路径可用**。在双通道方案里它是"最快路径"（无需 npm 账号、无需等发布），README 里作为开发/自用路径列出。

> 顺带确认了 loader 的解析行为（`cordis-plugin-loader/lib/index.js:270`）：对**裸包名**直接走 `import(name)`（Node 解析），对 `.` 开头的相对名才用 `baseUrl`。所以插件必须能从 **profile 的 `node_modules`** 解析到——这是 `link:`/`pnpm add` 的职责，**不是**在 `cordis.patch.yml` 里写文件路径。

#### ❌ `github:` 路径**本机无法验证**（网络所致，非方案问题）

实测证据：

- `git ls-remote https://github.com/...` → `fatal: ... Operation too slow. Less than 1000 bytes/sec transferred the last 8 seconds`
- `pnpm add --lockfile-only github:isaacs/rimraf` → 50 秒无任何输出、未生成 lockfile
- `curl https://github.com` → HTTP 200 但 10 秒只收到 16 KB

**即 GitHub 可达但吞吐极低**，git 的低速保护会直接中止。所以：

- **不把 `github:` 写进 README 主路径**，只在"备选"里提一句，并标注"未在本机验证"；
- 由你来验（你的网络显然更好——实测你能正常访问 npm registry：1.7s 返回 200）：`pnpm add github:<user>/figma-mcp-dsh` 能否成功；
- **npm 通道不受此影响**：npm registry 在本机**实测可达且很快**（`registry.npmjs.org` HTTP 200 / 1.77s），所以 `dsh plugin add <包名>` 这条主路径可以正常开发与验证。

#### ⚠️ 结构问题（本次测试发现，会阻塞 GitHub 分发）

`pnpm add github:<user>/<repo>` 装的是**仓库根**。而原方案的目录结构是 workspace 根 + `packages/adapter-dsh/` 子包 —— **`name` 在子目录里，GitHub 安装拿不到它**。也就是说：按原结构，GitHub 分发**开箱就是坏的**。

**修正：改成单一平铺包（放弃 workspace）。**

```
figma-mcp-dsh/               # 仓库根 = 包根，name: "figma-mcp-dsh"
├── package.json                # main → lib/index.js
├── src/
│   ├── core/                   # ⛔ 禁 import @deepseek-ai/*、禁出现 ctx
│   │   ├── capability.ts / specs/ / url.ts / auth.ts
│   │   ├── http.ts / retry.ts / scheduler.ts / cache.ts
│   │   └── projection.ts / budget.ts / provider.ts
│   └── adapter/                # DSH 接线（唯一允许 import DSH 的地方）
│       ├── index.ts / config.ts / tools.ts
├── lib/                        # 提交进仓库（git 安装不构建）
└── test/
```

**为什么这样可行**：本插件**零外部运行时依赖**（用 Node 内建 `fetch`，MCP SDK 也用不到因为 B 不做），所以根本不需要 workspace 去做依赖隔离。分层的价值（§0.1 组件自足性、§12.3.1 的 B 可补回）**由目录边界 + CI 门禁**实现，而不是由包边界实现：

- CI gate：`src/core/**` 中 grep `@deepseek-ai/` 与 `ctx` 必须为 0 命中；
- `src/core` 的测试不 import 任何 DSH，`node --test` 直接跑；
- 将来若要拆包，`src/core/` 已经是一个自足的目录，移动即可。

> **代价**：失去 workspace 的物理依赖隔离（靠 CI 门禁补偿）；**收益**：GitHub 分发开箱可用，且少一层 pnpm workspace 复杂度。

### 12.10 开源清单（可直接当 checklist）

- [x] `LICENSE`（建议 MIT，与 DSH / Cordis 生态一致；`vendor/cordis` 亦为 MIT）　→ ✅ 已落地：仓库根 `LICENSE`（MIT）。
- [x] 包名 `figma-mcp-dsh`，README 标注"非 Figma 官方项目，未获 Figma 背书"　→ ✅ 包名见 §9.1.2；免责声明引用块已加在 README 开头（`> ⚠️ 本项目**非 Figma 官方项目，未获 Figma 背书**。`）。
- [x] npm 发布就绪：**`private` 必须为 false/不存在**、`license`/`repository`/`keywords`/`files`（只含 `lib/`）、`prepublishOnly` 跑测试、考虑 `--provenance`（§12.9.1）　→ ✅ 已就位：`private` 不存在，`license`/`repository`/`bugs`/`homepage`/`keywords`/`engines`/`prepublishOnly` 全部写好。⚠️ **`files` 后来改成同时含 `src/`，是有意为之**：git 安装不执行构建，`lib/index.js` 是手写转发层、转发目标就是 `../src/adapter/index.js`，只发 `lib/` 会得到一个装不起来的包（与下一条 `lib/` 同源）。`--provenance` 留到真正发布时再定。
- [x] ⚠️ **把 `package.json` 里的 `<user>` 占位符换成你的真实 GitHub 用户名** —— npm 不会校验 `repository.url`，所以占位符会安静地发布成一个坏链接（`repository.url` / `bugs.url` / `homepage` 三处）。发布前检查收窄到只查 `package.json`：

      ! grep -q '<user>' package.json

  **`README.md` 与 `docs/` 里的 `github:<user>/…` 是给读者的占位语法，故意保留**，不要一起替换——把它们算进检查会让这条永远无法通过。　→ ✅ 已替换为 `N107meow`（`repository.url` / `bugs.url` / `homepage` 三处一致，`grep -c '<user>' package.json` = 0）；README / `docs/` 里的占位语法按原意保留。
- [x] 跑一次 `bash scripts/verify-wiring.sh`，确认装配四项检查全绿（已内置）　→ ✅ 脚本已内置，四个检查项写死在脚本里；`link:` 装配路径已在本机端到端验证通过（§12.9.1「✅ `link:` 路径已端到端验证（2026-09，真机）」）。
- [x] **改名守卫**：`package.json` 的 `name` 是唯一权威；改名时用 `grep -rn '<旧名>' . --exclude-dir=.git` 收尾，**必须为 0 命中**。本次在 `dsh-plugin-figma` 与 `dsh-figma-plugin` 之间来回改名时，`repository.url` 之外的 `bugs` / `homepage` 两个 URL 就漏改过（一致性自查抓到的）。**另一个真实教训：全局替换脚本会连「历史存档」一起改掉**（本次就把它改成过自相矛盾的文本），所以文档里的旧名存档必须**显式豁免**于替换之外。　→ ✅ 当前名 `figma-mcp-dsh` 稳定，命名统一表（§9.1.2）是唯一权威；上面那条真实教训就是本节保留下来的原因。2026-09-24 的改名按此执行：全仓替换后手工恢复本节存档。
- [ ] 发布前先看 `github.com/dushaobindoudou/dsh-figma` —— 同类项目（占用了 `dsh-figma` 名字），判断是协作还是并行（§9.1.2）　→ ⏳ 名字层面的判断已完成（§9.1.2：对方是 `0.0.1` 占位版，故本仓库当年改名 `dsh-plugin-figma`）；但"**动手前花五分钟看一眼仓库**"是**发布动作的一部分**，还没到那一步，故保持未勾选。
- [x] ⚠️ **`lib/` 编译产物提交进仓库**，且 `.gitignore` **不再忽略 `lib/`** —— 否则 git 安装得到空包（§12.9.1）　→ ✅ `lib/index.js` 已提交，`.gitignore` 里那段注释显式说明**不忽略 `lib/`** 及原因（严格说它不是编译产物，而是手写转发层；没有任何构建步骤，所以 `src/` 也一起发）。
- [x] `SECURITY.md`：说明令牌不落日志/不进错误体/不跟随重定向（§5.5），给出私密报告渠道　→ ✅ 本任务新建 `SECURITY.md`（令牌处理 / 只读四层机制 / 本地敏感文件 / 私密报告渠道），并按实现补两条：脱敏同时覆盖 percent-encoded 形态、取签名图片 URL 时不带令牌。
- [x] `README.md`：三条预期管理（§12.5）+ 只读 scope 清单 + 装配步骤　→ ✅ 三项都在（只读 / PAT 最长 90 天且不可刷新 / 弱席位额度）；本任务又补了免责声明、7 个能力表与「脱敏与隐私」一节。
- [x] `docs/TOKEN_SETUP.md`：DSH 凭据为主路径　→ ✅ 本任务新建（获取路径 / 四项只读 scope / `.credentials.yaml` 为主路径 + 环境变量兜底 / PAT 三个坑 / 轮换与失效排查），README §3 已链过去。
- [ ] `.github/ISSUE_TEMPLATE/bug.yml`：必填 `figma_doctor` 报告　→ ⏳ 模板本身已建（本任务，任务 7 可选），但**刻意不引用尚未实现的 `figma_doctor`**（延期至 P1.5），改为要求贴 `npm run verify` 输出与脱敏后的结构化错误。按原措辞（必填 `figma_doctor` 报告）这条仍不成立，故保持未勾选。
- [x] `CONTRIBUTING.md`：讲清"**加能力 = 加一条 spec 数据**"（§4.2）——这是本架构对贡献者最友好的点，不写就没人知道　→ ✅ 本任务新建，含一条可直接照抄的 spec 示例、加载期校验覆盖的字段清单，以及"要加投影器时四处一起动"的对照表。
- [ ] `figma_doctor` 输出**脱敏**报告　→ ⏳ 能力本身延期至 P1.5（§12.4），本条随之延后；脱敏要求已写进 `SECURITY.md` 与 `CONTRIBUTING.md`。
- [ ] **CI 门禁**（§11 的纪律变成可执行检查）：只读断言、`core` 无 DSH import、卸载无残留、全 spec 均为 `GET`　→ ⏳ 四项里**三项已落地**：只读断言（派发前 `assertReadOnly` + `check:layering` 静态）、`core` 无 DSH import、全 spec 均为 `GET`，都由 `npm run check:layering` 覆盖、进 `npm run verify`，另有 `test/core/layering.test.js` 证明门禁**会**失败。**「卸载无残留」还没有自动化检查**（`ctx.effect` 的 disposer 都写了，但没有测试证明它），**GitHub Actions 接线也未做**——两项都留给推送方案。
- [x] ⚠️ **源码与 fixtures 脱敏**：§1.3/§1.4 的实测数据含真实 fileKey、节点 id、文件名与 Figma handle，**必须剔除或换合成样本再推**　→ ✅ 源码、fixtures **与文档**均已脱敏（合成标识符见本文文首说明）；真实值进了 `scripts/check-secrets.mjs` 的 `FORBIDDEN_LITERALS`，并已用一次 git 历史改写（`git filter-repo`）从历史中剔除，现在由 `npm run check:secrets`（工作树 + git 历史）守门，当前全绿。

---

> **P0 的两项前置实测已完成**（见 §1.3）：**① `ETag` 返回但条件请求不支持（拿不到 304，故该问题作废）；② `/files` 与 `/nodes` 无 `etag`。** 缓存策略因此确定为**纯 TTL**。
