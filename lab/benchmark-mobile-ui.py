"""A/B the local phone UI with/without the mobile policy; no writable requests."""
import glob
import json
import statistics
import time
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

OUT = Path('/tmp/opencode/starnet-mobile-ui')
OUT.mkdir(parents=True, exist_ok=True)
binary = sorted(glob.glob('/home/sandboxhp/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell'))[-1]
reports = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=binary, args=['--no-sandbox', '--disable-dev-shm-usage'])
    for optimized in (False, True):
        context = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=3, is_mobile=True, has_touch=True)
        def restrict(route):
            req = route.request
            if urlsplit(req.url).netloc != '127.0.0.1:8790':
                return route.abort()
            if req.method not in ('GET', 'HEAD', 'OPTIONS'):
                return route.fulfill(status=403, content_type='application/json', body='{"ok":false,"error":"read-only benchmark"}')
            route.continue_()
        context.route('**/*', restrict)
        page = context.new_page()
        page.goto('http://127.0.0.1:8790/' + ('' if optimized else '?lab-mobile=off'), wait_until='domcontentloaded')
        page.wait_for_function('() => window.__SKYNET_TEST__ && __SKYNET_TEST__.ready()', timeout=60000)
        for selector in ('.tut-coach-ok', '#nav-coach-x'):
            if page.locator(selector).is_visible():
                page.locator(selector).click()
        cdp = context.new_cdp_session(page)
        cdp.send('Emulation.setCPUThrottlingRate', {'rate': 6})
        samples = []
        # One discarded warm-up: the first open pays one-off JIT/compile costs for
        # both modes, so including it would measure startup rather than the change.
        for iteration in range(4):
            start = time.monotonic()
            page.locator('.bb-grp[data-hint="system"]').tap()
            page.wait_for_function('() => document.querySelector(\'.bb-grp[data-hint="system"]\').getAttribute("aria-expanded") === "true"')
            page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            popup = round((time.monotonic() - start) * 1000)
            start = time.monotonic()
            page.locator('.bb[data-term="settings"]').tap()
            dialog = page.get_by_role('dialog').first
            dialog.wait_for(state='visible')
            page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            settings = round((time.monotonic() - start) * 1000)
            settings_built = dialog.locator('.con-sec[data-built="true"]').count()
            paused = page.evaluate('World.renderPace().menuPaused')
            page.evaluate('StationUI.closeTerm("settings")')
            page.wait_for_function('() => !document.querySelector("#terms > .term")')
            start = time.monotonic()
            page.locator('.bb-grp[data-hint="crew"]').tap()
            page.locator('.bb[data-term="agents"]').tap()
            dossier = page.get_by_role('dialog').first
            dossier.wait_for(state='visible')
            page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            agents_ms = round((time.monotonic() - start) * 1000)
            dossier_built = dossier.locator('.con-sec[data-built="true"]').count()
            page.evaluate('StationUI.closeTerm("agents")')
            page.wait_for_function('() => !document.querySelector("#terms > .term")')
            sample = {'popupMs': popup, 'settingsMs': settings, 'builtPanes': settings_built,
                'menuPaused': paused, 'agentsMs': agents_ms, 'dossierBuiltPanes': dossier_built}
            if iteration == 0:
                warmup = sample
            else:
                samples.append(sample)
        assert page.evaluate('__SKYNET_TEST__.reduceTotals().calls') == 0
        reports.append({'optimized': optimized, 'cpuSlowdown': 6, 'warmupDiscarded': warmup, 'samples': samples,
            'medianPopupMs': statistics.median(x['popupMs'] for x in samples), 'medianSettingsMs': statistics.median(x['settingsMs'] for x in samples),
            'medianAgentsMs': statistics.median(x['agentsMs'] for x in samples)})
        context.close()
    browser.close()
Path('lab/evidence/mobile-performance.json').write_text(json.dumps({'method': 'Local Chromium, 390x844/DPR3, CPU 6x slowdown. One warm-up discarded, then 3 real-tap samples per mode; medians include automation/paint waits, not a measurement of the real phone. All writes/external requests blocked.', 'results': reports}, indent=2))
print(json.dumps(reports, indent=2))
