#!/usr/bin/env python3
"""Drive the real page in headless Chrome, with a fixed copy of the booklet's entries.

The page only loads booklet.json from its own site. This serves a copy of `web/`
whose booklet.json is `tests/browser/booklet.json`, from the November 2026 edition,
and moves the page's clock to 2026-11-05, while that edition was current.

    python tests/browser/run.py [--screenshots DIR]

Needs Python 3.10 or newer and Chrome (set CHROME if it isn't found). It also
downloads the November booklet from Sesc once, into a folder git ignores, so that
`node --test` can check the booklet command still reads it the same way. It's
Sesc's file, so it isn't in this repository.
"""
import argparse
import functools
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
import urllib.parse
import urllib.request
import uuid

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CACHE = HERE / '.cache'
NOVEMBER_URL = 'https://www.sescsp.org.br/wp-content/uploads/2026/10/V13_Em-Cartaz_2026_novembro_VF.pdf'
CURRENT = '2026-11-05T12:00:00-03:00'
OUTPUT_MARK = '<pre id="test-output">'
GIF = bytes.fromhex('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b')

state = {'booklet': True}
release = threading.Event()
failures = []


class Site(http.server.SimpleHTTPRequestHandler):
    """Serves the copy of the page, and holds Chrome until the page has reported."""

    # Windows can map these to something else, and browsers then refuse to run modules.
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript'}

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == '/__hold':
            # The page's load event waits for this image, so Chrome waits for the page to finish.
            release.wait(180)
            self.reply(200, GIF, 'image/gif')
        elif path == '/booklet.json' and not state['booklet']:
            self.reply(404, b'Not found', 'text/plain')
        else:
            super().do_GET()

    def do_POST(self):
        release.set()
        self.reply(200, b'{}', 'application/json')

    def reply(self, status, body, kind):
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def serve(handler):
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_port}'


def replace_once(text, old, new):
    assert text.count(old) == 1, f'expected exactly one {old!r} in the page, so run.py needs updating'
    return text.replace(old, new)


def build_site(site):
    """Copy the page, with the test's booklet and what's needed to watch it."""
    shutil.copytree(ROOT / 'web', site)
    shutil.copyfile(HERE / 'booklet.json', site / 'booklet.json')
    page = (site / 'index.html').read_text(encoding='utf-8')
    page = replace_once(page, 'img-src data:', "img-src data: 'self'")
    page = replace_once(page, '<script type="module"', '<script src="probe.js"></script>\n<script type="module"')
    page = replace_once(page, '<main id="results">', '<img src="__hold" alt="" width="1" height="1"><main id="results">')
    (site / 'index.html').write_text(page, encoding='utf-8')
    probe = (HERE / 'probe.js').read_text(encoding='utf-8')
    (site / 'probe.js').write_text(probe.replace('__CURRENT__', CURRENT), encoding='utf-8')


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


def download_november():
    path = CACHE / 'november.pdf'
    if path.exists():
        return
    print('Downloading the November booklet from Sesc, for node --test. This only happens once.')
    request = urllib.request.Request(NOVEMBER_URL, headers={'User-Agent': 'ticket-drop-browser-test'})
    with urllib.request.urlopen(request, timeout=300) as response:
        data = response.read()
    CACHE.mkdir(exist_ok=True)
    path.write_bytes(data)


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

    def visit(self, booklet=True, **params):
        """Open the page, wait for it to finish, and return its report."""
        state.update(booklet=booklet)
        release.clear()
        query = f'?{urllib.parse.urlencode(params)}' if params else ''
        dom = self.run(['--dump-dom'], f'{self.site_url}/{query}').stdout.decode('utf-8', 'replace')
        start = dom.find(OUTPUT_MARK)
        report = {}
        if start >= 0:
            report = json.loads(html.unescape(dom[start + len(OUTPUT_MARK):dom.find('</pre>', start)]))
        return {**report, 'finished': start >= 0}

    def screenshot(self, name, width, height, folder):
        state.update(booklet=True)
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


def check_healthy(visit, site_origin):
    check('page finished', visit['finished'])
    check('no blocked content or script errors', [visit.get('violations'), visit.get('errors')], [[], []])
    check('only asks its own site', visit.get('origins'), [site_origin])


