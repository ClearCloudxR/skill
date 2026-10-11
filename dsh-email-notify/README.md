# dsh-email-notify

DSH 插件：**任务跑完 / 跑出错 / DSH 需要你回复时，发一封邮件到手机；反过来，你也可以用邮件给 DSH 下指令。**

零依赖：SMTP 和 IMAP 客户端都是手写的，不需要 `nodemailer`、`imapflow` 之类的包。

## 它做两件事

**发信（出站）**

| 时机 | 邮件内容 |
|---|---|
| 一个任务跑完（agent 从 running 回到 idle）且耗时超过阈值 | ✅ 任务完成：工作目录、会话号、第几轮、耗时、你交代的任务、助手最终回答的节选 |
| 任务因为报错结束 | ❌ 任务出错：同上，外加错误信息与堆栈前几行 |
| DSH 弹出问题在等你回答（`ask_user_question`） | ❓ 需要你回复：逐个列出问题、选项和说明 |

邮件正文一律转成**纯文本**（`plaintext.js`）：助手回答里的 `#`、`**`、表格、代码围栏都会先被处理成人能直接读的样子，手机上不会看到一堆符号。

**收信（入站）**

插件每 30 秒用 IMAP 看一次信箱：

- **回复某封通知邮件** → 靠 `In-Reply-To` / `References` 认出是哪次任务，**接着那个会话继续**，上下文不丢；
- **新写一封邮件** → 在配置的工作目录**开一个新会话**跑邮件正文里的任务。

安全边界（都实测过）：

- 只处理白名单发件人（默认就是发件账号自己）；
- 插件自己发出的通知带 `Auto-Submitted: auto-generated` 和 `X-DSH-Notify: 1`，会被自己识别并跳过，**不会形成回环**；
- **不动信箱**：不标记已读、不移动、不删除（只读 `EXAMINE` + `BODY.PEEK`）；
- **首次启用先打基线**：把当时的 UID 记下来，之前积压的旧邮件一律不处理；
- 邮件里的引用（`>` 行、「在……写道：」之后的内容）会被剥掉，只取新写的内容；
- 投递失败会给你回一封「⚠️ 邮件指令未能执行」说明原因，不会静默吞掉。

## 装到 DSH

插件是一个 DSH bundle（`package.json` 里声明 `dsh.bundle.patch`）。把它作为一个包加进你的 profile：

```powershell
# 假设本仓库已 clone 到 <本目录>
& 'G:\dsh\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add '<本目录的绝对路径>'
```

（`dsh plugin --profile <名> <pnpm 参数>` 就是「在 profile 目录里跑 pnpm」，会把包装成 `link:` 依赖并把包名加进 `dsh.profile.bundles`。也可以直接在 Web 界面的 **插件** 页里安装。）

然后在 profile 的 `cordis.patch.yml` 末尾加一段覆盖配置（**一个 patch 条目会整体替换该行的 config，不会与下层合并，所以想保留的字段都要写全**）：

```yaml
- id: email-notify
  name: dsh-email-notify
  config:
    enabled: true
    to: 'you@example.com'
    minDurationMs: 420000      # 只提醒超过 7 分钟的任务
    outboxFile: ''             # 可选：每封邮件再存一份到本地文件
    smtp:
      host: smtp.qq.com
      port: 465
      secure: true
      user: 'you@qq.com'       # 发件邮箱
      pass: '授权码'            # SMTP 授权码（不是登录密码）
      passEnv: ''              # 也可以留空 pass、改填环境变量名
    inbound:
      enabled: true
      host: imap.qq.com
      port: 993
      secure: true
      user: ''                 # 留空 = 跟随 smtp.user
      pass: ''                 # 留空 = 跟随 smtp.pass
      pollMs: 30000
      allowFrom: []            # 留空 = 只允许 smtp.user 自己
      workspacePath: 'D:\work' # 新会话的工作目录
      agentPreset: standard
      permissionPreset: danger-full-access
      replyToSession: true
```

**授权码怎么拿**（QQ 邮箱，Foxmail 同理）：邮箱网页版 → 设置 → 账户 → 开启「IMAP/SMTP 服务」→ 短信验证 → 得到一串 16 位授权码。它同时用于 SMTP 和 IMAP。

