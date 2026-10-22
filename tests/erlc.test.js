const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const Database = require('better-sqlite3');
const { applyMigrations } = require('../database/migrations');

process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.ERLC_SERVER_KEY = 'test-server-key';

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

const ERLCService = require('../services/erlcService');

function apiResponse(body, status = 200, headers = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(headers),
        async json() {
            return body;
        }
    };
}

const validServerData = {
    Name: 'NYSRP @ Server',
    OwnerId: 12345,
    CoOwnerIds: [67890],
    CurrentPlayers: 8,
    MaxPlayers: 40,
    JoinKey: 'do-not-display-this-join-key',
    AccVerifiedReq: 'Email',
    TeamBalance: true,
    Queue: [111, 222],
    Players: [
        { Player: 'OwnerName:12345', Permission: 'Server Owner' },
        { Player: 'AdminName:111', Permission: 'Server Administrator' },
        { Player: 'PlayerName:222', Permission: 'Normal' }
    ]
};

test('ER:LC status fetch uses the documented endpoint/header and caches validated data', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async (url, options) => {
        calls += 1;
        assert.equal(url, 'https://api.erlc.gg/v2/server?Players=true&Queue=true');
        assert.equal(options.headers['server-key'], 'test-server-key');
        return apiResponse(validServerData);
    };
    try {
        const [first, second] = await Promise.all([
            ERLCService.refreshStatus(true),
            ERLCService.refreshStatus(true)
        ]);
        assert.equal(calls, 1);
        assert.equal(first.state, 'AVAILABLE');
        assert.equal(first.data.CurrentPlayers, 8);
        assert.equal(second.data.Name, validServerData.Name);
        assert.equal((await ERLCService.refreshStatus()).data.MaxPlayers, 40);
        assert.equal(calls, 1);
    } finally {
        global.fetch = originalFetch;
    }
});

test('ER:LC status embed displays documented counts without exposing keys or allowing mentions', () => {
    const snapshot = {
        state: 'AVAILABLE',
        checkedAt: Date.now(),
        fetchedAt: Date.now(),
        data: validServerData
    };
    const payload = ERLCService.buildPayload(snapshot);
    const [banner, status] = payload.embeds.map(embed => embed.toJSON());
    const rendered = JSON.stringify(status);

    assert.equal(banner.image.url, 'attachment://Session_Start.png');
    assert.equal(payload.files.length, 1);
    assert.equal(status.title, 'ER:LC LIVE SERVER STATUS');
    assert.match(status.description, /🟢 ONLINE/);
    assert.ok(status.fields.some(field => field.name === 'PLAYERS ONLINE' && field.value.includes('8')));
    assert.ok(status.fields.some(field => field.name === 'QUEUE' && field.value.includes('2')));
    assert.ok(status.fields.some(field => field.name === 'STAFF ONLINE' && field.value.includes('2')));
    assert.ok(status.fields.some(field => field.name === 'SERVER OWNER' && field.value.includes('OwnerName')));
    assert.ok(status.fields.some(field => field.name === 'JOIN CODE' && field.value.includes(validServerData.JoinKey)));
    assert.ok(status.footer.text.includes('Last successful API update'));
    assert.ok(rendered.includes('@​ Server'));
    assert.ok(!rendered.includes('test-server-key'));
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.deepEqual(payload.components[0].components.map(button => button.data.custom_id), [
        'erlc_show_join_code',
        'erlc_refresh_status'
    ]);
});

test('ER:LC status embed handles optional API fields without inventing values', () => {
    const payload = ERLCService.buildPayload({
        state: 'AVAILABLE',
        checkedAt: Date.now(),
        fetchedAt: Date.now(),
        data: { Name: 'NYSRP Test Server', CurrentPlayers: 0, MaxPlayers: 40 }
    });
    const status = payload.embeds[1].toJSON();
    const fields = Object.fromEntries(status.fields.map(field => [field.name, field.value]));

    assert.equal(fields.QUEUE, 'Not provided');
    assert.equal(fields['STAFF ONLINE'], 'Not provided');
    assert.equal(fields['SERVER OWNER'], 'Not provided');
    assert.equal(fields['JOIN CODE'], 'Not provided by the API.');
});

test('ER:LC code 3002 is represented as offline without inferring status from API reachability', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => apiResponse({ code: 3002, message: 'Server offline' }, 400);
    try {
        const snapshot = await ERLCService.requestStatus();
        assert.equal(snapshot.state, 'OFFLINE');
        assert.equal(snapshot.apiCode, 3002);
        const payload = ERLCService.buildPayload(snapshot);
        assert.match(payload.embeds[1].data.description, /🔴 OFFLINE/);
        assert.match(payload.embeds[1].data.description, /offline/);
        assert.ok(payload.components[0].components.every(button => button.data.custom_id === 'erlc_refresh_status'));
        assert.ok(payload.embeds[1].data.fields.find(field => field.name === 'JOIN CODE').value.includes('Unavailable'));
    } finally {
        global.fetch = originalFetch;
    }
});

