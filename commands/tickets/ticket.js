const { SlashCommandBuilder } = require('discord.js');
const { hasPermission } = require('../../utils/permissionCheck');
const { PERMISSIONS } = require('../../config/permissions');
const config = require('../../config');
const TicketService = require('../../services/ticketService');
const { getValidatedChannel } = require('../../utils/channelValidator');
const { createSuccessEmbed, createErrorEmbed, createNYSRPEmbed } = require('../../utils/embedBuilder');
const logger = require('../../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('NYSRP Support Ticket Management Commands')

        // /ticket panel
        .addSubcommand(sub =>
            sub.setName('panel')
                .setDescription('Deploy the official NYSRP support ticket panel to the designated support channel.'))

        // /ticket close
        .addSubcommand(sub =>
            sub.setName('close')
                .setDescription('Close the current ticket channel and generate a transcript.'))

        // /ticket lock
        .addSubcommand(sub =>
            sub.setName('lock')
                .setDescription('Lock the current ticket channel (prevents creator messaging).'))

        // /ticket unlock
        .addSubcommand(sub =>
            sub.setName('unlock')
                .setDescription('Unlock the current ticket channel.'))

        // /ticket add
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Add a user to this ticket channel.')
                .addUserOption(opt => opt.setName('user').setDescription('The user to add').setRequired(true)))

        // /ticket remove
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove a user from this ticket channel.')
                .addUserOption(opt => opt.setName('user').setDescription('The user to remove').setRequired(true)))

        .addSubcommand(sub =>
            sub.setName('priority')
                .setDescription('Set the priority of this ticket (staff only).')
                .addStringOption(opt => opt
                    .setName('level')
                    .setDescription('The ticket priority')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Low', value: 'LOW' },
                        { name: 'Normal', value: 'NORMAL' },
                        { name: 'High', value: 'HIGH' },
                        { name: 'Urgent', value: 'URGENT' }
                    )))

        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List open tickets, sorted by priority (staff only).')),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'panel') {
            if (!hasPermission(interaction.member, PERMISSIONS.BOT_CONFIGURE)) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to deploy the support panel.')],
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });
            const targetChannelId = config.channels.ticketPanel; // 1515395877316071508
            const targetChannel = await getValidatedChannel(interaction.guild, targetChannelId, 'Ticket Panel');

            if (!targetChannel) {
                return interaction.editReply({
                    embeds: [createErrorEmbed('Channel Error', `The configured ticket panel channel (${targetChannelId}) was not found or is inaccessible.`)]
                });
            }

            const panelPayload = TicketService.buildPanel();
            try {
                await targetChannel.send(panelPayload);
            } catch (error) {
                logger.error(`[Tickets] Could not deploy the ticket panel to ${targetChannelId}:`, error);
                return interaction.editReply({
                    embeds: [createErrorEmbed('Panel Deployment Failed', error.message)]
                });
            }

            return interaction.editReply({
                embeds: [createSuccessEmbed('Ticket Panel Deployed', `The NYSRP ticket panel has been successfully sent to the configured ticket panel channel <#${targetChannel.id}>.`)],
            });
        }

        if (subcommand === 'list') {
            if (!hasPermission(interaction.member, PERMISSIONS.TICKET_MANAGE)) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Permission Denied', 'Only authorized NYSRP Staff members can view the open ticket list.')],
                    ephemeral: true
                });
            }

            const tickets = TicketService.listOpenTickets(interaction.guild.id);
            const ticketItems = tickets.map(ticket => {
                const priority = ticket.priority.charAt(0) + ticket.priority.slice(1).toLowerCase();
                return `**${priority} — #${ticket.ticket_id}** <#${ticket.channel_id}> · ${ticket.status.toLowerCase()} · ${ticket.claimed_by ? `claimed by <@${ticket.claimed_by}>` : 'unclaimed'}`;
            });
            const embed = createNYSRPEmbed({
                title: 'Open NYSRP Tickets',
                introduction: tickets.length
                    ? 'Tickets are ordered by urgency, then by oldest creation time.'
                    : 'There are no open tickets right now.',
                sections: tickets.length
                    ? [{ title: `Tickets (${tickets.length})`, items: ticketItems }]
                    : [],
                closing: 'Use `/ticket priority` inside a ticket to update its priority.',
                color: config.branding.color
            });
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        // Channel ticket management commands
        const ticket = TicketService.getTicketByChannel(interaction.channel.id);
        if (!ticket) {
            return interaction.reply({
                embeds: [createErrorEmbed('Invalid Channel', 'This command can only be used inside an active NYSRP ticket channel.')],
                ephemeral: true
            });
        }

        if (['CLOSING', 'CLOSED'].includes(ticket.status) && subcommand !== 'close') {
            return interaction.reply({
                embeds: [createErrorEmbed('Ticket Unavailable', 'Ticket controls are disabled while the ticket is closing or after it has been closed.')],
                ephemeral: true
            });
        }

        if (!hasPermission(interaction.member, PERMISSIONS.TICKET_MANAGE) && interaction.user.id !== ticket.creator_id) {
            return interaction.reply({
                embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to manage this ticket.')],
                ephemeral: true
            });
        }

        if (subcommand === 'close') {
            await interaction.deferReply({ ephemeral: true });
            try {
                const result = await TicketService.closeTicket(interaction.channel, ticket, interaction.member);
                if (result.status === 'already_closed') {
                    return interaction.editReply({
                        embeds: [createErrorEmbed('Ticket Already Closed', 'This ticket has already been closed and its transcript was handled.')]
                    });
                }
                if (result.status === 'already_closing') {
                    return interaction.editReply({
                        embeds: [createErrorEmbed('Ticket Closure In Progress', 'A close operation is already running for this ticket. Please wait for it to finish.')]
                    });
                }
                return interaction.editReply({
                    embeds: [createSuccessEmbed(
                        'Ticket Closed',
                        `The transcript was delivered to the configured archive. Captured **${result.messageCount}** messages in **${result.partCount}** file part(s). The channel will be deleted in 10 seconds.`
                    )]
                });
            } catch (error) {
                logger.error(`[Tickets] Slash-command close failed for ticket #${ticket.ticket_id}:`, error);
                return interaction.editReply({
                    embeds: [createErrorEmbed('Ticket Close Failed', error.message)]
                });
            }
        }

        if (subcommand === 'priority') {
            if (!hasPermission(interaction.member, PERMISSIONS.TICKET_PRIORITY)) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to change ticket priorities.')],
                    ephemeral: true
                });
            }
            try {
                const priority = interaction.options.getString('level', true);
                await interaction.deferReply({ ephemeral: true });
                const result = await TicketService.setPriority(interaction.channel, ticket, priority, interaction.member);
                const label = priority.charAt(0) + priority.slice(1).toLowerCase();
                return interaction.editReply({
                    embeds: [createSuccessEmbed(
                        result.changed ? 'Ticket Priority Updated' : 'Ticket Priority Unchanged',
                        result.changed
                            ? `Ticket #${ticket.ticket_id} is now **${label}** priority.`
                            : `Ticket #${ticket.ticket_id} is already **${label}** priority.`
                    )]
                });
            } catch (error) {
                logger.error(`[Tickets] Priority change failed for ticket #${ticket.ticket_id}:`, error);
                const payload = { embeds: [createErrorEmbed('Priority Change Failed', error.message)] };
                return interaction.deferred
                    ? interaction.editReply(payload)
                    : interaction.reply({ ...payload, ephemeral: true });
            }
        }

        if (subcommand === 'lock') {
            await interaction.deferReply({ ephemeral: true });
            try {
                await TicketService.lockTicket(interaction.channel, ticket, interaction.member);
                return interaction.editReply({
                    embeds: [createSuccessEmbed('Ticket Locked', 'Channel locked successfully.')]
                });
            } catch (error) {
                return interaction.editReply({
                    embeds: [createErrorEmbed('Ticket Lock Failed', error.message)]
                });
            }
        }

        if (subcommand === 'unlock') {
            await interaction.deferReply({ ephemeral: true });
            try {
                await TicketService.unlockTicket(interaction.channel, ticket, interaction.member);
                return interaction.editReply({
                    embeds: [createSuccessEmbed('Ticket Unlocked', 'Channel unlocked successfully.')]
                });
            } catch (error) {
                return interaction.editReply({
                    embeds: [createErrorEmbed('Ticket Unlock Failed', error.message)]
                });
            }
        }

        if (subcommand === 'add') {
            const targetUser = interaction.options.getUser('user');
            await interaction.deferReply({ ephemeral: true });
            try {
                await interaction.channel.permissionOverwrites.edit(targetUser.id, {
                    ViewChannel: true,
                    SendMessages: true,
                    ReadMessageHistory: true
                });
                return interaction.editReply({
                    embeds: [createSuccessEmbed('User Added', `<@${targetUser.id}> has been added to ticket channel <#${interaction.channel.id}>.`)]
                });
            } catch (error) {
                return interaction.editReply({
                    embeds: [createErrorEmbed('User Add Failed', error.message)]
                });
            }
        }

        if (subcommand === 'remove') {
            const targetUser = interaction.options.getUser('user');
            await interaction.deferReply({ ephemeral: true });
            try {
                await interaction.channel.permissionOverwrites.delete(targetUser.id);
                return interaction.editReply({
                    embeds: [createSuccessEmbed('User Removed', `<@${targetUser.id}> has been removed from ticket channel <#${interaction.channel.id}>.`)]
                });
            } catch (error) {
                return interaction.editReply({
                    embeds: [createErrorEmbed('User Remove Failed', error.message)]
                });
            }
        }
    }
};
