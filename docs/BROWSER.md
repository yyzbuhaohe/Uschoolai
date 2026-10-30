# 浏览器选择与调试实例

## 该用哪个

| 浏览器 | 能用 | 说明 |
|---|---|---|
| Chrome 120+ | 推荐 | 调试端口最稳，本文以它为准 |
| Edge 120+ | 可以 | 用 `open-edge-debug.cmd`（配置目录 `%LOCALAPPDATA%\potato-debug\edge`） |
| 360 / QQ / 搜狗等套壳 | 不建议 | 内核版本参差，CDP 行为不一致 |
| Firefox | 不行 | 没有 CDP 接口 |

---

## 为什么要单独开一个实例

Chrome 136 之后，**正常启动的浏览器不允许外部程序连它的调试端口**。必须用 `--user-data-dir` 指定一个新的用户目录，等于开一个全新的浏览器配置。

`start-chrome.cmd` 干的就是这件事：

```
chrome.exe --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\potato-debug\chrome" --remote-allow-origins=* --no-first-run
```

- 端口固定 **9222**，脚本按这个端口找
- 配置目录是 `%LOCALAPPDATA%\potato-debug\chrome`，一套干净配置，**没有你平时的书签和登录状态**，需要重新登录 U 校园
- 老版本用的是 `C:\chrome-debug` —— 普通用户对 C 盘根目录没有写权限，Chrome 会静默退回默认配置、端口根本不开，所以改了
- 端口已经开着就直接复用，不会重复开窗口

验证是否通了：在这个窗口的地址栏打开 <http://127.0.0.1:9222/json/version>，看到一段 JSON 就对了。

---

## 土豆控制台怎么挂上去

有两种办法，二选一。

### 方案 A：注入守护（默认，推荐）

双击 `potato-watch.cmd`，它会：

- 每 2 秒扫一次 9222 的页面列表
- 发现 U 校园课程页没挂控制台，就把 `potato-ui.user.js` 注进去
- 页面刷新、换标签、重开浏览器，都会自动补

不依赖任何浏览器扩展，也不受企业策略影响。

要连刷时长模块一起挂：`potato-watch.cmd --farm`。

### 方案 B：Tampermonkey（不推荐，配音题会挂）

1. 在调试浏览器里装 Tampermonkey
2. 打开 <http://127.0.0.1:8787/potato-ui.user.js>，点「安装」
3. 同样方式装 `potato-farm.user.js`

**两个硬伤，所以默认不用它**：

1. 配音题要求 `dub-hook.js` 在**页面脚本之前**执行（靠 CDP 的 `Page.addScriptToEvaluateOnNewDocument`）。用户脚本是注入到页面之后的，赶不上，配音题必弹「录音启动超时」。
2. Chrome 138 之后，企业策略 / 家长控制常把扩展权限关掉，`chrome://extensions` 里显示「您的家长已停用扩展程序权限」，油猴装了也注不进去。

**结论**：用方案 A。那两个 `.user.js` 只是"给页面用的脚本"，方案 A 里由 `potato-watch.js` 直接注进去，跟浏览器扩展无关。

---

## 窗口与分辨率

脚本靠**坐标点击**（这个 SPA 里 `el.click()` 常常无效），所以：

- 窗口别太小，建议 1600×900 以上
- 浏览器缩放保持 100%
- 窗口可以放后台，**不能最小化** —— 最小化后渲染被节流，滚动事件不触发，挂机失效

---

## 常见问题

**调试端口连不上**

- 浏览器是不是用 `start-chrome.cmd` 开的
- 9222 端口被别的程序占了：`netstat -ano | findstr :9222`
- 用户目录路径带空格 → 换一个不带空格的路径

**页面打不开 / 一直转圈**

脚本用 CDP 找 `ucontent.unipus.cn` 的页面。确认浏览器里真的开着课程页，而不是停在登录页。

**土豆球不见了**

- `potato-watch.cmd` 的窗口是不是关了
- 按 `Alt + P` 试试有没有被收起
- 刷新页面，2 秒内会重新注入
