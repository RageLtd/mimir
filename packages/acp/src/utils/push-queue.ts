/**
 * A simple push queue that bridges event callbacks into an async iterator.
 *
 * Events are buffered until consumed; the async iterator pulls from the
 * queue. Used by backends that have a callback-based event model (e.g.
 * the Copilot SDK's session.on(...)) to bridge into async generators.
 */
export const createPushQueue = <T>() => {
  const buffer: T[] = [];
  let resolve: ((value: IteratorResult<T>) => void) | null = null;
  let done = false;

  const push = (value: T) => {
    if (done) return;
    if (resolve) {
      const r = resolve;
      resolve = null;
      r({ value, done: false });
    } else {
      buffer.push(value);
    }
  };

  const end = () => {
    done = true;
    if (resolve) {
      const r = resolve;
      resolve = null;
      r({ value: undefined as unknown as T, done: true });
    }
  };

  const iterator: AsyncIterableIterator<T> = {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    next() {
      if (buffer.length > 0) {
        // Safe: length check guarantees shift() returns a value
        const value = buffer.shift() as T;
        return Promise.resolve({ value, done: false });
      }
      if (done) {
        return Promise.resolve({
          value: undefined as unknown as T,
          done: true,
        });
      }
      return new Promise<IteratorResult<T>>((r) => {
        resolve = r;
      });
    },
  };

  return { push, end, iterator };
};
