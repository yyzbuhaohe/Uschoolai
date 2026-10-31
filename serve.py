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
REPO_RAW = 'https://raw.githubusercontent.com/yyzbuhaohe/Uschoolai/main/version.json'
# 启动时记下"这个进程加载的是哪一版"：更新完 version.json 会变成新号，
# 但内存里还是旧代码 —— 两者不一致就说明要重启 serve.cmd，界面上要明说。
BOOT_BUILD = 0
BOOT_NAME = ''
_VERCACHE = {'t': 0.0, 'ver': None}


def _ulog(msg):
    """更新流程单独写一份日志，出问题的机器把这个文件发过来就能定位。"""
    try:
        os.makedirs(LOGD, exist_ok=True)
        with open(os.path.join(LOGD, 'update.log'), 'a', encoding='utf-8') as f:
            f.write('[%s] %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg))
    except Exception:
        pass


def disk_version():
    return _read_json(os.path.join(ROOT, 'version.json'), {}) or {}


def _fetch_raw_version():
    """兜底：直接读 main 上的 version.json（main.zip 里读不到时的后路）。"""
    try:
        import urllib.request as _u
        req = _u.Request(REPO_RAW, headers={'User-Agent': 'potato-updater', 'Cache-Control': 'no-cache'})
        txt = _u.urlopen(req, timeout=20).read().decode('utf-8-sig')
        ver = json.loads(txt)
        if int(ver.get('build', 0) or 0):
            return ver
    except Exception as e:
        _ulog('raw version.json 也读不到：%s' % str(e)[:120])
    return None


def remote_version(max_age=600):
    """远端现在是多少（10 分钟缓存）。拿不到返回 None，不要去猜。"""
    if _VERCACHE['ver'] and time.time() - _VERCACHE['t'] < max_age:
        return _VERCACHE['ver']
    ver = _fetch_raw_version()
    if ver:
        _VERCACHE.update({'t': time.time(), 'ver': ver})
    return ver


def _archive_items(zf):
    """把 zip 条目拆成 (仓库内相对路径, zip 内原名)。

    GitHub 的 archive 会给所有文件套一层 `Uschoolai-main/`。这里不写死这个名字：
    如果所有条目共用同一个顶层目录就剥掉，没有套层就照原样用 —— 哪天 GitHub 改打包方式也不会全跳过。
    """
    names = [n for n in zf.namelist() if not n.endswith('/')]
    if not names:
        return []
    tops = {n.split('/', 1)[0] for n in names}
    strip = len(tops) == 1 and all('/' in n for n in names)
    return [((n.split('/', 1)[1] if strip else n), n) for n in names]


# 这几样缺一个，更新完就点不开或者跑不起来
REQUIRED_FILES = ('serve.py', 'run-all.js', 'version.json')


def _precheck(rel, data):
    """覆盖前就地检查这份文件。

    热更新最大的坑：把 serve.py 写坏 → 下次启动就是「双击没反应」，用户只能手动救。
    所以下载下来的东西先在内存里过一遍，能过才落盘。返回错误字符串，没问题返回 None。
    """
    low = rel.lower()
    if low.endswith('.py'):
        try:
            compile(data.decode('utf-8-sig'), rel, 'exec')
        except Exception as e:
            return 'Python 语法错误：%s' % str(e)[:120]
        return None
    if low.endswith(('.html', '.htm')):
        txt = data.decode('utf-8', 'replace')
        if txt.count('<script') != txt.count('</script>'):
            return '<script> 标签不配对（%d 个开 / %d 个闭）' % (txt.count('<script'), txt.count('</script>'))
        if '<html' in txt.lower() and '</html>' not in txt.lower():
            return 'HTML 没有 </html>，文件可能被截断'
        return None
    if low.endswith('.json'):
        try:
            json.loads(data.decode('utf-8-sig'))
        except Exception as e:
            return 'JSON 解析失败：%s' % str(e)[:80]
        return None
    return None


def _rollback(bakdir, written):
    """把本次已经写下去的文件按备份换回来；备份里没有的（原本不存在）直接删掉。

    半新半旧比不更新更坏：老的 serve.py + 新的 ui.html 会互相调不通。
    """
    ok, bad = 0, []
    for rel in reversed(written):
        dst = os.path.join(ROOT, rel.replace('/', os.sep))
        src = os.path.join(bakdir, rel.replace('/', os.sep))
        try:
            if os.path.exists(src):
                shutil.copy2(src, dst)
                ok += 1
            elif os.path.exists(dst):
                os.remove(dst)
                ok += 1
        except Exception:
            bad.append(rel)
    return ok, bad


def api_update(data=None):
    """从 GitHub 拉最新代码覆盖本地。只动代码和文档，control.json / state.json / usage.json 一律不碰。

    返回里带 diag（远端/本地 build、下载字节、条目数、判定原因），
    这样"为什么说已是最新"能在界面上直接说清，不用连麦猜。
    """
    import io, zipfile
    import urllib.request as _u
    data = data or {}
    force = bool(data.get('force'))
    keep = {'control.json', 'state.json', 'usage.json', 'logs'}
    bak = os.path.join(ROOT, '.bak-update')
    local_ver = disk_version()
    diag = {'remote': 0, 'local': int(local_ver.get('build', 0) or 0), 'zipBytes': 0,
            'entries': 0, 'force': force, 'reason': ''}

    try:
        req = _u.Request(REPO_ZIP, headers={'User-Agent': 'potato-updater', 'Accept': '*/*'})
        raw = _u.urlopen(req, timeout=60).read()
        diag['zipBytes'] = len(raw)
        zf = zipfile.ZipFile(io.BytesIO(raw))
        diag['entries'] = len(zf.infolist())
    except Exception as e:
        _ulog('下载 main.zip 失败：%s' % str(e)[:200])
        return {'ok': False, 'err': '下载 main.zip 失败：%s' % str(e)[:160], 'diag': diag}

    # 远端版本：先在 zip 里找，找不到再走 raw
    remote_ver = None
    try:
        cand = [n for n in zf.namelist() if n.endswith('/version.json') or n == 'version.json']
        if cand:
            remote_ver = json.loads(zf.read(cand[0]).decode('utf-8-sig'))
    except Exception as e:
        _ulog('zip 里的 version.json 解析失败：%s' % str(e)[:120])
        remote_ver = None
    if not remote_ver:
        diag['reason'] = 'zip 里没读到 version.json，改用 raw 比对'
        remote_ver = _fetch_raw_version()
    remote_build = int((remote_ver or {}).get('build', 0) or 0)
    diag['remote'] = remote_build
    local_build = diag['local']

    if not remote_build:
        _ulog('拿不到远端版本号（zip 条目 %d，下载 %d 字节）' % (diag['entries'], diag['zipBytes']))
        return {'ok': False, 'diag': diag,
                'err': '拿不到远端版本号：main.zip 里没有 version.json，raw 也读不到（可能被网络/代理拦了）。'
                       '确认能打开 github.com 后重试，或者点「强制更新」直接覆盖。'}

    if not force and local_build and remote_build <= local_build:
        diag['reason'] = '远端不比本地新'
        _ulog('跳过：本地 %d / 远端 %d' % (local_build, remote_build))
        return {'ok': True, 'n': 0, 'changed': [], 'build': remote_build, 'local': local_build, 'diag': diag,
                'msg': '已经是最新：本地 build %d，远端 build %d' % (local_build, remote_build)}

    # ---- 3) 覆盖前预检：宁可这次不更新，也别把 serve.py 写成语法错误 ----
    plan = []
    for rel, name in _archive_items(zf):
        head = rel.split('/')[0]
        if head in keep:
            continue
        # 仓库自用的东西不下发到用户机器：GitHub actions、开发脚本
        if head in ('.github', '.dev', '.vscode'):
            continue
        if rel.endswith('.pyc') or '__pycache__' in rel:
            continue
        try:
            plan.append((rel, zf.read(name)))
        except Exception as e:
            diag['reason'] = 'zip 条目读不出来：' + str(e)[:80]
            return {'ok': False, 'diag': diag, 'err': 'main.zip 里有条目读不出来：%s' % str(e)[:120]}

    miss = [f for f in REQUIRED_FILES if not any(p[0] == f for p in plan)]
    if miss:
        diag['reason'] = '远端包不完整：缺 ' + ', '.join(miss)
        _ulog('远端包不完整，缺：' + ', '.join(miss))
        return {'ok': False, 'diag': diag,
                'err': '远端这套文件缺 %s，不敢覆盖（本地一个字节都没动）' % ', '.join(miss)}

    bad = []
    for rel, blob in plan:
        err = _precheck(rel, blob)
        if err:
            bad.append('%s → %s' % (rel, err))
    if bad:
        diag['reason'] = '预检不通过'
        _ulog('预检不通过，拒绝覆盖：' + '; '.join(bad[:5]))
        return {'ok': False, 'diag': diag,
                'err': '远端这版没通过覆盖前预检，已拒绝（本地一个字节都没动）：' + ' / '.join(bad[:3])}

    # ---- 4) 落盘：备份按时间戳分目录并保留原目录结构，中途失败整批回滚 ----
    stamp = time.strftime('%Y%m%d-%H%M%S')
    bakdir = os.path.join(bak, stamp)
    written, failed = [], []
    for rel, blob in plan:
        dst = os.path.join(ROOT, rel.replace('/', os.sep))
        try:
            old = None
            if os.path.exists(dst):
                with open(dst, 'rb') as f:
                    old = f.read()
            if old == blob:
                continue
            if old is not None:
                bdst = os.path.join(bakdir, rel.replace('/', os.sep))
                bdir = os.path.dirname(bdst)
                if bdir:
                    os.makedirs(bdir, exist_ok=True)
                with open(bdst, 'wb') as f:
                    f.write(old)
            pdir = os.path.dirname(dst)
            if pdir:
                os.makedirs(pdir, exist_ok=True)
            with open(dst, 'wb') as f:
                f.write(blob)
            written.append(rel)
        except Exception as e:
            failed.append('%s: %s' % (rel, str(e)[:60]))

    if failed:
        restored, rbad = _rollback(bakdir, written)
        diag['reason'] = '写入失败并已回滚'
        _ulog('写入失败 %d 个：%s；回滚 %d 个%s' % (len(failed), '; '.join(failed[:5]), restored,
                                                ('，回滚失败：' + ', '.join(rbad[:3])) if rbad else ''))
        return {'ok': False, 'diag': diag, 'changed': [],
                'err': '写入失败（文件被占用 / 没写权限？）：%s\n已回滚 %d 个文件，其余没动，本地仍是 build %d。%s'
                       % ('; '.join(failed[:3]), restored, local_build,
                          ('回滚也有失败：' + ', '.join(rbad[:3])) if rbad else '')}

    # 备份目录留个 LATEST.txt，rollback.cmd 就靠它找最近一次
    if written:
        try:
            with open(os.path.join(bak, 'LATEST.txt'), 'w', encoding='utf-8') as f:
                f.write(stamp + '\n')
        except Exception:
            pass

    try:
        _write_json(os.path.join(ROOT, 'version.json'), remote_ver)
    except Exception:
        pass
    _ulog('更新 %d 个文件：本地 %d → 远端 %d%s；备份 %s' % (len(written), local_build, remote_build,
                                                    '（强制）' if force else '', stamp))
    msg = '%s → %s（build %d → %d）' % (local_ver.get('name') or '?', (remote_ver or {}).get('name') or '?',
                                        local_build, remote_build)
    return {'ok': True, 'changed': written, 'n': len(written), 'backup': bakdir if written else bak,
            'build': remote_build, 'local': local_build, 'msg': msg, 'diag': diag,
            'restart': bool(local_build and remote_build != local_build)}


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
PIDF = os.path.join(ROOT, 'runner.pid')
_PIDC = {'t': 0.0, 'pid': 0, 'alive': False}


def _pid_alive(pid, fresh=False):
    """pid 还活着吗。

    两条硬要求：
      1) 不能走 os.kill(pid, 0)。CPython 在 Windows 上的实现是
         OpenProcess + TerminateProcess(handle, 0) —— 探活会把进程真杀掉。
      2) 得快。控制台每 2 秒轮询一次，停止流程还要等进程退出；
         tasklist 一次要 300~450ms，40 次就是十几秒。所以先用 ctypes 直接
         OpenProcess + GetExitCodeProcess（毫秒级，只读），拿不到再退回 tasklist。
    """
    if not pid or pid <= 0:
        return False
    now = time.time()
    if not fresh and _PIDC['pid'] == pid and now - _PIDC['t'] < 1.5:
        return _PIDC['alive']
    alive = False
    if os.name == 'nt':
        try:
            import ctypes
            k32 = ctypes.windll.kernel32
            h = k32.OpenProcess(0x1000, False, int(pid))   # PROCESS_QUERY_LIMITED_INFORMATION
            if h:
                code = ctypes.c_ulong(0)
                ok = k32.GetExitCodeProcess(h, ctypes.byref(code))
                k32.CloseHandle(h)
                alive = bool(ok) and int(code.value) == 259   # STILL_ACTIVE
            else:
                alive = False
        except Exception:
            try:
                out = subprocess.run(['tasklist', '/FI', 'PID eq %d' % int(pid), '/NH'],
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=8,
                                     creationflags=0x08000000).stdout.decode('utf-8', 'replace')
                alive = str(int(pid)) in out
            except Exception:
                alive = False
    else:
        try:
            os.kill(pid, 0)
            alive = True
        except Exception:
            alive = False
    _PIDC.update({'t': now, 'pid': pid, 'alive': alive})
    return alive


def _read_pidf():
    try:
        with open(PIDF, encoding='utf-8-sig') as f:
            return int((f.read() or '0').strip() or 0)
    except Exception:
        return 0


def runner_pid():
    """真正在跑的 run-all.js 的 pid。

    先看这个进程记住的 Popen，再看 runner.pid —— 后者是给「serve.cmd 重启过、
    旧 run-all.js 变孤儿」这种情况留的：那种时候 RUNNER['proc'] 是 None，
    老代码会认定「没在跑」，于是停止按钮空转、再点开始就起第二个进程打同一屏。
    """
    p = RUNNER.get('proc')
    if p is not None and p.poll() is None:
        return p.pid
    pid = _read_pidf()
    return pid if _pid_alive(pid) else 0


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
    return runner_pid() > 0


def _kill_tree(pid):
    """硬杀一棵进程树：run-all.js 会用 spawnSync 拉起 dub.js，只 terminate 父进程会留孤儿配音进程。"""
    if not pid:
        return False
    try:
        if os.name == 'nt':
            r = subprocess.run(['taskkill', '/F', '/T', '/PID', str(pid)],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20,
                               creationflags=0x08000000)
            return r.returncode == 0
        os.kill(pid, 9)
        return True
    except Exception:
        return False


def start_runner(max_sec):
    pid = runner_pid()
    if pid:
        # 关键：以前这里只看 RUNNER['proc']，serve 重启过一次就再也拦不住第二个 runner
        return {'ok': True, 'already': True, 'pid': pid}
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
    try:
        with open(PIDF, 'w', encoding='utf-8') as f:
            f.write(str(p.pid))
    except Exception:
        pass
    _PIDC.update({'t': time.time(), 'pid': p.pid, 'alive': True})
    return {'ok': True, 'pid': p.pid, 'maxSec': max_sec}


def stop_runner():
    """先软停、再硬杀。

    软停 = 往 control.json 写 state="stop"：run-all.js 的 checkpoint() 塞在 sleep() 里，
    1~2 秒内自己走到 process.exit（能正常 flush usage、清 pid 文件）。
    硬杀 = taskkill /F /T，兜住「node 在长阻塞里（转写/模型请求）没轮到 checkpoint」的情况。
    """
    pid = runner_pid()
    soft = False
    try:
        cur = _read_json(CTRL, {'state': 'stopped'})
        cur['state'] = 'stop'
        _write_json(CTRL, cur)
        soft = True
    except Exception:
        pass
    if not pid:
        try:
            if os.path.exists(PIDF):
                os.remove(PIDF)
        except Exception:
            pass
        return {'ok': True, 'already': True, 'soft': soft, 'pid': 0}

    p = RUNNER.get('proc')
    waited = False
    for _ in range(40):            # 最多等 4 秒让它自己退
        if p is not None and p.poll() is not None:
            waited = True
            break
        if p is None and not _pid_alive(pid, fresh=True):
            waited = True
            break
        time.sleep(0.1)
    killed = False
    if not waited and _pid_alive(pid, fresh=True):
        killed = _kill_tree(pid)
    try:
        if p is not None:
            p.poll()
    except Exception:
        pass
    try:
        if os.path.exists(PIDF):
            os.remove(PIDF)
    except Exception:
        pass
    RUNNER['proc'] = None
    return {'ok': True, 'pid': pid, 'soft': soft, 'graceful': waited, 'killed': killed}

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
    st['runnerPid'] = runner_pid()
    st['usage'] = api_usage()
    # 版本与"要不要重启"：更新只换磁盘上的文件，进程内存里还是旧代码。
    # 不把这件事说清楚，用户会以为「更新成功但没变化」，再看版本号又显示最新。
    dv = disk_version()
    d_build = int(dv.get('build', 0) or 0)
    b_build = int(BOOT_BUILD or 0)
    st['build'] = b_build or d_build
    st['buildName'] = BOOT_NAME or str(dv.get('name') or '')
    st['diskBuild'] = d_build
    st['stale'] = bool(b_build and d_build and d_build > b_build)
    # 进程没了就别再显示「运行中 / 已暂停」；
    # 反过来，进程还在（哪怕是 serve 重启后留下的孤儿）就绝不能把 control.json 改成 stopped ——
    # 老代码这里每 2 秒写一次，会把 runner 刚写下的 paused 覆盖掉，暂停按钮看着生效其实没生效。
    if not st['runner'] and st.get('state') in ('running', 'paused', 'stop'):
        st['state'] = 'stopped'
        try:
            cur = _read_json(CTRL, {'state': 'stopped'})
            if cur.get('state') in ('running', 'paused', 'stop'):
                cur['state'] = 'stopped'
                _write_json(CTRL, cur)
        except Exception:
            pass
    elif st.get('state') == 'stop':
        st['state'] = 'stopped'      # 软停进行中，界面上就是「已停止」
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

    # 版本：本地 / 远端各一行，比翻日志快（远端 10 分钟缓存，不会每次体检都打 GitHub）
    dv = disk_version()
    d_build = int(dv.get('build', 0) or 0)
    add('version', 'ok' if d_build else 'warn',
        ('本地 %s（build %d）' % (dv.get('name') or '?', d_build)) if d_build else '本地没有 version.json，版本未知')
    if int(BOOT_BUILD or 0) and d_build and d_build > int(BOOT_BUILD):
        add('restart', 'warn', '磁盘上已经是 build %d，这个进程还跑着 build %d → 关掉 serve 窗口重开 serve.cmd 才生效'
            % (d_build, int(BOOT_BUILD)))
    rv = remote_version()
    if rv:
        r_build = int(rv.get('build', 0) or 0)
        if d_build and r_build > d_build:
            add('remote', 'warn', '远端有新版本 %s（build %d），点「检查更新」升级' % (rv.get('name') or '?', r_build))
        else:
            add('remote', 'ok', '远端 %s（build %d），本地已是最新' % (rv.get('name') or '?', r_build))
    else:
        add('remote', 'warn', '读不到远端版本：这台机器访问 github.com 有问题（代理/墙），检查更新会失败')

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
    # next 只推进"真正发出去的行数"：以前直接给 len(lines)，一次超过 200 行
    # （转写/模型请求密集时很正常）中间那些行就永远看不到了
    next_id = after + len(tail)
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
    return {'lines': out, 'next': next_id}
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
            try:
                udata = json.loads(body.decode('utf-8') or '{}') if body else {}
                if not isinstance(udata, dict):
                    udata = {}
            except Exception:
                udata = {}
            res = api_update(udata)
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
                    # 'filler' 以前漏在这个列表外：控制台那个「主观题写通用答案」勾掉也不生效
                    for k in ('maxSec', 'delay', 'rate', 'guess', 'filler', 'fillerText',
                              'commentText', 'maxFail', 'pauseEvery'):
                        if k in data:
                            cur[k] = data[k]
                    if 'apiKey' in data:
                        store_api_key(cur, data.get('apiKey'))
                    _write_json(CTRL, cur)
                    res = start_runner(int(cur.get('maxSec') or 3))
                    # 只有真的新起了一个进程才清进度；点开始去「确认已在跑」的时候别把 ok/fail 清零
                    if res.get('ok') and not res.get('already'):
                        _write_json(STATE, {'state': 'running', 'section': '-', 'screen': '-', 'ok': 0, 'fail': 0, 'page': ''})
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
                    cur['state'] = {'start': 'running', 'pause': 'paused', 'stop': 'stop'}[act]
                    # /api/control 说 stop 也得真的把进程停掉，别只改个字段
                    if act == 'stop':
                        try:
                            stop_runner()
                        except Exception:
                            pass
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
    _v0 = disk_version()
    BOOT_BUILD = int(_v0.get('build', 0) or 0)
    BOOT_NAME = str(_v0.get('name') or '')
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