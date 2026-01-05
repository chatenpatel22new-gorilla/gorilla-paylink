import Imap from "imap-simple";
import dotenv from "dotenv";

dotenv.config();

const config = {
  imap: {
    user: process.env.IMAP_USER,
    password: process.env.IMAP_PASS,
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT),
    tls: process.env.IMAP_SECURE === "true",
    authTimeout: 10000
  }
};

async function testImap() {
  console.log("🔌 Connecting to Gmail IMAP…");

  const connection = await Imap.connect(config);
  console.log("✅ Connected");

  await connection.openBox(process.env.IMAP_LABEL || "INBOX");

  const searchCriteria = ["ALL"];
  const fetchOptions = { bodies: ["HEADER.FIELDS (SUBJECT FROM DATE)"], struct: false };

  const messages = await connection.search(searchCriteria, fetchOptions);

  console.log(`📬 Messages in ${process.env.IMAP_LABEL}:`, messages.length);

  if (messages.length > 0) {
    const last = messages[messages.length - 1];
    console.log("🧾 Latest email headers:");
    console.log(last.parts[0].body);
  }

  await connection.end();
  console.log("🔒 IMAP connection closed");
}

testImap().catch(err => {
  console.error("❌ IMAP test failed:", err.message);
  process.exit(1);
});
