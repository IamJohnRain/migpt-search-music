import { execFile } from 'node:child_process';
import fs from 'node:fs';

// ==================== 联网搜索（可选，保持 MiniMax 不换）====================
// 内置的 webSearch 依赖火山方舟 Responses API，MiniMax 不支持。
// 这里改为在 onMessage 里自行调用搜索 API，把结果作为参考资料注入提示词。
// - Tavily：海外，免费额度 1000 次/月，https://app.tavily.com 注册拿 key（tvly- 开头）
// - 博查：国内直连，按次付费，https://open.bochaai.com 注册拿 key（sk- 开头）
// 填任意一个 apiKey 即自动启用；两个都留空则不搜索，行为与之前完全一致。
const SEARCH = {
  tavilyApiKey: '', // 填 tvly- 开头的 Tavily 密钥开启联网搜索，留空关闭
  bochaApiKey: '',
  maxResults: 5,
  timeout: 10000,
};

// 判断问题是否需要联网（沿用本项目 web-search.ts 的时效性正则）
const kExplicitSearchPattern =
  /(?:联网|上网|网上|互联网).{0,6}(?:查|搜|搜索)|(?:查一下|查下|搜一下|搜下|搜索一下|搜索|搜搜|网上查查)/i;
const kFreshnessPattern =
  /今天|今日|现在|当前|目前|此刻|最新|最近|近期|刚刚|刚才|实时|本周|这周|本月|这个月|今年|明天|后天|昨天|昨日|近\s*\d+\s*(?:天|周|月|年)/i;
const kVolatileInformationPattern =
  /新闻|资讯|动态|热搜|热点|天气|气温|空气质量|价格|多少钱|股价|股票|行情|汇率|利率|金价|油价|票价|比分|赛程|战绩|排名|榜单|政策|法规|规定|版本|更新|发布|上线|开售|发售|库存|营业时间|开放时间|航班|高铁|列车|路况|限行/i;
const kVolatileRolePattern =
  /(?:(?:总统|总理|首相|主席|ceo|首席执行官|负责人|领导人|市长|省长|部长|教皇).{0,8}(?:是谁|叫什么|哪位)|谁是.{0,8}(?:总统|总理|首相|主席|ceo|首席执行官|负责人|领导人|市长|省长|部长|教皇))/i;

function shouldSearch(text) {
  if (!text) return false;
  return (
    kExplicitSearchPattern.test(text) ||
    kFreshnessPattern.test(text) ||
    text.includes(String(new Date().getFullYear())) ||
    kVolatileInformationPattern.test(text) ||
    kVolatileRolePattern.test(text)
  );
}

async function searchTavily(query) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SEARCH.tavilyApiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: SEARCH.maxResults,
      include_answer: false,
      search_depth: 'basic',
    }),
    signal: AbortSignal.timeout(SEARCH.timeout),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = await res.json();
  return (data.results ?? []).map((r) => `【${r.title}】${r.content ?? ''}`).join('\n');
}

async function searchBocha(query) {
  const res = await fetch('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SEARCH.bochaApiKey}`,
    },
    body: JSON.stringify({
      query,
      freshness: 'noLimit',
      summary: true,
      count: SEARCH.maxResults,
    }),
    signal: AbortSignal.timeout(SEARCH.timeout),
  });
  if (!res.ok) throw new Error(`博查 HTTP ${res.status}`);
  const data = await res.json();
  const pages = data?.data?.webPages?.value ?? [];
  return pages.map((p) => `【${p.name}】${p.summary || p.snippet || ''}`).join('\n');
}

// 清洗搜索词：剥掉「请/你/帮我/搜索/查一下」等指令残留，避免污染搜索结果
// （实测把「请搜索苹果应该怎么做」整句丢给搜索引擎，结果会被带偏成 Apple 设备相关内容）
function cleanSearchQuery(text) {
  return text
    .replace(/^[请你您][帮我给你替]*\s*/, '')
    .replace(/^(?:帮我|给我|替我)?(?:联网|网上|上网)?(?:搜索一下|搜索|搜一下|搜下|搜搜|查一下|查下|查询一下|查询|网上查查)/, '')
    .replace(/^[请你您]\s*/, '')
    .trim();
}

