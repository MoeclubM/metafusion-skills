# MetaFusion Skills — 编目标准技能集

本仓库收录 MetaFusion 项目的 **AI Agent 编目标准技能（Agent Skills）**，已从 [MetaFusion 主仓库](https://github.com/MoeclubM/MetaFusion) 的 `.cursor/skills/` 迁移独立托管，供各类支持 Skills 规范的 Agent（Cursor / ZCode / Claude 等）复用。

## 技能清单

| 技能 | 路径 | 说明 |
|---|---|---|
| **metafusion-curator** | [`skills/metafusion-curator/`](skills/metafusion-curator/SKILL.md) | MetaFusion 权威编目与元数据审查规范：覆盖纯题名、LRM 层级、同作品载体边界、关系审查、封面、i18n、证据与写后核验，并附子系统边界、存储契约与当前实现契约参考。 |
| **lrm-catalog-standards** | [`skills/lrm-catalog-standards/`](skills/lrm-catalog-standards/SKILL.md) | MetaFusion LRM 编目与发行版命名规范：按当前 Agent / Collection / Work / ContentUnit / Expression / Release / Medium / Track 边界处理跨媒介实体与发行版命名。 |

两个技能互为补充：`metafusion-curator` 是全站编目审查总则，`lrm-catalog-standards` 是与之同步互补的发行版命名细分规范。两者都引用 `reference-runtime-contract.md`，遇到目标实例差异时以实例 OpenAPI、已执行迁移和响应为准。

## 契约基线

- 统一入口是 `/api`，**没有 `/api/v1`、`/api/v2` 版本前缀**；实体写入统一走 `POST|PUT /api/catalog/entities`，关系走 `/api/catalog/relations`。
- 固定实体骨架为八类：`agent` / `collection` / `work` / `content_unit` / `expression` / `release` / `medium` / `track`。
- 子系统的路由归属与数据所有权见 [子系统边界](skills/metafusion-curator/reference-service-boundaries.md)（来源为主仓库 `docs/architecture/service-split-migration.md`）。
- 存储服务的文件契约见 [存储契约要点](skills/metafusion-curator/reference-storage-contract.md)。

## 安装方式

将技能目录整体复制到 Agent 的技能目录即可：

```bash
# Cursor / 主仓库约定位置（.cursor/skills/）
git clone https://github.com/MoeclubM/metafusion-skills.git
cp -r metafusion-skills/skills/metafusion-curator     <your-repo>/.cursor/skills/
cp -r metafusion-skills/skills/lrm-catalog-standards  <your-repo>/.cursor/skills/
```

其他 Agent 平台请复制到对应技能目录（如 ZCode 的 `~/.agents/skills/`、Claude Code 的 `.claude/skills/`）。两个技能建议同时安装：`lrm-catalog-standards` 内部以相对路径引用 `metafusion-curator`。

## 许可与来源

技能初始内容迁移自 MetaFusion 主仓库 `.cursor/skills/`；当前文档按主仓库运行时契约与各子系统服务实现持续校准，具体实例以其 OpenAPI、已执行迁移和响应为准。
