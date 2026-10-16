# 小爱音箱 AI 语音助手 — 部署与运维手册

基于 [migpt-next-2](https://github.com/whBettering/migpt-next-2)（migpt-next 的社区增强版）深度定制的私有部署，
让小爱触屏音箱（LX04）接入自选大模型、联网搜索和网易云全曲库点歌。

> 本文档是**实际部署的完整手册**，上游项目的通用说明见仓库自带的 README.md。
> 账号密钥等敏感信息只在 `config.js` 中，本文不重复。

---

## 一、系统能力总览

| 能力 | 触发方式 | 后端 |
|---|---|---|
| AI 问答 | 「请/你」开头的任意话 | MiniMax-M3（关闭思考过程） |
| 联网搜索问答 | 时效性问题自动触发（今天/最新/天气/股价…） | Tavily（免费 1000 次/月） |
| 网易云点歌 | 「请播放XX」「你想听XX」 | ncm-cli + 网易云开放平台（黑胶 VIP 音质） |
| 播放控制 | 「请暂停/继续/停止播放」 | MiNA ubus 指令 |
| 其他消息 | 不以「请/你」开头 | 完全不接管，走小爱原生 |

**触发规则**：只有「请」或「你」开头的消息才被接管，触发后完全接管（小爱原生回答不再保留）；
其余消息一律放行给小爱原生处理。

---

## 二、系统架构

```
你说「请播放小燕子」
   │
   ▼
小爱音箱(LX04) ──语音──▶ 小米云端对话记录
                             │ 500ms 轮询
                             ▼
                    migpt-next2 (Node.js, systemd 常驻)
                             │
        ┌────────────────────┼────────────────────┐
        ▼ 点歌               ▼ 问答                ▼ 联网(按需)
  ncm-cli search song    MiniMax API          Tavily API
  ncm-cli play 触发解析   (api.minimaxi.com)   (api.tavily.com)
        │
        ▼ 假 mpv 触发，从 app.log 截获 playUrl
        │
        ▼ player_play_music 推流 (REPLACE_ALL)
  音箱播放网易云全曲
```

问答链路的播报走 MIoT「播放文本」指令（LX04 唯一可靠的 TTS 通道）。

---

## 三、部署信息

| 项 | 值 |
|---|---|
| 服务器 | <你的服务器IP>（阿里云，Alibaba Cloud Linux 3，你的用户，SSH 免密） |
| 项目目录 | `~//migpt-next2` |
| 服务管理 | systemd 单元 `migpt-next2`（开机自启，崩溃 5 秒自动拉起） |
| Node | v24.18.0（nvm 安装，`~//.nvm/versions/node/v24.18.0/`） |
| ncm-cli | v0.1.7，全局安装于 nvm bin 下 |
| 部署方式 | 本地改 `config.js` → scp 上传 → `systemctl restart`（本地代码仅作开发调试用） |

**单实例约束**：小米账号同一时间只能有一个实例轮询对话，本地调试前必须先停服务器实例。

---

## 四、关键文件

```
~//migpt-next2/
├── app.mjs              # 启动入口（MiGPT.start）
├── config.js            # ★ 全部配置：账号/模型/点歌/搜索 —— 改完需重启
├── packages/            # 构建产物（tsup 编译后的 8 个 @mi-gpt 包）
├── node_modules/        # 生产依赖
└── README-DEPLOY.md     # 本文档

~//.config/ncm-cli/
├── credentials.enc.json # 开放平台凭证（appId/privateKey，已配置）
├── tokens.enc.json      # 网易云账号登录态（扫码所得）
└── app.log              # CLI 日志（点歌取流时从中截获 playUrl）

/usr/local/bin/mpv       # ★ 假 mpv 捕获脚本 —— 点歌链路依赖，勿删！
/etc/logrotate.d/migpt-next2        # ncm-cli 日志轮转（512K×2）
/etc/systemd/journald.conf.d/size-cap.conf  # journald 16M 上限
```

---

## 五、config.js 配置要点

- `speaker`：小米账号（did=小爱触屏音箱，含 passToken 兜底登录）
- `openai`：MiniMax 接口。`thinking: disabled` 必须保留（M3 是推理模型，否则音箱会念出思考过程）
- `SEARCH.tavilyApiKey`：联网搜索开关，留空即关闭
- `NCM_CLI`：写死的 ncm-cli 绝对路径（systemd PATH 没有 nvm，**相对路径会失败**）
- `songUrlCache`：同歌播放地址内存缓存 50 分钟（URL 官方 1 小时时效）
- 点歌幂等：重复点同一首不会打断正在播放的音乐

---

## 六、语音指令示例

```
请播放起风了              # 点歌（网易云全曲，非试听版）
请播放周杰伦的晴天         # 会放翻唱版（网易云无周杰伦版权，平台限制）
你想听小燕子              # 同点歌
请暂停播放 / 请继续播放 / 请停止播放
请查一下今天上海的天气      # 自动联网搜索后回答
请告诉我下一届美国总统是谁   # 时效性问题，自动联网
请你讲个笑话               # 普通问答，不消耗搜索额度
```

点歌首播延迟约 5~15 秒（搜索+解析+音箱起流），同一首歌 50 分钟内再点秒切。

---

## 七、日常运维

```shell
systemctl status migpt-next2            # 运行状态
sudo journalctl -u migpt-next2 -f       # 实时日志（🔥消息 🎵点歌 🌐联网 🔊播报）
sudo journalctl -u migpt-next2 --since "5 minutes ago"   # 近期日志
sudo systemctl restart migpt-next2      # 改配置后重启生效
sudo systemctl stop migpt-next2         # 停止（本地调试前先执行这个）

# ncm-cli 登录态（失效时需重新扫码）
ncm-cli login --check
ncm-cli login                           # 出二维码，用网易云音乐 App 扫

# 日志占用（有轮转，稳态 ~1M CLI + ≤16M journald）
ls -lh ~/.config/ncm-cli/app.log*
du -sh /var/log/journal
```

---

## 八、LX04 固件坑（重要，换音箱/改代码前必读）

这台触屏音箱的固件有两类「API 返回成功但设备无动作」的静默失效，均已绕过：

1. **TTS 播报**：MiNA 的 `mibrain text_to_speech` 无效。
   必须用 MIoT「播放文本」：`MiOT.doAction(5, 1, text)`（老版指令号；
   新版规格的 5/3 会被拒绝，错误码 -704220025）。
2. **播放外部音频 URL**：`player_play_url` 无论 type/media 参数怎么传都无效
   （曾误判为带 `media:'app_ios'` 可用——当时看到的 playing 其实是小爱原生队列）。
   **唯一有效**：`player_play_music`（带 xiaowei audio_id payload，REPLACE_ALL），
   裸流播放时音箱标题显示「请欣赏 (音乐)」，以此区分流归属。
3. 播控/音量指令正常，但都要带 `media: 'app_ios'` 字段。
4. 停止后立刻推流很难起来（状态机 churn），所以重复点歌走幂等而不是重推。

**排查铁律**：别信指令返回码，盯 `player_get_play_status` 的 status + 曲目标题 + 进度是否前进。

---

## 九、点歌链路与易碎点

```
语音 → 意图正则 → ncm-cli search song（隐藏命令，help 不列出）
    → ncm-cli play --song（假 mpv 让 CLI 以为在本地播放）
    → 从 ~/.config/ncm-cli/app.log 增量截获 "playUrl"
    → 内存缓存 50 分钟 → player_play_music 推流 → 曲目归属确认
```

断链排查顺序：

1. `ncm-cli login --check` — 网易云登录态（最常见：过期需重新扫码）
2. `/usr/local/bin/mpv` 假 mpv 脚本还在不在（被清理则 play 无法触发解析）
3. 手动跑一次 `ncm-cli search song --keyword test` 看 JSON 是否正常
4. 服务日志 `🎵 ncm-cli xx 失败:` 行有具体错误（PATH/超时等）
5. 取流接口偶发挂起属正常，代码里有重试 + 缓存兜底

---

## 十、故障速查

| 现象 | 原因与处理 |
|---|---|
| 音箱完全不响应「请/你」 | `systemctl status migpt-next2`；看 journalctl 是否有 🔥 日志；小米登录是否过期（重启服务重新登录） |
| 点歌报「歌曲搜索失败」 | journalctl 里看 `🎵 ncm-cli search 失败:` 具体错误；检查 nvm 路径 |
| 点歌报「播放地址获取失败」 | 开放平台取流接口抖动，稍后再试；连续失败查 `~/.config/ncm-cli/app.log` |
| 回答是旧信息 | 联网搜索没触发（问题不含时效词）或 Tavily 额度用尽（控制台查看） |
| 搜到的歌是翻唱 | 平台版权问题（如周杰伦），非故障 |
| 音箱说「音箱播放失败了」 | 大概率小爱原生抢答竞态，代码会自动重推；偶发可忽略 |

---

## 十一、更新部署流程

```shell
# 本地（Windows）改完 config.js 后：
cd C:\Users\z00572826\code\xiaoyiwork\migpt-next-2
node -e "import('./config.js').then(()=>console.log('OK'))"   # 语法自检
scp config.js <user>@<你的服务器IP>:~/migpt-next2/config.js
ssh <user>@<你的服务器IP> "sudo systemctl restart migpt-next2"

# 改了 packages 源码的话需重新构建再整体打包上传（参考 pnpm build + tar）
```

---

*部署完成于 2026-10-16。联网搜索（Tavily）、网易云点歌（黑胶 VIP）、LX04 全链路适配均已实测验证。*
