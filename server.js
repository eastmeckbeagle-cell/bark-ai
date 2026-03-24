// ─────────────────────────────────────────────────────────────
//  Bark AI — "Wizard of Oz" AI Chat Backend
//  Express API + Discord Bot in a single process
//  Uses polling instead of long-held connections
// ─────────────────────────────────────────────────────────────

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  WebhookClient,
} = require('discord.js');

// ── Config ──────────────────────────────────────────────────
const {
  DISCORD_BOT_TOKEN,
  DISCORD_WEBHOOK_URL,
  PORT = 3000,
} = process.env;

if (!DISCORD_BOT_TOKEN || !DISCORD_WEBHOOK_URL) {
  console.error('❌  Missing DISCORD_BOT_TOKEN or DISCORD_WEBHOOK_URL in .env');
  process.exit(1);
}

// ── Shared In-Memory Store ──────────────────────────────────
//  pendingChats: Map<taskId, { prompt, timestamp, timer, webhookMsgId, response, resolved }>
const pendingChats = new Map();
// Reverse lookup: webhook message ID → task ID (for reply-based resolution)
const msgIdToTaskId = new Map();
let nextTaskId = 1;

const TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 hours
const CLEANUP_AFTER_MS = 5 * 60 * 1000; // keep resolved tasks for 5 min before cleanup

// ── Discord Webhook Client (for dispatching prompts) ────────
const webhook = new WebhookClient({ url: DISCORD_WEBHOOK_URL });

// ── Express Server ──────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// POST /api/chat — submit a prompt, returns immediately with a taskId
app.post('/api/chat', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'A non-empty "prompt" string is required.' });
  }

  const taskId = nextTaskId++;

  // Set up an auto-timeout
  const timer = setTimeout(() => {
    if (pendingChats.has(taskId)) {
      const entry = pendingChats.get(taskId);
      entry.response = '🐶 The beagles are busy sniffing around… try again later!';
      entry.timedOut = true;
      entry.resolved = true;
      if (entry.webhookMsgId) msgIdToTaskId.delete(entry.webhookMsgId);
      console.log(`⏰  Task ${taskId} timed out.`);
      // Clean up after a grace period so the frontend can still poll the result
      setTimeout(() => pendingChats.delete(taskId), CLEANUP_AFTER_MS);
    }
  }, TIMEOUT_MS);

  // Store the task — no res object needed anymore
  pendingChats.set(taskId, {
    prompt: prompt.trim(),
    timestamp: Date.now(),
    timer,
    webhookMsgId: null,
    response: null,
    timedOut: false,
    resolved: false,
  });

  console.log(`📩  Task ${taskId} created for prompt: "${prompt.trim()}"`);

  // Dispatch to the Discord staff channel
  try {
    const sentMsg = await webhook.send({
      username: 'Bark AI 🐾',
      content: [
        `**📨 New Bark AI prompt!**`,
        `> **Task ID:** \`${taskId}\``,
        `> **Prompt:** ${prompt.trim()}`,
        ``,
        `💬 **Reply to this message** or use \`/bark task_id:${taskId} response:...\``,
      ].join('\n'),
    });
    if (sentMsg && sentMsg.id && pendingChats.has(taskId)) {
      pendingChats.get(taskId).webhookMsgId = sentMsg.id;
      msgIdToTaskId.set(sentMsg.id, taskId);
    }
  } catch (err) {
    console.error('⚠️  Failed to send webhook:', err.message);
  }

  // Return immediately with the task ID
  res.json({ taskId });
});

// GET /api/chat/:taskId — poll for a response
app.get('/api/chat/:taskId', (req, res) => {
  const taskId = parseInt(req.params.taskId, 10);

  if (!pendingChats.has(taskId)) {
    return res.json({ status: 'not_found' });
  }

  const entry = pendingChats.get(taskId);

  if (entry.resolved) {
    return res.json({
      status: 'resolved',
      response: entry.response,
      timedOut: entry.timedOut,
    });
  }

  res.json({ status: 'pending' });
});

// Health-check endpoint
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', pending: pendingChats.size });
});

const server = app.listen(PORT, () => {
  console.log(`🚀  Express listening on port ${PORT}`);
});

// ── Helper: resolve a task ──────────────────────────────────
function resolveTask(taskId, response) {
  const entry = pendingChats.get(taskId);
  if (!entry || entry.resolved) return false;

  clearTimeout(entry.timer);
  entry.response = response;
  entry.resolved = true;
  if (entry.webhookMsgId) msgIdToTaskId.delete(entry.webhookMsgId);

  // Clean up after a grace period
  setTimeout(() => pendingChats.delete(taskId), CLEANUP_AFTER_MS);

  console.log(`✅  Task ${taskId} resolved.`);
  return true;
}

// ── Discord Bot ─────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Register the /bark slash command on startup
client.once('ready', async () => {
  console.log(`🤖  Discord bot logged in as ${client.user.tag}`);

  const barkCommand = new SlashCommandBuilder()
    .setName('bark')
    .setDescription('Reply to a pending Bark AI prompt')
    .addIntegerOption((opt) =>
      opt
        .setName('task_id')
        .setDescription('The Task ID shown in the chat prompt message')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('response')
        .setDescription('Your witty response to send back to the user')
        .setRequired(true)
    );

  const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);

  try {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: [barkCommand.toJSON()],
    });
    console.log('✅  /bark slash command registered globally.');
  } catch (err) {
    console.error('❌  Failed to register slash command:', err);
  }
});

// Handle /bark interactions
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'bark') {
    return;
  }

  const taskId = interaction.options.getInteger('task_id');
  const response = interaction.options.getString('response');

  if (!pendingChats.has(taskId) || pendingChats.get(taskId).resolved) {
    return interaction.reply({
      content: `❌ Task **${taskId}** not found. It may have already been answered or timed out.`,
      ephemeral: true,
    });
  }

  resolveTask(taskId, response);

  await interaction.reply({
    content: `✅ Response sent for Task **${taskId}**!\n> ${response}`,
    ephemeral: true,
  });
});

// ── Reply-Based Resolution ──────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.reference?.messageId) return;

  const refId = message.reference.messageId;
  if (!msgIdToTaskId.has(refId)) return;

  const taskId = msgIdToTaskId.get(refId);
  if (!pendingChats.has(taskId) || pendingChats.get(taskId).resolved) {
    msgIdToTaskId.delete(refId);
    return;
  }

  const response = message.content.trim();
  if (!response) return;

  resolveTask(taskId, response);

  await message.reply(`✅ Response sent for Task **${taskId}**!`);
});

client.login(DISCORD_BOT_TOKEN);

// ── Graceful Shutdown ───────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n🛑  Shutting down…');
  pendingChats.clear();
  msgIdToTaskId.clear();
  client.destroy();
  server.close(() => process.exit(0));
});
