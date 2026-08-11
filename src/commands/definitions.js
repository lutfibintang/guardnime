const {
  ContextMenuCommandBuilder,
  SlashCommandBuilder,
  ApplicationCommandType,
} = require('discord.js');

/**
 * Definisi commands untuk bot.
 *
 * Permission diset dan divalidasi via runtime handler di index.js:
 * Hanya Administrator & member dengan Role ID 1087264689068724234 yang dapat mengakses.
 */
const commands = [
  // === CONTEXT MENU ===
  new ContextMenuCommandBuilder()
    .setName('Log Ban')
    .setType(ApplicationCommandType.Message),

  new ContextMenuCommandBuilder()
    .setName('Log Kick')
    .setType(ApplicationCommandType.Message),

  new ContextMenuCommandBuilder()
    .setName('Log TO')
    .setType(ApplicationCommandType.Message),

  // === SLASH COMMANDS: Cek History ===
  new SlashCommandBuilder()
    .setName('list-warn')
    .setDescription('Lihat berapa kali user masuk List Warn')
    .addUserOption((opt) =>
      opt.setName('member').setDescription('Pilih member yang mau dicek').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('list-ban')
    .setDescription('Lihat berapa kali user masuk List Ban')
    .addUserOption((opt) =>
      opt.setName('member').setDescription('Pilih member yang mau dicek').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('list-kick')
    .setDescription('Lihat berapa kali user masuk List Kick')
    .addUserOption((opt) =>
      opt.setName('member').setDescription('Pilih member yang mau dicek').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('list-to')
    .setDescription('Lihat berapa kali user masuk List Timeout')
    .addUserOption((opt) =>
      opt.setName('member').setDescription('Pilih member yang mau dicek').setRequired(true)
    ),

  // === SLASH COMMANDS: Leaderboard ===
  new SlashCommandBuilder()
    .setName('lb-warn')
    .setDescription('🏆 Leaderboard user paling sering masuk List Warn'),

  new SlashCommandBuilder()
    .setName('lb-ban')
    .setDescription('🏆 Leaderboard user paling sering masuk List Ban'),

  new SlashCommandBuilder()
    .setName('lb-kick')
    .setDescription('🏆 Leaderboard user paling sering masuk List Kick'),

  new SlashCommandBuilder()
    .setName('lb-to')
    .setDescription('🏆 Leaderboard user paling sering masuk List Timeout'),
];

module.exports = { commands };
