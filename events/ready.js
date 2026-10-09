const logger = require('../utils/logger');
const config = require('../config');
const SessionService = require('../services/sessionService');
const SuggestionService = require('../services/suggestionService');
const { ActivityType } = require('discord.js');

module.exports = {
    name: 'ready',
    once: true,
    async execute(client) {
        logger.info(`=================================================`);
        logger.info(` NYSRP BOT IS ONLINE & OPERATIONAL`);
        logger.info(` Logged in as: ${client.user.tag} (${client.user.id})`);
        logger.info(` Server Name: ${config.branding.serverName}`);
        logger.info(` Guild Count: ${client.guilds.cache.size}`);
        logger.info(` Database: SQLite WAL Engine initialized`);
        logger.info(`=================================================`);

        // Recover active session state on startup
        SessionService.recoverActiveSessions(client);
        await SuggestionService.initialize(client);

        client.user.setPresence({
            activities: [
                {
                    name: 'New York State Roleplay | /help',
                    type: ActivityType.Watching
                }
            ],
            status: 'online'
        });
    }
};
