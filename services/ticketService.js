const { ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ChannelType } = require('discord.js');
const crypto = require('crypto');
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

const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const TRANSCRIPT_BATCH_SIZE = 10;
const activeTicketOperations = new Set();

function parseMessageIds(value) {
    try {
        const ids = JSON.parse(value || '[]');
        return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [];
    } catch (error) {
        logger.error('[Tickets] Invalid stored transcript message IDs.', error);
        return [];
    }
}

function priorityLabel(priority) {
    return priority.charAt(0) + priority.slice(1).toLowerCase();
}

async function withTicketOperation(ticketId, operation) {
    if (activeTicketOperations.has(ticketId)) {
        throw new Error('Another ticket operation is already in progress. Please wait and try again.');
    }

    activeTicketOperations.add(ticketId);
    try {
        return await operation();
    } finally {
        activeTicketOperations.delete(ticketId);
    }
}

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
        const placeholderChannelId = `temp_${crypto.randomUUID()}`;
        const dbResult = db.prepare(`
            INSERT INTO tickets (guild_id, channel_id, creator_id, category, status, created_at)
            VALUES (?, ?, ?, ?, 'OPEN', ?)
        `).run(guild.id, placeholderChannelId, user.id, categoryConfig.label, timestamp);

        const ticketId = dbResult.lastInsertRowid;
        const channelName = `ticket-${String(ticketId).padStart(4, '0')}`;
        let channel = null;

        try {
            let parentCategory = null;
            if (configData.ticket_category) {
                try {
                    parentCategory = await guild.channels.fetch(configData.ticket_category);
                } catch (error) {
                    logger.warn(`[Tickets] Could not fetch configured ticket category ${configData.ticket_category}: ${error.message}`);
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

            channel = await guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                parent: parentCategory ? parentCategory.id : null,
                permissionOverwrites,
                topic: `NYSRP Ticket #${ticketId} | Creator: ${user.tag} (${user.id}) | Category: ${categoryConfig.label} | Priority: NORMAL`
            });

            const channelUpdate = db.prepare('UPDATE tickets SET channel_id = ? WHERE ticket_id = ?')
                .run(channel.id, ticketId);
            if (channelUpdate.changes !== 1) {
                throw new Error(`Could not associate ticket #${ticketId} with its Discord channel.`);
            }

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
                            '**Status:** OPEN',
                            '**Priority:** Normal'
                        ]
                    }
                ],
                closing: 'Use the buttons below to manage or close this ticket.',
                color: config.branding.color
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
        } catch (error) {
            if (!channel) {
                db.prepare('DELETE FROM tickets WHERE ticket_id = ?').run(ticketId);
                throw error;
            }

            try {
                await channel.delete('Ticket setup failed');
            } catch (cleanupError) {
                logger.error(`[Tickets] Could not remove partially-created ticket channel ${channel.id}:`, cleanupError);
                try {
                    db.prepare(`
                        UPDATE tickets
                        SET channel_id = ?, status = 'OPEN'
                        WHERE ticket_id = ?
                    `).run(channel.id, ticketId);
                } catch (databaseError) {
                    logger.error(`[Tickets] Could not retain a recovery record for ticket channel ${channel.id}:`, databaseError);
                }
                throw new Error(`Ticket setup failed, and the created channel could not be removed. Staff can recover it in <#${channel.id}>. ${error.message}`);
            }

            try {
                db.prepare('DELETE FROM tickets WHERE ticket_id = ?').run(ticketId);
            } catch (databaseError) {
                logger.error(`[Tickets] Could not remove database row for deleted partial ticket #${ticketId}:`, databaseError);
            }

            throw error;
        }
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

        const result = db.prepare(`
            UPDATE tickets
            SET claimed_by = ?
            WHERE ticket_id = ? AND claimed_by IS NULL AND status IN ('OPEN', 'LOCKED')
        `).run(staffMember.id, ticket.ticket_id);

        if (result.changes !== 1) {
            const latestTicket = db.prepare('SELECT * FROM tickets WHERE ticket_id = ?').get(ticket.ticket_id);
            if (latestTicket?.claimed_by) {
                throw new Error(`This ticket is already claimed by <@${latestTicket.claimed_by}>.`);
            }
            throw new Error('This ticket is no longer available to claim.');
        }

        const embed = createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝙏𝙞𝙘𝙠𝙚𝙩 𝘾𝙡𝙖𝙞𝙢𝙚𝙙',
            introduction: `This support ticket has been claimed by <@${staffMember.id}>.`,
            sections: [
                {
                    title: 'Staff Handler',
                    items: [
                        `**Claimed By:** <@${staffMember.id}> (${staffMember.user.tag})`,
                        `**Ticket ID:** #${ticket.ticket_id}`,
                        `**Priority:** ${priorityLabel(ticket.priority || 'NORMAL')}`
                    ]
                }
            ],
            closing: 'They will be handling your request from this point forward.',
            color: config.branding.color // #FD8701
        });

        try {
            await channel.send({ embeds: [embed] });
        } catch (error) {
            db.prepare('UPDATE tickets SET claimed_by = NULL WHERE ticket_id = ? AND claimed_by = ?')
                .run(ticket.ticket_id, staffMember.id);
            throw error;
        }
    }

    /**
     * Lock ticket
     */
    static async lockTicket(channel, ticket, staffMember) {
        return withTicketOperation(ticket.ticket_id, async () => {
            return this.performLockTicket(channel, ticket, staffMember);
        });
    }

    static async performLockTicket(channel, ticket, staffMember) {
        const result = db.prepare(`
            UPDATE tickets
            SET status = 'LOCKED'
            WHERE ticket_id = ? AND status = 'OPEN'
        `).run(ticket.ticket_id);
        if (result.changes !== 1) {
            throw new Error('Only an open ticket can be locked.');
        }

        try {
            await channel.permissionOverwrites.edit(ticket.creator_id, { SendMessages: false });
        } catch (error) {
            db.prepare("UPDATE tickets SET status = 'OPEN' WHERE ticket_id = ? AND status = 'LOCKED'")
                .run(ticket.ticket_id);
            try {
                await channel.permissionOverwrites.edit(ticket.creator_id, { SendMessages: true });
            } catch (restoreError) {
                logger.error(`[Tickets] Could not restore creator messaging after failed lock for ticket #${ticket.ticket_id}:`, restoreError);
            }
            throw error;
        }

        const embed = createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝙏𝙞𝙘𝙠𝙚𝙩 𝙇𝙤𝙘𝙠𝙚𝙙',
            introduction: 'This ticket channel has been locked by NYSRP Staff.',
            important: 'The ticket creator can no longer send messages in this channel.',
            closing: 'Staff may unlock the ticket using the Unlock button.',
            color: config.branding.color // #FD8701
        });

        try {
            await channel.send({ embeds: [embed] });
        } catch (error) {
            logger.warn(`[Tickets] Ticket #${ticket.ticket_id} was locked, but its announcement failed: ${error.message}`);
        }
    }

    /**
     * Unlock ticket
     */
    static async unlockTicket(channel, ticket, staffMember) {
        return withTicketOperation(ticket.ticket_id, async () => {
            return this.performUnlockTicket(channel, ticket, staffMember);
        });
    }

    static async performUnlockTicket(channel, ticket, staffMember) {
        const result = db.prepare(`
            UPDATE tickets
            SET status = 'OPEN'
            WHERE ticket_id = ? AND status = 'LOCKED'
        `).run(ticket.ticket_id);
        if (result.changes !== 1) {
            throw new Error('Only a locked ticket can be unlocked.');
        }

        try {
            await channel.permissionOverwrites.edit(ticket.creator_id, { SendMessages: true });
        } catch (error) {
            db.prepare("UPDATE tickets SET status = 'LOCKED' WHERE ticket_id = ? AND status = 'OPEN'")
                .run(ticket.ticket_id);
            try {
                await channel.permissionOverwrites.edit(ticket.creator_id, { SendMessages: false });
            } catch (restoreError) {
                logger.error(`[Tickets] Could not restore locked permissions after failed unlock for ticket #${ticket.ticket_id}:`, restoreError);
            }
            throw error;
        }

        const embed = createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝙏𝙞𝙘𝙠𝙚𝙩 𝙐𝙣𝙡𝙤𝙘𝙠𝙚𝙙',
            introduction: 'This ticket channel has been unlocked by NYSRP Staff.',
            closing: 'Messaging permissions have been restored for the ticket creator.',
            color: config.branding.color // #FD8701
        });

        try {
            await channel.send({ embeds: [embed] });
        } catch (error) {
            logger.warn(`[Tickets] Ticket #${ticket.ticket_id} was unlocked, but its announcement failed: ${error.message}`);
        }
    }

    /**
     * Close ticket, send transcript, and prompt creator for DM rating feedback
     */
    static async closeTicket(channel, ticket, staffMember) {
        return withTicketOperation(ticket.ticket_id, async () => {
            return this.performCloseTicket(channel, ticket, staffMember);
        });
    }

    static async performCloseTicket(channel, ticket, staffMember) {
        const latestTicket = db.prepare('SELECT * FROM tickets WHERE ticket_id = ?').get(ticket.ticket_id);
        if (!latestTicket) throw new Error('Ticket not found in database.');
        if (latestTicket.status === 'CLOSED') return { status: 'already_closed' };
        if (latestTicket.status === 'CLOSING') return { status: 'already_closing' };
        if (!['OPEN', 'LOCKED'].includes(latestTicket.status)) {
            throw new Error(`Ticket cannot be closed while its status is ${latestTicket.status}.`);
        }

        const previousStatus = latestTicket.status;
        const closingStartedAt = Date.now();
        let deliveryNonce = latestTicket.transcript_delivery_nonce || crypto.randomBytes(10).toString('hex');
        const started = db.prepare(`
            UPDATE tickets
            SET status = 'CLOSING',
                close_previous_status = ?,
                closing_started_at = ?,
                closed_by = ?,
                closed_at = NULL,
                transcript_part_count = 0,
                transcript_delivered_at = NULL,
                transcript_delivery_nonce = COALESCE(transcript_delivery_nonce, ?)
            WHERE ticket_id = ? AND status = ?
        `).run(previousStatus, closingStartedAt, staffMember.id, deliveryNonce, ticket.ticket_id, previousStatus);

        if (started.changes !== 1) {
            return { status: 'already_closing' };
        }

        let transcriptChannel = null;
        const creatorLockAttempted = previousStatus === 'OPEN';
        let pendingMessageIds = parseMessageIds(latestTicket.transcript_message_ids);
        let expectedPartCount = 0;
        let transcript = null;
        let messageSent = false;
        let transcriptDeliveredAt = null;
        const transcriptChannelId = ConfigService.getConfig(channel.guild.id).transcript_channel
            || config.channels.ticketTranscripts;

        try {
            if (creatorLockAttempted) {
                await channel.permissionOverwrites.edit(latestTicket.creator_id, { SendMessages: false });
            }

            transcriptChannel = await getValidatedChannel(
                channel.guild,
                transcriptChannelId,
                'Ticket Transcript'
            );
            if (!transcriptChannel) {
                throw new Error(`Transcript channel ${transcriptChannelId} is missing or the bot cannot send messages there.`);
            }

            for (const messageId of [...pendingMessageIds]) {
                await this.deleteTranscriptMessage(transcriptChannel, messageId);
                pendingMessageIds = pendingMessageIds.filter(id => id !== messageId);
                this.saveTranscriptProgress(ticket.ticket_id, pendingMessageIds, 0, null);
            }
            if (latestTicket.transcript_message_ids && parseMessageIds(latestTicket.transcript_message_ids).length > 0) {
                deliveryNonce = crypto.randomBytes(10).toString('hex');
                db.prepare(`
                    UPDATE tickets SET transcript_delivery_nonce = ?
                    WHERE ticket_id = ? AND status = 'CLOSING'
                `).run(deliveryNonce, ticket.ticket_id);
            }

            transcript = await generateTranscript(channel, {
                ...latestTicket,
                closed_at: Date.now(),
                closed_by: staffMember.user?.tag || staffMember.id,
                closed_by_id: staffMember.id
            });
            expectedPartCount = Math.ceil(transcript.attachments.length / TRANSCRIPT_BATCH_SIZE);
            db.prepare(`
                UPDATE tickets
                SET transcript_part_count = ?
                WHERE ticket_id = ? AND status = 'CLOSING'
            `).run(expectedPartCount, ticket.ticket_id);

            for (let offset = 0; offset < transcript.attachments.length; offset += TRANSCRIPT_BATCH_SIZE) {
                const batch = transcript.attachments.slice(offset, offset + TRANSCRIPT_BATCH_SIZE);
                const batchNumber = Math.floor(offset / TRANSCRIPT_BATCH_SIZE) + 1;
                const embed = createNYSRPEmbed({
                    title: '𝙉𝙔𝙎𝙍𝙋 𝙏𝙞𝙘𝙠𝙚𝙩 𝙏𝙧𝙖𝙣𝙨𝙘𝙧𝙞𝙥𝙩',
                    introduction: 'A ticket transcript has been archived.',
                    sections: [
                        {
                            title: 'Transcript Overview',
                            items: [
                                `**Ticket ID:** #${ticket.ticket_id}`,
                                `**Creator:** <@${latestTicket.creator_id}> (\`${latestTicket.creator_id}\`)`,
                                `**Category:** ${latestTicket.category}`,
                                `**Priority:** ${priorityLabel(latestTicket.priority || 'NORMAL')}`,
                                `**Claimed By:** ${latestTicket.claimed_by ? `<@${latestTicket.claimed_by}>` : 'Unclaimed'}`,
                                `**Closed By:** <@${staffMember.id}> (\`${staffMember.id}\`)`,
                                `**Messages Captured:** ${transcript.messageCount}`,
                                `**Upload Batch:** ${batchNumber} / ${expectedPartCount}`
                            ]
                        }
                    ],
                    closing: 'All available channel history is included in the attached HTML transcript part(s).',
                    color: config.branding.color
                });
                const message = await transcriptChannel.send({
                    embeds: [embed],
                    files: batch,
                    allowedMentions: { parse: [] },
                    nonce: crypto.createHash('sha256')
                        .update(`nysrp-${deliveryNonce}-${batchNumber}`)
                        .digest('hex')
                        .slice(0, 24),
                    enforceNonce: true
                });
                messageSent = true;
                pendingMessageIds.push(message.id);
                this.saveTranscriptProgress(ticket.ticket_id, pendingMessageIds, expectedPartCount, null);
            }

            transcriptDeliveredAt = Date.now();
            const finalized = db.prepare(`
                UPDATE tickets
                SET status = 'CLOSED',
                    closed_at = ?,
                    closed_by = ?,
                    close_previous_status = NULL,
                    closing_started_at = NULL,
                    transcript_delivered_at = ?,
                    transcript_delivery_nonce = NULL
                WHERE ticket_id = ?
                    AND status = 'CLOSING'
                    AND transcript_part_count = ?
                    AND transcript_message_ids = ?
            `).run(
                transcriptDeliveredAt,
                staffMember.id,
                transcriptDeliveredAt,
                ticket.ticket_id,
                expectedPartCount,
                JSON.stringify(pendingMessageIds)
            );
            if (finalized.changes !== 1) {
                throw new Error('Transcript delivery completed, but the ticket could not be marked closed in the database.');
            }
        } catch (error) {
            if (transcriptChannel) {
                for (const messageId of [...pendingMessageIds]) {
                    try {
                        await this.deleteTranscriptMessage(transcriptChannel, messageId);
                        pendingMessageIds = pendingMessageIds.filter(id => id !== messageId);
                    } catch (cleanupError) {
                        logger.error(`[Tickets] Could not remove partial transcript message ${messageId} for ticket #${ticket.ticket_id}:`, cleanupError);
                    }
                }
            }

            db.prepare(`
                UPDATE tickets
                SET status = COALESCE(close_previous_status, 'OPEN'),
                    close_previous_status = NULL,
                    closing_started_at = NULL,
                    transcript_message_ids = ?,
                    transcript_part_count = ?,
                    transcript_delivered_at = NULL,
                    transcript_delivery_nonce = CASE WHEN ? = 1 THEN NULL ELSE transcript_delivery_nonce END
                WHERE ticket_id = ? AND status = 'CLOSING'
            `).run(JSON.stringify(pendingMessageIds), expectedPartCount, messageSent ? 1 : 0, ticket.ticket_id);

            if (creatorLockAttempted) {
                try {
                    await channel.permissionOverwrites.edit(latestTicket.creator_id, { SendMessages: true });
                } catch (permissionError) {
                    logger.error(`[Tickets] Could not restore creator messaging after failed close for ticket #${ticket.ticket_id}:`, permissionError);
                }
            }

            logger.error(`[Tickets] Could not close ticket #${ticket.ticket_id}; its channel remains available.`, error);
            throw new Error(
                pendingMessageIds.length > 0
                    ? `Transcript delivery was incomplete. The ticket remains open; staff should retry after checking the transcript archive. ${error.message}`
                    : `Transcript generation or delivery failed. The ticket remains open and can be retried. ${error.message}`
            );
        }

        const closedTicket = {
            ...latestTicket,
            status: 'CLOSED',
            closed_at: Date.now(),
            closed_by: staffMember.id,
            transcript_message_ids: JSON.stringify(pendingMessageIds),
            transcript_part_count: expectedPartCount,
            transcript_delivered_at: transcriptDeliveredAt
        };

        try {
            const creatorUser = await channel.guild.client.users.fetch(ticket.creator_id);
            if (creatorUser) {
                await FeedbackService.sendFeedbackPrompt(creatorUser, closedTicket, channel.guild);
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

        try {
            await channel.send({ embeds: [closeEmbed] });
        } catch (error) {
            logger.warn(`[Tickets] Transcript was delivered for ticket #${ticket.ticket_id}, but the close announcement failed: ${error.message}`);
        }

        this.scheduleChannelDeletion(channel);
        return {
            status: 'closed',
            messageCount: transcript.messageCount,
            partCount: transcript.partCount,
            archiveMessageIds: pendingMessageIds
        };
    }

    static saveTranscriptProgress(ticketId, messageIds, partCount, deliveredAt) {
        db.prepare(`
            UPDATE tickets
            SET transcript_message_ids = ?,
                transcript_part_count = ?,
                transcript_delivered_at = ?
            WHERE ticket_id = ? AND status = 'CLOSING'
        `).run(JSON.stringify(messageIds), partCount, deliveredAt, ticketId);
    }

    static async deleteTranscriptMessage(transcriptChannel, messageId) {
        try {
            const message = await transcriptChannel.messages.fetch(messageId);
            await message.delete('Remove incomplete NYSRP ticket transcript');
        } catch (error) {
            if (error.code === 10008 || error.code === 10003) return;
            throw error;
        }
    }

    static scheduleChannelDeletion(channel) {
        const timer = setTimeout(async () => {
            try {
                await channel.delete('NYSRP Ticket Closed');
            } catch (err) {
                logger.warn(`Failed deleting ticket channel ${channel.id}: ${err.message}`);
            }
        }, 10000);
        timer.unref?.();
    }

    static async recoverInterruptedClosures(client) {
        const pending = db.prepare("SELECT * FROM tickets WHERE status = 'CLOSING'").all();
        for (const ticket of pending) {
            const messageIds = parseMessageIds(ticket.transcript_message_ids);
            const transcriptDelivered = ticket.transcript_part_count > 0
                && messageIds.length >= ticket.transcript_part_count;
            let archiveVerified = false;

            if (transcriptDelivered) {
                try {
                    const guild = await client.guilds.fetch(ticket.guild_id);
                    const configData = ConfigService.getConfig(ticket.guild_id);
                    const archive = await getValidatedChannel(
                        guild,
                        configData.transcript_channel || config.channels.ticketTranscripts,
                        'Ticket Transcript Recovery'
                    );
                    if (!archive) {
                        throw new Error('Transcript archive is not currently accessible.');
                    }
                    for (const messageId of messageIds.slice(0, ticket.transcript_part_count)) {
                        await archive.messages.fetch(messageId);
                    }
                    archiveVerified = true;
                } catch (error) {
                    logger.warn(`[Tickets] Could not verify transcript archive for interrupted ticket #${ticket.ticket_id}: ${error.message}`);
                }
            }

            if (transcriptDelivered && archiveVerified) {
                const closedAt = ticket.transcript_delivered_at || ticket.closing_started_at || Date.now();
                db.prepare(`
                    UPDATE tickets
                    SET status = 'CLOSED',
                        closed_at = ?,
                        close_previous_status = NULL,
                        closing_started_at = NULL,
                        transcript_delivery_nonce = NULL,
                        transcript_delivered_at = COALESCE(transcript_delivered_at, ?)
                    WHERE ticket_id = ? AND status = 'CLOSING'
                `).run(closedAt, closedAt, ticket.ticket_id);
                logger.warn(`[Tickets] Recovered completed transcript delivery for ticket #${ticket.ticket_id}.`);

                try {
                    const channel = await client.channels.fetch(ticket.channel_id);
                    if (channel) this.scheduleChannelDeletion(channel);
                } catch (error) {
                    logger.warn(`[Tickets] Could not schedule cleanup for recovered closed ticket #${ticket.ticket_id}: ${error.message}`);
                }
                continue;
            }

            const restoredStatus = ticket.close_previous_status === 'LOCKED' ? 'LOCKED' : 'OPEN';
            db.prepare(`
                UPDATE tickets
                SET status = ?,
                    close_previous_status = NULL,
                    closing_started_at = NULL,
                    transcript_delivered_at = NULL
                WHERE ticket_id = ? AND status = 'CLOSING'
            `).run(restoredStatus, ticket.ticket_id);
            logger.warn(`[Tickets] Restored ticket #${ticket.ticket_id} to ${restoredStatus} after an interrupted transcript attempt.`);
        }
    }

    static async setPriority(channel, ticket, priority, staffMember) {
        const normalizedPriority = String(priority).toUpperCase();
        if (!TICKET_PRIORITIES.includes(normalizedPriority)) {
            throw new Error('Choose Low, Normal, High, or Urgent.');
        }

        const updatePriority = db.transaction(() => {
            const current = db.prepare('SELECT * FROM tickets WHERE ticket_id = ?').get(ticket.ticket_id);
            if (!current || !['OPEN', 'LOCKED'].includes(current.status)) {
                throw new Error('Priority can only be changed on an open or locked ticket.');
            }
            if (current.priority === normalizedPriority) {
                return { changed: false, ticket: current };
            }

            db.prepare('UPDATE tickets SET priority = ? WHERE ticket_id = ?')
                .run(normalizedPriority, ticket.ticket_id);
            db.prepare(`
                INSERT INTO ticket_priority_history (
                    ticket_id, guild_id, changed_by, previous_priority, new_priority, changed_at
                ) VALUES (?, ?, ?, ?, ?, ?)
            `).run(
                ticket.ticket_id,
                current.guild_id,
                staffMember.id,
                current.priority,
                normalizedPriority,
                Date.now()
            );
            return {
                changed: true,
                previousPriority: current.priority,
                ticket: { ...current, priority: normalizedPriority }
            };
        });

        const result = updatePriority();
        if (!result.changed) {
            return { ...result, priority: normalizedPriority };
        }

        const embed = createNYSRPEmbed({
            title: 'NYSRP Ticket Priority Updated',
            introduction: `Ticket #${ticket.ticket_id} priority changed from **${priorityLabel(result.previousPriority)}** to **${priorityLabel(normalizedPriority)}**.`,
            sections: [
                {
                    title: 'Change Details',
                    items: [
                        `**Changed By:** <@${staffMember.id}>`,
                        `**Ticket:** <#${channel.id}>`
                    ]
                }
            ],
            color: config.branding.color
        });
        logger.info(`[Tickets] Ticket #${ticket.ticket_id} priority changed to ${normalizedPriority} by ${staffMember.id}.`);

        try {
            await channel.setTopic(
                `NYSRP Ticket #${ticket.ticket_id} | Creator: ${ticket.creator_id} | Category: ${ticket.category} | Priority: ${normalizedPriority}`
            );
        } catch (error) {
            logger.warn(`[Tickets] Could not update channel topic for priority change on ticket #${ticket.ticket_id}: ${error.message}`);
        }
        try {
            await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        } catch (error) {
            logger.warn(`[Tickets] Priority change was saved, but the channel announcement failed for ticket #${ticket.ticket_id}: ${error.message}`);
        }

        const configData = ConfigService.getConfig(ticket.guild_id);
        const staffLogChannel = await getValidatedChannel(
            channel.guild,
            configData.staff_log_channel || config.channels.staffActions,
            'Ticket Priority Audit'
        );
        if (staffLogChannel) {
            try {
                await staffLogChannel.send({ embeds: [embed], allowedMentions: { parse: [] } });
            } catch (error) {
                logger.warn(`[Tickets] Could not send priority audit for ticket #${ticket.ticket_id}: ${error.message}`);
            }
        }

        return { ...result, priority: normalizedPriority };
    }

    static listOpenTickets(guildId, limit = 10) {
        return db.prepare(`
            SELECT ticket_id, channel_id, creator_id, category, status, claimed_by, created_at, priority
            FROM tickets
            WHERE guild_id = ? AND status IN ('OPEN', 'LOCKED', 'CLOSING')
            ORDER BY
                CASE priority
                    WHEN 'URGENT' THEN 0
                    WHEN 'HIGH' THEN 1
                    WHEN 'NORMAL' THEN 2
                    ELSE 3
                END,
                created_at ASC
            LIMIT ?
        `).all(guildId, limit);
    }
}

module.exports = TicketService;
