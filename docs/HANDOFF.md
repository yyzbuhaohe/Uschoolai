# 交接文档（2026-10 · v1.1.7）

写给下一个接手的人（或者下一个会话里的我）。读完这份应该能直接改代码，不用重新踩坑。

- 仓库：<https://github.com/yyzbuhaohe/Uschoolai>（main 分支即发布源，控制台「检查更新」拉的就是它）
- 当前版本：`version.json` → `build 2026103008 / v1.1.7`
- 代码目录：工作区里的 `rea/unipus/`

---

## 一、三十秒上手

```
1. 双击 install.cmd      装 Node22 / Python3.12 / faster-whisper / 模型，逐项体检（结论写进 install-log.txt）
2. 双击 start-all.cmd    按顺序：调试浏览器 → 本地服务(8787) → 注入守护 → 控制台
3. 调试窗口里登录 U 校园，进课程内容页；控制台填 DeepSeek API Key，点开始
```

- 只体检不装：`doctor.cmd`（= `install.ps1 -CheckOnly`，不写盘）
- 全停：`stop-all.cmd`
- 出问题先看 `docs/TROUBLESHOOT.md`，再看本文件第六节

---

## 二、这项目是什么

U 校园（`ucontent.unipus.cn`）新视野大学英语的课后题自动做。**不是改 DOM 硬点**，而是用 CDP 驱动真浏览器：识别屏幕 → 转写音视频 → 问 DeepSeek → 按题型填/点/录音 → 提交 → 翻节。

**不用 Tampermonkey**（扩展权限常被策略锁，而且配音题要求页面脚本前注入，用户脚本赶不上）。页面脚本由 `potato-watch.js` 通过 CDP 注入。

### 支持的题型

| 题型 | 识别特征 | 做法 | 实测 |
|---|---|---|---|
| 单选/多选 | `.option` + `.caption` | 转写 → 模型选 → 按 caption 点 | 80~100 |
| 判断 | caption 是 T/F | 同上 | 60~100 |
| 填空（听力） | `.scoop-input-wrapper input` | 原文对齐 `solveBlank`，不够问模型 | 60~90 |
| 填空（翻译/非听力） | 同上，Directions 无音视频 | 直接问模型 | 90+ |
| 下拉选择 | `.ant-dropdown-trigger.user-answer` | 模型给序号 | 90+ |
| 排序 | `sequence-reply-view-item` | 时间轴 → 证据句 → 拖拽 | **100** |
| 讨论/评论 | `textarea` + `发布` | 生成英文发帖 | 完成即得分 |
| 跟读 | `.sentence-container` **且内含 `<audio>`** | 示范音回灌假麦克风 | 89~97（平均 94） |
| 说话 | 录音按钮 + 长 Directions | 模型写口稿 → TTS 回灌 | 未在真机验证（见第七节） |
| 配音 | `.question-video-dub-pc` | 视频切片逐句回灌 | 82~85 |
| 改错 | `.question-revise-mistake` | 模型指错词 → 点词 change | 待实测 |
| 上传 | `.question-multi-file-upload` | 塞彩蛋 PDF | 完成即得分 |
| 匹配 | — | **没做**，会走兜底 | — |

---

## 三、架构

```
ui.html (控制台 127.0.0.1:8787)          potato-ui.user.js (页面右下角土豆面板)
        │ HTTP                                    │ 由 watch 注入
        ▼                                         ▼
serve.py :8787  ── /stt /stt-ts /api/state /api/run /api/update /api/selfcheck /speak.wav
        │ 子进程
        ▼
run-all.js  认屏 → 取料 → 问模型 → 填答案 → 提交 → 翻节
        │ CDP (WebSocket 9222)
        ▼
Chrome/Edge --remote-debugging-port=9222 --user-data-dir=%LOCALAPPDATA%\potato-debug\chrome
        │
        ▼
课程页

旁路：potato-watch.js 每 2s 扫 9222，注入 potato-ui.user.js + dub-hook.js（配音钩子必须在页面脚本前注册）
      dub.js 配音题单独跑（时序敏感，塞主循环会互相干扰）
```

### 文件地图（`rea/unipus/`）

