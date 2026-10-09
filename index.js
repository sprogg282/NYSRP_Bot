require('dotenv').config();

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const config = require('./config');
const logger = require('./utils/logger');
const { loadCommands } = require('./handlers/commandHandler');
const { loadEvents } = require('./handlers/eventHandler');

// Validate Discord token
if (!config.token || config.token === 'your_discord_bot_token_here') {
    logger.error('CRITICAL: DISCORD_TOKEN is missing or default placeholder in .env!');
    logger.error('Please configure your DISCORD_TOKEN in .env and restart with: node index.js');
}

// Create Discord Client instance
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences
    ],
    partials: [
        Partials.Channel,
        Partials.Message,
        Partials.User,
        Partials.GuildMember
    ]
});

// Initialize Handlers & Login
(async () => {
    try {
        logger.info('Initializing NYSRP Discord Bot...');
        
        // Load Events
        loadEvents(client);

        // Load and Deploy Commands
        await loadCommands(client);

        // Login to Discord if Token is Provided
        if (config.token && config.token !== 'your_discord_bot_token_here') {
            await client.login(config.token);
        } else {
            logger.warn('Bot started in dry-run/configuration mode (No valid token specified).');
        }
    } catch (error) {
        logger.error('Fatal initialization error:', error);
        process.exit(1);
    }
})();
