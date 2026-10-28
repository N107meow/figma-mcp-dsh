[中文](./README.md) | [English](./README_EN.md)

# figma-mcp-dsh

`figma-mcp-dsh` 是一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的只读 Figma 插件。它让模型读取设计文件结构、颜色、字体、组件和样式，并把指定画板渲染成当轮可见的图片。

## 核心功能

这个插件专注于让模型理解设计稿，同时避免修改云端文件：

- 读取 Figma 文件、页面和节点结构
- 提取颜色（含渐变的各个色标）、字体层级、布局和尺寸信息
- 识别自动布局的对齐与换行、遮罩、旋转角度——避免模型对倾斜或被裁剪的图层得出错误结论
- 识别本地组件、组件集、变体和样式
- 将指定 Frame 导出为图片，并作为图片内容返回给模型
- 自动限制读取深度，避免大型文件占满模型上下文
- 在结果过大时返回摘要，并把完整结果保存到本地
- 处理限流、令牌失效和权限不足等常见问题

## 环境要求

- **DeepSeek Harness ≥ 0.2.0-rc.2**。已实测：桌面 App `0.2.1-rc.3`、Web 版 `0.2.1-rc.2` 与 `0.2.0-rc.2`。**DSH 0.1.x 请继续用 `figma-mcp-dsh@0.1.3`**，不要升级到 0.2.0。
- Node.js 20 或更高版本
- `pnpm`（用 CLI 安装时需要；桌面 App 的插件页使用自带 pnpm）
- 具有目标文件访问权限的 Figma Personal Access Token（PAT）

Figma 令牌需要以下只读权限：

```text
file_content:read
file_metadata:read
file_comments:read
file_dev_resources:read
```

## 安装与配置

> **插件以 bundle 形式发布**：装进 profile 后自动挂载，**新安装不再需要手工改 `cordis.patch.yml`**。
>
> **两个 edition 的 profile 相互独立**：桌面 App 固定用 `desktop`，`dsh web` 默认用 `web`；插件装进哪个 profile，就只对哪个 edition 生效。**两个都用，就各装一次。**

### 1. 安装到桌面版

桌面 App → **Settings → Plugins → Add plugin** → 输入 `figma-mcp-dsh` → **Install / Enable**；提示重启就重启。

装完就是启用状态：插件管理器会把 `figma-mcp-dsh` 写进 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`，再由包内的 `cordis.patch.yml` 插入 `figma` 行。

### 2. 安装到 Web 版

`dsh web` 的 **Plugins** 页面走同一个入口；或者用 CLI：

```bash
dsh plugin --profile web add figma-mcp-dsh
```

装完同样会自动进 `dsh.profile.bundles`，重启（或等热载）即可。

### 3. 其它安装方式

#### 从 GitHub 安装

```bash
dsh plugin --profile web add github:N107meow/figma-mcp-dsh
```

GitHub 路径也走 plugin manager，因此同样会自动加 bundle。

#### 只装依赖（不推荐）

```bash
cd ~/.dsh/profiles/web
pnpm add figma-mcp-dsh          # 或 pnpm add github:N107meow/figma-mcp-dsh
```

`pnpm add` **只装依赖、不会把包选进 `dsh.profile.bundles`**，插件不会被挂载。确实要这样装，必须再手动把 `"figma-mcp-dsh"` 加到该 profile `package.json` 的 `dsh.profile.bundles` 数组里。

#### 本地开发（`link:`）

```bash
cd ~/.dsh/profiles/web
pnpm add link:/absolute/path/to/figma-mcp-dsh
```

`link:` 是开发路径，同样不会自动加 bundle：请按 §4 手动补那一行（旧版行为，继续可用）。本地开发还需要在插件仓库里装与当前 DSH 版本一致的宿主依赖，`npm run check:deps` 会检查。

### 4. 确认已挂载（含手动兜底）

```bash
dsh --profile web --dump-config | grep -A2 -- "- id: figma"
```

能看到 `- id: figma` / `name: figma-mcp-dsh` 就对了。

**手动兜底**（旧版安装、`link:` 开发，或自动加 bundle 失败时）：在 `~/.dsh/profiles/<name>/cordis.patch.yml` 追加

```yaml
- insert:
    - id: figma
      name: figma-mcp-dsh
