"""
政党机关公文排版助手 - 文档引擎
依赖：python-docx
"""

from __future__ import annotations
import re
from copy import deepcopy
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Iterable, Optional

from docx import Document
from docx.enum.section import WD_SECTION_START
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, Mm, RGBColor, Cm


PT_14 = Pt(14)
PT_16 = Pt(16)
PT_22 = Pt(22)
PT_28 = Pt(28)

FONT_MAP = {
    "标题": ("方正小标宋简体", "FZXiaoBiaoSong-B05S"),
    "仿宋": ("仿宋_GB2312", "FangSong"),
    "黑体": ("黑体", "SimHei"),
    "楷体": ("楷体_GB2312", "KaiTi"),
    "宋体": ("宋体", "SimSun"),
}

PROFILE_NAMES = {
    "official": "标准公文",
    "red": "红头公文",
    "red_space": "空红头",
    "letterhead": "信函格式",
    "order": "命令格式",
    "minutes": "纪要格式",
    "briefing": "政务材料",
    "policy": "制度方案",
    "meeting": "会议材料",
    "minimal": "极简行政",
}

DOC_TYPE_ENDINGS = {
    "通知": "特此通知。",
    "报告": "特此报告。",
    "请示": "妥否，请批示。",
    "批复": "此复。",
    "通报": "特此通报。",
    "公告": "特此公告。",
    "通告": "特此通告。",
    "函": "特此函达。",
    "议案": "请予审议。",
}

@dataclass
class BuildReport:
    output: str
    profile: str
    document_type: str | None
    issues: list[str]
    warnings: list[str]
    repaired: list[str]


def set_run_font(run, font_key: str = "仿宋", size: Optional[float] = 16,
                  bold: bool = False, color: Optional[RGBColor] = None):
    name, fallback = FONT_MAP.get(font_key, (font_key, font_key))
    run.font.name = name
    run.font.size = Pt(size) if isinstance(size, (int, float)) else size
    run.bold = bold
    if color:
        run.font.color.rgb = color
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.rFonts
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    for attr, val in [("ascii", "Times New Roman"), ("hAnsi", "Times New Roman"),
                      ("eastAsia", name), ("cs", name)]:
        rfonts.set(qn(f"w:{attr}"), val)
    return run


def format_paragraph(p, line=28, first_chars=200, align=None, before=0, after=0):
    pf = p.paragraph_format
    pf.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    pf.line_spacing = Pt(line)
    pf.space_before = Pt(before)
    pf.space_after = Pt(after)
    if align is not None:
        p.alignment = align
    if first_chars is not None:
        pPr = p._p.get_or_add_pPr()
        ind = pPr.find(qn("w:ind"))
        if ind is None:
            ind = OxmlElement("w:ind")
            pPr.append(ind)
        ind.set(qn("w:firstLineChars"), str(first_chars))
    return p


def configure_page(section):
    section.page_width = Mm(210)
    section.page_height = Mm(297)
    section.top_margin = Mm(37)
    section.bottom_margin = Mm(35)
    section.left_margin = Mm(28)
    section.right_margin = Mm(26)
    section.header_distance = Mm(15)
    section.footer_distance = Mm(8)


def strip_leading_tabs(text: str) -> str:
    return re.sub(r"^[ \t]+", "", text)