FORECASTS = [
    ('Peça para os Homens', 'Ipiranga', 'Previsão: 10 nov, 17h · Obtido no livreto, sujeito a mudanças. Confirme no Sesc'),
    ('Os Amores de Lorca, ou o Amor Dorme no Peito do Poeta', 'Pinheiros', 'Previsão: 10 nov, 17h · Obtido no livreto, sujeito a mudanças. Confirme no Sesc'),
    ('Reality Show', 'Pompeia', 'Previsão: 10 nov, 17h · Obtido no livreto, sujeito a mudanças. Confirme no Sesc'),
    ('Farinha com Açúcar ou Sobre a Sustança de Meninos e Homens', '14 Bis', 'Previsão: 17 nov, 17h · Obtido no livreto, sujeito a mudanças. Confirme no Sesc'),
    ('Jogo de Imaginar', 'Avenida Paulista', 'Previsão: 17 nov, 17h · Obtido no livreto, sujeito a mudanças. Confirme no Sesc'),
    ('A Terra Prometida', 'Belenzinho', 'Previsão: 17 nov, 17h · Obtido no livreto, sujeito a mudanças. Confirme no Sesc'),
    ('O Porco', 'Pompeia', 'Previsão: 17 nov, 17h · Obtido no livreto, sujeito a mudanças. Confirme no Sesc'),
    ('Cuidado Frágil', 'São Caetano', 'Previsão: 17 nov, 17h · Obtido no livreto, sujeito a mudanças. Confirme no Sesc'),
]


def test_forecasts(browser, site_origin):
    scenario('A visit while the booklet is current: its forecasts')
    visit = browser.visit(interact=1)
    check_healthy(visit, site_origin)
    check('title', visit.get('title'), 'Quando abre a estreia?')
    check('dark, even though the browser prefers light', visit.get('background'), 'rgb(22, 19, 15)')
    check('region starts on the capital', visit.get('choice'), 'region:capital')
    check('next opening', visit.get('hero'), 'Próxima abertura (previsão)Terça, 10 de novembro, 17hdaqui a 5 dias · 3 peças')
    check('cards in the capital', visit.get('cards'), 8)
    # The booklet is mostly about the capital.
    check('cards in the interior', visit.get('interior'), 0)
    check('cards on the coast', visit.get('coast'), 0)
    check('cards in all regions', visit.get('all'), 8)
    check('every unit can be chosen', visit.get('unitChoices'), 44)
    check('a unit with nothing to open says so', visit.get('santana'), [0, 'Nenhuma abertura prevista em Santana. Experimente outra região.'])
    check('search finds a play', visit.get('search'), ['Os Amores de Lorca, ou o Amor Dorme no Peito do Poeta'])
    check('forecasts', [(row['title'], row['unit'], row['sale']) for row in visit.get('forecasts', [])], FORECASTS)
    check('says which booklet', visit.get('updated'), 'Previsões do livreto Em Cartaz de novembro de 2026.')
    check('no note about problems', visit.get('problem'), None)


def test_problems(browser, site_origin):
    scenario('December, still with the November booklet: says so')
    visit = browser.visit(at='2026-12-02T12:00:00-03:00')
    check_healthy(visit, site_origin)
    check('note says the booklet is old', 'são do livreto de novembro' in (visit.get('problem') or ''))

    scenario('No booklet: says so')
    visit = browser.visit(booklet=False)
    check('page finished', visit['finished'])
    check('no blocked content or script errors', [visit.get('violations'), visit.get('errors')], [[], []])
    check('cards', visit.get('cards'), 0)
    check('message', visit.get('empty'), 'Nenhuma peça para mostrar agora.')
    check('next opening', visit.get('hero'), 'Próxima abertura (previsão)Sem dados agoraNão foi possível carregar as previsões.')
    check('note says the forecasts are missing', 'Não foi possível carregar as previsões' in (visit.get('problem') or ''))


def main():
    parser = argparse.ArgumentParser(description='Drive the page in headless Chrome, with a fixed copy of the booklet.')
    parser.add_argument('--screenshots', type=pathlib.Path, metavar='DIR', help='save desktop and phone screenshots here')
    args = parser.parse_args()

    download_november()
    chrome = find_chrome()
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temporary:
        work = pathlib.Path(temporary)
        build_site(work / 'site')
        site, site_origin = serve(functools.partial(Site, directory=str(work / 'site')))
        browser = Browser(chrome, work, site_origin)
        try:
            test_forecasts(browser, site_origin)
            test_problems(browser, site_origin)
            if args.screenshots:
                scenario('Screenshots')
                args.screenshots.mkdir(parents=True, exist_ok=True)
                browser.screenshot('desktop', 1280, 1400, args.screenshots)
                browser.screenshot('phone', 390, 1200, args.screenshots)
        finally:
            site.shutdown()

    print(f"\n{'All checks passed.' if not failures else f'{len(failures)} failed: ' + '; '.join(failures)}")
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
