# 本地凭据与通用客户端

这个目录是技能运行时的本地工作区。仓库提交说明、通用客户端 `metafusion-api.mjs` 和隔离测试 `metafusion-api.test.mjs`；本机凭据保存在同目录的 `credentials.json`，由本目录的 `.gitignore` 排除。

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
- `GET` / `HEAD` / `OPTIONS` 可按 `Retry-After` 重试 429、5xx 和网络错误；POST、PUT 等写请求只发一次。`listAll` 在本地先拒绝非 1–100 整数 limit，并以异常报告分页 4xx/5xx，不再把失败页静默当作结束。
- `putEntity` 读取完整实体、剔除只读投影、带 `expected_version` 做整实体 PUT；409 只返回冲突，不自动重放 `mutate`。2xx 后客户端再次 GET，并用 `readbackOK` 表示写后版本是否与响应一致；调用方仍须逐字段检查 `readback`、当前 revisions、relations 和 occurrences。
- 响应体和返回的少量响应头都会遮盖 PAT 值；客户端不自动跟随重定向。

```js
import { getEntity, putEntity } from "./local/metafusion-api.mjs";

const { status, body } = await getEntity("<entity-id>");

const result = await putEntity("<entity-id>", (entity) => {
  // 只修改已核实的可写字段；返回 false 表示无变化。
  entity.attributes ||= {};
  entity.attributes.example = "<value>";
  return true;
}, {
  editNote: "<具体变更说明>",
  sources: [{ kind: "url", citation: "<来源支持的具体字段码>", url: "https://example.com/source" }],
});
if (!result.readbackOK) throw new Error("写入响应与回读不一致，停止后续写入并人工核对");
```

`sources` 是修订级证据载荷，不是字段级 provenance；核心值仍须逐字段 CORE-P1，当前资格只认 `revision.version == entity.version`。`self` 不得支撑字段事实。

运行隔离测试（不会访问真实实例）：

```bash
node --check metafusion-api.mjs
node --test metafusion-api.test.mjs
```
