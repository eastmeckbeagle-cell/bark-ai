// ─────────────────────────────────────────────────────────────
//  Bark AI — "Wizard of Oz" AI Chat Backend
//  Express API + Discord Bot in a single process
//  Uses polling instead of long-held connections
// ─────────────────────────────────────────────────────────────

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
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

// ── Persistent Answer Store ─────────────────────────────────
//  Survives server restarts so queued items can still be fetched
const ANSWERS_FILE = path.join(__dirname, 'resolved_answers.json');
let persistedAnswers = {}; // { taskId: { response, resolvedAt } }
try {
  if (fs.existsSync(ANSWERS_FILE)) {
    persistedAnswers = JSON.parse(fs.readFileSync(ANSWERS_FILE, 'utf8'));
    console.log(`📂  Loaded ${Object.keys(persistedAnswers).length} persisted answers.`);
  }
} catch (e) {
  console.warn('⚠️  Could not load resolved_answers.json:', e.message);
}

function saveAnswerToFile(taskId, response) {
  persistedAnswers[taskId] = { response, resolvedAt: Date.now() };
  try {
    fs.writeFileSync(ANSWERS_FILE, JSON.stringify(persistedAnswers, null, 2));
  } catch (e) {
    console.warn('⚠️  Could not write resolved_answers.json:', e.message);
  }
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
  const { prompt, username, userId } = req.body;

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
      setTimeout(() => pendingChats.delete(taskId), CLEANUP_AFTER_MS);
    }
  }, TIMEOUT_MS);

  // Store the task
  pendingChats.set(taskId, {
    prompt: prompt.trim(),
    username: username || 'Guest',
    timestamp: Date.now(),
    timer,
    webhookMsgId: null,
    response: null,
    timedOut: false,
    resolved: false,
    queued: false, // true once user adds to their queue list
  });

  console.log(`📩  Task ${taskId} created for prompt: "${prompt.trim()}"`);

  // Dispatch to the Discord staff channel
  try {
    const sentMsg = await webhook.send({
      username: 'Bark AI 🐾',
      content: [
        `**📨 New Bark AI prompt!**`,
        `> **Task ID:** \`${taskId}\``,
        `> **User:** \`${username || 'Guest'}\` (${userId || 'anonymous'})`,
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

  res.json({ taskId });
});

// GET /api/chat/:taskId — poll for a response
app.get('/api/chat/:taskId', (req, res) => {
  const taskId = parseInt(req.params.taskId, 10);

  if (!pendingChats.has(taskId)) {
    // Check persisted answers before returning not_found
    if (persistedAnswers[taskId]) {
      return res.json({ status: 'resolved', response: persistedAnswers[taskId].response, timedOut: false });
    }
    return res.json({ status: 'not_found' });
  }

  const entry = pendingChats.get(taskId);

  if (entry.resolved) {
    return res.json({ status: 'resolved', response: entry.response, timedOut: entry.timedOut });
  }

  res.json({ status: 'pending' });
});

// POST /api/chat/:taskId/recall — notify Discord that the task was resolved via memory recall
app.post('/api/chat/:taskId/recall', async (req, res) => {
  const taskId = parseInt(req.params.taskId, 10);

  if (!pendingChats.has(taskId)) {
    return res.json({ ok: true, note: 'task_not_found' });
  }

  const entry = pendingChats.get(taskId);

  if (!entry.resolved) {
    clearTimeout(entry.timer);
    entry.response = '[Resolved via memory recall]';
    entry.resolved = true;
  }

  try {
    await webhook.send({
      username: 'Bark AI 🐾',
      content: [
        `**✅ Task ${taskId} auto-resolved** — \`${entry.username}\`'s question was answered from past memory.`,
        `> *"${entry.prompt.length > 80 ? entry.prompt.slice(0, 80) + '...' : entry.prompt}"*`,
        `No staff reply needed.`,
      ].join('\n'),
    });
  } catch (err) {
    console.error('⚠️  Failed to send recall webhook:', err.message);
  }

  if (entry.webhookMsgId) msgIdToTaskId.delete(entry.webhookMsgId);
  setTimeout(() => pendingChats.delete(taskId), CLEANUP_AFTER_MS);

  console.log(`🧠  Task ${taskId} resolved via memory recall.`);
  res.json({ ok: true });
});

// POST /api/chat/:taskId/queue — user moved this task to their queue list
app.post('/api/chat/:taskId/queue', (req, res) => {
  const taskId = parseInt(req.params.taskId, 10);
  if (pendingChats.has(taskId)) {
    pendingChats.get(taskId).queued = true;
    console.log(`📋  Task ${taskId} moved to user queue.`);
  }
  res.json({ ok: true });
});

// GET /api/answers?taskIds=1,2,3 — batch check resolved answers (for queue polling)
app.get('/api/answers', (req, res) => {
  const idsParam = req.query.taskIds || '';
  const taskIds = idsParam.split(',').map(id => parseInt(id, 10)).filter(id => !isNaN(id));

  const answers = {};
  for (const taskId of taskIds) {
    // In-memory first
    if (pendingChats.has(taskId) && pendingChats.get(taskId).resolved) {
      const entry = pendingChats.get(taskId);
      if (!entry.timedOut) answers[taskId] = entry.response;
    }
    // Then persisted file
    else if (persistedAnswers[taskId]) {
      answers[taskId] = persistedAnswers[taskId].response;
    }
  }
  res.json({ answers });
});

// Health-check endpoint
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', pending: pendingChats.size, persisted: Object.keys(persistedAnswers).length });
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

  // Persist so queue polls survive restarts
  saveAnswerToFile(taskId, response);

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

// Register slash commands on startup
client.once('ready', async () => {
  console.log(`🤖  Discord bot logged in as ${client.user.tag}`);

  const barkCommand = new SlashCommandBuilder()
    .setName('bark')
    .setDescription('Reply to a pending Bark AI prompt')
    .addIntegerOption((opt) =>
      opt.setName('task_id').setDescription('The Task ID shown in the prompt message').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('response').setDescription('Your response to send back to the user').setRequired(true)
    );

  const barkQueueCommand = new SlashCommandBuilder()
    .setName('bark-queue')
    .setDescription('List or answer queued Bark AI prompts (user added to list)')
    .addSubcommand(sub =>
      sub.setName('list').setDescription('Show all queued (unanswered) tasks')
    )
    .addSubcommand(sub =>
      sub.setName('answer')
        .setDescription('Answer a queued task')
        .addIntegerOption(opt =>
          opt.setName('task_id').setDescription('Task ID to answer').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('response').setDescription('Your answer').setRequired(true)
        )
    );

  const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);

  try {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: [barkCommand.toJSON(), barkQueueCommand.toJSON()],
    });
    console.log('✅  /bark and /bark-queue slash commands registered globally.');
  } catch (err) {
    console.error('❌  Failed to register slash commands:', err);
  }
});

