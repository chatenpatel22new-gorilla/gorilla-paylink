import http from "http";
import "dotenv/config";
import imaps from "imap-simple";

// ---- Config from Railway Variables ----
const IMAP_HOST = process.env.IMAP_HOST || "imap.gmail.com";
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const IMAP_USER = process.env.IMAP_USER; // hello@...
const IMAP_PASS = process.env.IMAP_PASS; // app password (no spaces)
const IMAP_TLS = (process.env.IMAP_TLS ?? "true") !== "false";

// Gmail label/folder OR inbox fallback
const IMAP_BOX = process.env.IMAP_BOX || "INBOX";

// Only match emails containing BOTH strings
const MUST_CONTAIN = ["Credit Card", "United Kingdom"];

// Poll frequency
const POLL_MS = Number(process.env.POLL_MS || 60_000);

// If true, do one check and exit (great for testing)
const RUN_ONCE = (process.env.RUN_ONCE ?? "false") === "true";

// If true, allow self-signed certs (NOT recommended, but useful if your runtime chain is weird)
const IMAP_ALLOW_SELFSIGNED = (process.env.IMAP_ALLOW_SELFSIGNED ?? "false") === "true";

function required(name, val) {
  if (!val) throw new Error(`Missing required env var: ${name}`);
}

function normalizeBodyToString(body) {
  if (body == null) return "";
  if (typeof body === "string") return body;
  // imap-simple sometimes returns objects/arrays for TEXT parts depending on parser
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function extractOrderNumber(text) {
  // Examples:
  // "Your Order #000021753"
  // "Order #000021753"
  const m = text.match(/Order\s*#\s*([0-9]{3,})/i);
  return m ? m[1] : null;
}

function extractGrandTotalInclTax(text) {
  // Your email example contains:
  // "Grand Total (Incl.Tax) £14.19"
  // We prioritise Incl.Tax if present
  let m = text.match(/Grand\s*Total\s*\(Incl\.?Tax\)\s*£\s*([0-9]+(?:\.[0-9]{2})?)/i);
  if (m) return m[1];

  // fallback: any "Grand Total" £X
  m = text.match(/Grand\s*Total.*?£\s*([0-9]+(?:\.[0-9]{2})?)/i);
  return m ? m[1] : null;
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

  // Default: just unread in this mailbox/label
  const searchCriteria = ["UNSEEN"];

  // Fetch both header + text; keep markSeen false while we’re testing
  const fetchOptions = {
    bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE)", "TEXT", "BODY[]"],
    markSeen: false,
  };

  const results = await connection.search(searchCriteria, fetchOptions);
  console.log(`[imap] found ${results.length} unseen messages`);

  for (const r of results) {
    const header = r.parts.find(p => p.which?.startsWith("HEADER"))?.body;
    const subject = header?.subject?.[0] || "(no subject)";

    // Try TEXT first; if missing, fall back to BODY[]
    const textPart =
      r.parts.find(p => p.which === "TEXT") ||
      r.parts.find(p => p.which === "BODY[]");

    const text = normalizeBodyToString(textPart?.body);

    const ok = MUST_CONTAIN.every(s => text.includes(s));
    if (!ok) {
      console.log(`[skip] subject: ${subject} (missing Credit Card/United Kingdom)`);
      continue;
    }

    const orderNo = extractOrderNumber(text);
    const total = extractGrandTotalInclTax(text);

    console.log("=================================");
    console.log("[MATCH] UK Credit Card Order");
    console.log("Subject:", subject);
    if (orderNo) console.log("Order #:", orderNo);
    if (total) console.log("Grand Total (Incl.Tax) £:", total);
    console.log("=================================");
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

// ---- Keep Railway happy: simple HTTP server ----
const PORT = Number(process.env.PORT || 3000);
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("gorilla-paylink: ok\n");
  })
  .listen(PORT, () => console.log(`[web] listening on ${PORT}`));

// ---- Run ----
(async () => {
  try {
    if (RUN_ONCE) {
      await checkMailboxOnce();
      console.log("[run] done (RUN_ONCE=true), exiting");
      process.exit(0);
    }
    await loopForever();
  } catch (err) {
    console.error("[fatal] ERROR:", err?.message || err);
    process.exit(1);
  }
})();
