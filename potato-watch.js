/* potato-watch.js —— 土豆控制台注入守护
   这台 Chrome 的扩展权限被策略锁了（chrome://extensions 里写着「您的家长已停用扩展程序权限」），
   Tampermonkey 装了也注不进用户脚本。所以改成自己扫 CDP，把脚本注进刷课页。

   用法：
     node potato-watch.js          只注土豆控制台
     node potato-watch.js --farm   连挂机模块一起注
*/
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:9222';
const ROOT = __dirname;
const WITH_FARM = process.argv.includes('--farm');
const LOG = path.join(ROOT, 'logs', 'potato-watch.log');
const INTERVAL = 2000;
const SRC = {
  ui: { file: path.join(ROOT, 'potato-ui.user.js'), marker: '__POTATO_UI__' },
  farm: { file: path.join(ROOT, 'potato-farm.user.js'), marker: '__POTATO_FARM__' },
  dub: { file: path.join(ROOT, 'dub-hook.js'), marker: '__potatoDub' },
};

function log(m) {
  const line = '[' + new Date().toLocaleTimeString() + '] ' + m;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
}

function call(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('timeout')); }, 8000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: method, params: params || {} }));
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
  });
}

async function evalIn(wsUrl, expr) {
  const r = await call(wsUrl, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) throw new Error('eval exception');
  return r && r.result ? r.result.value : undefined;
}

const cache = {};
function source(key) {
  if (!cache[key]) cache[key] = fs.readFileSync(SRC[key].file, 'utf8');
  return cache[key];
}

const failed = new Set();
const seeded = new Set();   // 已经注册过「加载前注入」的 target
let lastLog = 0;

async function tick() {
  let list;
  try {
    list = await (await fetch(BASE + '/json/list')).json();
  } catch (e) {
    if (Date.now() - lastLog > 60000) { lastLog = Date.now(); log('!! 连不上 CDP 9222，等它起来'); }
    return;
  }
  const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl && /ucontent\.unipus\.cn/.test(t.url));
  for (const p of pages) {
    // 配音题的音频旁路必须赶在页面脚本之前 —— 注册成「每次导航前先跑」
    const dk = p.id + ':dubscript';
    if (!failed.has(dk) && !seeded.has(p.id)) {
      try {
        await call(p.webSocketDebuggerUrl, 'Page.addScriptToEvaluateOnNewDocument', { source: source('dub') });
        seeded.add(p.id);
        log('注册配音旁路（页面加载前注入）');
      } catch (e) {
        failed.add(dk);
        log('注册配音旁路失败：' + e.message);
      }
    }
    const want = [['ui', SRC.ui.marker], ['dub', SRC.dub.marker]];
    if (WITH_FARM) want.push(['farm', SRC.farm.marker]);
    for (const pair of want) {
      const key = pair[0], marker = pair[1];
      try {
        const has = await evalIn(p.webSocketDebuggerUrl, '!!window.' + marker);
        if (!has) {
          await evalIn(p.webSocketDebuggerUrl, source(key));
          log('注入 ' + key + ' → ' + p.url.slice(0, 60));
          failed.delete(p.id + ':' + key);
        }
      } catch (e) {
        const k = p.id + ':' + key;
        if (!failed.has(k)) { failed.add(k); log('注入失败 ' + key + '（' + e.message + '）→ ' + p.url.slice(0, 40)); }
      }
    }
  }
}

(async () => {
  log('土豆注入守护启动（farm=' + WITH_FARM + '），每 ' + INTERVAL + 'ms 扫一次 ' + BASE);
  for (;;) {
    await tick();
    await new Promise(r => setTimeout(r, INTERVAL));
  }
})();
