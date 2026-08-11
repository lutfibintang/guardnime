const logger = require('../utils/logger');
const { isProcessed, markProcessed } = require('../utils/store');
const { parseModerationEmbed } = require('../parser/moderationParser');
const { appendModeration } = require('../google/sheets');

/**
 * Cek apakah embed memiliki case info (di author.name atau title).
 */
const CASE_PATTERN = /Case\s+\d+\s*\|/i;

function hasCaseInfo(embed) {
  const authorName = embed.author?.name || '';
  const title = embed.title || '';
  return CASE_PATTERN.test(authorName) || CASE_PATTERN.test(title);
}

/**
 * Buat Discord message URL.
 */
function getMessageUrl(message) {
  return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
}

/**
 * Setup listener untuk moderation log di channel tertentu.
 * Auto-listener ini hanya memproses WARN.
 *
 * @param {import('discord.js').Client} client
 * @param {Set<string>} processedIds
 */
function setupModerationListener(client, processedIds) {
  const channelId = process.env.MODERATION_LOG_CHANNEL_ID;

  if (!channelId) {
    throw new Error('MODERATION_LOG_CHANNEL_ID is not set in .env');
  }

  client.on('messageCreate', async (message) => {
    // Hanya proses message dari channel moderation log
    if (message.channel.id !== channelId) return;

    // Skip jika tidak ada embed
    if (!message.embeds || message.embeds.length === 0) return;

    // Cek apakah ADA embed yang punya case info
    const caseEmbed = message.embeds.find((e) => hasCaseInfo(e));
    if (!caseEmbed) return; // Skip message konfirmasi dll

    // Duplicate protection by message ID
    if (isProcessed(processedIds, message.id)) return;

    logger.info(`📩 Moderation log: ${message.id} | Author: "${caseEmbed.author?.name || caseEmbed.title}"`);

    try {
      const parsed = parseModerationEmbed(message);

      if (!parsed) {
        logger.info(`⏭️ Type not supported for auto-log, skipping.`);
        markProcessed(processedIds, message.id);
        return;
      }

      // Duplicate protection by case number
      const caseKey = `case_${parsed.type}_${parsed.caseNumber}`;
      if (isProcessed(processedIds, caseKey)) {
        logger.info(`⏭️ Case ${parsed.caseNumber} already logged, skipping duplicate.`);
        markProcessed(processedIds, message.id);
        return;
      }

      // Validasi semua field penting
      const requiredFields = ['type', 'caseNumber', 'userId', 'username', 'reason', 'timestamp'];
      const missing = requiredFields.filter((f) => !parsed[f]);

      if (missing.length > 0) {
        logger.error(`Case ${parsed.caseNumber || '?'}: Missing fields: ${missing.join(', ')}. Skipping.`);
        markProcessed(processedIds, message.id);
        return;
      }

      // Tambahkan message URL
      parsed.messageUrl = getMessageUrl(message);

      logger.info(`📝 Writing: Case ${parsed.caseNumber} | ${parsed.type} | ${parsed.username}`);

      await appendModeration(parsed);

      // Tandai message ID DAN case number sebagai processed
      markProcessed(processedIds, message.id);
      markProcessed(processedIds, caseKey);

      logger.info(`✅ Case ${parsed.caseNumber} logged to Google Sheets.`);
    } catch (err) {
      logger.error(`Error processing message ${message.id}:`, err.message);
    }
  });

  logger.info(`Moderation listener active on channel: ${channelId}`);
}

module.exports = { setupModerationListener };
