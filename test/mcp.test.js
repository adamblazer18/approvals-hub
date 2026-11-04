const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { start } = require('./helpers');

let hub, cookie, key;

async function connect(url) {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}
const parse = (r) => JSON.parse(r.content[0].text);

before(async () => {
  hub = await start();
  cookie = await hub.login();
  key = hub.store.createKey('MCP agent').key;
});
after(() => hub.stop());

test('an invalid key is refused', async () => {
  await assert.rejects(connect(`${hub.base}/mcp/apk_not_a_real_key`));
});

test('lists the review tools', async () => {
  const client = await connect(`${hub.base}/mcp/${key}`);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(),
    ['check_decisions', 'get_item', 'list_pending', 'list_projects', 'submit_for_review', 'withdraw_item']);
  await client.close();
});

test('full loop over MCP: submit, decide in the hub, check_decisions', async () => {
  const client = await connect(`${hub.base}/mcp/${key}`);
  const sub = parse(await client.callTool({ name: 'submit_for_review', arguments: {
    project: 'Website', kind: 'decision', title: 'Pick a headline',
    options: ['Plan your week', 'Your week, planned'], external_ref: 'run-42',
  } }));
  assert.equal(sub.status, 'pending');

  const pending = parse(await client.callTool({ name: 'list_pending', arguments: {} }));
  assert.ok(pending.some((p) => p.id === sub.id));

  await hub.call('POST', `/api/items/${sub.id}/decision`, { cookie, body: { status: 'approved', chosen_option: 'B' } });

  const out = parse(await client.callTool({ name: 'check_decisions', arguments: { external_ref: 'run-42' } }));
  assert.equal(out.decisions.length, 1);
  assert.equal(out.decisions[0].status, 'approved');
  assert.deepEqual(out.decisions[0].chosen_option, { id: 'B', label: 'Your week, planned' });

  const again = parse(await client.callTool({ name: 'check_decisions', arguments: { external_ref: 'run-42' } }));
  assert.equal(again.decisions.length, 0);
  await client.close();
});

test('the key can also be sent as a bearer header', async () => {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${hub.base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  }));
  const r = parse(await client.callTool({ name: 'list_projects', arguments: {} }));
  assert.ok(Array.isArray(r));
  await client.close();
});

test('tool errors come back as MCP errors, not crashes', async () => {
  const client = await connect(`${hub.base}/mcp/${key}`);
  const r = await client.callTool({ name: 'withdraw_item', arguments: { id: 'does-not-exist' } });
  assert.equal(r.isError, true);
  await client.close();
});
