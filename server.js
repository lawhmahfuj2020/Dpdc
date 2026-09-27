/**
 * DPDC Prepaid Electricity Dashboard — backend
 *
 * Talks to the same API DPDC's own "AMI" prepaid app uses
 * (amiapp.dpdc.org.bd). That API only returns the CURRENT balance/account
 * snapshot — DPDC does not expose a historical "units consumed" endpoint.
 * So this server polls the balance periodically and keeps its own history
 * file, from which usage/spend-over-time is derived.
 *
 * Configure via environment variables (set these in Render's dashboard):
 *   DPDC_CUSTOMER_NUMBER  - your prepaid customer/account number (required)
 *   POLL_INTERVAL_HOURS   - how often to snapshot balance (default 6)
 *   PORT                  - set automatically by Render
 */

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const CUSTOMER_NUMBER = process.env.DPDC_CUSTOMER_NUMBER || "";
const POLL_INTERVAL_HOURS = Number(process.env.POLL_INTERVAL_HOURS || 6);

// --- DPDC API config (same endpoints/creds the official app uses) ---
const AUTH_URL = "https://amiapp.dpdc.org.bd/auth/login/generate-bearer";
const USAGE_URL = "https://amiapp.dpdc.org.bd/usage/usage-service";
const CLIENT_ID = "auth-ui";
const CLIENT_SECRET = "0yFsAl4nN9jX1GGkgOrvpUxDarf2DT40";
const TENANT_CODE = "DPDC";

// --- Local history storage ---
// NOTE: Render's free-tier filesystem is ephemeral (wiped on redeploy/restart).
// history.json will survive normal uptime but not a redeploy, unless you
// attach a Render Persistent Disk mounted at /data and set DATA_DIR=/data.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

function readHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeHistory(entries) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2));
}

async function getAccessToken() {
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      tenantCode: TENANT_CODE,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error("No access_token in auth response");
  return data.access_token;
}

async function fetchBalance(customerNumber) {
  const token = await getAccessToken();
  const query = `query{
    postBalanceDetails(input: {
      customerNumber: "${customerNumber}",
      tenantCode: "${TENANT_CODE}"
    }) {
      accountId
      customerName
      customerClass
      mobileNumber
      emailId
      accountType
      balanceRemaining
      connectionStatus
      customerType
      minRecharge
    }
  }`;

  const res = await fetch(USAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      accesstoken: token,
      tenantCode: TENANT_CODE,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Usage service failed: ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join("; "));
  const details = json?.data?.postBalanceDetails;
  if (!details) throw new Error("No balance data returned — check the customer number");
  return details;
}

async function snapshotBalance() {
  if (!CUSTOMER_NUMBER) return;
  try {
    const details = await fetchBalance(CUSTOMER_NUMBER);
    const history = readHistory();
    history.push({
      timestamp: new Date().toISOString(),
      balanceRemaining: Number(details.balanceRemaining),
      connectionStatus: details.connectionStatus,
    });
    // keep at most 2 years of 6-hourly snapshots (~2920 entries) to bound file size
    while (history.length > 3000) history.shift();
    writeHistory(history);
    console.log(`[${new Date().toISOString()}] snapshot ok — balance ${details.balanceRemaining}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] snapshot failed:`, err.message);
  }
}

// --- API routes ---

app.get("/api/balance", async (req, res) => {
  const customerNumber = req.query.customerNumber || CUSTOMER_NUMBER;
  if (!customerNumber) {
    return res.status(400).json({ error: "No customer number configured or provided" });
  }
  try {
    const details = await fetchBalance(customerNumber);
    res.json(details);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/history", (req, res) => {
  res.json(readHistory());
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`DPDC dashboard running on port ${PORT}`);
  if (!CUSTOMER_NUMBER) {
    console.warn("DPDC_CUSTOMER_NUMBER is not set — set it in Render's environment variables.");
  }
  // Snapshot once on boot, then on an interval.
  snapshotBalance();
  setInterval(snapshotBalance, POLL_INTERVAL_HOURS * 60 * 60 * 1000);
});
