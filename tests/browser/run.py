#!/usr/bin/env python3
"""Drive the real page in headless Chrome against a local mock of Sesc's API.

Sesc refuses headless Chrome, so this is as close as an automated test can get. It
serves a copy of `web/` that differs only in where it points, with the mock on a
separate origin, so CORS and the Content-Security-Policy really apply. Its responses
were recorded on 2026-11-05, and the page's clock is moved to that day.

It can't show how the real API behaves today, so that still needs a person.

    python tests/browser/run.py [--large-booklets] [--screenshots DIR]

Needs Python 3.10 or newer and Chrome (set CHROME if it isn't found). The booklets are
Sesc's own PDFs, so they aren't in this repository. Each one is downloaded once, into
a folder git ignores.
"""
import argparse
import datetime
import html
import http.server
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CACHE = HERE / '.cache'
RECORDED_AT = '2026-11-05T12:00:00-03:00'
BOOKLETS = {
    'november': 'https://www.sescsp.org.br/wp-content/uploads/2026/10/V13_Em-Cartaz_2026_novembro_VF.pdf',
    'october': 'https://www.sescsp.org.br/wp-content/uploads/2026/09/Em-Cartaz_2026_outubro.pdf',
    'august': 'https://www.sescsp.org.br/wp-content/uploads/2026/07/Em-Cartaz_2026_agosto.pdf',
}
OUTPUT_MARK = '<pre id="test-output">'
GIF = bytes.fromhex('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b')

state = {'mode': 'ok', 'latency': 0.03, 'storage': {}, 'pdf': b''}
stats = {}
release = threading.Event()
failures = []
recorded = {}


def reset_stats():
    stats.update(listing=0, detail=0, archive=0, pdf=0, in_flight=0, peak=0, starts=[], origins=set())


class Api(http.server.BaseHTTPRequestHandler):
    """Stands in for Sesc, and also carries results between visits."""

    protocol_version = 'HTTP/1.1'

    def do_POST(self):
        state['storage'] = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        release.set()
        self.reply(200, b'{}', self.headers.get('Origin'))

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        origin = self.headers.get('Origin')
        if parsed.path == '/__hold':
            # The page's load event waits for this image, so Chrome waits for the page to finish.
            release.wait(180)
            self.reply(200, GIF, None, 'image/gif')
        elif parsed.path == '/__storage':
            self.reply(200, json.dumps(state['storage']).encode('utf-8'), origin)
        elif state['mode'] == 'ok' and parsed.path.endswith('/wp/v2/posts'):
            stats['archive'] += 1
            link = f'{self.api_origin}/wp-content/uploads/2026/10/V13_Em-Cartaz_2026_novembro_VF.pdf'
            older = f'{self.api_origin}/wp-content/uploads/2026/09/older.pdf'
            body = [{'content': {'rendered': f'<a href="{link}">new</a><a href="{older}">old</a>'}}]
            self.reply(200, json.dumps(body).encode('utf-8'), origin)
        elif parsed.path.endswith('.pdf'):
            stats['pdf'] += 1
            self.reply(200, state['pdf'], '*', 'application/pdf')
        else:
            self.answer_activities(parsed, origin)

    def answer_activities(self, parsed, origin):
        is_listing = parsed.path.endswith('/filter')
        stats['origins'].add(origin)
        stats['listing' if is_listing else 'detail'] += 1
        stats['starts'].append(time.monotonic())
        stats['in_flight'] += 1
        stats['peak'] = max(stats['peak'], stats['in_flight'])
        try:
            mode = state['mode']
            if mode == 'block-all' or (mode == 'block-details' and not is_listing):
                # Like CloudFront's refusal: a 403 with no CORS header, which a browser sees as a network error.
                self.reply(403, b'<!DOCTYPE html><h1>403 ERROR</h1>', None, 'text/html')
            elif is_listing:
                self.reply(200, recorded['listing'].encode('utf-8'), origin)
            else:
                time.sleep(state['latency'])
                entry = recorded['details'].get(urllib.parse.parse_qs(parsed.query)['slug'][0])
                if entry:
                    self.reply(entry['status'], entry['body'].encode('utf-8'), origin)
                else:
                    self.reply(404, b'{"code":"activity_not_found"}', origin)
        finally:
            stats['in_flight'] -= 1

    def reply(self, status, body, origin, kind='application/json; charset=UTF-8'):
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            if origin != '*':
                self.send_header('Vary', 'Origin')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class Site(http.server.SimpleHTTPRequestHandler):
    # Windows can map these to something else, and browsers then refuse to run modules.
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript'}

    def log_message(self, *args):
        pass


