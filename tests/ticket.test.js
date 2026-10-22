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

const databaseModulePath = require.resolve('../database/db');
installModuleStub(databaseModulePath, db);

const actualTranscriptGenerator = require('../utils/transcriptGenerator');
const transcriptAdapter = {
    current: (...args) => actualTranscriptGenerator.generateTranscript(...args),
};
transcriptAdapter.generateTranscript = (...args) => transcriptAdapter.current(...args);
const channelValidatorAdapter = {
    current: async () => null
};
channelValidatorAdapter.getValidatedChannel = (...args) => channelValidatorAdapter.current(...args);
installModuleStub('../utils/transcriptGenerator', transcriptAdapter);
installModuleStub('../utils/channelValidator', channelValidatorAdapter);
installModuleStub('../utils/logger', {
    info() {},
    warn() {},
    error() {},
    debug() {}
});

const TicketService = require('../services/ticketService');

function createTicket(status = 'OPEN', overrides = {}) {
    const ticketId = db.prepare(`
        INSERT INTO tickets (guild_id, channel_id, creator_id, category, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        'test-guild',
        `test-channel-${Date.now()}-${Math.random()}`,
        'test-creator',
        'General Support',
        status,
        Date.now()
    ).lastInsertRowid;

    if (Object.keys(overrides).length) {
        const columns = Object.keys(overrides);
        const values = columns.map(column => overrides[column]);
        db.prepare(`UPDATE tickets SET ${columns.map(column => `${column} = ?`).join(', ')} WHERE ticket_id = ?`)
            .run(...values, ticketId);
    }

    return db.prepare('SELECT * FROM tickets WHERE ticket_id = ?').get(ticketId);
}

function createMessage(id, index, extras = {}) {
    return {
        id: String(id),
        createdTimestamp: index * 1000,
        editedTimestamp: null,
        content: `message ${index}`,
        author: {
            id: `author-${index}`,
            tag: `author${index}#0001`,
            username: `author${index}`,
            displayAvatarURL: () => 'https://cdn.discordapp.com/avatar.png'
        },
        attachments: new Map(),
        embeds: [],
        components: [],
        pinned: false,
        ...extras
    };
}

function createPagedChannel(allMessages) {
    const calls = [];
    return {
        channel: {
            id: 'transcript-test-channel',
            name: 'ticket-test',
            createdTimestamp: 0,
            guild: { id: 'test-guild' },
            messages: {
                async fetch(options) {
                    calls.push(options);
                    let messages = allMessages;
                    if (options.before) {
                        const cursor = BigInt(options.before);
                        messages = allMessages.filter(message => BigInt(message.id) < cursor);
                    }
                    messages = messages
                        .slice()
                        .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1)
                        .slice(0, options.limit);
                    return new Map(messages.map(message => [message.id, message]));
                }
            }
        },
        calls
    };
}

function createCloseChannel(channelId) {
    const permissionChanges = [];
    const channel = {
        id: channelId,
        name: `ticket-${channelId}`,
        createdTimestamp: Date.now(),
        guild: {
            id: 'test-guild',
            client: { users: { fetch: async () => null } }
        },
        permissionOverwrites: {
            edit: async (...args) => permissionChanges.push(args)
        },
        send: async () => ({ id: 'close-announcement' }),
        delete: async () => {}
    };
    return { channel, permissionChanges };
}

test('database migrations add ticket fields to an existing database and are idempotent', () => {
    const legacyDb = new Database(':memory:');
    legacyDb.exec(`
        CREATE TABLE tickets (
            ticket_id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            channel_id TEXT NOT NULL UNIQUE,
            creator_id TEXT NOT NULL,
            category TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'OPEN',
            claimed_by TEXT,
            created_at INTEGER NOT NULL,
            closed_at INTEGER,
            closed_by TEXT
        );
    `);
    legacyDb.exec(fs.readFileSync(path.join(__dirname, '../database/schema.sql'), 'utf8'));

    applyMigrations(legacyDb);
    applyMigrations(legacyDb);
    const columns = legacyDb.pragma('table_info(tickets)').map(column => column.name);
    assert.ok(columns.includes('priority'));
    assert.ok(columns.includes('transcript_message_ids'));
    assert.ok(columns.includes('transcript_delivery_nonce'));
    assert.equal(legacyDb.pragma('user_version', { simple: true }), 5);
    legacyDb.close();
});

