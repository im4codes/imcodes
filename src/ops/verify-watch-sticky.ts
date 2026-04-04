import { randomUUID } from 'node:crypto';
import { IMCODES_POD_HEADER } from '../../shared/http-header-names.js';

type Args = {
  baseUrl: string;
  apiKey: string;
  serverId: string;
  sessionName: string;
  sendText: string;
  historyLimit: number;
};

function usage(): never {
  console.error([
    'Usage: npx tsx src/ops/verify-watch-sticky.ts \
  --base-url <https://app.im.codes> \
  --api-key <token> \
  --server-id <serverId> \
  --session-name <sessionName> \
  --send-text <text> [--history-limit <n>]',
    '',
    'This smoke sends one message and reads history for the same server/session, then verifies',
    `both HTTP responses report the same ${IMCODES_POD_HEADER} header.`,
  ].join('\n'));
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key?.startsWith('--')) usage();
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) usage();
    values.set(key.slice(2), value);
    i += 1;
  }
  const baseUrl = values.get('base-url');
  const apiKey = values.get('api-key');
  const serverId = values.get('server-id');
  const sessionName = values.get('session-name');
  const sendText = values.get('send-text');
  const historyLimit = Number(values.get('history-limit') ?? '5');
  if (!baseUrl || !apiKey || !serverId || !sessionName || !sendText || !Number.isFinite(historyLimit) || historyLimit <= 0) {
    usage();
  }
  return { baseUrl, apiKey, serverId, sessionName, sendText, historyLimit: Math.trunc(historyLimit) };
}

async function expectJson(res: Response): Promise<unknown> {
  const bodyText = await res.text();
  let parsed: unknown = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    parsed = bodyText;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const authHeader = { Authorization: `Bearer ${args.apiKey}` };

  const historyUrl = new URL(`/api/server/${encodeURIComponent(args.serverId)}/timeline/history`, args.baseUrl);
  historyUrl.searchParams.set('sessionName', args.sessionName);
  historyUrl.searchParams.set('limit', String(args.historyLimit));

  const historyRes = await fetch(historyUrl, { headers: authHeader });
  const historyPayload = await expectJson(historyRes);
  const historyPod = historyRes.headers.get(IMCODES_POD_HEADER);
  if (!historyPod) throw new Error(`Missing ${IMCODES_POD_HEADER} on history response`);

  const sendUrl = new URL(`/api/server/${encodeURIComponent(args.serverId)}/session/send`, args.baseUrl);
  const sendRes = await fetch(sendUrl, {
    method: 'POST',
    headers: {
      ...authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sessionName: args.sessionName,
      text: args.sendText,
      commandId: `watch-sticky-${randomUUID()}`,
    }),
  });
  const sendPayload = await expectJson(sendRes);
  const sendPod = sendRes.headers.get(IMCODES_POD_HEADER);
  if (!sendPod) throw new Error(`Missing ${IMCODES_POD_HEADER} on send response`);

  if (historyPod !== sendPod) {
    throw new Error(`Sticky verification failed: history=${historyPod} send=${sendPod}`);
  }

  console.log(JSON.stringify({
    ok: true,
    pod: historyPod,
    serverId: args.serverId,
    sessionName: args.sessionName,
    historyPayload,
    sendPayload,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