def serve(handler):
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_port}'


def replace_once(text, old, new):
    assert text.count(old) == 1, f'expected exactly one {old!r} in the page, so run.py needs updating'
    return text.replace(old, new)


def build_site(site, api_origin):
    """Copy the page, and change only where it points and what's needed to watch it."""
    shutil.copytree(ROOT / 'web', site)
    plays = (site / 'plays.js').read_text(encoding='utf-8')
    (site / 'plays.js').write_text(
        replace_once(plays, 'export const SITE_URL = "https://www.sescsp.org.br"', f'export const SITE_URL = "{api_origin}"'),
        encoding='utf-8')
    page = (site / 'index.html').read_text(encoding='utf-8')
    page = replace_once(page, 'connect-src https://www.sescsp.org.br', f'connect-src {api_origin}')
    page = replace_once(page, 'img-src data:', f'img-src data: {api_origin}')
    page = replace_once(page, '<script type="module"', '<script src="probe.js"></script>\n<script type="module"')
    page = replace_once(page, '<main id="results">', f'<img src="{api_origin}/__hold" alt="" width="1" height="1"><main id="results">')
    (site / 'index.html').write_text(page, encoding='utf-8')
    offset = round((datetime.datetime.fromisoformat(RECORDED_AT).timestamp() - time.time()) * 1000)
    probe = (HERE / 'probe.js').read_text(encoding='utf-8')
    (site / 'probe.js').write_text(probe.replace('__API__', api_origin).replace('__CLOCK_OFFSET__', str(offset)), encoding='utf-8')


def find_chrome():
    candidates = [
        os.environ.get('CHROME'),
        r'C:\Program Files\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        shutil.which('google-chrome'),
        shutil.which('chromium'),
        shutil.which('chromium-browser'),
    ]
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return candidate
    sys.exit('Chrome not found. Set CHROME to its path.')


def booklet(name):
    path = CACHE / f'{name}.pdf'
    if not path.exists():
        print(f'Downloading the {name} booklet from Sesc. This only happens once.')
        request = urllib.request.Request(BOOKLETS[name], headers={'User-Agent': 'ticket-drop-browser-test'})
        with urllib.request.urlopen(request, timeout=300) as response:
            data = response.read()
        CACHE.mkdir(exist_ok=True)
        path.write_bytes(data)
    return path.read_bytes()


class Browser:
    def __init__(self, chrome, work, site_url):
        self.chrome, self.work, self.site_url = chrome, work, site_url

    def run(self, args, url):
        """Run Chrome once with a new profile, set to prefer light mode like many visitors."""
        profile = self.work / f'profile-{uuid.uuid4().hex[:8]}'
        command = [self.chrome, '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
                   '--blink-settings=preferredColorScheme=1', f'--user-data-dir={profile}', *args, url]
        try:
            return subprocess.run(command, capture_output=True, timeout=240)
        finally:
            shutil.rmtree(profile, ignore_errors=True)

    def visit(self, query='', mode='ok', latency=0.03):
        """Open the page, wait for it to finish, and return its report and the requests it made."""
        state.update(mode=mode, latency=latency)
        release.clear()
        reset_stats()
        dom = self.run(['--dump-dom'], f'{self.site_url}/{query}').stdout.decode('utf-8', 'replace')
        start = dom.find(OUTPUT_MARK)
        report = {}
        if start >= 0:
            report = json.loads(html.unescape(dom[start + len(OUTPUT_MARK):dom.find('</pre>', start)]))
        gaps = [b - a for a, b in zip(stats['starts'], stats['starts'][1:])]
        return {**report, **stats, 'finished': start >= 0, 'smallest_gap': min(gaps, default=None)}

    def screenshot(self, name, width, height, folder):
        state.update(mode='ok', latency=0.03)
        release.clear()
        target = folder / f'{name}.png'
        url = f'{self.site_url}/'
        size = (width, height)
        if width < 500:
            # Headless Chrome won't make a window this narrow, so frame the page in a wider one.
            frame = f'<!doctype html><body style="margin:0;background:#777"><iframe src="./" style="border:0;width:{width}px;height:{height}px"></iframe>'
            (self.work / 'site' / f'{name}.html').write_text(frame, encoding='utf-8')
            url += f'{name}.html'
            size = (width + 100, height)
        self.run([f'--window-size={size[0]},{size[1]}', f'--screenshot={target}'], url)
        print(f'  saved {target}')


