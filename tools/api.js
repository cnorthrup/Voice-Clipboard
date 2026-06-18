#!/usr/bin/env node
/**
 * Authenticated API client for Salesforce, Confluence (Atlassian Cloud), and Asana.
 * Zero external dependencies — uses only Node.js built-in modules.
 *
 * Auth is loaded from tools/.sessions.json (browser session import) first,
 * then falls back to tools/credentials.json (API tokens).
 *
 * To import a browser session:
 *   node tools/import-session.js < curl.txt
 *
 * Usage:
 *   node tools/api.js salesforce query "SELECT Id, Name FROM Contact LIMIT 5"
 *   node tools/api.js salesforce get /services/data/v58.0/sobjects/
 *   node tools/api.js salesforce post /services/data/v58.0/sobjects/Contact '{"LastName":"Smith"}'
 *   node tools/api.js salesforce patch /services/data/v58.0/sobjects/Contact/<id> '{"Phone":"555-1234"}'
 *
 *   node tools/api.js confluence verify
 *   node tools/api.js confluence search "text ~ \"meeting notes\" AND type = page"
 *   node tools/api.js confluence get-page <pageId>
 *   node tools/api.js confluence list-spaces
 *   node tools/api.js confluence get "/wiki/rest/api/content?type=page&limit=10"
 *   node tools/api.js confluence create-page <spaceKey> "Page Title" "<p>Body HTML</p>"
 *
 *   node tools/api.js asana verify
 *   node tools/api.js asana workspaces
 *   node tools/api.js asana projects [workspace_gid]
 *   node tools/api.js asana tasks <project_gid>
 *   node tools/api.js asana get-task <task_gid>
 *   node tools/api.js asana create-task <project_gid> "Task name" ["notes"]
 *   node tools/api.js asana get /projects
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const TOOLS_DIR = __dirname;
const CREDS_FILE = path.join(TOOLS_DIR, 'credentials.json');
const SESSION_FILE = path.join(TOOLS_DIR, '.sessions.json');

// ─── Utilities ───────────────────────────────────────────────────────────────

function loadJSON(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function httpsRequest(urlStr, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let bodyBuf;
    if (body !== undefined) {
      bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      headers['Content-Length'] = bodyBuf.length;
    }
    const { hostname, port, pathname, search, protocol } = new URL(urlStr);
    const req = https.request({
      hostname,
      port: port || (protocol === 'https:' ? 443 : 80),
      path: pathname + search,
      method,
      headers,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function parseBody(res) {
  try { return JSON.parse(res.body); }
  catch { return res.body; }
}

function output(data) {
  console.log(JSON.stringify(data, null, 2));
}

function die(msg) {
  console.error('Error:', msg);
  process.exit(1);
}

// ─── Auth resolver ────────────────────────────────────────────────────────────
// Returns { baseUrl, authHeaders } for a service.
// Prefers browser session (.sessions.json) over stored tokens (credentials.json).

function getAuth(service) {
  const session = loadJSON(SESSION_FILE)[service];
  const creds = loadJSON(CREDS_FILE)[service];

  // ── Browser session (imported via import-session.js) ──
  if (session) {
    const ageMins = (Date.now() - (session.created_at || 0)) / 60000;
    if (ageMins > 480) { // 8 hours
      process.stderr.write(`Warning: ${service} browser session is ${Math.round(ageMins / 60)}h old and may have expired.\n`);
      process.stderr.write(`Re-import with: node tools/import-session.js ${service} < curl.txt\n`);
    }

    if (session.auth_type === 'session' && session.session_id) {
      // Salesforce: sid cookie value is used directly as Bearer token
      return {
        baseUrl: session.instance_url,
        authHeaders: { 'Authorization': `Bearer ${session.session_id}` },
      };
    }

    if (session.auth_type === 'cookie' && session.cookies) {
      const cookieStr = Object.entries(session.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
      return {
        baseUrl: session.base_url || '',
        authHeaders: {
          'Cookie': cookieStr,
          ...(session.extra_headers || {}),
        },
      };
    }
  }

  // ── Stored API tokens (credentials.json) ──
  if (creds) {
    if (service === 'confluence' && creds.api_token) {
      const basic = Buffer.from(`${creds.email}:${creds.api_token}`).toString('base64');
      return {
        baseUrl: (creds.base_url || '').replace(/\/$/, ''),
        authHeaders: { 'Authorization': `Basic ${basic}` },
      };
    }
    if (service === 'asana' && creds.personal_access_token) {
      return {
        baseUrl: 'https://app.asana.com/api/1.0',
        authHeaders: { 'Authorization': `Bearer ${creds.personal_access_token}` },
      };
    }
    // Salesforce token-based auth is handled separately via sf.login()
  }

  return null;
}

// ─── Generic service request ──────────────────────────────────────────────────

async function serviceRequest(service, method, apiPath, body, baseUrlOverride) {
  const auth = getAuth(service);
  if (!auth) {
    die(
      `No auth found for ${service}.\n` +
      `  Option 1 (browser session): node tools/import-session.js ${service} < curl.txt\n` +
      `  Option 2 (API token): add credentials to tools/credentials.json`
    );
  }

  const baseUrl = baseUrlOverride || auth.baseUrl;
  const cleanPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  const url = `${baseUrl}${cleanPath}`;

  const headers = {
    'Accept': 'application/json',
    ...auth.authHeaders,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await httpsRequest(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  return { status: res.status, data: parseBody(res) };
}

// ─── Salesforce ───────────────────────────────────────────────────────────────
// Salesforce has its own login flow (SOAP) for token-based auth.
// When a browser session is present, it skips login entirely.

const sf = {
  async login() {
    const creds = loadJSON(CREDS_FILE).salesforce;
    if (!creds) die('No salesforce section in credentials.json. See credentials.example.json.');

    const loginHost = creds.sandbox ? 'https://test.salesforce.com' : 'https://login.salesforce.com';
    const password = creds.password + (creds.security_token || '');

    // SOAP login — no Connected App required
    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:urn="urn:partner.soap.sforce.com">
  <soapenv:Body>
    <urn:login>
      <urn:username>${creds.username}</urn:username>
      <urn:password>${password}</urn:password>
    </urn:login>
  </soapenv:Body>
</soapenv:Envelope>`;

    const res = await httpsRequest(`${loginHost}/services/Soap/u/57.0`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '""' },
      body: soapBody,
    });

    if (res.status !== 200) {
      const fault = res.body.match(/<faultstring>(.*?)<\/faultstring>/s);
      die(fault ? fault[1].trim() : `Login failed (HTTP ${res.status})`);
    }

    const sidMatch = res.body.match(/<sessionId>(.*?)<\/sessionId>/);
    const urlMatch = res.body.match(/<serverUrl>(.*?)<\/serverUrl>/);
    if (!sidMatch) die('Could not extract session ID from SOAP response');

    const serverUrl = urlMatch?.[1] ?? loginHost;
    const { protocol, hostname } = new URL(serverUrl);
    const instanceUrl = `${protocol}//${hostname}`;

    const sessions = loadJSON(SESSION_FILE);
    sessions.salesforce = { auth_type: 'session', session_id: sidMatch[1], instance_url: instanceUrl, created_at: Date.now() };
    saveJSON(SESSION_FILE, sessions);

    console.log(`Salesforce login successful. Instance: ${instanceUrl}`);
    return sessions.salesforce;
  },

  async request(method, apiPath, body, allowRetry = true) {
    const auth = getAuth('salesforce');

    // No session at all — try SOAP login if credentials are available
    if (!auth) {
      const creds = loadJSON(CREDS_FILE).salesforce;
      if (!creds?.username) {
        die(
          'No Salesforce auth found.\n' +
          '  Option 1 (browser session): node tools/import-session.js salesforce < curl.txt\n' +
          '  Option 2 (credentials): fill in tools/credentials.json and run: node tools/api.js salesforce login'
        );
      }
      await this.login();
      return this.request(method, apiPath, body, false);
    }

    const url = `${auth.baseUrl}${apiPath.startsWith('/') ? apiPath : '/' + apiPath}`;
    const headers = { 'Accept': 'application/json', ...auth.authHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await httpsRequest(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && allowRetry) {
      // Try re-logging in if credentials are available
      const creds = loadJSON(CREDS_FILE).salesforce;
      if (creds?.username) {
        process.stderr.write('Salesforce session expired — re-logging in...\n');
        await this.login();
        return this.request(method, apiPath, body, false);
      }
      process.stderr.write('Session expired. Re-import with: node tools/import-session.js salesforce < curl.txt\n');
    }

    return { status: res.status, data: parseBody(res) };
  },

  query(soql) {
    return this.request('GET', `/services/data/v58.0/query?q=${encodeURIComponent(soql)}`);
  },
};

// ─── Confluence ───────────────────────────────────────────────────────────────

const confluence = {
  request(method, apiPath, body) {
    return serviceRequest('confluence', method, apiPath, body);
  },
  verify() { return this.request('GET', '/wiki/rest/api/user/current'); },
  search(cql, limit = 25) {
    return this.request('GET', `/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=version,space`);
  },
  getPage(id) {
    return this.request('GET', `/wiki/rest/api/content/${id}?expand=body.storage,version,space,ancestors`);
  },
  listSpaces() {
    return this.request('GET', '/wiki/rest/api/space?limit=50&type=global');
  },
  createPage(spaceKey, title, bodyHtml) {
    return this.request('POST', '/wiki/rest/api/content', {
      type: 'page', title,
      space: { key: spaceKey },
      body: { storage: { value: bodyHtml, representation: 'storage' } },
    });
  },
};

// ─── Asana ───────────────────────────────────────────────────────────────────

const asana = {
  request(method, apiPath, body) {
    const auth = getAuth('asana');
    if (!auth) die('No Asana auth found. Import a session or add credentials.json.');
    // Asana base URL depends on auth type: PAT uses /api/1.0, cookie uses app.asana.com
    const basePath = auth.authHeaders['Authorization'] ? '/api/1.0' : '';
    const cleanPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
    return serviceRequest('asana', method, basePath + cleanPath, body, auth.baseUrl);
  },
  verify() { return this.request('GET', '/users/me'); },
  workspaces() { return this.request('GET', '/workspaces'); },
  projects(wsGid) {
    const qs = wsGid ? `?workspace=${wsGid}&opt_fields=gid,name,color,archived` : '?opt_fields=gid,name,color,archived';
    return this.request('GET', `/projects${qs}`);
  },
  tasks(projectGid) {
    const params = new URLSearchParams({ project: projectGid, opt_fields: 'gid,name,completed,assignee.name,due_on,notes' });
    return this.request('GET', `/tasks?${params}`);
  },
  getTask(gid) {
    return this.request('GET', `/tasks/${gid}?opt_fields=gid,name,completed,assignee.name,due_on,notes,projects.name,tags.name`);
  },
  createTask(projectGid, name, notes = '') {
    return this.request('POST', '/tasks', { data: { name, notes, projects: [projectGid] } });
  },
};

// ─── Command router ───────────────────────────────────────────────────────────

const [,, service, command, ...args] = process.argv;

async function main() {
  if (!service) {
    console.log([
      'Usage: node tools/api.js <service> <command> [args]',
      '',
      'FIRST TIME SETUP — import a browser session (no credentials needed):',
      '  1. Log in to the service in your browser',
      '  2. DevTools → Network → right-click any request → Copy as cURL (bash)',
      '  3. node tools/import-session.js <service> < curl.txt',
      '',
      'Services: salesforce  confluence  asana',
      '',
      '  salesforce login                        Authenticate via SOAP (needs credentials.json)',
      '  salesforce query "<SOQL>"               Run SOQL query',
      '  salesforce get <path>                   GET request',
      '  salesforce post <path> <json>           POST request',
      '  salesforce patch <path> <json>          PATCH request',
      '  salesforce delete <path>                DELETE request',
      '',
      '  confluence verify                       Check session is working',
      '  confluence search "<CQL>"               Full-text / CQL search',
      '  confluence get-page <id>                Fetch page by ID',
      '  confluence list-spaces                  List all spaces',
      '  confluence create-page <key> <title> <html>',
      '  confluence get <path>                   Generic GET',
      '  confluence post <path> <json>           Generic POST',
      '  confluence put <path> <json>            Generic PUT',
      '',
      '  asana verify                            Check session is working',
      '  asana workspaces                        List workspaces',
      '  asana projects [workspace_gid]          List projects',
      '  asana tasks <project_gid>               List tasks in a project',
      '  asana get-task <task_gid>               Get task details',
      '  asana create-task <project_gid> <name> [notes]',
      '  asana get <path>                        Generic GET',
      '  asana post <path> <json>                Generic POST',
    ].join('\n'));
    process.exit(0);
  }

  let result;

  if (service === 'salesforce') {
    switch (command) {
      case 'login':  await sf.login(); break;
      case 'query':  result = await sf.query(args[0]); break;
      case 'get':    result = await sf.request('GET', args[0]); break;
      case 'post':   result = await sf.request('POST', args[0], JSON.parse(args[1] || '{}')); break;
      case 'patch':  result = await sf.request('PATCH', args[0], JSON.parse(args[1] || '{}')); break;
      case 'delete': result = await sf.request('DELETE', args[0]); break;
      default: die(`Unknown salesforce command: ${command}`);
    }
  } else if (service === 'confluence') {
    switch (command) {
      case 'verify':       result = await confluence.verify(); break;
      case 'search':       result = await confluence.search(args[0]); break;
      case 'get-page':     result = await confluence.getPage(args[0]); break;
      case 'list-spaces':  result = await confluence.listSpaces(); break;
      case 'create-page':  result = await confluence.createPage(args[0], args[1], args[2] || '<p></p>'); break;
      case 'get':          result = await confluence.request('GET', args[0]); break;
      case 'post':         result = await confluence.request('POST', args[0], JSON.parse(args[1] || '{}')); break;
      case 'put':          result = await confluence.request('PUT', args[0], JSON.parse(args[1] || '{}')); break;
      default: die(`Unknown confluence command: ${command}`);
    }
  } else if (service === 'asana') {
    switch (command) {
      case 'verify':      result = await asana.verify(); break;
      case 'workspaces':  result = await asana.workspaces(); break;
      case 'projects':    result = await asana.projects(args[0]); break;
      case 'tasks':       result = await asana.tasks(args[0]); break;
      case 'get-task':    result = await asana.getTask(args[0]); break;
      case 'create-task': result = await asana.createTask(args[0], args[1], args[2]); break;
      case 'get':         result = await asana.request('GET', args[0]); break;
      case 'post':        result = await asana.request('POST', args[0], JSON.parse(args[1] || '{}')); break;
      case 'put':         result = await asana.request('PUT', args[0], JSON.parse(args[1] || '{}')); break;
      case 'delete':      result = await asana.request('DELETE', args[0]); break;
      default: die(`Unknown asana command: ${command}`);
    }
  } else {
    die(`Unknown service: "${service}". Choose: salesforce, confluence, asana`);
  }

  if (result !== undefined) output(result);
}

main().catch(err => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
