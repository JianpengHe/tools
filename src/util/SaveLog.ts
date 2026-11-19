import * as fs from "fs";
import { afterExit } from "./afterExit";
export class SaveLog {
  private readonly filePath: string;
  public saveInterval: number;
  public log: any[] = [];
  constructor(filePath: string = (require.main?.filename || process.argv[1]) + "_log.json", saveInterval = 5000) {
    this.filePath = filePath;
    this.saveInterval = saveInterval;
    afterExit(() => fs.writeFileSync(this.filePath, JSON.stringify(this.log, null, 2)));
    try {
      this.log = JSON.parse(String(fs.readFileSync(filePath)));
    } catch (e) {}
  }
  private needSave = false;
  public save() {
    this.needSave = false;
    this.nextSaveTime = new Date().getTime() + this.saveInterval;
    fs.writeFile(this.filePath, JSON.stringify(this.log, null, 2), () => {});
  }
  private nextSaveTime = 0;
  public add(data) {
    this.log.push(data);
    const now = new Date().getTime();
    if (this.nextSaveTime < now) {
      this.save();
    } else if (!this.needSave) {
      this.needSave = true;
      setTimeout(() => this.save(), this.nextSaveTime - now);
    }
  }
}

// 测试用例
// const saveLog = new SaveLog("t.json");
// saveLog.add({ a: 1 });
// setTimeout(() => {
//   saveLog.add({ b: 1 });
// }, 2000);
