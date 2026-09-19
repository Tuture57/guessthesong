/**
 * `npm run scan` — index the library and print what the game will see.
 * Handy for checking how messy filenames got normalised.
 */
import { getLibraryPath, scan, stopWatcher } from './library.js';

const force = process.argv.includes('--force');
const tracks = await scan({ force });

console.log(`\n${getLibraryPath()}\n`);
console.log(
  `${String(tracks.total).padStart(4)} tracks   ${tracks.addedOnly} new · ${tracks.updated} updated · ${tracks.removed} removed · ${tracks.reused} cached   (${tracks.durationMs} ms, force=${force})\n`,
);

const { getTracks } = await import('./library.js');
const rows = getTracks().sort((a, b) => a.title.localeCompare(b.title, 'fr'));

for (const track of rows) {
  const duration = track.duration ? `${Math.floor(track.duration / 60)}:${String(Math.floor(track.duration % 60)).padStart(2, '0')}` : '?:??';
  const flags = [track.hasCover ? 'cover' : '     ', track.unreadable ? 'UNREADABLE' : ''].filter(Boolean).join(' ');
  console.log(`${track.title.padEnd(42).slice(0, 42)}  ${(track.artist || '—').padEnd(16).slice(0, 16)}  ${duration.padStart(5)}  ${flags}`);
}

const missingArtist = rows.filter((track) => !track.artist).length;
const missingDuration = rows.filter((track) => !track.duration).length;
console.log(`\nno artist: ${missingArtist}   no duration: ${missingDuration}\n`);

stopWatcher();
