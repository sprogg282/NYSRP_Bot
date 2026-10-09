const { handleComponentInteraction } = require('../handlers/componentHandler');
const CommandLogService = require('../services/commandLogService');
const { createErrorEmbed } = require('../utils/embedBuilder');
const logger = require('../utils/logger');

module.exports = {
    name: 'interactionCreate',
    async execute(interaction, client) {
        // Handle Slash Commands
        if (interaction.isChatInputCommand()) {
            const command = client.commands.get(interaction.commandName);
            if (!command) {
                logger.warn(`No command matching ${interaction.commandName} was found.`);
                return;
            }

            try {
                await command.execute(interaction);
                // Log successful command execution to official Command Log channel (1515409909779271770)
                await CommandLogService.logCommand(interaction, true, null);
            } catch (error) {
                logger.error(`Error executing slash command /${interaction.commandName}:`, error);
                
                // Log failed command execution to official Command Log channel (1515409909779271770)
                await CommandLogService.logCommand(interaction, false, error.message);

                const errorEmbed = createErrorEmbed(
                    'Command Execution Error',
                    'An unhandled exception occurred while processing this command.'
                );

                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ embeds: [errorEmbed], ephemeral: true }).catch(() => {});
                } else {
                    await interaction.reply({ embeds: [errorEmbed], ephemeral: true }).catch(() => {});
                }
            }
            return;
        }

        // Handle Component Interactions (Buttons, Select Menus, Modals)
        if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
            try {
                await handleComponentInteraction(interaction);
            } catch (error) {
                logger.error(`Error handling component interaction (${interaction.customId}):`, error);
            }
        }
    }
};
