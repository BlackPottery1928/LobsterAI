# 构图骨架规划

本参考只用于用户已经明确选择空间骨架的请求。OutlineIntent 是顶层意图约束，不是完整节点图，也不是让 Skill 猜测业务关系的规划器。

## 何时使用

- `layered`：用户明确要分层呈现。通常用 `guided`；只有用户指定完整行列时才用 `locked`。
- `three_lane`：用户明确要三栏，或中央主链配固定左右侧轨。固定侧轨用 `locked`，三栏必须分别占第 1、2、3 列并共享同一行跨度。
- `stage_grid`：用户明确要多行阶段网格。明确 2×2、同行、同列或 row-major 时用 `locked`，仅要求紧凑分阶段时用 `guided`。

普通容器分组、普通单轴流程，以及仅仅“内容复杂、节点很多、文字很长”时不要创建 OutlineIntent。`guided` 保留分区身份和顺序，允许后端紧凑调整；`locked` 保留用户明确指定的完整顶层 Grid。

## v1 最小合同

将 JSON 保存到工作区内，例如 `.cw_skill/requests/outline_<timestamp>.json`，再向生成命令传入其绝对路径 `--outline_file`。

```json
{
  "outline_intent_version": 1,
  "focus": "一句话说明读者必须看见的重点",
  "layout_policy": {
    "preset": "layered",
    "grid_mode": "guided"
  },
  "edge_policy": {
    "mode": "sparse_semantic",
    "focus": ["main_backbone", "explicit_dependencies"],
    "preferred_range": [2, 5],
    "inferred_scope": "local_only"
  },
  "content": [
    {
      "item_name": "application",
      "label": "应用层",
      "type": "grid",
      "grid-rows": "[1]",
      "grid-columns": "[1]",
      "content_generation_prompt": "只填充用户原文明确列出的应用层内容"
    }
  ],
  "global_relationships": []
}
```

约束：

- `preset` 仅为 `layered`、`three_lane`、`stage_grid` 或 `auto`；Skill 主动生成时使用前三种明确骨架。
- `grid_mode` 仅为 `guided` 或 `locked`。
- `edge_policy.mode` 仅为 `sparse_semantic`、`ordered_flow` 或 `explicit_only`，默认优先 `sparse_semantic`；`inferred_scope` 只用 `local_only`。
- `item_name` 与关系端点使用唯一 ASCII ID（字母或下划线开头，之后可含数字、`_`、`-`）；Grid 为升序正整数列表，各顶层分区不能占用同一单元格。
- `global_relationships` 只放用户明确表达且必须保留的跨区事实。每项使用 `from`、`to`、可选 `label`、必填 `evidence_quote`、可选 `kind`；端点必须引用 `content.item_name`。
- `evidence_quote` 必须是 `# Request` 中可逐字定位的原文。层级顺序、空间相邻、同属容器都不是关系证据。
- 连线是稀缺资源。不要把分层顺序自动补成 N-1 调用链，不要让通用支撑组件向所有层 fan-out；侧轨说明卡默认不挂边。
- `preferred_range` 是软目标，不能删除用户明确关系；没有证据的关系不要为了凑边数而创建。

## 三个短例子

- `6b` 分层架构：选 `layered + guided + sparse_semantic`。七个语义层各自成为顶层分区；保留原文明示的 clients → gateway → application → service → infra 主干，以及 Application/Service → Starter 两条集成关系。Nacos/Redis 的通用支撑描述留在来源分区，不扩散成多条边。
- `e9` 中央主链与左右说明：选 `three_lane + locked + explicit_only`。左侧说明、中央 13 步主链、右侧风险规则各占一列；说明卡不挂边，真实风险与否定条件保留为文字，不能添加 `phase_*`、`risk_group_*` 等技术包装分区。
- `670` 四阶段 2×2：选 `stage_grid + locked`，四个阶段按 row-major 占 `[1]/[1]`、`[1]/[2]`、`[2]/[1]`、`[2]/[2]`。只有用户明确声明阶段顺序时才用 `ordered_flow`；Allen 分支与安全限定按原文保留。
