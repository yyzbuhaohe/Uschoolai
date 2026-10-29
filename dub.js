/* dub.js —— 配音题（视频逐句配音）解题
 *
 * 思路：页面每句都自带示范音（<audio>，点小喇叭放的那个），
 * 把它接进页面的录音链路，录进去的就是标准读音，不用自己去视频里切时间轴。
 *
 * 时序（一步都不能乱）：
 *   点录音 → 页面 init(1~2s，sink 就绪) → 立刻让示范音响 + 接进 sink
 *   → 等页面到点(约 5s)自己停并评分 → 期间绝不点第二次
 *
 * 用法：node dub.js
 * 前提：Chrome 开着 9222，页面停在配音题那一屏
 */
const BASE = 'http://127.0.0.1:9222';
const fs = require('fs');
const path = require('path');

const LOG = path.join(__dirname, 'run-all.log');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => {
  const line = '[' + new Date().toLocaleTimeString() + '] ' + m;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
};

async function connect() {
  const list = await (await fetch(BASE + '/json/list')).json();
  const t = list.filter(x => x.type === 'page' && /ucontent\.unipus\.cn/.test(x.url))[0];
  if (!t) throw new Error('没找到课程页面');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const call = (m, params) => new Promise(res => {
    const myId = ++id;
    const h = e => { const d = JSON.parse(e.data); if (d.id === myId) { ws.removeEventListener('message', h); res(d); } };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: myId, method: m, params: params || {} }));
  });
  await new Promise(r => ws.addEventListener('open', r));
  const ev = async expr => {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (!r || !r.result) return null;
    if (r.result.exceptionDetails) {
      const d = r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description;
      return { __err: String(d || r.result.exceptionDetails.text || '').slice(0, 200) };
    }
    return r.result.result ? r.result.result.value : null;
  };
  const clickAt = async (x, y) => {
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  };
  return { call, ev, clickAt, close: () => ws.close() };
}

