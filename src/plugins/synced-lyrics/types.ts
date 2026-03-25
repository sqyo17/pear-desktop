import type { SongInfo } from '@/providers/song-info';
import type { ProviderName } from './providers';

export type OriginalSongMapping = {
  artist: string;
  title?: string;
};

export type SyncedLyricsPluginConfig = {
  enabled: boolean;
  preferredProvider?: ProviderName;
  preciseTiming: boolean;
  showTimeCodes: boolean;
  defaultTextString: string | string[];
  showLyricsEvenIfInexact: boolean;
  lineEffect: LineEffect;
  romanization: boolean;
  /** Map cover song videoId to original song info for lyrics lookup */
  originalSongMapping: Record<string, OriginalSongMapping>;
  /** URL to fetch shared lyrics mappings from (remote JSON) */
  mappingUrl?: string;
  /** How often to refresh remote mappings (in seconds, 0 = disable) */
  mappingUrlRefreshInterval?: number;
};

export type LineLyricsStatus = 'previous' | 'current' | 'upcoming';

export type LineLyrics = {
  time: string;
  timeInMs: number;
  duration: number;

  text: string;
  status: LineLyricsStatus;
};

export type LineEffect = 'fancy' | 'scale' | 'offset' | 'focus';

export interface LyricResult {
  title: string;
  artists: string[];

  lyrics?: string;
  lines?: LineLyrics[];
}

// prettier-ignore
export type SearchSongInfo = Pick<SongInfo, 'title' | 'alternativeTitle' | 'artist' | 'album' | 'songDuration' | 'videoId' | 'tags'>;

export interface LyricProvider {
  name: string;
  baseUrl: string;

  search(songInfo: SearchSongInfo): Promise<LyricResult | null>;
}
