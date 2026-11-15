import docx
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

docx_path = r"C:\Users\Nguyen Trong Khoi\.gemini\antigravity\brain\66a73df6-10e0-40f8-9a2e-ea91648f0426\.user_uploaded\media_1793522829636_aa3c8745.docx"
if os.path.exists(docx_path):
    doc = docx.Document(docx_path)
    print("PARAGRAPHS COUNT:", len(doc.paragraphs))
    print("TABLES COUNT:", len(doc.tables))
    for i, p in enumerate(doc.paragraphs[:60]):
        if p.text.strip():
            print(f"P{i}: {p.text.strip()}")
    print("\n--- TABLES PREVIEW ---")
    for t_idx, table in enumerate(doc.tables):
        print(f"\nTable {t_idx} (rows: {len(table.rows)}, cols: {len(table.columns)}):")
        for r_idx, row in enumerate(table.rows[:5]):
            row_vals = [cell.text.strip().replace("\n", " ") for cell in row.cells]
            print(f"  Row {r_idx}: {' | '.join(row_vals)}")
else:
    print("NOT FOUND")
