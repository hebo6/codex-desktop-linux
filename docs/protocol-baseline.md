# app-server 协议基线

## 生成来源

| 项目 | 值 |
| --- | --- |
| 上游仓库 | [openai/codex](https://github.com/openai/codex) |
| Codex CLI | `PATH` 中的本机 `codex` |
| 上游生成命令 | `codex app-server generate-json-schema --experimental --out <目录>` |
| 固化目录 | `protocol/schema` |

本基线只固化上游 JSON Schema，不复制上游 `ts-rs` 生成的 TypeScript 类型

前端协议类型与运行时校验器统一从固化的 JSON Schema 生成，协议升级也以 Schema 差异为入口

## 复现与校验

更新固化基线时执行

```bash
./scripts/generate-protocol-schema.sh --update
```

验证工作树中的基线与本机 Codex CLI 的生成结果一致时执行

```bash
./scripts/generate-protocol-schema.sh --check
```

脚本不限制 CLI 版本，直接调用本机 Codex 生成 JSON Schema，不查询或推断上游提交号

原始生成目录位于 `/tmp`

`--update` 只把最终 JSON Schema、CLI 版本和校验清单同步到本项目；`--check` 比较这些文件并在出现差异时失败，不修改基线

## 固化产物

`protocol/schema/CODEX_VERSION` 记录生成时 `codex --version` 的实际输出，`protocol/schema/SHA256SUMS` 记录全部 JSON 文件按相对路径排序后的 SHA256，版本标识来源，校验清单标识确切内容

`codex_app_server_protocol.schemas.json` 是完整命名空间聚合包，`codex_app_server_protocol.v2.schemas.json` 是扁平化 v2 聚合包，目录内其余 JSON 文件是请求、响应、通知及共享负载的独立 Schema

## TypeScript 生成物

从已固化 Schema 重新生成 TypeScript 判别联合、方法集合和 Ajv standalone ESM 校验器时执行

```bash
pnpm protocol:generate
```

验证固化 Schema 完整性，以及工作树中的生成物未被手动修改且与当前 Schema 一致时执行

```bash
pnpm protocol:check
```

该命令会先使用 Node.js 内置加密模块校验清单路径、JSON 文件全集和全部 SHA256，不依赖系统 `sha256sum` 命令，也不会重新构建上游 Schema

生成物位于 `src/protocol/generated`，每个文件都记录基线的 CLI 版本并禁止手动修改

Schema 同时包含对象公共字段与 `anyOf` 时，类型生成前等价改写为显式交集，保留图片输入等联合类型的共同判别字段；运行时校验继续使用原始 Schema 约束

`src/protocol/validation` 在 envelope 校验后继续按服务端方法和参数执行二级校验，并只生成不含原始字段值的错误摘要

Schema 中的 Rust 数值格式会收紧为对应范围，64 位整数额外限制在 JavaScript safe integer 范围内，避免解析后静默丢失精度

## Wire envelope

app-server 在语义上使用 JSON-RPC 2.0，但 stdio 行与 WebSocket 文本帧中的 wire envelope 省略标准的 `"jsonrpc": "2.0"` 字段

请求、通知、成功响应和错误响应分别采用以下形状

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"codex-desktop-linux","title":"Codex Desktop Linux","version":"0.1.0"},"capabilities":{"experimentalApi":true}}}
{"method":"initialized"}
{"id":1,"result":{}}
{"id":1,"error":{"code":-32600,"message":"Invalid request"}}
```

客户端不得在 stdio 或 WebSocket 传输中自行补入 `jsonrpc` 字段，也不得把生成的 Schema 当成标准 JSON-RPC envelope 后再套一层

当前通知 envelope 包含服务端发出通知时记录的 `emittedAtMs`，但没有事件序号，归并顺序仍只能使用同一物理连接上的传输到达顺序，断线后通过 thread 快照重新对账

## 实验能力

Schema 必须使用 `--experimental` 生成，保留本机 CLI 导出的实验方法和字段

生成实验 Schema 与运行时启用实验 API 是两件独立的事，连接初始化仍必须显式声明以下能力

```json
{
  "capabilities": {
    "experimentalApi": true
  }
}
```

产品会话恢复使用 `thread/resume.initialTurnsPage`、`thread/turns/list` 和 `thread/items/list` 的两级分页契约，运行时边界必须分别校验回合页与项目页响应

客户端应在 `initialize` 成功后发送 `initialized`，初始化完成前不得发送业务请求

## `rawResponse*/completed` 不对称

当前基线对应的 Rust `ServerNotification` 枚举包含内部通知 `rawResponseItem/completed` 与 `rawResponse/completed`，但 JSON Schema 导出器通过明确排除清单将这两个方法从 `ServerNotification` 判别联合中移除，即使启用 `--experimental` 也不会成为合法通知方法

导出器仍会生成独立的 `v2/RawResponseItemCompletedNotification.json` 与 `v2/RawResponseCompletedNotification.json` 负载 Schema，并在聚合包的定义区保留对应负载类型，这正说明负载类型存在不等于 wire 方法对客户端开放

因此这两个通知不是 Desktop 可依赖的公开协议面，不为它们手写 TypeScript 类型或绕过 Schema 添加专用业务处理

若 wire 上出现这些方法，路由器按未知通知记录诊断计数并忽略，不能把其中的原始 Responses API 数据当作公开协议负载处理

## 方法边界

方法名与方向必须以聚合 Schema 中的四个判别联合为准

| 联合 | 方向 | envelope |
| --- | --- | --- |
| `ClientRequest` | 客户端到服务端 | `id` `method` `params` |
| `ServerRequest` | 服务端到客户端 | `id` `method` `params` |
| `ClientNotification` | 客户端到服务端 | `method` 与可选 `params` |
| `ServerNotification` | 服务端到客户端 | `method` `params` 与可选 `emittedAtMs` |

独立的 `*Params.json` 和 `*Response.json` 只描述负载，不能仅因文件存在就推断它对应可调用方法或方向

`initialize` 和 `initialized` 继续使用协议中的 v1 握手类型，这是 v2 业务 API 的正式初始化边界，不代表客户端应使用已废弃的 v1 会话接口

Desktop 业务实现以 v2 thread、turn、item、账户、模型、技能、应用及审批接口为边界，产品阶段只决定实现顺序，不改变固化 Schema 的完整范围

聚合 Schema 中保留的已废弃 v1 业务方法、内部方法或尚未进入产品需求的方法不因完成类型生成而自动成为可调用能力，使用新方法前必须同时确认产品需求、实验能力门控和服务端行为
