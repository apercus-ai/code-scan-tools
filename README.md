# code-scan-tools

ZCode 插件：**跨仓库全库扫描**，按 Devin Code Scans 的 Agentic MapReduce 方式实现。核心是**选择器 v2**：规划员写作用于全库的确定性规则（scope/grep/AST/依赖图/工具），脚本在全库确定性执行，只有产生信号的文件才分片复核；规则可持久化、可复用、可审计。**扫描内容按模式选择**：全面扫描、性能、数据库查询、测试覆盖、死代码、代码质量、清理、遥测、无障碍、合规、迁移文档、安全，或自定义目标——与 Devin `/scan` 菜单上的类型一一对应。

> 本仓库为团队内部私有工具仓库。安装后成员可在任意工作区用 `/code-scan` 扫描一个或多个仓库。

## 它做什么

- **全库规则先行**：plan→shard 之间，脚本用 glob/grep/ast-grep/knip/jscpd/madge 在整库跑完规则，死代码、跨模块重复、循环依赖这类全局问题不靠分片运气
- **AST 与关系查询**：ast-grep 模式（空 catch、循环内 await、forEach 异步…）与规则 JSON（`inside`/`has`/`follows`/`all`/`any`）都能作为选择器
- **依赖图规则**：madge 模块边 + 脚本内 SCC：`cycle`、`orphan`、`layering`
- **工具候选**：knip（未使用导出/依赖）、jscpd（重复代码）、test-reach（没有被任何测试文件引用的模块）、a11y（eslint + jsx-a11y 查 JSX/TSX 的无障碍缺陷）由脚本执行并解析输出，不再经过 agent
- **信号分片**：只有产生信号的文件进入批次；按信号数、扇入、路径排序后按文件数切批
- **预算与采样**：每条选择器默认上限 200 条命中，超出按路径确定性采样并记录；批次按文件数与信号量（≤60）切分，提示词每文件展示前 12 条信号，未展示部分写进 notCovered
- **试跑与修订**：全库试跑后，零命中的死规则与超量规则交规划员修订一轮
- **规则持久化**：选择器、仓库地图、试跑统计写入 `.code-scan/selectors/<repo>.json`（全面扫描）或 `<repo>~<模式>.json`（其他模式）；同模式、同 goal 重跑直接复用
- **跨仓库**：一次运行可指定多个仓库（Git URL 或工作区内路径），汇总成一份跨仓库报告
- **扫描模式**：13 种模式对应 Devin `/scan` 菜单的 11 种类型（另加全面扫描与安全）。模式决定启用哪些维度；每个维度的「找什么」与「什么才算真问题」只写在模板的 `DIMENSIONS` 注册表里，直接进规划员与评审员的提示词。没选的维度会在 `notCovered` 里逐个点名——那是「没看」，不是「看了没问题」
- **迁移文档模式**：产出文档而不是发现清单——逐批追踪端到端流程与业务规则，每个「路径:行号」做确定性核对，流程图由代码按核对通过的步骤生成
- **证据 + 复核**：每条发现必须引用具体文件行（性能类必须复杂度论证或基准数据）；每条发现由确定性检查复现证据——文件存在、行号在范围内、引文能在引用行附近找到——不花模型调用，未通过标 `unconfirmed`
- **全局审查**：Reduce 后追加跨批次模式审查（重复/不一致/分层违规）
- **看板 + 报告**：扫描结束后发布发现看板与 markdown 报告（含选择器执行表）
- **按阶段模型**：`/code-scan-models` 用 `ListModels` 读取本机模型目录，按阶段选择并保存为每人自己的配置；`/code-scan` 读取配置生成带模型字面量的草稿，未配置的阶段继承 run 级 `model=`/会话模型

## Devin 对照

