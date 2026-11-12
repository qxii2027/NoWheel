#!/usr/bin/env node
/**
 * icon-tool — locate real icons instead of hand-drawing SVG.
 *
 *   check-local [dir]   Detect icon libraries already installed in the project.
 *   search <query>      Search Iconify for real icon identifiers.
 *   svg <prefix:name>   Fetch the official SVG source.
 *
 * Zero npm dependencies. Node.js >= 18.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  CliError,
  ICONIFY_API_HOSTS,
  fail,
  humanBytes,
  hasHelp,
  log,
  parseCliArgs,
  printHelp,
  requestFirstOk,
  runMain,
  toPascalCase,
  writeText,
} from './shared.mjs';

const USAGE = `
icon-tool — find real icons, never draw them by hand

Usage:
  node scripts/icon-tool.mjs check-local [project_dir] [--json]
  node scripts/icon-tool.mjs search <query> [--prefix lucide,tabler] [--limit 15] [--json]
  node scripts/icon-tool.mjs svg <prefix:name> [--size 24] [--color "#fff"] [--out file.svg] [--json]

Commands:
  check-local   Scan package.json (and HTML CDN tags) for installed icon libraries.
  search        Search the Iconify API for icon ids that actually exist.
  svg           Download the official SVG source for one icon.

Examples:
  node scripts/icon-tool.mjs check-local .
  node scripts/icon-tool.mjs search "sparkles" --prefix lucide,tabler --limit 5
  node scripts/icon-tool.mjs svg lucide:sparkles --size 20 --color currentColor
  node scripts/icon-tool.mjs svg tabler:wand --out src/assets/wand.svg

Notes:
  - Search results are real identifiers from Iconify; copy them into the svg
    command or map them to the project's installed library.
  - Never invent icon names from memory.
  - Output is compact Markdown by default; --json is for machine use.
`;

const CHECK_HELP = `
icon-tool check-local — detect icon libraries already in the project

Usage:
  node scripts/icon-tool.mjs check-local [project_dir] [--json]

Scans the nearest package.json (walking up from project_dir) plus common HTML
entry files for icon-library dependencies or CDN links. Reuse an existing
library when one is found so stroke weight and style stay consistent.
`;

const SEARCH_HELP = `
icon-tool search — search Iconify for real icon identifiers

Usage:
  node scripts/icon-tool.mjs search <query> [--prefix lucide,tabler] [--limit 15] [--json]

Options:
  --prefix  Comma-separated Iconify collections (lucide, tabler, ph,
            simple-icons, heroicons, radix-icons, ...). Omit to search all.
  --limit   Max results, 1-50 (default 15).
  --json    Emit JSON instead of Markdown.

If a prefixed search finds nothing, the tool retries across all collections
and tells you.
`;

const SVG_HELP = `
icon-tool svg — download the official SVG source for one icon

Usage:
  node scripts/icon-tool.mjs svg <prefix:name> [--size 24] [--color "#fff"] [--out file.svg] [--json]

Arguments:
  <prefix:name>  Icon id from the search command, e.g. lucide:sparkles.

Options:
  --size   Rendered height in px, 8-512 (default 24).
  --color  Replace currentColor. Omit to keep currentColor (follows text color).
  --out    Save to this file (parent folders are created) instead of stdout.
  --json   Emit JSON (includes the SVG source).

Only size, color, and class may be changed afterwards. Never edit path data.
`;

/* ------------------------------------------------------------------ */
/* Known icon libraries                                               */
/* ------------------------------------------------------------------ */

