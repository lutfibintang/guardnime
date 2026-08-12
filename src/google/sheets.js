const { google } = require('googleapis');
const logger = require('../utils/logger');

/**
 * Mapping dari moderation type ke nama sheet di Google Spreadsheet.
 */
const SHEET_MAP = {
  ban: 'List Ban',
  kick: 'List Kick',
  warn: 'List Warn',
  to: 'List TO',
};

let sheetsClient = null;
let spreadsheetId = null;

/**
 * Inisialisasi Google Sheets API client menggunakan Service Account.
 * Harus dipanggil sekali saat bot startup.
 */
async function initGoogleSheets() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  const sheetId = process.env.GOOGLE_SPREADSHEET_ID;

  if (!email || !privateKey || !sheetId) {
    throw new Error(
      'Missing Google Sheets config. Pastikan GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, dan GOOGLE_SPREADSHEET_ID sudah diisi di .env'
    );
  }

  // Handle escaped newlines dari .env
  const formattedKey = privateKey.replace(/\\n/g, '\n');

  const auth = new google.auth.JWT({
    email,
    key: formattedKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  await auth.authorize();
  logger.info('Google Sheets API authenticated successfully.');

  sheetsClient = google.sheets({ version: 'v4', auth });
  spreadsheetId = sheetId;
}

/**
 * Mengembalikan client Google Sheets dan spreadsheet ID yang sudah diinisialisasi.
 */
function getSheetsClient() {
  return { sheetsClient, spreadsheetId };
}

/**
 * Format Date object ke string "DD/MM/YYYY HH:mm" dalam timezone Asia/Jakarta.
 * @param {Date} date
 * @returns {string}
 */
function formatDateJakarta(date) {
  const options = {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  };

  const formatter = new Intl.DateTimeFormat('en-GB', options);
  const parts = formatter.formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value || '';

  const day = get('day');
  const month = get('month');
  const year = get('year');

  return `${day}/${month}/${year}`;
}

/**
 * Membaca case number tertinggi dari semua sheet (List Ban, List Kick, List Warn).
 * @returns {Promise<number>} Case number tertinggi yang ditemukan, atau 0 jika kosong.
 */
async function getMaxCaseNumber() {
  if (!sheetsClient) {
    throw new Error('Google Sheets client not initialized.');
  }

  let maxCase = 0;

  for (const sheetName of Object.values(SHEET_MAP)) {
    try {
      const res = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `'${sheetName}'!B:B`,
      });

      const rows = res.data.values;
      if (!rows || rows.length === 0) continue;

      for (const row of rows) {
        const val = parseInt(row[0], 10);
        if (!isNaN(val) && val > maxCase) {
          maxCase = val;
        }
      }
    } catch (err) {
      logger.warn(`Could not read case numbers from "${sheetName}": ${err.message}`);
    }
  }

  return maxCase;
}

/**
 * Menambahkan row baru ke sheet yang sesuai di Google Spreadsheet.
 *
 * Kolom yang ditulis sesuai header Google Sheets:
 * A = Tanggal
 * B = Case
 * C = ID User
 * D = Nama
 * E = Reason
 *
 * @param {object} data - Parsed moderation data.
 * @param {string} data.type - "ban", "kick", atau "warn"
 * @param {string} data.caseNumber
 * @param {string} data.userId
 * @param {string} data.username
 * @param {string} data.reason
 * @param {Date} data.timestamp
 * @param {string} [data.messageUrl] - URL message Discord untuk link di kolom Case
 */
