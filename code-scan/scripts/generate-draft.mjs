import { randomBytes } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

// 复核(confirm/globalConfirm)已改为确定性接地检查,不再调用模型,所以没有对应插槽。
const SLOTS = {
  plan: "/* @model:plan */",
  revision: "/* @model:revision */",
  review: "/* @model:review */",
  judge: "/* @model:judge */",
  global: "/* @model:global */",
};

const EXPECTED_COUNTS = {
  plan: 1,
  revision: 1,
  review: 1,
  judge: 1,
  global: 1,
};

function fail(message) {
  console.error(`generate-draft: ${message}`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    template: { type: "string" },
    config: { type: "string" },
    out: { type: "string" },
  },
});

if (!values.template) {
  fail("usage: node generate-draft.mjs --template <code-scan.ts> [--config <models.json>] [--out <.code-scan/tmp/draft.ts>]");
}

const cwd = process.cwd();
const workspace = realpathSync(cwd);
const templatePath = resolve(values.template);
const configPath = values.config === undefined ? undefined : resolve(values.config);

function ensureSafeDir(dir) {
  let info;
  try {
    info = lstatSync(dir);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      mkdirSync(dir, { recursive: true });
      return ensureSafeDir(dir);
    }
    fail(`cannot inspect ${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (info.isSymbolicLink()) {
    fail(`refusing symlinked directory: ${dir}`);
  }
  if (!info.isDirectory()) {
    fail(`not a directory: ${dir}`);
  }
  const actual = realpathSync(dir);
  const actualRelative = relative(workspace, actual);
  if (actualRelative === "" || actualRelative.startsWith("..") || isAbsolute(actualRelative)) {
    fail(`directory escapes the workspace: ${dir}`);
  }
}

let outputDir;
let finalOutPath;
let writeMode;

if (values.out !== undefined) {
  const outPath = resolve(values.out);
  const outRelative = relative(cwd, outPath);
  const normalizedRelative = outRelative.replaceAll("\\", "/");
  if (outRelative === "" || outRelative.startsWith("..") || isAbsolute(outRelative)) {
    fail(`output must stay inside the workspace: ${outPath}`);
  }
  if (!normalizedRelative.startsWith(".code-scan/tmp/")) {
    fail(`output must be under .code-scan/tmp/: ${outPath}`);
  }

  const safeRoot = join(workspace, ".code-scan");
  const safeTmp = join(safeRoot, "tmp");
  ensureSafeDir(safeRoot);
  ensureSafeDir(safeTmp);

  // Re-resolve the actual output directory and write through its real path, so a
  // symlinked path component cannot redirect the write. The final realpath check
  // catches a directory swap that happens between this check and the write.
  const outDir = dirname(outPath);
  let realOutDir;
  let realTmp;
  try {
    realOutDir = realpathSync(outDir);
    realTmp = realpathSync(safeTmp);
  } catch (error) {
    fail(`cannot resolve output directory ${outDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const samePath = process.platform === "win32"
    ? realOutDir.toLowerCase() === realTmp.toLowerCase()
    : realOutDir === realTmp;
  if (!samePath) {
    fail(`output directory must be exactly ${safeTmp}: ${outDir}`);
  }

  outputDir = realOutDir;
  finalOutPath = join(realOutDir, basename(outPath));
  writeMode = "explicit";
} else {
  // Production mode: a fresh per-user temp directory outside the workspace.
  // A workspace writer cannot pre-create or replace the draft before launch.
  const privateDir = mkdtempSync(join(tmpdir(), "code-scan-draft-"));
  outputDir = realpathSync(privateDir);
  finalOutPath = join(outputDir, "draft.ts");
  writeMode = "private";
}

let template;
try {
  template = readFileSync(templatePath, "utf8");
} catch (error) {
  fail(`cannot read template ${templatePath}: ${error instanceof Error ? error.message : String(error)}`);
}

let config = {};
if (configPath !== undefined) {
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    fail(`cannot read config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (!config || typeof config !== "object" || Array.isArray(config)) {
  fail("config must be a JSON object");
}

// 复核阶段改为确定性接地检查后不再调用模型;旧配置里的这两个键保留兼容,只提示一次。
const RETIRED_SLOTS = ["confirm", "globalConfirm"];
const unknown = Object.keys(config).filter(
  (key) => !Object.hasOwn(SLOTS, key) && !RETIRED_SLOTS.includes(key),
);
if (unknown.length > 0) {
  fail(`unknown model slot(s): ${unknown.join(", ")}`);
}
const retired = Object.keys(config).filter((key) => RETIRED_SLOTS.includes(key));
if (retired.length > 0) {
  console.error(
    `generate-draft: 忽略 ${retired.join(", ")}:复核已改为确定性证据核对,不再使用模型;可从配置里删掉这些键`,
  );
}

let draft = template;
const summary = { set: [], inherit: [] };

for (const [slot, marker] of Object.entries(SLOTS)) {
  const count = draft.split(marker).length - 1;
  if (count !== EXPECTED_COUNTS[slot]) {
    fail(`template marker ${slot} appears ${count} time(s), expected ${EXPECTED_COUNTS[slot]}`);
  }
  const value = config[slot];
  if (value === undefined) {
    draft = draft.split(marker).join("");
    summary.inherit.push(slot);
    continue;
  }
  if (typeof value !== "string") {
    fail(`model for ${slot} must be a non-empty string; omit the key to inherit`);
  }
  if (value.trim() === "") {
    fail(`model for ${slot} is empty`);
  }
  if (/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) {
    fail(`model for ${slot} contains control characters`);
  }
  draft = draft.split(marker).join(`model: ${JSON.stringify(value)}`);
  summary.set.push(slot);
}

if (draft.includes("/* @model:")) {
  fail("generated draft still contains an unreplaced @model marker");
}

if (writeMode === "explicit") {
  // Hard-link creation fails if the destination exists, including a dangling
  // symlink, and never follows a reparse point at the destination.
  const tempPath = join(outputDir, `.code-scan-draft-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tempPath, draft, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    fail(`cannot write temporary draft ${tempPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    linkSync(tempPath, finalOutPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    if (error && error.code === "EEXIST") {
      fail(`refusing to overwrite existing draft: ${finalOutPath}`);
    }
    fail(`cannot create draft ${finalOutPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  rmSync(tempPath, { force: true });
} else {
  try {
    writeFileSync(finalOutPath, draft, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error && error.code === "EEXIST") {
      fail(`refusing to overwrite existing draft: ${finalOutPath}`);
    }
    fail(`cannot write draft ${finalOutPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let writtenReal;
try {
  writtenReal = realpathSync(finalOutPath);
} catch (error) {
  fail(`cannot verify draft ${finalOutPath}: ${error instanceof Error ? error.message : String(error)}`);
}
const writtenRelative = relative(outputDir, writtenReal);
const writtenParts = writtenRelative.split(/[\\/]/);
if (writtenParts.length !== 1 || writtenParts[0] === "" || writtenParts[0] === ".." || isAbsolute(writtenRelative)) {
  rmSync(finalOutPath, { force: true });
  fail(`draft escaped its output directory: ${finalOutPath}`);
}

console.log(`draft: ${finalOutPath}`);
console.log(`configured: ${summary.set.join(", ") || "none"}`);
console.log(`inherit: ${summary.inherit.join(", ") || "none"}`);
