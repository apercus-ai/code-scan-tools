---
name: code-scan
description: 跨仓库全库扫描(质量、冗余、性能三维度),按 Devin Agentic MapReduce 方式:可持久化的全库选择器(scope/grep/ast/graph/tool)先执行、信号分片复核、逐条独立确认。适用于全库扫描、跨仓库审计、找死代码/重复代码、找性能问题的场景。
---

# Code Scan

## 何时使用

- 用户要求"扫描整个仓库/多个仓库""找死代码""找重复代码""哪里性能有问题""做一次代码质量审计"
- 不适用于:单 PR 审查(用 GitHub 审查 bot)、只看改动(用 `git diff` 流程)

## 方法(选择器 v2)

1. **准备**:仓库通过 `git clone --depth 1` 取到 `.code-scan/repos/<name>`;失败记录进 notCovered,不中断整次运行。随后探测能力(npx/ast-grep/knip/jscpd/madge)。
2. **Plan(全库规则)**:每个仓库一个规划员,产出作用于全库的确定性 `selectors`:
   - `scope`:路径 glob,只圈定审查边界,**不产生信号**
   - `grep`:ripgrep 正则,命中行成为信号
   - `ast`:ast-grep 模式(如 `catch ($E) { }`)或关系规则 JSON(支持 `inside`/`has`/`follows`/`all`/`any`),按住语言选择 `lang`
   - `graph`:依赖图规则 `cycle` / `orphan` / `layering`(madge 提供模块边,环用脚本内 SCC 计算)
   - `tool`:`knip`(未使用导出/依赖)、`jscpd`(重复代码)
   同时产出精简仓库地图(模块树/职责/入口/依赖边)。
3. **试跑**:脚本在整库**确定性执行**全部选择器,不经过 agent;工具输出由脚本解析 JSON。每条选择器有 `budget`(默认 200),超出按路径确定性采样并记录。
4. **修订**:零命中的死规则与超量规则交给规划员修订一轮(只改规则,不重跑全库);修订后只执行签名变化的选择器。
5. **存档**:最终选择器与试跑统计写入 `.code-scan/selectors/<repo>.json`。同一 goal 的下次运行直接复用;`refreshSelectors=true` 时重新规划并参考旧规则。
6. **Shard(信号分片)**:只有产生信号的文件进入批次;按信号数、扇入(依赖图)、路径排序,再按文件数切批(默认每批 ≤8 个文件)。**分片的是信号文件,不是全量文件**;没有信号时才退化为按 scope + 扇入抽样(最多 200 个文件)。
7. **Map**:每批一个独立审查员,复核信号是否真问题,可整库 Grep 补充上下文;最多补 3 条信号外发现。
8. **Confirm(确定性)**:每条发现用文件系统与文本比对复现证据——文件存在、行号在范围内、引文能在引用行附近找到。不调用模型。任一项不成立标 `unconfirmed` 并注明原因,不删除。
9. **Reduce + 全局审查**:评审长去重排序;全局评审员找跨批次模式(重复/不一致/分层违规),最多新增 5 条,同样要复核。
10. **运行期复现(可选,`runtimeVerify=true`)**:merge 后先发一轮报告,再在隔离容器里按仓库安装依赖(默认 offline),为 high/medium 且证据核对通过的发现顺序执行最多 12 段复现脚本,用同一卡片 id 原位更新结果。判定只表示「脚本返回了符合断言的数据」,不是独立证明,永不自动 dismiss。

## 维度与证据要求

| 维度 | 查什么 | 证据门槛 |
|---|---|---|
| 质量 `quality` | 可读性、边界处理、错误处理、一致性 | 引用具体文件行,说明为什么是问题 |
| 冗余 `dead-code` | 死代码、重复实现、未使用导出 | 优先工具(knip/jscpd);工具缺失只做代码阅读并在 notCovered 说明 |
| 性能 `perf` | 算法复杂度、N+1、重复 I/O、无谓分配 | **必须给复杂度论证或基准数据**,空口建议不报 |

## 严重度

- `high`:数据丢失、崩溃、错误结果
- `medium`:明显缺陷、显著性能退化、维护成本高
- `low`:风格、小优化

## 输出

- `WorkflowReport`:`conclusion` / `findings`(含 `status`,真跑过复现时含 `repro`)/ `verified` / `notCovered`
- 扫描结束后发布发现看板(`report`)与 markdown 报告(primary artifact)
- 报告含选择器执行表:每条规则的命中/采样/文件数与死规则
- `unconfirmed` 不等于假阳性:确定性复现没通过(文件/行号/引文对不上),或证据没给可核对的原文;值得人工看一眼
- 复核能证明「引用的代码确实存在」,不能证明「这段代码真的有问题」;后者靠报告里的证据与 severity 由人判断
- 运行期复现的 `notReproduced` 只说「脚本未观察到预期行为」,不是「假阳性」;`unavailable` 才是没跑成(缺依赖、安装被拒、探测停用)

### 运行时复现(`runtimeVerify=true`)

