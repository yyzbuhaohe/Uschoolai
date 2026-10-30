# 交接文档

写给下一个接手这个项目的人（或者下一个会话里的我）。

读完这份，应该能直接上手改代码，不用重新踩一遍坑。

最后更新：2026-10（v1.1 环境/安装器大修，见第十一节）

---

## 一、这项目是干什么的

U 校园（ucontent.unipus.cn）新视野大学英语的课后题自动做。浏览器驱动 + 本地服务 + 大模型。

不是改 DOM 硬点，是像一个真人一样开浏览器、点按钮、录音、提交。

**支持的题型（11 种）**

| 题型 | 识别特征 | 做法 | 实测 |
|---|---|---|---|
| 单选 / 多选 | `.question-option` | 转写 → 模型选 → 按序号点 | 80~100 |
| 判断题 | 选项是 T/F | 同上 | 90+ |
| 填空 | `input.scoop-input` | 本地对原文（`solveBlank`），不够再问模型 | 90+ |
| 下拉选择 | `select` | 模型给序号 | 90+ |
| 排序 | `.question-sort` | 证据句定序 → 拖拽 | 100 |
| 讨论 / 评论 | `.cmt` 输入框 | 生成英文发帖 | 完成即得分 |
| 跟读 | `.sent` | TTS 回灌麦克风 | 88~94 |
| 说话 | 录音按钮 + 提示 | 写口稿 → TTS → 回灌 | 90+ |
| 配音 | `.question-video-dub-pc` | 视频音轨切片 → 逐句回灌 | 82~85 |
| 上传 | `.question-multi-file-upload` | 塞彩蛋 PDF | 完成即得分 |

**匹配题没做**。目前遇到会走兜底分支（大概率瞎点）。

---

## 二、整体架构

```
┌─────────────────────────────────────────────┐
│  ui.html  (控制台, 127.0.0.1:8787)           │
│  土豆面板 (potato-ui.user.js, 页面右下角)     │
└──────────────┬──────────────────────────────┘
               │ HTTP
┌──────────────▼──────────────────────────────┐
│  serve.py   本地服务 :8787                   │
│  - /stt /stt-ts   Whisper 转写（带时间戳）    │
│  - /api/run      起停 run-all.js 子进程       │
│  - /api/state    状态 + 用量                  │
│  - /api/update   从 GitHub 拉最新代码         │
│  - /speak.wav    TTS 产物                    │
└──────────────┬──────────────────────────────┘
               │ 子进程
┌──────────────▼──────────────────────────────┐
│  run-all.js  主控（Node）                     │
│  - 认屏 → 取料 → 问模型 → 填答案 → 提交 → 翻节 │
└──────────────┬──────────────────────────────┘
               │ CDP (WebSocket, :9222)
┌──────────────▼──────────────────────────────┐
│  Chrome / Edge  (--remote-debugging-port=9222)│
│  └─ 课程页面 ucontent.unipus.cn               │
└─────────────────────────────────────────────┘

旁路：
  potato-watch.js  每 2s 扫 CDP，往页面注入 potato-ui.user.js 和 dub-hook.js
  dub.js           配音题单独跑（时序太敏感，塞主循环会互相干扰）
```

### 为什么用 CDP 而不是 Tampermonkey

开发机上 Chrome 的扩展权限被组策略锁了（`chrome://extensions` 显示「您的家长已停用扩展程序权限」），用户脚本注不进去。所以开调试端口，从外面驱动。

副作用是好的：能做用户脚本做不到的事（真实鼠标事件、`DOM.setFileInputFiles`、截图、`Page.reload ignoreCache`）。

---

## 三、代码地图

| 文件 | 行数 | 干什么 |
|---|---|---|
| `run-all.js` | ~950 | 主控。认屏、分派、各题型的答题逻辑、翻节 |
| `dub.js` | ~260 | 配音题独立脚本（run-all 检测到配音屏会 spawn 它） |
| `dub-hook.js` | ~200 | 配音题的音频钩子（假麦克风） |
| `serve.py` | ~700 | 本地服务 |
| `ui.html` | ~230 | 控制台页面 |
| `potato-ui.user.js` | ~470 | 页面右下角的面板（挂在 shadow DOM 里） |
| `potato-watch.js` | ~130 | 注入守护 |
| `keyvault.js` | ~90 | API Key 加解密（AES-256-GCM，密钥绑机器） |
| `potato-farm.user.js` | ~300 | 挂机模块（刷视频时长） |
| `cdp.js` / `ctrl.js` | 小工具 | 手工调试用 |

