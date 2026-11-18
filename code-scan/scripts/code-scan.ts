/* zcode-workflow
name: code-scan
description: 跨仓库全库扫描(Devin 式查询分片):Plan(全库 selectors)→ 全局执行 → Shard(命中项批次)→ Map → Confirm → Reduce
args:
  - name: repos
    type: json
    description: 仓库列表:[{name,url,ref}] 或 [{name,path}] 或 ["owner/repo"];省略则扫当前工作区
  - name: goal
    type: string
    default: 全面扫描:质量 / 冗余 / 性能
  - name: maxFilesPerBatch
    type: number
    default: 8
  - name: maxBatchesPerRepo
    type: number
    default: 4
*/

interface RepoSpec {
  /** 仓库名,用于报告与看板。 */
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
  /** 工作区内的扫描目录。 */
  dir: string;
  /** 是否准备成功。 */
  ok: boolean;
  /** 失败原因或准备说明。 */
  note: string;
}

interface Selector {
  /** 查询类型:glob 路径、grep 模式、tool 工具。 */
  kind: "glob" | "grep" | "tool";
  /** glob 时是路径模式(如 "src/**/*.ts");grep 时是正则;tool 时是工具名(knip|jscpd|madge)。 */
  query: string;
  /** grep 时的路径过滤(如 "src/**");其他类型填空字符串。 */
  scope: string;
  /** 这条选择器要回答的问题,给复核员参考。 */
  intent: string;
  /** 维度侧重。 */
  dimension: "quality" | "dead-code" | "perf";
}

interface RepoPlan {
  /** 作用于全库的确定性选择规则(不是文件清单)。 */
  selectors: Selector[];
  /** 仓库地图:模块树、各模块职责、入口、关键依赖边,供批次复核时参考。 */
  map: string;
  /** 有意跳过的目录与理由。 */
  skipped: string[];
}

interface ToolHit {
  /** 相对仓库根目录的路径,适用时带行号(如 "src/a.ts:42")。 */
  path: string;
  /** 行号;无行号时为 0。 */
  line: number;
  /** 工具名:knip / jscpd / madge / 其他。 */
  tool: string;
  /** 维度:死代码、质量或性能。 */
  dimension: "dead-code" | "quality" | "perf";
  /** 工具输出片段。 */
  evidence: string;
}

interface ToolReport {
  /** 工具候选,按影响排序。 */
  hits: ToolHit[];
  /** 工具缺失或运行失败的原因。 */
  notCovered: string[];
}

interface MatchItem {
  /** 相对仓库根目录的路径。 */
  path: string;
  /** 行号;非行级命中时为 0。 */
  line: number;
  /** 命中的代码片段或工具证据。 */
  excerpt: string;
  /** 产生这条命中的选择器意图。 */
  intent: string;
  /** 维度。 */
  dimension: "quality" | "dead-code" | "perf";
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
}

interface Finding extends RawFinding {
  /** 发现所属仓库名。 */
  repo: string;
  /** 该仓库的扫描目录,供复核员定位。 */
  dir: string;
}

interface BatchReport {
  /** 该批次的发现,按影响排序。 */
  findings: RawFinding[];
  /** 该批次没覆盖到的部分及原因。 */
  notCovered: string[];
}

interface Confirmation {
  /** 问题是否真实存在;只有亲自复现成功才为 true。 */
  holds: boolean;
  /** 一句话:你实际检查了什么。 */
  reason: string;
}

interface CheckedFinding extends Finding {
  /** verified 表示独立复核员复现成功;unconfirmed 表示未能复现或未尝试。 */
  status: "verified" | "unconfirmed";
  /** 复核结论一句话。 */
  note: string;
}

interface GlobalReview {
  /** 跨批次模式下新增的发现,最多 5 条,必须带证据。 */
  findings: RawFinding[];
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

function toRepoSpecs(raw: unknown): RepoSpec[] {
  const specs: RepoSpec[] = [];
  if (!Array.isArray(raw)) {
    return specs;
  }
  for (const item of raw) {
    if (typeof item === "string") {
      const name = item.replace(/^.*[\/:]/g, "").replace(/\.git$/g, "");
      specs.push({ name: name !== "" ? name : item, url: item, ref: "", localPath: "" });
      continue;
    }
    if (item !== null && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name : "";
      const url = typeof rec.url === "string" ? rec.url : "";
      const ref = typeof rec.ref === "string" ? rec.ref : "";
      const localPath = typeof rec.path === "string" ? rec.path : "";
      if (name !== "" && (url !== "" || localPath !== "")) {
        specs.push({ name, url, ref, localPath });
      }
    }
  }
  return specs;
}

function slug(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned !== "" ? cleaned : "repo";
}

function relToRepo(repoDir: string, path: string): string {
  const prefix = `${repoDir}/`;
  if (path.startsWith(prefix)) {
    return path.slice(prefix.length);
  }
  return path;
}

function withRepo(repoDir: string, pattern: string): string {
  const trimmed = pattern.replace(/^\.?\//, "");
  if (repoDir === ".") {
    return trimmed;
  }
  return `${repoDir}/${trimmed}`;
}

function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max) + "…";
}

