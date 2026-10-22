const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../database/db');
const config = require('../config');
const { createNYSRPEmbed, createSuccessEmbed, createErrorEmbed } = require('../utils/embedBuilder');
const logger = require('../utils/logger');

const MIN_DURATION_MINUTES = 1;
const MAX_DURATION_MINUTES = 10080;
const MAX_ANSWER_OPTIONS = 10;
const OPTIONS_PER_ROW = 5;
let schedulerTimer = null;
let processingDuePolls = false;

function createPollError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

class PollService {
    static validatePoll(question, options, durationMinutes, allowMultiple) {
        const normalizedQuestion = String(question || '').trim();
        if (!normalizedQuestion || normalizedQuestion.length > 200) {
            throw new Error('A poll question must contain 1 to 200 characters.');
        }
        if (!Array.isArray(options) || options.length < 2 || options.length > MAX_ANSWER_OPTIONS) {
            throw new Error('A poll must have between 2 and 10 answer options.');
        }

        const normalizedOptions = options.map(option => String(option || '').trim());
        if (normalizedOptions.some(option => !option || option.length > 80)) {
            throw new Error('Each answer option must contain 1 to 80 characters.');
        }
        const uniqueOptions = new Set(normalizedOptions.map(option => option.toLocaleLowerCase()));
        if (uniqueOptions.size !== normalizedOptions.length) {
            throw new Error('Poll answer options must be unique.');
        }
        if (!Number.isInteger(durationMinutes)
            || durationMinutes < MIN_DURATION_MINUTES
            || durationMinutes > MAX_DURATION_MINUTES) {
            throw new Error('Poll duration must be between 1 minute and 7 days.');
        }
        if (typeof allowMultiple !== 'boolean') {
            throw new Error('Poll selection mode must be specified as single-choice or multiple-selection.');
        }

        return { question: normalizedQuestion, options: normalizedOptions };
    }

    static getPoll(pollId) {
        return db.prepare('SELECT * FROM polls WHERE poll_id = ?').get(pollId);
    }

    static getResults(pollId) {
        const poll = this.getPoll(pollId);
        if (!poll) throw new Error('Poll not found.');

        const options = db.prepare(`
            SELECT option_index, label
            FROM poll_options
            WHERE poll_id = ?
            ORDER BY option_index
        `).all(pollId);
        const counts = new Map(db.prepare(`
            SELECT option_index, COUNT(*) AS vote_count
            FROM poll_votes
            WHERE poll_id = ?
            GROUP BY option_index
        `).all(pollId).map(row => [row.option_index, row.vote_count]));
        const voterCount = db.prepare(`
            SELECT COUNT(DISTINCT user_id) AS voter_count
            FROM poll_votes
            WHERE poll_id = ?
        `).get(pollId).voter_count;

        return {
            poll,
            voterCount,
            options: options.map(option => ({
                ...option,
                votes: counts.get(option.option_index) || 0,
                percent: voterCount
                    ? Math.round(((counts.get(option.option_index) || 0) / voterCount) * 100)
                    : 0
            }))
        };
    }

    static buildPayload(pollId) {
        const { poll, voterCount, options } = this.getResults(pollId);
        const statusText = poll.status === 'OPEN'
            ? `Voting is open until <t:${Math.floor(poll.closes_at / 1000)}:F>.`
            : `Voting closed <t:${Math.floor((poll.closed_at || poll.closes_at) / 1000)}:R>.`;
        const optionLines = options.map(option => {
            const bar = option.votes ? `${'█'.repeat(Math.max(1, Math.round(option.percent / 10)))} ` : '';
            return `**${option.option_index + 1}. ${option.label}**\n${bar}${option.votes} vote(s) · ${option.percent}%`;
        });
        const embed = createNYSRPEmbed({
            title: `NYSRP Poll #${poll.poll_id}`,
            introduction: poll.question,
            sections: [
                {
                    title: 'Results',
                    items: optionLines
                },
                {
                    title: 'Poll Details',
                    items: [
                        `**Mode:** ${poll.allow_multiple ? 'Select multiple options' : 'Select one option'}`,
                        `**Voters:** ${voterCount}`,
                        `**Status:** ${poll.status === 'OPEN' ? 'Open' : 'Closed'}`,
                        statusText
                    ]
                }
            ],
            color: config.branding.color
        });
        const components = [];

        if (options.length) {
            for (let offset = 0; offset < options.length; offset += OPTIONS_PER_ROW) {
                const row = new ActionRowBuilder();
                row.addComponents(options.slice(offset, offset + OPTIONS_PER_ROW).map(option =>
                    new ButtonBuilder()
                        .setCustomId(`poll_vote:${poll.poll_id}:${option.option_index}`)
                        .setLabel(option.label)
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(poll.status !== 'OPEN')
                ));
                components.push(row);
            }
        }

        return {
            embeds: [embed],
            components,
            allowedMentions: { parse: [] }
        };
    }

