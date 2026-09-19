/**
 * The library as the client sees it: tracks, a search index, and a live
 * subscription so songs added to the folder while the game is open show up on
 * their own.
 */
import { buildMatchIndex, normalizeAnswer, searchTracks } from './matching';
import type { MatchIndex, Suggestion } from './matching';
import { gameConfig } from './types';
import type { CategoryTab, LibraryPayload, ScanStats, Track } from './types';

export class Library {
  tracks: Track[] = [];
  libraryPath = '';
  scan: ScanStats | null = null;
  /** "Toutes" plus one tab per music folder that actually exists. */
  categories: CategoryTab[] = [{ name: 'Toutes', value: 'all', count: 0 }];
  loading = true;
  error: string | null = null;

  private index: MatchIndex[] = [];
  private listeners = new Set<() => void>();
  private events: EventSource | null = null;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  get size(): number {
    return this.tracks.length;
  }

  async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.notify();
    try {
      await this.apply(await fetchJson<LibraryPayload>('/api/library'));
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not reach the local server.';
    } finally {
      this.loading = false;
      this.notify();
    }
    if (!this.error) this.connect();
  }

  /** Rescan the folder on disk. Cheap: unchanged files are not re-read. */
  async refresh(force = false): Promise<ScanStats | null> {
    try {
      const payload = await fetchJson<LibraryPayload & ScanStats>(`/api/library/refresh${force ? '?full=1' : ''}`, {
        method: 'POST',
      });
      await this.apply(payload);
      return this.scan;
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Rescan failed.';
      this.notify();
      return null;
    }
  }

  private async apply(payload: LibraryPayload): Promise<void> {
    this.tracks = payload.tracks ?? [];
    this.libraryPath = payload.libraryPath ?? '';
    this.scan = payload.scan ?? null;
    this.index = buildMatchIndex(this.tracks, gameConfig.matching.ignoreBracketedSuffixes);
    void this.loadCategories();
    this.notify();
  }

  /** Category tabs, derived server-side from the folders that hold music. */
  private async loadCategories(): Promise<void> {
    try {
      const payload = await fetchJson<{ categories: CategoryTab[] }>('/api/categories');
      if (!Array.isArray(payload.categories) || payload.categories.length === 0) return;
      // Only re-render when the tabs actually changed: a needless notify here
      // would repaint the top bar over a message the UI is still showing.
      const changed = JSON.stringify(payload.categories) !== JSON.stringify(this.categories);
      this.categories = payload.categories;
      if (changed) this.notify();
    } catch {
      /* the "Toutes" tab always works, even if this call fails */
    }
  }

  /** Tracks belonging to a category value ('all' or a top-level folder). */
  tracksIn(category: string): Track[] {
    const playable = this.playable();
    if (!category || category === 'all') return playable;
    return playable.filter((track) => {
      const folder = track.folder ? track.folder.split(/[\\/]/)[0] : '';
      return folder === category;
    });
  }

  private connect(): void {
    if (this.events || typeof EventSource === 'undefined') return;
    this.events = new EventSource('/api/events');
    this.events.addEventListener('library', (event) => {
      try {
        this.apply(JSON.parse((event as MessageEvent).data));
      } catch {
        /* malformed event — keep the current library */
      }
    });
    // A dropped connection is normal (server restart); EventSource retries.
    this.events.addEventListener('error', () => {});
  }

  get matchIndex(): MatchIndex[] {
    return this.index;
  }

  /** Playable tracks: anything we could actually read. */
  playable(): Track[] {
    return this.tracks.filter((track) => !track.unreadable);
  }

  search(query: string, limit = gameConfig.ui.autocompleteLimit): Suggestion[] {
    return searchTracks(query, this.index, limit);
  }

  /** Same normalisation the matcher uses — for comparing typed text to titles. */
  normalize(value: string): string {
    return normalizeAnswer(value, gameConfig.matching.ignoreBracketedSuffixes);
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  // `response.statusText` is an English protocol phrase and would surface in
  // the interface; the status number is the part that is actually useful.
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

export const library = new Library();
