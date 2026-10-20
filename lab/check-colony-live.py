"""Read-only verification through the real, authenticated Tailscale HTTPS front door.

Never starts inference or a task. Browser writes and off-origin requests are blocked.
Credentials are used locally, never written to the evidence or printed.
"""
import glob
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://sandboxhp-virtual-machine.tailcfc506.ts.net:8791'
OUT = Path('/tmp/opencode/colony-live-check')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    credentials = json.loads((ROOT / '.lab-state/lan-access.json').read_text())
    binary = sorted(glob.glob('/home/sandboxhp/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell'))[-1]
    reports = []
    with sync_playwright() as p:
        # No ignore_https_errors: the actual HTTPS certificate must validate.
        anonymous = p.request.new_context()
        assert anonymous.get(BASE + '/').status == 401
        anonymous.dispose()
        api = p.request.new_context(http_credentials=credentials)
        html = api.get(BASE + '/')
        assert html.status == 200
        token = json.loads(re.search(r'window\.__STARNET_API_TOKEN__=("(?:\\.|[^"])*")', html.text()).group(1))
        headers = {'X-StarNet-Token': token, 'Origin': BASE}

        def get(route):
            response = api.get(BASE + route, headers=headers)
            assert response.status == 200, (route, response.status)
            return response.json()

        assert api.get(BASE + '/api/colony').status == 403
        assert api.get(BASE + '/api/colony', headers={**headers, 'Origin': 'https://example.invalid'}).status == 403
        lab = get('/api/lab/status')
        assert lab['live'] and lab['execution'] and not lab['offline'], lab
        installation = get('/api/colony/installation')
        assert installation['installed'] and installation['state'] == 'committed'
        view = get('/api/colony')
        assert len(view['processes']) == 13
        ids = set(installation['agentIds'])
        assert len(ids) == 17
        assert ids == {a['id'] for a in view['team'] if a['nativeInstalled']}
        saved = get('/api/save')['save']
        profiles = [saved['agent'], *saved.get('agents', [])]
        assert all(a.get('provider') == 'custom' and a.get('model') == 'deepseek-v4.1-flash' for a in profiles)
        browser = p.chromium.launch(executable_path=binary, args=['--no-sandbox', '--disable-dev-shm-usage'])
        try:
            for mode, width, height in [('desktop', 1440, 1000), ('mobile', 390, 900)]:
                context = browser.new_context(http_credentials=credentials, viewport={'width': width, 'height': height},
                                              is_mobile=mode == 'mobile', has_touch=mode == 'mobile')
                def restrict(route):
                    req = route.request
                    if not req.url.startswith(BASE + '/') or req.method not in ('GET', 'HEAD', 'OPTIONS'):
                        return route.abort()
                    route.continue_()
                context.route('**/*', restrict)
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(BASE + '/', wait_until='domcontentloaded')
                page.wait_for_function('() => window.__SKYNET_TEST__?.ready()', timeout=60000)
                for selector in ('.tut-coach-ok', '#nav-coach-x'):
                    if page.locator(selector).is_visible():
                        page.locator(selector).click()
                page.wait_for_function("() => document.querySelector('#lab-notice')?.textContent.includes('KI aktiv')", timeout=30000)
                page.wait_for_function('() => App.colonyInstallation()', timeout=30000)
                facts = page.evaluate("""() => ({
                  rooms: App.station().rooms().map(r => r.name),
                  agentIds: App.agents().map(a => a.id),
                  pipelines: WorkflowsWindow._floor().lines.filter(l => /^[LAH]\\d/.test(l.name)).length,
                  calls: window.__SKYNET_TEST__.reduceTotals().calls,
                  commitId: App.colonyInstallation().commitId,
                  notice: document.querySelector('#lab-notice').textContent
                })""")
                assert {'Lifestruct', 'Ashveil', 'HomeStackR'} <= set(facts['rooms'])
                assert ids <= set(facts.pop('agentIds'))
                assert facts['pipelines'] == 13 and facts['calls'] == 0
                assert facts['commitId'] == installation['commitId']
                page.screenshot(path=str(OUT / (mode + '-station.png')))
                page.goto(BASE + '/colony/index.html', wait_until='domcontentloaded')
                page.wait_for_function("() => document.body.innerText.includes('Verbunden')", timeout=30000)
                assert page.get_by_role('heading', name='Business-Steuerung', exact=True).count() == 1
                page.screenshot(path=str(OUT / (mode + '-business.png')))
                assert not errors, errors
                reports.append({'mode': mode, **facts, 'businessConsoleConnected': True, 'pageErrors': errors})
                context.close()
        finally:
            browser.close()
        # Verification must not silently rewrite the user's save.
        assert get('/api/save')['save'] == saved, 'Station changed during read-only verification'
        api.dispose()
    evidence = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'url': BASE,
                'httpsCertificateValidated': True, 'accessChecks': {'anonymous': 401, 'missingToken': 403, 'foreignOrigin': 403},
                'live': True, 'configuredProfiles': len(profiles), 'model': 'deepseek-v4.1-flash',
                'saveUnchanged': True, 'inferenceTested': False, 'realPilotAccepted': False, 'checks': reports}
    (ROOT / 'lab/evidence/colony-live.json').write_text(json.dumps(evidence, indent=2, ensure_ascii=False))
    print(json.dumps(evidence, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
