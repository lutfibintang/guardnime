const logger = require('../utils/logger');
const { getSheetsClient } = require('../google/sheets');

/**
 * Mapping tab sheet dan range untuk search moderation.
 * HANYA membaca 4 tab ini (Read-Only):
 * - List TO
 * - List Warn
 * - List Kick
 * - List Ban
 */
const TARGET_SHEETS = [
  { type: 'to', sheetName: 'List TO', range: "'List TO'!A:F" },
  { type: 'warn', sheetName: 'List Warn', range: "'List Warn'!A:E" },
  { type: 'kick', sheetName: 'List Kick', range: "'List Kick'!A:E" },
  { type: 'ban', sheetName: 'List Ban', range: "'List Ban'!A:E" },
];

/**
 * Clean case number dari formula HYPERLINK atau string lain.
 * Contoh: =HYPERLINK("url"; "1201") -> "1201"
 *
 * @param {string} caseStr
 * @returns {string}
 */
function cleanCaseNumber(caseStr) {
  if (!caseStr) return '';
  const str = String(caseStr).trim();
  // Matching HYPERLINK formula dengan separator ; atau ,
  const match = str.match(/HYPERLINK\([^;)]+[;,]\s*"([^"]+)"\)/i) || str.match(/"([^"]+)"\)/);
  if (match) return match[1].trim();
  return str;
}

/**
 * Parse tanggal dari Google Sheets ("DD/MM/YYYY HH:mm", "DD/MM/YYYY", dsb).
 * Return epoch timestamp (ms), atau 0 jika tanggal tidak valid.
 *
 * @param {string} dateStr
 * @returns {number}
 */
function parseSheetDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return 0;
  const str = dateStr.trim();
  // Match format DD/MM/YYYY atau DD-MM-YYYY jam:menit[:detik]
  const match = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (match) {
    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1; // 0-indexed month
    const year = parseInt(match[3], 10);
    const hour = match[4] ? parseInt(match[4], 10) : 0;
    const minute = match[5] ? parseInt(match[5], 10) : 0;
    const second = match[6] ? parseInt(match[6], 10) : 0;
    const d = new Date(year, month, day, hour, minute, second);
    const ts = d.getTime();
    return isNaN(ts) ? 0 : ts;
  }
  const parsed = Date.parse(str);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Cari seluruh riwayat moderation seorang user dari Google Sheets.
 * Operasi ini bersifat READ-ONLY.
 *
 * @param {object} options
 * @param {string} [options.userId] - Discord User ID (Identifier Utama)
 * @param {string} [options.username] - Username (Fallback)
 * @returns {Promise<{
 *   userId: string,
 *   username: string,
 *   summary: { to: number, warn: number, kick: number, ban: number, total: number },
 *   cases: Array<{ type: string, caseNumber: string, date: string, dateTimestamp: number, username: string, userId: string, reason: string, duration?: string }>
 * }>}
 */
