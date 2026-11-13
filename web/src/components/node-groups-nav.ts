import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

export const NodeGroupsNavContext = createContext<(() => void) | undefined>(undefined);

/**
 * Resolve navigation callback for opening Controlled Node Groups management.
 * Explicit prop overrides the app-level NodeGroupsNavContext when provided.
 */
export function useNodeGroupsNav(explicit?: () => void): (() => void) | undefined {
  const fromContext = useContext(NodeGroupsNavContext);
  return explicit ?? fromContext;
}
