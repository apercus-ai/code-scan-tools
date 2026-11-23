---
name: code-scan
description: 跨仓库全库扫描,Devin Agentic MapReduce 复刻;扫描内容按模式选择(全面/性能/数据库查询/测试覆盖/死代码/代码质量/清理/遥测/无障碍/合规/迁移文档/安全/自定义),选择器 v2 可持久化、可试跑修订,按阶段模型可配置,产出带证据与复核的发现清单
argument-hint: [扫描方向或目标] [repos=...] [goal=...] [runtimeVerify=true]
---

# /code-scan

对当前工作区或指定的一组仓库执行 MapReduce 全库扫描。先确定**扫描内容**(下面「选择扫描内容」),再走步骤。

## 选择扫描内容

用户的话就是扫描目标。按顺序判断,判定结果决定 `mode` 与 `goal`:

1. 说了某个内置方向(下表任意一列的说法) → 用该模式的 id;一句话里点了几个方向就逗号连接,如 `perf,db`。原话里其余要求放进 `goal`。
2. 没点方向,但描述了一个具体目标(“找内存泄漏”“看日志里会不会打出手机号”“检查命名约定”) → `mode=custom`,`goal`=原话。
3. 什么都没说(只有仓库名,或完全没有参数) → 用 `AskUserQuestion` 让用户选,不要替用户猜:
   - 第一问(单选,四个选项,说明文字取自 `--list-modes` 的输出):
     1. 全面扫描 (Recommended) — 代码质量 + 死代码 + 性能
     2. 性能 / 数据库查询 / 测试覆盖
     3. 死代码 / 代码质量 / 清理
     4. 无障碍 / 遥测 / 合规 / 迁移文档 / 安全
   - 选了 2–4:再问一次,选项是该组里的几个方向。
   - 用户随时可以在 Other 里直接写:某个方向、多个方向的组合,或一段自定义目标(按第 2 条处理)。
4. 说了“全面”“都扫一遍”或等价意思 → `mode=full`。

方向对照(id 与中文名都可以直接作为 `mode` 值):

| mode | 常见说法 |
|---|---|
| `full` | 全面、整体、都扫一遍 |
| `perf` | 性能、慢、卡顿、性能优化 |
| `db` | 数据库查询、N+1、SQL、查询慢、ORM |
| `coverage` | 测试覆盖、缺测试、哪些没测到 |
| `dead-code` | 死代码、没用到的代码、无用依赖、废弃开关 |
| `quality` | 代码质量、可维护性、复杂度、重复逻辑、编码规范 |
| `cleanup` | 清理、简化、过度抽象、样板代码 |
| `telemetry` | 遥测、日志缺口、可观测性、监控埋点 |
| `a11y` | 无障碍、可访问性、WCAG、键盘操作 |
| `compliance` | 合规、敏感数据、审计轨迹、数据保留;要对照的标准写进 `goal`,没给就按通用数据保护基线 |
| `migration` | 迁移文档、迁移准备、梳理流程与业务逻辑 |
| `security` | 安全、注入、漏洞(静态检查,不含利用验证) |
| `custom` | 其他任何具体目标 |

判定后在回复里用一句话说明选了哪个模式、为什么(如“你说的是 N+1,按【数据库查询】扫”)。`migration` 产出的是迁移文档而不是发现清单,汇报时按文档说明。

## 参数解析

用户可能给出:

- 无参数 → 先选扫描内容;仓库默认扫当前工作区
- `repos=[{name,url,ref}]` 或仓库 URL 列表 → 跨仓库扫描(也支持 `{name,path}` 指向工作区内目录)
- `mode="..."` → 扫描方向,见上表;可以逗号组合(`perf,db`)
- `model="..."` → **run 级默认模型**,只影响没有单独配置的阶段;按阶段配置请先用 `/code-scan-models`
- `goal="..."` → 审查侧重;合规模式在这里写要对照的标准
- `selectorBudget=200` → 每条选择器的命中上限(默认 200,最大 2000)
- `refreshSelectors=true` → 忽略 `.code-scan/selectors/` 里**该模式**的历史规则,重新规划
- `maxFilesPerBatch=8` / `maxTotalBatches=0` → 分片与全局批次预算
- (无需参数)审查员提出的验证在隔离容器里执行,**默认开启**:机器上有 Docker 才可用;没有则审查员只做静态核对,原因写进 `notCovered`
- `runtimeVerify=true` → 对核对通过的 high/medium 发现逐条执行复现脚本(默认关闭;需要 Docker daemon 与本地 context)。审查员的沙箱验证不受这个开关影响
- `runtimeVerifyOnline=true` → 安装依赖时允许联网(默认离线读本机 npm 缓存;开启后安装容器可访问任意主机)
- `concurrency=4` → 并发上限

