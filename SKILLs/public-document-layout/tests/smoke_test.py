import tempfile
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.official_doc import build_document, reformat_existing_docx
from scripts.doc_guard import inspect

def main():
    with tempfile.TemporaryDirectory() as d:
        src = Path(d)/"a.txt"
        out = Path(d)/"a.docx"
        src.write_text("一、总体要求\n加强规范管理。\n（一）重点任务。持续推进。\n1. 完善制度。", encoding="utf-8")
        build_document(
            str(src), str(out), profile="red",
            title="关于进一步加强规范管理工作的通知",
            issuer="××市人民政府",
            doc_number="×政发〔2026〕12号",
            recipient="各区人民政府：",
            author="××市人民政府",
            date_str="2026年8月26日",
        )
        errors, warnings, info = inspect(str(out))
        assert out.exists()
        out2 = Path(d)/"reformat.docx"
        reformat_existing_docx(str(out), str(out2), profile="official")
        e2, w2, i2 = inspect(str(out2))
        assert not e2, e2
        assert not errors, errors
        print("SMOKE TEST PASS")
        print("\n".join(warnings))
if __name__ == "__main__":
    main()
