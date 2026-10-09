const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

/**
 * Load event listeners
 * @param {Client} client 
 */
function loadEvents(client) {
    const eventsPath = path.join(__dirname, '../events');
    if (!fs.existsSync(eventsPath)) return;

    const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

    for (const file of eventFiles) {
        const filePath = path.join(eventsPath, file);
        const event = require(filePath);

        if (event.name && event.execute) {
            if (event.once) {
                client.once(event.name, (...args) => event.execute(...args, client));
            } else {
                client.on(event.name, (...args) => event.execute(...args, client));
            }
            logger.info(`Loaded event: ${event.name}`);
        }
    }
}

module.exports = { loadEvents };
