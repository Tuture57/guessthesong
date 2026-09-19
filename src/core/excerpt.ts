/**
 * Choosing where inside a track the excerpt starts.
 *
 * The implementation lives in `shared/excerpt.js` because the Node server
 * needs the exact same rule to be authoritative for multiplayer rounds: all
 * players in a room must hear the same frozen position. This module is the
 * client's door to it.
 */
export { pickExcerptStart, excerptEnd } from '../../shared/excerpt.js';
