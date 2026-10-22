const { SlashCommandBuilder } = require('discord.js');
const { hasPermission } = require('../../utils/permissionCheck');
const { PERMISSIONS } = require('../../config/permissions');
const EventService = require('../../services/eventService');
const { createSuccessEmbed, createErrorEmbed, createNYSRPEmbed } = require('../../utils/embedBuilder');
const config = require('../../config');
const logger = require('../../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('event')
        .setDescription('Create and manage NYSRP events and giveaways')
        .addSubcommand(subcommand => subcommand
            .setName('create')
            .setDescription('Schedule a community event')
            .addStringOption(option => option
                .setName('title')
                .setDescription('Event name')
                .setMaxLength(100)
                .setRequired(true))
            .addStringOption(option => option
                .setName('starts-at')
                .setDescription('Start time in ISO 8601 format, including timezone')
                .setMinLength(20)
                .setMaxLength(40)
                .setRequired(true))
            .addIntegerOption(option => option
                .setName('duration')
                .setDescription('Event duration in minutes (1-10080)')
                .setMinValue(1)
                .setMaxValue(10080)
                .setRequired(true))
            .addStringOption(option => option
                .setName('description')
                .setDescription('Optional event details')
                .setMaxLength(1000)))
        .addSubcommand(subcommand => subcommand
            .setName('giveaway')
            .setDescription('Start a giveaway with automatic winner selection')
            .addStringOption(option => option
                .setName('title')
                .setDescription('Prize or giveaway name')
                .setMaxLength(100)
                .setRequired(true))
            .addIntegerOption(option => option
                .setName('duration')
                .setDescription('Entry duration in minutes (1-10080)')
                .setMinValue(1)
                .setMaxValue(10080)
                .setRequired(true))
            .addIntegerOption(option => option
                .setName('winners')
                .setDescription('Number of winners to select (1-20)')
                .setMinValue(1)
                .setMaxValue(20)
                .setRequired(true))
            .addStringOption(option => option
                .setName('description')
                .setDescription('Optional giveaway details')
                .setMaxLength(1000)))
        .addSubcommand(subcommand => subcommand
            .setName('list')
            .setDescription('List upcoming events and active giveaways'))
        .addSubcommand(subcommand => subcommand
            .setName('close')
            .setDescription('End an event or giveaway immediately')
            .addIntegerOption(option => option
                .setName('id')
                .setDescription('The event ID shown in its title')
                .setMinValue(1)
                .setRequired(true)))
        .addSubcommand(subcommand => subcommand
            .setName('cancel')
            .setDescription('Cancel an event or giveaway')
            .addIntegerOption(option => option
                .setName('id')
                .setDescription('The event ID shown in its title')
                .setMinValue(1)
                .setRequired(true))),

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({
                embeds: [createErrorEmbed('Events', 'Events and giveaways can only be managed inside a server.')],
                ephemeral: true
            });
        }
        if (!hasPermission(interaction.member, PERMISSIONS.EVENT_MANAGE)) {
            return interaction.reply({
                embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to manage events and giveaways.')],
                ephemeral: true
            });
        }

        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'list') {
            const events = EventService.listOpenEvents(interaction.guild.id);
            const items = events.map(event => {
                const type = event.event_type === 'GIVEAWAY' ? 'Giveaway' : 'Event';
                return `**${type} #${event.event_id}: ${event.title}** · starts <t:${Math.floor(event.starts_at / 1000)}:R> · closes <t:${Math.floor(event.ends_at / 1000)}:R> · <#${event.channel_id}>`;
            });
            return interaction.reply({
                embeds: [createNYSRPEmbed({
                    title: 'Upcoming Events and Giveaways',
                    introduction: events.length
                        ? 'Here are the active community events and giveaways.'
                        : 'There are no upcoming events or active giveaways.',
                    sections: events.length ? [{ title: `Active (${events.length})`, items }] : [],
                    color: config.branding.color
                })],
                ephemeral: true
            });
        }

        await interaction.deferReply({ ephemeral: true });
        try {
            if (subcommand === 'create' || subcommand === 'giveaway') {
                if (!interaction.channel?.isTextBased() || typeof interaction.channel.send !== 'function') {
                    throw new Error('Events and giveaways can only be posted in a text channel.');
                }
                const isGiveaway = subcommand === 'giveaway';
                const duration = interaction.options.getInteger('duration', true);
                const startsAt = isGiveaway
                    ? Date.now()
                    : Date.parse(interaction.options.getString('starts-at', true));
                const created = await EventService.createEvent(interaction.channel, interaction.user.id, {
                    eventType: isGiveaway ? 'GIVEAWAY' : 'EVENT',
                    title: interaction.options.getString('title', true),
                    description: interaction.options.getString('description') || '',
                    startsAt,
                    durationMinutes: duration,
                    winnerCount: isGiveaway ? interaction.options.getInteger('winners', true) : null
                });
                return interaction.editReply({
                    embeds: [createSuccessEmbed(
                        isGiveaway ? 'Giveaway Started' : 'Event Scheduled',
                        `${isGiveaway ? 'Giveaway' : 'Event'} **#${created.eventId}** has been posted in <#${interaction.channel.id}> and ends <t:${Math.floor(created.endsAt / 1000)}:R>.`
                    )]
                });
            }

            const eventId = interaction.options.getInteger('id', true);
            if (subcommand === 'close') {
                const result = await EventService.closeEventForGuild(
                    eventId,
                    interaction.guild.id,
                    interaction.client
                );
                const event = result.event;
                const message = result.messageMissing
                    ? `Event **#${eventId}** has ended and results are saved, but its Discord message no longer exists.`
                    : event.event_type === 'GIVEAWAY'
                        ? result.winners.length
                            ? `Giveaway **#${eventId}** has ended. Winner(s): ${result.winners.map(userId => `<@${userId}>`).join(', ')}.`
                            : `Giveaway **#${eventId}** has ended with no eligible entries.`
                        : `Event **#${eventId}** has ended.`;
                return interaction.editReply({
                    embeds: [createSuccessEmbed('Event Closed', message)]
                });
            }

            if (subcommand === 'cancel') {
                const result = await EventService.cancelEventForGuild(
                    eventId,
                    interaction.guild.id,
                    interaction.client
                );
                const message = result.messageMissing
                    ? `Event **#${eventId}** has been cancelled, but its Discord message no longer exists.`
                    : `Event **#${eventId}** has been cancelled.`;
                return interaction.editReply({
                    embeds: [createSuccessEmbed('Event Cancelled', message)]
                });
            }
        } catch (error) {
            logger.error(`[Events] /event ${subcommand} failed:`, error);
            return interaction.editReply({
                embeds: [createErrorEmbed('Event Operation Failed', error.message)]
            });
        }
    }
};
