const logger = require('../utils/logger');
const { isProcessed, markProcessed } = require('../utils/store');
const { parseModerationEmbed } = require('../parser/moderationParser');
const { appendModeration } = require('../google/sheets');
const { sendLogToChannel } = require('../utils/discordLogger');

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

function setupModerationListener(client, processedIds) {
  const modChannelId = process.env.MODERATION_LOG_CHANNEL_ID;

  if (!modChannelId) {
    throw new Error('MODERATION_LOG_CHANNEL_ID is not set in .env');
  }

  // ========================
  // 2. messageCreate listener
  // ========================
  client.on('messageCreate', async (message) => {
    // --- 2b. Moderation Log biasa (Warn, dll) ---
    if (message.channel.id !== modChannelId) return;
    if (!message.embeds || message.embeds.length === 0) return;

    const caseEmbed = message.embeds.find((e) => hasCaseInfo(e));
    if (!caseEmbed) return;

    if (isProcessed(processedIds, message.id)) return;

    logger.info(`📩 Moderation log: ${message.id} | Author: "${caseEmbed.author?.name || caseEmbed.title}"`);

    try {
      const parsed = parseModerationEmbed(message);

      if (!parsed) {
        logger.info(`⏭️ Type not supported for auto-log, skipping.`);
        markProcessed(processedIds, message.id);
        return;
      }

      const caseKey = `case_${parsed.type}_${parsed.caseNumber}`;
      if (isProcessed(processedIds, caseKey)) {
        logger.info(`⏭️ Case ${parsed.caseNumber} already logged, skipping duplicate.`);
        markProcessed(processedIds, message.id);
        return;
      }

      const requiredFields = ['type', 'caseNumber', 'userId', 'username', 'reason', 'timestamp'];
      const missing = requiredFields.filter((f) => !parsed[f]);

      if (missing.length > 0) {
        logger.error(`Case ${parsed.caseNumber || '?'}: Missing fields: ${missing.join(', ')}. Skipping.`);
        markProcessed(processedIds, message.id);
        return;
      }

      parsed.messageUrl = getMessageUrl(message);

      logger.info(`📝 Writing: Case ${parsed.caseNumber} | ${parsed.type} | ${parsed.username}`);

      await appendModeration(parsed);

      markProcessed(processedIds, message.id);
      markProcessed(processedIds, caseKey);

      logger.info(`✅ Case ${parsed.caseNumber} logged to Google Sheets.`);

      // Kirim log embed ke Discord channel
      await sendLogToChannel({
        type: parsed.type,
        caseNumber: parsed.caseNumber,
        userId: parsed.userId,
        username: parsed.username,
        reason: parsed.reason,
        timestamp: parsed.timestamp,
        messageUrl: parsed.messageUrl,
        duration: parsed.duration,
        source: 'auto',
      });
    } catch (err) {
      logger.error(`Error processing message ${message.id}:`, err.message);
    }
  });

  logger.info(`Moderation listener active on channel: ${modChannelId}`);
}

module.exports = { setupModerationListener };
