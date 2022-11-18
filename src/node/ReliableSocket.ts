import * as net from "net";
export type IReliableConnectOpts = {
  retryDelayTime?: number;
  maxRetryTimes?: number;
  onConnect?: (socket: net.Socket, connectTimes: number) => void;
  onError?: (e: any) => void;
  onClose?: (hadError: boolean) => void | false;
};
export type IReliableConnectCallback = (socket: net.Socket) => void;
export class ReliableSocket {
  private options: net.NetConnectOpts;
  private reliableConnectOpts: IReliableConnectOpts;
  private socket: net.Socket;
  private connectTimes = 0;
  public isClose = false;
  private callbackQueue: IReliableConnectCallback[] = [];

  /** 获取一个socket */
  public getSocket(callback: IReliableConnectCallback) {
    if (this.isClose) {
      throw new Error("ReliableSocket is closed");
    }
    this.callbackQueue.push(callback);
    this.tryCleanCallbackQueue();
  }

  /** getSocket的“同步”版本，写起来更方便，但性能差一点点 */
  public getSocketSync: () => Promise<net.Socket> = () =>
    new Promise((resolve, reject) => {
      try {
        this.getSocket(resolve);
      } catch (e) {
        reject(e);
      }
    });
  private tryCleanCallbackQueue() {
    if (!this.callbackQueue.length || this.isClose) {
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

  private reconnect = () => {
    const { maxRetryTimes, retryDelayTime } = this.reliableConnectOpts;
    if (maxRetryTimes === 0) {
      this.close();
      throw new Error("失败次数过多");
    }
    if (this.reliableConnectOpts.maxRetryTimes !== undefined) {
      this.reliableConnectOpts.maxRetryTimes--;
    }
    // console.log(`${retryDelayTime || 0}毫秒后重试，剩余${maxRetryTimes ?? "无限"}次`);
    setTimeout(() => this.connect(), retryDelayTime || 0);
  };

  private connect() {
    if (this.isClose) {
      return this.socket;
    }
    const errorListener = (e: any) => {
      this.reliableConnectOpts.onError && this.reliableConnectOpts.onError(e);
    };
    const connectListener = () => {
      this.reliableConnectOpts.onConnect && this.reliableConnectOpts.onConnect(this.socket, ++this.connectTimes);
      this.tryCleanCallbackQueue();
      this.reliableConnectOpts.onError && this.socket.once("error", this.reliableConnectOpts.onError);
    };
    this.socket = net.connect(this.options);
    this.socket.once("connect", connectListener);
    this.socket.once("error", errorListener);
    this.socket.once("close", hadError => {
      this.socket.removeListener("connect", connectListener);
      if (this.reliableConnectOpts.onClose && this.reliableConnectOpts.onClose(hadError) === false) {
        return;
      }
      this.reconnect();
    });
    return this.socket;
  }
  constructor(options: net.NetConnectOpts, reliableConnectOpts?: IReliableConnectOpts) {
    this.options = options;
    this.reliableConnectOpts = reliableConnectOpts || {};
    this.socket = this.connect();
  }

  public close() {
    this.isClose = true;
    this.callbackQueue.length = 0;
    if (this.socket.readyState !== "closed") {
      this.socket.end();
      return;
    }
  }
}

// 测试用例
// const reliableSocket = new ReliableSocket(
//   { port: 80, host: "127.0.0.1" },
//   {
//     onConnect(socket, times) {
//       console.log("连接成功", times);
//     },
//     onError(e) {
//       //console.error(e);
//     },
//     onClose() {
//       // console.log("已关闭");
//     },
//   }
// );
// const fn = async () => {
//   const sock = await reliableSocket.getSocketSync();
//   console.log("socket:", sock.readyState);
//   setTimeout(() => {
//     fn();
//   }, 10000);
// };
// fn();
