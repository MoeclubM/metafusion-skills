# 接口归属与写入范围（面向 Agent）

站点由若干系统组成，但**编目只需要认路径前缀**：哪些前缀属于元数据目录、哪些属于别的系统。
本文件只讲"我能调什么、该往哪里写"。

## 路径前缀与职责

| 系统 | 负责什么 | 对外路径前缀 | 实现仓库 |
| --- | --- | --- | --- |
| 元数据目录 catalog | 八类实体、动态定义、关系、结构、修订、检索、货架、外部权威库、快照导出与外部提案（`catalog.*`） | `/api/catalog/*`（含 `/api/catalog/me/home-preferences`）、`/api/importer/*`、`/api/exchange/*`、`/api/admin/catalog-definitions`、`/api/admin/shelves`、`/api/admin/external-databases`、`/api/openapi.json` | MetaFusion |
| 账号 auth | 用户、会话、OAuth 客户端/授权码/令牌、RSA 密钥（`auth.*`） | `/api/setup`、`/api/auth/*`、`/api/admin/users*`、`/api/oauth/*`、`/api/oidc/jwks`、`/api/.well-known/openid-configuration` | metafusion-auth |
| 互动 community | 论坛板块/主题/回复/标签、条目短评、收藏、私信（`community.*`） | `/api/community/*`、`/api/favorites/*`、`/api/messages/*`、`/api/users/{id}/favorites`、`/api/users/{id}/stats` | metafusion-community |
| 存储 storage | 物理文件、sha256 内容寻址、对象存储直传、文件→实体绑定、下载与预览的访问控制（`storage.*`） | `/api/storage/*` | metafusion-storage |
| 边缘网关 gateway | 无（只有路由表） | `/`、`/docs`，按前缀分流到上述单元 | MetaFusion 的 `deploy/nginx.conf`；`metafusion-api-gateway` 存放切流自检脚本 |

> 上表是**分工口径**，不是"实例已经提供"的清单：某组前缀在具体实例是否可用，**按实例响应为准**
> （返回 404 即该实例没有提供这组端点），不要在报告里写成已有能力。

`/api/admin/*` **不是整段归账号**：`/api/admin/users*` 归账号，而 `/api/admin/catalog-definitions`、
`/api/admin/shelves`、`/api/admin/external-databases` 由目录服务提供（权限码 `catalog.definitions.manage`、
`catalog.shelves.manage`），是定义 / 货架 / 外部库的管理入口，与实体写入（`/api/catalog/entities/*`）不是同一范围；
别把"我只有编目权限"读成"目录里没有定义/货架管理入口"。

网关**按前缀分流**，不为切换服务而改前端调用点。`/api/users/{id}/favorites` 与用户资料同前缀，网关用精确正则
`^/api/users/[^/]+/favorites$` 单独分流到互动服务；`/api/users/{id}/stats` 也归互动，
`/api/users/{id}` 归账号，`/api/users/{id}/contributions` 归目录。

**编目者只写目录。** 论坛、短评、收藏、互动记录不是元数据事实：不要通过目录接口写入它们，也不要为它们在目录里建实体。

## 目录的其它入口（与实体写入无关）

同属目录服务、但不写实体的几条通道，先认准再调用：

- `GET /api/exchange/entities/{id}`：导出该实体的快照，只读，匿名可访问。
- `POST /api/exchange/proposals`：提交外部提案，落 `pending_review` 待审，**不直接写实体**。
- `GET /api/catalog/me/home-preferences`：读调用者自己的主页偏好，与实体无关。
- `GET /api/docs`（Scalar）、`GET /api/swagger`（Swagger UI）：目录服务托管的交互式文档页，属**管理面**
  （需登录 + `catalog.lifecycle.manage`，页面与自托管资源同一道闸门），不是给接入方看的公开入口；
  要看公开契约用 `GET /api/openapi.json`，它对匿名开放。

## 各系统负责什么

- **元数据目录**：八类实体的创建与编辑、动态类型/字段/词表/关系/模板定义、关系图、包含与发行结构、
  修订与生命周期（草稿 / 待审 / 发布 / 合并 / 停用）、检索与货架、外部权威库预设。它是"作品是什么"的唯一来源。
