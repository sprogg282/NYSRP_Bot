const { SlashCommandBuilder } = require('discord.js');
const { hasPermission } = require('../../utils/permissionCheck');
const { PERMISSIONS } = require('../../config/permissions');
const config = require('../../config');
const TicketService = require('../../services/ticketService');
const { getValidatedChannel } = require('../../utils/channelValidator');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');

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
                .addUserOption(opt => opt.setName('user').setDescription('The user to remove').setRequired(true))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'panel') {
            if (!hasPermission(interaction.member, PERMISSIONS.BOT_CONFIGURE)) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to deploy the support panel.')],
                    ephemeral: true
                });
            }

            const targetChannelId = config.channels.ticketPanel; // 1515395877316071508
            const targetChannel = await getValidatedChannel(interaction.guild, targetChannelId, 'Ticket Panel');

            if (!targetChannel) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Channel Error', `The configured ticket panel channel (${targetChannelId}) was not found or is inaccessible.`)],
                    ephemeral: true
                });
            }

            const panelPayload = TicketService.buildPanel();
            await targetChannel.send(panelPayload);

            return interaction.reply({
                embeds: [createSuccessEmbed('Ticket Panel Deployed', `The NYSRP ticket panel has been successfully sent to the configured ticket panel channel <#${targetChannel.id}>.`)],
                ephemeral: true
            });
        }

        // Channel ticket management commands
        const ticket = TicketService.getTicketByChannel(interaction.channel.id);
        if (!ticket) {
            return interaction.reply({
                embeds: [createErrorEmbed('Invalid Channel', 'This command can only be used inside an active NYSRP ticket channel.')],
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
            await interaction.reply({
                embeds: [createSuccessEmbed('Closing Ticket', 'Initiating ticket closure and transcript generation...')]
            });
            await TicketService.closeTicket(interaction.channel, ticket, interaction.member);
            return;
        }

        if (subcommand === 'lock') {
            await TicketService.lockTicket(interaction.channel, ticket, interaction.member);
            return interaction.reply({
                embeds: [createSuccessEmbed('Ticket Locked', 'Channel locked successfully.')],
                ephemeral: true
            });
        }

        if (subcommand === 'unlock') {
            await TicketService.unlockTicket(interaction.channel, ticket, interaction.member);
            return interaction.reply({
                embeds: [createSuccessEmbed('Ticket Unlocked', 'Channel unlocked successfully.')],
                ephemeral: true
            });
        }

        if (subcommand === 'add') {
            const targetUser = interaction.options.getUser('user');
            await interaction.channel.permissionOverwrites.edit(targetUser.id, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true
            });

            return interaction.reply({
                embeds: [createSuccessEmbed('User Added', `<@${targetUser.id}> has been added to ticket channel <#${interaction.channel.id}>.`)]
            });
        }

        if (subcommand === 'remove') {
            const targetUser = interaction.options.getUser('user');
            await interaction.channel.permissionOverwrites.delete(targetUser.id);

            return interaction.reply({
                embeds: [createSuccessEmbed('User Removed', `<@${targetUser.id}> has been removed from ticket channel <#${interaction.channel.id}>.`)]
            });
        }
    }
};
