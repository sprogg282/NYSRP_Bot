const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    PermissionFlagsBits,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const db = require('../database/db');
const config = require('../config');
const { PERMISSIONS } = require('../config/permissions');
const { hasPermission } = require('../utils/permissionCheck');
const { createErrorEmbed, createNYSRPEmbed } = require('../utils/embedBuilder');
const { getValidatedChannel } = require('../utils/channelValidator');
const logger = require('../utils/logger');

const CHANNEL_ID = config.channels.suggestions;
const PANEL_BUTTON_ID = 'suggestion_panel_submit';
const SUBMIT_MODAL_ID = 'suggestion_submit_modal';
const STATUS_LABELS = {
    UNDER_REVIEW: '🟡 Under Review',
    APPROVED: '🟢 Suggestion Approved',
    DENIED: '🔴 Suggestion Denied',
    IMPLEMENTED: '🔵 Suggestion Implemented',
    CLOSED: '🔒 Suggestion Closed'
};
const DECISIONS = {
    approve: { status: 'APPROVED', label: 'Approve' },
    deny: { status: 'DENIED', label: 'Deny' },
    implement: { status: 'IMPLEMENTED', label: 'Mark Implemented' },
    close: { status: 'CLOSED', label: 'Close' }
};

class SuggestionService {
    static queues = new Map();

    static serialize(guildId, operation) {
        const previous = this.queues.get(guildId) || Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        this.queues.set(guildId, current);
        return current.finally(() => {
            if (this.queues.get(guildId) === current) this.queues.delete(guildId);
        });
    }

    static async initialize(client) {
        try {
            const channel = await client.channels.fetch(CHANNEL_ID);
            if (!channel?.isTextBased() || !channel.guild) {
                logger.warn(`[Suggestions] Configured suggestion channel ${CHANNEL_ID} is missing or is not a guild text channel.`);
                return;
            }

            await this.serialize(channel.guild.id, async () => {
                const validatedChannel = await this.getSuggestionChannel(channel.guild);
                if (!validatedChannel) {
                    logger.warn('[Suggestions] Panel and call-to-action reconciliation skipped because the channel is unavailable or the bot lacks required permissions.');
                    return;
                }

                await this.ensurePanel(validatedChannel);
                await this.ensureCallToAction(validatedChannel);
                logger.info(`[Suggestions] Panel and rolling call-to-action are ready in channel ${CHANNEL_ID}.`);
            });
        } catch (error) {
            logger.error(`[Suggestions] Could not initialize the suggestion system in channel ${CHANNEL_ID}:`, error);
        }
    }

    static ensureState(guildId) {
        db.prepare('INSERT OR IGNORE INTO suggestion_system_state (guild_id) VALUES (?)').run(guildId);
        return db.prepare('SELECT * FROM suggestion_system_state WHERE guild_id = ?').get(guildId);
    }

    static async getSuggestionChannel(guild) {
        const channel = await getValidatedChannel(guild, CHANNEL_ID, 'Suggestion');
        if (!channel) return null;

        let botMember = guild.members.me;
        if (!botMember) {
            try {
                botMember = await guild.members.fetchMe();
            } catch (error) {
                logger.warn(`[Suggestions] Could not verify bot permissions in channel ${CHANNEL_ID}: ${error.message}`);
                return null;
            }
        }

        const permissions = channel.permissionsFor(botMember);
        if (!permissions?.has(PermissionFlagsBits.ReadMessageHistory)) {
            logger.warn(`[Suggestions] Missing Read Message History permission in channel ${CHANNEL_ID}.`);
            return null;
        }
        return channel;
    }

    static async fetchMessage(channel, messageId) {
        if (!messageId) return null;
        try {
            return await channel.messages.fetch(messageId);
        } catch (error) {
            if (error.code === 10008 || error.status === 404) return null;
            throw error;
        }
    }

