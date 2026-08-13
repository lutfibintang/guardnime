const {
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const logger = require('../utils/logger');
const { appendModeration, searchUserInSheet, getLeaderboard } = require('../google/sheets');
const { sendLogToChannel } = require('../utils/discordLogger');
const {
  searchUserModeration,
  saveSearchState,
  getSearchState,
} = require('../services/moderationSearch');

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

      // Kirim log embed ke Discord channel
      await sendLogToChannel({
        type: 'to',
        caseNumber: 'Kura',
        userId: resolvedId,
        username: parsed.username,
        reason: parsed.reason,
        timestamp: now,
        messageUrl,
        duration: parsed.duration,
        source: 'context-menu',
      });
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

  // Kirim log embed ke Discord channel
  await sendLogToChannel({
    type: modType,
    caseNumber: 'Manual',
    userId,
    username,
    reason,
    timestamp: now,
    messageUrl,
    source: 'manual',
  });
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

  // Kirim log embed ke Discord channel
  await sendLogToChannel({
    type: 'to',
    caseNumber: 'Kura',
    userId,
    username: parsed.username,
    reason: parsed.reason,
    timestamp: now,
    messageUrl,
    duration: parsed.duration,
    source: 'context-menu',
  });
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

const PAGE_SIZE = 10;

/**
 * Utility untuk membuat Embed dan ActionRow button pagination untuk /search.
 */
function buildSearchEmbedAndRow(searchResult, page = 1, searchId = '', targetUserObj = null) {
  const totalCases = searchResult.cases.length;
  const totalPages = Math.ceil(totalCases / PAGE_SIZE) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const embed = new EmbedBuilder()
    .setTitle('🔎 Moderation History')
    .setColor(0x5865f2)
    .setTimestamp();

  if (targetUserObj && typeof targetUserObj.displayAvatarURL === 'function') {
    embed.setThumbnail(targetUserObj.displayAvatarURL({ size: 128 }));
  }

  const userDisplayName = searchResult.username || 'Unknown';
  const userIdDisplay = searchResult.userId || '-';

  let descriptionText = [
    `👤 **User**`,
    `${userDisplayName}`,
    ``,
    `🆔 **User ID**`,
    `${userIdDisplay}`,
    ``,
    `📊 **Summary**`,
    `🟣 TO: ${searchResult.summary.to}`,
    `⚠️ Warn: ${searchResult.summary.warn}`,
    `👢 Kick: ${searchResult.summary.kick}`,
    `🔨 Ban: ${searchResult.summary.ban}`,
    ``,
    `📋 **Total Cases**: ${searchResult.summary.total}`,
  ].join('\n');

  if (totalCases === 0) {
    descriptionText += `\n\n────────────────────\nTidak ada riwayat moderation yang ditemukan.`;
  } else {
    descriptionText += `\n\n────────────────────\n`;

    const startIndex = (currentPage - 1) * PAGE_SIZE;
    const pageCases = searchResult.cases.slice(startIndex, startIndex + PAGE_SIZE);

    if (totalCases > PAGE_SIZE) {
      descriptionText += `📋 **Showing ${startIndex + 1}-${startIndex + pageCases.length} of ${totalCases} cases**\n\n`;
    } else {
      descriptionText += `📋 **Recent Cases**\n\n`;
    }

    const CATEGORY_MAP = {
      to: { emoji: '🟣', label: 'TO' },
      warn: { emoji: '⚠️', label: 'Warn' },
      kick: { emoji: '👢', label: 'Kick' },
      ban: { emoji: '🔨', label: 'Ban' },
    };

    for (const c of pageCases) {
      const cat = CATEGORY_MAP[c.type] || { emoji: '❓', label: c.type.toUpperCase() };
      let caseLabel = c.caseNumber;
      if (!caseLabel.startsWith('#')) {
        caseLabel = `#${caseLabel}`;
      }

      descriptionText += `${cat.emoji} **${cat.label}** — Case ${caseLabel}\n`;
      descriptionText += `${c.date}\n`;
      descriptionText += `Reason: ${c.reason}\n`;
      if (c.duration) {
        descriptionText += `Duration: ${c.duration}\n`;
      }
      descriptionText += `\n`;
    }
  }

  embed.setDescription(descriptionText);

  if (totalCases > PAGE_SIZE) {
    embed.setFooter({
      text: `Page ${currentPage}/${totalPages} • User ID: ${userIdDisplay} • made by Izuminaru.`,
    });
  } else {
    embed.setFooter({
      text: `User ID: ${userIdDisplay} • made by Izuminaru.`,
    });
  }

  const components = [];
  if (totalCases > PAGE_SIZE && searchId) {
    const prevBtn = new ButtonBuilder()
      .setCustomId(`search_prev_${searchId}`)
      .setLabel('◀ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage <= 1);

    const pageIndicatorBtn = new ButtonBuilder()
      .setCustomId(`search_page_${searchId}`)
      .setLabel(`${currentPage} / ${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);

    const nextBtn = new ButtonBuilder()
      .setCustomId(`search_next_${searchId}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages);

    const row = new ActionRowBuilder().addComponents(prevBtn, pageIndicatorBtn, nextBtn);
    components.push(row);
  }

  return { embeds: [embed], components, currentPage, totalPages };
}

/**
 * Handle Slash Command /search.
 */
async function handleSearchCommand(interaction) {
  if (interaction.commandName !== 'search') return false;

  // Response bersifat PUBLIC (dapat dilihat oleh semua orang)
  await interaction.deferReply({ ephemeral: false });

  const targetUser = interaction.options.getUser('user');
  const targetIdOrName = interaction.options.getString('id');

  let searchOptions = {};
  let targetUserObj = targetUser || null;

  if (targetUser) {
    searchOptions = {
      userId: targetUser.id,
      username: targetUser.username,
    };
  } else if (targetIdOrName) {
    const trimmed = targetIdOrName.trim();
    if (/^\d{17,20}$/.test(trimmed)) {
      searchOptions = { userId: trimmed };
      try {
        targetUserObj = await interaction.client.users.fetch(trimmed);
        if (targetUserObj) {
          searchOptions.username = targetUserObj.username;
        }
      } catch (err) {
        // Fallback jika user ID tidak ada di Discord cache/fetch
      }
    } else {
      searchOptions = { username: trimmed };
    }
  } else {
    await interaction.editReply({
      content: '❌ Harap tentukan user yang ingin dicari (contoh: `/search user:@Pel` atau `/search id:576343975938621440`).',
    });
    return true;
  }

  try {
    const searchResult = await searchUserModeration(searchOptions);
    const searchId = `srch_${Date.now()}_${interaction.user.id}`;

    const { embeds, components, currentPage, totalPages } = buildSearchEmbedAndRow(
      searchResult,
      1,
      searchId,
      targetUserObj
    );

    if (searchResult.cases.length > PAGE_SIZE) {
      saveSearchState(searchId, {
        searchResult,
        currentPage,
        totalPages,
        targetUserObj,
      });
    }

    await interaction.editReply({ embeds, components });
  } catch (err) {
    logger.error('[ERROR] Failed to search moderation history');
    if (searchOptions.userId) {
      logger.error(`[ERROR] User ID: ${searchOptions.userId}`);
    }
    logger.error('Search command error:', err.message);

    await interaction.editReply({
      content: '❌ Gagal mengambil moderation history.\nSilakan coba lagi beberapa saat lagi.',
    });
  }

  return true;
}

/**
 * Handle pagination button interaction untuk /search.
 */
async function handleSearchPagination(interaction) {
  if (!interaction.isButton()) return false;

  const customId = interaction.customId;
  if (!customId.startsWith('search_prev_') && !customId.startsWith('search_next_')) {
    return false;
  }

  const isPrev = customId.startsWith('search_prev_');
  const searchId = customId.replace(isPrev ? 'search_prev_' : 'search_next_', '');

  const state = getSearchState(searchId);
  if (!state) {
    await interaction.reply({
      content: '❌ Sesi pencarian ini telah expired. Silakan jalankan `/search` kembali.',
      ephemeral: true,
    });
    return true;
  }

  if (isPrev) {
    state.currentPage = Math.max(1, state.currentPage - 1);
  } else {
    state.currentPage = Math.min(state.totalPages, state.currentPage + 1);
  }

  const { embeds, components } = buildSearchEmbedAndRow(
    state.searchResult,
    state.currentPage,
    searchId,
    state.targetUserObj
  );

  await interaction.update({ embeds, components });
  return true;
}

/**
 * Handle /add-role slash command.
 * Menambahkan 1 role ke maksimal 5 member sekaligus.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {boolean} true jika command di-handle
 */
async function handleAddRole(interaction) {
  if (interaction.commandName !== 'add-role') return false;

  await interaction.deferReply();

  const role = interaction.options.getRole('role');

  // Kumpulkan member unik (1-5)
  const memberKeys = [
    'member1', 'member2', 'member3', 'member4', 'member5',
    'member6', 'member7', 'member8', 'member9', 'member10',
    'member11', 'member12', 'member13', 'member14', 'member15',
  ];
  const seenIds = new Set();
  const members = [];

  for (const key of memberKeys) {
    const user = interaction.options.getUser(key);
    if (user && !seenIds.has(user.id)) {
      seenIds.add(user.id);
      members.push(user);
    }
  }

  if (members.length === 0) {
    await interaction.editReply('❌ Tidak ada member yang dipilih.');
    return true;
  }

  // Cek apakah bot punya posisi role lebih tinggi dari role target
  const botMember = interaction.guild.members.me;
  if (!botMember) {
    await interaction.editReply('❌ Tidak bisa mendapatkan info bot di server ini.');
    return true;
  }

  if (role.position >= botMember.roles.highest.position) {
    await interaction.editReply(
      `❌ Bot tidak bisa menambahkan role **${role.name}** karena posisi role tersebut lebih tinggi atau sama dengan role bot.`
    );
    return true;
  }

  if (role.managed) {
    await interaction.editReply(
      `❌ Role **${role.name}** adalah managed role (milik bot/integrasi) dan tidak bisa ditambahkan secara manual.`
    );
    return true;
  }

  const results = [];

  for (const user of members) {
    try {
      const guildMember = await interaction.guild.members.fetch(user.id);

      if (guildMember.roles.cache.has(role.id)) {
        results.push({ user, status: 'skipped', reason: 'Sudah punya role ini' });
        continue;
      }

      await guildMember.roles.add(role.id);
      results.push({ user, status: 'success' });
    } catch (err) {
      logger.error(`[ADD-ROLE] Failed to add role to ${user.username} (${user.id}): ${err.message}`);
      results.push({ user, status: 'failed', reason: err.message });
    }
  }

  // Build result embed
  const successCount = results.filter((r) => r.status === 'success').length;
  const skippedCount = results.filter((r) => r.status === 'skipped').length;
  const failedCount = results.filter((r) => r.status === 'failed').length;

  const STATUS_EMOJI = {
    success: '✅',
    skipped: '⏭️',
    failed: '❌',
  };

  let resultText = '';
  for (const r of results) {
    const emoji = STATUS_EMOJI[r.status];
    const note = r.reason ? ` — ${r.reason}` : '';
    resultText += `${emoji} <@${r.user.id}> (${r.user.username})${note}\n`;
  }

  const embed = new EmbedBuilder()
    .setTitle('➕ Add Role — Result')
    .setDescription(
      `**Role:** <@&${role.id}>\n**Target:** ${members.length} member(s)\n\n${resultText}`
    )
    .addFields(
      { name: '✅ Berhasil', value: `${successCount}`, inline: true },
      { name: '⏭️ Sudah punya', value: `${skippedCount}`, inline: true },
      { name: '❌ Gagal', value: `${failedCount}`, inline: true }
    )
    .setColor(failedCount > 0 ? 0xffa500 : 0x57f287)
    .setFooter({ text: `Executed by ${interaction.user.username} • made by Izuminaru.` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  logger.info(
    `✅ [ADD-ROLE] ${interaction.user.username} added role "${role.name}" to ${successCount}/${members.length} members.`
  );

  return true;
}

module.exports = {
  handleContextMenu,
  handleModalSubmit,
  handleSlashCommand,
  handleLeaderboard,
  handleSearchCommand,
  handleSearchPagination,
  handleAddRole,
};
