/* zcode-workflow
description: '跨仓库全库扫描(选择器 v2):Plan(可持久化 selectors)→ 全库确定性执行 → 信号分片 → Map → 确定性接地 → Reduce;可选 runtimeVerify 在隔离容器里装依赖并执行仓库代码复现'
args:
  repos:
    type: json
    description: '仓库列表,元素为 {name,url,ref} 或 {name,path},或 owner/repo 字符串;省略则扫当前工作区'
  goal:
    type: string
    default: '全面扫描:质量 / 冗余 / 性能'
  maxFilesPerBatch:
    type: number
    default: 8
  maxTotalBatches:
    type: number
    default: 0
    description: '全局批次数上限;0 表示不限制(推荐),并发由 CreateWorkflow 的 max_concurrency 控制'
  selectorBudget:
    type: number
    default: 200
    description: '每条选择器的默认命中预算;超出按路径确定性采样并写进 notCovered'
  refreshSelectors:
    type: boolean
    default: false
    description: 'true 时忽略 .code-scan/selectors 下的历史规则,重新规划'
  runtimeVerify:
    type: boolean
    default: false
    description: 'true 时在隔离容器里安装依赖并执行仓库代码做运行时复现(需要 Docker daemon 与本地 context);默认关闭'
  runtimeVerifyOnline:
    type: boolean
    default: false
    description: '安装依赖时允许联网。默认离线(读本机 npm 缓存);开启后安装容器可访问任意主机,风险更高'
*/

interface RepoSpec {
  /** 仓库名,用于报告、看板与选择器存档。 */
  name: string;
  /** Git 克隆地址;与 localPath 二选一。 */
  url: string;
  /** 要检出的分支/标签;空字符串表示默认分支。 */
  ref: string;
  /** 已在工作区内的仓库相对路径;与 url 二选一。 */
  localPath: string;
}

interface PreparedRepo {
  /** 仓库名。 */
  name: string;
  /** 本次运行内唯一的文件安全 key,用于克隆目录与选择器存档。 */
  key: string;
  /** 工作区内的扫描目录。 */
  dir: string;
  /** 是否准备成功。 */
  ok: boolean;
  /** 失败原因或准备说明。 */
  note: string;
}

interface Capabilities {
  /** npx 可用;false 时 ast/tool/graph 全部不可执行。 */
  npm: boolean;
  /** ast-grep 可执行(经 npx)。 */
  ast: boolean;
  /** madge 可执行(经 npx),用于依赖图规则。 */
  graph: boolean;
  /** knip 可执行(需要 package.json)。 */
  knip: boolean;
  /** jscpd 可执行(经 npx)。 */
  jscpd: boolean;
  /** 能力探测的说明,写进 notCovered。 */
  notes: string[];
}

interface SelectorSpec {
  /** 稳定 id;重跑复用与报告都靠它,同仓库内唯一。 */
  id: string;
  /** scope 只圈定范围;grep/ast/graph/tool 会产生信号。 */
  kind: "scope" | "grep" | "ast" | "graph" | "tool";
  /** ast 的语言:ts|tsx|js|jsx|py|go|rust|java;其他类型填空字符串。 */
  lang: string;
  /** scope:路径 glob;grep:正则;ast:AST 模式或 ast-grep 规则 JSON;graph:cycle|orphan|layering;tool:knip|jscpd。 */
  query: string;
  /** 搜索范围(路径 glob);空字符串表示整个仓库。 */
  scope: string;
  /** graph 专用:layering 的目标 glob、orphan 的入口豁免 glob,逗号分隔;其他类型填空字符串。 */
  target: string;
  /** 要排除的路径 glob,逗号分隔;空字符串表示不排除。 */
  exclude: string;
  /** 这条规则要回答的问题,会带给批次审查员与复核员。 */
  intent: string;
  /** 维度侧重。 */
  dimension: "quality" | "dead-code" | "perf";
  /** 命中上限;0 表示使用本次运行的默认预算。 */
  budget: number;
}

interface RepoPlan {
  /** 作用于全库的确定性选择规则(不是文件清单)。 */
  selectors: SelectorSpec[];
  /** 仓库地图:模块树、各模块职责、入口、关键依赖边,供批次复核时参考。 */
  map: string;
  /** 有意跳过的目录与理由。 */
  skipped: string[];
}

interface SelectorRevision {
  /** 修订后的完整选择器列表(保留未改的,替换死规则与超量规则)。 */
  selectors: SelectorSpec[];
  /** 一句话说明改了什么。 */
  notes: string;
}

interface ProbeStat {
  /** 选择器 id。 */
  id: string;
  /** 执行后的命中总数(采样前)。 */
  hits: number;
  /** 实际进入信号的条数。 */
  sampled: number;
  /** 命中覆盖的文件数。 */
  files: number;
  /** 覆盖说明:工具缺失、采样、错误。 */
  note: string;
}

interface SelectorManifest {
  /** 存档格式版本。 */
  version: number;
  /** 仓库 HEAD,便于判断规则是否过期。 */
  repoHead: string;
  /** 这次运行的 goal;goal 变化时旧规则不复用。 */
  goal: string;
  /** 规划出的仓库地图。 */
  map: string;
  /** 选择器全集。 */
  selectors: SelectorSpec[];
  /** 上次试跑的命中统计。 */
  probe: ProbeStat[];
  /** 能力探测结果。 */
  capabilities: Capabilities;
}

interface LoadedManifest extends SelectorManifest {
  /** 存档里的 goal 是否与本次一致。 */
  goalMatches: boolean;
  /** 按“全部能力可用”规范化的规则;能力临时缺失时用它保留历史规则。 */
  archiveSelectors: SelectorSpec[];
  /** 仅因当前能力缺失而被过滤掉的历史规则。 */
  filteredSelectors: SelectorSpec[];
}

interface Hit {
  /** 相对仓库根目录的路径。 */
  path: string;
  /** 行号;非行级命中时为 0。 */
  line: number;
  /** 命中的代码片段或工具证据。 */
  excerpt: string;
  /** 0-1,来源越硬置信越高(工具 > AST > grep)。 */
  confidence: number;
  /** 来源说明,例如 "knip exports" 或 "ast-grep empty-catch"。 */
  provenance: string;
}

interface Signal extends Hit {
  /** 产生这条信号的选择器 id。 */
  selectorId: string;
  /** 选择器意图。 */
  intent: string;
  /** 维度。 */
  dimension: "quality" | "dead-code" | "perf";
  /** 产生信号的规则类型。 */
  kind: string;
}

interface ToolOutcome {
  /** 工具的原始候选。 */
  hits: Hit[];
  /** 工具缺失或运行失败的原因。 */
  note: string;
}

interface GraphInfo {
  /** 模块依赖边。 */
  edges: Map<string, string[]>;
  /** 每个模块被依赖的次数。 */
  fanIn: Map<string, number>;
  /** 强连通环(每个元素是一组互相可达的模块)。 */
  cycles: string[][];
  /** 依赖图不可用的原因;空字符串表示可用。 */
  note: string;
}

interface SelectorRun {
  /** 选择器 id。 */
  id: string;
  /** 规则类型。 */
  kind: string;
  /** 选择器意图。 */
  intent: string;
  /** 维度。 */
  dimension: "quality" | "dead-code" | "perf";
  /** 采样前命中总数。 */
  hits: number;
  /** 实际进入信号的条数。 */
  sampled: number;
  /** 命中覆盖的文件数。 */
  files: number;
  /** 覆盖说明。 */
  note: string;
  /** 进入批次的信号(scope 为空)。 */
  signals: Signal[];
  /** scope 规则命中的文件列表。 */
  paths: string[];
}

interface RepoContext {
  /** 仓库。 */
  repo: PreparedRepo;
  /** 能力。 */
  caps: Capabilities;
  /** 是否安装了 node_modules,决定 knip 依赖类输出是否可信。 */
  hasNodeModules: boolean;
  /** knip 使用的 deny-all 配置绝对路径;空串表示不可用。 */
  knipConfigPath: string;
  /** knip 安全 no-op preprocessor 绝对路径;空串表示不可用。 */
  knipPreprocessorPath: string;
  /** ast-grep 使用的空配置绝对路径;空串表示不可用。 */
  astConfigPath: string;
  /** madge 使用的安全 webpack 配置绝对路径;空串表示不可用。 */
  madgeWebpackPath: string;
  /** madge 使用的 tsconfig 绝对路径(仓库自带优先,否则安全默认)。 */
  madgeTsConfigPath: string;
  /** madge 使用的安全 RequireJS 配置绝对路径;覆盖仓库的 requireConfig。 */
  madgeRequireConfigPath: string;
  /** 依赖图;没有 graph 规则时为 null。 */
  graph: GraphInfo | null;
  /** 工具输出缓存,同一工具每仓库只跑一次。 */
  toolCache: Map<string, ToolOutcome>;
  /** 选择器执行缓存,按签名复用。 */
  selectorCache: Map<string, SelectorRun>;
}

interface RepoExecution {
  /** 仓库。 */
  repo: PreparedRepo;
  /** 能力。 */
  caps: Capabilities;
  /** 规划结果。 */
  plan: RepoPlan;
  /** 是否复用了持久化规则。 */
  reused: boolean;
  /** 是否保留历史存档中因能力缺失被过滤掉的规则。 */
  preserveArchive: boolean;
  /** 存档用规则:能力缺失时包含历史规则。 */
  archiveSelectors: SelectorSpec[];
  /** 仅因能力缺失被过滤、需要在修订后继续保留的历史规则。 */
  preservedSelectors: SelectorSpec[];
  /** 执行上下文。 */
  ctx: RepoContext;
  /** 最终选择器执行结果。 */
  runs: SelectorRun[];
  /** 仓库 HEAD。 */
  repoHead: string;
  /** 本次执行的说明。 */
  notes: string[];
}

interface SignalGroup {
  /** 相对仓库根目录的路径。 */
  path: string;
  /** 该文件上的信号。 */
  items: Signal[];
}

interface BatchJob {
  /** 仓库。 */
  repo: PreparedRepo;
  /** 仓库序号,用于子代理命名去重。 */
  repoIndex: number;
  /** 批次序号。 */
  index: number;
  /** 本批次覆盖的文件组。 */
  groups: SignalGroup[];
  /** 仓库地图。 */
  map: string;
  /** 扇入数据,用于排序。 */
  fanIn: Map<string, number> | null;
}

interface RawFinding {
  /** 维度:质量、冗余或性能。 */
  dimension: "quality" | "dead-code" | "perf";
  /** 相对仓库根目录的路径,适用时带行号。 */
  where: string;
  /** 一句话说明问题本身,不写修法。 */
  problem: string;
  /** 证据:读过的具体行,或命令及其输出;性能类必须给基准数据或复杂度论证。 */
  evidence: string;
  /** high 仅用于数据丢失、崩溃或错误结果。 */
  severity: "high" | "medium" | "low";
  /** 一句话修法。 */
  fix: string;
  /** 可选的运行期复现规格;审查员给出,经主机校验后才会执行。 */
  repro?: ReproSpec;
}

interface Finding extends RawFinding {
  /** 发现所属仓库名。 */
  repo: string;
  /** 该仓库的扫描目录,供复核员定位。 */
  dir: string;
}

interface BatchReport {
  /** 该批次的发现,按影响排序。最多 12 条。 */
  findings: RawFinding[];
  /** 该批次没覆盖到的部分及原因。 */
  notCovered: string[];
}

interface CheckedFinding extends Finding {
  /** 本次运行内的稳定键;评审长只按 key 排序/去重,不信任其它字段。 */
  key: string;
  /** verified 表示独立复核员复现成功;unconfirmed 表示未能复现或未尝试。 */
  status: "verified" | "unconfirmed";
  /** 复核结论一句话。 */
  note: string;
  /** 运行期复现规格;只有 high/medium 且证据核对通过才可能被选中执行。 */
  repro?: ReproSpec;
  /** 运行期复现结果;只有真跑过才有。与 status 并列,不替换它。 */
  reproResult?: ReproResult;
}

interface JudgeInputFinding {
  key: string;
  repo: string;
  where: string;
  problem: string;
  evidence: string;
  severity: "high" | "medium" | "low";
  status: "verified" | "unconfirmed";
}

interface JudgeFinding {
  /** 已复核发现的稳定键;评审长按顺序返回。 */
  key: string;
  /** 以下字段允许评审长原样带回,但脚本只读取 key,不会用它们覆盖可信字段。 */
  repo?: string;
  where?: string;
  problem?: string;
  evidence?: string;
  severity?: "high" | "medium" | "low";
  status?: "verified" | "unconfirmed";
}

interface GlobalFinding extends RawFinding {
  /** 发现所属仓库名;无法归属时缺席,复核前会丢弃并记入未覆盖。 */
  repo?: string;
}

interface GlobalReview {
  /** 跨批次模式下新增的发现,最多 5 条,必须带证据并填 repo。 */
  findings: GlobalFinding[];
  /** 跨批次观察:重复、不一致、分层违规等说明。 */
  notes: string[];
}

interface ReportFinding {
  /** 位置,带仓库名前缀。 */
  where: string;
  /** 问题一句话。 */
  what: string;
  /** 证据。 */
  evidence: string;
  /** verified 或 unconfirmed。 */
  status: "verified" | "unconfirmed";
  /** 严重度。 */
  severity: "high" | "medium" | "low";
  /** 运行期复现结论(只在真正执行过时出现)。 */
  repro?: string;
}

interface WorkflowReport {
  /** 两到三句话回答这次扫描的结论。 */
  conclusion: string;
  /** 去重排序后的发现。 */
  findings: ReportFinding[];
  /** 这次实际检查了什么、怎么检查的。 */
  verified: string[];
  /** 没看或看不了的部分及原因。 */
  notCovered: string[];
}

/** 容器内执行的断言规则;三种足够覆盖质量与性能两个维度。 */
type ReproAssertion =
  /** 断言「调用会抛错,且错误信息匹配」。run() 必须返回 { threw, message }。 */
  | { kind: "throws"; match: string }
  /** 断言「返回值不等于期望」。run() 必须返回 { actual }。 */
  | { kind: "not-equals"; expected: string }
  /** 断言「2n 耗时超过 n 的 threshold 倍」。run() 必须返回 { t1Ms, t2Ms }。 */
  | { kind: "ratio-greater"; threshold: number };

/**
 * 审查员给出的一条可执行复现。
 * 脚本只在容器 tmpfs 里落盘,不写工作区;导入仓库代码必须用 createRequire('/src/package.json')。
 */
interface ReproSpec {
  /** CommonJS 脚本,必须 module.exports = { run }。 */
  script: string;
  /** 判定规则;在容器内用原始返回值计算,不读 stdout、不脱敏。 */
  assertion: ReproAssertion;
  /** 一句话:这段脚本证明了什么。 */
  proves: string;
}

/**
 * 运行期复现结果。
 * reproduced 只表示「脚本返回了符合断言的数据」,不是「问题已被独立证明」——
 * 脚本与仓库代码同进程,仓库代码可以干扰返回值(见设计稿 §4.0/§12)。
 */
interface ReproResult {
  /** reproduced/notReproduced 只在 harness 正常返回判定数据时出现。 */
  outcome: "reproduced" | "notReproduced" | "unavailable" | "error";
  /** docker 进程退出码;-1 表示没拿到。与脚本自身退出码是两个不同的值。 */
  dockerExitCode: number;
  /** 容器内用原始数据算出的判定;null 表示无效 spec 或数据不合规。 */
  verdict: boolean | null;
  /** 失败阶段,用于定位。 */
  stage: "" | "spec" | "runner" | "run" | "load" | "contract" | "serialize" | "done";
  /** 一句话结论(已脱敏)。 */
  note: string;
  stdoutTail: string;
  stderrTail: string;
}

artifact.board("findings", {
  title: "扫描发现",
  key: "id",
  status: "severity",
  columns: ["high", "medium", "low"],
  cardTitle: "problem",
  detail: [
    { field: "repo", label: "仓库" },
    { field: "where", label: "位置" },
    { field: "dimension", label: "维度" },
    { field: "evidence", label: "证据" },
    { field: "fix", label: "建议修法" },
    { field: "statusText", label: "复核" },
  ],
});

const SELECTOR_VERSION = 2;
const DEFAULT_SELECTOR_BUDGET = 200;
const FALLBACK_MAX_FILES = 200;
const MAX_SIGNALS_PER_FILE = 12;
const MAX_SIGNALS_PER_BATCH = 60;
const MAX_MANIFEST_CHARS = 24000;
const MAX_REPORT_CHARS = 60000;
const MAX_JUDGE_INPUT_FINDINGS = 120;
const MAX_JUDGE_INPUT_CHARS = 24000;
/** 单批次发现硬上限;只防审查员病态输出(几十条重复/碎片),正常批次远达不到。 */
const MAX_FINDINGS_PER_BATCH = 50;
/** 报告与返回值的展示上限;超出的写进 notCovered 并说明,不静默丢弃。 */
const MAX_FINDINGS_REPORTED = 200;
/** 证据原文在引用行附近多少行内出现,仍算「就是这一行」。 */
const QUOTE_LINE_WINDOW = 2;
/** 运行时复现:最多执行几条、脚本字节上限、单容器超时。 */
const MAX_REPRO = 12;
const REPRO_SCRIPT_MAX_BYTES = 8192;
const REPRO_B64_MAX_CHARS = 24000;
const REPRO_TIMEOUT_MS = 60000;
/**
 * 镜像按 digest 钉死,不可配置。digest 未填时探测阶段会明确停用,
 * 并把从 tag 解析到的 digest 写进 notCovered,提示钉死。
 */
const REPRO_IMAGE_TAG = "node:22-slim";
const REPRO_IMAGE = `${REPRO_IMAGE_TAG}@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`;
/** 镜像自带 npm 的主版本;不符即停用,因为安装语义按它核对过。 */
const REPRO_IMAGE_NPM_MAJOR = 10;
/** 性能断言阈值区间:越界即拒绝 spec,不钳制。下限 2.5 是因为线性 n→2n 的比值就在 2 附近。 */
const RATIO_MIN = 2.5;
const RATIO_MAX = 100;
/** 小样本计时不足以支撑结论;t1Ms 低于此值判无效 spec。 */
const RATIO_FLOOR_MS = 50;
const INSTALL_TIMEOUT_MS = 300000;
const INSTALL_MAX_MEMORY = "2g";
const MANIFEST_MAX_BYTES = 2097152;
const DEPS_VOLUME_PREFIX = "code-scan-deps-";
const INSTALL_POLICY_VERSION = 1;
/** 链接遍历的条目上限;超过即跳过该仓库,避免病态目录结构拖死探测。 */
const WALK_MAX_ENTRIES = 50000;
const SEVERITY_RANK: Record<"high" | "medium" | "low", number> = { high: 0, medium: 1, low: 2 };
let workspaceRoot = "";
/**
 * world.run 按参数缓存:同一 argv 的第二次调用会直接命中第一次的结果。
 * 所以每次「重检」都必须带一个递增 nonce,否则第二次重检等于没做。
 */
let guardSeq = 0;
let npxCliPath = "";
let astConfigPath = "";
let madgeWebpackPath = "";
let madgeTsConfigPath = "";
let madgeRequireConfigPath = "";
let knipPreprocessorPath = "";
const AST_GREP_PKG = "@ast-grep/cli@0.51.3";
const KNIP_PKG = "knip@6.45.1";
const JSCPD_PKG = "jscpd@5.4.3";
const MADGE_PKG = "madge@8.0.0";
/** knip 6.45.1 的全部插件名;配置里逐个置 false,避免 package.json 插件配置执行 JS。 */
const KNIP_PLUGIN_NAMES = [
  "angular", "astro", "astro-db", "astro-markdoc", "astro-og-canvas", "ava", "aws-cdk",
  "babel", "biome", "borp", "buf", "bumpp", "bun", "c8", "capacitor", "catalyst",
  "changelogen", "changelogithub", "changesets", "commitizen", "commitlint", "convex",
  "create-typescript-app", "cspell", "cucumber", "cypress", "danger", "dependency-cruiser",
  "docusaurus", "dotenv", "drizzle", "electron-forge", "electron-vite", "eleventy", "esbuild",
  "eslint", "evalite", "eve", "execa", "expo", "expo-router", "expressive-code", "fast",
  "filesystem-routing", "flue", "fumadocs", "gatsby", "github-action", "github-actions",
  "glob", "graphql-codegen", "hardhat", "husky", "i18next-parser", "jasmine", "jest",
  "karma", "knex", "kysely-codegen", "ladle", "laravel-vite-plugin", "lefthook", "lingui",
  "lint-staged", "linthtml", "lit", "lockfile-lint", "lost-pixel", "lunaria", "markdownlint",
  "marko", "mastra", "mcp", "mdx", "mdxlint", "metro", "mikro-orm", "mise", "mocha",
  "moonrepo", "msw", "nano-spawn", "nano-staged", "nest", "netlify", "next", "next-intl",
  "next-mdx", "nitro", "node", "node-modules-inspector", "nodemon", "npm-package-json-lint",
  "nuxt", "nuxtjs-i18n", "nx", "nyc", "oclif", "openapi-ts", "openclaw", "orval", "osls",
  "oxfmt", "oxlint", "panda-css", "parcel", "payload", "pino", "playwright", "playwright-ct",
  "playwright-test", "plop", "pm2", "pnpm", "postcss", "pre-commit", "preconstruct",
  "prettier", "prisma", "purgecss", "quasar", "qwik", "railway", "raycast", "react-cosmos",
  "react-email", "react-native", "react-router", "relay", "release-it", "remark", "remix",
  "retry-cli", "rolldown", "rollup", "rsbuild", "rslib", "rspack", "rstest", "sanity",
  "semantic-release", "sentry", "serverless-framework", "simple-git-hooks", "size-limit",
  "solidjs-vite-plugin", "sst", "starlight", "stencil", "storybook", "stryker", "stylelint",
  "svelte", "sveltejs-package", "sveltekit", "svgo", "svgr", "swc", "syncpack", "tailwind",
  "tanstack-router", "taskfile", "tauri", "temporal", "textlint", "travis", "ts-node", "tsd",
  "tsdown", "tsrs", "tsup", "tsx", "turbo", "typedoc", "typescript", "typescript-content-mapper",
  "unbuild", "unocss", "unplugin-auto-import", "unplugin-icons", "unplugin-vue-components",
  "unplugin-vue-i18n", "unplugin-vue-markdown", "unplugin-vue-router", "varlock", "vercel",
  "vercel-og", "vike", "vite", "vite-plugin-pages", "vite-plugin-pwa", "vite-plugin-vue-layouts-next",
  "vite-plus", "vite-pwa-assets-generator", "vitepress", "vitest", "vue", "web-test-runner",
  "webdriver-io", "webpack", "wireit", "wrangler", "wxt", "xo", "yarn", "yorkie", "zx",
];
const KNIP_DENY_ALL_CONFIG = JSON.stringify(
  Object.fromEntries(KNIP_PLUGIN_NAMES.map((name) => [name, false])),
);
const PATH_GUARD_ROOT =
  "const fs=require('fs');const path=require('path');let root=process.cwd();try{root=fs.realpathSync(root);}catch(e){}";
const WRITE_CODE = [
  PATH_GUARD_ROOT,
  "const target=path.resolve(root,process.argv[1]);",
  "const rel=path.relative(root,target);",
  "if(rel===''||rel.startsWith('..')||path.isAbsolute(rel)){process.exit(3);}",
  "const parts=rel.split(path.sep);let cur=root;",
  "for(let i=0;i<parts.length-1;i+=1){cur=path.join(cur,parts[i]);try{const st=fs.lstatSync(cur);if(st.isSymbolicLink()){process.exit(4);}const real=fs.realpathSync(cur);const rr=path.relative(root,real);if(rr.startsWith('..')||path.isAbsolute(rr)){process.exit(6);}if(!st.isDirectory()){process.exit(5);}}catch(e){if(e&&e.code==='ENOENT'){fs.mkdirSync(cur);}else{throw e;}}}",
  "const finalPath=path.join(root,rel);",
  "try{const st=fs.lstatSync(finalPath);if(st.isSymbolicLink()){fs.unlinkSync(finalPath);}}catch(e){}",
  "const crypto=require('crypto');",
  "const tmp=finalPath+'.tmp-'+process.pid+'-'+crypto.randomBytes(6).toString('hex');",
  "fs.writeFileSync(tmp,process.argv[2],{encoding:'utf8',flag:'wx'});",
  "fs.renameSync(tmp,finalPath);",
].join("");
const CHECK_WORKSPACE_CODE = [
  PATH_GUARD_ROOT,
  "for(const p of ['.code-scan','.code-scan/tmp','.code-scan/repos','.code-scan/selectors']){",
  "try{const st=fs.lstatSync(p);if(st.isSymbolicLink()||!st.isDirectory()){process.exit(1);}",
  "const real=fs.realpathSync(p);const rel=path.relative(root,real);",
  "if(rel.startsWith('..')||path.isAbsolute(rel)){process.exit(1);}}catch(e){if(e&&e.code!=='ENOENT'){process.exit(1);}}",
  "}",
].join("");
const CHECK_PATH_CODE = [
  PATH_GUARD_ROOT,
  "const target=path.resolve(root,process.argv[1]);const rel=path.relative(root,target);",
  "if(rel.startsWith('..')||path.isAbsolute(rel)){process.exit(1);}",
  "let cur=root;",
  "for(const part of rel.split(path.sep)){cur=path.join(cur,part);try{const st=fs.lstatSync(cur);if(st.isSymbolicLink()){process.exit(1);}const real=fs.realpathSync(cur);const rr=path.relative(root,real);if(rr.startsWith('..')||path.isAbsolute(rr)){process.exit(1);}}catch(e){if(e&&e.code==='ENOENT'){break;}process.exit(1);}}",
].join("");
const CHECK_DIR_EXISTS_CODE = [
  "const fs=require('fs');const p=process.argv[1];let st;",
  "try{st=fs.statSync(p);}catch(e){process.exit(1);}",
  "if(!st.isDirectory()){process.exit(1);}",
].join("");
const OUTPUT_CODE = [
  "const fs=require('fs');const path=require('path');",
  "const base=path.resolve(process.cwd(),'.code-scan/tmp');",
  "fs.mkdirSync(base,{recursive:true});",
  "const dir=fs.mkdtempSync(path.join(base,'jscpd-'));",
  "process.stdout.write(path.relative(process.cwd(),dir));",
].join("");
/** 定位 npm 自带的 npx-cli.js;Windows 不能直接 spawn npx/npx.cmd,必须用 node 启动该脚本。 */
const NPX_PATH_CODE = [
  "const fs=require('fs'),path=require('path');",
  "const dir=path.dirname(process.execPath);",
  "const candidates=process.platform==='win32'",
  "?[path.join(dir,'node_modules/npm/bin/npx-cli.js')]",
  ":[path.join(dir,'../lib/node_modules/npm/bin/npx-cli.js')];",
  "const found=candidates.find((p)=>fs.existsSync(p));",
  "process.stdout.write(found||'');",
].join("");
/**
 * 按 Node 的 FS 语义逐路径判定存在性(输出 JSON 布尔数组)。
 * npm/knip 用 stat/readFile:Windows 大小写不敏感、符号链接会被跟随;
 * workflow 的 files.glob 走自己的 walker(大小写敏感、跳过 symlink),不能用于安全判断。
 * 只有 ENOENT 算不存在;EACCES/ELOOP 等异常让进程失败,由 fsPresence fail-closed。
 */
