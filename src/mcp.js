// MCP endpoint so Claude agents (Cowork, scheduled tasks, Claude Code, projects) can submit work
// for review and read back decisions. Stateless Streamable HTTP.
// Connect at  {PUBLIC_URL}/mcp/{API_KEY}   (key in the path, for connectors that can't set headers)
//        or   {PUBLIC_URL}/mcp  with  Authorization: Bearer {API_KEY}
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const store = require('./db');
const notify = require('./notify');
const { resolveAttachments } = require('./attachments');

const R = process.env.REVIEWER_NAME || 'the reviewer';
const Rs = R === 'the reviewer' ? "the reviewer's" : `${R}'s`;

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: 'Error: ' + msg }], isError: true });

function buildServer(key) {
  const server = new McpServer(
    { name: 'approvals-hub', version: '1.0.0' },
    {
      instructions:
        `Approvals hub. When your work needs ${Rs} sign-off (artwork, designs, copy, emails, a choice between options), ` +
        'call submit_for_review instead of waiting in chat, then carry on with other work. On your next run, call check_decisions ' +
        'and act on each result: approved → ship it (use revised_content verbatim if present, and chosen_option if options were given); ' +
        'changes_requested → revise per the note and resubmit with revises=<id>; rejected → drop it or rethink per the note. ' +
        'Always pass a stable external_ref (your task id) so you can match decisions to your work.' +
        (key.project ? ` This key is limited to project "${key.project}".` : ''),
    }
  );

  const attachment = z.object({
    url: z.string().optional().describe('Public or hub URL of the file'),
    data: z.string().optional().describe('Base64 file content (or a data: URL) if there is no URL'),
    name: z.string().optional(),
    mime_type: z.string().optional(),
    caption: z.string().optional(),
  });

  server.registerTool('submit_for_review', {
    title: 'Submit for review',
    description:
      `Put something in ${Rs} approval queue. Use kind="design" for artwork/visuals (attach images), "copy" for text, ` +
      '"email" for an email draft (set email_to/email_subject, body = email body), "decision" when he must choose between options. ' +
      'Returns the item id; decisions come back through check_decisions.',
    inputSchema: {
      project: z.string().describe('Project name, e.g. "Website", "Mobile app". New names create a project.'),
      title: z.string().describe('Short, specific title, e.g. "Homepage hero image, option set 2"'),
      kind: z.enum(['design', 'copy', 'email', 'decision', 'other']).default('other'),
      summary: z.string().optional().describe(`One or two sentences: what you need from ${R} and any context needed to decide fast`),
      body: z.string().optional().describe('The content under review (markdown by default)'),
      body_format: z.enum(['markdown', 'text', 'html']).optional(),
      email_to: z.string().optional(),
      email_subject: z.string().optional(),
      options: z.array(z.union([z.string(), z.object({ id: z.string().optional(), label: z.string(), detail: z.string().optional() })])).optional()
        .describe(`For kind=decision: the choices. ${R[0].toUpperCase() + R.slice(1)} picks one when approving.`),
      attachments: z.array(attachment).optional(),
      links: z.array(z.object({ url: z.string(), label: z.string().optional() })).optional().describe('Figma, staging URLs, docs, PRs'),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      due_at: z.string().optional().describe('ISO date/time if this blocks something'),
      external_ref: z.string().optional().describe('Your own task/run id, to match the decision back to your work'),
      revises: z.string().optional().describe('Id of an earlier item this is a new version of (after changes_requested)'),
      agent: z.string().optional().describe('Your name, e.g. "Website growth agent"'),
      callback_url: z.string().optional().describe('Optional URL to POST the decision to'),
    },
  }, async (args) => {
    try {
      args.attachments = resolveAttachments({ attachments: args.attachments || [] }).filter((a) => a.url);
      const it = store.createItem(args, { agentKey: key });
      notify.discordNewItem(it);
      return text({ id: it.id, status: it.status, version: it.version, project: it.project, url: notify.absolutize(it).url,
        next: `Carry on with other work. Call check_decisions later to get ${Rs} answer.` });
    } catch (e) { return fail(e.message); }
  });

  server.registerTool('check_decisions', {
    title: 'Check decisions',
    description: `Returns items ${R} has approved, rejected or sent back with changes that you have not picked up yet. By default marks them as picked up.`,
    inputSchema: {
      project: z.string().optional(),
      external_ref: z.string().optional().describe('Only decisions for this task/run id'),
      acknowledge: z.boolean().default(true).describe('Mark returned decisions as picked up so they are not returned again'),
      include_acknowledged: z.boolean().default(false),
    },
  }, async ({ project, external_ref, acknowledge, include_acknowledged }) => {
    try {
      let items = store.listItems({ status: 'decided', unacknowledged: !include_acknowledged, project: key.project || project });
      if (external_ref) items = items.filter((i) => i.external_ref === external_ref);
      if (acknowledge) store.acknowledge(items.map((i) => i.id), key.label, key);
      const pending = store.listItems({ status: 'pending', project: key.project || project }).length;
      return text({ decisions: items.map(notify.decisionPayload), still_pending: pending });
    } catch (e) { return fail(e.message); }
  });

  server.registerTool('list_pending', {
    title: 'List items waiting for review',
    description: 'Items still waiting for review, so you don\'t resubmit something already in the queue.',
    inputSchema: { project: z.string().optional() },
  }, async ({ project }) => text(store.listItems({ status: 'pending', project: key.project || project })
    .map((i) => ({ id: i.id, project: i.project, title: i.title, kind: i.kind, version: i.version, external_ref: i.external_ref, created_at: i.created_at }))));

  server.registerTool('get_item', {
    title: 'Get one review item',
    description: 'Full details and current status of one item, including earlier versions and notes.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    const it = store.getItem(id);
    if (!it || (key.project && it.project !== key.project)) return fail('not found');
    const { events, ...rest } = notify.absolutize(it);
    return text(rest);
  });

  server.registerTool('withdraw_item', {
    title: 'Withdraw a pending item',
    description: 'Remove an item from the review queue if it is no longer needed.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => { try { return text(store.withdraw(id, key.label, key).status); } catch (e) { return fail(e.message); } });

  server.registerTool('list_projects', {
    title: 'List projects',
    description: 'Projects in the hub, with pending counts.',
    inputSchema: {},
  }, async () => text(store.listProjects().map((p) => ({ slug: p.slug, name: p.name, pending: p.pending }))));

  return server;
}

function mountMcp(app) {
  const handler = async (req, res) => {
    const raw = req.params.key || ((req.get('authorization') || '').startsWith('Bearer ') ? req.get('authorization').slice(7) : null);
    const key = store.verifyKey(raw);
    if (!key) return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'invalid or missing API key' }, id: null });
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
    try {
      const server = buildServer(key);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('mcp error', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  };
  app.all('/mcp', handler);
  app.all('/mcp/:key', handler);
}

module.exports = { mountMcp };
