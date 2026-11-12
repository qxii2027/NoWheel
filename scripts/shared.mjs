#!/usr/bin/env node
/**
 * Shared helpers for the NoWheel skill.
 *
 * Zero npm dependencies. Node.js >= 18 (ESM, built-in fetch / util.parseArgs).
 * All output helpers are tuned for LLM consumption: compact, high signal,
 * never raw API JSON unless the caller passes --json.
 */

import { exec, execFile } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const IS_WIN = process.platform === 'win32';

export const USER_AGENT =
  'nowheel/1.0 (Node.js CLI; icon + open-source research helper)';
export const DEFAULT_TIMEOUT_MS = 15000;

/** Redundant official Iconify hosts, tried in order. */
export const ICONIFY_API_HOSTS = [
  'https://api.iconify.design',
  'https://api.simplesvg.com',
  'https://api.unisvg.com',
];

/** npm registries, tried in order (official first, mirror second). */
export const NPM_REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'];

/* ------------------------------------------------------------------ */
/* Errors and process handling                                        */
/* ------------------------------------------------------------------ */

export class CliError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.name = 'CliError';
    this.hint = hint;
  }
}

export function fail(message, hint = '') {
  throw new CliError(message, hint);
}

/** Diagnostics always go to stderr so stdout stays pipe-friendly. */
export function log(message = '') {
  process.stderr.write(`${message}\n`);
}

export function printHelp(usage) {
  process.stdout.write(`${String(usage).trimEnd()}\n`);
}

export function hasHelp(argv) {
  return argv.includes('--help') || argv.includes('-h') || argv[0] === 'help';
}

/** Parse CLI flags, converting parse errors into friendly CliErrors. */
export function parseCliArgs(args, options) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    fail(err.message, 'Run with --help to see the supported options.');
  }
}

/** Wrap a command body: prints a clean error and sets a non-zero exit code. */
export function runMain(main) {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major < 18) {
    log(`error: Node.js ${process.versions.node} is too old (require >= 18).`);
    log('hint:  Install Node.js 18+ from https://nodejs.org/ or your package manager, then retry.');
    process.exitCode = 1;
    return;
  }

  main().catch((err) => {
    if (err instanceof CliError) {
      log(`error: ${err.message}`);
      if (err.hint) log(`hint:  ${err.hint}`);
    } else {
      log(`error: ${err && err.message ? err.message : String(err)}`);
      if (process.env.DEBUG) log(err && err.stack ? err.stack : '');
    }
    process.exitCode = 1;
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Subprocesses (cross-platform, including .cmd shims on Windows)      */
/* ------------------------------------------------------------------ */

function quoteForWindows(arg) {
  const value = String(arg);
  // Leave simple tokens alone; quote anything with spaces or cmd metacharacters.
  if (/^[\w@%+=:,./\\-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

export async function runCommand(command, args = [], { timeout = 20000, cwd } = {}) {
  const options = { timeout, cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 };

  try {
    if (IS_WIN) {
      // .cmd shims (gh, npx, npm) need cmd.exe. Build one quoted command line
      // instead of execFile+shell, which Node 24 deprecated.
      const line = [command, ...args.map(quoteForWindows)].join(' ');
      const { stdout, stderr } = await execAsync(line, options);
      return { code: 0, stdout: String(stdout), stderr: String(stderr) };
    }
    const { stdout, stderr } = await execFileAsync(command, args, options);
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || err.message || ''),
    };
  }
}

export async function commandAvailable(command, args = ['--version']) {
  const result = await runCommand(command, args, { timeout: 10000 });
  return result.code === 0;
}

/* ------------------------------------------------------------------ */
/* HTTP (proxy-aware, automatic retries)                              */
/* ------------------------------------------------------------------ */

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

function pickProxyEnv(target) {
  const env = process.env;
  const keys =
    target.protocol === 'https:'
      ? ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
      : ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  for (const key of keys) {
    const value = (env[key] || '').trim();
    if (value) return value;
  }
  return '';
}

function isNoProxyHost(target) {
  const raw = (process.env.NO_PROXY || process.env.no_proxy || '').trim();
  if (!raw) return false;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => {
      if (entry === '*') return true;
      let host = entry;
      let port = '';
      const match = /^(.*):(\d+)$/.exec(entry);
      if (match && !entry.startsWith('[')) {
        host = match[1];
        port = match[2];
      }
      if (port && String(target.port || (target.protocol === 'https:' ? 443 : 80)) !== port) {
        return false;
      }
      host = host.replace(/^\*?\./, '').toLowerCase();
      const hostname = target.hostname.toLowerCase();
      return hostname === host || hostname.endsWith(`.${host}`);
    });
}

/** Returns a URL for the configured HTTP(S) proxy, or null. */
export function proxyForUrl(urlString) {
  let target;
  try {
    target = new URL(urlString);
  } catch {
    return null;
  }
  const raw = pickProxyEnv(target);
  if (!raw || isNoProxyHost(target)) return null;
  try {
    const proxy = new URL(raw.includes('://') ? raw : `http://${raw}`);
    return proxy.hostname ? proxy : null;
  } catch {
    return null;
  }
}

function proxyAuthHeader(proxy) {
  if (!proxy.username) return null;
  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password || '');
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/**
 * Custom https agent that tunnels through an HTTP(S) proxy with CONNECT.
 * Lets Node < 24 honour HTTPS_PROXY, which global fetch does not.
 */
function createProxyAgent(target, proxy, timeout) {
  const targetPort = target.port || 443;
  const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
  const proxyTransport = proxy.protocol === 'https:' ? https : http;
  const auth = proxyAuthHeader(proxy);

  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (_options, callback) => {
    let settled = false;
    const done = (err, socket) => {
      if (settled) return;
      settled = true;
      callback(err, socket);
    };

    const connectReq = proxyTransport.request({
      host: proxy.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      headers: {
        Host: `${target.hostname}:${targetPort}`,
        ...(auth ? { 'Proxy-Authorization': auth } : {}),
      },
      timeout,
    });

    connectReq.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        const err = new Error(`Proxy CONNECT failed with HTTP ${res.statusCode}.`);
        err.code = res.statusCode === 407 ? 'PROXY_AUTH' : 'PROXY_CONNECT';
        done(err);
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: target.hostname }, () =>
        done(null, tlsSocket),
      );
      tlsSocket.once('error', (err) => done(err));
    });
    connectReq.once('timeout', () =>
      connectReq.destroy(new Error(`Proxy connect timed out after ${timeout}ms.`)),
    );
    connectReq.once('error', (err) => done(err));
    connectReq.end();
  };
  return agent;
}