const FS_EXISTS_CODE = [
  "const fs=require('fs');",
  "process.stdout.write(JSON.stringify(process.argv.slice(1).map((p)=>{try{fs.lstatSync(p);return true}catch(e){if(e&&e.code==='ENOENT'){return false}throw e}})));",
].join("");
/**
 * 复刻 npm 的项目定位,一次输出 npm 可能读取的 project .npmrc 与 PATH 中可见的工具 shim:
 * - localPrefix 是 cwd 向上第一个含 package.json/node_modules 的目录;更高层声明 workspaces 的目录会被 npm 当作工作区根;
 * - .npmrc 跳过 home(与 userconfig 同路径,npm 明确忽略);
 * - .bin 检查 cwd 及其所有祖先(npm 的 run-script PATH 会逐级向上查找),按固定工具名匹配任意扩展名
 *   (Windows PATHEXT 含 .bat/.com 等,不能枚举后缀),readdir 跟随 symlink 目录;
 * - cmd.exe 解析命令时先查当前目录,所以工作区根、npm 前缀与隐式 workspace 包根下与工具同名的 PATHEXT 可执行文件(如 jscpd.bat)也算 shim。
 * 任何非 ENOENT/ENOTDIR 的异常都退出非零,调用方 fail-closed。
 */
const NPM_GUARD_CODE = [
  "const fs=require('fs'),path=require('path'),os=require('os');",
  "const cwd=process.argv[1];const home=os.homedir();const tools=['jscpd','knip','madge','ast-grep'];",
  "const statOrNull=(p)=>{try{return fs.statSync(p)}catch(e){if(e&&e.code==='ENOENT'){return null}throw e}};",
  "const envUser=Object.keys(process.env).filter((k)=>/^npm_config_userconfig$/i.test(k)&&process.env[k]).map((k)=>process.env[k]);",
  "const userconfig=path.resolve(envUser.length>0?envUser[0]:path.join(home,'.npmrc'));",
  "const hasPackageJson=(p)=>{const st=statOrNull(path.join(p,'package.json'));return st!==null&&st.isFile()};",
  "const hasNodeModules=(p)=>{const st=statOrNull(path.join(p,'node_modules'));return st!==null&&st.isDirectory()};",
  "const dirs=[];const seen=new Set();const add=(d)=>{if(!seen.has(d)){seen.add(d);dirs.push(d)}};",
  "let prefix=cwd;let p=cwd;let found=false;",
  "while(true){if(hasPackageJson(p)||hasNodeModules(p)){prefix=p;found=true;break}const parent=path.dirname(p);if(parent===p){break}p=parent}",
  "add(cwd);add(found?prefix:cwd);",
  "p=found?prefix:cwd;",
  "while(true){const parent=path.dirname(p);if(parent===p){break}p=parent;let raw=null;",
  "try{raw=fs.readFileSync(path.join(p,'package.json'),'utf8')}catch(e){if(!(e&&e.code==='ENOENT')){throw e}}",
  "if(raw!==null){let pkg=null;try{pkg=JSON.parse(String(raw).replace(/^\\uFEFF/,''))}catch(e){pkg=null}if(pkg&&pkg.workspaces){add(p)}}}",
  "const npmrc=[];const bins=[];const binDirs=[];const binSeen=new Set();let q=cwd;",
  "while(true){if(!binSeen.has(q)){binSeen.add(q);binDirs.push(q)}const parent=path.dirname(q);if(parent===q){break}q=parent}",
  "for(const dir of dirs){const f=path.join(dir,'.npmrc');if(f!==userconfig&&statOrNull(f)!==null){npmrc.push(f)}}",
  "for(const dir of binDirs){const bin=path.join(dir,'node_modules','.bin');let entries=[];",
  "try{entries=fs.readdirSync(bin)}catch(e){if(e&&(e.code==='ENOENT'||e.code==='ENOTDIR')){entries=[]}else{throw e}}",
  "for(const name of entries){const lower=name.toLowerCase();if(!tools.some((t)=>lower===t||lower.startsWith(t+'.'))){continue}const f=path.join(bin,name);let st=null;try{st=fs.statSync(f)}catch(e){if(e&&e.code==='ENOENT'){continue}throw e}if(st.isFile()){bins.push(f)}}",
  "}",
  "const exts=('.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'+(process.env.PATHEXT?';'+process.env.PATHEXT:'')).split(';').map((s)=>s.trim().toLowerCase()).filter(Boolean);",
  // cmd.exe 解析命令时先查当前目录,再查 PATH;run-script 的 cwd 可能是工作区根或隐式 workspace 包根。
  "for(const dir of dirs){for(const name of fs.readdirSync(dir)){const lower=name.toLowerCase();if(!tools.some((t)=>lower===t||exts.some((e)=>lower===t+e))){continue}const f=path.join(dir,name);let st=null;try{st=fs.statSync(f)}catch(e){if(e&&e.code==='ENOENT'){continue}throw e}if(st.isFile()){bins.push(f)}}}",
  "process.stdout.write(JSON.stringify({npmrc:npmrc,bins:bins}));",
].join("");

/* ----------------------------------------------------------------------------
 * 运行时复现:主机侧 Node 片段。
 * 工作流脚本没有 Buffer/btoa/fs/path,也没有 process.env,所以编码、遍历、
 * 路径解析、锁、manifest 解析都必须走 world.run("node", ["-e", SNIPPET, ...])。
 * 所有大段 JS 用 String.raw,避免模板转义把正则里的反斜杠吃掉。
 * -------------------------------------------------------------------------- */

/**
 * 只查 docker 的顶替检查。
 * 不能复用 NPM_GUARD_CODE:那里返回单一 bins 数组,npmToolsShadowed 看到任意一个
 * docker shim 会把 ast/graph/knip/jscpd 一起停掉。
 */
const DOCKER_GUARD_CODE = [
  "const fs=require('fs'),path=require('path');",
  "const cwd=process.argv[1];",
  "const exts=('.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'+(process.env.PATHEXT?';'+process.env.PATHEXT:'')).split(';').map((s)=>s.trim().toLowerCase()).filter(Boolean);",
  "const bins=[];const seen=new Set();let p=cwd;",
  "while(true){if(seen.has(p)){break}seen.add(p);let entries=[];try{entries=fs.readdirSync(p)}catch(e){if(!(e&&e.code==='ENOENT')){throw e}}",
  "for(const name of entries){const lower=name.toLowerCase();if(!(lower==='docker'||exts.some((e)=>lower==='docker'+e))){continue}const f=path.join(p,name);let st=null;try{st=fs.statSync(f)}catch(e){if(e&&e.code==='ENOENT'){continue}throw e}if(st.isFile()){bins.push(f)}}",
  "const parent=path.dirname(p);if(parent===p){break}p=parent}",
  "process.stdout.write(JSON.stringify(bins));",
].join("");

/** DOCKER_HOST 会静默覆盖 context;工作流脚本读不到 process.env,只能走片段。 */
const ENV_CODE = "process.stdout.write(JSON.stringify({dockerHost:process.env.DOCKER_HOST||''}));";

/**
 * 把 spec 编码成 base64,同时按 UTF-8 字节检查脚本上限。
 * 8,192 个非 ASCII 字符是 24,576 字节,base64 后 32,768 字符,单独就撞上 Windows 命令行上限,
 * 所以脚本上限按字节而不是字符。
 */
const B64_CODE = String.raw`
const max=Number(process.argv[1]);
const spec=JSON.parse(process.argv[2]);
const script=typeof spec.script==='string'?spec.script:'';
const bytes=Buffer.byteLength(script,'utf8');
if(script===''||bytes>max){process.stdout.write(JSON.stringify({ok:false,reason:'script too large or empty',bytes}));process.exit(0);}
const b64=Buffer.from(process.argv[2],'utf8').toString('base64');
if(b64.length>24000){process.stdout.write(JSON.stringify({ok:false,reason:'encoded spec too large',bytes}));process.exit(0);}
process.stdout.write(JSON.stringify({ok:true,b64,bytes}));
`;

/**
 * 递归 lstat:发现任何符号链接/联接就失败。
 * node_modules 与 .git 跳过:node_modules 会被只读依赖卷整体覆盖,且 npm 的
 * workspace 会造一堆 symlink,硬查会让绝大多数已装依赖的仓库无法复现。
 */
const WALK_LINKS_CODE = String.raw`
const fs=require('fs'),path=require('path');
const root=fs.realpathSync(process.argv[1]);const max=Number(process.argv[2])||50000;
const out=(o)=>{process.stdout.write(JSON.stringify(o));process.exit(0);};
let count=0;const stack=[{dir:root,depth:0}];
while(stack.length>0){
  const frame=stack.pop();const dir=frame.dir;const depth=frame.depth;let entries=[];
  try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch(e){out({ok:false,reason:'unreadable directory'});}
  for(const ent of entries){
    const full=path.join(dir,ent.name);
    if(ent.name==='node_modules'){
      // 根 node_modules 会被只读依赖卷整体覆盖,容器看不见宿主的它。
      // 嵌套 node_modules 仍暴露在 /src 里,仓库自带依赖会绕过安装策略,所以整体跳过该仓库。
      if(depth===0){continue;}
      let st0=null;try{st0=fs.lstatSync(full);}catch(e){continue;}
      if(st0.isDirectory()){out({ok:false,reason:'host node_modules: '+path.relative(root,full)});}
    }
    count+=1;
    if(count>max){out({ok:false,reason:'too many entries'});}
    let st=null;
    try{st=fs.lstatSync(full);}catch(e){continue;}
    if(st.isSymbolicLink()){out({ok:false,reason:'symlink: '+path.relative(root,full)});}
    if(st.isDirectory()){stack.push({dir:full,depth:depth+1});}
  }
}
out({ok:true,entries:count});
`;

/** realpath + 目录校验:输出可直接作为 --mount 源的绝对路径。 */
const REALPATH_CODE = String.raw`
const fs=require('fs'),path=require('path');
let real=null;
try{real=fs.realpathSync(process.argv[1]);}catch(e){process.exit(1);}
const st=fs.statSync(real);
if(!st.isDirectory()){process.exit(1);}
process.stdout.write(real);
`;

/** 审计目录:系统临时目录 + mkdtemp;每次运行唯一,不写工作区。 */
const AUDIT_DIR_CODE = String.raw`
const fs=require('fs'),os=require('os'),path=require('path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'code-scan-audit-'));
process.stdout.write(dir);
`;

/** 审计写入:固定文件名 + wx 独占创建;内容先脱敏。绝不把模型字符串拼进路径。 */
const AUDIT_WRITE_CODE = String.raw`
const fs=require('fs'),path=require('path');
const dir=process.argv[1];const name=process.argv[2];
const st=fs.statSync(dir);
if(!st.isDirectory()){process.exit(1);}
let okName=name.length>0&&name.length<=48;
for(const ch of name){const c=ch.charCodeAt(0);if(!((c>=48&&c<=57)||(c>=97&&c<=122)||c===45||c===46)){okName=false;}}
if(!okName){process.exit(1);}
// 审计目录同样只存脱敏后的文本(脚本/argv 里可能含证据带出的凭据)。
const content=String(process.argv[3]||'')
  .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/g,'$1[redacted]@')
  .replace(/(AKIA|ASIA)[0-9A-Z]{16}/g,'[redacted]')
  .replace(/\b(ghp_|gho_|ghu_|ghs_|ghr_|glpat-|xox[bpar]-|sk-)[A-Za-z0-9_-]{10,}/g,'[redacted]')
  .replace(/(_authToken|_auth|password|secret|token)\s*=\s*\S+/gi,'$1=[redacted]')
  .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,'[redacted]');
fs.writeFileSync(path.join(dir,name),content,{encoding:'utf8',flag:'wx'});
`;

/**
 * 跨进程安装锁:os.tmpdir() 下原子 mkdir。
 * acquire: 拿到返回 OK,超时 BUSY;release: 删除后返回 OK。
 */
const LOCK_CODE = String.raw`
const fs=require('fs'),os=require('os'),path=require('path');
const name=process.argv[1];const waitMs=Number(process.argv[2])||0;const mode=process.argv[3]||'acquire';
let okName=name.length>0&&name.length<=120;
for(const ch of name){const c=ch.charCodeAt(0);if(!((c>=48&&c<=57)||(c>=97&&c<=122)||c===45)){okName=false;}}
if(!okName){process.stdout.write('BAD');process.exit(0);}
const file=path.join(os.tmpdir(),'code-scan-lock-'+name);
if(mode==='release'){try{fs.rmdirSync(file);}catch(e){}process.stdout.write('OK');process.exit(0);}
const until=Date.now()+waitMs;let got=false;
while(true){
  try{fs.mkdirSync(file);got=true;break;}catch(e){if(!(e&&e.code==='EEXIST')){process.stdout.write('ERR');process.exit(0);}}
  if(Date.now()>=until){break;}
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);
}
process.stdout.write(got?'OK':'BUSY');
`;

/** npm 缓存根(<home>/.npm)。注意是缓存根不是 _cacache:content store 在 <cache>/_cacache。 */
const NPM_CACHE_CODE = String.raw`
const fs=require('fs'),os=require('os'),path=require('path');
const dir=path.join(os.homedir(),'.npm');
let st=null;
try{st=fs.statSync(dir);}catch(e){process.exit(1);}
if(!st.isDirectory()){process.exit(1);}
process.stdout.write(dir);
`;

/**
 * manifest 指令级检查(与 installer 里的检查同一份规则,防竞态)。
 * 只解析 JSON、做字符串比较,不 require 仓库代码、不 eval。
 */
const MANIFEST_CHECK_CODE = String.raw`
const fs=require('fs'),path=require('path');
const root=path.resolve(process.argv[1]);const maxBytes=Number(process.argv[2]);
const out=(o)=>{process.stdout.write(JSON.stringify(o));process.exit(0);};
const exists=(f)=>{try{return fs.lstatSync(f);}catch(e){if(e&&e.code==='ENOENT'){return null;}throw e;}};
const readManifest=(f)=>{const st=exists(f);if(st===null){out({ok:false,reason:'missing: '+path.basename(f)});}if(!st.isFile()){out({ok:false,reason:'not a regular file: '+path.basename(f)});}if(st.size>maxBytes){out({ok:false,reason:'too large: '+path.basename(f)});}return fs.readFileSync(f,'utf8');};
const sanitize=(v)=>{let s=String(v==null?'':v).slice(0,40);let o='';for(const ch of s){const c=ch.charCodeAt(0);o+=(c>=32&&c<=126)?ch:'?';}return o;};
const pj=path.join(root,'package.json');
if(exists(pj)===null){out({ok:false,reason:'no package.json'});}
const pkg=JSON.parse(readManifest(pj).replace(/^\uFEFF/,''));
const allowed='~^*<>=| 0123456789.xX+-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const specOk=(spec)=>{
  if(typeof spec!=='string'){return false;}
  const v=spec.trim();
  if(v===''){return false;}
  if(/[\\/:]/.test(v)){return false;}
  if(/^(workspace|link|file|portal|patch)$/i.test(v)){return false;}
  for(const ch of v){if(!allowed.includes(ch)){return false;}}
  return true;
};
const walk=(obj,where)=>{
  if(!obj||typeof obj!=='object'){return null;}
  for(const k of Object.keys(obj)){
    const v=obj[k];
    if(typeof v==='string'){if(!specOk(v)){return 'unsupported spec in '+where+': '+sanitize(k);}}
    else if(v&&typeof v==='object'){const nested=walk(v,where+'.'+sanitize(k));if(nested!==null){return nested;}}
  }
  return null;
};
for(const s of ['dependencies','devDependencies','optionalDependencies','peerDependencies']){
  const bad=walk(pkg&&pkg[s],s);
  if(bad!==null){out({ok:false,reason:bad});}
}
const badOverride=walk(pkg&&pkg.overrides,'overrides');
if(badOverride!==null){out({ok:false,reason:badOverride});}
const LIFECYCLE=['preinstall','install','postinstall','prepare','prepack','prepublish'];
const scripts=(pkg&&pkg.scripts)||{};
for(const k of LIFECYCLE){
  if(typeof scripts[k]==='string'&&scripts[k].trim()!==''){out({ok:false,reason:'lifecycle script present: '+k});}
}
if(pkg&&pkg.workspaces!==undefined){out({ok:false,reason:'workspaces field present'});}
for(const f of ['pnpm-workspace.yaml','lerna.json']){
  if(exists(path.join(root,f))!==null){out({ok:false,reason:'workspace config present: '+f});}
}
if(exists(path.join(root,'.npmrc'))!==null){out({ok:false,reason:'project .npmrc present'});}
const LOCKS=['npm-shrinkwrap.json','package-lock.json'];
const lockPath=LOCKS.map((f)=>path.join(root,f)).find((p)=>exists(p)!==null)||'';
if(lockPath===''){out({ok:false,reason:'no lockfile'});}
const lock=JSON.parse(readManifest(lockPath));
const lv=Number(lock&&lock.lockfileVersion);
if(!(lv===2||lv===3)){out({ok:false,reason:'lockfileVersion not 2/3'});}
const pkgs=(lock&&lock.packages);
if(!pkgs||typeof pkgs!=='object'||Array.isArray(pkgs)||Object.keys(pkgs).length===0){out({ok:false,reason:'lockfile has no packages map'});}
for(const key of Object.keys(pkgs)){
  if(key===''){continue;}
  const e=pkgs[key];
  if(!e||typeof e!=='object'){out({ok:false,reason:'lockfile entry malformed'});}
  if(typeof e.resolved!=='string'||typeof e.integrity!=='string'||e.resolved.trim()===''||e.integrity.trim()===''){out({ok:false,reason:'lockfile entry missing resolved/integrity: '+sanitize(key)});}
  let u=null;
  try{u=new URL(e.resolved);}catch(err){out({ok:false,reason:'lockfile resolved not a URL'});}
  if(u.protocol!=='https:'){out({ok:false,reason:'lockfile resolved not https: '+sanitize(key)});}
  if(u.hostname.toLowerCase()!=='registry.npmjs.org'){out({ok:false,reason:'lockfile resolved host not allowlisted'});}
  if(u.port!==''&&u.port!=='443'){out({ok:false,reason:'lockfile resolved port not allowed'});}
}
out({ok:true});
`;

/**
 * 建只含 package.json + lockfile 的暂存目录,作为 install 容器的 /src。
 * 每个文件先 lstat 确认是普通文件(不跟随符号链接),再按大小上限复制。
 * 同时算 fingerprint:生效 lockfile + package.json + 镜像 + 平台 + 安装策略版本。
 */
const MANIFEST_STAGE_CODE = String.raw`
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const src=path.resolve(process.argv[1]);const maxBytes=Number(process.argv[2]);
const image=process.argv[3];const policy=process.argv[4];const identity=process.argv[5]||src;
const out=(o)=>{process.stdout.write(JSON.stringify(o));process.exit(0);};
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'code-scan-manifest-'));
// mkdtemp 默认 0700,而安装容器以 65534 读取该 bind 目录;不放开权限在 Linux/macOS 上会 EACCES。
fs.chmodSync(dir,0o755);
const names=['package.json','npm-shrinkwrap.json','package-lock.json'];
const copied=[];let lockfile='';
for(const name of names){
  const from=path.join(src,name);let st=null;
  try{st=fs.lstatSync(from);}catch(e){if(e&&e.code==='ENOENT'){continue;}throw e;}
  if(!st.isFile()){out({ok:false,reason:'manifest not a regular file: '+name});}
  if(st.size>maxBytes){out({ok:false,reason:'manifest too large: '+name});}
  fs.copyFileSync(from,path.join(dir,name));
  fs.chmodSync(path.join(dir,name),0o644);
  copied.push(name);
  if(name!=='package.json'&&lockfile===''){lockfile=name;}
}
if(!copied.includes('package.json')){out({ok:false,reason:'no package.json'});}
if(lockfile===''){out({ok:false,reason:'no lockfile'});}
const h=crypto.createHash('sha256');
for(const name of copied){h.update(name);h.update('\u0000');h.update(fs.readFileSync(path.join(dir,name)));h.update('\u0000');}
h.update(image);h.update('\u0000');h.update(process.platform);h.update('\u0000');h.update(String(policy));
const repoId=crypto.createHash('sha256').update(String(identity)).digest('hex').slice(0,20);
out({ok:true,dir,lockfile,fingerprint:h.digest('hex').slice(0,16),repoId});
`;

/**
 * 固定 runner:编译期源码,作为单个 argv 元素 `node -e <RUNNER>` 执行,不经过 shell。
 * 判定数据只从固定文件 /work/result.json 读;stdout 完全不参与判定。
 * 先脱敏完整输出再截断,避免 token 跨 1500 字符边界时正则失配。
 */
const RUNNER_SRC = String.raw`
const fs = require('fs');

function redact(s) {
  return String(s)
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[redacted]@')
    .replace(/(AKIA|ASIA)[0-9A-Z]{16}/g, '[redacted]')
    .replace(/\b(ghp_|gho_|ghu_|ghs_|ghr_|glpat-|xox[bpar]-|sk-)[A-Za-z0-9_-]{10,}/g, '[redacted]')
    .replace(/(_authToken|_auth|password|secret|token)\s*=\s*\S+/gi, '$1=[redacted]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted]');
}

function redactDeep(v, depth) {
  if (depth > 6) { return '[depth]'; }
  if (typeof v === 'string') { return redact(v); }
  if (Array.isArray(v)) { return v.map((x) => redactDeep(x, depth + 1)); }
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) { o[k] = redactDeep(v[k], depth + 1); }
    return o;
  }
  return v;
}

const ASSERT_SRC = [
  "const A = __ASSERTION__;",
  "module.exports = (d) => {",
  "  if (!A || typeof A.kind !== 'string') { return null; }",
  "  if (A.kind === 'throws') {",
  "    if (typeof A.match !== 'string' || A.match.length === 0) { return null; }",
  "    return d.threw === true && String(d.message).includes(A.match);",
  "  }",
  "  if (A.kind === 'not-equals') {",
  "    if (typeof A.expected !== 'string') { return null; }",
  "    return String(d.actual) !== A.expected;",
  "  }",
  "  if (A.kind === 'ratio-greater') {",
  "    const t1 = Number(d.t1Ms), t2 = Number(d.t2Ms), th = Number(A.threshold);",
  "    if (!isFinite(t1) || !isFinite(t2) || !isFinite(th)) { return null; }",
  "    if (th < 2.5 || th > 100) { return null; }",
  "    if (t1 < 50) { return null; }",
  "    return t2 / t1 > th;",
  "  }",
  "  return null;",
  "};",
].join('\n');

function emit(o) { process.stdout.write('@@RUNNER@@' + JSON.stringify(o) + '\n'); }

const HARNESS_SRC = [
  "const fs = require('fs');",
  "const RESULT = '/work/result.json';",
  "const write = (o) => { try { fs.writeFileSync(RESULT, JSON.stringify(o)); } catch (e) { } };",
  "let mod;",
  "try { mod = require('/work/impl.cjs'); }",
  "catch (e) { write({ stage: 'load', error: String(e && e.message || e) }); process.exit(0); }",
  "if (!mod || typeof mod.run !== 'function') { write({ stage: 'contract', error: 'module.exports.run missing' }); process.exit(0); }",
  "(async () => {",
  "  try {",
  "    const data = await mod.run();",
  "    if (data === null || typeof data !== 'object') {",
  "      write({ stage: 'contract', error: 'run() must return an object, got ' + typeof data });",
  "      process.exit(0);",
  "    }",
  "    let safe;",
  "    try { safe = JSON.parse(JSON.stringify(data)); }",
  "    catch (e) { write({ stage: 'serialize', error: String(e && e.message || e) }); process.exit(0); }",
  "    let verdict = null;",
  "    try { verdict = require('/work/assert.cjs')(data); } catch (e) { verdict = null; }",
  "    write({ stage: 'done', data: safe, verdict });",
  "  } catch (e) { write({ stage: 'run', error: String(e && e.message || e) }); }",
  "})();",
].join('\n');

try {
  const spec = JSON.parse(Buffer.from(process.env.REPRO_SPEC_B64 || '', 'base64').toString('utf8'));
  if (typeof spec.script !== 'string' || spec.script.length === 0) {
    emit({ phase: 'spec', error: 'script missing' });
  } else {
    fs.writeFileSync('/work/impl.cjs', spec.script);
    fs.writeFileSync('/work/harness.cjs', HARNESS_SRC);
    // 必须用函数形式替换:字符串形式会把 $& / $$ / $' 当成替换模式,含 $' 时还会注入换行。
    fs.writeFileSync('/work/assert.cjs', ASSERT_SRC.replace('__ASSERTION__', () => JSON.stringify(spec.assertion || null)));
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, ['/work/harness.cjs'], {
      cwd: '/src',
      encoding: 'utf8',
      timeout: 52000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: '/tmp',
        TMPDIR: '/tmp',
        NODE_PATH: process.env.NODE_PATH || '/src/node_modules',
      },
    });
    let payload = null;
    try { payload = JSON.parse(fs.readFileSync('/work/result.json', 'utf8')); } catch (e) { payload = null; }
    emit({
      phase: 'run',
      status: typeof r.status === 'number' ? r.status : -1,
      signal: r.signal || '',
      timedOut: !!(r.error && /ETIMEDOUT/i.test(String(r.error.message || r.error))),
      payload: payload === null ? null : redactDeep(payload, 0),
      verdict: payload && typeof payload.verdict === 'boolean' ? payload.verdict : null,
      stdoutTail: redact(String(r.stdout || '')).slice(-1500),
      stderrTail: redact(String(r.stderr || '')).slice(-1500),
    });
  }
} catch (e) {
  emit({ phase: 'runner', error: redact(String(e && e.message || e)) });
}
`;

/**
 * 固定 installer:编译期源码,`node -e <INSTALLER>` 执行,不经过 shell。
 * /src 是只含 manifest/lockfile 的暂存目录,仓库源码物理不可见。
 * 依赖装进 /deps/stage,成功后发布到 volume 根(/deps),再写成功标记。
 */
