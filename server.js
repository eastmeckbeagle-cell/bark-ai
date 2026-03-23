// ─────────────────────────────────────────────────────────────
//  Beagle Chat — "Wizard of Oz" AI Chat Backend
//  Express API + Discord Bot in a single process
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
//  pendingChats: Map<taskId, { res, prompt, timestamp, timer, webhookMsgId }>
const pendingChats = new Map();
// Reverse lookup: webhook message ID → task ID (for reply-based resolution)
const msgIdToTaskId = new Map();
let nextTaskId = 1;

const TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 hours

// ── Discord Webhook Client (for dispatching prompts) ────────
const webhook = new WebhookClient({ url: DISCORD_WEBHOOK_URL });

// ── Express Server ──────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/chat', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'A non-empty "prompt" string is required.' });
  }

  const taskId = nextTaskId++;

  // Set up an auto-timeout so the HTTP connection doesn't hang forever
  const timer = setTimeout(() => {
    if (pendingChats.has(taskId)) {
      const entry = pendingChats.get(taskId);
      pendingChats.delete(taskId);
      entry.res.json({
        response: '🐶 The beagles are busy sniffing around… try again later!',
        timedOut: true,
      });
      console.log(`⏰  Task ${taskId} timed out.`);
    }
  }, TIMEOUT_MS);

  // Store the response object — we'll resolve it later via /bark or a reply
  pendingChats.set(taskId, { res, prompt: prompt.trim(), timestamp: Date.now(), timer, webhookMsgId: null });

  console.log(`📩  Task ${taskId} created for prompt: "${prompt.trim()}"`);

  // Dispatch to the Discord staff channel
  try {
    const sentMsg = await webhook.send({
      username: 'Beagle Chat 🐾',
      content: [
        `**📨 New Beagle Chat prompt!**`,
        `> **Task ID:** \`${taskId}\``,
        `> **Prompt:** ${prompt.trim()}`,
        ``,
        `💬 **Reply to this message** or use \`/bark task_id:${taskId} response:...\``,
      ].join('\n'),
    });
    // Track the webhook message ID so we can match replies
    if (sentMsg && sentMsg.id && pendingChats.has(taskId)) {
      pendingChats.get(taskId).webhookMsgId = sentMsg.id;
      msgIdToTaskId.set(sentMsg.id, taskId);
    }
  } catch (err) {
    console.error('⚠️  Failed to send webhook:', err.message);
    // The request is still pending — staff can still use /bark manually
  }

  // NOTE: We intentionally do NOT call res.json() here.
  // The response will be sent when a staff member uses /bark.
});

// Health-check endpoint
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', pending: pendingChats.size });
});

const server = app.listen(PORT, () => {
  console.log(`🚀  Express listening on port ${PORT}`);
});

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
    .setDescription('Reply to a pending Beagle Chat prompt')
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

  if (!pendingChats.has(taskId)) {
    return interaction.reply({
      content: `❌ Task **${taskId}** not found. It may have already been answered or timed out.`,
      ephemeral: true,
    });
  }

  // Resolve the pending HTTP request
  const entry = pendingChats.get(taskId);
  clearTimeout(entry.timer);
  if (entry.webhookMsgId) msgIdToTaskId.delete(entry.webhookMsgId);
  pendingChats.delete(taskId);

  try {
    entry.res.json({ response });
  } catch (err) {
    console.error(`⚠️  Failed to send response for task ${taskId}:`, err.message);
    return interaction.reply({
      content: `⚠️ Task **${taskId}** was found but the client connection was already closed.`,
      ephemeral: true,
    });
  }

  console.log(`✅  Task ${taskId} resolved by ${interaction.user.tag}`);

  await interaction.reply({
    content: `✅ Response sent for Task **${taskId}**!\n> ${response}`,
    ephemeral: true,
  });
});

// ── Reply-Based Resolution ──────────────────────────────────
// Staff can simply reply to the webhook message instead of using /bark
client.on('messageCreate', async (message) => {
  // Ignore bot messages and messages without a reply reference
  if (message.author.bot || !message.reference?.messageId) return;

  const refId = message.reference.messageId;
  if (!msgIdToTaskId.has(refId)) return;

  const taskId = msgIdToTaskId.get(refId);
  if (!pendingChats.has(taskId)) {
    msgIdToTaskId.delete(refId);
    return;
  }

  const response = message.content.trim();
  if (!response) return;

  const entry = pendingChats.get(taskId);
  clearTimeout(entry.timer);
  msgIdToTaskId.delete(refId);
  pendingChats.delete(taskId);

  try {
    entry.res.json({ response });
  } catch (err) {
    console.error(`⚠️  Failed to send response for task ${taskId}:`, err.message);
    return message.reply('⚠️ The client connection was already closed.');
  }

  console.log(`✅  Task ${taskId} resolved via reply by ${message.author.tag}`);
  await message.reply(`✅ Response sent for Task **${taskId}**!`);
});

client.login(DISCORD_BOT_TOKEN);

// ── Graceful Shutdown ───────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n🛑  Shutting down…');

  // Resolve any pending chats with a shutdown message
  for (const [taskId, entry] of pendingChats) {
    clearTimeout(entry.timer);
    if (entry.webhookMsgId) msgIdToTaskId.delete(entry.webhookMsgId);
    try {
      entry.res.json({
        response: '🐶 The beagles have gone to sleep. Try again later!',
        timedOut: true,
      });
    } catch { /* client already disconnected */ }
  }
  pendingChats.clear();

  client.destroy();
  server.close(() => process.exit(0));
});
