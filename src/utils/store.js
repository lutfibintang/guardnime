const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const STORE_PATH = path.join(process.cwd(), 'processed_messages.json');

/**
 * Membaca daftar message ID yang sudah diproses dari file JSON.
 * @returns {Set<string>} Set berisi message ID yang sudah diproses.
 */
function loadProcessedIds() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const data = fs.readFileSync(STORE_PATH, 'utf-8');
      const arr = JSON.parse(data);
      if (Array.isArray(arr)) {
        logger.info(`Loaded ${arr.length} processed message IDs from store.`);
        return new Set(arr);
      }
    }
  } catch (err) {
    logger.error('Failed to load processed messages store:', err.message);
  }
  return new Set();
}

/**
 * Menyimpan Set message ID ke file JSON.
 * @param {Set<string>} idSet
 */
function saveProcessedIds(idSet) {
  try {
    const arr = Array.from(idSet);
    fs.writeFileSync(STORE_PATH, JSON.stringify(arr, null, 2), 'utf-8');
  } catch (err) {
    logger.error('Failed to save processed messages store:', err.message);
  }
}

/**
 * Mengecek apakah message ID sudah pernah diproses.
 * @param {Set<string>} idSet
 * @param {string} messageId
 * @returns {boolean}
 */
function isProcessed(idSet, messageId) {
  return idSet.has(messageId);
}

/**
 * Menandai message ID sebagai sudah diproses dan menyimpan ke disk.
 * @param {Set<string>} idSet
 * @param {string} messageId
 */
function markProcessed(idSet, messageId) {
  idSet.add(messageId);
  saveProcessedIds(idSet);
}

module.exports = {
  loadProcessedIds,
  saveProcessedIds,
  isProcessed,
  markProcessed,
};