| Devin Code Scans 方面 | 本仓库 | 说明 |
|---|---|---|
| 目标驱动（goal） | ✅ | 命令接受 goal，影响选择规则与复核侧重 |
| Planner 写全库规则 | ✅ | 规划员产出 `selectors`（scope/grep/ast/graph/tool），不是文件清单 |
| 规则先在全库执行 | ✅ | 脚本确定性执行；工具输出由脚本解析 |
| selector 可审计/可复用 | ✅ | `.code-scan/selectors/<repo>.json`；同 goal 复用，可人工审阅 |
| AST / 符号 / 依赖图查询 | ⚠️ | AST 与依赖图已支持；符号级靠 knip（TS）；类型感知跨文件查询、函数级调用图未做 |
| 确定性分片 | ✅ | 只有信号文件进批次；按信号数/扇入/路径排序 |
| 并行 Map agents | ✅ | 每批次一个独立上下文的审查员 |
| Reduce 聚合去重排序 | ✅ | 评审长去重、按严重度排序 |
| 扫描器接入 | ⚠️ | 接 knip/jscpd/madge/ast-grep/eslint jsx-a11y；未接商业扫描器（Snyk/SonarQube 等） |
| 扫描类型（`/scan` 菜单） | ✅ | 菜单上的 11 种类型都有对应模式；`migration` 产出迁移文档；可组合多个方向（Devin 一次只能选一种） |
| 跨批次全局审查 | ✅ | 全局评审员找重复/不一致/分层违规 |
| 证据 + 严重度 | ✅ | 每条发现带 evidence / severity |
| 发现清单/看板 | ⚠️ | ZCode artifact 看板 + markdown 报告替代专用 UI |
| 挑选后开 PR | ⚠️ | 由 `/code-scan-fix` 后续任务实现（扫描只读） |
| 增量扫描 | ❌ | 每次全量浅克隆；`scan new commits` 未实现 |
| 运行时漏洞验证（VM） | ❌ | 未实现；`security` 模式只做静态数据流规则与证据接地，不含利用验证 |
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

### 选择扫描内容

直接说要扫什么，方向可以组合：

```
/code-scan 性能
/code-scan 找 N+1 查询
/code-scan perf,db repos=[{name:"app",path:"services/app"}]
/code-scan 合规 goal="对照 GDPR:敏感数据的收集、存储、日志与删除"
/code-scan 迁移文档
/code-scan 日志里会不会打出手机号
```

- 点了内置方向（性能 / 数据库查询 / 测试覆盖 / 死代码 / 代码质量 / 清理 / 遥测 / 无障碍 / 合规 / 迁移文档 / 安全）→ 对应模式，id 或中文名都可以
- 描述了一个具体目标（「找内存泄漏」「日志里会不会打出手机号」）→ 自定义模式，原话作为 `goal`
- 什么都没说 → 弹出选择面板；Devin 菜单之外还有「安全」和「全面扫描（质量 + 死代码 + 性能）」
- `migration`（迁移文档）只能单独运行，产出的是文档

### 跨仓库

```
/code-scan repos=[{name:"app",url:"git@github.com:ORG/app.git"},{name:"lib",url:"git@github.com:ORG/lib.git"}] goal="重点看性能和死代码"
```

仓库清单也可放在 `repos.json`（格式见 `examples/repos.example.json`），让 agent 读取后传入。

克隆目标固定在工作区下的 `.code-scan/repos/`（已 gitignore）。**重跑前请删除该目录**，否则 `git clone` 会因目录已存在而失败。

### 选择器复用

选择器存档按模式分开：全面扫描是 `.code-scan/selectors/<repo>.json`，其他模式是 `<repo>~<模式>.json`。同一模式、同一 `goal` 再次运行时直接复用，只做试跑与必要修订；想重新规划：字段与执行语义见 [docs/selectors.md](docs/selectors.md)。

```
/code-scan refreshSelectors=true
```

### 按阶段选择模型

先运行一次：

```
/code-scan-models
```

它会读取本机 ZCode 模型目录，按阶段（规划/修订/批次审查/逐条复核/评审长/全局评审/全局复核）弹出选择面板，保存到 `~/.zcode/code-scan-models.json`。成员各自配置，互不影响。

