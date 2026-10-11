---
name: dsh-email-notify
description: 让 DSH 在任务跑完 / 出错 / 需要你回复时发邮件到手机，并支持用邮件反过来给 DSH 下指令（回复通知邮件 = 接着原会话继续）。当用户想「远程知道任务结果」「离开电脑也能让 DSH 干活」「把 DSH 接到邮箱」时使用。
---

# dsh-email-notify

一个零依赖的 DSH 插件包，同时打通**出站通知**和**入站指令**两条链路。

## 什么时候用它

- 用户想要「任务跑完了通知我一声」，尤其是长任务、跑一夜的任务。
- 用户想离开电脑后用手机继续指挥 DSH。
- 用户已经有一个可用作发件人的邮箱（QQ / Foxmail / 任何支持 SMTP+IMAP 的邮箱）。

## 怎么装

1. 把本目录作为一个 bundle 装进 profile：

   ```powershell
   dsh plugin --profile <profile> add '<本目录绝对路径>'
   ```

   或者用 `plugin_manager` 工具的 `install_bundle`（本地绝对路径）。

2. 在 profile 的 `cordis.patch.yml` 末尾追加覆盖行（**一个 patch 条目会整体替换该行的 config，不会合并，字段要写全**）：

   ```yaml
   - id: email-notify
     name: dsh-email-notify
     config:
       enabled: true
       to: 'you@example.com'
       smtp: { host: smtp.qq.com, port: 465, secure: true, user: 'you@qq.com', pass: '授权码' }
       inbound: { enabled: true, workspacePath: 'D:\work' }
   ```

3. **重启 DSH**。新增 bundle 属于组合期的事，HMR 只重载已挂载的模块——实测新增插件行不会靠 HMR 挂上。

## 关键事实与坑（都实测过）

- **QQ / Foxmail 的授权码同时用于 SMTP 和 IMAP**，但必须在邮箱网页版里开启「IMAP/SMTP 服务」；没开或用了登录密码，认证会回 `535 Login fail`。
- **QQ IMAP 登录后必须立刻发 `ID` 命令**，否则后续命令会被拒为 Unsafe Login。
- **IMAP 响应的 literal 必须按字节处理**：形如 `{12345}\r\n` 后面跟恰好那么多字节。缓冲区不能先 `toString` 再切；FETCH 的结果要从**含 literal 的那条响应**里取，取成带 tag 的完成行会得到 0 字节正文。
- **只读收信要用 `EXAMINE` + `BODY.PEEK[]`**，否则取信这个动作本身就会把用户的邮件标成已读。
- **自寄自收的邮箱一定会把通知发进自己的收件箱**，所以出站邮件必须带 `Auto-Submitted: auto-generated` 之类的标记，入站侧据此跳过，否则「通知 → 当成新任务 → 再通知」死循环。
- **首次启用要打基线**（记下当前 UIDNEXT），否则会把信箱里积压的全部旧邮件当成指令跑一遍。
- **邮件正文里的 Markdown 要转纯文本**：agent 的回答通常是 Markdown，直接塞进邮件会在手机端显示成一堆 `#` `*` `|`。
- **`ctx.on('user-questions/request')` 是 waterfall**：监听器必须 `return next()`，否则真正的提问方收不到。根级监听器能收到 agent 作用域的事件（未打标签的监听器全局可见）。
- 插件里**不要 import `@deepseek-ai/dsh-*`**：第三方 bundle 解析不到宿主内部的包。需要 user message 就手搓 `{ id: randomUUID(), role: 'user', content: [...], source: { kind, ... } }`（session 只校验这几个字段）。
- 新会话的创建可以照抄 `@deepseek-ai/dsh-webhook` 的步骤：`agentPresets.resolve` → `agents.create`（`meta.cwd` + `setup` 里 `agentPresets.mount`）→ `workspace.attachSession` → `permissionPresets.set` → `sessionTitle.rename` → `agent.followup`。

## 验证它真的工作

```powershell
node test-email.mjs probe        # 网络与 TLS
node test-email.mjs compose      # 只看会发出什么正文
node test-plugin.mjs             # 离线：三种触发 + 去重 + Markdown 转换
node test-mail.mjs               # MIME/IMAP 解析；--live 只读连真实信箱
node test-inbound.mjs            # 收信分类规则；--live 对真实邮件跑一遍
```

在线测试的凭据来自 `smtp.local.json` 或 `DSH_SMTP_USER` / `DSH_SMTP_PASS`，**永远不要写进代码或提交**。

判断插件是否真的在运行：把 `dryRun: true` 和 `outboxFile` 指向一个文件，任务结束时那里会出现一封「本应发出的邮件」。
