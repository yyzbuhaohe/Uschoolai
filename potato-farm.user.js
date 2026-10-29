// ==UserScript==
// @name         U 校园 · 土豆挂机
// @namespace    local.unipus.farm
// @version      1.0.0
// @description  停在阅读/评论页刷时长：锁 visibility、模拟滚动与鼠标、自动关超时弹窗
// @match        *://ucontent.unipus.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (window.__POTATO_FARM__) return;
  window.__POTATO_FARM__ = true;

  const CFG = {
    scrollMin: 18000,   // 两次滚动的间隔下限(ms)
    scrollMax: 42000,   // 上限
    stepMin: 90,        // 单次滚动像素下限
    stepMax: 260,
    mouseEvery: 21000,  // 鼠标微动间隔
    checkEvery: 5000    // 弹窗巡检间隔
  };

  let running = false;
  let timers = [];
  let lastDir = 1;
  let stats = { scrolls: 0, mouses: 0, dialogs: 0, startedAt: 0 };

  // ---- 0. 跳到评论题（有时长统计、又不打扰做题） ----
  function findDiscussionTab() {
    // 当前节的子 tab 里找 Discussion
    const tasks = Array.from(document.querySelectorAll('.pc-task'));
    const hit = tasks.find(t => /discussion|讨论/i.test(String(t.textContent || '')));
    return hit || null;
  }

  function findDiscussionSection() {
    const cont = document.querySelector('.pc-slier-menu-container');
    if (!cont) return null;
    const items = Array.from(cont.querySelectorAll('.pc-slider-menu-micro'));
    return items.find(m => /discussion|group discussion|讨论/i.test(String(m.textContent || '').trim())) || null;
  }

  async function jumpToDiscussion() {
    // 已经在评论页？
    const ta = document.querySelector('textarea[placeholder*="评论"], .discussion-cloud-bottom textarea, textarea.ant-input');
    if (ta && ta.offsetParent !== null) return { ok: true, where: 'already' };

    // 先试子 tab
    let tab = findDiscussionTab();
    if (tab) {
      const inner = tab.querySelector('.pc-tab-view-container') || tab;
      try { inner.click(); tab.click(); } catch (e) {}
      await new Promise(r => setTimeout(r, 2500));
      const ta2 = document.querySelector('textarea[placeholder*="评论"], .discussion-cloud-bottom textarea, textarea.ant-input');
      if (ta2 && ta2.offsetParent !== null) return { ok: true, where: 'subtab' };
    }

    // 再试目录里的讨论节
    const sec = findDiscussionSection();
    if (sec) {
      sec.scrollIntoView({ block: 'center' });
      await new Promise(r => setTimeout(r, 600));
      try { (sec.querySelector('.pc-menu-node-name') || sec).click(); sec.click(); } catch (e) {}
      await new Promise(r => setTimeout(r, 3000));
      const tab2 = findDiscussionTab();
      if (tab2) {
        const inner2 = tab2.querySelector('.pc-tab-view-container') || tab2;
        try { inner2.click(); tab2.click(); } catch (e) {}
        await new Promise(r => setTimeout(r, 2200));
      }
      const ta3 = document.querySelector('textarea[placeholder*="评论"], .discussion-cloud-bottom textarea, textarea.ant-input');
      if (ta3 && ta3.offsetParent !== null) return { ok: true, where: 'section' };
    }

    return { ok: false, where: 'not-found' };
  }
  // ---- 1. 锁死可见性，避免页面被判定切后台 ----
  function lockVisibility() {
    try {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      Object.defineProperty(document, 'webkitHidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'webkitVisibilityState', { configurable: true, get: () => 'visible' });
    } catch (e) {}
    document.addEventListener('visibilitychange', e => { e.stopImmediatePropagation(); }, true);
    document.addEventListener('webkitvisibilitychange', e => { e.stopImmediatePropagation(); }, true);
    window.addEventListener('blur', e => { e.stopImmediatePropagation(); }, true);
  }

  // ---- 2. 滚动：交替上下，步长随机，模拟真人来回翻 ----
  function findScroller() {
    const cands = ['.reply-wrap', '.layoutBody-container', '.question-common-abs-question-container', '#main-content'];
    for (const s of cands) {
      const el = document.querySelector(s);
      if (el && el.scrollHeight > el.clientHeight + 40) return el;
    }
    return document.scrollingElement || document.documentElement;
  }

  function doScroll() {
    if (!running) return;
    const el = findScroller();
    const step = CFG.stepMin + Math.random() * (CFG.stepMax - CFG.stepMin);
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    // 到顶/到底就换向，平时 30% 概率随机换向
    if (el.scrollTop <= 4) lastDir = 1;
    else if (el.scrollTop >= max - 4) lastDir = -1;
    else if (Math.random() < 0.3) lastDir = -lastDir;
    el.scrollTop = Math.max(0, Math.min(max, el.scrollTop + lastDir * step));
    // 真滚轮事件也补一发，让监听 wheel 的逻辑也收到
    const target = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2) || document.body;
    try {
      target.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaY: lastDir * step, deltaMode: 0
      }));
    } catch (e) {}
    stats.scrolls++;
    scheduleScroll();
  }

  function scheduleScroll() {
    const wait = CFG.scrollMin + Math.random() * (CFG.scrollMax - CFG.scrollMin);
    timers.push(setTimeout(doScroll, wait));
  }

  // ---- 3. 鼠标微动 ----
  function doMouse() {
    if (!running) return;
    const x = Math.round(window.innerWidth * (0.25 + Math.random() * 0.5));
    const y = Math.round(window.innerHeight * (0.25 + Math.random() * 0.5));
    const t = document.elementFromPoint(x, y) || document.body;
    ['mouseover', 'mouseenter', 'mousemove'].forEach(type => {
      try {
        t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
      } catch (e) {}
    });
    stats.mouses++;
    timers.push(setTimeout(doMouse, CFG.mouseEvery + Math.random() * 12000));
  }

  // ---- 4. 自动关「长时间未操作 / 会话超时」弹窗 ----
  const IDLE_WORDS = ['长时间未操作', '继续使用', '继续学习', '会话已结束', '超时', 'timeout', '是否继续'];
  const OK_WORDS = ['继续', '确定', '我知道', 'OK', '好的', '是'];

  function closeIdleDialog() {
    const IDLE = /长时间未操作|请点确定继续使用|会话已结束|连接已断开|是否继续/;
    const OK = /^(确定|继续|继续使用|我知道了|好的|确定继续使用|OK)$/;

    // 1) 常规 modal 容器
    const wraps = document.querySelectorAll('.ant-modal-wrap,.ant-modal-root,[role=dialog],.ant-modal,.el-dialog');
    for (const w of wraps) {
      if (w.offsetParent === null) continue;
      if (!IDLE.test(String(w.textContent || ''))) continue;
      let hit = null;
      w.querySelectorAll('button,a,.ant-btn,[role=button]').forEach(b => {
        if (hit || b.offsetParent === null) return;
        if (OK.test(String(b.textContent || '').replace(/\s+/g, ''))) hit = b;
      });
      if (hit) { hit.click(); stats.dialogs++; console.log('[土豆挂机] 关掉超时弹窗(modal)'); return true; }
    }

    // 2) 自定义弹窗：按文本找最小容器，点它的按钮
    const all = document.querySelectorAll('div,section');
    let best = null;
    for (const e of all) {
      if (e.offsetParent === null) continue;
      if (e.children.length > 8) continue;
      const t = String(e.textContent || '').replace(/\s+/g, ' ').trim();
      if (!IDLE.test(t)) continue;
      if (t.length > 160) continue;
      if (!best || t.length < String(best.textContent || '').length) best = e;
    }
    if (!best) return false;

    // 往上找一层再点，按钮可能不在最小容器里
    let scope = best;
    for (let up = 0; up < 3 && scope; up++) {
      let hit = null;
      scope.querySelectorAll('button,a,.ant-btn,[role=button],span,div').forEach(b => {
        if (hit || b.offsetParent === null) return;
        const bt = String(b.textContent || '').replace(/\s+/g, '');
        if (!OK.test(bt)) return;
        const r = b.getBoundingClientRect();
        if (r.width < 30 || r.height < 16) return;
        hit = b;
      });
      if (hit) {
        hit.click();
        stats.dialogs++;
        console.log('[土豆挂机] 关掉超时弹窗(custom)');
        return true;
      }
      scope = scope.parentElement;
    }

    // 3) 实在找不到按钮，直接按下键盘回车试试
    try {
      const ev2 = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true });
      document.dispatchEvent(ev2);
      stats.dialogs++;
      console.log('[土豆挂机] 回车关弹窗');
      return true;
    } catch (e) {}
    return false;
  }
  function watchDialog() {
    const mo = new MutationObserver(() => { closeIdleDialog(); });
    mo.observe(document.body, { childList: true, subtree: true });
    timers.push(setInterval(closeIdleDialog, CFG.checkEvery));
    timers.push({ mo });
  }

  // ---- 5. 保持 Socket.IO 心跳（掉线时补一个 ping） ----
  function hookSocket() {
    const Orig = window.WebSocket;
    if (!Orig || Orig.__potatoHooked) return;
    const socks = [];
    function Wrapped(url, protocols) {
      const ws = protocols ? new Orig(url, protocols) : new Orig(url);
      socks.push(ws);
      ws.addEventListener('close', () => {
        const i = socks.indexOf(ws);
        if (i >= 0) socks.splice(i, 1);
      });
      return ws;
    }
    Wrapped.prototype = Orig.prototype;
    Wrapped.__potatoHooked = true;
    window.WebSocket = Wrapped;
    window.__potatoSocks = socks;
    // 每 25 秒给活着的连接发一个 socket.io ping 帧
    timers.push(setInterval(() => {
      socks.forEach(ws => {
        try { if (ws.readyState === 1) ws.send('2'); } catch (e) {}
      });
    }, 25000));
  }

  // ---- 对外接口 ----
  async function start(opts) {
    if (running) return { ok: true, already: true };
    const was = running;
    running = true;
    const jump = !opts || opts.jump !== false;
    if (jump) {
      const r = await jumpToDiscussion();
      console.log('[土豆挂机] 跳评论页:', r);
      if (!r.ok) console.log('[土豆挂机] 没找到评论页，就在当前页挂');
    }
    stats = { scrolls: 0, mouses: 0, dialogs: 0, startedAt: Date.now() };
    lockVisibility();
    hookSocket();
    watchDialog();
    closeIdleDialog();
    scheduleScroll();
    timers.push(setTimeout(doMouse, 4000));
    console.log('[土豆挂机] 已启动');
    return { ok: true };
  }

  function stop() {
    running = false;
    timers.forEach(t => {
      try {
        if (typeof t === 'number') clearTimeout(t);
        else if (t && t.mo) t.mo.disconnect();
        else if (t) clearInterval(t);
      } catch (e) {}
    });
    timers = [];
    console.log('[土豆挂机] 已停止');
    return { ok: true };
  }

  window.__potatoFarm = {
    start, stop, jumpToDiscussion,
    get running() { return running; },
    get stats() {
      return Object.assign({}, stats, {
        minutes: stats.startedAt ? Math.round((Date.now() - stats.startedAt) / 60000) : 0,
        visibility: document.visibilityState
      });
    }
  };
})();
