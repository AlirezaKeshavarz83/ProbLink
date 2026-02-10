interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_CHAT_ID: string;
  TITLES: KVNamespace;
}

type Platform = 'CF' | 'ATC';

interface ResolvedQuery {
  platform: Platform;
  normalized: string;
  url: string;
  cfContestId?: string;
  cfIndex?: string;
  atcContestId?: string;
  atcIndex?: string;
}

interface CodeforcesProblem {
  index: string;
  name: string;
}

interface AtcoderProblem {
  contest_id?: string;
  problem_index?: string;
  name?: string;
  title?: string;
}

interface TelegramInlineQuery {
  id: string;
  from: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  query: string;
}

interface TelegramChosenInlineResult {
  result_id: string;
  from: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  query: string;
}

interface TelegramUpdate {
  inline_query?: TelegramInlineQuery;
  chosen_inline_result?: TelegramChosenInlineResult;
}

interface PendingLog {
  userId: number;
  username?: string;
  platform: Platform;
  displayTitle: string;
  url: string;
}

const INLINE_CACHE_SECONDS = 300;
const INLINE_MAX_RESULTS = 50;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === 'GET' && url.pathname === '/health') {
        return text('ok');
      }

      if (request.method === 'POST' && url.pathname === '/set-webhook') {
        return await handleSetWebhook(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/webhook') {
        requireEnv(env, ['BOT_TOKEN', 'WEBHOOK_SECRET', 'ADMIN_CHAT_ID']);
        const ok = verifyWebhookSecret(request, env.WEBHOOK_SECRET);
        if (!ok) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }

        const update = (await request.json()) as TelegramUpdate;

        if (update.inline_query) {
          ctx.waitUntil(handleInlineQuery(update.inline_query, env, ctx));
        }
        if (update.chosen_inline_result) {
          ctx.waitUntil(handleChosenInlineResult(update.chosen_inline_result, env));
        }

        return json({ ok: true });
      }

      return json({ ok: false, error: 'not_found' }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      return json({ ok: false, error: message }, 500);
    }
  },
};

async function handleSetWebhook(request: Request, env: Env): Promise<Response> {
  requireEnv(env, ['BOT_TOKEN', 'WEBHOOK_SECRET']);
  const url = new URL(request.url);
  const dropPending = (url.searchParams.get('drop_pending_updates') ?? 'false') === 'true';
  const webhookUrl = `${url.origin}/webhook`;

  const payload = {
    url: webhookUrl,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['inline_query', 'chosen_inline_result'],
    drop_pending_updates: dropPending,
  };

  const data = await telegramApi(env, 'setWebhook', payload);
  return json(data);
}

async function handleInlineQuery(
  inlineQuery: TelegramInlineQuery,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const contestIdQuery = parseCodeforcesContestQuery(inlineQuery.query);
  if (contestIdQuery) {
    const results = await buildCodeforcesContestInlineResults(env, contestIdQuery);
    await telegramApi(env, 'answerInlineQuery', {
      inline_query_id: inlineQuery.id,
      results,
      cache_time: INLINE_CACHE_SECONDS,
      is_personal: true,
    });
    return;
  }

  const atcoderContestQuery = parseAtcoderContestQuery(inlineQuery.query);
  if (atcoderContestQuery) {
    const results = await buildAtcoderContestInlineResults(env, atcoderContestQuery);
    await telegramApi(env, 'answerInlineQuery', {
      inline_query_id: inlineQuery.id,
      results,
      cache_time: INLINE_CACHE_SECONDS,
      is_personal: true,
    });
    return;
  }

  const resolved = parseAndResolveQuery(inlineQuery.query);

  if (!resolved) {
    await telegramApi(env, 'answerInlineQuery', {
      inline_query_id: inlineQuery.id,
      results: [],
      cache_time: INLINE_CACHE_SECONDS,
      is_personal: true,
    });
    return;
  }

  const displayTitle = await buildDisplayTitle(env, resolved);

  const markdownLink = `[${displayTitle}](${resolved.url})`;
  const text = `${markdownLink}`;
  const resultId = buildResultId(resolved.platform, resolved.normalized);

  const article = {
    type: 'article',
    id: resultId,
    title: displayTitle,
    description: resolved.url,
    thumbnail_url: getInlineThumbnailUrl(resolved.platform),
    input_message_content: {
      message_text: text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    },
  };

  await telegramApi(env, 'answerInlineQuery', {
    inline_query_id: inlineQuery.id,
    results: [article],
    cache_time: INLINE_CACHE_SECONDS,
    is_personal: true,
  });

}

