import http from "http";
import "dotenv/config";
import imaps from "imap-simple";

// ---- Config from Railway Variables ----
const IMAP_HOST = process.env.IMAP_HOST || "imap.gmail.com";
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const IMAP_USER = process.env.IMAP_USER;          // hello@...
const IMAP_PASS = process.env.IMAP_PASS;          // app password (no spaces)
const IMAP_TLS  = (process.env.IMAP_TLS ?? "true") !== "false";
const IMAP_BOX  = process.env.IMAP_BOX || "INBOX";

// how often to poll
const POLL_MS = Number(process.env.POLL_MS || 60_000);

function required(name, val) {
  if (!val) throw new Error(`Missing required env var: ${name}`);
}

async function checkMailboxOnce() {
  required("IMAP_USER", IMAP_USER);
  required("IMAP_PASS", IMAP_PASS);

const IMAP_ALLOW_SELFSIGNED = (process.env.IMAP_ALLOW_SELFSIGNED ?? "false") === "true";

const config = {
  imap: {
    user: IMAP_USER,
    password: IMAP_PASS,
    host: IMAP_HOST,
    port: IMAP_PORT,
    tls: IMAP_TLS,
    authTimeout: 20_000,
    tlsOptions: {
      servername: IMAP_HOST,
      rejectUnauthorized: !IMAP_ALLOW_SELFSIGNED,
    },
  },
};


  console.log(`[imap] connecting to ${IMAP_HOST}:${IMAP_PORT} tls=${IMAP_TLS} box=${IMAP_BOX}`);

  const connection = await imaps.connect(config);
  await connection.openBox(IMAP_BOX);

  // TODO: change search criteria to your Magento order emails
  const searchCriteria = ["UNSEEN"]; // start simple
  const fetchOptions = { bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE)", "TEXT"], markSeen: false };

  const results = await connection.search(searchCriteria, fetchOptions);

  console.log(`[imap] found ${results.length} unseen messages`);

  // For now just log subjects (so we know it’s working)
  for (const r of results.slice(0, 5)) {
    const header = r.parts.find(p => p.which?.startsWith("HEADER"))?.body;
    const subject = header?.subject?.[0] || "(no subject)";
    console.log(`[imap] subject: ${subject}`);
  }

  connection.end();
}

async function mainLoop() {
  while (true) {
    try {
      await checkMailboxOnce();
    } catch (err) {
      console.error("[imap] ERROR:", err?.message || err);
      // keep alive even if it errors
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

// ---- Keep Railway happy: run an HTTP server ----
const port = Number(process.env.PORT || 3000);

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("gorilla-paylink: ok\n");
  })
  .listen(port, () => console.log(`[web] listening on ${port}`));

// Start worker loop
mainLoop();
