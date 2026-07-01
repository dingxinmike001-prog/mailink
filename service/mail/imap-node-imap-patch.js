const patchedKey = Symbol.for('mailink.imap.nodeImapPatched');

if (!global[patchedKey]) {
  global[patchedKey] = true;

  try {
    const Connection = require('imap/lib/Connection');
    const originalResUntagged = Connection?.prototype?._resUntagged;

    if (typeof originalResUntagged === 'function' && !originalResUntagged.__mailinkPatched) {
      const needsCurReqTypes = new Set(['id', 'sort', 'thread', 'esearch', 'search', 'quota', 'recent', 'flags', 'exists']);

      const wrapped = function resUntaggedPatched(info) {
        const type = info?.type;

        if (needsCurReqTypes.has(type) && !this?._curReq) {
          const err = new Error(`IMAP protocol state error: untagged ${type} without active request`);
          err.source = 'protocol';
          if (typeof this.listenerCount === 'function' && this.listenerCount('error') > 0) {
            this.emit('error', err);
          }
          return;
        }

        if (needsCurReqTypes.has(type) && this?._curReq && !Array.isArray(this._curReq.cbargs)) {
          this._curReq.cbargs = [];
        }

        return originalResUntagged.call(this, info);
      };

      wrapped.__mailinkPatched = true;
      Connection.prototype._resUntagged = wrapped;
    }
  } catch {
  }
}
