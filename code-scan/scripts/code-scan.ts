/* zcode-workflow
name: code-scan
description: 跨仓库全库扫描:Plan→Shard→Map→Reduce→Confirm,Devin Agentic MapReduce 复刻
args:
  - name: repos
    type: json
    description: 仓库列表:[{name,url,ref}] 或 [{name,path}] 或 ["owner/repo"];省略则扫当前工作区
  - name: goal
    type: string
    default: 全面扫描:质量 / 冗余 / 性能
  - name: maxFilesPerShard
    type: number
    default: 12
  - name: maxShardsPerRepo
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

interface RepoPlan {
  /** 选择规则:按什么标准挑选/排除文件,供复核时参考。 */
  selectors: string[];
  /** 要审查的文件,相对仓库根目录,已排除生成代码、vendored、构建产物。 */
  files: string[];
  /** 有意跳过的目录与理由。 */
  skipped: string[];
}

interface RawFinding {
  /** 维度:质量、冗余或性能。 */
  dimension: "quality" | "dead-code" | "perf";
  /** 相对仓库根目录的路径,适用时带行号,如 "src/a.ts:42"。 */
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

interface ShardReport {
  /** 该分片的发现,按影响排序。 */
  findings: RawFinding[];
  /** 该分片没覆盖到的部分及原因。 */
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

function chunkFiles(files: string[], size: number, maxChunks: number): string[][] {
  const sorted = files.slice().sort();
  const chunks: string[][] = [];
  for (let i = 0; i < sorted.length; i += size) {
    chunks.push(sorted.slice(i, i + size));
  }
  return chunks.slice(0, maxChunks);
}

function overflowFiles(files: string[], size: number, maxChunks: number): string[] {
  const sorted = files.slice().sort();
  const start = size * maxChunks;
  return sorted.slice(start);
}

const goal = typeof args.goal === "string" ? args.goal : "全面扫描:质量 / 冗余 / 性能";
const filesPerShard = typeof args.maxFilesPerShard === "number" ? Math.max(4, Math.min(40, args.maxFilesPerShard)) : 12;
const maxShardsPerRepo = typeof args.maxShardsPerRepo === "number" ? Math.max(1, Math.min(8, args.maxShardsPerRepo)) : 4;
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
    prepared.push({ name: spec.name, dir, ok: false, note: `clone 失败: ${clone.stderr.slice(0, 300)}` });
    continue;
  }
  if (spec.ref !== "") {
    const fetch = await world.run("git", ["-C", dir, "fetch", "--depth", "1", "origin", spec.ref], { timeoutMs: 600000 });
    if (fetch.exitCode !== 0) {
      prepared.push({ name: spec.name, dir, ok: false, note: `fetch ${spec.ref} 失败: ${fetch.stderr.slice(0, 300)}` });
      continue;
    }
    const checkout = await world.run("git", ["-C", dir, "checkout", "FETCH_HEAD"]);
    if (checkout.exitCode !== 0) {
      prepared.push({ name: spec.name, dir, ok: false, note: `checkout 失败: ${checkout.stderr.slice(0, 300)}` });
      continue;
    }
  }
  prepared.push({ name: spec.name, dir, ok: true, note: "浅克隆完成" });
}
const ready = prepared.filter((repo) => repo.ok);
log(`目标仓库 ${targets.length} 个,准备成功 ${ready.length} 个`);

phase("规划:为每个仓库生成选择规则与分片");
const planned = await Promise.all(
  ready.map(async (repo) => {
    const plan = await agent(
      `规划员-${repo.name}`,
      "你是代码库扫描的规划者。研究给定仓库目录的结构,产出选择规则(selectors)与要审查的文件清单;排除生成代码、vendored、node_modules/dist/build 等目录;分片名不必产出,脚本会确定性切块。不要编辑任何文件;难以判断时写进 skipped。",
    ).ask<RepoPlan>(
      `研究仓库目录 ${repo.dir}(仓库名 ${repo.name})。扫描侧重:${goal}。\n只返回:selectors(选择/排除规则)、files(相对仓库根目录的要审查文件,最多 200 个,按核心模块优先)、skipped(跳过的目录与理由)。`,
    );
    return { repo, plan };
  }),
);

