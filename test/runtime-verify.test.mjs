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
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** 抽取 `const NAME = String.raw`...`;` 的原文(反斜杠保持字面)。 */
function rawBlock(name) {
  const marker = `const ${name} = String.raw\``;
  const start = SOURCE.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const bodyStart = start + marker.length;
  const end = SOURCE.indexOf("\n`;", bodyStart);
  if (end < 0) throw new Error(`unterminated ${name}`);
  return SOURCE.slice(bodyStart, end);
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
  ["interface RawFinding", "interface"],
  ["interface Finding", "interface"],
  ["interface CheckedFinding", "interface"],
  ["type ReproAssertion", "alias"],
  ["interface ReproSpec", "interface"],
  ["interface ReproResult", "interface"],
  ["interface DockerCall", "interface"],
  ["interface ReproJob", "interface"],
];
const FUNC_BLOCKS = [
  "clip",
  "oneLine",
  "asString",
  "asNumber",
  "isRecord",
  "isSeverity",
  "isDimension",
  "findingKey",
  "normalizeAssertion",
  "normalizeRepro",
  "classifyRepro",
  "selectReproJobs",
  "dedupeFindings",
  "normalizeFinding",
];
const CONST_BLOCKS = ["RATIO_MIN", "RATIO_MAX", "MAX_REPRO"];

function extractDecl(marker, kind) {
  const start = SOURCE.indexOf(`${marker}`);
  if (start < 0) throw new Error(`missing ${marker}`);
  let depth = 0;
  let mode = "code";
  for (let index = start; index < SOURCE.length; index += 1) {
    const char = SOURCE[index];
    const next = SOURCE[index + 1];
    if (mode === "line") {
      if (char === "\n") mode = "code";
      continue;
    }
    if (mode === "block") {
      if (char === "*" && next === "/") { mode = "code"; index += 1; }
      continue;
    }
    if (mode === "single") {
      if (char === "\\") { index += 1; continue; }
      if (char === "'") mode = "code";
      continue;
    }
    if (mode === "double") {
      if (char === "\\") { index += 1; continue; }
      if (char === '"') mode = "code";
      continue;
    }
    if (mode === "template") {
      if (char === "\\") { index += 1; continue; }
      if (char === "`") mode = "code";
      continue;
    }
    if (char === "/" && next === "/") { mode = "line"; index += 1; continue; }
    if (char === "/" && next === "*") { mode = "block"; index += 1; continue; }
    if (char === "'") { mode = "single"; continue; }
    if (char === '"') { mode = "double"; continue; }
    if (char === "`") { mode = "template"; continue; }
    if (char === "{") { depth += 1; continue; }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && kind === "interface") return SOURCE.slice(start, index + 1);
      continue;
    }
    if (char === ";" && depth === 0) {
      if (kind === "alias") return SOURCE.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${marker}`);
}

function extractFunction(name) {
  const match = new RegExp(`function ${name}\\(`).exec(SOURCE);
  if (match === null) throw new Error(`missing function ${name}`);
  const start = match.index;
  let depth = 0;
  let mode = "code";
  for (let index = start; index < SOURCE.length; index += 1) {
    const char = SOURCE[index];
    const next = SOURCE[index + 1];
    if (mode === "line") { if (char === "\n") mode = "code"; continue; }
    if (mode === "block") { if (char === "*" && next === "/") { mode = "code"; index += 1; } continue; }
    if (mode === "single") { if (char === "\\") { index += 1; continue; } if (char === "'") mode = "code"; continue; }
    if (mode === "double") { if (char === "\\") { index += 1; continue; } if (char === '"') mode = "code"; continue; }
    if (mode === "template") { if (char === "\\") { index += 1; continue; } if (char === "`") mode = "code"; continue; }
    if (char === "/" && next === "/") { mode = "line"; index += 1; continue; }
    if (char === "/" && next === "*") { mode = "block"; index += 1; continue; }
    if (char === "'") { mode = "single"; continue; }
    if (char === '"') { mode = "double"; continue; }
    if (char === "`") { mode = "template"; continue; }
    if (char === "{") {
      if (depth === 0 && index > start) {
        // 参数列表里的对象类型注解也算,但我们的函数没有;继续按大括号计深度
      }
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(start, index + 1);
      continue;
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function extractConstLine(name) {
  const match = new RegExp(`const ${name} = [^;\\n]+;`).exec(SOURCE);
  if (match === null) throw new Error(`missing const ${name}`);
  return match[0];
}

async function logicTests() {
  if (TSC === "" || !fs.existsSync(TSC)) {
    console.log("SKIP 逻辑测试:未提供 TSC=<typescript/lib/tsc.js>");
    return;
  }
  const workDir = mkdtemp("logic-");
  const parts = [];
  for (const [marker, kind] of DECL_BLOCKS) parts.push(extractDecl(marker, kind));
  for (const name of CONST_BLOCKS) parts.push(extractConstLine(name));
  for (const name of FUNC_BLOCKS) parts.push(extractFunction(name));
  parts.push("export { normalizeAssertion, normalizeRepro, classifyRepro, selectReproJobs, dedupeFindings, normalizeFinding };");
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

  check("LOGIC:未知 severity/dimension 回落但不丢发现", () => {
    const notes = [];
    const out = logic.normalizeFinding(
      { dimension: "security", where: "a.js:1", problem: "p", evidence: "e", severity: "critical", fix: "f" },
      notes,
    );
    assert(out !== null, "finding kept");
    assert(out.severity === "medium" && out.dimension === "quality", `${out.severity}/${out.dimension}`);
  });
}

/* ------------------------------------------------------------------------- */

await logicTests();

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`- FAIL ${failure}`);
if (failures.length > 0) process.exitCode = 1;
