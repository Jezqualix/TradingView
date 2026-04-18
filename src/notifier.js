const nodemailer = require('nodemailer');
const config = require('./config');

function formatMessage(decision, signal, tradeResult) {
  const emoji = decision.decision === 'TRADE' ? (tradeResult?.action === 'OPENED' ? 'BUY' : tradeResult?.action === 'CLOSED' ? 'SELL' : 'TRADE') : 'SKIP';
  const lines = [
    `[${emoji}] ${signal.symbol} @ $${signal.price}`,
    `Decision: ${decision.decision} (${decision.confidence}% confidence)`,
    `Reasoning: ${decision.reasoning}`,
    `Risk: ${decision.riskNotes}`,
  ];
  if (decision.matchedStrategy) lines.push(`Strategy: ${decision.matchedStrategy}`);
  if (tradeResult && tradeResult.action !== 'SKIPPED') {
    lines.push(`Trade: ${tradeResult.action}`);
    if (tradeResult.pnlUsd !== undefined) lines.push(`P&L: $${tradeResult.pnlUsd}`);
  }
  return lines.join('\n');
}

async function sendDiscord(decision, signal, tradeResult) {
  if (!config.discord.webhookUrl) return;

  const color = decision.decision === 'TRADE'
    ? (tradeResult?.pnlUsd > 0 ? 0x00a040 : tradeResult?.pnlUsd < 0 ? 0xff4040 : 0xffdd00)
    : 0x888888;

  const body = {
    embeds: [{
      title: `${decision.decision} — ${signal.symbol}`,
      description: formatMessage(decision, signal, tradeResult),
      color,
      timestamp: new Date().toISOString(),
    }],
  };

  try {
    await fetch(config.discord.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('Discord notification failed:', err.message);
  }
}

async function sendEmail(decision, signal, tradeResult) {
  if (!config.email.host || !config.email.to) return;

  const transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.port === 465,
    auth: { user: config.email.user, pass: config.email.pass },
  });

  try {
    await transporter.sendMail({
      from: config.email.user,
      to: config.email.to,
      subject: `[TradingView] ${decision.decision} — ${signal.symbol} (${decision.confidence}%)`,
      text: formatMessage(decision, signal, tradeResult),
    });
  } catch (err) {
    console.error('Email notification failed:', err.message);
  }
}

async function notify(decision, signal, tradeResult) {
  await Promise.allSettled([
    sendDiscord(decision, signal, tradeResult),
    sendEmail(decision, signal, tradeResult),
  ]);
}

module.exports = { notify };