| 文件 | 行数 | 干什么 |
|---|---|---|
| `run-all.js` | ~2000 | 主控：认屏、各题型、提交、翻节（改代码主要在这） |
| `dub.js` / `dub-hook.js` | 209 / 197 | 配音题独立脚本 + 音频钩子 |
| `serve.py` | ~760 | 本地服务：STT、跑课进程托管、更新、selfcheck |
| `ui.html` | 199 | 控制台页面 |
| `potato-ui.user.js` | ~530 | 页面右下角面板（shadow DOM） |
| `potato-watch.js` | ~110 | CDP 注入守护 |
| `keyvault.js` | 87 | API Key AES-256-GCM（密钥绑 MachineGuid） |
| `install.ps1` / `install.cmd` / `doctor.cmd` | ~560 | 一键安装 / 只读体检 |
| `start-all.cmd` / `stop-all.cmd` | — | 一键开跑 / 全停 |
| `start-chrome.cmd` / `open-edge-debug.cmd` | — | 开调试浏览器（端口探测+复用） |
| `serve.cmd` / `potato-watch.cmd` | — | 单起服务 / 注入守护（`--farm` 连带挂机模块） |
| `.dev/make-pack.ps1` | — | 从仓库生成发布包（别手改 `.dev/pack`） |

---

## 四、必须知道的实现细节

### 4.1 认屏（v1.1.5 改过，别改回去）

`kind()` 返回的计数里，两个不能想当然：

- `ins`：`.scoop-input-wrapper input` + `.comp-abs-input input` + `input.input-user-answer`，**只算可见的**
- `sent`：`.sentence-container` **里面必须有 `<audio>`**（填空页也用这种容器当骨架，只看类名会误判成跟读）

`waitKind()` 要求「两次采样一致 **且** 至少认出一类题型」才返回，否则骨架屏会被当成"没有题型"。

`doSpeak()` 有兜底：页面上有可见填空框就直接转 `doFill()`。

### 4.2 跟读（v1.1.4 / v1.1.6 的坑，血泪）

**一个页面只肯要一次麦克风**：录完第一句后，其它句子点麦克风页面**根本不调 `getUserMedia`**。所以每句之前必须刷页面。

**但刷新会退回第 1 页**（分页屏的页序不在 URL 里）：`Exercise 1` 第 1 页是翻译填空、第 2 页才是跟读。所以：

1. 每句前 `reloadForVoice()`（轮询等题型元素出现，别死 sleep）
2. `restoreVoicePage(sig)`：点「下一题」翻回跟读页，用第 1 句文本当签名确认（**签名要去掉行首分数**，录完会 0→96）
3. 点麦克风用**坐标点击**，`el.click()` 在这个 SPA 里不可靠；点完轮询 `window.__voiceProbe.n` 确认页面真的要了麦克风
4. 已录过的句子再点会弹「确定重新录制吗？」，得点确定
5. 收尾再翻回跟读页，否则「提交」提在填空页

### 4.3 说话（v1.1.7）

跟读的坑一个不能少：坐标点击、多选择器兜底、点完确认 `window.__dubLog` / 倒计时存在、`__dubLog` 有 `fail` 就报错、结束抓「已作答/分数」。钩子里 `ctx.resume()` + 150ms 起播。

### 4.4 改错（v1.1.2）

`.question-revise-mistake`：句子被拆成逐词 `.mistake-atom`，点词弹 `.ant-popover`（add-before/change/delete/mark-correct），选 change 出 `input.edit-form-input` + `button.edit-form-submit`（按钮文字是「提 交」，带空格）。

三条铁律：输入必须用真实输入事件（`Input.insertText`，直接赋 value React 收不到）；按钮文字要 `replace(/\s+/g,'')` 再比对；改过的词再点会弹「确定撤销该操作吗？」，认到没有 `.mistake-item-action` 就点「取消」。

### 4.5 配音（老坑，别动）

六个坑缺一个就「录音启动超时」：MediaStreamDestination 跨 AudioContext 不产 PCM / 节点不连 destination 不渲染 / 页面每句 `tracks.stop()`（每次 gUM 给新流）/ `createMediaElementSource` 绑死 ctx / `el.play()` 被 autoplay 拦（`muted=true`）/ 钩子必须在页面加载前注入（`Page.addScriptToEvaluateOnNewDocument`）。原速播放，不能加速；录音只点一次。

### 4.6 提交与面板

