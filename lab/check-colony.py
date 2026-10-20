"""Read-only desktop/mobile verification of the isolated Colony preview server."""
import glob
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path('/tmp/opencode/colony-implementation/visual')
OUT.mkdir(parents=True, exist_ok=True)
binary = sorted(glob.glob('/home/sandboxhp/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell'))[-1]
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=binary, headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
    for name, width in [('desktop', 1280), ('mobile', 390)]:
        context = browser.new_context(viewport={'width': width, 'height': 900})
        context.route('**/*', lambda route: route.continue_() if route.request.url.startswith('http://127.0.0.1:8793/') and route.request.method == 'GET' else route.abort())
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('http://127.0.0.1:8793/colony/index.html', wait_until='domcontentloaded')
        page.wait_for_function("document.querySelector('#connection').textContent.includes('Revision 0')")
        assert page.locator('#processes .card').count() == 13
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.locator('#brand').select_option('ashveil')
        assert page.locator('#processes .card').count() == 4
        assert 'Lifestruct' not in page.locator('#team').inner_text()
        assert not errors
        page.screenshot(path=str(OUT / (name + '.png')))
        page.route('**/api/colony', lambda route: route.abort())
        page.locator('#refresh').click()
        page.wait_for_function("document.querySelector('#connection').textContent.startsWith('Offline')")
        assert 'Verfügbarkeit unbekannt' in page.locator('#team').inner_text()
        results.append({'viewport': name, 'width': width, 'noOverflow': True, 'brandFilter': True, 'offlineTruth': True, 'errors': errors})
        context.close()
    browser.close()
(OUT / 'browser.json').write_text(json.dumps(results, indent=2))
print(json.dumps(results, indent=2))
