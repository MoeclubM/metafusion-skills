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

- 本地 Agent 可以直接读写这个文件；`pat` 值不进入对话、日志、报告或提交。
- `MF_BASE` / `MF_PAT` 可临时覆盖文件内容；`MF_CREDENTIALS` 可指定其它本地凭据文件。
- 正常本地调用无需轮换；服务端返回 `401 invalid_token` 时再选择其他有效凭据。

## 通用客户端

`metafusion-api.mjs` 提供通用 `request`、实体读取、definitions、分页读取和带版本检查的整实体 PUT，任务直接复用。

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
