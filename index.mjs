import { Client, GatewayIntentBits, Events } from 'discord.js';
import axios from 'axios';

const required = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`[FATAL] Missing required env: ${k}`);
    process.exit(1);
  }
  return v;
};

const DISCORD_TOKEN = required('DISCORD_TOKEN');
const N8N_WEBHOOK_URL = required('N8N_WEBHOOK_URL'); // e.g., https://n8n.example.com/webhook/discord-relay
const SHARED_SECRET = required('SHARED_SECRET');

const ALLOWED_CHANNELS = (process.env.ALLOWED_CHANNELS || '')
  .split(',').map(s => s.trim()).filter(Boolean); // comma-separated channel IDs
const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '!'; // e.g., !ping
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const HEALTH_PORT = Number(process.env.HEALTH_PORT || 3000);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Basic HTTP health endpoint (no extra deps)
import http from 'http';
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(404);
  res.end();
});
server.listen(HEALTH_PORT, () => {
  console.log(`[health] listening on :${HEALTH_PORT}`);
});

async function postWithRetry(url, data, headers, retries = MAX_RETRIES) {
  let attempt = 0, lastErr;
  while (attempt <= retries) {
    try {
      await axios.post(url, data, { headers, timeout: 10000 });
      return;
    } catch (e) {
      lastErr = e;
      const wait = Math.min(2000 * (attempt + 1), 8000);
      console.warn(`[relay] POST failed (attempt ${attempt + 1}/${retries + 1}):`, e?.response?.status || e.message);
      await new Promise(r => setTimeout(r, wait));
      attempt++;
    }
  }
  console.error('[relay] POST permanently failed:', lastErr?.response?.data || lastErr?.message);
}

client.on(Events.ClientReady, () => {
  console.log(`[discord] Logged in as ${client.user.tag}`);
});

client.on(Events.MessageCreate, async (m) => {
  try {
    if (m.author.bot) return;                                   // ignore bots (including yourself)
    if (ALLOWED_CHANNELS.length && !ALLOWED_CHANNELS.includes(m.channelId)) return;
    if (!m.content?.startsWith(COMMAND_PREFIX)) return;          // only prefixed commands

    const [cmd, ...args] = m.content.slice(COMMAND_PREFIX.length).trim().split(/\s+/);

    const payload = {
      event_type: 'message_create',
      command: cmd,
      args,
      content: m.content,
      channel_id: m.channelId,
      channel_name: m.channel?.name ?? null,
      guild_id: m.guild?.id ?? null,
      user: { id: m.author.id, username: m.author.username, globalName: m.author.globalName ?? null },
      message_id: m.id,
      attachments: [...m.attachments.values()].map(a => ({
        id: a.id, name: a.name, url: a.url, contentType: a.contentType, size: a.size
      })),
      timestamp: m.createdTimestamp
    };

    await postWithRetry(
      N8N_WEBHOOK_URL,
      payload,
      { 'X-Discord-Relay': SHARED_SECRET, 'Content-Type': 'application/json' }
    );
  } catch (err) {
    console.error('[relay] handler error:', err?.message);
  }
});

// Graceful shutdown
function shutdown(sig) {
  console.log(`[system] ${sig} received, shutting down...`);
  server.close(() => console.log('[system] health server closed'));
  client.destroy();
  process.exit(0);
}
['SIGINT','SIGTERM'].forEach(sig => process.on(sig, () => shutdown(sig)));

client.login(DISCORD_TOKEN);