const INSTALLER_SRC = String.raw`
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const OFFLINE = process.env.INSTALL_MODE !== 'online';
const emit = (o) => process.stdout.write('@@INSTALL@@' + JSON.stringify(o) + '\n');
const sanitize = (v) => String(v === null || v === undefined ? '' : v).slice(0, 40).replace(/[^\x20-\x7e]/g, '?');
const REJECT = (reason) => { emit({ ok: false, reason }); process.exit(0); };

function specOk(spec) {
  if (typeof spec !== 'string') return false;
  const v = spec.trim();
  if (v === '') return false;
  if (/[\\/:]/.test(v)) return false;
  if (/^(workspace|link|file|portal|patch)$/i.test(v)) return false;
  return /^[~^*<>=|\s0-9.xXa-zA-Z+-]*$/.test(v);
}

try {
  let raw;
  try { raw = fs.readFileSync('/src/package.json', 'utf8'); } catch (e) { REJECT('no package.json'); }
  let pkg;
  try { pkg = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (e) { REJECT('package.json unparsable'); }

  const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  const walkSpecs = (obj, where) => {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string') {
        if (!specOk(v)) return 'unsupported spec in ' + where + ': ' + sanitize(k);
      } else if (v && typeof v === 'object') {
        const nested = walkSpecs(v, where + '.' + sanitize(k));
        if (nested !== null) return nested;
      }
    }
    return null;
  };
  for (const s of SECTIONS) {
    const bad = walkSpecs(pkg && pkg[s], s);
    if (bad !== null) REJECT(bad);
  }
  const badOverride = walkSpecs(pkg && pkg.overrides, 'overrides');
  if (badOverride !== null) REJECT(badOverride);

  const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'prepublish'];
  const scripts = (pkg && pkg.scripts) || {};
  for (const k of LIFECYCLE) {
    if (typeof scripts[k] === 'string' && scripts[k].trim() !== '') {
      REJECT('lifecycle script present: ' + k);
    }
  }

  if (pkg && pkg.workspaces !== undefined) REJECT('workspaces field present');
  for (const f of ['pnpm-workspace.yaml', 'lerna.json']) {
    if (fs.existsSync(path.join('/src', f))) REJECT('workspace config present: ' + f);
  }
  if (fs.existsSync('/src/.npmrc')) REJECT('project .npmrc present');

  const LOCKS = ['npm-shrinkwrap.json', 'package-lock.json'];
  const lockPath = LOCKS.map((f) => path.join('/src', f)).find((p) => fs.existsSync(p)) || '';
  if (lockPath === '') REJECT('no lockfile');
  let lock;
  try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (e) { REJECT('lockfile unparsable'); }
  const lv = Number(lock && lock.lockfileVersion);
  if (!(lv === 2 || lv === 3)) REJECT('lockfileVersion not 2/3: ' + sanitize(lv));
  const pkgs = (lock && lock.packages);
  if (!pkgs || typeof pkgs !== 'object' || Array.isArray(pkgs) || Object.keys(pkgs).length === 0) {
    REJECT('lockfile has no packages map');
  }
  for (const key of Object.keys(pkgs)) {
    if (key === '') continue;
    const e = pkgs[key];
    if (!e || typeof e !== 'object') REJECT('lockfile entry malformed');
    if (typeof e.resolved !== 'string' || typeof e.integrity !== 'string' || e.resolved.trim() === '' || e.integrity.trim() === '') {
      REJECT('lockfile entry missing resolved/integrity: ' + sanitize(key));
    }
    let u;
    try { u = new URL(e.resolved); } catch (e2) { REJECT('lockfile resolved not a URL'); }
    if (u.protocol !== 'https:') REJECT('lockfile resolved not https: ' + sanitize(key));
    if (u.hostname.toLowerCase() !== 'registry.npmjs.org') REJECT('lockfile resolved host not allowlisted');
    if (u.port !== '' && u.port !== '443') REJECT('lockfile resolved port not allowed');
  }

  fs.writeFileSync('/tmp/npm-userconfig', '');
  fs.writeFileSync('/tmp/npm-globalconfig', '');

  const stage = '/tmp/stage';
  const target = '/deps/tree';
  fs.mkdirSync(stage, { recursive: true, mode: 0o777 });
  fs.mkdirSync(target, { recursive: true, mode: 0o777 });
  for (const f of ['package.json', 'npm-shrinkwrap.json', 'package-lock.json']) {
    const from = path.join('/src', f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(stage, f));
  }

  const env = {
    PATH: process.env.PATH,
    HOME: '/tmp',
    TMPDIR: '/tmp',
    npm_config_userconfig: '/tmp/npm-userconfig',
    npm_config_globalconfig: '/tmp/npm-globalconfig',
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
  if (OFFLINE) {
    env.npm_config_cache = '/npm-cache';
    env.npm_config_offline = 'true';
  } else {
    env.npm_config_cache = '/tmp/npm-cache';
  }
  const args = ['ci', '--omit=optional', '--no-audit', '--no-fund'];
  if (OFFLINE) args.push('--offline');

  const r = spawnSync('npm', args, {
    cwd: stage, encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024, env,
  });
  const out = String(r.stdout || '');
  const err = String(r.stderr || '');
  if (r.status !== 0) {
    emit({
      ok: false,
      offline: OFFLINE,
      status: typeof r.status === 'number' ? r.status : -1,
      stdoutTail: redact(out).slice(-1200),
      stderrTail: redact(err).slice(-1200),
    });
    process.exit(0);
  }

  for (const name of fs.readdirSync(path.join(stage, 'node_modules'))) {
    const dst = path.join(target, name);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(path.join(stage, 'node_modules', name), dst, { recursive: true });
  }
  fs.rmSync(stage, { recursive: true, force: true });

  fs.writeFileSync(target + '/.code-scan-install-ok', JSON.stringify({
    fingerprint: process.env.DEPS_FINGERPRINT || '',
    offline: OFFLINE,
    at: new Date().toISOString(),
  }));

  emit({ ok: true, offline: OFFLINE, status: 0, stdoutTail: redact(out).slice(-1200), stderrTail: redact(err).slice(-1200) });
} catch (e) {
  emit({ ok: false, reason: redact(String((e && e.message) || e)) });
}

function redact(s) {
  return String(s)
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[redacted]@')
    .replace(/(AKIA|ASIA)[0-9A-Z]{16}/g, '[redacted]')
    .replace(/\b(ghp_|gho_|ghu_|ghs_|ghr_|glpat-|xox[bpar]-|sk-)[A-Za-z0-9_-]{10,}/g, '[redacted]')
    .replace(/(_authToken|_auth|password|secret|token)\s*=\s*\S+/gi, '$1=[redacted]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted]');
}
`;

const goal = typeof args.goal === "string" ? args.goal : "全面扫描:质量 / 冗余 / 性能";
const maxFilesPerBatch =
  typeof args.maxFilesPerBatch === "number" ? Math.max(3, Math.min(20, args.maxFilesPerBatch)) : 8;
const maxTotalBatches = typeof args.maxTotalBatches === "number" ? Math.max(0, Math.min(200, args.maxTotalBatches)) : 0;
const defaultSelectorBudget =
  typeof args.selectorBudget === "number" ? Math.max(20, Math.min(2000, args.selectorBudget)) : DEFAULT_SELECTOR_BUDGET;
const refreshSelectors = args.refreshSelectors === true;
const runtimeVerify = args.runtimeVerify === true;
const runtimeVerifyOnline = args.runtimeVerifyOnline === true;
const specs = toRepoSpecs(args.repos);
const targets: RepoSpec[] =
  specs.length > 0 ? specs : [{ name: "当前工作区", url: "", ref: "", localPath: "." }];

/** 限制数值范围。 */
function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** 仓库名转文件安全 slug,保留非拉丁字符。 */
function slug(value: string): string {
  const cleaned = value
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/[ .]+$/g, "");
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return "repo";
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) {
    return `${cleaned}-repo`;
  }
  return cleaned;
}

/** 本次运行内唯一 slug:同名仓库自动加 -2/-3 后缀。 */
function uniqueKey(name: string, used: Set<string>): string {
  const base = slug(name);
  let key = base;
  let suffix = 2;
  while (used.has(key)) {
    key = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(key);
  return key;
}

/** 本次运行内唯一的展示名:同名仓库加 -2/-3 后缀,避免报告/全局复核串仓。 */
function uniqueName(name: string, used: Set<string>): string {
  const base = name.trim() || "repo";
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  let candidate = `${base}-${suffix}`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

/** 仓库 URL 只允许普通 Git 协议,拒绝 ext:: 等可执行远程助手与前导选项注入。 */
function isSafeRepoUrl(url: string): boolean {
  if (url === "" || url.startsWith("-")) {
    return false;
  }
  if (url.includes("::") || url.includes("\n") || url.includes("\r")) {
    return false;
  }
  return true;
}

/** 本地仓库路径必须是工作区相对路径,不允许绝对路径、UNC、.. 或选项注入。 */
function isSafeLocalPath(path: string): boolean {
  const value = path.replace(/\\/g, "/");
  if (
    value === "" ||
    value.startsWith("/") ||
    value.startsWith("-") ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return false;
  }
  for (const segment of value.split("/")) {
    if (segment === "") {
      return false;
    }
    if (segment === ".") {
      continue;
    }
    const normalized = segment.replace(/[. ]+$/g, "");
    if (normalized === "" || normalized === "..") {
      return false;
    }
  }
  return true;
}

/** 选择器文本字段不得含控制字符或以 - 开头(Windows cmd shim 与命令行选项的双重防护)。 */
function isSafeSelectorText(value: string): boolean {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return false;
  }
  return !value.startsWith("-");
}

/** ast-grep 支持的规范语言名。 */
function isSupportedAstLang(lang: string): boolean {
  const value = lang.toLowerCase();
  return (
    value === "ts" ||
    value === "typescript" ||
    value === "tsx" ||
    value === "js" ||
    value === "jsx" ||
    value === "javascript" ||
    value === "py" ||
    value === "python" ||
    value === "go" ||
    value === "rs" ||
    value === "rust" ||
    value === "java"
  );
}

/** 分支/标签只允许合法的 ref 字符,拒绝选项注入。 */
function isSafeRef(ref: string): boolean {
  if (ref === "" || ref.startsWith("-") || ref.includes("..")) {
    return false;
  }
  return !/[\s~^:?*[\]\\]/.test(ref);
}

/** 把工作区相对路径归一成仓库相对路径;仓库外路径返回空串。 */
function normPath(repoDir: string, path: string): string {
  let value = path.replace(/\\/g, "/");
  if (value.startsWith("./")) {
    value = value.slice(2);
  }
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  let absoluteUnderRoot = false;
  if (root !== "" && value.startsWith(`${root}/`)) {
    value = value.slice(root.length + 1);
    absoluteUnderRoot = true;
  }
  const dir = repoDir.replace(/\\/g, "/").replace(/^\.\//, "");
  if (dir !== "" && dir !== ".") {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
    const marker = `/${prefix}`;
    const index = value.indexOf(marker);
    if (index >= 0) {
      return value.slice(index + marker.length);
    }
    if (absoluteUnderRoot) {
      return "";
    }
  }
  if (value.startsWith("../") || value.startsWith("/") || /^[A-Za-z]:\//.test(value)) {
    return "";
  }
  if (value.split("/").some((segment) => segment === "..")) {
    return "";
  }
  return value;
}

/** 把仓库相对 glob 拼成工作区相对 glob。 */
function withRepo(repoDir: string, pattern: string): string {
  const trimmed = pattern.replace(/^\.?\//, "");
  const dir = repoDir.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (dir === "." || dir === "") {
    return trimmed;
  }
  return `${dir}/${trimmed}`;
}

/**
 * 检查路径是否存在。lstat 能发现普通文件、符号链接(含断链),
 * Windows 下大小写不敏感,与 npm/knip 的 stat 语义一致。
 * 返回 null 表示检查本身失败;调用方必须 fail-closed。
 */
async function fsPresence(paths: string[]): Promise<boolean[] | null> {
  if (paths.length === 0) {
    return [];
  }
  try {
    const result = await world.run("node", ["-e", FS_EXISTS_CODE, "--", ...paths], { timeoutMs: 60000 });
    if (result.exitCode !== 0) {
      return null;
    }
    const parsed = JSON.parse(result.stdout.trim()) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== paths.length || !parsed.every((value) => typeof value === "boolean")) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** 运行 npm 定位守卫,返回 npm 可能读取的 .npmrc 与可见的工具 shim;失败返回 null。 */
async function npmGuard(root: string): Promise<{ npmrc: string[]; bins: string[] } | null> {
  if (root === "") {
    return null;
  }
  try {
    const result = await world.run("node", ["-e", NPM_GUARD_CODE, "--", root], { timeoutMs: 60000 });
    if (result.exitCode !== 0) {
      return null;
    }
    const parsed = JSON.parse(result.stdout.trim()) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const npmrc = parsed.npmrc;
    const bins = parsed.bins;
    if (!Array.isArray(npmrc) || !npmrc.every((value) => typeof value === "string")) {
      return null;
    }
    if (!Array.isArray(bins) || !bins.every((value) => typeof value === "string")) {
      return null;
    }
    return { npmrc, bins };
  } catch {
    return null;
  }
}

/** 截断文本。 */
function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max) + "…";
}

/** 单行化文本:去掉控制字符并折叠空白,防止日志/报告注入。 */
function oneLine(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** 安全取字符串。 */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 安全取数字。 */
function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 判断是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 解析 JSON;允许输出前后夹带非 JSON 文本。 */
function parseJsonLoose<T>(text: string): T | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // 继续尝试截取
  }
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart && (objectStart < 0 || arrayStart < objectStart)) {
    try {
      return JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1)) as T;
    } catch {
      return null;
    }
  }
  if (objectStart >= 0 && objectEnd > objectStart) {
    try {
      return JSON.parse(trimmed.slice(objectStart, objectEnd + 1)) as T;
    } catch {
      return null;
    }
  }
  return null;
}

/** 逗号分隔的 glob 列表。 */
function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** 将 glob 转成正则;支持 **、*、?。 */
function globToRegExp(pattern: string): RegExp {
  let source = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (source.endsWith("/")) {
    source += "**";
  }
  if (!source.includes("/") && !source.includes("*") && !source.includes("?")) {
    source += "/**";
  }
  let regex = "";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "*") {
      let stars = 1;
      while (i + stars < source.length && source[i + stars] === "*") {
        stars += 1;
      }
      i += stars - 1;
      if (stars >= 2 && i + 1 < source.length && source[i + 1] === "/") {
        regex += "(?:[^/]+/)*";
        i += 1;
      } else if (stars >= 2) {
        regex += ".*";
      } else {
        regex += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    if ("\\.^$+()|[]{}".includes(char)) {
      regex += `\\${char}`;
      continue;
    }
    regex += char;
  }
  return new RegExp(`^${regex}$`);
}

const globCache = new Map<string, RegExp>();

/** 带缓存的 glob 编译;同一规则在成千上万条信号上复用。 */
function globRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  const compiled = globToRegExp(pattern);
  globCache.set(pattern, compiled);
  return compiled;
}

/** 路径是否匹配任一 glob。 */
function matchesAny(path: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern !== "" && globRegExp(pattern).test(path)) {
      return true;
    }
  }
  return false;
}

/** 选择器签名,用于执行缓存与修订复用;JSON 编码避免字段拼接歧义。 */
function selectorSignature(selector: SelectorSpec): string {
  return JSON.stringify([
    selector.id,
    selector.kind,
    selector.lang,
    selector.query,
    selector.scope,
    selector.target,
    selector.exclude,
    selector.intent,
    selector.dimension,
    selector.budget,
  ]);
}

/** 单条选择器的命中预算。 */
function selectorBudget(selector: SelectorSpec): number {
  return selector.budget > 0 ? clamp(selector.budget, 20, 2000) : defaultSelectorBudget;
}

/** 信号排序:路径,再行号。 */
function signalOrder(left: Signal, right: Signal): number {
  if (left.path < right.path) {
    return -1;
  }
  if (left.path > right.path) {
    return 1;
  }
  return left.line - right.line;
}

/** 去重信号:同一位置同一证据只保留置信更高的。 */
function dedupeSignals(signals: Signal[]): Signal[] {
  const seen = new Map<string, Signal>();
  for (const signal of signals) {
    const key = JSON.stringify([signal.path, signal.line, signal.excerpt]);
    const previous = seen.get(key);
    if (previous === undefined || signal.confidence > previous.confidence) {
      seen.set(key, signal);
    }
  }
  return Array.from(seen.values()).sort(signalOrder);
}

