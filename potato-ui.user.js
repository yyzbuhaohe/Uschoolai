// ==UserScript==
// @name         U 校园自动化 · 土豆控制台
// @namespace    local.unipus.potato
// @version      1.0.0
// @description  挂在刷课页面上的控制面板（土豆主题），可拖动、可收起，不挡页面操作
// @match        *://ucontent.unipus.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (window.__POTATO_UI__) return;
  window.__POTATO_UI__ = true;

  const API = 'http://127.0.0.1:8787';

  const css = `
  :host{
    position:fixed;right:16px;bottom:88px;z-index:2147483000;
    font:13px/1.55 -apple-system,'Segoe UI','PingFang SC',sans-serif;
    color:#4a3410;pointer-events:none;
    display:flex;flex-direction:column;align-items:flex-end;gap:10px;
    max-width:calc(100vw - 20px);max-height:calc(100vh - 20px);
  }
  :host(.p-dragging){transition:none}
  /* 跑课脚本点击时加 .p-pass，让鼠标穿过面板/土豆球 */
  :host(.p-pass) .p-ui{pointer-events:none !important}
  *{box-sizing:border-box}
  .p-ui{pointer-events:auto}

  /* 收起态：一颗土豆 */
  #potato-ball{
    width:56px;height:56px;border-radius:50% 46% 52% 48%/48% 52% 46% 54%;
    background:radial-gradient(circle at 34% 30%,#f2d98b 0%,#d9ab4a 45%,#a97c22 100%);
    box-shadow:0 6px 18px rgba(90,60,0,.35),inset -4px -6px 12px rgba(120,80,10,.28),inset 4px 4px 10px rgba(255,240,190,.55);
    display:flex;align-items:center;justify-content:center;font-size:26px;
    cursor:grab;user-select:none;transition:transform .18s cubic-bezier(.34,1.56,.64,1);
    position:relative;
  }
  #potato-ball:hover{transform:scale(1.08) rotate(-3deg)}
  #potato-ball:active{cursor:grabbing;transform:scale(.96)}
  #potato-ball .p-dot{
    position:absolute;right:2px;top:2px;width:12px;height:12px;border-radius:50%;
    background:#b0a89a;border:2px solid #fff8e6;
  }
  #potato-ball.run .p-dot{background:#4caf50;box-shadow:0 0 8px #4caf50}
  #potato-ball.pause .p-dot{background:#e6a700}
  #potato-ball.stop .p-dot{background:#d9534f}

  /* 展开态 */
  #potato-panel{
    display:none;width:312px;max-width:calc(100vw - 20px);
    max-height:calc(100vh - 180px);flex-direction:column;
    border-radius:18px 18px 18px 6px;
    background:linear-gradient(160deg,#fff8e6 0%,#f7e7bd 48%,#eed49a 100%);
    box-shadow:0 14px 40px rgba(90,60,0,.32),inset 0 1px 0 rgba(255,255,255,.8);
    border:1px solid #e2c684;overflow:hidden;
  }
  #potato-panel.show{display:flex;animation:potatoIn .22s cubic-bezier(.34,1.56,.64,1)}
  @keyframes potatoIn{from{opacity:0;transform:translateY(10px) scale(.96)}to{opacity:1;transform:none}}

  .p-head{
    display:flex;align-items:center;gap:8px;padding:10px 12px;
    background:linear-gradient(135deg,#e8c46a,#d4a83c);
    color:#4a3410;font-weight:800;font-size:13.5px;letter-spacing:.02em;
    border-bottom:1px solid #c99b2e;
    cursor:grab;user-select:none;flex:0 0 auto;
  }
  .p-head:active{cursor:grabbing}
  .p-head .p-emoji{font-size:17px;pointer-events:none}
  .p-head .p-title{pointer-events:none}
  .p-head .p-badge{
    margin-left:auto;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:20px;
    background:rgba(255,255,255,.55);color:#6b4d0a;pointer-events:none;
  }
  .p-min{
    width:22px;height:22px;flex:0 0 auto;line-height:1;padding:0;
    border:0;border-radius:7px;cursor:pointer;
    background:rgba(255,255,255,.5);color:#5a4008;font-weight:800;font-size:13px;
  }
  .p-min:hover{background:rgba(255,255,255,.8)}

  .p-body{
    padding:12px 14px 14px;flex:1 1 auto;min-height:0;
    overflow-y:auto;overscroll-behavior:contain;
  }
  .p-body::-webkit-scrollbar{width:6px}
  .p-body::-webkit-scrollbar-thumb{background:rgba(160,120,40,.45);border-radius:3px}
  .p-body::-webkit-scrollbar-track{background:transparent}

  .p-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:11px}
  .p-stat{
    background:rgba(255,255,255,.62);border:1px solid rgba(190,150,60,.35);
    border-radius:12px;padding:7px 9px;
  }
  .p-stat b{display:block;font-size:15px;font-weight:800;color:#5a4008;line-height:1.25}
  .p-stat span{font-size:10.5px;color:#8a6a2a}

  .p-btns{display:flex;gap:7px;margin-bottom:11px}
  .p-btn{
    flex:1;border:0;border-radius:11px;padding:9px 0;font-size:12.5px;font-weight:800;
    cursor:pointer;transition:transform .12s,filter .12s;color:#fff;
    box-shadow:0 3px 0 rgba(0,0,0,.13);
  }
  .p-btn:hover:not(:disabled){filter:brightness(1.07);transform:translateY(-1px)}
  .p-btn:active:not(:disabled){transform:translateY(1px);box-shadow:0 1px 0 rgba(0,0,0,.13)}
  .p-btn:disabled{opacity:.42;cursor:not-allowed;box-shadow:none}
  .p-btn.go{background:linear-gradient(160deg,#7cb342,#558b2f)}
  .p-btn.pause{background:linear-gradient(160deg,#f9a825,#ef6c00)}
  .p-btn.stop{background:linear-gradient(160deg,#e57373,#c62828)}

  .p-row{display:flex;align-items:center;justify-content:space-between;padding:5px 0;font-size:12px;color:#6b4d0a}
  .p-row + .p-row{border-top:1px dashed rgba(190,150,60,.35)}
  .p-row input[type=number]{
    width:64px;padding:3px 7px;border-radius:8px;border:1px solid #d8bd80;
    background:#fffdf5;color:#5a4008;font-size:12px;font-weight:700;text-align:center;
  }
  .p-row input[type=checkbox]{width:15px;height:15px;accent-color:#8bc34a;cursor:pointer}

  .p-env{background:rgba(255,253,245,.6);border:1px solid rgba(190,150,60,.3);border-radius:10px;padding:6px 8px;margin-top:5px}
  .p-env-row{display:flex;align-items:center;justify-content:space-between;font-size:11px;color:#6b4d0a;padding:2px 0}
  .p-env-row b{font-weight:700}
  .p-ok{color:#4c8c2b;font-weight:700}
  .p-bad{color:#c62828;font-weight:700}
  .p-warn{color:#c17900;font-weight:700}
  .p-hint{font-size:10px;color:#96773a;margin-top:3px;line-height:1.45}
  .p-hint code{background:rgba(190,150,60,.18);padding:1px 4px;border-radius:4px;font-size:10px}
  .p-switch{position:relative;display:inline-block;width:38px;height:20px;flex:0 0 auto}
  .p-switch input{opacity:0;width:0;height:0}
  .p-switch i{position:absolute;inset:0;background:rgba(150,119,58,.35);border-radius:20px;transition:.25s;cursor:pointer}
  .p-switch i:before{content:'';position:absolute;width:16px;height:16px;left:2px;top:2px;background:#fffdf5;border-radius:50%;transition:.25s;box-shadow:0 1px 3px rgba(0,0,0,.2)}
  .p-switch input:checked + i{background:linear-gradient(160deg,#a3cc4b,#6f9c2a)}
  .p-switch input:checked + i:before{transform:translateX(18px)}
  .p-farm-stat{font-size:10px;color:#96773a;margin-top:4px;line-height:1.4}
  .p-sec-title{
    font-size:10.5px;font-weight:800;color:#96773a;letter-spacing:.06em;
    margin:9px 0 4px;padding-top:7px;border-top:1px dashed rgba(190,150,60,.35);
  }
  .p-text{
    width:100%;padding:5px 8px;border-radius:8px;border:1px solid #d8bd80;
    background:#fffdf5;color:#5a4008;font-size:11.5px;font-family:inherit;
    resize:vertical;min-height:28px;
  }
  .p-text:focus{outline:none;border-color:#c99b2e;box-shadow:0 0 0 2px rgba(201,155,46,.18)}
  .p-keyrow{display:flex;gap:6px;align-items:center}
  .p-keyrow .p-text{flex:1 1 auto}
  .p-prog{height:6px;border-radius:4px;background:rgba(190,150,60,.22);overflow:hidden;margin:8px 0 2px}
  .p-prog i{display:block;height:100%;width:0;background:linear-gradient(90deg,#a3cc4b,#6f9c2a);transition:width .4s}
  .p-tip{font-size:10px;color:#96773a;margin-top:3px;line-height:1.4}
  .p-log{
    flex:0 0 auto;margin:0 12px 8px;height:104px;overflow:auto;border-radius:11px;
    background:#3d2e12;color:#f0e3c0;font:11px/1.5 ui-monospace,Consolas,monospace;
    padding:8px 9px;white-space:pre-wrap;word-break:break-all;
    box-shadow:inset 0 1px 4px rgba(0,0,0,.35);
  }
  .p-log::-webkit-scrollbar{width:5px}
  .p-log::-webkit-scrollbar-thumb{background:#7a5c1e;border-radius:3px}
  .p-log .ok{color:#a5d66f}
  .p-log .err{color:#ff9a8b}
  .p-log .warn{color:#ffd166}
  .p-log .dim{color:#b9a67d}

  .p-foot{
    flex:0 0 auto;margin:0 12px 11px;font-size:10.5px;color:#96773a;text-align:center;
    letter-spacing:.03em;
  }
  `;

  // 挂到 shadow DOM：页面脚本（run-all.js）扫 textarea/innerText 时看不到我们的控件
  const host = document.createElement('div');
  host.id = 'potato-root';
  const shadow = host.attachShadow({ mode: 'open' });

  const root = shadow;
  root.innerHTML = `<style>${css}</style>
    <div id="potato-panel" class="p-ui">
      <div class="p-head" id="p-head"><span class="p-emoji">🥔</span><span class="p-title">土豆刷课台</span><span class="p-badge" id="p-state">停止</span><button class="p-min" id="p-min" title="收起">—</button></div>
      <div class="p-body">
        <div class="p-stats">
          <div class="p-stat"><b id="p-sec">-</b><span>当前节</span></div>
          <div class="p-stat"><b id="p-screen">-</b><span>当前屏</span></div>
        </div>
        <div class="p-btns">
          <button class="p-btn go" id="p-go">开始</button>
          <button class="p-btn pause" id="p-pause" disabled>暂停</button>
          <button class="p-btn stop" id="p-stop">停止</button>
        </div>
        <div class="p-prog"><i id="p-bar"></i></div>
        <div class="p-tip" id="p-tip">等待开始</div>

        <div class="p-sec-title">文案</div>
        <textarea class="p-text" id="p-filler" rows="1" placeholder="主观题填什么">I think this unit is interesting and useful.</textarea>
        <textarea class="p-text" id="p-comment" rows="1" placeholder="讨论区评论什么">I think this unit is interesting and useful.</textarea>

        <div class="p-sec-title">挂机</div>
        <div class="p-row"><span>跑到第几节后停</span><input type="number" id="p-max" value="8" min="1" max="275"></div>
        <div class="p-row"><span>每跑几节歇一下</span><input type="number" id="p-pause-every" value="0" min="0" max="50"></div>
        <div class="p-row"><span>连续几屏失败就停</span><input type="number" id="p-maxfail" value="5" min="1" max="20"></div>
        <div class="p-row"><span>答题延迟 ms</span><input type="number" id="p-delay" value="900" min="300" max="5000"></div>
        <div class="p-row"><span>视频倍速</span><input type="number" id="p-rate" value="4" min="1" max="8" step="0.5"></div>
        <div class="p-row"><span>图片题随机蒙</span><input type="checkbox" id="p-guess" checked></div>

        <div class="p-sec-title">刷时长</div>
        <div class="p-row"><span>挂机模拟活动</span><label class="p-switch"><input type="checkbox" id="p-farm"><i></i></label></div>
        <div class="p-farm-stat" id="p-farm-stat">停在评论页 → 定时滚一下 → 自动关超时弹窗</div>

        <div class="p-sec-title">模型</div>
        <div class="p-keyrow">
          <input class="p-text" id="p-key" type="password" placeholder="sk-… 留空用已保存的" autocomplete="off">
          <button class="p-min" id="p-key-eye" title="显示 / 隐藏">显</button>
        </div>

        <div class="p-sec-title">环境</div>
        <div class="p-env">
          <div class="p-env-row"><span>本地服务 8787</span><b id="p-env-srv">检测中</b></div>
          <div class="p-env-row"><span>CDP 9222</span><b id="p-env-cdp">检测中</b></div>
          <div class="p-env-row"><span>转写引擎</span><b id="p-env-stt">检测中</b></div>
          <div class="p-env-row"><span>挂机模块</span><b id="p-env-farm">检测中</b></div>
          <div class="p-hint" id="p-env-tip">首次使用先装 <code>faster-whisper</code>，再启动 <code>serve.cmd</code></div>
        </div>
      </div>
      <div class="p-log" id="p-log"></div>
      <div class="p-foot">alt+P 开关 · 拖标题栏移动 · 不阻断页面操作</div>
    </div>
    <div id="potato-ball" class="p-ui stop" title="土豆刷课台"><span>🥔</span><i class="p-dot"></i></div>
  `;
  document.body.appendChild(host);

  const $ = s => root.querySelector(s);
  const panel = $('#potato-panel'), ball = $('#potato-ball'), head = $('#p-head');
  let open = false, logId = 0, dragMoved = false;

  // ---- 位置：默认贴右下；拖过就记 left/top，存 localStorage ----
  let pos = null;
  try { pos = JSON.parse(localStorage.getItem('potato-ui-pos') || 'null'); } catch (e) { pos = null; }

  function applyPos() {
    if (!pos) {
      host.style.left = ''; host.style.top = '';
      host.style.right = '16px'; host.style.bottom = '88px';
      return;
    }
    const r = host.getBoundingClientRect();
    const maxX = Math.max(4, window.innerWidth - r.width - 4);
    const maxY = Math.max(4, window.innerHeight - r.height - 4);
    pos.x = Math.min(Math.max(4, pos.x), maxX);
    pos.y = Math.min(Math.max(4, pos.y), maxY);
    host.style.left = pos.x + 'px';
    host.style.top = pos.y + 'px';
    host.style.right = 'auto';
    host.style.bottom = 'auto';
  }

  function setOpen(v) {
    open = v;
    panel.classList.toggle('show', v);
    requestAnimationFrame(applyPos);
    if (v) {
      if (window.__potatoEnvCheck) window.__potatoEnvCheck();
      tick();
    }
  }

  // ---- 拖动：标题栏和土豆球都能拖，pointer 事件 + 视口内收边 ----
  function bindDrag(handle) {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      if (e.target.closest('button, input, textarea, label, select, a')) return;
      const r = host.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY, ol = r.left, ot = r.top;
      let moved = false;
      dragMoved = false;
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      host.classList.add('p-dragging');
      const onMove = ev => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        moved = true; dragMoved = true;
        pos = { x: ol + dx, y: ot + dy };
        applyPos();
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        host.classList.remove('p-dragging');
        try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
        if (pos) { try { localStorage.setItem('potato-ui-pos', JSON.stringify(pos)); } catch (err) {} }
        setTimeout(() => { dragMoved = false; }, 80);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  }
  bindDrag(ball);
  bindDrag(head);

  ball.addEventListener('click', () => {
    if (dragMoved) return;
    setOpen(!open);
  });
  $('#p-min').addEventListener('click', e => { e.stopPropagation(); setOpen(false); });
  // 眼睛：明文/掩码切换，默认掩码
  $('#p-key-eye').addEventListener('click', e => {
    e.stopPropagation();
    const box = $('#p-key');
    box.type = box.type === 'password' ? 'text' : 'password';
    if (box.type === 'text') box.focus();
  });
  // 双击标题栏回到右下角默认位
  head.addEventListener('dblclick', () => {
    pos = null;
    try { localStorage.removeItem('potato-ui-pos'); } catch (e) {}
    applyPos();
  });

  applyPos();
  window.addEventListener('resize', () => requestAnimationFrame(applyPos));

  async function api(path, opts) {
    try {
      const r = await fetch(API + path, Object.assign({ cache: 'no-store' }, opts || {}));
      return await r.json();
    } catch (e) { return null; }
  }

  async function post(body) {
    return api('/api/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  const STATE_TEXT = { running: '运行中', paused: '已暂停', stopped: '停止' };

  let curMax = 8;

  function render(st) {
    if (!st) { $('#p-state').textContent = '断线'; $('#p-tip').textContent = '连不上本地服务 8787'; return; }
    const s = st.state || 'stopped';
    const running = st.runner === true;
    let label = STATE_TEXT[s] || s;
    if (s === 'running' && st.runner === false) label = '进程丢了';
    $('#p-state').textContent = label;
    ball.className = 'p-ui ' + s;
    $('#p-sec').textContent = st.section || '-';
    $('#p-screen').textContent = (st.screen || '-').slice(0, 14);
    $('#p-go').disabled = s === 'running';
    $('#p-pause').disabled = s !== 'running';

    // 进度条
    const done = Number(st.section || 0);
    const pct = curMax > 0 ? Math.min(100, Math.round(done / curMax * 100)) : 0;
    $('#p-bar').style.width = (s === 'running' ? Math.max(pct, 3) : pct) + '%';

    // 提示文案
    let tip = '就绪';
    if (s === 'running') tip = '正在跑：' + (st.screen || '-') + '　成功 ' + (st.ok || 0) + ' / 失败 ' + (st.fail || 0);
    else if (s === 'paused') tip = '已暂停，点击开始继续';
    else if (s === 'stopped') tip = (running ? '已停止' : '未启动·点开始会拉起 node 进程') + '　成功 ' + (st.ok || 0) + ' / 失败 ' + (st.fail || 0);
    if (!st.cdp) tip = '⚠ CDP 未连接（9222）';
    else if (!st.srv) tip = '⚠ 本地服务未连接（8787）';
    $('#p-tip').textContent = tip;

    // 只回填一次，避免打断输入
    if (!window.__potatoFilled && st.settings) {
      window.__potatoFilled = true;
      const g = st.settings;
      if (g.maxSec) { $('#p-max').value = g.maxSec; curMax = g.maxSec; }
      if (g.delay) $('#p-delay').value = g.delay;
      if (g.rate) $('#p-rate').value = g.rate;
      if (g.fillerText) $('#p-filler').value = g.fillerText;
      if (g.commentText) $('#p-comment').value = g.commentText;
      if (g.maxFail) $('#p-maxfail').value = g.maxFail;
      if (g.pauseEvery !== undefined) $('#p-pause-every').value = g.pauseEvery;
      if (g.hasKey) $('#p-key').placeholder = '已保存（留空不改）';
    }
  }

  function pushLog(lines) {
    if (!lines || !lines.length) return;
    const box = $('#p-log');
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    lines.forEach(l => {
      const d = document.createElement('div');
      d.className = l.cls || '';
      d.textContent = l.text || '';
      box.appendChild(d);
    });
    while (box.childNodes.length > 120) box.removeChild(box.firstChild);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  async function tick() {
    if (!open) return;
    render(await api('/api/state'));
    const lg = await api('/api/log?after=' + logId);
    if (lg && lg.lines && lg.lines.length) {
      pushLog(lg.lines);
      logId = lg.next || logId;
    }
  }

  async function postRun(body) {
    try {
      const r = await fetch(API + '/api/run', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      });
      return await r.json();
    } catch (e) { return null; }
  }

  function logLine(text, cls) {
    const box = $('#p-log');
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = '[' + new Date().toLocaleTimeString() + '] ' + text;
    box.appendChild(d);
    while (box.childNodes.length > 120) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  $('#p-go').onclick = async () => {
    curMax = Number($('#p-max').value) || 8;
    const r = await postRun({
      action: 'start',
      maxSec: curMax,
      delay: Number($('#p-delay').value) || 900,
      rate: Number($('#p-rate').value) || 4,
      guess: $('#p-guess').checked,
      fillerText: $('#p-filler').value || 'I think this unit is interesting and useful.',
      commentText: $('#p-comment').value || 'I think this unit is interesting and useful.',
      maxFail: Number($('#p-maxfail').value) || 5,
      pauseEvery: Number($('#p-pause-every').value) || 0,
      apiKey: $('#p-key').value.trim()
    });
    if (r && r.ok) logLine(r.already ? '已经在跑（pid ' + r.pid + '）' : '已启动跑课进程 pid ' + r.pid + ' · 跑 ' + curMax + ' 节');
    else logLine('启动失败：' + ((r && r.err) || '连不上本地服务 8787'), 'err');
    // 提交后立刻清掉输入框里的明文，并还原成掩码
    const keyBox = $('#p-key');
    if (keyBox.value) { keyBox.value = ''; keyBox.placeholder = '已保存（留空不改）'; }
    keyBox.type = 'password';
    tick();
  };
  $('#p-pause').onclick = async () => { await post({ action: 'pause' }); logLine('已暂停'); tick(); };
  $('#p-stop').onclick = async () => {
    const r = await postRun({ action: 'stop' });
    logLine('已停止' + (r && r.pid ? '（pid ' + r.pid + '）' : ''));
    tick();
  };

  // ---- 刷时长开关 ----
  function ensureFarm() {
    return window.__potatoFarm || null;
  }

  $('#p-farm').onchange = async (e) => {
    const on = e.target.checked;
    if (on) {
      if (!ensureFarm()) {
        $('#p-farm-stat').textContent = '挂机脚本没加载，请确认油猴里装了 potato-farm';
        e.target.checked = false;
        return;
      }
      $('#p-farm-stat').textContent = '正在跳到评论页…';
      const r = await window.__potatoFarm.start({ jump: true });
      $('#p-farm-stat').textContent = r && r.already ? '已在挂机' : '挂机中…（visibility 已锁）';
    } else {
      if (ensureFarm()) window.__potatoFarm.stop();
      $('#p-farm-stat').textContent = '已停止';
    }
  };

  // 挂机状态跟着 tick 刷新
  const _oldRender = render;
  render = function (st) {
    _oldRender(st);
    const f = ensureFarm();
    if (!f) return;
    if (f.running) {
      const s2 = f.stats;
      $('#p-farm-stat').textContent = '挂机中 ' + s2.minutes + ' 分钟 · 滚动 ' + s2.scrolls + ' 次 · 弹窗 ' + s2.dialogs + ' 次 · ' + s2.visibility;
      if (!$('#p-farm').checked) $('#p-farm').checked = true;
    }
  };

  // ---- 环境体检 ----
  async function envCheck() {
    const set = (id, ok, txt) => {
      const el = $('#' + id);
      el.textContent = txt || (ok ? '正常' : '未连接');
      el.className = ok === true ? 'p-ok' : ok === 'warn' ? 'p-warn' : 'p-bad';
    };
    // 本地服务
    let srv = null;
    try { srv = await (await fetch(API + '/api/state', { cache: 'no-store' })).json(); } catch (e) {}
    set('p-env-srv', !!srv, srv ? '正常' : '未连接');
    // CDP（由后端代查）
    set('p-env-cdp', srv ? !!srv.cdp : 'bad', srv ? (srv.cdp ? '正常' : '未连接') : '未知');
    // 转写引擎
    set('p-env-stt', srv ? (srv.stt === true ? true : 'warn') : 'bad', srv ? (srv.stt ? '已加载' : '待首次调用') : '未知');
    // 挂机模块
    const farm = !!window.__potatoFarm;
    set('p-env-farm', farm, farm ? '已加载' : '未安装');

    // 提示语
    let tip = '环境正常，可以开跑';
    if (!srv) tip = '本地服务没起来：回到项目文件夹双击 serve.cmd';
    else if (!srv.cdp) tip = 'CDP 没连上：用 start-chrome.cmd 开调试版浏览器';
    else if (!farm) tip = '挂机模块没装：再装一个 potato-farm.user.js';
    else if (!srv.stt) tip = '转写引擎待命：第一次答题会自动下载模型（约 140MB）';
    $('#p-env-tip').innerHTML = tip.replace(/serve\.cmd|start-chrome\.cmd|potato-farm\.user\.js|faster-whisper/g, m => '<code>' + m + '</code>');
  }

  $('#p-env-srv').onclick = envCheck;
  setInterval(() => { if (open) envCheck(); }, 12000);
  window.__potatoEnvCheck = envCheck;

  setInterval(() => { if (open) tick(); }, 2200);

  // 默认收起，键盘 P 键开关，方便不点鼠标
  document.addEventListener('keydown', e => {
    if (e.altKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      setOpen(!open);
      if (open) tick();
    }
  }, true);
})();