interface PathGroup {
  /** 相对仓库根目录的路径。 */
  path: string;
  /** 该路径上的命中项。 */
  items: MatchItem[];
}

function groupByPath(items: MatchItem[]): PathGroup[] {
  const groups: PathGroup[] = [];
  for (const item of items) {
    let found: PathGroup | undefined = undefined;
    for (const group of groups) {
      if (group.path === item.path) {
        found = group;
        break;
      }
    }
    if (found !== undefined) {
      found.items.push(item);
    } else {
      groups.push({ path: item.path, items: [item] });
    }
  }
  groups.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return groups;
}

function packBatches(groups: PathGroup[], maxFiles: number, maxBatches: number): { batches: PathGroup[][]; overflow: PathGroup[] } {
  const all: PathGroup[][] = [];
  for (let i = 0; i < groups.length; i += maxFiles) {
    all.push(groups.slice(i, i + maxFiles));
  }
  return { batches: all.slice(0, maxBatches), overflow: groups.slice(maxFiles * maxBatches) };
}

const goal = typeof args.goal === "string" ? args.goal : "全面扫描:质量 / 冗余 / 性能";
const maxFilesPerBatch = typeof args.maxFilesPerBatch === "number" ? Math.max(3, Math.min(20, args.maxFilesPerBatch)) : 8;
const maxBatchesPerRepo = typeof args.maxBatchesPerRepo === "number" ? Math.max(1, Math.min(8, args.maxBatchesPerRepo)) : 4;
const specs = toRepoSpecs(args.repos);
const targets: RepoSpec[] =
  specs.length > 0 ? specs : [{ name: "当前工作区", url: "", ref: "", localPath: "." }];

phase("准备:获取目标仓库");
const prepared: PreparedRepo[] = [];
for (const spec of targets) {
  if (spec.localPath !== "") {
    prepared.push({ name: spec.name, dir: spec.localPath, ok: true, note: "使用工作区内目录" });
    continue;
  }
  if (spec.url === "") {
    prepared.push({ name: spec.name, dir: "", ok: false, note: "缺少 url 或 path" });
    continue;
  }
  const dir = `.code-scan/repos/${slug(spec.name)}`;
  const clone = await world.run("git", ["clone", "--depth", "1", spec.url, dir], { timeoutMs: 600000 });
  if (clone.exitCode !== 0) {
    prepared.push({ name: spec.name, dir, ok: false, note: `clone 失败: ${clip(clone.stderr, 300)}` });
    continue;
  }
  if (spec.ref !== "") {
    const fetch = await world.run("git", ["-C", dir, "fetch", "--depth", "1", "origin", spec.ref], { timeoutMs: 600000 });
    if (fetch.exitCode !== 0) {
      prepared.push({ name: spec.name, dir, ok: false, note: `fetch ${spec.ref} 失败: ${clip(fetch.stderr, 300)}` });
      continue;
    }
    const checkout = await world.run("git", ["-C", dir, "checkout", "FETCH_HEAD"]);
    if (checkout.exitCode !== 0) {
      prepared.push({ name: spec.name, dir, ok: false, note: `checkout 失败: ${clip(checkout.stderr, 300)}` });
      continue;
    }
  }
  prepared.push({ name: spec.name, dir, ok: true, note: "浅克隆完成" });
}
const ready = prepared.filter((repo) => repo.ok);
log(`目标仓库 ${targets.length} 个,准备成功 ${ready.length} 个`);