## 步骤

1. 调用 Skill 加载 `dynamic-workflows`(工作流工具在加载前拒绝运行)。
2. 定位插件目录:模板脚本 `scripts/code-scan.ts`、草稿生成器 `scripts/generate-draft.mjs`、模型选择命令 `commands/code-scan-models.md`。
3. 按「选择扫描内容」确定 `mode` 与 `goal`。需要可选方向的名单与说明时运行(不写草稿):
   ```
   node "<插件目录>/scripts/generate-draft.mjs" --template "<插件目录>/scripts/code-scan.ts" --list-modes
   ```
   每行 `mode: <id> | <中文名> | <一句话说明>`。
4. 读取并校验按阶段模型配置:
   - 解析用户 home:`Bash("node -e \"process.stdout.write(require('os').homedir())\"")`(得到 `C:\Users\...` 这类原生路径)。配置路径 `<home>/.zcode/code-scan-models.json`。
   - 文件不存在:用 `AskUserQuestion` 问用户"现在按阶段选模型,还是本次全部继承?"。
     - 选"现在按阶段选":读取 `<插件目录>/commands/code-scan-models.md` 并按其步骤执行(会把选择写入配置);完成后回到本步骤重新读取并校验。如果用户中途取消,按"本次全部继承"继续,不要反复弹窗。
     - 选"本次全部继承":继续,并在结果里注明未配置阶段模型。
   - 文件存在:读取 JSON。只允许键 `plan`、`revision`、`review`、`judge`、`global`;值必须是非空字符串。`confirm`、`globalConfirm` 是旧版本的键(复核已改为确定性检查,不再调用模型),出现时忽略并提示用户可从配置里删掉。JSON 非法、键未知或值类型不对:停止,提示重跑 `/code-scan-models`。
   - 对每个已配置的 id 调用 `ListModels` 校验:必须存在且没有 `disabledReason` 字段(`reasoningLevels` 里的 `disabled` 是档位名,不算禁用)。任何一个失效:停止,提示重跑 `/code-scan-models`;不要静默丢弃或改用别的模型。
5. 生成带模型字面量的草稿:
   - 有配置时运行(`--mode` 的值就是第 3 步判定的模式 id;多个方向用逗号连接):
     ```
     node "<插件目录>/scripts/generate-draft.mjs" \
       --template "<插件目录>/scripts/code-scan.ts" \
       --config "<home>/.zcode/code-scan-models.json" \
       --mode "<模式 id>"
     ```
     没有配置时省略 `--config`;`mode=full` 时省略 `--mode`。
   - 生成器在**每用户私有的系统临时目录**创建草稿(不在工作区),输出 `draft: <绝对路径>`,以及 `mode:`、`modeLabel:`、`dimensions:` 三行。记下草稿路径,后续 `CreateWorkflow` 用它;`mode:` 行的值原样作为 `args.mode` 传入。
   - 检查退出码为 0、该路径存在、`grep -c "@model:" "<草稿路径>"` 为 0。所有 Bash 检查都给草稿路径加双引号(Windows 用户名/TEMP 可能含空格或 `&`)。`node` 不可用或生成失败:停止并说明原因,不要绕过生成器直接跑模板脚本。生成器报「未识别的扫描方向」时,把错误里的可选名单告诉用户并让用户重选,不要自行替换成别的模式。
   - 草稿是系统私有临时文件;不要修改共享模板,也不要让用户手动编辑草稿。
