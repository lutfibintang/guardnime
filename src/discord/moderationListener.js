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

/**
 * Cek apakah message ini adalah AutoMod alert yang harus di-log sebagai TO.
 * Membaca embed fields (rule_name, timeout_duration) untuk menentukan.
 *
 * HANYA log jika rule_name = "Timeout 5 menit" atau "Timeout 10 menit".
 * SKIP jika rule_name mengandung "Tanpa TO".
 *
 * @param {import('discord.js').Message} message
 * @returns {{ rule: string, duration: string } | null}
 */
function parseAutoModMessage(message) {
  if (!message.embeds || message.embeds.length === 0) return null;

  const embed = message.embeds[0];

  // Gabungkan seluruh teks dari embed untuk pengecekan rule
  const footerText = embed.footer?.text || '';
  const description = embed.description || '';
  const fieldsText = (embed.fields || []).map((f) => `${f.name}: ${f.value}`).join(' | ');
  const rawText = `${footerText} ${description} ${fieldsText}`;

  // Cek dari embed.fields (Discord AutoMod internal fields)
  let ruleName = '';
  let timeoutDuration = '';

  if (embed.fields && embed.fields.length > 0) {
    for (const field of embed.fields) {
      if (field.name === 'rule_name') {
        ruleName = field.value || '';
      }
      if (field.name === 'timeout_duration') {
        timeoutDuration = field.value || '';
      }
    }
  }

  // Fallback: cek dari rawText
  if (!ruleName) {
    const ruleMatch = rawText.match(/Rule:\s*([^|•\n]+)/i);
    if (ruleMatch) {
      ruleName = ruleMatch[1].trim();
    }
  }

  // Jika rule "Tanpa TO" -> SKIP
  if (/Tanpa\s+TO/i.test(ruleName) || /Tanpa\s+TO/i.test(rawText)) {
    return null;
  }

  // Cek apakah Rule memuat "Timeout 5 menit" atau "Timeout 10 menit"
  const allText = `${ruleName} ${rawText}`;
  const is5Min = /Timeout\s*5\s*(menit|mins|min)?/i.test(allText);
  const is10Min = /Timeout\s*10\s*(menit|mins|min)?/i.test(allText);

  if (!is5Min && !is10Min) {
    return null; // Skip rule selain Timeout 5/10 menit
  }

  // Determine duration
  let duration = is10Min ? '10 mins' : '5 mins';
  if (timeoutDuration) {
    const secs = parseInt(timeoutDuration, 10);
    if (!isNaN(secs) && secs > 0) {
      duration = secs >= 60 ? `${Math.floor(secs / 60)} mins` : `${secs}s`;
    }
  } else {
    // Fallback: cek dari rawText "Timeout: 5 mins"
    const durationMatch = rawText.match(/Timeout:\s*([^|•\n]+)/i);
    if (durationMatch) {
      duration = durationMatch[1].trim();
    }
  }

  // Reason = Rule name
  const reason = ruleName || (is10Min ? 'Timeout 10 menit' : 'Timeout 5 menit');

  return { rule: reason, duration };
}

/**
 * Setup listener untuk moderation log & AutoMod log.
 *
 * @param {import('discord.js').Client} client
 * @param {Set<string>} processedIds
 */
