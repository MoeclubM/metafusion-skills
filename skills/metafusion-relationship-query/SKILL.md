---
name: metafusion-relationship-query
description: 通过 MetaFusion 只读 API 查询作品、表达、发行、载体、曲目及人员的直接关系，批量筛选正反方向、动态关系码和对端层级。用于回答内容归属、发行收录、版本组或署名关联问题，不执行编目写入。
---

# MetaFusion 实体关系查询

使用用户指定的实例。先明确实体身份与查询范围；题名有歧义时通过 `GET /api/catalog/entities` 找候选，再核对 kind、外部标识与所属关系，不把同名候选直接当作目标。实例端点与参数以 `GET /api/openapi.json` 为准。

## 查询

内置 [查询脚本](scripts/query_relationships.py) 只读 HTTP，使用 Python 3 标准库。`--base-url` 是实例根地址；公开查询无需凭据，需要读取授权可见内容时从环境变量 `MF_API_TOKEN` 取 Bearer 凭据，不打印或写入技能文件。

```bash
python scripts/query_relationships.py --base-url https://findverse.cc --rules
python scripts/query_relationships.py --base-url https://findverse.cc \
  --id <release-uuid> --direction outgoing --peer-kind medium --limit 25
```

`--rules` 读取当前 definitions 的 `relationship_rules`，包含多语言正反向名称、端点 kind、只读标记和启用状态。`--rule-code` 使用这里的完整 code；`structure:` 为固定事实投影，`relation:` 为 GUI 扩展的语义关系。不要从显示名猜码，也不要把读取到的停用历史关系当作可写规则。

普通查询调用 `POST /api/catalog/relationships/query`，只是查询，不创建关系。`--id`、`--rule-code`、`--peer-kind` 均可重复；一次最多 20 个主体，方向为 `both`（默认）、`outgoing`、`incoming`。`peer-kind` 过滤相对于主体的另一端。每个主体独立分页，limit 默认 25、最大 100；offset 默认 0、最大 10000。完整载荷与响应以目标实例 OpenAPI 为准。

结果中的 `pages` 按主体给出直接关系及 `has_more`，`entities` 为去重后的可见端点摘要表（id、kind、version、title、original_language、translations），不能作为完整实体编辑载荷；`definition_etag` 标记本次规则版本。方向是相对于 `subject_id` 的方向；事实始终为 `source_id → target_id`。规则的反向显示名不改变边方向。`unavailable_ids` 合并表示不存在与当前不可见，不能解释为实体已删除。

当某主体 `has_more=true` 时，以相同筛选和该主体 ID 继续查询，offset 增加本页 limit。多页调用不共享数据库快照，需声明读取时间与范围；未遍历的页不能被当成没有关系。每次查询只读一跳，需要继续追踪时由任务决定下一批 ID，并保留已访问集合、请求/页数预算与停止条件。

## 常见问题的路径

- **一个发行包含哪些介质**：Release 向外查询 Medium；需要完整碟序、曲序和内容时使用 `GET /api/catalog/releases/{id}/toc`。
- **一首表达在哪些曲目中出现**：Expression 向内查询 Track，再以 Track 向内查询 Medium、Medium 向内查询 Release，三步均使用 `incoming`；事实边分别为 Track → Expression、Medium → Track、Release → Medium。Work 的 `release_subject` 表示发行声明了这个作品，不能证明某个具体录音被收录；完整跨发行收录可用 `GET /api/catalog/entities/{id}/occurrences`。
- **小说的章节**：Work 向外查询 ContentUnit 得到全篇目；层级章节再使用当前 `content_unit_parent` 规则查直接子项。位置不等于全树阅读顺序。
- **普通版、限定版与地区版**：优先使用 `GET /api/catalog/releases/{id}/editions`。需要筛选语义边时，从完整 definitions.document.relations 中用途为 `release_group` 的定义确定码，再匹配注册表中的 `relation:` 码；`--rules` 输出不包含用途字段。共同 subjects 不能单独证明同一版本组。
- **作者、演员与创作关联**：先从运行时规则中选贴切的 `relation:` 码，再按方向和 Agent / Work / Expression 等对端层级筛选。上下文属性参与事实含义，不能只保留对端名字。

回答保留实体 ID、kind、边方向、规则码与相关位置/角色/定位，说明分页、可见性和尚未追踪的范围。只读结构 key 不可当作可写关系 UUID；本技能不将推断关系落库。

## 失败处理

400：按当前 OpenAPI 修正参数或运行时规则码。401/403：检查已有凭据与权限，不能作为“无关系”。404：确认实例是否提供本查询端点，不把未升级当成空结果。429：遵循 `Retry-After`，设定有限重试预算；5xx 或网络错误报告查询未完成，不自行无限重试。脚本不自动重放请求。
