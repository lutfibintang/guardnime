require('dotenv').config();

const { Client, GatewayIntentBits, Partials, Events, ActivityType, PermissionFlagsBits } = require('discord.js');
const logger = require('./utils/logger');
const { setClient: setLoggerClient } = require('./utils/discordLogger');
const { loadProcessedIds } = require('./utils/store');
const { initGoogleSheets } = require('./google/sheets');
const { setupModerationListener } = require('./discord/moderationListener');
const { registerCommands } = require('./commands/register');
const {
  handleContextMenu,
  handleModalSubmit,
  handleSlashCommand,
  handleLeaderboard,
  handleSearchCommand,
  handleSearchPagination,
  handleAddRole,
} = require('./commands/handler');

const ALLOWED_ROLE_ID = '1087264689068724234';

/**
 * Cek apakah user memiliki izin untuk menggunakan fitur bot.
 * Diizinkan jika:
 * 1. Punya permission Administrator
 * 2. Memiliki Role ID 1087264689068724234
 */
function hasRequiredPermission(interaction) {
  if (!interaction.guild || !interaction.member) return false;

  // Cek Permission Administrator
  const perms = interaction.memberPermissions || interaction.member.permissions;
  if (perms && perms.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  // Cek Role ID 1087264689068724234
  const roles = interaction.member.roles;
  if (roles && typeof roles.cache?.has === 'function') {
    if (roles.cache.has(ALLOWED_ROLE_ID)) return true;
  } else if (Array.isArray(roles)) {
    if (roles.includes(ALLOWED_ROLE_ID)) return true;
  }

  return false;
}

/**
 * Validasi bahwa semua environment variable yang diperlukan sudah tersedia.
 */
function validateEnv() {
  const required = [
    'DISCORD_TOKEN',
    'MODERATION_LOG_CHANNEL_ID',
    'GOOGLE_SPREADSHEET_ID',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_PRIVATE_KEY',
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    logger.error(`Missing environment variables: ${missing.join(', ')}`);
    logger.error('Pastikan file .env sudah dibuat berdasarkan .env.example');
    process.exit(1);
  }
}

/**
 * Entry point utama.
 */
async function main() {
  logger.info('Starting Guard Nime bot...');

  // Validasi env
  validateEnv();

  // Load processed message IDs untuk duplicate protection
  const processedIds = loadProcessedIds();

  // Inisialisasi Google Sheets
  try {
    await initGoogleSheets();
  } catch (err) {
    logger.error('Failed to initialize Google Sheets:', err.message);
    process.exit(1);
  }

  // Setup Discord client
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel],
    presence: {
      status: 'dnd',
      activities: [
        {
          name: 'Nimenation',
          state: 'Made by Izuminaru.',
          type: ActivityType.Watching,
        },
      ],
    },
  });

  // Event: Ready
  client.once(Events.ClientReady, async () => {
    logger.info(`✅ Bot logged in as ${client.user.tag}`);
    logger.info(`Watching channel: ${process.env.MODERATION_LOG_CHANNEL_ID}`);

    // Set Discord client untuk discordLogger
    setLoggerClient(client);

    // Set presence
    client.user.setPresence({
      status: 'dnd',
      activities: [
        {
          name: 'Nimenation',
          state: 'Made by Izuminaru.',
          type: ActivityType.Watching,
        },
      ],
    });
    logger.info('Presence set to DND with RPC footer: Made by Izuminaru.');

    // Register commands di semua guild (instant, tidak perlu tunggu)
    try {
      const guildIds = Array.from(client.guilds.cache.keys());
      await registerCommands(process.env.DISCORD_TOKEN, client.user.id, guildIds);
    } catch (err) {
      logger.error('Failed to register commands:', err.message);
    }
  });

  // Handle interactions
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      // Permission check untuk semua fitur interaction (Context Menu, Slash Commands, Modal, Button)
      if (
        interaction.isMessageContextMenuCommand() ||
        interaction.isChatInputCommand() ||
        interaction.isModalSubmit() ||
        interaction.isButton()
      ) {
        if (!hasRequiredPermission(interaction)) {
          const denyMsg = '❌ Kamu tidak memiliki izin untuk menggunakan fitur ini.\nFitur ini hanya dapat digunakan oleh **Administrator dan Nime Guard** ';
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: denyMsg, ephemeral: true }).catch(() => {});
          } else {
            await interaction.reply({ content: denyMsg, ephemeral: true }).catch(() => {});
          }
          return;
        }
      }

      // Button interaction: pagination untuk /search
      if (interaction.isButton()) {
        const handled = await handleSearchPagination(interaction);
        if (handled) return;
      }

      // Context menu: klik kanan message → Apps → Log Ban / Log Kick / Log TO
      if (interaction.isMessageContextMenuCommand()) {
        await handleContextMenu(interaction);
        return;
      }

      // Slash commands: /ping, /search, /list-*, /lb-*
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'ping') {
          const ws = interaction.client.ws.ping;
          const response = await interaction.reply({ content: '🏓 Pinging...', withResponse: true });
          const roundtrip = response.resource.message.createdTimestamp - interaction.createdTimestamp;
          await interaction.editReply(`🏓 **Pong!**\nLatency: **${roundtrip}ms**\nWebSocket: **${ws}ms**`);
          return;
        }
        if (interaction.commandName === 'search') {
          await handleSearchCommand(interaction);
          return;
        }
        if (interaction.commandName === 'add-role') {
          await handleAddRole(interaction);
          return;
        }
        // Coba leaderboard dulu, lalu list check
        const handled = await handleLeaderboard(interaction);
        if (!handled) await handleSlashCommand(interaction);
        return;
      }

      // Modal submit: form setelah Log Ban / Log Kick / Log TO
      if (interaction.isModalSubmit()) {
        await handleModalSubmit(interaction);
        return;
      }
    } catch (err) {
      logger.error(`Error handling interaction:`, err.message);
      const reply = { content: '❌ Terjadi error saat memproses.', ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  });

  // Setup moderation log listener (auto untuk Warn)
  setupModerationListener(client, processedIds);

  // Login ke Discord
  try {
    await client.login(process.env.DISCORD_TOKEN);
  } catch (err) {
    logger.error('Failed to login to Discord:', err.message);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('Unhandled error in main:', err);
  process.exit(1);
});
