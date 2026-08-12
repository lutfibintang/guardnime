const { EmbedBuilder } = require('discord.js');
const logger = require('../utils/logger');

/**
 * Referensi Discord client. Di-set oleh index.js saat startup.
 * @type {import('discord.js').Client | null}
 */
let discordClient = null;

/**
 * Set Discord client reference.
 * @param {import('discord.js').Client} client
 */
function setClient(client) {
  discordClient = client;
}

/**
 * Konfigurasi warna & emoji per moderation type.
 */
const TYPE_CONFIG = {
  to: { emoji: '🟣', label: 'Timeout', color: 0x5865f2 },
  warn: { emoji: '⚠️', label: 'Warn', color: 0xfee75c },
  kick: { emoji: '👢', label: 'Kick', color: 0xffa500 },
  ban: { emoji: '🔨', label: 'Ban', color: 0xff0000 },
};

/**
 * Kirim embed log ke channel Discord setelah data berhasil ditulis ke Google Sheets.
 *
 * @param {object} data
 * @param {string} data.type - "ban" | "kick" | "warn" | "to"
 * @param {string} data.caseNumber - Nomor case (atau "Automod", "Kura", "Manual")
 * @param {string} data.userId - Discord User ID
 * @param {string} data.username - Username
 * @param {string} data.reason - Alasan moderation
 * @param {Date}   data.timestamp - Waktu kejadian
 * @param {string} [data.messageUrl] - URL ke message Discord (opsional)
 * @param {string} [data.duration] - Durasi timeout (hanya untuk TO)
 * @param {string} [data.source] - Sumber log: "auto" | "manual" | "automod" | "context-menu"
 */
async function sendLogToChannel(data) {
  const channelId = process.env.BOT_LOG_CHANNEL_ID;
  if (!channelId || !discordClient) return;

  try {
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      logger.warn(`[LOG] Bot log channel ${channelId} not found or not text-based.`);
      return;
    }

    const config = TYPE_CONFIG[data.type] || { emoji: '📋', label: data.type, color: 0x99aab5 };

    const sourceLabel = data.source === 'automod' ? 'AutoMod'
      : data.source === 'auto' ? 'Auto-Log'
      : data.source === 'context-menu' ? 'Context Menu'
      : data.source === 'manual' ? 'Manual'
      : 'Bot';

    const embed = new EmbedBuilder()
      .setTitle(`${config.emoji} ${config.label} — Logged to Sheets`)
      .setColor(config.color)
      .setTimestamp(data.timestamp || new Date());

    // Fields
    const fields = [
      { name: '👤 User', value: data.username || 'Unknown', inline: true },
      { name: '🆔 User ID', value: data.userId || '-', inline: true },
      { name: '📝 Case', value: String(data.caseNumber || '-'), inline: true },
    ];

    if (data.reason) {
      fields.push({ name: '📋 Reason', value: data.reason, inline: false });
    }

    if (data.duration) {
      fields.push({ name: '⏱️ Duration', value: data.duration, inline: true });
    }

    if (data.messageUrl) {
      fields.push({ name: '🔗 Source', value: `[Jump to message](${data.messageUrl})`, inline: true });
    }

    embed.addFields(fields);
    embed.setFooter({ text: `Source: ${sourceLabel} • made by Izuminaru.` });

    await channel.send({ embeds: [embed] });
  } catch (err) {
    // Jangan crash bot hanya karena gagal kirim log ke Discord
    logger.warn(`[LOG] Failed to send log embed to channel: ${err.message}`);
  }
}

module.exports = { setClient, sendLogToChannel };
