/**
 * French copy for the one thing both sides of the wire must agree on: the
 * error messages the multiplayer server sends back.
 *
 * Plain data, no imports, so the Node server and the browser client can both
 * read it. The server composes the text it sends; the client uses the same
 * catalogue to render an error from its code alone. Neither can drift.
 *
 * `{name}` placeholders are filled by `fill()`.
 */
export const PROTOCOL_ERRORS = {
  'name-required': "Choisissez d'abord un nom.",
  'room-not-found': 'Aucune partie ne porte le code {code}.',
  'in-progress':
    "Cette partie a déjà commencé. Demandez à l'hôte de la terminer, puis créez-en une nouvelle.",
  full: 'La partie {code} est complète ({max} joueurs).',
  'duplicate-name': 'Quelqu’un dans la partie {code} s’appelle déjà « {name} ». Choisissez un autre nom.',
  'no-room': "Rejoignez d'abord une partie.",
  'empty-library': 'Aucun titre ne correspond à cette catégorie.',
  'rate-limited': 'Doucement… patientez un instant avant de réessayer.',
  'server-restart': 'Le serveur a redémarré : la partie est fermée.',
  unknown: 'Une erreur est survenue.',
};

export const PROTOCOL_INFO = {
  replaced: 'Cette partie a été ouverte dans un autre onglet ; cet onglet-ci s’efface.',
};

/** Replace `{key}` placeholders. Unknown keys are left alone rather than blanked. */
export function fill(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
  );
}

/** The text for one error code, with its parameters filled in. */
export function messageFor(code, params) {
  return fill(PROTOCOL_ERRORS[code] ?? PROTOCOL_ERRORS.unknown, params);
}