    static async createPoll(channel, createdBy, question, options, durationMinutes, allowMultiple) {
        const validated = this.validatePoll(question, options, durationMinutes, allowMultiple);
        const createdAt = Date.now();
        const closesAt = createdAt + durationMinutes * 60 * 1000;
        const pollId = db.transaction(() => {
            const result = db.prepare(`
                INSERT INTO polls (
                    guild_id, channel_id, question, allow_multiple, created_by,
                    created_at, closes_at, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN')
            `).run(
                channel.guild.id,
                channel.id,
                validated.question,
                allowMultiple ? 1 : 0,
                createdBy,
                createdAt,
                closesAt
            );
            const id = Number(result.lastInsertRowid);
            const insertOption = db.prepare(`
                INSERT INTO poll_options (poll_id, option_index, label)
                VALUES (?, ?, ?)
            `);
            validated.options.forEach((label, index) => insertOption.run(id, index, label));
            return id;
        })();

        let message = null;
        try {
            message = await channel.send(this.buildPayload(pollId));
            const result = db.prepare(`
                UPDATE polls
                SET message_id = ?
                WHERE poll_id = ? AND status = 'OPEN'
            `).run(message.id, pollId);
            if (result.changes !== 1) {
                throw new Error('The poll message was sent, but its database record could not be finalized.');
            }
        } catch (error) {
            if (message) {
                try {
                    await message.delete('Poll could not be recorded');
                } catch (cleanupError) {
                    logger.error(`[Polls] Could not remove untracked poll message ${message.id}:`, cleanupError);
                }
            }
            db.prepare("UPDATE polls SET status = 'FAILED' WHERE poll_id = ? AND status = 'OPEN'").run(pollId);
            throw new Error(`Poll creation failed. No usable poll was recorded. ${error.message}`);
        }

        logger.info(`[Polls] Poll #${pollId} created by ${createdBy} in channel ${channel.id}.`);
        return { pollId, messageId: message.id, closesAt };
    }

    static castVote(pollId, userId, optionIndex) {
        return db.transaction(() => {
            const poll = this.getPoll(pollId);
            if (!poll) throw new Error('Poll not found.');
            if (poll.status !== 'OPEN') throw new Error('Voting for this poll is closed.');
            if (poll.closes_at <= Date.now()) {
                throw createPollError('This poll has expired.', 'POLL_EXPIRED');
            }

            const option = db.prepare(`
                SELECT option_index FROM poll_options
                WHERE poll_id = ? AND option_index = ?
            `).get(pollId, optionIndex);
            if (!option) throw new Error('That answer option is no longer available.');

            const existing = db.prepare(`
                SELECT option_index FROM poll_votes
                WHERE poll_id = ? AND user_id = ? AND option_index = ?
            `).get(pollId, userId, optionIndex);
            if (poll.allow_multiple && existing) {
                db.prepare(`
                    DELETE FROM poll_votes
                    WHERE poll_id = ? AND user_id = ? AND option_index = ?
                `).run(pollId, userId, optionIndex);
                return { action: 'REMOVED' };
            }

            let action = existing ? 'CHANGED' : 'ADDED';
            if (!poll.allow_multiple) {
                const previous = db.prepare(`
                    SELECT option_index FROM poll_votes
                    WHERE poll_id = ? AND user_id = ?
                `).get(pollId, userId);
                if (previous?.option_index === optionIndex) {
                    return { action: 'UNCHANGED' };
                }
                if (previous) action = 'CHANGED';
                db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?')
                    .run(pollId, userId);
            }

            db.prepare(`
                INSERT INTO poll_votes (poll_id, user_id, option_index, created_at)
                VALUES (?, ?, ?, ?)
            `).run(pollId, userId, optionIndex, Date.now());
            return { action };
        })();
    }

