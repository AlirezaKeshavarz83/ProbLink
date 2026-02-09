#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_SOURCE = 'https://codeforces.com/api/problemset.problems';
const DEFAULT_OUTPUT = '/tmp/cf-kv-bulk.json';

function parseArgs(argv) {
  const args = {
    source: DEFAULT_SOURCE,
    output: DEFAULT_OUTPUT,
    binding: 'TITLES',
    limit: null,
    skipList: false,
    remote: false,
    local: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--source' && argv[i + 1]) {
      args.source = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--output' && argv[i + 1]) {
      args.output = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--binding' && argv[i + 1]) {
      args.binding = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--limit' && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid --limit value: ${argv[i + 1]}`);
      }
      args.limit = parsed;
      i += 1;
      continue;
    }
    if (token === '--skip-list') {
      args.skipList = true;
      continue;
    }
    if (token === '--remote') {
      args.remote = true;
      continue;
    }
    if (token === '--local') {
      args.local = true;
      continue;
    }
    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (args.remote && args.local) {
    throw new Error('Use at most one of --remote or --local.');
  }

  if (!args.remote && !args.local) {
    args.remote = true;
  }

  return args;
}

function printHelp() {
  console.log(`Fill Codeforces contest cache keys in KV.

Usage:
  node scripts/fill-codeforces-cache.mjs [options]

Options:
  --source <url-or-file>   Input JSON source (default: ${DEFAULT_SOURCE})
  --output <file>          Temp bulk JSON output (default: ${DEFAULT_OUTPUT})
  --binding <name>         KV binding name (default: TITLES)
  --limit <N>              Max number of new contest keys to upload
  --skip-list              Skip key listing and upload without duplicate check
  --remote                 Upload to remote KV (default)
  --local                  Upload to local KV
  --dry-run                Only generate output file; do not upload
  -h, --help               Show this help
`);
}

async function loadSource(source) {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, {
      headers: {
        'User-Agent': 'ProbLinkCacheFiller/1.0',
      },
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch source: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  const filePath = resolve(source);
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function normalizeProblemArray(input) {
  if (Array.isArray(input)) {
    return input;
  }

  if (
    input &&
    typeof input === 'object' &&
    input.status === 'OK' &&
    input.result &&
    typeof input.result === 'object' &&
    Array.isArray(input.result.problems)
  ) {
    return input.result.problems;
  }

  throw new Error('Unsupported Codeforces source format. Expected array or API response with result.problems.');
}

function buildBulkEntries(problemRows) {
  const problems = normalizeProblemArray(problemRows);

  /** @type {Map<string, Record<string, string>>} */
  const byContest = new Map();

  for (const row of problems) {
    if (!row || typeof row !== 'object') {
      continue;
    }

    const contestIdRaw = row.contestId;
    const indexRaw = row.index;
    const nameRaw = row.name;

    const contestId = Number.isInteger(contestIdRaw) ? String(contestIdRaw) : '';
    const index = typeof indexRaw === 'string' ? indexRaw.toUpperCase() : '';
    const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';

    if (!contestId || !index || !name) {
      continue;
    }

    let contestMap = byContest.get(contestId);
    if (!contestMap) {
      contestMap = {};
      byContest.set(contestId, contestMap);
    }

    if (!contestMap[index]) {
      contestMap[index] = name;
    }
  }

  const contests = Array.from(byContest.keys()).sort((a, b) => Number(a) - Number(b));
  const entries = contests.map((contestId) => ({
    key: `cf:${contestId}`,
    value: JSON.stringify(byContest.get(contestId)),
  }));

  return { entries, contestCount: contests.length };
}

function listExistingKeys(binding, mode) {
  const args = ['wrangler', 'kv', 'key', 'list', '--binding', binding, '--prefix', 'cf:', mode];
  const result = spawnSync('npx', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_LOG_PATH: '/tmp' },
    shell: false,
  });

  if (result.status !== 0) {
    throw new Error(`wrangler kv key list failed: ${result.stderr || result.stdout || '(no output)'}`);
  }

  const rows = JSON.parse(result.stdout);
  if (!Array.isArray(rows)) {
    throw new Error('Unexpected output from wrangler kv key list');
  }

  /** @type {Set<string>} */
  const keys = new Set();
  for (const row of rows) {
    if (row && typeof row.name === 'string') {
      keys.add(row.name);
    }
  }

  return keys;
}

function runBulkPut(output, binding, mode) {
  const args = ['wrangler', 'kv', 'bulk', 'put', output, '--binding', binding, mode];
  const result = spawnSync('npx', args, {
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_LOG_PATH: '/tmp' },
    shell: false,
  });

  if (result.status !== 0) {
    throw new Error(`wrangler kv bulk put failed with exit code ${result.status ?? 'unknown'}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = await loadSource(args.source);
  const { entries: allEntries, contestCount } = buildBulkEntries(source);
  const mode = args.remote ? '--remote' : '--local';

  const existing = args.skipList ? new Set() : listExistingKeys(args.binding, mode);
  let entries = allEntries.filter((entry) => !existing.has(entry.key));

  if (args.limit !== null) {
    entries = entries.slice(0, args.limit);
  }

  await writeFile(resolve(args.output), JSON.stringify(entries), 'utf8');

  console.log(`Found ${contestCount} contests in source.`);
  console.log(`Existing cf:* keys: ${existing.size}`);
  console.log(`Prepared ${entries.length} new KV entries.`);
  console.log(`Bulk file: ${resolve(args.output)}`);

  if (args.dryRun) {
    console.log('Dry run: upload skipped.');
    return;
  }

  if (entries.length === 0) {
    console.log('No new keys to upload.');
    return;
  }

  runBulkPut(resolve(args.output), args.binding, mode);
  console.log('Codeforces cache upload complete.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
