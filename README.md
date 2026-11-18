# code-scan-tools

ZCode 插件：**跨仓库全库扫描**，按 Devin Code Scans 的 Agentic MapReduce 方式实现——**规划员写作用于全库的确定性选择规则（selectors），规则先在全库执行，命中项才分片复核**。另外加了 Devin 公开描述之外的逐条独立复核。

> 本仓库为团队内部私有工具仓库。安装后成员可在任意工作区用 `/code-scan` 扫描一个或多个仓库。

## 它做什么

- **全局优先**：plan→shard 之间，全库 glob/grep/工具查询先跑完，死代码、跨模块重复这类全局问题不会因分片被切碎
- **跨仓库**：一次运行可指定多个仓库（Git URL 或工作区内路径），克隆到 `.code-scan/repos/` 后逐个扫描，汇总成一份跨仓库报告
- **三维度**：质量（可读性/边界/一致性）、冗余（死代码/重复实现/未使用导出）、性能（复杂度/N+1/重复 I/O）
- **证据 + 复核**：每条发现必须引用具体文件行（性能类必须复杂度论证或基准数据）；每条发现由独立复核员复现，未能复现标 `unconfirmed`
- **全局审查**：Reduce 后追加跨批次模式审查（重复/不一致/分层违规）
- **看板 + 报告**：运行中实时更新发现看板，结束后发布 markdown 报告
- **模型可指定**：运行时指定扫描模型（`subagent_model`），默认用会话模型

## Devin 对照

| Devin Code Scans 方面 | 本仓库 | 说明 |
|---|---|---|
| 目标驱动（goal） | ✅ | 命令接受 goal，影响选择规则与复核侧重 |
| Planner 写全库规则 | ✅ | 规划员产出 `selectors`（glob/grep/tool），不是文件清单 |
| 规则先在全库执行 | ✅ | 脚本用 `files.glob`/`files.grep` 执行，命中项才进批次 |
| 确定性分片 | ✅ | 命中项按路径排序后按文件数切批，非随机 |
| 并行 Map agents | ✅ | 每批次一个独立上下文的审查员 |
| Reduce 聚合去重排序 | ✅ | 评审长去重、按严重度排序 |
| 扫描器接入 | ✅ | 工具执行员跑 knip/jscpd/madge，候选进批次复核 |
| 跨批次全局审查 | ✅ | 全局评审员找重复/不一致/分层违规 |
| 证据 + 严重度 | ✅ | 每条发现带 evidence / severity |
| 发现清单/看板 | ⚠️ | ZCode artifact 看板 + markdown 报告替代专用 UI |
| 挑选后开 PR | ⚠️ | 由 `/code-scan-fix` 后续任务实现（扫描只读） |
| 运行时漏洞验证（VM） | ❌ | 未实现，安全维度只做静态分析 |
| 托管 UI / 专有模型 | ❌ | 无，本地运行 |

## 安装

1. clone 本仓库到本地
2. ZCode → **Plugin Marketplace → Add → Add Plugin Marketplace** → 粘贴本仓库根目录（含 `marketplace.json`）
3. **Personal → dev-code-scan → code-scan → Install**
4. 在 composer 选择 `code-scan` 插件/skill，或用 `/code-scan` 命令

## 使用

### 单仓库（当前工作区）

```
/code-scan
```

### 跨仓库

```
/code-scan repos=[{name:"app",url:"git@github.com:ORG/app.git"},{name:"lib",url:"git@github.com:ORG/lib.git"}] goal="重点看性能和死代码"
```

仓库清单也可放在 `repos.json`（格式见 `examples/repos.example.json`），让 agent 读取后传入。

克隆目标固定在工作区下的 `.code-scan/repos/`（已 gitignore）。**重跑前请删除该目录**，否则 `git clone` 会因目录已存在而失败。

### 指定扫描模型

```
/code-scan repos=[...] model="GLM-5.3-Flash"
```

命令解析 `ListModels` 后作为 `subagent_model` 传给工作流——整次扫描的所有子 agent 统一使用；不指定则用会话默认模型。

### 调整分片与并发

```
/code-scan repos=[...] maxFilesPerBatch=8 concurrency=4
```

- `maxFilesPerBatch`:每批文件数(默认 8)。批次数按命中规模自动生成,**默认不设总批上限**
- `concurrency`:并发上限,传给 `CreateWorkflow` 的 `max_concurrency`(建议 4,不传则运行时自适应)
- `maxTotalBatches`(可选,默认 0 = 不限):想设全局批次预算时才用;超出会显式写进 notCovered

## 输出

- `conclusion`：结论
- `findings`：去重排序后的发现（`where` 带仓库前缀、`status` 为 verified/unconfirmed）
- `notCovered`：克隆失败、选择器超限、工具缺失、批次溢出、性能未跑基准等
- Artifact：发现看板（按严重度分列）+ markdown 报告

## 成本与安全

- 每个仓库 = 规划员 1 + 工具执行员 1;每批次 = 审查员 1;每条发现 = 复核员 1;再加评审长与全局评审员各 1
- **批次数随命中规模增长**（每批 8 个文件），成本按会话数线性上升；`max_concurrency` 只控制同时跑几个，不控制总量
- 全程只读：审查员与复核员不编辑文件；扫描不会自动开 PR
- 选择器单次命中上限 2000（超出会记录进 notCovered 而不是静默截断）

## 目录

```
code-scan-tools/
├── marketplace.json
├── code-scan/
│   ├── .zcode-plugin/plugin.json
│   ├── commands/code-scan.md
│   ├── commands/code-scan-fix.md
│   ├── skills/code-scan/SKILL.md
│   └── scripts/code-scan.ts
├── examples/repos.example.json
└── docs/
    ├── devin-parity.md
    └── rubric.md
```

## 已知限制

- 工作流脚本首次提交需过确认框（展示完整脚本），这是 ZCode 的安全设计
- `git clone` 通过 `world.run("git", ...)` 执行，确认框会列出 `git` 命令集
- 首次运行若出现编译诊断，按提示编辑脚本文件后用 `path` 重提（不要重贴脚本）
- 安全维度的"运行时验证"未实现；如需请另行加容器化验证阶段
