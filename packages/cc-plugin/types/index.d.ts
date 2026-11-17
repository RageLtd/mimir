/**
 * The plugin's `$.state` contract — what `claude plugin validate` holds
 * the hooks module's state keys to.
 */

export type MimirTurn = number;

/**
 * Where the last distillation stopped: how many messages of the main
 * conversation it covered and the mark (role and text) of the last one,
 * so the point is found again after the window slides or compacts.
 */
export type MimirAnchor = {
  readonly count: number;
  readonly mark: string;
};

/**
 * A distillation scheduled off the turn and not yet settled: the anchor it
 * will move to, and when it was scheduled (`$.clock.now()`), so one left
 * behind by a session that ended mid-run goes stale instead of blocking.
 */
export type MimirPending = {
  readonly anchor: MimirAnchor;
  readonly at: number;
};

/**
 * A read's claim on a file's file-context run: when it was taken
 * (`$.clock.now()`), so one left behind by a read that never gave it back
 * goes stale instead of blocking.
 */
export type MimirReading = {
  readonly at: number;
};

declare module "claude-code" {
  interface PluginState {
    "mimir-cc": {
      /**
       * Developer turns this session, counted on `prompt.submit` — the
       * voice-anchor cadence. A re-anchor moves it up to the next anchor
       * turn, so the cadence restarts from there.
       */
      turn: MimirTurn;
      /**
       * Set by a compaction, a `/clear` or a resume (`session.end` with
       * reason `clear` or `resume`): the next prompt is a reset — a voice
       * anchor whatever the count, the boot block again, and
       * `window_reset` to retrieval. The window that replaced the
       * conversation carries none of the persona's voice. A reset is also
       * seen without it, from `window`.
       */
      reanchor: boolean;
      /**
       * Set by a resume in this process (`session.end` with reason
       * `resume`): the next prompt starts `mimir-cc session-start` for the
       * session that took the ended one's place.
       */
      resumed: boolean;
      /**
       * The conversation window the last prompt saw, taken on
       * `prompt.submit` from `$.session.messages()`'s rows: a prompt whose
       * messages no longer carry it (a compaction or `/clear` replaced the
       * window) is a reset.
       */
      window: MimirAnchor;
      /**
       * The last session's summary is still owed to this one: a first
       * prompt's retrieve answered `summaryPending` — its summary-pending
       * mark is live, whatever the distance gate admitted (a near summary
       * is still injected), or its retrieval failed — or the retrieve
       * failed, could not run, or printed what is not JSON. Each prompt
       * goes to retrieve as `session_start` until one answers readably
       * without `summaryPending`.
       */
      summaryOwed: boolean;
      /**
       * Files by path whose file-context run is in flight: the claim of the
       * read that took it until its run settles, null after. A read of a
       * file under a live claim runs nothing and attaches nothing; a claim
       * older than `READING_STALE_MS` is dead and blocks nothing.
       */
      reading: StateFamily<MimirReading | null>;
      /** The main conversation's distilled prefix, advanced by persist. */
      distilled: MimirAnchor;
      /**
       * The conversation a summary already covers: the window the last
       * settled precompact of a skipped compaction summarised — a repeat
       * over it would otherwise store a near-identical summary — or, after
       * a real compaction, the compacted conversation, whose replaced
       * window that compaction's own run summarises.
       */
      summarised: MimirAnchor;
      /** The distillation in flight, null once it settles. */
      pending: MimirPending | null;
    };
  }
}
