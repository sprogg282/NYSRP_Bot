const { randomInt } = require('crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../database/db');
const config = require('../config');
const { createNYSRPEmbed, createSuccessEmbed, createErrorEmbed } = require('../utils/embedBuilder');
const logger = require('../utils/logger');

const MAX_DURATION_MINUTES = 10080;
let schedulerTimer = null;
let processingDueEvents = false;

function createEventError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function chooseWinners(participants, count) {
    const pool = participants.slice();
    const winnerCount = Math.min(count, pool.length);
    for (let index = 0; index < winnerCount; index += 1) {
        const selected = randomInt(index, pool.length);
        [pool[index], pool[selected]] = [pool[selected], pool[index]];
    }
    return pool.slice(0, winnerCount);
}

class EventService {
    static validateEvent(eventType, title, description, startsAt, durationMinutes, winnerCount) {
        if (!['EVENT', 'GIVEAWAY'].includes(eventType)) {
            throw new Error('Event type must be EVENT or GIVEAWAY.');
        }
        const normalizedTitle = String(title || '').trim();
        const normalizedDescription = String(description || '').trim();
        if (!normalizedTitle || normalizedTitle.length > 100) {
            throw new Error('Event titles must contain 1 to 100 characters.');
        }
        if (normalizedDescription.length > 1000) {
            throw new Error('Event descriptions cannot exceed 1000 characters.');
        }
        if (!Number.isSafeInteger(startsAt)
            || startsAt < 0
            || (eventType === 'EVENT' && startsAt < Date.now())) {
            throw new Error('The start time must be valid, and scheduled events must start in the future.');
        }
        if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > MAX_DURATION_MINUTES) {
            throw new Error('Duration must be between 1 minute and 7 days.');
        }
        if (eventType === 'GIVEAWAY'
            && (!Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 20)) {
            throw new Error('A giveaway must have between 1 and 20 winners.');
        }
        return {
            title: normalizedTitle,
            description: normalizedDescription,
            winnerCount: eventType === 'GIVEAWAY' ? winnerCount : null
        };
    }

    static getEvent(eventId) {
        return db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId);
    }

    static getEventResults(eventId) {
        const event = this.getEvent(eventId);
        if (!event) throw new Error('Event not found.');
        const participantCount = db.prepare(`
            SELECT COUNT(*) AS count FROM event_entries WHERE event_id = ?
        `).get(eventId).count;
        const winners = db.prepare(`
            SELECT user_id FROM event_winners WHERE event_id = ? ORDER BY rowid
        `).all(eventId).map(winner => winner.user_id);
        return { event, participantCount, winners };
    }

    static buildPayload(eventId) {
        const { event, participantCount, winners } = this.getEventResults(eventId);
        const isGiveaway = event.event_type === 'GIVEAWAY';
        const label = isGiveaway ? 'Giveaway' : 'Event';
        const statusText = event.status === 'OPEN'
            ? 'Open'
            : event.status === 'CANCELLED' ? 'Cancelled' : 'Ended';
        const details = [
            `**Status:** ${statusText}`,
            `**${isGiveaway ? 'Entries' : 'Going'}:** ${participantCount}`,
            `**Starts:** <t:${Math.floor(event.starts_at / 1000)}:F>`,
            `**Ends:** <t:${Math.floor(event.ends_at / 1000)}:F>`
        ];
        if (isGiveaway) details.push(`**Winners:** ${event.winner_count}`);
        if (winners.length) {
            details.push(`**Selected:** ${winners.map(userId => `<@${userId}>`).join(', ')}`);
        } else if (isGiveaway && event.status === 'ENDED') {
            details.push('**Selected:** No eligible entries.');
        }

        const embed = createNYSRPEmbed({
            title: `${label} #${event.event_id}: ${event.title}`,
            introduction: event.description || (isGiveaway
                ? 'Enter below for a chance to win.'
                : 'Use the button below to RSVP.'),
            sections: [{ title: `${label} Details`, items: details }],
            closing: event.status === 'OPEN'
                ? (isGiveaway ? 'Each member may enter once. Entries close automatically at the deadline.' : 'You can update or remove your RSVP at any time.')
                : `This ${label.toLowerCase()} is ${statusText.toLowerCase()}.`,
            color: config.branding.color
        });
        const button = new ButtonBuilder()
            .setCustomId(`${isGiveaway ? 'giveaway_enter' : 'event_rsvp'}:${event.event_id}`)
            .setLabel(isGiveaway ? 'Enter Giveaway' : 'RSVP')
            .setStyle(isGiveaway ? ButtonStyle.Primary : ButtonStyle.Success)
            .setDisabled(event.status !== 'OPEN');

        return {
            embeds: [embed],
            components: [new ActionRowBuilder().addComponents(button)],
            allowedMentions: { users: winners, parse: [] }
        };
    }

    static async createEvent(channel, createdBy, {
        eventType,
        title,
        description = '',
        startsAt,
        durationMinutes,
        winnerCount = null
    }) {
        const createdAt = Date.now();
        const effectiveStartsAt = eventType === 'GIVEAWAY' ? createdAt : startsAt;
        const validated = this.validateEvent(
            eventType,
            title,
            description,
            effectiveStartsAt,
            durationMinutes,
            winnerCount
        );
        const endsAt = effectiveStartsAt + durationMinutes * 60 * 1000;
        const eventId = db.transaction(() => {
            const result = db.prepare(`
                INSERT INTO events (
                    guild_id, channel_id, event_type, title, description,
                    winner_count, created_by, created_at, starts_at, ends_at, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')
            `).run(
                channel.guild.id,
                channel.id,
                eventType,
                validated.title,
                validated.description || null,
                validated.winnerCount,
                createdBy,
                createdAt,
                effectiveStartsAt,
                endsAt
            );
            return Number(result.lastInsertRowid);
        })();

        let message = null;
        try {
            message = await channel.send(this.buildPayload(eventId));
            const result = db.prepare(`
                UPDATE events SET message_id = ?
                WHERE event_id = ? AND status = 'OPEN'
            `).run(message.id, eventId);
            if (result.changes !== 1) {
                throw new Error('The event message was sent, but its database record could not be finalized.');
            }
        } catch (error) {
            if (message) {
                try {
                    await message.delete('Event could not be recorded');
                } catch (cleanupError) {
                    logger.error(`[Events] Could not remove untracked message ${message.id}:`, cleanupError);
                }
            }
            db.prepare("UPDATE events SET status = 'FAILED' WHERE event_id = ? AND status = 'OPEN'").run(eventId);
            throw new Error(`Could not create the event. No usable event was recorded. ${error.message}`);
        }

        logger.info(`[Events] ${eventType} #${eventId} created by ${createdBy} in channel ${channel.id}.`);
        return { eventId, messageId: message.id, endsAt };
    }

    static toggleParticipation(eventId, userId) {
        return db.transaction(() => {
            const event = this.getEvent(eventId);
            if (!event || event.status === 'FAILED') throw new Error('Event not found.');
            if (event.status !== 'OPEN') throw new Error('This event is no longer accepting participation.');
            if (event.ends_at <= Date.now()) {
                throw createEventError('The event deadline has passed.', 'EVENT_EXPIRED');
            }

            const existing = db.prepare(`
                SELECT 1 FROM event_entries WHERE event_id = ? AND user_id = ?
            `).get(eventId, userId);
            if (existing) {
                db.prepare('DELETE FROM event_entries WHERE event_id = ? AND user_id = ?')
                    .run(eventId, userId);
                return { action: 'REMOVED', eventType: event.event_type };
            }
            db.prepare(`
                INSERT INTO event_entries (event_id, user_id, entered_at)
                VALUES (?, ?, ?)
            `).run(eventId, userId, Date.now());
            return { action: 'ADDED', eventType: event.event_type };
        })();
    }

    static async handleParticipation(interaction, eventId) {
        await interaction.deferReply({ ephemeral: true });
        try {
            const event = this.getEvent(eventId);
            if (!event
                || event.guild_id !== interaction.guildId
                || event.message_id !== interaction.message.id) {
                throw new Error('This event message is no longer valid.');
            }
            const result = this.toggleParticipation(eventId, interaction.user.id);
            let displayUpdated = true;
            try {
                await interaction.message.edit(this.buildPayload(eventId));
            } catch (error) {
                displayUpdated = false;
                logger.warn(`[Events] Participation saved, but event #${eventId} display could not be refreshed: ${error.message}`);
            }

            const noun = result.eventType === 'GIVEAWAY' ? 'giveaway entry' : 'event RSVP';
            const response = result.action === 'ADDED'
                ? `Your ${noun} has been recorded.`
                : `Your ${noun} has been removed.`;
            return interaction.editReply({
                embeds: [createSuccessEmbed(
                    result.action === 'ADDED' ? 'Participation Recorded' : 'Participation Removed',
                    displayUpdated
                        ? response
                        : `${response} The public event display could not refresh yet.`
                )]
            });
        } catch (error) {
            if (error.code === 'EVENT_EXPIRED') {
                try {
                    await this.closeEvent(eventId, interaction.client, interaction.message);
                } catch (closeError) {
                    logger.error(`[Events] Could not close expired event #${eventId} after participation:`, closeError);
                }
            }
            return interaction.editReply({
                embeds: [createErrorEmbed('Participation Failed', error.message)]
            });
        }
    }

    static finalizeEvent(eventId) {
        return db.transaction(() => {
            let event = this.getEvent(eventId);
            if (!event) throw new Error('Event not found.');
            if (event.status === 'FAILED') throw new Error('This event was not successfully created.');
            if (event.status === 'CANCELLED') {
                return { event, winners: [], alreadyClosed: true };
            }
            if (event.status === 'ENDED') {
                const winners = db.prepare(`
                    SELECT user_id FROM event_winners WHERE event_id = ? ORDER BY rowid
                `).all(eventId).map(row => row.user_id);
                return { event, winners, alreadyClosed: true };
            }

            const participants = db.prepare(`
                SELECT user_id FROM event_entries WHERE event_id = ? ORDER BY entered_at, user_id
            `).all(eventId).map(row => row.user_id);
            const winners = event.event_type === 'GIVEAWAY'
                ? chooseWinners(participants, event.winner_count)
                : [];
            const closedAt = Date.now();
            const insertWinner = db.prepare(`
                INSERT INTO event_winners (event_id, user_id, selected_at)
                VALUES (?, ?, ?)
            `);
            for (const winnerId of winners) insertWinner.run(eventId, winnerId, closedAt);
            db.prepare(`
                UPDATE events SET status = 'ENDED', closed_at = ?
                WHERE event_id = ? AND status = 'OPEN'
            `).run(closedAt, eventId);
            event = this.getEvent(eventId);
            return { event, winners, alreadyClosed: false };
        })();
    }

    static async updateFinalMessage(eventId, client, interactionMessage = null) {
        const event = this.getEvent(eventId);
        if (!event) throw new Error('Event not found.');
        if (event.message_finalized) {
            return { messageUpdated: true, alreadyFinalized: true };
        }
        try {
            let message = interactionMessage?.id === event.message_id ? interactionMessage : null;
            if (!message) {
                const channel = await client.channels.fetch(event.channel_id);
                message = await channel.messages.fetch(event.message_id);
            }
            await message.edit(this.buildPayload(eventId));
            db.prepare('UPDATE events SET message_finalized = 1 WHERE event_id = ? AND status != \'OPEN\'')
                .run(eventId);
            return { messageUpdated: true, alreadyFinalized: false };
        } catch (error) {
            if (error.code === 10008 || error.code === 10003) {
                db.prepare('UPDATE events SET message_finalized = 1 WHERE event_id = ? AND status != \'OPEN\'')
                    .run(eventId);
                logger.warn(`[Events] Finalized event #${eventId} in storage, but its Discord message no longer exists.`);
                return { messageUpdated: false, messageMissing: true };
            }
            throw new Error(`Event results are saved, but the Discord message could not be updated: ${error.message}`);
        }
    }

    static async closeEvent(eventId, client, interactionMessage = null) {
        const result = this.finalizeEvent(eventId);
        const messageResult = await this.updateFinalMessage(eventId, client, interactionMessage);
        return { ...result, ...messageResult };
    }

    static cancelEvent(eventId) {
        return db.transaction(() => {
            const event = this.getEvent(eventId);
            if (!event || event.status === 'FAILED') throw new Error('Event not found.');
            if (event.status === 'CANCELLED') return { alreadyCancelled: true };
            if (event.status === 'ENDED') throw new Error('This event has already ended and cannot be cancelled.');
            db.prepare(`
                UPDATE events SET status = 'CANCELLED', closed_at = ?
                WHERE event_id = ? AND status = 'OPEN'
            `).run(Date.now(), eventId);
            return { alreadyCancelled: false };
        })();
    }

    static async cancelEventForGuild(eventId, guildId, client) {
        const event = this.getEvent(eventId);
        if (!event || event.guild_id !== guildId) throw new Error('Event not found in this server.');
        const result = this.cancelEvent(eventId);
        if (!event.message_finalized) {
            const messageResult = await this.updateFinalMessage(eventId, client);
            return { ...result, ...messageResult };
        }
        return { ...result, messageUpdated: true };
    }

    static async closeEventForGuild(eventId, guildId, client) {
        const event = this.getEvent(eventId);
        if (!event || event.guild_id !== guildId) throw new Error('Event not found in this server.');
        if (event.status === 'CANCELLED') throw new Error('This event was cancelled and cannot be ended as an active event.');
        return this.closeEvent(eventId, client);
    }

    static listOpenEvents(guildId) {
        return db.prepare(`
            SELECT event_id, event_type, title, starts_at, ends_at, channel_id
            FROM events
            WHERE guild_id = ? AND status = 'OPEN'
            ORDER BY starts_at
            LIMIT 25
        `).all(guildId);
    }

    static async processDueEvents(client) {
        if (processingDueEvents) return;
        processingDueEvents = true;
        try {
            const now = Date.now();
            const due = db.prepare(`
                SELECT event_id FROM events
                WHERE status = 'OPEN' AND ends_at <= ?
                ORDER BY ends_at
                LIMIT 25
            `).all(now);
            const pending = db.prepare(`
                SELECT event_id FROM events
                WHERE status IN ('ENDED', 'CANCELLED') AND message_finalized = 0
                ORDER BY closed_at
                LIMIT 25
            `).all();
            for (const event of [...due, ...pending]) {
                try {
                    if (this.getEvent(event.event_id).status === 'OPEN') {
                        await this.closeEvent(event.event_id, client);
                    } else {
                        await this.updateFinalMessage(event.event_id, client);
                    }
                } catch (error) {
                    logger.error(`[Events] Automatic finalization failed for event #${event.event_id}:`, error);
                }
            }
        } finally {
            processingDueEvents = false;
        }
    }

    static async startScheduler(client) {
        if (!schedulerTimer) {
            schedulerTimer = setInterval(() => {
                this.processDueEvents(client).catch(error => {
                    logger.error('[Events] Automatic event scheduler failed:', error);
                });
            }, 15000);
            schedulerTimer.unref?.();
        }
        await this.processDueEvents(client);
    }
}

module.exports = EventService;
