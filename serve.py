#!/usr/bin/env python3
# 本地服务：热更新 + 运行日志回传
import http.server, socketserver, json, os, re, sys, time, subprocess, shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
LOGD = os.path.join(ROOT, 'logs')
os.makedirs(LOGD, exist_ok=True)
FILES = ['potato-ui.user.js', 'potato-farm.user.js']
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8787

os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')

# 第一次运行没有 control.json 时给一份能用的默认值（老包里的默认值是一句中文口号，
# 新用户会在讨论题里把它当答案交上去，所以这里默认给英文占位）
DEFAULT_CTRL = {
    'state': 'stopped', 'maxSec': 3, 'delay': 900, 'rate': 4, 'guess': True,
    'fillerText': 'This is my answer to the question above.',
    'commentText': 'This is my answer to the question above.',
    'maxFail': 8, 'pauseEvery': 0,
}
_MODEL = None

USAGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'usage.json')


def api_usage():
    """从 usage.json 读累计用量，顺带算钱（DeepSeek 现价：输入 2 元/百万，输出 8 元/百万）"""
    u = _read_json(USAGE, {})
    pin = int(u.get('in', 0) or 0)
    pout = int(u.get('out', 0) or 0)
    calls = int(u.get('calls', 0) or 0)
    cost = pin * 2.0 / 1e6 + pout * 8.0 / 1e6
    return {
        'calls': calls,
        'in': pin,
        'out': pout,
        'cost': round(cost, 4),
        'since': u.get('since', ''),
    }


def api_usage_reset():
    _write_json(USAGE, {'calls': 0, 'in': 0, 'out': 0, 'since': time.strftime('%Y-%m-%d %H:%M')})
    return {'ok': True}


REPO_ZIP = 'https://github.com/yyzbuhaohe/Uschoolai/archive/refs/heads/main.zip'


def api_update():
    """从 GitHub 拉最新代码覆盖本地。只动代码和文档，control.json / state.json / usage.json 一律不碰。"""
    import io, zipfile
    import urllib.request as _u
    keep = {'control.json', 'state.json', 'usage.json', 'logs'}
    bak = os.path.join(ROOT, '.bak-update')
    changed, failed = [], []
    try:
        req = _u.Request(REPO_ZIP, headers={'User-Agent': 'potato-updater'})
        raw = _u.urlopen(req, timeout=60).read()
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except Exception as e:
        return {'ok': False, 'err': '下载失败：%s' % str(e)[:160]}

    try:
        os.makedirs(bak, exist_ok=True)
    except Exception:
        pass

    # 先看远端版本，比本地旧就不覆盖（防止把新功能刷回旧版）
    try:
        remote_ver = json.loads(zf.read([n for n in zf.namelist() if n.endswith('/version.json')][0]).decode('utf-8'))
        remote_build = int(remote_ver.get('build', 0) or 0)
    except Exception:
        remote_build = 0
    try:
        local_build = int(_read_json(os.path.join(ROOT, 'version.json'), {}).get('build', 0) or 0)
    except Exception:
        local_build = 0
    if not remote_build:
        # 远端没有 version.json 就不知道谁新谁旧，宁可不更新
        return {'ok': True, 'n': 0, 'changed': [], 'msg': '远端缺少 version.json，跳过更新以免把本地刷成旧版'}
    if local_build and remote_build <= local_build:
        return {'ok': True, 'n': 0, 'changed': [], 'msg': '本地 %d，远端 %d，已是最新' % (local_build, remote_build)}

    for item in zf.infolist():
        if item.is_dir():
            continue
        parts = item.filename.split('/', 1)
        if len(parts) != 2:
            continue
        rel = parts[1]
        head = rel.split('/')[0]
        if head in keep:
            continue
        if rel.endswith('.pyc') or '__pycache__' in rel:
            continue
        dst = os.path.join(ROOT, rel.replace('/', os.sep))
        try:
            os.makedirs(os.path.dirname(dst), exist_ok=True) if os.path.dirname(dst) else None
            old = None
            if os.path.exists(dst):
                with open(dst, 'rb') as f:
                    old = f.read()
            new = zf.read(item)
            if old == new:
                continue
            if old is not None:
                b = os.path.join(bak, rel.replace('/', '_'))
                with open(b, 'wb') as f:
                    f.write(old)
            with open(dst, 'wb') as f:
                f.write(new)
            changed.append(rel)
        except Exception as e:
            failed.append('%s: %s' % (rel, str(e)[:60]))

    if failed:
        return {'ok': False, 'err': '部分文件失败：' + '; '.join(failed[:3]), 'changed': changed}
    if remote_build:
        try:
            _write_json(os.path.join(ROOT, 'version.json'), remote_ver)
        except Exception:
            pass
    return {'ok': True, 'changed': changed, 'n': len(changed), 'backup': bak, 'build': remote_build}


