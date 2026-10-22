const logger = require('../utils/logger');
const config = require('../config');
const SessionService = require('../services/sessionService');
const TicketService = require('../services/ticketService');
const PollService = require('../services/pollService');
const EventService = require('../services/eventService');
const ERLCService = require('../services/erlcService');
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

        try {
            await SessionService.recoverActiveSessions(client);
        } catch (error) {
            logger.error('[Session Recovery] Could not recover active session state:', error);
        }
        SessionService.startNotificationRetry(client);
        try {
            await TicketService.recoverInterruptedClosures(client);
        } catch (error) {
            logger.error('[Ticket Recovery] Could not recover interrupted ticket closures:', error);
        }
        await PollService.startScheduler(client);
        await EventService.startScheduler(client);
        await ERLCService.startScheduler(client);
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
