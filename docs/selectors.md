# 选择器 v2

选择器是**作用于全库的确定性规则**，不是文件清单。规划员只写规则，脚本负责执行；批次只包含产生信号的文件。

## 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | ASCII、同仓库内唯一、跨运行稳定；存档复用与报告都靠它 |
| `kind` | 是 | `scope` / `grep` / `ast` / `graph` / `tool` |
| `lang` | ast 必填 | `ts` / `tsx` / `js` / `jsx` / `py` / `go` / `rust` / `java` |
| `query` | 是 | 见下表 |
| `scope` | 是（可空串） | 搜索范围路径 glob；`scope` 规则里是边界 glob |
| `target` | 是（可空串） | 仅 graph：layering 的目标 glob、orphan 的入口豁免 glob，逗号分隔 |
| `exclude` | 是（可空串） | 排除的路径 glob，逗号分隔 |
| `intent` | 是 | 一句中文，说明这条规则找什么；带给批次审查员 |
| `dimension` | 是 | 维度 id，取模板 `DIMENSIONS` 注册表之一（`quality` / `dead-code` / `perf` / `db` / `coverage` / `cleanup` / `telemetry` / `a11y` / `compliance` / `security` / `migration`）；不在本次模式启用范围内的规则会被丢弃并记录 |
| `budget` | 是 | 命中上限；0 = 用运行默认预算（200） |

## 类型

### `scope`

只圈定审查边界，**不产生信号**。至少 1 条。

```json
{ "id": "scope-src", "kind": "scope", "lang": "", "query": "src/**/*.ts", "scope": "", "target": "", "exclude": "**/*.test.ts", "intent": "审查范围", "dimension": "quality", "budget": 0 }
```

作用：
- 作为批次退化时的抽样范围
- 过滤 grep/ast/graph 信号（tool 信号不受范围限制）

### `grep`

ripgrep 正则，命中行成为信号。

```json
{ "id": "grep-todo", "kind": "grep", "lang": "", "query": "TODO|FIXME|XXX", "scope": "src/**", "target": "", "exclude": "", "intent": "遗留标记", "dimension": "quality", "budget": 200 }
```

### `ast`

`query` 是 ast-grep 模式，或带 `rule` 的关系规则 JSON。

```json
{ "id": "ast-empty-catch", "kind": "ast", "lang": "ts", "query": "catch ($ERR) { }", "scope": "src/**", "target": "", "exclude": "", "intent": "空 catch 吞异常", "dimension": "quality", "budget": 200 }
```

关系查询（`inside` / `has` / `follows` / `precedes` / `all` / `any` / `not`）：

```json
{
  "id": "ast-nested-await",
  "kind": "ast",
  "lang": "ts",
  "query": "{\"rule\":{\"all\":[{\"pattern\":\"await $EXPR\"},{\"inside\":{\"kind\":\"for_statement\"}}]}}",
  "scope": "src/**",
  "target": "",
  "exclude": "",
  "intent": "循环内 await",
  "dimension": "perf",
  "budget": 200
}
```

脚本用 `ast-grep scan --inline-rules` 执行，规则 id/language/message 由脚本补齐。

### `graph`

依赖边来自 madge；环由脚本内迭代式 Kosaraju 计算。

| query | 含义 | 参数 |
|---|---|---|
| `cycle` | 强连通环 | `scope` 过滤环中文件 |
| `orphan` | 扇入 0 的文件 | `scope` 圈候选；`target` 填入口豁免 glob |
| `layering` | 违反分层规则的依赖边 | `scope` 是来源 glob；`target` 是禁止依赖的目标 glob |

```json
{ "id": "graph-layer", "kind": "graph", "lang": "", "query": "layering", "scope": "src/domain/**", "target": "src/infra/**,src/ui/**", "exclude": "", "intent": "domain 不应依赖 infra/ui", "dimension": "quality", "budget": 200 }
```

### `tool`

| query | 报告 | 条件 |
|---|---|---|
| `knip` | 未使用文件/导出/依赖 | 仓库需有 `package.json` |
| `jscpd` | 重复代码 | JS/TS 文件 |
| `test-reach` | 没有任何测试文件直接或经导入链引用的模块（每模块一个命中，带扇入） | 依赖图可用（madge） |
| `a11y` | JSX/TSX 的无障碍缺陷（eslint + eslint-plugin-jsx-a11y，每条 lint 消息一个命中） | JS/TS 项目；能定位到 npm 自带的 `npm-cli.js` 与驱动脚本。工具包按固定版本装在 npm 缓存目录下的专属目录里，不写工作区，也不经 npx 启动任何命令 |

```json
{ "id": "tool-knip", "kind": "tool", "lang": "", "query": "knip", "scope": "", "target": "", "exclude": "", "intent": "未使用导出与依赖", "dimension": "dead-code", "budget": 200 }
```

## 执行语义

