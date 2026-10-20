"""Live Colony installation on the isolated fixture (127.0.0.1:8794).

A desktop tab stays open and idle while the installation is committed through the
sidecar. It must adopt the new layout WITHOUT a page reload (same JavaScript context).
A fresh mobile load must then show the same installed state. No model calls, no
external actions; the only writes are the installation itself and normal saves."""
import glob
import json
import re
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8794'
OUT = Path('/tmp/opencode/colony-implementation/native-visual')
OUT.mkdir(parents=True, exist_ok=True)
BINARY = sorted(glob.glob('/home/sandboxhp/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell'))[-1]
ALLOWED_WRITES = {'/api/save', '/api/roster', '/api/routing', '/api/presence', '/api/tickets', '/api/colony/installation/install'}
FACTS = """() => ({
  roomNames: App.station().rooms().map(r => r.name),
  nativeProcesses: WorkflowsWindow._floor().lines.filter(l => /^[LAH]\\d/.test(l.name)).length,
  agents: App.agents().filter(a => /^colony_/.test(a.id)).length,
  crewRows: document.querySelectorAll('.crew-row').length,
  crewSummary: document.querySelector('#crew-sum') ? document.querySelector('#crew-sum').textContent : '',
  calls: window.__SKYNET_TEST__.reduceTotals().calls,
  saveRevision: CloudSave.revision(),
  commitId: App.colonyInstallation() ? App.colonyInstallation().commitId : null
})"""


def token():
    html = urllib.request.urlopen(BASE + '/', timeout=10).read().decode()
    match = re.search(r'window\.__STARNET_API_TOKEN__=("(?:\\.|[^"])*")', html)
    if not match:
        raise RuntimeError('station token not found')
    return json.loads(match.group(1))


def call(method, route, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(BASE + route, data=data, method=method, headers={
        'X-StarNet-Token': token(), 'Origin': BASE, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode() or '{}')


def guard(context):
    def restrict(route):
        request = route.request
        parts = urlsplit(request.url)
        if parts.netloc != '127.0.0.1:8794' or (request.method not in ('GET', 'HEAD', 'OPTIONS') and parts.path not in ALLOWED_WRITES):
            return route.abort()
        route.continue_()
    context.route('**/*', restrict)


def open_station(browser, mobile):
    context = browser.new_context(viewport={'width': 390, 'height': 900} if mobile else {'width': 1440, 'height': 1000},
                                  is_mobile=mobile, has_touch=mobile)
    guard(context)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE + '/', wait_until='domcontentloaded', timeout=30000)
    page.wait_for_function('() => window.__SKYNET_TEST__ && window.__SKYNET_TEST__.ready()', timeout=45000)
    for selector in ('.tut-coach-ok', '#nav-coach-x'):
        if page.locator(selector).is_visible():
            page.locator(selector).click()
    return context, page, errors


def wait_for_installation(page):
    page.wait_for_function("() => App.colonyInstallation() && App.station().rooms().some(r => r.name === 'Ashveil')", timeout=40000)
    page.wait_for_function("() => document.querySelector('#crew-sum') && document.querySelector('#crew-sum').textContent.includes('OFFLINE')", timeout=30000)
    page.wait_for_timeout(2500)


def assert_installed(facts, commit):
    _, saved = call('GET', '/api/save')
    assert facts['commitId'] == commit, facts
    assert {'Lifestruct', 'Ashveil', 'HomeStackR'}.issubset(set(facts['roomNames'])), facts
    assert facts['nativeProcesses'] == 13, facts
    assert facts['agents'] == 17 and facts['crewRows'] == 20, facts
    assert facts['calls'] == 0, facts
    assert 'OFFLINE' in facts['crewSummary'], facts
    assert facts['saveRevision'] == saved['save']['_saveRevision'], ('browser and sidecar disagree on the save revision', facts)


def main():
    reports = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=BINARY, args=['--no-sandbox', '--disable-dev-shm-usage'])
        try:
            desktop, page, desktop_errors = open_station(browser, mobile=False)
            page.wait_for_timeout(1500)
            page.evaluate('() => CloudSave.flush({force: true})')
            page.evaluate("() => { window.__colonyNoReload = 'same-page'; }")
            status, preview = call('GET', '/api/colony/installation/preview')
            assert status == 200 and preview.get('ok'), preview
            status, installed = call('POST', '/api/colony/installation/install', {
                'expectedSaveRevision': preview['expectedSaveRevision'],
                'expectedStateRevision': preview['expectedStateRevision'],
                'previewDigest': preview['previewDigest']})
            assert status == 200 and installed.get('installed') is True, installed
            wait_for_installation(page)
            assert page.evaluate('() => window.__colonyNoReload') == 'same-page', 'the idle tab was reloaded'
            desktop_facts = page.evaluate(FACTS)
            assert_installed(desktop_facts, installed['commitId'])
            page.screenshot(path=str(OUT / 'desktop.png'))
            assert not desktop_errors, desktop_errors
            reports.append({'mode': 'desktop-live-adoption-without-reload', **desktop_facts, 'errors': desktop_errors})
            desktop.close()

            mobile, mpage, mobile_errors = open_station(browser, mobile=True)
            wait_for_installation(mpage)
            mobile_facts = mpage.evaluate(FACTS)
            assert_installed(mobile_facts, installed['commitId'])
            mpage.screenshot(path=str(OUT / 'mobile.png'))
            assert not mobile_errors, mobile_errors
            reports.append({'mode': 'mobile-fresh-load', **mobile_facts, 'errors': mobile_errors})
            mobile.close()
        finally:
            browser.close()
    (OUT / 'browser.json').write_text(json.dumps(reports, indent=2, ensure_ascii=False))
    print(json.dumps(reports, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
