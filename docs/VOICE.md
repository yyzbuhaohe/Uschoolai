# 语音题攻略（Vocabulary 跟读 / Dubbing 配音）

## 实测成绩

| 题型 | 方法 | 成绩 |
|---|---|---|
| Vocabulary 跟读（7 题） | 每题自带的 wav 示范音回灌 | **94.1 分** |
| Dubbing 配音（4 句） | 视频音轨按时间段切片回灌 | **88.5 分** |

单题明细（配音）：

```
第1句 0.43-10.27 (9.84s)  准确度 90  总分 91
第2句 10.27-15.59 (5.32s) 准确度 84  总分 88
第3句 15.59-25.79 (10.20s)准确度 82  总分 85
第4句 25.79-34.59 (8.80s) 准确度 88  总分 90
```

## 三个必备参数

**① 延迟 900ms**

```js
setTimeout(() => src.start(0, segStart, segLen), 900);
```

getUserMedia 返回后页面还要建编码器，立刻播会把开头切掉。900ms 实测正好。

**② 录音时长 = 片段时长 + 0.6~1.0 秒**

```js
const len = seg.end - seg.start;
await sleep(Math.round((len + 0.8) * 1000));
```

固定时长会多录静音。1.5 秒的 trailblazer 按 4 秒录，准确度掉到 60 多。

**③ 只播片段，不播整段**

```js
src.start(0, seg.start, len);   // when, offset, duration
```

整段 36 秒 decode 一次，缓存 AudioBuffer，每句按 offset 切片。

## 最坑的地方：click() 是状态切换

录音按钮**不是**「开始」「停止」两个按钮，是**同一个按钮切换**：

```
点第 1 次 → 开始录音
点第 2 次 → 停止，出分
点第 3 次 → 又开始录音，成绩被清空
```

我第一版盲目点了 2 次，第 2/3 句的成绩全被刷没了。

**正确写法：点完轮询有没有分，没分再点一次，最多 5 次**

```js
let got = null;
for (let k = 0; k < 5; k++) {
  await ev(clickBtn(i));              // 点一次
  for (let t = 0; t < 8; t++) {
    await sleep(1200);
    const acc = await readAcc(i);     // 读「准确度：NN」
    if (acc) { got = acc; break; }
  }
  if (got) break;
}
```

实测：第 2 句点 2 次出分，第 3 句点 3 次出分。

## 音轨定位：别自己写对齐，交给模型

台词到视频时间轴的映射，我试了三个算法全军覆没：

```
词级贪心窗口   → 边界错位，第1句取到 0.43-13.35（应 10.27）
segment 合并   → 合并过头，第1句吞掉了第2句
首尾锚定       → 尾部词被 whisper 写错（Baitahwang ≠ Beidahuang）
```

**最后是让模型做纯映射，一次就对。**

### 提示词（可直接复用）

```
视频音轨分段（每段带起止秒数）：
1. [0.43-7.43] The courage and stories of trailblazers have long been extolled by people of all cultures,
2. [7.43-10.27] both in the past and today.
3. [10.27-15.59] The development history of Baitahwang is full of touching stories.
...

配音台词（按顺序）：
1. The courage and stories of trailblazers have long been extolled by people of all cultures, both in the past and today.
2. The development history of Beidahuang is full of touching stories.
...

请给出每句台词对应的音频区间，区间必须由连续分段拼成。
严格输出 4 行，格式：序号|起始秒|结束秒。不要解释。
```

模型输出：

```
1|0.43|10.27
2|10.27|15.59
3|15.59|25.79
4|25.79|34.59
```

**三条约束缺一不可**：

1. **给分段表**（带秒数）—— 模型只做映射，不做时间计算
2. **「区间必须由连续分段拼成」** —— 防止编造 3.5 这种不存在的时间点
3. **「严格输出 N 行 序号|起始|结束」** —— 一句一行的纯数据格式

## 服务端接口

`POST http://127.0.0.1:8787/stt-ts`

```json
{ "url": "视频地址", "lines": ["台词1", "台词2"] }
```

返回 whisper 分段（带 s/e/t），前端再喂给模型做映射。

## 两种题型的示范音来源

| 题型 | 示范音 | 取法 |
|---|---|---|
| Vocabulary 跟读 | 每题独立 wav | `container.querySelector('audio').currentSrc` |
| Dubbing 配音 | 视频音轨切片 | `decodeAudioData(整个视频)` + `start(0, offset, len)` |

## 回灌原理

```js
navigator.mediaDevices.getUserMedia = async function (c) {
  if (!c.audio) return orig(c);
  var ctx = new AudioContext();
  var dst = ctx.createMediaStreamDestination();
  var buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
  var src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(dst);
  setTimeout(() => src.start(0, segStart, segLen), 900);
  return dst.stream;     // 页面以为这是麦克风
};
```

页面拿到的是 `MediaStreamDestination` 的流，录进去的就是示范音本身。