---

## 四、关键实现细节（血泪）

### 4.1 认屏

```
.pc-header-tab-*        → 顶层 Tab（Before you view / While you view / After you view）
.pc-task                → Tab 下的小屏（Vocabulary / Exercise 1 / Exercise 2）
.pc-slider-menu-micro   → 左侧节列表，带 pc-menu-micro-lock 的是锁住的
```

切 Tab 后**必须校验**：`.pc-header-tab-activity` 的文字对不对得上。曾经出现过"以为切了实际没切"，导致同一屏被处理 3 次（看起来像"一直卡在评论"）。

### 4.2 转写

`POST /stt {url}` → 纯文本
`POST /stt-ts {url, lines}` → 段落 + 词级时间戳

模型 `base.en`，int8 量化，CPU 跑。4 分钟音频约 20~40 秒。

**优先级**：`models/whisper-base.en/` 本地目录 → `hf-mirror.com` → `huggingface.co`。

### 4.3 排序题（100 分的那个）

**别直接让模型排序**。最初这么干，准确率 17 分——模型把语义接近的句子搞混。

现在的做法：

1. 把转写的分段时间戳给模型
2. 让它为每条陈述找一句**证据句**
3. 按证据句的时间戳排序
4. 按顺序拖拽

多一次模型调用，但 4/4 全对。

代码：`run-all.js` 的 `sortByEvidence()`。

### 4.4 口语 / 跟读（假麦克风）

页面的录音链路：

```
getUserMedia → createMediaStreamSource → RecorderJS(ScriptProcessor) → MP3 → 上传评分
```

我们劫持 `getUserMedia`，返回自己造的 `MediaStreamDestination` 流，把 TTS 音频接进去。

**必须注意**：音频节点要挂一条 `gain=0` 的支路到 `destination`。Web Audio 里节点不连到 destination 就不被渲染，ScriptProcessor 一个采样都收不到。

### 4.5 配音题（最麻烦的一块）

**六个坑，少一个就弹「录音启动超时」**：

| # | 坑 | 后果 | 解法 |
|---|---|---|---|
| 1 | `MediaStreamDestination` 的流跨 AudioContext 不产 PCM | 页面收不到数据 | 劫持 `createMediaStreamSource` 返回自己造的 GainNode |
| 2 | Web Audio 节点不连 destination 就不渲染 | ScriptProcessor 零采样 | 接 `gain=0` 静音支路到 destination |
| 3 | 页面每录完一句执行 `stream.getTracks().forEach(t => t.stop())` | 复用同一条流 → 第二句起永久哑 | 每次 gUM 给新流 |
| 4 | 页面每句新建 AudioContext，`createMediaElementSource` 只能建一次且绑死 ctx | 第二句起断链 | 改用 `captureStream()`（实际最后没用到，见下） |
| 5 | `el.play()` 在 evaluate 里被 autoplay policy 拒 | 元素没播 → 没音轨 | `muted=true` + `volume=0` |
| 6 | 录音器是组件 init 时建的，事后劫持 gUM 已经晚 | 钩子无效 | `Page.addScriptToEvaluateOnNewDocument` 页面加载前注入 |

**最终方案**（`dub.js` + `dub-hook.js`）：

1. **不劫持页面自带的示范音**（试过，captureStream 那条路不稳），而是**自己解视频**
2. `fetch(视频URL) → decodeAudioData → AudioBuffer`
3. 用 whisper 分段 + **本地词重叠匹配**（DP，带顺序约束）给每句台词配时间段
4. 长度用**页面示范音的 duration**（比 whisper 段尾准）
5. 切出片段 → `AudioBufferSourceNode.connect(sink)`（当初拿 77/83 分的那条路）
6. **原速播放，不能加速**——加速会让评分引擎的时间轴对不上，后半句被判没读
7. **点一次录音就不再点**——页面到点（约 5 秒？实测能录 10 秒）自己停并评分，再点会变成"重新开始"

**当前成绩**：5 句通常 4 句 82~85，偶尔一句掉到 40 出头（配段起点偏了，见待办）。