function decompress(buffer, encoding) {
  const value = String(encoding || '').toLowerCase();
  try {
    if (value.includes('gzip')) return zlib.gunzipSync(buffer);
    if (value.includes('br')) return zlib.brotliDecompressSync(buffer);
    if (value.includes('deflate')) return zlib.inflateSync(buffer);
  } catch {
    // Return the raw bytes if decoding fails.
  }
  return buffer;
}

function toHeaders(raw) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) {
      headers.append(key, Array.isArray(value) ? value.join(', ') : String(value));
    }
  }
  return headers;
}

/** One proxy-routed request (no retries; redirects are followed here). */
function nodeFetch(urlString, opts, redirectsLeft = 5) {
  const { method = 'GET', headers = {}, body, timeout = DEFAULT_TIMEOUT_MS } = opts;
  const target = new URL(urlString);
  const proxy = proxyForUrl(urlString);
  if (!proxy) {
    // Should not happen: nodeFetch is only used when a proxy is configured.
    return requestViaFetch(urlString, opts);
  }

  return new Promise((resolve, reject) => {
    const finalHeaders = { 'User-Agent': USER_AGENT, ...headers, Host: target.host };

    const onResponse = (res) => {
      const status = res.statusCode || 0;
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const buffer = decompress(Buffer.concat(chunks), res.headers['content-encoding']);

        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirectsLeft > 0) {
          let next;
          try {
            next = new URL(res.headers.location, target).href;
          } catch {
            next = null;
          }
          if (next) {
            nodeFetch(next, { method, headers, body, timeout }, redirectsLeft - 1).then(
              resolve,
              reject,
            );
            return;
          }
        }

        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: toHeaders(res.headers),
          text: buffer.toString('utf8'),
          url: target.href,
        });
      });
    };

    let req;
    try {
      if (target.protocol === 'http:') {
        const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
        const transport = proxy.protocol === 'https:' ? https : http;
        req = transport.request(
          {
            host: proxy.hostname,
            port: proxyPort,
            method,
            path: target.href, // absolute-form request for an HTTP proxy
            headers: finalHeaders,
          },
          onResponse,
        );
      } else {
        req = https.request(
          target,
          {
            method,
            headers: { ...finalHeaders, 'Accept-Encoding': 'identity' },
            agent: createProxyAgent(target, proxy, timeout),
          },
          onResponse,
        );
      }
    } catch (err) {
      reject(err);
      return;
    }

    req.setTimeout(timeout, () => {
      req.destroy(new Error(`Request timed out after ${timeout}ms.`));
    });
    req.on('error', (err) => {
      if (err && err.code === 'ECONNREFUSED') {
        reject(new Error(`Cannot reach proxy ${proxy.host} (connection refused). Check HTTPS_PROXY.`));
        return;
      }
      reject(err);
    });
    if (body) req.write(body);
    req.end();
  });
}

