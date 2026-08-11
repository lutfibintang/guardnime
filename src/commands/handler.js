const {
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');
const logger = require('../utils/logger');
const { appendModeration, searchUserInSheet, getLeaderboard } = require('../google/sheets');

/**
 * Mapping command name ke moderation type.
 */
const COMMAND_TYPE_MAP = {
  'Log Ban': 'ban',
  'Log Kick': 'kick',
  'Log TO': 'to',
};

const TYPE_LABEL = {
  ban: 'Ban',
  kick: 'Kick',
  to: 'Timeout',
};

/**
 * Regex untuk parsing message Ninja Turtles timeout.
 * Format: "Successful Timeout of <username>. for <duration>. Reason: <reason>"
 */
const TIMEOUT_REGEX = /Successful Timeout of \*{0,2}(.+?)\*{0,2}\.?\s+for\s+\*{0,2}(.+?)\*{0,2}\.\s*Reason:\s*(.+)/is;

/**
 * Parse message dari Ninja Turtles / Carl bot.
 */
function parseTimeoutMessage(message) {
  const content = message.content || '';
  const match = content.match(TIMEOUT_REGEX);
  if (match) {
    return {
      username: match[1].replace(/\*+/g, '').trim(),
      duration: match[2].replace(/\*+/g, '').trim(),
      reason: match[3].replace(/\*+/g, '').trim(),
    };
  }
  return null;
}

/**
 * Cari User ID dari username di guild.
 * @returns {string|null} User ID jika ditemukan, null jika tidak.
 */
async function resolveUserId(guild, username) {
  try {
    const members = await guild.members.search({ query: username, limit: 5 });
    const exactMatch = members.find(
      (m) =>
        m.user.username.toLowerCase() === username.toLowerCase() ||
        m.displayName.toLowerCase() === username.toLowerCase()
    );
    if (exactMatch) return exactMatch.user.id;
  } catch (err) {
    logger.warn(`Could not search members for "${username}": ${err.message}`);
  }
  return null;
}

// In-memory store untuk pending TO data
const pendingTimeouts = new Map();

/**
 * Handle Message Context Menu.
 */
async function handleContextMenu(interaction) {
  const commandName = interaction.commandName;
  const modType = COMMAND_TYPE_MAP[commandName];
  if (!modType) return;

  const targetMessage = interaction.targetMessage;
  const label = TYPE_LABEL[modType];
  const customId = `logmod_${modType}_${targetMessage.guildId}_${targetMessage.channelId}_${targetMessage.id}`;

  if (modType === 'to') {
    // === LOG TO ===
    logger.info(`📋 Log TO triggered on message: "${targetMessage.content?.substring(0, 200)}"`);
    const parsed = parseTimeoutMessage(targetMessage);

    if (!parsed) {
      logger.warn(`❌ Could not parse timeout from: "${targetMessage.content}"`);
      await interaction.reply({
        content: '❌ Tidak bisa membaca format timeout dari message ini.\nPastikan klik kanan pada message dari Ninja Turtles / Carl bot.',
        ephemeral: true,
      });
      return;
    }

    // Coba cari User ID otomatis dari username
    const resolvedId = await resolveUserId(interaction.guild, parsed.username);

    if (resolvedId) {
      // USER ID DITEMUKAN → langsung log tanpa modal
      await interaction.deferReply();

      const messageUrl = `https://discord.com/channels/${targetMessage.guildId}/${targetMessage.channelId}/${targetMessage.id}`;
      const now = new Date();

      try {
        await appendModeration({
          type: 'to',
          caseNumber: 'Kura',
          userId: resolvedId,
          username: parsed.username,
          reason: parsed.reason,
          timestamp: now,
          messageUrl,
          duration: parsed.duration,
        });
      } catch (err) {
        logger.error('Failed to log TO:', err.message);
        await interaction.editReply(`❌ Gagal menulis ke Google Sheets: ${err.message}`);
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('✅ Timeout Logged')
        .setDescription('Data timeout berhasil dicatat ke Google Sheets.')
        .addFields(
          { name: 'User', value: parsed.username, inline: true },
          { name: 'ID', value: resolvedId, inline: true },
          { name: 'Duration', value: parsed.duration, inline: true },
          { name: 'Reason', value: parsed.reason }
        )
        .setColor(0x5865f2)
        .setTimestamp(now);

      await interaction.editReply({ embeds: [embed] });
      logger.info(`✅ Timeout | ${parsed.username} (${resolvedId}) | ${parsed.duration} — logged to Sheets.`);
      return;
    }

    // USER ID TIDAK DITEMUKAN → tampilkan modal untuk input manual
    const shortId = `logto_${targetMessage.id}`;
    pendingTimeouts.set(shortId, {
      parsed,
      guildId: targetMessage.guildId,
      channelId: targetMessage.channelId,
      messageId: targetMessage.id,
    });

    const modal = new ModalBuilder()
      .setCustomId(shortId)
      .setTitle('Log Timeout')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('userId')
            .setLabel(`User ID (${parsed.username} tidak ditemukan)`)
            .setPlaceholder('Masukkan User ID secara manual')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
      );

    await interaction.showModal(modal);
  } else {
    // === LOG BAN / KICK: full manual ===
    const modal = new ModalBuilder()
      .setCustomId(customId)
      .setTitle(`Log ${label}`)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('userId')
            .setLabel('User ID')
            .setPlaceholder('Contoh: 576343975938621440')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('username')
            .setLabel('Username')
            .setPlaceholder('Contoh: pell2_')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Reason')
            .setPlaceholder('Alasan ban/kick')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
        ),
      );

    await interaction.showModal(modal);
  }
}

