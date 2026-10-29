# 卸载

## 一键卸载

双击 `uninstall.cmd`，确认后它会：

- 停掉 `node run-all.js`
- 停掉 `node potato-watch.js`
- 停掉占着 8787 端口的 `serve.py`
- 删掉 `control.json`、`state.json`、`logs\\`、`run-all.log`、`.dev\\`

项目文件夹本身不动。

---

## 连环境一起清

```cmd
uninstall.cmd --all
```

或者：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 -All
```

多清三样：

- `C:\chrome-debug` —— 调试浏览器配置（里面有你的登录态）
- `%USERPROFILE%\.cache\huggingface\hub\models--Systran--faster-whisper-base.en` —— Whisper 模型，约 140MB
- `pip uninstall faster-whisper` —— Python 包

---

## 彻底删掉

卸载脚本跑完，把项目文件夹整个删掉就行。没有注册表项，没有后台服务，没有开机自启。

---

## 手动清理对照表

| 东西 | 位置 |
|---|---|
| 项目文件 | 你解压的那个文件夹 |
| 调试浏览器配置 | `C:\chrome-debug` |
| Whisper 模型 | `%USERPROFILE%\.cache\huggingface\hub\models--Systran--faster-whisper-base.en` |
| Python 包 | `pip uninstall faster-whisper` |
| Node 依赖 | 本项目没有 npm 依赖，不用管 |
| 环境变量 | 只在本窗口设置的 `DEEPSEEK_API_KEY` 关窗口即失效 |

---

## 只想暂停，不想删

1. 土豆面板点「停止」
2. 关掉 `potato-watch.cmd` 的黑窗口
3. 关掉 `serve.cmd` 的黑窗口
4. 关掉调试版浏览器

下次用重新双击这三个窗口即可，配置都还在。
