"""Verify the central staffed room locally; block execution and credential routes."""
import glob
import json
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

OUT = Path('/tmp/opencode/starnet-orchestrator')
OUT.mkdir(parents=True, exist_ok=True)
binary = sorted(glob.glob('/home/sandboxhp/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell'))[-1]
reports = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=binary, args=['--no-sandbox', '--disable-dev-shm-usage'])
    for mobile in (False, True):
        context = browser.new_context(viewport={'width': 390, 'height': 844} if mobile else {'width': 1600, 'height': 1000}, is_mobile=mobile, has_touch=mobile)
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
        page.goto('http://127.0.0.1:8790/', wait_until='domcontentloaded', timeout=30000)
        page.wait_for_function('() => window.__SKYNET_TEST__ && window.__SKYNET_TEST__.ready()', timeout=45000)
        for selector in ('.tut-coach-ok', '#nav-coach-x'):
            if page.locator(selector).is_visible():
                page.locator(selector).click()
        origin = page.evaluate('App.station().projectGeometry().origin')
        # Prove the actual body is at its assigned room, not just that its desk
        # exists there. No teleport, fake job or pose override in this check.
        page.wait_for_function('''o => {
          const b = World.bodies().find(b => b.id === 'colony_coordinator');
          const st = App.station(), room = st.rooms().find(r => r.name === 'ORCHESTRATOR');
          return b && !b.unplaced && st.roomAt(b.tile.x + o.tx, b.tile.y + o.ty) === room.id;
        }''', arg=origin, timeout=20000, polling=200)
        facts = page.evaluate('''async () => {
          const st = App.station(), room = st.rooms().find(r => r.name === 'ORCHESTRATOR');
          const a = App.agents().find(a => a.id === 'colony_coordinator');
          const desk = st.props().find(p => p.t === 'desk' && p.agentId === 'colony_coordinator');
          const r = room.rects[0], y = r.y1 + 3;
          const left = st.roomById(st.roomAt(r.x1 - 1, y));
          const right = st.roomById(st.roomAt(r.x2 + 1, y));
          const b = World.bodies().find(b => b.id === 'colony_coordinator');
          const o = st.projectGeometry().origin;
          return {ready: window.__SKYNET_TEST__.ready(), room: {id: room.id, name: room.name, rect: r},
            leftRoom: left.name, rightRoom: right.name,
            agent: a && {id: a.id, name: a.name, role: a.role, workshop: a.workshop, approvalMode: a.approvalMode},
            deskInRoom: desk && st.roomAt(desk.x, desk.y) === room.id,
            bodyInRoom: b && !b.unplaced && st.roomAt(b.tile.x + o.tx, b.tile.y + o.ty) === room.id,
            lines: WorkflowsWindow._floor().lines.map(l => ({name: l.name, steps: l.steps.map(s => ({id: s.id, agentId: s.agentId, desk: s.desk}))})),
            calls: window.__SKYNET_TEST__.reduceTotals().calls, rosterSynced: await App.pushRoster()};
        }''')
        assert facts['ready'] and facts['deskInRoom'] and facts['bodyInRoom'] and facts['agent']['name'] == 'Orchestrator'
        assert facts['leftRoom'] == 'HOME' and facts['rightRoom'] == 'HomeStackR'
        assert facts['agent']['workshop'] is False and facts['agent']['approvalMode'] == 'ask'
        assert len(facts['lines']) == 4 and all(len(l['steps']) == 3 and all(s['desk'] for s in l['steps']) for l in facts['lines'])
        assert facts['calls'] == 0 and facts['rosterSynced']
        assert not errors, errors
        mode = 'mobile' if mobile else 'desktop'
        page.screenshot(path=str(OUT / (mode + '-station.png')))
        facts.update({'mode': mode, 'pageErrors': errors, 'deniedRequests': denied})
        reports.append(facts)
        context.close()
    browser.close()
Path('lab/evidence/orchestrator-browser.json').write_text(json.dumps(reports, indent=2, ensure_ascii=False))
print(json.dumps([{k: v for k, v in r.items() if k != 'deniedRequests'} for r in reports], indent=2, ensure_ascii=False))
