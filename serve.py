#!/usr/bin/env python3
# 本地服务：热更新 + 运行日志回传
import http.server, socketserver, json, os, re, sys, time, subprocess, shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
LOGD = os.path.join(ROOT, 'logs')
os.makedirs(LOGD, exist_ok=True)
FILES = ['potato-ui.user.js', 'potato-farm.user.js']
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8787

os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
_MODEL = None

def get_model():
    global _MODEL
    if _MODEL is None:
        from faster_whisper import WhisperModel
        _MODEL = WhisperModel('base.en', device='cpu', compute_type='int8')
    return _MODEL

def stt(url):
    import tempfile, urllib.request
    if not url.startswith('http'):
        m0 = get_model()
        segs0, _ = m0.transcribe(url, language='en', vad_filter=True, beam_size=1)
        return {'ok': True, 'text': ' '.join(x.text.strip() for x in segs0)}
    fd, path = tempfile.mkstemp(suffix='.mp3')
    os.close(fd)
    try:
        req = urllib.request.Request(url, headers={'user-agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=60) as r, open(path, 'wb') as f:
            f.write(r.read())
        m = get_model()
        segs, info = m.transcribe(path, language='en', vad_filter=True, beam_size=1)
        text = ' '.join(x.text.strip() for x in segs)
        return {'ok': True, 'text': text}
    finally:
        try: os.remove(path)
        except Exception: pass

def stt_ts(url):
    """返回词级时间戳，用于从视频里切出每句台词对应的音轨"""
    import tempfile, urllib.request, json as _json
    fd, path = tempfile.mkstemp(suffix='.mp4')
    os.close(fd)
    try:
        req = urllib.request.Request(url, headers={'user-agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=120) as r, open(path, 'wb') as f:
            f.write(r.read())
        m = get_model()
        segs, info = m.transcribe(path, language='en', vad_filter=True, beam_size=1, word_timestamps=True)
        words = []
        for seg in segs:
            for w in (seg.words or []):
                words.append({'w': w.word.strip(), 's': round(w.start, 3), 'e': round(w.end, 3)})
        return {'ok': True, 'words': words, 'dur': round(info.duration, 2)}
    finally:
        try: os.remove(path)
        except Exception: pass

def match_lines(url, lines):
    """首尾锚定：按台词开头/结尾几个词定位到 whisper 分段，取整段区间"""
    import tempfile, urllib.request
    fd, path = tempfile.mkstemp(suffix='.mp4')
    os.close(fd)
    try:
        req = urllib.request.Request(url, headers={'user-agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=120) as r, open(path, 'wb') as f:
            f.write(r.read())
        m = get_model()
        segs, info = m.transcribe(path, language='en', vad_filter=True, beam_size=1)
        pool = [{'s': round(x.start, 3), 'e': round(x.end, 3), 't': x.text.strip()} for x in segs]
    finally:
        try: os.remove(path)
        except Exception: pass

    norm = lambda x: ''.join(ch.lower() for ch in x if ch.isalnum())
    segwords = [[norm(w) for w in p['t'].split() if norm(w)] for p in pool]
    out = []
    cursor = 0
    for line in lines:
        toks = [norm(t) for t in line.split() if norm(t)]
        if not toks:
            out.append({'line': line, 'start': None, 'end': None, 'score': 0, 'heard': None})
            continue
        head, tail = toks[:3], toks[-3:]

        def find_seq(seq, frm):
            for i in range(frm, len(segwords)):
                sw = segwords[i]
                for j in range(len(sw)):
                    ok = all(j + k < len(sw) and (sw[j + k] == seq[k] or seq[k] in sw[j + k] or sw[j + k] in seq[k]) for k in range(len(seq)))
                    if ok:
                        return i
                # 跨段也要考虑
                joined = ' '.join(segwords[i]) + ' ' + ' '.join(segwords[i + 1]) if i + 1 < len(segwords) else ' '.join(segwords[i])
                if ' '.join(seq) in joined:
                    return i
            return -1

        i0 = find_seq(head, cursor)
        if i0 < 0:
            out.append({'line': line, 'start': None, 'end': None, 'score': 0, 'heard': None})
            continue
        i1 = find_seq(tail, i0)
        if i1 < 0:
            i1 = i0
        out.append({'line': line, 'start': pool[i0]['s'], 'end': pool[i1]['e'], 'score': 1.0 if i1 > i0 else 0.7,
                    'heard': ' | '.join(pool[k]['t'] for k in range(i0, i1 + 1))[:90]})
        cursor = i1 + 1
    return {'ok': True, 'dur': round(info.duration, 2), 'segments': out, 'pool': pool}
def ver_of(path):
    try:
        with open(path, encoding='utf-8') as f:
            m = re.search(r'@version\s+([\w.\-]+)', f.read())
            return m.group(1) if m else '?'
    except Exception:
        return None


CTRL = os.path.join(ROOT, 'control.json')
STATE = os.path.join(ROOT, 'state.json')
LOG = os.path.join(ROOT, 'run-all.log')

def _read_json(path, default):
    try:
        # utf-8-sig：记事本 / PowerShell 存出来的带 BOM 文件也能读
        with open(path, encoding='utf-8-sig') as f:
            return json.load(f)
    except Exception:
        return default

def _write_json(path, obj):
    try:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(obj, f, ensure_ascii=False)
    except Exception:
        pass

# ---- 跑课进程托管：UI 点「开始」真的把 run-all.js 拉起来 ----
RUNNER = {'proc': None, 'started': 0}

def _enc_key(plain):
    """用 keyvault.js 把明文 key 加密成 v1:... ；失败返回空串（调用方退回明文）"""
    node = shutil.which('node') or 'node'
    try:
        p = subprocess.run([node, os.path.join(ROOT, 'keyvault.js'), 'enc'],
                           input=str(plain).encode('utf-8'),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20,
                           creationflags=(0x08000000 if os.name == 'nt' else 0))
        if p.returncode == 0:
            out = p.stdout.decode('utf-8').strip()
            if out.startswith('v1:'):
                return out
    except Exception:
        pass
    return ''


def store_api_key(cur, plain):
    """把 key 存进 cur：优先加密，加密不了才落明文"""
    plain = (plain or '').strip()
    if not plain:
        return
    enc = _enc_key(plain)
    if enc:
        cur['apiKeyEnc'] = enc
        cur.pop('apiKey', None)
    else:
        cur['apiKey'] = plain


def runner_alive():
    p = RUNNER.get('proc')
    return bool(p and p.poll() is None)

def start_runner(max_sec):
    if runner_alive():
        return {'ok': True, 'already': True, 'pid': RUNNER['proc'].pid}
    node = shutil.which('node') or 'node'
    os.makedirs(LOGD, exist_ok=True)   # logs 目录可能被删/移走，跑课进程的输出得先有地方落
    out = open(os.path.join(LOGD, 'runner.out'), 'ab')
    flags = 0x08000000 if os.name == 'nt' else 0
    try:
        p = subprocess.Popen([node, os.path.join(ROOT, 'run-all.js'), str(max_sec)],
                             cwd=ROOT, stdout=out, stderr=subprocess.STDOUT,
                             creationflags=flags)
    finally:
        out.close()
    RUNNER['proc'] = p
    RUNNER['started'] = time.time()
    return {'ok': True, 'pid': p.pid, 'maxSec': max_sec}

def stop_runner():
    p = RUNNER.get('proc')
    if not p or p.poll() is not None:
        return {'ok': True, 'already': True}
    try:
        p.terminate()
        for _ in range(20):
            if p.poll() is not None:
                break
            time.sleep(0.1)
        if p.poll() is None:
            p.kill()
    except Exception:
        pass
    return {'ok': True, 'pid': p.pid}

def api_state():
    st = _read_json(STATE, {})
    ctrl = _read_json(CTRL, {'state': 'stopped'})
    st['state'] = ctrl.get('state', st.get('state', 'stopped'))
    st['settings'] = {
        'delay': ctrl.get('delay', 900),
        'rate': ctrl.get('rate', 4),
        'maxSec': ctrl.get('maxSec', 8),
        'fillerText': ctrl.get('fillerText', '关注塔菲谢谢喵！'),
        'commentText': ctrl.get('commentText', '关注塔菲谢谢喵！'),
        'hasKey': bool(ctrl.get('apiKeyEnc') or ctrl.get('apiKey')),
        'autoResume': ctrl.get('autoResume', True),
        'maxFail': ctrl.get('maxFail', 5),
        'pauseEvery': ctrl.get('pauseEvery', 0),
    }
    st['cdp'] = False
    st['srv'] = True
    try:
        import urllib.request as _u
        _u.urlopen('http://127.0.0.1:9222/json/version', timeout=2).read()
        st['cdp'] = True
    except Exception:
        pass
    st['stt'] = _MODEL is not None
    st['runner'] = runner_alive()
    # 进程没了就别再显示「运行中」
    if not st['runner'] and st.get('state') == 'running':
        st['state'] = 'stopped'
        try:
            cur = _read_json(CTRL, {'state': 'stopped'})
            if cur.get('state') == 'running':
                cur['state'] = 'stopped'
                _write_json(CTRL, cur)
        except Exception:
            pass
    return st

def api_log(after):
    try:
        with open(LOG, encoding='utf-8', errors='replace') as f:
            lines = f.readlines()
    except Exception:
        return {'lines': [], 'next': after}
    if after < 0 or after > len(lines):
        after = max(0, len(lines) - 300)
    tail = lines[after:][-200:]
    out = []
    for ln in tail:
        t = ln.rstrip('\n')
        cls = ''
        if '→ ' in t and ' 分' in t:
            cls = 'ok'
        if '!!' in t or '失败' in t or '异常' in t:
            cls = 'err'
        if '跳过' in t or '无法' in t:
            cls = 'warn'
        if '===' in t:
            cls = 'dim'
        out.append({'text': t, 'cls': cls})
    return {'lines': out, 'next': len(lines)}
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'content-type')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        p = self.path.split('?')[0]
        qs = {}
        if '?' in self.path:
            for kv in self.path.split('?', 1)[1].split('&'):
                if '=' in kv:
                    k, v = kv.split('=', 1)
                    qs[k] = v
        if p == '/api/state':
            outb = json.dumps(api_state(), ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(outb)))
            self.end_headers()
            self.wfile.write(outb)
            return
        if p == '/api/log':
            try:
                after = int(qs.get('after', '0'))
            except Exception:
                after = 0
            outb = json.dumps(api_log(after), ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(outb)))
            self.end_headers()
            self.wfile.write(outb)
            return
        if p in ('/', '/ui'):
            self.path = '/ui.html'
        self._legacy_get()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        p = self.path.split('?')[0]
        n = int(self.headers.get('content-length') or 0)
        body = self.rfile.read(n) if n else b'{}'
        if p == '/api/run':
            try:
                data = json.loads(body.decode('utf-8') or '{}') if body else {}
                act = data.get('action', 'start')
                if act == 'stop':
                    res = stop_runner()
                    cur = _read_json(CTRL, {'state': 'stopped'})
                    cur['state'] = 'stopped'
                    _write_json(CTRL, cur)
                else:
                    cur = _read_json(CTRL, {'state': 'stopped'})
                    cur['state'] = 'running'
                    for k in ('maxSec', 'delay', 'rate', 'guess', 'fillerText', 'commentText', 'maxFail', 'pauseEvery'):
                        if k in data:
                            cur[k] = data[k]
                    if 'apiKey' in data:
                        store_api_key(cur, data.get('apiKey'))
                    _write_json(CTRL, cur)
                    _write_json(STATE, {'state': 'running', 'section': '-', 'screen': '-', 'ok': 0, 'fail': 0, 'page': ''})
                    res = start_runner(int(cur.get('maxSec') or 3))
            except Exception as e:
                res = {'ok': False, 'err': str(e)[:300]}
            outr = json.dumps(res, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(outr)))
            self.end_headers()
            self.wfile.write(outr)
            return
        if p == '/api/control':
            try:
                data = json.loads(body.decode('utf-8') or '{}') if body else {}
                cur = _read_json(CTRL, {'state': 'stopped'})
                act = data.get('action')
                if act in ('start', 'pause', 'stop'):
                    cur['state'] = {'start': 'running', 'pause': 'paused', 'stop': 'stopped'}[act]
                for k in ('maxSec', 'delay', 'rate', 'guess', 'filler', 'fillerText', 'commentText', 'autoResume', 'maxFail', 'pauseEvery'):
                    if k in data:
                        cur[k] = data[k]
                if 'apiKey' in data:
                    store_api_key(cur, data.get('apiKey'))
                _write_json(CTRL, cur)
                res = {'ok': True, 'ctrl': cur}
            except Exception as e:
                res = {'ok': False, 'err': str(e)}
            outb = json.dumps(res, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(outb)))
            self.end_headers()
            self.wfile.write(outb)
            return
        if p == '/stt-ts':
            try:
                data = json.loads(body.decode('utf-8') or '{}') if body else {}
                url2 = (data.get('url') or '').strip()
                lines = data.get('lines') or []
                res = match_lines(url2, lines) if url2 else {'ok': False, 'err': 'no url'}
            except Exception as e:
                res = {'ok': False, 'err': str(e)}
            out2 = json.dumps(res, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(out2)))
            self.end_headers()
            self.wfile.write(out2)
            return
        if p == '/stt':
            try:
                data = json.loads(body.decode('utf-8') or '{}') if body else {}
                url = (data.get('url') or '').strip()
                res = stt(url) if url else {'ok': False, 'err': 'no url'}
            except Exception as e:
                res = {'ok': False, 'err': str(e)[:300]}
            out = json.dumps(res, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return
        if p == '/result':
            data = json.loads(body.decode('utf-8') or '{}') if body else {}
            ts = time.strftime('%Y%m%d-%H%M%S')
            rid = str(data.get('id') or '')
            fn = os.path.join(LOGD, 'result-' + ts + '-' + rid.replace('/', '_')[:16] + '.json')
            try:
                with open(fn, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False)
                out = json.dumps({'ok': True, 'file': os.path.basename(fn)}).encode()
            except Exception as e:
                out = json.dumps({'ok': False, 'err': str(e)}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return
        if p == '/cmd':
            data = {}
            try: data = json.loads(body.decode('utf-8') or '{}')
            except Exception: pass
            qf = os.path.join(ROOT, 'cmd.json')
            queue = []
            try:
                with open(qf, encoding='utf-8') as f: queue = json.load(f)
            except Exception: queue = []
            if isinstance(data, dict) and data.get('cmd'):
                queue.append(data['cmd'])
                with open(qf, 'w', encoding='utf-8') as f: json.dump(queue, f, ensure_ascii=False)
                out = json.dumps({'ok': True, 'queued': len(queue)}).encode()
            else:
                with open(qf, 'w', encoding='utf-8') as f: json.dump([], f)
                out = json.dumps({'ok': True, 'cmd': queue[0] if queue else None, 'left': len(queue)}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return
        if p == '/report':
            ts = time.strftime('%Y%m%d-%H%M%S')
            fn = os.path.join(LOGD, 'report-' + ts + '.json')
            try:
                data = json.loads(body.decode('utf-8'))
                with open(fn, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False)
                # 只留最近 300 份
                old = sorted(os.listdir(LOGD))
                for x in old[:-300]:
                    try: os.remove(os.path.join(LOGD, x))
                    except Exception: pass
                out = json.dumps({'ok': True, 'file': os.path.basename(fn)}).encode()
            except Exception as e:
                out = json.dumps({'ok': False, 'err': str(e)}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return
        self.send_response(404)
        self.end_headers()

    def _legacy_get(self):
        p = self.path.split('?')[0]
        if p == '/manifest.json':
            versions, order = {}, []
            for name in FILES:
                v = ver_of(os.path.join(ROOT, name))
                if v:
                    versions[name] = v
                    order.append(name)
            body = json.dumps({'versions': versions, 'order': order}, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if p == '/latest':
            files = sorted(f for f in os.listdir(LOGD) if f.endswith('.json'))
            body = b'{}'
            if files:
                with open(os.path.join(LOGD, files[-1]), 'rb') as f:
                    body = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def log_message(self, fmt, *args):
        pass

if __name__ == '__main__':
    with socketserver.ThreadingTCPServer(('127.0.0.1', PORT), H) as httpd:
        httpd.allow_reuse_address = True
        print(f'http://127.0.0.1:{PORT}  日志目录 {LOGD}')
        httpd.serve_forever()