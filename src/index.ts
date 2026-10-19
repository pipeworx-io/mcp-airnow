interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * EPA AirNow MCP — official US current + forecast AQI, keyless, from AirNow's
 * public file products (files.airnowtech.org).
 *
 * AirNow is the EPA's authoritative source for current and forecasted air
 * quality at >2,000 US monitoring sites. Complements `airquality` (Open-Meteo
 * gridded forecast), `openaq` (open dataset), and `waqi` (global private
 * stations) with the EPA-official US layer.
 *
 * Source: AirNow RETIRED its keyed web service (www.airnowapi.org/aq/*) on
 * 2026-10-01 — every call returned HTTP 410 (fleet #2808). The same data is
 * published keyless as pipe-delimited / CSV files on files.airnowtech.org
 * (an S3 bucket AirNow refreshes hourly), which this pack reads live per call:
 *
 * - airnow/today/cityzipcodes.csv          ZIP → city, state, lat, lon (27k rows)
 * - airnow/today/reportingarea.dat         per reporting area: yesterday (Y),
 *                                          current observed (O) and forecast (F)
 *                                          AQI rows with lat/lon + discussion
 * - airnow/YYYY/YYYYMMDD/HourlyAQObs_YYYYMMDDHH.dat
 *                                          per-site hourly AQI + concentrations,
 *                                          one file per UTC hour, with lat/lon
 *
 * Format fact sheets: https://files.airnowtech.org/airnow/docs/
 *
 * Tools:
 * - current_by_zip:       latest AQI for the reporting area nearest a US ZIP code
 * - current_by_location:  latest AQI for the reporting area nearest a lat/lon
 * - forecast_by_zip:      AQI forecast (today + up to 3 days) for a US ZIP code
 * - observations_in_bbox: hourly site observations inside a bounding box
 */


const UA = 'pipeworx-mcp-airnow/2.0 (+https://pipeworx.io)';
const FILES_BASE = 'https://files.airnowtech.org/airnow';
const ZIP_URL = `${FILES_BASE}/today/cityzipcodes.csv`;
const REPORTING_AREA_URL = `${FILES_BASE}/today/reportingarea.dat`;
const DOCS_URL = 'https://files.airnowtech.org/airnow/docs/';
const SOURCE_NOTE =
  'US EPA AirNow public file products (files.airnowtech.org); the keyed AirNow web service was retired 2026-10-01.';

// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, { ...(init ?? {}), headers: { 'User-Agent': UA, ...(init?.headers ?? {}) } }, 'EPA AirNow');
}

