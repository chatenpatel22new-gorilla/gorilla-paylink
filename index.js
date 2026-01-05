import 'dotenv/config';
import { google } from 'googleapis';
import Database from 'better-sqlite3';

const LABEL = 'MAGENTO_ORDERS';

const auth = new google.auth.JWT(
  process.env.GMAIL_CLIENT_EMAIL,
  null,
  process.env.GMAIL_PRIVATE_KEY.replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/gmail.readonly']
);

const gmail = google.gmail({ version: 'v1', auth });
const db = new Database('orders.db');

db.prepare(`
  CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    email_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

async function run() {
  await auth.authorize();

  const res = await gmail.users.messages.list({
    userId: 'me',
    labelIds: [LABEL],
    maxResults: 10
  });

  if (!res.data.messages) {
    console.log('No new Magento orders');
    return;
  }

  for (const msg of res.data.messages) {
    const exists = db
      .prepare('SELECT 1 FROM orders WHERE email_id = ?')
      .get(msg.id);

    if (exists) continue;

    const full = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'metadata'
    });

    const subject =
      full.data.payload.headers.find(h => h.name === 'Subject')?.value || '';

    console.log('New order email:', subject);

    db.prepare(
      'INSERT INTO orders (order_id, email_id) VALUES (?, ?)'
    ).run(subject, msg.id);
  }
}

run().catch(console.error);
