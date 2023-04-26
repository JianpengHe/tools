export class ShowTransferProgress {
  private startTime: number;
  private title: string;
  private filesize: number;
  private totalSize: number;
  private showedFilesize: number;
  private showedTime: number;
  private timer: NodeJS.Timer;
  constructor(title = "ShowTransferProgress", totalSize = 0, interval = 1000) {
    this.startTime = new Date().getTime();
    this.title = title;
    this.filesize = 0;
    this.totalSize = totalSize;
    this.showedFilesize = 0;
    this.showedTime = this.startTime;
    this.timer = setInterval(this.setInterval.bind(this), interval);
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
    console.log(
      "瞬间速度",
      ...this.showSize(speed),
      "/s",
      "平均速度",
      ...this.showSize((this.filesize * 1000) / (now - this.startTime)),
      "/s",
      "剩余大小",
      ...this.showSize(this.totalSize - this.filesize),
      "剩余时间",
      String((time / 60) | 0).padStart(2, "0") + ":" + String(time % 60).padStart(2, "0"),
      "\x1B[34m" + this.title + "\x1B[0m"
    );
    this.showedFilesize = this.filesize;
    this.showedTime = now;
  }
  end() {
    clearInterval(this.timer);
    this.setInterval();
  }
  showSize(byte: number) {
    return "kMGTP"
      .split("")
      .reduce((a, b) => (Number(a[0]) > 1024 ? [Number(a[0]) / 1024, b + "iB"] : a), [byte, "B"])
      .map((a, i) =>
        i ? a : `\x1B[33m${`${(a = String(a))}${a.includes(".") ? "" : "."}`.substring(0, 6).padEnd(6, "0")}\x1B[0m`
      );
  }
}