test('ER:LC status panel persists and reuses the same Discord message', async () => {
    const channel = {
        id: 'erlc-status-channel',
        guild: { id: 'erlc-status-guild' },
        sent: [],
        async send(payload) {
            const message = {
                id: 'erlc-status-message',
                payload,
                edits: 0,
                async edit(updated) {
                    this.payload = updated;
                    this.edits += 1;
                    return this;
                }
            };
            this.sent.push(message);
            return message;
        },
        messages: {
            fetch: async () => channel.sent[0]
        }
    };

    const first = await ERLCService.setupPanel(channel);
    const second = await ERLCService.setupPanel(channel);
    assert.equal(first.replaced, false);
    assert.equal(second.replaced, false);
    assert.equal(channel.sent.length, 1);
    assert.equal(channel.sent[0].edits, 1);
    assert.equal(
        db.prepare('SELECT message_id FROM erlc_status_panels WHERE guild_id = ?')
            .get(channel.guild.id).message_id,
        'erlc-status-message'
    );
});

test('ER:LC panel recreates a missing status message after restart', async () => {
    let sent = 0;
    const channel = {
        id: 'erlc-recovery-channel',
        guild: { id: 'erlc-recovery-guild' },
        messages: {
            async fetch() {
                const error = new Error('Unknown message');
                error.code = 10008;
                throw error;
            }
        },
        async send(payload) {
            sent += 1;
            return {
                id: 'recreated-status-message',
                payload,
                async edit(updated) {
                    this.payload = updated;
                }
            };
        }
    };
    db.prepare(`
        INSERT INTO erlc_status_panels (guild_id, channel_id, message_id, updated_at)
        VALUES (?, ?, ?, ?)
    `).run(channel.guild.id, channel.id, 'deleted-message', Date.now());

    await ERLCService.setupPanel(channel);
    const record = db.prepare('SELECT * FROM erlc_status_panels WHERE guild_id = ?').get(channel.guild.id);
    assert.equal(sent, 1);
    assert.equal(record.message_id, 'recreated-status-message');
});

test('ER:LC join action is enabled only for a configured official Roblox invitation URL', () => {
    const config = require('../config');
    const snapshot = {
        state: 'AVAILABLE',
        checkedAt: Date.now(),
        fetchedAt: Date.now(),
        data: validServerData
    };
    config.erlc.joinUrl = 'https://www.roblox.com/share?code=valid-invite&type=Server';
    const joinButton = ERLCService.buildPayload(snapshot).components[0].components[0].toJSON();
    assert.equal(joinButton.label, 'Join Server');
    assert.equal(joinButton.url, config.erlc.joinUrl);

    config.erlc.joinUrl = 'https://example.com/not-a-roblox-server';
    const codeButton = ERLCService.buildPayload(snapshot).components[0].components[0].toJSON();
    assert.equal(codeButton.custom_id, 'erlc_show_join_code');
});

test('ER:LC actions show the current join code and refresh status messages', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
        calls += 1;
        return apiResponse(validServerData);
    };
    const interaction = {
        customId: 'erlc_show_join_code',
        guildId: 'erlc-status-guild',
        user: { id: 'member' },
        client: { user: { id: 'bot' } },
        message: {
            author: { id: 'bot' },
            embeds: [{ title: 'ER:LC LIVE SERVER STATUS' }],
            async edit(payload) {
                this.payload = payload;
                this.edited = true;
            }
        },
        async deferReply() {},
        async editReply(payload) {
            this.reply = payload;
            return payload;
        }
    };
    try {
        await ERLCService.requestStatus();
        await ERLCService.handleButton(interaction);
        assert.match(interaction.reply.content, /do-not-display-this-join-key/);
        assert.deepEqual(interaction.reply.allowedMentions, { parse: [] });

        interaction.customId = 'erlc_refresh_status';
        await ERLCService.handleButton(interaction);
        assert.equal(interaction.message.edited, true);
        assert.equal(calls, 1);
    } finally {
        global.fetch = originalFetch;
    }
});

test('ER:LC unavailable status is not presented as live and omits stale join actions', () => {
    const payload = ERLCService.buildPayload({
        state: 'STALE',
        checkedAt: Date.now(),
        fetchedAt: Date.now() - 120000,
        data: validServerData,
        error: 'API request failed.'
    });
    const status = payload.embeds[1].toJSON();

    assert.match(status.description, /API UNAVAILABLE · STALE DATA/);
    assert.match(status.description, /not live/);
    assert.ok(status.fields.some(field => field.name === 'LAST SUCCESSFUL UPDATE'));
    assert.ok(!payload.components[0].components.some(button => button.data.custom_id === 'erlc_show_join_code'));
});

test('ER:LC rate limits honor Retry-After and suppress further requests during the pause', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
        calls += 1;
        return apiResponse({ code: 4001, message: 'Rate limited' }, 429, { 'Retry-After': '30' });
    };
    try {
        const first = await ERLCService.requestStatus();
        const second = await ERLCService.refreshStatus(true);
        assert.equal(first.state, 'STALE');
        assert.ok(first.data);
        assert.match(second.error, /rate-limiting/);
        assert.equal(calls, 1);
    } finally {
        global.fetch = originalFetch;
    }
});

test.after(() => {
    db.close();
});
