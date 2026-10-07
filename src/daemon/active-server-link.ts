/**
 * The daemon's live server link, for code that closes or changes sessions outside a command handler (pair session cleanup, recycling):
 * `stopSubSession(name, link)` tells the server and browsers `subsession.closed` only when it is given the link.
 */
export interface ActiveServerLink { send(msg: object): void }

let active: ActiveServerLink | null = null;

export function setActiveServerLink(link: ActiveServerLink | null): void { active = link; }
export function getActiveServerLink(): ActiveServerLink | null { return active; }
