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
  console?: { write: (str: string) => void; reset: () => void }; //  new Console()
  display?: (EShowTransferProgressDisplay | (() => string))[];
};
export class ShowTransferProgress {
  private startTime = performance.now();
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
    if (this.opt.interval !== 0) {
      this.timer = Number(setInterval(this.updateTransferProgressDisplay.bind(this), this.opt.interval));
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
      return;
    }
    /** 如果opt.interval为0，则每次增加数据都同步显示到控制台 */
    if (this.opt.interval === 0) {
      this.updateTransferProgressDisplay();
    }
  }

  public updateTransferProgressDisplay() {
    const now = performance.now();
    const speed = ((this.filesize - this.showedFilesize) * 1000) / (now - this.showedTime);
    /** 平均速度 */
    const avgSpeed = (this.filesize * 1000) / (now - this.startTime);
    /** 剩余大小 */
    const remainingSize = Math.max(0, this.opt.totalSize - this.filesize);
    /** 进度，取值范围0-1 */
    const progress = Math.min(1, Math.max(0, (this.opt.totalSize === 0 ? 0 : this.filesize / this.opt.totalSize) || 0));

    const formatTime = (speed: number, time: number) =>
      speed ? `${String((time / 60) | 0).padStart(2, "0")}:${String(time % 60).padStart(2, "0")}` : "--:--";
    const showTransferProgressDisplay: { [x in EShowTransferProgressDisplay]: () => string } = {
      [EShowTransferProgressDisplay.瞬间速度]: () => `瞬间速度 ${ShowTransferProgress.showSize(speed)}/s`,
      [EShowTransferProgressDisplay.平均速度]: () => `平均速度 ${ShowTransferProgress.showSize(avgSpeed)}/s`,
      [EShowTransferProgressDisplay.进度条]: () =>
        `${Console.getProgressBar(progress)} ${String(progress * 100).substring(0, 5)}%`,
      [EShowTransferProgressDisplay.剩余大小]: () => `剩余大小 ${ShowTransferProgress.showSize(remainingSize)}`,
      [EShowTransferProgressDisplay.剩余时间]: () => `剩余时间 ${formatTime(speed, Math.ceil(remainingSize / speed))}`,
      [EShowTransferProgressDisplay.预估时间]: () =>
        `预估时间 ${formatTime(avgSpeed, Math.ceil(remainingSize / avgSpeed))}`,
      [EShowTransferProgressDisplay.文件名]: () => Console.setStringColor(" " + this.opt.title, EConsoleStyle.cyan),
    };
    // const writeText=
    this.opt.console.write(
      this.opt.display
        .map(item => (typeof item === "function" ? item() : showTransferProgressDisplay[item]()))
        .join(" "),
    );
    this.showedFilesize = this.filesize;
    this.showedTime = now;
  }
  public isEnd = false;
  public end() {
    this.isEnd = true;
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
          ? String(a).padStart(3, " ")
          : Console.setStringColor(
              `${(a = String(a))}${a.includes(".") ? "" : "."}`.substring(0, 6).padEnd(6, "0"),
              EConsoleStyle.yellow,
            ),
      )
      .join(" ")
      .trim();
  }
}

export class ShowTransferProgressMultiple {
  public showTransferProgressList: Set<ShowTransferProgress> = new Set();
  public isEnd = false;
  private timer = 0;
  constructor(
    private interval: number = 0,
    private console: Console = new Console(),
  ) {
    if (interval) this.timer = Number(setInterval(() => this.renderAll(), interval));
  }
  public add(opt: Exclude<IShowTransferProgressOpt, "console"> = {}) {
    if (this.isEnd) throw new Error("已结束");
    const con = {
      write: (str: string) => {
        this.renderMap.set(showTransferProgress, str);
        this.interval === 0 && this.renderAll();
      },
      reset: () => {
        this.interval === 0 && this.renderAll();
        this.showTransferProgressList.delete(showTransferProgress);
        this.renderMap.delete(showTransferProgress);
        if (this.showTransferProgressList.size === 0) {
          this.isEnd = true;
          this.timer && clearInterval(this.timer);
          this.console.reset();
        }
      },
    };
    if (this.interval) opt.interval = 0;
    const showTransferProgress = new ShowTransferProgress({ ...opt, console: con });
    this.showTransferProgressList.add(showTransferProgress);
    this.renderMap.set(showTransferProgress, "");
    return showTransferProgress;
  }
  private renderMap: Map<ShowTransferProgress, string> = new Map();
  private renderAllBusy = false;
  public renderAll() {
    if (this.renderAllBusy) return;
    this.renderAllBusy = true;
    let doneCount = 0;
    for (const [showTransferProgress, str] of this.renderMap) {
      if (str) {
        doneCount++;
        continue;
      }
      showTransferProgress.updateTransferProgressDisplay();
    }
    if (doneCount !== this.showTransferProgressList.size) {
      this.renderAllBusy = false;
      return;
    }
    // console.log("renderAll");
    const strs: string[] = [];
    for (const [showTransferProgress, str] of this.renderMap) {
      strs.push(str);
      this.renderMap.set(showTransferProgress, "");
    }
    this.console.write(strs.join("\n"));
    this.renderAllBusy = false;
  }
}

/** 测试用例 */
// const showTransferProgressMultiple = new ShowTransferProgressMultiple();
// const a1 = showTransferProgressMultiple.add({
//   title: "文件1",
//   totalSize: 100000,
//   interval: 200,
// });
// let a2 = showTransferProgressMultiple.add({
//   title: "文件2",
//   totalSize: 10000,
// });
// setInterval(() => {
//   if (a2.isEnd) {
//     a2 = showTransferProgressMultiple.add({
//       title: "文件" + Math.random(),
//       totalSize: 10000,
//     });
//   }
//   a1.add(100);
//   a2.add(100);
// }, 200);
