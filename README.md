# MetaFusion Skills — 给 Agent 的站点数据操作指南

本仓库收录 **AI Agent 浏览与修改 MetaFusion 站点数据的技能**：怎么查、怎么写、写完怎么核验，
以及写库被拒时怎么改，供支持 Skills 规范的 Agent（Cursor / ZCode / Claude Code 等）复用。

**这里不是开发文档**：代码结构、数据库结构、部署与切流、各服务实现细节都不在本仓库——
它们属于主仓库 [MetaFusion](https://github.com/MoeclubM/MetaFusion) 的 `AGENTS.md` 与 `docs/`。
面向外部开发者的 REST API 文档、面向用户与社区的项目介绍在 [metafusion-docs](https://github.com/MoeclubM/metafusion-docs)。

## 技能清单

| 技能 | 路径 | 说明 |
|---|---|---|
| **metafusion-curator** | [`skills/metafusion-curator/`](skills/metafusion-curator/SKILL.md) | 站点数据的读写与审查总则：按身份锚点、内容与父级作用域查重、层级归属、关系审查、封面、多语言、证据与写后核验；附本地凭据与单一通用客户端、API 行为、错误码、接口归属、文件上传、数据模型、字段适用层级与白名单（`reference-types-and-fields.md`）、关系码全表（`reference-relations.md`）、模型缺口清单（`reference-model-gaps.md`）参考。 |
| **lrm-catalog-standards** | [`skills/lrm-catalog-standards/`](skills/lrm-catalog-standards/SKILL.md) | MetaFusion LRM 编目与发行版命名规范：按当前 Agent / Collection / Work / ContentUnit / Expression / Release / Medium / Track 边界处理跨媒介实体与发行版命名。 |

两个技能互为补充：`metafusion-curator` 是数据操作与审查总则，`lrm-catalog-standards` 是发行版命名与内容复用的细分规范。
两者都引用 `reference-api-behavior.md`；与实例响应不一致时以实例为准。

## 参考资料的维护边界

技能入口负责选择流程，不重复维护完整码表；动态定义始终以目标实例当前生效结果为准。

| 内容 | 唯一维护入口 |
| --- | --- |
| API 载荷、校验与状态转换 | [API 行为](skills/metafusion-curator/reference-api-behavior.md)、[载荷示例](skills/metafusion-curator/reference-api-templates.md) |
| 创作与发行层级、跨媒介范式 | [数据模型](skills/metafusion-curator/reference-data-model.md) |
| 动态字段、适用层级与词表种子对照 | [字段与适用层级](skills/metafusion-curator/reference-types-and-fields.md) |
| 关系码、方向与端点种子对照 | [关系](skills/metafusion-curator/reference-relations.md) |
| 来源等级、当前版本与图片权利 | [来源策略](skills/metafusion-curator/reference-source-policy.md) |
| 系统归属、鉴权与引用判定 | [接口归属](skills/metafusion-curator/reference-endpoint-scope.md) |
| 文件上传、绑定与读取 | [文件上传](skills/metafusion-curator/reference-file-upload.md) |
| 错误处置与模型扩展 | [错误码](skills/metafusion-curator/reference-api-errors.md)、[模型缺口](skills/metafusion-curator/reference-model-gaps.md) |

改动共享事实时更新对应参考，质检页保留验收动作；不要在 README 或技能入口再维护关系数量和完整字段列表。

## 安装方式

将技能目录整体复制到 Agent 的技能目录即可：

```bash
# Cursor / 主仓库约定位置（.cursor/skills/）
git clone https://github.com/MoeclubM/metafusion-skills.git
cp -r metafusion-skills/skills/metafusion-curator     <your-repo>/.cursor/skills/
cp -r metafusion-skills/skills/lrm-catalog-standards  <your-repo>/.cursor/skills/
```

其他 Agent 平台请复制到对应技能目录（如 ZCode 的 `~/.agents/skills/`、Claude Code 的 `.claude/skills/`）。两个技能建议同时安装：`lrm-catalog-standards` 内部以相对路径引用 `metafusion-curator`。

`metafusion-curator/local/` 包含通用 API 客户端；安装和更新只复制版本库中的技能文件，不复制本机 `credentials.json`、审计产物或忽略文件。两个技能保持同一源仓修订并同级安装，避免相对引用断裂；凭据单独在目标环境创建并保持忽略。

## 许可、来源与编目边界

动手前读取目标实例的 OpenAPI 与当前生效 definitions；实例差异不能靠修改文案掩盖。核心字段、合并资格、当前修订、封面来源与使用权统一采用 [字段级来源与权利策略](skills/metafusion-curator/reference-source-policy.md)，不在安装页另维护一份门槛。
