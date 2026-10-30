# Whisper 模型包怎么用

## 为什么要单独下

脚本靠 Whisper 把音频转成英文文本。模型文件 140MB，从网上下有两个坑：

- `hf-mirror.com` 经常抽风
- 官方源在国内基本下不动

所以单独打了个包，直接拷进来最省事。

---

## 怎么装（最省事：丢 zip 就行）

1. 下载 `whisper-base.en.zip`（约 127 MB）
2. **直接丢到项目根目录**（跟 `install.cmd` 同一层），不一定要解压
3. 双击 `install.cmd`

它会自己找这个 zip、解开、把 `model.bin` 所在的那个目录搬到 `models\whisper-base.en`。zip 里多套一层目录、或者 `model.bin` 直接在 zip 根上，都能认。

装完看这一行：

```
[OK]   用项目里的模型：models\whisper-base.en（model.bin 138.5 MB），不联网
```

手动解压也行，最终结构是：

```
土豆刷课\
└── models\
    └── whisper-base.en\
        ├── model.bin        138 MB
        ├── config.json
        ├── tokenizer.json
        └── vocabulary.txt
```

**目录名必须是 `whisper-base.en`，不能改**（自动解压会自动用这个名字，手动放要注意）。

---

## 不放行不行

行，`install.cmd` 会自己去下载，走 `hf-mirror.com` → `huggingface.co` 轮着试。

只是国内下 140MB 经常断，所以推荐直接放本地。

---

## 验证模型能用

```cmd
serve.cmd
```

看窗口里有没有这一行：

```
[stt] model loaded from local: D:\...\models\whisper-base.en
```

有就对了。没有的话检查：

- 文件夹名对不对（`whisper-base.en`，注意大小写和那个点）
- `model.bin` 在不在（138 MB 那个）
- 是不是放到了 `models\` 下面，而不是直接扔在根目录

---

## 模型是什么

| 项 | 值 |
|---|---|
| 来源 | Systran/faster-whisper-base.en |
| 语言 | 只认英文 |
| 大小 | 138 MB（fp16） |
| 跑起来占内存 | 约 400 MB |
| 一段 4 分钟音频转写 | 20~40 秒（纯 CPU） |

用 `int8` 量化跑，所以快、省内存，准确度对课后题完全够。

---

## 想换更大的模型

`base.en` 是最小能用的。想要更准可以换 `small.en`（约 480MB），把 `models\` 下的文件夹换掉，并改 `serve.py`：

```python
local = os.path.join(ROOT, 'models', 'small.en')
```

一般不需要，课后题的音频很干净，`base.en` 足够。