const ICON_LIBRARIES = {
  'lucide-react': {
    set: 'lucide',
    framework: 'React',
    example: "import { Sparkles } from 'lucide-react';\n<Sparkles size={20} strokeWidth={2} />",
  },
  'lucide-vue-next': {
    set: 'lucide',
    framework: 'Vue 3',
    example: "import { Sparkles } from 'lucide-vue-next';\n<Sparkles :size=\"20\" />",
  },
  'lucide-svelte': {
    set: 'lucide',
    framework: 'Svelte',
    example: "import { Sparkles } from 'lucide-svelte';\n<Sparkles size={20} />",
  },
  'lucide-react-native': {
    set: 'lucide',
    framework: 'React Native',
    example: "import { Sparkles } from 'lucide-react-native';\n<Sparkles size={20} />",
  },
  lucide: {
    set: 'lucide',
    framework: 'Vanilla / createIcons',
    example: "import { createIcons, Sparkles } from 'lucide';\ncreateIcons({ icons: { Sparkles } });",
  },
  '@iconify/react': {
    set: 'all (10k+ sets)',
    framework: 'React',
    example: "import { Icon } from '@iconify/react';\n<Icon icon=\"lucide:sparkles\" width={20} />",
  },
  '@iconify/vue': {
    set: 'all (10k+ sets)',
    framework: 'Vue 3',
    example: "import { Icon } from '@iconify/vue';\n<Icon icon=\"lucide:sparkles\" :width=\"20\" />",
  },
  '@iconify/svelte': {
    set: 'all (10k+ sets)',
    framework: 'Svelte',
    example: "import Icon from '@iconify/svelte';\n<Icon icon=\"lucide:sparkles\" width={20} />",
  },
  '@iconify-icon/react': {
    set: 'all (10k+ sets)',
    framework: 'React (web component)',
    example: "import '@iconify-icon/react';\n<iconify-icon icon=\"lucide:sparkles\" width=\"20\" />",
  },
  '@heroicons/react': {
    set: 'heroicons',
    framework: 'React',
    example: "import { SparklesIcon } from '@heroicons/react/24/outline';\n<SparklesIcon className=\"size-5\" />",
  },
  '@heroicons/vue': {
    set: 'heroicons',
    framework: 'Vue 3',
    example: "import { SparklesIcon } from '@heroicons/vue/24/outline';\n<SparklesIcon class=\"size-5\" />",
  },
  '@tabler/icons-react': {
    set: 'tabler',
    framework: 'React',
    example: "import { IconSparkles } from '@tabler/icons-react';\n<IconSparkles size={20} stroke={1.5} />",
  },
  '@tabler/icons-vue': {
    set: 'tabler',
    framework: 'Vue 3',
    example: "import { IconSparkles } from '@tabler/icons-vue';\n<IconSparkles size={20} />",
  },
  '@tabler/icons': {
    set: 'tabler',
    framework: 'Vanilla',
    example: "import { IconSparkles } from '@tabler/icons';\n// inline via innerHTML or use @tabler/icons-sprite",
  },
  'react-icons': {
    set: 'many (Font Awesome, Lucide, Tabler, Simple Icons, ...)',
    framework: 'React',
    example: "import { LuSparkles } from 'react-icons/lu';\nimport { SiGithub } from 'react-icons/si';\n<LuSparkles size={20} />",
  },
  '@radix-ui/react-icons': {
    set: 'radix-icons',
    framework: 'React',
    example: "import { MagicWandIcon } from '@radix-ui/react-icons';\n<MagicWandIcon width={20} height={20} />",
  },
  'phosphor-icons': {
    set: 'ph',
    framework: 'Vanilla / web',
    example: "import { Sparkle } from 'phosphor-icons';\n// or use the web font / @phosphor-icons/web",
  },
  '@phosphor-icons/react': {
    set: 'ph',
    framework: 'React',
    example: "import { Sparkle } from '@phosphor-icons/react';\n<Sparkle size={20} weight=\"regular\" />",
  },
  '@phosphor-icons/vue': {
    set: 'ph',
    framework: 'Vue 3',
    example: "import { PhSparkle } from '@phosphor-icons/vue';\n<PhSparkle :size=\"20\" />",
  },
  '@phosphor-icons/web': {
    set: 'ph',
    framework: 'HTML / CSS',
    example: '<i class="ph ph-sparkle"></i>',
  },
  '@fortawesome/fontawesome-free': {
    set: 'fa6-*',
    framework: 'HTML / CSS',
    example: '<i class="fa-solid fa-wand-magic-sparkles"></i>',
  },
  '@fortawesome/react-fontawesome': {
    set: 'fa6-*',
    framework: 'React',
    example: "import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';\nimport { faWandMagicSparkles } from '@fortawesome/free-solid-svg-icons';\n<FontAwesomeIcon icon={faWandMagicSparkles} />",
  },
  'font-awesome': {
    set: 'fa*',
    framework: 'HTML / CSS',
    example: '<i class="fa-solid fa-wand-magic-sparkles"></i>',
  },
  'feather-icons': {
    set: 'feather',
    framework: 'HTML / JS',
    example: "import feather from 'feather-icons';\nfeather.replace(); // icons via data-feather=\"star\"",
  },
  'react-feather': {
    set: 'feather',
    framework: 'React',
    example: "import { Star } from 'react-feather';\n<Star size={20} />",
  },
  'bootstrap-icons': {
    set: 'bi',
    framework: 'HTML / CSS',
    example: '<i class="bi bi-stars"></i>',
  },
  'material-symbols': {
    set: 'material-symbols',
    framework: 'HTML / CSS',
    example: '<span class="material-symbols-outlined">auto_awesome</span>',
  },
  '@mui/icons-material': {
    set: 'mdi / material',
    framework: 'React (MUI)',
    example: "import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';\n<AutoAwesomeIcon fontSize=\"small\" />",
  },
  'ionicons': {
    set: 'ion',
    framework: 'HTML / web component',
    example: '<ion-icon name="sparkles-outline"></ion-icon>',
  },
  'iconoir-react': {
    set: 'iconoir',
    framework: 'React',
    example: "import { Sparks } from 'iconoir-react';\n<Sparks width={20} height={20} />",
  },
  'primeicons': {
    set: 'primeicons',
    framework: 'HTML / CSS',
    example: '<i class="pi pi-sparkles"></i>',
  },
  '@ant-design/icons': {
    set: 'ant-design',
    framework: 'React',
    example: "import { StarOutlined } from '@ant-design/icons';\n<StarOutlined />",
  },
  '@chakra-ui/icons': {
    set: 'chakra',
    framework: 'React',
    example: "import { StarIcon } from '@chakra-ui/icons';\n<StarIcon />",
  },
  'remixicon': {
    set: 'ri',
    framework: 'HTML / CSS',
    example: '<i class="ri-sparkling-line"></i>',
  },
  'svelte-feather-icons': {
    set: 'feather',
    framework: 'Svelte',
    example: "import { StarIcon } from 'svelte-feather-icons';\n<StarIcon size=\"20\" />",
  },
};

