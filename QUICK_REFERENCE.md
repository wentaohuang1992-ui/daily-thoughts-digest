# ⚡ 快速参考卡

## 🚀 5 分钟快速开始

### 第一步：获取密钥

```
Telegram Bot Token
  → @BotFather → /newbot

Telegram Chat ID  
  → @userinfobot → 得到你的ID

DeepSeek API Key
  → https://platform.deepseek.com → API Keys
```

### 第二步：Railway 部署

```
1. GitHub 新建仓库 → Push 代码
2. Railway.app → New Project → GitHub Repo
3. Railway Variables → 填入 4 个环境变量
4. Deploy → 等 2-3 分钟
```

### 第三步：开始使用

```
Telegram 私聊 → 发送任意消息
Bot 自动保存

/today → 查看今天的
/summary → 立即生成总结
```

---

## 📝 Telegram 命令速查

```
/today      查看今日观点清单
/summary    手动生成今日总结
/clear      清空今日观点
/help       帮助菜单
```

---

## 🔑 环境变量清单

```
TELEGRAM_BOT_TOKEN       Bot Token (从 @BotFather)
TELEGRAM_CHAT_ID         你的 Telegram ID (从 @userinfobot)
DEEPSEEK_API_KEY         DeepSeek API Key
REDIS_URL                你已有的 Redis URL
PORT                     3000 (可不改)
```

---

## 🐛 常见错误处理

| 错误 | 解决 |
|------|------|
| `Redis error` | 检查 REDIS_URL 是否复制完整 |
| `Bot not responding` | 检查 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID |
| `DeepSeek 401` | 检查 API Key 或余额不足 |
| `timeout` | Railway 冷启动，刷新重试 |

---

## 📊 数据格式

**发送观点时：**
```
文本内容 #标签1 #标签2

例：
光伏逆变器价格战加剧，预计Q3毛利率承压 #投资 #PV
```

**自动生成的总结格式：**
```
🔍 【标签分类】
• 核心观点
  💡 可复用的金句

【另一个标签】
...
```

---

## 🔄 自动化时间表

| 时间 | 事件 |
|------|------|
| 你发送消息 | Bot 保存，回复 ✓ |
| 08:00 北京时间 | 自动生成每日总结 |
| 24h 后 | 清空前一天的观点 |

---

## 💾 Redis 数据存储

```
today 的观点     → thoughts:2026-06-22
today 的总结     → summary:2026-06-22
```

直接查询：
```bash
redis-cli -u <REDIS_URL>
> LRANGE thoughts:2026-06-22 0 -1
> GET summary:2026-06-22
```

---

## 🎯 使用场景

### 场景 1：快速记录投资观点
```
09:30 我: 光伏 #投资
      Bot: ✓ 已保存
14:15 我: ASML #技术
      Bot: ✓ 已保存
08:00(明天) Bot: 📊 每日总结
```

### 场景 2：为 Xueqiu 文章收集素材
```
一周内每天发送观点
周末手动 /summary
复制 💡 金句到 Xueqiu 评论
```

### 场景 3：Telegram 作为笔记本
```
随时 /today 查看今日想法
/clear 开始新的一天
Redis 保存 90 天历史
```

---

## 🔗 链接速查

| 资源 | URL |
|------|-----|
| Railway Dashboard | https://railway.app |
| DeepSeek API | https://platform.deepseek.com |
| Telegram BotFather | t.me/BotFather |
| Telegram UserInfoBot | t.me/userinfobot |

---

**准备好了？创建 GitHub 仓库开始部署！** 🚀