def get_model():
    """加载转写模型。

    优先级：
      1. 项目目录下的 models/whisper-base.en/（用户解压模型包就有，不用联网）
      2. 从镜像下载到 HF 缓存
    """
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    if not fw_ok():
        pyv = '%d.%d' % sys.version_info[:2]
        raise RuntimeError(
            '这台机器上的 Python %s 里没有 faster-whisper（3.13/3.14 装不上）。'
            '跑一次 install.cmd 或 doctor.cmd，它会装好 Python 3.12 并把路径写进 py.path；'
            '然后关掉这个窗口重新开 serve.cmd。' % pyv)
    from faster_whisper import WhisperModel

    local = os.path.join(ROOT, 'models', 'whisper-base.en')
    if os.path.isfile(os.path.join(local, 'model.bin')):
        try:
            _MODEL = WhisperModel(local, device='cpu', compute_type='int8')
            print('[stt] model loaded from local: %s' % local, flush=True)
            return _MODEL
        except Exception as e:
            print('[stt] local model failed, fall back to download: %s' % str(e)[:160], flush=True)

    mirrors = ['https://hf-mirror.com', 'https://huggingface.co']
    last = None
    for m in mirrors:
        os.environ['HF_ENDPOINT'] = m
        for attempt in range(2):
            try:
                _MODEL = WhisperModel('base.en', device='cpu', compute_type='int8')
                print('[stt] model ready via %s' % m, flush=True)
                return _MODEL
            except Exception as e:
                last = e
                print('[stt] %s attempt %d failed: %s' % (m, attempt + 1, str(e)[:160]), flush=True)
                time.sleep(2)
    raise RuntimeError('Whisper 模型加载失败（镜像都试过了）：%s' % str(last)[:200])

_FW = {'ok': None}


def fw_ok():
    """faster-whisper 到底能不能 import —— 装没装、装坏了、Python 版本不对，一眼看出来"""
    if _FW['ok'] is None:
        try:
            import faster_whisper  # noqa: F401
            _FW['ok'] = True
        except Exception:
            _FW['ok'] = False
    return _FW['ok']


def model_state():
    """local=项目里自带模型；hub=HF 缓存里有；none=都没有（跟读/排序/配音会挂）"""
    if os.path.isfile(os.path.join(ROOT, 'models', 'whisper-base.en', 'model.bin')):
        return 'local'
    hub = os.path.join(os.path.expanduser('~'), '.cache', 'huggingface', 'hub')
    try:
        for n in os.listdir(hub):
            if n.startswith('models--Systran--faster-whisper-base.en'):
                return 'hub'
    except Exception:
        pass
    return 'none'


def ensure_control():
    if not os.path.exists(CTRL):
        _write_json(CTRL, DEFAULT_CTRL)


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

