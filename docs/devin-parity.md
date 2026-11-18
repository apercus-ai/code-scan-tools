# Devin Code Scans 对照

本仓库复刻的是 Cognition 公开描述的 **Agentic MapReduce** 架构（[官方博客](https://devin.ai/blog/agentic-map-reduce)）：Plan → Shard → Map → Reduce，以及 Code Scans 的公开行为（goal 驱动、证据、发现清单、挑选后开 PR）。Devin 的内部 prompt 未公开，本实现不是逐字复制。

## 逐项对照

| 方面 | Devin | 本仓库 | 差异 |
|---|---|---|---|
| 目标定义 | 用户给 goal，Devin 协助定义审查范围与 finding 标准 | `goal` 参数 + skill 里的固定 rubric | 范围定义由人给定，无交互式澄清 |
| Plan | planner agent 研究仓库并写 **deterministic selectors** | 规划员产出 selectors（glob/grep/tool）+ 精简仓库地图 | 规则以数据表达，不是可编译的 selector 代码 |
| Shard | **规则先在全库执行，命中代码切成 focused batches** | 脚本先全库执行 selectors，再按命中路径切批 | 分片粒度按文件数，不按语义复杂度 |
| Map | 并行 Devin agents 调查批次 | 每批一个独立上下文的审查员，`Promise.all` 并行 | 子 agent 数受批次上限约束 |
| Reduce | 聚合、去重、优先级排序 | 评审长去重 + 严重度排序（≤60 条） | 排序标准是 rubric，不是 Devin 的调优模型 |
| 扫描器接入 | 可 ingest Snyk/SonarQube/Semgrep 等既有扫描器 | 工具执行员跑 knip/jscpd/madge，候选进批次复核 | 目前接的是通用 OSS 工具，未接商业扫描器 |
| 证据 | 发现带可核查证据 | 每条必须给 `file:line` 或命令输出；性能必须有复杂度/基准证据 | 无运行时 exploit 验证 |
| 复核 | 安全维度运行时验证可利用性 | **每条发现独立复核**（Devin 公开描述未明确此项，本仓库强制） | 复核是静态复现，不起 VM |
| 全局审查 | 公开描述中 reduce 细节未展开 | **跨批次全局评审**：重复/不一致/分层违规，新增发现同样复核 | Devin 未公开对应机制，属推断补强 |
| 发现 UI | 产品化 dashboard，可讨论、挑选 | ZCode artifact 看板 + markdown 报告；挑选在对话里完成 | 无专门 UI |
| 挑选 → PR | 选中后发现自动开 PR | `/code-scan-fix` 后续任务，人工确认后开 PR | PR 不由扫描自动触发 |
| 跨仓库 | 按仓库分别配置 | **一次运行传多个仓库**，统一报告 | 本仓库的扩展 |
| 模型 | 托管 harness（含 Mythos 等） | 运行时可指定 `subagent_model` | 模型取决于你的 provider |

## 未复刻的部分（明确不做）

1. **运行时验证**：起 VM 复现漏洞、验证可利用性——需要沙箱基建，后续版本可加
2. **专用 UI**：Devin 的发现管理界面、讨论、去重状态跟踪——用 artifact/Kaneo 替代
3. **托管调度**：Devin 的云端调度与配额管理——由 ZCode Cron/OffPeak 承担
4. **专有模型**：Mythos 等——用你配置的模型
5. **可编译 selector DSL**：Devin 的 "deterministic" selector 具体形式未公开；本仓库用 glob/grep/工具规则近似

## 参考边界

- 架构来自公开博客与官方 FAQ 转述，实现为独立编写
- **未使用 the_swarm 的任何代码**（其许可证为 GPLv3 + 地理限制附录，不引入）