    static async handleVote(interaction, pollId, optionIndex) {
        await interaction.deferReply({ ephemeral: true });
        try {
            const poll = this.getPoll(pollId);
            if (!poll
                || poll.guild_id !== interaction.guildId
                || poll.message_id !== interaction.message.id) {
                throw new Error('This poll message is no longer valid.');
            }
            const result = this.castVote(pollId, interaction.user.id, optionIndex);
            let displayUpdated = true;
            try {
                await interaction.message.edit(this.buildPayload(pollId));
            } catch (error) {
                displayUpdated = false;
                logger.warn(`[Polls] Vote saved, but poll #${pollId} display could not be refreshed: ${error.message}`);
            }

            const confirmation = {
                ADDED: 'Your vote has been counted.',
                CHANGED: 'Your selection has been updated.',
                REMOVED: 'Your selection has been removed.',
                UNCHANGED: 'Your vote was already counted for that option.'
            }[result.action];
            return interaction.editReply({
                embeds: [createSuccessEmbed(
                    'Poll Vote',
                    displayUpdated
                        ? confirmation
                        : `${confirmation} The vote is saved, but the public results display could not refresh yet.`
                )]
            });
        } catch (error) {
            if (error.code === 'POLL_EXPIRED') {
                try {
                    await this.closePoll(pollId, interaction.client, interaction.message, 'SYSTEM');
                } catch (closeError) {
                    logger.error(`[Polls] Could not close expired poll #${pollId} after a vote attempt:`, closeError);
                }
            }
            return interaction.editReply({
                embeds: [createErrorEmbed('Poll Vote Failed', error.message)]
            });
        }
    }

    static async closePoll(pollId, client, interactionMessage = null, closedBy = 'SYSTEM') {
        let poll = this.getPoll(pollId);
        if (!poll) throw new Error('Poll not found.');
        if (poll.status === 'FAILED') throw new Error('This poll was not successfully created.');

        if (poll.status === 'OPEN') {
            const closedAt = Date.now();
            db.prepare(`
                UPDATE polls
                SET status = 'CLOSED', closed_at = ?, closed_by = ?
                WHERE poll_id = ? AND status = 'OPEN'
            `).run(closedAt, closedBy, pollId);
            poll = this.getPoll(pollId);
        }
        if (poll.status !== 'CLOSED') {
            throw new Error(`Poll cannot be closed while its status is ${poll.status}.`);
        }
        if (poll.message_finalized) {
            return { closed: true, messageUpdated: true, alreadyClosed: true };
        }

        try {
            let message = interactionMessage?.id === poll.message_id ? interactionMessage : null;
            if (!message) {
                const channel = await client.channels.fetch(poll.channel_id);
                message = await channel.messages.fetch(poll.message_id);
            }
            await message.edit(this.buildPayload(pollId));
            db.prepare('UPDATE polls SET message_finalized = 1 WHERE poll_id = ? AND status = \'CLOSED\'')
                .run(pollId);
            return { closed: true, messageUpdated: true, alreadyClosed: false };
        } catch (error) {
            if (error.code === 10008 || error.code === 10003) {
                db.prepare('UPDATE polls SET message_finalized = 1 WHERE poll_id = ? AND status = \'CLOSED\'')
                    .run(pollId);
                logger.warn(`[Polls] Poll #${pollId} was closed in storage, but its Discord message no longer exists.`);
                return { closed: true, messageUpdated: false, messageMissing: true };
            }
            throw new Error(`Poll was closed and its results are saved, but the Discord message could not be updated: ${error.message}`);
        }
    }

    static async closePollForGuild(pollId, guildId, client, closedBy) {
        const poll = this.getPoll(pollId);
        if (!poll || poll.guild_id !== guildId) throw new Error('Poll not found in this server.');
        return this.closePoll(pollId, client, null, closedBy);
    }

    static async processDuePolls(client) {
        if (processingDuePolls) return;
        processingDuePolls = true;
        try {
            const now = Date.now();
            const duePolls = db.prepare(`
                SELECT poll_id FROM polls
                WHERE status = 'OPEN' AND closes_at <= ?
                ORDER BY closes_at
                LIMIT 25
            `).all(now);
            const pendingUpdates = db.prepare(`
                SELECT poll_id FROM polls
                WHERE status = 'CLOSED' AND message_finalized = 0
                ORDER BY closed_at
                LIMIT 25
            `).all();

            for (const poll of [...duePolls, ...pendingUpdates]) {
                try {
                    await this.closePoll(poll.poll_id, client);
                } catch (error) {
                    logger.error(`[Polls] Automatic closure/update failed for poll #${poll.poll_id}:`, error);
                }
            }
        } finally {
            processingDuePolls = false;
        }
    }

    static async startScheduler(client) {
        if (!schedulerTimer) {
            schedulerTimer = setInterval(() => {
                this.processDuePolls(client).catch(error => {
                    logger.error('[Polls] Automatic poll scheduler failed:', error);
                });
            }, 15000);
            schedulerTimer.unref?.();
        }
        await this.processDuePolls(client);
    }
}

module.exports = PollService;
