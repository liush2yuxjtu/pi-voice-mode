# pi-voice-mode

让 Pi 知道你正在用 Typeless 等外部语音转文字软件输入。

```text
Typeless / 系统听写
        │
        ▼
   近似转写文本
        │
        ▼
  Pi + 语音容错提示
        │
        ├── 修复同音词、断句、重复与自我纠正
        ├── 结合项目上下文恢复技术名词
        └── 高风险或精确字面量仍会请求确认
```

## 安装

从 Pi 包市场安装：

```bash
pi install npm:pi-voice-mode
```

也可以直接从公开源码仓库安装：

```bash
pi install git:github.com/liush2yuxjtu/pi-voice-mode
```

安装后重新启动 Pi，或在当前会话执行 `/reload`。

## 使用

单独输入：

```text
/voice
```

它是开关，不接收后续请求文本：

- `🎙`：已开启。
- `🔇`：已关闭。
- 再次执行 `/voice`：切换状态。
- 状态保存在 Pi 用户配置目录，因此会跨项目、跨会话和跨重启生效。
- 每轮开始前都会重新读取状态，因此并行运行的 Pi 会话会在下一轮同步。

不要输入 `/voice 帮我修复登录`。扩展会拒绝带参数的形式，避免误吞真正的请求。先单独执行 `/voice`，再正常说出下一条请求。

## Pi 会如何理解语音转写

开启后，扩展会在每轮系统提示中加入解释规则：

- 用对话和仓库上下文恢复最可能的真实意图。
- 静默处理同音词、漏词、错词、错误断句、中英文边界、重复和口头填充词。
- 让后说的自我纠正覆盖前面的说法。
- 在上下文明确时，把“斜杠 voice”等口述符号恢复成 `/voice`。
- 对路径、网址、命令、代码标识符、数字和版本号保持谨慎，不凭空补全精确值。
- 对删除、覆盖、发布、付款、凭据、安全设置和外部通信等高风险操作保留确认门槛。
- 不主动评价或复述一份“清理后的转写”，而是直接处理最可能的请求。

## 隐私边界

这个扩展：

- 不访问麦克风。
- 不录制或保存音频。
- 不调用 Typeless 接口。
- 不发送语音内容、转写文本、prompt、模型输出、路径、token、邮箱或用户名。
- 可选匿名 usage funnel 默认关闭；只有同时设置 `PI_USAGE_TELEMETRY=1` 和 `PI_USAGE_TELEMETRY_PRIVACY_ACK=1` 时才发送。默认 collector 是 `https://telemetry-peach.vercel.app/api/events`，可用 `PI_USAGE_TELEMETRY_ENDPOINT` 覆盖。
- `DO_NOT_TRACK=1` 或 `PI_TELEMETRY_DISABLED=1` 会强制关闭；CI 环境也不会发送。

语音模式本身只在本地保存零字节的切换事件，并在开启时调整 Pi 的系统提示。当前状态由事件数量的奇偶性决定，因此多个 Pi 会话同时执行 `/voice` 也不会相互覆盖。状态目录默认为：

```text
~/.pi/agent/pi-voice-mode/
```

如果设置了 `PI_CODING_AGENT_DIR`，状态目录会跟随该目录。每次切换会新增一个零字节事件文件；扩展不在线压缩这些事件，以避免重新引入并发锁。正常开关频率下占用可以忽略。

### 可选 usage funnel

明确 opt-in 后，只发送这些匿名事件：`install`、`activated`、`first_success`、`d7_retained`、`weekly_active`。`first_success` 只有在语音模式真正参与一次 agent turn 时才记录，单纯切换 `/voice` 不算成功；`d7_retained` 只在首次成功后的第 7–8 天再次真实成功时产生。

事件字段限制为事件名、随机匿名安装 ID、公开包名/版本、时间、操作系统、Node 主版本和 CI 布尔值；不会附带任意文本。funnel 去重状态保存在系统用户配置目录下的 `liushiyu-usage-funnel/` JSON 文件中。网络发送只允许显式配置的 HTTPS endpoint，拒绝重定向，单次尝试有短超时，不维护离线待发队列。

## 与录音类扩展的区别

有些 Pi 扩展也注册 `/voice`，但会直接采集麦克风并运行语音识别。本扩展专门服务于已经使用 Typeless、系统听写或其他外部转写工具的人。

Pi 在多个扩展注册同名命令时会给命令添加数字后缀。若你希望始终使用无后缀的 `/voice`，不要同时启用另一个注册该命令的扩展。

## 开发验证

```bash
npm install
npm run check
npm run pack:check
```

## 许可证

MIT
