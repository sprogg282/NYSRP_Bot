const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const db = require('../database/db');
const config = require('../config');
const { createNYSRPEmbed, createSuccessEmbed, createErrorEmbed } = require('../utils/embedBuilder');
const { getValidatedChannel } = require('../utils/channelValidator');
const { getImage } = require('../utils/imageManager');
const logger = require('../utils/logger');

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

    /**
     * Check cooldown and active session state
     * @param {string} guildId 
     * @returns {{ canStart: boolean, remainingMinutes: number, reason: string|null }}
     */
    static checkCooldownAndActiveState(guildId) {
        const activeSession = db.prepare(`
            SELECT * FROM sessions 
            WHERE guild_id = ? AND status IN ('VOTING', 'VOTE_PASSED', 'SSU_ACTIVE')
            ORDER BY session_id DESC LIMIT 1
        `).get(guildId);

        if (activeSession) {
            let stateLabel = 'active vote';
            if (activeSession.status === 'VOTE_PASSED') stateLabel = 'passed vote awaiting SSU start';
            if (activeSession.status === 'SSU_ACTIVE') stateLabel = 'active SSU';
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

        const cooldown = this.checkCooldownAndActiveState(guild.id);
        if (!cooldown.canStart) {
            return {
                success: false,
                embed: createErrorEmbed('Session Start Blocked', cooldown.reason)
            };
        }

        const timestamp = Date.now();
        const requiredVotes = config.sessionVote.requiredYesVotes; // 5

        // Insert into DB
        const result = db.prepare(`
            INSERT INTO sessions (guild_id, status, channel_id, started_by, vote_started_at, required_yes_votes, yes_votes, no_votes)
            VALUES (?, 'VOTING', ?, ?, ?, ?, 0, 0)
        `).run(guild.id, config.channels.session, member.id, timestamp, requiredVotes);

        const sessionId = result.lastInsertRowid;

        // Build Buttons
        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`session_vote_yes_${sessionId}`).setLabel('Yes').setStyle(ButtonStyle.Success).setEmoji('✅'),
            new ButtonBuilder().setCustomId(`session_vote_no_${sessionId}`).setLabel('No').setStyle(ButtonStyle.Danger).setEmoji('❌')
        );

        // Build Vote Embed
        const voteEmbed = createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝙎𝙚𝙨𝙨𝙞𝙤𝙣 𝙑𝙤𝙩𝙚',
            introduction: 'A session vote is currently active. Cast your vote below if you would like NYSRP to host a session.',
            sections: [
                {
                    title: 'Session Vote',
                    items: [
                        '✅ **Yes:** 0',
                        '❌ **No:** 0',
                        `🎯 **Required:** ${requiredVotes}`
                    ]
                },
                {
                    title: 'Status',
                    items: [
                        '🟡 **Voting in Progress**'
                    ]
                },
                {
                    title: 'Started By',
                    items: [
                        `<@${member.id}>`
                    ]
                }
            ],
            closing: 'You may only vote once.',
            color: config.branding.color // #FD8701
        });
        const voteImage = getImage('sessionVote');
        const voteFiles = [];
        if (voteImage) {
            voteEmbed.setImage(voteImage.url);
            voteFiles.push(voteImage.attachment);
        }

        // Send to Session Channel (1515413881256677496)
        const sessionChannel = await getValidatedChannel(guild, config.channels.session, 'Session');
        if (!sessionChannel) {
            db.prepare("UPDATE sessions SET status = 'CLOSED' WHERE session_id = ?").run(sessionId);
            return {
                success: false,
                embed: createErrorEmbed('Channel Error', `The session channel (${config.channels.session}) is missing or inaccessible.`)
            };
        }

        const voteMsg = await sessionChannel.send({ embeds: [voteEmbed], components: [buttons], files: voteFiles });

        // Update DB with message ID
        db.prepare('UPDATE sessions SET vote_message_id = ? WHERE session_id = ?').run(voteMsg.id, sessionId);

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
        const parts = interaction.customId.split('_'); // session_vote_yes_<sessionId>
        const sessionId = parseInt(parts[3], 10);

        const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
        if (!session) {
            return interaction.reply({
                embeds: [createErrorEmbed('Invalid Session', 'This session vote record was not found.')],
                ephemeral: true
            });
        }

        if (session.status !== 'VOTING') {
            return interaction.reply({
                embeds: [createErrorEmbed('Voting Closed', 'Voting for this session has ended or the vote has already passed.')],
                ephemeral: true
            });
        }

        // Check duplicate vote
        const existingVote = db.prepare('SELECT * FROM session_voters WHERE session_id = ? AND user_id = ?').get(sessionId, interaction.user.id);
        if (existingVote) {
            return interaction.reply({
                embeds: [createErrorEmbed('Vote Rejected', 'You have already cast your vote for this session vote. You may only vote once.')],
                ephemeral: true
            });
        }

        const timestamp = Date.now();
        db.prepare('INSERT INTO session_voters (session_id, user_id, vote_choice, voted_at) VALUES (?, ?, ?, ?)')
            .run(sessionId, interaction.user.id, voteChoice, timestamp);

        let newYes = session.yes_votes;
        let newNo = session.no_votes;

        if (voteChoice === 'YES') {
            newYes += 1;
            db.prepare('UPDATE sessions SET yes_votes = yes_votes + 1 WHERE session_id = ?').run(sessionId);
        } else {
            newNo += 1;
            db.prepare('UPDATE sessions SET no_votes = no_votes + 1 WHERE session_id = ?').run(sessionId);
        }

        const requiredVotes = session.required_yes_votes || config.sessionVote.requiredYesVotes;

        // Check if vote passed (5 YES votes reached)
        if (newYes >= requiredVotes) {
            db.prepare("UPDATE sessions SET status = 'VOTE_PASSED', vote_passed_at = ? WHERE session_id = ?").run(timestamp, sessionId);

            // Update Vote Message with disabled buttons
            try {
                const passedEmbed = createNYSRPEmbed({
                    title: '𝙉𝙔𝙎𝙍𝙋 𝙎𝙚𝙨𝙨𝙞𝙤𝙣 𝙑𝙤𝙩𝙚 𝙋𝙖𝙨𝙨𝙚𝙙',
                    introduction: 'The NYSRP Session Vote has reached the required number of YES votes.',
                    sections: [
                        {
                            title: 'Vote Result',
                            items: [
                                `✅ **Yes:** ${newYes}`,
                                `❌ **No:** ${newNo}`,
                                `🎯 **Required:** ${requiredVotes}`
                            ]
                        },
                        {
                            title: 'Status',
                            items: [
                                '🟢 **Vote Passed — Awaiting Staff SSU Start**'
                            ]
                        },
                        {
                            title: 'Started By',
                            items: [
                                `<@${session.started_by}>`
                            ]
                        }
                    ],
                    closing: 'The vote has passed. An authorized staff member must manually start the SSU.',
                    color: config.branding.color // #FD8701
                });
                const voteImageUrl = interaction.message.embeds[0]?.image?.url;
                if (voteImageUrl) passedEmbed.setImage(voteImageUrl);

                const disabledButtons = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`session_vote_yes_${sessionId}`).setLabel('Yes').setStyle(ButtonStyle.Success).setEmoji('✅').setDisabled(true),
                    new ButtonBuilder().setCustomId(`session_vote_no_${sessionId}`).setLabel('No').setStyle(ButtonStyle.Danger).setEmoji('❌').setDisabled(true)
                );

                await interaction.message.edit({ embeds: [passedEmbed], components: [disabledButtons] });
            } catch (err) {
                logger.warn(`Could not edit passed vote message ${session.vote_message_id}: ${err.message}`);
            }

            // Ping SSU Permission role in channel notifying staff that SSU is ready to be manually started
            const ssuRolePing = `<@&${config.roles.ssuPermission}>`;
            const staffNoticeEmbed = createNYSRPEmbed({
                title: '𝙎𝙚𝙨𝙨𝙞𝙤𝙣 𝙑𝙤𝙩𝙚 𝙋𝙖𝙨𝙨𝙚𝙙',
                introduction: 'The NYSRP Session Vote has reached the required number of YES votes.',
                important: 'The SSU is ready to be started. An authorized staff member must manually use `/session ssu-start`.',
                sections: [
                    {
                        title: 'Vote Result',
                        items: [
                            `✅ **Yes:** ${newYes}`,
                            `❌ **No:** ${newNo}`,
                            `🎯 **Required:** ${requiredVotes}`
                        ]
                    },
                    {
                        title: 'Action Required',
                        items: [
                            `${ssuRolePing}`,
                            'An authorized staff member with the SSU Permission role must manually run `/session ssu-start`.'
                        ]
                    }
                ],
                closing: 'The SSU has NOT been started automatically.',
                color: config.branding.color // #FD8701
            });

            await interaction.channel.send({
                content: ssuRolePing,
                embeds: [staffNoticeEmbed]
            });

            return interaction.reply({
                embeds: [createSuccessEmbed('Vote Passed!', `Your vote (YES) pushed the total to **${newYes} YES votes**! The vote has passed and staff have been notified to manually start the SSU.`)],
                ephemeral: true
            });
        }

        // Vote still in progress
        try {
            const updatedEmbed = createNYSRPEmbed({
                title: '𝙉𝙔𝙎𝙍𝙋 𝙎𝙚𝙨𝙨𝙞𝙤𝙣 𝙑𝙤𝙩𝙚',
                introduction: 'A session vote is currently active. Cast your vote below if you would like NYSRP to host a session.',
                sections: [
                    {
                        title: 'Session Vote',
                        items: [
                            `✅ **Yes:** ${newYes}`,
                            `❌ **No:** ${newNo}`,
                            `🎯 **Required:** ${requiredVotes}`
                        ]
                    },
                    {
                        title: 'Status',
                        items: [
                            '🟡 **Voting in Progress**'
                        ]
                    },
                    {
                        title: 'Started By',
                        items: [
                            `<@${session.started_by}>`
                        ]
                    }
                ],
                closing: 'You may only vote once.',
                color: config.branding.color // #FD8701
            });
            const voteImageUrl = interaction.message.embeds[0]?.image?.url;
            if (voteImageUrl) updatedEmbed.setImage(voteImageUrl);

            await interaction.message.edit({ embeds: [updatedEmbed] });
        } catch (err) {
            logger.warn(`Could not update vote message ${session.vote_message_id}: ${err.message}`);
        }

        return interaction.reply({
            embeds: [createSuccessEmbed('Vote Recorded', `Your vote (**${voteChoice}**) has been counted for Session Vote #${sessionId}.`)],
            ephemeral: true
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
        db.prepare(`
            UPDATE sessions 
            SET status = 'SSU_ACTIVE', ssu_started_by = ?, ssu_started_at = ?
            WHERE session_id = ?
        `).run(member.id, timestamp, session.session_id);

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
        if (sessionChannel) {
            await sessionChannel.send({ embeds: [ssuAnnouncementEmbed], files: sessionStartFiles });
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

        db.prepare(`
            UPDATE sessions 
            SET status = 'SSU_ENDED', ssu_ended_by = ?, ssu_ended_at = ?
            WHERE session_id = ?
        `).run(member.id, timestamp, session.session_id);

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
        if (sessionChannel) {
            await sessionChannel.send({ embeds: [ssuEndAnnouncementEmbed], files: sessionEndFiles });
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

        const timestamp = Date.now();
        db.prepare(`
            UPDATE sessions 
            SET status = 'CLOSED', session_ended_at = ?
            WHERE session_id = ?
        `).run(timestamp, session.session_id);

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
            SSU_ACTIVE: '🟢 **SSU Active**',
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
    static recoverActiveSessions(client) {
        try {
            const activeSessions = db.prepare(`
                SELECT * FROM sessions 
                WHERE status IN ('VOTING', 'VOTE_PASSED', 'SSU_ACTIVE')
            `).all();
            logger.info(`[Session Recovery] Restored ${activeSessions.length} active session(s) from database.`);
        } catch (err) {
            logger.error('[Session Recovery Error]', err);
        }
    }
}

module.exports = SessionService;
