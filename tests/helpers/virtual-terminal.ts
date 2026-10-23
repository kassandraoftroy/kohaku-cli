/** Minimal VT screen for testing scrolling, cursor movement, erasure and autowrap. */
export class VirtualTerminal {
  private screen: string[][];
  private history: string[][] = [];
  private row: number;
  private column = 0;
  private saved = [0, 0];

  constructor(private columns: number, private rows: number) {
    this.screen = Array.from({ length: rows }, () => []);
    this.row = rows - 1; // Reproduce a progress block starting at the bottom.
  }

  private newline() {
    this.row++;
    if (this.row >= this.rows) {
      this.history.push(this.screen.shift()!);
      this.screen.push([]);
      this.row = this.rows - 1;
    }
  }

  write(output: string) {
    const chars = Array.from(output);
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i]!;
      if (char === "\x1b") {
        if (chars[i + 1] === "7") {
          this.saved = [this.row, this.column];
          i++;
          continue;
        }
        if (chars[i + 1] === "8") {
          [this.row, this.column] = this.saved as [number, number];
          i++;
          continue;
        }
        const sequence = chars.slice(i).join("").match(/^\x1b\[([?\d;]*)([a-zA-Z])/);
        if (!sequence) throw new Error("Unhandled terminal escape");
        const amount = Number(sequence[1]) || 1;
        if (sequence[2] === "A") this.row = Math.max(0, this.row - amount);
        else if (sequence[2] === "D") this.column = Math.max(0, this.column - amount);
        else if (sequence[2] === "J") {
          this.screen[this.row] = this.screen[this.row]!.slice(0, this.column);
          for (let next = this.row + 1; next < this.rows; next++) this.screen[next] = [];
        } else if (sequence[2] === "K") this.screen[this.row] = [];
        else if (sequence[2] !== "l" && sequence[2] !== "h") {
          throw new Error(`Unhandled terminal command ${sequence[2]}`);
        }
        i += sequence[0].length - 1;
      } else if (char === "\r") this.column = 0;
      else if (char === "\n") this.newline();
      else {
        if (this.column >= this.columns) {
          this.column = 0;
          this.newline();
        }
        this.screen[this.row]![this.column++] = char;
      }
    }
  }

  get text() {
    return [...this.history, ...this.screen].map((line) => line.join("")).join("\n");
  }
}
