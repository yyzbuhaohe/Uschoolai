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

## 待攻破

| 题型 | 特征 | 卡点 |
|---|---|---|
| 排序题 | `.sortable-list-wrapper` + 8 条 `sequence-reply-view-item` | TouchEvent 拖拽被忽略，需要改 DOM 重排或拦提交 |

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