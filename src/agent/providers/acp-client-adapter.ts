import {
  client,
  methods,
  RequestError,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type Stream,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk/unstable';

export interface AcpClientHandlers {
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  sessionUpdate(params: SessionNotification): Promise<void>;
  extNotification?(method: string, params: Record<string, unknown>): Promise<void>;
  extMethod?(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
}

export interface AcpWriteTracker {
  writeQueue?: Promise<void>;
  abortController?: { signal?: AbortSignal };
}

export interface AcpSetSessionModelRequest {
  sessionId: string;
  modelId: string;
  _meta?: Record<string, unknown> | null;
}

/** Thin client-side ACP v1 connection facade backed by `@agentclientprotocol/sdk/unstable` App API. */
export interface AcpClientConnection {
  readonly closed?: Promise<void>;
  readonly signal?: AbortSignal;
  readonly connection?: AcpWriteTracker;
  initialize(params: InitializeRequest): Promise<InitializeResponse>;
  authenticate?(params: AuthenticateRequest): Promise<AuthenticateResponse | void>;
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
  loadSession?(params: LoadSessionRequest): Promise<LoadSessionResponse | void>;
  resumeSession?(params: ResumeSessionRequest): Promise<ResumeSessionResponse>;
  listSessions?(params?: ListSessionsRequest): Promise<ListSessionsResponse>;
  closeSession?(params: CloseSessionRequest): Promise<CloseSessionResponse | void>;
  setSessionMode?(params: SetSessionModeRequest): Promise<SetSessionModeResponse | void>;
  setSessionConfigOption?(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse>;
  unstable_setSessionModel?(params: AcpSetSessionModelRequest): Promise<Record<string, unknown> | void>;
  prompt(params: PromptRequest & { messageId?: string | null }): Promise<PromptResponse>;
  cancel(params: CancelNotification): Promise<void>;
  extMethod?(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  extNotification?(method: string, params: Record<string, unknown>): Promise<void>;
  close?(error?: unknown): void;
}

const UNSTABLE_SET_MODEL_METHOD = 'session/set_model';

function asParamsRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
}

/** Create an ACP client connection over a bidirectional JSON-RPC `Stream`. */
export function createAcpClientConnection(
  handlers: AcpClientHandlers,
  stream: Stream,
): AcpClientConnection {
  let fallbackWriteQueue = Promise.resolve();
  const rawWriter = stream.writable.getWriter();
  const trackedStream: Stream = {
    readable: stream.readable,
    writable: new WritableStream({
      write(message) {
        const next = fallbackWriteQueue.then(() => rawWriter.write(message));
        fallbackWriteQueue = next.catch(() => {});
        return next;
      },
      close: () => rawWriter.close(),
      abort: (reason) => rawWriter.abort(reason),
    }),
  };

  const app = client()
    .onRequest(methods.client.session.requestPermission, ({ params }) => handlers.requestPermission(params))
    .onRequest(methods.client.fs.readTextFile, ({ params }) => handlers.readTextFile(params))
    .onRequest(methods.client.fs.writeTextFile, ({ params }) => handlers.writeTextFile(params))
    .onNotification(methods.client.session.update, ({ params }) => handlers.sessionUpdate(params))
    .onNotification('*', ({ method, params }) => handlers.extNotification?.(method, asParamsRecord(params)))
    .onRequest('*', ({ method, params }) => {
      if (handlers.extMethod) {
        return handlers.extMethod(method, asParamsRecord(params));
      }
      throw RequestError.methodNotFound(method);
    });

  const handle = app.connect(trackedStream);
  const rawConn = (handle as unknown as { connection?: AcpWriteTracker }).connection;
  const writeTracker: AcpWriteTracker = rawConn?.writeQueue
    ? rawConn
    : {
        get writeQueue() {
          return fallbackWriteQueue;
        },
        abortController: { signal: handle.signal },
      };

  return {
    closed: handle.closed,
    signal: handle.signal,
    connection: writeTracker,
    initialize: (params) => handle.agent.request(methods.agent.initialize, params),
    authenticate: (params) => handle.agent.request(methods.agent.authenticate, params),
    newSession: (params) => handle.agent.request(methods.agent.session.new, params),
    loadSession: (params) => handle.agent.request(methods.agent.session.load, params),
    resumeSession: (params) => handle.agent.request(methods.agent.session.resume, params),
    listSessions: (params) => handle.agent.request(methods.agent.session.list, params ?? {}),
    closeSession: (params) => handle.agent.request(methods.agent.session.close, params),
    setSessionMode: (params) => handle.agent.request(methods.agent.session.setMode, params),
    setSessionConfigOption: (params) => handle.agent.request(methods.agent.session.setConfigOption, params),
    unstable_setSessionModel: (params) => handle.agent.request(UNSTABLE_SET_MODEL_METHOD, params),
    prompt: (params) => handle.agent.request(methods.agent.session.prompt, params),
    cancel: (params) => handle.agent.notify(methods.agent.session.cancel, params),
    extMethod: (method, params) => handle.agent.request<Record<string, unknown>>(method, params),
    extNotification: (method, params) => handle.agent.notify(method, params),
    close: (error) => handle.close(error),
  };
}
