# v1.1.8 改动与潜在 Bug 清单（2026-10-30）

这一版只做两件事：**提交前把漏填的题补齐**、**把开始/停止/暂停修好**。剩下没动的按「潜在」列在后面，附触发条件、影响面和改法，下一个人照着改就行。改过的文件都留在 `.bak-edit-1.1.8/`（回滚用）。

---

## 一、这次改了什么

### 1. 提交前体检（新 `preSubmitAudit`）

旧 `selfCheck()` 有两个硬伤：

- **只补选择题**：`.option.selected` 之外一律不管 —— 填空空着、下拉还写着「点击选择」、主观题空框，照样点提交，等于交白卷。
- **下标错位**：它枚举 `.question-common-abs-reply,.question-basic` 时不过滤，而 `pickByIndex()` 走 `QS_JS` 的过滤（≥2 个选项、跳过 Directions 块）。一个屏里只要多一个 Directions 块或一道单选项题，补答就会点到**别的题**上去。

现在的 `preSubmitAudit(wantMap)` 一次查四类、补两类、复查一轮：

| 类型 | 判据 | 补法 |
|---|---|---|
| 选择 | 题目下没有 `.option.selected` | 用模型给的字母 → `pickByIndex` 坐标点；没答案就 A |
| 填空 | `.scoop-input-wrapper input` / `.comp-abs-input input` / `input.input-user-answer` 的 `value` 为空 | 先重跑 `doFill` 重算；还空就写占位词（默认 `the`） |
| 下拉 | `.ant-dropdown-trigger.user-answer` 文本是空/「点击选择」/「请选择」 | 点开 → 选第一项 |
| 文本 | 可见且非评论框的 `textarea` 为空 | 写 `fillerText` |

调用点三处：主循环每个屏提交前、`submit()` 点「提交」前、`submit()` 每翻一页之后。体检脚本本身跑不起来（页面结构大改 / evaluate 被拦）时**只打 warn，不会假报"通过"** —— 假通过比不体检更坑。

日志样式：

```
    体检通过：选择 8 题 / 填空 0 空 / 下拉 0 题 / 文本 0 框，全部有内容
    体检：选择 第3,5 题；填空 2/4 空 未作答 → 补
      选择 第3 题 → B ok
      填空空着的 2 个补完
    体检通过：…
```

`doFill` 的行为也跟着改了：**解析不出题干、或答案不全时返回 `'retry'`**，主循环据此跳过提交（这类屏宁可不交，也别把"仅记录第一次作答"的机会用掉）。

### 2. 开始 / 停止 / 暂停

三处叠加，才是"按钮像坏的"：

1. `run-all.js` 的 `guard()` 比的是 `c.state === 'stop'`，而 `serve.py` 停止时写的是 `'stopped'` —— **软停从来没生效过**，全靠外部硬杀。现在 `control.json.state` 的值分工明确：
   - `running` 跑 / `paused` 暂停 / **`stop` + `stopping` 停止命令** / `stopped` 静止态（serve 收尾后或根本没在跑）
   - runner 只把 `stop`/`stopping` 当停止命令，`stopped` 一律忽略 —— 否则手动 `node run-all.js 1 --here` 会被一个静止态当场劝退。
2. `serve.py` 重启过后（改代码必重启）`RUNNER['proc']` 是 `None`，老代码据此认定"没在跑"：孤儿 `run-all.js` 还在答题，界面却显示"已停止"，点开始还会**再起一个进程**，两个进程抢同一个页面。现在有 `runner.pid`：`run-all.js` 启动时写自己 pid、退出时清掉；`serve.py` 先看 `Popen` 再看 pid 文件，靠 `OpenProcess + GetExitCodeProcess`（毫秒级、只读）判活。
3. `api_state()` 每 2 秒被轮询一次，只要 `runner` 判为假就把 `control.json` 改写成 `stopped` —— 会把 `run-all.js` 刚写的 `paused` 覆盖掉，**暂停按钮也跟着失灵**。现在：进程还活着就一个字都不碰 `control.json`。

停止流程改成两步：