    static buildPanel() {
        const embed = createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝙎𝙪𝙜𝙜𝙚𝙨𝙩𝙞𝙤𝙣𝙨',
            introduction: 'Have an idea that could improve NYSRP? We want to hear your ideas!',
            closing: 'Click the button below to submit your suggestion.',
            color: config.branding.color
        });
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(PANEL_BUTTON_ID)
                .setLabel('Submit Suggestion')
                .setEmoji('💡')
                .setStyle(ButtonStyle.Primary)
        );
        return { embeds: [embed], components: [row] };
    }

    static async ensurePanel(channel) {
        const state = this.ensureState(channel.guild.id);
        const currentPanel = await this.fetchMessage(channel, state.panel_message_id);
        if (currentPanel) return currentPanel;

        const panel = await channel.send({
            ...this.buildPanel(),
            allowedMentions: { parse: [] }
        });
        db.prepare('UPDATE suggestion_system_state SET panel_message_id = ? WHERE guild_id = ?')
            .run(panel.id, channel.guild.id);
        return panel;
    }

    static buildCallToAction(channel, panelMessage) {
        const panelUrl = `https://discord.com/channels/${channel.guild.id}/${channel.id}/${panelMessage.id}`;
        const embed = new EmbedBuilder()
            .setColor(config.branding.color)
            .setDescription(
                '💡 **Want to suggest something to NYSRP?**\n\n' +
                'Have an idea that could improve the community?\n\n' +
                'Go to the suggestion panel and click **💡 Submit Suggestion**.'
            );
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('Suggest Something')
                .setEmoji('💡')
                .setStyle(ButtonStyle.Link)
                .setURL(panelUrl)
        );
        return { embeds: [embed], components: [row] };
    }

    static isCallToActionMessage(message, channel, panelMessage) {
        if (!message?.embeds?.some(embed =>
            embed.description?.includes('Want to suggest something to NYSRP?')
        )) {
            return false;
        }

        const expectedUrl = `https://discord.com/channels/${channel.guild.id}/${channel.id}/${panelMessage.id}`;
        const componentUrls = (message.components || [])
            .flatMap(row => row.components || [])
            .map(component => component.url || component.data?.url);
        return componentUrls.includes(expectedUrl);
    }

    static async sendCallToAction(channel, panelMessage) {
        const message = await channel.send({
            ...this.buildCallToAction(channel, panelMessage),
            allowedMentions: { parse: [] }
        });
        db.prepare('UPDATE suggestion_system_state SET cta_message_id = ? WHERE guild_id = ?')
            .run(message.id, channel.guild.id);
        return message;
    }

    static async ensureCallToAction(channel, panelMessage = null) {
        const state = this.ensureState(channel.guild.id);
        const panel = panelMessage || await this.ensurePanel(channel);
        const currentCta = await this.fetchMessage(channel, state.cta_message_id);

        if (!currentCta) {
            const latestMessages = await channel.messages.fetch({ limit: 1 });
            const latestMessage = latestMessages.first();
            if (this.isCallToActionMessage(latestMessage, channel, panel)) {
                db.prepare('UPDATE suggestion_system_state SET cta_message_id = ? WHERE guild_id = ?')
                    .run(latestMessage.id, channel.guild.id);
                return latestMessage;
            }
        }

        if (currentCta) {
            const latestMessages = await channel.messages.fetch({ limit: 1 });
            const latestMessage = latestMessages.first();
            if (latestMessage?.id === currentCta.id) return currentCta;

            await currentCta.delete();
        }

        db.prepare('UPDATE suggestion_system_state SET cta_message_id = NULL WHERE guild_id = ?')
            .run(channel.guild.id);
        return this.sendCallToAction(channel, panel);
    }

    static buildSubmitModal() {
        const modal = new ModalBuilder()
            .setCustomId(SUBMIT_MODAL_ID)
            .setTitle('Submit a Suggestion');

        const suggestion = new TextInputBuilder()
            .setCustomId('suggestion_text')
            .setLabel('Suggestion')
            .setStyle(TextInputStyle.Paragraph)
            .setMinLength(1)
            .setMaxLength(1500)
            .setRequired(true);
        const reason = new TextInputBuilder()
            .setCustomId('suggestion_reason')
            .setLabel('Why would this help NYSRP?')
            .setStyle(TextInputStyle.Paragraph)
            .setMinLength(1)
            .setMaxLength(1500)
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(suggestion),
            new ActionRowBuilder().addComponents(reason)
        );
        return modal;
    }

    static buildDecisionModal(action, suggestionId) {
        const decision = DECISIONS[action];
        if (!decision) throw new Error(`Unknown suggestion decision: ${action}`);

        const reason = new TextInputBuilder()
            .setCustomId('decision_reason')
            .setLabel(`Reason for ${decision.label}`)
            .setStyle(TextInputStyle.Paragraph)
            .setMinLength(1)
            .setMaxLength(1000)
            .setRequired(true);
        return new ModalBuilder()
            .setCustomId(`suggestion_decision_${action}_${suggestionId}`)
            .setTitle(`Suggestion ${decision.label}`)
            .addComponents(new ActionRowBuilder().addComponents(reason));
    }

    static getSuggestion(suggestionId) {
        return db.prepare('SELECT * FROM suggestions WHERE suggestion_id = ?').get(suggestionId);
    }

    static getVoteCounts(suggestionId) {
        const row = db.prepare(`
            SELECT
                SUM(CASE WHEN vote = 'UP' THEN 1 ELSE 0 END) AS upvotes,
                SUM(CASE WHEN vote = 'DOWN' THEN 1 ELSE 0 END) AS downvotes
            FROM suggestion_votes WHERE suggestion_id = ?
        `).get(suggestionId);
        return { upvotes: row.upvotes || 0, downvotes: row.downvotes || 0 };
    }

    static buildSuggestionEmbed(suggestion, voteCounts = this.getVoteCounts(suggestion.suggestion_id)) {
        const sections = [
            {
                title: 'Suggestion',
                items: suggestion.suggestion_text.split(/\r?\n/).map(line => `> ${line}`)
            },
            {
                title: 'Why would this help NYSRP?',
                items: suggestion.reason_text.split(/\r?\n/).map(line => `> ${line}`)
            },
            {
                title: 'Suggestion Details',
                items: [
                    `**Submitted by:** <@${suggestion.author_id}>`,
                    `**Status:** ${STATUS_LABELS[suggestion.status] || suggestion.status}`,
                    `**👍 ${voteCounts.upvotes} | 👎 ${voteCounts.downvotes}**`
                ]
            }
        ];

        if (suggestion.decision_by) {
            sections.push({
                title: STATUS_LABELS[suggestion.status] || 'Staff Decision',
                items: [
                    `**Handled by:** <@${suggestion.decision_by}>`,
                    `**Reason:** ${suggestion.decision_reason}`,
                    `**Date:** <t:${Math.floor(suggestion.decided_at / 1000)}:F>`
                ]
            });
        }

        return createNYSRPEmbed({
            title: `💡 Suggestion #${String(suggestion.suggestion_id).padStart(3, '0')}`,
            introduction: 'A community suggestion has been submitted for review.',
            sections,
            color: config.branding.color
        });
    }

    static buildSuggestionComponents(suggestion) {
        const voteRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`suggestion_vote_up_${suggestion.suggestion_id}`)
                .setLabel('Upvote')
                .setEmoji('👍')
                .setStyle(ButtonStyle.Success)
                .setDisabled(suggestion.status === 'CLOSED'),
            new ButtonBuilder()
                .setCustomId(`suggestion_vote_down_${suggestion.suggestion_id}`)
                .setLabel('Downvote')
                .setEmoji('👎')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(suggestion.status === 'CLOSED')
        );
        const decisionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`suggestion_staff_approve_${suggestion.suggestion_id}`)
                .setLabel('Approve')
                .setEmoji('✅')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(suggestion.status === 'CLOSED'),
            new ButtonBuilder()
                .setCustomId(`suggestion_staff_deny_${suggestion.suggestion_id}`)
                .setLabel('Deny')
                .setEmoji('❌')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(suggestion.status === 'CLOSED'),
            new ButtonBuilder()
                .setCustomId(`suggestion_staff_implement_${suggestion.suggestion_id}`)
                .setLabel('Implemented')
                .setEmoji('🔵')
                .setStyle(ButtonStyle.Success)
                .setDisabled(suggestion.status === 'CLOSED'),
            new ButtonBuilder()
                .setCustomId(`suggestion_staff_close_${suggestion.suggestion_id}`)
                .setLabel('Close')
                .setEmoji('🔒')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(suggestion.status === 'CLOSED')
        );
        return [voteRow, decisionRow];
    }

    static async submitSuggestion(interaction, suggestionText, reasonText) {
        const guild = interaction.guild;
        if (!guild || !interaction.channel || interaction.channel.id !== CHANNEL_ID) {
            return { success: false, message: 'Suggestions can only be submitted through the panel in the configured suggestion channel.' };
        }
        if (!suggestionText?.trim() || !reasonText?.trim()) {
            return { success: false, message: 'Both the suggestion and its benefit to NYSRP are required.' };
        }

        return this.serialize(guild.id, async () => {
            const channel = await this.getSuggestionChannel(guild);
            if (!channel) {
                return { success: false, message: 'The suggestion channel is unavailable, or I lack permission to send messages, embed links, or read message history there.' };
            }

            const panel = await this.ensurePanel(channel);
            await this.ensureCallToAction(channel, panel);
            const state = this.ensureState(guild.id);
            const previousCta = await this.fetchMessage(channel, state.cta_message_id);
            if (previousCta) await previousCta.delete();
            try {
                db.prepare('UPDATE suggestion_system_state SET cta_message_id = NULL WHERE guild_id = ?')
                    .run(guild.id);
            } catch (error) {
                try {
                    await this.sendCallToAction(channel, panel);
                } catch (ctaError) {
                    logger.error('[Suggestions] Could not restore the call-to-action after a database error:', ctaError);
                }
                throw error;
            }

            const createdAt = Date.now();
            let result;
            try {
                result = db.prepare(`
                    INSERT INTO suggestions (guild_id, channel_id, author_id, suggestion_text, reason_text, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).run(
                    guild.id,
                    CHANNEL_ID,
                    interaction.user.id,
                    suggestionText,
                    reasonText,
                    createdAt
                );
            } catch (error) {
                try {
                    await this.sendCallToAction(channel, panel);
                } catch (ctaError) {
                    logger.error('[Suggestions] Could not restore the call-to-action after suggestion storage failed:', ctaError);
                }
                throw error;
            }
            const suggestionId = Number(result.lastInsertRowid);
            let suggestionMessage = null;
            let postError = null;

            try {
                const suggestion = this.getSuggestion(suggestionId);
                suggestionMessage = await channel.send({
                    embeds: [this.buildSuggestionEmbed(suggestion)],
                    components: this.buildSuggestionComponents(suggestion),
                    allowedMentions: { parse: [] }
                });
                db.prepare('UPDATE suggestions SET message_id = ? WHERE suggestion_id = ?')
                    .run(suggestionMessage.id, suggestionId);
            } catch (error) {
                postError = error;
                logger.error(`[Suggestions] Failed posting suggestion #${suggestionId}:`, error);
            } finally {
                try {
                    await this.sendCallToAction(channel, panel);
                } catch (error) {
                    logger.error(`[Suggestions] Failed refreshing call-to-action after suggestion #${suggestionId}:`, error);
                    if (!postError) postError = error;
                }
            }

            if (postError) {
                if (!suggestionMessage) {
                    db.prepare('UPDATE suggestions SET status = ? WHERE suggestion_id = ?')
                        .run('FAILED', suggestionId);
                }
                return {
                    success: false,
                    message: suggestionMessage
                        ? `Suggestion #${String(suggestionId).padStart(3, '0')} was posted, but the call-to-action message could not be refreshed. Staff have been notified.`
                        : 'Your suggestion could not be posted. Please try again later.'
                };
            }

            return {
                success: true,
                message: `Your suggestion #${String(suggestionId).padStart(3, '0')} was submitted. Thank you for helping improve NYSRP!`
            };
        });
    }

    static async toggleVote(guild, userId, suggestionId, vote) {
        return this.serialize(guild.id, async () => {
            const suggestion = this.getSuggestion(suggestionId);
            if (!suggestion || suggestion.guild_id !== guild.id) {
                return { success: false, message: 'That suggestion could not be found.' };
            }
            if (suggestion.status === 'CLOSED') {
                return { success: false, message: 'Voting is closed for this suggestion.' };
            }

            let channel;
            let message;
            try {
                channel = await this.getSuggestionChannel(guild);
                if (!channel) return { success: false, message: 'The suggestion channel is unavailable or I lack permission to read and update suggestions.' };
                message = await this.fetchMessage(channel, suggestion.message_id);
            } catch (error) {
                logger.error(`[Suggestions] Could not fetch suggestion #${suggestionId} for voting:`, error);
                return { success: false, message: 'The suggestion message could not be reached. Please try again later.' };
            }
            if (!message) {
                return { success: false, message: 'This suggestion post has been deleted, so voting is unavailable.' };
            }

            const existing = db.prepare(
                'SELECT vote FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?'
            ).get(suggestionId, userId);
            const updateVote = db.transaction(() => {
                if (existing?.vote === vote) {
                    db.prepare('DELETE FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?')
                        .run(suggestionId, userId);
                    return null;
                }
                db.prepare(`
                    INSERT INTO suggestion_votes (suggestion_id, user_id, vote, created_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(suggestion_id, user_id) DO UPDATE SET
                        vote = excluded.vote,
                        created_at = excluded.created_at
                `).run(suggestionId, userId, vote, Date.now());
                return vote;
            });
            const currentVote = updateVote();
            const updatedSuggestion = this.getSuggestion(suggestionId);
            const voteCounts = this.getVoteCounts(suggestionId);

            try {
                await message.edit({
                    embeds: [this.buildSuggestionEmbed(updatedSuggestion, voteCounts)],
                    components: this.buildSuggestionComponents(updatedSuggestion),
                    allowedMentions: { parse: [] }
                });
            } catch (error) {
                logger.error(`[Suggestions] Could not update vote totals for suggestion #${suggestionId}:`, error);
                db.prepare('DELETE FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?')
                    .run(suggestionId, userId);
                if (existing) {
                    db.prepare('INSERT INTO suggestion_votes (suggestion_id, user_id, vote, created_at) VALUES (?, ?, ?, ?)')
                        .run(suggestionId, userId, existing.vote, Date.now());
                }
                return { success: false, message: 'Your vote could not be saved. Please try again.' };
            }

            return {
                success: true,
                message: currentVote
                    ? `Your ${vote === 'UP' ? 'upvote' : 'downvote'} was recorded.`
                    : 'Your vote was removed.'
            };
        });
    }

    static async decideSuggestion(guild, staffMember, suggestionId, action, reason) {
        if (!hasPermission(staffMember, PERMISSIONS.SUGGESTION_MANAGE)) {
            return { success: false, message: 'You do not have permission to manage suggestions.' };
        }
        if (!reason?.trim()) {
            return { success: false, message: 'A reason is required for this staff decision.' };
        }
        const decision = DECISIONS[action];
        if (!decision) return { success: false, message: 'That suggestion action is invalid.' };

        return this.serialize(guild.id, async () => {
            const suggestion = this.getSuggestion(suggestionId);
            if (!suggestion || suggestion.guild_id !== guild.id) {
                return { success: false, message: 'That suggestion could not be found.' };
            }
            if (suggestion.status === 'CLOSED') {
                return { success: false, message: 'This suggestion is already closed and cannot be changed.' };
            }

            let channel;
            let message;
            try {
                channel = await this.getSuggestionChannel(guild);
                if (!channel) return { success: false, message: 'The suggestion channel is unavailable or I lack permission to read and update suggestions.' };
                message = await this.fetchMessage(channel, suggestion.message_id);
            } catch (error) {
                logger.error(`[Suggestions] Could not fetch suggestion #${suggestionId} for staff decision:`, error);
                return { success: false, message: 'The suggestion message could not be reached. Please try again later.' };
            }
            if (!message) {
                return { success: false, message: 'The suggestion post was deleted. Its record is preserved, but it cannot be updated.' };
            }

            const previousDecision = {
                status: suggestion.status,
                decision_by: suggestion.decision_by,
                decision_reason: suggestion.decision_reason,
                decided_at: suggestion.decided_at
            };
            const decidedAt = Date.now();
            db.prepare(`
                UPDATE suggestions
                SET status = ?, decision_by = ?, decision_reason = ?, decided_at = ?
                WHERE suggestion_id = ?
            `).run(decision.status, staffMember.id, reason, decidedAt, suggestionId);

            const updatedSuggestion = this.getSuggestion(suggestionId);
            const voteCounts = this.getVoteCounts(suggestionId);
            try {
                await message.edit({
                    embeds: [this.buildSuggestionEmbed(updatedSuggestion, voteCounts)],
                    components: this.buildSuggestionComponents(updatedSuggestion),
                    allowedMentions: { parse: [] }
                });
            } catch (error) {
                logger.error(`[Suggestions] Could not update the post for suggestion #${suggestionId}; reverting decision:`, error);
                db.prepare(`
                    UPDATE suggestions
                    SET status = ?, decision_by = ?, decision_reason = ?, decided_at = ?
                    WHERE suggestion_id = ?
                `).run(
                    previousDecision.status,
                    previousDecision.decision_by,
                    previousDecision.decision_reason,
                    previousDecision.decided_at,
                    suggestionId
                );
                return { success: false, message: 'The suggestion post could not be updated, so the staff decision was not saved.' };
            }

            return {
                success: true,
                message: `Suggestion #${String(suggestionId).padStart(3, '0')} marked ${decision.label.toLowerCase()}.`
            };
        });
    }

    static parseSuggestionButton(customId) {
        let match = customId.match(/^suggestion_vote_(up|down)_(\d+)$/);
        if (match) return { type: 'vote', action: match[1] === 'up' ? 'UP' : 'DOWN', suggestionId: Number(match[2]) };
        match = customId.match(/^suggestion_staff_(approve|deny|implement|close)_(\d+)$/);
        if (match) return { type: 'staff', action: match[1], suggestionId: Number(match[2]) };
        return null;
    }

    static parseDecisionModal(customId) {
        const match = customId.match(/^suggestion_decision_(approve|deny|implement|close)_(\d+)$/);
        return match
            ? { action: match[1], suggestionId: Number(match[2]) }
            : null;
    }

    static buildErrorPayload(title, message) {
        return { embeds: [createErrorEmbed(title, message)], ephemeral: true };
    }
}

module.exports = SuggestionService;
