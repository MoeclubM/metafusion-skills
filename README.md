# MetaFusion Skills — 给 Agent 的站点数据操作指南

本仓库收录 **AI Agent 浏览与修改 MetaFusion 站点数据的技能**：怎么查、怎么写、写完怎么核验，
以及写库被拒时怎么改，供支持 Skills 规范的 Agent（Cursor / ZCode / Claude Code 等）复用。

**这里不是开发文档**：代码结构、数据库结构、部署与切流、各服务实现细节都不在本仓库——
它们属于主仓库 [MetaFusion](https://github.com/MoeclubM/MetaFusion) 的 `AGENTS.md` 与 `docs/`。
面向外部开发者的 REST API 文档、面向用户与社区的项目介绍在 [metafusion-docs](https://github.com/MoeclubM/metafusion-docs)。

## 技能清单

| 技能 | 路径 | 说明 |
|---|---|---|
| **metafusion-curator** | [`skills/metafusion-curator/`](skills/metafusion-curator/SKILL.md) | 站点数据的读写与审查总则：查重（含 `types`）、层级归属、关系审查、封面、多语言、证据与写后核验；附本地凭据与单一通用客户端、API 行为、错误码、接口归属、文件上传、数据模型、类型码与字段白名单（`reference-types-and-fields.md`）、关系码全表（`reference-relations.md`）、模型缺口清单（`reference-model-gaps.md`）参考。 |
| **lrm-catalog-standards** | [`skills/lrm-catalog-standards/`](skills/lrm-catalog-standards/SKILL.md) | MetaFusion LRM 编目与发行版命名规范：按当前 Agent / Collection / Work / ContentUnit / Expression / Release / Medium / Track 边界处理跨媒介实体与发行版命名。 |

两个技能互为补充：`metafusion-curator` 是数据操作与审查总则，`lrm-catalog-standards` 是发行版命名与内容复用的细分规范。
两者都引用 `reference-api-behavior.md`；与实例响应不一致时以实例为准。

## 契约基线

- 统一入口是 `/api`，**没有 `/api/v1`、`/api/v2` 版本前缀**；实体写入统一走 `POST|PUT /api/catalog/entities`，关系走 `/api/catalog/relations`。
- 固定实体骨架为八类：`agent` / `collection` / `work` / `content_unit` / `expression` / `release` / `medium` / `track`；`attributes` 的可写字段 = 实体 `types` 的字段并集，不声明类型就只能写空 `attributes`。
- 发布是 PUT 写 `status: "published"`；lifecycle 只做合并与停用（body 无 `action`），**退回走专属下架端点** `POST /api/catalog/entities/{id}/unpublish`（权限 `catalog.lifecycle.manage`，`published → draft`，体 `{expected_version, edit_note, sources}`）；关系码共 29 条，方向与属性以 `reference-relations.md` 为准。
- 哪些前缀属于编目、哪些不属于：见 [接口归属与写入范围](skills/metafusion-curator/reference-endpoint-scope.md)。
- 文件怎么传、怎么挂到实体上：见 [文件上传与绑定](skills/metafusion-curator/reference-file-upload.md)。
- 写库被拒怎么办：见 [API 错误码与修复动作](skills/metafusion-curator/reference-api-errors.md)。

## 安装方式

将技能目录整体复制到 Agent 的技能目录即可：

```bash
# Cursor / 主仓库约定位置（.cursor/skills/）
git clone https://github.com/MoeclubM/metafusion-skills.git
cp -r metafusion-skills/skills/metafusion-curator     <your-repo>/.cursor/skills/
cp -r metafusion-skills/skills/lrm-catalog-standards  <your-repo>/.cursor/skills/
```

其他 Agent 平台请复制到对应技能目录（如 ZCode 的 `~/.agents/skills/`、Claude Code 的 `.claude/skills/`）。两个技能建议同时安装：`lrm-catalog-standards` 内部以相对路径引用 `metafusion-curator`。

`metafusion-curator/local/` 包含通用 API 客户端；复制技能后创建已忽略的 `credentials.json` 即可，令牌不要提交。

## 许可、来源与编目边界

技能内容以**目标实例的实际响应**为准校准：接口行为、枚举与字段码都会随实例配置演进，
动手前先读 `GET /api/openapi.json` 与 `GET /api/catalog/definitions`。
编目事实优先核对出版/发行/制作/权利方等一手来源；逐条写清引文所支持的字段，
未知、冲突或未核实内容必须留空并标注，不猜测或编造。封面优先权利方提供的高清原图，并核实许可/授权；
来源链接不自动授予图片使用权，权利不明时不使用。