function setupModerationListener(client, processedIds) {
  const modChannelId = process.env.MODERATION_LOG_CHANNEL_ID;
  const automodChannelId = process.env.AUTOMOD_LOG_CHANNEL_ID;

  if (!modChannelId) {
    throw new Error('MODERATION_LOG_CHANNEL_ID is not set in .env');
  }

  // ========================
  // 1. AutoMod Execution Event (Primary - jika intent aktif)
  // ========================
  client.on('autoModerationActionExecution', async (execution) => {
    try {
      const ruleName = execution.ruleName || '';

      // Skip jika rule "Tanpa TO"
      if (/Tanpa\s+TO/i.test(ruleName)) return;

      // Cek apakah Rule memuat "Timeout 5 menit" atau "Timeout 10 menit"
      const is5Min = /Timeout\s*5\s*menit/i.test(ruleName);
      const is10Min = /Timeout\s*10\s*menit/i.test(ruleName);
      if (!is5Min && !is10Min) return;

      const userId = execution.userId;
      if (!userId) {
        logger.warn('[AUTOMOD-EVENT] No userId in autoModerationActionExecution');
        return;
      }

      // Duplicate protection
      const dedupeKey = `automod_event_${userId}_${execution.ruleId}_${Math.floor(Date.now() / 5000)}`;
      if (isProcessed(processedIds, dedupeKey)) return;

      let username = 'Unknown';
      try {
        const user = await client.users.fetch(userId);
        if (user) username = user.username;
      } catch (err) {
        logger.warn(`[AUTOMOD-EVENT] Could not fetch user ${userId}: ${err.message}`);
      }

      const durationSeconds = execution.action?.metadata?.durationSeconds || (is10Min ? 600 : 300);
      const durationStr = durationSeconds >= 60 ? `${Math.floor(durationSeconds / 60)} mins` : `${durationSeconds}s`;

      let messageUrl = '';
      if (execution.alertSystemMessageId && automodChannelId) {
        messageUrl = `https://discord.com/channels/${execution.guildId}/${automodChannelId}/${execution.alertSystemMessageId}`;
      }

      const now = new Date();

      logger.info(`🤖 [AUTOMOD-EVENT] TO | ${username} (${userId}) | Rule: ${ruleName} | Duration: ${durationStr}`);

      await appendModeration({
        type: 'to',
        caseNumber: 'Automod',
        userId,
        username,
        reason: ruleName,
        timestamp: now,
        messageUrl,
        duration: durationStr,
      });

      markProcessed(processedIds, dedupeKey);
      logger.info(`✅ [AUTOMOD-EVENT] TO logged | ${username} (${userId}) | ${ruleName} | ${durationStr}`);

      // Kirim log embed ke Discord channel
      await sendLogToChannel({
        type: 'to',
        caseNumber: 'Automod',
        userId,
        username,
        reason: ruleName,
        timestamp: now,
        messageUrl,
        duration: durationStr,
        source: 'automod',
      });
    } catch (err) {
      logger.error(`[AUTOMOD-EVENT] Error:`, err.message);
    }
  });

  logger.info('AutoMod execution listener registered.');

  // ========================
  // 2. messageCreate listener
  // ========================
  client.on('messageCreate', async (message) => {
    // --- 2a. AutoMod alert via messageCreate (Fallback) ---
    if (automodChannelId && message.channel.id === automodChannelId) {
      // Skip jika sudah di-processed
      if (isProcessed(processedIds, message.id)) return;

      const autoModData = parseAutoModMessage(message);
      if (autoModData) {
        // Untuk AutoMod alert messages (type 24), message.author = user yang kena TO
        // Untuk pesan biasa dari bot AutoMod, cek apakah author bukan bot
        let userId = null;
        let username = 'Unknown';

        // Discord AutoMod action messages: type 24 = AUTO_MODERATION_ACTION
        // Pada message type ini, author adalah user yang melanggar
        if (message.type === 24) {
          userId = message.author?.id;
          username = message.author?.username || 'Unknown';
        }

        // Fallback: cek mentions
        if (!userId && message.mentions && message.mentions.users?.size > 0) {
          const nonBot = message.mentions.users.find((u) => !u.bot);
          if (nonBot) {
            userId = nonBot.id;
            username = nonBot.username;
          }
        }

        // Fallback: cek embedded user_id field
        if (!userId && message.embeds?.[0]?.fields) {
          for (const field of message.embeds[0].fields) {
            if (field.name === 'user_id' || field.name === 'actor_id') {
              const val = (field.value || '').trim();
              if (/^\d{17,20}$/.test(val)) {
                userId = val;
                try {
                  const u = await client.users.fetch(val);
                  if (u) username = u.username;
                } catch (e) {}
              }
            }
          }
        }

        if (!userId) {
          // Debug log untuk membantu troubleshoot
          logger.warn(
            `[AUTOMOD-MSG] Could not resolve user | msg.type=${message.type} | msg.author=${message.author?.tag || 'none'} (${message.author?.id || 'none'}, bot=${message.author?.bot})`
          );
          markProcessed(processedIds, message.id);
          return;
        }

        // Duplicate protection
        const dedupeKey = `automod_msg_${userId}_${Math.floor(Date.now() / 5000)}`;
        if (isProcessed(processedIds, dedupeKey)) {
          markProcessed(processedIds, message.id);
          return;
        }

        const messageUrl = getMessageUrl(message);
        const now = new Date();

        try {
          logger.info(`🤖 [AUTOMOD-MSG] TO | ${username} (${userId}) | Rule: ${autoModData.rule} | Duration: ${autoModData.duration}`);

          await appendModeration({
            type: 'to',
            caseNumber: 'Automod',
            userId,
            username,
            reason: autoModData.rule,
            timestamp: now,
            messageUrl,
            duration: autoModData.duration,
          });

          markProcessed(processedIds, message.id);
          markProcessed(processedIds, dedupeKey);
          logger.info(`✅ [AUTOMOD-MSG] TO logged | ${username} (${userId}) | ${autoModData.rule} | ${autoModData.duration}`);

          // Kirim log embed ke Discord channel
          await sendLogToChannel({
            type: 'to',
            caseNumber: 'Automod',
            userId,
            username,
            reason: autoModData.rule,
            timestamp: now,
            messageUrl,
            duration: autoModData.duration,
            source: 'automod',
          });
        } catch (err) {
          logger.error(`[AUTOMOD-MSG] Error logging:`, err.message);
        }
        return;
      }
    }

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
  if (automodChannelId) {
    logger.info(`AutoMod message listener active on channel: ${automodChannelId}`);
  }
}

module.exports = { setupModerationListener };
