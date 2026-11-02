/** Compare CSS values, not CSSOM serialization order (which differs across jsdom versions). */
export function inlineStyleValues(element: HTMLElement): Record<string, string> {
  return Object.fromEntries(Array.from(element.style, (property) => [
    property, element.style.getPropertyValue(property),
  ]));
}
