const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8788;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = path.join(__dirname, 'oleffi-backend-data.json');

function createEmptyStore() {
  return { companies: {}, sessions: {}, leads: [] };
}

function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return createEmptyStore();
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    if (!parsed.companies || !parsed.sessions) return createEmptyStore();
    if (!Array.isArray(parsed.leads)) parsed.leads = [];
    return parsed;
  } catch (error) {
    console.error('Failed to load backend data:', error);
    return createEmptyStore();
  }
}

let store = loadStore();

function saveStore() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(payload));
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 18);
}

function generateCompanyCode(companyName) {
  const base = slugify(companyName) || 'oleffi';
  let code = `${base}-${Math.floor(1000 + Math.random() * 9000)}`;
  while (store.companies[code]) {
    code = `${base}-${Math.floor(1000 + Math.random() * 9000)}`;
  }
  return code.toUpperCase();
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string' || !storedHash.includes(':')) return false;
  const [salt, hash] = storedHash.split(':');
  const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

function sanitizeText(value, maxLength = 500) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function toList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => sanitizeText(item, 80)).filter(Boolean).slice(0, 20);
}

function buildLeadMessage(lead) {
  return [
    'New Oleffi SaaS interest received',
    `Company: ${lead.companyName}`,
    `Contact: ${lead.contactName}`,
    `Phone: ${lead.phone || 'Not provided'}`,
    `Email: ${lead.email || 'Not provided'}`,
    `City: ${lead.city || 'Not provided'}`,
    `Industry: ${lead.industry || 'Not provided'}`,
    `Employees: ${lead.employees || 'Not provided'}`,
    `Modules: ${lead.modules.length ? lead.modules.join(', ') : 'Not selected'}`,
    `ERP: ${lead.erpName || 'Not provided'}`,
    `Timeline: ${lead.timeline || 'Not provided'}`,
    `Demo mode: ${lead.demoPreference || 'Not provided'}`,
    `Message: ${lead.message || 'No message'}`,
    `Submitted: ${lead.createdAt}`
  ].join('\n');
}

