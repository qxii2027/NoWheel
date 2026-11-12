#!/usr/bin/env node
/**
 * oss-scout — find, evaluate, read, and unpack open-source projects
 * instead of rebuilding a proven capability from scratch.
 *
 *   search <query>    Search GitHub + npm (+ Python repos) with license audit.
 *   inspect <target>  Read repo metadata / package deps / latest README or docs.
 *   unpack <o/r>      Download key source files (repomix, else GitHub Trees API).
 *
 * Zero npm dependencies. Node.js >= 18.
 */

import path from 'node:path';
import process from 'node:process';
import {
  CliError,
  NPM_REGISTRIES,
  classifyLicense,
  commandAvailable,
  daysSince,
  ensureDir,
  fail,
  fileSize,
  formatCount,
  hasHelp,
  humanBytes,
  inferLicenseFromText,
  log,
  matchesGlobs,
  mdCell,
  parseCliArgs,
  printHelp,
  request,
  requestFirstOk,
  runCommand,
  runMain,
  splitGlobList,
  stripBadges,
  timeAgo,
  writeText,
  githubJson,
  githubRaw,
} from './shared.mjs';

const USAGE = `
oss-scout — find and reuse proven open-source code instead of reinventing it

Usage:
  node scripts/oss-scout.mjs search <query> [--ecosystem all|github|npm|pypi] [--limit 6] [--json]
  node scripts/oss-scout.mjs inspect <owner/repo | url> [--max-chars 8000] [--json]
  node scripts/oss-scout.mjs unpack <owner/repo> [--include "src/**"] [--out dir] [--engine auto|repomix|builtin] [--max-files 20] [--json]

Commands:
  search    Find candidate projects. GitHub stars, last push, and license risk;
            npm version, freshness, and quality scores.
  inspect   Read a repo's layout, dependencies and latest README, or convert
            any documentation URL into clean Markdown.
  unpack    Copy key source files locally for adaptation (powered by repomix
            when available, with a zero-dependency GitHub API fallback).

Safety:
  - Copyleft / unclear licenses are always flagged. Ask the user before using them.
  - GitHub auth: GITHUB_TOKEN, then the gh CLI, then anonymous (rate limited).
  - Unpacked code is reference material. Keep its license header when porting.
`;

const SEARCH_HELP = `
oss-scout search — find candidate open-source projects

Usage:
  node scripts/oss-scout.mjs search <query> [--ecosystem all|github|npm|pypi] [--limit 6] [--json]

Options:
  --ecosystem  all (GitHub + npm, default), github, npm, or pypi (Python repos).
  --limit      Results per source, 1-25 (default 6).
  --json       Emit JSON instead of Markdown.

Every result carries a license verdict:
  ✅ permissive        safe to use, keep the notice
  ⚠️ copyleft/restricted  ask the user first
  ⚠️ unclear           inspect the LICENSE file and ask the user
`;

const INSPECT_HELP = `
oss-scout inspect — read a repo or documentation page

Usage:
  node scripts/oss-scout.mjs inspect <owner/repo | url> [--max-chars 8000] [--json]

For owner/repo (or a github.com URL):
  GitHub metadata, root layout, monorepo/examples detection, package.json
  dependencies and peerDependencies, and the latest README.

For any other URL:
  Page converted to Markdown via Jina Reader, with a direct-HTML fallback.
  Install / quick-start / usage sections are preserved when truncating.

Options:
  --max-chars  Cap on document characters shown (default 8000).
  --json       Emit JSON instead of Markdown.
`;

const UNPACK_HELP = `
oss-scout unpack — download key source files for adaptation

Usage:
  node scripts/oss-scout.mjs unpack <owner/repo> [--include "src/**"] [--out dir] [--engine auto|repomix|builtin] [--max-files 20] [--json]

Options:
  --include    Glob(s) to include, comma-separated. Default: src/lib source files.
  --out        Output directory (default .tmp/oss-ref/<repo>).
  --engine     auto (default: try repomix, fall back), repomix, or builtin.
  --max-files  Max files copied by the builtin engine (default 20).
  --json       Emit JSON instead of Markdown.

Port only what you need, keep the upstream license header, and delete the
.tmp directory when finished.
`;

const PACK_TIMEOUT_MS = 120000;

/* ------------------------------------------------------------------ */
/* Target parsing                                                     */
/* ------------------------------------------------------------------ */

function parseRepoTarget(input) {
  const value = String(input || '').trim();
  if (!value) return null;

  const urlMatch =
    /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(
      value,
    );
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2] };
  }

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    const [owner, repo] = value.split('/');
    return { owner, repo: repo.replace(/\.git$/i, '') };
  }
  return null;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

/* ------------------------------------------------------------------ */
/* search                                                             */
/* ------------------------------------------------------------------ */

