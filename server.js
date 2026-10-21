const express = require('express');
const path = require('path');
const { CognitoUserPool, CognitoUser, AuthenticationDetails } = require('amazon-cognito-identity-js');

const app = express();
const PORT = 3000;

// GoalSync API base URL.
const API_URL = process.env.GOALSYNC_API_URL;

// Same Cognito pool/client the real GoalSync web app uses (prod).
const USER_POOL_ID = 'us-west-1_pSKAKk26G';
const CLIENT_ID = '5fa8qq0cfvjaebtsg299lmtnt2';

const USERNAME = process.env.GOALSYNC_USERNAME;
const PASSWORD = process.env.GOALSYNC_PASSWORD;

// Payload used by the scheduled (automatic) events. Overridable via env.
const AUTO_USER_ID = Number(process.env.CLOCK_IN_USER_ID || 14);
const AUTO_LAT = Number(process.env.CLOCK_IN_LAT || 34.4098);
const AUTO_LNG = Number(process.env.CLOCK_IN_LNG || -118.4317);

// Break rule ids (mirror the ones used by the buttons in public/index.html).
const BREAK_RULE_ID = 1; // 15-minute break
const LUNCH_RULE_ID = 2; // 30-minute (mandatory) break

// Local hour/minute (California time) at which the automatic clock-in fires.
const AUTO_TIMEZONE = 'America/Los_Angeles';

const userPool = new CognitoUserPool({ UserPoolId: USER_POOL_ID, ClientId: CLIENT_ID });

let cachedToken = null;
let cachedExpiry = 0;

function loginToCognito() {
  return new Promise((resolve, reject) => {
    const cognitoUser = new CognitoUser({ Username: USERNAME, Pool: userPool });
    const authDetails = new AuthenticationDetails({ Username: USERNAME, Password: PASSWORD });
    cognitoUser.authenticateUser(authDetails, {
      onSuccess: (session) => resolve(session.getAccessToken()),
      onFailure: (err) => reject(err),
    });
  });
}

// Reuses the cached token until ~30s before it actually expires, then logs in again automatically.
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedExpiry > now + 30) return cachedToken;
  const accessToken = await loginToCognito();
  cachedToken = accessToken.getJwtToken();
  cachedExpiry = accessToken.getExpiration();
  return cachedToken;
}

// POSTs a payload to an API path with a fresh/cached bearer token.
// Shared by the HTTP routes and the scheduler.
async function callApi(apiPath, payload) {
  const token = await getAccessToken();
  const response = await fetch(`${API_URL.replace(/\/$/, '')}${apiPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const clockIn = (payload) => callApi('/clock-in', payload);

// ---- Clock-status check -----------------------------------------------------
// GET /clock-status?user_id=<id>, with the bearer token and x-tenant-id header
// (matches what the real app sends).
const CLOCK_STATUS_PATH = process.env.CLOCK_STATUS_PATH || '/clock-status';
const TENANT_ID = process.env.GOALSYNC_TENANT_ID || '1';

// Response shape (confirmed against the real API):
//   { isClockedIn: bool, isOnBreak: bool, lastEntry: {...}, activeBreak: {...}|null }
function parseClockedIn(body) {
  if (!body || typeof body !== 'object') return false;
  if (typeof body.isClockedIn === 'boolean') return body.isClockedIn;
  // Fallback: an open last entry (clocked in, not yet clocked out).
  const entry = body.lastEntry;
  return Boolean(entry && entry.clock_in_time && !entry.clock_out_time);
}

// Fetches the raw clock-status response for the configured user.
async function fetchClockStatus() {
  const token = await getAccessToken();
  const url = `${API_URL.replace(/\/$/, '')}${CLOCK_STATUS_PATH}?user_id=${encodeURIComponent(AUTO_USER_ID)}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-tenant-id': TENANT_ID,
    },
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { url, status: response.status, ok: response.ok, body };
}