### 4.6 提交

- 提交前要处理确认弹窗（「仅记录第一次作答的得分，确定提交吗？」）
- `unblock()` 只摘"僵尸遮罩"（`ant-modal-wrap` 卡在 `ant-fade-leave`），**不能摘真弹窗**——曾经把确认框摘掉，导致提交失败
- 判断"僵不僵"：看弹窗里有没有「确定 / 确认 / 保存」

### 4.7 面板遮挡

土豆面板在右下角，会盖住页面元素导致点击丢失。

解法：点击前给 `#potato-root` 加 `p-pass` 类（`pointer-events: none`），点完移除。

### 4.8 面板自己被当成题目

面板里有 textarea，会被 `kind()` 当成"评论框"。

解法：面板挂进 **shadow DOM**，页面 `querySelectorAll('textarea')` 查不到。

---

## 五、怎么调试

### 看当前状态

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/state | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:8787/api/usage | ConvertTo-Json
```

### 只看当前这一屏

```powershell
node run-all.js 1 --here
```

`--here` 只处理当前 Tab 的当前小题，不遍历整节。调试用，省时间。

### 在页面里执行任意 JS

```powershell
$env:CDP_MATCH='ucontent'
node cdp.js eval 某个脚本.js
```

### 页面状态检查清单

```js
// 钩子在不在
window.__potatoDub && window.__potatoDub.ver

// 音频图接好没
window.__potatoDub.sink()

// 录到的电平（判断有没有声音）
window.__potatoDub.level()

