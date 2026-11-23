# 扫描 Rubric

修改本文件后同步更新 `code-scan/skills/code-scan/SKILL.md` 与脚本 prompt 中的对应措辞。

## 选择规则(selectors)

规划员必须产出作用于**全库**的确定性规则,而不是文件清单。每条规则包含:

`id`、`kind`、`lang`、`query`、`scope`、`target`、`exclude`、`intent`、`dimension`、`budget`

| 类型 | 用途 | 示例 |
|---|---|---|
| `scope` | 只圈定审查边界,**不产生信号** | `src/**/*.ts`、`packages/*/src/**/*.ts` |
| `grep` | 全局词法查询 | `TODO|FIXME`、`process.env.` |
| `ast` | AST 结构或关系查询 | `catch ($E) { }`、`$ARR.forEach(async ($X) => { $$$ })`;关系规则 JSON `{"rule":{"pattern":"...","inside":{"kind":"function_declaration"}}}` |
| `graph` | 依赖图规则 | `cycle`、`orphan`、`layering` |
| `tool` | 全库工具查询 | `knip`(死代码/未使用导出)、`jscpd`(重复代码) |

补充规则:

- `scope` 规则只定义边界;至少 1 条。
- `grep`/`ast`/`graph`/`tool` 至少各 1 条产生信号,否则批次没有依据。
- `ast` 的 `lang` 取 `ts|tsx|js|jsx|py|go|rust|java`;`query` 是 ast-grep 模式,或带 `rule` 的规则 JSON。
- `graph`:
  - `cycle`:用 `scope` 过滤环中文件
  - `orphan`:用 `scope` 圈候选,`target` 填入口豁免 glob(逗号分隔)
  - `layering`:`scope` 是来源 glob,`target` 是禁止依赖的目标 glob(逗号分隔)
- `exclude` 是逗号分隔的路径 glob,排除测试/生成物。
- `id` 用 ASCII,稳定且唯一;规则存档与重跑复用依赖它。

## 执行与预算

- 规则先在全库执行,**不经过 agent**:脚本用 `files.glob`/`files.grep` 和固定命令行的 ast-grep/knip/jscpd/madge。
- 规划员产出的规则数量有约束:`scope` 2–3 条,产生信号的规则合计 8–12 条;每条 grep 都是一次全库检索,靠堆规则换覆盖率不划算。
- 每条产生信号的规则有预算:`budget`(默认 200,最大 2000)。超出后按路径排序确定性采样,并把 `采样 N/M` 写进报告与 notCovered。
- 批次只按文件数切分(`maxFilesPerBatch`,默认 8),信号再多也不拆;批次提示词给出这批文件的全部信号、完整仓库地图与每条规则的判据,不截断。
- `files.glob` 超过 2000 文件、`files.grep` 超过 2000 行会失败;脚本记录为覆盖缺口,不静默截断。grep 的 2000 行上限**先于**预算生效,所以规划员必须把单条 grep 控制在 2000 行以内;脚本对该错误给出「收窄 scope」的提示,而不是当成正则写错。
- 工具输出解析失败、工具缺失、依赖未安装都会写进 notCovered;`node_modules` 缺失时 knip 的 `unlisted/unresolved/binaries` 噪声会被过滤并注明。
- 零命中的死规则与超量规则交给规划员修订一轮;修订后只执行签名变化的选择器。

## 发现的数量与字段

- 每批次审查员返回的发现不按条数设限(批次按文件数切分,信号多的批次本来就可能报得多);无法解析或缺少 where/problem 的才丢弃并记进 notCovered。
- 批次间按 `仓库+位置+问题` 先合并一次,重复项不再各起一个复核员。
- 报告不因数量丢发现:去重后按严重度排序全部保留;展示上限 200 条,超出的写进 notCovered 说明。
- 模型返回的 `severity`/`dimension` 无法识别时,分别归一到 `medium`/`quality` 并写进 notCovered;缺 `where` 或 `problem` 的发现直接丢弃并记录。

## 持久化

- 每个仓库的选择器、仓库地图、试跑统计与能力写入 `.code-scan/selectors/<repo>.json`。
- 同一 `goal` 的下次运行直接复用;`goal` 变化或 `refreshSelectors=true` 时重新规划,旧规则作为参考。
- 存档是只读扫描的唯一写操作(另有 `.code-scan/tmp/` 下的工具报告)。

## 维度

### 质量 `quality`

查:
- 可读性:命名、函数长度、嵌套深度、魔法数
- 边界处理:空值、越界、异常路径
- 一致性:与仓库现有模式冲突的写法
- 错误处理:吞异常、错误信息缺失

证据门槛:引用具体文件行,说明"为什么是问题",不接受"看起来不好"。

### 冗余 `dead-code`

查:
- 死代码:不可达分支、未使用导出/函数/类型
- 重复实现:跨模块的近似逻辑
- 未使用依赖

证据门槛:优先用工具找候选:
- JS/TS:`knip`(未使用导出/依赖)、`jscpd`(重复代码)、`madge`(循环依赖)
- Python:ast-grep 的 Python 模式可做结构信号;vulture/radon 尚未接入
- Rust/Go:暂只做 ast-grep 结构与 grep 信号

工具不可用时只做代码阅读,并在 `notCovered` 说明"未运行工具"。

### 性能 `perf`

查:
- 算法复杂度(O(n²) 循环、嵌套遍历)
- N+1 查询、循环内 I/O
- 无谓分配/拷贝、重复序列化

证据门槛:**必须给复杂度论证或基准数据**。没有证据的性能建议不报。

## 严重度

| 级别 | 标准 |
|---|---|
| `high` | 数据丢失、崩溃、错误结果 |
| `medium` | 明显缺陷、显著性能退化、维护成本高 |
| `low` | 风格、小优化 |

## 复核规则(确定性)

- 每条发现用**确定性检查**复现,不调用模型:文件存在 → 行号在范围内 → 引文在引用行附近(`QUOTE_LINE_WINDOW`=2 行)。
- 全部通过 → `verified`;任一项不成立 → `unconfirmed`(保留并注明原因,不删除)。
- 强度边界:能证明「引用的代码确实存在」,不能证明「这段代码真的有问题」——后者交给读者按 evidence/severity 判断。
- 证据里没有可核对的引文时,有行号只能算弱通过(注明「未引用可核对原文」),没有行号直接判不成立。

## 全局审查规则

全局评审员只做三件事,且新增发现 ≤5 条、必须带证据:
1. 同一逻辑在多处重复(跨批次)
2. 各批次对同一概念处理不一致
3. 分层/依赖违规(模块间不该有的依赖)
