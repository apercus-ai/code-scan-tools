---
name: code-scan-models
description: 为 code-scan 的五个模型阶段选择模型:自动读取本机 ZCode 模型目录,按阶段弹出选择面板,保存为每人自己的配置;之后 /code-scan 自动使用
---

# /code-scan-models

让用户按阶段选择 code-scan 使用的模型。候选来自本机 ZCode 的 `ListModels`,不需要手改配置文件。

## 步骤

1. 调用 `ListModels`,读取本机已配置的模型。**只排除带 `disabledReason` 字段的模型**——`reasoningLevels` 里的 `disabled` 只是一个推理档位名(`enabled` 同理),不是模型被禁用;看到 `levels: disabled,low,high,max` 的模型仍然可用。记下每行的 `id`(通常是 `providerId/modelId`)、`current`、`reasoningLevels`。
   - 没有可用模型:停止,告诉用户先在 ZCode 里配置模型。
2. 在对话里列出可用模型的完整 id(一行一个或逗号分隔),并说明:面板里是快捷候选,其他模型点 **Other** 输入完整 id。
3. 分两轮调用 `AskUserQuestion`,每轮最多 4 个问题:

   第一轮:
   - `plan` 规划:写全库选择器与仓库地图
   - `revision` 修订:死规则/超量规则修订
   - `review` 批次审查:每个信号批次的审查员

   第二轮:
   - `judge` 评审长:去重排序
   - `global` 全局评审:跨批次模式审查

   只有这五个阶段调用模型。复核(Confirm)已改为确定性证据核对,不消耗模型调用,所以没有对应的问题;如果旧的配置文件里还有 `confirm`/`globalConfirm`,保存时去掉它们。

   每个问题:
   - 模型候选总共最多 3 个:如果 `current` 存在,把它放第一个,再从目录里补足到 3 个;不要超过 3 个(加"继承"正好 4 个选项)
   - 最后一个选项:`继承运行模型`(不写 model 字段,用 run 级 `subagent_model` 或会话模型)
   - label 用完整 id;description 写 provider、推理档位、是否 current
   - 用户可以用 Other 输入任意完整模型 id;候选之外的 id 也必须在 `ListModels` 里存在且没有 `disabledReason`
4. 校验每个非继承选择:在 `ListModels` 结果里找到对应 id;不存在或带 `disabledReason` 就说明原因,重新问该阶段。跨 provider 必须用完整 `providerId/modelId`,不要用裸名。
5. 把选择写成 JSON,只保留非继承的阶段:
   - 解析用户 home:`Bash("node -e \"process.stdout.write(require('os').homedir())\"")`(得到 `C:\Users\...` 这类原生路径)
   - 路径 `<home>/.zcode/code-scan-models.json`;目录不存在就创建:`Bash("node -e \"require('fs').mkdirSync(require('path').join(require('os').homedir(), '.zcode'), { recursive: true })\"")`
   - 示例:
     ```json
     {
       "plan": "providerId/modelId",
       "review": "providerId/modelId"
     }
     ```
   - 用 Write 写入,覆盖旧配置;写入前确认 JSON 合法。如果文件已存在,先用 Read 读它再 Write(Write 覆盖已存在文件前要求已读过)
6. 汇报:保存路径、每个阶段的选择(模型 id 或"继承")、下次 `/code-scan` 自动读取。

## 规则

- 只使用 `ListModels` 里真实存在且未 disabled 的模型;不要凭模型名猜测。
- 每个阶段独立选择;不要把同一个模型强塞给所有阶段。
- 继承是合法选择;没选的阶段不要在 JSON 里写空串或 `null`。
- 不把模型 id 写进共享插件文件;配置只在用户 home 下。
- 用户取消或没有回答完整时,不要写半份配置;保留旧配置。
