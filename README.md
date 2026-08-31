# MetaFusion Skills — 编目标准技能集

本仓库收录 MetaFusion 项目的 **AI Agent 编目标准技能（Agent Skills）**，已从 [MetaFusion 主仓库](https://github.com/MoeclubM/MetaFusion) 的 `.cursor/skills/` 迁移独立托管，供各类支持 Skills 规范的 Agent（Cursor / ZCode / Claude 等）复用。

## 技能清单

| 技能 | 路径 | 说明 |
|---|---|---|
| **metafusion-curator** | [`skills/metafusion-curator/`](skills/metafusion-curator/SKILL.md) | MetaFusion 权威编目与元数据审查规范：实体编目操作技能，涵盖纯标题铁律、IFLA LRM 五层实体模型、多源导入、发行层级、关系 DAG 拓扑、封面画幅、i18n 回退链与不可篡改审计流（含 4 份 reference 附属文档）。 |
| **lrm-catalog-standards** | [`skills/lrm-catalog-standards/`](skills/lrm-catalog-standards/SKILL.md) | MetaFusion LRM 编目与发行版（Release）命名规范：基于 IFLA LRM 与 MusicBrainz 体系的跨媒介实体结构与发行版命名细分领域标准。 |

两个技能互为补充：`metafusion-curator` 是全站编目审查总则，`lrm-catalog-standards` 是与之同步互补的发行版命名细分规范（其 SKILL.md 内含指向前者的相对链接）。

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

内容原样迁移自 MetaFusion 主仓库 `.cursor/skills/`，遵循主仓库相应约定。
