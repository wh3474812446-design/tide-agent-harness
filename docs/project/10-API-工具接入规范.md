# API 工具接入规范

## 目标

Tide 可以把 HTTP API 暴露为模型可调用工具。模型只看到工具名、描述和输入 Schema；Tide 负责认证、请求发送、权限判断和结果格式化。

## 配置入口

`.env` 中指定 API 工具配置文件：

```text
HARNESS_API_TOOLS=examples/api-tools.example.json
```

修改配置后需要重启 Tide 服务。

## 最小示例

```json
{
  "tools": [
    {
      "name": "github_repo",
      "description": "Fetch public metadata for a GitHub repository.",
      "method": "GET",
      "url": "https://api.github.com/repos/{{input.owner}}/{{input.repo}}",
      "headers": {
        "accept": "application/vnd.github+json",
        "user-agent": "tide"
      },
      "inputSchema": {
        "type": "object",
        "properties": {
          "owner": { "type": "string" },
          "repo": { "type": "string" }
        },
        "required": ["owner", "repo"],
        "additionalProperties": false
      }
    }
  ]
}
```

## 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 工具名，模型调用时使用 |
| `description` | 是 | 告诉模型什么时候使用该工具 |
| `method` | 否 | HTTP 方法，默认 `GET` |
| `url` | 是 | 请求地址，支持模板 |
| `headers` | 否 | 请求头，支持模板 |
| `query` | 否 | 查询参数，支持模板 |
| `body` | 否 | 请求体，支持模板 |
| `inputSchema` | 是 | JSON Schema，用于校验模型参数 |
| `risk` | 否 | 风险等级，默认 `network` |
| `concurrencySafe` | 否 | 是否允许并发执行 |
| `includeResponseHeaders` | 否 | 是否把响应头返回给模型 |
| `maxResponseChars` | 否 | 返回给模型的最大字符数 |

## 模板语法

支持两类模板：

```text
{{input.field}}
{{env.API_KEY}}
```

示例：

```json
{
  "headers": {
    "authorization": "Bearer {{env.MY_API_KEY}}"
  },
  "query": {
    "limit": "{{input.limit}}"
  }
}
```

如果整个字段就是一个模板，Tide 会尽量保留原始类型；如果模板只是字符串的一部分，则按字符串插值处理。

## 鉴权示例

```json
{
  "name": "business_search",
  "description": "Search business records.",
  "method": "POST",
  "url": "https://api.example.com/v1/search",
  "headers": {
    "authorization": "Bearer {{env.BUSINESS_API_KEY}}",
    "content-type": "application/json"
  },
  "body": {
    "query": "{{input.query}}",
    "limit": "{{input.limit}}"
  },
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string" },
      "limit": { "type": "integer", "minimum": 1, "maximum": 20 }
    },
    "required": ["query"],
    "additionalProperties": false
  }
}
```

`.env` 中保存密钥：

```text
BUSINESS_API_KEY=your-service-key
```

## 权限要求

API 工具默认风险等级为 `network`。如果需要直接调用，`.env` 应包含：

```text
HARNESS_ALLOW_RISKS=read,write,network
```

如果未允许 `network`，工具调用会被权限策略拒绝。

## 设计建议

- 工具名使用稳定英文小写和下划线。
- 描述应说明业务用途，不要写泛泛的“调用接口”。
- `inputSchema` 尽量限制字段类型、长度、枚举和范围。
- 不要把 API Key 写死在 JSON 中。
- 对写入类业务 API 使用更高风险等级或单独工具策略。
- 对大响应设置 `maxResponseChars`。

