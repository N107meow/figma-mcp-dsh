# 贡献指南

感谢你有兴趣改进 `figma-mcp-dsh`。仓库不大，但有几条纪律**不靠自觉、靠门禁**——花两分钟读完这一页，能省掉一次返工。

## 1. 环境准备

```bash
git clone https://github.com/N107meow/figma-mcp-dsh.git
cd figma-mcp-dsh
```

插件通过 `link:` 装进 DSH profile，Node 会按**本仓库**（符号链接的真实路径）解析 import，所以三个宿主包必须在本仓库里也装一份，且**版本要与正在运行的 DSH 三元组对齐**（装错版本不会在加载时报错，只在调用时表现为类型/行为不一致）：

```bash
# 读到版本号 → 照 README「0. 开发环境准备」装这三个包
D="$(dirname "$(readlink -f "$(command -v dsh)")")/../@deepseek-ai"
node -p "require('$D/dsh-tools/package.json').version"

pnpm add -D @deepseek-ai/dsh-tools@<上面读到的版本> \
           @deepseek-ai/schemastery@3.18.2 \
           @deepseek-ai/cordis@4.0.2

npm run check:deps     # 三个必须全 ✅（它比对的不只是"能否解析"，还有版本三元组）
npm run verify         # deps + 分层门禁 + 秘密门禁 + 195 条测试
```

## 2. 核心贡献模式：加一个能力 = 加**一条数据**

这是本架构对贡献者最友好的地方：**能力是声明式数据，不是代码**。工具表长度恒定（永远两个工具），加端点不会增加每次请求的上下文税。

在 `src/core/specs/` 下写一条 spec，形状照抄邻居（例如 `components.js`）：

```js
// src/core/specs/comments.js
import { READ_ONLY_METHOD } from '../capability.js'

/** @type {import('../types.js').CapabilitySpec} */
export const comments = {
  name: 'comments',                          // 也是 figma_call 的 op，必须是小写标识符
  description:                               // 给模型看：做什么 + 什么时候用（英文，与既有 spec 一致）
    'Read the comments on this file: author, text, the node they are attached to, and whether they are resolved. ' +
    'Use it when the question is what people said about a design, not what the design contains.',
  group: 'comment',
  scopes: ['file_comments:read'],            // 启动自检与缺 scope 时的提示都靠它
  transport: 'rest',
  method: READ_ONLY_METHOD,                  // 永远是 GET，见下
  path: '/v1/files/:fileKey/comments',
  params: {
    fileKey: {
      type: 'string',
      required: true,
      description: 'Figma file key, or pass the whole link as "target".',
    },
  },
  tier: 3,                                   // 决定用哪个令牌桶（默认值面向最弱席位）
  cache: { ttlMs: 60_000, keyBy: ['fileKey'] },   // keyBy 必须覆盖每个参数
  project: 'raw',                            // 先用直出；需要整形再加投影器
  weight: 'small',
}
```

> 语言约定：**代码与注释用英文**（包括 `description`——它是模型直接读到的文本），**文档（`README.md`、`docs/`、这份指南）用中文**。

然后汇入 `src/core/specs/index.js`：

```js
import { commentSpecs } from './comments.js'

export const ALL_SPECS = Object.freeze([...fileSpecs, ...imageSpecs, ...componentSpecs, ...styleSpecs, ...commentSpecs])
```

**spec 在模块加载时全量校验**（`validateSpecs`），声明写错会在 `import` 阶段就抛错，而不是等到用户提问时给一个奇怪的答案。校验覆盖：`name` 形态、`description` 长度、`method` 必须 GET、`path` 必须以 `/v1/` 开头、`tier`/`weight`/`project` 的取值、每个参数的 `type` 与 `description`、**路径占位符必须有对应参数**、以及 **`cache.keyBy` 必须包含全部参数**（漏一个不会报错，只会把 A 请求的响应喂给 B 请求——所以在这里就拦掉）。

**能力必须是 GET。** 写端点不该存在于本仓库：能力表里没有写能力，运行期还会在派发前断言一次（`assertReadOnly`），CI 再静态检查一遍。想加写操作的话，那是一个需要先改项目定位的讨论，不是一个 PR。

**要加投影器时**（默认 `project: 'raw'` 直出原始 payload，模型通常读不动），四个地方要一起动：

| 位置 | 加什么 |
|---|---|
| `src/core/projection.js` | 投影函数本体（这是唯一适合"写逻辑"的地方） |
| `src/core/types.js` | `ProjectorName` 联合类型 |
| `src/core/capability.js` | `KNOWN_PROJECTORS` 集合（漏了会在加载时报错，不会静默） |
| `src/core/provider.js` | `projectFor` 的 `switch` 分支 |

投影的目标是**把节点树压到模型读得起的形状**（白名单保留 + 颜色归一 + 超预算回落骨架），细节见 README「上下文管道」与 `docs/PLAN.md` §4.5。

## 3. 分层纪律

`src/core/**` 是**零宿主依赖**的：不得 `import '@deepseek-ai/*'`，不得出现 `ctx`。只有 `src/adapter/**` 允许碰 DSH。

这不是洁癖：它是**离线可测性**（测试不启动 DSH、不联网就全绿）与**依赖注入缝**（fetch / 时钟 / 睡眠都可替换，时间相关的行为因此能确定性复现）的前提。`npm run check:layering` 静态守门，而且**门禁本身有测试证明它会失败**（`test/core/layering.test.js` 故意注入违规代码）。

推论：**核心逻辑要能在没有 DSH 的进程里跑**——所以 `src/core/` 不碰 `fs`（落盘走 `spool-sink.js` 定义的接口，实现放在 adapter），也不自己 `fetch`（`http.js` 接受注入的 `fetchImpl`）。

## 4. 测试约定

- **离线、确定性**：`fetch`、时钟、睡眠都是注入的，测试不联网、不睡真实时间。`npm test` 在没有网络、没有令牌的机器上必须全绿。
- **真实数据测试需要 `.env.local`**（不入库；变量清单见 `test/fixtures/real-file.js`）。缺省时这些用例**自动跳过**——`195 条 / 181 通过 / 14 跳过`是正常状态，不是失败。手动跑：`npm run test:real`。
- **不得提交真实 fixture**：真实 fileKey、节点 id、组件名、渲染图都不要进仓库。`test/` 只用合成值，断言写成与真实名称无关的事实（例如"某个组件有 40 字符的 key""变体名能被解析成 `{Ratio: '2:3'}`"）。
- **新增合成标识符要登记**：加进 `scripts/check-secrets.mjs` 的 `SYNTHETIC_ALLOWLIST`。这是一次**需要想清楚**的动作——登记等于声明"这个值指不到任何真实对象"。
- 改到安全相关路径（脱敏、重定向、只读断言）时，请同时加一条**会失败的**回归测试——门禁的价值全在于它能红。

## 5. 提 PR 前

```bash
npm run verify     # deps 门禁 + 分层门禁 + 秘密门禁 + 全部测试，必须全绿
```

- 提交信息沿用仓库风格：`feat:` / `fix:` / `chore:` / `docs:` + 一句中文说明。
- 文档语言是中文。
- 不要在同一个 PR 里顺手改无关文件——尤其是 `scripts/check-*.mjs`（门禁）与 `.gitignore`。
- 安全问题不要开公开 Issue，走 [Security Advisory](SECURITY.md)。
