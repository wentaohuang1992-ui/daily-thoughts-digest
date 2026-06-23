# 每日观点归纳系统 - Railway 部署版

## 部署步骤

### 1. 上传文件到 GitHub

将以下文件上传到你的 GitHub 仓库（覆盖原文件）：

- `telegram-daily-digest.js` - 主程序
- `package.json` - 依赖配置
- `Procfile` - Railway 启动配置
- `.gitignore` - Git 忽略文件

### 2. 配置 Railway 环境变量

在 Railway 项目的 Variables 中添加以下环境变量（值参考你的实际凭证）：

```
TELEGRAM_BOT_TOKEN = <你的 Telegram Bot Token>
MY_CHAT_ID = <你的 Telegram Chat ID>
DEEPSEEK_API_KEY = <你的 DeepSeek API Key>
REDIS_URL = <Upstash Redis URL，rediss:// 开头>
BAIDU_APP_ID = <百度 App ID>
BAIDU_API_KEY = <百度 API Key>
BAIDU_SECRET_KEY = <百度 Secret Key>
```

### 3. 等待自动部署

Railway 会自动检测 GitHub 提交并部署。

## 功能

- 文字观点保存（自动提取 #标签）
- 语音识别（百度短语音识别）
- 实时 AI 聊天（? 前缀，DeepSeek）
- 每日自动总结（UTC 15:00 / 北京时间 23:00）
- Redis 存储（90 天过期）

## 命令

- `/today` - 查看今日所有观点
- `/summary` - 立即生成今日总结
- `/clear` - 清空今日观点
- `/help` - 查看帮助
- `?问题` - 实时 AI 聊天

## HTTP 端点

- `GET /health` - 健康检查
- `GET /test-baidu` - 测试百度连接
- `POST /trigger-summary` - 手动触发总结
