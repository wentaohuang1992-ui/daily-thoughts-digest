/**
 * 每日观点自动归纳系统 - Railway 版本（带 FFmpeg 音频转换）
 */

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const redis = require('redis');
const axios = require('axios');
const cron = require('node-cron');
const dotenv = require('dotenv');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

dotenv.config();

// 设置 ffmpeg 路径
ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
app.use(express.json());

// ============ 配置 ============
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const YOUR_CHAT_ID = parseInt(process.env.MY_CHAT_ID || process.env.TELEGRAM_CHAT_ID);
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/chat/completions';
const PORT = process.env.PORT || 3000;

const REDIS_URL = process.env.REDIS_URL;

const BAIDU_APP_ID = process.env.BAIDU_APP_ID;
const BAIDU_API_KEY = process.env.BAIDU_API_KEY;
const BAIDU_SECRET_KEY = process.env.BAIDU_SECRET_KEY;
const BAIDU_TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token';
const BAIDU_ASR_URL = 'http://vop.baidu.com/server_api';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const redisClient = redis.createClient({ 
  url: REDIS_URL,
  socket: {
    tls: REDIS_URL && REDIS_URL.startsWith('rediss://'),
    rejectUnauthorized: false,
  }
});

redisClient.on('error', err => console.error('Redis error:', err.message));
redisClient.on('connect', () => console.log('✓ Redis connected'));

(async () => {
  try {
    await redisClient.connect();
  } catch (error) {
    console.error('Redis 连接失败:', error.message);
  }
})();

// ============ 百度 Token 管理 ============
let baiduAccessToken = null;
let baiduTokenExpireTime = 0;

async function getBaiduAccessToken() {
  try {
    if (baiduAccessToken && Date.now() < (baiduTokenExpireTime - 60000)) {
      return baiduAccessToken;
    }

    console.log('🔄 获取百度 Access Token...');

    const response = await axios.post(BAIDU_TOKEN_URL, null, {
      params: {
        grant_type: 'client_credentials',
        client_id: BAIDU_API_KEY,
        client_secret: BAIDU_SECRET_KEY,
      },
      timeout: 10000,
    });

    if (response.data && response.data.access_token) {
      baiduAccessToken = response.data.access_token;
      baiduTokenExpireTime = Date.now() + (response.data.expires_in * 1000);
      console.log('✓ 百度 Token 获取成功');
      return baiduAccessToken;
    } else {
      throw new Error(`获取 Token 失败: ${JSON.stringify(response.data)}`);
    }
  } catch (error) {
    console.error('获取百度 Token 错误:', error.message);
    throw new Error(`百度认证失败: ${error.message}`);
  }
}

// ============ 音频格式转换 ============
function convertOggToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`🔄 转换音频: ${inputPath} -> ${outputPath}`);
    
    ffmpeg(inputPath)
      .audioCodec('pcm_s16le')
      .audioFrequency(16000)
      .audioChannels(1)
      .format('wav')
      .on('end', () => {
        console.log('✓ 音频转换完成');
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error('❌ 音频转换失败:', err.message);
        reject(new Error(`音频转换失败: ${err.message}`));
      })
      .save(outputPath);
  });
}

// ============ 辅助函数 ============

function extractTags(text) {
  const tagRegex = /#[\u4e00-\u9fa5a-zA-Z0-9_]+/g;
  return text.match(tagRegex) || [];
}