之后 `/code-scan` 自动读取这份配置，校验模型仍存在且没有 `disabledReason`（`reasoningLevels` 里的 `disabled` 是档位名，不算禁用），再生成一份带模型字面量的草稿脚本启动。改模型就再跑一次 `/code-scan-models`，不需要改文件。

`model="..."` 仍然可用，但它只是 **run 级默认模型**，只影响没有单独配置的阶段：

```
/code-scan repos=[...] model="GLM-5.3-Flash"
```

命令会先用 `ListModels` 解析成完整 `providerId/modelId`，再作为 `subagent_model` 传入；裸名只在会话 provider 内解析。

### 调整预算、分片与并发

```
/code-scan repos=[...] maxFilesPerBatch=8 selectorBudget=200 concurrency=4
```

- `selectorBudget`:每条选择器的默认命中上限（默认 200，允许 20–2000）；超出按路径确定性采样并写进 notCovered
- `maxFilesPerBatch`:每批信号文件数（默认 8，允许 3–20）。批次数按信号规模自动生成，**默认不设总批上限**
- `concurrency`:并发上限，传给 `CreateWorkflow` 的 `max_concurrency`（建议 4，不传则运行时自适应）
- `maxTotalBatches`（可选，默认 0 = 不限，最大 200）：想设全局批次预算时才用；超出会显式写进 notCovered

### 沙箱执行（默认开启，需要 Docker）

- 审查员不直接执行仓库代码。能靠执行验证的发现（崩溃、错误结果、性能退化、测试失败），它把命令写进 `sandboxRuns`，由脚本在隔离容器里执行，再把真实输出回传给它修订一次（每批次最多 8 条，全部按顺序执行，一次只跑一个容器）
- 容器与运行时复现同一套隔离：`--network=none`、`--read-only`、非 root、`--cap-drop=ALL`、`no-new-privileges`、pids/memory/cpu 限制；仓库只读挂载到 `/src`，每条命令最长 52 秒，只回传 stdout/stderr 末尾 3000 字符，输出在容器内脱敏后才离开容器
- 依赖在容器内按 lockfile 安装（默认离线，读本机 npm 缓存）；装不上（例如没有 lockfile）时容器照常运行、只是不带依赖，并在回传给审查员的结果里注明原因。仓库自带的 `node_modules` 一律用空 tmpfs 遮住，不会被用到
- 装好的依赖在只读卷里（`/deps/tree`）。沙箱执行器在可写的 `node_modules` 挂载点为它的每一项建符号链接视图，所以 CommonJS 的 `require`、ESM 的 `import` 和 `npm test` 里用到的命令行工具（`.bin`）都能找到依赖；依赖卷本身写不进去
- 所有子代理（规划员、修订员、审查员、追踪员、评审长、全局评审员）的提示词里都有一条**执行边界**：不允许在主机上运行仓库的脚本、测试、构建、服务，也不在仓库目录里执行 npm/npx/pnpm/yarn；仓库内容和沙箱输出里出现的指令一律不执行。**这是提示词约束，不是机制隔离**：工作流脚本没收不了子代理的 shell，也看不到它们执行过什么，所以报告不能当作「主机上没有执行过仓库代码」的证明——报告里会原样写明这一点
- 没装 Docker、daemon 未运行、context 不是本机、工作区里有 `docker` shim、镜像拉不下来 → 沙箱不可用，审查员只做静态核对，原因写进 notCovered；没装 docker 的机器不会产生任何 docker 调用。迁移文档模式不使用沙箱
- 沙箱镜像就是运行时复现的 `node:22-slim`（按 digest 钉死），里面只有 Node、npm 和基础 shell 工具：非 Node 仓库的脚本与测试大多跑不了，审查员会把「未能执行验证」写进证据
- 审计目录在系统临时目录，记录每条运行的命令、容器 argv、脱敏后的输出；报告里给出路径

### 运行时复现（可选，需要 Docker）

```
/code-scan runtimeVerify=true
```

