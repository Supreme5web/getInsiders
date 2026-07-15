// api/index.js
// Solana Insider Wallet Detector — Telegram bot as a single Vercel
// serverless function. Telegram POSTs updates here (webhook mode).
//
// Deployed URL for the webhook: https://<your-app>.vercel.app/api

const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const RUGCHECK_BASE_URL = 'https://api.rugcheck.xyz/v1';

if (!BOT_TOKEN) {
  throw new Error('Missing BOT_TOKEN environment variable');
}

const bot = new Telegraf(BOT_TOKEN);

// Simple in-memory cache (per warm function instance). Good enough to avoid
// re-hitting RugCheck when a user taps "Rescan" or views wallet details
// right after their first scan.
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Solana address validation
// ---------------------------------------------------------------------------

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isValidSolanaAddress(address) {
  return typeof address === 'string' && BASE58_REGEX.test(address.trim());
}

function shortenWallet(address) {
  if (!address || address.length <= 12) return address || 'UNKNOWN';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatNumber(n) {
  if (!n) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toLocaleString();
}

// ---------------------------------------------------------------------------
// RugCheck API
// ---------------------------------------------------------------------------

async function getInsiderGraph(tokenAddress) {
  const url = `${RUGCHECK_BASE_URL}/tokens/${tokenAddress}/insiders/graph`;
  try {
    const { data } = await axios.get(url, { timeout: 15000 });
    const graphs = Array.isArray(data) ? data : data?.graphs;
    if (!Array.isArray(graphs)) throw new Error('Unexpected response shape from RugCheck');
    return graphs;
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) throw new Error('No insider graph data found for this token.');
    if (status === 429) throw new Error('RugCheck is rate limiting us. Please try again shortly.');
    if (err.code === 'ECONNABORTED') throw new Error('RugCheck request timed out. Please try again.');
    throw new Error(`Failed to fetch insider data: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Insider analysis + risk scoring
// ---------------------------------------------------------------------------

function analyzeInsiderGraph(graphs) {
  if (!Array.isArray(graphs) || graphs.length === 0) {
    return {
      riskScore: 0,
      riskLevel: 'LOW RISK',
      clusters: [],
      topWallets: [],
      explanation: ['No insider graph data was returned — no linked insider wallets detected.'],
      totalWalletCount: 0,
      totalClusterCount: 0,
    };
  }

  const clusters = graphs.map((graph, idx) => {
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const links = Array.isArray(graph.links) ? graph.links : [];
    const totalHoldings = nodes.reduce((s, n) => s + (Number(n.holdings) || 0), 0);

    // degree + circular transfer detection
    const degree = new Map();
    const adjacency = new Map();
    for (const l of links) {
      degree.set(l.source, (degree.get(l.source) || 0) + 1);
      degree.set(l.target, (degree.get(l.target) || 0) + 1);
      if (!adjacency.has(l.source)) adjacency.set(l.source, []);
      adjacency.get(l.source).push(l.target);
    }

    let circularCount = 0;
    for (const [start, neighbors] of adjacency.entries()) {
      for (const mid of neighbors) {
        const midNeighbors = adjacency.get(mid) || [];
        if (midNeighbors.includes(start)) circularCount += 1;
      }
    }

    const outDegree = new Map();
    for (const l of links) outDegree.set(l.source, (outDegree.get(l.source) || 0) + 1);

    const zeroHoldingDistributors = nodes.filter(
      (n) => (Number(n.holdings) || 0) === 0 && (outDegree.get(n.id) || 0) > 0
    );

    const wallets = nodes
      .map((n) => ({
        id: n.id,
        holdings: Number(n.holdings) || 0,
        connections: degree.get(n.id) || 0,
        holdingsPercent: totalHoldings > 0 ? ((Number(n.holdings) || 0) / totalHoldings) * 100 : 0,
      }))
      .sort((a, b) => b.holdings - a.holdings);

    return {
      clusterIndex: idx,
      walletCount: nodes.length,
      hasLinks: links.length > 0,
      wallets,
      zeroHoldingDistributors,
      circularCount,
      largestHolderShare: wallets.length > 0 ? wallets[0].holdingsPercent : 0,
    };
  });

  const uniqueWallets = new Set();
  clusters.forEach((c) => c.wallets.forEach((w) => uniqueWallets.add(w.id)));
  const totalWalletCount = uniqueWallets.size;

  // --- Risk scoring (as specified) ---
  let score = 0;
  const explanation = [];

  if (clusters.some((c) => c.hasLinks)) {
    score += 20;
    explanation.push('Wallets share direct transfer connections with one another.');
  }
  const maxShare = Math.max(0, ...clusters.map((c) => c.largestHolderShare));
  if (maxShare >= 20) {
    score += 20;
    explanation.push(`A single wallet controls ${maxShare.toFixed(1)}% of holdings within its cluster.`);
  }
  if (totalWalletCount >= 10) {
    score += 15;
    explanation.push(`${totalWalletCount} distinct wallets are connected across insider clusters.`);
  }
  const totalCircular = clusters.reduce((s, c) => s + c.circularCount, 0);
  if (totalCircular > 0) {
    score += 15;
    explanation.push(`${totalCircular} circular transfer pattern(s) detected.`);
  }
  const totalZeroDist = clusters.reduce((s, c) => s + c.zeroHoldingDistributors.length, 0);
  if (totalZeroDist > 0) {
    score += 10;
    explanation.push(`${totalZeroDist} wallet(s) hold zero tokens but actively distribute to others.`);
  }
  if (clusters.some((c) => c.walletCount >= 8)) {
    score += 20;
    explanation.push('At least one insider cluster has 8+ connected wallets.');
  }
  score = Math.min(100, score);

  let riskLevel = 'LOW RISK';
  if (score > 70) riskLevel = 'HIGH RISK';
  else if (score > 30) riskLevel = 'MEDIUM RISK';

  const topWallets = clusters
    .flatMap((c) => c.wallets)
    .sort((a, b) => b.holdings - a.holdings)
    .slice(0, 5);

  return {
    riskScore: score,
    riskLevel,
    clusters,
    topWallets,
    explanation: explanation.length ? explanation : ['No significant insider risk indicators were found.'],
    totalWalletCount,
    totalClusterCount: clusters.length,
  };
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

function riskEmoji(level) {
  if (level === 'HIGH RISK') return '🔴';
  if (level === 'MEDIUM RISK') return '🟠';
  return '🟢';
}

function formatReport(tokenAddress, r) {
  const lines = [];
  lines.push('🚨 *INSIDER WALLET ANALYSIS*', '', '*Token:*', `\`${tokenAddress}\``, '');
  lines.push('📊 *Overview*');
  lines.push(`Clusters: *${r.totalClusterCount}*`);
  lines.push(`Connected Wallets: *${r.totalWalletCount}*`, '');

  if (r.clusters.length > 0) {
    const riskiest = [...r.clusters].sort((a, b) => b.largestHolderShare - a.largestHolderShare)[0];
    lines.push(`${riskEmoji(r.riskLevel)} *Highest Risk Cluster* (#${riskiest.clusterIndex + 1})`, '');
    lines.push('Wallets:');
    riskiest.wallets.slice(0, 6).forEach((w, i) => lines.push(`${i + 1}. \`${shortenWallet(w.id)}\``));
    lines.push('');
    if (riskiest.wallets[0]) {
      lines.push('Largest Holdings:');
      lines.push(`\`${shortenWallet(riskiest.wallets[0].id)}\``);
      lines.push(`${formatNumber(riskiest.wallets[0].holdings)} tokens (${riskiest.wallets[0].holdingsPercent.toFixed(1)}%)`, '');
    }
  }

  if (r.topWallets.length > 0) {
    lines.push('💰 *Top Holders*');
    r.topWallets.forEach((w, i) => lines.push(`${i + 1}. \`${shortenWallet(w.id)}\` — ${formatNumber(w.holdings)} tokens`));
    lines.push('');
  }

  lines.push('📝 *Why this score:*');
  r.explanation.forEach((e) => lines.push(`• ${e}`));
  lines.push('');
  lines.push('⚠️ *Risk Score*', '', `*${r.riskScore}/100*`, `${riskEmoji(r.riskLevel)} *${r.riskLevel}*`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Bot commands & handlers
// ---------------------------------------------------------------------------

bot.start((ctx) =>
  ctx.replyWithMarkdown(
    [
      '👋 *Welcome to the Solana Insider Wallet Detector!*',
      '',
      'Send me a Solana token address (CA) and I\'ll analyze insider wallet clusters using RugCheck data.',
      '',
      'Or use `/scan <TOKEN_ADDRESS>`.',
      '',
      'Type /help for more.',
    ].join('\n')
  )
);

bot.help((ctx) =>
  ctx.replyWithMarkdown(
    ['*Commands*', '', '/start — Welcome message', '/help — This message', '/scan `<CA>` — Analyze a token', '', 'Or just paste a token address directly.'].join('\n')
  )
);

async function runAnalysis(ctx, tokenAddress, forceRefresh = false) {
  const address = (tokenAddress || '').trim();

  if (!isValidSolanaAddress(address)) {
    await ctx.reply('❌ That doesn\'t look like a valid Solana address. Please check and try again.');
    return;
  }

  const status = await ctx.reply('🔍 Analyzing insider wallets...');

  try {
    const cacheKey = `insider:${address}`;
    let report = forceRefresh ? null : cacheGet(cacheKey);

    if (!report) {
      const graphs = await getInsiderGraph(address);
      report = analyzeInsiderGraph(graphs);
      cacheSet(cacheKey, report);
    }

    const message = formatReport(address, report);
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Rescan', `rescan:${address}`), Markup.button.callback('🔎 View Wallets', `wallets:${address}`)],
    ]);

    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, message, {
      parse_mode: 'Markdown',
      ...keyboard,
    });
  } catch (err) {
    await ctx.telegram
      .editMessageText(ctx.chat.id, status.message_id, undefined, `⚠️ ${err.message}`)
      .catch(() => ctx.reply(`⚠️ ${err.message}`));
  }
}

