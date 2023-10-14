/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const undici = require('undici');
const delay = require('delay');
const ms = require('ms');

const isRetryableError = require('./is-retryable-error');

class RetryClient extends undici.Client {
  constructor(opts) {
    super(opts);

    const timeout =
      typeof opts?.timeout === 'number' ? opts.timeout : ms('30s');
    const retries = typeof opts?.retries === 'number' ? opts.retries : 3;

    // exponential retry backoff (2, 4, 8)
    const calculateDelay =
      typeof opts?.calculateDelay === 'function'
        ? opts.calculateDelay
        : (count) => Math.round(1000 * 2 ** count);

    this._request = this.request;

    this.request = async (options, count = 1) => {
      try {
        options.signal = AbortSignal.timeout(timeout);
        options.throwOnError = true;
        const response = await this._request(options);
        // the error code is between 200-400 (e.g. 302 redirect)
        // in order to mirror the behavior of `throwOnError` we will re-use the undici errors
        // <https://github.com/nodejs/undici/issues/2093>
        if (response.statusCode !== 200) {
          // still need to consume body even if an error occurs
          const body = await response.body.text();
          const err = new undici.errors.ResponseStatusCodeError(
            `Response status code ${response.statusCode}`,
            response.statusCode,
            response.headers,
            body
          );
          err.options = options;
          err.count = count;
          throw err;
        }

        return response;
      } catch (err) {
        if (count >= retries || !isRetryableError(err)) throw err;
        const ms = calculateDelay(count);
        if (ms) await delay(ms);
        return this.request(options, count + 1);
      }
    };
  }
}

module.exports = RetryClient;
