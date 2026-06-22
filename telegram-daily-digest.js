/**
 * 每日观点自动归纳系统
 * 功能：
 * - Telegram Bot 接收文字观点、语音消息
 * - 实时聊天（? 前缀提问）
 * - 阿里云语音识别（免费）
 * - Redis 存储
 * - DeepSeek 每日AI归纳
 * - Railway 部署
 */

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const redis = require('redis');
const axios = require('axios');
const cron = require('node-cron');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

dotenv.config();

const app = express();
app.use(express.json());

// ============ 配置 ============
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const YOUR_CHAT_ID = parseInt(process.env.TELEGRAM_CHAT_ID);
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/chat/completions';
const REDIS_URL = process.env.REDIS_URL;
const PORT = process.env.PORT || 3000;

// 阿里云配置
const ALIYUN_ACCESS_KEY_ID = process.env.ALIYUN_ACCESS_KEY_ID;
const ALIYUN_ACCESS_KEY_SECRET = process.env.ALIYUN_ACCESS_KEY_SECRET;

const bot = new TelegramBot(BOT_TOKEN);
const redisClient = redis.createClient({ url: REDIS_URL });

// ============ Redis 初始化 ============
redisClient.on('error', err => console.error('Redis error:', err));
redisClient.on('connect', () => console.log('✓ Redis connected'));

(async () => {
  await redisClient.connect();
})();

// ============ 辅助函数 ============

function extractTags(text) {
  const tagRegex = /#[\u4e00-\u9fa5a-zA-Z0-9_]+/g;
  return text.match(tagRegex) || [];
}

function getThoughtKey(date) {
  return `thoughts:${date}`;
}

function getTodayKey() {
  const today = new Date().toISOString().split('T')[0];
  return getThoughtKey(today);
}

async function saveThought(content, tags = []) {
  const key = getTodayKey();
  const thought = {
    content,
    tags,
    timestamp: new Date().toISOString(),
  };

  await redisClient.lPush(key, JSON.stringify(thought));
  await redisClient.expire(key, 90 * 24 * 60 * 60);

  console.log(`✓ Thought saved: ${content.substring(0, 30)}...`);
}

async function getTodayThoughts() {
  const key = getTodayKey();
  const rawThoughts = await redisClient.lRange(key, 0, -1);
  return rawThoughts.map(t => JSON.parse(t));
}

