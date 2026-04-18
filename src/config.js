require('dotenv').config({ path: '.env.local' });

module.exports = {
  port: parseInt(process.env.PORT || '3003'),

  db: {
    server: process.env.DB_SERVER || 'localhost\\SQLEXPRESS',
    port: parseInt(process.env.DB_PORT || '1433'),
    database: process.env.DB_DATABASE || 'TradingViewDB',
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
  },

  trading: {
    confidenceThreshold: parseInt(process.env.CONFIDENCE_THRESHOLD || '70'),
    tradeAmountUsd: parseFloat(process.env.TRADE_AMOUNT_USD || '100'),
    startingBalance: parseFloat(process.env.STARTING_BALANCE || '10000'),
    signalHistory: parseInt(process.env.SIGNAL_HISTORY || '50'),
    decisionHistory: parseInt(process.env.DECISION_HISTORY || '20'),
  },

  discord: {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  },

  email: {
    host: process.env.EMAIL_HOST || '',
    port: parseInt(process.env.EMAIL_PORT || '587'),
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASS || '',
    to: process.env.EMAIL_TO || '',
  },

  finnhub: {
    apiKey: process.env.FINNHUB_API_KEY || '',
  },
};
