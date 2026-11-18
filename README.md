# code-scan-tools

ZCode 插件：**跨仓库全库扫描**，复刻 Devin Code Scans 的 Agentic MapReduce 架构（Plan → Shard → Map → Reduce），补充了 Devin 没有的**逐条发现独立复核**。

> 本仓库为团队内部私有工具仓库。安装后成员可在任意工作区用 `/code-scan` 扫描一个或多个仓库。

## 它做什么

- **跨仓库**：一次运行可指定多个仓库（Git URL 或工作区内路径），克隆到 `.code-scan/repos/` 后逐个扫描，汇总成一份跨仓库报告
- **三维度**：质量（可读性/边界/一致性）、冗余（死代码/重复实现/未使用导出）、性能（复杂度/N+1/重复 I/O）
- **带证据**：每条发现必须引用具体文件行，性能类必须给复杂度论证或基准数据
- **逐条复核**：每条发现由独立复核员复现，未能复现的标 `unconfirmed`（不删除）
- **看板 + 报告**：运行中实时更新发现看板，结束后发布 markdown 报告
- **模型可指定**：运行时可指定扫描模型（`subagent_model`），默认用会话模型

## Devin 对照

| Devin Code Scans 方面 | 本仓库 | 说明 |
|---|---|---|
| 目标驱动（goal） | ✅ | 命令接受 goal 参数，影响审查侧重 |
| Planner 研究仓库、写规则 | ✅ | 规划员 agent 产出 `selectors` + 分片文件清单 |
| 确定性分片 | ✅ | 文件按路径排序后按数量切块，非随机 |
| 并行 Map agents | ✅ | 每分片一个独立上下文的审查员 |
| Reduce 聚合去重排序 | ✅ | 评审长去重、按严重度排序 |
| 证据 + 严重度 | ✅ | 每条发现带 evidence / severity |
| 发现清单/看板 | ⚠️ | 用 ZCode artifact 看板 + markdown 报告替代专用 UI |
| 挑选后开 PR | ⚠️ | 由 `/code-scan-fix` 后续任务实现（扫描本身只读） |
| 运行时漏洞验证（VM） | ❌ | 未实现，安全维度只做静态分析 |
| 托管 UI / 专有模型 | ❌ | 无，本地运行 |

## 安装

1. clone 本仓库到本地
2. ZCode → **Plugin Marketplace → Add → Add Plugin Marketplace** → 粘贴本仓库根目录（含 `marketplace.json`）
3. **Personal → dev-code-scan → code-scan → Install**
4. 在 composer 选择 `code-scan` 插件/skill，或用 `/code-scan` 命令

安装后成员可随时更新：Settings → Plugins → 更新（版本号在 `plugin.json`）。

## 使用

### 单仓库（当前工作区）

```
/code-scan
```

不传仓库列表时，扫描当前工作区的仓库。

### 跨仓库

```
/code-scan repos=[{name:"app",url:"git@github.com:ORG/app.git"},{name:"lib",url:"git@github.com:ORG/lib.git"}] goal="重点看性能和死代码"
```

或先把仓库清单写进 `examples/repos.example.json` 风格的 `repos.json`，让 agent 读取后传入。

克隆目标固定在工作区下的 `.code-scan/repos/`（已加入 `.gitignore`），运行前可删除该目录获得干净副本。

### 指定扫描模型

```
/code-scan repos=[...] model="GLM-5.3-Flash"
```

命令会把模型名解析为 `ListModels` 中的 id，并作为 `subagent_model` 传给工作流——**整次扫描的所有子 agent 都用这个模型**。不指定则用会话默认模型。

## 输出

- `conclusion`：一两句话结论
- `findings`：去重排序后的发现（`where` 带仓库名前缀、`status` 为 verified/unconfirmed）
- `notCovered`：没覆盖的部分（克隆失败的仓库、工具缺失、性能未跑基准等）
- Artifact：发现看板（按严重度分列）+ markdown 报告

## 成本与安全

- 每个分片、每条发现的复核都是独立模型会话；默认每仓库最多 4 个分片、每分片最多 12 条发现
- 全程只读：审查员与复核员不编辑文件；扫描不会自动开 PR
- 克隆的仓库进入 `.code-scan/repos/`，请勿提交
- 第三方 skill/插件安装前请审阅 SKILL.md 与脚本（供应链风险自担）

## 目录

```
code-scan-tools/
├── marketplace.json            # 本地市场
├── code-scan/
│   ├── .zcode-plugin/plugin.json
│   ├── commands/code-scan.md   # 扫描入口
│   ├── commands/code-scan-fix.md
│   ├── skills/code-scan/SKILL.md
│   └── scripts/code-scan.ts    # MapReduce 工作流
├── examples/repos.example.json
└── docs/
    ├── devin-parity.md
    └── rubric.md
```

## 已知限制

- 工作流脚本首次提交需过确认框（展示完整脚本），这是 ZCode 的安全设计
- `git clone` 在脚本里通过 `world.run("git", ...)` 执行，确认框会列出 `git` 命令集
- 首次运行若出现编译诊断，按提示编辑脚本文件后重提（`CreateWorkflow` 的 `path` 重新提交，不要重贴脚本）
- 安全维度的"运行时验证"未实现；如需请另行加容器化验证阶段