async function handleChosenInlineResult(chosen: TelegramChosenInlineResult, env: Env): Promise<void> {
  const resolved = parseChosenResult(chosen);
  if (!resolved) {
    return;
  }

  await logAdminUsage(env, {
    userId: chosen.from.id,
    username: chosen.from.username,
    platform: resolved.platform,
    displayTitle: resolved.normalized,
    url: resolved.url,
  });
}

function parseCodeforcesContestQuery(raw: string): string | null {
  const trimmed = raw.trim();
  const match = /^([0-9]+)$/.exec(trimmed);
  if (!match) {
    return null;
  }
  return match[1];
}

function parseAtcoderContestQuery(raw: string): string | null {
  const trimmed = raw.trim();
  const match = /^(abc|arc|agc|ahc|apc)([0-9]{1,3})$/i.exec(trimmed);
  if (!match) {
    return null;
  }
  return normalizeAtcoderContest(match[1], match[2]);
}

function parseChosenResult(chosen: TelegramChosenInlineResult): ResolvedQuery | null {
  const parsedFromQuery = parseAndResolveQuery(chosen.query);
  if (parsedFromQuery) {
    return parsedFromQuery;
  }

  const resultIdMatch = /^(CF|ATC):(.+)$/.exec(chosen.result_id);
  if (!resultIdMatch) {
    return null;
  }

  return parseAndResolveQuery(resultIdMatch[2]);
}

function parseAndResolveQuery(raw: string): ResolvedQuery | null {
  const q = raw.trim();

  const cfMatch = /^([0-9]+)([a-z][0-9]*)$/i.exec(q);
  if (cfMatch) {
    const contestId = cfMatch[1];
    const problemIndex = cfMatch[2].toUpperCase();
    return {
      platform: 'CF',
      normalized: `${contestId}${problemIndex}`,
      url: `https://codeforces.com/contest/${contestId}/problem/${problemIndex}`,
      cfContestId: contestId,
      cfIndex: problemIndex,
    };
  }

  const atcCanonical = /^(abc|arc|agc|ahc|apc)([0-9]{1,3})_([a-z])$/i.exec(q);
  if (atcCanonical) {
    const contest = normalizeAtcoderContest(atcCanonical[1], atcCanonical[2]);
    const letter = atcCanonical[3].toLowerCase();
    const normalized = `${contest}_${letter}`;
    return {
      platform: 'ATC',
      normalized,
      url: `https://atcoder.jp/contests/${contest}/tasks/${normalized}`,
      atcContestId: contest,
      atcIndex: letter,
    };
  }

  const atcCompact = /^(abc|arc|agc|ahc|apc)([0-9]{1,3})([a-z])$/i.exec(q);
  if (atcCompact) {
    const contest = normalizeAtcoderContest(atcCompact[1], atcCompact[2]);
    const letter = atcCompact[3].toLowerCase();
    const normalized = `${contest}_${letter}`;
    return {
      platform: 'ATC',
      normalized,
      url: `https://atcoder.jp/contests/${contest}/tasks/${normalized}`,
      atcContestId: contest,
      atcIndex: letter,
    };
  }

  return null;
}

function normalizeAtcoderContest(prefix: string, contestNumber: string): string {
  return `${prefix.toLowerCase()}${contestNumber.padStart(3, '0')}`;
}

