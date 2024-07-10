import { Console, EConsoleStyle } from "./Console";
export enum EShowTransferProgressDisplay {
  瞬间速度,
  平均速度,
  进度条,
  剩余大小,
  剩余时间,
  预估时间,
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
  public opt: Required<IShowTransferProgressOpt>;
  constructor(opt: IShowTransferProgressOpt = {}) {
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
            EShowTransferProgressDisplay.预估时间,
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
      interval: 1000,
      ...opt,
    } as Required<IShowTransferProgressOpt>;
    this.showedTime = this.startTime;

    /** 如果opt.interval不为0，则开启自动循环显示 */
    if (opt.interval !== 0) {
      this.timer = Number(setInterval(this.updateTransferProgressDisplay.bind(this), opt.interval));
    } else {
      this.timer = 0;
    }
  }

  /** 追加大小 */
  public add(filesize: number) {
    this.filesize += filesize;
    this.update();
  }

  /** 设置已完成的大小 */
  public set(filesize: number) {
    this.filesize = filesize;
    this.update();
  }

  private update() {
    if (this.opt.totalSize === this.filesize) {
      this.end();
    }
    /** 如果opt.interval为0，则每次增加数据都同步显示到控制台 */
    if (this.opt.interval === 0) {
      this.updateTransferProgressDisplay();
    }
  }

  public updateTransferProgressDisplay() {
    const now = new Date().getTime();
    const speed = ((this.filesize - this.showedFilesize) * 1000) / (now - this.showedTime);
    /** 平均速度 */
    const avgSpeed = (this.filesize * 1000) / (now - this.startTime);
    /** 剩余大小 */
    const remainingSize = Math.max(0, this.opt.totalSize - this.filesize);
    /** 进度，取值范围0-1 */
    const progress = this.opt.totalSize === 0 ? 0 : this.filesize / this.opt.totalSize;

    const formatTime = (speed: number, time: number) =>
      speed ? `${String((time / 60) | 0).padStart(2, "0")}:${String(time % 60).padStart(2, "0")}` : "--:--";
    const showTransferProgressDisplay: { [x in EShowTransferProgressDisplay]: () => string } = {
      [EShowTransferProgressDisplay.瞬间速度]: () => `瞬间速度 ${ShowTransferProgress.showSize(speed)}/s`,
      [EShowTransferProgressDisplay.平均速度]: () => `平均速度 ${ShowTransferProgress.showSize(avgSpeed)}/s`,
      [EShowTransferProgressDisplay.进度条]: () =>
        `${Console.getProgressBar(progress)} ${(progress * 100).toFixed(2)}%`,
      [EShowTransferProgressDisplay.剩余大小]: () => `剩余大小 ${ShowTransferProgress.showSize(remainingSize)}`,
      [EShowTransferProgressDisplay.剩余时间]: () => `剩余时间 ${formatTime(speed, Math.ceil(remainingSize / speed))}`,
      [EShowTransferProgressDisplay.预估时间]: () =>
        `预估时间 ${formatTime(avgSpeed, Math.ceil(remainingSize / avgSpeed))}`,
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
    this.timer && clearInterval(this.timer);
    this.updateTransferProgressDisplay();
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