/** 按文件聚合信号,并按信号数、扇入排序。 */
function groupSignals(signals: Signal[], fanIn: Map<string, number> | null): SignalGroup[] {
  const byPath = new Map<string, Signal[]>();
  for (const signal of signals) {
    const existing = byPath.get(signal.path);
    if (existing === undefined) {
      byPath.set(signal.path, [signal]);
    } else {
      existing.push(signal);
    }
  }
  const groups: SignalGroup[] = [];
  for (const [path, items] of byPath) {
    groups.push({ path, items: items.slice().sort(signalOrder) });
  }
  groups.sort((left, right) => {
    if (right.items.length !== left.items.length) {
      return right.items.length - left.items.length;
    }
    const leftFanIn = fanIn === null ? 0 : (fanIn.get(left.path) ?? 0);
    const rightFanIn = fanIn === null ? 0 : (fanIn.get(right.path) ?? 0);
    if (rightFanIn !== leftFanIn) {
      return rightFanIn - leftFanIn;
    }
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
  return groups;
}

/** 按文件数与信号量切批:一批最多 maxFiles 个文件、maxSignals 条信号。 */
function packBatches(groups: SignalGroup[], maxFiles: number, maxSignals: number): SignalGroup[][] {
  const batches: SignalGroup[][] = [];
  let current: SignalGroup[] = [];
  let signalCount = 0;
  for (const group of groups) {
    const groupSignals = group.items.length;
    if (current.length > 0 && (current.length >= maxFiles || signalCount + groupSignals > maxSignals)) {
      batches.push(current);
      current = [];
      signalCount = 0;
    }
    current.push(group);
    signalCount += groupSignals;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

/** 把批次信号压成提示词文本;每文件最多展示 MAX_SIGNALS_PER_FILE 条。 */
function formatGroups(groups: SignalGroup[], fanIn: Map<string, number> | null): string {
  const lines: string[] = [];
  const intents = new Map<string, string>();
  for (const group of groups) {
    for (const item of group.items) {
      if (!intents.has(item.selectorId)) {
        intents.set(item.selectorId, item.intent);
      }
    }
  }
  if (intents.size > 0) {
    lines.push("选择器意图:");
    for (const [id, intent] of intents) {
      lines.push(`- ${id}: ${clip(intent, 120)}`);
    }
    lines.push("信号:");
  }
  for (const group of groups) {
    const fanInValue = fanIn === null ? 0 : (fanIn.get(group.path) ?? 0);
    lines.push(`- ${group.path}(信号 ${group.items.length} 条,扇入 ${fanInValue})`);
    const shown = group.items.slice(0, MAX_SIGNALS_PER_FILE);
    for (const item of shown) {
      const lineTag = item.line > 0 ? ` @${item.line}` : "";
      lines.push(
        `  - [${item.selectorId}/${item.dimension}]${lineTag} (${item.provenance}) ${clip(item.excerpt, 140)}`,
      );
    }
    if (group.items.length > shown.length) {
      lines.push(`  - ...另有 ${group.items.length - shown.length} 条信号未展示`);
    }
  }
  return lines.join("\n");
}

function toRepoSpecs(raw: unknown): RepoSpec[] {
  const result: RepoSpec[] = [];
  if (!Array.isArray(raw)) {
    return result;
  }
  for (const item of raw) {
    if (typeof item === "string") {
      const raw = item.trim();
      if (raw === "") {
        continue;
      }
      const shorthand =
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(raw) &&
        !raw.startsWith(".") &&
        !raw.includes("://") &&
        !raw.startsWith("git@");
      const url = shorthand
        ? `https://github.com/${raw.replace(/\.git$/i, "")}.git`
        : raw;
      const name = raw.replace(/^.*[\/:]/g, "").replace(/\.git$/i, "");
      result.push({ name: name !== "" ? name : raw, url, ref: "", localPath: "" });
      continue;
    }
    if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : "";
      const url = typeof record.url === "string" ? record.url : "";
      const ref = typeof record.ref === "string" ? record.ref : "";
      const localPath = typeof record.path === "string" ? record.path : "";
      if (name !== "" && (url !== "" || localPath !== "")) {
        result.push({ name, url, ref, localPath });
      }
    }
  }
  return result;
}

/** 选择器类型是否合法。 */
function isSelectorKind(value: string): boolean {
  return value === "scope" || value === "grep" || value === "ast" || value === "graph" || value === "tool";
}

/** 维度是否合法。 */
function isDimension(value: string): value is RawFinding["dimension"] {
  return value === "quality" || value === "dead-code" || value === "perf";
}

/** graph 规则因依赖图不可用而无法执行;这不是规则本身的问题。 */
function isGraphUnavailable(run: SelectorRun): boolean {
  return (
    run.kind === "graph" &&
    (run.note === "未准备依赖图" || run.note.startsWith("madge "))
  );
}

/** 死规则:零信号、非 scope/tool,且不是“图不可用”的说明。 */
function isDeadRule(run: SelectorRun): boolean {
  return (
    run.kind !== "scope" &&
    run.kind !== "tool" &&
    run.signals.length === 0 &&
    !isGraphUnavailable(run)
  );
}

/** scope 规则零命中或枚举失败/超限时需要修订。 */
function scopeNeedsRevision(run: SelectorRun): boolean {
  return run.kind === "scope" && (run.note !== "" || run.hits === 0);
}

/** 复核发现的稳定去重键。 */
function findingKey(finding: Finding): string {
  return `${finding.repo}\u0000${finding.where}\u0000${finding.problem}`;
}

/** 严重度是否合法。 */
function isSeverity(value: string): value is "high" | "medium" | "low" {
  return value === "high" || value === "medium" || value === "low";
}

/**
 * 把审查员返回的发现改写成可信任的形状。
 * 字段是模型输出,不能让未知 severity/dimension 混进排序、统计与看板分列。
 * 返回 null 表示缺少位置或问题描述,调用方记 notCovered。
 */
function normalizeFinding(raw: unknown, notes: string[]): RawFinding | null {
  if (!isRecord(raw)) {
    notes.push("丢弃一条无法解析的发现(不是对象)");
    return null;
  }
  const where = clip(oneLine(asString(raw.where)), 200);
  const problem = clip(oneLine(asString(raw.problem)), 400);
  if (where === "" || problem === "") {
    notes.push(`丢弃缺少 where/problem 的发现: ${clip(oneLine(JSON.stringify(raw)), 160)}`);
    return null;
  }
  const rawSeverity = asString(raw.severity).trim().toLowerCase();
  let severity: RawFinding["severity"] = "medium";
  if (isSeverity(rawSeverity)) {
    severity = rawSeverity;
  } else {
    notes.push(`发现严重度无法识别(${clip(rawSeverity, 40) || "空"}),按 medium 处理: ${where}`);
  }
  const rawDimension = asString(raw.dimension).trim().toLowerCase();
  let dimension: RawFinding["dimension"] = "quality";
  if (isDimension(rawDimension)) {
    dimension = rawDimension;
  } else {
    notes.push(`发现维度无法识别(${clip(rawDimension, 40) || "空"}),按 quality 处理: ${where}`);
  }
  let repro: ReproSpec | undefined;
  if (raw.repro !== undefined && raw.repro !== null) {
    const parsed = normalizeRepro(raw.repro);
    if (parsed === null) {
      notes.push(`发现附带的复现规格无效(断言/脚本不合契约),已忽略: ${where}`);
    } else {
      repro = parsed;
    }
  }
  const finding: RawFinding = {
    dimension,
    where,
    problem,
    evidence: clip(asString(raw.evidence), 800),
    severity,
    fix: clip(asString(raw.fix), 400),
  };
  if (repro !== undefined) {
    finding.repro = repro;
  }
  return finding;
}

/** 按稳定键去重;verified 优先于 unconfirmed,并保留任意一侧带着的复现规格。 */
function dedupeFindings(items: CheckedFinding[]): CheckedFinding[] {
  const byKey = new Map<string, CheckedFinding>();
  for (const item of items) {
    const key = findingKey(item);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, item);
      continue;
    }
    const winner =
      existing.status === "unconfirmed" && item.status === "verified" ? item : existing;
    const repro = existing.repro ?? item.repro;
    byKey.set(key, repro === undefined ? winner : { ...winner, repro });
  }
  return [...byKey.values()];
}

/** 一条 grounding 检查的结果。 */
interface GroundingResult {
  /** 是否通过确定性的可复现检查。 */
  holds: boolean;
  /** 说明:检查了什么、结果是什麼。 */
  reason: string;
}

/** 从 where 里取「路径:行号」。没有行号时 line 为 0。 */
function parseWhere(where: string): { path: string; line: number } {
  const text = where.trim();
  const match = /^(.*?):(\d+)(?::\d+)?$/.exec(text);
  if (match === null) {
    return { path: text.replace(/:\d+(?::\d+)?$/, ""), line: 0 };
  }
  const line = Number(match[2]);
  return { path: match[1].trim(), line: Number.isFinite(line) && line > 0 ? line : 0 };
}

/** 从证据里取出被反引号包住的代码片段;没有反引号就取带引号的串。 */
function quotedSnippets(evidence: string): string[] {
  const snippets: string[] = [];
  for (const match of evidence.matchAll(/`([^`\n]{3,200})`/g)) {
    const text = match[1].trim();
    if (text !== "") {
      snippets.push(text);
    }
  }
  if (snippets.length === 0) {
    for (const match of evidence.matchAll(/"([^"\n]{3,200})"/g)) {
      const text = match[1].trim();
      if (text !== "") {
        snippets.push(text);
      }
    }
  }
  return snippets;
}

/** 从证据里取出标识符,用于「这个符号真的存在吗」的检查。 */
function evidenceIdentifiers(evidence: string): string[] {
  const seen = new Set<string>();
  for (const match of evidence.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g)) {
    seen.add(match[0]);
  }
  return [...seen];
}

/**
 * 确定性复核:不调用模型,用文件系统与文本比对复现一条发现。
 * 检查顺序由硬到软,任何一步失败都说明这条发现的证据不成立:
 *   1. where 的文件在仓库里存在
 *   2. 行号在文件范围内
 *   3. 证据里引用的代码片段能在引用行附近找到
 *   4. 行号缺失时,证据片段至少能在整个文件里找到
 * 这是 Devin Security Verify 的降级版:它比「换个模型重读一遍」更硬(可复现、零 token),
 * 但只能证明「引用的代码确实存在」,不能证明「这行代码真的有问题」——后者留给读者判断,
 * 报告里用 status 区分。
 */
async function groundFinding(finding: Finding): Promise<GroundingResult> {
  const target = parseWhere(finding.where);
  if (target.path === "") {
    return { holds: false, reason: "发现没有给出文件路径,无法复现" };
  }
  const repoPath = withRepo(finding.dir, target.path);
  let content: string;
  try {
    content = await files.read(repoPath);
  } catch (error) {
    const detail = oneLine(error instanceof Error ? error.message : String(error));
    return { holds: false, reason: `文件不存在或不可读: ${target.path} (${clip(detail, 120)})` };
  }
  const lines = content.split(/\r?\n/);
  if (target.line > 0 && target.line > lines.length) {
    return {
      holds: false,
      reason: `行号越界: ${target.path}:${target.line},文件只有 ${lines.length} 行`,
    };
  }
  const snippets = quotedSnippets(finding.evidence);
  if (snippets.length === 0) {
    // 没有可核对的引文时,只能确认文件与行号;这是弱证据,标 unconfirmed 更诚实。
    if (target.line === 0) {
      return { holds: false, reason: `证据里没有可核对的代码片段,且 where 缺行号: ${target.path}` };
    }
    return {
      holds: true,
      reason: `文件与行号存在(${target.path}:${target.line}),但证据未引用可核对原文`,
    };
  }
  const joined = lines.join("\n");
  const missing = snippets.filter((snippet) => !joined.includes(snippet));
  if (missing.length === snippets.length) {
    return {
      holds: false,
      reason: `证据引用的片段在文件中都不存在: ${clip(missing[0], 80)}`,
    };
  }
  if (target.line > 0) {
    const start = Math.max(0, target.line - 1 - QUOTE_LINE_WINDOW);
    const end = Math.min(lines.length, target.line + QUOTE_LINE_WINDOW);
    const nearby = lines.slice(start, end).join("\n");
    if (!snippets.some((snippet) => nearby.includes(snippet))) {
      return {
        holds: false,
        reason: `引用片段不在 ${target.path}:${target.line} 附近;证据与行号不符`,
      };
    }
  }
  const verified = snippets.length - missing.length;
  return {
    holds: true,
    reason: target.line > 0
      ? `复现成功: ${target.path}:${target.line} 附近找到引用的代码(${verified}/${snippets.length} 段)`
      : `复现成功: 引用片段在 ${target.path} 中找到(${verified}/${snippets.length} 段),但 where 未给行号`,
  };
}

/* ----------------------------------------------------------------------------
 * 运行时复现:探测、依赖安装、容器执行与结果分类。
 * 判定含义严格限定为「脚本返回了符合断言的数据」,不是「问题已被独立证明」:
 * 脚本必须 require 仓库代码,两者同进程,仓库代码可以干扰返回值(设计稿 §4.0/§12)。
 * -------------------------------------------------------------------------- */

/** docker 调用的统一返回;world.run 抛异常(超时/spawn 失败)折成 ok:false。 */
interface DockerCall {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  note: string;
}

/** 从 stdout 里取最后一整行 JSON 前缀标记;没有返回 null。 */
function lastMarkerJson(text: string, marker: string): unknown {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.startsWith(marker)) {
      try {
        return JSON.parse(line.slice(marker.length)) as unknown;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** 统一的 docker 调用包装。每次调用前重新做一次顶替检查(设计 §6.2)。 */
async function callDocker(argv: string[], timeoutMs: number): Promise<DockerCall> {
  const shadowed = await dockerShadowed(workspaceRoot);
  if (shadowed === null || shadowed) {
    return {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: "",
      note: shadowed === null ? "docker 顶替检查失败" : "docker 可执行文件被工作区顶替",
    };
  }
  try {
    const result = await world.run("docker", argv, { timeoutMs });
    return {
      ok: true,
      exitCode: result.exitCode,
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || ""),
      note: "",
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: "",
      note: clip(oneLine(error instanceof Error ? error.message : String(error)), 200),
    };
  }
}

/** 命名容器的一次性调用:无论主调用成功与否都盲删该名字(超时拿不到容器 ID)。 */
async function callDockerOnce(name: string, argv: string[], timeoutMs: number): Promise<DockerCall> {
  try {
    return await callDocker(argv, timeoutMs);
  } finally {
    await callDocker(["rm", "-f", name], 30000);
  }
}

/** 只查 docker 的顶替检查;null 表示检查本身失败(按不可用处理)。 */
async function dockerShadowed(root: string): Promise<boolean | null> {
  if (root === "") {
    return null;
  }
  try {
    guardSeq += 1;
    const result = await world.run("node", ["-e", DOCKER_GUARD_CODE, "--", root, String(guardSeq)], { timeoutMs: 60000 });
    if (result.exitCode !== 0) {
      return null;
    }
    const parsed = JSON.parse(result.stdout.trim()) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      return null;
    }
    return parsed.length > 0;
  } catch {
    return null;
  }
}

/** 读 DOCKER_HOST(它会静默覆盖 context);null 表示读取失败。 */
async function dockerHostEnv(): Promise<string | null> {
  try {
    const result = await world.run("node", ["-e", ENV_CODE], { timeoutMs: 60000 });
    if (result.exitCode !== 0) {
      return null;
    }
    const parsed = JSON.parse(result.stdout.trim()) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    return asString(parsed.dockerHost).trim();
  } catch {
    return null;
  }
}

/** 探测通过后的运行时能力。 */
interface RuntimeCaps {
  /** 审计目录(系统临时目录,mkdtemp);容器名与审计文件都从这里派生。 */
  auditDir: string;
  /** mkdtemp 的随机后缀;容器名靠它做到每次运行唯一。 */
  auditId: string;
  /** npm 缓存根(<home>/.npm);offline 安装只读挂载。 */
  npmCacheDir: string;
  /** 本次安装模式。 */
  mode: "offline" | "online";
}

/** 探测结果:ok 为 false 时 note 写进 notCovered,整段功能停用。 */
interface RuntimeProbe {
  ok: boolean;
  note: string;
  caps: RuntimeCaps | null;
}

/** 探测阶段已经判定不可用时的占位结果。 */
function runtimeDisabled(note: string): RuntimeProbe {
  return { ok: false, note, caps: null };
}

/** 取镜像的 RepoDigests;失败返回 null。 */
async function imageDigests(ref: string, variant = 0): Promise<string[] | null> {
  // world.run 按参数缓存:拉取后重查必须换一个等价但不同的 ref,否则命中拉取前的失败结果。
  const target = variant === 0 || ref.includes("/") ? ref : "docker.io/library/" + ref;
  const call = await callDocker(["image", "inspect", target, "--format", "{{json .RepoDigests}}"], 30000);
  if (!call.ok || call.exitCode !== 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(call.stdout.trim()) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return null;
  }
}

/**
 * 能力探测:只做一次,结果复用。任一环失败 → 整体跳过并写进 notCovered。
 * 这里不跑任何仓库代码,只验证 docker 可用性、本机 context、镜像与权限。
 */
async function detectRuntimeVerify(): Promise<RuntimeProbe> {
  if (!runtimeVerify) {
    return runtimeDisabled("运行时复现未开启(runtimeVerify=false)");
  }
  // 审计目录先建:容器名要用 auditId,且后续所有 docker 调用都写审计。
  let auditDir = "";
  try {
    const result = await world.run("node", ["-e", AUDIT_DIR_CODE], { timeoutMs: 60000 });
    if (result.exitCode === 0) {
      auditDir = result.stdout.trim();
    }
  } catch {
    auditDir = "";
  }
  if (auditDir === "") {
    return runtimeDisabled("无法创建审计目录,运行时复现跳过");
  }
  const auditId = auditDir.split(/[\\/]/).filter((part) => part !== "").pop() || "";

  // 1) docker 二进制不能被工作区顶替。
  const shadowed = await dockerShadowed(workspaceRoot);
  if (shadowed === null) {
    return runtimeDisabled("docker 顶替检查失败,运行时复现跳过");
  }
  if (shadowed) {
    return runtimeDisabled("docker 可执行文件被工作区顶替,运行时复现跳过(其余工具不受影响)");
  }
  // 2) daemon 可达。
  const version = await callDocker(["version"], 15000);
  if (!version.ok || version.exitCode !== 0) {
    return runtimeDisabled("Docker daemon 未运行或 docker CLI 不可用,运行时复现跳过");
  }
  // 3) context 必须指向本机。本机 context 名是 desktop-linux,不能按名字判断。
  const context = await callDocker(["context", "inspect", "--format", "{{json .}}"], 15000);
  if (!context.ok || context.exitCode !== 0) {
    return runtimeDisabled("读取 docker context 失败,运行时复现跳过");
  }
  let contextHost = "";
  const contextJson = parseJsonLoose<Record<string, unknown>>(context.stdout);
  if (contextJson !== null && isRecord(contextJson.Endpoints)) {
    const docker = contextJson.Endpoints.docker;
    if (isRecord(docker)) {
      contextHost = asString(docker.Host);
    }
  }
  if (!/^(npipe|unix):\/\//i.test(contextHost)) {
    return runtimeDisabled(`docker context 不是本机端点(${clip(oneLine(contextHost) || "未知", 80)}),运行时复现跳过`);
  }
  // 4) DOCKER_HOST 会静默覆盖 context。
  const envHost = await dockerHostEnv();
  if (envHost === null) {
    return runtimeDisabled("读取 DOCKER_HOST 失败,运行时复现跳过");
  }
  if (envHost !== "" && !/^(npipe|unix):\/\//i.test(envHost)) {
    return runtimeDisabled(`DOCKER_HOST 指向非本机端点(${clip(oneLine(envHost), 80)}),运行时复现跳过`);
  }
  // 5) 镜像按 digest 钉死。未填 digest 时只解析一次并提示,不执行任何容器。
  if (REPRO_IMAGE.includes("__REPRO_IMAGE_DIGEST__")) {
    let digests = await imageDigests(REPRO_IMAGE_TAG);
    if (digests === null) {
      const pull = await callDocker(["pull", REPRO_IMAGE_TAG], 300000);
      if (!pull.ok || pull.exitCode !== 0) {
        return runtimeDisabled("镜像未拉取且拉取失败,运行时复现跳过");
      }
      digests = await imageDigests(REPRO_IMAGE_TAG, 1);
    }
    const digest = (digests || [])
      .map((entry) => /@(sha256:[0-9a-f]{64})/.exec(entry))
      .map((match) => (match === null ? "" : match[1]))
      .find((value) => value !== "");
    if (digest === undefined) {
      return runtimeDisabled("无法解析镜像 digest,运行时复现跳过");
    }
    return runtimeDisabled(
      `镜像 digest 未钉死:本次解析到 ${clip(digest, 80)};把它填进 REPRO_IMAGE(node:22-slim@${clip(digest, 80)})后重新运行`,
    );
  }
  let digests = await imageDigests(REPRO_IMAGE);
  if (digests === null) {
    const pull = await callDocker(["pull", REPRO_IMAGE], 300000);
    if (!pull.ok || pull.exitCode !== 0) {
      return runtimeDisabled("镜像拉取失败,运行时复现跳过");
    }
    digests = await imageDigests(REPRO_IMAGE, 1);
  }
  const wanted = REPRO_IMAGE.split("@")[1] || "";
  if (digests === null || wanted === "" || !digests.some((entry) => entry.includes(wanted))) {
    return runtimeDisabled("镜像 digest 与 REPRO_IMAGE 不一致,运行时复现跳过");
  }
  // 6) 真实探测容器:同 user / 同 tmpfs 语义,验证写权限与挂载。
  const probeName = `code-scan-repro-${clip(auditId, 40)}-probe`;
  const probe = await callDockerOnce(
    probeName,
    [
      "run", "--rm", "--name", probeName,
      "--network=none",
      "--read-only",
      "--tmpfs", "/work:rw,noexec,nosuid,nodev,mode=1777,size=64m",
      "--user", "65534:65534",
      "--cap-drop=ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "128",
      "--memory", "1g", "--memory-swap", "1g",
      "--cpus", "2",
      "--entrypoint", "node",
      REPRO_IMAGE,
      "-e", "require('fs').writeFileSync('/work/probe','1')",
    ],
    REPRO_TIMEOUT_MS,
  );
  if (!probe.ok || probe.exitCode !== 0) {
    return runtimeDisabled(`探测容器失败(挂载或权限问题),运行时复现跳过: ${clip(probe.note || oneLine(probe.stderr), 160)}`);
  }
  // 7) 镜像内 npm 版本必须与安装语义核对过的版本一致。
  const npmProbeName = `code-scan-repro-${clip(auditId, 40)}-npm`;
  const npmProbe = await callDockerOnce(
    npmProbeName,
    [
      "run", "--rm", "--name", npmProbeName,
      "--network=none",
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,mode=1777,size=32m",
      "--pids-limit", "128",
      "--memory", "1g", "--memory-swap", "1g",
      "--cpus", "2",
      "--user", "65534:65534",
      "--cap-drop=ALL",
      "--security-opt", "no-new-privileges",
      "--entrypoint", "node",
      REPRO_IMAGE,
      "-e", "process.stdout.write(require('child_process').execSync('npm --version').toString().trim())",
    ],
    REPRO_TIMEOUT_MS,
  );
  if (!npmProbe.ok || npmProbe.exitCode !== 0) {
    return runtimeDisabled("无法读取镜像内 npm 版本,运行时复现跳过");
  }
  const npmVersion = npmProbe.stdout.trim();
  const npmMajor = Number((/^(\d+)/.exec(npmVersion) || ["", "0"])[1]);
  if (!Number.isFinite(npmMajor) || npmMajor !== REPRO_IMAGE_NPM_MAJOR) {
    return runtimeDisabled(
      `镜像内 npm 主版本 ${clip(npmVersion || "未知", 20)} 与核对过的 ${REPRO_IMAGE_NPM_MAJOR} 不符,运行时复现跳过`,
    );
  }
  // 8) npm 缓存根:offline 安装要用。
  let npmCacheDir = "";
  if (!runtimeVerifyOnline) {
    try {
      const result = await world.run("node", ["-e", NPM_CACHE_CODE], { timeoutMs: 60000 });
      if (result.exitCode === 0) {
        npmCacheDir = result.stdout.trim();
      }
    } catch {
      npmCacheDir = "";
    }
    if (npmCacheDir === "") {
      return runtimeDisabled("找不到本机 npm 缓存(<home>/.npm),离线安装不可用;可加 runtimeVerifyOnline=true");
    }
  }
  return {
    ok: true,
    note: `运行时复现已启用(${runtimeVerifyOnline ? "online" : "offline"} 安装,审计目录 ${auditDir})`,
    caps: {
      auditDir,
      auditId: clip(auditId, 40),
      npmCacheDir,
      mode: runtimeVerifyOnline ? "online" : "offline",
    },
  };
}

/** 把审查员给的 repro 归一化成可校验的形状;不合规直接丢弃(不猜)。 */
function normalizeAssertion(raw: unknown): ReproAssertion | null {
  if (!isRecord(raw)) {
    return null;
  }
  const kind = asString(raw.kind).trim();
  if (kind === "throws") {
    const match = asString(raw.match);
    // 判定要逐字比较,所以不 oneLine/不 clip:改写它会让 verdict 两向出错;过长直接拒绝。
    if (match === "" || match.length > 400) {
      return null;
    }
    return { kind: "throws", match };
  }
  if (kind === "not-equals") {
    if (typeof raw.expected !== "string" || raw.expected.length > 1000) {
      return null;
    }
    return { kind: "not-equals", expected: raw.expected };
  }
  if (kind === "ratio-greater") {
    const threshold = asNumber(raw.threshold);
    if (!Number.isFinite(threshold) || threshold < RATIO_MIN || threshold > RATIO_MAX) {
      return null;
    }
    return { kind: "ratio-greater", threshold };
  }
  return null;
}

/** 归一化 repro;脚本只在容器 tmpfs 里落盘,不写工作区。 */
function normalizeRepro(raw: unknown): ReproSpec | null {
  if (!isRecord(raw)) {
    return null;
  }
  const script = asString(raw.script);
  if (script.trim() === "") {
    return null;
  }
  const assertion = normalizeAssertion(raw.assertion);
  if (assertion === null) {
    return null;
  }
  const proves = clip(oneLine(asString(raw.proves)), 200);
  if (proves === "") {
    return null;
  }
  return { script, assertion, proves };
}

/** 每仓库的运行时状态。 */
interface RepoRuntime {
  /** realpath 后的仓库绝对路径。 */
  dir: string;
  /** 依赖卷名;空字符串表示该仓库没有 package.json,不装依赖。 */
  depsVolume: string;
  /** ready=依赖可用;none=不需要安装;failed=该仓库全部复现不可用。 */
  state: "ready" | "none" | "failed";
  /** 状态说明,写进报告。 */
  note: string;
  /** 仓库根是否已有 node_modules 目录;决定依赖卷挂在 /src/node_modules 还是 /deps。 */
  mountNodeModules?: boolean;
}

/** 读安装成功标记;null 表示读不到。 */
async function readInstallMarker(ref: string, image: string, volume: string, phase: string): Promise<{ fingerprint: string } | null> {
  const name = `code-scan-repro-${ref}-marker-${clip(phase, 12)}`;
  const call = await callDockerOnce(
    name,
    [
      "run", "--rm", "--name", name,
      "--network=none",
      "--read-only",
      "--user", "65534:65534",
      "--cap-drop=ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "128",
      "--memory", "1g", "--memory-swap", "1g",
      "--cpus", "2",
      "--mount", `type=volume,source=${volume},target=/deps,readonly`,
      "--entrypoint", "node",
      image,
      "-e", "const fs=require('fs');try{process.stdout.write(fs.readFileSync('/deps/tree/.code-scan-install-ok','utf8'));}catch(e){process.stdout.write('');}",
    ],
    REPRO_TIMEOUT_MS,
  );
  if (!call.ok || call.exitCode !== 0) {
    return null;
  }
  const text = call.stdout.trim();
  if (text === "") {
    return null;
  }
  const parsed = parseJsonLoose<Record<string, unknown>>(text);
  if (parsed === null) {
    return null;
  }
  return { fingerprint: asString(parsed.fingerprint) };
}

/** 锁操作;true=拿到/释放成功。 */
async function lockDeps(name: string, waitMs: number, mode: "acquire" | "release"): Promise<boolean> {
  try {
    const result = await world.run("node", ["-e", LOCK_CODE, "--", name, String(waitMs), mode], {
      timeoutMs: Math.max(60000, waitMs + 30000),
    });
    return result.exitCode === 0 && result.stdout.trim() === "OK";
  } catch {
    return false;
  }
}

/**
 * 重新做一遍链接遍历。设计 §6.3 要求挂载前检查;world.run 按参数缓存,
 * 所以每次带一个新 nonce,否则第二次检查会命中第一次的缓存。
 */
async function linksStillOk(dir: string): Promise<{ ok: boolean; reason: string }> {
  guardSeq += 1;
  try {
    const result = await world.run(
      "node",
      ["-e", WALK_LINKS_CODE, "--", dir, String(WALK_MAX_ENTRIES), String(guardSeq)],
      { timeoutMs: 120000 },
    );
    if (result.exitCode !== 0) {
      return { ok: false, reason: "链接遍历失败" };
    }
    const parsed = JSON.parse(result.stdout.trim()) as unknown;
    if (!isRecord(parsed) || parsed.ok !== true) {
      return { ok: false, reason: isRecord(parsed) ? asString(parsed.reason) : "链接遍历失败" };
    }
    return { ok: true, reason: "" };
  } catch {
    return { ok: false, reason: "链接遍历失败" };
  }
}
/**
 * 准备一个仓库的依赖卷。返回 failed 时该仓库的所有复现记 unavailable,
 * 绝不在 host 上执行仓库代码,也不用仓库自带的 node_modules。
 */
async function prepareRepoRuntime(target: PreparedRepo, probe: RuntimeProbe): Promise<RepoRuntime | null> {
  const caps = probe.caps;
  if (caps === null) {
    return null;
  }
  // 链接检查必须先做:Windows 上 Docker Desktop 会透过 junction 暴露挂载子树之外的内容。
  const walk = await linksStillOk(target.dir);
  if (!walk.ok) {
    const reason = walk.reason;
    const note = reason.startsWith("host node_modules: ")
      ? `仓库含嵌套 node_modules(${clip(oneLine(reason.slice(19)), 120)}),自带的依赖不用于复现,运行时复现跳过`
      : `仓库结构不可挂载(${clip(oneLine(reason), 120)}),运行时复现跳过`;
    return { dir: target.dir, depsVolume: "", state: "failed", note };
  }
  let real = "";
  try {
    const result = await world.run("node", ["-e", REALPATH_CODE, "--", target.dir], { timeoutMs: 60000 });
    if (result.exitCode === 0) {
      real = result.stdout.trim();
    }
  } catch {
    real = "";
  }
  if (real === "") {
    return { dir: target.dir, depsVolume: "", state: "failed", note: "仓库路径无法解析为目录,运行时复现跳过" };
  }
  // --mount 是 CSV 解析,路径里出现逗号会截断参数。
  if (real.includes(",")) {
    return { dir: real, depsVolume: "", state: "failed", note: "仓库路径含逗号,无法安全挂载,运行时复现跳过" };
  }
  // 没有 package.json 的仓库不需要安装;脚本仍可用 createRequire('/src/package.json') 解析相对路径。
  let hasManifest = false;
  let presenceKnown = false;
  try {
    const presence = await fsPresence([`${real}/package.json`]);
    if (presence !== null) {
      presenceKnown = true;
      hasManifest = presence[0] === true;
    }
  } catch {
    presenceKnown = false;
  }
  if (!presenceKnown) {
    return { dir: real, depsVolume: "", state: "failed", note: "无法确认 package.json 是否存在,运行时复现跳过" };
  }
  // /src 是只读 bind:目标目录不存在时 Docker 无法创建挂载点,所以依赖卷挂 /deps + NODE_PATH。
  // 仓库根有 node_modules 时再用空 tmpfs 遮蔽它(目标存在才挂得上)。
  let hasNodeModules = false;
  let nmKnown = false;
  try {
    const presence = await fsPresence([`${real}/node_modules`]);
    if (presence !== null) {
      nmKnown = true;
      hasNodeModules = presence[0] === true;
    }
  } catch {
    nmKnown = false;
  }
  if (!nmKnown) {
    return { dir: real, depsVolume: "", state: "failed", note: "无法确认 node_modules 是否存在,运行时复现跳过" };
  }
  if (!hasManifest) {
    return { dir: real, depsVolume: "", state: "none", note: "", mountNodeModules: hasNodeModules };
  }
  // 五项 manifest 检查(只解析,不执行)。
  let check: unknown = null;
  try {
    const result = await world.run(
      "node",
      ["-e", MANIFEST_CHECK_CODE, "--", real, String(MANIFEST_MAX_BYTES)],
      { timeoutMs: 120000 },
    );
    if (result.exitCode === 0) {
      check = JSON.parse(result.stdout.trim()) as unknown;
    }
  } catch {
    check = null;
  }
  if (!isRecord(check) || check.ok !== true) {
    const reason = isRecord(check) ? asString(check.reason) : "manifest 检查失败";
    return {
      dir: real,
      depsVolume: "",
      state: "failed",
      note: `依赖安装被拒(${clip(oneLine(reason), 160)}),运行时复现跳过`,
    };
  }
  // 暂存目录 + fingerprint。
  let staged: unknown = null;
  try {
    const result = await world.run(
      "node",
      [
        "-e", MANIFEST_STAGE_CODE, "--", real, String(MANIFEST_MAX_BYTES),
        REPRO_IMAGE, String(INSTALL_POLICY_VERSION), target.key,
      ],
      { timeoutMs: 120000 },
    );
    if (result.exitCode === 0) {
      staged = JSON.parse(result.stdout.trim()) as unknown;
    }
  } catch {
    staged = null;
  }
  if (!isRecord(staged) || staged.ok !== true) {
    const reason = isRecord(staged) ? asString(staged.reason) : "manifest 暂存失败";
    return {
      dir: real,
      depsVolume: "",
      state: "failed",
      note: `manifest 暂存失败(${clip(oneLine(reason), 160)}),运行时复现跳过`,
    };
  }
  const stageDir = asString(staged.dir);
  const fingerprint = asString(staged.fingerprint);
  const repoId = asString(staged.repoId);
  if (stageDir === "" || fingerprint === "" || repoId === "") {
    return { dir: real, depsVolume: "", state: "failed", note: "manifest 暂存结果不完整,运行时复现跳过" };
  }
  const volume = `${DEPS_VOLUME_PREFIX}${clip(repoId, 20)}-${clip(fingerprint, 16)}`;
  // 容器名带上仓库标识:并行扫描之间、同一扫描的多仓库之间都不会撞名。
  const runRef = `${caps.auditId}-${clip(repoId, 20)}`;
  // 复用条件不是「卷存在」,而是「成功标记存在且 fingerprint 匹配」。
  // phase 参与容器名:world.run 按参数缓存,前后两次读取必须参数不同,否则第二次会命中第一次的缓存。
  const existing = await readInstallMarker(runRef, REPRO_IMAGE, volume, "pre");
  if (existing !== null && existing.fingerprint === fingerprint) {
    return { dir: real, depsVolume: volume, state: "ready", note: "复用已装依赖", mountNodeModules: hasNodeModules };
  }
  const lockName = `deps-${clip(volume, 120)}`;
  if (!(await lockDeps(lockName, 30000, "acquire"))) {
    return {
      dir: real,
      depsVolume: "",
      state: "failed",
      note: "另一个扫描正在安装该仓库的依赖(拿不到锁),运行时复现跳过",
    };
  }
  const installNote: string[] = [];
  const installName = `code-scan-repro-${runRef}-install`;
  try {
    // 等锁期间其他扫描可能已经装好:标记匹配就复用,不删卷、不重装。
    const afterLock = await readInstallMarker(runRef, REPRO_IMAGE, volume, "lock");
    if (afterLock !== null && afterLock.fingerprint === fingerprint) {
      return { dir: real, depsVolume: volume, state: "ready", note: "复用已装依赖(等锁期间完成)", mountNodeModules: hasNodeModules };
    }
    // 异常遗留:名字已含 fingerprint,标记不匹配只可能是旧产物;删掉重建,不原地清空。
    const removed = await callDocker(["volume", "rm", volume], 60000);
    if (!removed.ok || removed.exitCode !== 0) {
      const stillThere = await callDocker(["volume", "inspect", volume], 30000);
      if (stillThere.ok && stillThere.exitCode === 0) {
        return { dir: real, depsVolume: "", state: "failed", note: "遗留依赖卷删不掉(仍被引用),运行时复现跳过" };
      }
    }
    const create = await callDocker(["volume", "create", volume], 60000);
    if (!create.ok || create.exitCode !== 0) {
      return { dir: real, depsVolume: "", state: "failed", note: "依赖卷创建失败,运行时复现跳过" };
    }
    // 新卷是 root 所有;发布与成功标记都写在卷根,所以 chown 也必须作用于卷根。
    const chownName = `code-scan-repro-${runRef}-chown`;
    const chown = await callDockerOnce(
      chownName,
      [
        "run", "--rm", "--name", chownName,
        "--network=none",
        "--read-only",
        "--user", "0:0",
        "--cap-drop=ALL",
        "--cap-add=CHOWN",
        "--cap-add=FOWNER",
        "--pids-limit", "64",
        "--memory", "512m", "--memory-swap", "512m",
        "--cpus", "1",
        "--security-opt", "no-new-privileges",
        "--mount", `type=volume,source=${volume},target=/deps`,
        "--entrypoint", "node",
        REPRO_IMAGE,
        "-e", "const fs=require('fs');fs.mkdirSync('/deps/tree',{recursive:true});fs.chmodSync('/deps/tree',0o777);fs.chownSync('/deps/tree',65534,65534)",
      ],
      REPRO_TIMEOUT_MS,
    );
    if (!chown.ok || chown.exitCode !== 0) {
      return { dir: real, depsVolume: "", state: "failed", note: "依赖卷权限准备失败,运行时复现跳过" };
    }
    const argv = [
      "run", "--rm", "--name", `code-scan-repro-${runRef}-install`,
      "--network", runtimeVerifyOnline ? "bridge" : "none",
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,mode=1777,size=512m",
      "--user", "65534:65534",
      "--cap-drop=ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "256",
      "--memory", INSTALL_MAX_MEMORY, "--memory-swap", INSTALL_MAX_MEMORY,
      "--cpus", "2",
      "--mount", `type=bind,source=${stageDir},target=/src,readonly`,
      "--mount", `type=volume,source=${volume},target=/deps`,
    ];
    if (caps.npmCacheDir !== "") {
      argv.push("--mount", `type=bind,source=${caps.npmCacheDir},target=/npm-cache,readonly`);
    }
    argv.push(
      "--workdir", "/deps",
      "-e", "HOME=/tmp",
      "-e", "TMPDIR=/tmp",
      "-e", `DEPS_FINGERPRINT=${fingerprint}`,
      "-e", `INSTALL_MODE=${runtimeVerifyOnline ? "online" : "offline"}`,
      "-e", "npm_config_userconfig=/tmp/npm-userconfig",
      "-e", "npm_config_globalconfig=/tmp/npm-globalconfig",
      "-e", "npm_config_registry=https://registry.npmjs.org/",
      "-e", "npm_config_ignore_scripts=true",
      "-e", "npm_config_audit=false",
      "-e", "npm_config_fund=false",
      "-e", "npm_config_update_notifier=false",
      "--entrypoint", "node",
      REPRO_IMAGE,
      "-e", INSTALLER_SRC,
    );
    const install = await callDocker(argv, INSTALL_TIMEOUT_MS);
    const info = lastMarkerJson(install.stdout, "@@INSTALL@@");
    if (!install.ok) {
      return {
        dir: real,
        depsVolume: "",
        state: "failed",
        note: `依赖安装容器启动失败(${clip(install.note, 140)}),运行时复现跳过`,
      };
    }
    if (install.exitCode !== 0 || !isRecord(info) || info.ok !== true) {
      const reason = isRecord(info)
        ? asString(info.reason)
        : install.exitCode !== 0
          ? `installer 退出码 ${install.exitCode}`
          : "installer 无有效输出";
      installNote.push(`install 失败: ${clip(oneLine(reason), 160)}`);
      if (isRecord(info) && info.offline === true) {
        installNote.push("缓存缺包;先在本地跑一次 npm ci 预热,或加 runtimeVerifyOnline=true");
      }
      return {
        dir: real,
        depsVolume: "",
        state: "failed",
        note: `依赖安装失败(${installNote.join(";")}),运行时复现跳过`,
      };
    }
    // 复核标记:安装进程可能被杀在写标记之前。
    const marker = await readInstallMarker(runRef, REPRO_IMAGE, volume, "post");
    if (marker === null || marker.fingerprint !== fingerprint) {
      return { dir: real, depsVolume: "", state: "failed", note: "安装成功标记缺失或 fingerprint 不匹配,运行时复现跳过" };
    }
    return { dir: real, depsVolume: volume, state: "ready", note: "本次安装依赖", mountNodeModules: hasNodeModules };
  } finally {
    // world.run 超时不会返回容器 ID;名字是确定性的,可以无条件盲删安装容器。
    await callDocker(["rm", "-f", installName], 30000);
    await lockDeps(lockName, 0, "release");
  }
}

/** 一条复现规格:与发现一起进入执行队列。 */
interface ReproJob {
  finding: CheckedFinding;
  spec: ReproSpec;
}

/** 选复现目标:只做 high/medium 且证据核对通过的;按严重度取前 MAX_REPRO 条。 */
function selectReproJobs(findings: CheckedFinding[]): ReproJob[] {
  const jobs: ReproJob[] = [];
  for (const finding of findings) {
    if (jobs.length >= MAX_REPRO) {
      break;
    }
    if (finding.repro === undefined) {
      continue;
    }
    if (finding.severity !== "high" && finding.severity !== "medium") {
      continue;
    }
    if (finding.status !== "verified") {
      continue;
    }
    jobs.push({ finding, spec: finding.repro });
  }
  return jobs;
}

/** 按设计稿 §4.4 的分类表(顺序匹配,先命中先返回;兜底一律 unavailable)。 */
function classifyRepro(call: DockerCall, runner: unknown): ReproResult {
  const base = {
    dockerExitCode: call.exitCode,
    stdoutTail: "",
    stderrTail: "",
  };
  const runnerRecord = isRecord(runner) ? runner : null;
  const runnerPhase = runnerRecord === null ? "" : asString(runnerRecord.phase);
  const payload = runnerRecord === null ? null : runnerRecord.payload;
  const payloadRecord = isRecord(payload) ? payload : null;
  const stage = payloadRecord === null ? "" : asString(payloadRecord.stage);
  const verdict = runnerRecord !== null && typeof runnerRecord.verdict === "boolean" ? runnerRecord.verdict : null;
  const out: ReproResult = {
    outcome: "unavailable",
    dockerExitCode: base.dockerExitCode,
    verdict,
    stage: stage as ReproResult["stage"],
    note: "",
    stdoutTail: runnerRecord === null ? "" : clip(asString(runnerRecord.stdoutTail), 800),
    stderrTail: runnerRecord === null ? "" : clip(asString(runnerRecord.stderrTail), 800),
  };
  if (!call.ok) {
    // 规则 2:world.run 抛异常(容器超时/spawn 失败)。
    return { ...out, outcome: "error", note: `docker 调用失败: ${clip(call.note, 160)}` };
  }
  if (call.exitCode === 125 || call.exitCode === 126 || call.exitCode === 127) {
    // 规则 3:docker 自身失败 / 命令不可执行。
    return {
      ...out,
      outcome: "error",
      note: `docker 退出码 ${call.exitCode}: ${clip(oneLine(call.stderr) || oneLine(call.stdout), 160)}`,
    };
  }
  if (call.exitCode !== 0 && runnerRecord === null) {
    // 规则 4:没有 runner 输出且退出非零(daemon 断开等)。
    return { ...out, outcome: "error", note: `docker 退出码 ${call.exitCode} 且无 runner 输出` };
  }
  if (runnerRecord !== null && runnerRecord.timedOut === true) {
    // 超时的观察不作为判定依据:进程被 kill 前写下的中间数据不能当结论。
    return { ...out, outcome: "unavailable", note: "脚本超时(容器内 52s)" };
  }
  if (runnerPhase === "spec" || runnerPhase === "runner") {
    // 规则 5:runner 自己出错。
    return {
      ...out,
      outcome: "unavailable",
      stage: runnerPhase as ReproResult["stage"],
      note: `复现执行器错误: ${clip(oneLine(asString(runnerRecord === null ? "" : runnerRecord.error)), 200)}`,
    };
  }
  if (payloadRecord === null) {
    // 规则 6:harness 没返回判定数据。
    const timedOut = runnerRecord !== null && runnerRecord.timedOut === true;
    return {
      ...out,
      outcome: "unavailable",
      note: timedOut ? "脚本超时(容器内 52s)" : "脚本未返回判定数据",
    };
  }
  if (stage === "load" || stage === "contract" || stage === "serialize" || stage === "run") {
    // 规则 7:加载失败 / 契约不符 / 无法序列化 / run() 抛错。
    return {
      ...out,
      outcome: "unavailable",
      note: `${stage}: ${clip(oneLine(asString(payloadRecord.error)), 200)}`,
    };
  }
  if (stage === "done" && verdict === true) {
    return { ...out, outcome: "reproduced", note: "脚本返回了符合断言的数据(脚本自报,非独立证明)" };
  }
  if (stage === "done" && verdict === false) {
    return { ...out, outcome: "notReproduced", note: "脚本未观察到预期行为" };
  }
  if (stage === "done") {
    // 规则 10:有效数据但断言为 null —— 无效 spec(阈值越界/小样本)或返回值不合契约。
    return { ...out, outcome: "unavailable", note: "断言不成立或数据不合契约(无效 spec)" };
  }
  // 规则 11:fail-closed。
  return { ...out, outcome: "unavailable", note: `未识别的复现结果(stage=${clip(stage || "空", 40)})` };
}

/** 审计写入:失败不影响执行——审计是留痕,不是控制点。 */
async function auditWrite(caps: RuntimeCaps, name: string, content: string): Promise<void> {
  try {
    await world.run("node", ["-e", AUDIT_WRITE_CODE, "--", caps.auditDir, name, content], {
      timeoutMs: 60000,
    });
  } catch {
    // 留痕失败不改变判定;报告里仍会写明审计目录。
  }
}

/** 执行一条复现:脚本经 base64 环境变量传入,不落 host 磁盘,退出后无条件删容器。 */
async function runRepro(job: ReproJob, repo: RepoRuntime, caps: RuntimeCaps, index: number): Promise<ReproResult> {
  // 挂载前再走一遍链接检查:localPath 可能被同步盘/构建进程改动,一次检查不够。
  const links = await linksStillOk(repo.dir);
  if (!links.ok) {
    return {
      outcome: "unavailable",
      dockerExitCode: -1,
      verdict: null,
      stage: "spec",
      note: "仓库结构在挂载前发生变化(" + clip(oneLine(links.reason), 120) + "),未执行",
      stdoutTail: "",
      stderrTail: "",
    };
  }
  const specJson = JSON.stringify(job.spec);
  let encoded: unknown = null;
  try {
    const result = await world.run(
      "node",
      ["-e", B64_CODE, "--", String(REPRO_SCRIPT_MAX_BYTES), specJson],
      { timeoutMs: 120000 },
    );
    if (result.exitCode === 0) {
      encoded = JSON.parse(result.stdout.trim()) as unknown;
    }
  } catch {
    encoded = null;
  }
  if (!isRecord(encoded) || encoded.ok !== true || typeof encoded.b64 !== "string") {
    const reason = isRecord(encoded) ? asString(encoded.reason) : "编码失败";
    return {
      outcome: "unavailable",
      dockerExitCode: -1,
      verdict: null,
      stage: "spec",
      note: `复现脚本无效: ${clip(oneLine(reason), 160)}`,
      stdoutTail: "",
      stderrTail: "",
    };
  }
  const b64 = encoded.b64;
  if (b64.length > REPRO_B64_MAX_CHARS) {
    return {
      outcome: "unavailable",
      dockerExitCode: -1,
      verdict: null,
      stage: "spec",
      note: `编码后的复现规格超过 ${REPRO_B64_MAX_CHARS} 字符,已拒绝`,
      stdoutTail: "",
      stderrTail: "",
    };
  }
  const container = `code-scan-repro-${caps.auditId}-${index + 1}`;
  const argv = [
    "run", "--rm", "--name", container,
    "--network=none",
    "--read-only",
    "--tmpfs", "/work:rw,noexec,nosuid,nodev,mode=1777,size=64m",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,mode=1777,size=32m",
    "--user", "65534:65534",
    "--cap-drop=ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "128",
    "--memory", "1g", "--memory-swap", "1g",
    "--cpus", "2",
    "--mount", `type=bind,source=${repo.dir},target=/src,readonly`,
  ];
  if (repo.depsVolume !== "") {
    // 依赖装在卷的子目录 tree 里(卷根会被 Docker Desktop 按挂载用户重设,不能依赖它可写)。
    argv.push("--mount", "type=volume,source=" + repo.depsVolume + ",target=/deps,readonly");
    argv.push("-e", "NODE_PATH=/deps/tree");
  }
  if (repo.mountNodeModules === true) {
    // 仓库自带 node_modules:用空 tmpfs 覆盖(目标存在,只读 bind 里可挂),再靠 NODE_PATH 解析到 /deps/tree。
    argv.push("--mount", "type=tmpfs,destination=/src/node_modules,tmpfs-size=16m,tmpfs-mode=0555");
  }
  argv.push(
    "--workdir", "/src",
    "-e", "HOME=/tmp",
    "-e", "TMPDIR=/tmp",
    "-e", `REPRO_SPEC_B64=${b64}`,
    "--entrypoint", "node",
    REPRO_IMAGE,
    "-e", RUNNER_SRC,
  );
  // 审计:完整脚本与 argv 留痕,输出用已脱敏的 runner 记录。
  await auditWrite(caps, `spec-${index + 1}.json`, JSON.stringify(job.spec, null, 2));
  await auditWrite(
    caps,
    `argv-${index + 1}.json`,
    JSON.stringify(
      argv.map((value) => (value.startsWith("REPRO_SPEC_B64=") ? "REPRO_SPEC_B64=<omitted;见 spec 文件>" : value)),
      null,
      2,
    ),
  );
  let call: DockerCall;
  try {
    call = await callDocker(argv, REPRO_TIMEOUT_MS);
  } finally {
    // world.run 超时不会返回容器 ID;名字是确定性的,所以可以无条件盲删自己这一条。
    await callDocker(["rm", "-f", container], 30000);
  }
  const runner = call.ok ? lastMarkerJson(call.stdout, "@@RUNNER@@") : null;
  const result = classifyRepro(call, runner);
  await auditWrite(caps, `output-${index + 1}.json`, JSON.stringify(result, null, 2));
  return result;
}

/** 规范化规划员/存档里的选择器,过滤不可执行的能力。 */
function normalizeSelectors(raw: unknown, caps: Capabilities, notes: string[]): SelectorSpec[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: SelectorSpec[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!isRecord(item)) {
      continue;
    }
    const noteIdRaw = oneLine(asString(item.id));
    const noteId = noteIdRaw !== "" ? clip(noteIdRaw, 80) : `#${i + 1}`;
    const kind = asString(item.kind).trim();
    const noteKind = clip(oneLine(kind), 40);
    if (!isSelectorKind(kind)) {
      notes.push(`丢弃未知选择器类型: ${noteKind || "(空)"}`);
      continue;
    }
    const dimension = asString(item.dimension).trim();
    if (!isDimension(dimension)) {
      notes.push(`丢弃维度非法的选择器: ${noteId}`);
      continue;
    }
    const query = asString(item.query).trim();
    if (query === "") {
      notes.push(`丢弃空 query 的选择器: ${noteId}`);
      continue;
    }
    const lang = asString(item.lang).trim();
    if (kind === "ast" && lang === "") {
      notes.push(`丢弃缺少 lang 的 ast 选择器: ${noteId}`);
      continue;
    }
    if (kind === "ast" && !isSupportedAstLang(lang)) {
      notes.push(`丢弃 lang 不受支持的 ast 选择器: ${noteId} (${clip(oneLine(lang), 40)})`);
      continue;
    }
    const scope = asString(item.scope).trim();
    const target = asString(item.target).trim();
    const exclude = asString(item.exclude).trim();
    const intentValue = asString(item.intent).trim();
    const safeFields = [query, scope, target, exclude, intentValue, lang];
    if (!safeFields.every((value) => isSafeSelectorText(value))) {
      notes.push(`丢弃含控制字符或以 - 开头的选择器: ${noteId}`);
      continue;
    }
    if ((kind === "ast" || kind === "graph" || kind === "tool") && !caps.npm) {
      notes.push(`丢弃 ${noteKind} 选择器 ${noteId}: npx 不可用`);
      continue;
    }
    if (kind === "ast" && !caps.ast) {
      notes.push(`丢弃 ast 选择器 ${noteId}: ast-grep 不可用`);
      continue;
    }
    if (kind === "graph" && !caps.graph) {
      notes.push(`丢弃 graph 选择器 ${noteId}: madge 不可用`);
      continue;
    }
    if (kind === "tool") {
      const tool = query.toLowerCase();
      if (tool === "knip" && !caps.knip) {
        notes.push(`丢弃 knip 选择器 ${noteId}: knip 不可用`);
        continue;
      }
      if (tool === "jscpd" && !caps.jscpd) {
        notes.push(`丢弃 jscpd 选择器 ${noteId}: jscpd 不可用`);
        continue;
      }
      if (tool !== "knip" && tool !== "jscpd") {
        notes.push(`丢弃未知工具选择器 ${noteId}: ${clip(oneLine(query), 60)}`);
        continue;
      }
    }
    const baseId = asString(item.id).trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
    let id = baseId !== "" ? baseId : `sel-${i + 1}`;
    let suffix = 1;
    while (seenIds.has(id)) {
      id = `${baseId !== "" ? baseId : `sel-${i + 1}`}-${suffix}`;
      suffix += 1;
    }
    seenIds.add(id);
    result.push({
      id,
      kind: kind as SelectorSpec["kind"],
      lang,
      query,
      scope,
      target,
      exclude,
      intent: intentValue !== "" ? intentValue : query,
      dimension: dimension as SelectorSpec["dimension"],
      budget: asNumber(item.budget),
    });
  }
  return result;
}