装完需要**重启 DSH**：新增 bundle 属于组合期的事，HMR 只负责已挂载模块的重载。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `to` / `from` | — / 跟随 `smtp.user` | 收件人（逗号分隔）/ 发件人 |
| `subjectPrefix` | `[DSH]` | 主题前缀，方便手机端过滤 |
| `notifyOnIdle` / `notifyOnQuestion` | `true` | 任务结束 / 提问 是否发信 |
| `skipSubagents` | `true` | 忽略子代理会话 |
| `idleDelayMs` | `8000` | 空闲后再等多久才发；期间又跑起来就跳过（多轮 goal 只发一封） |
| `minDurationMs` | `0` | 短于此时长的任务不发信（提问不受限） |
| `taskChars` / `replyChars` | 600 / 1500 | 任务与回答的截断长度 |
| `dryRun` | `false` | 只组装 + 写 outbox，不发信 |
| `logMail` | `false` | 把邮件内容写进 DSH 日志 |
| `outboxFile` | 空 | 每封邮件再存一份到该文件 |
| `smtp.host/port/secure` | `smtp.qq.com` / `465` / `true` | 587 端口请用 `secure: false`（自动 STARTTLS） |
| `smtp.passEnv` | 空 | 从该环境变量读授权码 |
| `smtp.timeoutMs` / `attempts` | 30000 / 2 | 单次超时 / 失败重试 |
| `smtp.allowInvalidCert` | `false` | 自签证书环境才打开 |
| `inbound.*` | 见上例 | 收信侧：IMAP 账号、轮询间隔、白名单、新会话工作目录与 preset |

## 自检与测试

```powershell
# 只测网络和 TLS，不需要账号
node test-email.mjs probe

# 真的发一封测试邮件（凭据放 smtp.local.json，或用 --user/--pass）
node test-email.mjs send --user you@qq.com --pass <授权码>

# 只看会组成什么样的邮件正文（不联网）
node test-email.mjs compose

# 离线跑插件逻辑：完成 / 报错 / 提问 三种触发与去重
node test-plugin.mjs

# MIME / IMAP 解析自测；--live 会只读连一次真实信箱（需要 smtp.local.json）
node test-mail.mjs
node test-mail.mjs --live

# 收信分类规则：谁能触发、哪些跳过、回复能否接回原会话
node test-inbound.mjs
node test-inbound.mjs --live
```

`smtp.local.json`（**不要提交**，已在 `.gitignore` 里）：

```json
{ "host": "smtp.qq.com", "port": 465, "user": "you@qq.com", "pass": "授权码", "to": "you@example.com" }
```

`check-profile.py` 用来校验 profile 接线与 YAML 可解析性（需要 Python + PyYAML）：

```powershell
python check-profile.py
```

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 插件本体：Cordis `apply`、触发点、邮件排版、去重 |
| `smtp.js` | 手写 SMTP/TLS 客户端 + MIME 组装（UTF-8 base64 正文） |
| `plaintext.js` | Markdown → 纯文本（标题/加粗/表格/链接/围栏） |
| `imap.js` | 手写 IMAP 客户端：literal 感知的响应解析、UID 搜索、只读取信 |
| `mime.js` | 手写 MIME 解析：multipart、base64/quoted-printable、中文 charset、RFC2047 |
| `inbound.js` | 收信引擎：轮询、水位、白名单、线程路由、会话注入 |
| `cordis.patch.yml` | 作为 bundle 声明 `insert` 行 |

## 排错

| 现象 | 处理 |
|---|---|
| 任务跑完没收到邮件 | 看是否短于 `minDurationMs`；设 `dryRun: true` + `outboxFile` 可确认插件是否真的在跑 |
| 日志出现 `not configured yet, staying idle` | `smtp.user` / `smtp.pass` 是空的 |
| 日志出现 `535 Login fail` | 授权码不对（是不是用了登录密码？）或没开启 SMTP 服务 |
| IMAP 登录报 Unsafe Login | 登录后必须先发 `ID` 命令，代码里已处理；自写客户端时容易踩 |
| 收信没反应 | 首次启用会打基线跳过旧邮件；只有**新到**的邮件才触发 |
| 回复邮件没接回原会话 | 原会话已经不在运行，会退化成开新会话（日志会写原因） |

## 已知取舍

- 一次 IMAP 会话用一个总超时（不是每命令空闲超时），拉取很慢的信箱可能需要调大 `inbound.timeoutMs`。
- 多字节字符被拆在两个相邻 encoded-word 且 charset 不同时无法拼回（同 charset 可以）。
- 收信只取 `text/plain`（或把 `text/html` 转成文本），附件跳过。
- 回复邮件要接回原会话，前提是那个会话还在运行；DSH 重启过之后就只能开新会话。