async function webSearch(query) {
  try {
    const results = SEARCH.tavilyApiKey
      ? await searchTavily(query)
      : await searchBocha(query);
    // 控制注入长度，避免回答跑偏、上下文过长
    return results.slice(0, 1200);
  } catch (error) {
    console.error(`❌ 联网搜索失败，改用模型直接回答：${error.message}`);
    return '';
  }
}

// ==================== 网易云音乐点歌 ====================
// 链路：ncm-cli search 拿歌曲双 ID → ncm-cli play 触发解析（服务器上的 fake mpv 让 CLI 以为在本地播放）
// → 从 app.log 增量截获 playUrl → 通过 MiNA mediaplayer 推给音箱播放。
// 注意：ncm-cli 的 player 只认 mpv/orpheus，/usr/local/bin/mpv 是捕获脚本，别删。
const NCM_CLI = '/home/admin/.nvm/versions/node/v24.18.0/bin/ncm-cli';
const NCM_BIN_DIR = NCM_CLI.slice(0, NCM_CLI.lastIndexOf('/'));
const NCM_APP_LOG = '/home/admin/.config/ncm-cli/app.log';

// systemd 服务环境的 PATH 没有 nvm 目录，ncm-cli 的 shebang（env node）会找不到 node，必须显式注入
function runNcm(args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(
      NCM_CLI,
      args,
      {
        timeout: timeoutMs,
        env: { ...process.env, PATH: `${process.env.PATH}:${NCM_BIN_DIR}` },
      },
      (err, stdout, stderr) => {
        if (err) console.error(`🎵 ncm-cli ${args[0]} 失败: ${err.message}`);
        resolve(err ? null : stdout);
      },
    );
  });
}

// LX04 的 stop 需带 media 字段才可靠（engine.speaker.abortXiaoAI 不带）
function stopMedia(engine) {
  return engine.MiNA.callUbus('mediaplayer', 'player_play_operation', {
    action: 'stop',
    media: 'app_ios',
  });
}

function pollPlayUrlFromLog(startOffset, durationMs = 8000) {
  const deadline = Date.now() + durationMs;
  return new Promise((resolve) => {
    const tick = () => {
      try {
        const buf = fs.readFileSync(NCM_APP_LOG);
        // logrotate 截断后文件比记录的偏移短，从头读（会多匹配一次旧 URL，无害）
        const from = startOffset > buf.length ? 0 : startOffset;
        if (buf.length > from) {
          const matches = [
            ...buf.slice(from).toString('utf8').matchAll(/"playUrl":"(https?:\/\/[^"]+)"/g),
          ];
          if (matches.length) return resolve(matches[matches.length - 1][1]);
        }
      } catch {}
      if (Date.now() > deadline) return resolve(null);
      setTimeout(tick, 300);
    };
    tick();
  });
}

// 已解析的播放地址缓存：歌曲加密ID → { url, at }。URL 有效期 1 小时，留余量取 50 分钟。
// 作用：开放平台取流接口偶发挂起（CLI daemon 3 秒超时就放弃），重复点同一首歌直接走缓存，不依赖接口。
const songUrlCache = new Map();
const SONG_URL_TTL = 50 * 60 * 1000;

async function resolvePlayUrl(record) {
  const cached = songUrlCache.get(record.id);
  if (cached && Date.now() - cached.at < SONG_URL_TTL) {
    console.log('🎵 命中播放地址缓存');
    return cached.url;
  }

  let logOffset = 0;
  try {
    logOffset = fs.statSync(NCM_APP_LOG).size;
  } catch {}

  // 最多两轮：接口偶发无响应，等 3 秒重新触发一次解析再轮询
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 3000));

    // 不等待 play 结束（daemon 超时收尾要挂几秒），URL 出现在日志里就够了
    runNcm(
      ['play', '--song', '--encrypted-id', record.id, '--original-id', String(record.originalId), '--output', 'json'],
      12000,
    );

    const url = await pollPlayUrlFromLog(logOffset, 9000);
    if (url) {
      songUrlCache.set(record.id, { url, at: Date.now() });
      return url;
    }
  }
  return null;
}

