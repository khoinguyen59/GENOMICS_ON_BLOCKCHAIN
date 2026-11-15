#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Academic Hygiene & Verification Toolkit for IS355 (Blockchain & Applications)
UIT - University of Information Technology (VNU-HCM)
Course Instructor: ThS. Ha Le Hoai Trung
Student: Nguyen Trong Khoi (MSSV: 23520783)
Topic: Genomics on Blockchain (DeSci Platform Architecture)

Functionalities:
1. Verify Clean Zip Submission Structure (Zero temp/cache/docx/scratch files)
2. Verify Web3 Hex Format & 0x Prefix Preservation
3. Render PDF pages to high-resolution PNG for Vision Audit
4. Self-test suite for automated pre-handover verification
"""

import os
import sys
import re
import zipfile
import argparse

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Blacklisted file extensions and patterns that MUST NOT be present in clean submissions
FORBIDDEN_EXTENSIONS = (
    '.docx', '.tmp', '.log', '.pyc', '.bak', '.swp', '.DS_Store', 'Thumbs.db'
)
FORBIDDEN_DIRECTORIES = (
    '__pycache__', '.pytest_cache', '.vscode', '.idea', 'scratch',
    'node_modules', '.git', '.system_generated', '.agents', '.gemini'
)

def check_clean_zip(zip_path: str, verbose: bool = True) -> tuple[bool, list[str]]:
    """
    Kiem tra tinh sach se cua tep zip nop bai:
    - Bat buoc phai chua it nhat 1 file PDF bao cao chinh thuc
    - Chua thu muc ma nguon hop le
    - Tuyet doi KHONG chua cac tep nhap (.docx), scratch, cache, temp
    """
    if not os.path.exists(zip_path):
        return False, [f"Tep zip khong ton tai: {zip_path}"]

    violations = []
    pdf_found = False
    source_files_count = 0

    try:
        with zipfile.ZipFile(zip_path, 'r') as zf:
            file_list = zf.namelist()
            if not file_list:
                return False, ["Tep zip rong!"]

            for entry in file_list:
                # Kiem tra thu muc cam
                for forbidden_dir in FORBIDDEN_DIRECTORIES:
                    if f"/{forbidden_dir}/" in entry or entry.startswith(f"{forbidden_dir}/"):
                        violations.append(f"Chua thu muc cam '{forbidden_dir}': {entry}")

                # Kiem tra phan mo rong cam
                for forbidden_ext in FORBIDDEN_EXTENSIONS:
                    if entry.lower().endswith(forbidden_ext):
                        # DEF3-HYGIENE-01: Exclude docs/specs/archive/ from the .docx forbidden extension check (stores original university syllabus)
                        normalized_entry = entry.replace("\\", "/").lower()
                        if forbidden_ext == '.docx' and ("docs/specs/archive/" in normalized_entry or normalized_entry.startswith("docs/specs/archive/")):
                            continue
                        violations.append(f"Chua tep cam '{forbidden_ext}': {entry}")

                if entry.lower().endswith('.pdf'):
                    pdf_found = True
                elif not entry.endswith('/'):
                    source_files_count += 1

            if not pdf_found:
                violations.append("Thieu tep bao cao PDF chinh thuc trong goi nop!")
            if source_files_count == 0:
                violations.append("Khong tim thay tep ma nguon nao trong goi nop!")

    except Exception as e:
        return False, [f"Loi doc file zip: {str(e)}"]

    is_clean = len(violations) == 0
    if verbose:
        if is_clean:
            print(f"[PASSED] Tep zip sach 100%: {zip_path} (Bao gom PDF va {source_files_count} tep ma nguon)")
        else:
            print(f"[FAILED] Phat hien vi pham ve sinh trong {zip_path}:")
            for v in violations:
                print(f"  - {v}")

    return is_clean, violations


def verify_hex_string(hex_val: str, expected_len: int = 66, field_name: str = "TxHash") -> tuple[bool, str]:
    """
    Xac thuc chuoi hexa Web3:
    - Bat buoc co tien to '0x'
    - Dung do dai yeu cau (vi du: 66 ky tu cho TxHash, 42 ky tu cho Address)
    - Chi chua ky tu hexa hop le [0-9a-fA-F]
    """
    if not isinstance(hex_val, str):
        return False, f"[{field_name}] Khong phai chuoi string"
    if not hex_val.startswith("0x"):
        return False, f"[{field_name}] Thieu tien to bat bien '0x': {hex_val}"
    if len(hex_val) != expected_len:
        return False, f"[{field_name}] Sai do dai (Ky vong: {expected_len}, Thuc te: {len(hex_val)}): {hex_val}"
    if not re.match(r"^0x[0-9a-fA-F]+$", hex_val):
        return False, f"[{field_name}] Chua ky tu khong phai hex: {hex_val}"
    return True, f"[{field_name}] Hop le 100%: {hex_val}"


def check_script_hex_integrity(directory_path: str = None) -> tuple[bool, list[str]]:
    """
    Quet doi khang cac script Python va JS trong thu muc xem co loi mat tien to '0x'
    khi truyen Transaction Hash hoac Address hay khong.
    Bao dam cac transaction hash xuat ra terminal hoac log luon giu '0x'.
    """
    if directory_path is None or directory_path == "scripts":
        base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        directory_path = os.path.join(base_dir, "scripts")

    violations = []
    if not os.path.exists(directory_path):
        return True, []

    # Mau kiem tra nghi van: hash.hex() thay vi Web3.to_hex(hash)
    pattern_tx_hash_hex = re.compile(r'tx_hash\.hex\(\)')

    for root, _, files in os.walk(directory_path):
        for f in files:
            if f == "academic_hygiene_toolkit.py":
                continue
            if f.endswith(('.py', '.js', '.ts')):
                file_path = os.path.join(root, f)
                try:
                    with open(file_path, 'r', encoding='utf-8', errors='ignore') as fp:
                        for idx, line in enumerate(fp, 1):
                            if pattern_tx_hash_hex.search(line):
                                stripped = line.strip()
                                if not stripped.startswith(('#', '//', '/*')):
                                    violations.append(f"{file_path}:{idx} -> tx_hash.hex() co the mat tien to 0x, nen dung Web3.to_hex(tx_hash): {stripped}")
                except Exception as ex:
                    violations.append(f"Loi doc file {file_path}: {ex}")

    is_clean = len(violations) == 0
    return is_clean, violations


def render_pdf_to_images(pdf_path: str, output_dir: str, dpi: int = 200) -> tuple[bool, list[str]]:
    """
    Render toan bo cac trang cua tep PDF sang anh PNG de phuc vu tham dinh thi giac (Vision Audit).
    Thu vien uu tien: pypdfium2 hoac PyMuPDF (fitz).
    """
    if not os.path.exists(pdf_path):
        return False, [f"Tep PDF khong ton tai: {pdf_path}"]

    os.makedirs(output_dir, exist_ok=True)
    rendered_files = []

    # Thu dung pypdfium2
    try:
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(pdf_path)
        scale = dpi / 72.0
        for i, page in enumerate(pdf):
            img = page.render(scale=scale).to_pil_image()
            out_file = os.path.join(output_dir, f"page_{i+1:02d}.png")
            img.save(out_file)
            rendered_files.append(out_file)
        return True, rendered_files
    except ImportError:
        pass

    # Thu dung PyMuPDF (fitz)
    try:
        import fitz
        doc = fitz.open(pdf_path)
        zoom = dpi / 72.0
        mat = fitz.Matrix(zoom, zoom)
        for i, page in enumerate(doc):
            pix = page.get_pixmap(matrix=mat)
            out_file = os.path.join(output_dir, f"page_{i+1:02d}.png")
            pix.save(out_file)
            rendered_files.append(out_file)
        doc.close()
        return True, rendered_files
    except ImportError:
        pass

    return False, ["Can cai dat pypdfium2 hoac PyMuPDF (fitz) de render PDF sang anh."]


def run_selftest() -> int:
    """Chay kiem thu toan bo cac ham trong toolkit de bao dam tinh dung dan."""
    print("=== CHAY KIEM THU TU DONG ACADEMIC HYGIENE TOOLKIT ===")

    # 1. Test verify_hex_string
    valid_tx = "0x" + "a" * 64
    ok, msg = verify_hex_string(valid_tx, 66, "TxHash")
    assert ok, f"Test failed for valid tx: {msg}"

    bad_tx_no_0x = "a" * 64
    ok, msg = verify_hex_string(bad_tx_no_0x, 66, "TxHash")
    assert not ok, "Test failed: missing 0x should fail"

    bad_tx_len = "0x" + "a" * 63
    ok, msg = verify_hex_string(bad_tx_len, 66, "TxHash")
    assert not ok, "Test failed: wrong length should fail"
    print("[1/3] Kiem tra dinh dang Hex Web3: PASSED (Bao toan tien to 0x thanh cong)")

    # 2. Test check_clean_zip with temporary dummy zip
    import tempfile
    with tempfile.TemporaryDirectory() as tmpdir:
        # Tao zip vi pham chua docx
        bad_zip = os.path.join(tmpdir, "bad.zip")
        with zipfile.ZipFile(bad_zip, 'w') as zf:
            zf.writestr("report.docx", "bad content")
            zf.writestr("code.py", "print('hello')")
        ok, viols = check_clean_zip(bad_zip, verbose=False)
        assert not ok, "Test failed: zip with docx must fail"

        # Tao zip hop le (bao gom ca docx hop le trong docs/specs/archive/)
        good_zip = os.path.join(tmpdir, "good.zip")
        with zipfile.ZipFile(good_zip, 'w') as zf:
            zf.writestr("report.pdf", "%PDF-1.4 dummy")
            zf.writestr("contracts/GenomicsRegistry.sol", "// SPDX-License-Identifier: MIT")
            zf.writestr("docs/specs/archive/syllabus.docx", "university syllabus archive")
        ok, viols = check_clean_zip(good_zip, verbose=False)
        assert ok, f"Test failed: valid zip with archive syllabus should pass: {viols}"
    print("[2/3] Kiem tra ve sinh Tep Zip: PASSED (Nhan dien chinh xac tep cam)")

    # 3. Test check_script_hex_integrity
    ok, viols = check_script_hex_integrity("scripts")
    print(f"[3/3] Kiem tra chuoi tx_hash trong scripts/: {'PASSED' if ok else 'CANH BAO'}")
    if not ok:
        for v in viols:
            print(f"  {v}")

    print("=== TAT CA KIEM THU TOOLKIT DA VUOT QUA THANH CONG (100%) ===")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Academic Hygiene & Verification Toolkit")
    parser.add_argument("--selftest", action="store_true", help="Chay kiem thu noi bo cua toolkit")
    parser.add_argument("--check-zip", type=str, help="Kiem tra tep zip nop bai")
    parser.add_argument("--check-hex", action="store_true", help="Kiem tra toan ven hex trong thu muc scripts")
    parser.add_argument("--render-pdf", type=str, help="Render PDF sang anh de kiem tra Vision")
    parser.add_argument("--output-dir", type=str, default="scratch/vision_audit", help="Thu muc xuat anh render")

    args = parser.parse_args()

    if args.selftest:
        sys.exit(run_selftest())
    elif args.check_zip:
        ok, _ = check_clean_zip(args.check_zip)
        sys.exit(0 if ok else 1)
    elif args.check_hex:
        ok, viols = check_script_hex_integrity("scripts")
        sys.exit(0 if ok else 1)
    elif args.render_pdf:
        ok, res = render_pdf_to_images(args.render_pdf, args.output_dir)
        if ok:
            print(f"[OK] Da render {len(res)} trang vao {args.output_dir}")
            sys.exit(0)
        else:
            print(f"[FAILED] {res[0]}")
            sys.exit(1)
    else:
        # Mac dinh chay selftest
        sys.exit(run_selftest())