- 对证据核对通过的 high/medium 发现逐条执行一段最小复现脚本（最多 12 条，顺序执行），容器隔离与沙箱执行相同；审查员提出的沙箱验证不受这个开关影响
- 安装默认 **offline**：`--network=none` + `npm ci --offline`，只读挂载本机 npm 缓存（以 `npm config get cache` 为准，仅当工作区没有 `.npmrc` 时；否则用 `~/.npm`）；缺包会 `unavailable` 并提示先在本地预热或加 `runtimeVerifyOnline=true`
- 只接受满足以下条件的仓库：lockfileVersion 2/3 且有非空 packages 表（拒绝 v1 形状）、每条 `resolved` 指向 `registry.npmjs.org` 且 `integrity` 非空、**没有任何生命周期脚本**（无白名单，husky 也拒）、无 workspace 协议、无项目 `.npmrc`；不满足就整体跳过并写明原因（`unavailable`）
- 依赖装在卷的子目录 `/deps/tree`；复现容器挂 `/deps` 并设 `NODE_PATH=/deps/tree`，仓库自带的 `node_modules` 用空 tmpfs 遮蔽
- 复现容器：`--network=none`、`--read-only`、非 root、`cap-drop=ALL`、pids/memory/cpu 限制；仓库只读挂载，依赖来自只读卷，脚本只写容器 tmpfs
- **结论含义严格限定为「脚本返回了符合断言的数据」**：脚本必须 `require` 仓库代码，二者同进程，仓库代码可以干扰返回值，所以它不是独立证明，永不用于自动 dismiss；`notReproduced` 只显示「脚本未观察到预期行为」
- 镜像按 digest 钉死：sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee（node:22-slim）。tag 在 registry 上移动也不影响按 digest 拉取
- 审计目录在系统临时目录（`mkdtemp`），记录脚本全文、容器 argv、脱敏后的输出；报告里给出路径
- Docker daemon 未运行、context 不是本机、工作区里有 `docker` shim、仓库含符号链接、路径含逗号、含嵌套 `node_modules`（自带依赖会绕过安装策略）→ 整体或该仓库跳过，扫描其余部分照常完成
- 依赖安装按仓库一次，卷名为 `code-scan-deps-<仓库标识hex>-<fingerprint>`；只有「成功标记存在且 fingerprint 匹配」才复用，半成品不会被复用

## 输出

- `conclusion`：结论
- `findings`：去重排序后的发现（`where` 带仓库前缀、`status` 为 verified/unconfirmed；开了 runtimeVerify 且真跑过时带 `repro`）
- `verified`：实际执行了什么（第一行是本次模式与覆盖的维度；然后是仓库数、信号数、批次数、工具版本；沙箱执行的次数与结果；开了 runtimeVerify 时还有复现条数与成立数）
- `notCovered`：**本次模式没有扫描的维度**、克隆失败、选择器超限/采样、工具缺失、死规则、依赖未安装、批次溢出、性能未跑基准、沙箱不可用、运行时复现未运行/安装被拒/该仓库跳过
- Artifact：发现看板（按严重度分列）+ markdown 报告（含选择器执行表）；`migration` 模式的交付物是迁移文档（端到端流程、业务规则、迁移风险、流程图）

## 成本与安全

