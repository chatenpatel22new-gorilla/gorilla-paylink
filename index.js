import http from "http";
import "dotenv/config";
import imaps from "imap-simple";

/* =========================
   ENV CONFIG
========================= */

const IMAP_HOST = process.env.IMAP_HOST || "imap.gmail.com";
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASS = process.env.IMAP_PASS;
const IMAP_TLS  = (process.env.IMAP_TLS ?? "true") !== "false";

// Gmail label (works as folder in IMAP)
const IMAP_BOX  = process.env.IMAP_BOX || "MAGENTO_ORDERS";

// Must contain BOTH strings
const MUST_CONTAIN = ["Credit Card", "United Kingdom"];

// Polling
const POLL_MS  = Number(process.env.POLL_MS || 60_000);
const RUN_ONCE = (process.env.RUN_ONCE ?? "false") === "true";

/* =========================
   HELPERS
========================= */

function required(name, val) {
  if (!val) throw new Error(`Missing required env var: ${name}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function extractText(parts) {
  // Safely join all TEXT parts (Gmail may split them)
  return parts
    .filter(p => p.which === "TEXT" && typeof p.body === "string")
    .map(p => p.body)
    .join("\n");
}

/* =========================
   IMAP LOGIC
========================= */

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
      tlsOptions: {
        servername: IMAP_HOST,
        rejectUnauthorized: true,
      },
    },
  };

  console.log(`[imap] connecting to ${IMAP_HOST}:${IMAP_PORT}`);
  console.log(`[imap] opening box: ${IMAP_BOX}`);

  const connection = await imaps.connect(config);
  await connection.openBox(IMAP_BOX);

  // Scan EVERYTHING in the label
  const searchCriteria = ["ALL"];

  // 🚨 IMPORTANT: DO NOT REQUEST HTML (this crashes Gmail parsing)
  const fetchOptions = {
    bodies: [
      "HEADER.FIELDS (FROM TO SUBJECT DATE)",
      "TEXT",
    ],
    markSeen: false,
  };

  const results = await connection.search(searchCriteria, fetchOptions);

  console.log(`[imap] scanned ${results.length} messages`);

  let matchCount = 0;

  for (const r of results) {
    const headerPart = r.parts.find(p => p.which?.startsWith("HEADER"));
    const header = headerPart?.body || {};
    const subject = header.subject?.[0] || "(no subject)";

    const text = extractText(r.parts);
    if (!text) {
      console.log(`[skip] ${subject} (no text body)`);
      continue;
    }

    const isMatch = MUST_CONTAIN.every(s => text.includes(s));
    if (!isMatch) {
      console.log(`[skip] ${subject}`);
      continue;
    }

    matchCount++;

    console.log(`\n[MATCH FOUND]`);
    console.log(`Subject: ${subject}`);

    // Optional safe parsing
    const orderMatch = text.match(/Order\s+#(\d+)/i);
    const totalMatch = text.match(/Grand Total \(Incl\.Tax\)\s+£([\d.]+)/i);

    if (orderMatch) {
      console.log(`Order #: ${orderMatch[1]}`);
    }
    if (totalMatch) {
      console.log(`Amount: £${totalMatch[1]}`);
    }

    console.log(`-----------------------------`);
  }

  console.log(`[imap] matching emails: ${matchCount}`);

  connection.end();
}

/* =========================
   LOOP
========================= */

async function loopForever() {
  while (true) {
    try {
      await checkMailboxOnce();
    } catch (err) {
      console.error("[imap] ERROR:", err?.message || err);
    }
    console.log(`[loop] sleeping ${POLL_MS}ms`);
    await sleep(POLL_MS);
  }
}

/* =========================
   HTTP (Railway healthcheck)
========================= */

const PORT = Number(process.env.PORT || 3000);

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("gorilla-paylink OK\n");
}).listen(PORT, () => {
  console.log(`[web] listening on ${PORT}`);
});

/* =========================
   START
========================= */

(async () => {
  if (RUN_ONCE) {
    console.log("[run] RUN_ONCE=true");
    await checkMailboxOnce();
    console.log("[run] done, exiting");
    process.exit(0);
  }

  await loopForever();
})();