// LX04 播放外部 URL 的唯一有效指令是 player_play_music（带 audio_id 的 payload），
// player_play_url 无论 type/media 怎么传都返回 code 0 但不播（对照实验验证）。
// 附带好处：play_behavior REPLACE_ALL 会直接替换小爱原生队列，不用跟它抢管道。
const XIAOWEI_AUDIO_ID = '1582971365183456177';
function playUrlCommand(url) {
  const music = {
    payload: {
      audio_type: 'MUSIC',
      audio_items: [
        {
          item_id: {
            audio_id: XIAOWEI_AUDIO_ID,
            cp: { album_id: '-1', episode_index: 0, id: '355454500', name: 'xiaowei' },
          },
          stream: { url },
        },
      ],
      list_params: { listId: '-1', loadmore_offset: 0, origin: 'xiaowei', type: 'MUSIC' },
    },
    play_behavior: 'REPLACE_ALL',
  };
  return ['mediaplayer', 'player_play_music', { startaudioid: XIAOWEI_AUDIO_ID, music: JSON.stringify(music) }];
}

// 最近一次成功推流的歌曲核心名（裸流标题显示「请欣赏」，幂等判断需要靠它）
let lastPlayedCore = '';

// 搜索结果缓存：关键词 → { record, at }，30 分钟内重复点同一首免搜索（配合 URL 缓存，重复点歌全程秒级）
const searchCache = new Map();
const SEARCH_TTL = 30 * 60 * 1000;

// 点播序号：新的点歌/播控/LLM 接管时自增，使仍在跑的旧管道确认立即失效
// （否则用户刚说停止，后台确认循环又会把歌推回去）
let playSeq = 0;