test('transcript pagination captures more than 100 messages with authors, attachments, and embeds', async () => {
    const messages = Array.from({ length: 205 }, (_, index) => createMessage(1000 + index, index));
    messages[1] = createMessage(1001, 1, {
        content: '<script>alert("transcript")</script>',
        attachments: new Map([['attachment', {
            name: 'evidence.png',
            url: 'https://cdn.discordapp.com/attachments/evidence.png',
            contentType: 'image/png',
            size: 125
        }]]),
        embeds: [{
            title: 'Evidence embed',
            description: 'Embed description',
            fields: [{ name: 'Field name', value: 'Field value', inline: true }]
        }]
    });
    const { channel, calls } = createPagedChannel(messages);
    const transcript = await actualTranscriptGenerator.generateTranscript(channel, {
        ticket_id: 12,
        created_at: 0,
        creator_id: 'test-creator',
        category: 'General Support'
    });

    assert.equal(transcript.messageCount, 205);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].limit, 100);
    assert.ok(calls[1].before);
    assert.ok(calls[2].before);
    const html = transcript.attachments.map(file => file.attachment.toString('utf8')).join('');
    assert.ok(html.includes('author1#0001'), 'author display name should be included');
    assert.ok(html.includes('User ID: author-1'), 'message author ID should be included');
    assert.ok(html.includes('evidence.png'), 'attachment name should be included');
    assert.ok(html.includes('https://cdn.discordapp.com/attachments/evidence.png'), 'attachment URL should be included');
    assert.ok(html.includes('Evidence embed'), 'embed title should be included');
    assert.ok(html.includes('Field value'), 'embed fields should be included');
    assert.ok(html.includes('&lt;script&gt;'), 'message content should be HTML escaped');
    assert.ok(!html.includes('<script>alert'), 'raw script markup should not be emitted');
});

test('transcript generation fails rather than returning a partial history when pagination fails', async () => {
    const messages = Array.from({ length: 101 }, (_, index) => createMessage(2000 + index, index));
    let calls = 0;
    const channel = {
        id: 'pagination-failure',
        name: 'ticket-test',
        createdTimestamp: 0,
        messages: {
            async fetch(options) {
                calls += 1;
                if (calls === 2) throw new Error('Discord history unavailable');
                const page = messages.slice(-options.limit).reverse();
                return new Map(page.map(message => [message.id, message]));
            }
        }
    };

    await assert.rejects(
        actualTranscriptGenerator.generateTranscript(channel, { ticket_id: 13, created_at: 0 }),
        /Discord history unavailable/
    );
});

test('ticket claiming is atomic and rolls back if its announcement fails', async () => {
    const ticket = createTicket();
    const channel = {
        id: ticket.channel_id,
        send: async () => {}
    };
    const claimants = [
        { id: 'staff-a', user: { tag: 'staff-a#0001' } },
        { id: 'staff-b', user: { tag: 'staff-b#0001' } }
    ];
    const results = await Promise.allSettled(
        claimants.map(member => TicketService.claimTicket(channel, member))
    );

    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.ok(claimants.some(member => member.id === db.prepare('SELECT claimed_by FROM tickets WHERE ticket_id = ?').get(ticket.ticket_id).claimed_by));

    const unclaimedTicket = createTicket();
    await assert.rejects(
        TicketService.claimTicket(
            {
                id: unclaimedTicket.channel_id,
                send: async () => { throw new Error('Discord send failed'); }
            },
            { id: 'staff-c', user: { tag: 'staff-c#0001' } }
        ),
        /Discord send failed/
    );
    assert.equal(db.prepare('SELECT claimed_by FROM tickets WHERE ticket_id = ?').get(unclaimedTicket.ticket_id).claimed_by, null);
});

test('failed ticket setup removes its temporary database row', async () => {
    const guild = {
        id: 'test-guild',
        client: { user: { id: 'bot-user' } },
        channels: {
            fetch: async () => null,
            create: async () => { throw new Error('Channel creation rejected'); }
        },
        roles: { cache: { has: () => false } }
    };

    await assert.rejects(
        TicketService.createTicket(guild, { id: 'new-creator', tag: 'new#0001' }, 'general_support'),
        /Channel creation rejected/
    );
    assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM tickets WHERE channel_id LIKE 'temp_%'").get().count,
        0
    );
});

test('priority changes are persisted, audited, and sorted for staff', async () => {
    const normalTicket = createTicket();
    const urgentTicket = createTicket();
    const channel = {
        id: urgentTicket.channel_id,
        guild: { id: urgentTicket.guild_id },
        setTopic: async () => {},
        send: async () => {}
    };

    const result = await TicketService.setPriority(
        channel,
        urgentTicket,
        'URGENT',
        { id: 'staff-priority' }
    );

    assert.equal(result.changed, true);
    assert.equal(db.prepare('SELECT priority FROM tickets WHERE ticket_id = ?').get(urgentTicket.ticket_id).priority, 'URGENT');
    assert.equal(
        db.prepare('SELECT changed_by FROM ticket_priority_history WHERE ticket_id = ?').get(urgentTicket.ticket_id).changed_by,
        'staff-priority'
    );
    assert.equal(TicketService.listOpenTickets(normalTicket.guild_id)[0].ticket_id, urgentTicket.ticket_id);
});

