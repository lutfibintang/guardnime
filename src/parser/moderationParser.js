const logger = require('../utils/logger');

// Auto-listener hanya untuk WARN — Ban/Kick ditangani oleh slash command
const AUTO_LISTEN_TYPES = ['warn'];

/**
 * Regex untuk parsing title/author moderation embed.
 * Format: "Case <number> | <type> | <username>"
 */
const TITLE_REGEX = /Case\s+(\d+)\s*\|\s*(\w+)\s*\|\s*(.+)/i;

/**
 * Regex untuk mengekstrak User ID.
 * Format: "ID: <snowflake>"
 */
const USER_ID_REGEX = /ID:\s*(\d{17,20})/;

/**
 * Mengekstrak teks yang berisi case info dari embed.
 * Nime bot menyimpan "Case X | Type | Username" di embed.author.name, BUKAN di embed.title.
 * Parser ini cek keduanya untuk fleksibilitas.
 *
 * @param {import('discord.js').Embed} embed
 * @returns {string}
 */
function getCaseText(embed) {
  // Prioritas 1: author.name (format Nime/Dyno bot)
  if (embed.author && embed.author.name) {
    return embed.author.name;
  }

  // Prioritas 2: title (format bot lain)
  if (embed.title) {
    return embed.title;
  }

  return '';
}

/**
 * Mengekstrak field dari embed Discord.
 * @param {import('discord.js').Embed} embed
 * @returns {Map<string, string>}
 */
function extractEmbedFields(embed) {
  const fields = new Map();

  if (embed.fields && embed.fields.length > 0) {
    for (const field of embed.fields) {
      const name = field.name.trim().toLowerCase();
      const value = field.value.trim();
      fields.set(name, value);
    }
  }

  return fields;
}

/**
 * Mengekstrak User ID dari embed.
 * @param {import('discord.js').Embed} embed
 * @param {Map<string, string>} fields
 * @returns {string|null}
 */
function extractUserId(embed, fields) {
  // 1. Cek footer
  if (embed.footer && embed.footer.text) {
    const match = embed.footer.text.match(USER_ID_REGEX);
    if (match) return match[1];
  }

  // 2. Cek embed description
  if (embed.description) {
    const match = embed.description.match(USER_ID_REGEX);
    if (match) return match[1];
  }

  // 3. Cek semua field values
  for (const [, value] of fields) {
    const match = value.match(USER_ID_REGEX);
    if (match) return match[1];
  }

  return null;
}

/**
 * Mengekstrak reason dari embed fields.
 * @param {Map<string, string>} fields
 * @param {import('discord.js').Embed} embed
 * @returns {string|null}
 */
function extractReason(fields, embed) {
  if (fields.has('reason')) {
    return fields.get('reason');
  }

  for (const [name, value] of fields) {
    if (name.includes('reason') || name.includes('alasan')) {
      return value;
    }
  }

  if (embed.description) {
    const reasonMatch = embed.description.match(/Reason:\s*(.+)/i);
    if (reasonMatch) return reasonMatch[1].trim();
  }

  return null;
}

/**
 * Parse embed moderation Discord.
 * Cek author.name DAN title untuk menemukan "Case X | Type | Username".
 *
 * @param {import('discord.js').Message} message
 * @returns {object|null}
 */
function parseModerationEmbed(message) {
  if (!message.embeds || message.embeds.length === 0) {
    return null;
  }

  for (const embed of message.embeds) {
    const caseText = getCaseText(embed);

    const titleMatch = caseText.match(TITLE_REGEX);
    if (!titleMatch) {
      continue;
    }

    const caseNumber = titleMatch[1];
    const moderationType = titleMatch[2].toLowerCase();
    const username = titleMatch[3].trim();

    // Hanya proses tipe yang di-auto-listen (warn)
    if (!AUTO_LISTEN_TYPES.includes(moderationType)) {
      logger.info(
        `Case ${caseNumber} is type "${moderationType}" — not auto-listened, skipping.`
      );
      return null;
    }

    const fields = extractEmbedFields(embed);

    const userId = extractUserId(embed, fields);
    if (!userId) {
      logger.error(`Case ${caseNumber}: User ID not found in embed. Skipping.`);
      return null;
    }

    const reason = extractReason(fields, embed);
    if (!reason) {
      logger.error(`Case ${caseNumber}: Reason not found in embed. Skipping.`);
      return null;
    }

    const timestamp = message.createdAt;

    const parsed = {
      type: moderationType,
      caseNumber,
      userId,
      username,
      reason,
      timestamp,
    };

    logger.info(
      `✅ Parsed Case ${caseNumber} | ${moderationType} | ${username} | ID: ${userId} | Reason: ${reason}`
    );

    return parsed;
  }

  return null;
}

module.exports = { parseModerationEmbed };