// Handle /bark and /bark-queue interactions
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ── /bark ──
  if (interaction.commandName === 'bark') {
    const taskId = interaction.options.getInteger('task_id');
    const response = interaction.options.getString('response');

    if (!pendingChats.has(taskId) || pendingChats.get(taskId).resolved) {
      return interaction.reply({
        content: `❌ Task **${taskId}** not found or already answered.`,
        ephemeral: true,
      });
    }

    resolveTask(taskId, response);

    return interaction.reply({
      content: `✅ Response sent for Task **${taskId}**!\n> ${response}`,
      ephemeral: true,
    });
  }

  // ── /bark-queue ──
  if (interaction.commandName === 'bark-queue') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      const queued = [];
      for (const [id, entry] of pendingChats) {
        if (!entry.resolved && entry.queued) {
          queued.push({ id, prompt: entry.prompt, username: entry.username, age: Math.round((Date.now() - entry.timestamp) / 60000) });
        }
      }
      if (queued.length === 0) {
        return interaction.reply({ content: '📋 No queued prompts right now.', ephemeral: true });
      }
      const lines = queued.map(q => `\`#${q.id}\` (${q.age}m) **${q.username}**: ${q.prompt.slice(0, 80)}`);
      return interaction.reply({ content: `**📋 Queued Prompts:**\n${lines.join('\n')}\n\nUse \`/bark-queue answer task_id:<id> response:<answer>\``, ephemeral: true });
    }

    if (sub === 'answer') {
      const taskId = interaction.options.getInteger('task_id');
      const response = interaction.options.getString('response');

      if (!pendingChats.has(taskId) || pendingChats.get(taskId).resolved) {
        return interaction.reply({ content: `❌ Task **${taskId}** not found or already answered.`, ephemeral: true });
      }

      resolveTask(taskId, response);

      // Notify channel
      try {
        await webhook.send({
          username: 'Bark AI 🐾',
          content: `**✅ Queued Task ${taskId} answered** by ${interaction.user.username}.\n> *"${pendingChats.get(taskId)?.prompt?.slice(0, 80) || '...'}"*\n> ${response}`,
        });
      } catch (e) { /* ignore */ }

      return interaction.reply({
        content: `✅ Answer saved for Task **${taskId}** — the user will see it when they check their queue.\n> ${response}`,
        ephemeral: true,
      });
    }
  }
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
