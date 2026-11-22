require('dotenv').config?.();
module.exports = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://localhost:5433/kayan_dev',
  dbSsl: /sslmode=require|neon\.tech|supabase/.test(process.env.DATABASE_URL || ''),
  sessionSecret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  port: parseInt(process.env.PORT || '3000', 10),
  adminEmail: process.env.ADMIN_EMAIL || 'admin@kayan.local',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123456',
  runCron: process.env.RUN_CRON !== 'false',
  cronSecret: process.env.CRON_SECRET || '',
  whatsappAdapter: process.env.WHATSAPP_ADAPTER || 'mock',
  whatsappWebhookSecret: process.env.WHATSAPP_WEBHOOK_SECRET || '',
  metaVerifyToken: process.env.META_VERIFY_TOKEN || '',
  metaAppSecret: process.env.META_APP_SECRET || '',
  metaPhoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
  aiApiKey: process.env.AI_API_KEY || '',
  aiApiUrl: process.env.AI_API_URL || '',
  env: process.env.NODE_ENV || 'development',
  assetVersion: process.env.ASSET_VERSION || '3'
};
