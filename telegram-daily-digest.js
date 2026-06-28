/**
 * 个人思考记录系统 - Railway 版本
 * 功能：
 * - 文字 + 语音记录
 * - 每日/每周/每月回顾
 * - AI 思考伴侣（偶尔追问）
 * - Redis 365 天保留
 */

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const redis = require('redis');
const axios = require('axios');
const cron = require('node-cron');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.json());

// ============ 配置 ============
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// 支持多个 chat id（逗号分隔）
// 优先用 ALLOWED_CHAT_IDS，否则回退到 MY_CHAT_ID
const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || process.env.MY_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '')
  .split(',')
  .map(id => id.trim())
  .filter(id => id)
  .map(id => parseInt(id))
  .filter(id => !isNaN(id));

// 主账号（用于自动推送总结），使用第一个 chat id
const YOUR_CHAT_ID = ALLOWED_CHAT_IDS[0];

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/chat/completions';
const PORT = process.env.PORT || 3000;

const REDIS_URL = process.env.REDIS_URL;

// 火山引擎语音识别配置
// 支持两种鉴权方式：
// 方式 1（新版控制台）: 只需要 VOLC_API_KEY
// 方式 2（旧版控制台）: VOLC_APP_KEY + VOLC_ACCESS_KEY
const VOLC_API_KEY = process.env.VOLC_API_KEY;       // 新版
const VOLC_APP_KEY = process.env.VOLC_APP_KEY;       // 旧版（也叫 AppID）
const VOLC_ACCESS_KEY = process.env.VOLC_ACCESS_KEY; // 旧版

const VOLC_ASR_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
const VOLC_RESOURCE_ID = 'volc.bigasr.auc_turbo';

// 数据保留时间：365 天
const RETENTION_DAYS = 365;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const redisClient = redis.createClient({ 
  url: REDIS_URL,
  socket: {
    tls: REDIS_URL && REDIS_URL.startsWith('rediss://'),
    rejectUnauthorized: false,
  }
});

// 记录最近未授权的 chat id（用于查询）
const recentUnauthorizedChats = [];

redisClient.on('error', err => console.error('Redis error:', err.message));
redisClient.on('connect', () => console.log('✓ Redis connected'));

(async () => {
  try {
    await redisClient.connect();
  } catch (error) {
    console.error('Redis 连接失败:', error.message);
  }
})();

// ============ 火山引擎语音识别 ============

// ============ 辅助函数 ============

function extractTags(text) {
  const tagRegex = /#[\u4e00-\u9fa5a-zA-Z0-9_]+/g;
  return text.match(tagRegex) || [];
}

function getDateString(date = new Date()) {
  return date.toISOString().split('T')[0];
}

function getThoughtKey(dateStr) {
  return `thoughts:${dateStr}`;
}

function getTodayKey() {
  return getThoughtKey(getDateString());
}

async function saveThought(content, tags = []) {
  const key = getTodayKey();
  const thought = {
    content,
    tags,
    timestamp: new Date().toISOString(),
  };

  await redisClient.lPush(key, JSON.stringify(thought));
  await redisClient.expire(key, RETENTION_DAYS * 24 * 60 * 60);

  console.log(`✓ Thought saved: ${content.substring(0, 30)}...`);
}

async function getTodayThoughts() {
  const key = getTodayKey();
  const rawThoughts = await redisClient.lRange(key, 0, -1);
  return rawThoughts.map(t => JSON.parse(t));
}

/**
 * 获取最近 N 天的观点
 */
async function getRecentThoughts(days) {
  const allThoughts = [];
  const now = new Date();
  
  for (let i = 0; i < days; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const key = getThoughtKey(getDateString(date));
    
    const rawThoughts = await redisClient.lRange(key, 0, -1);
    const thoughts = rawThoughts.map(t => ({
      ...JSON.parse(t),
      date: getDateString(date),
    }));
    
    allThoughts.push(...thoughts);
  }
  
  // 按时间排序（旧的在前）
  return allThoughts.sort((a, b) => 
    new Date(a.timestamp) - new Date(b.timestamp)
  );
}

/**
 * 获取本周观点（周一到周日）
 */
async function getThisWeekThoughts() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sunday, 1=Monday
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  
  return await getRecentThoughts(daysSinceMonday + 1);
}

/**
 * 获取本月观点
 */