```
POST /api/run {action:"stop"}
  → 先软停：control.json.state = "stop"，run-all.js 的 checkpoint() 在 1~2 秒内自己 process.exit
  → 再最多等 4 秒；没退就 taskkill /F /T /PID（带 /T，把 dub.js 这种 spawnSync 子进程一起收掉）
  → 清 runner.pid，返回 {graceful:true/false, killed:true/false}
```
`/api/control {action:"stop"}` 现在也真的停进程（以前只改字段）。

**响应速度**：`checkpoint()` 塞进了 `sleep()`（最多 1.2 秒一次读 `control.json`），所以跟读刷页、等 TTS、WaitMedia 这些长循环里点暂停/停止也立刻生效，不用等下一个「节」或「屏」。

### 3. 顺手修的明确 Bug

| # | 位置 | 问题 | 改法 |
|---|---|---|---|
| 1 | `ev()` | 页面里 evaluate 抛异常返回 `'EXC'`，外面十几处 `JSON.parse(await ev(...) \|\| '[]')` → `JSON.parse('EXC')` 抛错 → **整个 run-all.js 退出** | 失败返回空串，`\|\|` 默认值才真能兜住 |
| 2 | `nextSection()` | 两次 evaluate 之间隔 900ms，`pos` 可能变 `null`，下一行 `pos.w` 抛 TypeError → 顶层 catch → 整轮退出 | 判空后 `return false` |
| 3 | `ask()` | 无超时（DeepSeek 挂住就永久吊死，界面还显示"运行中"）、无重试（网络一抖整轮崩） | 120s 超时 + 3 次重试；401/402 直接报错不重试 |
| 4 | `submit()` 翻页 | 最后一页的「下一题」还在但点不动 → 空转 8 次（每次 waitKind 8 秒）并重复处理同一屏 | 翻页前后比对页面签名，没变就停 |
| 5 | `submit()` | 没有「提交」也没有「发布」时静默返回 | 明确 log「这屏没加载完」 |
| 6 | `score()` | 抓整页第一个「N 分」→ 页头/历史分数误判 → 连续误判触发自动暂停 | 优先分数节点，其次"答题小结"区，最后才退回全文 |
| 7 | 图片题 | 用 `el.click()`（HANDOFF 明说不稳） | 改坐标点击，点不到才退回 `click()` |
| 8 | 设置项 | `guess` / `filler` / `delay` 三个开关 run-all.js 从来没读过；`/api/run` 的参数白名单还漏了 `filler` | 三个都接上了（图片题是否乱蒙 / 主观题是否写文案 / 填完到提交之间的停顿 0~3s 上限） |
| 9 | `/api/run` start | 每次点开始都把 `state.json` 的 ok/fail 清零，包括"已经在跑"的时候 | 只有真起了新进程才清 |
| 10 | `ui.html` | `.ok` / `.err` 两个 class 没在样式里定义 → 环境检查那一栏永远不变色；开始按钮只看 state 字段 | 补样式；开始按钮同时看 `st.runner` |
| 11 | `ui.html` | 点停止只发一个 POST，进程没退也看不出 | 轮询 8 秒，日志里说清"自己退的/强杀的/还没退" |

---

## 二、潜在 Bug（本次没改，附触发条件与建议）

按「真跑起来会咬人」的概率排序。

### P1 · `btn()` 是"文字包含"匹配，会点错按钮

`const btn = ws => ... if (ws.indexOf(t) < 0) return;` —— 传 `['提交']` 时，「提交作业」「确定提交」「重新提交」「提交答案」全都命中；传 `['确定','确认']` 时，页面上任何一个无关弹窗的确定按钮也会被点。

- **触发**：分页题尾部有「上一页/下一页/提交」；单元测试页有「保存并提交」；站点加了「提交作业」按钮。
- **影响**：点到错误按钮 → 提交空卷 / 关掉不该关的弹窗 / 卡在中间态。
- **建议**：`btn()` 增加 `exact` 选项（`t === ws[i]`），主流程用 exact；只在「确定/确认」这类弹窗里保留包含匹配，并且限定 `document.querySelector('.ant-modal-wrap')` 作用域。

### P2 · `doDiscussion()` 的「发布」可能把整个屏提交掉

