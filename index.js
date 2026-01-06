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
const IMAP_TLS = (process.env.IMAP_TLS ?? "true") !== "false";

// Gmail label/folder name in IMAP (Gmail exposes labels as folders)
const IMAP_BOX = process.env.IMAP_BOX || "MAGENTO_ORDERS";

// Must contain BOTH strings
const MUST_CONTAIN = ["Credit Card", "United Kingdom"];

// Polling
const POLL_MS = Number(process.env.POLL_MS || 60_000);

// If true, do one check then idle (do NOT exit on Railway)
const RUN_ONCE = (process.env.RUN_ONCE ?? "false") === "true";

/* =========================
   HELPERS
========================= */

function required(name, val) {
  if (!val) throw new Error(`Missing required env var: ${name}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractText(parts) {
  // Gmail can split text bodies; safely join all TEXT bodies
  return parts
    .filter((p) => p.which === "TEXT" && typeof p.body === "string")
    .map((p) => p.body)
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

  console.log(`[imap] connecting to ${IMAP_HOST}:${IMAP_PORT} tls=${IMAP_TLS}`);
  const connection = await imaps.connect(config);

  console.log(`[imap] opening box: ${IMAP_BOX}`);
  await connection.openBox(IMAP_BOX);
  console.log(`[imap] box opened`);

  // ✅ Server-side filtering: only return emails whose TEXT contains both strings.
  // This avoids scanning 16k+ emails.
  const searchCriteria = [
    "ALL",
    ["TEXT", MUST_CONTAIN[0]],
    ["TEXT", MUST_CONTAIN[1]],
  ];

  const fetchOptions = {
    bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE)", "TEXT"],
    markSeen: false,
  };

  console.log(`[imap] searching for: "${MUST_CONTAIN[0]}" AND "${MUST_CONTAIN[1]}"`);
  const results = await connection.search(searchCriteria, fetchOptions);
  console.log(`[imap] server returned ${results.length} candidate message(s)`);

  let matchCount = 0;

  for (const r of results) {
    const headerPart = r.parts.find((p) => p.which?.startsWith("HEADER"));
    const header = headerPart?.body || {};
    const subject = header.subject?.[0] || "(no subject)";

    const text = extractText(r.parts) || "";

    // Double-check locally too (belt + braces)
    const isMatch = MUST_CONTAIN.every((s) => text.includes(s));
    if (!isMatch) {
      console.log(`[skip] ${subject}`);
      continue;
    }

    matchCount++;
    console.log(`\n[MATCH FOUND] Subject: ${subject}`);

    // Optional parsing (safe)
    const orderMatch = text.match(/Order\s+#(\d+)/i);
    const totalMatch = text.match(/Grand Total \(Incl\.Tax\)\s+£([\d.]+)/i);

    if (orderMatch) console.log(`Order #: ${orderMatch[1]}`);
    if (totalMatch) console.log(`Amount: £${totalMatch[1]}`);

    console.log(`-----------------------------`);
  }

  console.log(`[imap] matching emails confirmed: ${matchCount}`);

  connection.end();
}

/* =========================
   MAIN LOOP
========================= */

async function loopForever() {
  while (true) {
    try {
      await checkMailboxOnce();
    } catch (err) {
      console.error("[imap] ERROR:", err?.stack || err?.message || err);
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
    console.log("[run] RUN_ONCE=true (will run once, then idle)");
    try {
      await checkMailboxOnce();
      console.log("[run] done (RUN_ONCE=true)");
    } catch (err) {
      console.error("[run] ERROR:", err?.stack || err?.message || err);
    }

    // ✅ Don’t exit on Railway; keep service alive for healthchecks
    // (If you actually want it to stop, only do that locally — not on Railway)
    while (true) {
      await sleep(60_000);
    }
  } else {
    await loopForever();
  }
})();
