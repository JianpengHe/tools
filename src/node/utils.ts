import * as stream from "stream";
import * as events from "events";
import * as fs from "fs";
import { afterExit } from "./afterExit";
export type IReadStream = stream.Readable | stream.Duplex;
export const recvAll = (stream: IReadStream): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const body: Buffer[] = [];
    stream.on("data", chuck => body.push(chuck));
    stream.once("end", () => resolve(Buffer.concat(body)));
    stream.once("error", reject);
  });

type EmittedEvents = Record<string | symbol, (...args: any) => any>;
export declare interface TypedEventEmitter<Events extends EmittedEvents> {
  addListener<E extends keyof Events>(event: E, listener: Events[E]): this;
  emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>): boolean;
  eventNames<E extends keyof Events>(): E[];
  listenerCount<E extends keyof Events>(eventName: E): number;
  listeners<E extends keyof Events>(eventName: E): Events[E][];
  off<E extends keyof Events>(event: E, listener: Events[E]): this;
  on<E extends keyof Events>(event: E, listener: Events[E]): this;
  once<E extends keyof Events>(event: E, listener: Events[E]): this;
  prependListener<E extends keyof Events>(event: E, listener: Events[E]): this;
  prependOnceListener<E extends keyof Events>(event: E, listener: Events[E]): this;
  removeAllListeners<E extends keyof Events>(eventName?: E): this;
  removeListener<E extends keyof Events>(event: E, listener: Events[E]): this;
  rawListeners<E extends keyof Events>(eventName: E): Events[E][];
}
export class TypedEventEmitter<Events extends EmittedEvents> extends events.EventEmitter {}

export class SaveLog {
  private readonly filePath: string;
  public saveInterval: number;
  public log: any[] = [];
  constructor(filePath: string = __filename + "_log.json", saveInterval = 5000) {
    this.filePath = filePath;
    this.saveInterval = saveInterval;
    try {
      this.log = JSON.parse(String(fs.readFileSync(filePath)));
    } catch (e) {}
    afterExit(() => this.save());
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
