// index.js
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

// Gmail label/folder (e.g. MAGENTO_ORDERS) or INBOX
const IMAP_BOX  = process.env.IMAP_BOX || "MAGENTO_ORDERS";

// Must contain BOTH strings (case-insensitive)
const MUST_CONTAIN = ["Credit Card", "United Kingdom"];

// Polling
const POLL_MS = Number(process.env.POLL_MS || 60_000);
const RUN_ONCE = (process.env.RUN_ONCE ?? "false") === "true";

// Optional: avoid scanning your entire mailbox every time
// Defaults are safe even if you don’t set them.
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES || 200);     // limit newest N
const SINCE_DAYS   = Number(process.env.SINCE_DAYS || 14);        // only last N days

/* =========================
   HELPERS
========================= */

function required(name, val) {
  if (!val) throw new Error(`Missing required env var: ${name}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stripHtml(html) {
  if (!html) return "";
  // super simple tag strip + some entity cleanup
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function containsAll(haystack, needles) {
  const h = (haystack || "").toLowerCase();
  return needles.every((n) => h.includes(String(n).toLowerCase()));
}

function parseOrderAndTotal(text) {
  // Works for many Magento templates; keep “best effort”
  const orderMatch =
    text.match(/Your Order\s*#\s*(\d+)/i) ||
    text.match(/Order\s*#\s*(\d+)/i);

  const totalMatch =
    text.match(/Grand\s+Total\s*\(Incl\.?Tax\)\s*£\s*([\d.]+)/i) ||
    text.match(/Grand\s+Total.*?£\s*([\d.]+)/i);

  return {
    orderNumber: orderMatch?.[1] || null,
    amountGBP: totalMatch?.[1] || null,
  };
}

/* =========================
   IMAP LOGIC
========================= */

async function openBoxSafe(connection, boxName) {
  try {
    await connection.openBox(boxName);
    return boxName;
  } catch (e) {
    // Fallbacks that sometimes help on Gmail accounts
    const fallbacks = ["INBOX", "[Gmail]/All Mail", "[Google Mail]/All Mail"];
    for (const fb of fallbacks) {
      try {
        await connection.openBox(fb);
        console.log(`[imap] WARN: failed to open "${boxName}", opened "${fb}" instead`);
        return fb;
      } catch (_) {}
    }
    throw e;
  }
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
        rejectUnauthorized: true, // keep strict for Gmail
      },
    },
  };

  console.log(`[imap] connecting to ${IMAP_HOST}:${IMAP_PORT} tls=${IMAP_TLS}`);
  const connection = await imaps.connect(config);

  const openedBox = await openBoxSafe(connection, IMAP_BOX);
  console.log(`[imap] opened box: ${openedBox}`);

  // IMPORTANT: searching ALL can be huge; we narrow by SINCE + then limit newest N
  const sinceDate = new Date(Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000);
  const searchCriteria = [["SINCE", sinceDate]]; // works with most IMAP servers (incl Gmail)

  const fetchOptions = {
    // TEXT is often empty for HTML-only emails, so fetch both.
    bodies: [
      "HEADER.FIELDS (FROM TO SUBJECT DATE)",
      "TEXT",
      "HTML"
    ],
    markSeen: false,
  };

  const results = await connection.search(searchCriteria, fetchOptions);

  // newest first (by internal date if available; else keep original)
  const newest = [...results].reverse().slice(0, MAX_MESSAGES);

  console.log(
    `[imap] scanned ${results.length} messages since ${sinceDate.toISOString().slice(0, 10)} (processing newest ${newest.length})`
  );

  let matchCount = 0;

  for (const r of newest) {
    const header = r.parts.find((p) => p.which?.startsWith("HEADER"))?.body;
    const subject = header?.subject?.[0] || "(no subject)";

    const textPart = r.parts.find((p) => p.which === "TEXT")?.body || "";
    const htmlPart = r.parts.find((p) => p.which === "HTML")?.body || "";

    const htmlAsText = stripHtml(htmlPart);
    const combined = `${textPart}\n${htmlAsText}`;

    const isMatch = containsAll(combined, MUST_CONTAIN);

    if (!isMatch) {
      // uncomment if you want noisy logs:
      // console.log(`[skip] ${subject}`);
      continue;
    }

    matchCount++;

    console.log(`\n[MATCH FOUND]`);
    console.log(`Subject: ${subject}`);

    const { orderNumber, amountGBP } = parseOrderAndTotal(combined);

    if (orderNumber) console.log(`Order #: ${orderNumber}`);
    if (amountGBP) console.log(`Amount: £${amountGBP}`);

    // You can add your “generate paylink” step here later.
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

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("gorilla-paylink OK\n");
  })
  .listen(PORT, () => {
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

