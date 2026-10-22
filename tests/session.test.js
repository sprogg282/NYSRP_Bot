const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const Database = require('better-sqlite3');
const { applyMigrations } = require('../database/migrations');

process.env.DOTENV_CONFIG_QUIET = 'true';

const db = new Database(':memory:');
db.exec(fs.readFileSync(path.join(__dirname, '../database/schema.sql'), 'utf8'));
applyMigrations(db);

function installModuleStub(modulePath, exports) {
    const filename = require.resolve(modulePath);
    const stub = new Module(filename, module);
    stub.filename = filename;
    stub.loaded = true;
    stub.exports = exports;
    require.cache[filename] = stub;
}

installModuleStub('../database/db', db);
installModuleStub('../utils/logger', {
    info() {},
    warn() {},
    error() {},
    debug() {}
});
installModuleStub('../utils/imageManager', { getImage: () => null });
const channelValidator = { current: null };
channelValidator.getValidatedChannel = async (...args) => channelValidator.current(...args);
installModuleStub('../utils/channelValidator', channelValidator);

const SessionService = require('../services/sessionService');
const config = require('../config');

function createSession(status = 'VOTING', overrides = {}) {
    const result = db.prepare(`
        INSERT INTO sessions (
            guild_id, status, channel_id, started_by, vote_started_at,
            required_yes_votes, yes_votes, no_votes, vote_message_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        overrides.guild_id || 'session-guild',
        status,
        overrides.channel_id || config.channels.session,
        overrides.started_by || 'session-starter',
        Date.now(),
        overrides.required_yes_votes ?? 5,
        overrides.yes_votes ?? 0,
        overrides.no_votes ?? 0,
        overrides.vote_message_id === undefined ? 'vote-message' : overrides.vote_message_id
    );
    return db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(Number(result.lastInsertRowid));
}

function createSessionChannel(send = async () => ({ id: 'announcement-message' })) {
    const sent = [];
    const channel = {
        id: config.channels.session,
        async send(payload) {
            sent.push(payload);
            return send(payload);
        },
        messages: {
            async fetch() {
                return {
                    id: 'vote-message',
                    embeds: [],
                    async edit(payload) {
                        this.payload = payload;
                        this.editCount = (this.editCount || 0) + 1;
                    }
                };
            }
        }
    };
    return { channel, sent };
}

function createVoteInteraction(session, userId, voteChoice = 'YES', clientChannel) {
    const interaction = {
        customId: `session_vote_${voteChoice.toLowerCase()}_${session.session_id}`,
        guildId: session.guild_id,
        channelId: session.channel_id,
        user: { id: userId },
        deferred: false,
        async deferReply() {
            this.deferred = true;
        },
        async editReply(payload) {
            this.replyPayload = payload;
            return payload;
        },
        message: {
            id: session.vote_message_id,
            embeds: [],
            async edit(payload) {
                this.payload = payload;
                this.editCount = (this.editCount || 0) + 1;
            }
        },
        client: {
            channels: {
                fetch: async () => clientChannel
            }
        }
    };
    return interaction;
}

test('session vote interactions count once and atomically pass the vote', async () => {
    const session = createSession('VOTING', { required_yes_votes: 1 });
    const { channel } = createSessionChannel();
    const interaction = createVoteInteraction(session, 'voter-1', 'YES', channel);

    await SessionService.processVote(interaction, 'YES');

    const stored = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(session.session_id);
    assert.equal(stored.status, 'VOTE_PASSED');
    assert.equal(stored.yes_votes, 1);
    assert.equal(stored.vote_passed_notified, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM session_voters WHERE session_id = ?')
        .get(session.session_id).count, 1);
    assert.ok(interaction.message.payload.components[0].components.every(button => button.data.disabled));
    assert.ok(interaction.replyPayload.embeds);
});

test('duplicate session votes do not increment stored counts', async () => {
    const session = createSession('VOTING', { required_yes_votes: 5 });
    const { channel } = createSessionChannel();
    await SessionService.processVote(createVoteInteraction(session, 'repeat-voter', 'YES', channel), 'YES');
    const duplicate = createVoteInteraction(session, 'repeat-voter', 'NO', channel);

    await SessionService.processVote(duplicate, 'NO');

    const stored = db.prepare('SELECT yes_votes, no_votes FROM sessions WHERE session_id = ?')
        .get(session.session_id);
    assert.deepEqual(stored, { yes_votes: 1, no_votes: 0 });
    assert.match(duplicate.replyPayload.embeds[0].data.description, /already cast a vote/);
});

test('failed SSU announcements roll the lifecycle back to a retryable state', async () => {
    const session = createSession('VOTE_PASSED', { required_yes_votes: 5, yes_votes: 5 });
    channelValidator.current = async () => createSessionChannel(async () => {
        throw new Error('Discord send failed');
    }).channel;
    const guild = { id: session.guild_id };
    const member = {
        id: 'ssu-staff',
        guild: { ownerId: 'ssu-staff' }
    };

    const result = await SessionService.ssuStart(guild, member);

    assert.equal(result.success, false);
    assert.equal(db.prepare('SELECT status FROM sessions WHERE session_id = ?')
        .get(session.session_id).status, 'VOTE_PASSED');
});

test('SSU start and end transitions finalize only after their announcements succeed', async () => {
    const session = createSession('VOTE_PASSED', { required_yes_votes: 5, yes_votes: 5 });
    const { channel } = createSessionChannel();
    channelValidator.current = async () => channel;
    const guild = { id: session.guild_id };
    const member = {
        id: 'ssu-staff',
        guild: { ownerId: 'ssu-staff' }
    };

    const started = await SessionService.ssuStart(guild, member);
    assert.equal(started.success, true);
    let stored = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(session.session_id);
    assert.equal(stored.status, 'SSU_ACTIVE');
    assert.equal(stored.ssu_started_by, member.id);

    const ended = await SessionService.ssuEnd(guild, member);
    assert.equal(ended.success, true);
    stored = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(session.session_id);
    assert.equal(stored.status, 'SSU_ENDED');
    assert.equal(stored.ssu_ended_by, member.id);
});

test('startup recovery repairs interrupted transitions and restores missing vote messages', async () => {
    const starting = createSession('SSU_STARTING', { guild_id: 'recover-guild' });
    const ending = createSession('SSU_ENDING', { guild_id: 'recover-guild' });
    const voting = createSession('VOTING', { guild_id: 'recover-guild', vote_message_id: 'missing-vote' });
    db.prepare("UPDATE sessions SET status = 'CLOSED' WHERE guild_id != 'recover-guild'").run();
    let replacementCount = 0;
    const client = {
        channels: {
            async fetch() {
                return {
                    messages: {
                        async fetch() {
                            const error = new Error('Unknown message');
                            error.code = 10008;
                            throw error;
                        }
                    },
                    async send() {
                        replacementCount += 1;
                        return { id: 'replacement-vote' };
                    }
                };
            }
        }
    };

    await SessionService.recoverActiveSessions(client);

    assert.equal(db.prepare('SELECT status FROM sessions WHERE session_id = ?').get(starting.session_id).status, 'VOTE_PASSED');
    assert.equal(db.prepare('SELECT status FROM sessions WHERE session_id = ?').get(ending.session_id).status, 'SSU_ACTIVE');
    assert.equal(db.prepare('SELECT vote_message_id FROM sessions WHERE session_id = ?').get(voting.session_id).vote_message_id, 'replacement-vote');
    assert.equal(replacementCount, 2);
});

test.after(() => {
    db.close();
});