// 页面自带的示范音
window.__potatoDub.snapshotAudio()
```

### 日志

`run-all.log` —— 主日志，面板和控制台都读它
`logs/potato-watch.log` —— 注入守护的日志

---

## 六、环境与部署

### 依赖

- Node.js（`run-all.js`）
- Python 3.11 / 3.12（**3.13+ 装不上 faster-whisper**）
- Chrome 或 Edge
- DeepSeek API Key

### 一键装

`install.cmd` 会：
1. 找 Node（没有就 winget 装）
2. 找 Python（没有就下载 3.12.7 静默装，华为云镜像）
3. pip install faster-whisper
4. 找/下 Whisper 模型
5. 把解释器绝对路径写进 `py.path` / `node.path`
6. 建桌面快捷方式

**`py.path` 是关键**：装完 PATH 常常要重开窗口才刷新，`serve.cmd` 靠这个文件直接调解释器，不依赖 PATH。

### 模型包

`whisper-base.en.zip`（127 MB），解压到 `models\` 下，安装脚本会自动认。

### 编码规矩（踩过）

- `.ps1` 必须 **UTF-8 带 BOM**，否则 PowerShell 5.1 按 GBK 读会报语法错误
- `.cmd` 必须**纯 ASCII**，写中文在别人机器上必乱码（即使加了 `chcp 65001`）
- `control.json` 可能有 BOM，读的时候 `.replace(/^\uFEFF/, '')`

---

## 七、已知问题 / 待办

### 高优先

**配音题配段偏差**
5 句里偶尔有一句掉到 40 出头，因为 whisper 分段和实际朗读位置差几十毫秒到半秒。
改法：用页面示范音的时长反推起点，或者对同一句做多段候选打分。

### 中优先

**匹配题没实现**
遇到 `.question-match` 之类会走兜底分支。需要先摸清 DOM 结构。

**排序题对改写敏感**
陈述被大幅改写（不是原文复述）时，证据句可能找偏，掉到 60 左右。

### 低优先

- 选择题：题目本身有歧义时会错
- 口语题：页面只认第一次作答，录坏了覆盖不了

---

## 八、发布相关

### GitHub

https://github.com/yyzbuhaohe/Uschoolai

### 更新机制

控制台「检查更新」→ `POST /api/update` → 从 GitHub 拉 zip 覆盖。

保护：
- 只动代码和文档，`control.json` / `state.json` / `usage.json` / `logs` 一律不碰
- 覆盖前备份到 `.bak-update/`
- **版本门**：远端 `version.json` 的 `build` 不比本地新就拒绝（防止把新功能刷回旧版）
- 远端没有 `version.json` 也拒绝（不知道谁新谁旧）

### 发布时排除

`.dev/ logs/ control.json state.json usage.json py.path node.path *.log *.wav .bak-update/ .github/`

### 用量

DeepSeek 现价：输入 2 元/百万 token，输出 8 元/百万。

实测一册（约 160 屏）**0.5~1 元**。控制台能看到实时数字。

---

## 九、坑速查表

| 现象 | 可能原因 |
|---|---|
| 「录音启动超时」 | 钩子没注入 / 音频节点没挂 destination / 流被 stop 过 |
| 点提交没反应 | 确认弹窗被 `unblock()` 误删了 |
| 面板挡住点击 | 没加 `p-pass` |
| 面板文字被当成答案 | 面板没挂 shadow DOM |
| `control.json` 读不出来 | BOM |
| `install.ps1` 语法错误 | BOM 丢了 |
| `.cmd` 乱码 | 里面写了中文 |
| 第二句录音必崩 | 复用了同一条 MediaStream |
| 配音后半句标红 | 音频加速了 |
| 更新把新功能刷没了 | 远端 `version.json` 的 build 没加一 |
| `serve.cmd` 找不到 python | `py.path` 没生成或路径失效 |
| `WebSocket is not defined` | Node < 22（22 才有全局 WebSocket） |
| 点开始没反应、日志空白 | 看 `logs\runner.out`；启动自检失败会写进 `run-all.log` |
| 「端口 8787 起不来 10048」 | 已经有一个 serve 在跑，或旧进程没退 |
| 跟读/说话没声、日志 `TTS 失败` | 没英文音色（中文版 Windows 常态），换成自动挑音色后日志会写选中的音色名 |
| 面板不出来、日志列了别的网址 | 只匹配 `unipus.cn`，确认停在课程页 |

---

## 十一、v1.1 的环境/安装器改动（2026-10）

新用户第一版反馈集中在这几件事上，全部改了。改代码前先看这一节，别把坑填回去。

### 11.1 硬门槛

| 组件 | 要求 | 为什么 |
|---|---|---|
| Node | **≥ 22** | `run-all.js` / `potato-watch.js` 用 Node 自带的全局 `WebSocket`；20/21 直接 `WebSocket is not defined`，而且崩在 `serve.py` 拉起的子进程里，控制台一个字都看不到 |
| Python | **3.10 ~ 3.12** | 3.13/3.14 没有 ctranslate2 预编译轮子。`install.ps1` 现在**不将就**：发现只有 3.13+ 就另装一个 3.12.7 并把它的绝对路径写进 `py.path`，不动用户现有的高版本 |
| 系统音色 | 至少一个 `en-*` | 跟读/说话题是 TTS 灌麦克风。中文版 Windows 默认只有 Huihui |

`install.ps1` 到 3.14 机器上跑，会看到：

```
[FAIL] 只找到 Python 3.14：3.13 起 faster-whisper 的依赖没有预编译包
       不会动你现在的 Python，另装一个 3.12 放在用户目录
```

### 11.2 新增/重写的文件

| 文件 | 状态 | 说明 |
|---|---|---|
| `install.ps1` | 重写 | 9 段体检 + 自动修；所有输出落 `install-log.txt`；`-CheckOnly` 绝对不写盘 |
| `install.cmd` | 改 | 去掉重复的 pause（ps1 自己会等），失败码 ≥2 才补一个 pause |
| `doctor.cmd` | 新增 | `install.ps1 -CheckOnly` 的壳，只读体检 |
| `start-all.cmd` | 新增 | 按 端口探测 → 浏览器 → 服务 → 注入 → 控制台 的顺序起，已起着的直接复用 |
| `stop-all.cmd` | 新增 | 按进程名+命令行精确停 `run-all` / `potato-watch` / `serve.py`，不误伤别的 node/python |
| `start-chrome.cmd` / `open-edge-debug.cmd` | 重写 | 配置文件挪到 `%LOCALAPPDATA%\potato-debug{chrome,edge}`；不再依赖 curl；加 `--remote-allow-origins=*`；端口已在监听就复用 |
| `serve.cmd` | 重写 | 探 8787 → 验证 faster-whisper → 找不到就说清楚；用 `py -3.12/-3.11/-3.10` 兜底 |
| `potato-watch.cmd` | 重写 | 先测 WebSocket 再启动，`logs\` 自动建 |

### 11.3 运行时自检（不要删）

`run-all.js` 在连 CDP 之前跑 `preflight()`，把新人最常见的三种崩法翻译成人话写进 `run-all.log`：

```
!! 连不上调试浏览器 127.0.0.1:9222 —— 先双击 start-chrome.cmd ...
!! 调试浏览器里没有 U 校园页面
   现在开着：chrome://newtab
   [warn] 本地服务 8787 连不上：不影响单选/填空，但转写相关的题型会失败