// Returns true if the configured user currently has an open shift.
// Fails closed: any error or non-2xx response returns false so the gated
// event is skipped rather than fired on an unknown state.
async function isClockedIn() {
  try {
    const { ok, body } = await fetchClockStatus();
    if (!ok) return false;
    return parseClockedIn(body);
  } catch {
    return false;
  }
}

app.use(express.json());

// Serve everything in the "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// Debug: returns what isClockedIn() computes plus the raw status response,
// so you can see the real shape and fix CLOCK_STATUS_PATH / parseClockedIn().
app.get('/debug-clock-status', async (req, res) => {
  if (!API_URL || !USERNAME || !PASSWORD) {
    return res.status(500).json({ error: 'Set GOALSYNC_API_URL, GOALSYNC_USERNAME, and GOALSYNC_PASSWORD before starting the server.' });
  }

  try {
    const status = await fetchClockStatus();
    res.status(200).json({
      isClockedIn: status.ok ? parseClockedIn(status.body) : false,
      requestUrl: status.url,
      statusCode: status.status,
      ok: status.ok,
      rawResponse: status.body,
    });
  } catch (err) {
    res.status(502).json({ error: `Request failed: ${err.message}` });
  }
});

// Send clock-in payload
app.post('/send-clock-in', async (req, res) => {
  if (!API_URL || !USERNAME || !PASSWORD) {
    return res.status(500).json({ error: 'Set GOALSYNC_API_URL, GOALSYNC_USERNAME, and GOALSYNC_PASSWORD before starting the server.' });
  }

  try {
    const result = await clockIn(req.body);
    res.status(result.status).json(result);
  } catch (err) {
    res.status(502).json({ error: `Request failed: ${err.message}` });
  }
});

// Send clock-out payload
app.post('/send-clock-out', async (req, res) => {
  if (!API_URL || !USERNAME || !PASSWORD) {
    return res.status(500).json({ error: 'Set GOALSYNC_API_URL, GOALSYNC_USERNAME, and GOALSYNC_PASSWORD before starting the server.' });
  }

  try {
    const token = await getAccessToken();
    const response = await fetch(`${API_URL.replace(/\/$/, '')}/clock-out`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(req.body),
    });

    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    res.status(response.status).json({ status: response.status, body });
  } catch (err) {
    res.status(502).json({ error: `Request failed: ${err.message}` });
  }
});

