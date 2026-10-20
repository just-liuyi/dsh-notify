# dsh-notify

DeepSeek Harness 的「注意力提醒」插件：任务跑完、或代理卡在提问上等你回答时，**弹一张自绘小卡片**（右下角、置顶），点一下就回到 DSH。

> Attention card for the DeepSeek Harness desktop app: when a turn finishes or the
> agent is waiting for your answer, a small topmost card appears in the corner of
> the screen. Clicking it brings the app back to the foreground.

## 为什么不用系统通知

DSH 的桌面端没有调用 `app.setAppUserModelId()`，而这在 Windows 上是 Electron 通知的硬前提。结果是：页面里 `new Notification()` **成功返回、不报错，但系统静默丢弃**，通知中心里也不会有记录。

用 PowerShell 的 AppID 发原生 toast 可以出现，但点击它**无法回到 DSH**（归属不是本应用）。

所以本插件自己画一张卡片：一个属于我们的置顶窗口，点击时用 `ShowWindow` + `SetForegroundWindow` 把 DSH 拉回前台。

## 工作原理

```
会话日志事件 (session/event)
  ├─ turn/end  completed        → "任务已完成"
  ├─ turn/end  error/blocked/…  → "任务出错"
  └─ tool/call ask_user_question → "正在等你选择或输入"
        │
        ▼
Host（本插件 index.js）记录到环形缓冲，暴露 GET /dsh-notify/api/state
        │
        ▼
Client（client.js）每 2 秒轮询：
  · 窗口可见且 hasFocus()      → 跳过（你在看，不打扰）
  · 不在前台                   → 请求卡片 + 提示音 + 标题 (n) 计数
        │
        ▼
Host 拉起 card.ps1（PowerShell + WinForms）画卡片
        │
        ▼
点击卡片 → ShowWindow/SetForegroundWindow → 回到 DSH
```

卡片配色**跟随 DSH 主题**：Client 从页面里读取 `--dsw-alias-bg-layer-1`、`--dsw-alias-label-primary` 等令牌的计算值，随请求发给 Host；拿不到时按 Windows 应用主题（浅色/深色）取 DSH 的对应色值。CSS 颜色带 alpha 的会被**先混合到底色**上，因为 Win32 控件不接受透明背景。

## 安装

```text
plugin_manager install_bundle <本目录绝对路径>
```

或发布到 GitHub 后：

```text
plugin_manager install_bundle github:<owner>/dsh-notify
```

安装后无需重启（本地目录安装是 junction，改动即时生效）；**但 `client.js` 的改动需要刷新页面**（DSH 不会热替换客户端模块）。

## 配置（可选）

在 bundle 的 `cordis.patch.yml` 行配置里：

```yaml
- insert:
    - id: notify
      name: dsh-notify
      config:
        processName: DeepSeek Harness   # 点击卡片时要激活的进程名
        seconds: 20                     # 卡片停留秒数（>=3）
```

## 诊断

`GET /dsh-notify/api/state` 返回（仅环回地址可访问）：

```json
{
  "seq": 4, "items": [ ... ],
  "polls": 61,
  "counters": { "done": 4, "question": 0, "error": 0 },
  "clientReports": [ { "outcome": "shown", "visibility": "hidden", "hasFocus": false } ]
}
```

- `polls` 增长 = 客户端在轮询
- `clientReports[].outcome`：`shown` / `skipped:watched` / `denied` / `no-api` / `threw:…`
- 客户端在首次加载时会自报一条 `started`，可用来判断页面是否已刷新

卡片脚本自身出错时**不会弹 .NET 崩溃框**（异常被吞掉）；设置环境变量 `DSH_CARD_LOG=<路径>` 可把异常写进该文件。

## 已知限制

- **卡片仅 Windows**：依赖 PowerShell + WinForms；其他平台只有页面内通知与提示音。
- **只识别标准提问工具**：`ask_user_question` 之外的提问（例如某个工具内部直接调用 `ctx.userQuestions.ask`）不会触发「等你输入」提醒——因为 DSH 的提问是 session projection，不写会话日志。
- **`client.js` 变更需刷新页面**：HMR 不会替换已加载的客户端模块。
- **阈值固定**：轮询间隔 2 秒；不做「任务跑了多久才提醒」的过滤。
