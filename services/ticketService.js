const { ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ChannelType } = require('discord.js');
const db = require('../database/db');
const ConfigService = require('./configService');
const FeedbackService = require('./feedbackService');
const config = require('../config');
const { TICKET_CATEGORIES } = require('../config/ticketCategories');
const { createNYSRPEmbed } = require('../utils/embedBuilder');
const { generateTranscript } = require('../utils/transcriptGenerator');
const { getValidatedChannel } = require('../utils/channelValidator');
const { getImage } = require('../utils/imageManager');
const logger = require('../utils/logger');

class TicketService {
    /**
     * Generate Ticket Panel Embed and Component ActionRow
     */
    static buildPanel() {
        const embed = createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝙎𝙪𝙥𝙥𝙤𝙧𝙩',
            introduction: 'Welcome to the NYSRP Support Center. If you require assistance, please create a ticket below.',
            important: 'Please provide accurate and useful information when creating a ticket.',
            sections: [
                {
                    title: 'Ticket Categories',
                    items: TICKET_CATEGORIES.map(cat => `${cat.label}`)
                }
            ],
            closing: 'Please select the appropriate category below.',
            color: config.branding.color // #FD8701
        });
        const supportImage = getImage('support');
        const files = [];
        if (supportImage) {
            embed.setImage(supportImage.url);
            files.push(supportImage.attachment);
        }

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('ticket_create_select')
            .setPlaceholder('Select a ticket category...')
            .addOptions(
                TICKET_CATEGORIES.map(cat => ({
                    label: cat.label,
                    value: cat.id,
                    description: cat.description,
                    emoji: cat.emoji
                }))
            );

        const row = new ActionRowBuilder().addComponents(selectMenu);

        return { embeds: [embed], components: [row], files };
    }

    /**
     * Build ticket channel control buttons
     */
    static buildControlButtons() {
        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
            new ButtonBuilder().setCustomId('ticket_lock').setLabel('Lock').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
            new ButtonBuilder().setCustomId('ticket_unlock').setLabel('Unlock').setStyle(ButtonStyle.Secondary).setEmoji('🔓'),
            new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim').setStyle(ButtonStyle.Primary).setEmoji('👤')
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ticket_add_user').setLabel('Add User').setStyle(ButtonStyle.Secondary).setEmoji('👥'),
            new ButtonBuilder().setCustomId('ticket_remove_user').setLabel('Remove User').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
            new ButtonBuilder().setCustomId('ticket_transcript').setLabel('Transcript').setStyle(ButtonStyle.Secondary).setEmoji('📄'),
            new ButtonBuilder().setCustomId('ticket_delete').setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
        );

        return [row1, row2];
    }

    /**
     * Create a new ticket channel and record in database
     */
    static async createTicket(guild, user, categoryId) {
        const categoryConfig = TICKET_CATEGORIES.find(c => c.id === categoryId) || TICKET_CATEGORIES[0];
        const configData = ConfigService.getConfig(guild.id);

        const timestamp = Date.now();
        const dummyChannelId = `temp_${timestamp}_${user.id}`;
        const dbResult = db.prepare(`
            INSERT INTO tickets (guild_id, channel_id, creator_id, category, status, created_at)
            VALUES (?, ?, ?, ?, 'OPEN', ?)
        `).run(guild.id, dummyChannelId, user.id, categoryConfig.label, timestamp);

        const ticketId = dbResult.lastInsertRowid;
        const channelName = `ticket-${String(ticketId).padStart(4, '0')}`;

        let parentCategory = null;
        if (configData.ticket_category) {
            try {
                parentCategory = await guild.channels.fetch(configData.ticket_category);
            } catch {
                parentCategory = null;
            }
        }

        const permissionOverwrites = [
            {
                id: guild.id,
                deny: [PermissionFlagsBits.ViewChannel]
            },
            {
                id: user.id,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.AttachFiles
                ]
            },
            {
                id: guild.client.user.id,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ManageChannels,
                    PermissionFlagsBits.EmbedLinks,
                    PermissionFlagsBits.AttachFiles,
                    PermissionFlagsBits.ManageMessages
                ]
            }
        ];

        if (configData.rank_roles) {
            for (const roleId of Object.values(configData.rank_roles)) {
                if (roleId && guild.roles.cache.has(roleId)) {
                    permissionOverwrites.push({
                        id: roleId,
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.ReadMessageHistory
                        ]
                    });
                }
            }
        }

        const channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: parentCategory ? parentCategory.id : null,
            permissionOverwrites,
            topic: `NYSRP Ticket #${ticketId} | Creator: ${user.tag} (${user.id}) | Category: ${categoryConfig.label}`
        });

        db.prepare('UPDATE tickets SET channel_id = ? WHERE ticket_id = ?').run(channel.id, ticketId);

        const ticketWelcomeEmbed = createNYSRPEmbed({
            title: `𝙉𝙔𝙎𝙍𝙋 𝙎𝙪𝙥𝙥𝙤𝙧𝙩 𝙏𝙞𝙘𝙠𝙚𝙩 #${ticketId}`,
            introduction: `Welcome <@${user.id}> to **New York State Roleplay** Support. A member of NYSRP Staff will assist you shortly.`,
            important: 'Please describe your request in detail. Do not ping staff members unless necessary.',
            sections: [
                {
                    title: 'Ticket Details',
                    items: [
                        `**Creator:** <@${user.id}>`,
                        `**Category:** ${categoryConfig.label}`,
                        `**Ticket ID:** #${ticketId}`,
                        `**Status:** OPEN`
                    ]
                }
            ],
            closing: 'Use the buttons below to manage or close this ticket.',
            color: config.branding.color // #FD8701
        });
        const supportImage = getImage('support');
        const files = [];
        if (supportImage) {
            ticketWelcomeEmbed.setImage(supportImage.url);
            files.push(supportImage.attachment);
        }

        await channel.send({
            content: `<@${user.id}> | Staff Notification`,
            embeds: [ticketWelcomeEmbed],
            files,
            components: this.buildControlButtons()
        });

        return channel;
    }

    /**
     * Get ticket by channel ID
     */
    static getTicketByChannel(channelId) {
        return db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(channelId);
    }

    /**
     * Claim ticket
     */
    static async claimTicket(channel, staffMember) {
        const ticket = this.getTicketByChannel(channel.id);
        if (!ticket) throw new Error('Ticket not found in database.');

        if (ticket.claimed_by) {
            throw new Error(`This ticket is already claimed by <@${ticket.claimed_by}>.`);
        }

        db.prepare('UPDATE tickets SET claimed_by = ? WHERE ticket_id = ?').run(staffMember.id, ticket.ticket_id);

        const embed = createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝙏𝙞𝙘𝙠𝙚𝙩 𝘾𝙡𝙖𝙞𝙢𝙚𝙙',
            introduction: `This support ticket has been claimed by <@${staffMember.id}>.`,
            sections: [
                {
                    title: 'Staff Handler',
                    items: [
                        `**Claimed By:** <@${staffMember.id}> (${staffMember.user.tag})`,
                        `**Ticket ID:** #${ticket.ticket_id}`
                    ]
                }
            ],
            closing: 'They will be handling your request from this point forward.',
            color: config.branding.color // #FD8701
        });

        await channel.send({ embeds: [embed] });
    }

    /**
     * Lock ticket
     */
    static async lockTicket(channel, ticket, staffMember) {
        await channel.permissionOverwrites.edit(ticket.creator_id, {
            SendMessages: false
        });
        db.prepare("UPDATE tickets SET status = 'LOCKED' WHERE ticket_id = ?").run(ticket.ticket_id);

        const embed = createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝙏𝙞𝙘𝙠𝙚𝙩 𝙇𝙤𝙘𝙠𝙚𝙙',
            introduction: 'This ticket channel has been locked by NYSRP Staff.',
            important: 'The ticket creator can no longer send messages in this channel.',
            closing: 'Staff may unlock the ticket using the Unlock button.',
            color: config.branding.color // #FD8701
        });

        await channel.send({ embeds: [embed] });
    }

    /**
     * Unlock ticket
     */
    static async unlockTicket(channel, ticket, staffMember) {
        await channel.permissionOverwrites.edit(ticket.creator_id, {
            SendMessages: true
        });
        db.prepare("UPDATE tickets SET status = 'OPEN' WHERE ticket_id = ?").run(ticket.ticket_id);

        const embed = createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝙏𝙞𝙘𝙠𝙚𝙩 𝙐𝙣𝙡𝙤𝙘𝙠𝙚𝙙',
            introduction: 'This ticket channel has been unlocked by NYSRP Staff.',
            closing: 'Messaging permissions have been restored for the ticket creator.',
            color: config.branding.color // #FD8701
        });

        await channel.send({ embeds: [embed] });
    }

    /**
     * Close ticket, send transcript, and prompt creator for DM rating feedback
     */
    static async closeTicket(channel, ticket, staffMember) {
        const closedAt = Date.now();
        db.prepare("UPDATE tickets SET status = 'CLOSED', closed_at = ?, closed_by = ? WHERE ticket_id = ?")
            .run(closedAt, staffMember.id, ticket.ticket_id);

        // 1. Generate Transcript
        const { attachment } = await generateTranscript(channel, {
            ...ticket,
            closed_by: staffMember.user ? staffMember.user.tag : staffMember.id
        });

        const configData = ConfigService.getConfig(channel.guild.id);
        const transcriptChannelId = configData.transcript_channel || config.channels.ticketTranscripts;

        // 2. Validate and send to Transcript Channel (1515410320997486662)
        const transcriptChannel = await getValidatedChannel(channel.guild, transcriptChannelId, 'Ticket Transcript');
        if (transcriptChannel) {
            try {
                const transcriptEmbed = createNYSRPEmbed({
                    title: '𝙉𝙔𝙎𝙍𝙋 𝙏𝙞𝙘𝙠𝙚𝙩 𝙏𝙧𝙖𝙣𝙨𝙘𝙧𝙞𝙥𝙩',
                    introduction: `A support ticket transcript has been completed and archived.`,
                    sections: [
                        {
                            title: 'Transcript Overview',
                            items: [
                                `**Ticket ID:** #${ticket.ticket_id}`,
                                `**Creator:** <@${ticket.creator_id}> (\`${ticket.creator_id}\`)`,
                                `**Category:** ${ticket.category}`,
                                `**Claimed By:** ${ticket.claimed_by ? `<@${ticket.claimed_by}>` : 'Unclaimed'}`,
                                `**Closed By:** <@${staffMember.id}> (\`${staffMember.id}\`)`,
                                `**Closed Date:** <t:${Math.floor(closedAt / 1000)}:F>`
                            ]
                        }
                    ],
                    closing: 'The complete message log file is attached below.',
                    color: config.branding.color // #FD8701
                });

                await transcriptChannel.send({ embeds: [transcriptEmbed], files: [attachment] });
            } catch (err) {
                logger.warn(`Could not send transcript to channel ${transcriptChannelId}: ${err.message}`);
            }
        }

        // 3. DM Ticket Creator Feedback Prompt
        try {
            const creatorUser = await channel.guild.client.users.fetch(ticket.creator_id);
            if (creatorUser) {
                await FeedbackService.sendFeedbackPrompt(creatorUser, ticket, channel.guild);
            }
        } catch (err) {
            logger.warn(`Could not fetch creator user ${ticket.creator_id} for feedback DM: ${err.message}`);
        }

        const closeEmbed = createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝙏𝙞𝙘𝙠𝙚𝙩 𝘾𝙡𝙤𝙨𝙚𝙙',
            introduction: `This ticket has been closed by <@${staffMember.id}>.`,
            important: 'This channel will automatically be deleted in 10 seconds.',
            closing: 'Thank you for contacting New York State Roleplay Support.',
            color: config.branding.color // #FD8701
        });

        await channel.send({ embeds: [closeEmbed] });

        setTimeout(async () => {
            try {
                await channel.delete('NYSRP Ticket Closed');
            } catch (err) {
                logger.warn(`Failed deleting ticket channel ${channel.id}: ${err.message}`);
            }
        }, 10000);
    }
}

module.exports = TicketService;