async function searchGithub(query, limit, pythonOnly) {
  const qualified = pythonOnly ? `${query} language:python archived:false` : `${query} archived:false`;
  const data = await githubJson(
    `/search/repositories?q=${encodeURIComponent(qualified)}&sort=stars&order=desc&per_page=${limit}`,
  );
  return (data.items || []).map((item) => ({
    fullName: item.full_name,
    stars: item.stargazers_count,
    forks: item.forks_count,
    pushedAt: item.pushed_at,
    updatedAt: item.updated_at,
    license: item.license ? item.license.spdx_id : null,
    licenseVerdict: classifyLicense(item.license ? item.license.spdx_id : null),
    description: item.description || '',
    url: item.html_url,
    homepage: item.homepage || '',
    language: item.language || '',
    archived: Boolean(item.archived),
    topics: item.topics || [],
  }));
}

async function searchNpm(query, limit) {
  const pathAndQuery = `/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`;
  const res = await requestFirstOk(
    NPM_REGISTRIES.map((registry) => `${registry}${pathAndQuery}`),
    { headers: { Accept: 'application/json' }, timeout: 12000, retries: 1 },
    (failedUrl, err) => {
      let host = failedUrl;
      try {
        host = new URL(failedUrl).host;
      } catch {
        // Keep the raw URL.
      }
      log(`npm registry ${host} failed (${err.message}); trying a mirror...`);
    },
  );

  if (!res.ok) {
    fail(`npm registry returned HTTP ${res.status}.`, res.text.replace(/\s+/g, ' ').slice(0, 160));
  }

  let data;
  try {
    data = JSON.parse(res.text);
  } catch {
    fail('npm registry returned invalid JSON.', `Response started with: ${res.text.slice(0, 120)}`);
  }
  return (data.objects || []).map((entry) => {
    const pkg = entry.package || {};
    const score = entry.score || {};
    const detail = score.detail || {};
    const downloads = entry.downloads || {};
    const pct = (value) => Math.round((Number(value) || 0) * 100);
    // npm's public API has changed over time: some deployments return 0..1
    // scores, others return a download-scaled number with useless detail
    // scores. Keep percentages only when the scale is recognizable.
    const normalized = Number(score.final) <= 1;
    return {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description || '',
      publishedAt: pkg.date,
      updatedAt: entry.updated,
      repository: pkg.links?.repository || pkg.links?.homepage || '',
      homepage: pkg.links?.homepage || '',
      publisher: pkg.publisher?.username || '',
      downloads: {
        weekly: Number(downloads.weekly) || 0,
        monthly: Number(downloads.monthly) || 0,
      },
      scores: normalized
        ? {
            final: pct(score.final),
            quality: pct(detail.quality),
            popularity: pct(detail.popularity),
            maintenance: pct(detail.maintenance),
          }
        : null,
    };
  });
}