def scenario(title):
    print(f'\n{title}')


def check(label, actual, expected=True):
    passed = actual == expected
    print(f"  {'ok  ' if passed else 'FAIL'} {label}" + ('' if passed else f': expected {expected!r}, got {actual!r}'))
    if not passed:
        failures.append(label)


def check_requests(visit, **expected):
    check('requests made', {name: visit[name] for name in expected}, expected)


def check_healthy(visit):
    check('page finished', visit['finished'])
    check('no blocked content or script errors', [visit.get('violations'), visit.get('errors')], [[], []])
    check('no button under the filters', visit.get('progressButton'), False)


def forget():
    state['storage'] = {}


FORECASTS = [
    ('Peça para os Homens', 'Ipiranga', 'Previsão: 10 nov, 17h · Obtido no livreto, sujeito a mudanças. Confirme no Sesc'),
    ('Os Amores de Lorca, ou o Amor Dorme no Peito do Poeta', 'Pinheiros', 'Previsão: 10 nov, 17h · Obtido no livreto, sujeito a mudanças. Confirme no Sesc'),
    ('Jogo de Imaginar', 'Avenida Paulista', 'Previsão: 17 nov, 17h · Obtido no livreto, sujeito a mudanças. Confirme no Sesc'),
    ('A Terra Prometida', 'Belenzinho', 'Previsão: 17 nov, 17h · Obtido no livreto, sujeito a mudanças. Confirme no Sesc'),
]


def test_first_visit(browser, site_origin):
    scenario('First visit: plays appear as they load, then the forecasts')
    forget()
    # Slow enough that the spacing between requests can't keep them under the limit by itself.
    visit = browser.visit('?interact=1', latency=1.0)
    check_healthy(visit)
    check_requests(visit, listing=1, detail=47, archive=1, pdf=1)
    check('at most 3 requests at once', 0 < visit['peak'] <= 3)
    check('requests at least 100 ms apart', visit['smallest_gap'] is not None and visit['smallest_gap'] >= 0.1)
    check('requests come from another origin', visit['origins'], {site_origin})
    check('cards appear gradually', len(set(visit.get('cardCounts', []))) > 2)
    check('title', visit.get('title'), 'Quando abre a estreia?')
    check('dark, even though the browser prefers light', visit.get('background'), 'rgb(22, 19, 15)')
    check('region starts on the capital', visit.get('choice'), 'region:capital')
    check('next opening', visit.get('hero'), 'Próxima aberturaTerça, 10 de novembro, 17hdaqui a 5 dias · 7 peças')
    check('cards in the capital', visit.get('cards'), 13)
    check('cards in the interior', visit.get('interior'), 12)
    check('cards on the coast', visit.get('coast'), 2)
    check('cards in all regions', visit.get('all'), 27)
    check('search finds a play', visit.get('search'), ['Farinha com Açúcar ou Sobre a Sustança de Meninos e Homens'])
    check('premiere rule on Farinha', '20 a 28 nov · 5 datas · temporada até 29 nov' in visit.get('farinha', ''))
    check('forecasts', [(row['title'], row['unit'], row['sale']) for row in visit.get('forecasts', [])], FORECASTS)
    check('no note about problems', visit.get('problem'), None)


def test_returning_visits(browser):
    scenario('Reload: everything comes from what was saved')
    visit = browser.visit()
    check_healthy(visit)
    check_requests(visit, listing=0, detail=0, archive=0, pdf=0)
    check('cards', visit.get('cards'), 13)
    check('forecasts', len(visit.get('forecasts', [])), 4)

    scenario('Listing older than 10 minutes: one request')
    visit = browser.visit('?age=listing')
    check_healthy(visit)
    check_requests(visit, listing=1, detail=0, archive=0, pdf=0)
    check('cards', visit.get('cards'), 13)

    scenario("Plays older than 3 hours: details fetched again, but not the booklet")
    visit = browser.visit('?age=listing,plays')
    check_healthy(visit)
    check_requests(visit, listing=1, detail=47, archive=0, pdf=0)
    check('cards', visit.get('cards'), 13)


