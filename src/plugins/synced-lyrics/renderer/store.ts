import { createStore } from 'solid-js/store';
import { createMemo } from 'solid-js';

import { getSongInfo } from '@/providers/song-info-front';

import {
  type ProviderName,
  providerNames,
  type ProviderState,
} from '../providers';
import { providers } from '../providers/renderer';

import type { LyricProvider, OriginalSongMapping } from '../types';
import type { SongInfo } from '@/providers/song-info';
import { config } from './renderer';
import type { SyncedLyricsPluginConfig } from '../types';

type LyricsStore = {
  provider: ProviderName;
  current: ProviderState;
  lyrics: Record<ProviderName, ProviderState>;
};

const initialData = () =>
  providerNames.reduce(
    (acc, name) => {
      acc[name] = { state: 'fetching', data: null, error: null };
      return acc;
    },
    {} as LyricsStore['lyrics'],
  );

export const [lyricsStore, setLyricsStore] = createStore<LyricsStore>({
  provider: providerNames[0],
  lyrics: initialData(),
  get current(): ProviderState {
    return this.lyrics[this.provider];
  },
});

export const currentLyrics = createMemo(() => {
  const provider = lyricsStore.provider;
  return lyricsStore.lyrics[provider];
});

type VideoId = string;

type SearchCacheData = Record<ProviderName, ProviderState>;
interface SearchCache {
  state: 'loading' | 'done';
  data: SearchCacheData;
}

// TODO: Maybe use localStorage for the cache.
const searchCache = new Map<VideoId, SearchCache>();

/** Remote mappings cache (merged from URL) */
let remoteMappings: Record<string, OriginalSongMapping> = {};
/** Interval ID for auto-refresh */
let refreshIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Fetch remote mappings from the configured URL
 */
export const fetchRemoteMappings = async (): Promise<void> => {
  const cfg = config();
  const url = cfg?.mappingUrl;
  if (!url) return;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`[synced-lyrics] Failed to fetch remote mappings: ${response.status}`);
      return;
    }

    const data = await response.json();

    // Validate that data is an object with string keys
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      console.warn('[synced-lyrics] Invalid remote mappings format');
      return;
    }

    remoteMappings = data as Record<string, OriginalSongMapping>;
    console.log(`[synced-lyrics] Loaded ${Object.keys(remoteMappings).length} remote mappings`);
  } catch (error) {
    console.error('[synced-lyrics] Error fetching remote mappings:', error);
  }
};

/**
 * Start auto-refresh of remote mappings
 */
export const startRemoteMappingRefresh = (): void => {
  const cfg = config();
  const interval = cfg?.mappingUrlRefreshInterval;
  const url = cfg?.mappingUrl;

  // Clear existing interval
  if (refreshIntervalId) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }

  // Don't start if no URL or interval is 0/disabled
  if (!url || !interval || interval <= 0) {
    return;
  }

  // Initial fetch
  fetchRemoteMappings();

  // Set up interval
  refreshIntervalId = setInterval(() => {
    fetchRemoteMappings();
  }, interval * 1000);
};

/**
 * Stop auto-refresh of remote mappings
 */
export const stopRemoteMappingRefresh = (): void => {
  if (refreshIntervalId) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }
};

/**
 * Get all mappings (remote + local, local takes precedence)
 */
const getAllMappings = (): Record<string, OriginalSongMapping> => {
  const localMappings = config()?.originalSongMapping || {};
  return { ...remoteMappings, ...localMappings };
};

/**
 * Apply original song mapping if configured.
 * Returns a modified SearchSongInfo with original artist/title for cover songs.
 */
const applyMapping = (info: SongInfo): SongInfo => {
  const allMappings = getAllMappings();
  const mapping = allMappings[info.videoId];
  if (!mapping) return info;

  return {
    ...info,
    artist: mapping.artist,
    ...(mapping.title && { title: mapping.title }),
  };
};

export const fetchLyrics = (info: SongInfo) => {
  // Apply mapping for cover songs before searching
  const searchInfo = applyMapping(info);
  if (searchCache.has(info.videoId)) {
    const cache = searchCache.get(info.videoId)!;

    if (cache.state === 'loading') {
      setTimeout(() => {
        fetchLyrics(info);
      });
      return;
    }

    if (getSongInfo().videoId === info.videoId) {
      setLyricsStore('lyrics', () => {
        // weird bug with solid-js
        return JSON.parse(JSON.stringify(cache.data)) as typeof cache.data;
      });
    }

    return;
  }

  const cache: SearchCache = {
    state: 'loading',
    data: initialData(),
  };

  searchCache.set(info.videoId, cache);
  if (getSongInfo().videoId === info.videoId) {
    setLyricsStore('lyrics', () => {
      // weird bug with solid-js
      return JSON.parse(JSON.stringify(cache.data)) as typeof cache.data;
    });
  }

  const tasks: Promise<void>[] = [];

  // prettier-ignore
  for (
    const [providerName, provider] of Object.entries(providers) as [
    ProviderName,
    LyricProvider,
  ][]
    ) {
    const pCache = cache.data[providerName];

    tasks.push(
      provider
        .search(searchInfo)
        .then((res) => {
          pCache.state = 'done';
          pCache.data = res;

          if (getSongInfo().videoId === info.videoId) {
            setLyricsStore('lyrics', (old) => {
              return {
                ...old,
                [providerName]: {
                  state: 'done',
                  data: res ? { ...res } : null,
                  error: null,
                },
              };
            });
          }
        })
        .catch((error: Error) => {
          pCache.state = 'error';
          pCache.error = error;

          console.error(error);

          if (getSongInfo().videoId === info.videoId) {
            setLyricsStore('lyrics', (old) => {
              return {
                ...old,
                [providerName]: { state: 'error', error, data: null },
              };
            });
          }
        }),
    );
  }

  Promise.allSettled(tasks).then(() => {
    cache.state = 'done';
    searchCache.set(info.videoId, cache);
  });
};

export const retrySearch = (provider: ProviderName, info: SongInfo) => {
  setLyricsStore('lyrics', (old) => {
    const pCache = {
      state: 'fetching',
      data: null,
      error: null,
    };

    return {
      ...old,
      [provider]: pCache,
    };
  });

  const searchInfo = applyMapping(info);

  providers[provider]
    .search(searchInfo)
    .then((res) => {
      setLyricsStore('lyrics', (old) => {
        return {
          ...old,
          [provider]: { state: 'done', data: res, error: null },
        };
      });
    })
    .catch((error) => {
      setLyricsStore('lyrics', (old) => {
        return {
          ...old,
          [provider]: { state: 'error', data: null, error },
        };
      });
    });
};