async function searchCommand(args) {
  const { values, positionals } = parseCliArgs(args, {
    ecosystem: { type: 'string', default: 'all' },
    limit: { type: 'string' },
    json: { type: 'boolean', default: false },
  });

  const query = positionals.join(' ').trim();
  if (!query) {
    fail('Missing search query.', 'Example: search "react kanban drag drop" --limit 6');
  }

  const ecosystem = String(values.ecosystem || 'all').toLowerCase();
  if (!['all', 'github', 'npm', 'pypi'].includes(ecosystem)) {
    fail(`Unknown ecosystem "${ecosystem}".`, 'Use all, github, npm, or pypi.');
  }

  const limit = Math.min(25, Math.max(1, Number.parseInt(values.limit || '6', 10) || 6));
  const result = {
    query,
    ecosystem,
    limit,
    github: null,
    npm: null,
    warnings: [],
  };

  const jobs = [];
  if (ecosystem !== 'npm') {
    jobs.push(
      (async () => {
        const pythonOnly = ecosystem === 'pypi';
        const items = await searchGithub(query, limit, pythonOnly);
        result.github = { pythonOnly, items };
      })(),
    );
  }
  if (ecosystem !== 'github' && ecosystem !== 'pypi') {
    jobs.push(
      (async () => {
        result.npm = await searchNpm(query, limit);
      })(),
    );
  }

  const settled = await Promise.allSettled(jobs);
  for (const entry of settled) {
    if (entry.status === 'rejected') {
      const reason = entry.reason;
      if (reason instanceof CliError) {
        result.warnings.push(`${reason.message}${reason.hint ? ` — ${reason.hint}` : ''}`);
      } else {
        result.warnings.push(String(reason));
      }
    }
  }

  const hasData =
    (result.github && result.github.items.length) || (result.npm && result.npm.length);
  if (!hasData) {
    if (result.warnings.length) {
      fail(`All sources failed: ${result.warnings.join(' | ')}`);
    }
    // Empty but successful: still print a clear Markdown result.
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const lines = [];
  lines.push(`# Open-source search — "${query}"`);
  lines.push('');
  const sources = [];
  if (result.github) sources.push(result.github.pythonOnly ? 'GitHub (Python)' : 'GitHub');
  if (result.npm) sources.push('npm');
  lines.push(`Sources: ${sources.join(' + ')} · limit ${limit} per source`);

  for (const warning of result.warnings) {
    lines.push('');
    lines.push(`⚠️ ${warning}`);
  }

  if (result.github) {
    lines.push('');
    lines.push(
      `## ${result.github.pythonOnly ? 'GitHub (Python repos)' : 'GitHub'} — ${
        result.github.items.length
      } results (by stars)`,
    );
    lines.push('');
    if (!result.github.items.length) {
      lines.push('_No repositories found._');
    }
    result.github.items.forEach((item, index) => {
      const stale = daysSince(item.pushedAt) > 365;
      const meta = [
        `⭐ ${formatCount(item.stars)}`,
        `updated ${timeAgo(item.pushedAt)}`,
        item.language || 'unknown language',
        item.licenseVerdict.label,
      ];
      if (stale) meta.push('⚠️ stale (>1y since last push)');
      if (item.archived) meta.push('⛔ archived');

      lines.push(`${index + 1}. **${item.fullName}** · ${meta.join(' · ')}`);
      if (item.description) lines.push(`   ${mdCell(item.description, 200)}`);
      lines.push(`   ${item.url}`);
      if (item.homepage) lines.push(`   homepage: ${item.homepage}`);
    });
  }

  if (result.npm) {
    lines.push('');
    lines.push(`## npm — ${result.npm.length} results`);
    lines.push('');
    if (!result.npm.length) {
      lines.push('_No packages found._');
    }
    result.npm.forEach((item, index) => {
      const bits = [`v${item.version || '?'}`, `published ${timeAgo(item.publishedAt)}`];
      if (item.downloads.weekly) bits.push(`${formatCount(item.downloads.weekly)} downloads/wk`);
      if (item.scores) {
        bits.push(
          `quality ${item.scores.quality} / popularity ${item.scores.popularity} / maintenance ${item.scores.maintenance}`,
        );
      }
      lines.push(`${index + 1}. **${item.name}** · ${bits.join(' · ')}`);
      if (item.description) lines.push(`   ${mdCell(item.description, 200)}`);
      if (item.repository) lines.push(`   repo: ${item.repository}`);
    });
  }

  lines.push('');
  lines.push('## Next');
  lines.push('- Read docs and dependency requirements: `node scripts/oss-scout.mjs inspect <owner/repo>`');
  lines.push('- Read source before adapting: `node scripts/oss-scout.mjs unpack <owner/repo> --include "src/**"`');
  lines.push('- Multiple viable options, a large dependency, or any ⚠️ license → ask the user first.');

  process.stdout.write(`${lines.join('\n')}\n`);
}

/* ------------------------------------------------------------------ */
/* Markdown truncation                                                */
/* ------------------------------------------------------------------ */

function sectionize(markdown) {
  const lines = markdown.split('\n');
  const sections = [];
  let current = { heading: '', level: 0, lines: [] };
  let inFence = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = !inFence ? /^(#{1,6})\s+(.+?)\s*$/.exec(line) : null;
    if (match) {
      if (current.lines.length || current.heading) sections.push(current);
      current = { heading: match[2], level: match[1].length, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length || current.heading) sections.push(current);

  return sections
    .map((section) => ({
      heading: section.heading,
      level: section.level,
      text: section.lines.join('\n').trim(),
    }))
    .filter((section) => section.text);
}

function scoreSection(section) {
  if (!section.heading) return 0;
  const title = section.heading;
  let score = 0;
  if (/\b(install|installation|setup|getting started|quick ?start|quickstart)\b/i.test(title)) {
    score += 4;
  }
  if (/\b(usage|basic usage|examples?|how to use)\b/i.test(title)) score += 3;
  if (/\b(api|props|options|configuration|reference)\b/i.test(title)) score += 1;
  return score;
}

function closeCodeFence(text) {
  const fences = (text.match(/^\s*```/gm) || []).length;
  return fences % 2 === 1 ? `${text}\n\`\`\`` : text;
}

function smartTruncate(markdown, maxChars) {
  const clean = stripBadges(String(markdown))
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (clean.length <= maxChars) {
    return { text: clean, truncated: false, omitted: 0, total: clean.length };
  }

  if (maxChars < 600) {
    const text = closeCodeFence(clean.slice(0, Math.max(100, maxChars)));
    return {
      text: `${text}\n\n[... truncated ${clean.length - text.length} of ${clean.length} characters]`,
      truncated: true,
      omitted: clean.length - text.length,
      total: clean.length,
    };
  }

  const sections = sectionize(clean);
  const budget = maxChars - 180;
  const chosen = new Set();
  const partials = new Map();
  let used = 0;

  const addFull = (index) => {
    if (chosen.has(index)) return;
    const cost = sections[index].text.length + 2;
    if (used + cost <= budget) {
      chosen.add(index);
      used += cost;
    }
  };

  // Never drop the intro when a tight budget is requested — keep a slice.
  if (sections.length) {
    const cost = sections[0].text.length + 2;
    if (cost <= budget) {
      chosen.add(0);
      used += cost;
    } else {
      const keep = Math.max(160, Math.min(sections[0].text.length, Math.floor(budget * 0.45)));
      partials.set(0, sections[0].text.slice(0, keep).trimEnd());
      used += partials.get(0).length + 2;
    }
  }

  const ranked = sections
    .map((section, index) => ({ index, score: scoreSection(section) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  for (const entry of ranked) addFull(entry.index);

  // Fill in document order. The first section that does not fit gets a slice,
  // instead of being skipped in favour of a smaller section further down.
  for (let index = 0; index < sections.length; index += 1) {
    if (chosen.has(index) || partials.has(index)) continue;
    const cost = sections[index].text.length + 2;
    if (used + cost <= budget) {
      chosen.add(index);
      used += cost;
      continue;
    }
    if (budget - used > 200) {
      partials.set(index, sections[index].text.slice(0, budget - used - 2).trimEnd());
      used = budget;
    }
    break;
  }

  const parts = [];
  for (let index = 0; index < sections.length; index += 1) {
    if (chosen.has(index)) parts.push(sections[index].text);
    else if (partials.has(index)) parts.push(partials.get(index));
  }
  let text = parts.join('\n\n');

  if (text.length > maxChars) text = text.slice(0, maxChars);
  text = closeCodeFence(text);

  return {
    text: `${text}\n\n[... truncated ${Math.max(
      0,
      clean.length - text.length,
    )} of ${clean.length} characters. Narrow the target or raise --max-chars to read more.]`,
    truncated: true,
    omitted: Math.max(0, clean.length - text.length),
    total: clean.length,
  };
}

/* ------------------------------------------------------------------ */
/* inspect                                                            */
/* ------------------------------------------------------------------ */

function detectMonorepo(rootNames, packageJson) {
  const markers = ['packages', 'apps', 'pnpm-workspace.yaml', 'lerna.json', 'turbo.json', 'nx.json'];
  if (rootNames.some((name) => markers.includes(name))) {
    return markers.filter((marker) => rootNames.includes(marker));
  }
  if (packageJson && packageJson.workspaces) return ['workspaces field in package.json'];
  return [];
}

function keyDependencyVersions(deps) {
  const interesting = ['react', 'react-dom', 'vue', 'svelte', 'next', 'typescript', 'node'];
  return interesting
    .filter((name) => deps[name])
    .map((name) => `${name} ${deps[name]}`);
}

let rawFallbackNotified = false;

/**
 * Read one text file from a repo through three independent transports:
 * raw.githubusercontent -> jsDelivr CDN -> GitHub contents API.
 * Returns null when every transport fails.
 */
async function fetchRepoFileText(owner, repo, branch, filePath) {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const encodedBranch = branch
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');

  const sources = [
    `https://raw.githubusercontent.com/${owner}/${repo}/${encodedBranch}/${encodedPath}`,
    `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${encodedBranch}/${encodedPath}`,
  ];

  for (let index = 0; index < sources.length; index += 1) {
    try {
      const res = await request(sources[index], {
        headers: { Accept: 'text/plain' },
        timeout: 8000,
        retries: 0,
      });
      if (res.ok) return res.text;
    } catch {
      // Try the next transport.
    }
    if (index === 0 && !rawFallbackNotified) {
      rawFallbackNotified = true;
      log('raw.githubusercontent unavailable; trying jsDelivr CDN...');
    }
  }

  try {
    const data = await githubJson(
      `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
    );
    if (data && data.content) return Buffer.from(data.content, 'base64').toString('utf8');
  } catch {
    // All transports failed.
  }
  return null;
}

async function fetchRepoPackageJson(owner, repo, branch) {
  const text = await fetchRepoFileText(owner, repo, branch, 'package.json');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * GitHub sometimes reports NOASSERTION/null for a plainly recognizable
 * license. Read the LICENSE file and sniff it so the audit stays useful.
 */
async function resolveLicense(meta, slug) {
  const spdx = meta.license ? meta.license.spdx_id : null;
  const initial = classifyLicense(spdx);
  if (initial.level !== 'unknown') return { spdx, verdict: initial, inferred: false };

  try {
    const data = await githubJson(`/repos/${slug}/license`);
    if (data && data.content) {
      const text = Buffer.from(data.content, 'base64').toString('utf8');
      const inferred = inferLicenseFromText(text);
      if (inferred) {
        return { spdx: inferred, verdict: classifyLicense(inferred), inferred: true };
      }
    }
  } catch {
    // Keep the unknown verdict.
  }
  return { spdx, verdict: initial, inferred: false };
}

async function inspectRepo(owner, repo, maxChars) {
  const slug = `${owner}/${repo}`;
  log(`Reading GitHub repo ${slug}...`);
  const meta = await githubJson(`/repos/${slug}`);

  const [contents, readme, packageJson] = await Promise.all([
    githubJson(`/repos/${slug}/contents`).catch(() => null),
    githubRaw(`/repos/${slug}/readme`).catch(() => null),
    fetchRepoPackageJson(owner, repo, meta.default_branch || 'main'),
  ]);

  const rootEntries = Array.isArray(contents) ? contents : [];
  const rootNames = rootEntries.map((entry) => entry.name);
  const rootDisplay = rootEntries
    .slice(0, 40)
    .map((entry) => (entry.type === 'dir' ? `${entry.name}/` : entry.name));
  const monorepoMarkers = detectMonorepo(rootNames, packageJson);
  const hasExamples = rootNames.includes('examples') || rootNames.includes('example');

  const licenseInfo = await resolveLicense(meta, slug);
  const license = licenseInfo.verdict;
  const dependencies = packageJson?.dependencies || {};
  const peerDependencies = packageJson?.peerDependencies || {};
  const devDependencies = packageJson?.devDependencies || {};

  const readmeResult = readme
    ? smartTruncate(readme, maxChars)
    : { text: '_No README found._', truncated: false, omitted: 0, total: 0 };

  const data = {
    type: 'repo',
    repo: slug,
    url: meta.html_url,
    homepage: meta.homepage || '',
    description: meta.description || '',
    stars: meta.stargazers_count,
    forks: meta.forks_count,
    openIssues: meta.open_issues_count,
    language: meta.language || '',
    license: licenseInfo.spdx,
    licenseVerdict: license,
    licenseInferred: licenseInfo.inferred,
    pushedAt: meta.pushed_at,
    archived: Boolean(meta.archived),
    defaultBranch: meta.default_branch,
    topics: meta.topics || [],
    rootEntries: rootDisplay,
    rootEntryCount: rootNames.length,
    monorepo: monorepoMarkers,
    hasExamples,
    package: packageJson
      ? {
          name: packageJson.name || null,
          dependencies: Object.keys(dependencies),
          peerDependencies,
          devDependencyCount: Object.keys(devDependencies).length,
          keyVersions: keyDependencyVersions({ ...dependencies, ...peerDependencies }),
        }
      : null,
    readme: readmeResult,
  };

  if (readmeResult.truncated) {
    log(`README truncated to ${maxChars} chars (${readmeResult.omitted} omitted).`);
  }
  return data;
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const isHex = code[1] && code[1].toLowerCase() === 'x';
      const value = Number.parseInt(isHex ? code.slice(2) : code.slice(1), isHex ? 16 : 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return named[code.toLowerCase()] ?? match;
  });
}

function htmlToText(html) {
  const cleaned = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header\b[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, ' ');

  // Prefer the page's main content when the site provides one.
  const main = /<main\b[\s\S]*<\/main>/i.exec(cleaned) ||
    /<article\b[\s\S]*<\/article>/i.exec(cleaned);
  const scoped = main && main[0].length > 400 ? main[0] : cleaned;

  let text = scoped
    .replace(/<h([1-6])[^>]*>/gi, (_match, level) => `\n${'#'.repeat(Number(level))} `)
    .replace(/<\/(h[1-6]|p|div|section|article|li|ul|ol|pre|blockquote|tr)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  text = decodeEntities(text)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/^\s*[-–—]\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

async function inspectDocs(url, maxChars) {
  let source = 'Jina Reader';
  let markdown = null;

  log(`Converting docs page: ${url}`);
  try {
    const res = await request(`https://r.jina.ai/${url}`, {
      headers: { 'X-Return-Format': 'markdown', Accept: 'text/plain' },
      timeout: 12000,
      retries: 1,
    });
    if (res.ok && res.text.trim().length > 80) markdown = res.text;
  } catch {
    // Fall through to direct HTML.
  }

  if (!markdown) {
    source = 'direct HTML fallback';
    log('Jina Reader unavailable — fetching HTML directly.');
    const res = await request(url, { headers: { Accept: 'text/html' }, timeout: 20000 });
    if (!res.ok) {
      fail(`Could not fetch ${url} (HTTP ${res.status}).`, 'Check the URL or fetch the page manually.');
    }
    markdown = htmlToText(res.text);
    if (markdown.length < 40) {
      fail(`No readable content extracted from ${url}.`, 'The page may be rendered client-side; open it manually.');
    }
  }

  const result = smartTruncate(markdown, maxChars);
  return {
    type: 'docs',
    url,
    source,
    totalChars: result.total,
    truncated: result.truncated,
    omitted: result.omitted,
    content: result.text,
  };
}

async function inspectCommand(args) {
  const { values, positionals } = parseCliArgs(args, {
    'max-chars': { type: 'string' },
    json: { type: 'boolean', default: false },
  });

  const target = positionals.join(' ').trim();
  if (!target) {
    fail('Missing target.', 'Pass "owner/repo", a GitHub URL, or a documentation URL.');
  }

  const maxChars = Math.min(
    200000,
    Math.max(500, Number.parseInt(values['max-chars'] || '8000', 10) || 8000),
  );

  const repo = parseRepoTarget(target);
  let data;
  if (repo) {
    data = await inspectRepo(repo.owner, repo.repo, maxChars);
  } else if (isHttpUrl(target)) {
    data = await inspectDocs(target, maxChars);
  } else {
    fail(
      `Cannot interpret target "${target}".`,
      'Use owner/repo (e.g. pmndrs/zustand) or a full https:// URL.',
    );
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  if (data.type === 'repo') {
    const lines = [];
    lines.push(`# ${data.repo}`);
    lines.push('');
    const meta = [
      `⭐ ${formatCount(data.stars)}`,
      data.language || 'unknown language',
      `pushed ${timeAgo(data.pushedAt)}`,
      `${data.licenseVerdict.label}${data.licenseInferred ? ' (from LICENSE)' : ''}`,
    ];
    if (data.archived) meta.push('⛔ archived');
    lines.push(meta.join(' · '));
    if (data.description) lines.push('', data.description);
    lines.push('', `Repo: ${data.url}`);
    if (data.homepage) lines.push(`Homepage: ${data.homepage}`);
    if (data.topics.length) lines.push(`Topics: ${data.topics.slice(0, 10).join(', ')}`);

    lines.push('');
    lines.push(`## Layout (default branch: ${data.defaultBranch})`);
    lines.push('');
    lines.push(
      data.rootEntries.slice(0, 30).join(' · ') || '_empty_',
    );
    lines.push('');
    lines.push(
      `Monorepo: ${data.monorepo.length ? `yes (${data.monorepo.join(', ')})` : 'no'} · examples/: ${
        data.hasExamples ? 'yes' : 'no'
      } · root entries: ${data.rootEntryCount}`,
    );

    if (data.package) {
      lines.push('');
      lines.push('## package.json');
      lines.push('');
      lines.push(
        `Dependencies (${data.package.dependencies.length}): ${
          data.package.dependencies.slice(0, 20).join(', ') || 'none'
        }`,
      );
      const peers = Object.entries(data.package.peerDependencies);
      lines.push(
        `Peer dependencies (${peers.length}): ${
          peers.slice(0, 15).map(([name, version]) => `${name} ${version}`).join(', ') || 'none'
        }`,
      );
      if (data.package.keyVersions.length) {
        lines.push(`Key versions: ${data.package.keyVersions.join(', ')}`);
      }
      lines.push(`Dev dependencies: ${data.package.devDependencyCount}`);
      if (data.monorepo.length) {
        lines.push(
          'Note: this is a workspace root package.json — check `packages/*/package.json` for the published packages.',
        );
      }
    }

    lines.push('');
    lines.push('## README (latest, default branch)');
    lines.push('');
    lines.push(data.readme.text);

    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  const lines = [];
  lines.push(`# Docs: ${data.url}`);
  lines.push('');
  lines.push(`Source: ${data.source} · ${data.totalChars.toLocaleString()} chars extracted`);
  lines.push('');
  lines.push(data.content);
  process.stdout.write(`${lines.join('\n')}\n`);
}

/* ------------------------------------------------------------------ */
/* unpack                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_EXCLUDES = [
  /(^|\/)(node_modules|dist|build|out|coverage|\.next|\.nuxt|\.output|vendor|tmp)\//i,
  /(^|\/)(__tests__|tests?|spec|__mocks__|mocks?|fixtures?)\//i,
  /\.(png|jpe?g|gif|webp|avif|ico|bmp|pdf|zip|gz|tgz|tar|7z|woff2?|ttf|eot|otf|mp3|mp4|mov|webm|map|xlsx?|docx?|pptx?)$/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|composer\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock|flake\.lock)$/i,
  /(^|\/)(\.DS_Store|Thumbs\.db|\.gitignore|\.gitattributes)$/i,
  /\.min\.(js|css)$/i,
  /\.d\.(ts|mts|cts)$/i,
];

const DEFAULT_INCLUDE_RE = [
  /^(src|lib|components|hooks|utils|packages\/[^/]+\/(src|lib))\//i,
  /^[^/]+\.(m?[jt]sx?|vue|svelte|astro|css|scss|less|py|go|rs|java|kt|swift)$/i,
];

function isExcluded(filePath) {
  return DEFAULT_EXCLUDES.some((re) => re.test(filePath));
}

function isDefaultSource(filePath) {
  return DEFAULT_INCLUDE_RE.some((re) => re.test(filePath));
}

function rankSourceFile(filePath) {
  let rank = 3;
  if (/^(src|lib)\//.test(filePath)) rank = 0;
  else if (/^components\//.test(filePath)) rank = 1;
  else if (/^packages\/[^/]+\/(src|lib)\//.test(filePath)) rank = 1;
  else if (isDefaultSource(filePath)) rank = 2;
  return { rank, depth: filePath.split('/').length };
}

async function fetchFileContent(owner, repo, branch, filePath) {
  const text = await fetchRepoFileText(owner, repo, branch, filePath);
  if (text === null) {
    fail(
      `Could not read ${filePath} from ${owner}/${repo}.`,
      'All three transports failed (raw, jsDelivr, contents API). Retry later or narrow --include.',
    );
  }
  return text;
}

async function tryRepomix(owner, repo, outDir, include) {
  const packFile = path.join(outDir, 'repomix-pack.xml');
  await ensureDir(outDir);
  const args = ['-y', 'repomix', '--remote', `${owner}/${repo}`, '--output', packFile];
  if (include) args.push('--include', include);
  log('Trying repomix via npx (may take a minute)...');
  const result = await runCommand('npx', args, { timeout: PACK_TIMEOUT_MS });
  const size = await fileSize(packFile);
  if (result.code === 0 && size > 200) {
    return { engine: 'repomix', outDir, packFile, packSize: size };
  }
  const tail = result.stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ');
  log(`repomix failed (exit ${result.code})${tail ? `: ${tail}` : ''}. Falling back to GitHub Trees API.`);
  return null;
}

async function builtinPack(owner, repo, outDir, includePatterns, maxFiles) {
  const slug = `${owner}/${repo}`;
  log(`Reading repository tree for ${slug}...`);

  const meta = await githubJson(`/repos/${slug}`);
  const branch = meta.default_branch || 'main';
  const treeData = await githubJson(
    `/repos/${slug}/git/trees/${branch.split('/').map(encodeURIComponent).join('/')}?recursive=1`,
  );
  const blobs = (treeData.tree || []).filter((node) => node.type === 'blob');

  let candidates = blobs.filter(
    (node) =>
      !isExcluded(node.path) &&
      (includePatterns.length ? matchesGlobs(includePatterns, node.path) : isDefaultSource(node.path)),
  );

  if (!candidates.length && !includePatterns.length) {
    candidates = blobs.filter(
      (node) =>
        !isExcluded(node.path) &&
        /\.(m?[jt]sx?|vue|svelte|py|go|rs|css|scss)$/i.test(node.path) &&
        node.path.split('/').length <= 4,
    );
  }

  if (!candidates.length) {
    fail(
      `No source files matched${includePatterns.length ? ` --include "${includePatterns.join(',')}"` : ''} in ${slug}.`,
      'Broaden --include (e.g. --include "**/*.ts") or check the repo layout with `inspect`.',
    );
  }

  candidates = candidates
    .map((node) => ({ ...node, ...rankSourceFile(node.path) }))
    .sort((a, b) => a.rank - b.rank || a.depth - b.depth || a.path.localeCompare(b.path));

  const selected = candidates.slice(0, maxFiles);
  await ensureDir(outDir);

  const files = [];
  for (const node of selected) {
    if ((node.size || 0) > 300 * 1024) {
      log(`Skipping large file ${node.path} (${humanBytes(node.size)}).`);
      continue;
    }
    try {
      const content = await fetchFileContent(owner, repo, branch, node.path);
      const target = path.join(outDir, ...node.path.split('/'));
      await writeText(target, content);
      files.push({
        path: node.path,
        bytes: Buffer.byteLength(content, 'utf8'),
        lines: content.split('\n').length,
      });
    } catch (err) {
      log(`Skipping ${node.path}: ${err.message}`);
    }
  }

  if (!files.length) {
    fail(`Could not download any source files from ${slug}.`, 'Retry later or use `inspect`.');
  }

  const licenseInfo = await resolveLicense(meta, slug);
  const license = licenseInfo.verdict;
  const indexLines = [];
  indexLines.push(`# Source pack — ${slug}`);
  indexLines.push('');
  indexLines.push(`- Repo: ${meta.html_url}`);
  indexLines.push(
    `- Branch: \`${branch}\`${licenseInfo.spdx ? ` · License: ${licenseInfo.spdx}` : ''}`,
  );
  indexLines.push(`- License check: ${license.label}`);
  indexLines.push(`- Packed: ${new Date().toISOString().slice(0, 10)}`);
  indexLines.push(
    `- Engine: GitHub Trees API (builtin) · Include: ${
      includePatterns.length ? includePatterns.join(', ') : 'default src/lib source'
    }`,
  );
  indexLines.push(
    `- Files: ${files.length} of ${candidates.length} matched (${blobs.length} total in repo)`,
  );
  indexLines.push('');
  indexLines.push('| # | File | Size | Lines |');
  indexLines.push('| --- | --- | --- | --- |');
  files.forEach((file, index) => {
    indexLines.push(`| ${index + 1} | \`${file.path}\` | ${humanBytes(file.bytes)} | ${file.lines} |`);
  });
  indexLines.push('');
  indexLines.push('## Notes');
  indexLines.push('- Read these files directly; port only the logic you need.');
  indexLines.push('- Keep the upstream source URL and license header in ported files.');
  indexLines.push('- Delete the .tmp/oss-ref directory when the task is done.');
  indexLines.push('');

  const indexPath = path.join(outDir, 'INDEX.md');
  await writeText(indexPath, indexLines.join('\n'));

  return {
    engine: 'github-trees',
    outDir,
    branch,
    license,
    files,
    indexPath,
    totalBlobs: blobs.length,
    matched: candidates.length,
  };
}

async function unpackCommand(args) {
  const { values, positionals } = parseCliArgs(args, {
    include: { type: 'string' },
    out: { type: 'string' },
    engine: { type: 'string', default: 'auto' },
    'max-files': { type: 'string' },
    json: { type: 'boolean', default: false },
  });

  const raw = (positionals[0] || '').trim();
  if (!raw) {
    fail('Missing repository.', 'Expected "owner/repo", e.g. "lukeed/clsx".');
  }
  if (positionals.length > 1) {
    fail('Pass exactly one repository in "owner/repo" form.');
  }

  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(raw);
  if (!match) {
    fail(
      `Invalid repository "${raw}".`,
      'Expected "owner/repo" (e.g. "lukeed/clsx"). For a full URL, extract owner/repo first.',
    );
  }
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, '');

  const enginePref = String(values.engine || 'auto').toLowerCase();
  if (!['auto', 'repomix', 'builtin'].includes(enginePref)) {
    fail(`Unknown engine "${values.engine}".`, 'Use auto, repomix, or builtin.');
  }

  const include = values.include || '';
  const includePatterns = splitGlobList(include);
  const maxFiles = Math.min(100, Math.max(1, Number.parseInt(values['max-files'] || '20', 10) || 20));
  const outDir = path.resolve(values.out || path.join('.tmp', 'oss-ref', repo));

  let packed = null;

  if (enginePref !== 'builtin' && (await commandAvailable('npx'))) {
    packed = await tryRepomix(owner, repo, outDir, include);
  } else if (enginePref === 'repomix') {
    fail('repomix was requested but npx is not available.', 'Install Node.js/npm or use --engine builtin.');
  } else if (enginePref === 'auto') {
    log('npx not available — using the GitHub Trees API engine.');
  }

  if (!packed) {
    if (enginePref === 'repomix') {
      fail('repomix failed.', 'Check network access, or use --engine builtin.');
    }
    packed = await builtinPack(owner, repo, outDir, includePatterns, maxFiles);
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ repo: `${owner}/${repo}`, ...packed }, null, 2)}\n`);
    return;
  }

  const lines = [];
  lines.push(`# Unpacked ${owner}/${repo}`);
  lines.push('');
  lines.push(`Engine: ${packed.engine === 'repomix' ? 'repomix (XML pack)' : 'GitHub Trees API'}`);
  if (packed.branch) lines.push(`Branch: ${packed.branch}`);
  if (packed.license) lines.push(`License: ${packed.license.label}`);
  lines.push(`Output: \`${outDir}\``);
  lines.push('');

  if (packed.engine === 'repomix') {
    lines.push(`Pack: \`${packed.packFile}\` (${humanBytes(packed.packSize)})`);
    lines.push('Read the XML pack or search inside it for the component you need.');
  } else {
    lines.push(
      `Files: ${packed.files.length} of ${packed.matched} matched (${packed.totalBlobs} total)`,
    );
    lines.push('');
    for (const file of packed.files) {
      lines.push(`- \`${file.path}\` (${humanBytes(file.bytes)}, ${file.lines} lines)`);
    }
    lines.push('');
    lines.push(`Index: \`${packed.indexPath}\``);
  }

  lines.push('');
  lines.push('## Rules');
  lines.push('- Read these files with your file tools; port only the needed logic.');
  lines.push('- Keep the upstream URL and license header in ported code.');
  lines.push('- Remove the .tmp directory when the task is done.');
  process.stdout.write(`${lines.join('\n')}\n`);
}

/* ------------------------------------------------------------------ */
/* Entry                                                              */
/* ------------------------------------------------------------------ */

runMain(async () => {
  const argv = process.argv.slice(2);
  if (!argv.length || hasHelp(argv)) {
    const command = argv[0];
    if (command === 'search' && hasHelp(argv.slice(1))) return printHelp(SEARCH_HELP);
    if (command === 'inspect' && hasHelp(argv.slice(1))) return printHelp(INSPECT_HELP);
    if (command === 'unpack' && hasHelp(argv.slice(1))) return printHelp(UNPACK_HELP);
    return printHelp(USAGE);
  }

  const [command, ...rest] = argv;
  switch (command) {
    case 'search':
      if (hasHelp(rest)) return printHelp(SEARCH_HELP);
      return searchCommand(rest);
    case 'inspect':
      if (hasHelp(rest)) return printHelp(INSPECT_HELP);
      return inspectCommand(rest);
    case 'unpack':
      if (hasHelp(rest)) return printHelp(UNPACK_HELP);
      return unpackCommand(rest);
    default:
      fail(`Unknown command: ${command}`, 'Run `node scripts/oss-scout.mjs --help`.');
  }
});
