import { generateSyntheticRaster } from './raster-codec.mjs';

export function httpProblem(status, message) {
  const error = new Error(message); error.httpStatus = status; return error;
}

// One physical generation lane. Request cancellation never frees an executing
// generator's slot; its real promise must settle. SingleFlight is RAM-only.
export function createImageStore({ statistics, generate = generateSyntheticRaster, maxWaiting = 16, encodedLimit = 80 * 1024 * 1024 } = {}) {
  const cache = new Map(), flights = new Map(), queue = [];
  let cacheBytes = 0, reservedBytes = 0, active = false, closing = false;
  const idleWaiters = [];
  Object.assign(statistics, { generationActive: 0, generationPeak: 0, generationWaiting: 0, generationWaitingPeak: 0, cacheBytes: 0, encodedReservedBytes: 0, encodedBytesPeak: 0 });
  function measure() {
    statistics.cacheBytes = cacheBytes; statistics.encodedReservedBytes = reservedBytes;
    statistics.cacheBytesPeak = Math.max(statistics.cacheBytesPeak || 0, cacheBytes);
    statistics.encodedBytesPeak = Math.max(statistics.encodedBytesPeak, cacheBytes + reservedBytes);
  }
  function trim(extra = 0) {
    while (cache.size && (cacheBytes + reservedBytes + extra > encodedLimit || cache.size >= 120)) {
      const key = cache.keys().next().value;
      cacheBytes -= cache.get(key).length; cache.delete(key);
    }
    if (cacheBytes + reservedBytes + extra > encodedLimit) throw httpProblem(507, 'Synthetic encoded memory budget');
  }
  async function drain() {
    if (active) return;
    const task = queue.shift(); statistics.generationWaiting = queue.length;
    if (!task) { for (const resolve of idleWaiters.splice(0)) resolve(); return; }
    active = true; statistics.generationActive = 1; statistics.generationPeak = Math.max(statistics.generationPeak, 1);
    try {
      const d = task.description;
      const bytes = await generate(d.width, d.height, {
        sourceWidth: d.native.width, sourceHeight: d.native.height,
        offsetX: d.offsetX, offsetY: d.offsetY, seed: d.seed,
        scaled: d.mode === 'preview', outputMime: d.mime,
        onEncodedBytes(total) {
          // Reserve both compressed chunks and their final contiguous copy.
          const next = total * 2; trim(next - reservedBytes); reservedBytes = next; measure();
        }
      });
      if (!Buffer.isBuffer(bytes)) throw new TypeError('PNG generator must return Buffer');
      statistics.imagesGenerated++;
      reservedBytes = 0; trim(bytes.length);
      cache.set(d.key, bytes); cacheBytes += bytes.length; measure(); task.resolve(bytes);
    } catch (error) { task.reject(error); }
    finally {
      reservedBytes = 0; measure(); flights.delete(task.description.key);
      active = false; statistics.generationActive = 0; void drain();
    }
  }
  return {
    get(description) {
      if (closing) return Promise.reject(httpProblem(503, 'Image store closing'));
      if (cache.has(description.key)) {
        const bytes = cache.get(description.key); cache.delete(description.key); cache.set(description.key, bytes);
        return Promise.resolve(bytes);
      }
      if (flights.has(description.key)) return flights.get(description.key);
      if (active && queue.length >= maxWaiting) return Promise.reject(httpProblem(429, 'Synthetic generation queue full'));
      const promise = new Promise((resolve, reject) => queue.push({ description, resolve, reject }));
      flights.set(description.key, promise);
      statistics.generationWaiting = queue.length;
      statistics.generationWaitingPeak = Math.max(statistics.generationWaitingPeak, Math.max(0, queue.length - (active ? 0 : 1)));
      void drain(); return promise;
    },
    async close() {
      closing = true;
      for (const task of queue.splice(0)) { flights.delete(task.description.key); task.reject(httpProblem(503, 'Image store closing')); }
      statistics.generationWaiting = 0;
      if (active) await new Promise(resolve => idleWaiters.push(resolve));
      cache.clear(); cacheBytes = 0; measure();
    }
  };
}

export function waitForRequest(promise, res, timeoutMs = 30_000) {
  if (res.destroyed) return Promise.reject(httpProblem(499, 'Request closed'));
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); res.off('close', closed); };
    const closed = () => { cleanup(); reject(httpProblem(499, 'Request closed')); };
    const timer = setTimeout(() => { cleanup(); reject(httpProblem(504, 'Synthetic resource timeout')); }, timeoutMs);
    res.once('close', closed);
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
