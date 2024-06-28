import { Console, EConsoleStyle } from "./Console";
export enum EShowTransferProgressDisplay {
  瞬间速度,
  平均速度,
  进度条,
  剩余大小,
  剩余时间,
  文件名,
}
export type IShowTransferProgressOpt = {
  title?: string; //"ShowTransferProgress",
  totalSize?: number; // 0
  interval?: number; // 1000
  console?: Console; //  new Console()
  display?: (EShowTransferProgressDisplay | (() => string))[];
};
export class ShowTransferProgress {
  private startTime = new Date().getTime();
  private filesize = 0;
  private showedFilesize = 0;
  private showedTime: number;
  private timer: number;
  private opt: Required<IShowTransferProgressOpt>;
  constructor(opt: IShowTransferProgressOpt) {
    opt.console = opt.console ?? new Console();
    opt.display =
      opt.display ??
      (opt.totalSize
        ? [
            EShowTransferProgressDisplay.瞬间速度,
            EShowTransferProgressDisplay.平均速度,
            EShowTransferProgressDisplay.进度条,
            EShowTransferProgressDisplay.剩余大小,
            EShowTransferProgressDisplay.剩余时间,
            EShowTransferProgressDisplay.文件名,
          ]
        : [
            EShowTransferProgressDisplay.瞬间速度,
            EShowTransferProgressDisplay.平均速度,
            EShowTransferProgressDisplay.文件名,
          ]);
    this.opt = {
      title: "ShowTransferProgress",
      totalSize: 0,
      interval: 0,
      ...opt,
    } as Required<IShowTransferProgressOpt>;
    this.showedTime = this.startTime;
    this.timer = Number(setInterval(this.setInterval.bind(this), opt.interval ?? 1000));
  }
  public add(filesize: number) {
    this.filesize += filesize;
    if (this.opt.totalSize === this.filesize) {
      this.end();
    }
  }
  private setInterval() {
    const now = new Date().getTime();
    const speed = ((this.filesize - this.showedFilesize) * 1000) / (now - this.showedTime);
    const time = Math.ceil((this.opt.totalSize - this.filesize) / speed);
    const showTransferProgressDisplay: { [x in EShowTransferProgressDisplay]: () => string } = {
      [EShowTransferProgressDisplay.瞬间速度]: () => `瞬间速度 ${ShowTransferProgress.showSize(speed)}/s`,
      [EShowTransferProgressDisplay.平均速度]: () =>
        `平均速度 ${ShowTransferProgress.showSize((this.filesize * 1000) / (now - this.startTime))}/s`,
      [EShowTransferProgressDisplay.进度条]: () =>
        `${Console.getProgressBar(this.filesize / this.opt.totalSize)} ${(
          (this.filesize * 100) /
          this.opt.totalSize
        ).toFixed(2)}%`,
      [EShowTransferProgressDisplay.剩余大小]: () =>
        `剩余大小 ${ShowTransferProgress.showSize(this.opt.totalSize - this.filesize)}`,
      [EShowTransferProgressDisplay.剩余时间]: () =>
        `剩余时间 ${speed ? String((time / 60) | 0).padStart(2, "0") : "--"}:${
          speed ? String(time % 60).padStart(2, "0") : "--"
        }`,
      [EShowTransferProgressDisplay.文件名]: () => Console.setStringColor(" " + this.opt.title, EConsoleStyle.blue),
    };
    // const writeText=
    this.opt.console.write(
      this.opt.display
        .map(item => (typeof item === "function" ? item() : showTransferProgressDisplay[item]()))
        .join(" ")
    );
    this.showedFilesize = this.filesize;
    this.showedTime = now;
  }
  public end() {
    clearInterval(this.timer);
    this.setInterval();
    this.opt.console.reset();
  }
  static showSize(byte: number) {
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