async function getThisMonthThoughts() {
  const now = new Date();
  const daysInMonth = now.getDate();
  return await getRecentThoughts(daysInMonth);
}

// ============ DeepSeek 调用 ============

const SYSTEM_PROMPT = `你是用户的思考伴侣，帮助用户记录和回顾日常感悟。
你的风格：
- 客观、克制
- 在合适的时候展现温度，但不滥用情感表达
- 不堆砌华丽辞藻
- 像一个有洞察力的朋友，而不是 AI 助手`;

async function callDeepSeek(prompt, systemPrompt = SYSTEM_PROMPT) {
  try {
    const response = await axios.post(
      DEEPSEEK_BASE_URL,
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 2000,
      },
      {
        headers: {
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('DeepSeek API error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * AI 判断是否需要追问，并生成追问
 * 返回：追问内容 或 null
 */
async function generateFollowUpQuestion(content) {
  const prompt = `用户刚记录了一条想法：

"${content}"

判断这条记录是否值得追问。

【需要追问的情况】
- 提到强烈或复杂的情绪（焦虑、低落、困惑、烦躁等）
- 提到模糊的感受（"说不清"、"有点怪"、"不知道为什么"）
- 提到未完成的思考或重要决定
- 提到反复出现的困扰

【不需要追问的情况】
- 客观事实记录（今天开会、吃了什么）
- 已经表达完整的想法
- 短小的备忘录
- 中性、平淡的内容

如果需要追问，回复一个简短、克制、有洞察力的问题（不超过30字）。
如果不需要追问，只回复"无"。

只输出问题或"无"，不要任何额外解释。`;

  try {
    const response = await callDeepSeek(prompt, '你善于判断什么样的内容值得深入思考。');
    const trimmed = response.trim().replace(/^["「『]+|["」』]+$/g, '');
    
    if (trimmed === '无' || trimmed.length < 5 || trimmed.length > 60) {
      return null;
    }
    
    return trimmed;
  } catch (error) {
    console.error('生成追问失败:', error.message);
    return null;
  }
}

// ============ 火山引擎语音识别（极速版）============

async function recognizeVoiceWithVolc(audioUrl, audioFormat = 'ogg') {
  try {
    console.log(`🎙️ 使用火山引擎识别: ${audioUrl}`);

    // 判断使用新版还是旧版鉴权
    const useNewAuth = !!VOLC_API_KEY;
    const useOldAuth = !!(VOLC_APP_KEY && VOLC_ACCESS_KEY);

    if (!useNewAuth && !useOldAuth) {
      throw new Error('火山引擎凭证未配置（需要 VOLC_API_KEY，或 VOLC_APP_KEY + VOLC_ACCESS_KEY）');
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // 根据鉴权方式构造 headers
    let headers;
    if (useNewAuth) {
      console.log('使用新版鉴权 (X-Api-Key)');
      headers = {
        'X-Api-Key': VOLC_API_KEY,
        'X-Api-Resource-Id': VOLC_RESOURCE_ID,
        'X-Api-Request-Id': requestId,
        'X-Api-Sequence': '-1',
        'Content-Type': 'application/json',
      };
    } else {
      console.log('使用旧版鉴权 (X-Api-App-Key + X-Api-Access-Key)');
      headers = {
        'X-Api-App-Key': VOLC_APP_KEY,
        'X-Api-Access-Key': VOLC_ACCESS_KEY,
        'X-Api-Resource-Id': VOLC_RESOURCE_ID,
        'X-Api-Request-Id': requestId,
        'X-Api-Sequence': '-1',
        'Content-Type': 'application/json',
      };
    }

    const requestBody = {
      user: {
        uid: `telegram_${YOUR_CHAT_ID}`,
      },
      audio: {
        url: audioUrl,
        format: audioFormat,
      },
      request: {
        model_name: 'bigmodel',
        enable_itn: true,
        enable_punc: true,
        enable_ddc: true,
      },
    };

    console.log('向火山引擎发送请求...');

    const response = await axios.post(VOLC_ASR_URL, requestBody, {
      headers,
      timeout: 60000,
    });

    console.log('火山引擎响应 status:', response.status);
    console.log('火山引擎响应 headers:', JSON.stringify(response.headers));
    console.log('火山引擎响应 data:', JSON.stringify(response.data).substring(0, 500));

    // 检查响应头中的状态码
    const apiStatusCode = response.headers['x-api-status-code'];
    const apiMessage = response.headers['x-api-message'];

    if (apiStatusCode && apiStatusCode !== '20000000') {
      throw new Error(`火山引擎错误 ${apiStatusCode}: ${apiMessage || '未知错误'}`);
    }

    // 提取识别结果
    if (response.data && response.data.result) {
      const result = response.data.result;
      
      // 大模型返回的 text 字段
      if (result.text) {
        console.log(`✓ 识别成功: ${result.text}`);
        return result.text;
      }
      
      // 兼容其他可能的格式
      if (result.utterances && result.utterances.length > 0) {
        const text = result.utterances.map(u => u.text).join('');
        console.log(`✓ 识别成功: ${text}`);
        return text;
      }
    }

    throw new Error(`火山引擎返回格式异常: ${JSON.stringify(response.data).substring(0, 200)}`);

  } catch (error) {
    if (error.response) {
      console.error('火山引擎响应错误 status:', error.response.status);
      console.error('火山引擎响应错误 data:', JSON.stringify(error.response.data));
      const apiStatusCode = error.response.headers?.['x-api-status-code'];
      const apiMessage = error.response.headers?.['x-api-message'];
      if (apiStatusCode) {
        throw new Error(`火山引擎错误 ${apiStatusCode}: ${apiMessage || error.message}`);
      }
    }
    console.error('火山引擎识别错误:', error.message);
    throw new Error(`语音识别失败: ${error.message}`);
  }
}

// ============ 每日总结 ============

async function generateDailySummary() {
  const thoughts = await getTodayThoughts();

  if (thoughts.length === 0) {
    return null;
  }

  const thoughtsText = thoughts
    .reverse() // 按时间正序
    .map((t, i) => `${i + 1}. [${new Date(t.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}] ${t.content}${t.tags.length > 0 ? ' ' + t.tags.join(' ') : ''}`)
    .join('\n');

  const prompt = `以下是用户今天记录的想法和感悟（按时间排序）：

${thoughtsText}

请生成今日回顾，格式如下：

【今天主要在想】
用 2-4 个要点概括今天关注的话题（不要分类成"工作/生活"等死板的分类，而是按实际主题）

【状态感受】
今天的整体状态。只在有明显情绪起伏时指出，平淡的一天就写"整体平稳"。

【值得继续想的】
1-2 个值得继续思考的点（必须基于用户的原话，不要自由发挥）

【一个问题】（可选，只在有合适素材时才写）
一个值得用户回头思考的问题。如果没有合适的，这部分可以省略。

要求：
- 客观、克制，不要过度阐释
- 不要用"你今天经历了..."这种煽情的开头
- 不要堆砌华丽辞藻
- 保持原话的精神，不要美化或推理
- 总长度控制在 300 字以内`;

  return await callDeepSeek(prompt);
}

async function sendDailySummary(silent = false, chatId = YOUR_CHAT_ID) {
  try {
    const summary = await generateDailySummary();
    const today = getDateString();

    if (!summary) {
      if (!silent) {
        await bot.sendMessage(chatId, '📝 今天还没有记录。');
      }
      return;
    }

    const message = `📊 <b>今日回顾 - ${today}</b>\n\n${summary}`;
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });

    const archiveKey = `summary:${today}`;
    await redisClient.set(archiveKey, summary, { EX: 365 * 24 * 60 * 60 });
    
    console.log('✓ Daily summary sent');
  } catch (error) {
    console.error('Failed to send daily summary:', error);
    if (!silent) {
      await bot.sendMessage(chatId, `❌ 总结生成失败：${error.message}`);
    }
  }
}

// ============ 周回顾 ============

async function generateWeeklyReview() {
  const thoughts = await getThisWeekThoughts();

  if (thoughts.length === 0) {
    return null;
  }

  // 按天分组
  const byDay = {};
  thoughts.forEach(t => {
    if (!byDay[t.date]) byDay[t.date] = [];
    byDay[t.date].push(t.content);
  });

  const thoughtsText = Object.entries(byDay)
    .map(([date, contents]) => `${date}：\n${contents.map(c => `  - ${c}`).join('\n')}`)
    .join('\n\n');

  const prompt = `以下是用户本周记录的所有想法（按日期组织）：

${thoughtsText}

请生成本周回顾，格式如下：

【本周主题】
列出 3-5 个本周反复出现或重要的主题

【状态变化】
本周状态的整体走向。如果有明显起伏，指出大概在哪几天。如果整体平稳，就写"整体平稳"。

【反复出现的】
用户这周多次提到的话题或感受（指出大致出现的频率）。这些往往是真正在意的事。

【未完成的思考】
本周有没有提出但没想清楚的问题/困惑。

【一个反思问题】（可选）
基于本周内容，提出一个值得深思的问题。只在有合适素材时才写。

要求：
- 客观、克制
- 不要过度阐释
- 不要堆砌情感
- 基于用户原话，不要自由发挥
- 总长度控制在 500 字以内`;

  return await callDeepSeek(prompt);
}

async function sendWeeklyReview(chatId = YOUR_CHAT_ID) {
  try {
    const review = await generateWeeklyReview();
    
    if (!review) {
      await bot.sendMessage(chatId, '📝 本周还没有足够的记录可以回顾。');
      return;
    }

    // 计算本周日期范围
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(now);
    monday.setDate(monday.getDate() - daysSinceMonday);
    const weekRange = `${getDateString(monday)} 至 ${getDateString(now)}`;

    const message = `📅 <b>本周回顾</b>\n<i>${weekRange}</i>\n\n${review}`;
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });

    const archiveKey = `weekly:${getDateString()}`;
    await redisClient.set(archiveKey, review, { EX: 365 * 24 * 60 * 60 });

    console.log('✓ Weekly review sent');
  } catch (error) {
    console.error('Failed to send weekly review:', error);
    await bot.sendMessage(chatId, `❌ 周回顾生成失败：${error.message}`);
  }
}

// ============ 月回顾 ============

async function generateMonthlyReview() {
  const thoughts = await getThisMonthThoughts();

  if (thoughts.length === 0) {
    return null;
  }

  // 按天分组
  const byDay = {};
  thoughts.forEach(t => {
    if (!byDay[t.date]) byDay[t.date] = [];
    byDay[t.date].push(t.content);
  });

  const thoughtsText = Object.entries(byDay)
    .map(([date, contents]) => `${date}：\n${contents.map(c => `  - ${c}`).join('\n')}`)
    .join('\n\n');

  const prompt = `以下是用户本月记录的所有想法（按日期组织）：

${thoughtsText}

请生成本月回顾，格式如下：

【主题地图】
本月最主要的 5-6 个主题，按重要程度排序

【变化轨迹】
用户在哪些方面有变化、新的想法、新的关注点

【模式识别】
用户重复出现的关注点、情绪模式、思考习惯

【未完成的思考】
本月有哪些问题/困惑还没想清楚

【值得深思的】
基于本月内容，提出 1-2 个值得深思的问题

要求：
- 客观、克制
- 不要过度阐释或煽情
- 基于用户原话，不要自由发挥
- 像一个细心的观察者写下他注意到的事
- 总长度控制在 800 字以内`;

  return await callDeepSeek(prompt);
}

async function sendMonthlyReview(chatId = YOUR_CHAT_ID) {
  try {
    const review = await generateMonthlyReview();
    
    if (!review) {
      await bot.sendMessage(chatId, '📝 本月还没有足够的记录可以回顾。');
      return;
    }

    const now = new Date();
    const monthStr = `${now.getFullYear()}年${now.getMonth() + 1}月`;

    const message = `🗓 <b>${monthStr}回顾</b>\n\n${review}`;
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });

    const archiveKey = `monthly:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    await redisClient.set(archiveKey, review, { EX: 365 * 24 * 60 * 60 });

    console.log('✓ Monthly review sent');
  } catch (error) {
    console.error('Failed to send monthly review:', error);
    await bot.sendMessage(chatId, `❌ 月回顾生成失败：${error.message}`);
  }
}

// ============ Telegram Bot 消息处理 ============

bot.on('message', async msg => {
  // 检查 chat id 是否在允许列表中
  if (!ALLOWED_CHAT_IDS.includes(msg.chat.id)) {
    console.log(`⚠️  未授权的 chat_id: ${msg.chat.id}, 消息: ${msg.text || '(非文本)'}`);
    
    // 记录未授权的 chat id（用于调试）
    recentUnauthorizedChats.unshift({
      chat_id: msg.chat.id,
      username: msg.chat.username || '未设置',
      first_name: msg.chat.first_name || '',
      last_name: msg.chat.last_name || '',
      text: msg.text || '(非文本消息)',
      timestamp: new Date().toISOString(),
    });
    
    // 只保留最近 10 条
    if (recentUnauthorizedChats.length > 10) {
      recentUnauthorizedChats.length = 10;
    }
    
    return;
  }

  try {
    // 语音消息
    if (msg.voice) {
      await bot.sendMessage(msg.chat.id, '🎙️ 正在识别...');
      
      try {
        // 直接获取 Telegram 的 URL，火山引擎可以直接访问
        const fileId = msg.voice.file_id;
        const file = await bot.getFile(fileId);
        const filePath = file.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
        
        // 火山引擎直接识别 URL（无需下载、无需 FFmpeg）
        const recognizedText = await recognizeVoiceWithVolc(fileUrl, 'ogg');
        
        const caption = msg.caption || '';
        const tags = extractTags(caption);
        
        await saveThought(recognizedText, tags);
        
        // 发送保存确认 + 识别内容
        await bot.sendMessage(msg.chat.id, 
          `✓ 已保存${tags.length > 0 ? ' ' + tags.join(' ') : ''}\n\n📝 ${recognizedText}`
        );
        
        // AI 判断是否需要追问
        const followUp = await generateFollowUpQuestion(recognizedText);
        if (followUp) {
          await bot.sendMessage(msg.chat.id, `—— ${followUp}`);
        }
        
      } catch (error) {
        console.error('语音处理错误:', error);
        await bot.sendMessage(msg.chat.id, `❌ 识别失败：${error.message}`);
      }
      return;
    }

    // 文字消息
    const text = msg.text || '';

    // 命令处理
    if (text === '/today' || text === '/今天') {
      const thoughts = await getTodayThoughts();
      if (thoughts.length === 0) {
        await bot.sendMessage(msg.chat.id, '今天还没有记录');
        return;
      }
      
      const list = thoughts
        .reverse()
        .map(t => {
          const time = new Date(t.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
          return `⏰ ${time}\n${t.content}${t.tags.length > 0 ? '\n' + t.tags.join(' ') : ''}`;
        })
        .join('\n\n');
      
      await bot.sendMessage(msg.chat.id, `📝 今天共 ${thoughts.length} 条记录：\n\n${list}`);
      return;
    }

    if (text === '/summary' || text === '/总结') {
      await bot.sendMessage(msg.chat.id, '⏳ 正在生成今日回顾...');
      await sendDailySummary(false, msg.chat.id);
      return;
    }

    if (text === '/week' || text === '/周') {
      await bot.sendMessage(msg.chat.id, '⏳ 正在生成本周回顾...');
      await sendWeeklyReview(msg.chat.id);
      return;
    }

    if (text === '/month' || text === '/月') {
      await bot.sendMessage(msg.chat.id, '⏳ 正在生成本月回顾...');
      await sendMonthlyReview(msg.chat.id);
      return;
    }

    if (text === '/clear') {
      const key = getTodayKey();
      await redisClient.del(key);
      await bot.sendMessage(msg.chat.id, '✓ 今日记录已清空');
      return;
    }

    if (text === '/help' || text === '/帮助' || text === '/start') {
      await bot.sendMessage(msg.chat.id, `
<b>📝 个人思考记录系统</b>

<b>日常使用：</b>
• 直接发送文字/语音 → 自动保存
• 加 # 标签可以分类
• 以 ? 开头 → 实时 AI 聊天

<b>查看与回顾：</b>
/today - 今日所有记录
/summary - 立即生成今日回顾
/week - 本周回顾
/month - 本月回顾
/clear - 清空今日记录

<b>自动生成：</b>
• 每日 23:00 - 今日回顾
• 每周日 22:00 - 本周回顾
• 每月最后一天 22:00 - 本月回顾

<b>数据保留：</b>
365 天
`, { parse_mode: 'HTML' });
      return;
    }

    // 实时聊天
    if (text.startsWith('?') || text.startsWith('?')) {
      const question = text.substring(1).trim();
      await bot.sendMessage(msg.chat.id, '⏳ 思考中...');
      
      try {
        const response = await callDeepSeek(question);
        await bot.sendMessage(msg.chat.id, response);
      } catch (error) {
        await bot.sendMessage(msg.chat.id, `❌ 回复失败：${error.message}`);
      }
      return;
    }

    // 保存观点
    const tags = extractTags(text);
    await saveThought(text, tags);
    await bot.sendMessage(msg.chat.id, `✓ 已保存${tags.length > 0 ? ' ' + tags.join(' ') : ''}`);
    
    // AI 判断是否需要追问
    const followUp = await generateFollowUpQuestion(text);
    if (followUp) {
      await bot.sendMessage(msg.chat.id, `—— ${followUp}`);
    }

  } catch (error) {
    console.error('消息处理错误:', error);
    await bot.sendMessage(msg.chat.id, `❌ 处理失败：${error.message}`);
  }
});

bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});

// ============ 定时任务 ============

// 每日 23:00（北京时间）= UTC 15:00
cron.schedule('0 15 * * *', async () => {
  console.log('⏰ 触发每日回顾...');
  await sendDailySummary(true);
});

// 每周日 22:00（北京时间）= UTC 14:00 周日
cron.schedule('0 14 * * 0', async () => {
  console.log('⏰ 触发本周回顾...');
  await sendWeeklyReview();
});

// 每月最后一天 22:00（北京时间）= UTC 14:00
// 用 cron 实现"每月最后一天"需要特殊处理
cron.schedule('0 14 * * *', async () => {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  // 如果明天是下个月的第1天，今天就是本月最后一天
  if (tomorrow.getDate() === 1) {
    console.log('⏰ 触发本月回顾...');
    await sendMonthlyReview();
  }
});

// ============ Express 服务器 ============

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: '个人思考记录系统运行中',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/test-volc', async (req, res) => {
  try {
    const useNewAuth = !!VOLC_API_KEY;
    const useOldAuth = !!(VOLC_APP_KEY && VOLC_ACCESS_KEY);

    if (!useNewAuth && !useOldAuth) {
      throw new Error('火山引擎凭证未配置（需要 VOLC_API_KEY，或 VOLC_APP_KEY + VOLC_ACCESS_KEY）');
    }
    
    res.json({ 
      success: true, 
      message: '✓ 火山引擎凭证已配置',
      auth_mode: useNewAuth ? '新版（X-Api-Key）' : '旧版（X-Api-App-Key + X-Api-Access-Key）',
      credentials_preview: useNewAuth 
        ? { api_key: VOLC_API_KEY.substring(0, 6) + '***' }
        : { 
            app_key: VOLC_APP_KEY.substring(0, 6) + '***',
            access_key: VOLC_ACCESS_KEY.substring(0, 6) + '***'
          },
      api_url: VOLC_ASR_URL,
      resource_id: VOLC_RESOURCE_ID,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({ 
      success: false, 
      message: `❌ ${error.message}`,
      timestamp: new Date().toISOString()
    });
  }
});

// 查看当前授权的 chat IDs 和最近被拒绝的 chat IDs
app.get('/get-chat-ids', (req, res) => {
  res.json({
    allowed_chat_ids: ALLOWED_CHAT_IDS,
    recent_unauthorized: recentUnauthorizedChats,
    hint: '把需要的 chat_id 添加到 Railway 环境变量 ALLOWED_CHAT_IDS（多个用逗号分隔），然后重新部署',
    timestamp: new Date().toISOString()
  });
});

app.post('/trigger-summary', async (req, res) => {
  try {
    await sendDailySummary();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/trigger-weekly', async (req, res) => {
  try {
    await sendWeeklyReview();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/trigger-monthly', async (req, res) => {
  try {
    await sendMonthlyReview();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 个人思考记录系统启动`);
  console.log(`📡 端口 ${PORT}`);
  console.log(`🤖 授权的 Chat IDs: ${ALLOWED_CHAT_IDS.join(', ')}`);
  console.log(`💾 Redis: ${REDIS_URL ? '已配置' : '未配置'}`);
  console.log(`🎙️ 语音: 火山引擎大模型录音文件识别（极速版）`);
  console.log(`📅 数据保留: ${RETENTION_DAYS} 天`);
  console.log(`\n📆 定时任务：`);
  console.log(`   • 每日 23:00 - 今日回顾`);
  console.log(`   • 每周日 22:00 - 本周回顾`);
  console.log(`   • 每月最后一天 22:00 - 本月回顾\n`);
});
