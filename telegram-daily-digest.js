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
const YOUR_CHAT_ID =
