/* dub-hook.js —— 配音题（视频逐句配音）的"假麦克风"
 *
 * 页面怎么录：getUserMedia → createMediaStreamSource → RecorderJS(ScriptProcessor) → MP3
 * 点录音后 15 秒收不到 PCM 就弹「录音启动超时」。
 *
 * 六条必须同时满足，少一条就超时：
 *   1. 钩子要在页面脚本之前装（potato-watch 用 addScriptToEvaluateOnNewDocument，
 *      或 dub.js 自己在点录音前注入）
 *   2. createMediaStreamSource 要换成自己造的节点，并挂一条 gain=0 的静音支路到
 *      destination —— 不挂 destination，整条音频图不渲染，ScriptProcessor 收不到采样
 *   3. 每次 getUserMedia 都给新流：页面录完一句会 getTracks().forEach(t => t.stop())
 *   4. 音频源用 captureStream()，不能用 createMediaElementSource ——
 *      后者一个元素只能建一次，且绑死建它的 AudioContext，页面每句都换 ctx
 *   5. 播放的元素要 muted=true + volume=0，否则 play() 被 autoplay 策略拒绝
 *   6. 点第二次"停止"会把状态搞成重新开始 —— 让页面自己到点停
 */
(function () {
  if (window.__potatoDub && window.__potatoDub.ver === 9) return;
  window.__potatoDub = null;

  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;

  var P = AC.prototype;
  window.__acList = window.__acList || [];

  // ---- 页面的 AudioContext 一建出来就让它跑 ----
  if (!window.__acWrapped) {
    window.__acWrapped = 1;
    var W = function () {
      var c = new AC();
      window.__acList.push(c);
      var kick = function () { try { if (c.state !== 'running') c.resume(); } catch (e) {} };
      kick(); setTimeout(kick, 50); setTimeout(kick, 300); setTimeout(kick, 1200);
      return c;
    };
    W.prototype = AC.prototype;
    window.AudioContext = W;
    window.webkitAudioContext = W;
  }

  // ---- 拦 createMediaStreamSource ----
  if (!window.__origCMS) window.__origCMS = P.createMediaStreamSource;
  P.createMediaStreamSource = function (stream) {
    if (window.__dubStream && stream === window.__dubStream) {
      var node = this.createGain();
      node.gain.value = 1;
      try {
        var mute = this.createGain();
        mute.gain.value = 0;
        node.connect(mute);
        mute.connect(this.destination);   // 关键，不接这里整条链不渲染
      } catch (e) {}
      window.__pageCtx = this;
      window.__dubSink = node;
      return node;
    }
    return window.__origCMS.apply(this, arguments);
  };

  var ctx = new (window.AudioContext || AC)();
  var buf = null, bufUrl = '', cur = null;

  var md = navigator.mediaDevices;
  var origGum = md.getUserMedia ? md.getUserMedia.bind(md) : null;
  md.getUserMedia = async function (c) {
    if (!c || !c.audio) return origGum ? origGum(c) : Promise.reject(new Error('no audio'));
    try { await ctx.resume(); } catch (e) {}
    // 每次新流：页面录完一句会把旧流的 track 全 stop 掉
    window.__dubStream = ctx.createMediaStreamDestination().stream;
    return window.__dubStream;
  };

  // ---- 页面自带的示范音 ----
  function audioEls() {
    var scope = [].slice.call(document.querySelectorAll('.question-video-dub-pc .item audio'));
    if (!scope.length) scope = [].slice.call(document.querySelectorAll('.question-video-dub-pc audio'));
    if (!scope.length) scope = [].slice.call(document.querySelectorAll('audio'));
    return scope.filter(function (a) { return a && a.src && a.duration > 0.5 && isFinite(a.duration); });
  }


  // ---- 主路径：把视频解成 AudioBuffer，切片后直接连到 sink ----
  // 这条路实测能拿 77 / 83 分。captureStream 那条别用了，中间多一跳不可靠。
  function playRange(loop, lead, rate) {
    try { if (cur) { cur.stop(); cur.disconnect(); cur = null; } } catch (e) {}
    if (!buf) return -1;
    var c = window.__pageCtx, sink = window.__dubSink;
    if (!c || !sink) return -2;
    var g = window.__dubRange || [0, 3];
    var s = g[0], e = g[1], dur = Math.max(0.4, e - s);
    var pre = Math.max(0, Number(lead) || 0);
    var rt = Number(rate) || 1;
    if (rt < 0.5 || rt > 4) rt = 1;
    var sr = c.sampleRate, ratio = buf.sampleRate / sr;
    var seg = c.createBuffer(buf.numberOfChannels, Math.ceil((pre + dur) * sr), sr);
    var off = Math.floor(s * buf.sampleRate);
    var base = Math.floor(pre * sr);
    for (var ch = 0; ch < buf.numberOfChannels; ch++) {
      var sd = buf.getChannelData(ch), d = seg.getChannelData(ch);
      for (var i = 0; i < Math.ceil(dur * sr) && base + i < d.length; i++) {
        d[base + i] = sd[off + Math.floor(i * ratio)] || 0;
      }
    }
    var node = c.createBufferSource();
    node.buffer = seg;
    node.loop = !!loop;
    if (rt > 1.01) { try { node.playbackRate.value = rt; } catch (e) {} }
    node.connect(sink);
    node.start();
    cur = node;
    return Math.round(((pre + dur / rt) * 100)) / 100;
  }

  window.__potatoDub = {
    ver: 9,
    gum: md.getUserMedia,

    // 页面会动态增删 <audio>，开场快照一份，后面一直用这批引用
    snapshotAudio: function () {
      window.__dubAudios = audioEls();
      return JSON.stringify(window.__dubAudios.map(function (a) { return Math.round(a.duration * 100) / 100; }));
    },

    // 让它响起来（静音播放，才有音轨）
    startAudio: function (idx, rate) {
      var el = (window.__dubAudios || audioEls())[idx];
      if (!el) return -1;
      var rt = Number(rate) || 1;
      if (rt < 0.5 || rt > 4) rt = 1;
      try { el.pause(); } catch (e) {}
      try { el.currentTime = 0; } catch (e) {}
      try { el.muted = true; } catch (e) {}
      try { el.volume = 0; } catch (e) {}
      try { el.playbackRate = rt; } catch (e) {}
      try { var pr = el.play(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) {}
      window.__dubAudioEl = el;
      return Math.round((el.duration / rt) * 100) / 100;
    },

    // 把示范音接进页面音频图的 sink
    bindAudio: function (idx) {
      var c = window.__pageCtx, sink = window.__dubSink;
      if (!c || !sink) return -2;
      var el = (window.__dubAudios || audioEls())[idx];
      if (!el) return -1;
      try {
        var cap = el.captureStream ? el.captureStream() : (el.mozCaptureStream ? el.mozCaptureStream() : null);
        if (!cap || !cap.getAudioTracks || cap.getAudioTracks().length === 0) return 'NOTRACK';
        if (window.__dubAudioNode) { try { window.__dubAudioNode.disconnect(); } catch (e) {} }
        var node = c.createMediaStreamSource(cap);
        node.connect(sink);
        window.__dubAudioNode = node;
        window.__dubAudioEl = el;
        return Math.round(el.duration * 100) / 100;
      } catch (e) { return 'ERR ' + e.message; }
    },

    // 录到的电平，用来判断到底有没有声音
    level: function () {
      var c = window.__pageCtx, sink = window.__dubSink;
      if (!c || !sink) return -1;
      if (!window.__dubAn) {
        window.__dubAn = c.createAnalyser();
        window.__dubAn.fftSize = 2048;
        window.__dubBuf = new Float32Array(2048);
        sink.connect(window.__dubAn);
      }
      window.__dubAn.getFloatTimeDomainData(window.__dubBuf);
      var s = 0;
      for (var i = 0; i < window.__dubBuf.length; i++) s += window.__dubBuf[i] * window.__dubBuf[i];
      return Math.round(Math.sqrt(s / window.__dubBuf.length) * 1000) / 1000;
    },

    stopAudio: function () {
      try { if (window.__dubAudioEl) window.__dubAudioEl.pause(); } catch (e) {}
      try { if (window.__dubAudioNode) { window.__dubAudioNode.disconnect(); window.__dubAudioNode = null; } } catch (e) {}
      return 1;
    },

    load: async function (u) {
      if (bufUrl === u && buf) return Math.round(buf.duration * 100) / 100;
      var r = await fetch(u, { mode: 'cors', credentials: 'omit' });
      var ab = await r.arrayBuffer();
      buf = await ctx.decodeAudioData(ab);
      bufUrl = u;
      return Math.round(buf.duration * 100) / 100;
    },
    range: function (s, e) { window.__dubRange = [s, e]; return 1; },
    play: function (loop, lead, rate) { return playRange(loop, lead, rate); },
    stop: function () { try { if (cur) { cur.stop(); cur.disconnect(); cur = null; } } catch (e) {} return 1; },

    sink: function () { return !!window.__dubSink; },
    state: function () { return ctx.state; },
    acStates: function () { return (window.__acList || []).map(function (c) { return c.state; }).join(','); }
  };
})();
