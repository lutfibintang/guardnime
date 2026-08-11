const { REST, Routes } = require('discord.js');
const { commands } = require('./definitions');
const logger = require('../utils/logger');

/**
 * Register commands ke Discord API.
 * Menggunakan guild commands (instant) bukan global commands (delay 1 jam).
 *
 * @param {string} token - Discord bot token.
 * @param {string} clientId - Bot application/client ID.
 * @param {string[]} guildIds - Array of guild IDs.
 */
async function registerCommands(token, clientId, guildIds) {
  const rest = new REST({ version: '10' }).setToken(token);

  const commandData = commands.map((cmd) => cmd.toJSON());

  try {
    // Hapus global commands lama (slash commands /ban /kick)
    logger.info('Clearing old global commands...');
    await rest.put(Routes.applicationCommands(clientId), { body: [] });

    // Register guild commands (instant, tidak perlu tunggu 1 jam)
    for (const guildId of guildIds) {
      logger.info(`Registering ${commandData.length} commands for guild ${guildId}...`);
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commandData,
      });
    }

    logger.info('✅ Commands registered successfully (guild-level, instant).');
  } catch (err) {
    logger.error('Failed to register commands:', err.message);
    throw err;
  }
}

module.exports = { registerCommands };
