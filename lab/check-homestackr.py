"""Headless configuration/visual check. Never submits a job or reads credentials."""
import glob
import json
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

OUT = Path('/tmp/opencode/starnet-homestackr')
OUT.mkdir(parents=True, exist_ok=True)
BINARY = sorted(glob.glob('/home/sandboxhp/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell'))[-1]
BASE = 'http://127.0.0.1:8790'
reports = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=BINARY, args=['--no-sandbox', '--disable-dev-shm-usage'])
    for mobile in (False, True):
        context = browser.new_context(viewport={'width': 390, 'height': 844} if mobile else {'width': 1440, 'height': 1000}, is_mobile=mobile, has_touch=mobile)
        denied, errors = [], []

        def restrict(route):
            req = route.request
            u = urlsplit(req.url)
            if u.netloc != '127.0.0.1:8790':
                return route.abort()
            if req.method not in ('GET', 'HEAD', 'OPTIONS') and u.path not in ('/api/save', '/api/roster', '/api/routing', '/api/presence'):
                denied.append({'method': req.method, 'path': u.path})
                return route.fulfill(status=403, content_type='application/json', body='{"ok":false,"error":"visual check: configuration only"}')
            route.continue_()

        context.route('**/*', restrict)
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)[:200]))
        page.goto(BASE + '/', wait_until='domcontentloaded', timeout=30000)
        page.wait_for_function('() => window.__SKYNET_TEST__ && window.__SKYNET_TEST__.ready()', timeout=45000)
        for selector in ('.tut-coach-ok', '#nav-coach-x'):
            if page.locator(selector).is_visible():
                page.locator(selector).click()
        facts = page.evaluate('''async () => {
          const st = App.station(), room = st.rooms().find(r => r.name === 'HomeStackR');
          const lines = WorkflowsWindow._floor().lines.filter(l => /^HomeStackR/.test(l.name));
          const agents = App.agents().filter(a => /^hsr_/.test(a.id));
          return {ready: window.__SKYNET_TEST__.ready(), room: room && {id: room.id, name: room.name},
            lines: lines.map(l => ({name: l.name, key: l.key, steps: l.steps.map(s => ({id: s.id, agentId: s.agentId, desk: s.desk}))})),
            agentCount: agents.length, calls: window.__SKYNET_TEST__.reduceTotals().calls,
            rosterSynced: await App.pushRoster()};
        }''')
        assert facts['ready'] and facts['room'] and facts['agentCount'] == 9
        assert len(facts['lines']) == 3 and facts['rosterSynced']
        assert all(len(l['steps']) == 3 and all(s['desk'] for s in l['steps']) for l in facts['lines'])
        assert facts['calls'] == 0, 'no generation is part of this configuration check'
        mode = 'mobile' if mobile else 'desktop'
        page.screenshot(path=str(OUT / (mode + '-station.png')))
        for i, line in enumerate(facts['lines']):
            page.evaluate('(key) => WorkflowsWindow.openLine(key)', line['key'])
            page.locator('.wfw').wait_for(state='visible', timeout=10000)
            panel = page.locator('.wfw').inner_text()
            assert 'HomeStackR' in panel
            if not mobile:
                page.screenshot(path=str(OUT / ('workflow-' + str(i + 1) + '.png')))
        assert not errors, errors
        facts.update({'mode': mode, 'pageErrors': errors, 'deniedRequests': denied})
        reports.append(facts)
        context.close()
    browser.close()
Path('lab/evidence/homestackr-browser.json').write_text(json.dumps(reports, indent=2, ensure_ascii=False))
print(json.dumps(reports, indent=2, ensure_ascii=False))
