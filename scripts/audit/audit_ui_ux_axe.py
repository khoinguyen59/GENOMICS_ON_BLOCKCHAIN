import asyncio
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from playwright.async_api import async_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

AXE_PATH = os.path.join(os.getcwd(), "research_repos", "axe-core", "axe.min.js")
BASE_URL = "http://localhost:3000"
THEME_CHECKS_DIR = Path(__file__).resolve().parents[2] / "docs" / "reports" / "theme_checks"


def ensure_server():
    try:
        urllib.request.urlopen("http://localhost:3000", timeout=1)
        return None
    except Exception:
        print("[*] Starting Vite dev server on port 3000...")
        frontend_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")
        if not os.path.exists(frontend_dir):
            frontend_dir = os.path.join(os.getcwd(), "frontend")
        proc = subprocess.Popen(
            "cmd /c npm run dev",
            cwd=frontend_dir,
            shell=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        for _ in range(30):
            time.sleep(1)
            try:
                urllib.request.urlopen("http://localhost:3000", timeout=1)
                print("[*] Vite dev server is ready!")
                return proc
            except Exception:
                pass
        return proc


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
    computed_contrast_failures = await page.evaluate(
        """() => {
            const parseRgba = (str) => {
                const m = String(str || '').match(/rgba?\\((\\d+(?:\\.\\d+)?),\\s*(\\d+(?:\\.\\d+)?),\\s*(\\d+(?:\\.\\d+)?)(?:,\\s*(\\d+(?:\\.\\d+)?))?\\)/);
                if (!m) return null;
                return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
            };
            const blend = (fg, bg) => {
                const a = fg.a;
                return {
                    r: fg.r * a + bg.r * (1 - a),
                    g: fg.g * a + bg.g * (1 - a),
                    b: fg.b * a + bg.b * (1 - a),
                    a: 1
                };
            };
            const lum = (c) => {
                const ch = [c.r, c.g, c.b].map(v => {
                    const s = v / 255;
                    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
                });
                return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
            };
            const getBg = (el) => {
                const layers = [];
                let cur = el;
                while (cur && cur.nodeType === 1) {
                    const st = getComputedStyle(cur);
                    if (st.backgroundImage && st.backgroundImage.includes('gradient')) return null;
                    const bg = parseRgba(st.backgroundColor);
                    if (bg && bg.a > 0) layers.push(bg);
                    if (bg && bg.a >= 0.999) break;
                    cur = cur.parentElement;
                }
                const rootBg = parseRgba(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
                let acc = rootBg.a > 0.99 ? rootBg : { r: 255, g: 255, b: 255, a: 1 };
                for (let i = layers.length - 1; i >= 0; i--) acc = blend(layers[i], acc);
                return acc;
            };
            const failures = [];
            for (const el of document.querySelectorAll('button:not(:disabled), .status-badge-chip, .btn-terminal:not(:disabled)')) {
                if (el.closest('.os2-featured-strip-card') || el.classList.contains('os2-brand-btn')) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) continue;
                const st = getComputedStyle(el);
                if (st.visibility === 'hidden' || parseFloat(st.opacity) < 0.9) continue;
                if (st.webkitTextFillColor === 'rgba(0, 0, 0, 0)') continue;
                const txt = (el.innerText || '').trim();
                if (!txt) continue;
                const bg = getBg(el);
                const fgRaw = parseRgba(st.color);
                if (!bg || !fgRaw || fgRaw.a === 0) continue;
                const fg = fgRaw.a < 1 ? blend(fgRaw, bg) : fgRaw;
                const l1 = lum(fg), l2 = lum(bg);
                const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
                const px = parseFloat(st.fontSize) || 14;
                const bold = (parseInt(st.fontWeight, 10) || 400) >= 700;
                const minRatio = (px >= 24 || (bold && px >= 18.67)) ? 3.0 : 4.5;
                if (ratio < minRatio) {
                    failures.push({ tag: el.tagName, id: el.id || '', cls: String(el.className || '').slice(0, 60), text: txt.slice(0, 40), ratio: Number(ratio.toFixed(2)), minRatio });
                }
            }
            return failures;
        }"""
    )

    violations = results.get("violations", [])
    # Task 4: verify ALL axe-core impacts (critical, serious, moderate, minor) without suppression
    blocking = violations
    if computed_contrast_failures:
        blocking = list(violations) + [{
            "id": "computed-color-contrast",
            "impact": "serious",
            "description": f"{len(computed_contrast_failures)} visible interactive/badge element(s) below WCAG contrast minimum",
            "nodes": [
                {"target": [f"#{f['id']}" if f["id"] else f["cls"]], "failureSummary": f"{f['text']!r} ratio={f['ratio']} < {f['minRatio']}"}
                for f in computed_contrast_failures[:4]
            ],
        }]
    minor_or_mod = [v for v in violations if v.get("impact") not in ("critical", "serious")]

    if save_shot:
        THEME_CHECKS_DIR.mkdir(parents=True, exist_ok=True)
        await page.screenshot(path=str(THEME_CHECKS_DIR / f"{scenario_tag}.png"), animations="disabled")

    print(
        f"  [{scenario_tag}] passes={len(results.get('passes', []))}, "
        f"blocking(all_impacts)={len(blocking)}, minor/mod={len(minor_or_mod)}, "
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

        # Audit AssetDetailModal in Desktop Light VI
        await ensure_theme(page, "light")
        await ensure_lang(page, "vi")
        await switch_view(page, "researcher")
        inspect_btn = page.locator(".opensea-nft-card, .btn-terminal-ghost").first
        if await inspect_btn.count() > 0:
            await inspect_btn.click()
            await page.wait_for_selector(".opensea-modal-container", timeout=5000)
            await page.wait_for_timeout(450)
            tag = "desktop_light_vi_modal"
            res = await audit_scenario(page, axe_js, tag, True)
            all_scenarios.append(res)
            blocking_failures += res["blocking_count"]
            if res["overflow_px"] > 0:
                overflow_failures += 1
            # Test Escape dismissal
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(350)

        # Audit IpfsSettingsModal in Desktop Light & Dark
        for theme in ("light", "dark"):
            await ensure_theme(page, theme)
            ipfs_btn = page.locator("#footer-ipfs-settings-btn, #admin-open-ipfs-btn, button:has-text('IPFS')").first
            if await ipfs_btn.count() > 0:
                await ipfs_btn.click()
                await page.wait_for_selector(".terminal-modal-window", timeout=5000)
                await page.wait_for_timeout(350)
                tag = f"desktop_{theme}_ipfs_modal"
                res = await audit_scenario(page, axe_js, tag, True)
                all_scenarios.append(res)
                blocking_failures += res["blocking_count"]
                if res["overflow_px"] > 0:
                    overflow_failures += 1
                await page.keyboard.press("Escape")
                await page.wait_for_timeout(300)

        # Audit Table & Activity Views in Researcher Portal
        await ensure_theme(page, "light")
        await ensure_lang(page, "vi")
        await switch_view(page, "researcher")

        # Table view
        table_btn = page.locator("#btn-view-table")
        if await table_btn.count() > 0:
            await table_btn.click()
            await page.wait_for_timeout(350)
            tag = "desktop_light_vi_table_view"
            res = await audit_scenario(page, axe_js, tag, True)
            all_scenarios.append(res)
            blocking_failures += res["blocking_count"]
            if res["overflow_px"] > 0:
                overflow_failures += 1
            grid_btn = page.locator("#btn-view-grid")
            if await grid_btn.count() > 0:
                await grid_btn.click()
                await page.wait_for_timeout(250)

        # Activity view & LicensedDatasetsView across Light and Dark
        for theme in ("light", "dark"):
            await ensure_theme(page, theme)
            await ensure_lang(page, "vi")
            await switch_view(page, "researcher")

            activity_tab = page.locator("#os2-tab-activity-btn")
            if await activity_tab.count() > 0:
                await activity_tab.click()
                await page.wait_for_timeout(350)
                tag = f"desktop_{theme}_vi_activity_view"
                res = await audit_scenario(page, axe_js, tag, theme == "light")
                all_scenarios.append(res)
                blocking_failures += res["blocking_count"]
                if res["overflow_px"] > 0:
                    overflow_failures += 1

            licensed_tab = page.locator("#btn-tab-licensed")
            if await licensed_tab.count() > 0:
                await licensed_tab.click()
                await page.wait_for_timeout(350)
                tag = f"desktop_{theme}_vi_licensed_view"
                res = await audit_scenario(page, axe_js, tag, theme == "light")
                all_scenarios.append(res)
                blocking_failures += res["blocking_count"]
                if res["overflow_px"] > 0:
                    overflow_failures += 1
                back_catalog = page.locator(".portal-subnav-bar .subnav-tab-item").first
                if await back_catalog.count() > 0:
                    await back_catalog.click()
                    await page.wait_for_timeout(250)

            items_tab = page.locator(".collection-subtabs-group button").first
            if await items_tab.count() > 0:
                await items_tab.click()
                await page.wait_for_timeout(250)

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

        # 1b. Tablet / Small Desktop Viewport (1024x768) matrix
        ctx_tab = await browser.new_context(viewport={"width": 1024, "height": 768})
        tab_page = await ctx_tab.new_page()
        await tab_page.goto(BASE_URL, wait_until="networkidle")
        await tab_page.wait_for_selector("#navbar-role-admin", timeout=15000)
        await tab_page.click("#navbar-role-admin")
        await tab_page.wait_for_selector("#admin-switch-acct-0", timeout=10000)
        await tab_page.click("#admin-switch-acct-0")
        await tab_page.wait_for_timeout(1000)

        tablet_matrix = [
            ("light", "vi", "researcher", True),
            ("light", "vi", "admin", True),
            ("dark", "vi", "researcher", False),
            ("dark", "vi", "admin", False),
        ]
        for theme, lang, view, save_shot in tablet_matrix:
            await ensure_theme(tab_page, theme)
            await ensure_lang(tab_page, lang)
            await switch_view(tab_page, view)
            tag = f"tablet_1024x768_{theme}_{lang}_{view}"
            res = await audit_scenario(tab_page, axe_js, tag, save_shot)
            all_scenarios.append(res)
            blocking_failures += res["blocking_count"]
            if res["overflow_px"] > 0:
                overflow_failures += 1
        await ctx_tab.close()

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
            ("light", "vi", "provider_mint", True),
            ("light", "vi", "provider_vault", True),
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

        # Audit AssetDetailModal in Mobile Light VI
        await ensure_theme(mob_page, "light")
        await ensure_lang(mob_page, "vi")
        await switch_view(mob_page, "researcher")
        mob_inspect = mob_page.locator(".opensea-nft-card, .btn-terminal-ghost, .btn-inspect").first
        if await mob_inspect.count() > 0:
            await mob_inspect.click()
            await mob_page.wait_for_selector(".opensea-modal-container", timeout=5000)
            await mob_page.wait_for_timeout(450)
            tag = "mobile_light_vi_modal"
            res = await audit_scenario(mob_page, axe_js, tag, True)
            all_scenarios.append(res)
            blocking_failures += res["blocking_count"]
            if res["overflow_px"] > 0:
                overflow_failures += 1
            # Test close button dismissal
            close_btn = mob_page.locator(".modal-close-btn").first
            if await close_btn.count() > 0:
                await close_btn.click()
                await mob_page.wait_for_timeout(350)
            else:
                await mob_page.keyboard.press("Escape")
                await mob_page.wait_for_timeout(350)
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


def main():
    proc = ensure_server()
    try:
        asyncio.run(run_audit())
    finally:
        if proc:
            print("[*] Cleaning up Vite dev server process...")
            try:
                subprocess.run(f"taskkill /F /T /PID {proc.pid}", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception:
                pass


if __name__ == "__main__":
    main()