async function callDeepSeek(prompt) {
  try {
    const response = await axios.post(
      DEEPSEEK_BASE_URL,
      {
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: '你是一名资深投资分析师和内容编辑。你的任务是帮用户整理和归纳日常的投资观点。'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 1500,
      },
      {
        headers: {
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('DeepSeek API error:', error.response?.data || error.message);
    throw error;
  }
}

// ============ 阿里云语音识别 ============

async function recognizeVoiceWithAliyun(audioFilePath) {
  try {
    console.log(`🎙️ 使用阿里云语音识别: ${audioFilePath}`);
    
    if (!ALIYUN_ACCESS_KEY_ID || !ALIYUN_ACCESS_KEY_SECRET) {
      throw new Error('阿里云配置缺失（ALIYUN_ACCESS_KEY_ID 或 ALIYUN_ACCESS_KEY_SECRET）');
    }

    // 读取音频文件
    const audioData = fs.readFileSync(audioFilePath);
    const base64Audio = audioData.toString('base64');

    // 调用阿里云 API
    const timestamp = new Date().toISOString();
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    // 构建请求体
    const payload = {
      audio: base64Audio,
      format: 'OGG',
      sampleRate: 16000,
      enablePunctuation: true,
      language: 'zh-CN',
    };

    // 调用阿里云 AI 语音识别 API
    const response = await axios.post(
      'https://intelligentspeech.aliyuncs.com/openapi/recognizeShortAudio',
      payload,
      { headers, timeout: 30000 }
    );

    if (response.data && response.data.success === true) {
      const text = response.data.result?.text || response.data.data?.text || '无法识别内容';
      console.log(`✓ 识别成功: ${text}`);
      return text;
    } else if (response.data && response.data.result?.text) {
      const text = response.data.result.text;
      console.log(`✓ 识别成功: ${text}`);
      return text;
    } else {
      throw new Error(`阿里云返回错误: ${JSON.stringify(response.data)}`);
    }
  } catch (error) {
    console.error('阿里云语音识别错误:', error.message);
    throw new Error(`语音识别失败: ${error.message}`);
  }
}

async function downloadFile(fileUrl, filePath) {
  try {
    const response = await axios.get(fileUrl, { 
      responseType: 'arraybuffer',
      timeout: 30000 
    });
    fs.writeFileSync(filePath, response.data);
    return filePath;
  } catch (error) {
    console.error('文件下载错误:', error.message);
    throw error;
  }
}

// ============ 每日总结 ============

async function generateDailySummary() {
  const thoughts = await getTodayThoughts();

  if (thoughts.length === 0) {
    return '今天暂无观点记录。';
  }

  const taggedThoughts = {};
  thoughts.forEach(t => {
    const tags = t.tags.length > 0 ? t.tags.join('/') : '其他';
    if (!taggedThoughts[tags]) {
      taggedThoughts[tags] = [];
    }
    taggedThoughts[tags].push(t.content);
  });

  const thoughtsText = Object.entries(taggedThoughts)
    .map(([tag, contents]) => `【${tag}】\n${contents.map(c => `• ${c}`).join('\n')}`)
    .join('\n\n');

  const prompt = `你的任务是整理用户的日常观点笔记。严格按照用户的原文，不要添加、推理或扩展任何内容。

用户提供的原始观点：
${thoughtsText}

要求：
1. 按标签分类用户的原文观点（不添加新内容）
2. 保持用户的原意，只做分类和整理
3. 标注可用于评论转发的观点（用 💡 标记）
4. 不要进行推理、补充或扩展
5. 若某个观点较短，直接保留原文，不要补充内容
6. 末尾附上所有 #标签便于使用

输出格式示例：
【标签分类】
- 用户观点原文
  💡 可复用部分

标签：#投资 #技术 #供应链`;

  return await callDeepSeek(prompt);
}

async function sendDailySummary() {
  try {
    const summary = await generateDailySummary();
    const today = new Date().toISOString().split('T')[0];

    const message = `📊 <b>每日观点总结 - ${today}</b>\n\n${summary}\n\n<i>自动生成于 ${new Date().toLocaleTimeString('zh-CN')}</i>`;

    await bot.sendMessage(YOUR_CHAT_ID, message, { parse_mode: 'HTML' });
    console.log('✓ Daily summary sent');

    const archiveKey = `summary:${today}`;
    await redisClient.set(archiveKey, summary, { EX: 365 * 24 * 60 * 60 });
  } catch (error) {
    console.error('Failed to send daily summary:', error);
    await bot.sendMessage(
      YOUR_CHAT_ID,
      `❌ 每日总结生成失败：${error.message}`
    );
  }
}

// ============ Telegram Bot 事件处理 ============

bot.on('message', async msg => {
  if (msg.chat.id !== YOUR_CHAT_ID) {
    return;
  }

  try {
    // ============ 处理语音消息 ============
    if (msg.voice) {
      await bot.sendMessage(YOUR_CHAT_ID, '🎙️ 正在识别语音...');
      
      try {
        // 获取语音文件
        const fileId = msg.voice.file_id;
        const file = await bot.getFile(fileId);
        const filePath = file.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
        
        // 下载语音文件到临时位置
        const tempAudioPath = `/tmp/voice_${Date.now()}.ogg`;
        await downloadFile(fileUrl, tempAudioPath);
        
        // 识别语音
        const recognizedText = await recognizeVoiceWithAliyun(tempAudioPath);
        
        // 清理临时文件
        try {
          fs.unlinkSync(tempAudioPath);
        } catch (e) {
          console.error('删除临时文件失败:', e);
        }
        
        // 提取标签（从消息的 caption 中）
        const caption = msg.caption || '';
        const tags = extractTags(caption);
        
        // 保存为观点
        await saveThought(recognizedText, tags);
        
        await bot.sendMessage(YOUR_CHAT_ID, 
          `✓ 已保存${tags.length > 0 ? ' ' + tags.join(' ') : ''}\n\n📝 识别内容：${recognizedText}`
        );
      } catch (error) {
        console.error('语音处理错误:', error);
        await bot.sendMessage(YOUR_CHAT_ID, `❌ 语音识别失败：${error.message}`);
      }
      return;
    }

    // ============ 处理文字消息 ============
    const text = msg.text || '';

    // 命令处理
    if (text === '/today' || text === '/今天') {
      const thoughts = await getTodayThoughts();
      const thoughtsList = thoughts
        .reverse()
        .map(t => `⏰ ${t.timestamp}\n${t.content}${t.tags.length > 0 ? ` ${t.tags.join(' ')}` : ''}`)
        .join('\n\n');

      const reply = thoughts.length === 0 
        ? '今天暂无观点'
        : `📝 今天共 ${thoughts.length} 条观点：\n\n${thoughtsList}`;

      await bot.sendMessage(YOUR_CHAT_ID, reply);
      return;
    }

    if (text === '/summary' || text === '/总结') {
      await bot.sendMessage(YOUR_CHAT_ID, '⏳ 正在生成总结...');
      await sendDailySummary();
      return;
    }

    if (text === '/clear') {
      const key = getTodayKey();
      await redisClient.del(key);
      await bot.sendMessage(YOUR_CHAT_ID, '✓ 今日观点已清空');
      return;
    }

    if (text === '/help' || text === '/帮助') {
      await bot.sendMessage(YOUR_CHAT_ID, `
<b>命令列表：</b>

<b>日常操作：</b>
- 直接发送消息 = 保存观点
  例：#投资 光伏逆变器价格战...
  （自动提取 #投资 标签）

- 发送语音 = 语音转文字自动保存
  例：[录音语音] 可选加标签 #投资

<b>实时聊天：</b>
- 消息前加 ? 来提问（AI 实时回复）
  例：? ASML 的护城河是什么

<b>查看与导出：</b>
/today - 查看今日所有观点
/summary - 立即生成今日总结
/clear - 清空今日观点

<b>系统：</b>
/help - 显示此帮助

每日自动生成总结时间：UTC 15:00（北京时间 23:00）
`, { parse_mode: 'HTML' });
      return;
    }

    // ============ 处理实时聊天（? 前缀） ============
    if (text.startsWith('?')) {
      const question = text.substring(1).trim();
      await bot.sendMessage(YOUR_CHAT_ID, '⏳ 思考中...');
      
      try {
        const response = await callDeepSeek(question);
        await bot.sendMessage(YOUR_CHAT_ID, response);
      } catch (error) {
        await bot.sendMessage(YOUR_CHAT_ID, `❌ 回复失败：${error.message}`);
      }
      return;
    }

    // ============ 处理普通观点消息 ============
    const tags = extractTags(text);
    await saveThought(text, tags);
    await bot.sendMessage(YOUR_CHAT_ID, `✓ 已保存 ${tags.length > 0 ? tags.join(' ') : '(无标签)'}`);

  } catch (error) {
    console.error('消息处理错误:', error);
    await bot.sendMessage(YOUR_CHAT_ID, `❌ 处理失败：${error.message}`);
  }
});

// ============ 定时任务 ============
// 北京时间 23:00 = UTC 15:00
cron.schedule('0 15 * * *', async () => {
  console.log('⏰ 触发每日总结任务...');
  await sendDailySummary();
});

// ============ Express 服务器 ============

app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/summary/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const key = `summary:${date}`;
    const summary = await redisClient.get(key);
    res.json({ date, summary: summary || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/trigger-summary', async (req, res) => {
  try {
    await sendDailySummary();
    res.json({ success: true, message: 'Summary triggered' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ 启动 ============

const server = app.listen(PORT, () => {
  console.log(`\n🚀 每日观点归纳系统启动`);
  console.log(`📡 服务器运行在端口 ${PORT}`);
  console.log(`🤖 Telegram Bot ID: ${YOUR_CHAT_ID}`);
  console.log(`💾 Redis: ${REDIS_URL ? '已连接' : '未配置'}`);
  console.log(`🎙️ 语音识别: 阿里云（${ALIYUN_ACCESS_KEY_ID ? '已配置' : '未配置'}）`);
  console.log(`🔄 每日总结时间: UTC 15:00 (北京时间 23:00)\n`);

  bot.startPolling();
});

process.on('SIGINT', async () => {
  console.log('\n关闭中...');
  bot.stopPolling();
  await redisClient.quit();
  server.close(() => {
    console.log('已关闭');
    process.exit(0);
  });
});
