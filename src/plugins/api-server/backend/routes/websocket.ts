import { createRoute, z } from '@hono/zod-openapi';

import { type NodeWebSocket } from '@hono/node-ws';

import {
  registerCallback,
  type SongInfo,
  SongInfoEvent,
} from '@/providers/song-info';

import { API_VERSION } from '../api-version';

import type { WSContext } from 'hono/ws';
import type { Context, Next } from 'hono';
import type { RepeatMode, VolumeState } from '@/types/datahost-get-state';
import type { HonoApp } from '../types';
import type { BackendContext } from '@/types/contexts';
import type { APIServerConfig } from '@/plugins/api-server/config';

enum DataTypes {
  PlayerInfo = 'PLAYER_INFO',
  VideoChanged = 'VIDEO_CHANGED',
  PlayerStateChanged = 'PLAYER_STATE_CHANGED',
  PositionChanged = 'POSITION_CHANGED',
  VolumeChanged = 'VOLUME_CHANGED',
  RepeatChanged = 'REPEAT_CHANGED',
  ShuffleChanged = 'SHUFFLE_CHANGED',
  LyricsChanged = 'LYRICS_CHANGED',
}

type PlayerState = {
  song?: SongInfo;
  isPlaying: boolean;
  muted: boolean;
  position: number;
  volume: number;
  repeat: RepeatMode;
  shuffle: boolean;
};