- `unblock()` 只摘"僵尸遮罩"（卡在 `ant-fade-leave` 且没有确定/保存按钮），真弹窗交给提交流程
- 面板挂 shadow DOM（否则被当成评论框）；点击前给 `#potato-root` 加 `p-pass`（`pointer-events:none`）

---

## 五、环境与发布

| 组件 | 要求 | 为什么 |
|---|---|---|
| Node | **≥22** | 代码用全局 `WebSocket`；20/21 直接 `WebSocket is not defined`，还崩在子进程里看不到 |
| Python | **3.10~3.12** | 3.13+ 没有 ctranslate2 预编译轮子 |
| 依赖 | `faster-whisper==1.0.3` **+ requests** | 1.0.3 的 utils.py `import requests` 但没写进依赖，新版 huggingface-hub 换成 httpx 后就不在了 |
| 音色 | 至少一个 `en-*` | 跟读/说话要 TTS；中文版 Windows 默认只有 Huihui |

`install.ps1` 到 3.13+ 机器上跑会**另装**一个 3.12.7 并把 `py.path` 指过去，不动用户现有高版本。

### 发布（改完必做）

```powershell
# 1) 改 version.json：build 必须 +1（远端 ≤ 本地时「检查更新」会拒绝）
# 2) 同步发布包
powershell -NoProfile -ExecutionPolicy Bypass -File .dev\make-pack.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .dev\make-pack.ps1 -Out "..\..\.dev\pack\unipus"
# 3) 压两个 zip：土豆刷课-v<ver>.zip / 土豆刷课-v<ver>-懒人包.zip（后者塞 whisper-base.en.zip 在根目录）
```

- **GitHub Release 的资产名会把中文整段剥掉**（`土豆刷课-v1.1.7.zip` → `-v1.1.7.zip`），上传前先复制成 `potato-course-v<ver>.zip` / `-full.zip`
- 本机没装 git，推代码是走浏览器（debug 浏览器里已登录）驱动 github.com 的 upload 页；脚本在 `.dev/gh/`（`push.js` / `commit-gen.js` / `release-gen.js` / `publish-gen.js`，读 `plan.json` `msg.json` `release.json`）
- **热更新**：控制台「检查更新」→ `POST /api/update` → 拉 `main.zip` → 远端 build 更大才覆盖；跳过 `control.json/state.json/usage.json/logs`；备份到 `.bak-update`；改完必须重启 `serve.cmd`。它不会下发 Release 资产

---

## 六、坑速查表

| 现象 | 原因 |
|---|---|
| `WebSocket is not defined` | Node < 22 |
| 点开始没反应、日志空白 | 看 `logs/runner.out`；启动自检失败会写进 `run-all.log` |
| `启动失败：[WinError 2]` | `serve.py` 找不到 node（已按 node.path→安装目录→PATH 依次找） |
| 「端口 8787 起不来 10048」 | 已有 serve 在跑；或旧进程没退 |
| 填好的空格数翻倍、答案重复 | 用了逗号选择器（`.scoop-input-wrapper,.comp-abs-input` 嵌套） |
| 填空页被判成跟读 | `sent` 数了没有 `<audio>` 的骨架容器 |
| 跟读只对一道 | 录音组件一个页面只肯要一次麦克风 → 每句刷页 |
| 跟读第 2 句「没有示范音」 | 刷新退回第 1 页 → 要 `restoreVoicePage` |
| 跟读「回不到跟读页」误报 | 签名带了行首分数 |
| 说话题没声音 | `el.click()` 点不动 → 坐标点击 + 确认 gUM |
| 跟读/说话「点了麦克风没反应」 | 已录过的句子弹「确定重新录制吗？」没点确定 |
| 面板挡住点击 | 没加 `p-pass` |
| 面板文字被当成答案 | 面板没挂 shadow DOM |
| `control.json` 读不出来 | BOM（读的时候 `.replace(/^\uFEFF/,'')`） |
| `install.ps1` 满屏"缺少右大括号" | 文件丢了 UTF-8 BOM（PS5.1 按 GBK 读了） |
| `.cmd` 乱码 | 里面写了中文（必须纯 ASCII + CRLF） |
| `timeout /t` 报 Input redirection | 重定向了 stdin；等待统一用 `ping -n N 127.0.0.1 >nul` |

---

## 七、已知未完成 / 下一步