!! 这台 Python 里没有 faster-whisper：转写全废 → 排序/跟读/说话/配音都会失败。跑 doctor.cmd 看修法
```

顶层 IIFE 还挂了 `.catch`：任何未捕获异常都会写 `!! 异常退出：...`，并把 `state.json` 的 `state` 拉回 stopped。**以前这里什么都没有，异常只进 `logs\runner.out`，面板还显示"运行中"。**

### 11.4 new endpoints

| 接口 | 用途 |
|---|---|
| `GET /api/selfcheck` | 结构化体检：python / faster-whisper / model / node(WebSocket) / cdp / key，返回 `errors` 和 `warns` |
| `/api/state` 新增字段 | `py`（解释器版本）、`fw`（faster-whisper 可用）、`model`（local/hub/none） |

`serve.py` 另外修了两件老问题：

1. `allow_reuse_address` 原来写在**实例**上（`httpd.allow_reuse_address = True`），bind 之后设等于没设 —— 关掉再开经常报 `WinError 10048`。现在写成 `Srv` 子类属性，并 `daemon_threads = True`。
2. 端口绑定失败不再甩 traceback，直接给出"已经有一个在跑，别开第二个"。

### 11.5 TTS 音色

`doSpeak()` 原来写死 `SelectVoice("Microsoft Zira Desktop")`。没装英文语音包的机器上这行必抛异常，说话题/跟读直接废。现在按 `en-US + Zira|Aria|Guy|Jenny` → 任意 `en-US` → 任意 `en*` → 系统默认 的顺序挑，并把选中的音色写进日志（`TTS 81920 字节（音色 Microsoft Huihui Desktop / zh-CN）`，看到 zh-CN 就知道该去装英文语音了）。

### 11.6 编码规矩（新加两条）

- `.ps1`：**必须 UTF-8 带 BOM + LF**。`edit` 工具/编辑器重写会掉 BOM，掉一次 PowerShell 5.1 就按 GBK 读，满屏"缺少右大括号"。改完用
  `[System.Management.Automation.Language.Parser]::ParseFile()` 过一遍。
- `.cmd`：**纯 ASCII + CRLF**，不要 `timeout /t`（重定向 stdin 时会报 `Input redirection is not supported`），等待统一用 `ping -n N 127.0.0.1 >nul`。

### 11.7 打包

发布前跑 `.dev/make-pack.ps1`：默认把仓库同步到 `<项目根>\dist\unipus`，加 `-Zip` 直接压包；要写别处用 `-Out <目录>`（历史上用的 `.dev/pack/unipus` 也能这么刷）。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .dev\make-pack.ps1          # 同步
powershell -NoProfile -ExecutionPolicy Bypass -File .dev\make-pack.ps1 -Zip    # 同步 + 压缩包
```

**别手改 pack 目录**。v1.0.0 发出去的那个 zip 就是从 pack 打的，里面 `serve.py` 比仓库旧 6KB（没有 `/api/usage`、没有 `/api/update` 的新版逻辑）、`ui.html` 也是老的、`version.json` 都缺 —— 新用户装完功能和文档写的不是同一份东西。v1.1.0 起 pack 由脚本生成，脚本会**先清空目录**再复制，排除 `control.json` / `py.path` / `logs` / `models` / 各种 `*.log`。

### 11.8 改错题（v1.1.2 新增）

`question-revise-mistake`：整句不对，页面把句子拆成逐词 `.mistake-atom`，点词 → 弹层四个动作（add-before / change / delete / mark-correct）→ change 出输入框 → 提交。实现见 `run-all.js` 的 `doCorrect()` / `revClickWord()` / `revAction()` / `revSubmitForm()`。

新人最容易踩的三条（写进 TYPES.md 了，改代码前看）：