const tools: McpToolExport['tools'] = [
  {
    name: 'current_by_zip',
    description:
      'Latest observed air quality index (AQI) for the EPA AirNow reporting area nearest a US ZIP code: one row per pollutant (ozone, PM2.5, PM10) with the AQI value, category (Good / Moderate / Unhealthy …), observation hour, reporting agency and yesterday\'s AQI for comparison. Answers "what is the air quality in ZIP 94103 right now".',
    inputSchema: {
      type: 'object',
      properties: {
        zip_code: { type: 'string', description: 'US 5-digit ZIP code' },
        distance_miles: { type: 'number', description: 'Search radius for the nearest reporting area (default 25, max 250)' },
      },
      required: ['zip_code'],
    },
  },
  {
    name: 'current_by_location',
    description:
      'Latest observed air quality index (AQI) for the EPA AirNow reporting area nearest a latitude/longitude in the US: one row per pollutant with AQI value, category, observation hour, agency and yesterday\'s AQI. Answers "what is the air quality at these coordinates right now".',
    inputSchema: {
      type: 'object',
      properties: {
        latitude: { type: 'number', description: 'US latitude' },
        longitude: { type: 'number', description: 'US longitude' },
        distance_miles: { type: 'number', description: 'Search radius for the nearest reporting area (default 25, max 250)' },
      },
      required: ['latitude', 'longitude'],
    },
  },
  {
    name: 'forecast_by_zip',
    description:
      'EPA AirNow air quality (AQI) forecast for a US ZIP code — today and up to three days ahead, per pollutant, with the forecast category, Action Day flag and the forecaster\'s discussion text. Pass a date (YYYY-MM-DD) to get one day, omit it for every day AirNow has issued. Answers "is tomorrow ok for outdoor activity in 60601".',
    inputSchema: {
      type: 'object',
      properties: {
        zip_code: { type: 'string', description: 'US 5-digit ZIP code' },
        date: { type: 'string', description: 'YYYY-MM-DD forecast day (default: every day AirNow has issued, today + up to 3)' },
        distance_miles: { type: 'number', description: 'Search radius for the nearest reporting area (default 25, max 250)' },
      },
      required: ['zip_code'],
    },
  },
  {
    name: 'observations_in_bbox',
    description:
      'Hourly EPA AirNow monitoring-site observations inside a bounding box for a span of UTC hours (max 24 hours per call): per site and hour, the AQI for ozone, PM2.5, PM10 and NO2 and the measured concentrations for PM2.5, ozone, NO2, CO, SO2 and PM10. Specify pollutants as comma-separated codes ("OZONE,PM25,PM10,CO,NO2,SO2"). bbox format: "minLon,minLat,maxLon,maxLat"; dates as "YYYY-MM-DDTHH" (UTC). Answers "which monitors in the LA basin exceeded AQI 100 yesterday".',
    inputSchema: {
      type: 'object',
      properties: {
        bbox: { type: 'string', description: 'minLon,minLat,maxLon,maxLat' },
        start_date: { type: 'string', description: 'YYYY-MM-DDTHH (UTC hour, inclusive)' },
        end_date: { type: 'string', description: 'YYYY-MM-DDTHH (UTC hour, inclusive; at most 23 hours after start_date)' },
        parameters: { type: 'string', description: 'Comma-separated pollutants (default: OZONE,PM25,PM10; also NO2,CO,SO2)' },
        data_type: { type: 'string', description: 'A (AQI only) | C (concentration only) | B (both, default)' },
        verbose: { type: 'boolean', description: 'Include site status, EPA region, elevation, data source agency and reporting areas' },
      },
      required: ['bbox', 'start_date', 'end_date'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'current_by_zip':
      return currentByZip(args);
    case 'current_by_location':
      return currentByLocation(args);
    case 'forecast_by_zip':
      return forecastByZip(args);
    case 'observations_in_bbox':
      return observationsInBbox(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Fetching + in-isolate caching. The two "today" files are ~1-2 MB each and
// AirNow rewrites them hourly; a Worker isolate that already parsed one can
// answer the next question from memory. The gateway's result cache sits in
// front of this as well (CACHE_TTL_OVERRIDES.airnow).
// ---------------------------------------------------------------------------

interface CachedText {
  body: string;
  lastModified: string | null;
  fetchedAt: number;
}

const textCache = new Map<string, CachedText>();

async function loadText(url: string, ttlMs: number): Promise<CachedText> {
  const hit = textCache.get(url);
  if (hit && Date.now() - hit.fetchedAt < ttlMs) return hit;
  const res = await pwFetch(url, { headers: { Accept: 'text/plain, text/csv, */*' } });
  if (res.status === 404) throw new NotPublished(url);
  if (!res.ok) {
    throw new Error(`EPA AirNow file server returned HTTP ${res.status} for ${url.replace(FILES_BASE, 'airnow')}.`);
  }
  const body = await res.text();
  const entry: CachedText = { body, lastModified: toIso(res.headers.get('last-modified')), fetchedAt: Date.now() };
  textCache.set(url, entry);
  return entry;
}

class NotPublished extends Error {
  constructor(public url: string) {
    super(`not published: ${url}`);
  }
}

function toIso(httpDate: string | null): string | null {
  if (!httpDate) return null;
  const t = Date.parse(httpDate);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// ZIP index — airnow/today/cityzipcodes.csv  (City|State|Zipcode|Latitude|Longitude)
// ---------------------------------------------------------------------------

interface ZipRow {
  zip: string;
  city: string;
  state: string;
  lat: number;
  lon: number;
}

let zipIndex: { map: Map<string, ZipRow>; lastModified: string | null } | null = null;
let zipIndexAt = 0;
const ZIP_TTL_MS = 24 * 3600 * 1000;

async function getZipIndex() {
  if (zipIndex && Date.now() - zipIndexAt < ZIP_TTL_MS) return zipIndex;
  const { body, lastModified } = await loadText(ZIP_URL, ZIP_TTL_MS);
  const map = new Map<string, ZipRow>();
  for (const line of body.split('\n')) {
    const f = line.trim().split('|');
    if (f.length < 5 || f[2] === 'Zipcode') continue;
    const lat = Number(f[3]);
    const lon = Number(f[4]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    map.set(f[2], { zip: f[2], city: f[0], state: f[1], lat, lon });
  }
  zipIndex = { map, lastModified };
  zipIndexAt = Date.now();
  return zipIndex;
}

// ---------------------------------------------------------------------------
// Reporting-area file — airnow/today/reportingarea.dat (pipe-delimited)
//   issue_date|valid_date|valid_time|tz|day_offset|type|primary|area|state|
//   lat|lon|parameter|aqi|category|action_day|discussion|agency
// type: Y = yesterday's observed, O = current observed, F = forecast
// ---------------------------------------------------------------------------

interface AreaRow {
  issue_date: string;
  valid_date: string;
  valid_time: string;
  timezone: string;
  day_offset: number;
  type: 'Y' | 'O' | 'F';
  primary: boolean;
  area: string;
  state: string;
  lat: number;
  lon: number;
  pollutant: string;
  aqi: number | null;
  category: string | null;
  action_day: boolean;
  discussion: string | null;
  agency: string;
}

interface ReportingArea {
  key: string;
  area: string;
  state: string;
  lat: number;
  lon: number;
  rows: AreaRow[];
}

let areaIndex: { areas: ReportingArea[]; lastModified: string | null } | null = null;
let areaIndexAt = 0;
const AREA_TTL_MS = 10 * 60 * 1000;

async function getReportingAreas() {
  if (areaIndex && Date.now() - areaIndexAt < AREA_TTL_MS) return areaIndex;
  const { body, lastModified } = await loadText(REPORTING_AREA_URL, AREA_TTL_MS);
  const byKey = new Map<string, ReportingArea>();
  for (const line of body.split('\n')) {
    const f = line.split('|');
    if (f.length < 17) continue;
    const lat = Number(f[9]);
    const lon = Number(f[10]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const type = f[5] as AreaRow['type'];
    if (type !== 'Y' && type !== 'O' && type !== 'F') continue;
    const aqi = f[12].trim() === '' ? null : Number(f[12]);
    const row: AreaRow = {
      issue_date: mdyToIso(f[0]),
      valid_date: mdyToIso(f[1]),
      valid_time: f[2],
      timezone: f[3],
      day_offset: Number(f[4]),
      type,
      primary: f[6] === 'Y',
      area: f[7],
      state: f[8],
      lat,
      lon,
      pollutant: f[11],
      aqi: aqi !== null && Number.isFinite(aqi) ? aqi : null,
      category: f[13] || null,
      action_day: f[14] === 'Yes',
      discussion: f[15]?.trim() || null,
      agency: f[16]?.trim() ?? '',
    };
    const key = `${row.area}|${row.state}`;
    let area = byKey.get(key);
    if (!area) {
      area = { key, area: row.area, state: row.state, lat, lon, rows: [] };
      byKey.set(key, area);
    }
    area.rows.push(row);
  }
  areaIndex = { areas: [...byKey.values()], lastModified };
  areaIndexAt = Date.now();
  return areaIndex;
}

/** "10/07/26" → "2026-10-07" */
function mdyToIso(s: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{2,4})$/.exec(s.trim());
  if (!m) return s.trim();
  const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${yr}-${m[1]}-${m[2]}`;
}

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function radiusMiles(args: Record<string, unknown>): number {
  const d = typeof args.distance_miles === 'number' ? args.distance_miles : 25;
  return Math.min(250, Math.max(0, d));
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing or empty. Pass a string like ${example}.`);
  }
  return v.trim();
}

function reqNum(args: Record<string, unknown>, key: string): number {
  const v = typeof args[key] === 'string' ? Number(args[key]) : args[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`Required argument "${key}" is missing or not a number.`);
  }
  return v;
}

/** Reporting areas within `radius` miles of a point, nearest first, that carry at least one row of `type`. */
async function nearestAreas(lat: number, lon: number, radius: number, type: AreaRow['type']) {
  const { areas, lastModified } = await getReportingAreas();
  const ranked = areas
    .map((a) => ({ area: a, distance_miles: haversineMiles(lat, lon, a.lat, a.lon) }))
    .filter((x) => x.distance_miles <= radius && x.area.rows.some((r) => r.type === type))
    .sort((a, b) => a.distance_miles - b.distance_miles);
  return { ranked, lastModified };
}

function observationOut(r: AreaRow) {
  return {
    pollutant: r.pollutant,
    aqi: r.aqi,
    category: r.category,
    observed_date: r.valid_date,
    observed_hour: r.valid_time || null,
    timezone: r.timezone,
    primary_pollutant: r.primary,
    agency: r.agency,
  };
}

function areaHeader(hit: { area: ReportingArea; distance_miles: number }) {
  return {
    reporting_area: hit.area.area,
    state: hit.area.state,
    area_latitude: hit.area.lat,
    area_longitude: hit.area.lon,
    distance_miles: Math.round(hit.distance_miles * 10) / 10,
  };
}

async function currentForPoint(lat: number, lon: number, radius: number) {
  const { ranked, lastModified } = await nearestAreas(lat, lon, radius, 'O');
  if (ranked.length === 0) {
    return {
      found: false as const,
      reason: 'no_reporting_area_in_radius',
      hint: `No EPA AirNow reporting area with a current observation within ${radius} miles of ${lat},${lon}. Raise distance_miles (max 250), or use observations_in_bbox for raw monitor sites, or the openaq / airquality packs for non-AirNow coverage.`,
      data_as_of: lastModified,
      source: REPORTING_AREA_URL,
    };
  }
  const hit = ranked[0];
  const current = hit.area.rows.filter((r) => r.type === 'O');
  const yesterday = hit.area.rows.filter((r) => r.type === 'Y');
  return {
    found: true as const,
    ...areaHeader(hit),
    count: current.length,
    observations: current.map(observationOut),
    yesterday: yesterday.map((r) => ({ pollutant: r.pollutant, aqi: r.aqi, category: r.category, date: r.valid_date })),
    other_areas_in_radius: ranked.slice(1, 6).map(areaHeader),
    data_as_of: lastModified,
    source: REPORTING_AREA_URL,
    source_note: SOURCE_NOTE,
  };
}

async function resolveZip(zip: string) {
  const idx = await getZipIndex();
  const row = idx.map.get(zip);
  if (!row) {
    return {
      found: false as const,
      reason: 'zip_not_in_airnow_index',
      hint: `ZIP ${zip} is not in AirNow's city/ZIP index (${idx.map.size} ZIPs). Geocode it and call current_by_location / forecast_by_zip's sibling with latitude and longitude instead.`,
      source: ZIP_URL,
    };
  }
  return { found: true as const, ...row };
}

async function currentByZip(args: Record<string, unknown>) {
  const zip = reqStr(args, 'zip_code', '"94103"');
  const loc = await resolveZip(zip);
  if (!loc.found) return { zip_code: zip, ...loc };
  const out = await currentForPoint(loc.lat, loc.lon, radiusMiles(args));
  return { zip_code: zip, city: loc.city, zip_state: loc.state, ...out };
}

async function currentByLocation(args: Record<string, unknown>) {
  const lat = reqNum(args, 'latitude');
  const lon = reqNum(args, 'longitude');
  const out = await currentForPoint(lat, lon, radiusMiles(args));
  return { latitude: lat, longitude: lon, ...out };
}

async function forecastByZip(args: Record<string, unknown>) {
  const zip = reqStr(args, 'zip_code', '"94103"');
  const wantDate = typeof args.date === 'string' && args.date.trim() ? args.date.trim() : null;
  if (wantDate && !/^\d{4}-\d{2}-\d{2}$/.test(wantDate)) {
    throw new Error(`"date" must be YYYY-MM-DD, got "${wantDate}".`);
  }
  const loc = await resolveZip(zip);
  if (!loc.found) return { zip_code: zip, ...loc };
  const radius = radiusMiles(args);
  const { ranked, lastModified } = await nearestAreas(loc.lat, loc.lon, radius, 'F');
  if (ranked.length === 0) {
    return {
      zip_code: zip,
      found: false,
      reason: 'no_forecast_area_in_radius',
      hint: `No EPA AirNow reporting area with an issued forecast within ${radius} miles of ZIP ${zip}. Raise distance_miles (max 250) or use the airquality pack (Open-Meteo gridded forecast).`,
      data_as_of: lastModified,
      source: REPORTING_AREA_URL,
    };
  }
  const hit = ranked[0];
  const all = hit.area.rows.filter((r) => r.type === 'F');
  const rows = wantDate ? all.filter((r) => r.valid_date === wantDate) : all;
  const available = [...new Set(all.map((r) => r.valid_date))].sort();
  const discussion = all.find((r) => r.discussion)?.discussion ?? null;
  return {
    zip_code: zip,
    city: loc.city,
    zip_state: loc.state,
    found: rows.length > 0,
    ...(rows.length === 0
      ? {
          reason: 'no_forecast_for_date',
          hint: `AirNow has issued forecasts for ${hit.area.area}, ${hit.area.state} on ${available.join(', ')} only (today + up to 3 days); pick one of those or omit date.`,
        }
      : {}),
    ...areaHeader(hit),
    requested_date: wantDate ?? 'all issued days',
    forecast_days_available: available,
    count: rows.length,
    forecast: rows
      .sort((a, b) => a.valid_date.localeCompare(b.valid_date) || a.pollutant.localeCompare(b.pollutant))
      .map((r) => ({
        forecast_date: r.valid_date,
        issued_date: r.issue_date,
        pollutant: r.pollutant,
        aqi: r.aqi,
        category: r.category,
        primary_pollutant: r.primary,
        action_day: r.action_day,
        agency: r.agency,
      })),
    discussion,
    data_as_of: lastModified,
    source: REPORTING_AREA_URL,
    source_note: SOURCE_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Hourly site observations — airnow/YYYY/YYYYMMDD/HourlyAQObs_YYYYMMDDHH.dat
// Quoted CSV with a header row; one file per UTC hour, ~1 MB, ~4,400 sites.
// ---------------------------------------------------------------------------

const PARAM_ALIASES: Record<string, string> = {
  OZONE: 'OZONE', O3: 'OZONE', PM25: 'PM25', 'PM2.5': 'PM25', PM10: 'PM10', NO2: 'NO2', CO: 'CO', SO2: 'SO2',
};
const AQI_PARAMS = new Set(['OZONE', 'PM25', 'PM10', 'NO2']);
const MAX_HOURS = 24;

function parseHour(s: string, key: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?/.exec(s.trim());
  if (!m) throw new Error(`"${key}" must be YYYY-MM-DDTHH (UTC hour), got "${s}".`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? '0')));
  if (Number.isNaN(d.getTime())) throw new Error(`"${key}" is not a valid date: "${s}".`);
  return d;
}

function hourFileUrl(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  return `${FILES_BASE}/${y}/${y}${mo}${da}/HourlyAQObs_${y}${mo}${da}${h}.dat`;
}

/** Minimal RFC-4180 line parser: every AirNow field is double-quoted; site names may contain commas. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const num = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

async function observationsInBbox(args: Record<string, unknown>) {
  const bboxStr = reqStr(args, 'bbox', '"-123.0,37.0,-121.0,38.5"');
  const bbox = bboxStr.split(',').map((s) => Number(s.trim()));
  if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
    throw new Error(`"bbox" must be "minLon,minLat,maxLon,maxLat", got "${bboxStr}".`);
  }
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const start = parseHour(reqStr(args, 'start_date', '"2026-10-06T00"'), 'start_date');
  const end = parseHour(reqStr(args, 'end_date', '"2026-10-06T23"'), 'end_date');
  if (end < start) throw new Error('"end_date" is before "start_date".');
  const hours = Math.floor((end.getTime() - start.getTime()) / 3_600_000) + 1;
  if (hours > MAX_HOURS) {
    throw new Error(
      `AirNow publishes one ~1 MB file per hour; this span is ${hours} hours and the cap is ${MAX_HOURS} per call. Narrow the range (e.g. one day: 2026-10-06T00 to 2026-10-06T23) and page by day.`,
    );
  }
  const wanted = ((args.parameters as string) ?? 'OZONE,PM25,PM10')
    .split(',')
    .map((p) => PARAM_ALIASES[p.trim().toUpperCase()])
    .filter(Boolean);
  if (wanted.length === 0) throw new Error('"parameters" named no known pollutant; use OZONE, PM25, PM10, NO2, CO, SO2.');
  const dataType = String(args.data_type ?? 'B').toUpperCase();
  if (!['A', 'C', 'B'].includes(dataType)) throw new Error('"data_type" must be A, C or B.');
  const verbose = Boolean(args.verbose);

  const slots: Date[] = [];
  for (let i = 0; i < hours; i++) slots.push(new Date(start.getTime() + i * 3_600_000));

  const missing: string[] = [];
  let latestModified: string | null = null;
  const observations: Record<string, unknown>[] = [];

  // Fetch in small parallel batches: max() of the batch instead of sum(), without
  // opening 24 sockets to one S3 bucket at once.
  const BATCH = 6;
  for (let i = 0; i < slots.length; i += BATCH) {
    const batch = slots.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (d) => {
        try {
          return { d, file: await loadText(hourFileUrl(d), 6 * 3600 * 1000) };
        } catch (err) {
          if (err instanceof NotPublished) return { d, file: null };
          throw err;
        }
      }),
    );
    for (const { d, file } of results) {
      const hourLabel = d.toISOString().slice(0, 13) + ':00Z';
      if (!file) {
        missing.push(hourLabel);
        continue;
      }
      if (file.lastModified && (!latestModified || file.lastModified > latestModified)) latestModified = file.lastModified;
      const lines = file.body.split('\n');
      const header = parseCsvLine(lines[0]);
      const col = (name: string) => header.indexOf(name);
      const iLat = col('Latitude');
      const iLon = col('Longitude');
      if (iLat < 0 || iLon < 0) continue;
      for (let li = 1; li < lines.length; li++) {
        const line = lines[li];
        if (!line.trim()) continue;
        const f = parseCsvLine(line);
        const lat = num(f[iLat]);
        const lon = num(f[iLon]);
        if (lat === null || lon === null) continue;
        if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) continue;
        const get = (n: string) => f[col(n)];
        const aqi: Record<string, number | null> = {};
        const concentration: Record<string, { value: number | null; unit: string | null }> = {};
        let any = false;
        for (const p of wanted) {
          if (dataType !== 'C' && AQI_PARAMS.has(p)) {
            const v = num(get(`${p}_AQI`));
            if (v !== null) {
              aqi[p] = v;
              any = true;
            }
          }
          if (dataType !== 'A') {
            const v = num(get(p));
            if (v !== null) {
              concentration[p] = { value: v, unit: get(`${p}_Unit`) || null };
              any = true;
            }
          }
        }
        if (!any) continue;
        observations.push({
          utc: hourLabel,
          site_id: get('AQSID'),
          site: get('SiteName'),
          latitude: lat,
          longitude: lon,
          local_date: mdyToIso(get('ValidDate') ?? ''),
          local_time: get('ValidTime') || null,
          gmt_offset: num(get('GMTOffset')),
          ...(dataType !== 'C' ? { aqi } : {}),
          ...(dataType !== 'A' ? { concentration } : {}),
          ...(verbose
            ? {
                status: get('Status') || null,
                epa_region: get('EPARegion') || null,
                elevation_m: num(get('Elevation')),
                country: get('CountryCode') || null,
                state: get('StateName') || null,
                agency: get('DataSource') || null,
                reporting_areas: (get('ReportingArea_PipeDelimited') ?? '').split('|').filter(Boolean),
              }
            : {}),
        });
      }
    }
  }

  const base = {
    bbox: bboxStr,
    start_utc: start.toISOString().slice(0, 13) + ':00Z',
    end_utc: end.toISOString().slice(0, 13) + ':00Z',
    hours_requested: hours,
    hours_published: hours - missing.length,
    hours_not_yet_published: missing,
    parameters: wanted,
    data_type: dataType,
    data_as_of: latestModified,
    source: `${FILES_BASE}/YYYY/YYYYMMDD/HourlyAQObs_YYYYMMDDHH.dat (format: ${DOCS_URL}HourlyAQObsFactSheet.pdf)`,
    source_note: SOURCE_NOTE,
  };
  if (observations.length === 0) {
    return {
      ...base,
      found: false,
      reason: missing.length === hours ? 'hours_not_published' : 'no_sites_in_bbox',
      hint:
        missing.length === hours
          ? 'AirNow has not published any of these hourly files yet (the current UTC hour lands ~30-60 min after it ends); ask for an earlier span.'
          : `No AirNow monitoring site reporting ${wanted.join('/')} inside ${bboxStr} in those hours. Widen the box (AirNow sites are sparse outside metro areas) or try other pollutants.`,
      count: 0,
      observations: [],
    };
  }
  return { ...base, found: true, count: observations.length, observations };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
