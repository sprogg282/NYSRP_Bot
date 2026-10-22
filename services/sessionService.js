const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const db = require('../database/db');
const config = require('../config');
const { createNYSRPEmbed, createSuccessEmbed, createErrorEmbed } = require('../utils/embedBuilder');
const { getValidatedChannel } = require('../utils/channelValidator');
const { getImage } = require('../utils/imageManager');
const logger = require('../utils/logger');

let notificationRetryTimer = null;
let retryingNotifications = false;
let retryingVoteMessages = false;
const pendingVoteMessageSync = new Set();

class SessionService {
    /**
     * Check if a member has the SSU Permission role (1545826232178839573) or server admin authority
     * @param {GuildMember} member 
     * @returns {boolean}
     */
    static hasSSUPermission(member) {
        if (!member) return false;
        if (member.guild.ownerId === member.id) return true;
        if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

        const ssuRoleId = config.roles.ssuPermission;
        if (ssuRoleId && member.roles.cache.has(ssuRoleId)) return true;

        return false;
    }

    static buildVotePayload(session, passed, imageUrl = null) {
        const requiredVotes = session.required_yes_votes || config.sessionVote.requiredYesVotes;
        const embed = createNYSRPEmbed({
            title: passed ? '𝙉𝙔𝙎𝙍𝙋 𝙎𝙚𝙨𝙨𝙞𝙤𝙣 𝙑𝙤𝙩𝙚 𝙋𝙖𝙨𝙨𝙚𝙙' : '𝙉𝙔𝙎𝙍𝙋 𝙎𝙚𝙨𝙨𝙞𝙤𝙣 𝙑𝙤𝙩𝙚',
            introduction: passed
                ? 'The NYSRP Session Vote has reached the required number of YES votes.'
                : 'A session vote is currently active. Cast your vote below if you would like NYSRP to host a session.',
            sections: [
                {
                    title: passed ? 'Vote Result' : 'Session Vote',
                    items: [
                        `✅ **Yes:** ${session.yes_votes}`,
                        `❌ **No:** ${session.no_votes}`,
                        `🎯 **Required:** ${requiredVotes}`
                    ]
                },
                {
                    title: 'Status',
                    items: [passed ? '🟢 **Vote Passed — Awaiting Staff SSU Start**' : '🟡 **Voting in Progress**']
                },
                {
                    title: 'Started By',
                    items: [`<@${session.started_by}>`]
                }
            ],
            closing: passed
                ? 'The vote has passed. An authorized staff member must manually start the SSU.'
                : 'You may only vote once.',
            color: config.branding.color
        });
        if (imageUrl) embed.setImage(imageUrl);

        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`session_vote_yes_${session.session_id}`)
                .setLabel('Yes')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅')
                .setDisabled(passed),
            new ButtonBuilder()
                .setCustomId(`session_vote_no_${session.session_id}`)
                .setLabel('No')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('❌')
                .setDisabled(passed)
        );
        return { embeds: [embed], components: [buttons] };
    }

    static async sendVotePassedNotice(session, client) {
        const channel = await client.channels.fetch(session.channel_id);
        if (!channel || typeof channel.send !== 'function') {
            throw new Error(`The session channel ${session.channel_id} is unavailable.`);
        }
        const rolePing = `<@&${config.roles.ssuPermission}>`;
        const notice = createNYSRPEmbed({
            title: '𝙎𝙚𝙨𝙨𝙞𝙤𝙣 𝙑𝙤𝙩𝙚 𝙋𝙖𝙨𝙨𝙚𝙙',
            introduction: 'The NYSRP Session Vote has reached the required number of YES votes.',
            important: 'The SSU is ready to be started. An authorized staff member must manually use `/session ssu-start`.',
            sections: [
                {
                    title: 'Vote Result',
                    items: [
                        `✅ **Yes:** ${session.yes_votes}`,
                        `❌ **No:** ${session.no_votes}`,
                        `🎯 **Required:** ${session.required_yes_votes || config.sessionVote.requiredYesVotes}`
                    ]
                },
                {
                    title: 'Action Required',
                    items: [
                        rolePing,
                        'An authorized staff member with the SSU Permission role must manually run `/session ssu-start`.'
                    ]
                }
            ],
            closing: 'The SSU has NOT been started automatically.',
            color: config.branding.color
        });
        await channel.send({
            content: rolePing,
            embeds: [notice],
            allowedMentions: { roles: [config.roles.ssuPermission] }
        });
        db.prepare('UPDATE sessions SET vote_passed_notified = 1 WHERE session_id = ?')
            .run(session.session_id);
    }

    /**
     * Check cooldown and active session state
     * @param {string} guildId 
     * @returns {{ canStart: boolean, remainingMinutes: number, reason: string|null }}
     */
    static checkCooldownAndActiveState(guildId) {
        const activeSession = db.prepare(`
            SELECT * FROM sessions 
            WHERE guild_id = ? AND status IN (
                'VOTING', 'VOTE_PASSED', 'SSU_STARTING', 'SSU_ACTIVE', 'SSU_ENDING'
            )
            ORDER BY session_id DESC LIMIT 1
        `).get(guildId);

        if (activeSession) {
            let stateLabel = 'active vote';
            if (activeSession.status === 'VOTE_PASSED') stateLabel = 'passed vote awaiting SSU start';
            if (activeSession.status === 'SSU_STARTING') stateLabel = 'SSU start in progress';
            if (activeSession.status === 'SSU_ACTIVE' || activeSession.status === 'SSU_ENDING') stateLabel = 'active SSU';
            return {
                canStart: false,
                remainingMinutes: 0,
                reason: `There is currently an ${stateLabel} for this server (Session ID: #${activeSession.session_id}). End the current session using \`/session end\` before starting a new one.`
            };
        }

        const lastSession = db.prepare(`
            SELECT * FROM sessions 
            WHERE guild_id = ? 
            ORDER BY session_id DESC LIMIT 1
        `).get(guildId);

        if (lastSession) {
            const lastTime = lastSession.session_ended_at || lastSession.ssu_ended_at || lastSession.vote_started_at;
            const cooldownMs = config.sessionVote.cooldownMinutes * 60 * 1000;
            const elapsed = Date.now() - lastTime;

            if (elapsed < cooldownMs) {
                const remainingMinutes = Math.ceil((cooldownMs - elapsed) / 60000);
                return {
                    canStart: false,
                    remainingMinutes,
                    reason: `The Session Vote is currently on cooldown. Please wait **${remainingMinutes} minute(s)** before starting a new vote.`
                };
            }
        }

        return { canStart: true, remainingMinutes: 0, reason: null };
    }

    /**
     * Start a new Session Vote
     */
    static async startVote(guild, member) {
        if (!this.hasSSUPermission(member)) {
            return {
                success: false,
                embed: createErrorEmbed('Permission Denied', `You require the <@&${config.roles.ssuPermission}> role to start a session vote.`)
            };
        }

        const sessionChannel = await getValidatedChannel(guild, config.channels.session, 'Session');
        if (!sessionChannel) {
            return {
                success: false,
                embed: createErrorEmbed('Channel Error', `The session channel (${config.channels.session}) is missing or inaccessible.`)
            };
        }

        const timestamp = Date.now();
        const requiredVotes = config.sessionVote.requiredYesVotes;
        const creation = db.transaction(() => {
            const cooldown = this.checkCooldownAndActiveState(guild.id);
            if (!cooldown.canStart) return { cooldown };
            const result = db.prepare(`
                INSERT INTO sessions (
                    guild_id, status, channel_id, started_by, vote_started_at,
                    required_yes_votes, yes_votes, no_votes
                ) VALUES (?, 'VOTING', ?, ?, ?, ?, 0, 0)
            `).run(guild.id, sessionChannel.id, member.id, timestamp, requiredVotes);
            return { sessionId: Number(result.lastInsertRowid) };
        })();
        if (creation.cooldown) {
            return {
                success: false,
                embed: createErrorEmbed('Session Start Blocked', creation.cooldown.reason)
            };
        }

        const sessionId = creation.sessionId;
        let voteMessage = null;
        try {
            const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
            const payload = this.buildVotePayload(session, false);
            const voteImage = getImage('sessionVote');
            if (voteImage) {
                payload.embeds[0].setImage(voteImage.url);
                payload.files = [voteImage.attachment];
            }
            voteMessage = await sessionChannel.send(payload);
            const result = db.prepare(`
                UPDATE sessions SET vote_message_id = ?
                WHERE session_id = ? AND status = 'VOTING'
            `).run(voteMessage.id, sessionId);
            if (result.changes !== 1) {
                throw new Error('The vote was posted, but its database record could not be finalized.');
            }
        } catch (error) {
            if (voteMessage) {
                try {
                    await voteMessage.delete('Session vote could not be recorded');
                } catch (cleanupError) {
                    logger.error(`[Session] Could not remove untracked vote message ${voteMessage.id}:`, cleanupError);
                }
            }
            db.prepare(`
                UPDATE sessions SET status = 'CLOSED', session_ended_at = ?
                WHERE session_id = ? AND status = 'VOTING'
            `).run(Date.now(), sessionId);
            logger.error(`[Session] Could not publish vote #${sessionId}:`, error);
            return {
                success: false,
                embed: createErrorEmbed('Session Vote Failed', `The session vote could not be posted. The incomplete vote was closed. ${error.message}`)
            };
        }

        return {
            success: true,
            embed: createSuccessEmbed(
                'Session Vote Started',
                `The NYSRP Session Vote **#${sessionId}** has been successfully posted to <#${sessionChannel.id}>.`,
                null,
                [
                    {
                        title: 'Vote Details',
                        items: [
                            `**Session ID:** #${sessionId}`,
                            `**Required YES Votes:** ${requiredVotes}`,
                            `**Channel:** <#${sessionChannel.id}>`
                        ]
                    }
                ]
            )
        };
    }

    /**
     * Process member vote submission
     */
    static async processVote(interaction, voteChoice) {
        await interaction.deferReply({ ephemeral: true });
        const match = interaction.customId.match(/^session_vote_(yes|no)_(\d+)$/);
        const sessionId = match ? Number(match[2]) : NaN;
        if (!Number.isSafeInteger(sessionId)
            || !['YES', 'NO'].includes(voteChoice)
            || match[1].toUpperCase() !== voteChoice) {
            return interaction.editReply({
                embeds: [createErrorEmbed('Invalid Session Vote', 'This vote control is not valid.') ]
            });
        }

        let session;
        try {
            session = db.transaction(() => {
                const current = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
                if (!current
                    || current.guild_id !== interaction.guildId
                    || current.channel_id !== interaction.channelId
                    || current.vote_message_id !== interaction.message.id) {
                    throw new Error('This session vote message is no longer valid.');
                }
                if (current.status !== 'VOTING') {
                    throw new Error('Voting for this session has ended or the vote has already passed.');
                }
                if (db.prepare(`
                    SELECT 1 FROM session_voters WHERE session_id = ? AND user_id = ?
                `).get(sessionId, interaction.user.id)) {
                    throw new Error('You have already cast a vote for this session. You may only vote once.');
                }

                const timestamp = Date.now();
                db.prepare(`
                    INSERT INTO session_voters (session_id, user_id, vote_choice, voted_at)
                    VALUES (?, ?, ?, ?)
                `).run(sessionId, interaction.user.id, voteChoice, timestamp);
                const yesVotes = current.yes_votes + (voteChoice === 'YES' ? 1 : 0);
                const noVotes = current.no_votes + (voteChoice === 'NO' ? 1 : 0);
                const requiredVotes = current.required_yes_votes || config.sessionVote.requiredYesVotes;
                const passed = yesVotes >= requiredVotes;
                const update = db.prepare(`
                    UPDATE sessions
                    SET yes_votes = ?, no_votes = ?,
                        status = ?, vote_passed_at = CASE WHEN ? THEN ? ELSE vote_passed_at END
                    WHERE session_id = ? AND status = 'VOTING'
                `).run(
                    yesVotes,
                    noVotes,
                    passed ? 'VOTE_PASSED' : 'VOTING',
                    passed ? 1 : 0,
                    timestamp,
                    sessionId
                );
                if (update.changes !== 1) {
                    throw new Error('Voting has already ended for this session.');
                }
                return {
                    ...current,
                    yes_votes: yesVotes,
                    no_votes: noVotes,
                    status: passed ? 'VOTE_PASSED' : 'VOTING'
                };
            })();
        } catch (error) {
            return interaction.editReply({
                embeds: [createErrorEmbed('Vote Rejected', error.message)]
            });
        }

        let messageUpdated = true;
        try {
            await interaction.message.edit(this.buildVotePayload(
                session,
                session.status === 'VOTE_PASSED',
                interaction.message.embeds[0]?.image?.url
            ));
            pendingVoteMessageSync.delete(sessionId);
        } catch (error) {
            messageUpdated = false;
            pendingVoteMessageSync.add(sessionId);
            logger.warn(`[Session] Vote #${sessionId} was recorded, but its message could not be updated: ${error.message}`);
        }

        let notificationPending = false;
        if (session.status === 'VOTE_PASSED' && !session.vote_passed_notified) {
            try {
                await this.sendVotePassedNotice(session, interaction.client);
            } catch (error) {
                notificationPending = true;
                logger.error(`[Session] Vote #${sessionId} passed, but the SSU notification could not be delivered:`, error);
            }
        }

        const response = session.status === 'VOTE_PASSED'
            ? `Your vote (**${voteChoice}**) was counted. Session Vote #${sessionId} has passed.`
            : `Your vote (**${voteChoice}**) has been counted for Session Vote #${sessionId}.`;
        const details = [];
        if (!messageUpdated) details.push('The public vote display could not be refreshed.');
        if (notificationPending) details.push('The staff notification is pending automatic retry.');
        return interaction.editReply({
            embeds: [createSuccessEmbed(
                session.status === 'VOTE_PASSED' ? 'Vote Passed!' : 'Vote Recorded',
                details.length ? `${response}\n\n${details.join(' ')}` : response
            )]
        });
    }

    /**
     * Manually start SSU (requires SSU Permission role & VOTE_PASSED status)
     */
    static async ssuStart(guild, member) {
        if (!this.hasSSUPermission(member)) {
            return {
                success: false,
                embed: createErrorEmbed('Permission Denied', `You require the <@&${config.roles.ssuPermission}> role to manually start the SSU.`)
            };
        }

        const session = db.prepare(`
            SELECT * FROM sessions 
            WHERE guild_id = ? AND status != 'CLOSED'
            ORDER BY session_id DESC LIMIT 1
        `).get(guild.id);

        if (!session) {
            return {
                success: false,
                embed: createErrorEmbed('No Active Session', 'There is no active session vote. Start one using `/session start`.')
            };
        }

        if (session.status === 'VOTING') {
            return {
                success: false,
                embed: createNYSRPEmbed({
                    title: '𝙎𝙎𝙐 𝙉𝙤𝙩 𝙍𝙚𝙖𝙙𝙮',
                    introduction: 'The Session Vote has not reached the required number of YES votes.',
                    sections: [
                        {
                            title: 'Current Vote',
                            items: [
                                `✅ **Yes:** ${session.yes_votes}`,
                                `❌ **No:** ${session.no_votes}`,
                                `🎯 **Required:** ${session.required_yes_votes}`
                            ]
                        }
                    ],
                    closing: 'Wait until the vote reaches 5 YES votes before attempting `/session ssu-start`.',
                    color: config.branding.color
                })
            };
        }

        if (session.status === 'SSU_ACTIVE') {
            return {
                success: false,
                embed: createErrorEmbed('SSU Already Active', 'The SSU is already active for this session.')
            };
        }

        if (session.status !== 'VOTE_PASSED') {
            return {
                success: false,
                embed: createErrorEmbed('Invalid Session State', `Cannot start SSU from state \`${session.status}\`.`)
            };
        }

        const timestamp = Date.now();

        const dateString = `<t:${Math.floor(timestamp / 1000)}:F>`;

        const ssuAnnouncementEmbed = createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝙎𝙎𝙐 𝙃𝙖𝙨 𝙎𝙩𝙖𝙧𝙩𝙚𝙙',
            introduction: 'The NYSRP session has officially started.',
            sections: [
                {
                    title: 'Session Information',
                    items: [
                        '🟢 **Status:** SSU Active',
                        `👮 **Started By:** <@${member.id}>`,
                        `🕐 **Started:** ${dateString}`
                    ]
                }
            ],
            closing: 'Please follow all NYSRP and ER:LC rules during the session.',
            color: config.branding.color // #FD8701
        });
        const sessionStartImage = getImage('sessionStart');
        const sessionStartFiles = [];
        if (sessionStartImage) {
            ssuAnnouncementEmbed.setImage(sessionStartImage.url);
            sessionStartFiles.push(sessionStartImage.attachment);
        }

        const sessionChannel = await getValidatedChannel(guild, config.channels.session, 'Session');
        if (!sessionChannel) {
            return {
                success: false,
                embed: createErrorEmbed('Channel Error', `The session channel (${config.channels.session}) is missing or inaccessible. The SSU was not started.`)
            };
        }

        const reservation = db.prepare(`
            UPDATE sessions SET status = 'SSU_STARTING'
            WHERE session_id = ? AND status = 'VOTE_PASSED'
        `).run(session.session_id);
        if (reservation.changes !== 1) {
            return {
                success: false,
                embed: createErrorEmbed('Session Changed', 'The session state changed before the SSU could start. Check `/session status` and try again if appropriate.')
            };
        }

        try {
            await sessionChannel.send({ embeds: [ssuAnnouncementEmbed], files: sessionStartFiles });
        } catch (error) {
            db.prepare(`
                UPDATE sessions SET status = 'VOTE_PASSED'
                WHERE session_id = ? AND status = 'SSU_STARTING'
            `).run(session.session_id);
            logger.error(`[Session] Could not announce SSU start for session #${session.session_id}:`, error);
            return {
                success: false,
                embed: createErrorEmbed('SSU Start Failed', `The start announcement could not be sent, so the SSU remains ready to start. ${error.message}`)
            };
        }

        const started = db.prepare(`
            UPDATE sessions
            SET status = 'SSU_ACTIVE', ssu_started_by = ?, ssu_started_at = ?
            WHERE session_id = ? AND status = 'SSU_STARTING'
        `).run(member.id, timestamp, session.session_id);
        if (started.changes !== 1) {
            throw new Error(`SSU start announcement was sent, but session #${session.session_id} could not be finalized.`);
        }

        return {
            success: true,
            embed: createSuccessEmbed(
                'SSU Started',
                `Official SSU for Session **#${session.session_id}** has been started.`,
                null,
                [
                    {
                        title: 'SSU Details',
                        items: [
                            `**Session ID:** #${session.session_id}`,
                            `**Started By:** <@${member.id}>`,
                            `**Started At:** ${dateString}`
                        ]
                    }
                ]
            )
        };
    }

    /**
     * End active SSU
     */
    static async ssuEnd(guild, member) {
        if (!this.hasSSUPermission(member)) {
            return {
                success: false,
                embed: createErrorEmbed('Permission Denied', `You require the <@&${config.roles.ssuPermission}> role to end the SSU.`)
            };
        }

        const session = db.prepare(`
            SELECT * FROM sessions 
            WHERE guild_id = ? AND status = 'SSU_ACTIVE'
            ORDER BY session_id DESC LIMIT 1
        `).get(guild.id);

        if (!session) {
            return {
                success: false,
                embed: createErrorEmbed('No Active SSU', 'There is currently no active SSU to end.')
            };
        }

        const timestamp = Date.now();
        const durationMinutes = Math.max(1, Math.floor((timestamp - (session.ssu_started_at || timestamp)) / 60000));

        const startDateStr = `<t:${Math.floor((session.ssu_started_at || timestamp) / 1000)}:F>`;
        const endDateStr = `<t:${Math.floor(timestamp / 1000)}:F>`;

        const ssuEndAnnouncementEmbed = createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝙎𝙎𝙐 𝙀𝙣𝙙𝙚𝙙',
            introduction: 'The NYSRP session has officially ended.',
            sections: [
                {
                    title: 'Session Information',
                    items: [
                        '🔴 **Status:** Session Ended',
                        `👮 **Started By:** <@${session.ssu_started_by || member.id}>`,
                        `🛑 **Ended By:** <@${member.id}>`,
                        `🕐 **Started:** ${startDateStr}`,
                        `🕐 **Ended:** ${endDateStr}`,
                        `⏱️ **Duration:** ${durationMinutes} minutes`
                    ]
                }
            ],
            closing: "Thank you for participating in today's NYSRP session.",
            color: config.branding.color // #FD8701
        });
        const sessionEndImage = getImage('sessionEnd');
        const sessionEndFiles = [];
        if (sessionEndImage) {
            ssuEndAnnouncementEmbed.setImage(sessionEndImage.url);
            sessionEndFiles.push(sessionEndImage.attachment);
        }

        const sessionChannel = await getValidatedChannel(guild, config.channels.session, 'Session');
        if (!sessionChannel) {
            return {
                success: false,
                embed: createErrorEmbed('Channel Error', `The session channel (${config.channels.session}) is missing or inaccessible. The SSU remains active.`)
            };
        }

        const reservation = db.prepare(`
            UPDATE sessions SET status = 'SSU_ENDING'
            WHERE session_id = ? AND status = 'SSU_ACTIVE'
        `).run(session.session_id);
        if (reservation.changes !== 1) {
            return {
                success: false,
                embed: createErrorEmbed('Session Changed', 'The session state changed before the SSU could end. Check `/session status` and try again if appropriate.')
            };
        }

        try {
            await sessionChannel.send({ embeds: [ssuEndAnnouncementEmbed], files: sessionEndFiles });
        } catch (error) {
            db.prepare(`
                UPDATE sessions SET status = 'SSU_ACTIVE'
                WHERE session_id = ? AND status = 'SSU_ENDING'
            `).run(session.session_id);
            logger.error(`[Session] Could not announce SSU end for session #${session.session_id}:`, error);
            return {
                success: false,
                embed: createErrorEmbed('SSU End Failed', `The end announcement could not be sent, so the SSU remains active. ${error.message}`)
            };
        }

        const ended = db.prepare(`
            UPDATE sessions
            SET status = 'SSU_ENDED', ssu_ended_by = ?, ssu_ended_at = ?
            WHERE session_id = ? AND status = 'SSU_ENDING'
        `).run(member.id, timestamp, session.session_id);
        if (ended.changes !== 1) {
            throw new Error(`SSU end announcement was sent, but session #${session.session_id} could not be finalized.`);
        }

        return {
            success: true,
            embed: createSuccessEmbed(
                'SSU Ended',
                `Session **#${session.session_id}** SSU has been ended.`,
                null,
                [
                    {
                        title: 'Summary',
                        items: [
                            `**Session ID:** #${session.session_id}`,
                            `**Duration:** ${durationMinutes} minutes`,
                            `**Ended By:** <@${member.id}>`
                        ]
                    }
                ]
            )
        };
    }

    /**
     * Fully close session
     */
    static async endSession(guild, member) {
        if (!this.hasSSUPermission(member)) {
            return {
                success: false,
                embed: createErrorEmbed('Permission Denied', `You require the <@&${config.roles.ssuPermission}> role to close a session.`)
            };
        }

        const session = db.prepare(`
            SELECT * FROM sessions 
            WHERE guild_id = ? AND status != 'CLOSED'
            ORDER BY session_id DESC LIMIT 1
        `).get(guild.id);

        if (!session) {
            return {
                success: false,
                embed: createErrorEmbed('No Active Session', 'There is no active session to close.')
            };
        }
        if (!['VOTING', 'VOTE_PASSED', 'SSU_ACTIVE', 'SSU_ENDED'].includes(session.status)) {
            return {
                success: false,
                embed: createErrorEmbed('Session Transition In Progress', `Session #${session.session_id} is currently ${session.status.toLowerCase()}. Wait for that transition to finish before closing it.`)
            };
        }

        const timestamp = Date.now();
        const result = db.prepare(`
            UPDATE sessions 
            SET status = 'CLOSED', session_ended_at = ?
            WHERE session_id = ? AND status = ?
        `).run(timestamp, session.session_id, session.status);
        if (result.changes !== 1) {
            return {
                success: false,
                embed: createErrorEmbed('Session Changed', 'The session changed before it could be closed. Check `/session status` and try again.')
            };
        }

        return {
            success: true,
            embed: createSuccessEmbed(
                'Session Closed',
                `Session **#${session.session_id}** has been fully closed and archived.`,
                null,
                [
                    {
                        title: 'Closed Session Details',
                        items: [
                            `**Session ID:** #${session.session_id}`,
                            `**Previous Status:** ${session.status}`,
                            `**Closed By:** <@${member.id}>`
                        ]
                    }
                ],
                'Cooldown period of 30 minutes is now active.'
            )
        };
    }

    /**
     * Get detailed session status
     */
    static getStatus(guild) {
        const session = db.prepare(`
            SELECT * FROM sessions 
            WHERE guild_id = ? AND status != 'CLOSED'
            ORDER BY session_id DESC LIMIT 1
        `).get(guild.id);

        if (!session) {
            return createNYSRPEmbed({
                title: '𝙉𝙔𝙎𝙍𝙋 𝙎𝙚𝙨𝙨𝙞𝙤𝙣 𝙎𝙩𝙖𝙩𝙪𝙨',
                introduction: 'Here is the current NYSRP session status.',
                sections: [
                    {
                        title: 'Status',
                        items: ['⚪ **No Session Active**']
                    }
                ],
                closing: 'Use `/session start` to initiate a new session vote.',
                color: config.branding.color
            });
        }

        const statusMap = {
            VOTING: '🟡 **Voting in Progress**',
            VOTE_PASSED: '🟢 **Vote Passed — Awaiting Staff SSU Start**',
            SSU_STARTING: '🟡 **SSU Start In Progress**',
            SSU_ACTIVE: '🟢 **SSU Active**',
            SSU_ENDING: '🟡 **SSU End In Progress**',
            SSU_ENDED: '🔴 **SSU Ended**'
        };

        const displayStatus = statusMap[session.status] || session.status;
        const requiredVotes = session.required_yes_votes || config.sessionVote.requiredYesVotes;

        const infoItems = [
            `**Session ID:** #${session.session_id}`,
            `**Started By:** <@${session.started_by}>`,
            `**Vote Started:** <t:${Math.floor(session.vote_started_at / 1000)}:R>`,
            `**YES Votes:** ${session.yes_votes}/${requiredVotes}`,
            `**NO Votes:** ${session.no_votes}`
        ];

        if (session.ssu_started_at) {
            infoItems.push(`**SSU Started By:** <@${session.ssu_started_by}>`);
            infoItems.push(`**SSU Started:** <t:${Math.floor(session.ssu_started_at / 1000)}:R>`);
        }

        if (session.ssu_ended_at) {
            const duration = Math.max(1, Math.floor((session.ssu_ended_at - session.ssu_started_at) / 60000));
            infoItems.push(`**SSU Duration:** ${duration} minutes`);
        }

        return createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝙎𝙚𝙨𝙨𝙞𝙤𝙣 𝙎𝙩𝙖𝙩𝙪𝙨',
            introduction: 'Here is the current NYSRP session status.',
            sections: [
                {
                    title: 'Status',
                    items: [displayStatus]
                },
                {
                    title: 'Session Information',
                    items: infoItems
                }
            ],
            closing: 'New York State Roleplay Operations Directory.',
            color: config.branding.color
        });
    }

    /**
     * Recover active sessions on bot restart
     */
    static async syncVoteMessage(client, session) {
        if (!['VOTING', 'VOTE_PASSED'].includes(session.status)) return;
        const channel = await client.channels.fetch(session.channel_id);
        if (!channel || !channel.messages) {
            throw new Error(`Session channel ${session.channel_id} is unavailable.`);
        }

        let message = null;
        if (session.vote_message_id) {
            try {
                message = await channel.messages.fetch(session.vote_message_id);
            } catch (error) {
                if (error.code !== 10008) throw error;
            }
        }

        const passed = session.status === 'VOTE_PASSED';
        if (message) {
            await message.edit(this.buildVotePayload(
                session,
                passed,
                message.embeds[0]?.image?.url
            ));
            pendingVoteMessageSync.delete(session.session_id);
            return;
        }

        const payload = this.buildVotePayload(session, passed);
        const voteImage = getImage('sessionVote');
        if (voteImage) {
            payload.embeds[0].setImage(voteImage.url);
            payload.files = [voteImage.attachment];
        }
        message = await channel.send(payload);
        const result = db.prepare(`
            UPDATE sessions SET vote_message_id = ?
            WHERE session_id = ? AND status IN ('VOTING', 'VOTE_PASSED')
        `).run(message.id, session.session_id);
        if (result.changes !== 1) {
            try {
                await message.delete('Session vote state changed during recovery');
            } catch (error) {
                logger.error(`[Session Recovery] Could not delete replacement vote message ${message.id}:`, error);
            }
            throw new Error(`Session #${session.session_id} changed while its vote message was being restored.`);
        }
        pendingVoteMessageSync.delete(session.session_id);
    }

    static async retryPendingVoteMessages(client) {
        if (retryingVoteMessages || pendingVoteMessageSync.size === 0) return;
        retryingVoteMessages = true;
        try {
            for (const sessionId of pendingVoteMessageSync) {
                const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
                if (!session || !['VOTING', 'VOTE_PASSED'].includes(session.status)) {
                    pendingVoteMessageSync.delete(sessionId);
                    continue;
                }
                try {
                    await this.syncVoteMessage(client, session);
                } catch (error) {
                    logger.error(`[Session Recovery] Vote message sync is still pending for session #${sessionId}:`, error);
                }
            }
        } finally {
            retryingVoteMessages = false;
        }
    }

    static async retryPendingVoteNotifications(client) {
        if (retryingNotifications) return;
        retryingNotifications = true;
        try {
            const pending = db.prepare(`
                SELECT * FROM sessions
                WHERE vote_passed_at IS NOT NULL AND vote_passed_notified = 0
                ORDER BY vote_passed_at
                LIMIT 25
            `).all();
            for (const session of pending) {
                try {
                    await this.sendVotePassedNotice(session, client);
                    logger.info(`[Session Recovery] Delivered pending pass notification for session #${session.session_id}.`);
                } catch (error) {
                    logger.error(`[Session Recovery] Pass notification is still pending for session #${session.session_id}:`, error);
                }
            }
        } finally {
            retryingNotifications = false;
        }
    }

    static async recoverActiveSessions(client) {
        const recoveredStarting = db.prepare(`
            UPDATE sessions
            SET status = 'VOTE_PASSED'
            WHERE status = 'SSU_STARTING'
        `).run().changes;
        const recoveredEnding = db.prepare(`
            UPDATE sessions
            SET status = 'SSU_ACTIVE'
            WHERE status = 'SSU_ENDING'
        `).run().changes;
        const activeSessions = db.prepare(`
            SELECT * FROM sessions
            WHERE status IN ('VOTING', 'VOTE_PASSED', 'SSU_ACTIVE')
            ORDER BY session_id
        `).all();

        logger.info(
            `[Session Recovery] Restored ${activeSessions.length} active session(s); `
            + `recovered ${recoveredStarting} interrupted start(s) and ${recoveredEnding} interrupted end(s).`
        );

        for (const session of activeSessions) {
            try {
                await this.syncVoteMessage(client, session);
            } catch (error) {
                pendingVoteMessageSync.add(session.session_id);
                logger.error(`[Session Recovery] Could not restore vote message for session #${session.session_id}:`, error);
            }
        }
        await this.retryPendingVoteNotifications(client);
        return activeSessions.length;
    }

    static startNotificationRetry(client) {
        if (notificationRetryTimer) return;
        notificationRetryTimer = setInterval(() => {
            Promise.all([
                this.retryPendingVoteNotifications(client),
                this.retryPendingVoteMessages(client)
            ]).catch(error => logger.error('[Session Recovery] Pending session recovery retry failed:', error));
        }, 30000);
        notificationRetryTimer.unref?.();
    }
}

module.exports = SessionService;
