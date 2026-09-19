/**
 * The French copy — every string a player can read.
 *
 * This file is the only place French lives. Components import `t` from
 * `src/i18n` and read `t.screen.key`; they never inline a sentence. Anything
 * that needs a number is a `{placeholder}` template filled by `fill()`.
 *
 * Adding another language later: copy this file, translate the values, and
 * point `src/i18n/index.ts` at the new object. No component changes.
 */
import { PROTOCOL_ERRORS, PROTOCOL_INFO } from '../../shared/messages.fr.js';

export const fr = {
  brand: {
    name: 'Devine la chanson',
    description: "Devinez une chanson à partir d'un extrait de 0,1 seconde, joué depuis votre propre bibliothèque.",
  },

  /* ── Words reused everywhere ─────────────────────────────────────── */
  common: {
    back: 'Retour',
    close: 'Fermer',
    retry: 'Réessayer',
    trackOne: 'titre',
    trackMany: 'titres',
    roundOne: 'manche',
    roundMany: 'manches',
    second: 'seconde',
    seconds: 'secondes',
    points: 'pts',
    dash: '—',
  },

  /* ── Home ────────────────────────────────────────────────────────── */
  home: {
    taglineBefore: 'Trouvez le titre à partir d’un extrait de ',
    taglineStrong: '0,1 seconde',
    taglineAfter: ' de votre bibliothèque.',
    modeSoloLabel: 'Solo',
    modeSoloHint: 'Jouer seul',
    modeMultiLabel: 'Multijoueur',
    modeMultiHint: 'Jouer avec des amis',
    quickPlay: 'Partie rapide',
    rounds: 'Manches',
    roundsAria: 'Nombre de manches',
    startQuick: 'Commencer à jouer',
    startRounds: 'Jouer {count} manches',
    bestScore: 'Meilleur score ',
    bestStreak: 'Meilleure série ',
    noMusicTitle: 'Aucune musique trouvée',
    noMusicBody:
      'Ajoutez des fichiers audio dans le dossier ci-dessous (les sous-dossiers comptent aussi), puis relancez l’analyse. Rien ne quitte votre ordinateur.',
    rescan: 'Analyser le dossier',
    serverDownTitle: 'Serveur injoignable',
    serverDownBody:
      'Le jeu lit votre musique via un petit serveur local. Vérifiez qu’il tourne, puis réessayez.',
    nothingToPlayTitle: 'Rien à jouer pour l’instant',
    nothingToPlayBody:
      'Tous les fichiers de votre dossier étaient illisibles, ou le dossier est vide. Ajoutez quelques titres et relancez l’analyse.',
    streakWord: 'Série',
  },

  /* ── Top bar ─────────────────────────────────────────────────────── */
  topbar: {
    loading: 'Chargement…',
    offline: 'Hors ligne',
    scanning: 'Analyse…',
    upToDate: 'Bibliothèque à jour',
    added: '{count} titres ajoutés',
    removed: '{count} titres supprimés',
    rescanTitle: 'Analyser à nouveau le dossier de musique',
  },

  /* ── Round (solo) ────────────────────────────────────────────────── */
  round: {
    hudRound: 'Manche',
    hudScore: 'Score',
    hudStreak: 'Série',
    searchTitle: 'Cherchez un titre',
    searchTitleOrArtist: 'Cherchez le titre ou l’artiste…',
    answerAria: 'Votre réponse',
    playAria: 'Écouter l’extrait',
    audioFailed: 'Lecture impossible — fichier illisible',
    spaceHint: 'Espace',
    listenMore: 'Écouter plus',
    listenMoreAria: 'Écouter plus d’audio, jusqu’à {seconds} secondes',
    giveUp: 'Abandonner',
    giveUpAria: 'Abandonner et afficher la réponse',
    rowListenMore: 'Plus d’extrait',
    rowEmpty: 'Essai à venir',
  },

  /* ── Reveal (solo) ───────────────────────────────────────────────── */
  reveal: {
    correct: 'Trouvé',
    answerWas: 'La réponse était',
    foundAt: 'Trouvé à {seconds} s',
    ranOutAt: 'Tous les extraits écoutés — {seconds} s',
    wrongOne: '{count} mauvais essai',
    wrongMany: '{count} mauvais essais',
    streakBonus: 'Série {streak} · +{percent} % de bonus',
    nextSong: 'Chanson suivante',
    seeResults: 'Voir le résultat',
    playingFrom: 'Lecture depuis {time}',
    pauseAria: 'Mettre la chanson en pause',
    playAria: 'Reprendre la chanson',
    hintPlaying: 'Espace : pause · Entrée : suivant',
    hintPaused: 'Espace : reprendre · Entrée : suivant',
    hintEnded: 'Espace : réécouter · Entrée : suivant',
  },

  /* ── End-of-run ──────────────────────────────────────────────────── */
  results: {
    title: 'Partie terminée',
    guessed: '{solved} chansons trouvées sur {played}',
    correctLabel: 'Réussite',
    bestStreakLabel: 'Meilleure série',
    bestEverLabel: 'Meilleur score',
    personalBest: 'Nouveau record',
    menu: 'Accueil',
    playAgain: 'Rejouer',
    gaveUp: 'abandonné',
  },

  /* ── Multiplayer ─────────────────────────────────────────────────── */
  mp: {
    title: 'Multijoueur',
    subtitle: 'Tout le monde entend le même extrait. Le moins d’audio possible l’emporte.',

    /* Menu */
    yourName: 'Votre nom',
    yourNamePlaceholder: 'Votre nom',
    createTitle: 'Créer une partie',
    joinTitle: 'Rejoindre une partie',
    roundsLabel: 'Manches',
    attemptsLabel: 'Essais',
    roundTimeLabel: 'Temps pour deviner',
    categoryLabel: 'Catégorie',
    roomCodeLabel: 'Code de la partie',
    roomCodePlaceholder: 'CODE',
    create: 'Créer la partie',
    join: 'Rejoindre',
    roundsOption: '{count} manches',
    secondsOption: '{count} s',

    /* Lobby */
    copy: 'Copier',
    copied: 'Copié',
    copyManual: 'Ctrl+C',
    copyTitle: 'Copier le code de la partie',
    you: 'Vous',
    away: 'Absent',
    host: 'Hôte',
    start: 'Lancer la partie',
    leave: 'Quitter la partie',
    waitingHost: 'En attente des autres joueurs. Lancez quand tout le monde est là.',
    waitingPlayer: 'En attente de l’hôte…',
    custom: 'Personnalisé',
    customWithValue: 'Personnalisé · {seconds} s',
    customTimeAria: 'Temps personnalisé, en secondes',
    settingsLocked: 'Les règles sont fixées : la partie a commencé.',
    noRankingYet: 'Le classement apparaîtra après la première manche.',

    /* Attempt modes */
    modeUnlimitedLabel: 'Illimités',
    modeUnlimitedHint: 'Autant d’essais que vous voulez avant d’écouter plus.',
    modePerRevealLabel: 'Un essai par palier',
    modePerRevealHint: 'Une réponse à chaque durée. Une erreur débloque l’extrait suivant.',
    modeSingleLabel: 'Un seul essai',
    modeSingleHint: 'Écoutez autant d’extraits que nécessaire, mais une seule réponse.',

    /* Player statuses */
    statusReady: 'Prêt',
    statusGuessing: 'Cherche…',
    statusFinished: 'Trouvé',
    statusGaveUp: 'Abandonné',
    statusTimeout: 'Temps écoulé',
    statusExhaustedSingle: 'Raté',
    statusExhausted: 'Plus d’essais',
    statusAway: 'Déconnecté',

    /* In-game */
    players: 'Joueurs',
    hudRoom: 'Partie',
    hudRound: 'Manche',
    hudTime: 'Temps',
    hudScore: 'Score',
    preparing: 'Préparation de l’audio…',
    listenMore: 'Écouter plus',
    listenMoreNext: 'Écouter +{seconds} s',
    giveUp: 'Abandonner',
    spentSingle: 'Vous avez déjà utilisé votre unique essai sur ce titre.',
    spentPerReveal: 'Vous avez déjà répondu à ce palier — écoutez plus pour continuer.',
    spentUnlimited: 'Cette proposition est déjà partie.',
    exhaustedSingle: 'Plus d’essais — c’était votre unique proposition',
    exhaustedLast: 'Plus d’essais au dernier palier',
    correctWaiting: 'Trouvé — en attente des autres…',
    tooLate: 'Trop tard : la manche est terminée.',

    /* Leadboard */
    standings: 'Classement',
    standingsYou: '{rank} · {score}',
    standingsToggle: 'Afficher le classement complet',
    standingsCollapse: 'Masquer le classement',

    /* Round results overlay */
    roundKicker: 'Manche {round}',
    foundIt: 'Vous l’avez trouvée',
    answerWas: 'La réponse était',
    ready: 'Prêt',
    seeResults: 'Voir le classement',
    readyCount: '{ready}/{total}',
    nextRoundIn: 'Manche suivante dans {seconds}…',
    finalResultsIn: 'Classement final dans {seconds}…',

    /* Final board */
    gameOver: 'Partie terminée',
    wins: '{name} remporte la partie',
    hitsOne: '{count} titre trouvé',
    hitsMany: '{count} titres trouvés',
    backToLobby: 'Retour au salon',
    leaveTitle: 'Quitter la partie',
    rules: '{rounds} · {mode} · {seconds} s',

    /* Connection */
    connectFailed: 'Impossible de joindre le serveur de jeu.',
    connectionLost: 'Connexion perdue — tentative de reconnexion…',
    codeTooShort: 'Un code de partie compte 5 caractères.',
    nameFirst: "Choisissez d'abord un nom.",
  },

  /* ── Protocol errors (shared with the server) ────────────────────── */
  proto: {
    errors: PROTOCOL_ERRORS as Record<string, string>,
    info: PROTOCOL_INFO as Record<string, string>,
  },
} as const;

export type FrDictionary = typeof fr;