async function requestViaFetch(url, opts) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    body: opts.body,
    redirect: 'follow',
    headers: {
      'User-Agent': USER_AGENT,
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(opts.timeout || DEFAULT_TIMEOUT_MS),
  });
  return {
    ok: res.ok,
    status: res.status,
    headers: res.headers,
    text: await res.text(),
    url: res.url,
  };
}

function retryDelay(attempt, headers) {
  const retryAfter = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(8000, Math.max(0, seconds * 1000));
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.min(8000, Math.max(0, at - Date.now()));
  }
  return Math.min(4000, 300 * 2 ** attempt + Math.random() * 250);
}

/**
 * Request with timeout, transparent proxy support, and automatic retries
 * (network errors, 408/429/5xx, Retry-After). Returns the response object;
 * HTTP error statuses are returned, not thrown.
 */
export async function request(url, opts = {}) {
  const { retries = 2, timeout = DEFAULT_TIMEOUT_MS } = opts;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const useProxy = Boolean(proxyForUrl(url));
      const res = useProxy
        ? await nodeFetch(url, { ...opts, timeout })
        : await requestViaFetch(url, { ...opts, timeout });

      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        await sleep(retryDelay(attempt, res.headers));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (err && err.code === 'PROXY_AUTH') {
        fail(
          'Proxy authentication failed (HTTP 407).',
          'Check the username/password in HTTPS_PROXY, or ask your network administrator.',
        );
      }
      if (attempt < retries) {
        await sleep(retryDelay(attempt));
        continue;
      }
    }
  }

  const detail =
    lastError && lastError.name === 'TimeoutError'
      ? `timed out after ${timeout}ms`
      : (lastError && (lastError.cause?.code || lastError.code || lastError.message)) ||
        'network error';
  fail(
    `Request failed after ${retries + 1} attempt(s): ${url} (${detail})`,
    'If you are behind a proxy, set HTTPS_PROXY/HTTP_PROXY (NO_PROXY is honoured) and retry. Otherwise check connectivity — do not retry manually, the tool already did.',
  );
}

/**
 * Try several equivalent endpoints in order (mirrors / redundant hosts).
 * Fails over on network errors and 5xx; a 4xx answer is returned as-is
 * (it is a valid response, e.g. 404 for a missing icon).
 */
export async function requestFirstOk(urls, opts = {}, onFallback) {
  let lastError;
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    try {
      const res = await request(url, opts);
      if (res.status >= 500 && index < urls.length - 1) {
        lastError = new CliError(`HTTP ${res.status} from ${url}`);
        if (onFallback) onFallback(url, lastError);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (onFallback && index < urls.length - 1) onFallback(url, err);
    }
  }
  throw lastError || new CliError('All endpoints failed.');
}

/* ------------------------------------------------------------------ */
/* GitHub auth: GITHUB_TOKEN -> gh CLI -> anonymous REST               */
/* ------------------------------------------------------------------ */

let githubAuthCache;

