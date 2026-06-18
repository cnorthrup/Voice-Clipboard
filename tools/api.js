#!/usr/bin/env node
/**
 * Authenticated API client for Salesforce, Confluence (Atlassian Cloud), and Asana.
 * Zero external dependencies — uses only Node.js built-in modules.
 *
 * Setup: copy tools/credentials.example.json to tools/credentials.json and fill in your tokens.
 *
 * Usage:
 *   node tools/api.js salesforce login
 *   node tools/api.js salesforce query "SELECT Id, Name FROM Contact LIMIT 5"
 *   node tools/api.js salesforce get /services/data/v58.0/sobjects/
 *   node tools/api.js salesforce post /services/data/v58.0/sobjects/Contact '{"LastName":"Smith","Email":"a@b.com"}'
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

function request(urlStr, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let bodyBuf;
    if (body) {
      bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      headers['Content-Length'] = bodyBuf.length;
    }
    const parsed = new URL(urlStr);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
    };
    const req = https.request(opts, res => {
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

function die(msg, code = 1) {
  console.error('Error:', msg);
  process.exit(code);
}

function warn(msg) {
  process.stderr.write(`Warning: ${msg}\n`);
}

// ─── Salesforce ──────────────────────────────────────────────────────────────

const sf = {
  async login() {
    const creds = loadJSON(CREDS_FILE).salesforce;
    if (!creds) die('No salesforce section in credentials.json. See credentials.example.json.');

    const loginHost = creds.instance_url && !creds.instance_url.includes('my.salesforce.com')
      ? creds.instance_url
      : (creds.sandbox ? 'https://test.salesforce.com' : 'https://login.salesforce.com');

    const password = creds.password + (creds.security_token || '');

    // SOAP Username-Password login — works without a Connected App
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

    const res = await request(`${loginHost}/services/Soap/u/57.0`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '""' },
      body: soapBody,
    });

    if (res.status !== 200) {
      const fault = res.body.match(/<faultstring>(.*?)<\/faultstring>/s);
      die(fault ? fault[1].trim() : `Login failed (HTTP ${res.status})`);
    }

    const sessionMatch = res.body.match(/<sessionId>(.*?)<\/sessionId>/);
    const serverMatch = res.body.match(/<serverUrl>(.*?)<\/serverUrl>/);
    if (!sessionMatch) die('Could not extract session ID from SOAP response');

    const serverUrl = serverMatch ? serverMatch[1] : loginHost;
    const parsed = new URL(serverUrl);
    const instanceUrl = `${parsed.protocol}//${parsed.hostname}`;

    const sessions = loadJSON(SESSION_FILE);
    sessions.salesforce = { session_id: sessionMatch[1], instance_url: instanceUrl, created_at: Date.now() };
    saveJSON(SESSION_FILE, sessions);

    console.log(`Salesforce login successful. Instance: ${instanceUrl}`);
    return sessions.salesforce;
  },

  async ensureSession() {
    const sessions = loadJSON(SESSION_FILE);
    const s = sessions.salesforce;
    if (!s || !s.session_id) {
      warn('No Salesforce session cached — logging in now...');
      return this.login();
    }
    const ageMins = (Date.now() - (s.created_at || 0)) / 60000;
    if (ageMins > 110) warn('Salesforce session is over 110 min old and may have expired. Run login if you get 401.');
    return s;
  },

  async apiRequest(method, apiPath, body, retry = true) {
    const s = await this.ensureSession();
    const url = `${s.instance_url}${apiPath}`;
    const headers = {
      'Authorization': `Bearer ${s.session_id}`,
      'Accept': 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await request(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && retry) {
      warn('Session rejected — re-logging in...');
      await this.login();
      return this.apiRequest(method, apiPath, body, false);
    }

    return { status: res.status, data: parseBody(res) };
  },

  async query(soql) {
    return this.apiRequest('GET', `/services/data/v58.0/query?q=${encodeURIComponent(soql)}`);
  },
};

// ─── Confluence (Atlassian Cloud) ────────────────────────────────────────────

const confluence = {
  auth() {
    const creds = loadJSON(CREDS_FILE).confluence;
    if (!creds) die('No confluence section in credentials.json. See credentials.example.json.');
    if (!creds.api_token) die('confluence.api_token is missing in credentials.json');
    const basic = Buffer.from(`${creds.email}:${creds.api_token}`).toString('base64');
    return { baseUrl: creds.base_url.replace(/\/$/, ''), basic };
  },

  async apiRequest(method, apiPath, body) {
    const { baseUrl, basic } = this.auth();
    // Normalise path: ensure it starts with /
    const cleanPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
    const url = `${baseUrl}${cleanPath}`;
    const headers = {
      'Authorization': `Basic ${basic}`,
      'Accept': 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await request(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: parseBody(res) };
  },

  async verify() {
    return this.apiRequest('GET', '/wiki/rest/api/user/current');
  },

  async search(cql, limit = 25) {
    return this.apiRequest('GET', `/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=version,space`);
  },

  async getPage(id) {
    return this.apiRequest('GET', `/wiki/rest/api/content/${id}?expand=body.storage,version,space,ancestors`);
  },

  async listSpaces() {
    return this.apiRequest('GET', '/wiki/rest/api/space?limit=50&type=global');
  },

  async createPage(spaceKey, title, bodyHtml) {
    return this.apiRequest('POST', '/wiki/rest/api/content', {
      type: 'page',
      title,
      space: { key: spaceKey },
      body: { storage: { value: bodyHtml, representation: 'storage' } },
    });
  },
};

// ─── Asana ───────────────────────────────────────────────────────────────────

const asana = {
  auth() {
    const creds = loadJSON(CREDS_FILE).asana;
    if (!creds) die('No asana section in credentials.json. See credentials.example.json.');
    if (!creds.personal_access_token) die('asana.personal_access_token is missing in credentials.json');
    return creds.personal_access_token;
  },

  async apiRequest(method, apiPath, body) {
    const token = this.auth();
    const cleanPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
    const url = `https://app.asana.com/api/1.0${cleanPath}`;
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await request(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: parseBody(res) };
  },

  async verify() {
    return this.apiRequest('GET', '/users/me');
  },

  async workspaces() {
    return this.apiRequest('GET', '/workspaces');
  },

  async projects(workspaceGid) {
    const path = workspaceGid
      ? `/projects?workspace=${workspaceGid}&opt_fields=gid,name,color,archived`
      : '/projects?opt_fields=gid,name,color,archived';
    return this.apiRequest('GET', path);
  },

  async tasks(projectGid, options = {}) {
    const params = new URLSearchParams({
      project: projectGid,
      opt_fields: 'gid,name,completed,assignee.name,due_on,notes',
      ...options,
    });
    return this.apiRequest('GET', `/tasks?${params}`);
  },

  async getTask(taskGid) {
    return this.apiRequest('GET', `/tasks/${taskGid}?opt_fields=gid,name,completed,assignee.name,due_on,notes,projects.name,tags.name`);
  },

  async createTask(projectGid, name, notes = '') {
    return this.apiRequest('POST', '/tasks', {
      data: { name, notes, projects: [projectGid] },
    });
  },
};

// ─── Command router ──────────────────────────────────────────────────────────

const [,, service, command, ...args] = process.argv;

async function main() {
  if (!service) {
    console.log([
      'Usage: node tools/api.js <service> <command> [args]',
      '',
      'Services: salesforce  confluence  asana',
      '',
      '  salesforce login                        Authenticate (caches session)',
      '  salesforce query "<SOQL>"               Run SOQL query',
      '  salesforce get <api-path>               GET request',
      '  salesforce post <api-path> <json>       POST request',
      '  salesforce patch <api-path> <json>      PATCH request',
      '  salesforce delete <api-path>            DELETE request',
      '',
      '  confluence verify                       Check credentials',
      '  confluence search "<CQL>"               Search with CQL',
      '  confluence get-page <id>                Fetch a page by ID',
      '  confluence list-spaces                  List all spaces',
      '  confluence create-page <key> <title> <html>  Create a new page',
      '  confluence get <api-path>               Generic GET',
      '  confluence post <api-path> <json>       Generic POST',
      '  confluence put <api-path> <json>        Generic PUT',
      '',
      '  asana verify                            Check credentials',
      '  asana workspaces                        List workspaces',
      '  asana projects [workspace_gid]          List projects',
      '  asana tasks <project_gid>               List tasks in project',
      '  asana get-task <task_gid>               Get task details',
      '  asana create-task <project_gid> <name> [notes]  Create a task',
      '  asana get <api-path>                    Generic GET',
      '  asana post <api-path> <json>            Generic POST',
    ].join('\n'));
    process.exit(0);
  }

  let result;

  if (service === 'salesforce') {
    switch (command) {
      case 'login':   await sf.login(); break;
      case 'query':   result = await sf.query(args[0]); break;
      case 'get':     result = await sf.apiRequest('GET', args[0]); break;
      case 'post':    result = await sf.apiRequest('POST', args[0], JSON.parse(args[1] || '{}')); break;
      case 'patch':   result = await sf.apiRequest('PATCH', args[0], JSON.parse(args[1] || '{}')); break;
      case 'delete':  result = await sf.apiRequest('DELETE', args[0]); break;
      default: die(`Unknown salesforce command: ${command}`);
    }
  } else if (service === 'confluence') {
    switch (command) {
      case 'verify':        result = await confluence.verify(); break;
      case 'search':        result = await confluence.search(args[0]); break;
      case 'get-page':      result = await confluence.getPage(args[0]); break;
      case 'list-spaces':   result = await confluence.listSpaces(); break;
      case 'create-page':   result = await confluence.createPage(args[0], args[1], args[2] || '<p></p>'); break;
      case 'get':           result = await confluence.apiRequest('GET', args[0]); break;
      case 'post':          result = await confluence.apiRequest('POST', args[0], JSON.parse(args[1] || '{}')); break;
      case 'put':           result = await confluence.apiRequest('PUT', args[0], JSON.parse(args[1] || '{}')); break;
      default: die(`Unknown confluence command: ${command}`);
    }
  } else if (service === 'asana') {
    switch (command) {
      case 'verify':       result = await asana.verify(); break;
      case 'workspaces':   result = await asana.workspaces(); break;
      case 'projects':     result = await asana.projects(args[0]); break;
      case 'tasks':        result = await asana.tasks(args[0]); break;
      case 'get-task':     result = await asana.getTask(args[0]); break;
      case 'create-task':  result = await asana.createTask(args[0], args[1], args[2]); break;
      case 'get':          result = await asana.apiRequest('GET', args[0]); break;
      case 'post':         result = await asana.apiRequest('POST', args[0], JSON.parse(args[1] || '{}')); break;
      case 'put':          result = await asana.apiRequest('PUT', args[0], JSON.parse(args[1] || '{}')); break;
      case 'delete':       result = await asana.apiRequest('DELETE', args[0]); break;
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
