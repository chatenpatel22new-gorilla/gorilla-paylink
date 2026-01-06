import http from "http";
import "dotenv/config";
import imaps from "imap-simple";

const IMAP_HOST = process.env.IMAP_HOST || "imap.gmail.com";
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASS = process.env.IMAP_PASS;
const IMAP_TLS  = (process.env.IMAP_TLS ?? "true") !== "false";

// IMPORTANT: set this to your Gmail label name
const IMAP_BOX  = process.env.IMAP_BOX || "MAGENTO_ORDERS";

const POLL_MS = Number(process.env.POLL_MS || 60_000);
const RUN_ONCE = (process.env.RUN_ONCE ?? "false") === "true";
const IMAP_ALLOW_SELFSIGNED = (process.env.IMAP_ALLOW_SELFSIGNED ?? "false") === "true";

function required(name, val) {
  if (!val) throw new Error(`Missing required env var: ${name}`);
}

function parseMagentoOrder(text) {
  // Basic extraction based on the email you pasted
  const orderId = text.match(/Your Order\s*#(\d+)/i)?.[1] || null;
  const placedOn = text.match(/Placed on\s*(.+)/i)?.[1]?.trim() || null;
  const grandTotal = text.match(/Grand Total \(Incl\.Tax\)\s*£\s*([\d.]+)/i)?.[1] || null;

  return { orderId, placedOn, grandTotal };
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
      tlsOptions: {
        servername: IMAP_HOST,
        rejectUnauthorized: !IMAP_ALLOW_SELFSIGNED,
      },
    },
  };

  console.log(`[imap] connecting to ${IMAP_HOST}:${IMAP_PORT} tls=${IMAP_TLS} box=${IMAP_BOX}`);

  const connection = await imaps.connect(config);
  await connection.openBox(IMAP_BOX);

  const searchCriteria = ["UNSEEN"];
  const fetchOptions = {
    bodies: ["HEADER.FIELDS (SUBJECT FROM TO DATE)", "TEXT"],
    markSeen: false,
  };

  const results = await connection.search(searchCriteria, fetchOptions);
  console.log(`[imap] found ${results.length} unseen messages`);

  for (const r of results.slice(0, 10)) {
    const header = r.parts.find(p => p.which?.startsWith("HEADER"))?.body;
    const subject = header?.subject?.[0] || "(no subject)";

    const body = r.parts.find(p => p.which === "TEXT")?.body || "";
    const parsed = parseMagentoOrder(body);

    console.log(`[imap] subject: ${subject}`);
    if (parsed.orderId) {
      console.log(`[order] #${parsed.orderId} placedOn="${parsed.placedOn}" grandTotal="${parsed.grandTotal}"`);
    }
  }

  connection.end();
}

async function run() {
  while (true) {
    try {
      await checkMailboxOnce();
    } catch (err) {
      console.error("[imap] ERROR:", err?.message || err);
    }

    if (RUN_ONCE) {
      console.log("[run] done (RUN_ONCE=true), exiting");
      process.exit(0);
    }

    console.log(`[loop] sleeping ${POLL_MS}ms`);
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

// Keep Railway happy: HTTP server
const port = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("gorilla-paylink: ok\n");
}).listen(port, () => console.log(`[web] listening on ${port}`));

run();
