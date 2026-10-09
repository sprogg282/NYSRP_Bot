const { REST, Routes, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Load commands into client and optionally register with Discord REST API
 * @param {Client} client 
 */
async function loadCommands(client) {
    client.commands = new Collection();
    const commandDataArray = [];
    const commandsPath = path.join(__dirname, '../commands');

    const commandFolders = fs.readdirSync(commandsPath);

    for (const folder of commandFolders) {
        const folderPath = path.join(commandsPath, folder);
        if (!fs.statSync(folderPath).isDirectory()) continue;

        const commandFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.js'));
        for (const file of commandFiles) {
            const filePath = path.join(folderPath, file);
            const command = require(filePath);

            if (command.data && command.execute) {
                client.commands.set(command.data.name, command);
                commandDataArray.push(command.data.toJSON());
                logger.info(`Loaded command: ${command.data.name}`);
            } else {
                logger.warn(`Command at ${filePath} is missing "data" or "execute" property.`);
            }
        }
    }

    // Deploy slash commands if client ID & token are present
    if (config.token && config.clientId) {
        const rest = new REST({ version: '10' }).setToken(config.token);
        try {
            logger.info(`Started refreshing ${commandDataArray.length} application (/) commands.`);
            if (config.guildId) {
                await rest.put(
                    Routes.applicationGuildCommands(config.clientId, config.guildId),
                    { body: commandDataArray }
                );
                logger.info(`Successfully reloaded ${commandDataArray.length} guild (/) commands for Guild ${config.guildId}.`);
            } else {
                await rest.put(
                    Routes.applicationCommands(config.clientId),
                    { body: commandDataArray }
                );
                logger.info(`Successfully reloaded ${commandDataArray.length} global (/) commands.`);
            }
        } catch (error) {
            logger.error(`Error registering slash commands: ${error.message}`);
        }
    } else {
        logger.warn('Skipping slash command deployment: DISCORD_TOKEN or CLIENT_ID not set in .env.');
    }
}

module.exports = { loadCommands };