const CDN_HINTS = [
  { re: /iconify/i, name: 'Iconify (CDN / web component)' },
  { re: /lucide/i, name: 'Lucide (CDN)' },
  { re: /font-?awesome|fontawesome/i, name: 'Font Awesome (CDN)' },
  { re: /tabler/i, name: 'Tabler Icons (CDN)' },
  { re: /heroicons/i, name: 'Heroicons (CDN)' },
  { re: /phosphor/i, name: 'Phosphor Icons (CDN)' },
  { re: /bootstrap-icons/i, name: 'Bootstrap Icons (CDN)' },
  { re: /feather/i, name: 'Feather Icons (CDN)' },
  { re: /remixicon/i, name: 'Remix Icon (CDN)' },
  { re: /material-symbols|material-icons/i, name: 'Material Symbols (CDN)' },
  { re: /ionicons/i, name: 'Ionicons (CDN)' },
];

const COLLECTION_NAMES = {
  lucide: 'Lucide',
  tabler: 'Tabler Icons',
  ph: 'Phosphor',
  'simple-icons': 'Simple Icons',
  heroicons: 'Heroicons',
  'radix-icons': 'Radix Icons',
  mdi: 'Material Design Icons',
  'material-symbols': 'Material Symbols',
  'fa6-solid': 'Font Awesome 6 Solid',
  'fa6-regular': 'Font Awesome 6 Regular',
  'fa6-brands': 'Font Awesome 6 Brands',
  'fa5-solid': 'Font Awesome 5 Solid',
  bi: 'Bootstrap Icons',
  carbon: 'Carbon Icons',
  octicon: 'Octicons',
  ion: 'Ionicons',
  logos: 'SVG Logos',
  ri: 'Remix Icon',
  'ant-design': 'Ant Design Icons',
  iconoir: 'Iconoir',
  'ic': 'Iconify Material',
  'mdi-light': 'Material Design Light',
  'hugeicons': 'Hugeicons',
  'solar': 'Solar',
  'mingcute': 'MingCute',
  'fluent': 'Fluent UI System Icons',
  'fluent-emoji-flat': 'Fluent Emoji Flat',
  'noto': 'Noto Emoji',
  'twemoji': 'Twitter Emoji',
  'openmoji': 'OpenMoji',
};

