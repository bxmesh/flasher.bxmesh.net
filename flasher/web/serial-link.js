// One open Web Serial port: a read loop that gathers everything the board sends, waits for what
// the caller is looking for, and writes. Nothing read or written is logged here.

export class LinkClosed extends Error {}
export class LinkTimeout extends Error {}

export class SerialLink {
  constructor(port) {
    this.port = port;
    this.buf = new Uint8Array(0);
    this.waiters = new Set();
    this.closed = false;
  }

  async open(baudRate) {
    await this.port.open({ baudRate, bufferSize: 65536 });
    try {
      await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
    } catch {
      // Not every port takes signals; the board doesn't need them.
    }
    this.reader = this.port.readable.getReader();
    this.loop = this._read();
    return this;
  }

  async _read() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) {
          const next = new Uint8Array(this.buf.length + value.length);
          next.set(this.buf);
          next.set(value, this.buf.length);
          this.buf = next;
          this._wake();
        }
      }
    } catch {
      // The board went away (a restart, or unplugged): seen by the waiters as closed.
    } finally {
      this.closed = true;
      this._wake();
    }
  }

  _wake() {
    for (const w of [...this.waiters]) w();
  }

  clear() {
    this.buf = new Uint8Array(0);
  }

  consume(n) {
    this.buf = this.buf.slice(n);
  }

  // Resolves with the first non-undefined value test(link) returns, checked on every arrival.
  waitFor(test, timeoutMs) {
    return new Promise((resolve, reject) => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      const check = () => {
        let r;
        try {
          r = test(this);
        } catch (e) {
          done();
          reject(e);
          return;
        }
        if (r !== undefined) {
          done();
          resolve(r);
        } else if (this.closed) {
          done();
          reject(new LinkClosed("the board disconnected"));
        }
      };
      timer = setTimeout(() => {
        done();
        reject(new LinkTimeout("no answer in time"));
      }, timeoutMs);
      this.waiters.add(check);
      check();
    });
  }

  async write(bytes) {
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
  }

  async close() {
    try {
      await this.reader?.cancel();
    } catch {}
    try {
      this.reader?.releaseLock();
    } catch {}
    await this.loop?.catch(() => {});
    try {
      await this.port.close();
    } catch {}
    this.closed = true;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