主循环里 `if (k.cmt > 0) await doDiscussion();` 在最前面，`kind()` 允许"评论框 + 选项"同屏（讨论屏常和主观题混在一起）。如果这一屏的「发布」实际是整屏提交，后面的 `doChoice` 是在已经提交完的页面上点，白点且日志看不出。

- **建议**：`doDiscussion` 里先判断屏幕上还有没有其它可答题元素（`.option` / 输入框 / textarea），有就**只填不发布**，等最后统一提交。

### P3 · `restoreVoicePage` 的签名只有前 40 字符

签名取第 1 句去掉行首分数后的前 40 字符。两句开头相同（新视野里 "I think…" / "The author…" 很常见）时会误判"已经在跟读页"，于是麦克风点在填空页上。

- **建议**：签名改成 `句子文本 + 句子总数 + 页面里 audio 的数量`；或直接比对 `document.querySelectorAll('.sentence-container').length` 与当前句序号。

### P4 · 自动暂停的判定把"没抓到分数"当失败

`submit()` 里 `sc === '?'` 就 `fail++ / streakFail++`，但"已提交、页面直接换屏/换节"同样抓不到分数。`MAX_FAIL` 到 5 就自动暂停——**夜里挂机时，5 次页面跳转就能让整轮停下**。

- **建议**：区分三种结局：拿到分数 / 页面明显变了（算成功）/ 页面没动且按钮可点（算失败）。

### P5 · `api_state()` 与 `run-all.js` 双写 `state.json`，没有锁

`_write_json` 是 `open(...,'w')` 直接覆盖，`saveState()` 也是。两边同时写就有机会写出半截 JSON；`_read_json` 解析失败退回 `{}` → 界面进度短暂归零，极端情况下 `ctrl` 也被写成 `{}` 之外的残片。

- **建议**：写临时文件 + `os.replace()`（原子替换）；`run-all.js` 用 `fs.writeFileSync(tmp)` + `fs.renameSync`。

### P6 · `api_log` 会丢日志

`tail = lines[after:][-200:]` 只回最后 200 行，但 `next` 直接给 `len(lines)`。STT / 模型请求密集时段一次能写上百行，超出的部分永远看不到。

- **建议**：`next = after + len(tail)`，让客户端下一轮接着拉。

### P7 · 分页题的体检查重复花钱

`submit()` 里每翻一页都跑一次 `preSubmitAudit`，而体检里遇到空输入会重跑 `doFill` → 再问一次模型。一屏 3 页就是 3 次额外调用。

- **建议**：体检里只在 `noFill.length` 且该页确实有填空时才重算；或者给 `doFill` 加 `onlyMissing` 参数。

### P8 · 暂停期间页面可能被站点踢下线

`checkpoint()` 在 pause 里每 0.8 秒轮询，但页面本身在暂停期间没人管；U 校园会话超时后页面变成登录页，恢复后 `waitKind()` 认不出题型，主循环走"未知题型乱点"分支。

- **建议**：恢复时先探一次 `document.body.innerText` 有没有"登录/请重新登录"，有就暂停并报错。

### P9 · 上传题不校验结果

`doUpload()` 返回 `false` 时主循环不看返回值，照样 `submit()`。

- **建议**：`k.up > 0` 且上传失败 → `skipSubmit = true`。

### P10 · 改错题没有二次校验

`doCorrect()` 点词 → 选 change → 填 → 提交，全程不复查 `.mistake-atom` 上的改动标记（改过的词再点会弹「确定撤销」，说明状态可查）。模型给的 `from` 词在句子里出现多次时，定位到第一个。

- **建议**：每改完一个词记下 `{from,to}`，提交前遍历 `.mistake-atom` 确认文本真的变了。

### P11 · 排序题失败也照样提交

`doSort` 里 `drag` 打空、`归位 N/M` 不满时会继续走到 `submit()`。

- **建议**：`归位 < want.length` 时返回 `'retry'`（一屏排序题分值高，值得重试一次）。

### P12 · 硬杀会丢 5 秒内的用量统计

`flushUsage` 每 5 秒落盘一次，`taskkill /F` 时最后几秒的 token 计数丢掉。只影响账目，不影响答题。

