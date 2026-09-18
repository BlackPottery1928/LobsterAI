# 政党机关公文排版助手 1.0.0

这是一个独立重构的公文排版 Skill，目标是把“公文标准排版、政务材料版式、现有 DOCX 重排、自动验收”整合到统一工作流中。

## 目录

- `SKILL.md`：Skill 主规则
- `scripts/official_doc.py`：DOCX 生成引擎
- `scripts/doc_guard.py`：输出检查器
- `references/`：标准、文种、版式与质量知识
- `tests/`：冒烟测试

依赖：
- Python 3.10+
- python-docx