export async function getGithubAuth() {
  if (githubAuthCache) return githubAuthCache;

  const envToken = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (envToken) {
    githubAuthCache = { token: envToken, source: 'GITHUB_TOKEN' };
    return githubAuthCache;
  }

  const gh = await runCommand('gh', ['auth', 'token'], { timeout: 8000 });
  const ghToken = gh.stdout.trim();
  if (gh.code === 0 && ghToken) {
    githubAuthCache = { token: ghToken, source: 'gh CLI' };
    return githubAuthCache;
  }

  githubAuthCache = { token: null, source: 'anonymous' };
  return githubAuthCache;
}

/**
 * Low-level GitHub REST request. Throws CliError on failure,
 * including an explicit message when the rate limit is exhausted.
 */
export async function githubFetch(pathOrUrl, opts = {}) {
  const {
    accept = 'application/vnd.github+json',
    timeout = DEFAULT_TIMEOUT_MS,
  } = opts;
  const auth = await getGithubAuth();
  const url = /^https?:\/\//i.test(pathOrUrl)
    ? pathOrUrl
    : `https://api.github.com${pathOrUrl}`;

  const headers = {
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': USER_AGENT,
  };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;

  const res = await request(url, { headers, timeout });

  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0' || res.text.includes('rate limit')) {
      const resetEpoch = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
      const resetAt = resetEpoch ? new Date(resetEpoch).toLocaleTimeString() : 'soon';
      fail(
        'GitHub API rate limit reached.',
        `Set GITHUB_TOKEN (or install and run \`gh auth login\`). Limit resets around ${resetAt}.`,
      );
    }
    fail(
      `GitHub API returned ${res.status}.`,
      res.text.replace(/\s+/g, ' ').slice(0, 200),
    );
  }

  if (!res.ok) {
    if (res.status === 404) {
      fail(
        `Not found: ${url}`,
        'Check the owner/repo spelling (GitHub is case-sensitive) and that the project is public.',
      );
    }
    fail(
      `GitHub API ${res.status} for ${url}.`,
      res.text.replace(/\s+/g, ' ').slice(0, 200),
    );
  }

  return res;
}

export async function githubJson(pathOrUrl, opts = {}) {
  const res = await githubFetch(pathOrUrl, opts);
  try {
    return JSON.parse(res.text);
  } catch {
    fail(`GitHub returned invalid JSON for ${pathOrUrl}.`);
  }
}