async function getCodeforcesTitle(env: Env, contestId: string, index: string): Promise<string | null> {
  const contestMap = await getCodeforcesContestMap(env, contestId);
  return contestMap[index.toUpperCase()] ?? null;
}

async function getCodeforcesContestMap(env: Env, contestId: string): Promise<Record<string, string>> {
  const contestKey = `cf:${contestId}`;
  const cachedContest = await env.TITLES.get(contestKey);
  if (cachedContest) {
    try {
      return JSON.parse(cachedContest) as Record<string, string>;
    } catch {
      console.warn(`Invalid JSON in KV for ${contestKey}; refreshing from source.`);
    }
  }

  const apiUrl = new URL('https://codeforces.com/api/contest.standings');
  apiUrl.searchParams.set('contestId', contestId);
  apiUrl.searchParams.set('from', '1');
  apiUrl.searchParams.set('count', '1');

  const res = await fetch(apiUrl.toString(), {
    headers: {
      'User-Agent': 'ProbLinkBot/1.0 (+Cloudflare-Worker)',
    },
  });

  if (!res.ok) {
    return {};
  }

  const body = (await res.json()) as {
    status?: string;
    result?: { problems?: CodeforcesProblem[] };
  };

  if (body.status !== 'OK' || !body.result?.problems?.length) {
    return {};
  }

  const contestMap: Record<string, string> = {};
  for (const problem of body.result.problems) {
    contestMap[problem.index.toUpperCase()] = problem.name;
  }

  if (Object.keys(contestMap).length > 0) {
    await putKvSafe(env.TITLES, contestKey, JSON.stringify(contestMap), 'Codeforces contest cache');
  }

  return contestMap;
}

async function getAtcoderTitle(env: Env, contestId: string, index: string): Promise<string | null> {
  const contestMap = await getAtcoderContestMap(env, contestId);
  return contestMap[index.toLowerCase()] ?? null;
}

async function getAtcoderContestMap(env: Env, contestId: string): Promise<Record<string, string>> {
  const contestKey = `atc:${contestId}`;
  const cachedContest = await env.TITLES.get(contestKey);
  if (cachedContest) {
    try {
      return JSON.parse(cachedContest) as Record<string, string>;
    } catch {
      console.warn(`Invalid JSON in KV for ${contestKey}; refreshing from source.`);
    }
  }

  const res = await fetch('https://kenkoooo.com/atcoder/resources/problems.json', {
    headers: {
      'User-Agent': 'ProbLinkBot/1.0 (+Cloudflare-Worker)',
    },
  });
  if (!res.ok) {
    return {};
  }

  const problems = (await res.json()) as AtcoderProblem[];
  const contestMap: Record<string, string> = {};
  for (const problem of problems) {
    if (problem.contest_id !== contestId) {
      continue;
    }

    const problemIndex = (problem.problem_index ?? '').toLowerCase();
    if (!/^[a-z]$/.test(problemIndex)) {
      continue;
    }

    const problemName = (problem.name ?? problem.title ?? '').trim();
    if (!problemName) {
      continue;
    }

    contestMap[problemIndex] = problemName;
  }

  if (Object.keys(contestMap).length > 0) {
    await putKvSafe(env.TITLES, contestKey, JSON.stringify(contestMap), 'AtCoder contest cache');
  }

  return contestMap;
}