/** 合并存档规则:同 id 以新规则为准,保留能力缺失时被过滤掉的历史规则。 */
function mergeSelectorArchive(base: SelectorSpec[], final: SelectorSpec[]): SelectorSpec[] {
  const byId = new Map<string, SelectorSpec>();
  for (const selector of base) {
    byId.set(selector.id, selector);
  }
  for (const selector of final) {
    byId.set(selector.id, selector);
  }
  return Array.from(byId.values());
}

/** 读取并校验 `.code-scan/selectors/<repo>.json`。 */
function loadSelectorManifest(text: string, caps: Capabilities, notes: string[]): LoadedManifest | null {
  const parsed = parseJsonLoose<Record<string, unknown>>(text);
  if (parsed === null) {
    return null;
  }
  if (asNumber(parsed.version) !== SELECTOR_VERSION) {
    return null;
  }
  const allCaps: Capabilities = { npm: true, ast: true, graph: true, knip: true, jscpd: true, notes: [] };
  const archiveNotes: string[] = [];
  const archiveSelectors = normalizeSelectors(parsed.selectors, allCaps, archiveNotes);
  if (archiveSelectors.length === 0) {
    return null;
  }
  const selectors = normalizeSelectors(parsed.selectors, caps, notes);
  const filteredSelectors = archiveSelectors.filter(
    (archived) => !selectors.some((selector) => selector.id === archived.id),
  );
  const probe: ProbeStat[] = [];
  if (Array.isArray(parsed.probe)) {
    for (const item of parsed.probe) {
      if (!isRecord(item)) {
        continue;
      }
      probe.push({
        id: asString(item.id),
        hits: asNumber(item.hits),
        sampled: asNumber(item.sampled),
        files: asNumber(item.files),
        note: asString(item.note),
      });
    }
  }
  const previousCaps = isRecord(parsed.capabilities)
    ? {
        npm: parsed.capabilities.npm === true,
        ast: parsed.capabilities.ast === true,
        graph: parsed.capabilities.graph === true,
        knip: parsed.capabilities.knip === true,
        jscpd: parsed.capabilities.jscpd === true,
        notes: Array.isArray(parsed.capabilities.notes)
          ? parsed.capabilities.notes.filter((note): note is string => typeof note === "string")
          : [],
      }
    : caps;
  return {
    version: SELECTOR_VERSION,
    repoHead: asString(parsed.repoHead),
    goal: asString(parsed.goal),
    map: asString(parsed.map),
    selectors,
    probe,
    capabilities: previousCaps,
    goalMatches: asString(parsed.goal) === goal,
    archiveSelectors,
    filteredSelectors,
  };
}

/** 读取存档;不存在或不可解析时返回 null。 */
async function readSelectorManifest(path: string, caps: Capabilities, notes: string[]): Promise<LoadedManifest | null> {
  try {
    const text = await files.read(path);
    return loadSelectorManifest(text, caps, notes);
  } catch {
    return null;
  }
}

/** 探测仓库所需的外部能力。 */
async function detectCapabilities(
  repo: PreparedRepo,
  npmOk: boolean,
  knipConfigReady: boolean,
  astConfigReady: boolean,
  madgeConfigReady: boolean,
  npmConfigSafe: boolean,
  npmToolsShadowed: boolean,
  workspaceSafe: boolean,
): Promise<Capabilities> {
  const notes: string[] = [];
  if (!npmOk) {
    notes.push("npx 不可用:ast/tool/graph 规则无法执行");
  }
  if (npmOk && !npmConfigSafe) {
    notes.push("工作区或其 npm 前缀目录存在 .npmrc,或该检查失败:为避免 npx 读取未受信的 registry/proxy/script-shell/node-options,不运行 ast/graph/tool(工具覆盖降级为 grep)");
  }
  if (npmOk && npmToolsShadowed) {
    notes.push("工作区/npm 前缀/工作区根的 node_modules 含固定工具包或同名 .bin(任意扩展名),或工作区根含同名 PATHEXT 可执行文件,或该检查失败:为避免 npx 使用本地二进制顶替,不运行 ast/graph/tool(工具覆盖降级为 grep)");
  }
  if (npmOk && !astConfigReady) {
    notes.push("ast-grep 安全配置不可用,不运行 ast 规则(避免加载工作区 sgconfig)");
  }
  if (npmOk && !madgeConfigReady) {
    notes.push("madge 安全配置不可用,不运行 graph 规则(避免加载 .madgerc 中的 webpackConfig)");
  }
  const rootManifest = withRepo(repo.dir, "package.json");
  const tsconfigPath = withRepo(repo.dir, "tsconfig.json");
  const pnpmWorkspacePath = withRepo(repo.dir, "pnpm-workspace.yaml");
  let hasPackage = false;
  let hasTsconfig = false;
  let hasPnpmWorkspace = false;
  let hasKnipManifest = false;
  const present = await fsPresence([rootManifest, tsconfigPath, pnpmWorkspacePath]);
  if (present === null) {
    hasPnpmWorkspace = true;
    hasKnipManifest = true;
    notes.push("package.json/tsconfig.json 探测失败");
  } else {
    hasPackage = present[0];
    hasTsconfig = present[1];
    hasPnpmWorkspace = present[2];
    if (hasPackage) {
      try {
        // knip 只读取根 package.json#knip;嵌套 manifest 不会加载配置代码。
        // 不扫描 **/package.json:workflow walker 会走进 node_modules,易误判。
        const parsed = JSON.parse(await files.read(rootManifest)) as unknown;
        hasKnipManifest = isRecord(parsed) && parsed.knip !== undefined;
      } catch {
        // 无法解析的 package.json 会让 knip 在加载配置阶段报错;仍按不安全处理
        hasKnipManifest = true;
      }
    }
  }
  if (!hasPackage) {
    notes.push("未发现 package.json:knip 未运行");
  }
  if (hasPnpmWorkspace) {
    notes.push("发现 pnpm-workspace.yaml:knip 未运行(其 include 会执行 JS;工具覆盖降级)");
  }
  if (hasKnipManifest) {
    notes.push("根 package.json 含 knip 配置:knip 未运行(避免每工作区配置加载代码;工具覆盖降级)");
  }
  if (npmOk && !knipConfigReady) {
    notes.push("knip 安全配置不可用,未运行 knip(避免执行被测仓库的配置代码)");
  }
  if (npmOk && !workspaceSafe) {
    notes.push("工作区 .code-scan 安全检查未通过:jscpd 未运行(避免写到工作区之外)");
  }
  const jsProject = hasPackage || hasTsconfig;
  return {
    npm: npmOk,
    ast: npmOk && npmConfigSafe && !npmToolsShadowed && astConfigReady,
    graph: npmOk && npmConfigSafe && !npmToolsShadowed && jsProject && madgeConfigReady,
    knip: npmOk && npmConfigSafe && !npmToolsShadowed && hasPackage && knipConfigReady &&
      !hasPnpmWorkspace && !hasKnipManifest,
    jscpd: npmOk && npmConfigSafe && !npmToolsShadowed && jsProject && workspaceSafe,
    notes,
  };
}