/** Per-collection component hints for common front-end libraries. */
const COMPONENT_HINTS = {
  lucide: (name) => `lucide-react: <${toPascalCase(name)} />`,
  tabler: (name) => `@tabler/icons-react: <Icon${toPascalCase(name)} />`,
  ph: (name) => `@phosphor-icons/react: <${toPascalCase(name)} />`,
  'simple-icons': (name) =>
    `react-icons/si: <Si${toPascalCase(name)} /> · brand logo, trademark rules apply`,
  'fa6-solid': (name) => `react-icons/fa6: <Fa${toPascalCase(name)} />`,
  'fa6-regular': (name) => `react-icons/fa6: <Fa${toPascalCase(name)} />`,
  'fa6-brands': (name) => `react-icons/fa6: <Fa${toPascalCase(name)} />`,
  heroicons: (name) => `@heroicons/react/24/outline: <${toPascalCase(name)}Icon />`,
  'radix-icons': (name) => `@radix-ui/react-icons: <${toPascalCase(name)}Icon />`,
  bi: (name) => `react-icons/bi: <Bi${toPascalCase(name)} />`,
  carbon: (name) => `@carbon/icons-react: <${toPascalCase(name)} />`,
  octicon: (name) => `@primer/octicons-react: <${toPascalCase(name)}Icon />`,
  mdi: () => 'Iconify only (or @mdi/js paths)',
  'material-symbols': () => 'Iconify only (or Google Material Symbols)',
  logos: () => 'Iconify only (brand logos)',
  ion: (name) => `@ionic/react: <IonIcon icon={${toPascalCase(name)}} />`,
  ri: (name) => `react-icons/ri: <Ri${toPascalCase(name)} />`,
  'ant-design': (name) => `@ant-design/icons: <${toPascalCase(name)}Outlined />`,
  iconoir: (name) => `iconoir-react: <${toPascalCase(name)} />`,
};

function componentHint(prefix, name) {
  const fn = COMPONENT_HINTS[prefix];
  return fn ? fn(name) : `@iconify/react: <Icon icon="${prefix}:${name}" />`;
}

function collectionName(prefix) {
  return COLLECTION_NAMES[prefix] || prefix;
}

/** Which Iconify collection to prefer for a library already in the project. */
function preferredPrefix(library) {
  const set = ICON_LIBRARIES[library]?.set || '';
  if (set === 'lucide') return 'lucide';
  if (set === 'tabler') return 'tabler';
  if (set === 'heroicons') return 'heroicons';
  if (set === 'ph') return 'ph';
  if (set === 'radix-icons') return 'radix-icons';
  if (set === 'bi') return 'bi';
  if (set === 'fa6-*' || set === 'fa*') return 'fa6-solid';
  if (set === 'simple-icons') return 'simple-icons';
  return '';
}

/* ------------------------------------------------------------------ */
/* check-local                                                        */
/* ------------------------------------------------------------------ */

async function findPackageJson(startDir) {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 6; depth += 1) {
    const file = path.join(dir, 'package.json');
    try {
      const raw = await readFile(file, 'utf8');
      return { dir, file, json: JSON.parse(raw) };
    } catch (err) {
      if (err.code === 'ENOENT') {
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
        continue;
      }
      return { dir, file, json: null, error: err.message };
    }
  }
  return null;
}

async function scanHtmlHints(projectDir) {
  const candidates = [];
  const roots = [projectDir, path.join(projectDir, 'public'), path.join(projectDir, 'src')];

  for (const root of roots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.html')) {
          const file = path.join(root, entry.name);
          const info = await stat(file);
          if (info.size <= 512 * 1024) candidates.push(file);
        }
      }
    } catch {
      // Directory missing; ignore.
    }
    if (candidates.length >= 8) break;
  }

  const found = new Map();
  for (const file of candidates.slice(0, 8)) {
    let html;
    try {
      html = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const hint of CDN_HINTS) {
      if (hint.re.test(html) && !found.has(hint.name)) {
        found.set(hint.name, path.relative(projectDir, file) || path.basename(file));
      }
    }
  }
  return [...found.entries()].map(([name, file]) => ({ name, file }));
}

