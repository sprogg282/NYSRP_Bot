const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const db = require('../database/db');
const config = require('../config');
const logger = require('../utils/logger');
const { getImage } = require('../utils/imageManager');

const API_URL = 'https://api.erlc.gg/v2/server?Players=true&Queue=true';
const CACHE_TTL_MS = 60000;
const POLL_INTERVAL_MS = 60000;
const MANUAL_REFRESH_INTERVAL_MS = 30000;
const REQUEST_TIMEOUT_MS = 10000;
let cachedSnapshot = null;
let retryAfterAt = 0;
let currentRequest = null;
let schedulerTimer = null;
let lastManualRefreshAt = 0;

function escapeDiscordText(value) {
    return String(value)
        .replace(/([\\`*_{}\[\]()#+\-.!|>~])/g, '\\$1')
        .replace(/@/g, '@\u200b');
}

function extractErrorCode(body) {
    const code = Number(body?.code ?? body?.Code);
    return Number.isFinite(code) ? code : null;
}

function getRetryDelayMs(response, body) {
    const retryAfter = response.headers.get('retry-after');
    const bodyRetryAfter = body?.retry_after ?? body?.retryAfter;
    const seconds = Number(retryAfter ?? bodyRetryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const date = retryAfter ? Date.parse(retryAfter) : NaN;
    if (Number.isFinite(date) && date > Date.now()) return date - Date.now();
    return 60000;
}

function validateServerData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('ER:LC API returned server data that does not match the documented response fields.');
    }
    if (typeof data.Name !== 'string'
        || !Number.isInteger(data.CurrentPlayers)
        || !Number.isInteger(data.MaxPlayers)) {
        throw new Error('ER:LC API response is missing the server name or player counts needed to verify its status.');
    }
    const fieldValidators = {
        Name: value => typeof value === 'string',
        OwnerId: Number.isSafeInteger,
        CoOwnerIds: value => Array.isArray(value) && value.every(Number.isSafeInteger),
        CurrentPlayers: value => Number.isInteger(value) && value >= 0,
        MaxPlayers: value => Number.isInteger(value) && value > 0,
        JoinKey: value => typeof value === 'string',
        AccVerifiedReq: value => typeof value === 'string',
        TeamBalance: value => typeof value === 'boolean',
        Queue: value => Array.isArray(value),
        Players: value => Array.isArray(value)
    };
    for (const [field, isValid] of Object.entries(fieldValidators)) {
        if (data[field] !== undefined && !isValid(data[field])) {
            throw new Error(`ER:LC API returned an invalid ${field} field.`);
        }
    }
    return data;
}

function formatValue(value, formatter = item => String(item)) {
    return value === undefined || value === null || value === '' ? 'Not provided' : formatter(value);
}

function getPlayerId(player) {
    if (typeof player !== 'string') return null;
    const separator = player.lastIndexOf(':');
    if (separator === -1) return null;
    const playerId = Number(player.slice(separator + 1));
    return Number.isSafeInteger(playerId) ? playerId : null;
}

function getOnlineStaffCount(players) {
    if (!Array.isArray(players)) return null;
    return players.filter(player =>
        typeof player?.Permission === 'string'
        && /server (administrator|moderator|owner|helper)/i.test(player.Permission)
    ).length;
}

function getOwnerDisplay(data) {
    if (!Number.isSafeInteger(data.OwnerId)) return 'Not provided';
    if (Array.isArray(data.Players)) {
        const owner = data.Players.find(player =>
            getPlayerId(player?.Player) === data.OwnerId
            || (typeof player?.Permission === 'string' && /server owner/i.test(player.Permission))
        );
        if (typeof owner?.Player === 'string') {
            return `${owner.Player.split(':')[0]} (ID: ${data.OwnerId})`;
        }
    }
    return `Roblox user ID: ${data.OwnerId}`;
}

function getJoinUrl() {
    if (!config.erlc.joinUrl) return null;
    try {
        const url = new URL(config.erlc.joinUrl);
        if (url.protocol !== 'https:'
            || !['roblox.com', 'www.roblox.com'].includes(url.hostname)) {
            return null;
        }
        return url.toString();
    } catch {
        return null;
    }
}

function createSnapshot(state, details = {}) {
    const checkedAt = Date.now();
    return { state, checkedAt, ...details };
}

class ERLCService {
    static async refreshStatus(force = false) {
        if (currentRequest) return currentRequest;
        const now = Date.now();
        if (!config.erlc.serverKey) {
            return createSnapshot('UNCONFIGURED', {
                error: 'ER:LC integration is not configured. Set ERLC_SERVER_KEY in the environment.'
            });
        }
        if (now < retryAfterAt) {
            if (!cachedSnapshot) {
                return createSnapshot('UNAVAILABLE', {
                    error: 'ER:LC API requests are paused until the documented retry delay expires.'
                });
            }
            return {
                ...cachedSnapshot,
                state: cachedSnapshot.data ? 'STALE' : cachedSnapshot.state,
                checkedAt: now,
                error: 'The ER:LC API is temporarily rate-limiting requests; showing the last known data.'
            };
        }
        if (cachedSnapshot
            && now - cachedSnapshot.checkedAt < CACHE_TTL_MS
            && (!force || now - lastManualRefreshAt < MANUAL_REFRESH_INTERVAL_MS)) {
            return cachedSnapshot;
        }

        if (force) lastManualRefreshAt = now;
        currentRequest = this.requestStatus();
        try {
            return await currentRequest;
        } finally {
            currentRequest = null;
        }
    }

    static async requestStatus() {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(API_URL, {
                method: 'GET',
                headers: { 'server-key': config.erlc.serverKey },
                signal: controller.signal
            });
            let body;
            try {
                body = await response.json();
            } catch (error) {
                throw new Error(`ER:LC API returned a non-JSON response (HTTP ${response.status}): ${error.message}`);
            }

            if (!response.ok) {
                const code = extractErrorCode(body);
                if (code === 3002) {
                    retryAfterAt = Date.now() + CACHE_TTL_MS;
                    cachedSnapshot = createSnapshot('OFFLINE', {
                        error: 'ER:LC API reports the private server is offline because it has no players (code 3002).',
                        apiCode: code,
                        fetchedAt: Date.now()
                    });
                    return cachedSnapshot;
                }
                if (response.status === 429 || code === 4001) {
                    const delay = getRetryDelayMs(response, body);
                    retryAfterAt = Date.now() + delay;
                    logger.warn(`[ER:LC] API rate limit received; requests paused for ${Math.ceil(delay / 1000)} seconds.`);
                } else if ([2001, 2002, 2004].includes(code) || [401, 403].includes(response.status)) {
                    retryAfterAt = Number.POSITIVE_INFINITY;
                    logger.error(`[ER:LC] API authentication failed (HTTP ${response.status}, code ${code ?? 'unknown'}). Correct ERLC_SERVER_KEY and restart the bot.`);
                } else {
                    retryAfterAt = Date.now() + CACHE_TTL_MS;
                    logger.error(`[ER:LC] API request failed (HTTP ${response.status}, code ${code ?? 'unknown'}).`);
                }

                const message = body?.message || body?.Message || 'The ER:LC API request failed.';
                cachedSnapshot = createSnapshot(cachedSnapshot?.data ? 'STALE' : 'UNAVAILABLE', {
                    data: cachedSnapshot?.data || null,
                    fetchedAt: cachedSnapshot?.fetchedAt || null,
                    apiCode: code,
                    error: `${message} (HTTP ${response.status}${code === null ? '' : `, code ${code}`}).`
                });
                return cachedSnapshot;
            }

            const data = validateServerData(body);
            cachedSnapshot = createSnapshot('AVAILABLE', {
                data,
                fetchedAt: Date.now(),
                apiCode: null,
                error: null
            });
            retryAfterAt = 0;
            return cachedSnapshot;
        } catch (error) {
            if (error.name === 'AbortError') {
                logger.error('[ER:LC] API request timed out.');
            } else {
                logger.error('[ER:LC] API request failed:', error);
            }
            retryAfterAt = Date.now() + CACHE_TTL_MS;
            cachedSnapshot = createSnapshot(cachedSnapshot?.data ? 'STALE' : 'UNAVAILABLE', {
                data: cachedSnapshot?.data || null,
                fetchedAt: cachedSnapshot?.fetchedAt || null,
                error: error.name === 'AbortError'
                    ? 'The ER:LC API request timed out.'
                    : 'The ER:LC API could not be reached or returned invalid data.'
            });
            return cachedSnapshot;
        } finally {
            clearTimeout(timeout);
        }
    }

    static buildPayload(snapshot) {
        const image = getImage('sessionStart');
        const banner = new EmbedBuilder()
            .setColor(config.branding.color);
        const files = [];
        if (image) {
            banner.setImage(image.url);
            files.push(image.attachment);
        }

        const data = snapshot.data || {};
        const hasFreshData = snapshot.state === 'AVAILABLE';
        const hasStaleData = snapshot.state === 'STALE' && Boolean(snapshot.data);
        const staffCount = getOnlineStaffCount(data.Players);
        const status = snapshot.state === 'AVAILABLE'
            ? { label: '🟢 ONLINE', color: 0x2ECC71 }
            : snapshot.state === 'OFFLINE'
                ? { label: '🔴 OFFLINE', color: 0xE74C3C }
                : hasStaleData
                    ? { label: '🟠 API UNAVAILABLE · STALE DATA', color: 0xE67E22 }
                    : snapshot.state === 'UNCONFIGURED'
                        ? { label: '⚪ NOT CONFIGURED', color: 0x7F8C8D }
                        : { label: '⚪ UNAVAILABLE', color: 0x7F8C8D };
        const description = hasStaleData
            ? 'The latest API request failed. Values below are from the last successful update and are **not live**.'
            : snapshot.state === 'OFFLINE'
                ? 'The ER:LC API reports that the private server is offline.'
                : snapshot.state === 'AVAILABLE'
                    ? 'Live server details from the official ER:LC Private Server API.'
                    : snapshot.error || 'Live ER:LC server information is currently unavailable.';
        const embed = new EmbedBuilder()
            .setColor(status.color)
            .setTitle('ER:LC LIVE SERVER STATUS')
            .setDescription(`**${status.label}**\n${escapeDiscordText(description).slice(0, 1500)}`)
            .addFields(
                {
                    name: 'PLAYERS ONLINE',
                    value: data.CurrentPlayers !== undefined && data.MaxPlayers !== undefined
                        ? `**${data.CurrentPlayers}** / ${data.MaxPlayers}`
                        : 'Not provided',
                    inline: true
                },
                {
                    name: 'QUEUE',
                    value: Array.isArray(data.Queue) ? `**${data.Queue.length}** waiting` : 'Not provided',
                    inline: true
                },
                {
                    name: 'STAFF ONLINE',
                    value: staffCount === null
                        ? 'Not provided'
                        : `**${staffCount}**`,
                    inline: true
                },
                {
                    name: 'SERVER NAME',
                    value: escapeDiscordText(formatValue(data.Name)).slice(0, 256),
                    inline: true
                },
                {
                    name: 'SERVER OWNER',
                    value: escapeDiscordText(getOwnerDisplay(data)).slice(0, 256),
                    inline: true
                },
                {
                    name: 'JOIN CODE',
                    value: hasFreshData && typeof data.JoinKey === 'string' && data.JoinKey
                        ? `\`${data.JoinKey.replace(/`/g, '\\`')}\``
                        : hasFreshData
                            ? 'Not provided by the API.'
                            : 'Unavailable while the server is offline or live data is unavailable.',
                    inline: false
                }
            )
            .setFooter({
                text: snapshot.fetchedAt
                    ? `NYSRP • Last successful API update: ${new Date(snapshot.fetchedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC · <t:${Math.floor(snapshot.fetchedAt / 1000)}:R>`
                    : 'NYSRP • No successful API update yet'
            })
            .setTimestamp(new Date(snapshot.fetchedAt || snapshot.checkedAt));

        if (hasStaleData && snapshot.fetchedAt) {
            embed.addFields({
                name: 'LAST SUCCESSFUL UPDATE',
                value: `<t:${Math.floor(snapshot.fetchedAt / 1000)}:f> · <t:${Math.floor(snapshot.fetchedAt / 1000)}:R>`,
                inline: false
            });
        }

        const components = [];
        const actionRow = new ActionRowBuilder();
        if (hasFreshData && typeof data.JoinKey === 'string' && data.JoinKey) {
            const joinUrl = getJoinUrl();
            if (joinUrl) {
                actionRow.addComponents(new ButtonBuilder()
                    .setLabel('Join Server')
                    .setStyle(ButtonStyle.Link)
                    .setURL(joinUrl));
            } else {
                actionRow.addComponents(new ButtonBuilder()
                    .setCustomId('erlc_show_join_code')
                    .setLabel('Show Join Code')
                    .setStyle(ButtonStyle.Primary));
            }
        }
        actionRow.addComponents(new ButtonBuilder()
            .setCustomId('erlc_refresh_status')
            .setLabel('Refresh Status')
            .setStyle(ButtonStyle.Secondary));
        components.push(actionRow);

        return {
            embeds: [banner, embed],
            components,
            files,
            allowedMentions: { parse: [] }
        };
    }

    static async handleButton(interaction) {
        await interaction.deferReply({ ephemeral: true });
        try {
            const isBotStatusMessage = interaction.message.author?.id === interaction.client.user.id
                && interaction.message.embeds.some(embed =>
                    embed.title === 'ER:LC LIVE SERVER STATUS'
                    || embed.data?.title === 'ER:LC LIVE SERVER STATUS'
                );
            if (!isBotStatusMessage || !interaction.guildId) {
                return interaction.editReply({ content: 'This ER:LC status action is no longer valid.' });
            }
            const snapshot = await this.refreshStatus();
            if (interaction.customId === 'erlc_show_join_code') {
                if (!snapshot.data?.JoinKey
                    || snapshot.state !== 'AVAILABLE') {
                    return interaction.editReply({
                        content: 'A current join code is not available. Check the status panel for the latest server state.'
                    });
                }
                return interaction.editReply({
                    content: `Current ER:LC join code for **${snapshot.data.Name || 'the NYSRP server'}**: \`${snapshot.data.JoinKey.replace(/`/g, '\\`')}\`\nOpen ER:LC in Roblox and use this code to join.`,
                    allowedMentions: { parse: [] }
                });
            }

            if (interaction.customId !== 'erlc_refresh_status') {
                return interaction.editReply({ content: 'This ER:LC status action is not recognized.' });
            }
            const refreshed = await this.refreshStatus(true);
            await interaction.message.edit(this.buildPayload(refreshed));
            return interaction.editReply({
                content: refreshed.state === 'AVAILABLE'
                    ? 'The ER:LC status panel has been refreshed.'
                    : `The status panel was refreshed and now shows ${refreshed.state.toLowerCase().replace('_', ' ')}.`
            });
        } catch (error) {
            logger.error('[ER:LC] Could not handle status panel action:', error);
            return interaction.editReply({
                content: 'The status action could not be completed. Check the bot logs for details.'
            });
        }
    }

    static async setupPanel(channel) {
        if (!config.erlc.serverKey) {
            throw new Error('ER:LC integration is not configured. Set ERLC_SERVER_KEY before creating a status panel.');
        }
        const snapshot = await this.refreshStatus();
        const existing = db.prepare(`
            SELECT * FROM erlc_status_panels WHERE guild_id = ?
        `).get(channel.guild.id);
        if (existing?.channel_id === channel.id) {
            try {
                const message = await channel.messages.fetch(existing.message_id);
                await message.edit(this.buildPayload(snapshot));
                db.prepare('UPDATE erlc_status_panels SET updated_at = ? WHERE guild_id = ?')
                    .run(Date.now(), channel.guild.id);
                return { messageId: message.id, replaced: false };
            } catch (error) {
                if (error.code !== 10008) throw error;
            }
        }

        const message = await channel.send(this.buildPayload(snapshot));
        try {
            db.prepare(`
                INSERT INTO erlc_status_panels (guild_id, channel_id, message_id, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(guild_id) DO UPDATE SET
                    channel_id = excluded.channel_id,
                    message_id = excluded.message_id,
                    updated_at = excluded.updated_at
            `).run(channel.guild.id, channel.id, message.id, Date.now());
        } catch (error) {
            try {
                await message.delete('ER:LC status panel could not be recorded');
            } catch (cleanupError) {
                logger.error(`[ER:LC] Could not remove untracked status panel ${message.id}:`, cleanupError);
            }
            throw new Error(`The status panel was posted but could not be recorded: ${error.message}`);
        }
        if (existing && existing.message_id !== message.id) {
            try {
                const oldChannel = await channel.client.channels.fetch(existing.channel_id);
                const oldMessage = await oldChannel.messages.fetch(existing.message_id);
                await oldMessage.delete('ER:LC status panel moved');
            } catch (error) {
                if (error.code !== 10008 && error.code !== 10003) {
                    logger.warn(`[ER:LC] Could not remove the previous status panel ${existing.message_id}: ${error.message}`);
                }
            }
        }
        return { messageId: message.id, replaced: Boolean(existing) };
    }

    static async updatePanels(client, snapshot) {
        const panels = db.prepare('SELECT * FROM erlc_status_panels').all();
        for (const panel of panels) {
            try {
                const channel = await client.channels.fetch(panel.channel_id);
                if (!channel?.messages) throw new Error(`Status channel ${panel.channel_id} is unavailable.`);
                let message;
                try {
                    message = await channel.messages.fetch(panel.message_id);
                } catch (error) {
                    if (error.code !== 10008) throw error;
                }
                if (message) {
                    await message.edit(this.buildPayload(snapshot));
                    db.prepare('UPDATE erlc_status_panels SET updated_at = ? WHERE guild_id = ?')
                        .run(Date.now(), panel.guild_id);
                } else {
                    message = await channel.send(this.buildPayload(snapshot));
                    try {
                        const result = db.prepare(`
                            UPDATE erlc_status_panels SET message_id = ?, updated_at = ?
                            WHERE guild_id = ?
                        `).run(message.id, Date.now(), panel.guild_id);
                        if (result.changes !== 1) {
                            throw new Error(`Status panel record for guild ${panel.guild_id} no longer exists.`);
                        }
                    } catch (error) {
                        try {
                            await message.delete('ER:LC status panel could not be recorded');
                        } catch (cleanupError) {
                            logger.error(`[ER:LC] Could not remove untracked replacement panel ${message.id}:`, cleanupError);
                        }
                        throw error;
                    }
                }
            } catch (error) {
                logger.error(`[ER:LC] Could not update status panel for guild ${panel.guild_id}:`, error);
            }
        }
    }

    static async startScheduler(client) {
        if (!config.erlc.serverKey) {
            logger.warn('[ER:LC] Status polling is disabled because ERLC_SERVER_KEY is not configured.');
            return;
        }
        const refresh = async () => {
            const snapshot = await this.refreshStatus();
            await this.updatePanels(client, snapshot);
        };
        await refresh();
        if (!schedulerTimer) {
            schedulerTimer = setInterval(() => {
                refresh().catch(error => {
                    logger.error('[ER:LC] Status polling cycle failed:', error);
                });
            }, POLL_INTERVAL_MS);
            schedulerTimer.unref?.();
        }
    }
}

module.exports = ERLCService;