/** 检查 node_modules 是否存在,决定 knip 依赖类噪声是否可信。 */
async function nodeModulesPresent(repoDir: string): Promise<boolean> {
  try {
    const result = await world.run(
      "node",
      ["-e", "console.log(require('fs').existsSync(process.argv[1]))", "--", `${repoDir}/node_modules`],
      { timeoutMs: 60000 },
    );
    return result.exitCode === 0 && result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** ast-grep 的规范语言名。 */
function astLanguage(lang: string): string {
  const value = lang.toLowerCase();
  if (value === "ts" || value === "typescript") {
    return "TypeScript";
  }
  if (value === "tsx") {
    return "Tsx";
  }
  if (value === "js" || value === "jsx" || value === "javascript") {
    return "JavaScript";
  }
  if (value === "py" || value === "python") {
    return "Python";
  }
  if (value === "go") {
    return "Go";
  }
  if (value === "rs" || value === "rust") {
    return "Rust";
  }
  if (value === "java") {
    return "Java";
  }
  return lang;
}

/** 把选择器 query 变成 ast-grep 规则 JSON:模式或关系规则都支持。 */
function astRuleJson(selector: SelectorSpec): string {
  let body: unknown = { pattern: selector.query.trim() };
  const query = selector.query.trim();
  if (query.startsWith("{")) {
    const parsed = parseJsonLoose<Record<string, unknown>>(query);
    if (parsed !== null) {
      body = parsed.rule !== undefined ? parsed.rule : parsed;
    }
  }
  return JSON.stringify({
    id: selector.id,
    language: astLanguage(selector.lang),
    rule: body,
    message: "selector hit",
    severity: "warning",
  });
}

/** 解析 knip JSON,兼容 v5/v6 的两种形状。 */
function parseKnipOutput(stdout: string, repoDir: string, hasNodeModules: boolean): ToolOutcome {
  const report = parseJsonLoose<Record<string, unknown>>(stdout);
  if (report === null) {
    return { hits: [], note: "knip 输出无法解析" };
  }
  const hits: Hit[] = [];
  let filteredCount = 0;
  const noiseKeys = new Set([
    "unlisted",
    "unresolved",
    "binaries",
    "catalog",
    "catalogReferences",
    "optionalPeerDependencies",
  ]);
  const filteredNoise = !hasNodeModules;
  const pushHit = (path: string, line: number, provenance: string, dimensionProof: string) => {
    if (path === "") {
      return;
    }
    const normalized = normPath(repoDir, path);
    if (normalized === "") {
      return;
    }
    hits.push({
      path: normalized,
      line,
      excerpt: `${provenance}${dimensionProof}`,
      confidence: 0.9,
      provenance: "knip",
    });
  };
  const filesValue = report.files;
  const hasTopLevelFiles = Array.isArray(filesValue);
  if (Array.isArray(filesValue)) {
    for (const item of filesValue) {
      if (typeof item === "string") {
        pushHit(item, 0, "knip unused file: ", item);
      } else if (isRecord(item)) {
        const name = asString(item.name);
        pushHit(name, 0, "knip unused file: ", name);
      }
    }
  }
  const issuesValue = report.issues;
  if (Array.isArray(issuesValue)) {
    for (const issueValue of issuesValue) {
      if (!isRecord(issueValue)) {
        continue;
      }
      const issueFile = asString(issueValue.file);
      for (const key of Object.keys(issueValue)) {
        if (key === "file") {
          continue;
        }
        if (key === "files" && hasTopLevelFiles) {
          continue;
        }
        const value = issueValue[key];
        if (!Array.isArray(value)) {
          continue;
        }
        if (filteredNoise && noiseKeys.has(key)) {
          filteredCount += value.length;
          continue;
        }
        for (const entry of value) {
          let name = "";
          let line = 0;
          if (typeof entry === "string") {
            name = entry;
          } else if (isRecord(entry)) {
            name = asString(entry.name);
            line = asNumber(entry.line);
          } else {
            continue;
          }
          const targetPath = issueFile !== "" ? issueFile : name;
          const dimension = key === "cycles" ? "quality" : "dead-code";
          pushHit(targetPath, line, `knip ${key}: ${name}`, ` (${dimension})`);
        }
      }
    }
  }
  const note = filteredCount > 0
    ? `未安装 node_modules,已过滤 knip 的 unlisted/unresolved/binaries 等依赖解析噪声(${filteredCount} 条)`
    : "";
  return { hits, note };
}

/** 解析 jscpd JSON 报告。 */
function parseJscpdOutput(text: string, repoDir: string): ToolOutcome {
  const report = parseJsonLoose<Record<string, unknown>>(text);
  if (report === null) {
    return { hits: [], note: "jscpd 报告无法解析" };
  }
  const duplicates = report.duplicates;
  if (!Array.isArray(duplicates)) {
    return { hits: [], note: "jscpd 报告缺少 duplicates" };
  }
  const hits: Hit[] = [];
  for (const entry of duplicates) {
    if (!isRecord(entry)) {
      continue;
    }
    const first = isRecord(entry.firstFile) ? entry.firstFile : null;
    const second = isRecord(entry.secondFile) ? entry.secondFile : null;
    if (first === null || second === null) {
      continue;
    }
    const firstName = asString(first.name);
    const secondName = asString(second.name);
    const firstStart = asNumber(first.start);
    const secondStart = asNumber(second.start);
    const lines = asNumber(entry.lines);
    const normalized = normPath(repoDir, firstName);
    if (firstName === "" || normalized === "") {
      continue;
    }
    hits.push({
      path: normalized,
      line: firstStart,
      excerpt: `与 ${secondName}:${secondStart} 重复 ${lines} 行`,
      confidence: 0.9,
      provenance: "jscpd",
    });
  }
  return { hits, note: "" };
}

/** Tarjan 的迭代版 Kosaraju:返回所有强连通环。 */
function computeCycles(edges: Map<string, string[]>): string[][] {
  const nodes = new Set<string>();
  for (const [from, tos] of edges) {
    nodes.add(from);
    for (const to of tos) {
      nodes.add(to);
    }
  }
  const reverse = new Map<string, string[]>();
  for (const node of nodes) {
    reverse.set(node, []);
  }
  for (const [from, tos] of edges) {
    for (const to of tos) {
      const back = reverse.get(to);
      if (back !== undefined) {
        back.push(from);
      }
    }
  }
  const visited = new Set<string>();
  const order: string[] = [];
  for (const start of nodes) {
    if (visited.has(start)) {
      continue;
    }
    visited.add(start);
    const stack: Array<{ node: string; index: number }> = [{ node: start, index: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const nexts = edges.get(frame.node) ?? [];
      if (frame.index < nexts.length) {
        const next = nexts[frame.index];
        frame.index += 1;
        if (!visited.has(next)) {
          visited.add(next);
          stack.push({ node: next, index: 0 });
        }
      } else {
        order.push(frame.node);
        stack.pop();
      }
    }
  }
  const assigned = new Set<string>();
  const components: string[][] = [];
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const start = order[i];
    if (assigned.has(start)) {
      continue;
    }
    assigned.add(start);
    const component: string[] = [];
    const stack: string[] = [start];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) {
        break;
      }
      component.push(node);
      const back = reverse.get(node) ?? [];
      for (const previous of back) {
        if (!assigned.has(previous)) {
          assigned.add(previous);
          stack.push(previous);
        }
      }
    }
    if (component.length > 1 || (edges.get(component[0]) ?? []).includes(component[0])) {
      components.push(component.slice().sort());
    }
  }
  return components;
}

/** 从 madge 输出构建依赖图。 */
function buildGraph(raw: unknown, repoDir: string): GraphInfo {
  if (!isRecord(raw)) {
    return { edges: new Map(), fanIn: new Map(), cycles: [], note: "madge 输出无法解析" };
  }
  const edges = new Map<string, string[]>();
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const from = normPath(repoDir, key);
    if (from === "") {
      continue;
    }
    const tos: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        const to = normPath(repoDir, item);
        if (to !== "") {
          tos.push(to);
        }
      }
    }
    edges.set(from, tos);
  }
  if (edges.size === 0) {
    return { edges, fanIn: new Map(), cycles: [], note: "madge 未产出依赖边(仓库可能不是 JS/TS)" };
  }
  const fanIn = new Map<string, number>();
  for (const [, tos] of edges) {
    for (const to of tos) {
      fanIn.set(to, (fanIn.get(to) ?? 0) + 1);
    }
  }
  return { edges, fanIn, cycles: computeCycles(edges), note: "" };
}

/** 选择 madge 的 tsconfig:仓库自带优先,否则用脚本写入的安全默认。 */
async function detectRepoMadgeTsConfig(repoDir: string): Promise<string> {
  if (workspaceRoot !== "") {
    const present = await fsPresence([withRepo(repoDir, "tsconfig.json")]);
    if (present !== null && present[0] === true) {
      const base = workspaceRoot;
      const dir = repoDir.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
      return `${base}/${dir === "." || dir === "" ? "" : `${dir}/`}tsconfig.json`;
    }
  }
  return madgeTsConfigPath;
}

/** 运行 npx 工具:优先用 node 启动 npm 自带的 npx-cli.js,避免 Windows 直接 spawn npx/.cmd 失败。 */
async function runNpx(args: string[], timeoutMs: number) {
  if (npxCliPath !== "") {
    return world.run("node", [npxCliPath, ...args], { timeoutMs });
  }
  return world.run("npx", args, { timeoutMs });
}

/** 运行 madge,得到模块图;固定安全 webpack/tsconfig,避免执行仓库/工作区的 .madgerc 代码。 */
async function prepareGraph(ctx: RepoContext): Promise<GraphInfo> {
  if (
    ctx.madgeWebpackPath === "" ||
    ctx.madgeTsConfigPath === "" ||
    ctx.madgeRequireConfigPath === ""
  ) {
    return { edges: new Map(), fanIn: new Map(), cycles: [], note: "madge 安全配置路径不可用,未运行" };
  }
  try {
    const result = await runNpx(
      [
        "--yes",
        "--ignore-scripts",
        "--package",
        MADGE_PKG,
        "--",
        "madge",
        "--json",
        "--extensions",
        "js,jsx,mjs,cjs,ts,tsx",
        "--webpack-config",
        ctx.madgeWebpackPath,
        "--ts-config",
        ctx.madgeTsConfigPath,
        "--require-config",
        ctx.madgeRequireConfigPath,
        ctx.repo.dir,
      ],
      300000,
    );
    if (result.exitCode !== 0) {
      return { edges: new Map(), fanIn: new Map(), cycles: [], note: `madge 失败: ${clip(result.stderr, 300)}` };
    }
    return buildGraph(parseJsonLoose<unknown>(result.stdout), ctx.repo.dir);
  } catch {
    return { edges: new Map(), fanIn: new Map(), cycles: [], note: "madge 执行失败" };
  }
}

/** 运行 knip;每仓库只跑一次。 */
async function runKnip(ctx: RepoContext): Promise<ToolOutcome> {
  const configPath = ctx.knipConfigPath;
  if (configPath === "" || ctx.knipPreprocessorPath === "") {
    return { hits: [], note: "knip 安全配置路径不可用,未运行" };
  }
  try {
    const result = await runNpx(
      [
        "--yes",
        "--ignore-scripts",
        "--package",
        KNIP_PKG,
        "--",
        "knip",
        "--preprocessor",
        ctx.knipPreprocessorPath,
        "--config",
        configPath,
        "--directory",
        ctx.repo.dir,
        "--reporter",
        "json",
      ],
      300000,
    );
    if (result.stdout.trim() === "") {
      return { hits: [], note: `knip 无输出: ${clip(result.stderr, 300)}` };
    }
    return parseKnipOutput(result.stdout, ctx.repo.dir, ctx.hasNodeModules);
  } catch {
    return { hits: [], note: "knip 执行失败" };
  }
}

/** 运行 jscpd;报告写到 node mkdtemp 生成的独占目录,避免复用旧路径或符号链接。 */
async function runJscpd(ctx: RepoContext): Promise<ToolOutcome> {
  let outputDir = "";
  try {
    const mk = await world.run("node", ["-e", OUTPUT_CODE], { timeoutMs: 60000 });
    if (mk.exitCode === 0) {
      outputDir = mk.stdout.trim().replace(/\\/g, "/");
    }
  } catch {
    outputDir = "";
  }
  if (outputDir === "") {
    return { hits: [], note: "jscpd 输出目录创建失败" };
  }
  try {
    const result = await runNpx(
      [
        "--yes",
        "--ignore-scripts",
        "--package",
        JSCPD_PKG,
        "--",
        "jscpd",
        ctx.repo.dir,
        "--reporters",
        "json",
        "--output",
        outputDir,
        "--format",
        "javascript,typescript,jsx,tsx",
        "--min-tokens",
        "50",
        "--ignore",
        "**/node_modules/**,**/dist/**,**/build/**,**/vendor/**",
      ],
      300000,
    );
    if (result.exitCode !== 0) {
      return { hits: [], note: `jscpd 失败: ${clip(result.stderr, 300)}` };
    }
    const text = await files.read(`${outputDir}/jscpd-report.json`);
    return parseJscpdOutput(text, ctx.repo.dir);
  } catch {
    return { hits: [], note: "jscpd 报告读取失败" };
  }
}

/** 工具结果的缓存入口。 */
async function toolOutcome(ctx: RepoContext, name: string): Promise<ToolOutcome> {
  const cached = ctx.toolCache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  let outcome: ToolOutcome;
  if (name === "knip") {
    outcome = await runKnip(ctx);
  } else if (name === "jscpd") {
    outcome = await runJscpd(ctx);
  } else {
    outcome = { hits: [], note: `未知工具: ${name}` };
  }
  ctx.toolCache.set(name, outcome);
  return outcome;
}

/** 执行 scope 选择器:只圈文件,不产生信号。 */
async function runScopeSelector(ctx: RepoContext, selector: SelectorSpec): Promise<{ paths: string[]; note: string }> {
  const pattern = selector.query !== ""
    ? withRepo(ctx.repo.dir, selector.query)
    : ctx.repo.dir === "."
      ? "**"
      : `${ctx.repo.dir}/**`;
  try {
    const raw = await files.glob(pattern);
    let paths = raw
      .map((path) => normPath(ctx.repo.dir, path))
      .filter((path) => path !== "");
    const excludes = splitList(selector.exclude);
    if (excludes.length > 0) {
      paths = paths.filter((path) => !matchesAny(path, excludes));
    }
    const capNote =
      raw.length >= 2000 ? `scope 命中达到 2000 上限,仅取前 2000: ${selector.query}` : "";
    return { paths, note: capNote };
  } catch (error) {
    return {
      paths: [],
      note: `scope 模式无效或枚举失败: ${selector.query} (${oneLine(
        error instanceof Error ? error.message : String(error),
      )})`,
    };
  }
}

/** 执行 grep 选择器。 */
async function runGrepSelector(ctx: RepoContext, selector: SelectorSpec): Promise<ToolOutcome> {
  const scopePattern = selector.scope !== ""
    ? withRepo(ctx.repo.dir, selector.scope)
    : ctx.repo.dir === "."
      ? "**"
      : `${ctx.repo.dir}/**`;
  try {
    const matches = await files.grep(selector.query, scopePattern);
    const hits: Hit[] = [];
    for (const match of matches) {
      const normalized = normPath(ctx.repo.dir, match.path);
      if (normalized === "") {
        continue;
      }
      hits.push({
        path: normalized,
        line: match.line,
        excerpt: clip(match.text, 200),
        confidence: 0.6,
        provenance: "grep",
      });
    }
    const capNote =
      matches.length >= 2000 ? "grep 命中达到 2000 上限,仅取前 2000 行" : "";
    return { hits, note: capNote };
  } catch (error) {
    const detail = oneLine(error instanceof Error ? error.message : String(error));
    // 超过 2000 行是 harness 的硬拒绝,不是正则写错;修订员该收窄 scope 而不是改正则。
    if (/2000|too many|exceed/i.test(detail)) {
      return {
        hits: [],
        note: `grep 命中超过上限被拒绝,需收窄 scope 或改用更精确的正则: ${selector.query} (${detail})`,
      };
    }
    return {
      hits: [],
      note: `grep 模式无效或检索失败 (${detail})`,
    };
  }
}

/** 执行 ast-grep 选择器;模式与关系规则共用同一条执行路径。 */
async function runAstSelector(ctx: RepoContext, selector: SelectorSpec): Promise<ToolOutcome> {
  if (ctx.astConfigPath === "") {
    return { hits: [], note: "ast-grep 安全配置路径不可用,未运行" };
  }
  const ruleJson = astRuleJson(selector);
  const args = [
    "--yes",
    "--ignore-scripts",
    "--package",
    AST_GREP_PKG,
    "--",
    "ast-grep",
    "scan",
    "--config",
    ctx.astConfigPath,
    "--inline-rules",
    ruleJson,
    "--json=compact",
    "--custom-languages",
    "ignore",
  ];
  if (selector.scope !== "") {
    args.push("--globs", withRepo(ctx.repo.dir, selector.scope));
  }
  for (const exclude of splitList(selector.exclude)) {
    args.push("--globs", `!${withRepo(ctx.repo.dir, exclude)}`);
  }
  args.push(ctx.repo.dir);
  try {
    const result = await runNpx(args, 300000);
    if (result.exitCode !== 0 && result.stdout.trim() === "") {
      return { hits: [], note: `ast-grep 失败: ${clip(result.stderr, 300)}` };
    }
    const matches = parseJsonLoose<Record<string, unknown>[]>(result.stdout);
    if (!Array.isArray(matches)) {
      return { hits: [], note: "ast-grep 输出无法解析" };
    }
    const hits: Hit[] = [];
    for (const match of matches) {
      if (!isRecord(match)) {
        continue;
      }
      const file = asString(match.file);
      if (file === "") {
        continue;
      }
      const range = isRecord(match.range) ? match.range : null;
      const start = range !== null && isRecord(range.start) ? range.start : null;
      const startLine = start !== null && typeof start.line === "number" && Number.isFinite(start.line)
        ? start.line
        : -1;
      const line = startLine >= 0 ? startLine + 1 : 0;
      const text = asString(match.lines) !== "" ? asString(match.lines) : asString(match.text);
      const normalized = normPath(ctx.repo.dir, file);
      if (normalized === "") {
        continue;
      }
      hits.push({
        path: normalized,
        line,
        excerpt: clip(text !== "" ? text : asString(match.message), 200),
        confidence: 0.85,
        provenance: "ast-grep",
      });
    }
    return { hits, note: "" };
  } catch {
    return { hits: [], note: "ast-grep 执行失败或输出超过上限" };
  }
}

/** 执行 graph 选择器:cycle / orphan / layering。 */
async function runGraphSelector(ctx: RepoContext, selector: SelectorSpec): Promise<ToolOutcome> {
  const graph = ctx.graph;
  if (graph === null) {
    return { hits: [], note: "未准备依赖图" };
  }
  if (graph.note !== "") {
    return { hits: [], note: graph.note };
  }
  const query = selector.query.trim().toLowerCase();
  const hits: Hit[] = [];
  if (query === "cycle") {
    for (const component of graph.cycles) {
      const inScope = selector.scope !== ""
        ? component.filter((path) => globToRegExp(selector.scope).test(path))
        : component;
      if (inScope.length === 0) {
        continue;
      }
      const excerpt = `循环依赖: ${inScope.join(" → ")}`;
      for (const path of inScope) {
        hits.push({ path, line: 0, excerpt, confidence: 0.95, provenance: "madge cycle" });
      }
    }
    return { hits, note: "" };
  }
  if (query === "orphan") {
    let candidates: string[] = [];
    if (selector.scope !== "") {
      try {
        candidates = (await files.glob(withRepo(ctx.repo.dir, selector.scope)))
          .map((path) => normPath(ctx.repo.dir, path))
          .filter((path) => path !== "");
      } catch {
        return { hits: [], note: "orphan 候选范围超过 2000 文件" };
      }
    } else {
      candidates = Array.from(graph.edges.keys());
    }
    const entries = splitList(selector.target);
    for (const path of candidates) {
      if ((graph.fanIn.get(path) ?? 0) > 0) {
        continue;
      }
      if (entries.length > 0 && matchesAny(path, entries)) {
        continue;
      }
      hits.push({
        path,
        line: 0,
        excerpt: "扇入 0:没有模块引用它,可能是死文件",
        confidence: 0.8,
        provenance: "madge orphan",
      });
    }
    return { hits, note: "" };
  }
  if (query === "layering") {
    const targets = splitList(selector.target);
    if (targets.length === 0) {
      return { hits: [], note: "layering 缺少 target glob" };
    }
    for (const [from, tos] of graph.edges) {
      if (selector.scope !== "" && !globToRegExp(selector.scope).test(from)) {
        continue;
      }
      for (const to of tos) {
        if (matchesAny(to, targets)) {
          hits.push({
            path: from,
            line: 0,
            excerpt: `${from} → ${to} 违反分层规则`,
            confidence: 0.9,
            provenance: "madge layering",
          });
        }
      }
    }
    return { hits, note: "" };
  }
  return { hits: [], note: `未知 graph 规则: ${selector.query}` };
}

/** 执行一条选择器,带签名缓存、排除与预算。 */
async function executeSelector(ctx: RepoContext, selector: SelectorSpec): Promise<SelectorRun> {
  const signature = selectorSignature(selector);
  const cached = ctx.selectorCache.get(signature);
  if (cached !== undefined) {
    return cached;
  }
  let rawHits: Hit[] = [];
  let paths: string[] = [];
  let baseNote = "";
  if (selector.kind === "scope") {
    const scope = await runScopeSelector(ctx, selector);
    paths = scope.paths;
    baseNote = scope.note;
  } else if (selector.kind === "grep") {
    const outcome = await runGrepSelector(ctx, selector);
    rawHits = outcome.hits;
    baseNote = outcome.note;
  } else if (selector.kind === "ast") {
    const outcome = await runAstSelector(ctx, selector);
    rawHits = outcome.hits;
    baseNote = outcome.note;
  } else if (selector.kind === "graph") {
    const outcome = await runGraphSelector(ctx, selector);
    rawHits = outcome.hits;
    baseNote = outcome.note;
  } else {
    const name = selector.query.trim().toLowerCase();
    if (name === "knip" && ctx.caps.knip) {
      const outcome = await toolOutcome(ctx, "knip");
      rawHits = outcome.hits;
      baseNote = outcome.note;
    } else if (name === "jscpd" && ctx.caps.jscpd) {
      const outcome = await toolOutcome(ctx, "jscpd");
      rawHits = outcome.hits;
      baseNote = outcome.note;
    } else {
      baseNote = `工具不可用或未知: ${selector.query}`;
    }
  }
  const excludes = splitList(selector.exclude);
  if (excludes.length > 0) {
    rawHits = rawHits.filter((hit) => !matchesAny(hit.path, excludes));
  }
  const decorated: Signal[] = rawHits.map((hit) => ({
    ...hit,
    selectorId: selector.id,
    intent: selector.intent,
    dimension: selector.dimension,
    kind: selector.kind,
  }));
  if (selector.kind === "scope") {
    const run: SelectorRun = {
      id: selector.id,
      kind: selector.kind,
      intent: selector.intent,
      dimension: selector.dimension,
      hits: paths.length,
      sampled: 0,
      files: paths.length,
      note: baseNote,
      signals: [],
      paths,
    };
    ctx.selectorCache.set(signature, run);
    return run;
  }
  const sorted = decorated.slice().sort(signalOrder);
  const budget = selectorBudget(selector);
  const kept = sorted.slice(0, budget);
  const hits = sorted.length;
  let note = baseNote;
  if (hits > budget) {
    note = `${note !== "" ? `${note}; ` : ""}命中 ${hits} 条,超过预算 ${budget},按路径确定性采样`;
  }
  const run: SelectorRun = {
    id: selector.id,
    kind: selector.kind,
    intent: selector.intent,
    dimension: selector.dimension,
    hits,
    sampled: kept.length,
    files: new Set(kept.map((signal) => signal.path)).size,
    note,
    signals: kept,
    paths: [],
  };
  ctx.selectorCache.set(signature, run);
  return run;
}

/** 为规划员准备提示词。 */
function planPrompt(
  repo: PreparedRepo,
  caps: Capabilities,
  previous: SelectorSpec[],
  previousMap: string,
  previousProbe: ProbeStat[],
): string {
  const capabilityLine = [
    `npm/npx=${caps.npm}`,
    `ast-grep=${caps.ast}`,
    `knip=${caps.knip}`,
    `jscpd=${caps.jscpd}`,
    `graph(madge)=${caps.graph}`,
  ].join("; ");
  const probeLines = previousProbe.map(
    (stat) => `- ${stat.id}: 命中 ${stat.hits},采样 ${stat.sampled},文件 ${stat.files}${stat.note !== "" ? ` — ${stat.note}` : ""}`,
  );
  const previousText = previous.length > 0
    ? `\n上次运行的 selectors(可复用,也可按仓库现状修订):\n${clip(JSON.stringify(previous), 3000)}\n上次地图:${clip(previousMap, 800)}\n上次试跑:\n${probeLines.join("\n")}`
    : "";
  return `研究仓库目录 ${repo.dir}(仓库名 ${repo.name})。扫描侧重:${goal}。\n能力:${capabilityLine}。能力说明:${caps.notes.join(";") || "无"}${previousText}\n\n历史规则与上次地图已在上面的提示中给出;不要读取 .code-scan/selectors/*.json 或不存在的文件;需要探索仓库时用 Grep/Glob。
只返回作用于全库的确定性选择规则,不要返回文件清单。每条 selector 字段如下(全部必填,不适用的填 ""):\n{ id, kind, lang, query, scope, target, exclude, intent, dimension, budget }\n\n规则类型:\n- kind=scope:query 是路径 glob(如 "src/**/*.ts"),只圈定审查边界,不产生信号;至少 1 条。\n- kind=grep:query 是 ripgrep 正则(不支持 lookahead/lookbehind/反向引用,写了会直接报错),scope 是路径 glob(空=全仓库),命中行成为信号。\n- kind=ast:query 是 ast-grep AST 模式(如 "catch ($ERR) { }"、"$ARR.forEach(async ($X) => { $$$ })"),lang 取 ts|tsx|js|jsx|py|go|rust|java,scope 是路径 glob。若需要关系查询,query 可以是 ast-grep 规则 JSON(如 {"rule":{"all":[{"pattern":"..."},{"inside":{"kind":"function_declaration"}}]}})。\n- kind=graph:query 取 cycle|orphan|layering;cycle 用 scope 过滤环中文件;orphan 用 scope 圈候选、target 填入口豁免 glob(逗号分隔);layering 用 scope 填来源 glob、target 填禁止依赖的目标 glob(逗号分隔)。\n- kind=tool:query 取 knip|jscpd,分别报未使用导出/依赖与重复代码。\n\n约束:\n- id 用 ASCII,稳定且唯一(重跑会复用同 id 的规则)。\n- 规则数量:scope 2–3 条,产生信号的规则合计 8–12 条。每条 grep 都是一次全库检索,规则越多成本越高;覆盖不到的边角写进 skipped,不要靠堆规则。\n- scope 规则只圈范围;产生信号的规则至少各 1 条,否则分片没有依据。\n- **单条 grep 命中必须低于 2000 行**:grep 超过 2000 行是直接报错而不是截断,budget 管不到这种情形。预计命中接近这个量级时,收窄 scope 或换更精确的正则;拿不准就先用窄 scope。\n- budget 是单条规则命中上限(默认 ${defaultSelectorBudget},最大 2000);预计命中很多时收窄 scope 或换更精确的 query,而不是靠采样。
- dimension 取 quality|dead-code|perf。\n- exclude 是逗号分隔的路径 glob,可排除测试/生成物。\n- intent 用一句中文写清这条规则要找什么,会带给批次审查员。\n- 只使用能力为 true 的类型;不可用的类型不要写。\n\n返回 selectors、map(≤1500 字的仓库地图:模块树、职责、入口、关键依赖边)与 skipped(有意跳过的目录与理由)。`;
}

/** 为修订员准备提示词。 */
function revisionPrompt(
  repo: PreparedRepo,
  caps: Capabilities,
  selectors: SelectorSpec[],
  runs: SelectorRun[],
  dead: SelectorRun[],
  flooded: SelectorRun[],
  scopeIssues: SelectorRun[],
): string {
  const stats = runs.map(
    (run) => `- ${run.id} (${run.kind}/${run.dimension}): 命中 ${run.hits},采样 ${run.sampled},文件 ${run.files}${run.note !== "" ? ` — ${run.note}` : ""}`,
  );
  const scopeLines = scopeIssues.map(
    (run) => `- ${run.id}: ${run.note !== "" ? run.note : "命中 0 个文件"}`,
  );
  return `你是选择器修订员。仓库 ${repo.name}(目录 ${repo.dir}) 的第一轮全库试跑结果如下:\n${stats.join("\n")}\n\n死规则(零信号):${dead.map((run) => run.id).join(", ") || "无"}\n超量规则(被采样):${flooded.map((run) => run.id).join(", ") || "无"}\n范围规则问题(scope 零命中/枚举失败/超限):${scopeLines.join("; ") || "无"}\n能力:${caps.notes.join(";") || "npx/ast/knip/jscpd/graph 均可用"}\n\n现有关键规则:\n${clip(JSON.stringify(selectors), 3000)}\n\n修订要求:\n1. 保留能命中的规则,id 不变(便于持久化复用)。\n2. 死规则:换更宽的 scope/更准确的 query/更合适的 lang,或删除;不要保留不可执行的工具。\n3. 超量规则:收窄 scope 或换更精确的 query;预算最多 2000。\n4. scope 规则:修正 query/exclude,确保至少命中仓库内文件;不要删除 scope 规则。\n5. 不要新增不可用能力;不要返回文件清单。\n返回完整 selectors 列表(不是增量)与 notes(一句话说明改了什么)。`;
}