async function checkLocal(args) {
  const { values, positionals } = parseCliArgs(args, {
    json: { type: 'boolean', default: false },
  });
  if (positionals.length > 1) {
    fail('check-local accepts at most one project directory.', 'Usage: check-local [project_dir]');
  }

  const requestedDir = path.resolve(positionals[0] || '.');
  try {
    const info = await stat(requestedDir);
    if (!info.isDirectory()) fail(`Not a directory: ${requestedDir}`);
  } catch (err) {
    if (err instanceof CliError) throw err;
    fail(`Directory not found: ${requestedDir}`);
  }

  const pkg = await findPackageJson(requestedDir);
  const versions = new Map();
  const packageFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

  if (pkg?.json) {
    for (const field of packageFields) {
      for (const [name, version] of Object.entries(pkg.json[field] || {})) {
        if (!versions.has(name)) versions.set(name, { version, field });
      }
    }
  }

  const libraries = [];
  for (const [name, meta] of versions) {
    const known = ICON_LIBRARIES[name];
    if (!known) continue;
    libraries.push({
      name,
      version: meta.version,
      field: meta.field,
      iconifySet: known.set,
      framework: known.framework,
      example: known.example,
      recommendedPrefix: preferredPrefix(name),
    });
  }

  const htmlHints = await scanHtmlHints(pkg?.dir || requestedDir);

  if (values.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          requestedDir,
          projectDir: pkg?.dir || requestedDir,
          packageJson: pkg?.file || null,
          packageJsonError: pkg?.error || null,
          libraries,
          cdnHints: htmlHints,
          recommendedPrefix: libraries.find((lib) => lib.recommendedPrefix)?.recommendedPrefix || '',
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const lines = [];
  lines.push('# Icon library check');
  lines.push('');
  lines.push(`Project: \`${pkg?.dir || requestedDir}\``);
  if (pkg) {
    lines.push(
      `package.json: \`${path.relative(requestedDir, pkg.file) || 'package.json'}\`${
        pkg.dir !== requestedDir ? ' (found by walking up)' : ''
      }`,
    );
    if (pkg.error) lines.push(`⚠️ package.json could not be parsed: ${pkg.error}`);
  } else {
    lines.push('package.json: not found (walked up 6 levels)');
  }
  lines.push('');

  if (libraries.length) {
    lines.push(`## Installed icon libraries (${libraries.length})`);
    lines.push('');
    lines.push('| Package | Version | Iconify set | Framework |');
    lines.push('| --- | --- | --- | --- |');
    for (const lib of libraries) {
      lines.push(`| \`${lib.name}\` | ${lib.version} | ${lib.iconifySet} | ${lib.framework} |`);
    }
    lines.push('');
    lines.push('## Import syntax');
    lines.push('');
    for (const lib of libraries) {
      lines.push(`### ${lib.name}@${lib.version}`);
      lines.push('```');
      lines.push(lib.example);
      lines.push('```');
      lines.push('');
    }
    const recommended = libraries.find((lib) => lib.recommendedPrefix);
    lines.push('## Rule');
    lines.push('');
    lines.push(
      'Use one of the libraries above for every new icon so stroke weight and visual style stay consistent. ' +
        'Do not add a second icon library without asking the user.',
    );
    if (recommended) {
      lines.push('');
      lines.push(
        `Search real icon ids with: \`node scripts/icon-tool.mjs search "<keyword>" --prefix ${recommended.recommendedPrefix}\``,
      );
    }
  } else {
    lines.push('## Result');
    lines.push('');
    lines.push('No icon library detected in package.json.');
    lines.push('');
    lines.push('Recommended default: **Lucide** (clean 24px stroke icons, CSS-variable friendly).');
    lines.push('');
    lines.push('```bash');
    lines.push('npm install lucide-react      # React');
    lines.push('npm install lucide-vue-next   # Vue 3');
    lines.push('npm install lucide-svelte     # Svelte');
    lines.push('npm install @iconify/react    # any framework, 10k+ sets at runtime');
    lines.push('```');
    lines.push('');
    lines.push(
      'Then search and fetch official SVGs with `icon-tool.mjs search` / `svg`. Never hand-draw icon paths.',
    );
  }

  if (htmlHints.length) {
    lines.push('');
    lines.push('## CDN hints in HTML');
    lines.push('');
    for (const hint of htmlHints) lines.push(`- ${hint.name} — ${hint.file}`);
  }

  process.stdout.write(`${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`);
}

/* ------------------------------------------------------------------ */
/* search                                                             */
/* ------------------------------------------------------------------ */

async function searchIcons(args) {
  const { values, positionals } = parseCliArgs(args, {
    prefix: { type: 'string' },
    limit: { type: 'string' },
    json: { type: 'boolean', default: false },
  });

  const query = (positionals[0] || '').trim();
  if (!query) fail('Missing search query.', 'Example: search "sparkles" --prefix lucide,tabler');
  if (positionals.length > 1) fail('Quote multi-word queries, e.g. search "arrow up right".');

  const limit = Math.min(50, Math.max(1, Number.parseInt(values.limit || '15', 10) || 15));
  const prefixes = (values.prefix || '')
    .split(',')
    .map((prefix) => prefix.trim())
    .filter(Boolean);

  const searchOnce = async (withPrefixes) => {
    const params = new URLSearchParams({ query, limit: String(limit) });
    if (withPrefixes.length) params.set('prefixes', withPrefixes.join(','));
    const scope = withPrefixes.length ? `prefixes=${withPrefixes.join(',')}` : 'all collections';
    log(`Searching Iconify (${scope}, limit ${limit})...`);
    const data = await fetchIconifySearch(params);
    return data.icons || [];
  };

  let icons = await searchOnce(prefixes);
  let fallbackNote = '';
  if (!icons.length && prefixes.length) {
    fallbackNote = `No matches in "${prefixes.join(',')}" — searched all collections instead.`;
    icons = await searchOnce([]);
  }

  // The Iconify search endpoint ignores small limits (it always returns up to 32),
  // so enforce the caller's limit locally.
  if (icons.length > limit) icons = icons.slice(0, limit);

  const grouped = [];
  const byPrefix = new Map();
  for (const id of icons) {
    const [prefix, name] = id.split(':');
    if (!byPrefix.has(prefix)) {
      const group = { prefix, name: collectionName(prefix), items: [] };
      byPrefix.set(prefix, group);
      grouped.push(group);
    }
    byPrefix.get(prefix).items.push({ id, name, hint: componentHint(prefix, name) });
  }

  if (values.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          query,
          prefixes,
          fallbackNote: fallbackNote || null,
          total: icons.length,
          groups: grouped.map((group) => ({
            prefix: group.prefix,
            collection: group.name,
            icons: group.items,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const lines = [];
  lines.push(`# Iconify search: "${query}"`);
  lines.push('');
  if (!icons.length) {
    lines.push('No icons found.');
    lines.push('');
    lines.push('Try: broader keywords, singular nouns, or drop `--prefix`.');
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  lines.push(
    `Matches: ${icons.length} · collections: ${grouped.map((group) => group.prefix).join(', ')}`,
  );
  if (fallbackNote) {
    lines.push('');
    lines.push(`⚠️ ${fallbackNote}`);
  }

  for (const group of grouped) {
    lines.push('');
    lines.push(`## ${group.prefix} — ${group.name} (${group.items.length})`);
    for (const item of group.items) {
      lines.push(`- \`${item.id}\` — ${item.hint}`);
    }
  }

  lines.push('');
  lines.push('## Next');
  lines.push('- Fetch the original SVG: `node scripts/icon-tool.mjs svg <id> --size 24`');
  lines.push('- Or install/import the mapped component shown above.');
  lines.push('- Only verified ids may be used. Do not guess icon names from memory.');

  process.stdout.write(`${lines.join('\n')}\n`);
}

/* ------------------------------------------------------------------ */
/* Iconify API access (redundant official hosts)                      */
/* ------------------------------------------------------------------ */

async function iconifyRequest(pathAndQuery, { accept, timeout = 10000 } = {}) {
  const urls = ICONIFY_API_HOSTS.map((base) => `${base}${pathAndQuery}`);
  return requestFirstOk(
    urls,
    { headers: { Accept: accept || 'application/json' }, timeout, retries: 1 },
    (failedUrl, err) => {
      let host = failedUrl;
      try {
        host = new URL(failedUrl).host;
      } catch {
        // Keep the raw URL.
      }
      log(`Iconify host ${host} failed (${err.message}); trying a mirror...`);
    },
  );
}

async function fetchIconifySearch(params) {
  const res = await iconifyRequest(`/search?${params.toString()}`, {
    accept: 'application/json',
  });
  if (!res.ok) {
    fail(
      `Iconify search failed with HTTP ${res.status}.`,
      'Retry once; if it persists, use a known icon id or ask the user.',
    );
  }
  try {
    return JSON.parse(res.text);
  } catch {
    fail('Iconify returned invalid JSON.', `Response started with: ${res.text.slice(0, 120)}`);
  }
}

/* ------------------------------------------------------------------ */
/* svg                                                                */
/* ------------------------------------------------------------------ */

function parseIconId(raw) {
  const match = /^\s*([a-z0-9-]+)[/:]([a-z0-9-]+)\s*$/i.exec(raw || '');
  if (!match) {
    fail(
      `Invalid icon id: "${raw}".`,
      'Use `prefix:name` (e.g. lucide:sparkles). Run `search` to find real ids.',
    );
  }
  return { prefix: match[1].toLowerCase(), name: match[2].toLowerCase() };
}

async function fetchSvg(args) {
  const { values, positionals } = parseCliArgs(args, {
    size: { type: 'string' },
    color: { type: 'string' },
    out: { type: 'string' },
    json: { type: 'boolean', default: false },
  });

  const rawId = positionals[0];
  if (!rawId) fail('Missing icon id.', 'Example: svg lucide:sparkles --size 20');
  if (positionals.length > 1) fail('Pass exactly one icon id.');

  const { prefix, name } = parseIconId(rawId);
  const size = Math.min(512, Math.max(8, Number.parseInt(values.size || '24', 10) || 24));

  const pathAndQuery = `/${prefix}/${name}.svg?height=${size}`;
  log(`Fetching official SVG: ${prefix}:${name} (${size}px)...`);
  const res = await iconifyRequest(pathAndQuery, { accept: 'image/svg+xml' });

  const body = res.text.trim();
  if (!res.ok || !body.toLowerCase().startsWith('<svg')) {
    if (res.status === 404) {
      fail(
        `Icon not found: ${prefix}:${name}.`,
        `Run \`node scripts/icon-tool.mjs search "<keyword>" --prefix ${prefix}\` to find a real id.`,
      );
    }
    fail(
      `Iconify did not return SVG for ${prefix}:${name} (HTTP ${res.status}).`,
      'Verify the icon set prefix and name with `search`.',
    );
  }

  let svg = body;
  const color = values.color;
  if (color) {
    svg = svg.replace(/currentColor/gi, color);
  }

  let savedTo = null;
  if (values.out) {
    savedTo = path.resolve(values.out);
    await writeText(savedTo, `${svg}\n`);
  }

  const bytes = Buffer.byteLength(`${svg}\n`, 'utf8');

  if (values.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          id: `${prefix}:${name}`,
          prefix,
          name,
          size,
          color: color || null,
          savedTo,
          bytes,
          svg,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (savedTo) {
    process.stdout.write(
      `Saved official SVG → ${savedTo} (${humanBytes(bytes)}) · ${prefix}:${name} · ${size}px\n`,
    );
    process.stdout.write(
      'Only size/color/class may be adjusted later; do not edit path data.\n',
    );
  } else {
    process.stdout.write(`${svg}\n`);
  }
}

/* ------------------------------------------------------------------ */
/* Entry                                                              */
/* ------------------------------------------------------------------ */

runMain(async () => {
  const argv = process.argv.slice(2);
  if (!argv.length || hasHelp(argv)) {
    if (argv[0] === 'check-local' && hasHelp(argv.slice(1))) return printHelp(CHECK_HELP);
    if (argv[0] === 'search' && hasHelp(argv.slice(1))) return printHelp(SEARCH_HELP);
    if (argv[0] === 'svg' && hasHelp(argv.slice(1))) return printHelp(SVG_HELP);
    return printHelp(USAGE);
  }

  const [command, ...rest] = argv;
  switch (command) {
    case 'check-local':
      if (hasHelp(rest)) return printHelp(CHECK_HELP);
      return checkLocal(rest);
    case 'search':
      if (hasHelp(rest)) return printHelp(SEARCH_HELP);
      return searchIcons(rest);
    case 'svg':
      if (hasHelp(rest)) return printHelp(SVG_HELP);
      return fetchSvg(rest);
    default:
      fail(`Unknown command: ${command}`, 'Run `node scripts/icon-tool.mjs --help`.');
  }
});
