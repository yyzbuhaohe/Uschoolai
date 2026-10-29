# 排序题 / 匹配题 攻坚记录

## 排序题：已攻破

### 无效做法

```js
// 合成 TouchEvent 全套
new TouchEvent('touchstart', { touches: [new Touch({...})] })
new TouchEvent('touchmove', ...)
new TouchEvent('touchend', ...)
// 结果：DOM 顺序纹丝不动
```

### 有效做法：CDP 真实鼠标事件

```js
Input.dispatchMouseEvent({ type: 'mouseMoved', x, y })
Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', buttons: 1 })
// 分 12 步移动，每步都要带 button:'left', buttons:1
Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', buttons: 0 })
```

**两个关键点**：

1. `buttons: 1` 在 mouseMoved 阶段必须带 —— 表示左键处于按下状态，组件才认作拖拽
2. 分段移动（12 步，每步 55ms）—— 一步到位会被当成点击

### 组件绑定的事件

hook `addEventListener` 拿到：

```
touchstart, touchmove, touchend, touchcancel
mousedown, mousemove, mouseup
keydown
```

挂在 `.sortable-list-wrapper` 上，鼠标和触摸都支持，但合成事件不被接受，只认 `isTrusted: true`。

### 全量排序：逐个归位

```js
for (let t = 0; t < want.length; t++) {
  const cur = 当前顺序;
  const pos = cur.indexOf(want[t]);
  if (pos === t) continue;
  await drag(pos, t);      // 把 pos 位拖到 t 位
}
```

实测 8 条全部归位：`4→0 ok 7→1 ok 4→2 ok 4→3 ok 6→4 ok`。

### 准确率问题

拖拽机制通了，但**顺序判断只有 3/8**（37.5 分）。

原因是这题给的是 8 段**总结性陈述**，不是原话。模型看转写文本只能猜。

要提准确率，得像配音题那样把每条陈述**映射回视频时间点**，再按时间排。

## 匹配题：未攻破

### 题目形态

```
Directions: match the people to the statements

1. I'm always up for new things... A.
2. If you try new things... B.
3. Depends what they are... C.
4. I always enjoy trying new things... D.
5. I love to try new things... E.
```

每条语句后面跟一个字母槽位。

### 已排除

| 试过的 | 结果 |
|---|---|
| `select` 元素 | 0 个 |
| `.ant-select` / `.ant-dropdown-trigger` | 0 个 |
| 点击 `span.A.`（坐标 1013,294） | 页面无变化 |
| `input` 元素 | 0 个 |

### 下一步

1. hook `addEventListener` 看槽位绑了什么事件
2. 查 React props 里有没有 onClick
3. 试整行点击（不是点字母）
4. 查是否有 canvas / 自定义绘制

## 填空：90 分（10 空 9 对）

### 关键修复：多空段落

同一段落有多个空时，原来把段落里**第一个空**反复标记，导致 3 个空生成 3 条相同语句。

```js
// 错：总是标第一个
ws[0].replaceWith(' __BLANK__ ')

// 对：标当前空
const idx = orig.indexOf(w);
ws[idx].replaceWith(' __BLANK__ ')
```

修完后每个空的题干都独立了。

### 流程

```
转写视频 → 原文对齐（3/10 命中）→ 模型补剩下 7 个 → 填入
提交 → 90分（9/10）
```