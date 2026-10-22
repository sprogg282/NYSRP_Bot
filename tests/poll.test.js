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

const PollService = require('../services/pollService');
const pollCommand = require('../commands/utility/poll');

function createChannel() {
    const messages = new Map();
    const channel = {
        id: 'poll-channel',
        guild: { id: 'poll-guild' },
        async send(payload) {
            const message = {
                id: `message-${messages.size + 1}`,
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

test('poll creation validation rejects bad questions, options, and durations', () => {
    assert.throws(() => PollService.validatePoll('', ['Yes', 'No'], 10, false), /question/);
    assert.throws(() => PollService.validatePoll('Pick one', ['Yes'], 10, false), /between 2 and 10/);
    assert.throws(() => PollService.validatePoll('Pick one', ['Yes', 'yes'], 10, false), /unique/);
    assert.throws(() => PollService.validatePoll('Pick one', ['Yes', 'No'], 0, false), /duration/);
    assert.deepEqual(
        PollService.validatePoll(' Pick one? ', [' Yes ', 'No'], 10, false),
        { question: 'Pick one?', options: ['Yes', 'No'] }
    );
});

test('poll command has a valid slash-command schema', () => {
    const data = pollCommand.data.toJSON();
    assert.equal(data.name, 'poll');
    assert.deepEqual(data.options.map(option => option.name), ['create', 'close']);
    assert.equal(data.options[0].options.length, 13);
});

test('single-choice votes are unique per voter and can be changed', async () => {
    const { channel, messages } = createChannel();
    const created = await PollService.createPoll(
        channel,
        'creator',
        'Choose a session time',
        ['Morning', 'Evening'],
        60,
        false
    );
    const message = messages.get(created.messageId);

    assert.equal(message.payload.components.length, 1);
    assert.equal(message.payload.components[0].components.length, 2);
    assert.equal(message.payload.components[0].components[0].data.custom_id, `poll_vote:${created.pollId}:0`);

    assert.deepEqual(PollService.castVote(created.pollId, 'voter-1', 0), { action: 'ADDED' });
    assert.deepEqual(PollService.castVote(created.pollId, 'voter-1', 0), { action: 'UNCHANGED' });
    assert.deepEqual(PollService.castVote(created.pollId, 'voter-1', 1), { action: 'CHANGED' });
    assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM poll_votes WHERE poll_id = ? AND user_id = ?')
            .get(created.pollId, 'voter-1').count,
        1
    );
    assert.throws(() => PollService.castVote(created.pollId, 'voter-2', 4), /no longer available/);

    const results = PollService.getResults(created.pollId);
    assert.equal(results.voterCount, 1);
    assert.equal(results.options[0].votes, 0);
    assert.equal(results.options[1].votes, 1);
});

test('multiple-choice polls allow distinct votes and let voters remove their own choice', async () => {
    const { channel } = createChannel();
    const created = await PollService.createPoll(
        channel,
        'creator',
        'Choose activities',
        ['Driving', 'Patrol', 'Training'],
        120,
        true
    );

    assert.deepEqual(PollService.castVote(created.pollId, 'voter-1', 0), { action: 'ADDED' });
    assert.deepEqual(PollService.castVote(created.pollId, 'voter-1', 1), { action: 'ADDED' });
    assert.deepEqual(PollService.castVote(created.pollId, 'voter-1', 1), { action: 'REMOVED' });
    assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM poll_votes WHERE poll_id = ? AND user_id = ?')
            .get(created.pollId, 'voter-1').count,
        1
    );
});

test('due polls close once and persist final results after restart-safe scheduling', async () => {
    const { channel, messages } = createChannel();
    const created = await PollService.createPoll(
        channel,
        'creator',
        'Expired poll',
        ['Yes', 'No'],
        1,
        false
    );
    const message = messages.get(created.messageId);
    db.prepare('UPDATE polls SET closes_at = ? WHERE poll_id = ?').run(Date.now() - 1, created.pollId);
    const client = {
        channels: {
            async fetch() {
                return { messages: { fetch: async () => message } };
            }
        }
    };

    await PollService.processDuePolls(client);
    await PollService.processDuePolls(client);

    const poll = PollService.getPoll(created.pollId);
    assert.equal(poll.status, 'CLOSED');
    assert.equal(poll.message_finalized, 1);
    assert.equal(message.editCount, 1);
    assert.ok(message.payload.components[0].components.every(button => button.data.disabled));
});

test.after(() => {
    db.close();
});
