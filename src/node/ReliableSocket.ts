/**
 * 可靠Socket连接模块
 * 提供自动重连功能的TCP Socket封装，用于建立稳定的网络连接
 */
import * as net from "net";

/**
 * 可靠连接选项接口
 * 定义ReliableSocket类的配置参数
 */
export type IReliableConnectOpts = {
  /** 重连延迟时间（毫秒） */
  retryDelayTime?: number;
  /** 最大重试次数，undefined表示无限重试 */
  maxRetryTimes?: number;
  /** 连接成功回调函数，提供socket实例和连接次数 */
  onConnect?: (socket: net.Socket, connectTimes: number) => void;
  /** 错误处理回调函数 */
  onError?: (e: any) => void;
  /**
   * 连接关闭回调函数
   * 返回false时将阻止自动重连
   */
  onClose?: (hadError: boolean) => void | false;
};

/**
 * Socket连接回调函数类型
 * 用于在获取socket时执行的回调
 */
export type IReliableConnectCallback = (socket: net.Socket) => void;

/**
 * 可靠Socket连接类
 * 实现了自动重连机制的Socket连接，确保网络连接的稳定性
 */
export class ReliableSocket {
  /** TCP连接选项 */
  private options: net.NetConnectOpts;
  /** 可靠连接的配置选项 */
  private reliableConnectOpts: IReliableConnectOpts;
  /** 当前Socket实例 */
  private socket: net.Socket;
  /** 连接尝试次数计数器 */
  private connectTimes = 0;
  /** 连接是否已关闭的标志 */
  public isClose = false;
  /** 等待获取Socket的回调函数队列 */
  private callbackQueue: IReliableConnectCallback[] = [];

  /**
   * 获取一个socket实例
   * 如果当前没有可用连接，会将回调加入队列，等连接建立后执行
   * @param callback 获取socket后的回调函数
   */
  public getSocket(callback: IReliableConnectCallback) {
    if (this.isClose) {
      throw new Error("ReliableSocket is closed");
    }
    this.callbackQueue.push(callback);
    this.tryCleanCallbackQueue();
  }

  /**
   * getSocket的Promise版本
   * 将回调式API转换为Promise风格，便于使用async/await语法
   * 性能略低于回调版本，但使用更方便
   */
  public getSocketSync: () => Promise<net.Socket> = () =>
    new Promise((resolve, reject) => {
      try {
        this.getSocket(resolve);
      } catch (e) {
        reject(e);
      }
    });

  /**
   * 尝试处理回调队列
   * 当socket连接就绪时，执行所有等待中的回调函数
   * 如果socket未连接，则触发连接过程
   */
  private tryCleanCallbackQueue() {
    // 如果队列为空或连接已关闭，则不处理
    if (!this.callbackQueue.length || this.isClose) {
      return;
    }

    // 获取socket当前状态
    const { readyState } = this.socket;

    // 如果正在连接中，等待连接完成
    if (readyState === "opening") {
      return;
    }

    // 如果连接已关闭，尝试重新连接
    if (readyState === "closed") {
      this.connect();
      return;
    }

    // 连接就绪，执行所有回调函数
    while (this.callbackQueue.length) {
      this.callbackQueue.splice(this.callbackQueue.length - 1, 1)[0].call(this, this.socket);
    }
  }

  /**
   * 重新连接方法
   * 在连接断开后根据配置进行重连
   */
  private reconnect = () => {
    const { maxRetryTimes, retryDelayTime } = this.reliableConnectOpts;

    // 如果达到最大重试次数且最大次数为0，则关闭连接
    if (maxRetryTimes === 0) {
      this.close();
      throw new Error("失败次数过多");
    }

    // 如果设置了最大重试次数，则递减计数
    if (this.reliableConnectOpts.maxRetryTimes !== undefined) {
      this.reliableConnectOpts.maxRetryTimes--;
    }

    // 延迟指定时间后重新连接
    // console.log(`${retryDelayTime || 0}毫秒后重试，剩余${maxRetryTimes ?? "无限"}次`);
    setTimeout(() => this.connect(), retryDelayTime || 0);
  };

  /**
   * 建立连接方法
   * 创建新的socket连接并设置相关事件监听器
   * @returns 创建的socket实例
   */
  private connect() {
    // 如果连接已关闭，直接返回当前socket
    if (this.isClose) {
      return this.socket;
    }

    // 错误处理监听器
    const errorListener = (e: any) => {
      this.reliableConnectOpts.onError && this.reliableConnectOpts.onError(e);
    };

    // 连接成功监听器
    const connectListener = () => {
      // 调用连接成功回调
      this.reliableConnectOpts.onConnect && this.reliableConnectOpts.onConnect(this.socket, ++this.connectTimes);
      // 处理等待队列中的回调
      this.tryCleanCallbackQueue();
      // 设置错误监听器
      this.reliableConnectOpts.onError && this.socket.once("error", this.reliableConnectOpts.onError);
    };

    // 创建新的socket连接
    this.socket = net.connect(this.options);

    // 设置事件监听器
    this.socket.once("connect", connectListener);
    this.socket.once("error", errorListener);

    // 监听连接关闭事件
    this.socket.once("close", hadError => {
      // 移除连接监听器，避免内存泄漏
      this.socket.removeListener("connect", connectListener);

      // 调用关闭回调，如果返回false则不重连
      if (this.reliableConnectOpts.onClose && this.reliableConnectOpts.onClose(hadError) === false) {
        return;
      }

      // 触发重连机制
      this.reconnect();
    });

    return this.socket;
  }

  /**
   * 构造函数
   * 创建ReliableSocket实例并立即尝试建立连接
   * @param options TCP连接选项，包含host、port等参数
   * @param reliableConnectOpts 可靠连接选项，包含重试策略和回调函数
   */
  constructor(options: net.NetConnectOpts, reliableConnectOpts?: IReliableConnectOpts) {
    this.options = options;
    this.reliableConnectOpts = reliableConnectOpts || {};
    this.socket = this.connect();
  }

  /**
   * 关闭连接方法
   * 终止当前连接并清空回调队列
   */
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
