import { Console, EConsoleStyle } from "./Console";

export class ShowTransferProgress {
  private startTime: number;
  private title: string;
  private filesize: number;
  private totalSize: number;
  private showedFilesize: number;
  private showedTime: number;
  private timer: number;
  private console: Console;
  constructor(title = "ShowTransferProgress", totalSize = 0, interval = 1000, console = new Console()) {
    this.startTime = new Date().getTime();
    this.title = title;
    this.filesize = 0;
    this.totalSize = totalSize;
    this.showedFilesize = 0;
    this.showedTime = this.startTime;
    this.timer = Number(setInterval(this.setInterval.bind(this), interval));
    this.console = console;
  }
  add(filesize: number) {
    this.filesize += filesize;
    if (this.totalSize === this.filesize) {
      this.end();
    }
  }
  setInterval() {
    const now = new Date().getTime();
    const speed = ((this.filesize - this.showedFilesize) * 1000) / (now - this.showedTime);
    const time = Math.ceil((this.totalSize - this.filesize) / speed);
    this.console.write(
      `瞬间速度 ${this.showSize(speed)}/s` +
        ` 平均速度 ${this.showSize((this.filesize * 1000) / (now - this.startTime))}/s` +
        (this.totalSize
          ? ` ${Console.getProgressBar(this.filesize / this.totalSize)} ${(
              (this.filesize * 100) /
              this.totalSize
            ).toFixed(2)}%` +
            ` 剩余大小 ${this.showSize(this.totalSize - this.filesize)}` +
            ` 剩余时间 ${speed ? String((time / 60) | 0).padStart(2, "0") : "--"}:${
              speed ? String(time % 60).padStart(2, "0") : "--"
            }`
          : "") +
        Console.setStringColor(" " + this.title, EConsoleStyle.blue)
    );
    this.showedFilesize = this.filesize;
    this.showedTime = now;
  }
  end() {
    clearInterval(this.timer);
    this.setInterval();
    this.console.reset();
  }
  showSize(byte: number) {
    return "kMGTP"
      .split("")
      .reduce((a, b) => (Number(a[0]) > 1024 ? [Number(a[0]) / 1024, b + "iB"] : a), [byte, "B"])
      .map((a, i) =>
        i
          ? a
          : Console.setStringColor(
              `${(a = String(a))}${a.includes(".") ? "" : "."}`.substring(0, 6).padEnd(6, "0"),
              EConsoleStyle.yellow
            )
      )
      .join(" ")
      .trim();
  }
}
