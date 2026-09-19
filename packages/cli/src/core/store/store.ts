import type { Action } from "./actions.ts";

export type Reducer<S> = (state: S, action: Action) => S;

type Subscriber<S> = {
  select: (state: S) => unknown;
  notify: (value: never, previous: never) => void;
  last: unknown;
};

/**
 * Flux-style store. Slices register their own reducer + initial state;
 * `dispatch` runs every reducer synchronously, then notifies subscribers
 * whose selected value changed by identity, then action listeners. Dispatches
 * issued from inside a notification or listener are queued and run after the
 * current one completes.
 */
export const createStore = <S extends Record<string, unknown>>() => {
  const reducers = new Map<keyof S, Reducer<S[keyof S]>>();
  const subscribers = new Set<Subscriber<S>>();
  const listeners = new Set<(action: Action) => void>();
  const queue: Action[] = [];
  let state = {} as S;
  let dispatching = false;

  const getState = () => state;

  const register = <K extends keyof S>(
    key: K,
    initial: S[K],
    reducer: Reducer<S[K]>,
  ) => {
    reducers.set(key, reducer as unknown as Reducer<S[keyof S]>);
    state = { ...state, [key]: initial };
  };

  const reduce = (action: Action) => {
    let changed = false;
    let next = state;
    for (const [key, reducer] of reducers) {
      const slice = reducer(state[key], action);
      if (slice !== state[key]) {
        next = changed ? next : { ...state };
        next[key] = slice;
        changed = true;
      }
    }
    if (changed) {
      state = next;
      for (const subscriber of subscribers) {
        const value = subscriber.select(state);
        if (value !== subscriber.last) {
          const previous = subscriber.last;
          subscriber.last = value;
          subscriber.notify(value as never, previous as never);
        }
      }
    }
    for (const listener of listeners) {
      listener(action);
    }
  };

  const dispatch = (action: Action) => {
    queue.push(action);
    if (dispatching) {
      return;
    }
    dispatching = true;
    while (queue.length > 0) {
      const next = queue.shift();
      if (next !== undefined) {
        reduce(next);
      }
    }
    dispatching = false;
  };

  const subscribe = <T>(
    select: (state: S) => T,
    notify: (value: T, previous: T) => void,
  ) => {
    const subscriber: Subscriber<S> = {
      select,
      notify: notify as Subscriber<S>["notify"],
      last: select(state),
    };
    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
    };
  };

  /** Action listener: side-effect modules (workers, commands) register here. */
  const listen = (listener: (action: Action) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { getState, register, dispatch, subscribe, listen };
};

export type Store<S extends Record<string, unknown>> = ReturnType<
  typeof createStore<S>
>;