export const register = (
  app: HonoApp,
  backendCtx: BackendContext<APIServerConfig>,
  { upgradeWebSocket }: NodeWebSocket,
) => {
  const { ipc, window } = backendCtx;
  let volumeState: VolumeState | undefined = undefined;
  let repeat: RepeatMode = 'NONE';
  let shuffle = false;
  let lastSongInfo: SongInfo | undefined = undefined;
  let lastLyrics: any | undefined = undefined;

  const sockets = new Set<WSContext<WebSocket>>();

  const send = (type: DataTypes, state: Partial<PlayerState>) => {
    sockets.forEach((socket) =>
      socket.send(JSON.stringify({ type, ...state })),
    );
  };

  const currentLyricRoute = createRoute({
    method: 'get',
    path: `/api/${API_VERSION}/lyrics/current`,
    summary: 'get current lyric',
    description: 'Get the current active lyric line',
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: z.object({
              available: z.boolean(),
              lyric: z.any().nullable(),
            }),
          },
        },
      },
    },
  });

  const createPlayerState = ({
    songInfo,
    volumeState,
    repeat,
    shuffle,
  }: {
    songInfo?: SongInfo;
    volumeState?: VolumeState;
    repeat: RepeatMode;
    shuffle: boolean;
  }): PlayerState => ({
    song: songInfo,
    isPlaying: songInfo ? !songInfo.isPaused : false,
    muted: volumeState?.isMuted ?? false,
    position: songInfo?.elapsedSeconds ?? 0,
    volume: volumeState?.state ?? 100,
    repeat,
    shuffle,
  });

  // HTTP route for current lyric
  app.openapi(currentLyricRoute, async (ctx) => {
    try {
      const script = `(() => {
            const el = document.querySelector('.synced-line.current');
            if (!el) return null;
            const textEl = el.querySelector('.text-lyrics');
            const romajiEl = el.querySelector('.romaji');
            return {
              index: null,
              text: textEl ? textEl.innerText.trim() : '',
              romanized: romajiEl ? romajiEl.innerText.trim() : null,
              timestamp: Date.now()
            };
          })();`;

      // execute in renderer
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const res = await window.webContents.executeJavaScript(script, true);
      if (res) {
        lastLyrics = {
          index: res.index,
          text: res.text,
          timeInMs: 0,
          duration: 0,
          isSynced: false,
          song: lastSongInfo
            ? {
              title: lastSongInfo.title,
              artists: lastSongInfo.artist
                ? lastSongInfo.artist.split(/[&,]/).map((s) => s.trim())
                : [],
              videoId: lastSongInfo.videoId,
            }
            : undefined,
          timestamp: res.timestamp,
          provider: null,
          romanized: res.romanized ?? null,
        };
      }
    } catch (e) {
      // ignore
    }

    ctx.status(200);
    return ctx.json({ available: !!lastLyrics, lyric: lastLyrics ?? null });
  });

  registerCallback((songInfo, event) => {
    if (event === SongInfoEvent.VideoSrcChanged) {
      lastLyrics = undefined;
      send(DataTypes.VideoChanged, { song: songInfo, position: 0 });
    }

    if (event === SongInfoEvent.PlayOrPaused) {
      send(DataTypes.PlayerStateChanged, {
        isPlaying: !(songInfo?.isPaused ?? true),
        position: songInfo.elapsedSeconds,
      });
    }

    if (event === SongInfoEvent.TimeChanged) {
      send(DataTypes.PositionChanged, { position: songInfo.elapsedSeconds });
    }

    lastSongInfo = { ...songInfo };
  });

  // listen for lyric updates from the synced-lyrics plugin
  const normalizeLyric = (payload: any, song?: SongInfo) => {
    try {
      const idx = Number(payload?.index ?? -1);
      const line = payload?.line ?? null;

      const text = line?.text ?? line?.lyrics ?? line?.text ?? '';
      const timeInMs = Number(line?.timeInMs ?? line?.time ?? NaN) ?? NaN;
      const duration = Number(line?.duration ?? 0) ?? 0;

      const normalized = {
        index: idx >= 0 ? idx : null,
        text: String(text ?? ''),
        timeInMs: Number(isNaN(timeInMs) ? 0 : timeInMs),
        duration: Number(isNaN(duration) ? 0 : duration),
        isSynced: typeof line?.timeInMs === 'number' || typeof line?.time === 'string',
        song: song
          ? { title: song.title, artists: song.artist ? song.artist.split(/[&,]/).map((s) => s.trim()) : [], videoId: song.videoId }
          : undefined,
        timestamp: Number(payload?.timestamp ?? Date.now()),
        provider: payload?.provider ?? null,
        romanized: payload?.romanized ?? null,
      };

      return normalized;
    } catch (e) {
      return null;
    }
  };

  ipc.on('synced-lyrics:current', (payload: any) => {
    try {
      // eslint-disable-next-line no-console
      console.debug('api-server:received-synced-lyrics', {
        provider: payload?.provider ?? null,
        romanized: payload?.romanized ?? null,
        idx: payload?.index ?? null,
      });
    } catch (e) {
      // ignore
    }
    const normalized = normalizeLyric(payload, lastSongInfo ?? undefined);
    if (!normalized) return;

    lastLyrics = normalized;
    sockets.forEach((socket) =>
      socket.send(JSON.stringify({ type: DataTypes.LyricsChanged, lyric: normalized })),
    );
  });

  ipc.on('peard:volume-changed', (newVolumeState: VolumeState) => {
    volumeState = newVolumeState;
    send(DataTypes.VolumeChanged, {
      volume: volumeState.state,
      muted: volumeState.isMuted,
    });
  });

  ipc.on('peard:repeat-changed', (mode: RepeatMode) => {
    repeat = mode;
    send(DataTypes.RepeatChanged, { repeat });
  });

  ipc.on('peard:seeked', (t: number) => {
    send(DataTypes.PositionChanged, { position: t });
  });

  ipc.on('peard:shuffle-changed', (newShuffle: boolean) => {
    shuffle = newShuffle;
    send(DataTypes.ShuffleChanged, { shuffle });
  });

  app.openapi(
    createRoute({
      method: 'get',
      path: `/api/${API_VERSION}/ws`,
      summary: 'websocket endpoint',
      description: 'WebSocket endpoint for real-time updates',
      responses: {
        101: {
          description: 'Switching Protocols',
        },
      },
    }),
    upgradeWebSocket(() => ({
      async onOpen(_, ws) {
        // "Unsafe argument of type `WSContext<WebSocket>` assigned to a parameter of type `WSContext<WebSocket>`. (@typescript-eslint/no-unsafe-argument)" ????? what?

        sockets.add(ws as WSContext<WebSocket>);

        ws.send(
          JSON.stringify({
            type: DataTypes.PlayerInfo,
            ...createPlayerState({
              songInfo: lastSongInfo,
              volumeState,
              repeat,
              shuffle,
            }),
          }),
        );
        if (lastLyrics) {
          ws.send(JSON.stringify({
            type: DataTypes.LyricsChanged,
            lyric: lastLyrics,
          }));
        } else {
          ws.send(JSON.stringify({
            type: 'LYRICS_UNAVAILABLE',
          }));
        }
      },

      onClose(_, ws) {
        sockets.delete(ws as WSContext<WebSocket>);
      },
    })) as (ctx: Context, next: Next) => Promise<Response>,
  );
};
