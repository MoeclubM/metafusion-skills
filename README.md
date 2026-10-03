# MetaFusion Skills

MetaFusion 目录数据技能；实现与部署见 [主仓库](https://github.com/MoeclubM/MetaFusion)，公共 API 文档见 [metafusion-docs](https://github.com/MoeclubM/metafusion-docs)。

| 技能 | 用途 |
| --- | --- |
| [metafusion-curator](skills/metafusion-curator/SKILL.md) | 编目、查重、来源检索与目录读写 |
| [lrm-catalog-standards](skills/lrm-catalog-standards/SKILL.md) | 实体层级、命名与表达复用 |
| [metafusion-relationship-query](skills/metafusion-relationship-query/SKILL.md) | 只读批量关系查询 |

## 使用

复制技能目录到 Agent 的技能目录。`lrm-catalog-standards` 与 `metafusion-curator` 同级安装、保持同一修订；关系查询技能可独立安装。只复制版本库文件，不复制本机凭据或审计产物。

- [工具与命令](skills/metafusion-curator/local/tools/README.md)
- [来源支持与凭据](skills/metafusion-curator/local/tools/README-providers.md)
- [API 载荷](skills/metafusion-curator/reference-api-templates.md) · [运行契约](skills/metafusion-curator/reference-api-behavior.md)

命令参数维护在工具 `help/schema`；其余参考按技能入口选择，不重复维护码表。
