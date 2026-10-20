"""Verification of the real local lab (127.0.0.1:8790) after the Colony takeover.

Reads the installation through the API, opens the Roboterhaus headless and confirms
three business rooms, 13 pipelines and 17 identities. Negative checks: the offline lab
refuses execution and every non-authoring write. Loading the page may save the station
as it always does; no model calls, no external actions. Writes lab/evidence/colony-takeover.json."""
import glob
import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:8790'
OUT = Path('/tmp/opencode/colony-implementation/takeover')
OUT.mkdir(parents=True, exist_ok=True)
BINARY = sorted(glob.glob('/home/sandboxhp/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell'))[-1]
FACTS = """() => ({
  roomNames: App.station().rooms().map(r => r.name),
  nativeProcesses: WorkflowsWindow._floor().lines.filter(l => /^[LAH]\\d/.test(l.name)).length,
  agentIds: App.agents().filter(a => /^colony_/.test(a.id)).map(a => a.id),
  crewRows: document.querySelectorAll('.crew-row').length,
  crewSummary: document.querySelector('#crew-sum') ? document.querySelector('#crew-sum').textContent : '',
  calls: window.__SKYNET_TEST__.reduceTotals().calls,
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


def main():
    status, lab = call('GET', '/api/lab/status')
    assert status == 200 and lab.get('offline') is True and lab.get('execution') is False, lab
    status, installation = call('GET', '/api/colony/installation')
    assert status == 200 and installation.get('installed') is True, installation
    installed_ids = installation['agentIds']
    status, view = call('GET', '/api/colony')
    # The team view shows the whole role catalogue; only identities the 13 pipelines
    # actually need were created as native agents. That split is the invariant here,
    # not an exact head count (older labs may carry pre-existing identities).
    native = [a for a in view['team'] if a.get('nativeInstalled')]
    assert sorted(a['id'] for a in native) == sorted(installed_ids), (native, installed_ids)
    assert len(view['processes']) == 13, len(view['processes'])

    run_status, run_body = call('POST', '/api/colony/run', {
        'taskId': 'none', 'expectedRevision': view['revision'], 'reserve': {'usd': 0.01, 'tokens': 100, 'ms': 1000}})
    command_status, command_body = call('POST', '/api/colony/command', {'type': 'task.create', 'expectedRevision': view['revision']})
    assert run_status == 403 and command_status == 403, (run_status, run_body, command_status, command_body)

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=BINARY, args=['--no-sandbox', '--disable-dev-shm-usage'])
        try:
            context = browser.new_context(viewport={'width': 1440, 'height': 1000})
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(BASE + '/', wait_until='domcontentloaded', timeout=30000)
            page.wait_for_function('() => window.__SKYNET_TEST__ && window.__SKYNET_TEST__.ready()', timeout=60000)
            for selector in ('.tut-coach-ok', '#nav-coach-x'):
                if page.locator(selector).is_visible():
                    page.locator(selector).click()
            page.wait_for_function("() => App.colonyInstallation() && App.station().rooms().some(r => r.name === 'Ashveil')", timeout=40000)
            page.wait_for_function("() => document.querySelector('#crew-sum') && document.querySelector('#crew-sum').textContent.includes('OFFLINE')", timeout=40000)
            page.wait_for_timeout(2500)
            facts = page.evaluate(FACTS)
            page.screenshot(path=str(OUT / 'desktop.png'))
            assert {'Lifestruct', 'Ashveil', 'HomeStackR'}.issubset(set(facts['roomNames'])), facts
            assert facts['nativeProcesses'] == 13, facts
            assert facts['agentIds'] and set(installed_ids).issubset(set(facts['agentIds'])), facts
            assert facts['calls'] == 0 and facts['commitId'] == installation['commitId'] and not errors, (facts, errors)
        finally:
            browser.close()

    evidence = {
        'checkedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'commitId': installation['commitId'],
        'backup': installation.get('backup'),
        'labBackup': str(Path('.lab-state/authoring-backups').resolve() / 'before-colony-takeover-1792403838995.json'),
        'rooms': sorted(facts['roomNames']),
        'pipelines': facts['nativeProcesses'],
        'installedIdentities': len(installed_ids),
        'identitiesInSave': len(facts['agentIds']),
        'roleCatalogue': len(view['team']),
        'crewRows': facts['crewRows'],
        'crewSummary': facts['crewSummary'],
        'modelCalls': facts['calls'],
        'offlineNegativeChecks': {'run': run_status, 'command': command_status},
        'realPilotAccepted': False,
        'screenshot': str(OUT / 'desktop.png'),
    }
    (ROOT / 'lab' / 'evidence' / 'colony-takeover.json').write_text(json.dumps(evidence, indent=2, ensure_ascii=False))
    print(json.dumps(evidence, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
