// Demo data so you can try the review flow. Usage: node scripts/seed-demo.js
// Writes straight to the local database. Delete data/approvals.db to start clean.
require('../src/env');
const fs = require('fs');
const path = require('path');
const store = require('../src/db');

const img = (f, caption) => {
  const saved = store.saveUpload(fs.readFileSync(path.join(__dirname, 'seed-assets', f)), f, 'image/png');
  return { url: `/files/${saved.file}`, name: f, type: 'image', caption };
};
const hoursAgo = (h) => new Date(Date.now() - h * 36e5).toISOString();

store.ensureProject('Mobile app', '#2e86ab');
store.ensureProject('Newsletter', '#e4572e');
store.ensureProject('Website', '#8e44ad');

const items = [
  {
    project: 'Mobile app', kind: 'decision', agent: 'Design agent', priority: 'high', external_ref: 'app-logo-r2',
    title: 'Logo direction for the app icon and splash screen',
    summary: 'Pick one direction so I can produce the full icon set and splash assets.',
    options: [
      { label: 'Dark and gold', detail: 'Gold linework on near-black. Feels premium, reads well at small sizes.' },
      { label: 'Paper and ink', detail: 'Navy on warm off-white. Friendlier and calmer.' },
      { label: 'Inverted navy', detail: 'Off-white on navy. Strong contrast on the home screen.' },
    ],
    attachments: [img('logo-a.png', 'A · Dark and gold'), img('logo-b.png', 'B · Paper and ink'), img('logo-c.png', 'C · Inverted navy')],
    links: [{ url: 'https://www.figma.com/', label: 'Figma file' }],
  },
  {
    project: 'Newsletter', kind: 'email', agent: 'Growth agent', external_ref: 'onboard-3',
    title: 'Onboarding email #3: "Your first week"',
    summary: 'Third email in the new-signup sequence. Goes out 3 days after signup to people who haven\'t finished setup.',
    email_to: 'New signups who haven\'t finished setup',
    email_subject: 'Two minutes to finish setting up',
    body: `Hi {{first_name}},\n\nYou signed up a few days ago but haven't finished setting up. Here's the fastest way in:\n\n1. Connect your calendar.\n2. Pick the three people you meet with most.\n3. Turn on the Monday summary.\n\n[Finish setup →]({{app_url}})`,
    attachments: [img('banner.png', 'Header banner')],
  },
  {
    project: 'Website', kind: 'copy', agent: 'Growth agent', priority: 'normal', external_ref: 'hero-v2', created: 5,
    title: 'Homepage headline and subhead',
    summary: 'Two lines for the top of the homepage. The current version is underperforming on signups.',
    body: `# Your week, planned before Monday\n\nAtlas reads your calendar and inbox and tells you what needs you this week, so you start Monday knowing where to spend your time.`,
  },
  {
    project: 'Website', kind: 'copy', agent: 'Content agent', priority: 'urgent', due_at: new Date(Date.now() + 864e5).toISOString(), external_ref: 'faq-pricing',
    title: 'Pricing page FAQ: "Can I cancel any time?"',
    summary: 'Needed before tomorrow\'s pricing page update. Check the tone is clear and doesn\'t over-promise.',
    body: `**Can I cancel any time?**\n\nYes. Cancel from Settings and you won't be charged again. You keep access until the end of the period you paid for.`,
  },
  {
    project: 'Mobile app', kind: 'design', agent: 'Design agent', priority: 'low', external_ref: 'social-1', created: 20,
    title: 'Launch post artwork',
    summary: 'Square post for the launch announcement. Approve or tell me what to change.',
    attachments: [img('logo-b.png', '1080×1080 export')],
  },
];

for (const it of items) {
  const created = store.createItem(it, { actor: it.agent });
  if (it.created) store.db.prepare('UPDATE items SET created_at=?, updated_at=? WHERE id=?').run(hoursAgo(it.created), hoursAgo(it.created), created.id);
}

// One revision chain so the "your note on version 1" view has something to show.
const v1 = store.createItem({ project: 'Newsletter', kind: 'copy', agent: 'Content agent', title: 'Monthly update intro paragraph', external_ref: 'monthly-update', body: 'We had an incredible, game-changing month that exceeded all expectations.' });
store.decide(v1.id, { status: 'changes_requested', note: 'Too hypey. State the actual numbers and keep it to two sentences.' });
store.createItem({ project: 'Newsletter', kind: 'copy', agent: 'Content agent', title: 'Monthly update intro paragraph', external_ref: 'monthly-update', revises: v1.id,
  summary: 'Revised per your note.', body: 'This month we shipped calendar sync and grew weekly active users to {{n}}. Details and next month\'s plan are below.' });

console.log('Seeded', store.listItems({ status: 'pending' }).length, 'pending items.');
