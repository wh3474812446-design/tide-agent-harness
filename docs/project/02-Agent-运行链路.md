# Agent 运行链路

## 标准请求流程

一次 Tide 对话运行包含以下步骤：

1. 用户通过 Web UI 或 CLI 发送消息。
2. Runtime 加载当前会话历史。
3. Context Manager 准备模型上下文。
4. Agent Loop 向模型 Provider 发起请求。
5. 模型返回文本或工具调用。
6. Tool Executor 校验并执行工具调用。
7. 工具结果以 `tool_result` 形式回填给模型。
8. 模型继续推理，直到给出最终文本回复。
9. Session Store 保存完整消息。
10. Event Bus 记录关键运行事件。

## 工具调用闭环

模型不会直接访问硬盘、网络或系统命令。它只能提出结构化工具调用：

```json
{
  "name": "read_file",
  "input": {
    "path": "README.md"
  }
}
```

Tide 负责判断这个调用是否存在、参数是否有效、权限是否允许，以及实际执行后的结果如何返回。

## 多轮工具调用

一次用户请求可以触发多轮模型请求。例如：

```text
用户要求整理项目
  -> 模型调用 list_files
  -> Tide 返回目录
  -> 模型调用 read_file
  -> Tide 返回文件内容
  -> 模型调用 write_file
  -> Tide 写入结果
  -> 模型总结完成情况
```

Agent Loop 的职责是维持这个闭环，直到模型不再请求工具。

## 并发策略

工具声明 `concurrencySafe` 后，执行器才会并发运行它。

当前规则：

- 读取类工具可以并发。
- 写入、移动、删除、命令执行类工具串行运行。
- API 工具根据 HTTP 方法和配置判断是否适合并发。

这个设计可以降低文件写入冲突和顺序错乱风险。

## 错误处理

工具执行错误不会直接中断整个 Agent。错误会作为 `tool_result` 返回模型，并标记 `isError: true`。

常见错误包括：

- 工具不存在。
- 输入参数不符合 Schema。
- 风险等级未授权。
- 路径越过工作区。
- 文件不存在。
- 网络 API 返回异常。

模型收到错误后可以修正参数、换用其他工具，或向用户说明失败原因。

## 事件流

Tide 在关键节点发出事件：

- `session.started`
- `model.requested`
- `model.responded`
- `tool.started`
- `tool.finished`
- `context.compacted`
- `agent.finished`

Web UI 使用这些事件展示运行状态，后续也可以接入日志、审计和监控系统。

