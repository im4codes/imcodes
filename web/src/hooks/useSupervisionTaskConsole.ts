import { useEffect, useMemo, useState } from 'preact/hooks';
import type { SupervisionTaskConsoleScope } from '@shared/supervision-task-console.js';
import type { WsClient } from '../ws-client.js';
import type { SupervisionTaskConsoleSocket } from '../supervision-task-console-controller.js';
import {
  createSupervisionTaskConsoleState,
  type SupervisionTaskConsoleReducerState,
} from '../supervision-task-console-reducer.js';
import {
  readSupervisionTaskConsoleCache,
  type SupervisionTaskConsoleAuthority,
} from '../supervision-task-console-cache.js';
import {
  leaseSupervisionTaskConsoleController,
  peekSharedSupervisionTaskConsoleController,
  type SupervisionTaskConsoleLease,
} from '../supervision-task-console-shared.js';

export function createSupervisionTaskConsoleSocket(ws: WsClient): SupervisionTaskConsoleSocket {
  return {
    send: (message) => ws.send(message),
    onMessage: (handler) => ws.onMessage((message) => handler(message)),
  };
}

export function useSupervisionTaskConsole(input: {
  ws: WsClient | null;
  connected: boolean;
  userId: string;
  serverId: string;
  scope: SupervisionTaskConsoleScope;
}): { state: SupervisionTaskConsoleReducerState; retry: () => void } {
  const scopeKey = `${input.userId}\u0000${input.serverId}\u0000${input.scope.projectName}\u0000${input.scope.coordinatorSessionName}`;
  const authority = useMemo<SupervisionTaskConsoleAuthority>(() => ({
    userId: input.userId,
    serverId: input.serverId,
    projectName: input.scope.projectName,
    coordinatorSessionName: input.scope.coordinatorSessionName,
  }), [scopeKey]);
  const initialState = () => (
    (input.ws ? peekSharedSupervisionTaskConsoleController(input.ws, authority)?.getState() : undefined)
      ?? readSupervisionTaskConsoleCache(authority)
      ?? createSupervisionTaskConsoleState(input.scope)
  );
  const [state, setState] = useState<SupervisionTaskConsoleReducerState>(initialState);
  const [lease, setLease] = useState<SupervisionTaskConsoleLease | null>(null);

  // One controller (hence one daemon subscription) per page and scope, shared
  // with every other view of the scope; see supervision-task-console-shared.ts.
  useEffect(() => {
    if (!input.ws) {
      setLease(null);
      setState(readSupervisionTaskConsoleCache(authority) ?? createSupervisionTaskConsoleState(input.scope));
      return undefined;
    }
    const acquired = leaseSupervisionTaskConsoleController(
      input.ws,
      createSupervisionTaskConsoleSocket(input.ws),
      input.scope,
      authority,
    );
    const unsubscribe = acquired.controller.subscribe(setState);
    setLease(acquired);
    return () => {
      unsubscribe();
      acquired.release();
    };
  }, [input.ws, scopeKey]);

  useEffect(() => {
    lease?.setConnected(input.connected);
  }, [lease, input.connected]);

  return {
    state,
    retry: () => { lease?.controller.retry(); },
  };
}