function getTodayKey() {
  const today = new Date().toISOString().split('T')[0];
  return `thoughts:${today}`;
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

// ============ 百度语音识别 ============

async function recognizeVoiceWithBaidu(audioFilePath) {
  try {
    console.log(`🎙️ 使用百度语音识别: ${audioFilePath}`);

    if (!BAIDU_APP_ID || !BAIDU_API_KEY || !BAIDU_SECRET_KEY) {
      throw new Error('百度凭证配置缺失');
    }

    const token = await getBaiduAccessToken();

    const audioData = fs.readFileSync(audioFilePath);
    console.log(`音频大小: ${audioData.length} 字节`);

    const base64Audio = audioData.toString('base64');

    const requestBody = {
      format: 'wav',
      rate: 16000,
      dev_pid: 1537,
      channel: 1,
      cuid: `telegram_${YOUR_CHAT_ID}`,
      token: token,
      len: audioData.length,
      speech: base64Audio,
    };

    console.log('向百度语音识别 API 发送请求...');

    const response = await axios.post(BAIDU_ASR_URL, requestBody, {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    console.log('百度响应:', response.data);

    if (response.data.err_no !== 0) {
      throw new Error(`百度 API 错误 (${response.data.err_no}): ${response.data.err_msg}`);
    }

    if (response.data.result && response.data.result.length > 0) {
      const recognizedText = response.data.result[0];
      console.log(`✓ 识别成功: ${recognizedText}`);
      return recognizedText;
    } else {
      throw new Error('百度未返回识别结果');
    }

  } catch (error) {
    console.error('百度语音识别错误:', error.message);
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
• 用户观点原文
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

// ============ Telegram Bot 消息处理 ============

bot.on('message', async msg => {
  if (msg.chat.id !== YOUR_CHAT_ID) {
    return;
  }

  try {
    // 语音消息
    if (msg.voice) {
      await bot.sendMessage(YOUR_CHAT_ID, '🎙️ 正在识别语音...');
      
      const timestamp = Date.now();
      const tempOggPath = `/tmp/voice_${timestamp}.ogg`;
      const tempWavPath = `/tmp/voice_${timestamp}.wav`;
      
      try {
        const fileId = msg.voice.file_id;
        const file = await bot.getFile(fileId);
        const filePath = file.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
        
        await downloadFile(fileUrl, tempOggPath);
        await convertOggToWav(tempOggPath, tempWavPath);
        const recognizedText = await recognizeVoiceWithBaidu(tempWavPath);
        
        try { fs.unlinkSync(tempOggPath); } catch (e) {}
        try { fs.unlinkSync(tempWavPath); } catch (e) {}
        
        const caption = msg.caption || '';
        const tags = extractTags(caption);
        
        await saveThought(recognizedText, tags);
        
        await bot.sendMessage(YOUR_CHAT_ID, 
          `✓ 已保存${tags.length > 0 ? ' ' + tags.join(' ') : ''}\n\n📝 识别内容：${recognizedText}`
        );
      } catch (error) {
        console.error('语音处理错误:', error);
        
        try { fs.unlinkSync(tempOggPath); } catch (e) {}
        try { fs.unlinkSync(tempWavPath); } catch (e) {}
        
        await bot.sendMessage(YOUR_CHAT_ID, `❌ 语音识别失败：${error.message}`);
      }
      return;
    }

    // 文字消息
    const text = msg.text || '';

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

    if (text === '/help' || text === '/帮助' || text === '/start') {
      await bot.sendMessage(YOUR_CHAT_ID, `
<b>命令列表：</b>

<b>日常操作：</b>
• 直接发送消息 = 保存观点
• 发送语音 = 语音转文字自动保存
• 消息前加 ? = 实时聊天

<b>查看与导出：</b>
/today - 查看今日所有观点
/summary - 立即生成今日总结
/clear - 清空今日观点

每日自动生成总结时间：UTC 15:00（北京时间 23:00）
`, { parse_mode: 'HTML' });
      return;
    }

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

    const tags = extractTags(text);
    await saveThought(text, tags);
    await bot.sendMessage(YOUR_CHAT_ID, `✓ 已保存 ${tags.length > 0 ? tags.join(' ') : '(无标签)'}`);

  } catch (error) {
    console.error('消息处理错误:', error);
    await bot.sendMessage(YOUR_CHAT_ID, `❌ 处理失败：${error.message}`);
  }
});

bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});

cron.schedule('0 15 * * *', async () => {
  console.log('⏰ 触发每日总结任务...');
  await sendDailySummary();
});

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: '每日观点归纳系统运行中',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/test-baidu', async (req, res) => {
  try {
    if (!BAIDU_APP_ID || !BAIDU_API_KEY || !BAIDU_SECRET_KEY) {
      throw new Error('百度凭证未配置');
    }

    const token = await getBaiduAccessToken();

    res.json({ 
      success: true, 
      message: '✓ 百度语音识别连接成功',
      token_preview: token.substring(0, 20) + '...',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({ 
      success: false, 
      message: `❌ 百度语音识别连接失败: ${error.message}`,
      timestamp: new Date().toISOString()
    });
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

const server = app.listen(PORT, () => {
  console.log(`\n🚀 每日观点归纳系统启动（Railway 版）`);
  console.log(`📡 服务器运行在端口 ${PORT}`);
  console.log(`🤖 Telegram Bot ID: ${YOUR_CHAT_ID}`);
  console.log(`💾 Redis: ${REDIS_URL ? '已配置' : '未配置'}`);
  console.log(`🎙️ 语音识别: 百度云短语音识别（带 FFmpeg 转换）`);
  console.log(`🔄 每日总结时间: UTC 15:00 (北京时间 23:00)`);
  console.log(`📲 Telegram 模式: Polling\n`);

  console.log(`✓ 系统运行中`);
  console.log(`📍 可用端点：`);
  console.log(`   • GET  /health - 健康检查`);
  console.log(`   • GET  /test-baidu - 测试百度连接`);
  console.log(`   • POST /trigger-summary - 手动触发总结\n`);
});
