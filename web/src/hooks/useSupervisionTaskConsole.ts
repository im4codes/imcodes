import { useEffect, useMemo, useState } from 'preact/hooks';
import type { SupervisionTaskConsoleScope } from '@shared/supervision-task-console.js';
import type { WsClient } from '../ws-client.js';
import {
  SupervisionTaskConsoleController,
  type SupervisionTaskConsoleSocket,
} from '../supervision-task-console-controller.js';
import {
  createSupervisionTaskConsoleState,
  type SupervisionTaskConsoleReducerState,
} from '../supervision-task-console-reducer.js';
import {
  readSupervisionTaskConsoleCache,
  type SupervisionTaskConsoleAuthority,
} from '../supervision-task-console-cache.js';

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
}): SupervisionTaskConsoleReducerState {
  const scopeKey = `${input.userId}\u0000${input.serverId}\u0000${input.scope.projectName}\u0000${input.scope.coordinatorSessionName}`;
  const authority = useMemo<SupervisionTaskConsoleAuthority>(() => ({
    userId: input.userId,
    serverId: input.serverId,
    projectName: input.scope.projectName,
    coordinatorSessionName: input.scope.coordinatorSessionName,
  }), [scopeKey]);
  const controller = useMemo(() => {
    if (!input.ws) return null;
    return new SupervisionTaskConsoleController(
      createSupervisionTaskConsoleSocket(input.ws),
      input.scope,
      authority,
    );
  }, [input.ws, scopeKey]);
  const [state, setState] = useState<SupervisionTaskConsoleReducerState>(() => (
    controller?.getState()
      ?? readSupervisionTaskConsoleCache(authority)
      ?? createSupervisionTaskConsoleState(input.scope)
  ));

  useEffect(() => {
    if (!controller) {
      setState(readSupervisionTaskConsoleCache(authority) ?? createSupervisionTaskConsoleState(input.scope));
      return undefined;
    }
    const unsubscribe = controller.subscribe(setState);
    controller.start();
    controller.setConnected(input.connected);
    return () => {
      unsubscribe();
      controller.stop();
    };
  }, [controller, scopeKey]);

  useEffect(() => {
    controller?.setConnected(input.connected);
  }, [controller, input.connected]);

  return state;
}