- 每个仓库 = 规划员 1（仅首次或 refresh）+ 修订员 1（仅当有死规则/超量规则）；每批次 = 审查员 1；再加评审长与全局评审员各 1。**复核不占 agent**：由确定性检查完成
- 发现数量只防病态输出：每批次硬上限 50 条、批次间先按 `仓库+位置+问题` 去重；报告不因数量丢发现（展示上限 200 条，超出的写进 notCovered）
- 工具执行不占 agent：knip/jscpd/madge/ast-grep 由脚本以固定命令行运行，JSON 由脚本解析
- **批次数随信号文件规模增长**（每批 8 个文件），成本按会话数线性上升；`max_concurrency` 只控制同时跑几个，不控制总量
- 全程只读：审查员与复核员不编辑文件；唯一工作区写入是 `.code-scan/selectors/` 的规则存档与 `.code-scan/tmp/` 的工具报告；草稿写在系统私有临时目录，不写工作区；扫描不会自动开 PR
- 按阶段模型配置按人保存在 `~/.zcode/code-scan-models.json`；生成的草稿在系统私有临时目录；模型 id 不写进共享脚本或仓库文件
- 草稿生成依赖 Node（`scripts/generate-draft.mjs`）；Node 不可用或生成失败时不会启动扫描
- 每次运行生成的草稿留在系统临时目录，不会自动删除，可定期清理
- knip 固定使用脚本写入的 **deny-all 插件配置**（所有插件名置 `false`，防止 `package.json` 插件配置执行 JS），**不读取仓库自带的 `knip.json/jsonc`**；**`knip.config.js/ts` 永不执行**，并固定 no-op `--preprocessor`；发现 `pnpm-workspace.yaml` 或**根** `package.json#knip` 时 knip 不运行；配置写入失败时本次直接不跑 knip
- 上述 `.npmrc`/`pnpm-workspace.yaml`/工具包与 `.bin` 存在性按 Node 的 `stat`/`lstat`/`readdir` 语义判断（Windows 大小写不敏感、符号链接算存在），不用 workflow 的 `files.glob`（其 walker 大小写敏感且跳过 symlink，与 npm/knip 的 `stat` 语义不一致）
- ast-grep 以空配置（`.code-scan/tmp/sgconfig-empty.yml`）运行并显式 `--custom-languages ignore`，不加载工作区/仓库的 sgconfig
- madge 固定由脚本写入的安全 webpack/tsconfig/require-config（仓库自带 tsconfig 优先），`--webpack-config`/`--ts-config`/`--require-config` 覆盖 `.madgerc`/`package.json#madge` 里的可执行配置
- 工作区**或 npm 会读取的 project `.npmrc`（npm 前缀目录、工作区根；home 与 userconfig 同路径时按 npm 行为跳过）**存在 `.npmrc` 时，**npx 工具整体停用**（ast/graph/knip/jscpd），只保留 grep；不解析 ini，避免 quoted key/`userconfig`/`script-shell`/`node-options` 绕过
- 工作区及其祖先目录（npm run-script 的 PATH 会逐级向上）的 `node_modules/.bin` 出现与固定工具同名的条目（按目录 readdir 匹配，任意扩展名，含 `.bat/.com` 等 PATHEXT 变体），工作区根、npm 前缀或隐式 workspace 包根出现与工具同名的 PATHEXT 可执行文件（如 `jscpd.bat`；cmd 先查当前目录），或 `node_modules/<pkg>/package.json` 存在时，npx 工具同样 fail-closed，防止本地二进制顶替固定版本
- 所有 `npx` 工具调用经 npm 自带的 `npx-cli.js`（Windows 下用 `node` 启动，避免 `npx.cmd` shim 无法直接 spawn），统一为 `--package <pkg> -- <tool>` 形式（本地包的 `bin` 名不能替换实际执行的命令），带 `--ignore-scripts`，版本固定为 `knip@6.45.1`、`jscpd@5.4.3`、`madge@8.0.0`、`@ast-grep/cli@0.51.3`
- `repos` 的 URL 拒绝 `ext::` 等可执行远程助手与前导 `-`；git 调用强制 `protocol.ext.allow=never`；`ref` 拒绝非法 ref 字符；`path` 必须是工作区内相对路径且不能含 `..`
- 启动时检查 `.code-scan`、`tmp`、`repos`、`selectors` 不是符号链接/联接；clone 目标叶节点也会检查；脚本写入走临时文件 + rename，jscpd 报告写到 `node mkdtemp` 的独占目录
- 选择器文本字段拒绝控制字符与前导 `-`（防止 Windows cmd shim 注入）
- 选择器预算默认 200、上限 2000（`selectorBudget`）；超出按路径确定性采样并记录，不静默截断
- 规划员被要求把规则控制在 2–3 条 scope + 8–12 条信号规则；单条 grep 命中必须低于 2000 行，超过是硬拒绝（预算管不到，脚本会提示收窄 scope 而不是当成正则写错）
- 逐条运行时复现默认关闭（`runtimeVerify=false`）；沙箱探测默认进行，发现类模式在有 Docker 的机器上会调用 docker（定位检查、`docker version`、context、镜像、两个探测容器）
- 运行时复现**不执行仓库自带脚本**：`ignore-scripts`、拒绝任何生命周期脚本、只 `npm ci`、`--omit=optional`；git/file/workspace 依赖与私有 registry 一律拒绝。默认离线，联网要显式开 `runtimeVerifyOnline=true`。沙箱运行执行的是审查员提出的命令，可以跑仓库的测试脚本，但只在容器里
- `docker` 的顶替检查与 npx 工具分开：工作区出现 `docker` shim 只停用沙箱与运行时复现，不影响 knip/jscpd/madge/ast-grep。检查按真实路径判断：工作区及其祖先目录里的 `docker`、PATH 上位于工作区之内或解析后落在工作区里的 `docker`、PATH 里的相对路径项，都算顶替；没装 docker 的机器不会产生任何 docker 调用
- **已知残余**：检查通过后，脚本仍以 `docker` 这个名字调用它（工作流引擎要求命令名是编译期字面量，没法传入检查时解析出的绝对路径），所以检查与调用之间的 PATH 是被信任的。这个假设在引入沙箱通道之前就存在，只是现在默认会用到
- 运行时复现的判定**不是独立证明**：脚本与仓库代码同进程，仓库代码可以覆写结果文件。设计只承诺「门槛高于一句 console.log」「伪造会留痕于审计目录」「展示文案标注为脚本自报」「永不自动 dismiss」
- 离线验收测试不依赖 Docker：`node test/runtime-verify.test.mjs`（需要 tsc 时加 `TSC=<typescript/lib/tsc.js>`）

