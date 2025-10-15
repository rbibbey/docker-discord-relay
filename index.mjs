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

const CHAT_TRIGGERS = (process.env.CHAT_TRIGGERS || 'MENTION,DM,REPLY')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const CHAT_CONTEXT_LAST_N = Math.max(0, Number(process.env.CHAT_CONTEXT_LAST_N || 0));
const FETCH_MEMBER_PROFILE = (process.env.FETCH_MEMBER_PROFILE || 'true').toLowerCase() === 'true';

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

async function getIdentity(m) {
  // Base identity from the User object (stable across guilds)
  const base = {
    user_id: m.author.id,
    username: m.author.username ?? null,        // e.g., "ryan"
    global_name: m.author.globalName ?? null,   // display name (new username system)
    discriminator: m.author.discriminator ?? null, // often "0" now
    is_bot: m.author.bot === true
  };

  // Try to enrich with guild-specific profile (displayName, roles)
  if (!FETCH_MEMBER_PROFILE || !m.guild) return { ...base, display_name: null, roles: [] };

  try {
    // Uses cache first; fetch if needed
    const member = m.guild.members.cache.get(m.author.id) || await m.guild.members.fetch(m.author.id);
    const roles = Array.from(member.roles.cache.values()).map(r => ({ id: r.id, name: r.name }));
    return {
      ...base,
      display_name: member.displayName ?? null, // server nickname / display name
      roles
    };
  } catch {
    return { ...base, display_name: null, roles: [] };
  }
}

function makeConversationKeys(m) {
  const guildKey = m.guild?.id || 'dm';
  return {
    // Long-term, per-user key per guild
    user_key: `${guildKey}:${m.author.id}`,
    // Optional: per-channel thread/context key
    convo_key: `${guildKey}:${m.channelId}:${m.author.id}`
  };
}


function isAllowedChannel(msg) {
  return !ALLOWED_CHANNELS.length || ALLOWED_CHANNELS.includes(msg.channelId);
}

function isDM(msg) {
  return msg.channel?.isDMBased?.() || msg.channel?.isThread() === false && msg.guildId === null;
}

function mentionsBot(msg) {
  return !!(client.user && msg.mentions?.has(client.user));
}

function isReplyToBot(msg) {
  const ref = msg.reference;
  const repliedUserId = msg.mentions?.repliedUser?.id;
  return !!(ref && repliedUserId && client.user && repliedUserId === client.user.id);
}

function shouldTreatAsChat(msg) {
  if (CHAT_TRIGGERS.includes('ALL')) return true;
  if (CHAT_TRIGGERS.includes('DM') && isDM(msg)) return true;
  if (CHAT_TRIGGERS.includes('MENTION') && mentionsBot(msg)) return true;
  if (CHAT_TRIGGERS.includes('REPLY') && isReplyToBot(msg)) return true;
  return false;
}

async function buildContext(msg) {
  if (CHAT_CONTEXT_LAST_N <= 0) return [];
  try {
    const fetched = await msg.channel.messages.fetch({ limit: Math.min(CHAT_CONTEXT_LAST_N, 20) });
    // Sort ascending by timestamp and map minimal context (avoid huge payloads)
    const items = Array.from(fetched.values())
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map(m => ({
        id: m.id,
        author: { id: m.author.id, username: m.author.username, isBot: m.author.bot },
        content: m.content,
        timestamp: m.createdTimestamp,
        isReply: !!m.reference?.messageId
      }));
    return items;
  } catch {
    return [];
  }
}

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
    if (m.author.bot) return;                 // ignore bots (prevents loops)
    if (!isAllowedChannel(m)) return;         // only allowed channels

    const isCommand = m.content?.startsWith(COMMAND_PREFIX);

    // --- COMMANDS ---
    if (isCommand) {
    const [cmd, ...args] = m.content.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
    const identity = await getIdentity(m);
    const { user_key, convo_key } = makeConversationKeys(m);

    const payload = {
        event_type: 'command',
        command: cmd,
        args,
        content: m.content,
        channel_id: m.channelId,
        channel_name: m.channel?.name ?? null,
        guild_id: m.guild?.id ?? null,
        user_key,        // <-- stable memory key
        convo_key,       // <-- optional shorter-term context key
        identity,        // <-- enriched identity block
        message_id: m.id,
        in_thread: m.channel?.isThread?.() ?? false,
        thread_id: m.channel?.isThread?.() ? m.channel.id : null,
        message_reference: m.reference?.messageId ?? null,
        attachments: [...m.attachments.values()].map(a => ({ id: a.id, name: a.name, url: a.url, contentType: a.contentType, size: a.size })),
        timestamp: m.createdTimestamp
    };

    await postWithRetry(N8N_WEBHOOK_URL, payload, { 'X-Discord-Relay': SHARED_SECRET, 'Content-Type': 'application/json' });
    return;
    }

    // --- CHAT (non-command) ---
    if (shouldTreatAsChat(m)) {
        let cleaned = m.content || '';
        if (mentionsBot(m) && client.user) {
            const mentionSyntax = new RegExp(`^<@!?${client.user.id}>\\s*`, 'i');
            cleaned = cleaned.replace(mentionSyntax, '');
        }

        const [identity, context] = await Promise.all([getIdentity(m), buildContext(m)]);
        const { user_key, convo_key } = makeConversationKeys(m);

        const payload = {
            event_type: 'chat',
            content: m.content,
            cleaned_content: cleaned,
            channel_id: m.channelId,
            channel_name: m.channel?.name ?? null,
            guild_id: m.guild?.id ?? null,
            user_key,
            convo_key,
            identity,
            message_id: m.id,
            in_thread: m.channel?.isThread?.() ?? false,
            thread_id: m.channel?.isThread?.() ? m.channel.id : null,
            message_reference: m.reference?.messageId ?? null,
            mentioned_bot: mentionsBot(m),
            is_dm: isDM(m),
            attachments: [...m.attachments.values()].map(a => ({ id: a.id, name: a.name, url: a.url, contentType: a.contentType, size: a.size })),
            timestamp: m.createdTimestamp,
            context
        };

        await postWithRetry(N8N_WEBHOOK_URL, payload, { 'X-Discord-Relay': SHARED_SECRET, 'Content-Type': 'application/json' });
        return;
    }
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
