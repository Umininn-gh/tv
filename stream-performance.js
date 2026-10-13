/* Request orchestration shared by the live TV pages. */
(function (root) {
    'use strict';

    function withRequestTimeout(task, { timeoutMs = 20000 } = {}) {
        const controller = new AbortController();
        let timer;
        const timeout = new Promise((resolve, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new Error('Channel request timed out'));
            }, timeoutMs);
        });
        return Promise.race([Promise.resolve().then(() => task(controller.signal)), timeout]).finally(() => clearTimeout(timer));
    }

    function createInFlightCoalescer() {
        const pending = new Map();
        return {
            run(key, task) {
                if (pending.has(key)) return pending.get(key);
                const request = Promise.resolve().then(task);
                pending.set(key, request);
                const release = () => { if (pending.get(key) === request) pending.delete(key); };
                request.then(release, release);
                return request;
            }
        };
    }

    function createStatusScheduler({ maxConcurrent = 4, cacheMs = 30000, requestTimeoutMs = 20000, now = Date.now } = {}) {
        const pending = new Map();
        const cache = new Map();
        const queue = [];
        let active = 0;
        const limit = Math.max(1, Math.floor(maxConcurrent) || 4);

        function pump() {
            while (active < limit && queue.length) {
                const job = queue.shift();
                active++;
                const release = () => {
                    active--;
                    if (pending.get(job.key) === job.promise) pending.delete(job.key);
                    pump();
                };
                withRequestTimeout(job.task, { timeoutMs: requestTimeoutMs }).then(value => {
                    cache.set(job.key, { value, checkedAt: now() });
                    release();
                    job.resolve(value);
                }, error => {
                    cache.delete(job.key);
                    release();
                    job.reject(error);
                });
            }
        }

        return {
            run(key, task, { force = false } = {}) {
                if (pending.has(key)) return pending.get(key);
                const previous = cache.get(key);
                if (!force && previous && now() - previous.checkedAt < cacheMs) return Promise.resolve(previous.value);
                let resolve, reject;
                const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
                pending.set(key, promise);
                queue.push({ key, task, promise, resolve, reject });
                pump();
                return promise;
            },
            clear(key) {
                if (key === undefined) cache.clear();
                else cache.delete(key);
            },
            snapshot() { return { active, queued: queue.length, pending: pending.size }; }
        };
    }

    const api = { createInFlightCoalescer, createStatusScheduler, withRequestTimeout };
    root.StreamPerformance = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