async function playMusicOnSpeaker(engine, keyword) {
  let record = null;
  const cached = searchCache.get(keyword);
  if (cached && Date.now() - cached.at < SEARCH_TTL) {
    record = cached.record;
  } else {
    const searchOut = await runNcm([
      'search', 'song', '--keyword', keyword, '--userInput', `播放${keyword}`, '--output', 'json',
    ]);
    if (!searchOut) return '歌曲搜索失败了';

    try {
      const records = JSON.parse(searchOut)?.data?.records ?? [];
      record = records.find((r) => r.visible !== false && !r.noCopyrightRcmd) ?? null;
    } catch {}

    if (!record) return `没找到能播放的${keyword}`;
    searchCache.set(keyword, { record, at: Date.now() });
  }

  const url = await resolvePlayUrl(record);
  if (!url) return '播放地址获取失败了';

  console.log(`🎵 播放：${record.name} - ${record.artists?.[0]?.name ?? ''}`);
  const core = record.name.replace(/[（(【[].*$/, '').trim();
  const artist = record.artists?.[0]?.name ?? '';
  const seq = ++playSeq;
  await engine.MiNA.callUbus(...playUrlCommand(url));

  // 管道归属确认放后台：立即返回不阻塞引擎，期间用户能马上说「请停止」等指令
  verifyPipeline(engine, { seq, core, artist, url }).catch(() => {});
  return null;
}

// 裸流经 player_play_music 播放时，音箱显示的标题是「请欣赏 (音乐)」而不是歌名，
// 以它作为我们流的标志（小爱原生曲目的标题是真实歌名，可区分归属）
async function verifyPipeline(engine, { seq, core, artist, url }) {
  const push = () => engine.MiNA.callUbus(...playUrlCommand(url));
  let lastPush = Date.now();
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (seq !== playSeq) return; // 已被新的点歌/播控/LLM 接管，放弃
    try {
      const status = await engine.MiNA.getStatus();
      if (status?.status === 'playing') {
        const detail = status?.play_song_detail ?? {};
        const title = detail?.title ?? '';
        console.log(`🎵 管道：playing，曲目：${title || '未知'} - ${detail?.artist ?? ''}`);
        if (title.includes('请欣赏') || title.includes(core) || (detail?.artist ?? '').includes(artist)) {
          lastPlayedCore = core; // 成功占住管道，记住是哪首歌
          return;
        }
        // 在放但不是我们的曲目（小爱的队列），下面节流重推替换
      }
      if (Date.now() - lastPush >= 5000) {
        await push();
        lastPush = Date.now();
      }
    } catch {}
  }
  if (seq !== playSeq) return;
  console.log('🎵 点歌失败：音箱播放失败了');
  await engine.MiOT.doAction(5, 1, '音箱播放失败了').catch(() => {});
}

function matchMusicIntent(text) {
  const m = text.match(
    /^(?:请|你)(?:帮我|给我|给我们)?(?:播放|放一首|放个|来一首|来个|我想听|想听|放|点)(?:一首|个|下|歌曲|音乐)?\s*(.+)$/,
  );
  if (!m) return null;
  const kw = m[1].trim().replace(/[。？！?!~，,.\s]+$/g, '');
  // 无具体歌名或明显是在提问的，不当作点歌
  if (!kw || /^(音乐|歌曲|歌|一首歌|个歌)$/.test(kw)) return null;
  if (/什么|怎么|吗|呢|哪|好不好|行不行/.test(kw)) return null;
  return kw;
}

function matchMusicControl(text) {
  if (/^(?:请|你)(?:帮我)?(?:暂停|停一下)(?:播放|音乐|歌)?/.test(text)) return 'pause';
  if (/^(?:请|你)(?:帮我)?(?:继续播放|恢复播放|接着播放|继续)/.test(text)) return 'resume';
  if (/^(?:请|你)(?:帮我)?(?:停止|关掉|停掉|别放)(?:播放|音乐|歌|了)?/.test(text)) return 'stop';
  return null;
}

/**
 * @type {import('@mi-gpt/next').MiGPTConfig}
 */
export default {
  debug: false, // 是否开启调试模式
  speaker: {
    /**
     * 小爱音箱在米家中设置的名称
     *
     * 如果提示找不到设备，请打开调试模式获取设备真实的 name、miotDID 或 mac 地址填入
     */
    did: '小爱触屏音箱',
    /**
     * 小米 ID（一串数字）
     *
     * 注意：不是手机号或邮箱，请在小米账号「个人信息」-「小米 ID」查看
     */
    userId: '你的小米ID（一串数字）',
    /**
     * 小米账号登录密码
     *
     * 如果提示登录失败，请使用 passToken 登录
     */
    password: '你的小米密码',
    /**
     * （可选）小米账号 passToken
     *
     * 获取教程：https://github.com/idootop/migpt-next/issues/4
     */
    passToken: '（可选）你的passToken',
  },
  openai: {
    // MiniMax 国内直连即可，不需要代理
    enableProxy: false,
    /**
     * 你的大模型服务提供商的接口地址
     *
     * 支持兼容 OpenAI 接口的大模型服务，比如：DeepSeek V3 等
     *
     * 注意：一般以 /v1 结尾，不包含 /chat/completions 部分
     */
    baseURL: 'https://api.minimaxi.com/v1',
    /**
     * API 密钥
     */
    apiKey: 'sk-你的MiniMax密钥',
    /**
     * 模型名称
     */
    model: 'MiniMax-M3',
    /**
     * 按需联网：依赖火山方舟 Responses API，MiniMax 不支持，这里关闭
     */
    webSearch: {
      enabled: false,
    },
    /**
     * 扩展配置
     */
    extra: {
      /**
       * 请求超时时间（毫秒），默认 30 秒
       */
      requestOptions: {
        timeout: 60000,
      },
      createParams: {
        // MiniMax-M3 是推理模型，关闭思考过程，避免音箱把 <think> 内容读出来
        thinking: { type: 'disabled' },
      },
    },
  },
  prompt: {
    /**
     * 系统提示词，如需关闭可设置为：''（空字符串）
     */
    system:
      '你是一个小爱音箱里的语音助手。回答必须口语化、简短自然，一般不超过三句话，直接说答案。不要使用任何 Markdown 格式（标题、加粗、列表等）、表情符号和特殊符号，因为你的回答会被直接转成语音播报。',
  },
  context: {
    /**
     * 每次对话携带的最大历史消息数（如需关闭可设置为：0）
     */
    historyMaxLength: 10,
  },
  /**
   * 流式响应配置
   */
  stream: {
    /**
     * 单次响应的最大长度（控制分句大小）
     * 小爱音箱对 TTS 文本长度有限制，建议不超过 100
     */
    maxReplyLength: 100,
  },
  /**
   * 只回答以下关键词开头的消息：
   *
   * - 请问地球为什么是圆的？
   * - 你知道世界上跑的最快的动物是什么吗？
   */
  callAIKeywords: ['请', '你'],
  /**
   * 自定义消息回复
   *
   * 只接管「请/你」开头的消息：播控 > 点歌 > 直接 LLM 回答（含按需联网）。
   * 不再做「小爱原生能答则保留」的判断，触发即接管；其余消息完全不碰。
   */
  async onMessage(engine, msg) {
    if (!engine.config.callAIKeywords?.some((keyword) => msg.text.startsWith(keyword))) {
      return;
    }

    // —— 音乐播控：停止 / 暂停 / 继续 ——
    const ctrl = matchMusicControl(msg.text);
    if (ctrl) {
      playSeq++; // 令后台管道确认失效，避免它把刚停的歌又推回去
      const action = ctrl === 'pause' ? 'pause' : ctrl === 'resume' ? 'play' : 'stop';
      await engine.MiNA.callUbus('mediaplayer', 'player_play_operation', {
        action,
        media: 'app_ios',
      });
      return { handled: true };
    }

    // —— 点歌播放 ——
    const keyword = matchMusicIntent(msg.text);
    if (keyword) {
      console.log(`🎵 音乐意图：${keyword}`);
      // 幂等：管道里已在放这首歌（裸流标题「请欣赏」+ 记录的核心名，或曲名/歌手直接命中）就不动
      const core = keyword.replace(/[（(【[].*$/, '').trim();
      const now = await engine.MiNA.getStatus();
      const detail = now?.play_song_detail ?? {};
      const title = detail?.title ?? '';
      if (
        now?.status === 'playing' &&
        (title.includes(core) || (detail?.artist ?? '').includes(core) || (title.includes('请欣赏') && lastPlayedCore === core))
      ) {
        console.log(`🎵 已在播放：${title || '未知'} - ${detail?.artist ?? ''}`);
        return { handled: true };
      }

      await stopMedia(engine);
      // 立刻语音应答并占住播报管道，压制小爱原生的「试听版」抢答
      await engine.MiOT.doAction(5, 1, `好的，为您播放${keyword}`);

      let notice = null;
      try {
        notice = await playMusicOnSpeaker(engine, keyword);
      } catch {
        notice = '点歌失败了，请稍后再试';
      }
      if (notice) {
        console.log(`🎵 点歌失败：${notice}`);
        await engine.MiOT.doAction(5, 1, notice);
      }
      return { handled: true };
    }

    // —— LLM 回答：打断 + 「正在思考中」占位 + MIoT 播报 ——
    // 注意：LX04 固件不支持 MiNA 的 mibrain text_to_speech（返回成功但不出声），
    // 必须走 MIoT doAction(5, 1)。5/3 是新版规格的编号，LX04 固件不认（-704220025）。
    playSeq++; // 令后台管道确认失效，避免它重推的音乐盖住 TTS
    await stopMedia(engine);

    await engine.MiOT.doAction(5, 1, '正在思考中');

    // 按需联网：命中时效性问题且有搜索 key 时，先搜索再回答
    let askText = msg.text;
    if (SEARCH.tavilyApiKey || SEARCH.bochaApiKey) {
      if (shouldSearch(msg.text)) {
        const context = await webSearch(cleanSearchQuery(msg.text));
        if (context) {
          console.log(`🌐 已使用联网搜索：${cleanSearchQuery(msg.text)}`);
          askText = `参考下面的联网搜索结果回答我的问题，信息冲突时以搜索结果为准，结果与问题无关时忽略它们凭你自己的知识回答；回答要口语化、简短，不要念出网址和序号：\n${context}\n\n我的问题：${msg.text}`;
        }
      }
    }

    // 用户提到「搜索/联网」但没实际注入结果（未触发或搜索失败）时，
    // 防止模型以「我无法搜索」为由拒答
    if (askText === msg.text && /搜索|联网|上网/.test(msg.text)) {
      askText = `${msg.text}\n（请直接基于已有知识回答这个问题，不要说自己无法搜索，也不要让用户自己去查。）`;
    }

    const { text } = await engine.askAI({ ...msg, text: askText }, { stream: false });
    if (text) {
      console.log(`🔊 ${text}`);
      await engine.MiOT.doAction(5, 1, text);
    }

    // 已用 MIoT 指令播报，阻止引擎再走默认的 MiNA TTS 链路
    return { handled: true };
  },
};
