const { SlashCommandBuilder } = require('discord.js');
const { hasPermission } = require('../../utils/permissionCheck');
const { PERMISSIONS } = require('../../config/permissions');
const WelcomeService = require('../../services/welcomeService');
const { createErrorEmbed } = require('../../utils/embedBuilder');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('test')
        .setDescription('NYSRP Staff Testing & Preview Commands')
        .addSubcommand(sub =>
            sub.setName('welcome')
                .setDescription('Preview the official NYSRP welcome message for new members.')
        ),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'welcome') {
            if (!hasPermission(interaction.member, PERMISSIONS.STAFF_VIEW)) {
                return interaction.reply({
                    embeds: [
                        createErrorEmbed(
                            'Permission Denied',
                            'Only authorized NYSRP Staff members can use preview test commands.'
                        )
                    ],
                    ephemeral: true
                });
            }

            // Build the EXACT same payload used when a real member joins.
            const welcomePayload = WelcomeService.buildWelcomePayload(
                interaction.member
            );

            return interaction.reply({
                content: welcomePayload.content,
                embeds: welcomePayload.embeds,
                files: welcomePayload.files || [],
                ephemeral: true
            });
        }
    }
};

