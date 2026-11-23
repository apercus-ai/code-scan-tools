# Devin Code Scans 对照

本仓库复刻的是 Cognition 公开描述的 **Agentic MapReduce** 架构（[官方博客](https://devin.ai/blog/agentic-map-reduce)）：Plan → Shard → Map → Reduce，以及 Code Scans 的公开行为（goal 驱动、证据、发现清单、挑选后开 PR）。Devin 的内部 prompt 未公开，本实现不是逐字复制。

版本说明：本仓库的选择器为 **v2**（scope/grep/ast/graph/tool，可持久化、可试跑修订）。

## 逐项对照

| 方面 | Devin | 本仓库 | 差异 |
|---|---|---|---|
| 目标定义 | 用户给 goal，Devin 协助定义审查范围与 finding 标准 | `goal` 参数 + skill 里的固定 rubric | 范围定义由人给定，无交互式澄清 |
| Plan | planner agent 研究仓库并写 **deterministic selectors**；公开描述含 AST、编译器符号/类型、import/call-graph 遍历 | 规划员产出 scope/grep/ast/graph/tool 规则；ast 支持 ast-grep 模式与关系规则，graph 支持 cycle/orphan/layering，tool 接 knip/jscpd | 类型感知跨文件查询与函数级调用图未做 |
| Selector 持久化 | 可审计、可版本控制、可复用 | `.code-scan/selectors/<repo>.json`：规则、地图、试跑统计；同 goal 复用 | 格式是本地 JSON，不是 Devin 的托管资产 |
| Shard | 规则先在全库执行，命中产生 signal；有 signal 的文件切成 focused batches | 脚本确定性执行；只有信号文件进批次；按信号数/扇入/路径排序 | 分片粒度按文件数；预算外按路径采样 |
| Map | 并行 Devin agents 调查批次，带 selector provenance | 每批一个独立上下文的审查员，信号带 selectorId/intent/行号 | 子 agent 数受 `max_concurrency` 与批次上限约束 |
| Reduce | 聚合、去重、优先级排序 | 评审长去重 + 严重度排序（输入上限 120 条，合并对写入 notCovered） | 排序标准是 rubric，不是 Devin 的调优模型 |
| 扫描器接入 | 安全路径可 ingest Snyk/SonarQube/SARIF 等；非安全 Code Scans 公开文档未说明 | 非安全路径自带 knip/jscpd/madge/ast-grep，无商业扫描器接入 | 未接 SARIF/Snyk 等 |
| 证据 | 发现带可核查证据 | 每条必须给 `file:line` 或命令输出；性能必须有复杂度/基准证据；可选 `runtimeVerify=true` 在容器里跑复现脚本 | 不做 exploit 级验证 |
| 复核 | 安全维度运行时验证可利用性 | 默认确定性接地；runtimeVerify=true 时另有容器内运行时复现(最多 12 条) | 复现跑在容器里,不是 VM;结论是脚本自报,不是独立证明 |
| 全局审查 | 公开描述中 reduce 细节未展开 | **跨批次全局评审**：重复/不一致/分层违规，新增发现同样复核 | Devin 未公开对应机制，属推断补强 |
| 增量扫描 | `Scan new commits` 只扫上次之后的提交；Automations 定时/事件 | 每次全量浅克隆重扫 | 未实现增量与内置定时（可用 ZCode Cron 外挂） |
| 安全 | 拆到 Security 2.0，含 sandbox 运行时验证 | 无 security 维度 | 明确不做 |
| 发现 UI | 产品化 dashboard，可讨论、挑选、Dismiss | ZCode artifact 看板 + markdown 报告；挑选在对话里完成 | 无专门 UI |
| 挑选 → PR | 选中后发现自动开 PR | `/code-scan-fix` 后续任务，人工确认后开 PR | PR 不由扫描自动触发 |
| 跨仓库 | 单次最多 500 仓库 | **一次运行传多个仓库**，统一报告 | 本仓库的扩展；规模取决于本地算力 |
| 模型 | 托管 harness（含 Mythos 等） | 按阶段可配置：`/code-scan-models` 读取本机模型目录，每人保存自己的阶段映射；未配置阶段继承 run 级 `subagent_model` | 模型取决于你的 provider 和成员自己的目录 |

## 选择器能力边界

已做到：

- **AST**：ast-grep 模式与关系规则（`inside`/`has`/`follows`/`precedes`/`all`/`any`/`not`）
- **依赖图**：madge 模块边；脚本内 SCC 求环；扇入用于批次排序；路径前缀分层规则
- **符号级**：knip 基于 TypeScript 编译器报告未使用导出/依赖
- **重复代码**：jscpd
- **预算/修订**：每条规则有命中预算；死规则与超量规则修订一轮

未做到（明确不做）：

1. **类型感知的跨文件查询**（tsserver/scip）与**函数级调用图**
2. **生成 schema 对比**（如 Prisma schema vs 生成类型）
3. **Python/Rust/Go 工具包**（vulture/radon/cargo udeps/staticcheck）；目前只支持 ast-grep 结构信号与 grep
4. **VM 级运行时验证**:起 VM 复现漏洞、验证可利用性。容器级、opt-in 的运行时复现已实现(依赖安装 + 复现脚本);VM 与 exploit 验证仍不做
5. **专用 UI / 托管调度 / 专有模型**
6. **增量扫描**：`scan new commits` 级别的 diff 扫描

## 参考边界

- 架构来自公开博客与官方 FAQ 转述，实现为独立编写
- **未使用 the_swarm 的任何代码**（其许可证为 GPLv3 + 地理限制附录，不引入）
- Devin 的 Code Scans（非安全）与 Security 2.0 是不同产品面；本仓库只对照前者，且未做安全维度
