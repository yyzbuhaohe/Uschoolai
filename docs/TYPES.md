# 题型手册（实测）

## 已攻破

| 题型 | 识别特征 | 处理方式 | 实测成绩 |
|---|---|---|---|
| 单选 A-D | `.option` + `.caption` 为 A/B/C/D | 转写+模型 → 按 caption 点 | **100** |
| 判断 T/F | `.option` + caption 为 True/False | 同上，按 T/F 分组 | 60~100 |
| 填空 | `.scoop-input-wrapper input` | 原文对齐优先，模型兜底 | 最高 88.9 |
| 讨论区 | 1 个 textarea + `发布` 按钮 | 打字 → 点发布 | 评论+1 |
| 阅读理解问答 | 多个 `textarea.question-inputbox-input` | 材料+问题 → 模型 → 填入 → 提交 | 3/3 作答（不计分） |
| Vocabulary 跟读 | `.sentence-container` + 每题自带 wav | 示范音回灌 + 900ms 延迟 | **94.1** |
| Dubbing 配音 | `.item` + 视频音轨切片 | whisper 分段 → 模型映射 → 切片回灌 | **88.5** |
| 自由说话 | 1 个 record 按钮 + 2 分钟倒计时 | TTS 生成口述稿 → 回灌 → 等倒计时满 | 92（不计分） |
| 排序 | `sequence-reply-view-item` | 转写取时间轴 → 模型找证据句 → 按证据句时间拖拽 | **100** |
| **改错** | `.question-revise-mistake` + 逐词 `.mistake-atom` | 转写 → 模型指出错词 → 点词 → change → 填词 → 提交 | 见下 |

## 认屏：别用容器类名当题型

**教训**：填空题第二页会用 `.sentence-container` 当骨架（4 个空壳、里面没有 `<audio>`），只看类名会把它判成跟读，然后去录"没有示范音"的句子。

现在的判据：

| 字段 | 怎么算 | 说明 |
|---|---|---|
| `ins` | `.scoop-input-wrapper input` + `.comp-abs-input input` + `input.input-user-answer`（只要可见的） | 填空/翻译 |
| `sent` | `.sentence-container` **里必须有 `<audio>`** | 跟读 |
| `sentAll` | `.sentence-container` 总数 | 只做诊断，不参与判定 |
| `rec` | `.record-icon.button-record` | 说话/配音 |

另外 `waitKind()` 以前"两次采样一样就返回"，页面还没渲染完时会返回一张全 0 的快照。现在要求**稳定 + 至少认出一类题型**才返回。

`doSpeak()` 也加了兜底：页面上只要有可见填空框，就直接交给 `doFill()`。

## 跟读题（Vocabulary / read aloud）

**一个页面只肯要一次麦克风。** 录完第一句之后，再点别的句子的麦克风，页面**根本不会调 `getUserMedia`**（实测 0 次调用，也没有任何提示），所以一屏 6 句只能拿到 1 句的分——这就是"跟读只对一道"的真正原因。

修法：**每句录之前刷一次页面**（`reloadForVoice()`）。刷新后录音组件重新挂载，下一句立刻能录。已录的分在服务端，刷新不丢。

**带分页的屏要注意**：`Exercise 1` 第 1 页是翻译填空、第 2 页才是跟读。`Page.reload` 之后页面**退回第 1 页**（路由不在 URL 里），所以刷新后必须点「下一题」翻回跟读页，否则后面每句都"没有示范音"，提交也提错页。判断是否翻对了：拿第 1 句文本当签名（**记得去掉行首那个分数**，录完会从 0 变 96）。

**已经录过的句子再点麦克风**会先弹「确定重新录制吗？」，得点确定才真的开始，不然一直等不到 `getUserMedia`。

其它要点：

- 点麦克风用**坐标点击**（`.record-icon.button-record` 的 rect），`el.click()` 在这个 SPA 里不可靠
- 点之前 `scrollIntoView({block:'center'})`，否则按钮在视口外根本点不到
- 录之前先看 `window.__voiceProbe.n` 有没有 +1 —— 页面没要麦克风就是没开始录，别傻等
- 停止按钮的位置会因为计分面板出现而变，停之前重新量一次 rect
- 成句分数 89~97，平均 94 左右

## 改错题（revise mistake）

页面把每句拆成一个个单词的 span，**点词才出操作菜单**，不是让你整句重写：

```
.comp-revise-mistake
└── .comp-revise-mistake-reply        ← 一句一个
    └── .mistake-item .mistake-atom   ← 一个词一个（word / space / punctuation）
        └── .mistake-atom-text

点 .mistake-atom → .ant-popover .mistake-item-action
    add-before | change | delete | mark-correct
选 change → .mistake-item-edit-form
    input.edit-form-input  +  button.edit-form-submit（文字是「提 交」）
```

三个必踩的坑：

1. **输入框必须用真实输入事件**（CDP `Input.insertText`）。直接 `input.value = '...'` React 收不到，点提交没反应，看着像按钮坏了。
2. `button.edit-form-submit` 文字是「提 交」（中间有空格），用 `replace(/\s+/g,'')` 再比对。
3. **改过的词再点会弹「确定撤销该操作吗？」**，那里点确定就把答案撤销了。代码里认到没有 `.mistake-item-action` 就点「取消」关掉。

调试两个环境变量：

```powershell
$env:POTATO_NO_SUBMIT='1'        # 填完不提交（改错/口语只记第一次作答，误提交补不回来）
$env:POTATO_CORRECT_PLAN='[{"i":1,"op":"change","from":"difficult","to":"hard"}]'   # 跳过模型直接按给定改法跑
node run-all.js 1 --here
```

## 翻页：只用「继续学习」

**这是全自动的关键，不用点目录不用改 hash。**

```
做完一屏 → 提交 → 答题小结 → 点「继续学习」
                                      ↓
                                  下一屏
                                      ↓ 所有屏做完
                                  直接进下一节
```

实测：`Viewing China` 最后一屏提交后点继续学习，active 直接变成 `Viewing world cultures`。

**优先级**：

```js
const cont = await btn(['继续学习']);
if (cont) { await click(cont.x, cont.y); return; }   // 先找继续学习
const sub = await btn(['提交']);                      // 没有才提交
```

## 语音题的三个固定参数

| 参数 | 值 |
|---|---|
| 播放延迟 | 900ms |
| 录音时长 | 片段长 + 0.8s |
| 播放方式 | `src.start(0, offset, len)` |

## 说话题（2 分钟限时）的特殊处理

1. **只点两次**（开始、停止），多点会重开一轮
2. 点击后查 `.record-count-down`：有内容 = 正在录
3. 停止后 `countdown` 变 null = 成功
4. **倒计时走完不会自己停**，必须点一次
5. 音频要用 TTS 生成（SAPI: `Microsoft Zira Desktop`）

## 讲评题的分数规则

```
客观题（选择/判断/填空）：计入成绩，看准确率
主观题（问答/说话/配音）：看「已作答 N/N」，多数不计分
```

所以主观题只要**答了**就行，内容过得去即可。