def normalize_text(text: str) -> str:
    text = text.replace("\u00a0", " ")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("“", "“").replace("”", "”")
    text = re.sub(r"[ \t]+$", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def detect_level(text: str) -> int:
    t = text.strip()
    if re.match(r"^[一二三四五六七八九十百]+、", t):
        return 1
    if re.match(r"^（[一二三四五六七八九十]+）", t):
        return 2
    if re.match(r"^\d+[.．、]\s*", t):
        return 3
    if re.match(r"^（\d+）", t) or re.match(r"^⑴", t):
        return 4
    return 0


def paragraph_has_drawing(p) -> bool:
    xml = p._p.xml
    return "w:drawing" in xml or "w:pict" in xml or "a:blip" in xml


def set_page_number(section, first_page=True):
    section.even_and_odd_headers = True
    section.different_first_page_header_footer = not first_page
    _ensure_footer_ref(section, "default")
    _ensure_footer_ref(section, "even")
    _ensure_update_fields(section.part.document)

    for footer, align in ((section.footer, WD_ALIGN_PARAGRAPH.RIGHT),
                          (section.even_page_footer, WD_ALIGN_PARAGRAPH.LEFT)):
        footer.is_linked_to_previous = False
        p = footer.paragraphs[0]
        p.clear()
        p.alignment = align
        format_paragraph(p, line=14, first_chars=0)
        r = p.add_run("— ")
        set_run_font(r, "宋体", 14)
        fld = OxmlElement("w:fldSimple")
        fld.set(qn("w:instr"), "PAGE")
        p._p.append(fld)
        r2 = p.add_run(" —")
        set_run_font(r2, "宋体", 14)

    if not first_page:
        f = section.first_page_footer
        f.is_linked_to_previous = False
        f.paragraphs[0].clear()


def _ensure_footer_ref(section, typ):
    sectPr = section._sectPr
    for ref in sectPr.findall(qn("w:footerReference")):
        if ref.get(qn("w:type")) == typ:
            return
    footer = {"default": section.footer, "even": section.even_page_footer,
              "first": section.first_page_footer}.get(typ)
    if footer is None:
        return
    rid = section.part.relate_to(footer.part, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer")
    ref = OxmlElement("w:footerReference")
    ref.set(qn("w:type"), typ)
    ref.set(qn("r:id"), rid)
    sectPr.append(ref)


def _ensure_update_fields(doc):
    settings = doc.settings.element
    node = settings.find(qn("w:updateFields"))
    if node is None:
        node = OxmlElement("w:updateFields")
        settings.append(node)
    node.set(qn("w:val"), "true")


def add_title(doc, text):
    p = doc.add_paragraph()
    format_paragraph(p, line=32, first_chars=0, align=WD_ALIGN_PARAGRAPH.CENTER)
    r = p.add_run(text.strip())
    set_run_font(r, "标题", 22)
    return p


def add_body_paragraph(doc, text):
    p = doc.add_paragraph()
    format_paragraph(p, line=28, first_chars=200, align=WD_ALIGN_PARAGRAPH.LEFT)
    r = p.add_run(text.strip())
    set_run_font(r, "仿宋", 16)
    return p


def add_level(doc, text, level):
    p = doc.add_paragraph()
    format_paragraph(p, line=28, first_chars=0 if level >= 3 else 200)
    font = {1: "黑体", 2: "楷体", 3: "仿宋", 4: "仿宋"}.get(level, "仿宋")
    r = p.add_run(text.strip())
    set_run_font(r, font, 16, bold=(level == 3 and False))
    return p


def add_redhead(doc, issuer=None, doc_number=None, signer=None,
                copies=None, secret=None, urgency=None, profile="red"):
    p = doc.add_paragraph()
    format_paragraph(p, line=28, first_chars=0, align=WD_ALIGN_PARAGRAPH.CENTER)
    if profile == "red_space":
        r = p.add_run(" ")
        set_run_font(r, "标题", 22, color=RGBColor(255, 0, 0))
    else:
        r = p.add_run(issuer or "")
        set_run_font(r, "标题", 22, color=RGBColor(255, 0, 0))
    # 红色分隔线
    p2 = doc.add_paragraph()
    format_paragraph(p2, line=8, first_chars=0)
    pPr = p2._p.get_or_add_pPr()
    pBdr = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single"); bottom.set(qn("w:sz"), "12"); bottom.set(qn("w:space"), "1")
    bottom.set(qn("w:color"), "FF0000")
    pBdr.append(bottom); pPr.append(pBdr)

    if any([copies, secret, urgency]):
        meta = []
        if copies: meta.append(f"份号：{copies}")
        if secret: meta.append(secret)
        if urgency: meta.append(urgency)
        p3 = doc.add_paragraph()
        format_paragraph(p3, line=20, first_chars=0)
        set_run_font(p3.add_run("    ".join(meta)), "仿宋", 14)

    if doc_number or signer:
        p4 = doc.add_paragraph()
        format_paragraph(p4, line=28, first_chars=0)
        if doc_number:
            set_run_font(p4.add_run(doc_number), "仿宋", 16)
        if signer:
            # 使用右对齐制表位，避免空格硬对齐
            section = doc.sections[0]
            width = section.page_width - section.left_margin - section.right_margin
            p4.paragraph_format.tab_stops.add_tab_stop(width, WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.SPACES)
            set_run_font(p4.add_run("\t签发人：" + signer), "仿宋", 16)
    return p


def add_recipient(doc, recipient):
    p = doc.add_paragraph()
    format_paragraph(p, line=28, first_chars=0)
    text = recipient.strip()
    if text and not text.endswith(("：", ":")):
        text += "："
    set_run_font(p.add_run(text), "仿宋", 16)
    return p


def add_footer_page(doc, cc=None, print_office=None, print_date=None):
    sec = doc.add_section(WD_SECTION_START.NEW_PAGE)
    configure_page(sec)
    # 解除之前节的链接，清理页码继承
    for f in (sec.footer, sec.even_page_footer, sec.first_page_footer, sec.header):
        f.is_linked_to_previous = False
        for p in f.paragraphs:
            p.clear()

    # 把版记推到底部
    sectPr = sec._sectPr
    v = OxmlElement("w:vAlign"); v.set(qn("w:val"), "bottom"); sectPr.append(v)

    line_top = sec._document.part.document.element.body.add_paragraph() if False else doc.add_paragraph()
    pPr = line_top._p.get_or_add_pPr()
    pBdr = OxmlElement("w:pBdr"); bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single"); bottom.set(qn("w:sz"), "4"); bottom.set(qn("w:space"), "1"); bottom.set(qn("w:color"), "000000")
    pBdr.append(bottom); pPr.append(pBdr)
    format_paragraph(line_top, line=10, first_chars=0)

    if cc:
        p = doc.add_paragraph(); format_paragraph(p, line=28, first_chars=0)
        set_run_font(p.add_run("抄送：" + cc), "仿宋", 14)

    if print_office or print_date:
        p = doc.add_paragraph()
        format_paragraph(p, line=28, first_chars=0)
        pf = p.paragraph_format
        width = sec.page_width - sec.left_margin - sec.right_margin - Pt(14)
        pf.tab_stops.add_tab_stop(width, WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.SPACES)
        if print_office:
            set_run_font(p.add_run(print_office), "仿宋", 14)
        if print_date:
            if print_office:
                set_run_font(p.add_run("\t" + normalize_date(print_date) + "印发"), "仿宋", 14)
            else:
                set_run_font(p.add_run(normalize_date(print_date) + "印发"), "仿宋", 14)

    line_bottom = doc.add_paragraph()
    format_paragraph(line_bottom, line=10, first_chars=0)
    pPr = line_bottom._p.get_or_add_pPr()
    pBdr = OxmlElement("w:pBdr"); top = OxmlElement("w:top")
    top.set(qn("w:val"), "single"); top.set(qn("w:sz"), "4"); top.set(qn("w:space"), "1"); top.set(qn("w:color"), "000000")
    pBdr.append(top); pPr.append(pBdr)
    return sec


def normalize_date(s: str) -> str:
    if not s:
        return ""
    m = re.match(r"^\s*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\s*$", s)
    if m:
        y, mo, d = m.groups()
        return f"{y}年{int(mo)}月{int(d)}日"
    return s


def add_signature(doc, author=None, date_str=None, seal=False):
    if author:
        p = doc.add_paragraph(); format_paragraph(p, line=28, first_chars=0, align=WD_ALIGN_PARAGRAPH.RIGHT)
        p.paragraph_format.right_indent = Mm(13)
        set_run_font(p.add_run(author), "仿宋", 16)
    if date_str:
        p = doc.add_paragraph(); format_paragraph(p, line=28, first_chars=0, align=WD_ALIGN_PARAGRAPH.RIGHT)
        p.paragraph_format.right_indent = Mm(13)
        set_run_font(p.add_run(normalize_date(date_str)), "仿宋", 16)
    if seal:
        p = doc.add_paragraph(); format_paragraph(p, line=10, first_chars=0, align=WD_ALIGN_PARAGRAPH.RIGHT)
        p.paragraph_format.right_indent = Mm(20)
        set_run_font(p.add_run("〔印章位置〕"), "仿宋", 10, color=RGBColor(128,128,128))


def add_attachment_note(doc, text):
    p = doc.add_paragraph(); format_paragraph(p, line=28, first_chars=0)
    set_run_font(p.add_run("附件：" + text.strip()), "仿宋", 16)


def add_body_from_lines(doc, lines):
    pending = []
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        lvl = detect_level(line)
        if lvl:
            add_level(doc, line, lvl)
        elif line.startswith(("附件：", "附：")):
            add_attachment_note(doc, line.split("：", 1)[-1])
        else:
            add_body_paragraph(doc, line)


def load_lines(input_path: str) -> list[str]:
    p = Path(input_path)
    if p.suffix.lower() == ".docx":
        d = Document(str(p))
        result = []
        for para in d.paragraphs:
            result.append(para.text)
        return result
    text = p.read_text(encoding="utf-8", errors="replace")
    text = normalize_text(text)
    if p.suffix.lower() == ".md":
        text = re.sub(r"^#{1,6}\s*", "", text, flags=re.M)
        text = re.sub(r"\*\*(.*?)\*\*", r"\1", text)
    return text.splitlines()


def build_document(input_path: str, output_path: str, profile="official",
                   document_type: str | None = None, title: str | None = None,
                   issuer: str | None = None, doc_number: str | None = None,
                   recipient: str | None = None, author: str | None = None,
                   date_str: str | None = None, signer: str | None = None,
                   copies: str | None = None, secret: str | None = None,
                   urgency: str | None = None, notes: list[str] | None = None,
                   cc: str | None = None, print_office: str | None = None,
                   print_date: str | None = None, seal: bool = False):
    lines = load_lines(input_path)
    if not title:
        for x in lines:
            if x.strip():
                title = x.strip()
                break
    title = title or "未命名公文"

    doc = Document()
    sec = doc.sections[0]
    configure_page(sec)

    if profile in ("red", "red_space"):
        add_redhead(doc, issuer, doc_number, signer, copies, secret, urgency, profile)
    else:
        if doc_number or signer:
            p = doc.add_paragraph(); format_paragraph(p, line=28, first_chars=0)
            set_run_font(p.add_run(doc_number or ""), "仿宋", 16)
            if signer:
                set_run_font(p.add_run("\t签发人：" + signer), "仿宋", 16)

    add_title(doc, title)

    if recipient:
        add_recipient(doc, recipient)

    add_body_from_lines(doc, lines)

    if notes:
        for n in notes:
            p = doc.add_paragraph(); format_paragraph(p, line=28, first_chars=0)
            set_run_font(p.add_run("（" + n.strip("（）()") + "）"), "仿宋", 14)

    if author or date_str:
        add_signature(doc, author, date_str or date.today().strftime("%Y年%-m月%-d日"), seal)

    if cc or print_office or print_date:
        add_footer_page(doc, cc, print_office, print_date)

    set_page_number(doc.sections[0], first_page=(profile not in ("red", "red_space")))
    doc.save(output_path)
    return BuildReport(output_path, profile, document_type, [], [], [])


def reformat_existing_docx(input_path: str, output_path: str, profile="official",
                           title_override: str | None = None):
    """在原 DOCX 上做最小侵入式重排；图片/表格所在段落不重建。"""
    doc = Document(input_path)
    for sec in doc.sections:
        configure_page(sec)

    # 保留已有对象，只调整纯文本段落
    first_text_seen = False
    for p in doc.paragraphs:
        text = p.text.strip()
        if not text:
            continue
        if paragraph_has_drawing(p):
            continue
        # 清理首尾控制字符，但保留正文内容
        if title_override and not first_text_seen:
            text = title_override
            for r in list(p.runs):
                r.text = ""
            p.add_run(text)
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            format_paragraph(p, line=32, first_chars=0, align=WD_ALIGN_PARAGRAPH.CENTER)
            for r in p.runs:
                set_run_font(r, "标题", 22)
            first_text_seen = True
            continue
        if not first_text_seen:
            first_text_seen = True
            format_paragraph(p, line=32, first_chars=0, align=WD_ALIGN_PARAGRAPH.CENTER)
            for r in p.runs:
                set_run_font(r, "标题", 22)
            continue
        lvl = detect_level(text)
        if lvl:
            format_paragraph(p, line=28, first_chars=0 if lvl >= 3 else 200)
            font = {1:"黑体", 2:"楷体", 3:"仿宋", 4:"仿宋"}[lvl]
            for r in p.runs:
                set_run_font(r, font, 16)
        else:
            format_paragraph(p, line=28, first_chars=200, align=WD_ALIGN_PARAGRAPH.LEFT)
            for r in p.runs:
                set_run_font(r, "仿宋", 16)

    set_page_number(doc.sections[0], first_page=(profile not in ("red", "red_space")))
    doc.save(output_path)
    return BuildReport(output_path, profile, None, [], [], [])


def cli():
    import argparse
    ap = argparse.ArgumentParser(description="政党机关公文排版助手")
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--profile", choices=list(PROFILE_NAMES), default="official")
    ap.add_argument("--type", dest="document_type")
    ap.add_argument("--title")
    ap.add_argument("--issuer")
    ap.add_argument("--doc-number")
    ap.add_argument("--recipient")
    ap.add_argument("--author")
    ap.add_argument("--date")
    ap.add_argument("--signer")
    ap.add_argument("--copies")
    ap.add_argument("--secret")
    ap.add_argument("--urgency")
    ap.add_argument("--cc")
    ap.add_argument("--print-office")
    ap.add_argument("--print-date")
    ap.add_argument("--seal", action="store_true")
    args = ap.parse_args()

    if Path(args.input).suffix.lower() == ".docx" and args.profile in ("official", "briefing", "policy", "meeting", "minimal"):
        report = reformat_existing_docx(args.input, args.output, args.profile, args.title)
    else:
        report = build_document(
            args.input, args.output, args.profile, args.document_type, args.title,
            args.issuer, args.doc_number, args.recipient, args.author, args.date,
            args.signer, args.copies, args.secret, args.urgency,
            None, args.cc, args.print_office, args.print_date, args.seal
        )
    print(f"已生成：{report.output}")


__all__ = ["build_document", "reformat_existing_docx", "BuildReport"]

if __name__ == "__main__":
    cli()
