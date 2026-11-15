import asyncio
import json
import os
import sys
from pathlib import Path
from playwright.async_api import async_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

AXE_PATH = os.path.join(os.getcwd(), "research_repos", "axe-core", "axe.min.js")
BASE_URL = "http://localhost:3000"
THEME_CHECKS_DIR = Path(
    r"C:\Users\Nguyen Trong Khoi\.gemini\antigravity\brain\66a73df6-10e0-40f8-9a2e-ea91648f0426\scratch\theme_checks"
)


async def ensure_theme(page, target_theme: str):
    cur = await page.evaluate("() => document.documentElement.getAttribute('data-theme') || 'light'")
    if cur != target_theme:
        toggle = page.locator("#navbar-theme-toggle")
        if await toggle.count() > 0 and await toggle.is_visible():
            await toggle.click()
            await page.wait_for_timeout(250)
        else:
            await page.evaluate(
                """(t) => {
                    document.documentElement.setAttribute('data-theme', t);
                    document.documentElement.classList.toggle('theme-light', t === 'light');
                    document.documentElement.classList.toggle('theme-dark', t === 'dark');
                    window.localStorage.setItem('geno_os2_theme', t);
                }""",
                target_theme,
            )
            await page.wait_for_timeout(250)


async def ensure_lang(page, target_lang: str):
    btn = page.locator(f"#navbar-lang-{target_lang}")
    if await btn.count() > 0 and await btn.is_visible():
        await btn.click()
        await page.wait_for_timeout(250)


async def switch_view(page, view_name: str):
    if view_name == "researcher":
        loc = page.locator("#navbar-role-researcher")
        if await loc.count() > 0 and await loc.is_visible():
            await loc.click()
        else:
            # Mobile sidebar fallback
            nav_item = page.locator(".os2-nav-item").first
            if await nav_item.count() > 0:
                await nav_item.click()
    elif view_name in ("provider_mint", "provider_vault"):
        loc = page.locator("#navbar-role-donor")
        if await loc.count() > 0 and await loc.is_visible():
            await loc.click()
            await page.wait_for_timeout(300)
        else:
            studio = page.locator(".os2-nav-item", has_text="Studio")
            if await studio.count() > 0:
                await studio.first.click()
                await page.wait_for_timeout(300)
        if view_name == "provider_vault":
            vault_tab = page.locator(".portal-subnav-bar .subnav-tab-item").nth(1)
            if await vault_tab.count() > 0:
                await vault_tab.click()
    elif view_name == "admin":
        loc = page.locator("#navbar-role-admin")
        if await loc.count() > 0 and await loc.is_visible():
            await loc.click()
        else:
            admin_nav = page.locator(".os2-nav-item[data-nav='admin'], .os2-nav-item", has_text="Admin")
            if await admin_nav.count() > 0:
                await admin_nav.first.click()
    await page.wait_for_timeout(450)


async def audit_scenario(page, axe_js: str, scenario_tag: str, save_shot: bool):
    await page.evaluate(axe_js)
    results = await page.evaluate("() => axe.run()")
    overflow_info = await page.evaluate(
        """() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            overflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth
        })"""
    )

    violations = results.get("violations", [])
    blocking = [v for v in violations if v.get("impact") in ("critical", "serious")]
    minor_or_mod = [v for v in violations if v.get("impact") not in ("critical", "serious")]

    if save_shot:
        THEME_CHECKS_DIR.mkdir(parents=True, exist_ok=True)
        await page.screenshot(path=str(THEME_CHECKS_DIR / f"{scenario_tag}.png"), animations="disabled")

    print(
        f"  [{scenario_tag}] passes={len(results.get('passes', []))}, "
        f"blocking(crit/ser)={len(blocking)}, minor/mod={len(minor_or_mod)}, "
        f"overflow={overflow_info['overflowPx']}px"
    )
    for v in blocking:
        print(f"    [FAIL VIOLATION] {v['id']} ({v['impact']}): {v['description']}")
        for n in v.get("nodes", [])[:3]:
            print(f"      -> {n.get('target')} | {n.get('failureSummary')}")

    return {
        "scenario": scenario_tag,
        "passes_count": len(results.get("passes", [])),
        "violations_count": len(violations),
        "blocking_count": len(blocking),
        "overflow_px": overflow_info["overflowPx"],
        "scroll_width": overflow_info["scrollWidth"],
        "client_width": overflow_info["clientWidth"],
        "violations": [
            {
                "id": v["id"],
                "impact": v["impact"],
                "description": v["description"],
                "help": v.get("help"),
                "nodes": [
                    {
                        "target": node.get("target"),
                        "html": node.get("html", "")[:160],
                        "failureSummary": node.get("failureSummary"),
                    }
                    for node in v.get("nodes", [])[:4]
                ],
            }
            for v in violations
        ],
    }