def find_node():
    """按 node.path → 常见安装目录 → PATH 的顺序找 node.exe。

    这里原来只有 shutil.which('node') or 'node'：这个窗口的 PATH 里一旦没有 node
    （比如不是从资源管理器双击、而是被别的程序拉起来的），点「开始」就会抛
    FileNotFoundError: [WinError 2]，界面上只剩一句「启动失败」。
    """
    cands = []
    try:
        with open(os.path.join(ROOT, 'node.path'), encoding='utf-8-sig') as f:
            cands.append(f.read().strip())
    except Exception:
        pass
    pf = os.environ.get('ProgramFiles') or r'C:\Program Files'
    la = os.environ.get('LOCALAPPDATA') or ''
    cands.append(os.path.join(pf, 'nodejs', 'node.exe'))
    if la:
        cands.append(os.path.join(la, 'Programs', 'nodejs', 'node.exe'))
    cands.append(shutil.which('node') or '')
    for c in cands:
        if c and os.path.isfile(c):
            return c
    return None


def _enc_key(plain):
    """用 keyvault.js 把明文 key 加密成 v1:... ；失败返回空串（调用方退回明文）"""
    node = find_node() or 'node'
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
    node = find_node()
    if not node:
        return {'ok': False, 'err': '找不到 node.exe（PATH 里没有，node.path 也没有）。'
                                    '双击 start-all.cmd 或 install.cmd 让它记下路径，再点开始'}
    os.makedirs(LOGD, exist_ok=True)   # logs 目录可能被删/移走，跑课进程的输出得先有地方落
    out = open(os.path.join(LOGD, 'runner.out'), 'ab')
    flags = 0x08000000 if os.name == 'nt' else 0
    try:
        p = subprocess.Popen([node, os.path.join(ROOT, 'run-all.js'), str(max_sec)],
                             cwd=ROOT, stdout=out, stderr=subprocess.STDOUT,
                             creationflags=flags)
    except FileNotFoundError as ex:
        return {'ok': False, 'err': '启动 run-all.js 失败：%s（node=%s）—— 跑一次 doctor.cmd 看环境' % (ex, node)}
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
        'fillerText': ctrl.get('fillerText', 'I think this unit is interesting and useful.'),
        'commentText': ctrl.get('commentText', 'I think this unit is interesting and useful.'),
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
    st['py'] = '%d.%d.%d' % sys.version_info[:3]
    st['node'] = find_node() or ''      # 空串 = serve 这个进程找不到 node，点开始会失败
    st['fw'] = fw_ok()          # faster-whisper 装好了没
    st['model'] = model_state() # local / hub / none
    st['runner'] = runner_alive()
    st['usage'] = api_usage()
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