phase("规划:为每个仓库写全库选择规则");
const plans = await Promise.all(
  ready.map(async (repo, index) => {
    const plan = await agent(
      `规划员-${index + 1}-${repo.name}`,
      "你是代码库扫描的规划者。研究给定仓库目录,写出作用于全库的确定性选择规则(selectors):glob 路径规则、grep 模式规则、工具规则(knip/jscpd/madge),而不是文件清单。同时产出精简的仓库地图(模块树、各模块职责、入口文件、关键依赖边)。不要编辑任何文件;难以判断时写进 skipped。",
    ).ask<RepoPlan>(
      `研究仓库目录 ${repo.dir}(仓库名 ${repo.name})。扫描侧重:${goal}。\n返回 selectors:每条 {kind: glob|grep|tool, query, scope, intent, dimension}。glob 的 query 用 "src/**/*.ts" 这类路径模式;grep 的 query 是正则,scope 是路径过滤(可空);冗余维度至少一条 tool 规则(knip),重复代码用 jscpd。还要返回 map(≤1500 字的仓库地图)与 skipped。不要返回文件清单。`,
    );
    return { repo, plan };
  }),
);

phase("执行:工具候选与全库查询");
const toolReports = await Promise.all(
  ready.map(async (repo, index) => {
    const report = await agent(
      `工具执行员-${index + 1}-${repo.name}`,
      "你是工具执行员。在给定仓库目录内尝试运行静态分析工具,解析输出为候选清单。不要编辑任何文件;工具不可用或输出无法解析时如实写进 notCovered,禁止编造。",
    ).ask<ToolReport>(
      `在仓库目录 ${repo.dir} 内执行(必要时先 cd 到该目录):\n1) npx --yes knip --reporter json(死代码/未使用导出)\n2) npx --yes jscpd --reporter json(重复代码)\n3) npx --yes madge --circular --json(仅 JS/TS,循环依赖)\n把每项候选写成 {path: 相对仓库根目录的路径, line: 行号(无则 0), tool: 工具名, dimension: dead-code|quality|perf, evidence: 输出片段}。返回 hits 与 notCovered。`,
    );
    return { repo, report };
  }),
);

interface RepoScan {
  /** 仓库。 */
  repo: PreparedRepo;
  /** 规划结果。 */
  plan: RepoPlan;
  /** 工具候选。 */
  tool: ToolReport;
  /** 归一后的命中项。 */
  items: MatchItem[];
  /** 查询覆盖说明。 */
  coverage: string[];
}

const scans: RepoScan[] = [];
for (let index = 0; index < ready.length; index += 1) {
  const repo = ready[index];
  const plan = plans[index].plan;
  const tool = toolReports[index].report;
  const items: MatchItem[] = [];
  const coverage: string[] = [];

  for (const selector of plan.selectors) {
    if (selector.kind === "glob") {
      try {
        const paths = await files.glob(withRepo(repo.dir, selector.query));
        for (const path of paths) {
          items.push({ path: relToRepo(repo.dir, path), line: 0, excerpt: "", intent: selector.intent, dimension: selector.dimension });
        }
      } catch {
        coverage.push(`${selector.intent}: glob 命中超过 2000 文件或模式无效,未执行(${selector.query})`);
      }
      continue;
    }
    if (selector.kind === "grep") {
      try {
        const scopePattern =
          selector.scope !== ""
            ? withRepo(repo.dir, selector.scope)
            : repo.dir === "."
              ? "**"
              : `${repo.dir}/**`;
        const matches = await files.grep(selector.query, scopePattern);
        for (const match of matches) {
          items.push({ path: relToRepo(repo.dir, match.path), line: match.line, excerpt: clip(match.text, 200), intent: selector.intent, dimension: selector.dimension });
        }
      } catch {
        coverage.push(`${selector.intent}: grep 命中超过 2000 行或模式无效,未执行(${selector.query})`);
      }
      continue;
    }
    // tool 规则由工具执行员统一产出,这里只记录意图
  }

  for (const hit of tool.hits) {
    const relPath = relToRepo(repo.dir, hit.path);
    items.push({ path: relPath, line: hit.line, excerpt: clip(`${hit.tool}: ${hit.evidence}`, 200), intent: `工具候选(${hit.tool})`, dimension: hit.dimension });
  }

  scans.push({ repo, plan, tool, items, coverage });
}
log(`全库查询完成,共 ${scans.map((scan) => scan.items.length).reduce((a, b) => a + b, 0)} 条命中`);

interface BatchJob {
  /** 仓库。 */
  repo: PreparedRepo;
  /** 批次序号。 */
  index: number;
  /** 本批次覆盖的路径组。 */
  groups: PathGroup[];
  /** 仓库地图。 */
  map: string;
}