const shardJobs: { repo: PreparedRepo; index: number; files: string[]; selectors: string[] }[] = [];
const skippedNotes: string[] = [];
for (const item of planned) {
  const chunks = chunkFiles(item.plan.files, filesPerShard, maxShardsPerRepo);
  const overflow = overflowFiles(item.plan.files, filesPerShard, maxShardsPerRepo);
  if (overflow.length > 0) {
    skippedNotes.push(`${item.repo.name}: 超出分片上限未扫描 ${overflow.length} 个文件`);
  }
  chunks.forEach((files, index) => {
    shardJobs.push({ repo: item.repo, index, files, selectors: item.plan.selectors });
  });
  item.plan.skipped.forEach((note) => skippedNotes.push(`${item.repo.name}: ${note}`));
}
log(`共 ${shardJobs.length} 个分片`);

phase("扫描:每个分片并行审查");
const mapped = await Promise.all(
  shardJobs.map(async (job) => {
    const report = await agent(
      `审查员-${job.repo.name}-${job.index + 1}`,
      "你是资深代码评审。只报你确信的问题;先用工具找候选(可在仓库目录尝试 npx knip、npx jscpd,工具缺失就只用代码阅读并在 notCovered 说明);证据必须来自你实际读过的行或实际运行过的命令。不要编辑任何文件。每片最多 12 条发现。",
    ).ask<ShardReport>(
      `仓库 ${job.repo.name}(目录 ${job.repo.dir}),分片 ${job.index + 1}。侧重:${goal}。\n选择规则:${job.selectors.join("; ")}\n审查这些文件(相对仓库根目录):${job.files.join(", ")}\n维度:质量(可读性/边界/一致性)、冗余(死代码/重复实现/未使用导出)、性能(复杂度/N+1/重复 I/O,必须给复杂度论证或基准数据)。where 用相对仓库根目录的路径,带行号。`,
    );
    return { job, report };
  }),
);
const findings: Finding[] = mapped
  .map(({ job, report }) =>
    report.findings.map((finding) => ({ repo: job.repo.name, dir: job.repo.dir, ...finding })),
  )
  .flat();
const shardCoverage: string[] = mapped
  .map(({ job, report }) => report.notCovered.map((note) => `${job.repo.name}#${job.index + 1}: ${note}`))
  .flat();
log(`收集到 ${findings.length} 条待复核发现`);

phase("复核:每条发现独立确认");
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

phase("汇总:去重排序并生成报告");
const judge = agent(
  "评审长",
  "你统一所有发现的评定口径:合并同一仓库同一位置同一问题的重复项,保留证据更强的一条;按严重度与影响面排序,最多保留 60 条。不要编辑任何文件。",
);
const ranked = await judge.ask<CheckedFinding[]>(`去重并排序这些发现:\n${JSON.stringify(checked)}`);

ranked.forEach((finding, i) => {
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

const high = ranked.filter((finding) => finding.severity === "high").length;
const unresolved = ranked.filter((finding) => finding.status === "unconfirmed").length;
const rows = ranked
  .map(
    (finding) =>
      `- **${finding.severity}** · ${finding.repo} · ${finding.where} · ${finding.dimension} — ${finding.problem}(${finding.status === "verified" ? "已验证" : "待复核"})`,
  )
  .join("\n");

await artifact.markdown(
  "report",
  [
    "# 跨仓库扫描报告",
    "",
    `共 ${ranked.length} 条发现:high ${high} 条,待复核 ${unresolved} 条。`,
    "",
    rows.length > 0 ? rows : "未发现可报告的问题。",
    "",
    "## 未覆盖",
    skippedNotes.map((note) => `- ${note}`).join("\n"),
    shardCoverage.map((note) => `- ${note}`).join("\n"),
    "- 性能维度未运行基准测试:仅接受复杂度论证或静态证据。",
  ].join("\n"),
  { title: "跨仓库扫描报告", description: "全库扫描的发现清单与证据", primary: true },
);

const failed = prepared.filter((repo) => !repo.ok).map((repo) => `${repo.name}: ${repo.note}`);
const result: WorkflowReport = {
  conclusion: `扫描完成:${ranked.length} 条发现,其中 high ${high} 条、待复核 ${unresolved} 条;覆盖 ${ready.length} 个仓库。`,
  findings: ranked.map((finding) => ({
    where: `${finding.repo}/${finding.where}`,
    what: finding.problem,
    evidence: finding.evidence,
    status: finding.status,
    severity: finding.severity,
  })),
  verified: [
    `${ready.length} 个仓库由规划员读取并产出选择规则`,
    `${shardJobs.length} 个分片各由独立审查员读取并给出来源证据`,
    `每条发现都经过了独立复核(未能复现的已标注 unconfirmed)`,
  ],
  notCovered: [
    ...failed,
    ...skippedNotes,
    ...shardCoverage,
    "性能维度未运行基准测试:仅接受复杂度论证或静态证据",
  ],
};
return result;