def _node_info():
    """node 版本 + 有没有全局 WebSocket（21 以下没有，run-all/potato-watch 会当场崩）"""
    node = shutil.which('node')
    if not node:
        return None, False
    try:
        ver = subprocess.run([node, '-v'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10,
                             creationflags=(0x08000000 if os.name == 'nt' else 0)).stdout.decode().strip()
    except Exception:
        return None, False
    try:
        r = subprocess.run([node, '-e', 'process.exit(typeof WebSocket === "function" ? 0 : 1)'],
                           timeout=15, creationflags=(0x08000000 if os.name == 'nt' else 0))
        return ver, r.returncode == 0
    except Exception:
        return ver, False


def api_selfcheck():
    """一键体检：新用户出问题先看这个，比翻日志快"""
    checks = []

    def add(cid, level, msg):
        checks.append({'id': cid, 'level': level, 'msg': msg})

    pv = sys.version_info
    pyv = '%d.%d.%d' % pv[:3]
    if pv.minor >= 13:
        add('python', 'error', 'Python %s 装不上 faster-whisper（要 3.10~3.12）。跑 install.cmd 或 doctor.cmd' % pyv)
    elif pv.minor <= 8:
        add('python', 'warn', 'Python %s 偏旧，建议 3.12' % pyv)
    else:
        add('python', 'ok', 'Python %s' % pyv)

    if fw_ok():
        add('faster-whisper', 'ok', '已安装')
    else:
        add('faster-whisper', 'error', '当前 Python 里没有 faster-whisper，转写全不可用')

    ms = model_state()
    if ms == 'local':
        add('model', 'ok', '项目内 models/whisper-base.en')
    elif ms == 'hub':
        add('model', 'ok', 'HF 缓存里有（首次转写会读盘加载）')
    else:
        add('model', 'warn', '没有语音模型：把 whisper-base.en.zip 放项目根目录重跑 install.cmd，或让它下载')

    ver, ws = _node_info()
    if not ver:
        add('node', 'error', '找不到 node，run-all.js / potato-watch.js 都起不来')
    elif not ws:
        add('node', 'error', 'Node %s 没有全局 WebSocket，必须 22 以上（winget install OpenJS.NodeJS.LTS）' % ver)
    else:
        add('node', 'ok', 'Node %s（WebSocket 可用）' % ver)

    try:
        import urllib.request as _u
        _u.urlopen('http://127.0.0.1:9222/json/version', timeout=2).read()
        add('cdp', 'ok', '调试端口 9222 已连上')
    except Exception:
        add('cdp', 'error', '连不上 9222：先双击 start-chrome.cmd，再在调试窗口里登录 U 校园')

    ctrl = _read_json(CTRL, {})
    if ctrl.get('apiKeyEnc') or ctrl.get('apiKey'):
        add('key', 'ok', 'API Key 已保存')
    else:
        add('key', 'error', '还没填 DeepSeek API Key（docs/API-KEY.md）')

    bad = [c for c in checks if c['level'] == 'error']
    warn = [c for c in checks if c['level'] == 'warn']
    return {'ok': not bad, 'errors': len(bad), 'warns': len(warn), 'checks': checks}


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
        if p == '/api/selfcheck':
            outb = json.dumps(api_selfcheck(), ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(outb)))
            self.end_headers()
            self.wfile.write(outb)
            return
        if p == '/api/usage':
            outb = json.dumps(api_usage(), ensure_ascii=False).encode('utf-8')
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
        if p == '/api/update':
            res = api_update()
            outr = json.dumps(res, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(outr)))
            self.end_headers()
            self.wfile.write(outr)
            return
        if p == '/api/usage/reset':
            res = api_usage_reset()
            outr = json.dumps(res, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(outr)))
            self.end_headers()
            self.wfile.write(outr)
            return
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

class Srv(socketserver.ThreadingTCPServer):
    # 这两个必须在 bind 之前就位：allow_reuse_address 写在实例上是无效的，
    # 之前那样写会让「关掉再开」经常报 WinError 10048 / Address already in use。
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    ensure_control()
    if not fw_ok():
        print('[!] 当前 Python %d.%d 里没有 faster-whisper（3.13/3.14 装不上）。' % sys.version_info[:2], flush=True)
        print('    服务能起来，但转写 / 排序 / 跟读 / 配音都用不了。', flush=True)
        print('    修法：双击 doctor.cmd（或 install.cmd）装好 Python 3.12 再重开本窗口。', flush=True)
    if model_state() == 'none':
        print('[!] 没找到语音模型：models/whisper-base.en 不存在，首次转写会尝试联网下载 140MB。', flush=True)
    try:
        httpd = Srv(('127.0.0.1', PORT), H)
    except OSError as ex:
        print('', flush=True)
        print('[X] 端口 %d 起不来：%s' % (PORT, ex), flush=True)
        print('    多半是已经有一个 serve.cmd 在跑了（一个就够，别开第二个）。', flush=True)
        print('    想确认： netstat -ano | findstr :%d' % PORT, flush=True)
        sys.exit(3)
    print(f'http://127.0.0.1:{PORT}  日志目录 {LOGD}', flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n[停止] 本地服务关闭', flush=True)