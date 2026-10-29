/* node cdp.js list | eval <file> | nav <url> | click <x> <y> */
const fs = require('fs');
const BASE = 'http://127.0.0.1:9222';

async function targets() {
  const r = await fetch(BASE + '/json/list');
  return r.json();
}
function pick(ts, want) {
  const pages = ts.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (want) {
    const hit = pages.find(p => p.url.includes(want));
    if (hit) return hit;
  }
  return pages.find(p => /unipus/.test(p.url)) || pages[0];
}
function send(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('timeout')); }, 30000);
    ws.onopen = () => ws.send(JSON.stringify({ id, method, params: params || {} }));
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id !== id) return;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    };
    ws.onerror = e => { clearTimeout(timer); reject(new Error('ws error')); };
  });
}

(async () => {
  const [op, a1, a2] = process.argv.slice(2);
  const ts = await targets();
  if (!op || op === 'list') {
    ts.filter(t => t.type === 'page').forEach(t => console.log(t.url.slice(0, 100), '|', t.title.slice(0, 40)));
    return;
  }
  const page = pick(ts, process.env.CDP_MATCH || 'unipus');
  if (!page) { console.log('no page target'); return; }
  if (op === 'eval') {
    const code = fs.readFileSync(a1, 'utf8');
    const r = await send(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
    console.log(JSON.stringify(r.result && r.result.value !== undefined ? r.result.value : r));
    return;
  }
  if (op === 'nav') {
    await send(page.webSocketDebuggerUrl, 'Page.navigate', { url: a1 });
    console.log('nav ok');
    return;
  }
  if (op === 'setjwt') {
    const jwt = fs.readFileSync(a1, 'utf8').trim();
    for (const url of ['https://ucontent.unipus.cn/', 'https://ucloud.unipus.cn/', 'https://ucampus.unipus.cn/']) {
      try { await send(page.webSocketDebuggerUrl, 'Network.setCookie', { name: 'jwt', value: jwt, url, path: '/' }); } catch (e) {}
    }
    console.log('jwt injected len=' + jwt.length);
    return;
  }
  if (op === 'reload') {
    await send(page.webSocketDebuggerUrl, 'Page.reload', { ignoreCache: false });
    console.log('reloaded');
    return;
  }
  if (op === 'logout') {
    await send(page.webSocketDebuggerUrl, 'Network.clearBrowserCookies');
    await send(page.webSocketDebuggerUrl, 'Network.clearBrowserCache');
    await send(page.webSocketDebuggerUrl, 'Page.navigate', { url: 'https://ucontent.unipus.cn/_explorationpc_default/pc.html' });
    console.log('cookies cleared, navigating');
    return;
  }
  if (op === 'viewport') {
    await send(page.webSocketDebuggerUrl, 'Emulation.setDeviceMetricsOverride', { width: Number(a1) || 1280, height: Number(a2) || 2000, deviceScaleFactor: 1, mobile: false });
    console.log('viewport set');
    return;
  }
  if (op === 'wheel') {
    await send(page.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: Number(a1) || 700, y: Number(a2) || 400, deltaX: 0, deltaY: Number(process.argv[5]) || 400 });
    console.log('wheel');
    return;
  }
  if (op === 'type') {
    await send(page.webSocketDebuggerUrl, 'Input.insertText', { text: a1 || '' });
    console.log('typed');
    return;
  }
  if (op === 'clear') {
    await send(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: "document.activeElement && (document.activeElement.textContent='')" });
    console.log('cleared');
    return;
  }
  if (op === 'click') {
    const x = Number(a1), y = Number(a2);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send(page.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
    console.log('clicked', x, y);
    return;
  }
  console.log('usage: list | eval <file> | nav <url> | click <x> <y>');
})();