phase("准备:获取目标仓库并探测工具");
let workspaceChecked = false;
let workspaceSafe = true;
try {
  const workspaceCheck = await world.run("node", ["-e", CHECK_WORKSPACE_CODE], { timeoutMs: 60000 });
  workspaceChecked = true;
  workspaceSafe = workspaceCheck.exitCode === 0;
} catch {
  workspaceChecked = false;
}
if (!workspaceSafe) {
  log("检测到 .code-scan 不可安全写入(符号链接/联接或指向工作区外):拒绝克隆与 jscpd 写盘");
}
const prepared: PreparedRepo[] = [];
const usedKeys = new Set<string>();
const usedNames = new Set<string>();
for (const spec of targets) {
  if (spec.localPath !== "") {
    const key = uniqueKey(spec.name, usedKeys);
    const name = uniqueName(spec.name, usedNames);
    if (!isSafeLocalPath(spec.localPath)) {
      prepared.push({ name, key, dir: spec.localPath, ok: false, note: "localPath 必须是工作区内相对路径,且不能包含 .." });
      continue;
    }
    const localDir = spec.localPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    const localTarget = localDir !== "" ? localDir : ".";
    try {
      const pathCheck = await world.run("node", ["-e", CHECK_PATH_CODE, "--", localTarget], { timeoutMs: 60000 });
      const existsCheck = await world.run("node", ["-e", CHECK_DIR_EXISTS_CODE, "--", localTarget], { timeoutMs: 60000 });
      if (pathCheck.exitCode !== 0 || existsCheck.exitCode !== 0) {
        prepared.push({
          name,
          key,
          dir: localTarget,
          ok: false,
          note: "localPath 不存在、不是目录,或含符号链接/联接/指向工作区外",
        });
        continue;
      }
    } catch {
      prepared.push({ name, key, dir: localTarget, ok: false, note: "localPath 安全检查失败" });
      continue;
    }
    prepared.push({ name, key, dir: localTarget, ok: true, note: "使用工作区内目录" });
    continue;
  }
  if (spec.url === "") {
    prepared.push({ name: spec.name, key: "", dir: "", ok: false, note: "缺少 url 或 path" });
    continue;
  }
  if (!isSafeRepoUrl(spec.url)) {
    prepared.push({ name: spec.name, key: "", dir: "", ok: false, note: "URL 含不支持的协议(如 ext::)或以 - 开头,已拒绝" });
    continue;
  }
  if (spec.ref !== "" && !isSafeRef(spec.ref)) {
    prepared.push({ name: spec.name, key: "", dir: "", ok: false, note: `ref 含非法字符: ${spec.ref}` });
    continue;
  }
  if (!workspaceChecked || !workspaceSafe) {
    prepared.push({ name: spec.name, key: "", dir: "", ok: false, note: "工作区 .code-scan 安全检查未通过,拒绝克隆(避免写到工作区之外)" });
    continue;
  }
  const key = uniqueKey(spec.name, usedKeys);
  const name = uniqueName(spec.name, usedNames);
  const dir = `.code-scan/repos/${key}`;
  const targetCheck = await world.run("node", ["-e", CHECK_PATH_CODE, dir], { timeoutMs: 60000 });
  if (targetCheck.exitCode !== 0) {
    prepared.push({ name, key, dir, ok: false, note: "clone 目标路径含符号链接或指向工作区外,已拒绝" });
    continue;
  }
  const clone = await world.run(
    "git",
    ["-c", "protocol.ext.allow=never", "clone", "--depth", "1", "--", spec.url, dir],
    { timeoutMs: 600000 },
  );
  if (clone.exitCode !== 0) {
    prepared.push({ name, key, dir, ok: false, note: `clone 失败: ${clip(clone.stderr, 300)}` });
    continue;
  }
  if (spec.ref !== "") {
    const fetch = await world.run(
      "git",
      ["-c", "protocol.ext.allow=never", "-C", dir, "fetch", "--depth", "1", "origin", spec.ref],
      { timeoutMs: 600000 },
    );
    if (fetch.exitCode !== 0) {
      prepared.push({ name, key, dir, ok: false, note: `fetch ${spec.ref} 失败: ${clip(fetch.stderr, 300)}` });
      continue;
    }
    const checkout = await world.run("git", ["-C", dir, "checkout", "FETCH_HEAD"]);
    if (checkout.exitCode !== 0) {
      prepared.push({ name, key, dir, ok: false, note: `checkout 失败: ${clip(checkout.stderr, 300)}` });
      continue;
    }
  }
  prepared.push({ name, key, dir, ok: true, note: "浅克隆完成" });
}
const ready = prepared.filter((repo) => repo.ok);

let npmAvailable = false;
try {
  const npxPath = await world.run("node", ["-e", NPX_PATH_CODE], { timeoutMs: 60000 });
  npxCliPath = npxPath.exitCode === 0 ? npxPath.stdout.trim() : "";
} catch {
  npxCliPath = "";
}
if (npxCliPath !== "") {
  try {
    const npmCheck = await world.run("node", [npxCliPath, "--version"], { timeoutMs: 120000 });
    npmAvailable = npmCheck.exitCode === 0;
  } catch {
    npmAvailable = false;
  }
} else {
  try {
    const npmCheck = await world.run("npx", ["--version"], { timeoutMs: 120000 });
    npmAvailable = npmCheck.exitCode === 0;
  } catch {
    npmAvailable = false;
  }
}
workspaceRoot = "";
try {
  // JSON 输出:保留目录名末尾空白/反斜杠等字符,不能用 trim()(POSIX 目录名可含尾随空格)
  const pwd = await world.run("node", ["-e", "process.stdout.write(JSON.stringify(process.cwd()))"], { timeoutMs: 60000 });
  if (pwd.exitCode === 0) {
    const parsed = JSON.parse(pwd.stdout) as unknown;
    workspaceRoot = typeof parsed === "string" ? parsed : "";
  }
} catch {
  workspaceRoot = "";
}
// npm 的 ini parser 有别名和带引号的 key,文本黑名单容易被绕过
// (registry, userconfig, script-shell, node-options)。npm 可能读取的任何 project .npmrc 都不可信。
// 定位与存在性用 Node stat 复刻 npm 语义(Windows 大小写不敏感、符号链接算存在)。
const npmGuardResult = workspaceRoot !== "" ? await npmGuard(workspaceRoot) : null;
const npmConfigSafe = npmGuardResult !== null && npmGuardResult.npmrc.length === 0;
const shadowPackagePaths =
  workspaceRoot === ""
    ? []
    : ["knip", "jscpd", "madge", "@ast-grep/cli"].map(
        (pkg) => `${workspaceRoot}/node_modules/${pkg}/package.json`,
      );
const shadowPackagePresence = workspaceRoot !== "" ? await fsPresence(shadowPackagePaths) : null;
const npmToolsShadowed =
  npmGuardResult === null ||
  npmGuardResult.bins.length > 0 ||
  shadowPackagePresence === null ||
  shadowPackagePresence.some(Boolean);
// 运行时复现能力探测:只做一次,结果复用。失败就整段停用,原因写进 notCovered。
const runtimeProbe = await detectRuntimeVerify();
const reproGuidance = runtimeProbe.ok
  ? "若能设计一段可执行复现,额外返回 repro 字段 {script,assertion,proves}。script 是 CommonJS,必须 module.exports = { run };导入仓库代码只能用 createRequire('/src/package.json')(裸 require 会从 /work 解析而失败)。脚本不得写文件、联网、读环境变量、改 process 全局,且不超过 8KB。assertion 三选一:{kind:'throws',match} / {kind:'not-equals',expected} / {kind:'ratio-greater',threshold}(threshold 在 2.5–100,run() 返回 t1Ms/t2Ms 且 t1Ms≥50)。拿不准就不要给 repro。"
  : "";
const knipConfigPath =
  workspaceRoot !== "" ? `${workspaceRoot}/.code-scan/tmp/knip-empty.json` : "";
let knipConfigReady = false;
if (npmAvailable && knipConfigPath !== "") {
  try {
    const writeConfig = await world.run(
      "node",
      ["-e", WRITE_CODE, ".code-scan/tmp/knip-empty.json", KNIP_DENY_ALL_CONFIG],
      { timeoutMs: 60000 },
    );
    knipConfigReady = writeConfig.exitCode === 0;
  } catch {
    knipConfigReady = false;
  }
}
knipPreprocessorPath =
  knipConfigReady && workspaceRoot !== ""
    ? `${workspaceRoot}/.code-scan/tmp/knip-preprocessor.cjs`
    : "";
if (knipConfigReady && knipPreprocessorPath !== "") {
  try {
    const writePreprocessor = await world.run(
      "node",
      [
        "-e",
        WRITE_CODE,
        ".code-scan/tmp/knip-preprocessor.cjs",
        "module.exports = (data) => data;",
      ],
      { timeoutMs: 60000 },
    );
    if (writePreprocessor.exitCode !== 0) {
      knipConfigReady = false;
      knipPreprocessorPath = "";
    }
  } catch {
    knipConfigReady = false;
    knipPreprocessorPath = "";
  }
}
let astConfigReady = false;
if (npmAvailable && workspaceRoot !== "") {
  try {
    const writeConfig = await world.run(
      "node",
      ["-e", WRITE_CODE, ".code-scan/tmp/sgconfig-empty.yml", "{}"],
      { timeoutMs: 60000 },
    );
    astConfigReady = writeConfig.exitCode === 0;
  } catch {
    astConfigReady = false;
  }
}
astConfigPath =
  astConfigReady && workspaceRoot !== ""
    ? `${workspaceRoot}/.code-scan/tmp/sgconfig-empty.yml`
    : "";
let madgeConfigReady = false;
if (npmAvailable && workspaceRoot !== "") {
  try {
    const writeWebpack = await world.run(
      "node",
      ["-e", WRITE_CODE, ".code-scan/tmp/webpack-empty.json", "{}"],
      { timeoutMs: 60000 },
    );
    const writeTsconfig = await world.run(
      "node",
      [
        "-e",
        WRITE_CODE,
        ".code-scan/tmp/tsconfig-empty.json",
        JSON.stringify({ compilerOptions: { moduleResolution: "node", target: "es2020", allowJs: true } }),
      ],
      { timeoutMs: 60000 },
    );
    const writeRequireConfig = await world.run(
      "node",
      ["-e", WRITE_CODE, ".code-scan/tmp/madge-require-config.js", "require.config({});"],
      { timeoutMs: 60000 },
    );
    madgeConfigReady =
      writeWebpack.exitCode === 0 &&
      writeTsconfig.exitCode === 0 &&
      writeRequireConfig.exitCode === 0;
  } catch {
    madgeConfigReady = false;
  }
}
madgeWebpackPath =
  madgeConfigReady && workspaceRoot !== ""
    ? `${workspaceRoot}/.code-scan/tmp/webpack-empty.json`
    : "";
madgeTsConfigPath =
  madgeConfigReady && workspaceRoot !== ""
    ? `${workspaceRoot}/.code-scan/tmp/tsconfig-empty.json`
    : "";
madgeRequireConfigPath =
  madgeConfigReady && workspaceRoot !== ""
    ? `${workspaceRoot}/.code-scan/tmp/madge-require-config.js`
    : "";
log(`目标仓库 ${targets.length} 个,准备成功 ${ready.length} 个;npx ${npmAvailable ? "可用" : "不可用"}`);

const capsList: Capabilities[] = [];
for (const repo of ready) {
  capsList.push(
    await detectCapabilities(
      repo,
      npmAvailable,
      knipConfigReady,
      astConfigReady,
      madgeConfigReady,
      npmConfigSafe,
      npmToolsShadowed,
      workspaceChecked && workspaceSafe,
    ),
  );
}

phase("规划:为每个仓库写全库选择器");
const planned = await Promise.all(
  ready.map(async (repo, index) => {
    const caps = capsList[index];
    const planningNotes: string[] = [];
    const selectorPath = `.code-scan/selectors/${repo.key}.json`;
    const manifest = await readSelectorManifest(selectorPath, caps, planningNotes);
    if (
      manifest !== null &&
      manifest.goalMatches &&
      !refreshSelectors &&
      manifest.selectors.length > 0
    ) {
      return {
        repo,
        caps,
        plan: { selectors: manifest.selectors, map: manifest.map, skipped: [] } as RepoPlan,
        reused: true,
        preserveArchive: manifest.filteredSelectors.length > 0,
        archiveSelectors: manifest.archiveSelectors,
        preservedSelectors: manifest.filteredSelectors,
        notes: planningNotes,
      };
    }
    const previous = manifest === null ? [] : manifest.archiveSelectors;
    const previousMap = manifest === null ? "" : manifest.map;
    const previousProbe = manifest === null ? [] : manifest.probe;
    const planner = agent(
      `规划员-${index + 1}-${repo.name}`,
      {
        system: "你是代码库扫描的规划者。研究给定仓库目录,写出作用于全库的确定性选择规则(selectors),而不是文件清单;同时产出精简仓库地图。不要编辑任何文件;难以判断时写进 skipped。",
        /* @model:plan */
      },
    );
    let plan = await planner.ask<RepoPlan>(planPrompt(repo, caps, previous, previousMap, previousProbe));
    let planMap = typeof plan.map === "string" ? plan.map : "";
    let planSkipped = Array.isArray(plan.skipped)
      ? plan.skipped.filter((note): note is string => typeof note === "string")
      : [];
    let selectors = normalizeSelectors(plan.selectors, caps, planningNotes);
    if (selectors.length === 0) {
      plan = await planner.ask<RepoPlan>(
        `上一轮返回的选择器无法执行(${planningNotes.join(";") || "没有有效规则"})。请重新返回可执行的选择器:至少 1 条 scope 与 1 条 grep/ast/tool/graph 信号规则,只使用能力为 true 的类型。`,
      );
      planMap = typeof plan.map === "string" ? plan.map : planMap;
      planSkipped = Array.isArray(plan.skipped)
        ? plan.skipped.filter((note): note is string => typeof note === "string")
        : planSkipped;
      selectors = normalizeSelectors(plan.selectors, caps, planningNotes);
    }
    const preserve = manifest !== null && manifest.goalMatches && !refreshSelectors;
    const preserved = preserve && manifest !== null ? manifest.filteredSelectors : [];
    const archive = preserve && manifest !== null
      ? mergeSelectorArchive(preserved, selectors)
      : selectors;
    return {
      repo,
      caps,
      plan: { selectors, map: planMap, skipped: planSkipped } as RepoPlan,
      reused: false,
      preserveArchive: preserve,
      archiveSelectors: archive,
      preservedSelectors: preserved,
      notes: planningNotes,
    };
  }),
);

const executions: RepoExecution[] = [];
for (let index = 0; index < planned.length; index += 1) {
  const state = planned[index];
  const ctx: RepoContext = {
    repo: state.repo,
    caps: state.caps,
    hasNodeModules: false,
    knipConfigPath: knipConfigReady ? knipConfigPath : "",
    knipPreprocessorPath: knipConfigReady ? knipPreprocessorPath : "",
    astConfigPath: astConfigReady ? astConfigPath : "",
    madgeWebpackPath: madgeConfigReady ? madgeWebpackPath : "",
    madgeRequireConfigPath: madgeConfigReady ? madgeRequireConfigPath : "",
    madgeTsConfigPath: "",
    graph: null,
    toolCache: new Map(),
    selectorCache: new Map(),
  };
  executions.push({
    repo: state.repo,
    caps: state.caps,
    plan: state.plan,
    reused: state.reused,
    preserveArchive: state.preserveArchive,
    archiveSelectors: state.archiveSelectors,
    preservedSelectors: state.preservedSelectors,
    ctx,
    runs: [],
    repoHead: "",
    notes: state.notes.slice(),
  });
  if (state.plan.selectors.length === 0) {
    executions[index].notes.push("规划员没有产出可执行的选择器");
  }
}

phase("试跑:全库选择器先执行一遍");
const initial = await Promise.all(
  executions.map(async (execution) => {
    if (execution.plan.selectors.length === 0) {
      return execution;
    }
    execution.ctx.hasNodeModules = execution.caps.knip ? await nodeModulesPresent(execution.repo.dir) : false;
    execution.ctx.madgeTsConfigPath = execution.caps.graph ? await detectRepoMadgeTsConfig(execution.repo.dir) : "";
    const needsGraph = execution.plan.selectors.some((selector) => selector.kind === "graph");
    execution.ctx.graph = needsGraph ? await prepareGraph(execution.ctx) : null;
    const runs: SelectorRun[] = [];
    for (const selector of execution.plan.selectors) {
      runs.push(await executeSelector(execution.ctx, selector));
    }
    execution.runs = runs;
    return execution;
  }),
);
for (const execution of initial) {
  if (execution.plan.selectors.length === 0 || execution.repo.dir === "") {
    continue;
  }
  try {
    const head = await world.run("git", ["-C", execution.repo.dir, "rev-parse", "HEAD"], { timeoutMs: 60000 });
    execution.repoHead = head.exitCode === 0 ? clip(head.stdout.trim(), 100) : "";
  } catch {
    execution.repoHead = "";
  }
}

const needsRevision = (execution: RepoExecution): boolean => {
  if (execution.plan.selectors.length === 0) {
    return false;
  }
  return execution.runs.some(
    (run) =>
      scopeNeedsRevision(run) ||
      (run.kind !== "scope" && run.sampled < run.hits) ||
      isDeadRule(run),
  );
};
const revisionTargets = initial.filter(needsRevision);

if (revisionTargets.length > 0) {
  phase("修订:修掉死规则和超量规则");
  const revised = await Promise.all(
    revisionTargets.map(async (execution) => {
      const index = initial.indexOf(execution);
      const signalRuns = execution.runs.filter((run) => run.kind !== "scope");
      const dead = signalRuns.filter(isDeadRule);
      const flooded = signalRuns.filter((run) => run.sampled < run.hits);
      const scopeIssues = execution.runs.filter(scopeNeedsRevision);
      const revisionAgent = agent(
        `规划员修订-${index + 1}-${execution.repo.name}`,
        {
          system: "你是选择器修订员。只改作用于全库的确定性规则,不返回文件清单;不要编辑任何文件;无法执行的工具不要保留。",
          /* @model:revision */
        },
      );
      const revision = await revisionAgent.ask<SelectorRevision>(
        revisionPrompt(
          execution.repo,
          execution.caps,
          execution.plan.selectors,
          execution.runs,
          dead,
          flooded,
          scopeIssues,
        ),
      );
      const notes: string[] = [];
      let selectors = normalizeSelectors(revision.selectors, execution.caps, notes);
      if (selectors.length === 0) {
        execution.notes.push(`修订未返回可执行规则,保留原规则(${revision.notes || "无说明"})`);
        return execution;
      }
      if (!selectors.some((selector) => selector.kind === "scope")) {
        const originalScopes = execution.plan.selectors.filter((selector) => selector.kind === "scope");
        selectors = mergeSelectorArchive(originalScopes, selectors);
      }
      execution.plan = { selectors, map: execution.plan.map, skipped: execution.plan.skipped };
      execution.notes.push(`选择器修订: ${revision.notes || `${selectors.length} 条规则`}`);
      const needsGraphNow = selectors.some((selector) => selector.kind === "graph");
      if (needsGraphNow && execution.ctx.graph === null) {
        if (execution.ctx.madgeTsConfigPath === "") {
          execution.ctx.madgeTsConfigPath = await detectRepoMadgeTsConfig(execution.repo.dir);
        }
        execution.ctx.graph = await prepareGraph(execution.ctx);
      }
      const runs: SelectorRun[] = [];
      for (const selector of selectors) {
        runs.push(await executeSelector(execution.ctx, selector));
      }
      execution.runs = runs;
      if (execution.preserveArchive) {
        execution.archiveSelectors = mergeSelectorArchive(execution.preservedSelectors, selectors);
      } else {
        execution.archiveSelectors = selectors;
      }
      for (const note of notes) {
        execution.notes.push(note);
      }
      return execution;
    }),
  );
  log(`修订完成:${revised.filter(needsRevision).length} 个仓库仍有死规则或超量规则`);
}

phase("记录选择器:供下次复用");
const persistenceNotes: string[] = [];
for (const execution of executions) {
  if (execution.plan.selectors.length === 0) {
    persistenceNotes.push(`${execution.repo.name}: 没有可存档的选择器`);
    continue;
  }
  const selectors = execution.preserveArchive ? execution.archiveSelectors : execution.plan.selectors;
  const manifest: SelectorManifest = {
    version: SELECTOR_VERSION,
    repoHead: execution.repoHead,
    goal,
    map: execution.plan.map,
    selectors,
    probe: execution.runs.map((selectorRun) => ({
      id: selectorRun.id,
      hits: selectorRun.hits,
      sampled: selectorRun.sampled,
      files: selectorRun.files,
      note: selectorRun.note,
    })),
    capabilities: execution.caps,
  };
  const serialized = JSON.stringify(manifest);
  if (serialized.length > MAX_MANIFEST_CHARS) {
    persistenceNotes.push(`${execution.repo.name}: 选择器存档过大(${serialized.length} 字符),未写入`);
    continue;
  }
  const path = `.code-scan/selectors/${execution.repo.key}.json`;
  try {
    const write = await world.run("node", ["-e", WRITE_CODE, path, serialized], { timeoutMs: 120000 });
    persistenceNotes.push(
      write.exitCode === 0
        ? ""
        : `${execution.repo.name}: 选择器存档写入失败: ${clip(write.stderr, 200)}`,
    );
  } catch {
    persistenceNotes.push(`${execution.repo.name}: 选择器存档写入失败(node 不可用)`);
  }
}

interface ScanResult {
  /** 仓库。 */
  repo: PreparedRepo;
  /** 规划。 */
  plan: RepoPlan;
  /** 依赖图。 */
  graph: GraphInfo | null;
  /** 选择器结果。 */
  runs: SelectorRun[];
  /** 去重后的信号。 */
  signals: Signal[];
  /** 批次文件组。 */
  groups: SignalGroup[];
  /** 说明。 */
  notes: string[];
}

const scanResults: ScanResult[] = [];
for (const execution of executions) {
  const scopeRuns = execution.runs.filter((run) => run.kind === "scope");
  const signalRuns = execution.runs.filter((run) => run.kind !== "scope");
  const scopeComplete = scopeRuns.every((run) => run.note === "");
  const hasScope = scopeRuns.length > 0;
  const scopeSet = new Set<string>();
  for (const run of scopeRuns) {
    for (const path of run.paths) {
      scopeSet.add(path);
    }
  }
  const rawSignals = signalRuns.flatMap((run) => run.signals);
  const filteredSignals = hasScope && scopeComplete
    ? rawSignals.filter((signal) => signal.kind === "tool" || scopeSet.has(signal.path))
    : rawSignals;
  const signals = dedupeSignals(filteredSignals);
  const notes: string[] = [];
  let groups = groupSignals(signals, execution.ctx.graph === null ? null : execution.ctx.graph.fanIn);
  if (groups.length === 0 && hasScope && scopeSet.size > 0) {
    const fanIn = execution.ctx.graph === null ? null : execution.ctx.graph.fanIn;
    const fallback = Array.from(scopeSet)
      .sort((left, right) => {
        const leftFanIn = fanIn === null ? 0 : (fanIn.get(left) ?? 0);
        const rightFanIn = fanIn === null ? 0 : (fanIn.get(right) ?? 0);
        return rightFanIn - leftFanIn || (left < right ? -1 : 1);
      })
      .slice(0, FALLBACK_MAX_FILES);
    groups = fallback.map((path) => ({ path, items: [] }));
    notes.push(`没有选择器命中;退化为按范围与扇入抽样 ${groups.length} 个文件`);
  }
  if (!scopeComplete) {
    const scopeErrors = scopeRuns
      .filter((run) => run.note !== "")
      .map((run) => `${run.id}: ${run.note}`);
    notes.push(`scope 规则不完整,未做范围过滤(${scopeErrors.join("; ")})`);
  }
  if (hasScope && scopeComplete && scopeSet.size === 0) {
    notes.push("scope 为空:扫描范围内没有文件,未生成批次");
  }
  if (groups.length === 0 && !hasScope) {
    notes.push("没有选择器命中且没有 scope,未生成批次");
  }
  const omittedSignals = groups.reduce(
    (sum, group) => sum + Math.max(0, group.items.length - MAX_SIGNALS_PER_FILE),
    0,
  );
  if (omittedSignals > 0) {
    notes.push(`批次提示词每文件只展示前 ${MAX_SIGNALS_PER_FILE} 条信号;${omittedSignals} 条信号未送审`);
  }
  for (const run of signalRuns) {
    if (run.signals.length === 0 && run.note === "") {
      notes.push(`选择器 ${run.id} 零命中`);
    }
    if (run.note !== "") {
      notes.push(`选择器 ${run.id}: ${run.note}`);
    }
  }
  const executionNotes = execution.notes.filter((note) => !note.startsWith("选择器修订:"));
  scanResults.push({
    repo: execution.repo,
    plan: execution.plan,
    graph: execution.ctx.graph,
    runs: execution.runs,
    signals,
    groups,
    notes: executionNotes.concat(notes),
  });
}

const allBatchJobs: BatchJob[] = [];
const batchNotes: string[] = [];
for (let repoIndex = 0; repoIndex < scanResults.length; repoIndex += 1) {
  const scan = scanResults[repoIndex];
  const batches = packBatches(scan.groups, maxFilesPerBatch, MAX_SIGNALS_PER_BATCH);
  batches.forEach((groups, index) => {
    allBatchJobs.push({
      repo: scan.repo,
      repoIndex,
      index,
      groups,
      map: scan.plan.map,
      fanIn: scan.graph === null ? null : scan.graph.fanIn,
    });
  });
  scan.plan.skipped.forEach((note) => batchNotes.push(`${scan.repo.name}: ${clip(note, 300)}`));
  scan.notes.forEach((note) => batchNotes.push(`${scan.repo.name}: ${note}`));
}
let batchJobs = allBatchJobs;
if (maxTotalBatches > 0 && batchJobs.length > maxTotalBatches) {
  const dropped = batchJobs.slice(maxTotalBatches);
  batchNotes.push(
    `超出全局批次预算 ${maxTotalBatches}:未复核 ${dropped.length} 个批次、${dropped.reduce((sum, job) => sum + job.groups.length, 0)} 个文件`,
  );
  batchJobs = batchJobs.slice(0, maxTotalBatches);
}
log(`共 ${batchJobs.length} 个批次(并发由 CreateWorkflow 的 max_concurrency 控制)`);

