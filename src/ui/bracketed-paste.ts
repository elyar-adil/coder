import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

const MARKER_START = '\x1b[200~';
const MARKER_END = '\x1b[201~';

/** Sequences that switch the terminal's bracketed paste mode on and off. */
export const BRACKETED_PASTE_ENABLE = '\x1b[?2004h';
export const BRACKETED_PASTE_DISABLE = '\x1b[?2004l';

/**
 * Terminals without bracketed-paste support cannot label a paste, but a real
 * keyboard's Enter arrives as a lone `\r`, while `\n` only ever shows up in
 * pasted text (browsers paste CRLF; LF-mode terminals paste LF). So a lone
 * break stays a typed Enter and any larger chunk carrying `\n` is paste.
 */

/** Browsers paste CRLF; stray CRs would otherwise be typed into the draft. */
const CRLF = /\r\n/g;
const CR = /\r/g;

export type PasteFilterOptions = {
  /** Idle time after which a held partial marker flushes as plain text. */
  holdFlushMs?: number;
};

export type PasteAwareInput = NodeJS.ReadableStream & {
  /** True while the keypress events currently being decoded belong to a paste. */
  pasteActive: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
  destroy?: (error?: Error) => void;
};

/** The concrete stream handed to blessed: readable and writable on purpose, since PassThrough is both. */
export type PasteAwarePassThrough = PassThrough & PasteAwareInput;

