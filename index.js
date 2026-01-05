import "dotenv/config";
import imaps from "imap-simple";

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const config = {
  imap: {
    user: need("IMAP_USER"),
    password: need("IMAP_PASS"),
    host: process.env.IMAP_HOST || "imap.gmail.com",
    port: Number(process.env.IMAP_PORT || 993),
    tls: (process.env.IMAP_TLS || "true").toLowerCase() === "true",
    authTimeout: 20000,
  },
};

const SEARCH_SUBJECT = process.env.SEARCH_SUBJECT || "order confirmation";

(async () => {
  console.log("Connecting to IMAP…");
  const connection = await imaps.connect(config);

  await connection.openBox("INBOX");
  console.log("Connected ✅ Opened INBOX");

  // Search recent emails with subject containing our phrase
  const searchCriteria = ["ALL", ["HEADER", "SUBJECT", SEARCH_SUBJECT]];
  const fetchOptions = { bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE)"], markSeen: false };

  const messages = await connection.search(searchCriteria, fetchOptions);

  console.log(`Found ${messages.length} messages matching subject: "${SEARCH_SUBJECT}"`);

  // Print last 5 subjects
  const last = messages.slice(-5);
  for (const m of last) {
    const headerPart = m.parts?.[0]?.body || {};
    const subject = (headerPart.subject && headerPart.subject[0]) || "(no subject)";
    const from = (headerPart.from && headerPart.from[0]) || "(no from)";
    const date = (headerPart.date && headerPart.date[0]) || "(no date)";
    console.log(`- ${date} | ${from} | ${subject}`);
  }

  await connection.end();
  console.log("Done ✅");
})();
