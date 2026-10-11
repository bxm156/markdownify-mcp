"""Runs create-remote-fixtures.py into a temporary directory and checks the generated Office files.

Uses explicit raises, never bare assert, so it behaves the same under `python -O`.
Needs openpyxl and python-pptx (installed with markitdown[xlsx,pptx]).
"""
import subprocess
import sys
import tempfile
from pathlib import Path
from zipfile import ZipFile

SCRIPT = Path(__file__).with_name("create-remote-fixtures.py")
ZIP_MAGIC = b"PK\x03\x04"  # every OOXML file is a ZIP container
# fixture -> (marker part that makes it the right OOXML type, text that must appear in the file)
EXPECTED = {
    "test.docx": ("word/document.xml", "Test DOCX content"),
    "test.xlsx": ("xl/workbook.xml", None),  # xlsx text lives in sharedStrings, checked below
    "test.pptx": ("ppt/presentation.xml", None),
}


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    with tempfile.TemporaryDirectory(prefix="markdownify-fixtures-") as parent:
        # A nested path that does not exist yet: the script must create it.
        destination = Path(parent) / "nested" / "fixtures"
        result = subprocess.run([sys.executable, str(SCRIPT), str(destination)],
                                capture_output=True, text=True, timeout=60)
        check(result.returncode == 0,
              f"create-remote-fixtures.py exited {result.returncode}: {result.stderr.strip()}")
        check("Generated" in result.stdout, f"unexpected output: {result.stdout!r}")

        produced = sorted(path.name for path in destination.iterdir())
        check(produced == sorted(EXPECTED), f"expected exactly {sorted(EXPECTED)}, got {produced}")

        for name, (marker_part, text) in EXPECTED.items():
            path = destination / name
            check(path.is_file(), f"{name} is not a regular file")
            check(path.stat().st_size > 0, f"{name} is empty")
            check(path.read_bytes()[:4] == ZIP_MAGIC, f"{name} does not start with ZIP magic bytes")
            with ZipFile(path) as archive:
                check(archive.testzip() is None, f"{name} has a corrupt ZIP member")
                names = archive.namelist()
                check(marker_part in names, f"{name} lacks {marker_part}; has {names}")
                if text is not None:
                    check(text in archive.read(marker_part).decode("utf-8"), f"{name} lacks {text!r}")

        with ZipFile(destination / "test.xlsx") as archive:
            # Depending on the openpyxl version, strings are shared or stored inline in the sheet.
            cells = "".join(archive.read(n).decode("utf-8") for n in archive.namelist()
                            if n == "xl/sharedStrings.xml" or n.startswith("xl/worksheets/sheet"))
            check("Test XLSX content" in cells, "test.xlsx lacks its sample text")
        with ZipFile(destination / "test.pptx") as archive:
            slides = [archive.read(n).decode("utf-8") for n in archive.namelist() if n.startswith("ppt/slides/slide")]
            check(any("Test PPTX content" in slide for slide in slides), "test.pptx lacks its sample text")

        # Regenerating into the same directory must also work (CI reruns on a dirty workspace).
        again = subprocess.run([sys.executable, str(SCRIPT), str(destination)],
                               capture_output=True, text=True, timeout=60)
        check(again.returncode == 0, f"second run failed: {again.stderr.strip()}")

        # Missing argument must fail loudly rather than write somewhere unexpected.
        bare = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, timeout=60)
        check(bare.returncode != 0, "running without a destination argument should fail")

    print("create-remote-fixtures.py generated valid DOCX, XLSX and PPTX files")


if __name__ == "__main__":
    main()
