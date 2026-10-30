# 排障手册

新用户第一次装、第一次跑最容易撞的坑都在这里。**先双击 `doctor.cmd`**，它会把缺什么直接列出来；下面按"卡在哪一步"查。

---

## 0. 三份日志，看哪份

| 文件 | 里面有什么 | 什么时候看 |
|---|---|---|
| `install-log.txt` | 安装向导每一步的输出 | 装不上 |
| `run-all.log` | 答题主流程（控制台日志区显示的就是它） | 点开始后没反应 / 答得不对 |
| `logs\potato-watch.log` | 注入守护：注了没、连不上 9222 会写在这 | 土豆面板不出来 |
| `logs\runner.out` | run-all.js 进程的原始 stdout/stderr | 主日志完全空白时看这里 |

---

## 1. 安装阶段

### 1.1 Python 3.13 / 3.14 装不上 faster-whisper

**症状**：pip 报 `error: Microsoft Visual C++ 14.0 or greater is required` 或卡在 `Building wheel for ctranslate2`；`doctor.cmd` 里 python 那行是红的。

**原因**：faster-whisper 依赖 ctranslate2，官方只发到 cp312 的预编译包，3.13/3.14 得自己编译。

**修法**：双击 `install.cmd`，它会**另装一个 Python 3.12.7** 到 `%LOCALAPPDATA%\Programs\Python\Python312`，并把这个解释器的绝对路径写进 `py.path`（不会动你现有的 3.14）。

装完确认 `py.path` 里是：

```
C:\Users\<你>\AppData\Local\Programs\Python\Python312\python.exe
```

然后关掉所有黑窗口，重新 `start-all.cmd`。

### 1.2 Node 20 / 21 一跑就崩

**症状**：控制台点开始没反应；`logs\runner.out` 里是 `ReferenceError: WebSocket is not defined`。

**原因**：新版代码用 Node 自带的全局 `WebSocket` 连浏览器，这个对象 22 才有（20 得加 `--experimental-websocket`）。

**修法**：`install.cmd` 会自动下 Node 22 便携版到 `%LOCALAPPDATA%\Programs\nodejs` 并写好 `node.path`。手动的话 `winget install OpenJS.NodeJS.LTS`。

### 1.3 pip 卡住 / 下载超时

**症状**：卡在 `Downloading faster-whisper-1.0.3-py3-none-any.whl` 或者 `Read timed out`。

**修法**：`install.cmd` 会依次试 清华 → 阿里 → 官方 三个源，都失败才报错。公司网/校园网挡 pypi 的话，挂代理后重跑，或者手动：

```
set HF_ENDPOINT=https://hf-mirror.com
python -m pip install faster-whisper==1.0.3 -i https://pypi.tuna.tsinghua.edu.cn/simple
```

### 1.4 模型下不下来

**症状**：`step 4` 报"模型没下下来"。

**修法**：群里下 `whisper-base.en.zip`，**丢到项目根目录**（跟 `install.cmd` 同一层），再跑一次 `install.cmd` —— 它会自己解压到 `models\whisper-base.en`（zip 里多套一层目录、model.bin 在根上都认）。

手动解压也可以，目标是这个结构：

```
models\whisper-base.en\model.bin
models\whisper-base.en\config.json
models\whisper-base.en\vocabulary.txt
```

### 1.5 目录里有中文 / 空格

**症状**：装完能跑，但偶发"找不到文件""Chrome 参数被截断""模型加载失败"。

**修法**：整个文件夹挪到 `D:\unipus` 这种纯英文无空格路径。脚本里所有路径都加了引号，能忍；但第三方程序（Chrome、ctranslate2）不一定给你面子。

### 1.6 不是管理员能装吗

能。安装向导走的是"当前用户"路线：Python 装到 `%LOCALAPPDATA%\Programs\Python`、Node 用便携版解压到 `%LOCALAPPDATA%\Programs\nodejs`，都不需要 UAC。

只有 `winget install` 那条路要管理员，脚本发现不是管理员会直接走便携版。

---

## 2. 启动阶段

### 2.1 端口 9222 连不上

**症状**：`run-all.log` 第一行 `!! 连不上调试浏览器 127.0.0.1:9222`；控制台"环境检查 - CDP"是红的。

**检查顺序**：
1. `start-chrome.cmd` 的窗口是不是被关了 → 重开
2. 是不是用**平时的** Chrome 开的课 → 不行，必须是调试窗口（独立配置目录）
3. 浏览器里手动访问 <http://127.0.0.1:9222/json/version>，看不到 JSON 就是没起来
4. 起了但端口不通：把调试窗口全关掉，重开 `start-chrome.cmd`（脚本会等端口，25 秒没起来会报错）

> Chrome 136 之后必须用独立 user-data-dir 才能开调试端口；现在配置在 `%LOCALAPPDATA%\potato-debug\chrome`，**不是** `C:\chrome-debug` 了（老版本写在 C 盘根目录，普通用户没权限写，会静默失败）。

### 2.2 端口 8787 被占

**症状**：`serve.cmd` 闪一下就退；日志 `[X] 端口 8787 起不来: [WinError 10048]`。

**原因**：已经有一个 `serve.cmd` 在跑（一个就够），或者上一个进程没退干净。