function postJsonToUrl(targetUrl, payload) {
  return new Promise((resolve, reject) => {
    if (!targetUrl) return resolve({ skipped: true });
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);

    const req = transport.request({
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let responseBody = '';
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => resolve({
        statusCode: res.statusCode || 0,
        ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
        body: responseBody
      }));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendTelegramLeadNotification(lead) {
  const token = process.env.LEAD_TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.LEAD_TELEGRAM_CHAT_ID || '';
  if (!token || !chatId) return { skipped: true };

  return postJsonToUrl(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: buildLeadMessage(lead)
  });
}

async function sendWebhookLeadNotification(lead) {
  const webhookUrl = process.env.LEAD_WEBHOOK_URL || '';
  if (!webhookUrl) return { skipped: true };

  return postJsonToUrl(webhookUrl, {
    source: 'Oleffi SaaS',
    type: 'lead_interest',
    lead
  });
}

async function notifyLead(lead) {
  const results = [];

  try {
    const telegramResult = await sendTelegramLeadNotification(lead);
    if (!telegramResult.skipped) results.push({ channel: 'telegram', ...telegramResult });
  } catch (error) {
    results.push({ channel: 'telegram', ok: false, error: error.message });
  }

  try {
    const webhookResult = await sendWebhookLeadNotification(lead);
    if (!webhookResult.skipped) results.push({ channel: 'webhook', ...webhookResult });
  } catch (error) {
    results.push({ channel: 'webhook', ok: false, error: error.message });
  }

  return results;
}

function normalizeStatePayload(payload) {
  const defaultState = {
    db: {
      production: [],
      quality: [],
      downtime: [],
      machines: [],
      config: { company: '', location: '', oeeTarget: '', qualityModuleEnabled: true }
    },
    lists: {
      machines: [],
      rejectionReasons: [],
      operatorNames: [],
      downtimeCategories: [],
      downtimeReasons: [],
      defectTypes: []
    },
    partCatalog: []
  };
  return {
    db: {
      ...defaultState.db,
      ...(payload.db || {}),
      config: {
        ...defaultState.db.config,
        ...((payload.db || {}).config || {})
      }
    },
    lists: {
      ...defaultState.lists,
      ...(payload.lists || {})
    },
    partCatalog: Array.isArray(payload.partCatalog) ? payload.partCatalog : []
  };
}

function buildAuthState(company) {
  const creds = {};
  const usermap = {};
  const usermeta = {};

  company.users.forEach(user => {
    creds[user.username] = '__server_managed__';
    usermap[user.username] = user.role;
    usermeta[user.username] = { active: user.active !== false };
  });

  return { creds, usermap, usermeta };
}

function publicCompany(company) {
  return {
    code: company.code,
    companyName: company.companyName,
    state: company.state,
    auth: buildAuthState(company)
  };
}

function getSessionFromReq(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  return token && store.sessions[token] ? { token, ...store.sessions[token] } : null;
}

function requireSession(req, res) {
  const session = getSessionFromReq(req);
  if (!session) {
    sendJson(res, 401, { ok: false, error: 'Session expired or invalid' });
    return null;
  }
  const company = store.companies[session.companyCode];
  if (!company) {
    sendJson(res, 404, { ok: false, error: 'Company not found' });
    return null;
  }
  const user = company.users.find(entry => entry.username === session.username);
  if (!user || user.active === false) {
    delete store.sessions[session.token];
    saveStore();
    sendJson(res, 403, { ok: false, error: 'This login has been disabled by Admin' });
    return null;
  }
  return { session, company };
}

function upsertUser(company, username, password, role, active = true) {
  const existing = company.users.find(user => user.username === username);
  if (existing) {
    existing.role = role;
    existing.active = active;
    if (password) existing.passwordHash = hashPassword(password);
  } else {
    company.users.push({
      username,
      passwordHash: hashPassword(password || '1234'),
      role,
      active
    });
  }
}

function applyAuthSync(company, payload) {
  const usermap = payload.usermap || {};
  const usermeta = payload.usermeta || {};
  const providedPasswords = payload.passwords || {};
  const nextUsers = [];

  Object.keys(usermap).forEach(username => {
    const existing = company.users.find(user => user.username === username);
    nextUsers.push({
      username,
      role: usermap[username],
      active: usermeta[username]?.active !== false,
      passwordHash: providedPasswords[username]
        ? hashPassword(providedPasswords[username])
        : (existing ? existing.passwordHash : hashPassword('1234'))
    });
  });

  company.users = nextUsers;
}

function readBootstrap(company, username) {
  const current = company.users.find(user => user.username === username);
  return {
    ok: true,
    companyCode: company.code,
    companyName: company.companyName,
    currentUser: username,
    currentRole: current ? current.role : 'prod',
    state: company.state,
    auth: buildAuthState(company)
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 200, { ok: true });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      message: 'Oleffi backend running',
      leadNotifications: {
        telegramConfigured: !!(process.env.LEAD_TELEGRAM_BOT_TOKEN && process.env.LEAD_TELEGRAM_CHAT_ID),
        webhookConfigured: !!process.env.LEAD_WEBHOOK_URL
      }
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/interest') {
    try {
      const body = await getBody(req);
      const contactName = sanitizeText(body.contactName, 120);
      const companyName = sanitizeText(body.companyName, 160);
      const phone = sanitizeText(body.phone, 40);
      const email = sanitizeText(body.email, 120);
      const city = sanitizeText(body.city, 80);
      const industry = sanitizeText(body.industry, 80);
      const employees = sanitizeText(body.employees, 40);
      const modules = toList(body.modules);
      const erpName = sanitizeText(body.erpName, 120);
      const timeline = sanitizeText(body.timeline, 80);
      const demoPreference = sanitizeText(body.demoPreference, 80);
      const message = sanitizeText(body.message, 1500);

      if (!contactName || !companyName) {
        return sendJson(res, 400, { ok: false, error: 'Contact name and company name are required' });
      }

      if (!phone && !email) {
        return sendJson(res, 400, { ok: false, error: 'Phone or email is required' });
      }

      const lead = {
        id: crypto.randomUUID(),
        contactName,
        companyName,
        phone,
        email,
        city,
        industry,
        employees,
        modules,
        erpName,
        timeline,
        demoPreference,
        message,
        createdAt: new Date().toISOString(),
        source: 'oleffi_saas_frontend'
      };

      store.leads.unshift(lead);
      store.leads = store.leads.slice(0, 5000);
      saveStore();

      const notificationResults = await notifyLead(lead);
      const delivered = notificationResults.some(result => result.ok);

      return sendJson(res, 200, {
        ok: true,
        leadId: lead.id,
        message: 'Interest received successfully',
        notifications: {
          attempted: notificationResults.length > 0,
          delivered
        }
      });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/register-company') {
    try {
      const body = await getBody(req);
      const companyName = String(body.company || '').trim();
      const adminUser = String(body.adminUser || '').trim();
      const adminPass = String(body.adminPass || '');
      const prodUser = String(body.prodUser || 'prod').trim();
      const prodPass = String(body.prodPass || '1234');
      const qualUser = String(body.qualUser || 'quality').trim();
      const qualPass = String(body.qualPass || '1234');
      const qualityModuleEnabled = body.qualityModuleEnabled !== false;

      if (!companyName || !adminUser || adminPass.length < 4) {
        return sendJson(res, 400, { ok: false, error: 'Company name, admin user, and admin password are required' });
      }

      const code = generateCompanyCode(companyName);
      const state = normalizeStatePayload({
        db: {
          production: [],
          quality: [],
          downtime: [],
          machines: Array.isArray(body.machines) ? body.machines : [],
          config: {
            company: companyName,
            owner: body.owner || '',
            city: body.city || '',
            sector: body.sector || '',
            msmeType: body.msmeType || '',
            gstin: body.gstin || '',
            udyam: body.udyam || '',
            phone: body.phone || '',
            address: body.address || '',
            employees: body.employees || '',
            oeeTarget: body.oeeTarget || '',
            location: body.city || '',
            qualityModuleEnabled
          }
        },
        lists: body.lists || {},
        partCatalog: body.partCatalog || []
      });

      const company = {
        code,
        companyName,
        createdAt: new Date().toISOString(),
        users: [],
        state
      };

      upsertUser(company, adminUser, adminPass, 'admin', true);
      upsertUser(company, prodUser, prodPass, 'prod', true);
      if (qualityModuleEnabled) upsertUser(company, qualUser, qualPass, 'quality', true);

      store.companies[code] = company;
      saveStore();

      return sendJson(res, 200, {
        ok: true,
        companyCode: code,
        auth: buildAuthState(company),
        state: company.state
      });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    try {
      const body = await getBody(req);
      const companyCode = String(body.companyCode || '').trim().toUpperCase();
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const company = store.companies[companyCode];

      if (!company) return sendJson(res, 404, { ok: false, error: 'Company code not found' });

      const user = company.users.find(entry => entry.username === username);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        return sendJson(res, 401, { ok: false, error: 'Invalid company code or login details' });
      }
      if (user.active === false) {
        return sendJson(res, 403, { ok: false, error: 'This login has been disabled by Admin' });
      }

      const token = randomToken();
      store.sessions[token] = {
        companyCode,
        username,
        role: user.role,
        createdAt: new Date().toISOString()
      };
      saveStore();

      return sendJson(res, 200, { ok: true, token, companyCode, role: user.role, username });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/recover-company-code') {
    try {
      const body = await getBody(req);
      const companyName = String(body.companyName || '').trim().toLowerCase();
      const adminUser = String(body.adminUser || '').trim();
      const adminPass = String(body.adminPass || '');

      if (!companyName || !adminUser || !adminPass) {
        return sendJson(res, 400, { ok: false, error: 'Company name, admin username, and password are required' });
      }

      const company = Object.values(store.companies).find(entry =>
        String(entry.companyName || '').trim().toLowerCase() === companyName
      );

      if (!company) {
        return sendJson(res, 404, { ok: false, error: 'Company not found' });
      }

      const admin = company.users.find(entry => entry.username === adminUser && entry.role === 'admin');
      if (!admin || !verifyPassword(adminPass, admin.passwordHash)) {
        return sendJson(res, 401, { ok: false, error: 'Admin login details do not match' });
      }

      return sendJson(res, 200, { ok: true, companyCode: company.code });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
    const access = requireSession(req, res);
    if (!access) return;
    return sendJson(res, 200, readBootstrap(access.company, access.session.username));
  }

  if (req.method === 'POST' && url.pathname === '/api/state') {
    const access = requireSession(req, res);
    if (!access) return;
    try {
      const body = await getBody(req);
      access.company.state = normalizeStatePayload(body);
      saveStore();
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auth-sync') {
    const access = requireSession(req, res);
    if (!access) return;
    if (access.session.role !== 'admin') {
      return sendJson(res, 403, { ok: false, error: 'Admin access required' });
    }
    try {
      const body = await getBody(req);
      applyAuthSync(access.company, body);
      saveStore();
      return sendJson(res, 200, { ok: true, auth: buildAuthState(access.company) });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const session = getSessionFromReq(req);
    if (session) {
      delete store.sessions[session.token];
      saveStore();
    }
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { ok: false, error: 'Route not found' });
});

server.on('error', error => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`Oleffi backend could not start because port ${PORT} is already in use.`);
    console.error('This usually means another Oleffi backend window is already running.');
    console.error('Close the old backend window, or keep only one backend window open.');
    process.exit(1);
  }
  console.error('Oleffi backend failed to start:', error.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Oleffi backend running on http://${HOST}:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});

