import type { ContextMemoryView } from '../../../shared/context-types.js';
import { searchSemanticMemoryView, type SemanticMemoryViewInput } from './semantic-memory-view.js';

export async function vectorSearch(input: SemanticMemoryViewInput): Promise<ContextMemoryView | null> {
  return searchSemanticMemoryView(input);
}