**修法**：`serve.cmd` 现在会先探端口，已经在跑就直接告诉你"复用现有的"并退出。真要重开：`stop-all.cmd`，或者

```
netstat -ano | findstr :8787
taskkill /PID <上面那个PID> /F
```

### 2.3 土豆面板不出来

**症状**：课程页右下角没有那颗土豆。

**检查**：
1. `potato-watch.cmd` 窗口在不在（它每 2 秒扫一次 9222）
2. `logs\potato-watch.log` 里有没有 `没有找到 U 校园页面` —— 有的话它会把当前开着的标签页 URL 列出来
3. 注入只认 `*.unipus.cn` 域；停在别的网站不会注
4. 按 `Alt + P`（面板可能被收起了）
5. 刷新一次页面，等 2 秒

### 2.4 三个窗口的顺序

必须：调试浏览器 → `serve.cmd` → `potato-watch.cmd`。`start-all.cmd` 已经按这个顺序起好并等端口就绪，直接用它最省事。

### 2.5 7860 / 8899 之类端口冲突

`serve.py` 端口写死在脚本参数里（`serve.cmd` 传的 8787）。要换：

```
python serve.py 8899
```

但同时要改 `run-all.js` 顶部的 `SRV`，不然它还是找 8787。

---

## 3. 答题阶段

### 3.1 「录音启动超时」

页面点录音后 15 秒内收不到音频数据就弹这个。根因通常是钩子没注进去，或者音频节点没挂到 destination。

**排查**（在调试浏览器 Console 里敲）：

```js
window.__potatoDub && window.__potatoDub.ver      // 钩子在不在
window.__potatoDub.sink()                          // 音频图接好没
window.__potatoDub.level()                         // 有没有电平
```

钩子没有 → `potato-watch.cmd` 没跑，或者页面是刷新前注入的，刷新重来。

### 3.2 说话题 / 跟读题没分、日志写「TTS 失败」

**原因**：中文版 Windows 默认只带中文音色（Huihui），老版本代码写死要 `Microsoft Zira Desktop`，找不到就抛异常。

**现在的行为**：自动挑 en-US 音色（Zira / Aria / Guy / Jenny 优先），日志会写用了哪个音色。

**一个英文音色都没有时**：设置 → 时间和语言 → 语言 → 添加语言 `English (United States)` → 勾上「语音」→ 装完重开窗口。`doctor.cmd` 的 step 5 会告诉你现在有哪些音色。

### 3.3 排序题分数低

证据句定位偏了。改写幅度大、转写质量差（背景音重）时会掉到 60 左右。属于已知问题，见 [已知问题](TODO.md)。

### 3.4 转写全失败

`run-all.log` 里 `!! 这台 Python 里没有 faster-whisper` 或 `/stt` 返回 `{"ok":false,"err":"..."}`。

**修法**：`doctor.cmd` 看 step 2/3 → `install.cmd` 修好 → **关掉 `serve.cmd` 窗口重开**（服务是常驻进程，不重启还是老解释器）。

### 3.5 提交没反应

确认弹窗被误摘了。现在的 `unblock()` 只摘"僵尸遮罩"（卡在 `ant-fade-leave` 且没有确定/保存按钮的），真弹窗交给提交流程点。

### 3.6 面板挡住点击

面板会给 `#potato-root` 临时加 `p-pass`（`pointer-events:none`）后再点。还是点不到就把面板挪走/收起。

### 3.7 页面一直在动、看起来乱

正常。它每道题都先 `scrollIntoView` 再点，视觉上很忙但不影响正确率。**别最小化**调试窗口，最小化后渲染被限速，滚动不触发。

---

## 4. 更新与卸载

### 4.1 「检查更新」说没有新版

远端 `version.json` 的 `build` 必须比本地大才会覆盖。发版忘了加一，就会一直提示"已是最新"。

### 4.2 更新把功能刷没了

更新只覆盖代码和文档，`control.json` / `state.json` / `usage.json` / `logs` 不碰；覆盖前备份到 `.bak-update\`。判断谁是新版看 `version.json` 的 `build`，远端没有 `version.json` 会直接跳过更新。

### 4.3 卸载

```
uninstall.cmd            停进程 + 删运行期文件（项目文件夹保留）
uninstall.cmd -All       连调试浏览器配置、Whisper 模型、pip 包一起清
```

调试浏览器配置目录现在是 `%LOCALAPPDATA%\potato-debug`（老版本是 `C:\chrome-debug`，`-All` 两个都会清）。

---

## 5. 日志关键词速查

| 日志里搜这个 | 说明 |
|---|---|
| `连不上调试浏览器` | 9222 没开，跑 `start-chrome.cmd` |
| `没有 U 校园页面` | 调试窗口里停错页面了 |
| `没有 faster-whisper` | Python 环境不对，跑 `install.cmd` |
| `没找到语音模型` | `models\whisper-base.en\model.bin` 不存在 |
| `没配 DeepSeek API Key` | 控制台填 Key |
| `TTS 失败` | 没英文音色，或 PowerShell 合成被拦 |
| `录音启动超时` | 钩子没注入 / 音频没接到 destination |
| `NotFoundException` / `ws error` | 浏览器被关过，重启一遍 |
