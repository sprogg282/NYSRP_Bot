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

const EventService = require('../services/eventService');
const eventCommand = require('../commands/utility/event');

function createChannel() {
    const messages = new Map();
    const channel = {
        id: 'event-channel',
        guild: { id: 'event-guild' },
        async send(payload) {
            const message = {
                id: `event-message-${messages.size + 1}`,
                payload,
                editCount: 0,
                async edit(updatedPayload) {
                    this.payload = updatedPayload;
                    this.editCount += 1;
                    return this;
                },
                async delete() {
                    messages.delete(this.id);
                }
            };
            messages.set(message.id, message);
            return message;
        }
    };
    return { channel, messages };
}

test('event validation enforces future start times, duration, and giveaway winners', () => {
    const startsAt = Date.now() + 60_000;
    assert.throws(
        () => EventService.validateEvent('EVENT', '', '', startsAt, 30, null),
        /title/
    );
    assert.throws(
        () => EventService.validateEvent('EVENT', 'Meetup', '', startsAt, 0, null),
        /Duration/
    );
    assert.throws(
        () => EventService.validateEvent('GIVEAWAY', 'Prize', '', startsAt, 30, 0),
        /winners/
    );
    assert.equal(
        EventService.validateEvent('EVENT', ' Meetup ', ' Details ', startsAt, 30, null).title,
        'Meetup'
    );
});

test('event slash command schema is serializable', () => {
    const data = eventCommand.data.toJSON();
    assert.equal(data.name, 'event');
    assert.deepEqual(data.options.map(option => option.name), ['create', 'giveaway', 'list', 'close', 'cancel']);
});

test('scheduled events persist RSVP state and automatically close with final results', async () => {
    const { channel, messages } = createChannel();
    const created = await EventService.createEvent(channel, 'organizer', {
        eventType: 'EVENT',
        title: 'Community Meetup',
        description: 'Meet the community.',
        startsAt: Date.now() + 60_000,
        durationMinutes: 60
    });
    const message = messages.get(created.messageId);
    assert.equal(message.payload.components[0].components[0].data.custom_id, `event_rsvp:${created.eventId}`);

    assert.deepEqual(EventService.toggleParticipation(created.eventId, 'member-1'), {
        action: 'ADDED',
        eventType: 'EVENT'
    });
    assert.deepEqual(EventService.toggleParticipation(created.eventId, 'member-1'), {
        action: 'REMOVED',
        eventType: 'EVENT'
    });
    assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM event_entries WHERE event_id = ?')
            .get(created.eventId).count,
        0
    );

    db.prepare('UPDATE events SET ends_at = ? WHERE event_id = ?').run(Date.now() - 1, created.eventId);
    const client = {
        channels: {
            async fetch() {
                return { messages: { fetch: async () => message } };
            }
        }
    };
    await EventService.processDueEvents(client);
    await EventService.processDueEvents(client);

    const event = EventService.getEvent(created.eventId);
    assert.equal(event.status, 'ENDED');
    assert.equal(event.message_finalized, 1);
    assert.equal(message.editCount, 1);
    assert.ok(message.payload.components[0].components[0].data.disabled);
});

test('giveaways choose a unique bounded set of winners and persist it idempotently', async () => {
    const { channel } = createChannel();
    const created = await EventService.createEvent(channel, 'organizer', {
        eventType: 'GIVEAWAY',
        title: 'Community Prize',
        startsAt: Date.now(),
        durationMinutes: 60,
        winnerCount: 2
    });
    for (const userId of ['member-a', 'member-b', 'member-c']) {
        assert.equal(EventService.toggleParticipation(created.eventId, userId).action, 'ADDED');
    }

    const firstClose = EventService.finalizeEvent(created.eventId);
    const secondClose = EventService.finalizeEvent(created.eventId);
    assert.equal(firstClose.winners.length, 2);
    assert.equal(new Set(firstClose.winners).size, 2);
    assert.ok(firstClose.winners.every(userId => ['member-a', 'member-b', 'member-c'].includes(userId)));
    assert.deepEqual(secondClose.winners, firstClose.winners);
    assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM event_winners WHERE event_id = ?')
            .get(created.eventId).count,
        2
    );
});

test('cancelling an event disables participation without selecting giveaway winners', async () => {
    const { channel, messages } = createChannel();
    const created = await EventService.createEvent(channel, 'organizer', {
        eventType: 'GIVEAWAY',
        title: 'Cancelled Prize',
        startsAt: Date.now(),
        durationMinutes: 60,
        winnerCount: 1
    });
    EventService.toggleParticipation(created.eventId, 'member-a');
    EventService.cancelEvent(created.eventId);
    const message = messages.get(created.messageId);
    const client = {
        channels: {
            async fetch() {
                return { messages: { fetch: async () => message } };
            }
        }
    };
    await EventService.updateFinalMessage(created.eventId, client);

    assert.equal(EventService.getEvent(created.eventId).status, 'CANCELLED');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM event_winners WHERE event_id = ?').get(created.eventId).count, 0);
    assert.ok(message.payload.components[0].components[0].data.disabled);
});

test.after(() => {
    db.close();
});