async def run_audit():
    with open(AXE_PATH, "r", encoding="utf-8") as f:
        axe_js = f.read()

    print("[*] Launching Chromium to run Multi-Viewport / Dual-Theme / Bilingual axe-core Audit...")
    all_scenarios = []
    blocking_failures = 0
    overflow_failures = 0

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)

        # 1. Desktop (1440x900) matrix (connect Account #0 so wallet controls + pubkey banner + Owner badges are audited live)
        ctx_desk = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx_desk.new_page()
        await page.goto(BASE_URL, wait_until="networkidle")
        await page.wait_for_selector("#navbar-role-admin", timeout=15000)
        await page.click("#navbar-role-admin")
        await page.wait_for_selector("#admin-switch-acct-0", timeout=10000)
        await page.click("#admin-switch-acct-0")
        await page.wait_for_timeout(1200)

        desktop_matrix = [
            ("light", "vi", "researcher", True),
            ("light", "vi", "provider_mint", True),
            ("light", "vi", "provider_vault", True),
            ("light", "vi", "admin", True),
            ("dark", "vi", "researcher", True),
            ("dark", "vi", "provider_mint", False),
            ("dark", "vi", "provider_vault", True),
            ("dark", "vi", "admin", True),
            ("light", "en", "admin", True),
            ("light", "en", "researcher", False),
            ("dark", "en", "admin", True),
            ("dark", "en", "provider_mint", False),
        ]

        for theme, lang, view, save_shot in desktop_matrix:
            await ensure_theme(page, theme)
            await ensure_lang(page, lang)
            await switch_view(page, view)
            tag = f"desktop_{theme}_{lang}_{view}"
            res = await audit_scenario(page, axe_js, tag, save_shot)
            all_scenarios.append(res)
            blocking_failures += res["blocking_count"]
            if res["overflow_px"] > 0:
                overflow_failures += 1

        # Measure Top Bar Diagnostics in Desktop Light + VI
        await ensure_theme(page, "light")
        await ensure_lang(page, "vi")
        await switch_view(page, "admin")
        navbar_info = await page.evaluate(
            """() => {
                const nav = document.querySelector('.os2-top-navbar');
                const brand = document.querySelector('.os2-brand-text');
                const balance = document.querySelector('.os2-wallet-bal');
                const address = document.querySelector('.os2-wallet-addr');
                const faucet = document.querySelector('.os2-faucet-btn');
                const lang = document.querySelector('.os2-lang-group');
                const roleBtns = Array.from(document.querySelectorAll('.os2-role-switch-group button')).map(b => ({
                    id: b.id,
                    text: b.innerText.trim(),
                    fontSize: window.getComputedStyle(b).fontSize,
                    padding: window.getComputedStyle(b).padding
                }));
                return {
                    navHeight: nav ? window.getComputedStyle(nav).height : null,
                    brandFontSize: brand ? window.getComputedStyle(brand).fontSize : null,
                    balanceFontSize: balance ? window.getComputedStyle(balance).fontSize : null,
                    addressFontSize: address ? window.getComputedStyle(address).fontSize : null,
                    faucetFontSize: faucet ? window.getComputedStyle(faucet).fontSize : null,
                    langGroupWidth: lang ? window.getComputedStyle(lang).width : null,
                    roleBtns
                };
            }"""
        )
        await ctx_desk.close()

        # 2. Mobile (390x844) matrix
        ctx_mob = await browser.new_context(viewport={"width": 390, "height": 844})
        mob_page = await ctx_mob.new_page()
        await mob_page.goto(BASE_URL, wait_until="networkidle")
        await mob_page.wait_for_selector("#navbar-role-admin", timeout=15000)
        await mob_page.click("#navbar-role-admin")
        await mob_page.wait_for_selector("#admin-switch-acct-0", timeout=10000)
        await mob_page.click("#admin-switch-acct-0")
        await mob_page.wait_for_timeout(1200)

        mobile_matrix = [
            ("light", "vi", "researcher", True),
            ("light", "vi", "admin", False),
            ("dark", "vi", "researcher", False),
            ("dark", "vi", "admin", True),
        ]
        for theme, lang, view, save_shot in mobile_matrix:
            await ensure_theme(mob_page, theme)
            await ensure_lang(mob_page, lang)
            await switch_view(mob_page, view)
            tag = f"mobile_{theme}_{lang}_{view}"
            res = await audit_scenario(mob_page, axe_js, tag, save_shot)
            all_scenarios.append(res)
            blocking_failures += res["blocking_count"]
            if res["overflow_px"] > 0:
                overflow_failures += 1
        await ctx_mob.close()
        await browser.close()

    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    reports_dir = os.path.join(base_dir, "docs", "reports")
    os.makedirs(reports_dir, exist_ok=True)
    report_path = os.path.join(reports_dir, "ui_ux_axe_report.json")
    summary_report = {
        "scenarios_count": len(all_scenarios),
        "blocking_violations_total": blocking_failures,
        "overflow_failures_total": overflow_failures,
        "navbar_diagnostics": navbar_info,
        "scenarios": all_scenarios,
    }
    with open(report_path, "w", encoding="utf-8") as rf:
        json.dump(summary_report, rf, indent=2, ensure_ascii=False)

    print(f"\n[*] Detailed multi-viewport axe-core report saved to {report_path}")
    print("[*] Top Bar Layout & Font Diagnostics:")
    print(json.dumps(navbar_info, indent=2, ensure_ascii=False))
    print(
        f"\n[SUMMARY] Scenarios={len(all_scenarios)} | BlockingViolations={blocking_failures} | OverflowFailures={overflow_failures}"
    )

    if blocking_failures > 0 or overflow_failures > 0:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(run_audit())