```

> 如果 bundle 已经在 `dsh.profile.bundles` 里，再加这一行会产生同 id 的重复项：实测不报错（后者生效），但应当把重复项删掉。

### 5. 配置 Figma 令牌

在 `~/.dsh/.credentials.yaml` 中保存令牌：

```yaml
refs:
  FIGMA_TOKEN: your_figma_token_here
```

你也可以通过环境变量 `FIGMA_TOKEN` 提供令牌。插件会在每次调用时重新读取凭据，因此更换令牌后不需要重启 DSH。

#### 三步拿到令牌

**① 打开设置** —— 点 Figma 左上角**你的头像**，在菜单里选 **设置**（Settings）。

![点头像 → 设置](https://cdn.jsdelivr.net/gh/N107meow/figma-mcp-dsh@8ca5f60632bb3e2cd9f664809023ec81041f5dc7/docs/images/token-1-open-settings.png)

**② 切到「安全」标签页** —— 在设置对话框顶部选 **安全**（Security），找到 **个人访问令牌**（Personal access tokens），点 **生成新的令牌**（Generate new token）。

![设置 → 安全 → 个人访问令牌 → 生成新的令牌](https://cdn.jsdelivr.net/gh/N107meow/figma-mcp-dsh@8ca5f60632bb3e2cd9f664809023ec81041f5dc7/docs/images/token-2-security-tab.png)

**③ 填名称、选有效期、勾只读 scope** —— 名字取个以后认得出的（例如 `dsh-figma-readonly`）；有效期建议选 `90 days`（个人访问令牌最长就是 90 天）；**只勾下面四个只读 scope**，不要勾任何 write，然后点 **Generate token**。生成后**立刻复制**——明文只显示这一次。

![填写名称、有效期，并勾选只读 scope](https://cdn.jsdelivr.net/gh/N107meow/figma-mcp-dsh@8ca5f60632bb3e2cd9f664809023ec81041f5dc7/docs/images/token-3-token-form.png)

> 截图是中文界面，括号里是英文界面下的对应字样。完整版（scope 逐条说明、轮换与失效排查）见 [Figma 令牌配置指南](./docs/TOKEN_SETUP.md)。

### 6. 升级与从 0.1.x 迁移

**升级**：

```bash
dsh plugin --profile <name> update figma-mcp-dsh
```

> ⚠️ **升级不一定自动进 bundles**：插件管理器只在“新装”时把这个包选进 `dsh.profile.bundles`；依赖已经存在时，`reconcile` 不会把它当成新 bundle。升级后请按 §4 确认一次。

**从 0.1.x 迁移（顺序很重要）**：

1. 先确认新版本已装好，并**确认** `figma-mcp-dsh` 已经在 `dsh.profile.bundles` 里（不在就重新安装一次，或在 profile `package.json` 的 `dsh.profile.bundles` 数组末尾补 `"figma-mcp-dsh"`，保留已有项）；
2. **确认之后**，再从 `cordis.patch.yml` 里删掉 0.1.x 时代手工加的 `figma` 行。

顺序反了会出现“装了但没挂载”的短暂状态。

**版本门槛**：`0.2.0` 需要 DSH `>= 0.2.0-rc.2`；DSH 0.1.x 用户请留在 `figma-mcp-dsh@0.1.3`。

**两个版本都能从 GitHub 装**（各自对应的 tag）：

```bash
# 新版（bundle，自动挂载）
dsh plugin --profile web add github:N107meow/figma-mcp-dsh#v0.2.0

