#!/usr/bin/env node
/**
 * package — build a release archive of this skill.
 *
 *   node scripts/package.mjs            -> dist/<name>-<version>.zip + .sha256
 *   node scripts/package.mjs --out dir
 *
 * The ZIP is written with Node's zlib only (no npm dependencies, no system
 * `zip`/`tar` required, works on Windows, macOS and Linux).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { fail, hasHelp, humanBytes, parseCliArgs, printHelp, runMain } from './shared.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(scriptDir, '..');
const INCLUDE = [
  'LICENSE',
  'NOTICE',
  'SKILL.md',
  'INSTALL.md',
  'HARNESSES.md',
  'DISTRIBUTION.md',
  'README.md',
  'package.json',
  'scripts',
];

const USAGE = `
package — build a release archive of the skill

Usage:
  node scripts/package.mjs [--out dist] [--json]

Output:
  <out>/<name>-<version>.zip
  <out>/<name>-<version>.zip.sha256

The archive contains one top-level folder (<name>/) with SKILL.md, the docs,
package.json and scripts/. skill.config.json and temporary folders are never
included. No zip/tar binary or npm package is required.
`;

/* ------------------------------------------------------------------ */
/* ZIP writer (deflate via zlib, UTF-8 names, no dependencies)        */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosStamp(date = new Date()) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function buildZip(entries) {
  const { time, day } = dosStamp();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const data = entry.data;
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 file name
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, name, compressed);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, central, end]);
}

/* ------------------------------------------------------------------ */
/* File collection                                                    */
/* ------------------------------------------------------------------ */

async function collect(relative, zipRoot, files) {
  const full = path.join(ROOT, relative);
  const info = await stat(full).catch(() => null);
  if (!info) return;

  if (info.isDirectory()) {
    const names = (await readdir(full)).sort();
    for (const name of names) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      await collect(path.join(relative, name), zipRoot, files);
    }
    return;
  }

  if (relative.endsWith('skill.config.json')) return;
  const name = `${zipRoot}/${relative.split(path.sep).join('/')}`;
  files.push({ name, data: await readFile(full) });
}

/* ------------------------------------------------------------------ */
/* Entry                                                              */
/* ------------------------------------------------------------------ */

runMain(async () => {
  const argv = process.argv.slice(2);
  if (hasHelp(argv)) return printHelp(USAGE);

  const { values } = parseCliArgs(argv, {
    out: { type: 'string' },
    json: { type: 'boolean', default: false },
  });

  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  if (!manifest.name || !manifest.version) {
    fail('package.json is missing name or version.');
  }

  const outDir = path.resolve(values.out || path.join(ROOT, 'dist'));
  const files = [];
  for (const entry of INCLUDE) await collect(entry, manifest.name, files);

  if (!files.length) fail('Nothing to package — is this the skill folder?');

  const zip = buildZip(files);
  const fileName = `${manifest.name}-${manifest.version}.zip`;
  const zipPath = path.join(outDir, fileName);
  const checksum = createHash('sha256').update(zip).digest('hex');

  await mkdir(outDir, { recursive: true });
  await writeFile(zipPath, zip);
  await writeFile(`${zipPath}.sha256`, `${checksum}  ${fileName}\n`, 'utf8');

  if (values.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          file: zipPath,
          bytes: zip.length,
          sha256: checksum,
          files: files.map((file) => file.name),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write('# Packaged\n\n');
  process.stdout.write(`File:    ${zipPath}\n`);
  process.stdout.write(`Size:    ${humanBytes(zip.length)} (${files.length} files)\n`);
  process.stdout.write(`SHA256:  ${checksum}\n\n`);
  process.stdout.write('Install from the archive:\n');
  process.stdout.write(`  unzip ${fileName}\n`);
  process.stdout.write(
    `  node ${manifest.name}/scripts/install.mjs --project /path/to/project\n`,
  );
});