async function logAdminUsage(env: Env, data: PendingLog): Promise<void> {
  const userTag = data.username ? `@${escapeMarkdown(data.username)}` : '(no username)';
  const markdownLink = `[${data.displayTitle}](${data.url})`;
  const text =
    `👤 ${userTag} (\`${data.userId}\`)\n` +
    `📘 *${data.platform}*\n` +
    `${markdownLink}`;

  await telegramApi(env, 'sendMessage', {
    chat_id: env.ADMIN_CHAT_ID,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
}

function verifyWebhookSecret(request: Request, expected: string): boolean {
  const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  return Boolean(got && got === expected);
}

function buildResultId(platform: Platform, normalized: string): string {
  return `${platform}:${normalized}`;
}

function getInlineThumbnailUrl(platform: Platform): string {
  if (platform === 'CF') {
    return 'https://www.google.com/s2/favicons?sz=128&domain=codeforces.com';
  }
  return 'https://www.google.com/s2/favicons?sz=128&domain=atcoder.jp';
}

async function telegramApi(env: Env, method: string, payload: unknown): Promise<unknown> {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram API ${method} failed: ${data.description ?? res.statusText}`);
  }
  return data;
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/`/g, '\\`');
}

async function buildDisplayTitle(env: Env, resolved: ResolvedQuery): Promise<string> {
  if (resolved.platform === 'CF') {
    const title = await getCodeforcesTitle(env, resolved.cfContestId as string, resolved.cfIndex as string);
    return `${resolved.normalized.toUpperCase()} - ${title ?? 'Problem'}`;
  }

  const title = await getAtcoderTitle(env, resolved.atcContestId as string, resolved.atcIndex as string);
  if (title) {
    return `${resolved.normalized} - ${title}`;
  }

  return resolved.normalized;
}

async function buildCodeforcesContestInlineResults(
  env: Env,
  contestId: string,
): Promise<Array<Record<string, unknown>>> {
  const contestMap = await getCodeforcesContestMap(env, contestId);
  const indexes = Object.keys(contestMap).sort(compareCodeforcesProblemIndexes).slice(0, INLINE_MAX_RESULTS);

  return indexes.map((index) => {
    const normalized = `${contestId}${index}`;
    const url = `https://codeforces.com/contest/${contestId}/problem/${index}`;
    const displayTitle = `${normalized} - ${contestMap[index]}`;
    return {
      type: 'article',
      id: buildResultId('CF', normalized),
      title: displayTitle,
      description: url,
      thumbnail_url: getInlineThumbnailUrl('CF'),
      input_message_content: {
        message_text: `[${displayTitle}](${url})`,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      },
    };
  });
}

async function buildAtcoderContestInlineResults(
  env: Env,
  contestId: string,
): Promise<Array<Record<string, unknown>>> {
  const contestMap = await getAtcoderContestMap(env, contestId);
  const indexes = Object.keys(contestMap).sort((a, b) => a.localeCompare(b)).slice(0, INLINE_MAX_RESULTS);

  return indexes.map((index) => {
    const normalized = `${contestId}_${index}`;
    const url = `https://atcoder.jp/contests/${contestId}/tasks/${normalized}`;
    const displayTitle = `${normalized} - ${contestMap[index]}`;
    return {
      type: 'article',
      id: buildResultId('ATC', normalized),
      title: displayTitle,
      description: url,
      thumbnail_url: getInlineThumbnailUrl('ATC'),
      input_message_content: {
        message_text: `[${displayTitle}](${url})`,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      },
    };
  });
}

function compareCodeforcesProblemIndexes(a: string, b: string): number {
  const aa = /^([A-Z])([0-9]*)$/.exec(a.toUpperCase());
  const bb = /^([A-Z])([0-9]*)$/.exec(b.toUpperCase());
  if (!aa || !bb) {
    return a.localeCompare(b);
  }

  if (aa[1] !== bb[1]) {
    return aa[1].localeCompare(bb[1]);
  }

  const an = aa[2] ? Number(aa[2]) : 0;
  const bn = bb[2] ? Number(bb[2]) : 0;
  return an - bn;
}

function requireEnv(env: Env, keys: Array<keyof Env>): void {
  for (const key of keys) {
    if (!env[key]) {
      throw new Error(`missing required env: ${key}`);
    }
  }
}

async function putKvSafe(
  kv: KVNamespace,
  key: string,
  value: string,
  context: string,
  options?: KVNamespacePutOptions,
): Promise<void> {
  try {
    await kv.put(key, value, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`KV write skipped (${context}) for key "${key}": ${message}`);
  }
}