const batchJobs: BatchJob[] = [];
const batchNotes: string[] = [];
for (const scan of scans) {
  const grouped = groupByPath(scan.items);
  const packed = packBatches(grouped, maxFilesPerBatch, maxBatchesPerRepo);
  if (packed.overflow.length > 0) {
    batchNotes.push(`${scan.repo.name}: 超出批次上限未复核 ${packed.overflow.length} 个文件`);
  }
  packed.batches.forEach((groups, index) => {
    batchJobs.push({ repo: scan.repo, index, groups, map: scan.plan.map });
  });
  scan.plan.skipped.forEach((note) => batchNotes.push(`${scan.repo.name}: ${note}`));
  scan.tool.notCovered.forEach((note) => batchNotes.push(`${scan.repo.name}: ${note}`));
  scan.coverage.forEach((note) => batchNotes.push(`${scan.repo.name}: ${note}`));
}
log(`共 ${batchJobs.length} 个批次`);

phase("扫描:复核命中批次");
const batched = await Promise.all(
  batchJobs.map(async (job) => {
    const hits = job.groups
      .map((group) => `- ${group.path}: ${group.items.map((item) => `${item.intent}${item.line > 0 ? ` @${item.line}` : ""}${item.excerpt !== "" ? ` — ${item.excerpt}` : ""}`).join(" | ")}`)
      .join("\n");
    const report = await agent(
      `审查员-${job.repo.name}-${job.index + 1}`,
      "你是资深代码评审。输入是全库选择器命中项与工具候选;逐条复核它们是否真是问题,可在仓库目录内 Grep 全局补充上下文,不要只看命中文件。只报你确信的问题;证据必须来自你实际读过的行或实际运行过的命令。不要编辑任何文件。每批次最多 12 条发现,命中项之外最多补充 3 条。",
    ).ask<BatchReport>(
      `仓库 ${job.repo.name}(目录 ${job.repo.dir}),批次 ${job.index + 1}。侧重:${goal}。\n仓库地图:\n${clip(job.map, 1500)}\n\n全库查询命中与工具候选:\n${hits}\n\n维度:质量、冗余(死代码/重复实现/未使用导出)、性能(必须给复杂度论证或基准数据)。where 用相对仓库根目录的路径,带行号。`,
    );
    return { job, report };
  }),
);
const findings: Finding[] = batched
  .map(({ job, report }) =>
    report.findings.map((finding) => ({ repo: job.repo.name, dir: job.repo.dir, ...finding })),
  )
  .flat();
const batchCoverage: string[] = batched
  .map(({ job, report }) => report.notCovered.map((note) => `${job.repo.name}#${job.index + 1}: ${note}`))
  .flat();
log(`收集到 ${findings.length} 条待复核发现`);

phase("复核:逐条确认");
const confirmations = await Promise.all(
  findings.map((finding, i) =>
    agent(
      `复核员-${i + 1}`,
      "你是独立复核员。只凭给出的证据亲自复现:读引用的文件与行,必要时运行验证命令;不要编辑任何文件。只有你亲自确认问题存在时才把 holds 置为 true;不能复现就置 false 并说明原因。",
    ).ask<Confirmation>(
      `仓库 ${finding.repo}(目录 ${finding.dir})。复核这条发现,判断它是否真实存在:\n${JSON.stringify(finding)}`,
    ),
  ),
);
const checked: CheckedFinding[] = findings.map((finding, i) => ({
  ...finding,
  status: confirmations[i].holds ? "verified" : "unconfirmed",
  note: confirmations[i].reason,
}));

phase("汇总:去重排序");
const judge = agent(
  "评审长",
  "你统一所有发现的评定口径:合并同一仓库同一位置同一问题的重复项,保留证据更强的一条;按严重度与影响面排序,最多保留 60 条。不要编辑任何文件。",
);
const ranked = await judge.ask<CheckedFinding[]>(`去重并排序这些发现:\n${JSON.stringify(checked)}`);

phase("全局审查:跨批次模式");
const globalReviewer = agent(
  "全局评审员",
  "你负责跨批次模式审查:同一逻辑在多处重复、各批次对同一概念处理不一致、分层/依赖违规、被批次切碎的关联问题。最多新增 5 条发现,必须带证据;不要重复已有发现。不要编辑任何文件。",
);
const globalResult = await globalReviewer.ask<GlobalReview>(
  `仓库地图与已确认发现:\n${clip(JSON.stringify(scans.map((scan) => ({ repo: scan.repo.name, map: scan.plan.map }))), 2000)}\n\n发现:\n${clip(JSON.stringify(ranked.map((finding) => ({ repo: finding.repo, where: finding.where, problem: finding.problem, evidence: clip(finding.evidence, 200), severity: finding.severity, status: finding.status }))), 4000)}`,
);

