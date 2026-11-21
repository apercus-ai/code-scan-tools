---
name: code-scan
description: 跨仓库全库扫描(质量/冗余/性能),Devin Agentic MapReduce 复刻;选择器 v2 可持久化、可试跑修订,按阶段模型可配置,产出带证据与复核的发现清单
---

# /code-scan

对当前工作区或指定的一组仓库执行 MapReduce 全库扫描。

## 参数解析

用户可能给出:

- 无参数 → 扫描当前工作区
- `repos=[{name,url,ref}]` 或仓库 URL 列表 → 跨仓库扫描(也支持 `{name,path}` 指向工作区内目录)
- `model="..."` → **run 级默认模型**,只影响没有单独配置的阶段;按阶段配置请先用 `/code-scan-models`
- `goal="..."` → 审查侧重(默认:全面扫描:质量/冗余/性能)
- `selectorBudget=200` → 每条选择器的命中上限(默认 200,最大 2000)
- `refreshSelectors=true` → 忽略 `.code-scan/selectors/` 历史规则,重新规划
- `maxFilesPerBatch=8` / `maxTotalBatches=0` → 分片与全局批次预算
- `runtimeVerify=true` → 在隔离容器里装依赖并执行仓库代码复现(默认关闭;需要 Docker daemon 与本地 context)
- `runtimeVerifyOnline=true` → 安装依赖时允许联网(默认离线读本机 npm 缓存;开启后安装容器可访问任意主机)
- `concurrency=4` → 并发上限

## 步骤

1. 调用 Skill 加载 `dynamic-workflows`(工作流工具在加载前拒绝运行)。
2. 定位插件目录:模板脚本 `scripts/code-scan.ts`、草稿生成器 `scripts/generate-draft.mjs`、模型选择命令 `commands/code-scan-models.md`。
3. 读取并校验按阶段模型配置:
   - 解析用户 home:`Bash("node -e \"process.stdout.write(require('os').homedir())\"")`(得到 `C:\Users\...` 这类原生路径)。配置路径 `<home>/.zcode/code-scan-models.json`。
   - 文件不存在:用 `AskUserQuestion` 问用户"现在按阶段选模型,还是本次全部继承?"。
     - 选"现在按阶段选":读取 `<插件目录>/commands/code-scan-models.md` 并按其步骤执行(会把选择写入配置);完成后回到本步骤重新读取并校验。如果用户中途取消,按"本次全部继承"继续,不要反复弹窗。
     - 选"本次全部继承":继续,并在结果里注明未配置阶段模型。
   - 文件存在:读取 JSON。只允许键 `plan`、`revision`、`review`、`judge`、`global`;值必须是非空字符串。`confirm`、`globalConfirm` 是旧版本的键(复核已改为确定性检查,不再调用模型),出现时忽略并提示用户可从配置里删掉。JSON 非法、键未知或值类型不对:停止,提示重跑 `/code-scan-models`。
   - 对每个已配置的 id 调用 `ListModels` 校验:必须存在且没有 `disabledReason` 字段(`reasoningLevels` 里的 `disabled` 是档位名,不算禁用)。任何一个失效:停止,提示重跑 `/code-scan-models`;不要静默丢弃或改用别的模型。
4. 生成带模型字面量的草稿:
   - 有配置时运行:
     ```
     node "<插件目录>/scripts/generate-draft.mjs" \
       --template "<插件目录>/scripts/code-scan.ts" \
       --config "<home>/.zcode/code-scan-models.json"
     ```
     没有配置时省略 `--config`。
   - 生成器在**每用户私有的系统临时目录**创建草稿(不在工作区),第一行输出 `draft: <绝对路径>`。记下这个路径,后续 `CreateWorkflow` 用它。
   - 检查退出码为 0、该路径存在、`grep -c "@model:" "<草稿路径>"` 为 0。所有 Bash 检查都给草稿路径加双引号(Windows 用户名/TEMP 可能含空格或 `&`)。`node` 不可用或生成失败:停止并说明原因,不要绕过生成器直接跑模板脚本。
   - 草稿是系统私有临时文件;不要修改共享模板,也不要让用户手动编辑草稿。
5. 解析其余参数:
   - `model`:若用户给了 `model="..."`,先调用 `ListModels` 解析成完整 `providerId/modelId`(可带 `$level`)。裸名只在会话 provider 内解析;跨 provider 必须用完整 id。解析失败就停止并列出可用模型;解析结果作为 `subagent_model`。
   - `repos`:JSON 数组,元素为 `{ "name": "...", "url": "...", "ref": "..." }`,或 `{ "name": "...", "path": "工作区内相对路径" }`;也可直接给 `"owner/repo"` 字符串(按 https URL 处理)。用户没给就用当前工作区。
   - `concurrency`:若用户指定并发上限(如 `concurrency=4`),作为 `max_concurrency` 传入——**这是唯一正确的限流方式**;用户没要求就不要传(运行时自适应);不要用批次上限来限流。
   - `selectorBudget`、`refreshSelectors`、`maxFilesPerBatch`、`maxTotalBatches`:原样转成数字/布尔值传入。
   - `runtimeVerify`、`runtimeVerifyOnline`:**只在用户明确要求时传 `true`**;默认不传(等于关闭,零次 docker 调用)。不要替用户判断要不要开。
   - `goal`:字符串,原样传入。
6. 调用 `CreateWorkflow`:
   ```
   CreateWorkflow({
     name: "跨仓库全库扫描",
     path: "<草稿路径>",
     args: {
       repos: [...],
       goal: "...",
       maxFilesPerBatch: 8,
       maxTotalBatches: 0,
       selectorBudget: 200,
       refreshSelectors: false,
       runtimeVerify: false,
       runtimeVerifyOnline: false
     },
     subagent_model: "<run 级模型>",   // 仅当用户给了 model=;已解析为完整 id
     max_concurrency: 4                // 仅当用户指定并发时
   })
   ```
   `subagent_model` 只作为未配置阶段的兜底;已配置阶段使用草稿里的模型字面量。
   用户确认后运行在后台;不要轮询,等完成通知。
7. 汇报结果:
   - `conclusion`
   - `findings`(按严重度;`status` 为 verified/unconfirmed;带 `repro` 字段时是运行期复现结论;`where` 带仓库名前缀)
   - `verified`(仓库数、信号数、批次数、外部工具;开了 runtimeVerify 时还有复现条数与成立数)
   - `notCovered`(克隆失败、选择器采样/死规则、工具缺失、依赖未安装、批次溢出、运行时复现未运行/安装被拒/跳过)
   - Artifact:发现看板 + markdown 报告(含选择器执行表)
   - 另说明本次哪些阶段用了配置模型、哪些继承。
8. 说明选择器复用:同 `goal` 重跑会直接复用 `.code-scan/selectors/<repo>.json`;需要重新规划时用 `refreshSelectors=true`。
9. 说明改模型用 `/code-scan-models`;配置在 `<home>/.zcode/code-scan-models.json`,不需要改共享脚本。
10. 扫描只读,不要修改任何仓库文件。用户要求修某几条发现时,改用 `/code-scan-fix`。
11. 开了 `runtimeVerify` 时说明:结论是脚本自报(不是独立证明),`notReproduced` 只表示「脚本未观察到预期行为」;镜像已按 digest 钉死,若 daemon 未运行功能会静默降级并写进 notCovered。

## 规则

- 模型配置按人保存;不要把模型 id 写进仓库文件或提交。
- 生成草稿是本次运行的脚本,确认框展示的就是它;不要改为直接提交共享模板。
- 草稿在每用户私有的系统临时目录;不要复用旧草稿,每次运行重新生成。
