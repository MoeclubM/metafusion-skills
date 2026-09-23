# 本地凭据与通用客户端

这个目录是技能运行时的本地工作区。仓库只提交说明和 `metafusion-api.mjs`；本机凭据保存在同目录的 `credentials.json`，由本目录的 `.gitignore` 排除。

## 凭据文件

`credentials.json` 只保留两个字段：

```json
{
  "baseUrl": "https://example.com",
  "pat": "<仅在本机填写>"
}
```

- 本地 Agent 可以直接读取和修改这个文件；不要把 `pat` 的值输出到对话、命令输出、日志、报告或提交。
- 工具只向 `baseUrl` 发送凭据，并拒绝跨重定向自动转发。
- `MF_BASE` / `MF_PAT` 可临时覆盖文件内容；`MF_CREDENTIALS` 可指定其它本地凭据文件。
- 正常使用本地凭据完成 API 读写不等于泄露，不要在任务结束时自动创建、吊销或轮换凭据。
- 只有凭据实际进入聊天、日志、版本控制或非目标服务，或目标实例明确返回 `401 invalid_token` 时，才停止使用并按用户授权处理。

## 通用客户端

`metafusion-api.mjs` 是所有编目任务共用的唯一客户端。它提供通用 `request`、实体读取、definitions、分页读取和带版本检查的整实体 PUT；不要再为每个批次复制一份脚本。

- `baseUrl` 只接受实例根地址；路径必须规范化后仍位于 `/api/`，否则不会携带凭据发出请求。
- `GET` / `HEAD` / `OPTIONS` 可按 `Retry-After` 重试 429、5xx 和网络错误；POST、PUT 等写请求只发一次。`putEntity` 遇到 409 也只返回冲突，不自动重放 `mutate`；回读并检查最新实体后，由调用方明确决定是否重试。
- 响应体和返回的少量响应头都会遮盖 PAT 值；客户端不自动跟随重定向。

```js
import { getEntity, putEntity } from "./local/metafusion-api.mjs";

const { status, body } = await getEntity("<entity-id>");

await putEntity("<entity-id>", (entity) => {
  // 只修改已核实的可写字段；返回 false 表示无变化。
  entity.attributes ||= {};
  entity.attributes.example = "<value>";
  return true;
}, {
  editNote: "<具体变更说明>",
  sources: [{ kind: "url", citation: "<来源为何支持这些字段>", url: "https://example.com/source" }],
});
```

这个客户端不负责创建、吊销或轮换 PAT，也不把任务数据保存到仓库。