// 全局评审的发现可能跨仓库,统一标为"跨仓库",复核时按位置在 .code-scan/repos/ 下确认
const globalCheckedInput: Finding[] = globalResult.findings.map((finding) => ({
  ...finding,
  repo: "跨仓库",
  dir: "",
}));

phase("复核:全局新发现");
const globalConfirmations = await Promise.all(
  globalCheckedInput.map((finding, i) =>
    agent(
      `复核员-全局-${i + 1}`,
      "你是独立复核员。只凭给出的证据亲自复现;读到对应仓库目录(可能在 .code-scan/repos/ 下)确认;不要编辑任何文件。只有亲自确认问题存在时才把 holds 置为 true,否则置 false 并说明原因。",
    ).ask<Confirmation>(`复核这条跨批次发现,判断它是否真实存在:\n${JSON.stringify(finding)}`),
  ),
);
const globalChecked: CheckedFinding[] = globalCheckedInput.map((finding, i) => ({
  ...finding,
  status: globalConfirmations[i].holds ? "verified" : "unconfirmed",
  note: globalConfirmations[i].reason,
}));

const finalFindings: CheckedFinding[] = ranked
  .concat(globalChecked)
  .slice(0, 60);

finalFindings.forEach((finding, i) => {
  report(
    {
      id: `f${i + 1}`,
      severity: finding.severity,
      dimension: finding.dimension,
      repo: finding.repo,
      where: finding.where,
      problem: finding.problem,
      evidence: finding.evidence,
      fix: finding.fix,
      statusText: finding.status === "verified" ? "已验证" : "待复核",
    },
    "findings",
  );
});

const high = finalFindings.filter((finding) => finding.severity === "high").length;
const unresolved = finalFindings.filter((finding) => finding.status === "unconfirmed").length;
const rows = finalFindings
  .map(
    (finding) =>
      `- **${finding.severity}** · ${finding.repo} · ${finding.where} · ${finding.dimension} — ${finding.problem}(${finding.status === "verified" ? "已验证" : "待复核"})`,
  )
  .join("\n");

await artifact.markdown(
  "report",
  [
    "# 跨仓库扫描报告(查询分片)",
    "",
    `共 ${finalFindings.length} 条发现:high ${high} 条,待复核 ${unresolved} 条。`,
    "",
    rows.length > 0 ? rows : "未发现可报告的问题。",
    "",
    "## 未覆盖",
    batchNotes.map((note) => `- ${note}`).join("\n"),
    batchCoverage.map((note) => `- ${note}`).join("\n"),
    globalResult.notes.map((note) => `- 全局观察: ${note}`).join("\n"),
    "- 性能维度未运行基准测试:仅接受复杂度论证或静态证据。",
  ].join("\n"),
  { title: "跨仓库扫描报告", description: "全库选择器命中的复核结果", primary: true },
);

const failed = prepared.filter((repo) => !repo.ok).map((repo) => `${repo.name}: ${repo.note}`);
const result: WorkflowReport = {
  conclusion: `扫描完成:${finalFindings.length} 条发现,其中 high ${high} 条、待复核 ${unresolved} 条;覆盖 ${ready.length} 个仓库、${batchJobs.length} 个批次。`,
  findings: finalFindings.map((finding) => ({
    where: `${finding.repo}/${finding.where}`,
    what: finding.problem,
    evidence: finding.evidence,
    status: finding.status,
    severity: finding.severity,
  })),
  verified: [
    `${ready.length} 个仓库由规划员写出全库选择规则(selectors)`,
    `${scans.map((scan) => scan.items.length).reduce((a, b) => a + b, 0)} 条选择器/工具命中被分入 ${batchJobs.length} 个批次复核`,
    `每条发现都经过了独立复核(未能复现的已标注 unconfirmed)`,
  ],
  notCovered: [
    ...failed,
    ...batchNotes,
    ...batchCoverage,
    ...globalResult.notes.map((note) => `全局观察: ${note}`),
    "性能维度未运行基准测试:仅接受复杂度论证或静态证据",
  ],
};
return result;
