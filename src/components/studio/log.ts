export interface TerminalEvent {
  id: number;
  at: string;
  kind: "info" | "ok" | "warn" | "err";
  text: string;
}

export type LogFn = (kind: TerminalEvent["kind"], text: string) => void;
