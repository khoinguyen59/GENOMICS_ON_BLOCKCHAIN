import asyncio
import json
import os
from playwright.async_api import async_playwright

AXE_PATH = os.path.join(os.getcwd(), "research_repos", "axe-core", "axe.min.js")

async def run_audit():
    with open(AXE_PATH, "r", encoding="utf-8") as f:
        axe_js = f.read()

    print("[*] Launching Chromium to audit UI/UX using axe-core...")
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        # Testing at user's actual viewport: 1707x932
        page = await browser.new_page(viewport={"width": 1707, "height": 932})

        print("[*] Navigating to http://localhost:3000...")
        await page.goto("http://localhost:3000", wait_until="networkidle")
        await asyncio.sleep(2)

        # Inject axe-core
        await page.evaluate(axe_js)
        print("[*] Running axe.run() accessibility & UX audit...")
        results = await page.evaluate("() => axe.run()")

        violations = results.get("violations", [])
        passes = results.get("passes", [])
        incomplete = results.get("incomplete", [])

        print(f"[+] Audit Summary:")
        print(f"    - Passed Rules: {len(passes)}")
        print(f"    - Incomplete/Review: {len(incomplete)}")
        print(f"    - Violations Found: {len(violations)}")

        report = {
            "passes_count": len(passes),
            "violations_count": len(violations),
            "incomplete_count": len(incomplete),
            "violations": []
        }

        for v in violations:
            print(f"\n[!] VIOLATION: {v['id']} ({v['impact']})")
            print(f"    Description: {v['description']}")
            nodes_info = []
            for node in v.get("nodes", [])[:3]:
                nodes_info.append({
                    "target": node.get("target"),
                    "html": node.get("html", "")[:150],
                    "failureSummary": node.get("failureSummary")
                })
            report["violations"].append({
                "id": v["id"],
                "impact": v["impact"],
                "description": v["description"],
                "help": v.get("help"),
                "helpUrl": v.get("helpUrl"),
                "nodes": nodes_info
            })

        base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        reports_dir = os.path.join(base_dir, "docs", "reports")
        os.makedirs(reports_dir, exist_ok=True)
        report_path = os.path.join(reports_dir, "ui_ux_axe_report.json")
        with open(report_path, "w", encoding="utf-8") as rf:
            json.dump(report, rf, indent=2, ensure_ascii=False)
        print(f"\n[*] Detailed axe-core report saved to {report_path}")

        # Measure Top Bar Font Sizes and Dimensions
        navbar_info = await page.evaluate("""() => {
            const nav = document.querySelector('.main-nav');
            const brand = document.querySelector('.brand-title');
            const balance = document.querySelector('.geno-balance-pill');
            const address = document.querySelector('.address-pill');
            const faucet = document.querySelector('.faucet-btn-nav');
            const lang = document.querySelector('.lang-switcher-btn');
            const roleBtns = Array.from(document.querySelectorAll('.role-switcher-tabs button')).map(b => ({
                text: b.innerText,
                fontSize: window.getComputedStyle(b).fontSize,
                padding: window.getComputedStyle(b).padding
            }));

            return {
                navHeight: nav ? window.getComputedStyle(nav).height : null,
                brandFontSize: brand ? window.getComputedStyle(brand).fontSize : null,
                balanceFontSize: balance ? window.getComputedStyle(balance).fontSize : null,
                addressFontSize: address ? window.getComputedStyle(address).fontSize : null,
                faucetFontSize: faucet ? window.getComputedStyle(faucet).fontSize : null,
                langFontSize: lang ? window.getComputedStyle(lang).fontSize : null,
                roleBtns
            };
        }""")

        print("\n[*] Top Bar Layout & Font Diagnostics:")
        print(json.dumps(navbar_info, indent=2))

        await browser.close()

if __name__ == "__main__":
    asyncio.run(run_audit())