# 旧版（0.1.x 用户；普通插件，装完按 §4 手动补 patch 行）
dsh plugin --profile web add github:N107meow/figma-mcp-dsh#v0.1.3
```

> **插件与 DSH 版本必须匹配。** DSH 会校验插件的 `peerDependencies`，不匹配时**安装会被直接拒绝**（`installation rejected: … is incompatible with dsh …`）。看到这条提示说明版本选错了——选对版本即可，不要用 `dsh plugin allow-version` 绕过：那是给“已知不兼容但接受风险”用的。

**令牌是全局的**：`~/.dsh/.credentials.yaml` 由两个 edition 共享，只需要配一次；只有使用自定义 `DSH_HOME` 时才需要各配一份。

## 使用示例

安装完成后，在 DSH 对话中粘贴 Figma 文件或节点链接，并直接描述你想了解的内容。例如：

```text
分析这个 Figma Frame 的布局、主要颜色和字体层级：
https://www.figma.com/design/your_file_key/project?node-id=12-345
```

模型会根据任务选择合适的读取能力。你也可以明确要求模型执行以下操作：

```text
读取这个文件中定义的组件和变体。
把 node 101:202 渲染成图片并分析视觉层级。
列出这个设计文件中的颜色样式和文字样式。
```

插件在模型侧注册两个工具：

| 工具 | 用途 |
| --- | --- |
| `figma_capabilities` | 查看可用能力；传入 `detail="full"` 可获取完整参数说明 |
| `figma_call` | 执行具体读取操作；使用 `op` 选择能力，使用 `target` 传入 Figma 链接 |

工具调用示例：

```javascript
figma_call({
  op: "file_nodes",
  target: "https://www.figma.com/design/your_file_key/project?node-id=12-345",
})
```

## 支持的 7 个能力

所有能力都使用 Figma 的只读接口，不会修改设计文件。

| `op` | 用途 | 限流档位 |
| --- | --- | --- |
| `file_meta` | 读取文件名、版本、更新时间和当前角色 | Tier 3 |
| `file` | 读取页面和顶层 Frame 结构 | Tier 1 |
| `file_nodes` | 按 node id 读取一个或多个节点子树 | Tier 1 |
| `image_render` | 将指定节点导出为图片并返回给模型 | Tier 1 |
| `components` | 列出当前文件定义的组件和变体 | Tier 1 |
| `component_sets` | 列出当前文件定义的组件集 | Tier 1 |
| `styles` | 列出填充、文字、效果和网格样式 | Tier 1 |

`file_nodes` 是分析单个页面或 Frame 时的推荐入口。如果链接包含 `node-id`，插件会自动解析节点，并在未指定深度时使用 `depth=2`。

## 安全与隐私

只读和凭据保护属于插件的架构约束：

- 能力表只声明 `GET` 请求，派发前会再次检查请求方法
- 插件禁止自动跟随重定向，避免令牌被发送到非 Figma 域名
- 下载 Figma 签名图片地址时不会携带 Figma 令牌
- 日志和错误结果会隐藏已知凭据
- 大型结果与渲染图片保存在本地 `.figma/`，该目录不会进入 Git
- `.env.*`、`.credentials.yaml` 和录制数据目录已被 Git 忽略
- `npm run check:secrets` 会扫描待提交文件和 Git 历史中的令牌与私有标识符

请勿把真实 Figma 令牌、私有文件链接或导出的设计内容提交到仓库。

## 常见问题

以下问题涵盖安装和使用过程中最常见的错误与行为。

### 为什么插件提示 `unconfigured`？

插件没有读取到 `FIGMA_TOKEN`。请检查 `~/.dsh/.credentials.yaml` 或当前进程的环境变量。

### 为什么插件提示 `token_invalid`？

令牌已经过期或被撤销。创建新令牌并替换原值，下一次调用会自动使用新凭据。

### 为什么插件提示 `credential_error`？

DSH 的**凭据服务本身**在解析令牌时失败了（凭据文件损坏、不是合法 YAML、服务未挂载），所以插件根本没有发出请求。这与 `unconfigured` 不同：那不是"服务答了没有令牌"，而是"服务没有作答"。先确认 `~/.dsh/.credentials.yaml` 可读且是合法 YAML，再确认它确有你要的那个条目；文件没问题就重启 DSH。

### 为什么插件提示 `forbidden_scope`？

令牌缺少所需权限。重新创建令牌，并启用环境要求中列出的四个只读 scope。

### 为什么请求需要等待？

插件使用保守的默认额度保护 Figma API 配额。额度不足时，请求会排队而不是被丢弃；收到 `429` 后，插件会根据响应头调整限流参数。

### 为什么没有 Variables 能力？

Figma Variables API 仅向 Enterprise 组织开放，并要求额外权限。插件当前不提供该能力。

### 结果太大时会发生什么？

插件会先缩小读取深度并重试一次。如果结果仍然过大，它会返回结构摘要，并将完整结果写入本地 `.figma/` 目录。

### 图片保存在哪里？

渲染图片保存在 `.figma/images/`，同时写入 DSH 附件存储，并作为图片内容返回给当前对话。

### 如何验证本地开发版本？

在仓库根目录运行：

```bash
npm run verify
```

该命令检查宿主依赖、只读分层、敏感信息和测试套件。

本项目采用 [MIT License](./LICENSE)。欢迎通过 [Issues](https://github.com/N107meow/figma-mcp-dsh/issues) 报告问题。本项目与 Figma 无隶属关系，也未获得 Figma 官方背书。