/** Longest suffix of `text` that is a proper prefix of `marker`. */
const trailingMarkerPrefix = (text: string, marker: string): number => {
  for (let length = Math.min(text.length, marker.length - 1); length > 0; length--) {
    if (marker.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
};

/**
 * Blessed 0.1.x decodes input byte-by-byte, so every line break inside a
 * pasted chunk arrives as an individual Enter keypress and submits a
 * half-typed draft. This wrapper enables the terminal's bracketed paste mode
 * and reassembles `\x1b[200~ ... \x1b[201~` chunks so the TUI can treat the
 * whole paste as literal content. Terminals without bracketed-paste support
 * (Apple Terminal, some tmux/screen setups) get a fallback: chunks with line
 * breaks are recognised as paste content and inserted literally, while a lone
 * break remains a typed Enter that submits instantly.
 *
 * The real input stream is only proxied: blessed keeps talking to the
 * returned stream (`pause`, `resume`, `setRawMode`, destroyed checks), so the
 * screen lifecycle still restores the underlying terminal on exit.
 */
export function enableBracketedPaste(
  rawInput: NodeJS.ReadableStream,
  options: PasteFilterOptions = {},
): PasteAwarePassThrough {
  const holdFlushMs = options.holdFlushMs ?? 40;
  const real = rawInput as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void; isRaw?: boolean };
  const filtered = new PassThrough();
  const decoder = new StringDecoder('utf8');
  // Blessed only restores cooked mode when it believes raw mode is on, so the
  // proxy must mirror the real stream's state (test doubles track it via
  // setRawMode; a real TTY sets `isRaw` itself).
  let rawMode = false;
  Object.defineProperty(filtered, 'isRaw', {
    get: (): boolean => (typeof real.isRaw === 'boolean' ? real.isRaw : rawMode),
    set: (value: boolean): void => { rawMode = value; },
  });
  // A terminal read error is unrecoverable; never let it crash as a second
  // unhandled 'error' event on the proxy.
  filtered.on('error', () => {});
  const proxied = filtered as unknown as PasteAwarePassThrough;

  let hold = '';
  let holdTimer: NodeJS.Timeout | undefined;
  let insidePaste = false;
  // Once the terminal has spoken bracketed paste, plain data is real
  // keystrokes and the `\n` heuristic is retired for this session.
  let bracketedSeen = false;
  proxied.pasteActive = false;

  const emit = (text: string, pasted: boolean): void => {
    if (!text) return;
    proxied.pasteActive = pasted;
    // PassThrough drains listeners synchronously, so every keypress decoded
    // from this write observes pasteActive.
    filtered.write(text);
    proxied.pasteActive = false;
  };

  const clearHoldTimer = (): void => {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = undefined; }
  };

  /** A partial marker held across reads must never wedge a bare Escape. */
  const armHoldFlush = (): void => {
    if (holdTimer || !hold || insidePaste) return;
    holdTimer = setTimeout(() => {
      holdTimer = undefined;
      if (hold) { const pending = hold; hold = ''; emit(pending, false); }
    }, holdFlushMs);
    holdTimer.unref?.();
  };

  /** Consumes paste content up to (and including) the end marker or chunk end. */
  const consumePasteBody = (text: string): string => {
    let rest = text;
    for (;;) {
      const end = rest.indexOf(MARKER_END);
      if (end < 0) {
        // Keep a potential partial end marker back so a read boundary
        // cannot swallow its tail.
        const keep = trailingMarkerPrefix(rest, MARKER_END);
        const body = rest.slice(0, rest.length - keep);
        if (body) emit(body.replace(CRLF, '\n').replace(CR, '\n'), true);
        hold = rest.slice(rest.length - keep);
        insidePaste = true;
        return '';
      }
      // Newlines inside a paste are literal content, never key presses.
      const body = rest.slice(0, end);
      if (body) emit(body.replace(CRLF, '\n').replace(CR, '\n'), true);
      insidePaste = false;
      return rest.slice(end + MARKER_END.length);
    }
  };

  /** Plain (marker-free) chunk: typed keystrokes, or a bracketless paste burst. */
  const handlePlain = (chunk: string): void => {
    if (!chunk) return;
    // Hold back a partial start marker so a read boundary cannot leak it
    // into the draft as stray characters.
    const keep = trailingMarkerPrefix(chunk, MARKER_START);
    if (keep > 0) {
      hold = chunk.slice(chunk.length - keep);
      chunk = chunk.slice(0, chunk.length - keep);
      if (!chunk) { armHoldFlush(); return; }
    }
    if (bracketedSeen) {
      emit(chunk, false);
      return;
    }
    // A lone CR (typed Enter) keeps submitting; LF only rides in pastes.
    // `\r\n` as a whole chunk is also a keyboard Enter (LF-mode terminals).
    if (/^\r?$/.test(chunk) || chunk === '\r\n') {
      emit(chunk === '\r\n' ? '\n' : chunk, false);
      return;
    }
    if (/[\r\n]/.test(chunk)) {
      emit(chunk.replace(CRLF, '\n').replace(CR, '\n'), true);
    } else {
      emit(chunk, false);
    }
  };

  const onData = (data: Buffer | string): void => {
    clearHoldTimer();
    let text = hold + (typeof data === 'string' ? data : decoder.write(data));
    hold = '';
    if (insidePaste) text = consumePasteBody(text);
    while (!insidePaste) {
      const start = text.indexOf(MARKER_START);
      if (start < 0) break;
      const before = text.slice(0, start);
      text = text.slice(start + MARKER_START.length);
      bracketedSeen = true;
      if (before) emit(before, false);
      insidePaste = true;
      text = consumePasteBody(text);
    }
    handlePlain(text);
    armHoldFlush();
  };

  /** EOF or the real stream dying: flush what is held and close the proxy. */
  const finish = (): void => {
    clearHoldTimer();
    if (hold) {
      emit(hold, insidePaste);
      hold = '';
    }
    if (!filtered.writableEnded) filtered.end();
  };
  const onEnd = finish;
  const onClose = finish;
  const onError = (error: Error): void => {
    filtered.destroy(error);
  };

  // Attach lazily: only start forwarding the real input once a consumer
  // actually reads from this proxy. Tests monkeypatch `blessed.screen` and
  // swap in their own input stream, so nothing ever consumes the proxy there —
  // eagerly listening on the real stdin would accumulate listeners across
  // tests and keep the process alive after the suite finished.
  let attached = false;
  const attach = (): void => {
    if (attached) return;
    attached = true;
    rawInput.on('data', onData);
    rawInput.on('end', onEnd);
    rawInput.on('close', onClose);
    rawInput.on('error', onError);
  };
  filtered.on('newListener', (event: string | symbol): void => {
    if (event === 'data' || event === 'readable') attach();
  });

  proxied.setRawMode = (mode: boolean): void => {
    rawMode = mode;
    real.setRawMode?.(mode);
  };
  // Method overrides are installed via defineProperty so the PassThrough
  // prototype methods remain reachable through their own names.
  const override = (name: 'pause' | 'resume' | 'destroy', implementation: (...args: never[]) => void): void => {
    Object.defineProperty(proxied, name, { value: implementation, writable: true, configurable: true });
  };
  override('pause', () => {
    real.pause?.();
    PassThrough.prototype.pause.call(filtered);
  });
  override('resume', () => {
    real.resume?.();
    PassThrough.prototype.resume.call(filtered);
  });
  override('destroy', ((error?: Error) => {
    clearHoldTimer();
    rawInput.removeListener('data', onData);
    rawInput.removeListener('end', onEnd);
    rawInput.removeListener('close', onClose);
    rawInput.removeListener('error', onError);
    // `filtered.destroy` resolves to this own override; calling through the
    // prototype keeps teardown from recursing into itself.
    PassThrough.prototype.destroy.call(filtered, error);
  }) as (...args: never[]) => void);
  return proxied;
}
