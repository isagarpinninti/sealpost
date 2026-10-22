/** Tiny, dependency-free terminal styling. Respects NO_COLOR and non-TTY output. */
export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  color: boolean;
  stdin?: () => Promise<string>;
}

const wrap = (io: Io, open: number, close: number) => (s: string): string => (io.color ? `\u001b[${open}m${s}\u001b[${close}m` : s);

export function styles(io: Io) {
  return {
    bold: wrap(io, 1, 22),
    dim: wrap(io, 2, 22),
    red: wrap(io, 31, 39),
    green: wrap(io, 32, 39),
    yellow: wrap(io, 33, 39),
    cyan: wrap(io, 36, 39),
  };
}

export function defaultIo(): Io {
  return {
    out: (t) => process.stdout.write(`${t}\n`),
    err: (t) => process.stderr.write(`${t}\n`),
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    stdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

export const usd = (n: number): string => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n % 1 === 0 ? 0 : 2 });