1. **说话题没在真实屏验证过**（`Speaking out` 那几节锁着进不去）。下次跑到看日志：`没有录音按钮` / `点了麦克风没反应` / `假麦克风喂音频失败` / `没看到分数`——这四条分别对应四个卡点。
2. **改错题也没实测过分**（逻辑跑通了，答案对不对要看模型）。
3. 匹配题没实现（走兜底乱点）。
4. 排序题对大幅改写敏感（证据句找偏会掉到 60）。
5. 选择题在题干有歧义时会错；主观题只记第一次作答，录坏了覆盖不了。
6. `/api/update` 只拉 main 源码，不下发 Release 资产；`py.path` / `node.path` 也不会变（要重跑 install.cmd）。

---

## 八、版本流水

| 版本 | build | 一句话 |
|---|---|---|
| v1.0.0 | 2026021501 | 首发（包和仓库不同步，别拿它当参考） |
| v1.1.0 | 2026103001 | 安装器 v2（Node22/Python3.12 硬门、模型自动解压、语音体检）+ start-all/doctor + 启动自检 |
| v1.1.1 | 2026103002 | 修「点开始报 WinError 2」（serve.py 按 node.path 找 node） |
| v1.1.2 | 2026103003 | 新增改错题 |
| v1.1.3 | 2026103004 | 面板/文档不再让你装油猴（挂机用 `potato-watch.cmd --farm`） |
| v1.1.4 | 2026103005 | 修跟读只对一道（每句录前刷页） |
| v1.1.5 | 2026103006 | 修题型判错（填空页被当跟读） |
| v1.1.6 | 2026103007 | 修分页跟读（刷新退回第 1 页 → 自动翻回；重录确认框） |
| v1.1.7 | 2026103008 | 修说话题没声音（录音按钮坐标点击 + 确认 gUM） |

---

## 九、调试工具速查

```powershell
# 只看当前这一屏（不遍历整节）
node run-all.js 1 --here

# 只填不提交（改错/口语只记第一次作答，调题型必须带）
$env:POTATO_NO_SUBMIT='1'

# 跳过模型，直接按给定改法跑（没 Key 也能验填充链路）
$env:POTATO_CORRECT_PLAN='[{"i":1,"op":"change","from":"difficult","to":"hard"}]'

# 看状态 / 用量 / 体检
Invoke-RestMethod http://127.0.0.1:8787/api/state
Invoke-RestMethod http://127.0.0.1:8787/api/selfcheck

# 在页面里执行任意 JS
$env:CDP_MATCH='ucontent'; node cdp.js eval 某脚本.js
```

日志：`install-log.txt`（装环境）/ `run-all.log`（答题主流程）/ `logs\potato-watch.log`（注入）/ `logs\runner.out`（进程原始输出）

页面里的钩子自检：

```js
window.__voiceProbe            // 跟读：n=被要了几次麦克风，dur=当前句时长
window.__dubLog                // 说话/配音：dec/play/fail 记录
window.__potatoDub && window.__potatoDub.level()   // 配音的电平
```

编码规矩：`.ps1` = UTF-8 **带 BOM** + LF；`.cmd` = **纯 ASCII** + CRLF。改完跑一遍：

```powershell
[System.Management.Automation.Language.Parser]::ParseFile($f,[ref]$null,[ref]$err)
node --check run-all.js
python -m py_compile serve.py
```

---

## 十、给下一个会话的话

1. **先读这份，再读 `docs/TYPES.md`**（认屏判据 + 每个题型的交互），最后才动 `run-all.js`
2. `run-all.js` 别一次读全，按题型找函数：`doChoice` / `doFill` / `doSort` / `doSpeak` / `doVoice` / `doCorrect` / `doDiscussion` / `doUpload` / `doVideo`
3. 改题型逻辑前先看 `kind()` 的计数有没有认错——这一版半数 bug 都是判型判错
4. **别信"应该能行"**：这个项目里所有"应该"的地方都翻过车，改完必须 `--here` 跑一遍真实屏，并且带 `POTATO_NO_SUBMIT=1`
5. 刷页、`el.click()`、DOM 赋值这三样在这个站点上都不稳，优先用坐标点击 + 轮询验证
6. 发版记得 `build + 1`、资产名用 ASCII、发布前 `make-pack` 同步

祝好运。
