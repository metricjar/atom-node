'use strict';

const sizeof = require('object-sizeof');
const Promise = require('bluebird');
const promiseRetry = require('promise-retry');
const config = require('./../config');
const Atom = require('./atom.class');
const LocalStore = require('./storage/local.class');
const TAG = 'TRACKER';

module.exports = class Tracker {
  /**
   *
   * This class implements a tracker for tracking events to ironSource atom
   * @param {Object} params
   * @param {Number} [params.flushInterval=10 seconds] - Data sending interval (in seconds)
   * @param {Number} [params.bulkLen=1000] - Number of records in each bulk request
   * @param {Number} [params.bulkSize=128kb] - The maximum bulk size in KB.
   * @param {callback} [params.onError=null] - Callback that will be invoked with the failed event if maximum retries fail
   * @param {Boolean} [params.flushOnExit=true] - Whether all data should be flushed on application exit
   * @param {Object} [params.logger=console] - Override Logger module
   * @param {Object} [params.backlog=LocalStore] - Backlog module, implementation for the tracker backlog storage
   * @ppram {Number} [params.concurrency=10] - Number of requests to send concurrently (Promise.Map)
   * @param {Object} [params.retryOptions] - node-retry(https://github.com/tim-kos/node-retry) options
   * @param {Number} [params.retryOptions.retries=10] - The maximum amount of times to retry the operation.
   * @param {Boolean} [params.retryOptions.randomize=true] - Randomizes the timeouts by multiplying with a factor between 1 to 2.
   * @param {Number} [params.retryOptions.factor=2] - The exponential factor to use.
   * @param {Number} [params.retryOptions.minTimeout=1 second] - The number of milliseconds before starting the first retry.
   * @param {Number} [params.retryOptions.maxTimeout=25 minutes] - The maximum number of milliseconds between two retries.
   * @param {Boolean} [params.debug=true] - Enabled/Disable debug printing
   * Optional for Atom main object:
   * @param {String} [params.endpoint] - Endpoint api url
   * @param {String} [params.auth] - Key for hmac authentication
   * @constructor
   */
  constructor(params) {
    params = params || {};
    this.params = params || {};

    this.params.debug = typeof params.debug !== 'undefined' ? params.debug : config.DEBUG;
    this.logger = params.logger || config.LOGGER;
    if (typeof this.logger.toggleLogger === "function") {
      this.logger.toggleLogger(this.params.debug);
    }
    this.backlog = params.backlog || new LocalStore();
    let self = this;

    // Flush logic parameters
    this.params.flushInterval = !!params.flushInterval ? params.flushInterval * 1000 : config.FLUSH_INTERVAL;
    this.params.bulkLen = !!params.bulkLen ? params.bulkLen : config.BULK_LENGTH;
    this.params.bulkSize = !!params.bulkSize ? params.bulkSize * 1024 : config.BULK_SIZE;
    this.params.onError = params.onError || function (err) {
        self.logger.error(`[${TAG}] Message: ${err.message}, status: ${err.status}`)
      };
    this.params.flushOnExit = typeof params.flushOnExit !== 'undefined' ? params.flushOnExit : true;

    // Processing parameters
    this.params.concurrency = params.concurrency || config.CONCURRENCY;

    // Retry parameters for exponential backoff
    this.retryOptions = Object.assign({}, {
      retries: 10,
      randomize: true,
      factor: 2,
      minTimeout: 1000,
      maxTimeout: 25 * 60 * 60
    }, params.retryOptions);

    this.atom = new Atom(params);

    // Timers dictionary for each stream
    this.streamTimers = {};

    if (this.params.flushOnExit) {
      this.exitHandled = false;
      ['exit', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGABRT', 'SIGTERM']
        .map((e) => {
          process.on(e, () => this._exitHandler())
        });
    }

    /**
     * will process streams and determine whether they should be flushed each 100 milliseconds
     * @type {any}
     */
    setInterval(() => {
      this._process();
    }, this.params.flushInterval);

  }

  /**
   * Handles graceful shutdown of the app
   * @private
   */
  _exitHandler() {
    // Prevent multiple exit handlers to be called
    if (!this.exitHandled) {
      this.exitHandled = true;
      this.logger.trace(`[${TAG}] Triggered flush due to process exit`);
      this.flush();
    }
  }

  /**
   * Get current time
   * @return {number}
   * @static
   */
  static _getTimestamp() {
    return +new Date();
  }

  /**
   * Return true if flushInterval has been reached for the input stream.
   * @param {String} stream - Atom Stream name
   * @return {Boolean}
   * @private
   */
  _shouldTriggerIntervalFlush(stream) {
    return (this.streamTimers[stream] !== undefined) &&
      this.params.flushInterval <= (Tracker._getTimestamp() - this.streamTimers[stream]);
  }

  /**
   * Determines whether the stream should be flushed based on 3 conditions
   * 1. Payload length reached
   * 2. Payload size reached
   * 3. Time since last flush
   * @param {String} stream - Atom Stream name
   * @returns {boolean} - Whether the stream should be flushed
   * @private
   */
  _shouldFlush(stream) {
    let payload = this.backlog.get(stream);
    return payload.length && // First, we should not flush an empty array
      (
        payload.length >= this.params.bulkLen || // Flush if we reached desired length (amount of events)
        sizeof(payload) >= this.params.bulkSize || // Flush if the object has reached desired byte-size
        this._shouldTriggerIntervalFlush(stream) // Should trigger based on interval
      );
  }

  // todo: add doc
  track(stream, data) {
    if (stream === undefined || stream.length == 0 || data === undefined || data.length == 0) {
      throw new Error('Stream name and data are required parameters');
    }
    this.backlog.add(stream, data);
    if (!this.streamTimers[stream]) {
      this.streamTimers[stream] = Tracker._getTimestamp();
      this.logger.trace(`[TRACKER] no timer set-up for stream ${stream}, setting.`);
    }
    // Call process each time to see if we need to flush
    return this._process();
  }

  /**
   * Process all streams and flush if necessary
   * @returns {*|Array|Promise}
   * @private
   */
  _process() {
    return Promise.map(this.backlog.keys, (stream) => {
      if (this._shouldFlush(stream)) {
        this.streamTimers[stream] = Tracker._getTimestamp();
        return this.flush(stream);
      }
    }, {concurrency: this.params.concurrency});
  }

  /**
   * Flush data to atom
   * @param batchStream
   */
  flush(batchStream) {
    // Flush a particular stream
    if (!!batchStream) {
      if (!this.backlog.isEmpty(batchStream)) {
        this.logger.info(`[${TAG}] flushing stream: ${batchStream} with ${this.backlog.get(batchStream).length} items`);
        return this._send(batchStream, this.backlog.take(batchStream));
      }
    } else {
      // Send everything when no params were given
      for (let stream of this.backlog.keys) {
        this.flush(stream);
      }
    }
  }

  /**
   * Sends events to Atom using the low level Atom Class, handles retries and calls a callback on error
   * @param stream
   * @param data
   * @private
   */
  _send(stream, data) {
    let payload = {stream: stream, data: data};
    return promiseRetry((retry, number) => {
      return this.atom.putEvents(payload)
        .then((data) => {
          this.logger.debug(`[${TAG}] flush attempt #${number} for stream: '${stream}' completed successfully`);
          return data;
        })
        .catch((err) => {
          this.logger.debug(`[${TAG}] flush attempt #${number} for stream: '${stream}' failed due to "${err.message}" (status ${err.status})`);
          if (err.status >= 500) {
            retry(err)
          } else {
            throw err;
          }
        });
    }, this.retryOptions).then(Promise.resolve)
      .catch((err) => {
        this.params.onError(err)
      });
  }
};