import { useEffect, useMemo, useState } from 'preact/hooks';
import type { SupervisionTaskConsoleScope } from '@shared/supervision-task-console.js';
import type { WsClient } from '../ws-client.js';
import {
  SupervisionTaskConsoleController,
  type SupervisionTaskConsoleSocket,
} from '../supervision-task-console-controller.js';
import type { SupervisionTaskConsoleReducerState } from '../supervision-task-console-reducer.js';

export function createSupervisionTaskConsoleSocket(ws: WsClient): SupervisionTaskConsoleSocket {
  return {
    send: (message) => ws.send(message),
    onMessage: (handler) => ws.onMessage((message) => handler(message)),
  };
}

export function useSupervisionTaskConsole(input: {
  ws: WsClient | null;
  connected: boolean;
  scope: SupervisionTaskConsoleScope;
}): SupervisionTaskConsoleReducerState {
  const scopeKey = `${input.scope.projectName}\u0000${input.scope.coordinatorSessionName}`;
  const controller = useMemo(() => {
    if (!input.ws) return null;
    return new SupervisionTaskConsoleController(
      createSupervisionTaskConsoleSocket(input.ws),
      input.scope,
    );
  }, [input.ws, scopeKey]);
  const [state, setState] = useState<SupervisionTaskConsoleReducerState>(() => (
    controller?.getState() ?? new SupervisionTaskConsoleController({ send: () => {}, onMessage: () => () => {} }, input.scope).getState()
  ));

  useEffect(() => {
    if (!controller) {
      const inert = new SupervisionTaskConsoleController({ send: () => {}, onMessage: () => () => {} }, input.scope);
      setState(inert.getState());
      return undefined;
    }
    const unsubscribe = controller.subscribe(setState);
    controller.start();
    controller.setConnected(input.connected);
    return () => {
      unsubscribe();
      controller.stop();
    };
  }, [controller]);

  useEffect(() => {
    controller?.setConnected(input.connected);
  }, [controller, input.connected]);

  return state;
}