bot.command('scan', (ctx) => {
  const address = ctx.message.text.split(/\s+/)[1];
  if (!address) return ctx.reply('Usage: /scan <TOKEN_ADDRESS>');
  return runAnalysis(ctx, address, false);
});

bot.on('text', (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return ctx.reply('Unknown command. Type /help.');
  return runAnalysis(ctx, text, false);
});

bot.action(/^rescan:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Rescanning...');
  await runAnalysis(ctx, ctx.match[1], true);
});

bot.action(/^wallets:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const cached = cacheGet(`insider:${ctx.match[1]}`);
  if (!cached) return ctx.reply('⚠️ Analysis expired from cache — please rescan.');

  const lines = ['🔎 *All Insider Wallets*', ''];
  cached.clusters.forEach((c) => {
    lines.push(`*Cluster #${c.clusterIndex + 1}*`);
    c.wallets.forEach((w) => lines.push(`• \`${shortenWallet(w.id)}\` — ${formatNumber(w.holdings)} tokens`));
    lines.push('');
  });
  await ctx.replyWithMarkdown(lines.join('\n').slice(0, 4000));
});

bot.catch((err, ctx) => {
  console.error('[bot-error]', err);
  ctx.reply('⚠️ An unexpected error occurred.').catch(() => {});
});

// ---------------------------------------------------------------------------
// Vercel serverless handler
// ---------------------------------------------------------------------------

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).json({ ok: true, message: 'Solana Insider Detector Bot webhook is live.' });
    return;
  }

  if (WEBHOOK_SECRET) {
    const incoming = req.headers['x-telegram-bot-api-secret-token'];
    if (incoming !== WEBHOOK_SECRET) {
      res.status(401).json({ ok: false, error: 'Invalid secret token' });
      return;
    }
  }

  try {
    await bot.handleUpdate(req.body, res);
  } catch (err) {
    console.error('[webhook-error]', err);
  }

  if (!res.headersSent) res.status(200).json({ ok: true });
};