## 目录

```
code-scan-tools/
├── marketplace.json
├── code-scan/
│   ├── .zcode-plugin/plugin.json
│   ├── commands/code-scan.md
│   ├── commands/code-scan-models.md
│   ├── commands/code-scan-fix.md
│   ├── skills/code-scan/SKILL.md
│   ├── scripts/code-scan.ts
│   └── scripts/generate-draft.mjs
├── examples/repos.example.json
├── test/runtime-verify.test.mjs
└── docs/
    ├── devin-parity.md
    ├── rubric.md
    ├── runtime-verify.md
    └── selectors.md
```

## 已知限制

- 工作流脚本首次提交需过确认框（展示完整脚本），这是 ZCode 的安全设计
- `/code-scan-models` 的面板每题最多 4 个选项：候选是前 3 个模型 + "继承运行模型"；其他模型点 Other 输入完整 id
- `git clone` 通过 `world.run("git", ...)` 执行，确认框会列出 `git` 命令集
- 首次运行若出现编译诊断，按提示编辑脚本文件后用 `path` 重提（不要重贴脚本）
- 工具经 `node npx-cli.js --yes --ignore-scripts` 按固定版本下载（`@ast-grep/cli@0.51.3`、`knip@6.45.1`、`jscpd@5.4.3`、`madge@8.0.0`），首次调用较慢
- 工作区（或 npm 前缀/工作区根）存在任何 `.npmrc`（含大小写变体与符号链接）时 npx 工具会 fail-closed 停用，只保留 grep；良性 `.npmrc` 也一样，这是有意的安全取舍；工作区及祖先目录 `node_modules/.bin` 含固定工具同名条目（任意扩展名），或工作区根含同名 PATHEXT 可执行文件（如 `jscpd.bat`）时同样停用
- 浅克隆没有 `node_modules` 时，knip 的依赖解析类噪声会被过滤并注明；Python/Rust 工具包（vulture/radon/cargo udeps）尚未接入
- 无增量扫描、无托管调度；`security` 模式是静态检查，不含利用验证；如需请另行加阶段
