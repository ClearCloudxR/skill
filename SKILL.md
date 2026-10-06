---
name: browser-automation
description: Drive a real Chromium browser to open pages, click, fill forms, take screenshots, read console/network, and scrape JS-rendered sites. Use when the task requires interacting with a web page rather than plain HTTP - logging into a site with a browser, clicking buttons, uploading files, capturing screenshots, debugging front-end errors, or reading content that only appears after JavaScript runs. Do NOT use when a plain HTTP request or an existing site-specific skill already covers the task.
---

# Browser automation

**两条路本机都已实测打通**——Playwright 开箱即用；Chrome DevTools MCP 已配好并**真的驱动了 Edge**。

> **先别急着开浏览器**：如果目标站有纯 HTTP 接口（如 `591iqAutomatic` 覆盖的站点），
> 用 HTTP——快一个数量级且不脆。只有**必须真实渲染或真实交互**时才用本 skill。

## 选哪条

| 用 MCP（方案 A） | 用 Playwright（方案 B） |
|---|---|
| 交互式探索：点页面、看网络/控制台 | 可重复的批处理、CI、要精确控制时序 |
| 每步要「看一眼再决定」 | 一次跑完的固定流程 |
| 需要人看得见浏览器窗口 | 无头跑、快 |

两条路**现在都可用**。MCP 已注册好，直接用即可；只有**改动 MCP 配置**时才需要重启 DSH。

## 环境事实（本机已核实并实测）

> **C 盘只剩 8 GB，所以浏览器相关的东西全部落在 E 盘**，别搬回 C 盘。

| 项 | 状态 |
|---|---|
| Python | `C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`（3.12.14） |
| playwright | ✅ 1.63.0（在**上面这个 bundled Python** 里，系统 python 没有） |
| Chromium | ✅ **`E:\ms-playwright`**（705 MB，靠 `.pth` 注入 + 用户环境变量定位） |
| Playwright 自检 | ✅ `smoke_test.py` 三项全过（导航 / JS 渲染 / 截图） |
| chrome-devtools-mcp | ✅ **已注册**：工具列表有 `mcp__chrome-devtools__*`（30 个），实测可导航/点击/填表/截图/跑 JS |
| 浏览器 | ❌ **无 Google Chrome**；用 Edge `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`（Chromium 内核，CDP 一致） |
| node / npx | `F:\node\node.exe` v24.15.0；`F:\node\npx.cmd` |
| npm 缓存 | `E:\dsh-cache\npm-cache`（`npm config set cache`），日志 `E:\dsh-cache\npm-logs` |
| MCP 浏览器 profile | `E:\dsh-cache\dsh-edge-profile`（`--userDataDir`） |

### 磁盘布局（为什么在 E 盘）

| 路径 | 内容 | 靠什么定位 |
|---|---|---|
| `E:\ms-playwright` | Chromium / ffmpeg / winldd 二进制，705 MB | **`.pth` 注入**（见下）+ 用户环境变量 |
| `E:\dsh-cache\npm-cache` | npm 缓存 | `npm config set cache` |
| `E:\dsh-cache\npm-logs` | npm 日志 | `npm config set logs-dir` |
| `E:\dsh-cache\dsh-edge-profile` | MCP 启动的 Edge 用户目录 | `--userDataDir=` |
| `E:\dsh-cache\chrome-devtools-mcp` | MCP 自身缓存 | `$HOME\.cache` 已迁走 |

已删除的 C 盘副本：`%LOCALAPPDATA%\ms-playwright`（705 MB）、`npm-cache`、`dsh-edge-profile`。
**若 C 盘又出现空的 `npm-cache` / `.cache\chrome-devtools-mcp` 目录，那是程序自建的骨架（0 MB），无害。**

#### ⚠️ `PLAYWRIGHT_BROWSERS_PATH` 光设环境变量不够

实测踩坑：**User 级环境变量对已经开着的进程不可见**（DSH / MCP 作为子进程读不到），
于是 playwright 又回去找 `C:\...\ms-playwright` 并报
`Executable doesn't exist at C:\Users\...\ms-playwright\...`。

**根治办法**是让 Python 自己注入，不依赖父进程环境——在 site-packages 放一个 `.pth`：