- **账号**：注册与登录、会话轮转、令牌签发与吊销、OAuth 2.0 / OIDC、账号与角色管理。
  **业务权限（谁能编辑哪个实体）由目录自己判断**，账号服务不介入。
- **互动**：论坛、条目短评、收藏与私信。它只保存用户互动，不保存实体元数据。
- **存储**：物理文件与哈希、直传、绑定、下载与预览。它**不保存**目录结构（不复制作品/专辑/曲目表），
  目录**不保存**对象存储物理路径。

## 读写的鉴权口径

- **读端点匿名可访问**：definitions、entities、tags、shelves、feed、exchange 快照这些读接口不带令牌也返回 200；
  但**草稿仍按调用者身份过滤**——匿名只看得到已发布内容，带上令牌才看得到自己有权限的草稿。
- **写端点无令牌一律 401**：不带 `Authorization` 调写接口返回 `401 authentication_required`，没有匿名写入。
- **会话 / OAuth 令牌无效时读接口不报 401**（按匿名处理，仍是 200）：所以"读接口调得通"证明不了令牌有效。
  要确认令牌，看写接口是否放行、或看同一实体带上令牌能不能读到草稿，别把读接口的 200 当登录凭证。
- **PAT（`Authorization: Bearer mfp_…`）不适用上一条**：下游服务（目录 / 互动 / 存储共用这份契约）看到 `mfp_` 前缀
  就交给账号服务内省判定，无效 / 已吊销 / 已过期 / 账号被封禁一律 `401 invalid_token`（**读端点也返回 401**，
  不会按匿名继续）；账号服务不可达（或该服务没配 `AUTH_URL`）回 `503 auth_unavailable`——那是依赖故障，
  退避重试，别当凭据问题去换令牌。
  若某个服务返回的是 `401 authentication_required` 或读端点 200，说明该实例还没部署到 PAT 这一版（`mfp_` 被当成
  普通验签失败的令牌）——先怀疑部署进度，不要据此改令牌或改载荷。
  有效 PAT 的身份形状与会话令牌相同，但**权限只来自「账号现时权限 ∩ 令牌 scopes」**，不按角色兜底：
  scopes 为空或不够时，权限码闸门一律 `403 forbidden`（不是 401）。

## 判定与引用规则

- 判定"实体是否存在 / 是否可见"必须问目录：`GET /api/catalog/entities/{id}`；取关系邻居用
  `GET /api/catalog/entities/{id}/relations`。非 200 一律按"不存在"处理。
- 不要自己维护"实体是否存在/是否可见"的台账（本地清单、缓存、派生表都算）：判定口径只有目录一处，
  缓存会让判断与真实状态分叉。
- 实体合并会改写引用：裸 UUID 引用先用 `GET /api/catalog/entities/{id}/resolve` 解析当前身份，
  不要假定 ID 永久有效；写入前重新解析，不要信本地缓存。
- 调用时带现有凭据，长期 Agent 通常使用 PAT；本机可从已忽略的 `local/credentials.json` 读取，令牌值不进入输出。
  正常本地调用无需轮换。排错时区分 `401 invalid_token`（凭据无效）、`403 forbidden`（权限不足）与 `503 auth_unavailable`（账号服务不可达）；PAT 吊销在目录侧最长 60 秒生效。

## 与编目有关的三条判据

1. 编目写入只走 `/api/catalog/*`（实体）与 `/api/importer/*`（导入预览），其余前缀不属于编目写入：
   `/api/exchange/*` 是快照导出与外部提案，`/api/admin/catalog-definitions|shelves|external-databases` 是定义 / 货架 / 外部库管理。
2. 需要"这个实体存不存在 / 能不能看到"时调用目录的实体读接口，不要另建本地台账或复制一份。
3. 需要给文件登记用途时走存储接口（见 [文件上传与绑定](reference-file-upload.md)）：
   哈希、对象键与下载地址都不进实体题名或动态字段。
