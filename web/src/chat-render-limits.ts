export const RICH_TEXT_ENHANCEMENT_CHAR_LIMIT = 20_000;
export const CHAT_INITIAL_RENDER_ITEM_LIMIT = 250;
export const CHAT_RENDER_ITEM_INCREMENT = 250;

export function shouldSkipRichTextEnhancement(text: string): boolean {
  return text.length > RICH_TEXT_ENHANCEMENT_CHAR_LIMIT;
}
