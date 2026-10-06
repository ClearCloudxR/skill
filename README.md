# DSH 浏览器自动化技能（browser-automation）

> **仓库名 `RSC` 与内容无关**，这里放的就是这个技能本身：让 AI agent 操作浏览器。
> 目录名 `browser-automation` 才是它的身份。

## 一句话

给 DSH 里的 agent 装上「开浏览器、点页面、填表、截图、抓 JS 渲染后的内容」的能力，
并记下某台 Windows 机器上把它调通的全过程与踩过的坑。

**这不是通用模板**——路径、版本号、报错都是那台机器的实况。换机器要改哪些路径，
见下面「本机环境」一节。

## 三种用法

| 我想… | 看哪里 |
|---|---|
| 直接用 | 装进 `~/.dsh/skills/browser-automation`，agent 会自动加载 |
| 知道它到底能干什么 | 下面「实测记录」——逐项都是真跑过的 |
| 自己搭一套 / 排错 | `SKILL.md` 的踩坑章节最有用（`insert:` 块、YAML 引号、`.pth` 注入…） |

## 它解决什么

| 方案 | 适用 | 状态 |
|---|---|---|
| **Chrome DevTools MCP** | 交互式探索：点、看网络/控制台 | ✅ 已注册，30 个工具 |
| **Playwright** | 可重复的批处理、CI、无头跑 | ✅ 开箱即用 |

## 为什么值得看

`SKILL.md` 里记的**踩坑部分**可能比代码更有用，都是实测撞出来的：

- **新增 MCP 插件行必须放在 `- insert:` 里**。写成顶层 `- id: xxx` 会被 DSH **静默忽略**——
  不报错、无日志、工具列表空着，极难排查。
- **YAML 双引号会炸 Windows 路径**：`"--executablePath=C:\Program Files\..."` 里的 `\M`、`\P`
  是非法转义，解析器直接报 `found unknown escape character`。得用单引号。
- **长路径别折行**：YAML 会把折行当成带换行的单值，参数就废了。
- **`PLAYWRIGHT_BROWSERS_PATH` 光设环境变量不够**：已开着的进程读不到，得靠 site-packages 的
  `.pth` 注入。而 `.pth` 里**只有以 `import` 开头的行才会执行**，写成裸赋值会静默失效。
- **Windows 控制台 GBK 会让抓真网页崩**：`example.com` 的 body 里有阿拉伯文/西里尔字母，
  `print` 直接 `UnicodeEncodeError`。脚本开头要把 stdout/stderr 转 utf-8。
- **含 Windows 路径的 docstring 要加 `r""`**：否则 `\Users` 触发 `truncated \UXXXXXXXX escape`。
- **HMR 不能免重启**：`dsh-base` 默认启用 HMR 且监听的正是配置文件，但实测新增插件行不会挂载——
  它只管已挂载模块的重载，新增属于组合期的事。
- **`take_screenshot` 的 `filePath` 会被工作区限制拦**，不传该参数让截图直接返回更省事。

## 怎么装

把仓库 clone 进 DSH 的 skills 目录（**目录名必须是 `browser-automation`**，
skill 靠它和 `SKILL.md` 的 frontmatter 识别），agent 启动时会自动加载：

```powershell
git clone git@github.com:ClearCloudxR/RSC.git "$env:USERPROFILE\.dsh\skills\browser-automation"
```

两条路可以只用其中一条：

- **只用 Playwright**：装依赖即可，不需要 MCP、不需要重启。
  ```powershell
  & $py -m pip install playwright
  & $py -m playwright install chromium
  ```
- **要 MCP**：把 `mcp.json` 里的条目并进 profile 的 `cordis.patch.yml`，
  **必须包在 `- insert:` 里**（写成顶层 `- id:` 会被静默忽略），然后重启 DSH。

装完自检：

```powershell
& $py smoke_test.py            # Playwright 三项
node examples\simulate_dsh_startup.js   # MCP 能否正常 spawn（不用重启）
```

## 文件

```
SKILL.md                      技能定义 + 环境事实 + 踩坑（主要价值在这）
mcp.json                      MCP 配置备份（真正生效的是 profile 的 cordis.patch.yml）
smoke_test.py                 Playwright 三项自检：导航 / JS 渲染 / 截图
verify_pth.py                 验证浏览器确实从 E 盘加载（不依赖环境变量）
examples/
  scrape.py                   抓取/截图模板
  mcp_smoke.js                手写 MCP 客户端，直接验 MCP 能驱动浏览器
  simulate_dsh_startup.js     按 profile 原样 spawn，模拟 DSH 启动行为（重启前自证）
  validate_profile.js         校验 profile 里 MCP 条目结构
```

## 本机环境（写死的部分）

```
Python   C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe
浏览器    C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe   （没装 Chrome）
node     F:\node\node.exe  v24.15.0
浏览器二进制  E:\ms-playwright        （C 盘紧张，搬到了 E 盘）
缓存      E:\dsh-cache\
MCP 配置   C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml
```

**换台机器要改这些路径。** 之所以保留原样，是因为这份记录本身就是「这台机器怎么调通的」，
泛化之后反而丢了信息。

## 实测记录

MCP 那条路逐项都真跑过，不是「能连上」：

| 能力 | 结果 |
|---|---|
| `list_pages` / `new_page` | ✅ 打开 example.com |
| `take_snapshot` | ✅ 返回 a11y 树与元素 uid |
| `click` | ✅ 点 "Learn more" → 跳转 iana.org |
| `fill_form` | ✅ 填入 `hello-mcp` |
| `evaluate_script` | ✅ 读回 `document.title` |
| `take_screenshot` | ✅ 完整渲染 |

填表那次最能说明问题：填入值 → 点按钮 → 按钮的 onclick 读到该值并把标题改成
`clicked:hello-mcp`，**填进去的值真的被页面用上了**。