```
C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\Lib\site-packages\zz_playwright_browsers_path.pth
```

内容（**必须整行是单行 `import`**）：
```python
import os; _b = r"E:\ms-playwright"; os.path.isdir(_b) and os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", _b)
```

两个坑，都实测踩过：

1. **`.pth` 里只有以 `import` 开头的行才会被执行**，其余行被当成路径加进 `sys.path`。
   我第一版写成裸赋值，文件在、却静默不执行，`os.environ` 里什么都没有。
2. 用 `setdefault` 而不是直接赋值，且先 `isdir` 判断——万一 E 盘没了，
   行为退回 playwright 的正常报错，而不是更难查的怪错。

装完任何 Python 包后**验证一次**（会自证浏览器确实在 E 盘）：

```powershell
$py = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
Remove-Item Env:PLAYWRIGHT_BROWSERS_PATH -ErrorAction SilentlyContinue   # 模拟干净环境
& $py "C:\Users\Administrator\.dsh\skills\browser-automation\verify_pth.py"
# 期望：PLAYWRIGHT_BROWSERS_PATH: E:\ms-playwright ... RESULT: PASS
```

若哪天报找不到浏览器，先跑这个脚本定位，再考虑重装到 E 盘：

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "E:\ms-playwright"
& $py -m playwright install chromium
```

### ⚠️ 本机必踩的坑（都是实测踩出来的）

1. **必须用 bundled Python 的绝对路径**，系统 `python` 里没有 playwright：

   ```powershell
   $py = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
   ```

2. **`npx` 走 PowerShell 会被执行策略拦住**（`npx.ps1` → `UnauthorizedAccess`）。
   用 `cmd /c` 调 `npx.cmd`：

   ```powershell
   cmd /c "F:\node\npx.cmd -y <pkg> ..."
   ```

3. **`playwright.exe` 的 Scripts 目录不在 PATH**，用 `python -m playwright ...` 而不是裸 `playwright`。

4. **控制台是 GBK，抓真网页必然 `UnicodeEncodeError`**（实测：example.com 的 body 里
   有阿拉伯文/西里尔字母，`print` 直接崩）。脚本开头必须把 stdout/stderr 转 utf-8：

   ```python
   import sys
   for s in (sys.stdout, sys.stderr):
       try:
           s.reconfigure(encoding="utf-8", errors="replace")
       except (AttributeError, ValueError):
           pass
   ```

   同理：**含 Windows 路径的 docstring 要加 `r""` 前缀**，否则 `\U`/`\d` 被当转义符
   （实测 `\Users` 触发 `truncated \UXXXXXXXX escape` 语法错误）。
   `examples/scrape.py` 两处都已处理，照抄即可。

5. **`navigate_page` 需要 `pageId`（数字）**，不传就报
   `Invalid input: expected number, received undefined`。先 `new_page` 或 `list_pages`
   拿到页码再导航（`examples/mcp_smoke.js` 演示了这个顺序）。

## 方案 A：Chrome DevTools MCP（配置已写入 profile，重启 DSH 后可用）

**DSH 不用 Claude 那种 `mcpServers` 格式**（`mcp.json` 只是备份参考，放哪都不会被读）。
真正的配置是 **profile 的 `cordis.patch.yml`**，条目由 `@deepseek-ai/dsh-mcp-client` 插件消费：

```
C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml
```

已写入的条目（**注意外面必须包一层 `- insert:`**）：

```yaml
- insert:
    - id: mcp-chrome-devtools
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: chrome-devtools        # 工具名 = mcp__chrome-devtools__<tool>
        transport: stdio
        command: cmd                       # 绕开 PowerShell 执行策略（见坑 2）
        args:
          - /c
          - F:\node\npx.cmd
          - -y
          - chrome-devtools-mcp@latest
          - '--executablePath=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
          - --userDataDir=E:\dsh-cache\dsh-edge-profile
        env:
          npm_config_cache: E:\dsh-cache\npm-cache   # 缓存也别落 C 盘
        toolCallTimeoutMs: 120000