/**
 * Handle modal submit.
 */
async function handleModalSubmit(interaction) {
  const customId = interaction.customId;

  // === LOG TO ===
  if (customId.startsWith('logto_')) {
    await handleTimeoutSubmit(interaction);
    return;
  }

  // === LOG BAN / KICK ===
  if (!customId.startsWith('logmod_')) return;

  await interaction.deferReply();

  const parts = customId.split('_');
  const modType = parts[1];
  const guildId = parts[2];
  const channelId = parts[3];
  const messageId = parts[4];
  const label = TYPE_LABEL[modType];

  const userId = interaction.fields.getTextInputValue('userId').trim();
  const username = interaction.fields.getTextInputValue('username').trim();
  const reason = interaction.fields.getTextInputValue('reason').trim();

  if (!/^\d{17,20}$/.test(userId)) {
    await interaction.editReply('❌ User ID tidak valid. Harus berupa angka 17-20 digit.');
    return;
  }

  const messageUrl = `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
  const now = new Date();

  try {
    await appendModeration({
      type: modType,
      caseNumber: 'Manual',
      userId,
      username,
      reason,
      timestamp: now,
      messageUrl,
    });
  } catch (err) {
    logger.error('Failed to log to Google Sheets:', err.message);
    await interaction.editReply(`❌ Gagal menulis ke Google Sheets: ${err.message}`);
    return;
  }

  const color = modType === 'ban' ? 0xff0000 : 0xffa500;

  const embed = new EmbedBuilder()
    .setTitle(`✅ ${label} Logged`)
    .setDescription(`Data ${label.toLowerCase()} berhasil dicatat ke Google Sheets.`)
    .addFields(
      { name: 'User', value: username, inline: true },
      { name: 'ID', value: userId, inline: true },
      { name: 'Reason', value: reason, inline: true }
    )
    .setColor(color)
    .setFooter({ text: 'made by Izuminaru.' })
    .setTimestamp(now);

  await interaction.editReply({ embeds: [embed] });
  logger.info(`✅ Manual ${label} | ${username} (${userId}) — logged to Sheets.`);
}

/**
 * Handle timeout modal submit (fallback jika username tidak ditemukan).
 */
async function handleTimeoutSubmit(interaction) {
  await interaction.deferReply();

  const customId = interaction.customId;
  const userId = interaction.fields.getTextInputValue('userId').trim();

  if (!/^\d{17,20}$/.test(userId)) {
    await interaction.editReply('❌ User ID tidak valid. Harus berupa angka 17-20 digit.');
    return;
  }

  if (!pendingTimeouts.has(customId)) {
    await interaction.editReply('❌ Data timeout sudah expired. Coba lagi.');
    return;
  }

  const data = pendingTimeouts.get(customId);
  pendingTimeouts.delete(customId);

  const { parsed, guildId, channelId, messageId } = data;
  const messageUrl = `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
  const now = new Date();

  try {
    await appendModeration({
      type: 'to',
      caseNumber: 'Kura',
      userId,
      username: parsed.username,
      reason: parsed.reason,
      timestamp: now,
      messageUrl,
      duration: parsed.duration,
    });
  } catch (err) {
    logger.error('Failed to log TO:', err.message);
    await interaction.editReply(`❌ Gagal menulis ke Google Sheets: ${err.message}`);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('✅ Timeout Logged')
    .setDescription('Data timeout berhasil dicatat ke Google Sheets.')
    .addFields(
      { name: 'User', value: parsed.username, inline: true },
      { name: 'ID', value: userId, inline: true },
      { name: 'Duration', value: parsed.duration, inline: true },
      { name: 'Reason', value: parsed.reason }
    )
    .setColor(0x5865f2)
    .setFooter({ text: 'made by Izuminaru.' })
    .setTimestamp(now);

  await interaction.editReply({ embeds: [embed] });
  logger.info(`✅ Timeout | ${parsed.username} (${userId}) | ${parsed.duration} — logged to Sheets.`);
}

/**
 * Mapping slash command name ke moderation type.
 */
const LIST_COMMAND_MAP = {
  'list-warn': { type: 'warn', label: 'Warn', color: 0xfee75c, emoji: '⚠️' },
  'list-ban': { type: 'ban', label: 'Ban', color: 0xff0000, emoji: '🔨' },
  'list-kick': { type: 'kick', label: 'Kick', color: 0xffa500, emoji: '👢' },
  'list-to': { type: 'to', label: 'Timeout', color: 0x5865f2, emoji: '⏱️' },
};

/**
 * Handle slash commands (/list-warn, /list-ban, /list-kick, /list-to).
 * Cek berapa kali user masuk list tertentu.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleSlashCommand(interaction) {
  const config = LIST_COMMAND_MAP[interaction.commandName];
  if (!config) return;

  await interaction.deferReply();

  const targetUser = interaction.options.getUser('member');
  const userId = targetUser.id;

  try {
    const result = await searchUserInSheet(config.type, userId);

    const embed = new EmbedBuilder()
      .setTitle(`${config.emoji} ${config.label} History — ${targetUser.username}`)
      .setThumbnail(targetUser.displayAvatarURL({ size: 128 }))
      .setColor(config.color)
      .setTimestamp();

    if (result.count === 0) {
      embed.setDescription(`✅ **${targetUser.username}** tidak pernah masuk **List ${config.label}**.`);
    } else {
      embed.setDescription(`**${targetUser.username}** tercatat **${result.count}x** di **List ${config.label}**.`);

      // Tampilkan max 10 entri terakhir
      const entries = result.entries.slice(-10);
      let details = '';

      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const line = config.type === 'to'
          ? `**${i + 1}.** ${e.tanggal} — ${e.reason} (${e.duration || '-'})`
          : `**${i + 1}.** ${e.tanggal} — ${e.reason}`;
        details += line + '\n';
      }

      if (result.count > 10) {
        details += `\n*...dan ${result.count - 10} entri lainnya.*`;
      }

      embed.addFields({ name: 'Detail', value: details || '-' });
    }

    embed.setFooter({ text: `User ID: ${userId} • made by Izuminaru.` });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    logger.error(`Error searching ${config.type} for ${userId}:`, err.message);
    await interaction.editReply(`❌ Gagal membaca data dari Google Sheets: ${err.message}`);
  }
}

/**
 * Mapping leaderboard command name.
 */
const LB_COMMAND_MAP = {
  'lb-warn': { type: 'warn', label: 'Warn', color: 0xfee75c, emoji: '⚠️' },
  'lb-ban': { type: 'ban', label: 'Ban', color: 0xff0000, emoji: '🔨' },
  'lb-kick': { type: 'kick', label: 'Kick', color: 0xffa500, emoji: '👢' },
  'lb-to': { type: 'to', label: 'Timeout', color: 0x5865f2, emoji: '⏱️' },
};

const MEDALS = ['🥇', '🥈', '🥉'];

/**
 * Handle leaderboard slash commands.
 */
async function handleLeaderboard(interaction) {
  const config = LB_COMMAND_MAP[interaction.commandName];
  if (!config) return false;

  await interaction.deferReply();

  try {
    const leaderboard = await getLeaderboard(config.type, 10);

    const embed = new EmbedBuilder()
      .setTitle(`🏆 Leaderboard ${config.label}`)
      .setColor(config.color)
      .setTimestamp();

    if (leaderboard.length === 0) {
      embed.setDescription(`Belum ada data di **List ${config.label}**.`);
    } else {
      let board = '';

      for (let i = 0; i < leaderboard.length; i++) {
        const entry = leaderboard[i];
        const medal = MEDALS[i] || `**${i + 1}.**`;
        board += `${medal} **${entry.username}** — ${entry.count}x\n`;
      }

      embed.setDescription(board);

      const totalEntries = leaderboard.reduce((sum, e) => sum + e.count, 0);
      embed.setFooter({ text: `Total ${totalEntries} entries dari ${leaderboard.length} user • made by Izuminaru.` });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    logger.error(`Error getting leaderboard ${config.type}:`, err.message);
    await interaction.editReply(`❌ Gagal membaca data: ${err.message}`);
  }

  return true;
}

module.exports = { handleContextMenu, handleModalSubmit, handleSlashCommand, handleLeaderboard };
