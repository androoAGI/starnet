"""Read-only desktop/mobile proof. Blocks browser writes, external requests and inference."""
import glob
import json
import re
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:8790'
OUT = ROOT / 'output/homestackr-clarity'


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    html = urllib.request.urlopen(BASE, timeout=10).read().decode()
    token = json.loads(re.search(r'window\.__STARNET_API_TOKEN__=("(?:\\.|[^"\\])*")', html).group(1))

    def get(route):
        req = urllib.request.Request(BASE + route, headers={'Origin': BASE, 'X-StarNet-Token': token})
        return json.loads(urllib.request.urlopen(req, timeout=10).read())

    before = get('/api/save')['save']
    colony_before = get('/api/colony')
    binary = sorted(glob.glob('/home/sandboxhp/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell'))[-1]
    reports = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=binary, args=['--no-sandbox', '--disable-dev-shm-usage'])
        try:
            for mode, width, height in [('desktop', 1440, 1100), ('mobile', 390, 844)]:
                context = browser.new_context(viewport={'width': width, 'height': height}, is_mobile=mode == 'mobile', has_touch=mode == 'mobile')
                denied, errors = [], []

                def restrict(route):
                    req = route.request
                    if urlsplit(req.url).netloc != '127.0.0.1:8790':
                        return route.abort()
                    if req.method not in ('GET', 'HEAD', 'OPTIONS'):
                        denied.append(urlsplit(req.url).path)
                        return route.fulfill(status=403, content_type='application/json', body='{"ok":false,"error":"read-only visual proof"}')
                    route.continue_()

                context.route('**/*', restrict)
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)[:200]))
                page.goto(BASE, wait_until='domcontentloaded')
                page.wait_for_function('() => window.__SKYNET_TEST__?.ready() && window.ColonyProcessState', timeout=60000)
                for selector in ('.tut-coach-ok', '#nav-coach-x'):
                    if page.locator(selector).is_visible():
                        page.locator(selector).click()
                lines = page.evaluate("() => WorkflowsWindow._floor().lines.filter(l => /^H0[1-5]/.test(l.name)).map(l => ({key:l.key,name:l.name,intakeId:l.intakeId,steps:l.steps.map(s=>({id:s.id,label:s.label,hands:s.hands}))}))")
                assert len(lines) == 5
                for line in lines:
                    page.evaluate('(key) => WorkflowsWindow.openLine(key)', line['key'])
                    page.locator('.wfw-readable').wait_for(state='visible')
                    panel = page.locator('.wfw').inner_text()
                    process_id = line['name'].split(' ')[0]
                    proc = colony_before['processes'][process_id]
                    expected_status = 'Über Business-Steuerung' if proc['enabled'] else 'Modell oder Freigabe fehlt' if proc['implemented'] else 'Noch nicht eingerichtet'
                    assert expected_status in panel and 'READY TO RUN' not in panel
                    assert page.locator('.wfw [data-act="send"], .wfw #wfw-job').count() == 0
                    for step in line['steps']:
                        assert step['label'] in panel and step['hands'] in panel
                    layout = page.evaluate("""() => {
                      const map = document.querySelector('.wfw-mapwrap');
                      const nodes = [...map.querySelectorAll('.wf-node')].map(e => {const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width}});
                      return {width:map.clientWidth,scrollWidth:map.scrollWidth,nodes};
                    }""")
                    assert layout['scrollWidth'] <= layout['width'] + 2, layout
                    assert all(b['y'] > a['y'] for a, b in zip(layout['nodes'], layout['nodes'][1:])), layout

                pinterest = next(line for line in lines if line['name'].startswith('H03'))
                page.evaluate('(key) => WorkflowsWindow.openLine(key)', pinterest['key'])
                page.locator('.wfw-business').wait_for(state='visible')
                sizes = page.evaluate("""() => ({title:parseFloat(getComputedStyle(document.querySelector('.wfw-title')).fontSize),note:parseFloat(getComputedStyle(document.querySelector('.wfw-business p')).fontSize)})""")
                assert sizes['title'] >= 20 and sizes['note'] >= 16, sizes
                page.mouse.move(1, 1)
                page.locator('.term.wfw-win').screenshot(path=str(OUT / (mode + '-status.png')))
                page.evaluate("document.querySelector('.wfw-readable [data-step]').scrollIntoView({block:'center'})")
                page.locator('.term.wfw-win').screenshot(path=str(OUT / (mode + '-tasks.png')))
                page.locator('.wfw-readable [data-step]').first.click()
                page.locator('.wfw-stepbox').wait_for(state='visible')
                assert 'ergebnis / übergabe' in page.locator('.wfw-stepbox').inner_text().casefold()

                # The native editor must tell the same truth and offer no bypass test.
                page.evaluate('(id) => Build.editLine(id)', pinterest['intakeId'])
                page.locator('.wf-panel').wait_for(state='visible')
                p = colony_before['processes']['H03']
                assert page.locator('#wf-pill').inner_text() == ('Über Business-Steuerung' if p['enabled'] else 'Modell oder Freigabe fehlt' if p['implemented'] else 'Noch nicht eingerichtet')
                assert page.locator('#wf-send, #wf-test, #wf-run').count() == 0
                assert page.locator('#wf-sendnow').is_hidden()
                assert 'Business-Steuerung öffnen' in page.locator('#wf-body').inner_text()
                calls = page.evaluate('() => window.__SKYNET_TEST__.reduceTotals().calls')
                assert calls == 0

                # A failed business-status read must clear a formerly successful read.
                if mode == 'desktop':
                    context.route(BASE + '/api/colony', lambda route: route.fulfill(status=503, content_type='application/json', body='{"ok":false}'))
                    page.wait_for_function('() => window.ColonyProcessState === null', timeout=20000)
                    page.wait_for_function("() => document.querySelector('#wf-pill')?.textContent === 'Status nicht bestätigt'", timeout=10000)
                    assert page.locator('#wf-send, #wf-test, #wf-run').count() == 0
                    context.unroute(BASE + '/api/colony')

                page.goto(BASE + '/colony/index.html?process=H03', wait_until='domcontentloaded')
                page.wait_for_function("() => document.querySelector('#brand').value === 'homestackr' && document.querySelector('#process-H03 ol')", timeout=30000)
                process = page.locator('#process-H03')
                assert process.locator('li').count() == 4
                assert 'Qualitätsschleife' in process.inner_text()
                assert colony_before['processes']['H03'].get('steps', [{}, {'label': 'Pin-Texte entwerfen'}])[1]['label'] in process.inner_text()
                process.screenshot(path=str(OUT / (mode + '-business.png')))
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 2')
                assert page.locator('#tasks > article').count() == 0
                assert page.locator('#tasks details.technical-tests > summary').count() == 1
                assert page.locator('#process-select option').count() == 13
                assert page.locator('#save-task').is_visible() and page.locator('#load-models').is_visible()
                page.locator('#process-select').select_option('L02a')
                mail_packet = json.loads(page.locator('#source-packet').input_value())
                assert len(mail_packet['inputs']['mails_1_to_7']) == 7 and mail_packet['inputs']['sequence'] == ['1','2','3','4','5','6','7']
                page.locator('#process-select').select_option('L01')
                pinterest_packet = json.loads(page.locator('#source-packet').input_value())
                assert 'metrics' in pinterest_packet['inputs'] and pinterest_packet['targets'] and pinterest_packet['boards'] == []
                assert not errors, errors
                reports.append({'mode': mode, 'pipelines': len(lines), 'specificTasks': sum(len(line['steps']) for line in lines), 'horizontalOverflow': False, 'nativeEditorStatusCorrect': True, 'failedStatusReadTested': mode == 'desktop', 'modelCalls': calls, 'pageErrors': errors, 'browserWritesBlocked': len(denied)})
                context.close()
        finally:
            browser.close()
    assert get('/api/save')['save'] == before, 'Save changed during visual proof'
    after = get('/api/colony')
    assert after['revision'] == colony_before['revision'] and after['tasks'] == colony_before['tasks']
    report = {'saveUnchangedByVerification': True, 'businessTasksUnchanged': True, 'checks': reports}
    (OUT / 'verification.json').write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
