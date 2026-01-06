import http from "http";
import "dotenv/config";
import imaps from "imap-simple";

const IMAP_HOST = process.env.IMAP_HOST || "imap.gmail.com";
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASS = process.env.IMAP_PASS;
const IMAP_TLS  = (process.env.IMAP_TLS ?? "true") !== "false";

// Gmail label/folder OR inbox fallback
const IMAP_BOX  = process.env.IMAP_BOX || "INBOX";

// Only match emails containing BOTH strings
const MUST_CONTAIN = ["Credit Card", "United Kingdom"];

// Poll frequency
const POLL_MS = Number(process.env.POLL_MS || 60_000);

// If true, do one check and exit (great for testing)
const RUN_ONCE = (process.env.RUN_ONCE ?? "false") === "true";

function required(name, val) {
  if (!val) throw new Error(`Missing required env var: ${name}`);
}

async function checkMailboxOnce() {
  required("IMAP_USER", IMAP_USER);
  required("IMAP_PASS", IMAP_PASS);

  const config = {
    imap: {
      user: IMAP_USER,
      password: IMAP_PASS,
      host: IMAP_HOST,
      port: IMAP_PORT,
      tls: IMAP_TLS,
      authTimeout: 20_000,
      // For Gmail, keep strict TLS. Don’t disable verification.
      tlsOptions: { servername: IMAP_HOST, rejectUnauthorized: true },
    },
  };

  console.log(`[imap] connecting to ${IMAP_HOST}:${IMAP_PORT} tls=${IMAP_TLS} box=${IMAP_BOX}`);

  const connection = await imaps.connect(config);
  await connection.openBox(IMAP_BOX);

  // Gmail trick: if you use IMAP_BOX="INBOX" you can still target label using X-GM-RAW
  // const searchCriteria = [["X-GM-RAW", 'label:MAGENTO_ORDERS is:unread']];
  // Otherwise: just UNSEEN in the box you opened:
  const searchCriteria = ["UNSEEN"];

  const fetchOptions = { bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE)", "TEXT"], markSeen: false };
  const results = await connection.search(searchCriteria, fetchOptions);

  console.log(`[imap] found ${results.length} unseen messages`);

  for (const r of results) {
    const header = r.parts.find(p => p.which?.startsWith("HEADER"))?.body;
    const text   = r.parts.find(p => p.which === "TEXT")?.body || "";

    const subject = header?.subject?.[0] || "(no subject)";

    const ok = MUST_CONTAIN.every(s => text.includes(s));
    if (!ok) {
      console.log(`[skip] subject: ${subject} (missing Credit Card/United Kingdom)`);
      continue;
    }

    console.log(`[MATCH] subject: ${subject}`);
    // TODO: parse order # and amount from text here
  }

  connection.end();
}

async function loopForever() {
  while (true) {
    try {
      await checkMailboxOnce();
    } catch (err) {
      console.error("[imap] ERROR:", err?.message || err);
    }
    console.log(`[loop] sleeping ${POLL_MS}ms`);
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

// Keep Railway happy: simple HTTP server
const PORT = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("gorilla-paylink: ok\n");
}).listen(PORT, () => console.log(`[web] listening on ${PORT}`));

// Run
(async () => {
  if (RUN_ONCE) {
    await checkMailboxOnce();
    console.log("[run] done (RUN_ONCE=true), exiting");
    process.exit(0);
  }
  await loopForever();
})();