async function searchUserModeration(options = {}) {
  const { userId, username } = options;
  const targetUserId = userId ? String(userId).trim() : null;
  const targetUsername = username ? String(username).trim() : null;

  if (!targetUserId && !targetUsername) {
    throw new Error('User ID atau Username harus dispesifikasikan untuk pencarian.');
  }

  const { sheetsClient, spreadsheetId } = getSheetsClient();
  if (!sheetsClient || !spreadsheetId) {
    throw new Error('Google Sheets client not initialized.');
  }

  logger.info('[SEARCH] User requested moderation history');
  if (targetUserId) {
    logger.info(`[SEARCH] User ID: ${targetUserId}`);
  } else if (targetUsername) {
    logger.info(`[SEARCH] Username: ${targetUsername}`);
  }

  for (const s of TARGET_SHEETS) {
    logger.info(`[SEARCH] Reading ${s.sheetName}`);
  }

  let valueRanges = [];
  try {
    const response = await sheetsClient.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: TARGET_SHEETS.map((s) => s.range),
    });
    valueRanges = response.data.valueRanges || [];
  } catch (err) {
    logger.error('[ERROR] Failed to search moderation history');
    if (targetUserId) {
      logger.error(`[ERROR] User ID: ${targetUserId}`);
    } else if (targetUsername) {
      logger.error(`[ERROR] Username: ${targetUsername}`);
    }
    throw err;
  }

  const cases = [];
  let resolvedUsername = targetUsername || null;

  for (let i = 0; i < TARGET_SHEETS.length; i++) {
    const targetSheet = TARGET_SHEETS[i];
    const sheetData = valueRanges[i];
    const rows = sheetData?.values || [];

    for (const row of rows) {
      if (!row || row.length === 0) continue;

      const cellUserId = (row[2] || '').trim();
      const cellUsername = (row[3] || '').trim();

      // Skip row jika User ID & Username kosong, atau merupakan header row
      if (!cellUserId && !cellUsername) continue;
      if (cellUserId.toLowerCase() === 'id user' || cellUserId.toLowerCase() === 'id') continue;

      let isMatch = false;

      if (targetUserId) {
        // ID User adalah identifier UTAMA
        if (cellUserId === targetUserId) {
          isMatch = true;
        }
      } else if (targetUsername) {
        // Username sebagai fallback jika User ID tidak diberikan
        if (
          cellUsername.toLowerCase() === targetUsername.toLowerCase() ||
          cellUserId.toLowerCase() === targetUsername.toLowerCase()
        ) {
          isMatch = true;
        }
      }

      if (isMatch) {
        const rawCase = row[1];
        const cleanedCase = cleanCaseNumber(rawCase);

        // Jika Case kosong (Requirement 20) -> abaikan row jika wajib
        if (!cleanedCase) continue;

        const dateStr = (row[0] || '').trim();
        const reasonStr = (row[4] || '').trim();
        const durationStr = targetSheet.type === 'to' && row[5] ? (row[5] || '').trim() : undefined;
        const dateTimestamp = parseSheetDate(dateStr);

        cases.push({
          type: targetSheet.type,
          caseNumber: cleanedCase,
          date: dateStr || 'Unknown',
          dateTimestamp,
          username: cellUsername || resolvedUsername || 'Unknown',
          userId: cellUserId || targetUserId || '',
          reason: reasonStr || '-',
          duration: durationStr,
        });

        if (!resolvedUsername && cellUsername) {
          resolvedUsername = cellUsername;
        }
      }
    }
  }

  if (cases.length === 0) {
    logger.info(`[SEARCH] No moderation history found for ${targetUserId || targetUsername}`);
  } else {
    logger.info(`[SEARCH] Found ${cases.length} moderation cases`);
    logger.info('[SEARCH] Successfully generated result');
  }

  // Urutkan berdasarkan tanggal TERBARU -> TERLAMA
  cases.sort((a, b) => {
    if (b.dateTimestamp !== a.dateTimestamp) {
      return b.dateTimestamp - a.dateTimestamp;
    }
    // Secondary fallback: Case number descending
    const numA = parseInt(a.caseNumber.replace(/\D/g, ''), 10) || 0;
    const numB = parseInt(b.caseNumber.replace(/\D/g, ''), 10) || 0;
    return numB - numA;
  });

  const summary = {
    to: cases.filter((c) => c.type === 'to').length,
    warn: cases.filter((c) => c.type === 'warn').length,
    kick: cases.filter((c) => c.type === 'kick').length,
    ban: cases.filter((c) => c.type === 'ban').length,
    total: cases.length,
  };

  return {
    userId: targetUserId || (cases.length > 0 ? cases[0].userId : ''),
    username: resolvedUsername || (cases.length > 0 ? cases[0].username : 'Unknown'),
    summary,
    cases,
  };
}

/**
 * In-memory store untuk state pagination agar Discord button tidak re-fetch Google Sheets.
 */
const searchCache = new Map();

function saveSearchState(searchId, data) {
  searchCache.set(searchId, {
    ...data,
    createdAt: Date.now(),
  });

  // Self-cleaning: hapus item yang > 30 menit
  const now = Date.now();
  for (const [key, val] of searchCache.entries()) {
    if (now - val.createdAt > 30 * 60 * 1000) {
      searchCache.delete(key);
    }
  }
}

function getSearchState(searchId) {
  return searchCache.get(searchId);
}

module.exports = {
  searchUserModeration,
  saveSearchState,
  getSearchState,
  parseSheetDate,
  cleanCaseNumber,
};
