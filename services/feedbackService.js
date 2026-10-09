const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const db = require('../database/db');
const config = require('../config');
const { createNYSRPEmbed } = require('../utils/embedBuilder');
const { getValidatedChannel } = require('../utils/channelValidator');
const logger = require('../utils/logger');

class FeedbackService {
    /**
     * Check if feedback has already been submitted for a ticket
     */
    static hasSubmittedFeedback(ticketId) {
        const row = db.prepare('SELECT feedback_id FROM ticket_feedback WHERE ticket_id = ?').get(ticketId);
        return Boolean(row);
    }

    /**
     * Send DM feedback prompt to ticket creator upon closure
     */
    static async sendFeedbackPrompt(user, ticket, guild) {
        if (!user || this.hasSubmittedFeedback(ticket.ticket_id)) return;

        const starsButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`feedback_rating_${ticket.ticket_id}_1`).setLabel('1').setStyle(ButtonStyle.Danger).setEmoji('⭐'),
            new ButtonBuilder().setCustomId(`feedback_rating_${ticket.ticket_id}_2`).setLabel('2').setStyle(ButtonStyle.Secondary).setEmoji('⭐'),
            new ButtonBuilder().setCustomId(`feedback_rating_${ticket.ticket_id}_3`).setLabel('3').setStyle(ButtonStyle.Secondary).setEmoji('⭐'),
            new ButtonBuilder().setCustomId(`feedback_rating_${ticket.ticket_id}_4`).setLabel('4').setStyle(ButtonStyle.Primary).setEmoji('⭐'),
            new ButtonBuilder().setCustomId(`feedback_rating_${ticket.ticket_id}_5`).setLabel('5').setStyle(ButtonStyle.Success).setEmoji('⭐')
        );

        const promptEmbed = createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝙎𝙪𝙥𝙥𝙤𝙧𝙩 𝙁𝙚𝙚𝙙𝙗𝙖𝙘𝙠',
            introduction: `Thank you for contacting **New York State Roleplay** Support. Your ticket **#${ticket.ticket_id}** has been closed.`,
            important: 'Please take a moment to rate the assistance you received from our staff team.',
            sections: [
                {
                    title: 'Feedback Options',
                    items: [
                        'Click a star rating button below (1 to 5 stars).',
                        'You will have the option to leave a comment after selecting a rating.'
                    ]
                }
            ],
            closing: 'Your feedback helps us continuously improve our community management.',
            color: config.branding.color // #FD8701
        });

        try {
            await user.send({ embeds: [promptEmbed], components: [starsButtons] });
        } catch {
            // User DM closed
            logger.warn(`Could not send feedback DM to user ${user.id} for ticket #${ticket.ticket_id}.`);
        }
    }

    /**
     * Build optional comment modal
     */
    static buildCommentModal(ticketId, stars) {
        const modal = new ModalBuilder()
            .setCustomId(`feedback_modal_${ticketId}_${stars}`)
            .setTitle('NYSRP Support Feedback');

        const commentInput = new TextInputBuilder()
            .setCustomId('feedback_comment_text')
            .setLabel('Optional Comment / Details')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Enter your feedback comment here (optional)...')
            .setRequired(false)
            .setMaxLength(1000);

        const row = new ActionRowBuilder().addComponents(commentInput);
        modal.addComponents(row);

        return modal;
    }

    /**
     * Process feedback submission (saves DB record, broadcasts to log channel 1515395906764148892, sends user confirmation)
     */
    static async saveAndBroadcastFeedback({ guildClient, ticketId, creatorUser, stars, comment = null }) {
        if (this.hasSubmittedFeedback(ticketId)) {
            return;
        }

        const ticket = db.prepare('SELECT * FROM tickets WHERE ticket_id = ?').get(ticketId);
        const timestamp = Date.now();
        const guildId = ticket ? ticket.guild_id : config.guildId;
        const claimedBy = ticket ? ticket.claimed_by : null;

        // 1. Save to SQLite database
        db.prepare(`
            INSERT INTO ticket_feedback (ticket_id, guild_id, creator_id, claimed_by, rating, comment, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(ticketId, guildId, creatorUser.id, claimedBy, stars, comment || null, timestamp);

        const starsDisplay = `${'⭐'.repeat(stars)} (${stars}/5)`;
        const dateString = `<t:${Math.floor(timestamp / 1000)}:F>`;

        // 2. Broadcast to Feedback Channel (1515395906764148892)
        const feedbackChannelId = config.channels.ticketFeedback;
        let guild = null;
        try {
            guild = await guildClient.guilds.fetch(guildId);
        } catch {
            guild = guildClient.guilds.cache.first();
        }

        if (guild) {
            const feedbackChannel = await getValidatedChannel(guild, feedbackChannelId, 'Ticket Feedback');
            if (feedbackChannel) {
                const logEmbed = createNYSRPEmbed({
                    title: '𝙉𝙔𝙎𝙍𝙋 𝙏𝙞𝙘𝙠𝙚𝙩 𝙁𝙚𝙚𝙙𝙗𝙖𝙘𝙠 𝙍𝙚𝙘𝙚𝙞𝙫𝙚𝙙',
                    introduction: 'A member has submitted feedback for a support ticket.',
                    sections: [
                        {
                            title: 'Feedback Details',
                            items: [
                                `**Ticket ID:** #${ticketId}`,
                                `**Creator:** <@${creatorUser.id}> (\`${creatorUser.id}\`)`,
                                `**Rating:** ${starsDisplay}`,
                                `**Comment:** ${comment && comment.trim() ? comment.trim() : '*No comment provided*'}`,
                                `**Category:** ${ticket ? ticket.category : 'Support'}`,
                                `**Claimed By:** ${claimedBy ? `<@${claimedBy}>` : 'Unclaimed'}`,
                                `**Closed By:** ${ticket && ticket.closed_by ? `<@${ticket.closed_by}>` : 'Staff'}`,
                                `**Submission Time:** ${dateString}`
                            ]
                        }
                    ],
                    closing: 'Logged by NYSRP Support Feedback System.',
                    color: config.branding.color // #FD8701
                });

                try {
                    await feedbackChannel.send({ embeds: [logEmbed] });
                } catch (err) {
                    logger.warn(`Could not send feedback log to ${feedbackChannelId}: ${err.message}`);
                }
            }
        }

        // 3. DM Confirmation to User
        const confirmationEmbed = createNYSRPEmbed({
            title: '𝙁𝙚𝙚𝙙𝙗𝙖𝙘𝙠 𝙎𝙪𝙗𝙢𝙞𝙩𝙩𝙚𝙙',
            introduction: 'Thank you for taking the time to provide feedback about your NYSRP support experience.',
            sections: [
                {
                    title: 'Your Feedback',
                    items: [
                        `**Rating:** ${starsDisplay}`,
                        `**Comment:** ${comment && comment.trim() ? comment.trim() : '*No comment provided*'}`
                    ]
                }
            ],
            closing: 'Your feedback has been successfully submitted to the NYSRP Support Team. Thank you for helping us improve **New York State Roleplay**.',
            color: config.branding.color // #FD8701
        });

        try {
            await creatorUser.send({ embeds: [confirmationEmbed] });
        } catch {
            // DM closed
        }
    }
}

module.exports = FeedbackService;
