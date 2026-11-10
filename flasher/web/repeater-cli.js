// The repeater's serial command line, as examples/simple_repeater/main.cpp runs it: every
// character sent is echoed (but "\n"), a "\r" ends the command, the board prints "\n", then
// "  -> <reply>\r\n" if the reply isn't empty. A reply can run over several lines ("region"),
// or print lines without the arrow ("get acl"), and nothing marks its end; so each command is
// followed by "ver", whose echo and answer mark where the first command's output stops.

import { LinkTimeout } from "./serial-link.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const ARROW = "  -> ";

function lines(link) {
  const all = dec.decode(link.buf).split("\n");
  all.pop(); // the part after the last "\n" isn't a whole line yet
  return all.map((l) => l.replace(/\r$/, ""));
}

function replyOf(out) {
  while (out.length && out[out.length - 1] === "") out.pop();
  if (out.length && out[0].startsWith(ARROW)) {
    return [out[0].slice(ARROW.length), ...out.slice(1)].join("\n");
  }
  return null;
}

export class RepeaterCli {
  constructor(link) {
    this.link = link;
  }

  // Waits until the firmware answers "ver" (its version and build date), after its start-up.
  async sync(totalMs) {
    const until = Date.now() + totalMs;
    while (Date.now() < until) {
      this.link.clear();
      await this.link.write(enc.encode("ver\r"));
      try {
        return await this.link.waitFor((l) => {
          const ls = lines(l);
          for (let i = 0; i + 1 < ls.length; i++) {
            if (ls[i].endsWith("ver") && ls[i + 1].startsWith(ARROW) && ls[i + 1].includes("(Build:")) {
              return ls[i + 1].slice(ARROW.length);
            }
          }
          return undefined;
        }, Math.min(1500, Math.max(100, until - Date.now())));
      } catch (e) {
        if (!(e instanceof LinkTimeout)) throw e;
      }
    }
    throw new LinkTimeout("the repeater firmware didn't answer");
  }

  // Runs one command; resolves with { reply, lines }.
  async run(cmd, timeoutMs = 6000) {
    if (/[\r\n]/.test(cmd)) throw new Error("a command is one line");
    this.link.clear();
    await this.link.write(enc.encode(`${cmd}\rver\r`));
    return this.link.waitFor((l) => {
      const ls = lines(l);
      const start = ls.indexOf(cmd);
      if (start < 0) return undefined;
      for (let j = start + 1; j + 1 < ls.length; j++) {
        if (ls[j] === "ver" && ls[j + 1].startsWith(ARROW)) {
          const out = ls.slice(start + 1, j);
          return { reply: replyOf([...out]), lines: out };
        }
      }
      return undefined;
    }, timeoutMs);
  }

  // "reboot" answers nothing: the board restarts at once (CommonCLI.cpp, _board->reboot()).
  async reboot() {
    this.link.clear();
    await this.link.write(enc.encode("reboot\r"));
  }
}
