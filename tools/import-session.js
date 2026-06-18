#!/usr/bin/env node
/**
 * Import a live browser session into the API client by parsing a cURL command.
 *
 * HOW TO GET A cURL COMMAND FROM YOUR BROWSER:
 *   1. Log in to the service in your browser as normal (SSO is fine)
 *   2. Open DevTools → Network tab  (F12 on Windows/Linux, Cmd+Opt+I on Mac)
 *   3. Navigate to any page in the service to capture a request
 *   4. In the Network tab, find any request to that service's domain
 *   5. Right-click the request → "Copy" → "Copy as cURL (bash)"
 *   6. Paste the result into the chat or save to a file
 *
 * USAGE:
 *   node tools/import-session.js < /path/to/curl.txt
 *   node tools/import-session.js salesforce < /path/to/curl.txt
 *
 * The service name is auto-detected from the URL if not provided.
 * Supported: salesforce, confluence, asana
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, '.sessions.json');

function loadJSON(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ─── cURL parser ─────────────────────────────────────────────────────────────

function parseCurl(input) {
  // Normalize: collapse backslash-newline continuations, strip bare newlines
  const normalized = input
    .replace(/\\\r?\n\s*/g, ' ')
    .replace(/\r?\n/g, ' ')
    .trim();

  const result = { url: null, headers: {}, cookies: {} };

  // Extract URL (first bare URL or quoted URL after 'curl')
  const urlMatch = normalized.match(/curl\b[^'"\n]*?['"]?(https?:\/\/[^\s'"\\]+)/i);
  if (urlMatch) result.url = urlMatch[1].replace(/['"]/g, '');

  // Extract -H headers (single or double quoted)
  const headerRe = /-H\s+(?:'([^']*)'|"([^"]*)")/g;
  let m;
  while ((m = headerRe.exec(normalized)) !== null) {
    const raw = m[1] !== undefined ? m[1] : m[2];
    const colon = raw.indexOf(':');
    if (colon === -1) continue;
    const name = raw.slice(0, colon).trim().toLowerCase();
    const value = raw.slice(colon + 1).trim();
    if (name === 'cookie') {
      parseCookieString(value, result.cookies);
    } else {
      result.headers[name] = value;
    }
  }

  // Also handle --cookie flag
  const cookieFlag = normalized.match(/--cookie\s+(?:'([^']*)'|"([^"]*)")/);
  if (cookieFlag) parseCookieString(cookieFlag[1] ?? cookieFlag[2], result.cookies);

  return result;
}

function parseCookieString(str, into) {
  str.split(';').forEach(pair => {
    const eq = pair.indexOf('=');
    if (eq === -1) return;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k) into[k] = v;
  });
}

// ─── Service detection ────────────────────────────────────────────────────────

function detectService(url, cookies) {
  if (!url) return null;
  if (/\.salesforce\.com|\.force\.com/.test(url)) return 'salesforce';
  if (/\.atlassian\.net|\.jira\.com/.test(url)) return 'confluence';
  if (/\.asana\.com/.test(url)) return 'asana';
  return null;
}

// ─── Session builders ─────────────────────────────────────────────────────────

function buildSalesforceSession(parsed) {
  // Salesforce REST API accepts the sid cookie value as a Bearer token
  const sid = parsed.cookies['sid'];
  const authHeader = parsed.headers['authorization'];
  const sessionId = sid || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);

  if (!sessionId) {
    throw new Error(
      'No Salesforce session ID found.\n' +
      '  Expected: a "sid" cookie, or an "Authorization: Bearer ..." header.\n' +
      '  Make sure you copied the cURL from a page on your Salesforce instance.'
    );
  }

  const { protocol, hostname } = new URL(parsed.url);
  return {
    auth_type: 'session',
    session_id: sessionId,
    instance_url: `${protocol}//${hostname}`,
    created_at: Date.now(),
  };
}

function buildConfluenceSession(parsed) {
  const { protocol, hostname } = new URL(parsed.url);
  // Preserve Atlassian CSRF headers from the original request
  const extraHeaders = { 'x-atlassian-token': 'no-check' };
  for (const [k, v] of Object.entries(parsed.headers)) {
    if (k.startsWith('x-atlassian') || k.startsWith('atl-') || k === 'x-acpt') {
      extraHeaders[k] = v;
    }
  }
  return {
    auth_type: 'cookie',
    base_url: `${protocol}//${hostname}`,
    cookies: parsed.cookies,
    extra_headers: extraHeaders,
    created_at: Date.now(),
  };
}

function buildAsanaSession(parsed) {
  return {
    auth_type: 'cookie',
    base_url: 'https://app.asana.com',
    cookies: parsed.cookies,
    extra_headers: {},
    created_at: Date.now(),
    _warning: "Asana's public API prefers Bearer tokens. Cookie auth may only work for internal endpoints.",
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) {
      process.stderr.write('Paste cURL command, then press Enter + Ctrl+D (Ctrl+Z on Windows):\n');
      process.stderr.write('─'.repeat(60) + '\n');
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => data += c);
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  const serviceHint = process.argv[2]; // optional override

  const input = await readStdin();
  if (!input.trim()) {
    console.error('No input. Pipe a cURL command: node tools/import-session.js < curl.txt');
    process.exit(1);
  }

  const parsed = parseCurl(input);
  if (!parsed.url) {
    console.error('Could not extract a URL from the cURL command. Is this a valid cURL command?');
    process.exit(1);
  }

  const service = serviceHint || detectService(parsed.url, parsed.cookies);
  if (!service) {
    console.error(`Could not detect service from: ${parsed.url}`);
    console.error('Specify it explicitly: node tools/import-session.js salesforce < curl.txt');
    process.exit(1);
  }

  console.log(`Service : ${service}`);
  console.log(`URL     : ${parsed.url}`);
  console.log(`Cookies : ${Object.keys(parsed.cookies).length} found`);

  let sessionData;
  try {
    if (service === 'salesforce') {
      sessionData = buildSalesforceSession(parsed);
      console.log(`Instance: ${sessionData.instance_url}`);
      console.log(`Session : ${sessionData.session_id.slice(0, 12)}...`);
    } else if (service === 'confluence') {
      sessionData = buildConfluenceSession(parsed);
      console.log(`Base URL: ${sessionData.base_url}`);
      const hasToken = 'cloud.session.token' in parsed.cookies;
      if (!hasToken) console.warn('Warning: No cloud.session.token cookie found — session may not be valid.');
    } else if (service === 'asana') {
      sessionData = buildAsanaSession(parsed);
      const hasAsana = Object.keys(parsed.cookies).some(k => k.startsWith('as_'));
      if (!hasAsana) console.warn('Warning: No Asana (as_*) cookies found — session may not be valid.');
      console.warn('Note: For Asana, a Personal Access Token in credentials.json is more reliable.');
    }
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }

  const sessions = loadJSON(SESSION_FILE);
  sessions[service] = sessionData;
  saveJSON(SESSION_FILE, sessions);

  console.log(`\nSaved to tools/.sessions.json`);
  console.log(`Try: node tools/api.js ${service} verify`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