### P13 · `potato-ui.user.js` 的进度条分母

`curMax` 只在首次 `render` 里从 `settings.maxSec` 取；之后控制台改了 `maxSec` 也不会跟着变（面板自己点开始时会在 handler 里更新，但用控制台改就不同步）。

### P14 · `--here` 模式的 tab 校验会补点一次

`tt.noClick` 只挡住第一次点击，`actName !== tt.t` 的"再点一次"分支没挡。当前 activity tab 只有一个时不会触发，出现两个 `pc-header-tab-activity` 时会跳屏。

---

### P15 · 热更新只说"已是最新"（v1.1.9 已修）

老 `api_update()` 有四个 `n=0` 的出口，界面上全变成一句"已经是最新版，没有文件变化"：真的最新、**远端读不到 version.json**、**内容一模一样**、更新中途失败但没写 version.json。用户看到的就是"点了没反应"。

而且更新只换磁盘文件，`serve.py` 进程内存里还是旧代码；`version.json` 已经是新号 → 再点一次必然显示"最新"，看起来就是"更新无效"。

v1.1.9 的改法见 `HANDOFF.md` 4.9：`diag` 诊断、真实 `msg`、强制更新、`stale`（磁盘 build > 进程 build → 界面黄条要求重启）、`logs/update.log`。

> v1.1.0 那个包里自带的是更早的更新器，改不动它，只能手动换 `serve.py` + `ui.html` 或重下包。

### P16 · 热更新的自举风险（v1.2.0 收了一半，剩下一半靠人守）

热更新是「用本机的更新器更新它自己」，所以有几种情况天然修不了：

1. **把 `serve.py` 写坏** → 下次启动就是双击没反应。v1.2.0 加了覆盖前 `compile()` 预检，这条基本堵住。
2. **写一半失败** → 老的 `serve.py` + 新的 `ui.html` 互相调不通。v1.2.0 加了整批回滚。
3. **新增 Python/Node 依赖** → 热更新只换文件，不装包，更新完 `import` 就崩。**这条修不了，只能靠发版规矩**：引入新依赖时必须写明"重跑 install.cmd"。
4. **改名 / 删除文件** → 更新只写不删，老机器留旧文件；`run-all.js` 改名会让两版并存。
5. **更新器本身有 bug** → 只有装上新版更新器的机器才有新行为。所以更新器这块代码要保守，宁可少功能也别崩。

---

## 三、这次怎么验证（没真机就得靠这个）

```powershell
# 1) 语法
node --check run-all.js
node --check potato-ui.user.js
python -m py_compile serve.py

# 2) 起服务 + 控制台，只体检不提交
$env:POTATO_NO_SUBMIT='1'
node run-all.js 1 --here

# 3) 看体检日志（应出现「体检通过」或「体检：… 未作答 → 补」）
Get-Content run-all.log -Tail 40

# 4) 开始/停止（不开浏览器也能测）：起进程 → 点停止 → 看 graceful/killed
Invoke-RestMethod -Uri http://127.0.0.1:8787/api/run -Method Post -Body '{"action":"start","maxSec":1}' -ContentType 'application/json'
Start-Sleep 3
Invoke-RestMethod -Uri http://127.0.0.1:8787/api/run -Method Post -Body '{"action":"stop"}' -ContentType 'application/json'
Invoke-RestMethod -Uri http://127.0.0.1:8787/api/state

# 5) 暂停响应（以前要好几分钟）
Invoke-RestMethod -Uri http://127.0.0.1:8787/api/control -Method Post -Body '{"action":"pause"}' -ContentType 'application/json'
Get-Content run-all.log -Tail 3        # 1~2 秒内应出现「已暂停」

# 6) 孤儿进程（serve 重启过的那种）
#    起一个 runner，杀掉 serve 进程，再起 serve，然后点停止 —— 现在能停住
```

判据：

- 停止后 `/api/state` 的 `runner` 变 `false`、`runnerPid` 变 0；
- `logs/runner.out` 末尾有 `!! 外部停止` 或者日志停在 `=== 跑完 ===`；
- `runner.pid` 文件消失；
- 体检日志里没有任何题重复处理（同一屏出现两次「体检」就算异常）。