/** GitHub raw text (README, etc). Returns null on 404 instead of throwing. */
export async function githubRaw(pathOrUrl, opts = {}) {
  try {
    const res = await githubFetch(pathOrUrl, {
      accept: 'application/vnd.github.raw',
      ...opts,
    });
    return res.text;
  } catch (err) {
    if (err instanceof CliError && err.message.startsWith('Not found')) return null;
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Formatting                                                         */
/* ------------------------------------------------------------------ */

export function timeAgo(dateLike) {
  if (!dateLike) return 'unknown';
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

export function daysSince(dateLike) {
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) return Infinity;
  return Math.floor((Date.now() - date.getTime()) / 86400000);
}

export function formatCount(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function humanBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Clean a string for a Markdown table cell. */
export function mdCell(value, maxLength = 160) {
  const text = String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function toPascalCase(name) {
  return String(name)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/* ------------------------------------------------------------------ */
/* License classification (core safety feature)                       */
/* ------------------------------------------------------------------ */

const PERMISSIVE = new Set([
  'MIT',
  'Apache-2.0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSD-2-Clause-Patent',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'WTFPL',
  'BlueOak-1.0.0',
  'Zlib',
  'PostgreSQL',
  'Python-2.0',
  'BSL-1.0',
  'MIT-0',
]);

const RESTRICTED_RE =
  /^(A?GPL|LGPL|SSPL|EUPL|MPL|OSL|CDDL|EPL|CPAL|CC-BY-(SA|NC)|CC-BY-NC|RPL|QPL)/i;

/**
 * Returns { level: 'permissive' | 'restricted' | 'unknown', label }.
 * The label is what the agent should surface to the user.
 */
export function classifyLicense(spdx) {
  const id = String(spdx || '').trim();
  if (!id || /^(NOASSERTION|NONE|null|Other|UNKNOWN)$/i.test(id)) {
    return {
      level: 'unknown',
      label: '⚠️ License unclear — check the LICENSE file and ask the user before use',
    };
  }
  if (PERMISSIVE.has(id)) {
    return { level: 'permissive', label: `✅ Permissive (${id})` };
  }
  if (RESTRICTED_RE.test(id)) {
    return {
      level: 'restricted',
      label: `⚠️ Copyleft/restricted (${id}) — confirm with the user before use`,
    };
  }
  return {
    level: 'unknown',
    label: `⚠️ Unclassified license (${id}) — check the LICENSE file and ask the user`,
  };
}

/**
 * Sniff an SPDX id from raw LICENSE text. Used when GitHub reports
 * NOASSERTION for a recognizable license (common with slight file edits).
 * Returns null when nothing matches confidently.
 */
export function inferLicenseFromText(text) {
  const body = String(text || '');
  if (!body) return null;

  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(body)) {
    return /Version 3/i.test(body) ? 'AGPL-3.0' : 'AGPL-3.0';
  }
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(body)) {
    return /Version 3/i.test(body) ? 'LGPL-3.0' : 'LGPL-2.1';
  }
  if (/GNU GENERAL PUBLIC LICENSE/i.test(body)) {
    return /Version 3/i.test(body) ? 'GPL-3.0' : 'GPL-2.0';
  }
  if (/Server Side Public License/i.test(body)) return 'SSPL-1.0';
  if (/Mozilla Public License/i.test(body)) return 'MPL-2.0';
  if (/Eclipse Public License/i.test(body)) return 'EPL-2.0';
  if (/Apache License/i.test(body) && /Version 2\.0/i.test(body)) return 'Apache-2.0';
  if (/Permission to use, copy, modify, and\/or distribute this software/i.test(body)) {
    return 'ISC';
  }
  if (/Permission is hereby granted, free of charge/i.test(body)) return 'MIT';
  if (/Redistribution and use in source and binary forms/i.test(body)) {
    return /Neither the name/i.test(body) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  }
  if (/This is free and unencumbered software released into the public domain/i.test(body)) {
    return 'Unlicense';
  }
  if (/Creative Commons Attribution/i.test(body)) {
    if (/NonCommercial/i.test(body)) return 'CC-BY-NC';
    if (/ShareAlike/i.test(body)) return 'CC-BY-SA';
    return 'CC-BY';
  }
  if (/Do What The Fuck You Want To Public License/i.test(body)) return 'WTFPL';
  return null;
}

/* ------------------------------------------------------------------ */
/* Filesystem + glob helpers                                          */
/* ------------------------------------------------------------------ */

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function writeText(file, content) {
  await ensureDir(path.dirname(file));
  await writeFile(file, content, 'utf8');
}

export async function fileSize(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * Convert a simple glob ("src/**", "*.{ts,tsx}", "packages/ * /src") to RegExp.
 * Supports *, **, ?, and {a,b} alternatives.
 */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        const alternatives = glob
          .slice(i + 1, end)
          .split(',')
          .map((alt) => escapeRegExp(alt).replace(/\\\*/g, '[^/]*'))
          .join('|');
        out += `(?:${alternatives})`;
        i = end;
      } else {
        out += '\\{';
      }
    } else if ('\\^$.|+()[]'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Split a comma-separated glob list, ignoring commas inside {a,b}. */
export function splitGlobList(input) {
  if (!input) return [];
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of String(input)) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function matchesGlobs(patterns, filePath) {
  if (!patterns.length) return false;
  return patterns.some((pattern) => globToRegExp(pattern).test(filePath));
}

/** Strip badges and presentational HTML from READMEs to save tokens. */
export function stripBadges(markdown) {
  const reduced = String(markdown)
    .replace(/<picture[\s\S]*?<\/picture>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<source\b[^>]*>/gi, '')
    .replace(/<\/?(?:p|div|center|span)\b[^>]*>/gi, '')
    .replace(/<a\b[^>]*>\s*<\/a>/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\]\([^)]*\)/g, '');

  return reduced
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^\[\/\/\]:/.test(trimmed)) return false;
      if (/^(?:&nbsp;|\s|·)+$/.test(trimmed)) return false;
      if (/^\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)$/.test(trimmed)) return false;
      if (/^!\[[^\]]*\]\([^)]*\)$/.test(trimmed)) return false;
      if (/^<a\b[^>]*>\s*<\/a>$/i.test(trimmed)) return false;
      return true;
    })
    .join('\n')
    .replace(/<a\b[^>]*>\s*<\/a>/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}
