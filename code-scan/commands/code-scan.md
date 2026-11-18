---
name: code-scan
description: 跨仓库全库扫描(质量/冗余/性能),Devin Agentic MapReduce 复刻,产出带证据与复核的发现清单
---

# /code-scan

对当前工作区或指定的一组仓库执行 MapReduce 全库扫描。

## 参数解析

用户可能给出:
- 无参数 → 扫描当前工作区
- `repos=[{name,url,ref}]` 或仓库 URL 列表 → 跨仓库扫描
- `model="..."` → 指定扫描模型
- `goal="..."` → 审查侧重(默认:全面扫描:质量/冗余/性能)

## 步骤

1. 调用 Skill 加载 `dynamic-workflows`(工作流工具在加载前拒绝运行)。
2. 定位本插件自带脚本 `scripts/code-scan.ts`(插件安装目录;定位不到时从本命令文件所在目录向上查找)。
3. 解析用户参数:
   - `repos`:JSON 数组,元素为 `{ "name": "...", "url": "...", "ref": "..." }`,或 `{ "name": "...", "path": "工作区内相对路径" }`;也可直接给 `"owner/repo"` 字符串(按 https URL 处理)。用户没给就用当前工作区。
   - `model`:若用户指定了模型,**先调用 `ListModels` 解析为可用的 `providerId/modelId`**,在 `CreateWorkflow` 时作为 `subagent_model` 传入;未指定则省略该参数(用会话默认模型)。
   - `goal`:字符串,原样传入。
4. 调用 `CreateWorkflow`:
   ```
   CreateWorkflow({
     name: "跨仓库全库扫描",
     path: "<插件目录>/scripts/code-scan.ts",
     args: { repos: [...], goal: "...", maxFilesPerShard: 12, maxShardsPerRepo: 4 },
     subagent_model: "<解析后的模型 id>"   // 仅当用户指定时
   })
   ```
   用户确认后运行在后台;不要轮询,等完成通知。
5. 汇报结果:
   - `conclusion`
   - `findings`(按严重度;`status` 为 verified/unconfirmed;`where` 带仓库名前缀)
   - `notCovered`(克隆失败、工具缺失、维度未覆盖)
   - Artifact:发现看板 + markdown 报告
6. 扫描只读,不要修改任何仓库文件。用户要求修某几条发现时,改用 `/code-scan-fix`。