1. 输入框要用真实输入事件（`Input.insertText`），直接赋 `value` React 收不到 → 点提交没反应
2. 表单按钮文字是「提 交」（带空格）
3. 改过的词再点会弹「确定撤销该操作吗？」→ 认到没 `.mistake-item-action` 就点「取消」

两个调试开关（都是环境变量，不影响正常跑）：

- `POTATO_NO_SUBMIT=1`：填完不提交。改错/口语题只记第一次作答，调题型必须带这个
- `POTATO_CORRECT_PLAN='[{"i":1,"op":"change","from":"difficult","to":"hard"}]'`：跳过模型，按给定改法执行，用来验填充链路（没 Key 也能测）

### 11.9 跟读题"只对一道"的根因（v1.1.4）

**现象**：一屏 6 句跟读，只有 1 句有分（16 分 ≈ 1/6）。老 `doVoice()` 用 `el.click()` 连点 6 个麦克风，日志只有"跟读完成"，没有任何单句信息。

**根因**：这个录音组件**一个页面只肯要一次麦克风**。第一句录完后，其它句子点麦克风时页面**完全不调 `getUserMedia`**（不是被拒，是压根没调用），也没有 toast / disabled 样式。刷新页面立刻恢复。

**现在的做法**：

1. 每句之前 `reloadForVoice()`（Page.reload + 等 6s + closeDlg）
2. 刷新后重新装 `VOICE_PATCH`（页面上下文换了，标志位没了）
3. `scrollIntoView` → 量 `.record-icon.button-record` 的 rect → **坐标点击**
4. 轮询 `window.__voiceProbe.n` 确认页面真的来要了麦克风（没有就重试一次）
5. 等 `dur + 1.2s` → 重新量 rect 点停止 → 轮询这一行是否出分
6. 失败的行最后统一再刷一轮重试一次

实测：同一屏从 **1/6 → 6/6**（96 / 96 / 89 / 97 / 95 / 94）。代价是每句多 6 秒刷新时间，一屏 6 句约 75 秒。

**注意**：页面只记第一次作答的分，这屏之前已经记成 16 分就补不回来了；改的是往后的屏。

### 11.10 题型判错的坑（v1.1.5）

**现象**：填空页（`After you view / Exercise 1` 第 2 页，4 个翻译空）被当成跟读，日志刷"跟读 4 题 / 没有示范音（none）"。

**根因**：`kind()` 里 `sent` 只数 `.sentence-container` 的个数，而填空题第二页也用这类容器做骨架（里面没有 `<audio>`）；`waitKind()` 又只要"两次采样一致"就返回，页面还没渲染完时拿到的是全 0 快照，直接进了跟读分支。

**改法**：

1. `sent` 改成"含 `<audio>` 的 `.sentence-container`"；另留 `sentAll` 只做诊断
2. `ins` 放宽到 `.scoop-input-wrapper input` / `.comp-abs-input input` / `input.input-user-answer`（只算可见）
3. `waitKind()` 要求"稳定 + 至少认出一类题型"（`actionable`），骨架屏继续等
4. `doSpeak()` 兜底：有可见填空框就转 `doFill()`
5. `doFill()` 的空容器优先 `.scoop-input-wrapper`，整屏没有才退回 `.comp-abs-input`——**不能用逗号选择器**，两种容器会嵌套，空格数会翻倍（当时报"8 空"，答案重复两遍）

实测：同一屏现在判成 `{"ins":4,...,"sent":0}` → `非听力填空（翻译等），直接让模型作答 4 空`，答案正确、不重复。

### 11.11 默认值

`control.json` / `serve.py` / `run-all.js` / 面板里的主观题兜底文案，从 `关注塔菲谢谢喵！` 改成 `I think this unit is interesting and useful.` —— 之前新用户模型调用失败时，会把中文口号当答案交进英语讨论区。

---

## 十、给下一个会话的话

1. **先读这份文档**，再读代码
2. `run-all.js` 是主战场，但别一次读全，按题型找函数（`doChoice` / `doFill` / `doSort` / `doSpeak` / `doDub` / `doDiscussion` / `doUpload`）
3. 改任何东西之前先 `node --check`，改完再跑 `--here` 验证那一屏
4. **别信"应该能行"**，这个项目里所有"应该"的地方都翻过车
5. 配音题那块是绕了最多弯路的，改之前把 4.5 节读三遍

祝好运。
