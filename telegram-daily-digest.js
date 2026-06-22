/**
 * 每日观点自动归纳系统
 * - Telegram Bot 接收消息
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

dotenv.config();

const app = express();
app.use(express.json());

// ============ 配置 ============
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const YOUR_CHAT_ID = parseInt(process.env.TELEGRAM_CHAT_ID); // 你的私人Telegram ID
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/chat/completions';
const REDIS_URL = process.env.REDIS_URL;
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(BOT_TOKEN);
const redisClient = redis.createClient({ url: REDIS_URL });

// ============ Redis 初始化 ============
redisClient.on('error', err => console.error('Redis error:', err));
redisClient.on('connect', () => console.log('✓ Redis connected'));

(async () => {
  await redisClient.connect();
})();

// ============ 辅助函数 ============

/**
 * 提取标签 (例如 #投资 #技术)
 */
function extractTags(text) {
  const tagRegex = /#[\u4e00-\u9fa5a-zA-Z0-9_]+/g;
  return text.match(tagRegex) || [];
}

/**
 * 生成 Redis key
 */
function getThoughtKey(date) {
  return `thoughts:${date}`;
}

function getTodayKey() {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return getThoughtKey(today);
}

/**
 * 保存观点到 Redis
 */
async function saveThought(content, tags = []) {
  const key = getTodayKey();
  const thought = {
    content,
    tags,
    timestamp: new Date().toISOString(),
  };

  // 存为 list，方便后续遍历
  await redisClient.lPush(key, JSON.stringify(thought));
  // 设置过期时间（90天）
  await redisClient.expire(key, 90 * 24 * 60 * 60);

  console.log(`✓ Thought saved: ${content.substring(0, 30)}...`);
}

/**
 * 获取今日所有观点
 */
async function getTodayThoughts() {
  const key = getTodayKey();
  const rawThoughts = await redisClient.lRange(key, 0, -1);
  return rawThoughts.map(t => JSON.parse(t));
}

/**
 * 调用 DeepSeek API
 */
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

/**
 * 生成每日总结
 */
async function generateDailySummary() {
  const thoughts = await getTodayThoughts();

  if (thoughts.length === 0) {
    return '今天暂无观点记录。';
  }

  // 按标签分类
  const taggedThoughts = {};
  thoughts.forEach(t => {
    const tags = t.tags.length > 0 ? t.tags.join('/') : '其他';
    if (!taggedThoughts[tags]) {
      taggedThoughts[tags] = [];
    }
    taggedThoughts[tags].push(t.content);
  });

  // 组装提示词
  const thoughtsText = Object.entries(taggedThoughts)
    .map(([tag, contents]) => `【${tag}】\n${contents.map(c => `• ${c}`).join('\n')}`)
    .join('\n\n');

  const prompt = `请根据以下 ${thoughts.length} 条日常观点笔记，生成一份每日总结。

要求：
1. 按主题分类并保留标签
2. 提炼 3-5 个最重要的观点
3. 标注相关的投资逻辑或市场变化
4. 推荐可用于评论/转发的金句（用 💡 标记）
5. 语言精炼，移动端友好
6. 末尾附上 #标签方便二次使用

观点笔记：
${thoughtsText}

生成的格式：
🔍 【分类1】
• 观点要点
  💡 金句

【分类2】
...

标签：#xxx #yyy
`;

  return await callDeepSeek(prompt);
}

/**
 * 发送每日总结
 */
async function sendDailySummary() {
  try {
    const summary = await generateDailySummary();
    const today = new Date().toISOString().split('T')[0];

    const message = `📊 <b>每日观点总结 - ${today}</b>\n\n${summary}\n\n<i>自动生成于 ${new Date().toLocaleTimeString('zh-CN')}</i>`;

    await bot.sendMessage(YOUR_CHAT_ID, message, { parse_mode: 'HTML' });
    console.log('✓ Daily summary sent');

    // 归档到 Redis key（方便查看历史）
    const archiveKey = `summary:${today}`;
    await redisClient.set(archiveKey, summary, { EX: 365 * 24 * 60 * 60 });
  } catch (error) {
    console.error('Failed to send daily summary:', error);
    // 发送错误通知
    await bot.sendMessage(
      YOUR_CHAT_ID,
      `❌ 每日总结生成失败：${error.message}`
    );
  }
}

// ============ Telegram Bot 事件处理 ============

/**
 * 处理私人消息
 */
bot.on('message', async msg => {
  // 只处理来自你的消息
  if (msg.chat.id !== YOUR_CHAT_ID) {
    return;
  }

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
• 直接发送消息 = 保存观点
  例：#投资 光伏逆变器价格战持续...
  （自动提取 #投资 标签）

<b>查看与导出：</b>
/today - 查看今日所有观点
/summary - 立即生成今日总结
/clear - 清空今日观点

<b>系统：</b>
/help - 显示此帮助

每日自动生成总结时间：UTC 00:00（北京时间 08:00）
`, { parse_mode: 'HTML' });
    return;
  }

  // 普通消息 = 保存观点
  const tags = extractTags(text);
  await saveThought(text, tags);
  await bot.sendMessage(YOUR_CHAT_ID, `✓ 已保存 ${tags.length > 0 ? tags.join(' ') : '(无标签)'}`);
});

// ============ 定时任务 ============

/**
 * 每日 00:00 UTC 生成总结
 * 北京时间 08:00
 */
cron.schedule('0 0 * * *', async () => {
  console.log('⏰ 触发每日总结任务...');
  await sendDailySummary();
});

// ============ Express 服务器 ============

/**
 * Webhook 端点（可选，如果使用 Webhook 模式）
 */
app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

/**
 * 健康检查
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * 查询历史总结
 */
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

/**
 * 手动触发总结（便于测试）
 */
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
  console.log(`🔄 每日总结时间: UTC 00:00 (北京时间 08:00)\n`);

  // 启用 Telegram bot polling
  bot.startPolling();
});

// 优雅关闭
process.on('SIGINT', async () => {
  console.log('\n关闭中...');
  bot.stopPolling();
  await redisClient.quit();
  server.close(() => {
    console.log('已关闭');
    process.exit(0);
  });
});