test('failed transcript delivery restores the ticket and keeps its channel available', async () => {
    const ticket = createTicket();
    const { channel, permissionChanges } = createCloseChannel(ticket.channel_id);
    transcriptAdapter.current = async () => ({
        attachments: [{ name: 'transcript.html' }],
        messageCount: 2,
        partCount: 1
    });
    channelValidatorAdapter.current = async () => ({
        send: async () => { throw new Error('Archive upload rejected'); },
        messages: { fetch: async () => null }
    });

    await assert.rejects(
        TicketService.closeTicket(channel, ticket, { id: 'staff-close', user: { tag: 'staff-close#0001' } }),
        /ticket remains open/
    );
    assert.equal(db.prepare('SELECT status FROM tickets WHERE ticket_id = ?').get(ticket.ticket_id).status, 'OPEN');
    assert.deepEqual(permissionChanges.map(change => change[1].SendMessages), [false, true]);
});

test('successful transcript delivery closes once and prevents duplicate archives', async () => {
    const ticket = createTicket();
    const { channel } = createCloseChannel(ticket.channel_id);
    let archiveSends = 0;
    transcriptAdapter.current = async () => ({
        attachments: [{ name: 'transcript.html' }],
        messageCount: 3,
        partCount: 1
    });
    channelValidatorAdapter.current = async () => ({
        send: async () => ({ id: `archive-${++archiveSends}` }),
        messages: { fetch: async () => ({ delete: async () => {} }) }
    });

    const result = await TicketService.closeTicket(
        channel,
        ticket,
        { id: 'staff-close', user: { tag: 'staff-close#0001' } }
    );
    const storedTicket = db.prepare('SELECT * FROM tickets WHERE ticket_id = ?').get(ticket.ticket_id);
    const duplicateResult = await TicketService.closeTicket(
        channel,
        storedTicket,
        { id: 'staff-close', user: { tag: 'staff-close#0001' } }
    );

    assert.equal(result.status, 'closed');
    assert.equal(result.messageCount, 3);
    assert.equal(storedTicket.status, 'CLOSED');
    assert.ok(storedTicket.transcript_delivered_at);
    assert.equal(duplicateResult.status, 'already_closed');
    assert.equal(archiveSends, 1);
});

test('simultaneous close interactions do not start a second transcript upload', async () => {
    const ticket = createTicket();
    const { channel } = createCloseChannel(ticket.channel_id);
    let startUpload;
    let finishUpload;
    const uploadStarted = new Promise(resolve => { startUpload = resolve; });
    const uploadCompletion = new Promise(resolve => { finishUpload = resolve; });
    transcriptAdapter.current = async () => ({
        attachments: [{ name: 'transcript.html' }],
        messageCount: 1,
        partCount: 1
    });
    channelValidatorAdapter.current = async () => ({
        send: async () => {
            startUpload();
            return uploadCompletion;
        },
        messages: { fetch: async () => ({ delete: async () => {} }) }
    });

    const closeRequest = TicketService.closeTicket(
        channel,
        ticket,
        { id: 'staff-close', user: { tag: 'staff-close#0001' } }
    );
    await uploadStarted;
    await assert.rejects(
        TicketService.closeTicket(channel, ticket, { id: 'staff-other', user: { tag: 'staff-other#0001' } }),
        /operation is already in progress/
    );
    finishUpload({ id: 'archive-only' });
    const result = await closeRequest;

    assert.equal(result.status, 'closed');
    assert.equal(db.prepare('SELECT transcript_part_count FROM tickets WHERE ticket_id = ?').get(ticket.ticket_id).transcript_part_count, 1);
});

test('interrupted close recovery reopens tickets whose transcript was not fully delivered', async () => {
    const ticket = createTicket('CLOSING', {
        close_previous_status: 'LOCKED',
        closing_started_at: Date.now(),
        transcript_part_count: 2,
        transcript_message_ids: JSON.stringify(['only-one-part'])
    });

    await TicketService.recoverInterruptedClosures({});

    const recovered = db.prepare('SELECT * FROM tickets WHERE ticket_id = ?').get(ticket.ticket_id);
    assert.equal(recovered.status, 'LOCKED');
    assert.equal(recovered.close_previous_status, null);
    assert.equal(recovered.transcript_message_ids, JSON.stringify(['only-one-part']));
});

test.after(() => {
    db.close();
});