- 默认关闭;关闭时**零次 docker 调用**,只在 notCovered 写一条说明
- 依赖安装默认 offline(`--network=none` + `npm ci --offline` 读本机 `~/.npm`);联网要显式 `runtimeVerifyOnline=true`
- 只接受 lockfileVersion 2/3、`resolved` 指向 `registry.npmjs.org` 且有 integrity、无任何生命周期脚本、无 workspace、无项目 `.npmrc` 的仓库
- 复现容器 `--network=none`、`--read-only`、非 root、cap-drop=ALL;仓库只读挂载,脚本只写 tmpfs
- 判定不是独立证明:脚本与仓库代码同进程,仓库代码可以干扰结果;只用于强化证据,不用于自动裁决
- 镜像未钉 digest 时功能自停用,notCovered 会给出该填的值

## 按阶段模型

- 共享脚本里没有模型 id,只有 `/* @model:<stage> */` 标记
- `/code-scan-models` 调用 `ListModels` 读取本机模型目录,按阶段弹出选择面板,保存到 `~/.zcode/code-scan-models.json`
- `/code-scan` 读取该配置,校验模型仍然存在且没有 `disabledReason`(`reasoningLevels` 里的 `disabled` 是档位名,不算禁用),用 `scripts/generate-draft.mjs` 生成一份带模型字面量的草稿,再启动工作流
- 未配置的阶段继承 run 级 `subagent_model`(来自 `model=` 参数)或会话模型
- 阶段键:`plan` / `revision` / `review` / `judge` / `global`(复核不调用模型,所以没有 `confirm` 键)
- 配置按人保存,共享插件不变;换模型跑 `/code-scan-models`,不需要改文件

## 成本与安全

- 每仓库:规划员 1(仅首次或 refresh);修订员 1(仅当有死规则/超量规则);每批次审查员 1;每发现复核员 1;另加评审长/全局评审员各 1
- **工具执行不再占 agent**:knip/jscpd/madge/ast-grep 由脚本以固定命令行执行并解析 JSON
- 批次数按信号文件数自动生成(每批 8 个文件),默认不设总批上限;并发上限用 `max_concurrency` 控制(建议 4)
- 发现数量只防病态输出:每批次硬上限 50 条、批次间先按 `仓库+位置+问题` 去重;报告不因数量丢发现(展示上限 200 条,超出的写进 notCovered);`severity`/`dimension` 的非法值会归一并记录
- 选择器默认预算 200,超出确定性采样并写进 notCovered;规划员被要求把规则控制在 8–12 条信号规则、单条 grep 命中低于 2000 行(超过是硬拒绝,预算管不到);单次工具调用受 world.run 超时约束
- 全程只读:审查员与复核员不编辑文件;扫描不开 PR。唯一工作区写入是 `.code-scan/selectors/` 下的规则存档与 `.code-scan/tmp/` 下的工具报告;草稿写在系统私有临时目录,不写工作区
- 模型配置按人保存在 `~/.zcode/code-scan-models.json`;生成的草稿在系统私有临时目录;模型 id 不写进共享脚本或仓库文件
- 草稿生成需要 Node(`scripts/generate-draft.mjs`);Node 不可用或生成失败时命令不启动扫描,不绕过生成器
- knip 固定使用 deny-all 插件配置(所有插件名 false),不读取仓库的 `knip.json/jsonc`;`knip.config.js/ts` 永不执行,并固定 no-op `--preprocessor`;发现 `pnpm-workspace.yaml` 或根 `package.json#knip` 时不运行 knip;ast-grep 用空配置并 `--custom-languages ignore`;madge 固定安全 webpack/tsconfig/require-config;所有 npx 调用经 npm 自带的 `npx-cli.js`(Windows 下用 `node` 启动,避免 `.cmd` shim 无法直接 spawn),统一 `--package <pkg> -- <tool>`(本地包的 bin 名不能改写命令),带 `--ignore-scripts` 并固定版本
- `.npmrc`/`pnpm-workspace.yaml`/工具包/`.bin` 存在性用 Node `stat`/`lstat`/`readdir` 判断(Windows 大小写不敏感、符号链接算存在),与 npm/knip 的 `stat` 语义一致;不用 `files.glob`(大小写敏感且跳过 symlink)
- npm 可能读取的 project `.npmrc`(npm 前缀目录、工作区根;home=userconfig 跳过)存在时,npx 工具 fail-closed 停用,只保留 grep;工作区及祖先目录的 `node_modules/.bin` 含固定工具同名条目(按 readdir 匹配任意扩展名,含 `.bat/.com`)、工作区根/npm 前缀/隐式 workspace 包根含同名 PATHEXT 可执行文件(如 `jscpd.bat`)或固定工具包时同样停用,防止本地二进制顶替;这些都会写入 notCovered,不得当作完整工具覆盖
- 仓库 URL 拒绝 `ext::` 与前导 `-`,git 调用强制 `protocol.ext.allow=never`;ref 拒绝非法字符,localPath 必须是工作区内相对路径;`.code-scan` 的 tmp/repos/selectors 启动时检查不是符号链接/联接,jscpd 报告写到独占临时目录
- 批次按文件数与信号量(≤60)切分,提示词每文件展示前 12 条信号;未展示部分写进 notCovered
- 要修复用 `/code-scan-fix` 后续任务
