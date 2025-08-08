/**
 * 工具函数模块
 * 提供各种通用工具函数和类型定义，用于简化常见操作
 */
import * as stream from "stream";
import * as events from "events";
import * as crypto from "crypto";
import * as child_process from "child_process";

/**
 * 可读流接口类型
 * 表示一个可读取数据的流，可以是纯可读流或双工流
 */
export type IReadStream = stream.Readable | stream.Duplex;

/**
 * 接收流中的所有数据并返回完整的Buffer
 * @param stream 输入的可读流
 * @returns 包含流中所有数据的Promise<Buffer>
 */
export const recvAll = (stream: IReadStream): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const body: Buffer[] = [];
    // 监听数据事件，将每个数据块添加到数组中
    stream.on("data", chuck => body.push(chuck));
    // 流结束时，将所有数据块合并为一个Buffer并解析Promise
    stream.once("end", () => resolve(Buffer.concat(body)));
    // 处理错误情况
    stream.once("error", reject);
  });

/**
 * 事件发射器的事件类型定义
 * 用于TypedEventEmitter的类型参数，提供类型安全的事件处理
 */
type EmittedEvents = Record<string | symbol, (...args: any) => any>;

/**
 * 类型化的事件发射器接口
 * 扩展了标准EventEmitter，提供类型安全的事件处理方法
 * @template Events 事件映射类型，定义事件名称和对应的处理函数类型
 */
export declare interface TypedEventEmitter<Events extends EmittedEvents> {
  /**
   * 添加事件监听器
   * @param event 事件名称
   * @param listener 事件处理函数
   */
  addListener<E extends keyof Events & (string | symbol)>(event: E, listener: Events[E]): this;

  /**
   * 触发事件
   * @param event 事件名称
   * @param args 传递给事件处理函数的参数
   */
  emit<E extends keyof Events & (string | symbol)>(event: E, ...args: Parameters<Events[E]>): boolean;

  /**
   * 获取所有已注册事件的名称
   */
  eventNames<E extends keyof Events & (string | symbol)>(): E[];

  /**
   * 获取指定事件的监听器数量
   * @param eventName 事件名称
   */
  listenerCount<E extends keyof Events & (string | symbol)>(eventName: E): number;

  /**
   * 获取指定事件的所有监听器
   * @param eventName 事件名称
   */
  listeners<E extends keyof Events & (string | symbol)>(eventName: E): Events[E][];

  /**
   * 移除事件监听器（同removeListener）
   * @param event 事件名称
   * @param listener 要移除的监听器函数
   */
  off<E extends keyof Events & (string | symbol)>(event: E, listener: Events[E]): this;

  /**
   * 添加事件监听器
   * @param event 事件名称
   * @param listener 事件处理函数
   */
  on<E extends keyof Events & (string | symbol)>(event: E, listener: Events[E]): this;

  /**
   * 添加一次性事件监听器，触发后自动移除
   * @param event 事件名称
   * @param listener 事件处理函数
   */
  once<E extends keyof Events & (string | symbol)>(event: E, listener: Events[E]): this;

  /**
   * 在监听器队列开头添加事件监听器
   * @param event 事件名称
   * @param listener 事件处理函数
   */
  prependListener<E extends keyof Events & (string | symbol)>(event: E, listener: Events[E]): this;

  /**
   * 在监听器队列开头添加一次性事件监听器
   * @param event 事件名称
   * @param listener 事件处理函数
   */
  prependOnceListener<E extends keyof Events & (string | symbol)>(event: E, listener: Events[E]): this;

  /**
   * 移除指定事件的所有监听器
   * @param eventName 事件名称（可选）
   */
  removeAllListeners<E extends keyof Events & (string | symbol)>(eventName?: E): this;

  /**
   * 移除指定的事件监听器
   * @param event 事件名称
   * @param listener 要移除的监听器函数
   */
  removeListener<E extends keyof Events & (string | symbol)>(event: E, listener: Events[E]): this;

  /**
   * 获取指定事件的原始监听器（包括包装器）
   * @param eventName 事件名称
   */
  rawListeners<E extends keyof Events & (string | symbol)>(eventName: E): Events[E][];
}

/**
 * 类型化的事件发射器类
 * 继承自Node.js的EventEmitter，但提供类型安全的事件处理
 * @template Events 事件映射类型
 */
export class TypedEventEmitter<Events extends EmittedEvents> extends events.EventEmitter {}

/**
 * 计算数据的哈希值
 * 重载1: 返回Buffer类型的哈希值
 * @param algorithm 哈希算法名称（如'md5'、'sha1'、'sha256'等）
 * @param data 要计算哈希的数据
 * @returns Buffer类型的哈希值
 */
export function getHash(algorithm: string, data: crypto.BinaryLike): Buffer;

/**
 * 计算数据的哈希值
 * 重载2: 返回指定编码的字符串哈希值
 * @param algorithm 哈希算法名称
 * @param data 要计算哈希的数据
 * @param encoding 输出编码（如'hex'、'base64'等）
 * @returns 指定编码的字符串哈希值
 */
export function getHash(algorithm: string, data: crypto.BinaryLike, encoding: crypto.BinaryToTextEncoding): string;

/**
 * 计算数据的哈希值（实现）
 * @param algorithm 哈希算法名称
 * @param data 要计算哈希的数据
 * @param encoding 可选的输出编码
 * @returns 哈希值，根据是否提供encoding返回Buffer或字符串
 */
export function getHash(
  algorithm: string,
  data: crypto.BinaryLike,
  encoding?: crypto.BinaryToTextEncoding,
): string | Buffer {
  // 创建哈希对象并更新数据
  const hash = crypto.createHash(algorithm).update(data);
  // 根据是否提供编码返回不同类型的结果
  if (encoding) {
    return hash.digest(encoding);
  }
  return hash.digest();
}

/**
 * 延时函数
 * 返回一个Promise，在指定时间后解析
 * @param time 延时时间（毫秒）
 * @returns 延时Promise
 */
export const sleep = (time: number) => new Promise(resolve => setTimeout(resolve, time));

/**
 * 执行命令行命令并忽略错误
 * 无论命令是否执行成功都会返回输出结果，不会抛出异常
 * @param command 要执行的命令
 * @param options 命令执行选项
 * @returns 包含命令输出的Promise
 */
export const childProcessExecIgnoreError = (command: string, options?: child_process.ExecOptions) =>
  new Promise<string>(resolve =>
    child_process.exec(command, options || {}, (error, data) => resolve(String(data || ""))),
  );

/**
 * 执行命令行命令
 * 如果命令执行失败会抛出异常
 * @param command 要执行的命令
 * @param options 命令执行选项
 * @returns 包含命令输出的Promise
 * @throws 如果命令执行失败，抛出包含错误信息的Error
 */
export const childProcessExec = (command: string, options?: child_process.ExecOptions) =>
  new Promise<string>((resolve, reject) =>
    child_process.exec(command, options || {}, (error, stdout, stderr) =>
      error
        ? reject(new Error(String(stdout || "") || String(stderr) || String(error)))
        : resolve(String(stdout || "")),
    ),
  );