```

### ⚠️ 最容易错的一点：新插件行必须放在 `insert:` 里

**profile 的 `cordis.patch.yml` 顶层那些 `- id: xxx` 行只能「按 id 覆盖已存在的行」，
不能凭一个 id 凭空创建插件行。** 要新增插件，必须写成 `- insert:` 下的子项。

这不是猜的——`dsh-base` 自己的 patch 文件开头就写着：

> 后来者（bundle patches 和用户 profile 的 `cordis.patch.yml`）**address these rows by id**,
> with the last write winning per row.

而 `dsh-base` 自己要引入新插件时，用的正是 `- insert:`（整个 base 核心就是
"applied as ONE insert over the empty profile root"）。

我一开始写成顶层 `- id: mcp-chrome-devtools`，**DSH 静默忽略**——不报错、无日志、
工具列表里什么都没有。排查了很久才从 base 的注释里看出问题。

⚠️ 实测说明：我没能单独验证「顶层写法 + 重启」是否必然失败（重启恰好发生在改成
`insert:` 之后），所以**不能断定顶层写法一定不行**。但 `insert:` 是文档明确要求的形式，
现已实测可用——**照这个写就对了**。

关键点：

- **本机没有 Chrome**，所以用 `--executablePath` 指向 Edge（Chromium 内核，CDP 一致）。
  MCP 会自己拉起并管理浏览器，**不用手动开 Edge 或调试端口**。
- `serverName` 决定工具前缀：工具会以 `mcp__chrome-devtools__<tool>` 出现（共 30 个）。
- **含 Windows 路径的参数用单引号包**：`'--executablePath=C:\Program Files (x86)\...'`。
  ⚠️ 实测坑：**双引号会炸**——YAML 双引号串里 `\M`、`\P` 都是非法转义，
  解析器直接报 `found unknown escape character 'M'`。单引号才是字面量。
  同理**不要把长路径折行**，YAML 会把折行当成一个带换行的值，参数就废了。

### ⚠️ 不能靠 HMR 免重启（实测结论）

`dsh-base` 默认启用 HMR 且 `root: []`（**配置**变更会被监听），文档也说
"Profile configuration reloads by default"。但**实测不行**：

改完 `cordis.patch.yml` 后等 5 秒以上、甚至再触发一次真实写入，
MCP 子进程始终没被拉起，工具列表里也没有 `mcp__chrome-devtools__*`。

原因：HMR 负责**已挂载模块的配置重载与源码替换**，而这里要挂载的是一个
**全新插入的插件行**（还要 spawn 外部子进程）——这属于组合期的事，得走完整启动。
所以：**新增 MCP 条目后必须重启 DSH。**

#### 重启后确认成功

工具列表里出现 `mcp__chrome-devtools__*`（30 个）即注册成功。
本机已实测通过的完整链路：

| 能力 | 实测 |
|---|---|
| `list_pages` / `new_page` 导航 | ✅ 打开 example.com |
| `take_snapshot` 拿元素 uid | ✅ 返回 a11y 树 |
| `click` 真实点击 | ✅ 点 "Learn more" 后跳转到 iana.org |
| `fill_form` 填表 | ✅ 填入 `hello-mcp` |
| `evaluate_script` 跑 JS | ✅ 读回 `document.title` |
| `take_screenshot` | ✅ 完整渲染（**不传 `filePath`，截图直接返回**） |

⚠️ **`take_screenshot` 的 `filePath` 会被工作区限制拦**：
传绝对路径（含 profile 目录、会话工作区）都报
`Access denied: ... is not within any of the configured workspace roots`。
**不传 `filePath`**，截图会直接作为附件返回，这样最省事。

### 重启前后各跑一次自检

重启前——不用重启就能验证整条链路（读 profile → 按原样 spawn → 握手 → 真的开浏览器）：

```powershell
node "C:\Users\Administrator\.dsh\skills\browser-automation\examples\simulate_dsh_startup.js"
# 期望：server: chrome_devtools 1.10.1 / tools: 30 /
#       DSH would expose e.g.: mcp__chrome-devtools__click / RESULT: PASS
```

重启后——确认工具真的注册进来了，再让模型调用一次 `mcp__chrome-devtools__*` 即可。

这个脚本实测通过，说明**重启后能注册成功**；若哪天坏了，它会直接指出是
路径变了、还是包下不下来，比重启后瞎猜快得多。
注意它会按 YAML 规则剥掉参数外层引号——**别用正则硬切，否则引号会进到参数里**
（我第一版就踩了，误报 FAIL）。

`examples/mcp_smoke.js` 是同一套客户端逻辑，
`examples/validate_profile.js` 只做结构检查（不解析 YAML，能力弱，仅作兜底）。

### 想连一个已经在跑的浏览器

去掉 `--executablePath`，改用 `--browser-url=http://127.0.0.1:9222`，
并先用**独立的** user-data-dir 启动 Edge：

