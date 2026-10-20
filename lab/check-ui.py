"""Headless fallback: oc-check's virtual-time capture hangs on this live canvas/SSE app."""
import glob
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path('/tmp/opencode/starnet-lab-visual')
OUT.mkdir(parents=True, exist_ok=True)
binary = sorted(glob.glob('/home/sandboxhp/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell'))[-1]
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=binary, headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
    for style in ['original', 'custom']:
        context = browser.new_context(viewport={'width': 1280, 'height': 900}, reduced_motion='reduce')
        context.route('**/*', lambda route: route.continue_() if route.request.url.startswith('http://127.0.0.1:8790/') else route.abort())
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('http://127.0.0.1:8790/?lab-style=' + style, wait_until='domcontentloaded', timeout=30000)
        page.wait_for_function('() => window.__SKYNET_TEST__ && window.__SKYNET_TEST__.ready()', timeout=60000)
        if page.locator('.tut-coach-ok').is_visible():
            page.locator('.tut-coach-ok').click()
        page.wait_for_timeout(2000)  # settle the initial canvas bake and entrance animation
        if page.locator('#nav-coach-x').is_visible():
            page.locator('#nav-coach-x').click()
        page.screenshot(path=str(OUT / (style + '-station.png')))
        facts = page.evaluate('''() => ({
          style: document.documentElement.dataset.labStyle,
          accent: getComputedStyle(document.body).getPropertyValue('--ph').trim(),
          ready: window.__SKYNET_TEST__.ready(),
          calls: window.__SKYNET_TEST__.reduceTotals().calls,
          lines: WorkflowsWindow._floor().lines.map(l => ({
            name: l.name, key: l.key, steps: l.steps.map(s => ({ id: s.id, role: s.role, agentId: s.agentId, brief: s.brief, desk: s.desk }))
          }))
        })''')
        assert facts['ready'] and facts['calls'] == 0
        line = next(l for l in facts['lines'] if l['name'] == 'Lifestruct Pinterest Pilot')
        assert len(line['steps']) == 3
        assert all(s['desk'] for s in line['steps'])
        assert [s['agentId'] for s in line['steps']] == ['agent', 'life_content', 'life_review']
        assert 'Drei Test-Pins' in line['steps'][1]['brief']
        page.evaluate('(key) => WorkflowsWindow.openLine(key)', line['key'])
        page.locator('.wfw').wait_for(state='visible', timeout=10000)
        page.wait_for_timeout(500)
        page.screenshot(path=str(OUT / (style + '-workflow.png')))
        facts['pageErrors'] = errors
        facts['screenshots'] = [str(OUT / (style + '-station.png')), str(OUT / (style + '-workflow.png'))]
        results.append(facts)
        context.close()
    browser.close()
assert results[0]['accent'] != results[1]['accent']
assert results[0]['lines'] == results[1]['lines'], 'Palette must not alter workflow configuration'
Path('lab/evidence/browser.json').write_text(json.dumps(results, indent=2))
print(json.dumps(results, indent=2))
