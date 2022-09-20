import * as net from "net";
export type IReliableConnectOpts = {
  retryDelayTime?: number;
  maxRetryTimes?: number;
};
export type IReliableConnectCallback = (socket: net.Socket) => void;
export class ReliableSocket {
  private options: net.NetConnectOpts;
  private reliableConnectOpts: IReliableConnectOpts;
  private socket: net.Socket;
  private callbackQueue: IReliableConnectCallback[] = [];
  public getSocket(callback: IReliableConnectCallback) {
    this.callbackQueue.push(callback);
    this.tryCleanCallbackQueue();
  }
  private tryCleanCallbackQueue() {
    if (!this.callbackQueue.length) {
      return;
    }
    const { readyState } = this.socket;
    if (readyState === "opening") {
      return;
    }
    if (readyState === "closed") {
      this.connect();
      return;
    }
    while (this.callbackQueue.length) {
      this.callbackQueue.splice(this.callbackQueue.length - 1, 1)[0].call(this, this.socket);
    }
  }
  private errorListener = (err: Error) => {
    console.log("error", err);
    const { maxRetryTimes, retryDelayTime } = this.reliableConnectOpts;
    if (maxRetryTimes === 0) {
      console.log("失败次数过多");
      throw err;
    }
    if (this.reliableConnectOpts.maxRetryTimes !== undefined) {
      this.reliableConnectOpts.maxRetryTimes--;
    }
    console.log(`${retryDelayTime || 0}毫秒后重试，剩余${maxRetryTimes ?? "无限"}次`);
    setTimeout(() => this.connect(), retryDelayTime || 0);
  };
  private connect() {
    this.socket = net.connect(this.options);
    this.socket.once("connect", () => {
      this.tryCleanCallbackQueue();
      this.socket.removeListener("error", this.errorListener);
    });
    this.socket.once("error", this.errorListener);
    return this.socket;
  }
  constructor(options: net.NetConnectOpts, reliableConnectOpts?: IReliableConnectOpts) {
    this.options = options;
    this.reliableConnectOpts = reliableConnectOpts || {};
    this.socket = this.connect();
  }
}
