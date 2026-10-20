"""Read-only mobile/desktop menu regression check, no model calls or real keys."""
import glob
import json
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

OUT = Path('/tmp/opencode/starnet-mobile-ui')
OUT.mkdir(parents=True, exist_ok=True)
binary = sorted(glob.glob('/home/sandboxhp/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell'))[-1]
reports = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=binary, args=['--no-sandbox', '--disable-dev-shm-usage'])
    for mode in ('mobile', 'desktop', 'mobile-off'):
        mobile = mode != 'desktop'
        context = browser.new_context(viewport={'width': 390, 'height': 844} if mobile else {'width': 1440, 'height': 900}, is_mobile=mobile, has_touch=mobile, device_scale_factor=3 if mobile else 1)
        blocked, errors = [], []
        def restrict(route):
            req = route.request
            if urlsplit(req.url).netloc != '127.0.0.1:8790':
                return route.abort()
            if req.method not in ('GET', 'HEAD', 'OPTIONS'):
                blocked.append(urlsplit(req.url).path)
                return route.fulfill(status=403, content_type='application/json', body='{"ok":false,"error":"read-only UI test"}')
            route.continue_()
        context.route('**/*', restrict)
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)[:180]))
        page.goto('http://127.0.0.1:8790/' + ('?lab-mobile=off' if mode == 'mobile-off' else ''), wait_until='domcontentloaded')
        page.wait_for_function('() => window.__SKYNET_TEST__ && __SKYNET_TEST__.ready()', timeout=60000)
        for selector in ('.tut-coach-ok', '#nav-coach-x'):
            if page.locator(selector).is_visible():
                page.locator(selector).click()
        active = mode == 'mobile'
        page.locator('.bb-grp[data-hint="system"]').click()
        page.wait_for_function('(on) => World.renderPace().menuPaused === on', arg=active)
        page.locator('.bb[data-term="settings"]').click()
        dialog = page.get_by_role('dialog').first
        dialog.wait_for(state='visible')
        page.wait_for_function('(on) => World.renderPace().menuPaused === on', arg=active)
        initial = dialog.locator('.con-sec[data-built="true"]').count()
        assert initial == (1 if active else 9), (mode, initial)
        # First-use builds must wire controls, preserve already-mounted drafts and
        # leave neither broken placeholders nor missing deep-link destinations.
        for tab in ('budget', 'appearance', 'notifs', 'system', 'permissions', 'autonomy', 'remote', 'browser', 'providers'):
            dialog.locator('.con-rail-item[data-section="' + tab + '"]').click()
            pane = dialog.locator('.con-sec[data-section="' + tab + '"]')
            assert pane.get_attribute('data-built') == 'true', (mode, tab)
            assert pane.locator('text=This section failed to render.').count() == 0, (mode, tab)
        assert dialog.locator('.con-sec[data-built="true"]').count() == 9, (mode, dialog.locator('.con-sec').evaluate_all('(els) => els.map(e => ({id:e.dataset.section,built:e.dataset.built}))'))
        # Search must build/index the other panes too, and restore one selected tab.
        search = dialog.locator('.con-search-in')
        search.fill('room lighting')
        assert dialog.locator('.con-sec[data-section="appearance"]').is_visible()
        search.fill('no-such-setting-987654')
        assert dialog.locator('.con-search-empty').is_visible()
        search.fill('')
        assert dialog.locator('[role="tab"][aria-selected="true"]').count() == 1
        # A non-secret scratch value must survive away/back (no backend write).
        dialog.locator('.con-rail-item[data-section="autonomy"]').click()
        dialog.locator('#auto-direction-fold').evaluate('(el) => { el.open = true; }')
        target = dialog.locator('#auto-steer')
        original = target.input_value()
        target.fill('local-draft-only')
        dialog.locator('.con-rail-item[data-section="budget"]').click()
        dialog.locator('.con-rail-item[data-section="autonomy"]').click()
        assert target.input_value() == 'local-draft-only'
        target.fill(original)
        if active:
            # Stable scene, live communications: this must not stop the bridge.
            page.wait_for_timeout(250)
            draws = page.evaluate('World.renderPace().draws')
            page.wait_for_timeout(350)
            assert page.evaluate('World.renderPace().draws') == draws
            assert page.evaluate('World.linkState().paused') is False
        page.screenshot(path=str(OUT / (mode + '-settings.png')))
        page.evaluate('StationUI.closeTerm("settings")')
        page.wait_for_function('() => !World.renderPace().menuPaused')
        # Dossier: same first-use policy, including a per-agent CONFIG draft.
        page.locator('.bb-grp[data-hint="crew"]').click()
        page.locator('.bb[data-term="agents"]').click()
        dossier = page.get_by_role('dialog').first
        dossier.wait_for(state='visible')
        assert dossier.locator('.con-sec[data-built="true"]').count() == (1 if active else 5), (mode, 'dossier initial')
        tab = lambda name: dossier.locator('.con-rail-item[data-section="' + name + '"]')
        for name in ('growth', 'record', 'memory', 'config', 'brief'):
            tab(name).click()
            pane = dossier.locator('.con-sec[data-section="' + name + '"]')
            assert pane.get_attribute('data-built') == 'true', (mode, 'dossier', name)
            assert pane.locator('text=This section failed to render.').count() == 0, (mode, 'dossier', name)
        assert dossier.locator('.con-sec[data-built="true"]').count() == 5, (mode, 'dossier built')
        tab('config').click()
        dossier.locator('.con-sec[data-section="config"]').evaluate('(el) => el.querySelectorAll("details").forEach(d => { d.open = true; })')
        model = dossier.locator('#ag-model-in')
        original_model = model.input_value()
        model.fill('local-dossier-draft')
        tab('brief').click()
        tab('config').click()
        assert model.input_value() == 'local-dossier-draft', (mode, 'dossier draft')
        model.fill(original_model)
        page.screenshot(path=str(OUT / (mode + '-dossier.png')))
        page.evaluate('StationUI.closeTerm("agents")')
        page.wait_for_function('() => !document.querySelector("#terms > .term")')
        before = page.evaluate('World.renderPace().draws')
        page.wait_for_function('(n) => World.renderPace().draws > n', arg=before)
        assert not errors, errors
        reports.append({'mode': mode, 'initialSettingsPanes': initial, 'allTabsBuiltAndWired': True, 'draftPreserved': True,
            'searchWorks': True, 'sceneResumed': True, 'dossierTabsBuilt': 5, 'dossierDraftPreserved': True,
            'errors': errors, 'modelCalls': page.evaluate('__SKYNET_TEST__.reduceTotals().calls')})
        context.close()
    browser.close()
Path('lab/evidence/mobile-ui.json').write_text(json.dumps(reports, indent=2))
print(json.dumps(reports, indent=2))