async function appendModeration(data) {
  if (!sheetsClient) {
    throw new Error('Google Sheets client not initialized. Call initGoogleSheets() first.');
  }

  const sheetName = SHEET_MAP[data.type];
  if (!sheetName) {
    logger.warn(`No sheet mapping for moderation type "${data.type}". Skipping.`);
    return;
  }

  const tanggal = formatDateJakarta(data.timestamp);

  // Kolom Case: jika ada messageUrl, buat HYPERLINK formula
  // Google Sheets Indonesia pakai ; sebagai separator formula
  let caseValue = data.caseNumber;
  if (data.messageUrl) {
    caseValue = `=HYPERLINK("${data.messageUrl}";"${data.caseNumber}")`;
  }

  // Row: Tanggal | Case | ID User | Nama | Reason | (Duration untuk List TO)
  const row = [tanggal, caseValue, data.userId, data.username, data.reason];

  // List TO punya kolom tambahan: Duration (kolom F)
  if (data.duration) {
    row.push(data.duration);
  }

  const range = data.duration ? `'${sheetName}'!A:F` : `'${sheetName}'!A:E`;

  try {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [row],
      },
    });

    logger.info(
      `✅ Appended to "${sheetName}": Case ${data.caseNumber} | ${data.username} | ${data.userId}`
    );
  } catch (err) {
    logger.error(`Failed to append to "${sheetName}":`, err.message);
    throw err;
  }
}

/**
 * Cari semua entri dari User ID tertentu di sheet.
 * Kolom C (index 2) = ID User.
 *
 * @param {string} type - Moderation type (ban/kick/warn/to).
 * @param {string} userId - Discord User ID.
 * @returns {Promise<{ count: number, entries: Array<{ tanggal: string, caseNumber: string, username: string, reason: string, duration?: string }> }>}
 */
async function searchUserInSheet(type, userId) {
  if (!sheetsClient) {
    throw new Error('Google Sheets client not initialized.');
  }

  const sheetName = SHEET_MAP[type];
  if (!sheetName) {
    throw new Error(`No sheet mapping for type "${type}".`);
  }

  const range = type === 'to' ? `'${sheetName}'!A:F` : `'${sheetName}'!A:E`;

  const response = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const rows = response.data.values || [];

  // Skip header rows (cari baris yang kolom C = userId)
  // Kolom: A=Tanggal, B=Case, C=ID User, D=Nama, E=Reason, F=Duration (TO only)
  const matches = [];

  for (const row of rows) {
    const cellUserId = (row[2] || '').trim();
    if (cellUserId === userId) {
      matches.push({
        tanggal: row[0] || '-',
        caseNumber: row[1] || '-',
        username: row[3] || '-',
        reason: row[4] || '-',
        duration: row[5] || undefined,
      });
    }
  }

  return {
    count: matches.length,
    entries: matches,
  };
}

/**
 * Ambil leaderboard dari sheet tertentu.
 * Hitung berapa kali setiap User ID muncul, urutkan dari terbanyak.
 *
 * @param {string} type - Moderation type (ban/kick/warn/to).
 * @param {number} [limit=10] - Jumlah top entries yang dikembalikan.
 * @returns {Promise<Array<{ userId: string, username: string, count: number }>>}
 */
async function getLeaderboard(type, limit = 10) {
  if (!sheetsClient) {
    throw new Error('Google Sheets client not initialized.');
  }

  const sheetName = SHEET_MAP[type];
  if (!sheetName) {
    throw new Error(`No sheet mapping for type "${type}".`);
  }

  const range = type === 'to' ? `'${sheetName}'!A:F` : `'${sheetName}'!A:E`;

  const response = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const rows = response.data.values || [];

  // Hitung per user: Kolom C (index 2) = ID User, Kolom D (index 3) = Nama
  const userCounts = new Map();

  for (const row of rows) {
    const userId = (row[2] || '').trim();
    if (!userId || !/^\d{17,20}$/.test(userId)) continue; // Skip header/invalid

    if (userCounts.has(userId)) {
      const entry = userCounts.get(userId);
      entry.count++;
      // Update username ke yang terbaru
      if (row[3]) entry.username = row[3];
    } else {
      userCounts.set(userId, {
        userId,
        username: row[3] || 'Unknown',
        count: 1,
      });
    }
  }

  // Sort descending by count
  const sorted = Array.from(userCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return sorted;
}

module.exports = {
  initGoogleSheets,
  getSheetsClient,
  appendModeration,
  getMaxCaseNumber,
  formatDateJakarta,
  searchUserInSheet,
  getLeaderboard,
  SHEET_MAP,
};
