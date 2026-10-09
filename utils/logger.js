/**
 * Simple, clean logger utility for NYSRP Bot
 */

function formatTime() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

const logger = {
    info: (msg) => console.log(`[${formatTime()}] [INFO] ${msg}`),
    warn: (msg) => console.warn(`[${formatTime()}] [WARN] ${msg}`),
    error: (msg, err) => console.error(`[${formatTime()}] [ERROR] ${msg}`, err || ''),
    debug: (msg) => {
        if (process.env.DEBUG) {
            console.log(`[${formatTime()}] [DEBUG] ${msg}`);
        }
    }
};

module.exports = logger;
