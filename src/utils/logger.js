const chalk = {
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  red: (text) => `\x1b[31m${text}\x1b[0m`,
  yellow: (text) => `\x1b[33m${text}\x1b[0m`,
  cyan: (text) => `\x1b[36m${text}\x1b[0m`,
  gray: (text) => `\x1b[90m${text}\x1b[0m`,
};

/**
 * Logger sederhana dengan timestamp dan level warna.
 */
const logger = {
  _timestamp() {
    return chalk.gray(new Date().toISOString());
  },

  info(message, ...args) {
    console.log(`${this._timestamp()} ${chalk.green('[INFO]')} ${message}`, ...args);
  },

  warn(message, ...args) {
    console.warn(`${this._timestamp()} ${chalk.yellow('[WARN]')} ${message}`, ...args);
  },

  error(message, ...args) {
    console.error(`${this._timestamp()} ${chalk.red('[ERROR]')} ${message}`, ...args);
  },

  debug(message, ...args) {
    if (process.env.DEBUG === 'true') {
      console.log(`${this._timestamp()} ${chalk.cyan('[DEBUG]')} ${message}`, ...args);
    }
  },
};

module.exports = logger;