```powershell
# 先完全退出 Edge 所有窗口，否则调试端口不生效
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
    --remote-debugging-port=9222 `
    --user-data-dir="E:\dsh-cache\dsh-edge-profile"
```

就绪判据：`http://127.0.0.1:9222/json/version` 返回 JSON。
⚠️ 用**默认** user-data-dir 时新版 Chromium 会拒绝开调试端口，所以上面是独立目录。

## 方案 B：Playwright 脚本

装好了直接用，无需任何额外配置。模板 `examples/scrape.py`，
自检 `smoke_test.py`（改动环境后跑它确认没坏）：

```powershell
& $py "C:\Users\Administrator\.dsh\skills\browser-automation\smoke_test.py"
& $py "C:\Users\Administrator\.dsh\skills\browser-automation\examples\scrape.py" https://example.com --text body --shot out.png
```

最小可用：

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto("https://example.com", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("h1")          # 关键：等元素，别 sleep
    print(page.title())
    page.screenshot(path="shot.png", full_page=True)
    browser.close()
```

关键写法与坑：

- **等待**：用 `wait_for_selector` / `expect(...)`，**不要 `time.sleep`**。
  ⚠️ 实测坑：`domcontentloaded` 就抓 `h1` 会 30s 超时——元素是稍后才渲染的。
- **定位器**：`get_by_role` / `get_by_label` / `get_by_text` 优先，CSS/XPath 最后。
- **持久登录态**：`launch_persistent_context(user_data_dir=...)` 复用 profile，
  比每次重登稳。凭据走环境变量，**不写进脚本**。
- **上传文件**：`page.set_input_files("input[type=file]", path)`；
  隐藏 input 先 `wait_for_selector(..., state="attached")`，不需要可见。
- **有头 vs 无头**：调试期 `headless=False` 方便看；稳定后再 `headless=True`。
  部分站点检测无头，行为不一致时以有头为准。
- **截图**：`full_page=True` 整页；元素级用 `locator.screenshot()`。

### 常见失败模式

| 现象 | 原因与处理 |
|---|---|
| `Executable doesn't exist at C:\...\ms-playwright\...` | `.pth` 注入没生效；跑 `verify_pth.py` 定位（见「磁盘布局」） |
| `UnicodeEncodeError: 'gbk' codec` | 控制台编码；脚本开头 reconfigure 成 utf-8（见坑 4） |
| `SyntaxError: truncated \UXXXXXXXX escape` | docstring 里有 Windows 路径没加 `r""` 前缀 |
| `ModuleNotFoundError: playwright` | 用了系统 python；换成 bundled Python 绝对路径 |
| 元素 30s 超时 | 元素还没渲染；先 `wait_for_selector`，别在 `domcontentloaded` 后就抓 |
| 点不到 / 被遮挡 | `scroll_into_view_if_needed()`，或用 role 定位 + `expect` 等待 |
| 登录后立刻跳回登录页 | cookie 没带住；改 `launch_persistent_context`，确认不是无头触发风控 |
| 抓到的是空壳 HTML | 内容靠 JS 渲染；等 `networkidle` 或直接等目标元素 |
| MCP：`pageId expected number` | 先 `new_page` / `list_pages` 拿页码（见坑 5） |

## 安全与边界

- **只做用户授权的操作。** 登录、支付、删除、发布等有副作用的动作，执行前必须向用户确认。
- 不绕过验证码、不绕风控、不批量注册或爬取受限数据。
- 凭据走环境变量或交互输入，**不写进脚本、不写进文档、不提交进仓库**。
- 截图与导出的页面可能含个人信息，落盘位置自己清楚，不要随手外传。
