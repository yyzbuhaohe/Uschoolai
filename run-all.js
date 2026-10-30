/* run-all.js —— 全自动跑完整本教材
   用法: node run-all.js [最大节数]
   依赖: cdp.js 的连接方式 + 本地 8787 服务
*/
const BASE = 'http://127.0.0.1:9222';
const SRV = 'http://127.0.0.1:8787';
// 不写死 Key：优先 control.json 里的 apiKey，其次环境变量 DEEPSEEK_API_KEY
let KEY = process.env.DEEPSEEK_API_KEY || '';
// solveBlank 见下方内联实现（原来在 内联函数）
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;                       // 放哪都能跑，不写死绝对路径
const STATE_PATH = path.join(ROOT, 'state.json');
const CTRL_PATH = path.join(ROOT, 'control.json');
let STATE = { state: 'running', section: '-', screen: '-', ok: 0, fail: 0, page: '' };
const saveState = () => { try { fs.writeFileSync(STATE_PATH, JSON.stringify(STATE), 'utf8'); } catch (e) {} };
// 兼容被记事本 / PowerShell 存成「带 BOM 的 UTF-8」
const readCtrl = () => {
  try { return JSON.parse(fs.readFileSync(CTRL_PATH, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { return { state: 'running' }; }
};
async function guard() {
  for (;;) {
    const c = readCtrl();
    if (c.state === 'stop') { log('!! 外部停止'); saveState(); process.exit(0); }
    if (c.state !== 'paused') return c;
    STATE.state = 'paused'; saveState();
    await sleep(1500);
  }
}
const LOG = path.join(ROOT, 'run-all.log');
const log = (m) => { const s = '[' + new Date().toLocaleTimeString() + '] ' + m; console.log(s); try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function page(){const ts=await (await fetch(BASE+'/json/list')).json();const ps=ts.filter(t=>t.type==='page'&&t.webSocketDebuggerUrl);return ps.find(p=>/ucontent/.test(p.url))||ps[0];}
function connect(u){return new Promise((res,rej)=>{const ws=new WebSocket(u);let seq=0;const w=new Map();ws.onmessage=e=>{let m;try{m=JSON.parse(e.data);}catch(x){return;}if(m.id&&w.has(m.id)){const h=w.get(m.id);w.delete(m.id);m.error?h.rej(new Error(JSON.stringify(m.error))):h.res(m.result);}};ws.onopen=()=>res({call:(mm,pp)=>new Promise((a,b)=>{const id=++seq;w.set(id,{res:a,rej:b});ws.send(JSON.stringify({id,method:mm,params:pp||{}}));}),close:()=>{try{ws.close();}catch(x){}}});ws.onerror=()=>rej(new Error('ws'));});}
// ---- 用量统计 ----
const USAGE_PATH = path.join(ROOT, 'usage.json');
let USAGE = { calls: 0, in: 0, out: 0 };
try {
  const u0 = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8').replace(/^\uFEFF/, ''));
  USAGE = { calls: +u0.calls || 0, in: +u0.in || 0, out: +u0.out || 0 };
} catch (e) {}
let usageDirty = false;
function flushUsage() {
  if (!usageDirty) return;
  usageDirty = false;
  try { fs.writeFileSync(USAGE_PATH, JSON.stringify(USAGE, null, 2), 'utf8'); } catch (e) {}
}
setInterval(flushUsage, 5000);
process.on('exit', flushUsage);

async function ask(p, s) {
  const r = await fetch('https://api.deepseek.com/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, body: JSON.stringify({ model: 'deepseek-chat', temperature: 0, messages: [{ role: 'system', content: s }, { role: 'user', content: p }] }) });
  const j = await r.json();
  if (j.usage) {
    USAGE.calls += 1;
    USAGE.in += +j.usage.prompt_tokens || 0;
    USAGE.out += +j.usage.completion_tokens || 0;
    usageDirty = true;
  }
  return ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
}

// ---- 启动自检：新人最常见的三件事（Node 太旧 / 浏览器没开调试端口 / 服务没起）在这里一次说清，
// 别让它跑到 Runtime.evaluate 才崩，崩了还只写进 logs/runner.out，控制台一个字都看不到。 ----
async function preflight() {
  const fatal = [];
  if (typeof fetch !== 'function') fatal.push('这个 Node 没有全局 fetch，需要 Node 18 以上');
  if (typeof WebSocket !== 'function') fatal.push('这个 Node 没有全局 WebSocket，必须 22 以上（当前 ' + process.version + '）—— 跑 doctor.cmd 看怎么修');
  if (fatal.length) { fatal.forEach(m => log('!! ' + m)); return 2; }

  // 1) 调试浏览器
  let tabs = null;
  try {
    const r = await fetch(BASE + '/json/list', { signal: AbortSignal.timeout(5000) });
    tabs = await r.json();
    log('CDP 已连上：' + tabs.filter(t => t.type === 'page').length + ' 个标签页');
  } catch (e) {
    log('!! 连不上调试浏览器 127.0.0.1:9222 —— 先双击 start-chrome.cmd（用 Edge 就 open-edge-debug.cmd），');
    log('   在那个新窗口里登录 U 校园，再回到控制台点开始。');
    return 2;
  }
  const cur = (tabs || []).filter(t => t.type === 'page' && /unipus/.test(t.url));
  if (!cur.length) {
    log('!! 调试浏览器里没有 U 校园页面');
    (tabs || []).filter(t => t.type === 'page').slice(0, 5).forEach(t => log('   现在开着：' + String(t.url).slice(0, 90)));
    log('   请在这个窗口打开课程内容页（停在要刷的那一节），再点开始。');
    return 2;
  }

  // 2) 本地服务 / 转写 / 模型
  try {
    const r = await fetch(SRV + '/api/state', { signal: AbortSignal.timeout(5000) });
    const st = await r.json();
    log('本地服务 8787 正常（Python ' + (st.py || '?') + '）');
    if (st.fw === false) log('!! 这台 Python 里没有 faster-whisper：转写全废 → 排序/跟读/说话/配音都会失败。跑 doctor.cmd 看修法');
    if (st.model === 'none') log('!! 没找到语音模型 models/whisper-base.en：首次转写会联网下 140MB，网络不稳就先放 model zip');
    if (st.paused) log('   当前是暂停状态，面板点「继续」才动');
  } catch (e) {
    log('   [warn] 本地服务 8787 连不上：不影响单选/填空，但转写相关的题型（排序/跟读/说话/配音）会失败');
    log('          修法：双击 serve.cmd，窗口留着别关');
  }
  return 0;
}

(async () => {
  const maxSec = Number(process.argv[2] || 3);
  // --here：只跑当前这一屏，不遍历整节的 tab/task（调试和快速验证用）
  const HERE_ONLY = process.argv.includes('--here');
  // POTATO_NO_SUBMIT=1：填完不提交，调试题型时用（改错题/口语题只记第一次作答，误提交就补不回来）
  const NO_SUBMIT = process.env.POTATO_NO_SUBMIT === '1';
  const _c0 = readCtrl();   // 统一走带 BOM 兼容的读取
  const FILLER_TEXT = _c0.fillerText || 'I think this unit is interesting and useful.';
  const COMMENT_TEXT = _c0.commentText || 'I think this unit is interesting and useful.';
  const MAX_FAIL = Number(_c0.maxFail || 5);
  const PAUSE_EVERY = Number(_c0.pauseEvery || 0);
  // Key 可能是加密的（apiKeyEnc），也可能是旧版明文（apiKey）或环境变量
  let cfgKey = '';
  if (_c0.apiKeyEnc) {
    try { cfgKey = require('./keyvault').decrypt(_c0.apiKeyEnc); } catch (e) { cfgKey = ''; }
    if (!cfgKey) log('!! apiKeyEnc 解不开（换过电脑？），请在面板里重填一次 key');
  }
  if (!cfgKey && _c0.apiKey) cfgKey = String(_c0.apiKey);
  if (cfgKey) KEY = cfgKey;
  if (!KEY) {
    log('!! 没配 DeepSeek API Key —— 获取方法见 docs/API-KEY.md，填到土豆面板的「模型」框，或写进 control.json 的 apiKey');
    process.exit(1);
  }
  if (await preflight()) process.exit(2);
  const c = await connect((await page()).webSocketDebuggerUrl);
  const ev = async e => { const r = await c.call('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r && r.exceptionDetails) return 'EXC'; return r && r.result ? r.result.value : undefined; };
  const unblock = async () => {
    const blocked = await ev("(function(){var e=document.elementFromPoint(700,400);return !!(e&&/ant-modal-wrap/.test(String(e.className||'')))})()");
    if (blocked) {
      // 正常确认框（带确定/取消）不能摘，交给 submit 去点
      const dirty = await ev("(function(){var w=document.querySelector('.ant-modal-wrap');if(!w)return 1;var t=String(w.textContent||'');return /确定|确认|保存/.test(t)?0:1})()");
      if (!dirty) return;
      const d = await ev("(function(){var w=document.querySelector('.ant-modal-wrap');if(!w)return 'no';var b=null;w.querySelectorAll('button,a,.ant-btn').forEach(function(x){if(x.offsetParent===null)return;var t=String(x.textContent||'').replace(/\\s+/g,'');if(t!=='我知道了'&&t!=='确定'&&t!=='取消')return;b={x:Math.round(x.getBoundingClientRect().left+x.getBoundingClientRect().width/2),y:Math.round(x.getBoundingClientRect().top+x.getBoundingClientRect().height/2)};});return b?JSON.stringify(b):'none'})()");
      if (d && d !== 'no' && d !== 'none') { const b = JSON.parse(d); await rawClick(b.x, b.y); await sleep(700); }
      // 僵尸遮罩：点了「我知道了」也不走，卡在 ant-fade-leave，DOM 里还在、还能吃点击
      const left = await ev("(function(){return document.querySelectorAll('.ant-modal-wrap').length})()");
      if (left) {
        log('    摘掉卡住的遮罩 x' + left);
        await ev("(function(){document.querySelectorAll('.ant-modal-wrap').forEach(function(w){w.remove()});document.querySelectorAll('.ant-modal-mask').forEach(function(m){m.remove()});document.body.style.overflow='';document.documentElement.style.overflow='';return 1})()");
        await sleep(250);
      }
    }
  };

// 听力填空：题干里用 __BLANK__ 标出空位，拿空前后的词去原文里定位，中间那段就是答案。
// （原来单独放在 内联函数，为了少一个文件内联进来）
function solveBlank(stmt, passage) {
  if (!stmt || !passage) return null;
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9']+/g, ' ').replace(/\s+/g, ' ').trim();
  const P = norm(passage).split(' ').filter(Boolean);
  const parts = String(stmt).split('__BLANK__');
  if (parts.length !== 2) return null;
  const before = norm(parts[0]).split(' ').filter(Boolean).slice(-6);
  const after = norm(parts[1]).split(' ').filter(Boolean).slice(0, 6);
  if (!before.length && !after.length) return null;

  let bestI = -1, bestScore = -1;
  for (let i = 0; i < P.length; i++) {
    let hit = 0;
    for (let k = 0; k < before.length; k++) {
      const idx = i - before.length + k;
      if (idx >= 0 && P[idx] === before[k]) hit++;
    }
    let hit2 = 0;
    for (let k = 0; k < after.length; k++) {
      const idx = i + k;
      if (idx < P.length && P[idx] === after[k]) hit2++;
    }
    const sc = hit + hit2;
    if (sc > bestScore) { bestScore = sc; bestI = i; }
  }
  if (bestI < 0 || bestScore < 2) return null;

  let end = -1;
  if (after.length) {
    for (let i = bestI; i < Math.min(P.length, bestI + 8); i++) {
      if (P[i] === after[0]) { end = i; break; }
    }
  }
  if (end <= bestI) end = Math.min(P.length, bestI + 3);
  const ans = P.slice(bestI, end).join(' ').trim();
  return ans || null;
}

  const rawClick = async (x, y) => {
    await c.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(60);
    await c.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(50);
    await c.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  };
  const click = async (x, y) => {
    await unblock();
    // 土豆面板可能盖住点击目标，点的一瞬间让它穿透
    const hadPanel = await ev("(function(){var h=document.getElementById('potato-root');if(!h)return 0;h.classList.add('p-pass');return 1})()");
    await rawClick(x, y);
    if (hadPanel) await ev("(function(){var h=document.getElementById('potato-root');if(h)h.classList.remove('p-pass');return 1})()");
  };
  const type = t => c.call('Input.insertText', { text: t });
  const btn = async ws => { const v = await ev("(function(){var ws=" + JSON.stringify(ws) + ";var h=null;document.querySelectorAll('a,button,.ant-btn,div[role=button]').forEach(function(b){if(b.offsetParent===null)return;var t=String(b.textContent||'').replace(/\\s+/g,'');if(ws.indexOf(t)<0)return;var r=b.getBoundingClientRect();if(r.width<4)return;h={el:b,t:t}});if(h&&h.el){h.el.scrollIntoView({block:'center'});var rr=h.el.getBoundingClientRect();h={x:Math.round(rr.left+rr.width/2),y:Math.round(rr.top+rr.height/2),t:h.t}}return JSON.stringify(h)})()"); return v && v !== 'null' ? JSON.parse(v) : null; };
  const closeDlg = async () => { const d = await btn(['我知道了']); if (d) { await click(d.x, d.y); await sleep(800); return true; } return false; };
  const kind = async () => JSON.parse(await ev("JSON.stringify({ins:[].slice.call(document.querySelectorAll('.scoop-input-wrapper input,.comp-abs-input input,input.input-user-answer')).filter(function(e){return e.offsetParent!==null}).length,opt:document.querySelectorAll('.option').length,ta:[].slice.call(document.querySelectorAll('textarea')).filter(function(e){if(e.offsetParent===null)return false;var r=e.getBoundingClientRect();return r.width>60&&r.height>20}).length,dd:[].slice.call(document.querySelectorAll('.ant-dropdown-trigger.user-answer')).filter(function(e){if(e.offsetParent===null)return false;var r=e.getBoundingClientRect();if(r.width<10||r.height<4)return false;if(r.top<0||r.bottom>window.innerHeight)return false;var box=e.closest('.question-common-abs-reply,.question,.answers-list,.layoutBody-container');if(!box)return false;var br=box.getBoundingClientRect();return br.width>50&&br.height>20}).length,qa:[].slice.call(document.querySelectorAll('textarea')).filter(function(t){if(t.offsetParent===null)return false;if(t.closest('.scoop-input-wrapper'))return false;if(/评论/.test(t.placeholder||''))return false;if(t.closest('[class*=discussion]'))return false;var r=t.getBoundingClientRect();return r.width>60&&r.height>20}).length,cmt:[].slice.call(document.querySelectorAll('textarea')).filter(function(t){if(t.offsetParent===null)return false;if(t.closest('.scoop-input-wrapper'))return false;var r=t.getBoundingClientRect();if(r.width<60||r.height<20)return false;return /评论/.test(t.placeholder||'')||!!t.closest('[class*=discussion]')}).length,up:(document.querySelector('.question-multi-file-upload')?1:0),sort:document.querySelectorAll('[class*=sequence-reply-view-item]').length,img:[].slice.call(document.querySelectorAll('.option img,.option-placeholder img')).filter(function(e){var o=e.closest('.option,.option-placeholder');if(!o||o.offsetParent===null)return false;var r=o.getBoundingClientRect();return r.width>4&&r.height>4}).length,sent:[].slice.call(document.querySelectorAll('.sentence-container')).filter(function(s){return !!s.querySelector('audio')}).length,sentAll:document.querySelectorAll('.sentence-container').length,rec:document.querySelectorAll('.record-icon.button-record').length,rev:document.querySelectorAll('.question-revise-mistake').length})") || '{}');
  const waitKind = async (maxMs = 8000) => {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < maxMs) {
      const k = await kind();
      const key = JSON.stringify(k);
      // 只"两次一样"不够：填空题第二页刚切过来时，页面上只有 4 个空壳 .sentence-container，
      // ins/opt 全是 0，会被误判成跟读。所以要求「稳定 + 真的认得出东西」才返回。
      const actionable = k.ins > 0 || k.opt > 0 || k.sent > 0 || k.rec > 0 || k.ta > 0 || k.sort > 0 || k.dd > 0 || k.up > 0 || k.rev > 0;
      if (last === key && actionable) return k;
      last = key;
      await sleep(700);
    }
    return await kind();
  };
  const summary = async () => ev("(function(){var t=String(document.body.innerText||'');return t.indexOf('答题小结')>=0})()");
  const score = async () => ev("(function(){var t=String(document.body.innerText||'').replace(/\\s+/g,' ');var m=t.match(/(\\d+(\\.\\d+)?)\\s*分/);return m?m[1]:'?'})()");

  // ---- 各题型处理 ----
  // 按“第几题 + 字母”定位并点击，滚动到位，点完验证，失败重试
  const QS_JS = "var qs=[].slice.call(document.querySelectorAll('.question-common-abs-reply,.question-basic'))" +
    ".filter(function(q){if(q.querySelectorAll('.option').length<2)return false;" +
    "if(/^Directions/i.test(String(q.textContent||'').trim()))return false;return true})" +
    ".sort(function(a,b){return a.offsetTop-b.offsetTop});";

  const pickByIndex = async (qIdx, letter) => {
    // 1. 滚到该题
    const r0 = await ev("(function(){" + QS_JS + "var q=qs[" + qIdx + "];if(!q)return 'no-q';q.scrollIntoView({block:'center'});return 'ok'})()");
    if (r0 !== 'ok') return r0;
    await sleep(450);
    // 2. 点该题里 caption===letter 的那个（点前再重新取一次，防止渲染变化）
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await ev("(function(){" + QS_JS +
        "var q=qs[" + qIdx + "];if(!q)return 'no-q';" +
        "var hit=null;q.querySelectorAll('.option').forEach(function(o){var c=o.querySelector('.caption');if(c&&String(c.textContent||'').trim()==='" + letter + "')hit=o;});" +
        "if(!hit)return 'no-opt';" +
        "hit.scrollIntoView({block:'center'});" +
        "hit.click();" +
        "return /selected/.test(String(hit.className))?'ok':'miss'" +
      "})()");
      if (res === 'ok') return 'ok';
      if (res === 'no-q' || res === 'no-opt') return res;
      await sleep(400);
    }
    return 'fail';
  };
  // 提交前自检：把没选的题补上（用模型给的答案）
  const selfCheck = async (wantMap) => {
    const miss = JSON.parse(await ev("(function(){" +
      "var qs=[].slice.call(document.querySelectorAll('.question-common-abs-reply,.question-basic'));" +
      "var o=[];" +
      "qs.forEach(function(q,i){if(!q.querySelector('.option'))return;if(q.querySelector('.option.selected'))return;o.push(i)});" +
      "return JSON.stringify(o)" +
    "})()") || '[]');
    if (!miss.length) return 0;
    log('    自检：第 ' + miss.map(i => i + 1).join(',') + ' 题未选，补答');
    let fixed = 0;
    for (const i of miss) {
      const letter = (wantMap && wantMap[i]) || 'A';
      const r = await pickByIndex(i, letter);
      if (r === 'ok') fixed++;
      log('      第' + (i + 1) + '题 → ' + letter + ' ' + r);
    }
    return fixed;
  };
  async function doVideo() {
    const v = await ev("(function(){var v=document.querySelector('video');if(!v)return 'null';return JSON.stringify({dur:v.duration||0,cur:v.currentTime||0,ended:v.ended})})()");
    if (!v || v === 'null') return false;
    const info = JSON.parse(v);
    log('    视频 ' + Math.round(info.dur) + 's 当前 ' + Math.round(info.cur) + 's');
    await ev("(function(){" +
      "var v=document.querySelector('video');if(!v)return 0;" +
      "v.muted=true;try{v.playbackRate=4}catch(e){}" +
      "try{v.currentTime=Math.max(0,(v.duration||0)-4)}catch(e){}" +
      "var p=v.play();if(p&&p.catch)p.catch(function(){});return 1" +
    "})()");
    for (let t = 0; t < 20; t++) {
      await sleep(1500);
      const st = await ev("(function(){var v=document.querySelector('video');if(!v)return 'null';return JSON.stringify({ended:v.ended,cur:Math.round(v.currentTime||0),dur:Math.round(v.duration||0)})})()");
      if (st === 'null') break;
      const o = JSON.parse(st);
      if (o.ended) { log('    视频播完 ' + o.dur + 's'); return true; }
    }
    log('    视频未播完（可能被拦），继续');
    return true;
  };
  // 等音视频就绪；15 秒拿不到就刷新重试
  const getMediaUrl = async () => ev("(function(){" +
    "var vs=[].slice.call(document.querySelectorAll('video,audio'));" +
    "for(var i=0;i<vs.length;i++){var u=vs[i].currentSrc||vs[i].src||'';if(u)return u}" +
    "var srcs=[];document.querySelectorAll('video source,audio source').forEach(function(s){var u=s.src||s.getAttribute('src')||'';if(u)srcs.push(u)});" +
    "return srcs[0]||''" +
  "})()");

  // 判定这屏是否计分：客观题元素 = 计分；纯主观 = 不计分
  const isScored = async (dirs) => {
    const m = JSON.parse(await ev("(function(){return JSON.stringify({" +
      "opt:document.querySelectorAll('.option').length," +
      "scoop:document.querySelectorAll('.scoop-input-wrapper').length," +
      "dd:[].slice.call(document.querySelectorAll('.ant-dropdown-trigger.user-answer')).filter(function(e){return e.offsetParent!==null}).length," +
      "sort:document.querySelectorAll('[class*=sequence-reply-view-item]').length," +
      "sent:document.querySelectorAll('.sentence-container').length," +
      "dub:document.querySelectorAll('.item .record-icon.button-record').length," +
      "rec:document.querySelectorAll('.record-icon.button-record').length," +
      "ta:[].slice.call(document.querySelectorAll('textarea')).filter(function(t){if(t.offsetParent===null)return false;if(t.closest('.scoop-input-wrapper'))return false;var r=t.getBoundingClientRect();return r.width>60&&r.height>20}).length" +
    "})})()") || '{}');
    if (m.opt > 0 || m.scoop > 0 || m.dd > 0 || m.sort > 0 || m.sent > 0 || m.dub > 0) return true;
    if (m.rec > 0 && m.ta === 0) return false;   // 纯说话，不计分
    if (m.ta > 0) {
      // 有文本框：看题目要求，听写类才计分
      return /dictat|write down what you hear|listen and (write|type)/i.test(String(dirs || ''));
    }
    return false;
  };

  const needsMedia = (dirs) => /listen|hear|watch|audio|video|podcast|conversation|passage|lecture/i.test(String(dirs || ''));

  async function waitMedia(maxMs = 15000) {
    const t0 = Date.now();
    let nudge = 0;
    for (;;) {
      const u = await getMediaUrl();
      if (u) return u;
      if (Date.now() - t0 >= maxMs) return null;
      // 每 3 秒推一下播放，催它加载
      if (nudge % 2 === 0) {
        await ev("(function(){var v=document.querySelector('video')||document.querySelector('audio');if(!v)return 0;try{v.muted=true;var p=v.play();if(p&&p.catch)p.catch(function(){})}catch(e){}return 1})()");
      }
      nudge++;
      await sleep(1500);
    }
  }

  // 跟读屏的录音组件一个页面只肯要一次麦克风：录完一句之后，别的句子点麦克风根本不会调
  // getUserMedia（实测第 2 句起 0 次调用；刷新页面立刻恢复）。所以每句之前刷一次页面。
  async function reloadForVoice() {
    await c.call('Page.reload', { ignoreCache: false });
    await sleep(5000);
    // 等到页面渲染出内容（pager 或任何一个题型元素出现）再返回，光 sleep 不够稳
    for (let t = 0; t < 12; t++) {
      const ready = await ev('(function(){return (document.querySelector(".question-common-course-page")||document.querySelector(".sentence-container")||document.querySelector(".scoop-input-wrapper")||document.querySelector(".option"))?1:0})()');
      if (Number(ready) === 1) break;
      await sleep(800);
    }
    await closeDlg();
    await sleep(800);
  }

  async function reloadAndWait() {
    log('    刷新页面重试…');
    await c.call('Page.reload', { ignoreCache: false });
    await sleep(9000);
    await closeDlg();
    await sleep(1200);
  }
  // ---- 配音题：把视频音轨按句切出来，回灌到麦克风 ----
  // 关键点：页面点录音时先要麦克风，拿到后还要在很短时间内听到声音，
  // 否则弹「录音启动超时」。所以劫持里一被调用就 resume 音频上下文并立刻开播。

  async function doSpeak() {
    // 说话题的判据只有"有录音按钮"太弱：填空页也常常带一个录音按钮（或骨架屏）。
    // 页面上有可见的填空/翻译输入框，就一定不是自由说话。
    const fillInputs = Number(await ev("(function(){return [].slice.call(document.querySelectorAll('.scoop-input-wrapper input,.comp-abs-input input,input.input-user-answer')).filter(function(e){return e.offsetParent!==null}).length})()"));
    if (fillInputs > 0) { log('    !! 这屏有 ' + fillInputs + ' 个填空输入框，不是说话题，交给 doFill'); await doFill({}); return; }
    const task = await ev("(function(){var t=String(document.body.innerText||'').replace(/\\s+/g,' ');var i=t.indexOf('Directions');var j=t.indexOf('提 交');return i>=0?t.slice(i,(j>i?j:i+700)):''})()");
    log('    说话题：' + String(task).slice(0, 60));
    const script = await ask('口语题：\n' + task + '\n\n写一段 90-110 词的英文口述稿，口语化、句子短、好朗读，只用纯英文，不要标题序号括注。', '只输出英文口述稿，一段话。');
    log('    口稿 ' + script.split(/\s+/).length + ' 词');
    const { execFileSync } = require('child_process');
    const smoke = path.join(ROOT, 'speak.wav');
    // 音色不能写死 Microsoft Zira Desktop：中文版 Windows 默认只带 Huihui，
    // 写死的话 SelectVoice 直接抛异常，说话题/跟读题全废（日志里只有一行「TTS 失败」）。
    const ps = [
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      '$vs = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })',
      '$pick = $vs | Where-Object { $_.Culture.Name -eq "en-US" -and $_.Name -match "Zira|Aria|Guy|Jenny" } | Select-Object -First 1',
      'if (-not $pick) { $pick = $vs | Where-Object { $_.Culture.Name -eq "en-US" } | Select-Object -First 1 }',
      'if (-not $pick) { $pick = $vs | Where-Object { $_.Culture.Name -like "en*" } | Select-Object -First 1 }',
      'if ($pick) { try { $s.SelectVoice($pick.Name) } catch {} }',
      '$s.Rate = 0',
      'if (Test-Path "' + smoke + '") { Remove-Item "' + smoke + '" -Force }',
      '$s.SetOutputToWaveFile("' + smoke + '")',
      '$s.Speak([IO.File]::ReadAllText("' + path.join(ROOT, 'tts-script.txt') + '"))',
      'Write-Output ("VOICE=" + $s.Voice.Name + "|" + $s.Voice.Culture.Name)',
      '$s.Dispose()'
    ].join('; ');
    try {
      require('fs').writeFileSync(path.join(ROOT, 'tts-script.txt'), script, 'utf8');
      const outv = String(execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 180000, encoding: 'utf8' }) || '');
      const mv = outv.match(/VOICE=([^\r\n|]+)\|([^\r\n]+)/);
      const sz = require('fs').statSync(smoke).size;
      log('    TTS ' + sz + ' 字节' + (mv ? '（音色 ' + mv[1] + ' / ' + mv[2] + '）' : ''));
      if (sz < 2000) { log('    !! 音频几乎为空，这题录进去也没声'); return; }
    } catch (e) {
      log('    TTS 失败 ' + e.message);
      log('    中文版 Windows 可能没装英文语音：设置 → 时间和语言 → 语言 → 添加语言 English (United States) → 勾「语音」');
      log('    或者用 Edge 的英文音色顶一下：装完 Voice 后重跑本屏');
      return;
    }
    await ev("(function(){" +
      "window.__dubUrl='http://127.0.0.1:8787/speak.wav';window.__dubSegs=[{start:0,end:999,score:1}];window.__dubIdx=0;window.__dubLog=[];" +
      "var md=navigator.mediaDevices;var orig=md.getUserMedia?md.getUserMedia.bind(md):null;" +
      "window.__dubBuf=null;window.__dubCtx=null;" +
      "md.getUserMedia=async function(c){" +
        "if(!c||!c.audio)return orig?orig(c):Promise.reject(new Error('no'));" +
        "var Ctx=window.AudioContext||window.webkitAudioContext;" +
        "if(!window.__dubCtx)window.__dubCtx=new Ctx();" +
        "var ctx=window.__dubCtx;var dst=ctx.createMediaStreamDestination();" +
        "try{" +
          "if(!window.__dubBuf){var r=await fetch(window.__dubUrl);var ab=await r.arrayBuffer();window.__dubBuf=await ctx.decodeAudioData(ab);window.__dubLog.push('dec '+window.__dubBuf.duration.toFixed(1));}" +
          "var src=ctx.createBufferSource();src.buffer=window.__dubBuf;src.connect(dst);" +
          "setTimeout(function(){try{src.start(0)}catch(e){}},700);" +
        "}catch(e){window.__dubLog.push('fail '+e.message)}" +
        "return dst.stream;" +
      "};return 'ok'" +
    "})()");
    const btn = await ev("(function(){var b=document.querySelector('.record-icon.button-record');if(!b)return 'null';var r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()");
    if (btn === 'null') { log('    没有录音按钮'); return; }
    const bpos = JSON.parse(btn);
    await ev("(function(){var b=document.querySelector('.record-icon.button-record');if(b)b.click()})()");
    await sleep(2500);
    const dur = await ev('(window.__dubBuf&&window.__dubBuf.duration)||45');
    log('    录音 ' + Math.round(dur) + 's');
    await sleep(Math.round((dur + 2) * 1000));
    await ev("(function(){var b=document.querySelector('.record-icon.button-record');if(b)b.click()})()");
    await sleep(4000);
    log('    说话完成');
  };
  async function doChoice(k) {
    const qs = JSON.parse(await ev("(function(){" +
      "var out=[];" +
      "document.querySelectorAll('.question-common-abs-reply,.question-basic').forEach(function(q){" +
        "var opts=q.querySelectorAll('.option');if(opts.length<2)return;" + "if(/^Directions/i.test(String(q.textContent||'').trim()))return;" +
        "var caps=[],texts=[];opts.forEach(function(o){var c=o.querySelector('.caption');var t=o.querySelector('.component-htmlview.content')||o.querySelector('.content');caps.push(c?String(c.textContent||'').trim():'');texts.push(t?String(t.textContent||'').replace(/\\s+/g,' ').trim():'')});" +
        "var clone=q.cloneNode(true);" +
        "[].slice.call(clone.querySelectorAll('.option')).forEach(function(o){o.remove()});" +
        "var pure=String(clone.textContent||'').replace(/\\s+/g,' ').trim();" +
        "out.push({stem:pure.slice(0,240),caps:caps,texts:texts,top:Math.round(q.offsetTop)})" +
      "});out.sort(function(a,b){return a.top-b.top});" +
      "return JSON.stringify(out)" +
    "})()") || '[]');
    if (!qs.length) { log('    没解析到题目'); return; }
    // caption 不重复且 >=3 个 → 一道多选题；有重复 → 多道单选
    const capList = qs.length === 1 ? qs[0].caps : [];
    const uniq = Array.from(new Set(capList));
    const isMulti = qs.length === 1 && capList.length >= 3 && uniq.length === capList.length;
    if (isMulti) {
      const vurl2 = await ev("(function(){var v=document.querySelector('video')||document.querySelector('audio');return v?(v.currentSrc||v.src||''):''})()");
      let psg = '';
      if (vurl2) {
        const st2 = await (await fetch(SRV + '/stt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: vurl2 }) })).json();
        if (st2.ok) psg = st2.text;
      }
      const opts2 = qs[0].caps.map((c, i) => c + ') ' + (qs[0].texts[i] || '')).join('\n');
      const raw2 = await ask('原文：\n' + psg + '\n\n这是一道多选题，请选出所有在原文中出现过的表达：\n' + opts2 + '\n\n只输出被选中的字母连在一起（如 ACD），不要空格、不要解释。', '只输出字母串。');
      const picks = String(raw2).toUpperCase().replace(/[^A-Z]/g, '')
        .split('').filter((c, i, a) => a.indexOf(c) === i)
        .filter(c => qs[0].caps.indexOf(c) >= 0);
      log('    多选题 → ' + picks.join(''));
      for (const c of picks) {
        const r = await pickByIndex(0, c);
        if (r !== 'ok') log('      ' + c + ' ' + r);
      }
      const done2 = await ev("(function(){return document.querySelectorAll('.option.selected').length})()");
      log('    选中 ' + done2 + '/' + qs[0].caps.length);
      return;
    }
    const hasTF = qs[0].texts && qs[0].texts.some(t => /^(True|False)[.\s]*$/i.test(t));
    const isTF = hasTF || (qs[0].caps.length > 0 && /^(True|False|T|F)$/i.test(qs[0].caps[0]));
    const dirs0 = await ev("(function(){var t=String(document.body.innerText||'').replace(/\\s+/g,' ');var i=t.indexOf('Directions');return i>=0?t.slice(i,i+180):''})()");
    let vurl = await waitMedia(15000);
    let passage = '';
    if (!vurl && needsMedia(dirs0)) {
      log('    !! 15 秒没拿到音视频，这题不作答');
      await reloadAndWait();
      return 'retry';
    }
    if (vurl) {
      const st = await (await fetch(SRV + '/stt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: vurl }) })).json();
      if (st.ok) { passage = st.text; log('    已转写 ' + passage.length + ' 字符'); }
      else { log('    !! 转写失败，这题不作答'); return 'retry'; }
    } else {
      log('    非听力题（无音视频要求），按题干作答');
    }
    const listing = qs.map((q, i) => {
      const opts = q.caps.map((c, j) => '   ' + c + '. ' + (q.texts[j] || '')).join('\n');
      return (i + 1) + '. ' + q.stem + '\n' + opts;
    }).join('\n\n');
    let answers = [];
    if (isTF) {
      const raw = await ask('原文：\n' + passage + '\n\n判断题：\n' + listing + '\n\n只输出 ' + qs.length + ' 个 T/F。', '只输出 T/F。');
      const L = String(raw).toUpperCase().replace(/[^TF]/g, '');
      answers = qs.map((q, i) => {
        const wantTrue = (L[i] || 'T') === 'T';
        const re = wantTrue ? /^True/i : /^False/i;
        const idx = (q.texts || []).findIndex(t => re.test(t));
        if (idx >= 0 && q.caps[idx]) return q.caps[idx];
        return wantTrue ? q.caps[0] : (q.caps[1] || q.caps[0]);
      });
    } else {
      // 结构化作答：每题先抄「依据原句」再选字母，避免模型空口挑
      const prompt = '听力原文：\n' + passage + '\n\n题目与选项：\n' + listing +
        '\n\n共 ' + qs.length + ' 题，单选。做法：每题先在原文里找出最能决定答案的那一句，原样抄下来（不超过 15 个词；原文里没有依据就写 NONE），再据此选一个字母。\n' +
        '严格按这个格式输出，每题一行，除这三段外不要任何文字：\n序号|答案|依据\n1|A|I have been travelling to some of the remotest places.';
      const raw = await ask(prompt, '只输出「序号|答案|依据」格式的行。');
      const picked = new Map();
      String(raw).split('\n').forEach(line => {
        const m = line.match(/(\d+)\s*[|｜:.]\s*([A-Za-z])\b\s*[|｜]?\s*(.*)$/);
        if (m) {
          const idx = Number(m[1]);
          if (idx >= 1 && idx <= qs.length && !picked.has(idx)) picked.set(idx, { a: m[2].toUpperCase(), ev: String(m[3] || '').trim() });
        }
      });
      answers = qs.map((q, i) => {
        const hit = picked.get(i + 1);
        return (hit && q.caps.indexOf(hit.a) >= 0) ? hit.a : '';
      });
      // 结构化没解全，退回老的字母抽取
      if (answers.filter(Boolean).length < qs.length) {
        const L = String(raw).toUpperCase().replace(/[^A-Z]/g, '');
        answers = qs.map((q, i) => { const want = answers[i] || L[i]; return (want && q.caps.indexOf(want) >= 0) ? want : q.caps[0]; });
      }
      const evs = qs.map((q, i) => { const h = picked.get(i + 1); return h && h.ev ? h.ev.slice(0, 22) : '-'; });
      log('    依据 ' + evs.join(' | ').slice(0, 120));
    }
    log('    ' + qs.length + ' 题 → ' + answers.join(''));
    for (let i = 0; i < qs.length; i++) {
      const r = await pickByIndex(i, answers[i]);
      if (r !== 'ok') {
        await sleep(500);
        const r2 = await pickByIndex(i, answers[i]);
        log('      第' + (i + 1) + '题 ' + answers[i] + ' → ' + r2);
      }
    }
    await selfCheck(answers);
    const done = await ev("(function(){return JSON.stringify({sel:document.querySelectorAll('.option.selected').length,qs:document.querySelectorAll('.question-common-abs-reply,.question-basic').length})})()");
    log('    选中 ' + done);
  }
  async function doFill(k) {
    // 空的容器：优先 .scoop-input-wrapper；整屏没有（新版页面用 .comp-abs-input）才退回
    const stmts = JSON.parse(await ev('(function(){' +
      'var SEL=".scoop-input-wrapper";' +
      'var all=[].slice.call(document.querySelectorAll(SEL));' +
      'if(!all.length){SEL=".comp-abs-input";all=[].slice.call(document.querySelectorAll(SEL))}' +
      'var o=[];' +
      'all.forEach(function(w){' +
        'var box=w.closest("p")||w.parentElement;if(!box)return;' +
        'var c=box.cloneNode(true);' +
        'var ws=[].slice.call(c.querySelectorAll(SEL));if(!ws.length)return;' +
        'var orig=[].slice.call(box.querySelectorAll(SEL));' +
        'var idx=orig.indexOf(w);if(idx<0)idx=0;' +
        'ws[idx].replaceWith(document.createTextNode(" __BLANK__ "));' +
        'for(var i=0;i<ws.length;i++){if(i!==idx&&ws[i].parentNode)ws[i].parentNode.removeChild(ws[i])}' +
        'o.push(String(c.textContent||"").replace(/\\s+/g," ").trim())' +
      '});' +
      'return JSON.stringify(o)' +
    '})()') || '[]');
    if (!stmts.length) { log('    没解析到空'); return; }

    const dirs = await ev("(function(){var t=String(document.body.innerText||'').replace(/\\s+/g,' ');var i=t.indexOf('Directions');return i>=0?t.slice(i,i+200):''})()");
    const isListening = needsMedia(dirs);
    let answers = stmts.map(() => null);
    let passage = '';

    if (isListening) {
      const vurl = await waitMedia(15000);
      if (!vurl) {
        log('    !! 15 秒没拿到音视频，这题不作答');
        await reloadAndWait();
        return 'retry';
      }
      const st = await (await fetch(SRV + '/stt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: vurl }) })).json();
      if (!st.ok) { log('    !! 转写失败，这题不作答'); return 'retry'; }
      passage = st.text;
      log('    已转写 ' + passage.length + ' 字符');
      answers = stmts.map(s2 => solveBlank(s2, passage));
      log('    听力填空 ' + stmts.length + ' 空，原文对齐 ' + answers.filter(Boolean).length);
    } else {
      log('    非听力填空（翻译等），直接让模型作答 ' + stmts.length + ' 空');
    }

    if (answers.filter(Boolean).length < stmts.length) {
      const need = stmts.map((s2, i) => (answers[i] ? null : (i + 1) + '. ' + s2)).filter(Boolean).join('\n');
      const prompt = (passage ? '听力原文：\n' + passage + '\n\n' : '') +
        '题目要求：' + dirs + '\n\n需要填的空：\n' + need +
        '\n\n规则：' +
        '\n- 空里通常要填英文单词或短语；如果题干括号里是中文，把它翻成英文。' +
        '\n- 听力题答案取原文完整短语（2-4 词），不要只截一个词。' +
        '\n- 严格输出 ' + need.split('\n').length + ' 行，每行一个答案，不要编号、不要解释、不要引号。';
      const a2 = await ask(prompt, '只输出答案，一行一个。');
      const arr2 = String(a2).split('\n').map(x => x.replace(/^[\d.、)\s]+/, '').replace(/^["']|["']$/g, '').trim()).filter(Boolean);
      let j = 0;
      answers = answers.map(a => a || (arr2[j++] || ''));
    }

    log('    答案 ' + answers.map(a => a || '?').join(' | ').slice(0, 110));
    if (answers.filter(Boolean).length < stmts.length) { log('    答案不全，不提交'); return; }
    await ev("(function(){var a=" + JSON.stringify(answers) + ";" +
      "var ins=[].slice.call(document.querySelectorAll('.scoop-input-wrapper input,.comp-abs-input input'));" +
      "ins.sort(function(p,q){if(Math.abs(p.offsetTop-q.offsetTop)>6)return p.offsetTop-q.offsetTop;return p.offsetLeft-q.offsetLeft});" +
      "var set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;" +
      "ins.forEach(function(e,i){set.call(e,a[i]||'');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.dispatchEvent(new Event('blur',{bubbles:true}))})})()");
    await sleep(700);
    const filled = await ev("(function(){return JSON.stringify([].slice.call(document.querySelectorAll('.scoop-input-wrapper input,.comp-abs-input input')).map(function(e){return e.value.slice(0,24)}))})()");
    log('    已填 ' + filled);
  }
  async function doDiscussion() {
    const cntJs = "(function(){var t=String(document.body.innerText||'');var i=t.indexOf('全部评论');if(i<0)return -1;var s=t.slice(i,i+20);var m=s.match(/[0-9]+/);return m?Number(m[0]):-1})()";
    const before = await ev(cntJs);
    const fillJs = "(function(){var T=" + JSON.stringify(COMMENT_TEXT) + ";" +
      "var ts=[].slice.call(document.querySelectorAll('textarea')).filter(function(x){if(x.offsetParent===null)return false;if(x.closest('.scoop-input-wrapper'))return false;var r=x.getBoundingClientRect();if(r.width<60||r.height<20)return false;return /评论/.test(x.placeholder||'')||!!x.closest('[class*=discussion]')});" +
      "var set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;" +
      "ts.forEach(function(e){set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}))});" +
      "ts.forEach(function(e){set.call(e,T);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.dispatchEvent(new Event('blur',{bubbles:true}))});" +
      "return ts.length})()";
    const n = await ev(fillJs);
    if (!n) return;
    await sleep(700);
    const d = await btn(['发布']);
    if (!d) return;   // 没有发布按钮，这屏不按讨论屏处理
    await click(d.x, d.y);
    await sleep(1800);
    const after = await ev(cntJs);
    log('    发评论 ' + n + ' 个框：' + before + ' → ' + after + ' 条');
  }

  async function doQA(k) {
    const dirs = await ev("(function(){var t=String(document.body.innerText||'').replace(/\\s+/g,' ');var i=t.indexOf('Directions');return i>=0?t.slice(i,i+200):''})()");
    const scored = await isScored(dirs);
    if (scored) {
      log('    这屏判为【计分】，按听力题处理');
      const vurl = await waitMedia(15000);
      if (!vurl) { log('    !! 计分题但 15 秒没拿到音视频，不作答'); await reloadAndWait(); return 'retry'; }
      const st = await (await fetch(SRV + '/stt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: vurl }) })).json();
      if (!st.ok) { log('    !! 转写失败，不作答'); return 'retry'; }
      log('    已转写 ' + st.text.length + ' 字符');
      const n2 = await ev("(function(){return [].slice.call(document.querySelectorAll('textarea')).filter(function(t){return t.offsetParent!==null&&!t.closest('.scoop-input-wrapper')&&!/评论/.test(t.placeholder||'')&&!t.closest('[class*=discussion]')&&t.getBoundingClientRect().width>60}).length})()");
      const raw = await ask('听力原文：\n' + st.text + '\n\n题目要求：' + dirs + '\n\n按原文作答，严格输出 ' + n2 + ' 行英文，不要编号。', '只输出 ' + n2 + ' 行答案。');
      const arr = String(raw).split('\n').map(x => x.replace(/^[\d.、)\s]+/, '').trim()).filter(Boolean);
      await ev("(function(){var a=" + JSON.stringify(arr) + ";var ts=[].slice.call(document.querySelectorAll('textarea')).filter(function(t){return t.offsetParent!==null&&!t.closest('.scoop-input-wrapper')&&!/评论/.test(t.placeholder||'')&&!t.closest('[class*=discussion]')&&t.getBoundingClientRect().width>60});var set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;ts.forEach(function(e,i){set.call(e,a[i]||'');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})})()");
      log('    计分题已按原文作答 ' + arr.length + ' 行');
      await sleep(600);
      return;
    }
    const n = await ev("(function(){return [].slice.call(document.querySelectorAll('textarea')).filter(function(t){return t.offsetParent!==null&&!t.closest('.scoop-input-wrapper')&&!/评论/.test(t.placeholder||'')&&!t.closest('[class*=discussion]')&&t.getBoundingClientRect().width>60}).length})()");
    if (!n) { log('    没有答题框'); return; }
    await ev("(function(){" +
      "var ts=[].slice.call(document.querySelectorAll('textarea')).filter(function(t){return t.offsetParent!==null&&!t.closest('.scoop-input-wrapper')&&!/评论/.test(t.placeholder||'')&&!t.closest('[class*=discussion]')&&t.getBoundingClientRect().width>60});" +
      "var set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;" +
      "ts.forEach(function(e,i){set.call(e,'" + FILLER_TEXT + "');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.dispatchEvent(new Event('blur',{bubbles:true}))})" +
    "})()");
    await sleep(600);
    log('    主观题 ' + n + ' 个，填固定文案');
  }
  // 假麦克风：每次 gUM 都新建 MediaStreamDestination，并把这次的真实情况记下来
  // （只看"点没点上"不够，得知道页面到底有没有真的来要麦克风）
  const VOICE_PATCH = '(function(){' +
    'if(window.__voicePatched)return "ok";window.__voicePatched=true;' +
    'window.__voiceProbe={n:0,started:0,dur:0,last:""};' +
    'var md=navigator.mediaDevices,orig=md.getUserMedia?md.getUserMedia.bind(md):null;' +
    'md.getUserMedia=async function(c){' +
      'if(!c||!c.audio)return orig?orig(c):Promise.reject(new Error("no"));' +
      'var Ctx=window.AudioContext||window.webkitAudioContext;' +
      'if(!window.__vctx)window.__vctx=new Ctx();' +
      'var ctx=window.__vctx;var dst=ctx.createMediaStreamDestination();' +
      'try{' +
        'var url=window.__voiceSrc;if(!url){window.__voiceProbe.last="no-src";return dst.stream}' +
        'var r=await fetch(url);var ab=await r.arrayBuffer();' +
        'var audio=await ctx.decodeAudioData(ab);' +
        'window.__voiceProbe.n++;window.__voiceProbe.dur=audio.duration;' +
        'var src=ctx.createBufferSource();src.buffer=audio;src.connect(dst);' +
        'setTimeout(function(){try{src.start(0);window.__voiceProbe.started++;window.__voiceProbe.last="started "+audio.duration.toFixed(2)}catch(e){window.__voiceProbe.last="start-err "+e.message}},900)' +
      '}catch(e){window.__voiceProbe.last="err "+e.message}' +
      'return dst.stream};return "ok"' +
  '})()';

  async function doVoice() {
    const n = (await kind()).sent;
    if (!n) return;
    log('    跟读 ' + n + ' 题（每句前刷一次页面：这屏的录音组件只肯要一次麦克风）');

    // 带分页的屏（第1页填空 / 第2页跟读）刷新会回到第 1 页，必须点回跟读页再录。
    // 判断"回到了对的那页"用第一句文本当签名，比数页面更抗改版。
    // 签名要去掉行首那个分数（录完会从 0 变成 96，不然"回不到跟读页"会误报）
    const firstSentence = async () => await ev('(function(){var s=document.querySelectorAll(".sentence-container")[0];' +
      'if(!s)return "";' +
      'var t=String(s.textContent||"").replace(/\s+/g," ").trim();' +
      't=t.replace(/^\d+(\.\d+)?\s*/,"");' +
      'return t.slice(0,40)})()');

    const clickPager = async (label) => {
      const r = JSON.parse(await ev('(function(){var els=[].slice.call(document.querySelectorAll("a,button,div[role=button]"));' +
        'var el=els.filter(function(e){return String(e.textContent||"").replace(/\s+/g,"")===' + JSON.stringify(label) + '})[0];' +
        'if(!el)return JSON.stringify({err:"no-btn"});' +
        'el.scrollIntoView({block:"center"});var b=el.getBoundingClientRect();' +
        'return JSON.stringify({x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)})})()') || '{}');
      if (!r.x) return false;
      await click(r.x, r.y);
      await sleep(1600);
      return true;
    };

    const restoreVoicePage = async (sig) => {
      for (let k = 0; k < 10; k++) {
        if (String(await firstSentence()) === sig) return true;
        if (await clickPager('下一题')) { await sleep(1200); continue; }
        await sleep(1500);   // 还没渲染完，等会儿再找按钮
      }
      return String(await firstSentence()) === sig;
    };

    const micRect = i => '(function(){' +
      'var s=document.querySelectorAll(".sentence-container")[' + i + '];' +
      'if(!s)return JSON.stringify({err:"no-row"});' +
      's.scrollIntoView({block:"center"});' +
      'var b=s.querySelector(".record-icon.button-record");' +
      'if(!b)return JSON.stringify({err:"no-mic"});' +
      'var r=b.getBoundingClientRect();' +
      'return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});' +
    '})()';

    // 录一句：返回 true 表示这次真的录了并且出了分
    const recordOne = async (i) => {
      await ev(VOICE_PATCH);

      const setSrc = await ev('(function(){var s=document.querySelectorAll(".sentence-container")[' + i + '];' +
        'if(!s)return "none";var a=s.querySelector("audio");if(!a)return "noaudio";' +
        'window.__voiceSrc=a.currentSrc||a.src;return "ok"})()');
      if (setSrc !== 'ok') { log('      第' + (i + 1) + '句 没有示范音（' + setSrc + '），跳过'); return false; }

      let rect = JSON.parse(await ev(micRect(i)) || '{}');
      if (rect.err) { log('      第' + (i + 1) + '句 找不到麦克风按钮（' + rect.err + '）'); return false; }

      const beforeN = await ev('window.__voiceProbe.n');
      await click(rect.x, rect.y);
      let started = false;
      let confirmed = false;
      for (let t = 0; t < 16; t++) {
        await sleep(250);
        if (Number(await ev('window.__voiceProbe.n')) > Number(beforeN)) { started = true; break; }
        // 这一句以前录过 → 页面会先弹「确定重新录制吗？」，点确定才真的开始
        if (!confirmed) {
          const clicked = await ev('(function(){var bs=[].slice.call(document.querySelectorAll(".ant-modal button,.ant-popover button,.ant-modal-confirm button"))' +
            '.filter(function(b){return /确定|确 定/.test(String(b.textContent||""))&&!b.disabled});if(!bs.length)return 0;bs[bs.length-1].click();return 1})()');
          if (clicked) { confirmed = true; log('      （这一句以前录过，点了「确定」重录）'); }
        }
      }
      if (!started) {
        rect = JSON.parse(await ev(micRect(i)) || '{}');
        await sleep(400);
        await click(rect.x, rect.y);
        for (let t = 0; t < 16; t++) {
          await sleep(250);
          if (Number(await ev('window.__voiceProbe.n')) > Number(beforeN)) { started = true; break; }
        }
      }
      if (!started) { log('      第' + (i + 1) + '句 点了麦克风没开始录音（页面没要麦克风），跳过'); return false; }

      const dur = Number(await ev('window.__voiceProbe.dur')) || 2.5;
      await sleep(Math.round((dur + 1.2) * 1000));

      rect = JSON.parse(await ev(micRect(i)) || '{}');
      if (!rect.x) { log('      第' + (i + 1) + '句 停止时找不到按钮'); return false; }
      await click(rect.x, rect.y);

      let scored = false;
      for (let t = 0; t < 20; t++) {
        await sleep(400);
        const rowTxt = await ev('(function(){var s=document.querySelectorAll(".sentence-container")[' + i + '];' +
          'return s?String(s.textContent||"").replace(/\\s+/g," ").slice(0,60):""})()');
        if (/准确度|流利度|完整度/.test(rowTxt) || /^\s*\d{1,3}/.test(String(rowTxt))) { scored = true; break; }
      }
      log('      第' + (i + 1) + '句 ' + dur.toFixed(1) + 's ' + (scored ? '已评分' : '录了但没出分'));
      await sleep(400);
      return scored;
    };

    const pageSig = String(await firstSentence());
    let ok = 0;
    const failed = [];
    for (let i = 0; i < n; i++) {
      // 第一句用当前页面，之后每句刷一次（见 reloadForVoice 的注释）
      if (i > 0) {
        await reloadForVoice();
        if (!(await restoreVoicePage(pageSig))) { log('      第' + (i + 1) + '句 刷新后回不到跟读页（第一句对不上），跳过'); failed.push(i); continue; }
      }
      if (await recordOne(i)) ok++; else failed.push(i);
    }
    // 没成的再刷一遍重试一次（有的行第一轮录不上，第二轮能上）
    if (failed.length) {
      log('    重试 ' + failed.length + ' 句：' + failed.map(i => i + 1).join(','));
      for (const i of failed.slice()) {
        await reloadForVoice();
        if (!(await restoreVoicePage(pageSig))) continue;
        if (await recordOne(i)) { ok++; failed.splice(failed.indexOf(i), 1); }
      }
    }
    // 收尾：确定人还在跟读页（刷新/重试之后可能被甩回第 1 页，提交就会提错页）
    if (!(await restoreVoicePage(pageSig))) log('    !! 收尾时回不到跟读页（下一句翻页可能失败）');
    log('    跟读完成 ' + ok + '/' + n + ' 句有分' + (failed.length ? '（没分：第 ' + failed.map(i => i + 1).join(',') + ' 句）' : ''));
  }

  // ---- 改错题（.question-revise-mistake）----
  // 页面把每句拆成逐个单词 span.mistake-atom；点某个词 → 弹出 .ant-popover，
  // 里面有 add-before / change / delete / mark-correct 四个动作；
  // 选 change → .mistake-item-edit-form 里出现 input.edit-form-input + button.edit-form-submit。
  // 注意：input 必须用真实输入事件（Input.insertText）改，直接赋 value 的话 React 收不到，
  // 提交按钮点了没反应（我第一次就是这么试的）。
  const REV_LINES_JS = "(function(){return JSON.stringify([].slice.call(document.querySelectorAll('.comp-revise-mistake-reply')).map(function(e){return String(e.textContent||'').replace(/\\s+/g,' ').trim()}))})()";

  async function revClickWord(idx, word) {
    const r = JSON.parse(await ev('(function(){' +
      'var item=document.querySelectorAll(".comp-revise-mistake-reply")[' + idx + '];' +
      'if(!item)return JSON.stringify({err:"no-item"});' +
      'var atoms=[].slice.call(item.querySelectorAll(".mistake-atom"));' +
      'var want=' + JSON.stringify(word) + ';' +
      'var hit=null;' +
      'var clean=function(s){return String(s||"").replace(/^[^A-Za-z]+/,"").replace(/[^A-Za-z"]+$/,"");};' +
      // 四层匹配：原样 → 忽略大小写 → 去标点 → 前缀（词形变化时也能对上）
      'atoms.forEach(function(a){var t=String(a.textContent||"").trim();if(hit)return;if(t===want)hit=a;});' +
      'if(!hit)atoms.forEach(function(a){var t=String(a.textContent||"").trim();if(hit)return;if(t.toLowerCase()===want.toLowerCase())hit=a;});' +
      'if(!hit)atoms.forEach(function(a){var t=clean(a.textContent);if(hit)return;if(t&&t.toLowerCase()===clean(want).toLowerCase())hit=a;});' +
      'if(!hit)atoms.forEach(function(a){var t=clean(a.textContent).toLowerCase(),w2=clean(want).toLowerCase();if(hit)return;if(t&&w2&&t.length>2&&t.indexOf(w2)===0)hit=a;});' +
      'if(!hit)return JSON.stringify({err:"no-atom"});' +
      'hit.scrollIntoView({block:"center"});' +
      'var b=hit.getBoundingClientRect();' +
      'return JSON.stringify({x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)});' +
    '})()') || '{}');
    if (!r.x) return r.err || 'no-coord';
    await click(r.x, r.y);
    await sleep(850);
    return 'ok';
  }

  // 在弹层里点某个动作，返回是否点到了
  async function revAction(label) {
    const ok = await ev('(function(){var el=[].slice.call(document.querySelectorAll(".ant-popover .mistake-item-action"))' +
      '.filter(function(e){return String(e.textContent||"").trim()===' + JSON.stringify(label) + '})[0];' +
      'if(!el)return 0;el.click();return 1})()');
    await sleep(700);
    if (!ok) {
      // 这个词之前改过：点开的是「确定撤销该操作吗？」，点取消关掉，千万别点确定把答案撤销了
      await ev('(function(){var bs=[].slice.call(document.querySelectorAll(".ant-popover button"))' +
        '.filter(function(b){return /取消/.test(String(b.textContent||""))});if(bs.length)bs[0].click();return 1})()');
      await sleep(300);
    }
    return !!ok;
  }

  async function revSubmitForm(text) {
    if (text) {
      await ev('(function(){var i=document.querySelector(".edit-form-input");if(!i)return 0;i.focus();try{i.select()}catch(e){};return 1})()');
      await type(text);   // Input.insertText：真实输入事件，React 才认得
      await sleep(350);
    }
    const ok = await ev('(function(){var b=document.querySelector(".mistake-item-edit-form button.edit-form-submit");' +
      'if(!b)return 0;b.click();return 1})()');
    await sleep(900);
    return !!ok;
  }

  async function doCorrect(k) {
    const lines = JSON.parse(await ev(REV_LINES_JS) || '[]');
    if (!lines.length) { log('    !! 改错题没读到句子，跳过'); return; }
    log('    改错题 ' + lines.length + ' 句');

    // 有视频就先转写，给模型当依据
    let passage = '';
    const vurl0 = await waitMedia(12000);
    if (vurl0) {
      try {
        const st = await (await fetch(SRV + '/stt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: String(vurl0).split('#')[0] }) })).json();
        if (st.ok) { passage = String(st.text || ''); log('    已转写 ' + passage.length + ' 字符'); }
        else log('    !! 转写失败：' + String(st.err || '').slice(0, 80));
      } catch (e) { log('    !! 转写出错 ' + e.message); }
    }

    const q = '视频原文（自动转写，可能有个别错词，仅作参考）：\n' + (passage || '(没有)') +
      '\n\n待改错的句子（每句有一处错）：\n' + lines.map((t, i) => (i + 1) + '. ' + t).join('\n') +
      '\n\n任务：逐句找出错的那个词，给出改法。要求：' +
      '\n- op=change：把 from 换成 to（错的是短语时，改短语里最关键的那个词）' +
      '\n- op=delete：多出来的词，to 留空' +
      '\n- op=add-before：少了词，在 from 前面插入 to' +
      '\n- from 必须是原句里原样出现的一个单词（大小写照抄，不带标点）' +
      '\n只输出 JSON 数组，形如 [{"i":1,"op":"change","from":"difficult","to":"hard"}]，不要任何解释。';
    let plan = [];
    // 调试用：POTATO_CORRECT_PLAN='[{"i":1,"op":"change","from":"difficult","to":"hard"}]'
    // 跳过模型直接按给定改法执行（没 API Key 也能验填充链路）
    if (process.env.POTATO_CORRECT_PLAN) {
      try { plan = JSON.parse(process.env.POTATO_CORRECT_PLAN); log('    用 POTATO_CORRECT_PLAN 指定的改法（调试）'); } catch (e) { plan = []; }
    }
    const raw = plan.length ? '' : await ask(q, '只输出 JSON 数组。');
    try {
      if (plan.length) throw { skip: true };
      const m = String(raw).match(/\[[\s\S]*\]/);
      plan = JSON.parse(m ? m[0] : raw);
    } catch (e) {
      if (!(e && e.skip)) {
        log('    !! 模型没给合法 JSON：' + String(raw).replace(/\s+/g, ' ').slice(0, 120));
        return;
      }
    }
    if (!Array.isArray(plan) || !plan.length) { log('    !! 模型没给出改法'); return; }

    let done = 0;
    for (const p of plan) {
      const idx = Number(p.i) - 1;
      const from = String(p.from || '').trim();
      const to = String(p.to || '').trim();
      const op = String(p.op || 'change');
      if (!(idx >= 0 && idx < lines.length) || !from) continue;
      const before = lines[idx];
      const r = await revClickWord(idx, from);
      if (r !== 'ok') { log('      第' + (idx + 1) + '句 找不到词「' + from + '」（' + r + '）'); await closeDlg(); continue; }
      const label = op === 'delete' ? 'delete' : (op === 'add-before' ? 'add-before' : 'change');
      if (!await revAction(label)) { log('      第' + (idx + 1) + '句 弹层里没找到 ' + label); await ev("(function(){var m=document.querySelector('.ant-popover');if(m)m.remove()})()"); continue; }
      const sent = await revSubmitForm(label === 'delete' ? '' : to);
      const after = await ev(REV_LINES_JS);
      const afterLines = JSON.parse(after || '[]');
      const now = afterLines[idx] || '';
      const changed = now !== before;
      if (changed) done++;
      log('      第' + (idx + 1) + '句 ' + label + ' "' + from + '"' + (to ? ' → "' + to + '"' : '') + ' ' + (changed ? 'OK' : (sent ? '提交了但句子没变' : '提交按钮没点到')));
      if (changed) lines[idx] = now;
      await sleep(300);
    }
    log('    改错完成 ' + done + '/' + plan.length);
  }

  // 词级时间戳断句 → 模型为每条陈述找「证据句」→ 按证据句时间定序
  async function sortByEvidence(stmts, vurl) {
    if (!vurl) return null;
    let ts = null;
    try {
      const r = await fetch(SRV + '/stt-ts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: vurl, lines: [] }) });
      ts = await r.json();
    } catch (e) { return null; }
    if (!ts || !ts.ok || !ts.pool || ts.pool.length < 8) { log('    !! 时间轴拿不到'); return null; }
    // pool 是 whisper 分段，每段自带起止时间，直接当"候选句"
    const sents = ts.pool
      .map((x, i) => ({ i: i + 1, start: Number(x.s) || 0, text: String(x.t || '').trim() }))
      .filter(x => x.text.length > 3);
    if (sents.length < stmts.length) { log('    !! 分段太少（' + sents.length + '）'); return null; }
    log('    拿到 ' + sents.length + ' 段带时间轴的原文，让模型配证据句');
    const plain = stmts.map(s => String(s).replace(/^[A-Za-z][.、)]\s*/, ''));
    const q = '视频旁白/对话（按时间顺序，行首是编号）：\n' + sents.map(x => x.i + '. ' + x.text).join('\n') +
      '\n\n任务：为下面 ' + plain.length + ' 条陈述各找最对应的一句。\n' +
      plain.map((s, i) => (i + 1) + '. ' + s).join('\n') +
      '\n\n严格输出 ' + plain.length + ' 行，每行「陈述序号 句子编号」，例如：1 12。不要解释。';
    const raw = await ask(q, '只输出数字对，一行一个，顺序对应陈述。');
    const map = new Map();
    String(raw).split('\n').forEach(line => {
      const m = String(line).match(/(\d+)\D+(\d+)/);
      if (m) {
        const a = Number(m[1]), b = Number(m[2]);
        if (a >= 1 && a <= plain.length && !map.has(a)) map.set(a, b);
      }
    });
    if (map.size < plain.length) { log('    !! 证据句没配全 ' + map.size + '/' + plain.length); return null; }
    const keyed = [];
    for (let i = 1; i <= plain.length; i++) {
      const hit = sents.find(x => x.i === map.get(i));
      if (!hit) { log('    !! 句子编号越界 ' + map.get(i)); return null; }
      keyed.push({ i: i, t: hit.start });
    }
    keyed.sort((a, b) => a.t - b.t || a.i - b.i);
    const span = keyed[keyed.length - 1].t - keyed[0].t;
    if (span < 3) { log('    !! 证据句时间几乎重合，弃用'); return null; }
    const order = keyed.map(x => x.i);
    log('    证据句定序 ' + order.join(' ') + '（时间 ' + keyed.map(x => Math.round(x.t)).join(' / ') + '）');
    return order;
  }

  // ---- 交作品题：把彩蛋 PDF 塞进 file input ----
  const UPLOAD_FILE = require('path').join(ROOT, 'assets', 'potato-report.pdf');
  async function doUpload() {
    let r = null;
    try {
      r = await c.call('Runtime.evaluate', { expression: "document.querySelector('.question-multi-file-upload input[type=file]') || document.querySelector('input[type=file]') || null" });
    } catch (e) { log('    !! 查上传控件失败 ' + e.message); return false; }
    const objectId = r && r.result && r.result.objectId;
    if (!objectId) { log('    !! 这屏没有 file input'); return false; }
    try {
      await c.call('DOM.setFileInputFiles', { files: [UPLOAD_FILE], objectId });
    } catch (e) { log('    !! 选文件失败 ' + e.message); return false; }
    log('    已塞入彩蛋文件 potato-report.pdf');
    // 等上传完成：出现文件名或进度条消失
    let ok = false;
    for (let i = 0; i < 20; i++) {
      await sleep(700);
      const seen = await ev("(function(){var t=String(document.body.innerText||'');return /potato-report/i.test(t)?1:0})()");
      if (seen) { ok = true; break; }
    }
    log(ok ? '    上传完成' : '    没看到文件名，先按已提交处理');
    return ok;
  }

  async function doSort(k) {
    const stmts = JSON.parse(await ev("(function(){return JSON.stringify([].slice.call(document.querySelectorAll('[class*=sequence-reply-view-item]')).map(function(e){return String(e.textContent||'').replace(/\\s+/g,' ').trim()}))})()") || '[]');
    if (stmts.length < 2) return;
    const vurl = await ev("(function(){var v=document.querySelector('video');return v?(v.currentSrc||v.src):''})()");
    let order = await sortByEvidence(stmts, vurl);
    if (!order) {
      log('    回退：整段转写直排');
      let passage = '';
      if (vurl) { const st = await (await fetch(SRV + '/stt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: vurl }) })).json(); if (st.ok) passage = st.text; }
      const raw = await ask('视频原文：\n' + passage + '\n\n现有语句（当前显示顺序）：\n' + stmts.map((x, i) => (i + 1) + '. ' + x).join('\n') + '\n\n题目要求按视频中出现的先后 / 人物对应关系排列这些语句。请给出正确顺序，严格输出一串序号（空格分隔），长度必须为 ' + stmts.length + '。不要解释。', '只输出序号序列。');
      order = String(raw).replace(/[^0-9\s]/g, ' ').trim().split(/\s+/).map(Number).filter(n => n >= 1 && n <= stmts.length);
      if (order.length !== stmts.length) { log('    排序序号长度不符，跳过'); return; }
      if (order.every((n, i) => n === i + 1)) { log('    模型给了原序，判断不可靠，跳过'); return; }
      log('    排序 ' + stmts.length + ' 条 → ' + order.join(' '));
    }
    const orig = stmts.slice();
    const want = order.map(n => orig[n - 1]);
    const listNow = () => ev("(function(){return JSON.stringify([].slice.call(document.querySelectorAll('[class*=sequence-reply-view-item]')).map(function(e){return String(e.textContent||'').replace(/\\s+/g,' ').trim()}))})()");
    async function drag(from, to) {
      // 先把目标句滚进视口，否则坐标落在屏幕外，鼠标事件打空
      await ev("(function(){var it=[].slice.call(document.querySelectorAll('[class*=sequence-reply-view-item]'));var a=it[" + from + "];if(a)a.scrollIntoView({block:'center'});return 1})()");
      await sleep(350);
      const p = JSON.parse(await ev("(function(){var it=[].slice.call(document.querySelectorAll('[class*=sequence-reply-view-item]'));var a=it[" + from + "],b=it[" + to + "];if(!a||!b)return 'null';var ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();if(ra.bottom<0||ra.top>window.innerHeight)return 'null';return JSON.stringify({ax:Math.round(ra.left+60),ay:Math.round(ra.top+ra.height/2),bx:Math.round(rb.left+60),by:Math.round(rb.top+rb.height/2)})})()") || 'null');
      if (p === 'null') return;
      await c.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.ax, y: p.ay });
      await sleep(110);
      await c.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.ax, y: p.ay, button: 'left', clickCount: 1, buttons: 1 });
      await sleep(160);
      for (let i = 1; i <= 10; i++) {
        await c.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(p.ax + (p.bx - p.ax) * i / 10), y: Math.round(p.ay + (p.by - p.ay) * i / 10), button: 'left', buttons: 1 });
        await sleep(50);
      }
      await sleep(150);
      await c.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.bx, y: p.by, button: 'left', clickCount: 1, buttons: 0 });
      await sleep(850);
    }
    let cur = JSON.parse(await listNow());
    for (let t = 0; t < want.length; t++) {
      const pos = cur.indexOf(want[t]);
      if (pos === t || pos < 0) continue;
      await drag(pos, t);
      cur = JSON.parse(await listNow());
    }
    const moved = cur.filter((x, i) => x === want[i]).length;
    log('    归位 ' + moved + '/' + want.length);
  }
  async function doSelect(k) {
    const items = JSON.parse(await ev("(function(){" +
      "var out=[];" +
      "var trigs=[].slice.call(document.querySelectorAll('.ant-dropdown-trigger.user-answer')).filter(function(t){var r=t.getBoundingClientRect();return r.width>10&&r.height>4&&t.offsetParent!==null});" +
      "trigs.forEach(function(t,i){" +
        "var box=t.parentElement;var guard=0;" +
        "while(box&&guard<6&&!/[A-C]\\.\\s/.test(String(box.textContent||''))){box=box.parentElement;guard++}" +
        "var r=t.getBoundingClientRect();" +
        "out.push({i:i,stem:box?String(box.textContent||'').replace(/\\s+/g,' ').trim().slice(0,320):'',tx:Math.round(r.left+r.width/2),ty:Math.round(r.top+r.height/2),cur:String(t.textContent||'').trim()});" +
      "});" +
      "return JSON.stringify(out)})()") || '[]');
    if (!items.length) { log('    没找到下拉题'); return; }
    log('    下拉 ' + items.length + ' 题（当前已填 ' + items.filter(x => !/点击选择/.test(x.cur)).length + '）');
    const vurl = await ev("(function(){var v=document.querySelector('video');return v?(v.currentSrc||v.src):''})()");
    let passage = '';
    if (vurl) {
      const st = await (await fetch(SRV + '/stt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: vurl }) })).json();
      if (st.ok) { passage = st.text; log('    已转写 ' + passage.length + ' 字符'); }
    }
    const listing = items.map((it, i) => (i + 1) + '. ' + it.stem).join('\n\n');
    const qt = await ev("(function(){var t=String(document.body.innerText||'').replace(/\\s+/g,' ');var i=t.indexOf('Question');return i>=0?t.slice(i,i+220):''})()");
    const raw = await ask(
      '视频原文：\n' + (passage || '(无音频)') + '\n\n' + (qt ? '总问题：' + qt + '\n\n' : '') + '题目与选项：\n' + listing +
      '\n\n共 ' + items.length + ' 题，每题为单选，答案必须以视频原文为依据，不要靠常识猜。' +
      '\n严格输出 ' + items.length + ' 行字母（A/B/C），不要编号不要解释。',
      '只输出 ' + items.length + ' 行字母。');
    const ans = String(raw).toUpperCase().replace(/[^ABC]/g, '').slice(0, items.length);
    log('    答案 ' + ans);
    if (ans.length !== items.length) { log('    答案长度不符，放弃本题组'); return; }
    for (let i = 0; i < items.length; i++) {
      const letter = ans[i];
      if (items[i].cur === letter) { log('    第' + (i + 1) + '题 已是 ' + letter); continue; }
      await click(items[i].tx, items[i].ty);
      await sleep(1000);
      const opt = JSON.parse(await ev("(function(){" +
        "var want=" + JSON.stringify(letter) + ";" +
        "var cand=[];" +
        "document.querySelectorAll('.ant-dropdown li,.ant-dropdown-menu li,.ant-select-item,li.select-option,.ant-dropdown a').forEach(function(e){" +
          "var r=e.getBoundingClientRect();if(r.width<4||r.height<4)return;" +
          "var t=String(e.textContent||'').trim();if(!t||t.length>80)return;" +
          "var m=t.match(/^([A-Z])[.、)]/);" +
          "cand.push({t:t,L:m?m[1]:null,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})" +
        "});" +
        "if(!cand.length)return 'null';" +
        "var hit=cand.find(function(o){return o.L===want});" +
        "if(!hit){var idx=want.charCodeAt(0)-65;hit=cand[idx]}" +
        "return hit?JSON.stringify(hit):'null'})()") || 'null');
      if (!opt || opt === 'null') { log('    第' + (i + 1) + '题 抓不到下拉项'); continue; }
      await click(opt.x, opt.y);
      await sleep(800);
      const now = await ev("(function(){var t=[].slice.call(document.querySelectorAll('.ant-dropdown-trigger.user-answer')).filter(function(e){var r=e.getBoundingClientRect();return r.width>10&&e.offsetParent!==null});return t[" + i + "]?String(t[" + i + "].textContent||'').trim():'?'})()");
      log('    第' + (i + 1) + '题 → ' + letter + '  实际=' + now + '  ' + String(opt.t).slice(0, 30));
    }
  }
  async function submit() {
    // 分页题：出现「下一题」就翻页，翻到底再提交
    for (let page = 0; page < 8; page++) {
      const next = await btn(['下一题']);
      if (!next) break;
      await click(next.x, next.y);
      log('    下一题 → 第' + (page + 2) + '页');
      await sleep(2500);
      try {
        const k2 = await waitKind();
        log('      第' + (page + 2) + '页 ' + JSON.stringify(k2));
        if (k2.cmt > 0) await doDiscussion();
        if (k2.up > 0) await doUpload();
        if (k2.sent > 0) await doVoice();
        else if (k2.opt > 0) await doChoice(k2);
        else if (k2.ins > 0) await doFill(k2);
        else if (k2.dd > 0) await doSelect(k2);
        else if (k2.qa >= 1) await doQA(k2);
        else log('      本页无可答内容');
      } catch (e) { log('    翻页后处理异常 ' + e.message); }
    }
    const cont = await btn(['继续学习']);
    if (cont) { await click(cont.x, cont.y); log('    继续学习'); await sleep(3500); return true; }
    const sub = await btn(['提交']);
    if (!sub) {
      const pub = await btn(['发布']);
      if (pub) {
        await click(pub.x, pub.y);
        await sleep(2600);
        log('    点「发布」完成这屏');
        STATE.ok = (STATE.ok || 0) + 1;
        saveState();
        return true;
      }
      return false;
    }
    await click(sub.x, sub.y);
    // 等确认弹窗（说话题/单元测试都会弹「仅记录第一次作答」），最多 9 秒
    let ok = null;
    for (let t = 0; t < 18; t++) {
      await sleep(500);
      ok = await btn(['确定', '确认']);
      if (ok) break;
    }
    if (ok) { await click(ok.x, ok.y); log('    已确认提交'); await sleep(3500); }
    else log('    这题提交不弹确认框');
    let sc = '?';
    for (let t = 0; t < 10; t++) {
      await sleep(1200);
      sc = await score();
      if (sc && sc !== '?') break;
    }
    log('    提交 → ' + sc + ' 分');
    if (sc && sc !== '?') { STATE.ok = (STATE.ok || 0) + 1; STATE.streakFail = 0; }
    else { STATE.fail = (STATE.fail || 0) + 1; STATE.streakFail = (STATE.streakFail || 0) + 1; }
    saveState();
    if (STATE.streakFail >= MAX_FAIL) {
      log('!! 连续 ' + STATE.streakFail + ' 屏没拿到分数，自动暂停等你处理');
      try { fs.writeFileSync(CTRL_PATH, JSON.stringify(Object.assign(readCtrl(), { state: 'paused' })), 'utf8'); } catch (e) {}
      STATE.state = 'paused'; saveState();
    }
    return true;
  }

  async function nextSection() {
    const findJs = "(function(){var cont=document.querySelector('.pc-slier-menu-container');if(!cont)return 'null';" +
      "var all=[].slice.call(cont.querySelectorAll('.pc-slider-menu-micro')).filter(function(m){return m.offsetParent!==null});" +
      "var act=all.filter(function(m){return /pc-menu-activity/.test(String(m.className))})[0];" +
      "if(!act)return 'null';var ai=all.indexOf(act);if(ai+1>=all.length)return 'null';" +
      "var n=all[ai+1];var nm=n.querySelector('.pc-menu-node-name');n.scrollIntoView({block:'center'});" +
      "return JSON.stringify({i:ai+1,name:String(nm?nm.textContent:(n.textContent||'')).trim().slice(0,24),lock:/pc-menu-micro-lock/.test(String(n.className))})})()";
    const posRaw = await ev(findJs);
    if (!posRaw || posRaw === 'null') { log('  没有下一节'); return false; }
    await sleep(900);
    const pos = JSON.parse(await ev("(function(){var cont=document.querySelector('.pc-slier-menu-container');var all=[].slice.call(cont.querySelectorAll('.pc-slider-menu-micro')).filter(function(m){return m.offsetParent!==null});var act=all.filter(function(m){return /pc-menu-activity/.test(String(m.className))})[0];var ai=all.indexOf(act);var n=all[ai+1];if(!n)return 'null';var r=n.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height),name:String(n.textContent||'').trim().slice(0,24),lock:/pc-menu-micro-lock/.test(String(n.className))})})()") || 'null');
    if (pos.w < 10 || pos.h < 10) { log('  下一节不在可视区: ' + pos.name); return false; }
    const before = await ev("(function(){var a=null;document.querySelectorAll('.pc-menu-activity').forEach(function(m){a=String(m.textContent||'').trim()});return a})()");
    await click(pos.x, pos.y);
    await sleep(4500);
    const after = await ev("(function(){var a=null;document.querySelectorAll('.pc-menu-activity').forEach(function(m){a=String(m.textContent||'').trim()});return a})()");
    if (before === after) {
      log('  翻节失败' + (pos.lock ? '（下一节带锁，必修没完成）' : '（点不动）') + ': ' + pos.name);
      return false;
    }
    log('  翻节 ' + before + ' → ' + after);
    return true;
  }

  // ---- 主循环 ----
  for (let sec = 1; sec <= maxSec; sec++) {
    await guard();
    STATE.section = sec; STATE.state = 'running'; saveState();
    log('=== 第 ' + sec + ' 节 ===');
    let tops = JSON.parse(await ev("(function(){var o=[];document.querySelectorAll('.pc-header-tab-default.tab,.pc-header-tab-activity.tab').forEach(function(t){var r=t.getBoundingClientRect();if(r.width<4)return;o.push({t:String(t.textContent||'').trim(),x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),a:/activity/.test(String(t.className))})});return JSON.stringify(o)})()") || '[]');
    if (HERE_ONLY) {
      const actTabs = tops.filter(t => t.a);
      tops = actTabs.length ? [Object.assign({}, actTabs[0], { noClick: true })] : [];
      log('  [--here] 只跑当前屏：' + (tops[0] ? tops[0].t : '?'));
    }
    for (const tt of tops) {
      if (!tt.noClick) { await click(tt.x, tt.y); await sleep(2600); await closeDlg(); }
      // 校验真的切过去了（点不中就会被当成上一个 tab 重复处理）
      let actName = await ev("(function(){var a=document.querySelector('.pc-header-tab-activity.tab');return a?String(a.textContent||'').trim():''})()");
      if (actName !== tt.t) {
        log('    tab 没切过去，再点一次：' + tt.t);
        await sleep(600);
        await click(tt.x, tt.y); await sleep(2800); await closeDlg();
        actName = await ev("(function(){var a=document.querySelector('.pc-header-tab-activity.tab');return a?String(a.textContent||'').trim():''})()");
        if (actName !== tt.t) log('    !! 还是没切到 ' + tt.t + '（当前 ' + actName + '）');
      }
      const subs = JSON.parse(await ev("(function(){var o=[];document.querySelectorAll('.pc-task').forEach(function(t){var r=t.getBoundingClientRect();if(r.width<4)return;o.push({t:String(t.textContent||'').trim(),x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),a:/activity/.test(String(t.className))})});return JSON.stringify(o)})()") || '[]');
      let screens = subs.length ? subs : [{ t: tt.t }];
      if (HERE_ONLY && subs.length) {
        const actSubs = subs.filter(s => s.a).map(s => ({ t: s.t }));
        if (actSubs.length) screens = actSubs;
      }
      for (const sc of screens) {
        if (sc.x) { const now = JSON.parse(await ev("(function(){var o=null;document.querySelectorAll('.pc-task').forEach(function(t){if(String(t.textContent||'').trim()===" + JSON.stringify(sc.t) + "){var r=t.getBoundingClientRect();o={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),a:/activity/.test(String(t.className))}}}) ; return JSON.stringify(o)})()") || 'null'); if (now && !now.a) { await click(now.x, now.y); await sleep(2000); } }
        await guard();
        const label = tt.t + ' / ' + sc.t;
        STATE.screen = String(label).slice(0, 40); saveState();
        if (await summary()) { log('  ' + label + ' 已完成 ' + (await score()) + ' 分，跳过'); continue; }
        await sleep(1200);
        const k = await waitKind();
        log('  ' + label + ' ' + JSON.stringify(k));
        if (k.img > 0) {
          const n = await ev("(function(){return document.querySelectorAll('.option').length})()");
          log('    选项含图片（' + n + ' 项），随机蒙一个后提交');
          if (n > 0) {
            const pick = Math.floor(Math.random() * n);
            await ev("(function(){var o=document.querySelectorAll('.option')[" + pick + "];if(o)o.click()})()");
            await sleep(500);
          }
          await submit();
          continue;
        }
        let skipSubmit = false;
        try {
          // 有评论框就先发布（讨论屏常和主观题混在一屏）
          if (k.cmt > 0) await doDiscussion();
          // 交作品的题：塞彩蛋文件
          if (k.up > 0) await doUpload();
          // 配音题（视频 + 逐句麦克风）单独走，别当自由说话处理
          const isDub = k.rec > 0 ? await ev("(function(){return document.querySelector('.question-video-dub-pc')?1:0})()") : 0;
          let dubbed = false;
          if (isDub) {
            // 配音题单独一个进程跑（时序对得严，塞在主循环里会互相干扰）
            log('    配音题：交给 dub.js');
            try {
              const { spawnSync } = require('child_process');
              spawnSync(process.execPath, [path.join(ROOT, 'dub.js')], { cwd: ROOT, stdio: 'inherit', timeout: 600000 });
            } catch (e) { log('    dub.js 出错：' + e.message); }
            dubbed = true;
          }
          if (dubbed) { /* 配音已逐句录完，直接进提交 */ }
          else if (k.dd > 0) { const rr = await doSelect(k); if (rr === 'retry') skipSubmit = true; }
          else if (k.opt > 0) { const rr = await doChoice(k); if (rr === 'retry') skipSubmit = true; }
          else if (k.ins > 0) { const rr = await doFill(k); if (rr === 'retry') skipSubmit = true; }
          else if (k.qa >= 1) { const rr = await doQA(k); if (rr === 'retry') skipSubmit = true; }
          else if (k.sent > 0) await doVoice();
          else if (k.ta > 0 && !(k.cmt > 0)) await doDiscussion();
          else if (k.sort > 0) await doSort(k);
          else if (k.rec > 0) await doSpeak();
          else if (k.rev > 0) await doCorrect(k);
          else if ((await ev("(function(){return document.querySelectorAll('video').length})()")) > 0) await doVideo();
          else if (!(k.cmt > 0)) {
            const probe = await ev("(function(){var t=String(document.body.innerText||'').replace(/\\s+/g,' ');var i=t.indexOf('Directions');return JSON.stringify({txt:i>=0?t.slice(i,i+220):t.slice(0,220),ta:document.querySelectorAll('textarea').length,btn:[].slice.call(document.querySelectorAll('a,button,.ant-btn')).filter(function(b){return b.offsetParent!==null&&String(b.textContent||'').trim().length<=6}).map(function(b){return String(b.textContent||'').replace(/\\s+/g,'')}).slice(0,6)})})()");
            log('    !! 未知题型，按“不能跳过就乱做”处理 ' + probe);
            const nopt = await ev("(function(){return document.querySelectorAll('.option').length})()");
            if (nopt > 0) {
              await ev("(function(){var o=document.querySelectorAll('.option')[" + Math.floor(Math.random() * 5) + "];if(o)o.click()})()");
              await sleep(400);
            } else {
              await ev("(function(){var ts=[].slice.call(document.querySelectorAll('textarea')).filter(function(t){return t.offsetParent!==null});var set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;ts.forEach(function(e){set.call(e,'" + FILLER_TEXT + "');e.dispatchEvent(new Event('input',{bubbles:true}))})})()");
              await sleep(400);
            }
          }
        } catch (e) { log('    处理异常 ' + e.message); }
        if (skipSubmit) { log('    未拿到依据，本轮不提交'); continue; }
        if (NO_SUBMIT) { log('    [POTATO_NO_SUBMIT] 已填好，本轮不提交'); continue; }
        await submit();
      }
    }
    if (PAUSE_EVERY > 0 && sec % PAUSE_EVERY === 0) {
      log('已跑 ' + sec + ' 节，按设置暂停');
      try { fs.writeFileSync(CTRL_PATH, JSON.stringify(Object.assign(readCtrl(), { state: 'paused' })), 'utf8'); } catch (e) {}
      STATE.state = 'paused'; saveState();
    }
    if (!(await nextSection())) { log('本节结束，无法继续'); break; }
  }
  flushUsage();
  if (USAGE.calls > 0) {
    const cost = USAGE.in * 2 / 1e6 + USAGE.out * 8 / 1e6;
    log('本次累计 ' + USAGE.calls + ' 次调用，输入 ' + USAGE.in + ' / 输出 ' + USAGE.out + ' token，约 ' + cost.toFixed(3) + ' 元');
  }
  log('=== 跑完 ===');
  c.close();
})().catch(e => {
  // 顶层的任何异常都要落进 run-all.log，否则新人只看到面板「运行中」而日志一片空白
  const msg = e && e.stack ? String(e.stack).split('\n').slice(0, 4).join(' | ') : String(e);
  log('!! 异常退出：' + msg);
  log('   如果是 connect/ws 相关：确认 start-chrome.cmd 那个窗口还开着、期间没关过浏览器');
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(Object.assign(STATE, { state: 'stopped', err: msg })), 'utf8'); } catch (x) {}
  process.exit(1);
});