def test_refusals(browser):
    scenario('Sesc refuses everything, with saved results: they stay')
    visit = browser.visit('?age=listing,plays', mode='block-all')
    check_healthy(visit)
    check_requests(visit, listing=3, detail=0)
    check('cards', visit.get('cards'), 13)
    check('forecasts', len(visit.get('forecasts', [])), 4)
    check('note says the data is old', 'Não foi possível atualizar agora' in (visit.get('problem') or ''))

    scenario('Sesc refuses details, with saved results: requests stop')
    visit = browser.visit('?age=listing,plays', mode='block-details')
    check_healthy(visit)
    check('stopped early', 0 < visit['detail'] < 20)
    check('cards', visit.get('cards'), 13)
    check('note says plays are missing', 'não puderam ser verificadas' in (visit.get('problem') or ''))

    scenario('Sesc refuses everything, first visit')
    forget()
    visit = browser.visit(mode='block-all')
    check_healthy(visit)
    check_requests(visit, listing=3, detail=0, archive=0, pdf=0)
    check('cards', visit.get('cards'), 0)
    check('message', visit.get('empty'), 'Nenhuma peça para mostrar agora.')
    check('note says Sesc can\'t be reached', 'Não foi possível consultar' in (visit.get('problem') or ''))

    scenario('Sesc refuses details, first visit: requests stop')
    forget()
    visit = browser.visit(mode='block-details')
    check_healthy(visit)
    check('stopped early', 0 < visit['detail'] < 20)
    check_requests(visit, listing=1, archive=0, pdf=0)
    check('message', visit.get('empty'), 'Nenhuma peça para mostrar agora.')


def test_bad_booklet(browser):
    november = state['pdf']
    scenario('Corrupt booklet: plays are unaffected')
    forget()
    state['pdf'] = b'this is not a pdf' * 100
    visit = browser.visit()
    check_healthy(visit)
    check_requests(visit, listing=1, detail=47, archive=1, pdf=1)
    check('cards', visit.get('cards'), 9)
    check('forecasts', len(visit.get('forecasts', [])), 0)
    check('note about the booklet', 'Não foi possível ler o livreto' in (visit.get('problem') or ''))

    scenario("Reload after a corrupt booklet: it isn't downloaded again")
    visit = browser.visit()
    check_healthy(visit)
    check_requests(visit, listing=0, detail=0, archive=1, pdf=0)
    check('note stays', 'Não foi possível ler o livreto' in (visit.get('problem') or ''))
    state['pdf'] = november


def test_large_booklets(browser):
    november = state['pdf']
    for name in ('august', 'october'):
        state['pdf'] = booklet(name)
        scenario(f'Real {name} booklet ({len(state["pdf"]) / 1e6:.1f} MB): reads by itself')
        forget()
        visit = browser.visit()
        check_healthy(visit)
        check_requests(visit, listing=1, detail=47, archive=1, pdf=1)
        check('no note about problems', visit.get('problem'), None)
        # Its plays have passed, so no forecasts appear. Not reading it again shows it was saved.
        visit = browser.visit()
        check_requests(visit, listing=0, detail=0, archive=0, pdf=0)
    state['pdf'] = november


def main():
    global recorded
    parser = argparse.ArgumentParser(description="Drive the page in headless Chrome against a mock of Sesc's API.")
    parser.add_argument('--large-booklets', action='store_true', help='also read the real 16 and 22 MB editions, downloading them once')
    parser.add_argument('--screenshots', type=pathlib.Path, metavar='DIR', help='save desktop and phone screenshots here')
    args = parser.parse_args()

    sys.stdout.reconfigure(encoding='utf-8')
    recorded = json.loads((HERE / 'recorded.json').read_text(encoding='utf-8'))
    state['pdf'] = booklet('november')
    chrome = find_chrome()

    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temporary:
        work = pathlib.Path(temporary)
        api, api_origin = serve(Api)
        Api.api_origin = api_origin
        build_site(work / 'site', api_origin)

        class ThisSite(Site):
            def __init__(self, *handler_args, **kwargs):
                super().__init__(*handler_args, directory=str(work / 'site'), **kwargs)

        site, site_origin = serve(ThisSite)
        browser = Browser(chrome, work, site_origin)
        try:
            test_first_visit(browser, site_origin)
            test_returning_visits(browser)
            test_refusals(browser)
            test_bad_booklet(browser)
            if args.large_booklets:
                test_large_booklets(browser)
            if args.screenshots:
                scenario('Screenshots')
                args.screenshots.mkdir(parents=True, exist_ok=True)
                forget()
                browser.visit()
                browser.screenshot('desktop', 1280, 1400, args.screenshots)
                browser.screenshot('phone', 390, 1200, args.screenshots)
        finally:
            api.shutdown()
            site.shutdown()

    print(f"\n{'All checks passed.' if not failures else f'{len(failures)} failed: ' + '; '.join(failures)}")
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