async function main() {
  const { ev, clickAt, close } = await connect();

  if (!(await ev("document.querySelector('.question-video-dub-pc') ? 1 : 0"))) {
    log('当前不是配音题'); close(); return;
  }

  // 自己注入钩子，不指望 potato-watch
  const hookSrc = fs.readFileSync(path.join(__dirname, 'dub-hook.js'), 'utf8');
  const ver = await ev(hookSrc + '\n;window.__potatoDub ? window.__potatoDub.ver : "fail"');
  log('钩子版本 ' + (ver && ver.__err ? '失败：' + ver.__err : ver));
  if (!ver || ver === 'fail' || ver.__err) { close(); return; }
  await sleep(300);

  const lines = JSON.parse(await ev("(function(){return JSON.stringify([].slice.call(document.querySelectorAll('.question-video-dub-pc .item')).map(function(it){var t=String(it.textContent||'').replace(/\\s+/g,' ').trim();t=t.replace(/Your browser does not support[\\s\\S]*$/,'');t=t.replace(/准确度[\\s\\S]*$/,'');return t.trim()}))})()") || '[]').filter(Boolean);
  if (!lines.length) { log('没解析到台词'); close(); return; }

  const lens = JSON.parse(await ev("window.__potatoDub.snapshotAudio()") || '[]');
  log('配音 ' + lines.length + ' 句，示范音时长：' + lens.join(' / ') + 's');

  // 视频解成 buffer（这条路才稳）
  const vurl = await ev("(function(){var v=document.querySelector('video');return v?String(v.currentSrc||v.src||'').split('#')[0]:''})()");
  if (!vurl) { log('没找到视频'); close(); return; }
  const vdur = await ev("window.__potatoDub.load(" + JSON.stringify(vurl) + ")");
  log('音轨 ' + vdur + 's');

  // 时间轴：拿 whisper 分段，本地词重叠给每句配段
  let segs = null;
  try {
    const rr = await fetch('http://127.0.0.1:8787/stt-ts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: vurl, lines: [] }) });
    const jj = await rr.json();
    const pool = (jj && jj.ok && jj.pool ? jj.pool : [])
      .map((x, k) => ({ i: k + 1, s: +x.s || 0, e: +x.e || 0, text: String(x.t || '').trim() }))
      .filter(x => x.text.length > 2 && x.e > x.s);
    log('  拿到 ' + pool.length + ' 段原文');
    if (pool.length >= lines.length) {
      const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
      const bag = s => { const m = new Map(); norm(s).forEach(w => m.set(w, (m.get(w) || 0) + 1)); return m; };
      const sim = (a, b) => {
        const A = bag(a), B = bag(b);
        let hit = 0, total = 0;
        A.forEach((n, w) => { total += n; hit += Math.min(n, B.get(w) || 0); });
        return total ? hit / total : 0;
      };
      // 台词是按顺序念的，配到的段也必须递增。贪心会撞车（第3、4 句时间重叠就是这么来的），
      // 这里用 DP：dp[i][j] = 前 i 句配到前 j 段里的最大总吻合度。
      const n = lines.length, m = pool.length;
      const S = [];
      for (let i = 0; i < n; i++) {
        S.push([]);
        for (let j = 0; j < m; j++) S[i].push(sim(lines[i], pool[j].text));
      }
      const NEG = -1e9;
      let dp = new Array(m).fill(0);
      const back = [];
      for (let i = 0; i < n; i++) {
        const nd = new Array(m).fill(NEG);
        const bk = new Array(m).fill(-1);
        for (let j = 0; j < m; j++) {
          if (i === 0) { nd[j] = S[0][j]; bk[j] = -2; continue; }
          // 前一句必须落在 j 之前
          let bestPrev = NEG, bestK = -1;
          for (let k = 0; k < j; k++) { if (dp[k] > bestPrev) { bestPrev = dp[k]; bestK = k; } }
          if (bestK >= 0) { nd[j] = bestPrev + S[i][j]; bk[j] = bestK; }
        }
        back.push(bk);
        dp = nd;
      }
      let bestJ = -1, bestV = NEG;
      for (let j = 0; j < m; j++) if (dp[j] > bestV) { bestV = dp[j]; bestJ = j; }
      const picked = new Array(n).fill(null);
      if (bestJ >= 0) {
        let j = bestJ;
        for (let i = n - 1; i >= 0; i--) {
          picked[i] = { s: pool[j].s, e: pool[j].e, sc: S[i][j] };
          j = i > 0 ? back[i][j] : -1;
          if (i > 0 && j < 0) { picked.fill(null); break; }
        }
      }
      if (picked.every(Boolean)) {
        // 起点用匹配段，长度用页面示范音的真实时长（whisper 的段尾经常偏短）
        segs = picked.map((x, i) => {
          const len = (lens[i] && lens[i] > 1) ? lens[i] : Math.max(1, x.e - x.s);
          return [x.s, x.s + len];
        });
        log('  本地配段 OK（平均吻合 ' + (picked.reduce((a, b) => a + b.sc, 0) / picked.length).toFixed(2) + '），长度用示范音');
      } else {
        log('  本地配段有缺口，退回均分');
      }
    }
  } catch (e) { log('  时间轴失败：' + (e && e.message || e)); }
  if (!segs) {
    const d = typeof vdur === 'number' && vdur > 5 ? vdur : 50;
    segs = lines.map((_, i) => [d * i / lines.length, d * (i + 1) / lines.length]);
    log('  用均分兜底');
  }
  log('  时间轴 ' + segs.map(x => x[0].toFixed(1)).join(' / '));

  const CAP = 12;           // 单句硬上限，超过就不要了
  const got = [];
  for (let i = 0; i < lines.length; i++) {
    const sgLen = Math.max(0.4, (segs && segs[i] ? segs[i][1] - segs[i][0] : (lens[i] || 5)));
    const rate = 1;   // 原速。变速会让评分的时间轴对不上，后半句直接判没读

    // 一句一清：页面会把旧流 stop 掉，sink 也要指向本轮新建的节点
    await ev("(function(){window.__dubSink=null;window.__dubStream=null;if(window.__potatoDub&&window.__potatoDub.gum)navigator.mediaDevices.getUserMedia=window.__potatoDub.gum;return 1})()");

    const posRaw = await ev("(function(){var its=[].slice.call(document.querySelectorAll('.question-video-dub-pc .item'));var it=its[" + i + "];if(!it)return 'null';var b=it.querySelector('.record-icon.button-record');if(!b)return 'null';b.scrollIntoView({block:'center'});var r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()");
    if (!posRaw || posRaw === 'null' || posRaw.__err) { log('  第' + (i + 1) + ' 句 找不到录音按钮'); continue; }
    await sleep(450);
    const pos = JSON.parse(await ev("(function(){var its=[].slice.call(document.querySelectorAll('.question-video-dub-pc .item'));var b=its[" + i + "].querySelector('.record-icon.button-record');var r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()") || 'null');

    const t0 = Date.now();
    await clickAt(pos.x, pos.y);          // 只点这一次

    // 等页面把音频图接好
    let sink = 0;
    for (let k = 0; k < 40; k++) { await sleep(250); sink = await ev("window.__potatoDub && window.__potatoDub.sink() ? 1 : 0"); if (sink) break; }

    // 这一段的时间区间，播进去
    const sg = segs[i];
    const rawLen = Math.max(0.4, sg[1] - sg[0]);
    await ev("window.__potatoDub.range(" + sg[0] + "," + (sg[0] + rawLen) + ")");
    const pd = await ev("(function(){try{return window.__potatoDub.play(false,0," + rate + ")}catch(e){return -1}})()");
    await sleep(400);
    const lvl = await ev("window.__potatoDub.level ? window.__potatoDub.level() : -1");

    log('  第' + (i + 1) + '/' + lines.length + ' 句 ' + sg[0].toFixed(1) + '-' + (sg[0] + rawLen).toFixed(1) + 's'
      + (rate > 1.01 ? ' ×' + rate.toFixed(2) : '') + ' sink=' + sink + ' 播=' + pd + ' 电平=' + lvl);

    // 等页面自己到点停（约 5 秒）并评分；这期间绝不点第二次
    // 原速播完整句，页面录完自己会停
    await sleep(Math.round((typeof pd === 'number' && pd > 0 ? pd : sgLen) * 1000) + 2400);

    let sc = '';
    for (let k = 0; k < 16; k++) {
      sc = await ev("(function(){var its=[].slice.call(document.querySelectorAll('.question-video-dub-pc .item'));var it=its[" + i + "];if(!it)return '';var m=String(it.textContent||'').match(/准确度[：:]\\s*(\\d+)/);return m?m[1]:''})()");
      if (sc && !sc.__err) break;
      await sleep(500);
    }
    await ev("window.__potatoDub.stopAudio()");

    const cp = await ev("(function(){var b=[].slice.call(document.querySelectorAll('.ant-modal-wrap button')).find(function(x){return /确定/.test(String(x.textContent||''))});if(!b)return 'none';var r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()");
    if (cp && cp !== 'none' && !cp.__err) { try { const q = JSON.parse(cp); await clickAt(q.x, q.y); await sleep(500); } catch (e) {} }

    if (sc && !sc.__err) got.push(i);
    log('  第' + (i + 1) + '/' + lines.length + ' 句 ' + (sc && !sc.__err ? '准确度 ' + sc : '没见评分') + '（' + ((Date.now() - t0) / 1000).toFixed(0) + 's）');
    await sleep(800);
  }

  log('配音结束：' + lines.length + ' 句都点过，' + got.length + ' 句拿到分');
  if (got.length < lines.length) log('没分的：' + lines.map((_, i) => got.indexOf(i) < 0 ? i + 1 : 0).filter(Boolean).join('/'));
  close();
}

main().catch(e => { log('出错：' + (e && e.message || e)); process.exit(1); });
