// Serial DFU for the Adafruit nRF52 bootloader: the legacy (SDK 11) HCI transport that
// adafruit-nrfutil's "dfu serial" speaks, over Web Serial.
//
// Written from adafruit-nrfutil's nordicsemi/dfu/dfu_transport_serial.py (BSD-3-Clause,
// Nordic Semiconductor and Adafruit), following the two Web Serial ports of it, both MIT:
// meshcore-dev/flasher.meshcore.io lib/dfu.js (Copyright (c) 2025 Rastislav Vysoky) and
// liamcottle/rnode-flasher js/nrf52_dfu_flasher.js (Copyright (c) 2024 Liam Cottle). The
// constants, the CRC-16, the SLIP header and the packet order are theirs; their notices are in
// THIRD_PARTY_NOTICES.md. This one waits for the bootloader's acknowledgement of every packet
// and checks its number, and reports progress with the time left.

import { LinkTimeout, sleep } from "./serial-link.js";

const DATA_INTEGRITY_CHECK_PRESENT = 1;
const RELIABLE_PACKET = 1;
const HCI_PACKET_TYPE = 14;

const DFU_INIT_PACKET = 1;
const DFU_START_PACKET = 3;
const DFU_DATA_PACKET = 4;
const DFU_STOP_DATA_PACKET = 5;
const DFU_UPDATE_MODE_APP = 4;

export const FLASH_PAGE_SIZE = 4096;
const FLASH_PAGE_ERASE_TIME = 0.0897; // s, nRF52840 at most
const FLASH_WORD_WRITE_TIME = 0.0001; // s
const FLASH_PAGE_WRITE_TIME = (FLASH_PAGE_SIZE / 4) * FLASH_WORD_WRITE_TIME;
export const DFU_PACKET_MAX_SIZE = 512;
const ACK_TIMEOUT_MS = 5000;

export class DfuError extends Error {}

export function crc16(data, crc = 0xffff) {
  for (const b of data) {
    crc = ((crc >> 8) & 0x00ff) | ((crc << 8) & 0xff00);
    crc ^= b;
    crc ^= (crc & 0x00ff) >> 4;
    crc ^= (crc << 8) << 4;
    crc ^= ((crc & 0x00ff) << 4) << 1;
    crc &= 0xffff;
  }
  return crc;
}

const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

export function slipHeader(seq, len) {
  const h = [
    seq | (((seq + 1) % 8) << 3) | (DATA_INTEGRITY_CHECK_PRESENT << 6) | (RELIABLE_PACKET << 7),
    HCI_PACKET_TYPE | ((len & 0x000f) << 4),
    (len & 0x0ff0) >> 4,
  ];
  h.push((~(h[0] + h[1] + h[2]) + 1) & 0xff);
  return h;
}

export function slipEscape(bytes) {
  const out = [];
  for (const b of bytes) {
    if (b === 0xc0) out.push(0xdb, 0xdc);
    else if (b === 0xdb) out.push(0xdb, 0xdd);
    else out.push(b);
  }
  return out;
}

export function slipUnescape(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0xdb) {
      const n = bytes[++i];
      if (n === 0xdc) out.push(0xc0);
      else if (n === 0xdd) out.push(0xdb);
      else throw new DfuError("garbled answer from the bootloader");
    } else out.push(bytes[i]);
  }
  return out;
}

export function hciPacket(seq, payload) {
  const body = [...slipHeader(seq, payload.length), ...payload];
  const crc = crc16(Uint8Array.from(body));
  body.push(crc & 0xff, (crc >> 8) & 0xff);
  return Uint8Array.from([0xc0, ...slipEscape(body), 0xc0]);
}

// The bootloader's time to erase before it takes data (dfu_transport_serial.get_erase_wait_time).
export function eraseWaitMs(totalSize) {
  return Math.max(0.5, (Math.floor(totalSize / FLASH_PAGE_SIZE) + 1) * FLASH_PAGE_ERASE_TIME) * 1000;
}

export class SerialDfu {
  constructor(link) {
    this.link = link;
    this.seq = 0;
  }

  // Sends one packet and waits for the bootloader's acknowledgement: a header-only SLIP frame
  // whose ack number is the next sequence number.
  async send(payload) {
    this.seq = (this.seq + 1) % 8;
    const seq = this.seq;
    await this.link.write(hciPacket(seq, payload));
    let ack;
    try {
      ack = await this.link.waitFor((l) => {
        for (;;) {
          const b = l.buf;
          const s = b.indexOf(0xc0);
          if (s < 0) return undefined;
          const e = b.indexOf(0xc0, s + 1);
          if (e < 0) return undefined;
          if (e === s + 1) {
            l.consume(s + 1); // two delimiters together: an empty frame
            continue;
          }
          const frame = slipUnescape(b.slice(s + 1, e));
          l.consume(e + 1);
          return (frame[0] >> 3) & 0x07;
        }
      }, ACK_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof LinkTimeout) throw new DfuError("the bootloader stopped answering");
      throw e;
    }
    if (ack !== (seq + 1) % 8) throw new DfuError("the bootloader lost track of the transfer");
  }

  // Writes the application: start, init packet, the image in 512-byte packets, stop.
  // onProgress({ sent, total, secondsLeft }).
  async flash(init, image, onProgress) {
    this.link.clear();
    const total = image.length;
    await this.send([...u32(DFU_START_PACKET), ...u32(DFU_UPDATE_MODE_APP), ...u32(0), ...u32(0), ...u32(total)]);
    await sleep(eraseWaitMs(total));
    await this.send([...u32(DFU_INIT_PACKET), ...init, 0x00, 0x00]);

    const started = performance.now();
    const count = Math.ceil(total / DFU_PACKET_MAX_SIZE);
    for (let i = 0; i < count; i++) {
      const chunk = image.subarray(i * DFU_PACKET_MAX_SIZE, (i + 1) * DFU_PACKET_MAX_SIZE);
      await this.send([...u32(DFU_DATA_PACKET), ...chunk]);
      // Every 8 packets (one flash page) the chip writes, and its CPU stops: give it the time.
      if (i % 8 === 0) await sleep(FLASH_PAGE_WRITE_TIME * 1000);
      const sent = Math.min(total, (i + 1) * DFU_PACKET_MAX_SIZE);
      const elapsed = (performance.now() - started) / 1000;
      onProgress?.({ sent, total, secondsLeft: Math.ceil((elapsed / sent) * (total - sent)) });
    }
    await sleep(FLASH_PAGE_WRITE_TIME * 1000);
    await this.send(u32(DFU_STOP_DATA_PACKET));
  }
}

// How long the bootloader may take to check and start the new image after the last packet
// (dfu_transport_serial.get_activate_wait_time, dual bank: erase, then copy).
export function activateWaitMs(totalSize) {
  const pages = Math.floor(totalSize / FLASH_PAGE_SIZE) + 1;
  return eraseWaitMs(totalSize) + pages * FLASH_PAGE_WRITE_TIME * 1000;
}

/*
Notices for the work this file follows (THIRD_PARTY_NOTICES.md):

adafruit-nrfutil:
Copyright (c) 2015, Nordic Semiconductor
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of Nordic Semiconductor ASA nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

meshcore-dev/flasher.meshcore.io lib/dfu.js:
MIT License

Copyright (c) 2025 Rastislav Vysoky

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

liamcottle/rnode-flasher js/nrf52_dfu_flasher.js:
MIT License

Copyright (c) 2024 Liam Cottle

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
