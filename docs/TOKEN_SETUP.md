# 配置 Figma 令牌

插件要读你的设计文件，就必须拿到一个 Figma 访问令牌。这份文档是**逐步操作**：去哪拿、勾哪些 scope、怎么交给 DSH、以及到期了怎么办。

## 1. 拿一个令牌

1. 打开 [figma.com/settings](https://www.figma.com/settings) → **Security** 标签页；
2. 找到 **Personal access tokens** → *Generate new token*；
3. 填名字与有效期，**勾选下面四个只读 scope**，然后生成；
4. **立刻复制**——明文只显示这一次（见 §4）。

插件需要的只读 scope，一行照抄：

```
file_content:read, file_metadata:read, file_comments:read, file_dev_resources:read
```

| scope | 用来做什么 |
|---|---|
| `file_content:read` | 文件结构、节点子树、组件与样式映射（`file` / `file_nodes` / `components` / `component_sets` / `styles`） |
| `file_metadata:read` | `file_meta`（名字、版本、最后修改时间、你的 role） |
| `file_comments:read` | 评论。**当前 7 个能力里还没有评论能力**，这个 scope 是为后续预留的——一次勾齐，以后加能力不用重新生成令牌 |
| `file_dev_resources:read` | Dev Mode 资源（代码链接等） |

**不要勾任何写 scope**（`file_comments:write`、`file_variables:write`、`file_code_connect:write`……）。插件是只读的，勾了也用不上，只是把令牌的破坏力放大。

> **变量（Variables）不勾也不用勾**：那个 API 只在 Figma **企业版**开放，所以本插件没有 `variables` 能力——`figma_capabilities` 的能力目录里会写明，模型不会以为是自己参数没传对。

## 2. 交给 DSH（主路径）

令牌**不进配置文件**，走 DSH 凭据服务：

```yaml
# ~/.dsh/.credentials.yaml
refs:
  FIGMA_TOKEN: <把刚复制的令牌粘这里>
```

保存即生效，**不需要重启 DSH**：凭据是每次操作重新解析的，下一个请求就用新值。

插件默认读的就是这个名字（`FIGMA_TOKEN`）。要换成别的名字，在 profile 的 `cordis.patch.yml` 里加一行配置：

```yaml
- insert:
    - id: figma
      name: 'figma-mcp-dsh'
      config:
        credentialRef: MY_FIGMA_TOKEN
```

### 兜底：环境变量

CI、容器或临时试用时，可以用环境变量代替凭据文件：

```bash
export FIGMA_TOKEN=figd_xxx
```

注意：**启动环境提供的变量对凭据服务是只读的**，适合一次性场景；长期使用请写回 `~/.dsh/.credentials.yaml`。

## 3. 确认能用

让模型跑一次最便宜的能力即可（Tier 3，不消耗文件内容的额度）：

```
figma_call({ op: "file_meta", target: "https://www.figma.com/design/<key>/<name>" })
```

返回文件名字、版本与你的 role，就说明令牌通了。也可以直接粘一整条 Figma 链接——`target` 会自动解析出 fileKey 与 node id。

## 4. PAT 的三个坑

| 事实 | 后果 |
|---|---|
| **最长 90 天** | 到期即失效。请把到期日记进日历，或者改用计划访问令牌（见下） |
| **明文只显示一次** | Figma 不再提供查看，丢了只能重建 |
| **不可刷新** | 没有 refresh token 流程，不能延长，只能重新生成一个 |

**Organization / Enterprise 套餐建议改用「计划访问令牌」（Plan access token）**：有效期 1 年、**可刷新**、支持 24 小时重叠期轮换，而且天然不支持写 scope——与本插件的只读定位完全吻合。唯一代价是它不支持 `GET /v1/me`（本插件本来就不用它，自检探针走的是 `/v1/files/:key/meta`）。

## 5. 轮换与失效

**轮换**：把新令牌粘回 `~/.dsh/.credentials.yaml` 覆盖旧值，保存即可。**下一次调用自动生效**，不用重启、不用重装插件——即使旧令牌刚刚报过错，插件也会用新的凭据值重新判断（记忆的判据是凭据值的哈希，不是时间）。

**失效时会发生什么**：Figma 对无效/过期令牌返回 `401 Invalid token`。插件**不抛错**，而是返回结构化的 `token_invalid`：说明当前令牌已失效、给出"去 Figma → Settings → Security 重新生成、只读 scope、写回 `~/.dsh/.credentials.yaml`、保存即生效"的可执行步骤，并**明确授权模型主动来找你换令牌**。所以你会看到模型开口问你要新令牌，而不是收到一个语焉不详的失败。

**401 不重试**——重试不会让令牌复活，只会白烧一次额度，还会让模型误以为是暂时故障。

**`403` 是另一回事**：令牌有效，但**缺某个 scope**。Figma 的响应体是 `{"status":403,"message":"Invalid scope(s): <该令牌实际持有的全部 scope>"}`，插件据此告诉模型"你只有这几个 scope，缺的是哪个"。看到 403 就去 §1 重勾 scope 再生成一个令牌。

**`credential_error` 是第三种**：连令牌都没取到——DSH 的凭据服务在解析时**抛了异常**（`~/.dsh/.credentials.yaml` 损坏、不是合法 YAML、服务没挂载）。插件同样不抛错，而是返回结构化失败并说明"**没有向 Figma 发出任何请求**"，避免你去 Figma 那边白找原因。先确认那个文件可读且是合法 YAML，再确认条目名对得上；文件没问题就重启 DSH。它与 `unconfigured` 的区别是：后者是"服务答了：没有这个凭据"，前者是"服务没有作答"。

## 6. 顺带一提：席位与额度

Figma 的 REST 额度按**席位**给：

- **View / Collab 席位**：Tier 1 只有 **20 次/月**；
- **Full / Dev 席位**：Tier 1 是 10–20 次/**分**。

插件因此把默认限流按"最弱席位"设成 `5/min, burst 1`（别的 DSH 用户很可能是 View 席位），桶空时**排队而不是丢弃**，并把等待时长回报给模型。要调，在 profile 配置里改：

```yaml
config:
  rateLimits:
    tier1: { perMinute: 5, burst: 1 }
```

如果你的席位额度真的很小，让模型先用 `file_meta`（Tier 3）定位，再用 `file_nodes` 精确读一个子树——**不要**反复浅读整个文件。

## 7. 哪些测试需要哪些变量

仓库里的真实数据测试**默认全部跳过**：它们各自有一道环境变量门，缺变量就 skip。要跑它们，把变量写进仓库根的 `.env.local`（**不入库**），然后用：

```bash
npm run test:real     # 会加载 .env.local
```

| 变量 | 解锁的用例 | 说明 |
|---|---|---|
| `FIGMA_TOKEN` | 所有真实数据用例 | 只读令牌，见 §1 |
| `FIGMA_TEST_FILE_KEY` | `real-data` 的大部分 | 真实文件的 fileKey |
| `FIGMA_TEST_NODE_ID` | `real-data` 的大部分 | 一个真实节点 id（与上面两个一起构成那道门） |
| `FIGMA_TEST_NODE_ID_B` | 主题对照 1 条 | 同一张画板的另一主题（深/浅）节点 |
| `FIGMA_TEST_RATE_LIMIT=1` | 限流排队 1 条 | **会真的消耗额度**（连续 12 次 Tier 1） |
| `FIGMA_P1_COMPONENT_A` / `_A_NAME`、`_B` / `_B_NAME` | `p1-real-data` 的组件 2 条 | 同一组件族的两个变体，以及它们的名称 |
| `FIGMA_P1_INSTANCE_A` / `_B` | `p1-real-data` 的实例 1 条 | 使用了这些组件的实例 |
| `FIGMA_P1_STYLE` / `_NAME` / `_TYPE` | `p1-real-data` 的样式 1 条 | 一个真实样式及其名称与类型 |
| `FIGMA_P1_STYLED_NODE` | `p1-real-data` 的样式引用 1 条 | 使用了该样式的节点 |

两点必须知道：

- **`npm run verify` 不会联网。** 它跑的门禁脚本会把环境里所有 `FIGMA_*` 变量**剥掉**再启动测试（见 `scripts/check-test-counts.mjs`），并且断言"跳过数恒为 14"。所以即使你的 shell 全局导出了令牌，本地门禁也不会花掉任何额度；同时也意味着**"测试全绿"从来不代表真实数据用例跑过**。
- **不要提交真实 fileKey / 节点 id**。`.env.local` 已被 `.gitignore` 忽略，而 `npm run check:secrets` 会扫描工作树与 git 历史兜底。缺 `.env.local` 时看到 14 条 skipped 是**正常状态**，不是失败。
