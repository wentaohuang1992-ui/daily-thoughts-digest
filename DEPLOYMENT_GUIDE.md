# 📱 每日观点自动归纳系统 - 部署指南

## 系统架构

```
你 (Telegram) 
  ↓ (发送观点+标签)
Telegram Bot ← Node.js 后端
  ↓ (存储)
Redis (已有 REDIS_URL)
  ↓ (每日 00:00 UTC)
DeepSeek API (自动归纳)
  ↓
Telegram 回复 (每日总结)
```

---

## 📋 前置准备

### 1. Telegram 配置

#### 创建私人 Bot
- 打开 Telegram，搜索 `@BotFather`
- 发送 `/newbot`，按步骤创建
- 获得 **BOT_TOKEN**（格式：`123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`）

#### 获取你的 Telegram ID
- 打开 Telegram，搜索 `@userinfobot`
- 发送任意消息
- 得到 **TELEGRAM_CHAT_ID**（数字，例：`123456789`）

### 2. DeepSeek 配置

- 访问 https://platform.deepseek.com
- 注册账户，充值一些额度（很便宜，1¥ 可用很久）
- 在「API Keys」获得 **DEEPSEEK_API_KEY**

### 3. Redis（你已有）

- 确认你有 **REDIS_URL**（从 Railway 或其他服务）
- 格式通常：`redis://default:password@host.railway.app:port`

---

## 🚀 部署到 Railway

### 方式一：GitHub + Railway（推荐）

#### Step 1: 创建 GitHub 仓库

```bash
cd your-project
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/your-username/daily-thoughts.git
git push -u origin main
```

#### Step 2: Railway 部署

1. 访问 https://railway.app
2. 登录 → 新建 Project → 选 "GitHub Repo"
3. 授权并选择你的仓库
4. Railway 自动检测 `package.json`，启动部署

#### Step 3: 设置环境变量

在 Railway 控制面板：
```
Variables 标签 → 添加以下变量：

TELEGRAM_BOT_TOKEN = 你的BotToken
TELEGRAM_CHAT_ID = 你的ChatID
DEEPSEEK_API_KEY = 你的DeepSeekKey
REDIS_URL = redis://default:password@host:port
PORT = 3000
```

#### Step 4: 查看日志

```
Deployments → 你的部署 → Logs → 查看是否启动成功
```

成功日志：
```
🚀 每日观点归纳系统启动
📡 服务器运行在端口 3000
🤖 Telegram Bot ID: 123456789
💾 Redis: 已连接
🔄 每日总结时间: UTC 00:00 (北京时间 08:00)
```

---

### 方式二：本地测试

```bash
# 1. 克隆或创建项目文件夹
mkdir daily-thoughts && cd daily-thoughts

# 2. 创建 .env 文件（复制 .env.example）
cp .env.example .env
# 编辑 .env 填入你的密钥

# 3. 安装依赖
npm install

# 4. 启动
npm start
```

---

## 📱 使用说明

### 日常操作

**直接在 Telegram 私人聊天中发送观点：**

```
9:30  你: 光伏逆变器价格战加剧，第三季度预计对毛利率压力持续 #投资 #PV

Bot:  ✓ 已保存 #投资 #PV

14:15 你: ASML EUV 出口限制升级，国产替代机会 #技术 #供应链

Bot:  ✓ 已保存 #技术 #供应链
```

**标签用法（可选）：**
- `#投资` - 投资观点
- `#技术` - 技术研究
- `#行业` - 行业分析
- `#供应链` - 供应链
- 等等...自定义

### 命令

| 命令 | 说明 |
|------|------|
| `/today` 或 `/今天` | 查看今日所有观点 |
| `/summary` 或 `/总结` | 立即生成今日总结 |
| `/clear` | 清空今日观点 |
| `/help` 或 `/帮助` | 显示帮助 |

### 自动执行

- **每日 UTC 00:00**（北京时间 08:00）自动生成总结并发送到 Telegram
- 总结内容包括：
  - 按标签分类的观点
  - 关键要点提炼
  - 💡 标记的金句
  - 相关标签便于二次使用

---

## 📊 数据存储结构

### Redis Key 设计

```
# 每日观点列表
thoughts:2026-06-22 → [观点1, 观点2, ...]

# 已生成的总结
summary:2026-06-22 → "📊 每日观点总结..."
```

### 观点数据格式

```json
{
  "content": "光伏逆变器价格战加剧...",
  "tags": ["#投资", "#PV"],
  "timestamp": "2026-06-22T09:30:00.000Z"
}
```

---

## 🔧 API 端点

### 健康检查
```
GET /health
→ { "status": "ok", "timestamp": "..." }
```

### 手动触发总结
```
POST /trigger-summary
→ { "success": true, "message": "Summary triggered" }
```

### 查询历史总结
```
GET /summary/2026-06-22
→ { "date": "2026-06-22", "summary": "..." }
```

---

## 💰 成本估算

| 项目 | 月成本 | 说明 |
|------|--------|------|
| Railway | ¥20-50 | 免费额度 + 流量 |
| DeepSeek | ¥5-20 | 极低，看调用量 |
| Redis | ¥0 | 你已有 |
| **合计** | **¥25-70** | 比 Claude API 便宜 10x |

---

## 🐛 常见问题

### Q: 消息没有被保存？
- 检查 `/help`，确认私人聊天而非群组
- 检查 Redis 连接（查看 Railway 日志）

### Q: DeepSeek API 返回错误？
- 检查 API Key 是否正确
- 确认 DeepSeek 账户有余额
- 查看日志中的具体错误信息

### Q: 总结没有在指定时间触发？
- 检查服务器时区（Railway 通常是 UTC）
- 手动测试：`POST /trigger-summary`
- 查看 Telegram 通知是否被静音

### Q: Redis 连接失败？
- 确认 `REDIS_URL` 复制完整（包括密码）
- 尝试在本地用 redis-cli 连接测试
- 检查 Railway 中 Redis 服务是否在线

---

## 📈 未来优化

1. **周总结** - 汇总整周的观点
2. **投资框架提取** - 自动抽取可用于文章的框架
3. **Xueqiu 集成** - 直接发布到 Xueqiu 草稿
4. **多语言** - 自动检测和翻译
5. **搜索功能** - 按日期/标签搜索历史观点

---

## 📞 支持

需要帮助？检查：
- Railway 日志：`Deployments → Logs`
- Telegram 机器人错误消息
- 项目 GitHub Issues

---

**享受自动化的每日总结！** 🚀
