# Devin Code Scans 对照

本仓库复刻的是 Cognition 公开描述的 **Agentic MapReduce** 架构（[官方博客](https://devin.ai/blog/agentic-map-reduce)）：Plan → Shard → Map → Reduce，以及 Code Scans 的公开行为（goal 驱动、证据、发现清单、挑选后开 PR）。Devin 的内部 prompt 未公开，本实现不是逐字复制。

版本说明：本仓库的选择器为 **v2**（scope/grep/ast/graph/tool，可持久化、可试跑修订）。

## 逐项对照

| 方面 | Devin | 本仓库 | 差异 |
|---|---|---|---|
| 目标定义 | 用户给 goal，Devin 协助定义审查范围与 finding 标准 | `goal` 参数 + skill 里的固定 rubric | 范围定义由人给定，无交互式澄清 |
| Plan | planner agent 研究仓库并写 **deterministic selectors**；公开描述含 AST、编译器符号/类型、import/call-graph 遍历 | 规划员产出 scope/grep/ast/graph/tool 规则；ast 支持 ast-grep 模式与关系规则，graph 支持 cycle/orphan/layering，tool 接 knip/jscpd/test-reach/a11y | 类型感知跨文件查询与函数级调用图未做 |
| Selector 持久化 | 可审计、可版本控制、可复用 | `.code-scan/selectors/<repo>.json`（全面扫描）或 `<repo>~<模式>.json`：规则、地图、试跑统计；同模式、同 goal 复用 | 格式是本地 JSON，不是 Devin 的托管资产 |
| Shard | 规则先在全库执行，命中产生 signal；有 signal 的文件切成 focused batches | 脚本确定性执行；只有信号文件进批次；按信号数/扇入/路径排序 | 分片粒度按文件数；预算外按路径采样 |
| Map | 并行 Devin agents 调查批次，带 selector provenance | 每批一个独立上下文的审查员，信号带 selectorId/intent/行号 | 子 agent 数受 `max_concurrency` 与批次上限约束 |
| Reduce | 聚合、去重、优先级排序 | 评审长去重 + 严重度排序（每条发现完整送入、不按条数设限，只受模型上下文预算约束；合并对写入 notCovered） | 排序标准是 rubric，不是 Devin 的调优模型 |
| 扫描器接入 | 安全路径可 ingest Snyk/SonarQube/SARIF 等；非安全 Code Scans 公开文档未说明 | 非安全路径自带 knip/jscpd/madge/ast-grep/eslint jsx-a11y，无商业扫描器接入 | 未接 SARIF/Snyk 等 |
| 证据 | 发现带可核查证据 | 每条必须给 `file:line` 或命令输出；性能必须有复杂度/基准证据；审查员可把验证命令交给沙箱，在隔离容器里执行并拿回真实输出（默认开启，需要 Docker）；可选 `runtimeVerify=true` 逐条跑复现脚本 | 不做 exploit 级验证 |
| 复核 | 安全维度运行时验证可利用性；非安全类型官方未说明逐条验证 | 默认确定性接地；审查员提出的验证在容器沙箱里执行，结果只作证据补充、不改变 `verified` 的判定；runtimeVerify=true 时另有容器内运行时复现(最多 12 条) | 沙箱与复现都跑在容器里,不是 VM;沙箱输出由仓库代码自报;主机执行禁令是提示词约束,不是机制隔离 |
| 全局审查 | 公开描述中 reduce 细节未展开 | **跨批次全局评审**：重复/不一致/分层违规，新增发现同样复核 | Devin 未公开对应机制，属推断补强 |
| 增量扫描 | `Scan new commits` 只扫上次之后的提交；Automations 定时/事件 | 每次全量浅克隆重扫 | 未实现增量与内置定时（可用 ZCode Cron 外挂） |
| 扫描类型 | `/scan` 菜单 11 种类型，一次扫描只能选一种 | 13 种模式（见下节），可以组合 | 可组合是本仓库的扩展 |
| 安全 | 拆到 Security 2.0，含 sandbox 运行时验证 | `security` 模式：静态数据流规则 + 证据接地 | 没有利用验证；`notCovered` 里明示 |
| 发现 UI | 产品化 dashboard，可讨论、挑选、Dismiss | ZCode artifact 看板 + markdown 报告；挑选在对话里完成 | 无专门 UI |
| 挑选 → PR | 选中后发现自动开 PR | `/code-scan-fix` 后续任务，人工确认后开 PR | PR 不由扫描自动触发 |
| 跨仓库 | 单次最多 500 仓库 | **一次运行传多个仓库**，统一报告 | 本仓库的扩展；规模取决于本地算力 |
| 模型 | 托管 harness（含 Mythos 等） | 按阶段可配置：`/code-scan-models` 读取本机模型目录，每人保存自己的阶段映射；未配置阶段继承 run 级 `subagent_model` | 模型取决于你的 provider 和成员自己的目录 |

## 扫描类型对照

Devin 的定义取自官方文档的 Scan types 表（[docs.devin.ai/work-with-devin/code-scans](https://docs.devin.ai/work-with-devin/code-scans)，2026-11-23 核对）。每个模式启用哪些维度、每个维度的判据，都在模板的 `DIMENSIONS`/`SCAN_MODES` 两张表里。

| Devin 类型（官方定义要点） | 模式 id | 一致的部分 | 明确没做的部分 |
|---|---|---|---|
| Performance：慢路径、重复计算、错过的缓存机会 | `perf` | 同一套目标；必须给复杂度论证或基准 | 不读线上 profile |
| Database queries：N+1、多余往返、无界读取；低效/错误/不安全/不可靠的查询 | `db` | 查询调用点的静态形态全部覆盖 | 不连数据库；索引与执行计划没有 schema 或慢查询日志就不下结论 |
| Test coverage：没被测试覆盖的流程与组件 | `coverage` | test-reach 找出没有任何测试文件引用的模块，评审员判断是不是重要缺口；评审员可以提交测试命令在沙箱里执行 | 选择器本身不执行测试套件，也没有行覆盖率；「哪些测试存在」靠静态可达性，不靠运行结果 |
| Dead code：没人再用的函数、模块、开关、依赖 | `dead-code` | knip（文件/导出/依赖）+ 规则（功能开关、仅测试引用） | 符号级只支持 JS/TS |
| Code quality：让代码难以阅读、修改、保持正确的可维护性问题 | `quality` | 重复逻辑、不必要的复杂度、抽象、错误处理与边界 | 团队编码规范要写进 `goal` |
| Cleanup：不改变行为就能清理的冗余、过度构建的代码 | `cleanup` | 重复实现、单实现转发包装、重复样板 | — |
| Telemetry：需要埋点的位置；日志、指标、追踪的缺口 | `telemetry` | 失败路径、关键入口、重试与降级的缺口 | — |
| Accessibility：不符合 WCAG 的前端代码 | `a11y` | eslint + jsx-a11y 查 JSX/TSX；其他模板靠规划员规则 | 对比度、焦点顺序这类要渲染后才能确认的不做；Vue/Svelte 没有专用工具 |
| Compliance：对照本次设定的法规、标准与政策的缺口（敏感数据、审计轨迹、保留） | `compliance` | 标准由用户在 `goal` 给出；不给时按通用数据保护基线 | 不下「是否受某法规约束」的结论 |
| Migration docs：追踪端到端流程与业务逻辑，产出带图的迁移文档 | `migration` | 流程、业务规则、迁移风险、流程图；位置经过确定性核对 | 纯静态追踪，不运行代码 |
| Custom：你描述的其他目标 | `custom` | 原话作为 `goal`，规划员按它选维度 | — |

选择方式与 Devin 的 `type /scan followed by what you want to find` 一致：直接说要找什么，命令按说法选模式；什么都没说时弹出选择面板。模式由 `generate-draft.mjs --mode` 校验，不认识的词直接报错并列出可选项。

## 选择器能力边界

已做到：

- **AST**：ast-grep 模式与关系规则（`inside`/`has`/`follows`/`precedes`/`all`/`any`/`not`）
- **依赖图**：madge 模块边；脚本内 SCC 求环；扇入用于批次排序；路径前缀分层规则；测试可达性（test-reach）
- **符号级**：knip 基于 TypeScript 编译器报告未使用导出/依赖
- **重复代码**：jscpd
- **无障碍**：eslint + eslint-plugin-jsx-a11y（固定版本，装在 npm 缓存目录下的专属目录，不经 npx 启动命令；不读被扫仓库的 eslint 配置与依赖，源码里的 eslint-disable 不生效）
- **预算/修订**：每条规则有命中预算；死规则与超量规则修订一轮

未做到（明确不做）：

1. **类型感知的跨文件查询**（tsserver/scip）与**函数级调用图**
2. **生成 schema 对比**（如 Prisma schema vs 生成类型）
3. **Python/Rust/Go 工具包**（vulture/radon/cargo udeps/staticcheck）；目前只支持 ast-grep 结构信号与 grep
4. **VM 级运行时验证**:起 VM 复现漏洞、验证可利用性。容器级已实现两样:审查员的沙箱验证(默认开启)与逐条运行时复现(opt-in);两者共用同一套容器隔离。VM 与 exploit 验证仍不做
5. **专用 UI / 托管调度 / 专有模型**
6. **增量扫描**：`scan new commits` 级别的 diff 扫描

## 参考边界

- 架构来自公开博客与官方 FAQ 转述，实现为独立编写
- **未使用 the_swarm 的任何代码**（其许可证为 GPLv3 + 地理限制附录，不引入）
- Devin 的 Code Scans（非安全）与 Security 2.0 是不同产品面；本仓库对照前者。`security` 模式只是静态检查，不等同于 Security 2.0