// List tenant's configured break rules (id, duration_minutes, is_paid, etc.)
app.get('/send-break-rules', async (req, res) => {
  if (!API_URL || !USERNAME || !PASSWORD) {
    return res.status(500).json({ error: 'Set GOALSYNC_API_URL, GOALSYNC_USERNAME, and GOALSYNC_PASSWORD before starting the server.' });
  }

  try {
    const token = await getAccessToken();
    const base = API_URL.replace(/\/$/, '');

    const meRes = await fetch(`${base}/users/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const me = await meRes.json();

    const rulesRes = await fetch(`${base}/break-rules?tenant_id=${me.tenant_id}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const rules = await rulesRes.json();

    res.status(rulesRes.status).json({ status: rulesRes.status, tenant_id: me.tenant_id, rules });
  } catch (err) {
    res.status(502).json({ error: `Request failed: ${err.message}` });
  }
});

// Start a break using whichever break_rule_id is sent in the payload
app.post('/send-break-start', async (req, res) => {
  if (!API_URL || !USERNAME || !PASSWORD) {
    return res.status(500).json({ error: 'Set GOALSYNC_API_URL, GOALSYNC_USERNAME, and GOALSYNC_PASSWORD before starting the server.' });
  }

  try {
    const token = await getAccessToken();
    const response = await fetch(`${API_URL.replace(/\/$/, '')}/breaks/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(req.body),
    });

    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    res.status(response.status).json({ status: response.status, body });
  } catch (err) {
    res.status(502).json({ error: `Request failed: ${err.message}` });
  }
});

// End whichever break is currently open 
app.post('/send-break-end', async (req, res) => {
  if (!API_URL || !USERNAME || !PASSWORD) {
    return res.status(500).json({ error: 'Set GOALSYNC_API_URL, GOALSYNC_USERNAME, and GOALSYNC_PASSWORD before starting the server.' });
  }

  try {
    const token = await getAccessToken();
    const response = await fetch(`${API_URL.replace(/\/$/, '')}/breaks/end`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(req.body),
    });

    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    res.status(response.status).json({ status: response.status, body });
  } catch (err) {
    res.status(502).json({ error: `Request failed: ${err.message}` });
  }
});

// Milliseconds from now until the next occurrence of hour:minute wall-clock time
// in the given IANA timezone (handles DST because the offset is read live).
function msUntilNext(hour, minute, timeZone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

  // The same instant expressed as that zone's wall clock, in a UTC-based Date we can do math on.
  const zoneWallClock = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour === 24 ? 0 : +parts.hour, +parts.minute, +parts.second
  );
  const target = new Date(zoneWallClock);
  target.setUTCHours(hour, minute, 0, 0);
  if (target.getTime() <= zoneWallClock) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime() - zoneWallClock;
}

// Standard payloads, matching the buttons in public/index.html.
const basePayload = () => ({ user_id: AUTO_USER_ID, lat: AUTO_LAT, lng: AUTO_LNG });
const breakStart = (ruleId) => () => ({ ...basePayload(), break_rule_id: ruleId });

// A full automated day, in California time. Each entry re-arms itself for the next day.
// requiresClockedIn: only fire if the user currently has an open shift.
const SCHEDULE = [
  // { hour: 9, minute: 0, label: 'clock-in', path: '/clock-in', payload: basePayload },
  { hour: 11, minute: 0, label: 'break-start', path: '/breaks/start', payload: breakStart(BREAK_RULE_ID), requiresClockedIn: true },
  { hour: 11, minute: 15, label: 'break-end', path: '/breaks/end', payload: basePayload, requiresClockedIn: true },
  { hour: 12, minute: 30, label: 'lunch-start', path: '/breaks/start', payload: breakStart(LUNCH_RULE_ID), requiresClockedIn: true },
  { hour: 13, minute: 0, label: 'lunch-end', path: '/breaks/end', payload: basePayload, requiresClockedIn: true },
  { hour: 14, minute: 51, label: 'break-start', path: '/breaks/start', payload: breakStart(BREAK_RULE_ID), requiresClockedIn: true },
  { hour: 15, minute: 0, label: 'break-end', path: '/breaks/end', payload: basePayload, requiresClockedIn: true },
  // { hour: 17, minute: 0, label: 'clock-out', path: '/clock-out', payload: basePayload },
];

// Fires one scheduled event at its next California-time occurrence, then re-arms it daily.
function scheduleEvent(entry) {
  const delay = msUntilNext(entry.hour, entry.minute, AUTO_TIMEZONE);
  const fireAt = new Date(Date.now() + delay);
  console.log(`Scheduled ${entry.label} for ${fireAt.toLocaleString('en-US', { timeZone: AUTO_TIMEZONE })} (California time).`);

  setTimeout(async () => {
    try {
      if (entry.requiresClockedIn && !(await isClockedIn())) {
        console.log(`Skipped ${entry.label}: user is not currently clocked in.`);
      } else {
        const result = await callApi(entry.path, entry.payload());
        console.log(`Auto ${entry.label} sent. Status ${result.status}:`, JSON.stringify(result.body));
      }
    } catch (err) {
      console.error(`Auto ${entry.label} failed:`, err.message);
    }
    scheduleEvent(entry); // re-arm for the next day
  }, delay);
}

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  if (!API_URL || !USERNAME || !PASSWORD) {
    console.log('Automatic schedule disabled: set GOALSYNC_API_URL, GOALSYNC_USERNAME, and GOALSYNC_PASSWORD.');
  } else {
    SCHEDULE.forEach(scheduleEvent);
  }
});