6. 解析其余参数:
   - `model`:若用户给了 `model="..."`,先调用 `ListModels` 解析成完整 `providerId/modelId`(可带 `$level`)。裸名只在会话 provider 内解析;跨 provider 必须用完整 id。解析失败就停止并列出可用模型;解析结果作为 `subagent_model`。
   - `repos`:JSON 数组,元素为 `{ "name": "...", "url": "...", "ref": "..." }`,或 `{ "name": "...", "path": "工作区内相对路径" }`;也可直接给 `"owner/repo"` 字符串(按 https URL 处理)。用户没给就用当前工作区。
   - `concurrency`:若用户指定并发上限(如 `concurrency=4`),作为 `max_concurrency` 传入——**这是唯一正确的限流方式**;用户没要求就不要传(运行时自适应);不要用批次上限来限流。
   - `selectorBudget`、`refreshSelectors`、`maxFilesPerBatch`、`maxTotalBatches`:原样转成数字/布尔值传入。
   - `runtimeVerify`、`runtimeVerifyOnline`:**只在用户明确要求时传 `true`**;默认不传(等于关闭逐条复现;沙箱探测不受它影响,有 Docker 的机器上会调用 docker)。不要替用户判断要不要开。
   - `goal`:字符串,原样传入;`custom` 必须有 `goal`(用户描述的目标),没有 `goal` 的 `custom` 退回第 3 步问清楚。
7. 调用 `CreateWorkflow`:
   ```
   CreateWorkflow({
     name: "跨仓库全库扫描",
     path: "<草稿路径>",
     args: {
       mode: "<模式 id>",
       repos: [...],
       goal: "...",
       maxFilesPerBatch: 8,
       maxTotalBatches: 0,
       selectorBudget: 200,
       refreshSelectors: false,
       runtimeVerify: false,
       runtimeVerifyOnline: false
     },
     subagent_model: "<run 级模型>",   // 仅当用户给了 model=;已解析为完整 id
     max_concurrency: 4                // 仅当用户指定并发时
   })
   ```
   `subagent_model` 只作为未配置阶段的兜底;已配置阶段使用草稿里的模型字面量。
   用户确认后运行在后台;不要轮询,等完成通知。
8. 汇报结果:
   - `conclusion`
   - `findings`(按严重度;`status` 为 verified/unconfirmed;带 `repro` 字段时是运行期复现结论;`where` 带仓库名前缀)。`migration` 模式没有发现清单:改为说明「迁移文档」产物(端到端流程、业务规则、迁移风险、流程图)与 `verified` 里的位置核对数字。
   - `verified`(第一行是本次模式与覆盖的维度;然后是仓库数、信号数、批次数、外部工具;沙箱执行的次数与结果;开了 runtimeVerify 时还有复现条数与成立数)
   - `notCovered`(本次模式**没有扫描的维度**、克隆失败、选择器采样/死规则、工具缺失、依赖未安装、批次溢出、沙箱不可用、运行时复现未运行/安装被拒/跳过;`security` 模式有「未做利用验证」的说明,要转述)
   - Artifact:发现看板 + markdown 报告(含选择器执行表);`migration` 模式是迁移文档
   - 另说明本次哪些阶段用了配置模型、哪些继承。
9. 说明选择器复用:每个模式各有一份规则存档,同 `goal` 重跑会直接复用(全面扫描是 `.code-scan/selectors/<repo>.json`,其他模式是 `<repo>~<模式>.json`);需要重新规划时用 `refreshSelectors=true`。
10. 说明改模型用 `/code-scan-models`;配置在 `<home>/.zcode/code-scan-models.json`,不需要改共享脚本。
11. 扫描只读,不要修改任何仓库文件。用户要求修某几条发现时,改用 `/code-scan-fix`。
12. 开了 `runtimeVerify` 时说明:结论是脚本自报(不是独立证明),`notReproduced` 只表示「脚本未观察到预期行为」;镜像已按 digest 钉死,若 daemon 未运行功能会静默降级并写进 notCovered。
13. 转述 `verified` 里「沙箱执行」一行给出的次数与结果(正常结束/非零退出/超时/未能执行),并原样转述**执行边界**:子代理被禁止在主机上执行仓库代码,但这是提示词约束、不是机制隔离,报告不能当作「主机上没有执行过仓库代码」的证明。沙箱不可用时说明审查员没有执行验证。

## 规则

- 模型配置按人保存;不要把模型 id 写进仓库文件或提交。
- 生成草稿是本次运行的脚本,确认框展示的就是它;不要改为直接提交共享模板。
- 草稿在每用户私有的系统临时目录;不要复用旧草稿,每次运行重新生成。