phase("扫描:复核信号批次");
const batched = await Promise.all(
  batchJobs.map(async (job) => {
    const hits = formatGroups(job.groups, job.fanIn);
    const report = await agent(
      `审查员-${job.repoIndex + 1}-${job.repo.name}-${job.index + 1}`,
      {
        system: "你是资深代码评审。输入是全库选择器信号与工具候选,已带 provenance;逐条复核它们是否真是问题,可在仓库目录内 Grep 全局补充上下文,不要只看命中文件。只报你确信的问题;证据必须来自你实际读过的行或实际运行过的命令。不要编辑任何文件。每批次最多 12 条发现;信号之外最多补充 3 条。维度只有 quality/dead-code/perf 三类,安全类问题不要报(没有 security 维度)。severity 只能是 high、medium 或 low,high 仅用于数据丢失、崩溃或错误结果。where 必须是相对仓库根目录的 `路径:行号`。信号没覆盖到、或你无法判断的部分写进 notCovered 并说明原因,不要留空。" + reproGuidance,
        /* @model:review */
      },
    ).ask<BatchReport>(
      `仓库 ${job.repo.name}(目录 ${job.repo.dir}),批次 ${job.index + 1}。侧重:${goal}。\n仓库地图:\n${clip(job.map, 1500)}\n\n全库信号(格式:[选择器/维度] @行 (来源) 证据):\n${hits}\n\n维度:质量、冗余(死代码/重复实现/未使用导出)、性能(必须给复杂度论证或基准数据)。where 用相对仓库根目录的路径,带行号。`,
    );
    const reportFindings: RawFinding[] = Array.isArray(report.findings) ? report.findings : [];
    const reportCoverage: string[] = Array.isArray(report.notCovered) ? report.notCovered : [];
    return { job, report: { findings: reportFindings, notCovered: reportCoverage } };
  }),
);
const findingNotes: string[] = [];
const findings: Finding[] = [];
const overReportedNotes: string[] = [];
const seenFindingKeys = new Set<string>();
const firstFindingByKey = new Map<string, Finding>();
for (const { job, report } of batched) {
  const kept: RawFinding[] = [];
  for (const raw of report.findings) {
    if (kept.length >= MAX_FINDINGS_PER_BATCH) {
      break;
    }
    const normalized = normalizeFinding(raw, findingNotes);
    if (normalized === null) {
      continue;
    }
    const candidate: Finding = { ...normalized, repo: job.repo.name, dir: job.repo.dir };
    // 批次内与批次间都在这里先合并一次,避免为重复项各起一个复核员。
    const key = findingKey(candidate);
    if (seenFindingKeys.has(key)) {
      const first = firstFindingByKey.get(key);
      if (first !== undefined && first.repro === undefined && candidate.repro !== undefined) {
        first.repro = candidate.repro;
      }
      continue;
    }
    seenFindingKeys.add(key);
    firstFindingByKey.set(key, candidate);
    kept.push(normalized);
    findings.push(candidate);
  }
  const reportedCount = report.findings.length;
  if (reportedCount > kept.length) {
    overReportedNotes.push(
      `${job.repo.name}#${job.index + 1}: 审查员返回 ${reportedCount} 条,按上限与去重保留 ${kept.length} 条`,
    );
  }
}
const batchCoverage: string[] = batched
  .map(({ job, report }) => report.notCovered.map((note) => `${job.repo.name}#${job.index + 1}: ${note}`))
  .flat();
log(`收集到 ${findings.length} 条待复核发现`);

phase("复核:确定性复现每条发现的证据");
// 这一步不花 agent:用文件系统与文本比对复现「证据引用的代码确实存在且位置对得上」。
// 与 Devin Security 的 sandbox Verify 同向,但降到纯静态强度;抓的是引用造假
// (编造文件、越界行号、引文与行不符),抓不到「这段代码是不是有意设计」。
const groundings = await Promise.all(findings.map((finding) => groundFinding(finding)));
const confirmNotes: string[] = [];
const checked: CheckedFinding[] = findings.map((finding, index) => {
  const grounding = groundings[index];
  return {
    ...finding,
    key: `f${index + 1}`,
    status: grounding.holds ? "verified" : "unconfirmed",
    note: clip(oneLine(grounding.reason), 300),
  };
});
const groundedCount = checked.filter((item) => item.status === "verified").length;
const ungroundedNotes = checked
  .filter((item) => item.status === "unconfirmed")
  .map((item) => `${item.repo}/${item.where}: ${item.note}`);
log(`复现完成: ${groundedCount}/${checked.length} 条证据通过确定性核对`);
for (const note of ungroundedNotes) {
  confirmNotes.push(note);
}

phase("汇总:去重排序");
const judge = agent(
  "评审长",
  {
    system: "你只负责合并重复项并排序:合并同一仓库同一位置同一问题的重复项,按严重度与影响面排序,最多保留 60 个 key;只返回 key,不要改写其他字段,不要编辑任何文件。",
    /* @model:judge */
  },
);
const judgeCandidates = checked
  .slice()
  .sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.status === "verified" ? 0 : 1) - (b.status === "verified" ? 0 : 1),
  );
const judgeInput: JudgeInputFinding[] = [];
let judgeChars = 0;
for (const finding of judgeCandidates) {
  if (judgeInput.length >= MAX_JUDGE_INPUT_FINDINGS) {
    break;
  }
  const item: JudgeInputFinding = {
    key: finding.key,
    repo: clip(oneLine(finding.repo), 120),
    where: clip(oneLine(finding.where), 160),
    problem: clip(oneLine(finding.problem), 240),
    evidence: clip(finding.evidence, 300),
    severity: finding.severity,
    status: finding.status,
  };
  const text = JSON.stringify(item);
  if (judgeInput.length > 0 && judgeChars + text.length > MAX_JUDGE_INPUT_CHARS) {
    break;
  }
  judgeInput.push(item);
  judgeChars += text.length;
}
const judgeInputCapped = judgeInput.length < checked.length;
const judgeResult = await judge.ask<JudgeFinding[]>(
  `去重并排序这些已复核发现,返回对象只保留 key:\n${JSON.stringify(judgeInput)}`,
);
const judgeItems = Array.isArray(judgeResult) ? judgeResult : [];
const checkedByKey = new Map(checked.map((finding) => [finding.key, finding]));
const rankedKeys: CheckedFinding[] = [];
const seenJudgeKeys = new Set<string>();
for (const item of judgeItems) {
  if (!isRecord(item) || typeof item.key !== "string") {
    continue;
  }
  const trusted = checkedByKey.get(item.key);
  if (trusted === undefined || seenJudgeKeys.has(trusted.key)) {
    continue;
  }
  seenJudgeKeys.add(trusted.key);
  rankedKeys.push(trusted);
}
const judgeInputKeys = new Set(judgeInput.map((finding) => finding.key));
const judgeNotes: string[] = [];
let ranked: CheckedFinding[] = checked;
if (judgeInputCapped) {
  judgeNotes.push(`评审长输入超过上限,只送入 ${judgeInput.length}/${checked.length} 条;其余按复核顺序参与汇总`);
}
if (rankedKeys.length > 0) {
  // Only findings never sent to the judge are appended back. A key that was
  // sent but not returned is the judge's deliberate merge, not lost work.
  const unsent = checked.filter(
    (finding) => !judgeInputKeys.has(finding.key) && !seenJudgeKeys.has(finding.key),
  );
  ranked = rankedKeys.concat(unsent);
  const omitted = judgeInput.length - rankedKeys.length;
  if (omitted > 0) {
    judgeNotes.push(`评审长合并/丢弃 ${omitted} 条已复核发现`);
  }
  if (unsent.length > 0) {
    judgeNotes.push(`评审长输入未覆盖 ${unsent.length} 条,按复核顺序追加`);
  }
} else if (checked.length > 0) {
  judgeNotes.push("评审长未返回可解析的 key 列表,按复核顺序输出全部发现");
}

phase("全局审查:跨批次模式");
const globalReviewer = agent(
  "全局评审员",
  {
    system: "你负责跨批次模式审查:同一逻辑在多处重复、各批次对同一概念处理不一致、分层/依赖违规、被批次切碎的关联问题。最多新增 5 条发现,必须带证据;findings.repo 必须填具体仓库名,where 用相对仓库根目录的路径;不要重复已有发现。不要编辑任何文件。",
    /* @model:global */
  },
);
const mapBudget = Math.max(120, Math.floor(6000 / Math.max(1, scanResults.length)));
const mapsTextRaw = scanResults
  .map((scan) => `### ${scan.repo.name}\n${clip(scan.plan.map, mapBudget)}`)
  .join("\n\n");
const mapsText =
  mapsTextRaw.length > 6000
    ? `${clip(mapsTextRaw, 6000)}\n…(仓库地图超出总预算,后段已截断)`
    : mapsTextRaw;
const globalResult = await globalReviewer.ask<GlobalReview>(
  `仓库地图(findings.repo 必须使用这里的仓库名):\n${mapsText}\n\n已复核发现:\n${clip(JSON.stringify(ranked.map((finding) => ({ repo: finding.repo, where: finding.where, problem: finding.problem, evidence: clip(finding.evidence, 200), severity: finding.severity, status: finding.status }))), 4000)}`,
);

const globalFindings = Array.isArray(globalResult.findings) ? globalResult.findings : [];
const globalNotes = Array.isArray(globalResult.notes) ? globalResult.notes : [];
const repoDirByName = new Map(scanResults.map((scan) => [scan.repo.name, scan.repo.dir]));
const globalCheckedInput: Finding[] = [];
const globalDropNotes: string[] = [];
globalFindings.slice(0, 5).forEach((finding, index) => {
  const rawRepo = isRecord(finding) ? finding.repo : undefined;
  const repo = typeof rawRepo === "string" ? rawRepo.trim() : "";
  const dir = repoDirByName.get(repo);
  if (dir === undefined) {
    globalDropNotes.push(`全局发现 ${index + 1} 未填有效仓库名(${repo || "空"}),未复核`);
    return;
  }
  const normalized = normalizeFinding(finding, globalDropNotes);
  if (normalized === null) {
    return;
  }
  if (normalized.repro !== undefined) {
    globalDropNotes.push(`全局发现 ${index + 1} 附带的复现规格不执行(v1 不支持全局发现的运行复现)`);
  }
  // 全局发现不参与运行时复现:提示词不要求脚本,也不给 repo 之外的定位。
  globalCheckedInput.push({
    dimension: normalized.dimension,
    where: normalized.where,
    problem: normalized.problem,
    evidence: normalized.evidence,
    severity: normalized.severity,
    fix: normalized.fix,
    repo,
    dir,
  });
});

phase("复核:确定性复现跨批次发现的证据");
const globalGroundings = await Promise.all(
  globalCheckedInput.map((finding) => groundFinding(finding)),
);
const globalChecked: CheckedFinding[] = globalCheckedInput.map((finding, index) => {
  const grounding = globalGroundings[index];
  return {
    ...finding,
    key: `g${index + 1}`,
    status: grounding.holds ? "verified" : "unconfirmed",
    note: clip(oneLine(grounding.reason), 300),
  };
});

// 全局新增的发现与常规发现一起合并去重,不预留也不截断:去重后全部进报告。
const rankedForMerge = ranked
  .slice()
  .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
const mergedFindings = dedupeFindings([...rankedForMerge, ...globalChecked]);
// 报告不按数量丢:去重后按严重度排序,全部保留。展示上限只影响正文与返回值里逐条
// 列出的条数,超出的写进 notCovered 说明,不会被静默截断。
const finalFindings: CheckedFinding[] = mergedFindings
  .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
const finalDropCount = ranked.length + globalChecked.length - finalFindings.length;
if (finalDropCount > 0) {
  judgeNotes.push(`汇总去重合并 ${finalDropCount} 条;最终保留 ${finalFindings.length} 条`);
}
const reportedFindings = finalFindings.slice(0, MAX_FINDINGS_REPORTED);
const beyondReportLimit = finalFindings.slice(MAX_FINDINGS_REPORTED);
if (beyondReportLimit.length > 0) {
  judgeNotes.push(
    `发现总数 ${finalFindings.length} 超过展示上限 ${MAX_FINDINGS_REPORTED}:${beyondReportLimit.length} 条未逐条列出(按严重度排在后面),不是被丢弃`,
  );
}

/** 复现结论到展示文案;notReproduced 永不说「假阳性」。 */
function reproLabel(result: ReproResult | undefined): string {
  if (result === undefined) {
    return "";
  }
  if (result.outcome === "reproduced") {
    return "成立";
  }
  if (result.outcome === "notReproduced") {
    return "未观察到预期行为";
  }
  if (result.outcome === "error") {
    return "环境错误";
  }
  return "未完成";
}

/** 卡片状态:证据核对状态 + 运行复现结论,两者并列。 */
function statusTextOf(finding: CheckedFinding): string {
  const base = finding.status === "verified" ? "已验证" : "待复核";
  const result = finding.reproResult;
  if (result === undefined) {
    return base;
  }
  return `${base} · 运行复现:${reproLabel(result)}`;
}

/** 同一张卡片两轮上报:先「待运行」,复现完成后用同一 id 原位更新。 */
function reportCard(finding: CheckedFinding, index: number): void {
  report(
    {
      id: `f${index + 1}`,
      severity: finding.severity,
      dimension: finding.dimension,
      repo: clip(finding.repo, 120),
      where: clip(finding.where, 200),
      problem: clip(finding.problem, 400),
      evidence: clip(finding.evidence, 700),
      fix: clip(finding.fix, 400),
      statusText: statusTextOf(finding),
      repro: finding.reproResult === undefined ? "待运行" : clip(finding.reproResult.note, 300),
    },
    "findings",
  );
}

const cardIndex = new Map<CheckedFinding, number>();
reportedFindings.forEach((finding, index) => {
  cardIndex.set(finding, index);
  reportCard(finding, index);
});

const reproNotes: string[] = [];
const withRepro = finalFindings.filter((finding) => finding.repro !== undefined);
const reproJobs = runtimeProbe.ok ? selectReproJobs(finalFindings) : [];
const caps = runtimeProbe.caps;
if (!runtimeProbe.ok || caps === null) {
  reproNotes.push(`运行时复现未运行: ${runtimeProbe.note}`);
  if (withRepro.length > 0) {
    reproNotes.push(`有 ${withRepro.length} 条发现带复现规格,但运行时复现未启用`);
  }
} else {
  if (reproJobs.length > 0) {
    phase("复现:在隔离容器里执行仓库代码");
  }
  if (withRepro.length > reproJobs.length) {
    reproNotes.push(
      `带复现规格的发现 ${withRepro.length} 条,只执行 ${reproJobs.length} 条(上限 ${MAX_REPRO},按严重度;其余需要 high/medium 且证据核对通过)`,
    );
  }
  // 每仓库最多装一次依赖;失败则该仓库的所有复现记 unavailable,绝不降级到 host。
  const runtimeByRepo = new Map<string, RepoRuntime>();
  const jobsByRepo = new Map<string, ReproJob[]>();
  for (const job of reproJobs) {
    const key = `${job.finding.repo}\u0000${job.finding.dir}`;
    const list = jobsByRepo.get(key);
    if (list === undefined) {
      jobsByRepo.set(key, [job]);
    } else {
      list.push(job);
    }
  }
  for (const [key, list] of jobsByRepo) {
    const dir = list[0].finding.dir;
    const target = prepared.find((repo) => repo.dir === dir);
    if (target === undefined) {
      runtimeByRepo.set(key, {
        dir,
        depsVolume: "",
        state: "failed",
        note: "找不到对应的仓库准备记录,运行时复现跳过",
      });
      continue;
    }
    const runtime = await prepareRepoRuntime(target, runtimeProbe);
    if (runtime === null) {
      runtimeByRepo.set(key, {
        dir,
        depsVolume: "",
        state: "failed",
        note: "运行时能力在准备阶段失效,运行时复现跳过",
      });
      continue;
    }
    runtimeByRepo.set(key, runtime);
    if (runtime.state !== "ready" && runtime.note !== "") {
      reproNotes.push(`${list[0].finding.repo}: ${runtime.note}`);
    }
  }
  let reproIndex = 0;
  for (const job of reproJobs) {
    const key = `${job.finding.repo}\u0000${job.finding.dir}`;
    const runtime = runtimeByRepo.get(key);
    if (runtime === undefined || runtime.state === "failed") {
      job.finding.reproResult = {
        outcome: "unavailable",
        dockerExitCode: -1,
        verdict: null,
        stage: "",
        note: runtime === undefined ? "运行时复现未准备" : runtime.note,
        stdoutTail: "",
        stderrTail: "",
      };
    } else {
      job.finding.reproResult = await runRepro(job, runtime, caps, reproIndex);
      reproIndex += 1;
      if (job.finding.reproResult.outcome === "error") {
        reproNotes.push(
          `${job.finding.repo}/${job.finding.where}: 运行时复现环境错误: ${clip(job.finding.reproResult.note, 160)}`,
        );
      }
    }
    const index = cardIndex.get(job.finding);
    if (index !== undefined) {
      reportCard(job.finding, index);
    }
  }
}
const reproCounts = { reproduced: 0, notReproduced: 0, unavailable: 0, error: 0 };
for (const finding of finalFindings) {
  const result = finding.reproResult;
  if (result !== undefined) {
    reproCounts[result.outcome] += 1;
  }
}

const high = finalFindings.filter((finding) => finding.severity === "high").length;
const unresolved = finalFindings.filter((finding) => finding.status === "unconfirmed").length;
const selectorKindCount = (kind: string): number =>
  scanResults.reduce(
    (sum, scan) => sum + scan.runs.filter((run) => run.kind === kind).length,
    0,
  );
const totalSignals = scanResults.reduce((sum, scan) => sum + scan.signals.length, 0);
const signalFiles = scanResults.reduce(
  (sum, scan) => sum + new Set(scan.signals.map((signal) => signal.path)).size,
    0,
);
const reusedCount = executions.filter((execution) => execution.reused).length;
const deadCount = scanResults.reduce(
  (sum, scan) => sum + scan.runs.filter(isDeadRule).length,
  0,
);
const sampledCount = scanResults.reduce(
  (sum, scan) => sum + scan.runs.filter((run) => run.kind !== "scope" && run.sampled < run.hits).length,
  0,
);
const toolKinds: string[] = [];
if (scanResults.some((scan) => scan.runs.some((run) => run.kind === "tool"))) {
  toolKinds.push("knip/jscpd");
}
if (scanResults.some((scan) => scan.graph !== null && scan.graph.note === "")) {
  toolKinds.push("madge");
}
if (scanResults.some((scan) => scan.runs.some((run) => run.kind === "ast"))) {
  toolKinds.push("ast-grep");
}
const toolSummary = toolKinds.length > 0 ? toolKinds.join("、") : "未运行外部工具";
const toolVersions: string[] = [];
if (toolKinds.includes("knip/jscpd")) {
  toolVersions.push(KNIP_PKG, JSCPD_PKG);
}
if (toolKinds.includes("madge")) {
  toolVersions.push(MADGE_PKG);
}
if (toolKinds.includes("ast-grep")) {
  toolVersions.push(AST_GREP_PKG);
}

const selectorRows = scanResults
  .flatMap((scan) =>
    scan.runs
      .map((run) => {
        const sampling = run.kind !== "scope" && run.sampled < run.hits
          ? `,采样 ${run.sampled}/${run.hits}`
          : "";
        const note = run.note !== "" ? ` — ${clip(oneLine(run.note), 200)}` : "";
        return `- ${clip(oneLine(scan.repo.name), 120)} · ${run.id} (${run.kind}/${run.dimension}):命中 ${run.hits},文件 ${run.files}${sampling}${note}`;
      }),
  )
  .join("\n");

const rows = reportedFindings
  .map(
    (finding) =>
      `- **${finding.severity}** · ${clip(oneLine(finding.repo), 120)} · ${clip(oneLine(finding.where), 200)} · ${finding.dimension} — ${clip(oneLine(finding.problem), 400)}(${finding.status === "verified" ? "已验证" : "待复核"}${finding.reproResult === undefined ? "" : ` · 运行复现:${reproLabel(finding.reproResult)}`})`,
  )
  .join("\n");

const notCovered: string[] = [];
for (const repo of prepared) {
  if (!repo.ok) {
    notCovered.push(`${repo.name}: ${repo.note}`);
  }
}
for (const execution of executions) {
  for (const note of execution.caps.notes) {
    notCovered.push(`${execution.repo.name}: ${note}`);
  }
}
for (const note of batchNotes) {
  notCovered.push(note);
}
for (const note of batchCoverage) {
  notCovered.push(note);
}
for (const note of persistenceNotes) {
  if (note !== "") {
    notCovered.push(note);
  }
}
for (const note of judgeNotes) {
  notCovered.push(note);
}
for (const note of overReportedNotes) {
  notCovered.push(note);
}
for (const note of findingNotes) {
  notCovered.push(note);
}
for (const note of confirmNotes) {
  notCovered.push(note);
}
for (const note of reproNotes) {
  notCovered.push(note);
}
for (const note of globalDropNotes) {
  notCovered.push(note);
}
if (!runtimeProbe.ok) {
  notCovered.push("性能维度未运行基准测试:仅接受复杂度论证或静态证据");
}
const notCoveredLines = notCovered.map((note) => oneLine(note));
const globalObservationLines = globalNotes
  .map((note) => clip(oneLine(note), 300))
  .filter((note) => note !== "");

let reportContent = [
  "# 跨仓库扫描报告(选择器 v2)",
  "",
  `共 ${finalFindings.length} 条发现:high ${high} 条,待复核 ${unresolved} 条。`,
  "",
  `选择器 ${scanResults.reduce((sum, scan) => sum + scan.runs.length, 0)} 条(scope ${selectorKindCount("scope")} / grep ${selectorKindCount("grep")} / ast ${selectorKindCount("ast")} / graph ${selectorKindCount("graph")} / tool ${selectorKindCount("tool")});${totalSignals} 条信号覆盖 ${signalFiles} 个文件;${deadCount} 条死规则,${sampledCount} 条按预算采样。`,
  "",
  "## 发现",
  "",
  rows.length > 0 ? rows : "未发现可报告的问题。",
  "",
  "## 选择器执行",
  "",
  selectorRows.length > 0 ? selectorRows : "没有可记录的选择器。",
  "",
  ...(globalObservationLines.length > 0
    ? ["## 全局观察", "", ...globalObservationLines.map((note) => `- ${note}`), ""]
    : []),
  "## 运行复现",
  "",
  runtimeProbe.ok
    ? `已启用:${caps === null ? "offline" : caps.mode} 安装;执行 ${reproCounts.reproduced + reproCounts.notReproduced + reproCounts.unavailable + reproCounts.error} 条,成立 ${reproCounts.reproduced} 条,未观察到预期行为 ${reproCounts.notReproduced} 条,未完成 ${reproCounts.unavailable + reproCounts.error} 条。`
    : `未运行:${runtimeProbe.note}`,
  ...(runtimeProbe.ok
    ? [
        `审计目录:${caps === null ? "(未记录)" : caps.auditDir}(含脚本全文、容器 argv、脱敏输出;本扫描最多执行 ${MAX_REPRO} 段模型生成的脚本)`,
        caps !== null && caps.mode === "online"
          ? "网络:安装容器使用 bridge,可访问任意主机(runtimeVerifyOnline=true);manifest 检查只是纵深防御"
          : "网络:安装容器与复现容器均 network=none(离线安装,依赖来自本机 npm 缓存)",
        "复现结论是脚本自报:脚本必须 require 仓库代码,二者同进程;结论不等于独立证明,永不用于自动 dismiss。",
      ]
    : []),
  "",
  "## 未覆盖",
  "",
  notCoveredLines.length > 0 ? notCoveredLines.map((note) => `- ${note}`).join("\n") : "- 无",
].join("\n");

if (reportContent.length > MAX_REPORT_CHARS) {
  reportContent =
    reportContent.slice(0, MAX_REPORT_CHARS) +
    "\n\n…报告过长,已截断;完整未覆盖清单见 notCovered。";
  notCoveredLines.push(`报告正文超过 ${MAX_REPORT_CHARS} 字符,已截断`);
}

await artifact.markdown(
  "report",
  reportContent,
  { title: "跨仓库扫描报告", description: "全库选择器信号的分片复核结果", primary: true },
);

const result: WorkflowReport = {
  conclusion: `扫描完成:${finalFindings.length} 条发现,其中 high ${high} 条、待复核 ${unresolved} 条;覆盖 ${ready.length} 个仓库、${totalSignals} 条信号、${batchJobs.length} 个批次。${runtimeProbe.ok ? `运行期复现执行 ${reproCounts.reproduced + reproCounts.notReproduced + reproCounts.unavailable + reproCounts.error} 条,其中成立 ${reproCounts.reproduced} 条(脚本自报,不是独立证明)。` : ""}`,
  findings: reportedFindings.map((finding) => {
    const entry: ReportFinding = {
      where: clip(oneLine(`${finding.repo}/${finding.where}`), 240),
      what: clip(oneLine(finding.problem), 400),
      evidence: clip(finding.evidence, 800),
      status: finding.status,
      severity: finding.severity,
    };
    if (finding.reproResult !== undefined) {
      entry.repro = `${reproLabel(finding.reproResult)}: ${clip(finding.reproResult.note, 200)}`;
    }
    return entry;
  }),
  verified: [
    `${ready.length} 个仓库执行了全库选择器(${reusedCount} 个仓库复用历史规则)`,
    `${totalSignals} 条信号覆盖 ${signalFiles} 个文件,分入 ${batchJobs.length} 个批次(每文件最多展示 ${MAX_SIGNALS_PER_FILE} 条信号)`,
    `外部工具:${toolSummary}${toolVersions.length > 0 ? `;${toolVersions.join(" / ")}` : ""}`,
    `${groundedCount}/${checked.length} 条发现的证据通过了确定性复现(文件、行号、引用原文);未通过的标 unconfirmed 并注明原因`,
    "复核不调用模型:用文件系统与文本比对复现证据,不验证「这段代码是不是有意设计」",
    runtimeProbe.ok
      ? `运行期复现(${caps === null ? "offline" : caps.mode} 安装):执行 ${reproCounts.reproduced + reproCounts.notReproduced + reproCounts.unavailable + reproCounts.error} 条,成立 ${reproCounts.reproduced} / 未观察到预期行为 ${reproCounts.notReproduced} / 未完成 ${reproCounts.unavailable + reproCounts.error};复现容器 network=none、只读、非 root${caps !== null && caps.mode === "online" ? ";安装容器 network=bridge,可访问任意主机(runtimeVerifyOnline=true)" : ";安装容器同样 network=none"};结论是脚本自报,不是独立证明,永不用于自动裁决`
      : `运行期复现未运行: ${runtimeProbe.note}`,
    ...globalObservationLines.map((note) => `全局观察: ${note}`),
  ],
  notCovered: notCoveredLines,
};
return result;