1. 能力探测：`npx`（Windows 下经 `node` 启动 npm 自带的 `npx-cli.js`）、`package.json`/`tsconfig.json`、各工具可用性；不可用的类型在规范化阶段被丢弃并记入 notCovered。
2. 执行顺序：每个仓库先准备依赖图（有 graph 规则或 `test-reach` 工具规则时），再逐条执行选择器。工具按名字缓存，同一仓库只跑一次。
3. 预算：信号按 `path`、`line` 排序后取前 `budget` 条；`hits` 是采样前总数，`sampled` 是实际进入批次的条数。
4. 试跑统计回到规划员：零命中的死规则、被采样的超量规则会在**一轮修订**里被改掉；修订后只执行签名变化的选择器。
5. 信号分片：按文件聚合信号；排序键依次为信号数、扇入、路径；按 `maxFilesPerBatch` 与每批 ≤60 条信号切批。批次提示词每文件最多展示前 12 条信号，超出部分写进 notCovered。
6. 没有信号且没有 scope 时，该仓库不产生批次并记入 notCovered；没有信号但有 scope 时，按扇入/路径抽样最多 200 个文件，明确标注"退化抽样"。

## 持久化

每个模式一份存档。全面扫描写 `.code-scan/selectors/<repo>.json`，其他模式写 `<repo>~<模式 id>.json`（模式 id 超过 24 个字符时截断并接上完整 id 的短哈希，组合模式不会撞同一个文件）：

```json
{
  "version": 2,
  "repoHead": "0319a6a...",
  "goal": "全面扫描:质量 / 冗余 / 性能",
  "map": "仓库地图",
  "selectors": [ ... ],
  "probe": [ { "id": "sel-1", "hits": 42, "sampled": 42, "files": 7, "note": "" } ],
  "capabilities": { "npm": true, "ast": true, "graph": true, "knip": true, "jscpd": true, "a11y": true, "notes": [] }
}
```

- 同 `goal` 且未设 `refreshSelectors=true`：直接复用选择器，跳过规划员
- `goal` 变化或 refresh：重新规划，旧选择器与试跑统计作为参考
- 能力临时缺失（如 npx 不可用）时，只把**因能力缺失被过滤掉**的 ast/graph/tool 规则保留在存档里；修订中主动删除或改名的规则不会被合并回来。下次能力恢复可继续执行被保留的规则。
- 仓库 HEAD 变化不会自动失效规则；需要时用 `refreshSelectors=true` 强制重规划
- 存档可用于人工审阅与版本比较；不要把 `.code-scan/` 提交进仓库

## 安全边界

- 选择器文本字段（`query`/`scope`/`target`/`exclude`/`intent`/`lang`）拒绝控制字符与前导 `-`；存档被当作不可信输入重新校验
- `ast` 规则经 `--inline-rules` 传入，使用空配置并固定 `--custom-languages ignore`，不加载工作区/仓库的 sgconfig 或 native 语言库
- `madge` 固定安全 `--webpack-config`（脚本写入的 `{}`）、`--ts-config`（仓库 tsconfig 优先，否则安全默认）与 `--require-config`（安全空 RequireJS 配置），覆盖 `.madgerc`/`package.json#madge` 中可被 `require()` 的配置
- npm 可能读取的 project `.npmrc`（npm 前缀目录、工作区根；home 与 userconfig 同路径时跳过）存在时，npx 工具 fail-closed 停用，只保留 grep；工作区及祖先目录的 `node_modules/.bin` 含固定工具同名条目（按 readdir 匹配任意扩展名，含 `.bat/.com`）、工作区根/npm 前缀/隐式 workspace 包根含同名 PATHEXT 可执行文件（如 `jscpd.bat`，cmd 先查当前目录）或固定工具包时同样停用。这些与 knip 停用条件都会写进 notCovered，不能当作完整工具覆盖
- `knip` 固定使用 deny-all 插件配置（所有插件名 `false`），不读取仓库的 `knip.json/jsonc`；`knip.config.js/ts` 永不执行，并固定 no-op `--preprocessor`；发现 `pnpm-workspace.yaml` 或根 `package.json#knip` 时不运行
- `.npmrc`/`pnpm-workspace.yaml`/工具包/`.bin` 的存在性按 Node `stat`/`lstat`/`readdir` 语义判断（Windows 大小写不敏感、符号链接算存在），与 npm/knip 的 `stat` 一致；不使用 `files.glob`（大小写敏感且跳过 symlink）；npx 统一以 `--package <pkg> -- <tool>` 调用，本地包的 bin 名不能改写命令
- 仓库 URL 拒绝 `ext::`/前导 `-`/CRLF；git 调用强制 `protocol.ext.allow=never`，防止 URL 被本地 git 配置改写成可执行远程助手
- `.code-scan`、`.code-scan/tmp`、`.code-scan/repos`、`.code-scan/selectors` 启动时检查不是符号链接/联接；clone 目标叶节点也会检查；脚本写入走临时文件 + rename，不跟随符号链接
- jscpd 报告写到 `node mkdtemp` 生成的独占目录，复用旧路径或预设符号链接都不成立

## 边界

已支持：AST 模式与关系查询（ast-grep）、模块依赖图（madge）、TS 符号级未使用导出（knip）、重复代码（jscpd）、测试可达性（test-reach，基于依赖图）、JSX/TSX 无障碍（eslint + eslint-plugin-jsx-a11y）。

未支持：类型感知的跨文件查询（tsserver/scip）、函数级调用图、生成 schema 对比、Python/Rust 工具包（vulture/radon/cargo udeps）、增量扫描。
