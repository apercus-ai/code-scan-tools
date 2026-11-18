---
name: code-scan
description: 跨仓库全库扫描(质量、冗余、性能三维度),基于 Devin Agentic MapReduce 架构。适用于用户要求全库扫描、跨仓库审计、找死代码/重复代码、找性能问题、做代码质量体检的场景。
---

# Code Scan

## 何时使用

- 用户要求"扫描整个仓库/多个仓库""找死代码""找重复代码""哪里性能有问题""做一次代码质量审计"
- 不适用于:单 PR 审查(用 GitHub 审查 bot)、只看改动(用 `git diff` 流程)

## 方法(Devin Agentic MapReduce 复刻)

1. **准备**:仓库通过 `git clone --depth 1` 取到 `.code-scan/repos/<name>`,失败记录进 notCovered,不中断整次运行
2. **Plan**:每个仓库一个规划员,读结构后产出 `selectors`(选择规则)与分片文件清单;排除生成代码、vendored、构建产物
3. **Shard**:脚本对文件清单排序后按数量切块(默认每片 ≤12 个文件,每仓库 ≤4 片),**确定性、非随机**
4. **Map**:每片一个独立审查员(全新上下文),回传结构化 `Finding[]`
5. **Reduce**:评审长跨仓库去重、按严重度与影响面排序
6. **Confirm**:每条发现交给独立复核员复现;未能复现标 `unconfirmed`,不删除

## 维度与证据要求

| 维度 | 查什么 | 证据门槛 |
|---|---|---|
| 质量 `quality` | 可读性、边界处理、错误处理、一致性 | 引用具体文件行,说明为什么是问题 |
| 冗余 `dead-code` | 死代码、重复实现、未使用导出 | 优先用工具找候选(`npx knip`、`npx jscpd`),再人工复核;工具缺失只做代码阅读并在 notCovered 说明 |
| 性能 `perf` | 算法复杂度、N+1、重复 I/O、无谓分配 | **必须给复杂度论证或基准数据**,空口建议不报 |

## 严重度

- `high`:数据丢失、崩溃、错误结果
- `medium`:明显缺陷、显著性能退化、维护成本高
- `low`:风格、小优化

## 输出

- `WorkflowReport`:`conclusion` / `findings`(含 `status`)/ `verified` / `notCovered`
- 运行中实时更新发现看板(`report`),结束后发布 markdown 报告(primary artifact)
- `unconfirmed` 不等于假阳性:复核员未能复现,但值得人工看一眼

## 模型选择

- 用户指定模型时,由命令解析 `ListModels` 后作为 `subagent_model` 传入,整次扫描所有子 agent 统一使用
- 未指定则用会话默认模型
- 插件脚本内不写死模型,避免跨 provider 计费问题

## 成本与安全

- 每个分片、每条复核都是独立模型会话;大仓库先用默认分片上限,别一次扫太多仓库
- 全程只读:审查员与复核员不编辑文件;扫描不开 PR
- 要修复用 `/code-scan-fix` 后续任务
