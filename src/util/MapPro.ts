/**
 * 利用 unique symbol 给 Promise 打上品牌标记，
 * 配合 NotPromise 类型，在编译期阻止 V 为 Promise 实例
 */
declare const __promiseBrand: unique symbol;

declare global {
  /** 给全局 Promise 接口注入品牌属性，使其与 NotPromise 互斥 */
  interface Promise<T> {
    readonly [__promiseBrand]: true;
  }
}

/**
 * "非 Promise" 守卫类型
 * - [__promiseBrand]?: never  → 与 Promise 的 true 冲突，编译期排除 Promise
 * - toString?: unknown        → 避免触发 TS2559 弱类型检查报错（纯可选属性对象需要至少一个已知属性）
 */
type NotPromise = {
  readonly [__promiseBrand]?: never;
  toString?: unknown;
};

/** 缓存淘汰策略枚举 */
export enum EMapProEvictionPolicy {
  /** 不淘汰 */
  NONE,
  /** 先进先出：最早插入的最先被淘汰 */
  FIFO,
  /** 最近最少使用：最久没被访问的最先被淘汰 */
  LRU,
  /** 空闲存活时间：超过 cacheTime 未被访问的会被定时器清除 */
  IDLE_TTL,
}

/** MapPro 配置项 */
export type IMapProOptions<K, V> = {
  /**
   * 自动初始化函数：调用 get/getObj 时，若 key 对应的 value 为 undefined，
   * 会调用此函数生成初始值并缓存。支持同步和异步返回。
   */
  init?: (key: K) => V | Promise<V>;
  /** 缓存淘汰策略 */
  readonly evictionPolicy: EMapProEvictionPolicy;
  /** 缓存最大数量，仅在 FIFO / LRU 策略下生效（默认 Infinity，即不限制） */
  cacheSize: number;
  /** 缓存空闲存活时间（毫秒），仅在 IDLE_TTL 策略下生效（默认 0，即不启用） */
  cacheTime: number;
  /** 节点被淘汰前的回调，可用于资源清理等 */
  beforeDelete?: (key: K, value: V | undefined) => void;
};

/**
 * 双向链表节点，同时作为 Map 中的值对象
 * - key / value：缓存的键值
 * - pending：异步 init 返回的 Promise（用于去重，同一个 key 只会有一个 pending）
 * - prev / next：双向链表指针，用于维护 FIFO / LRU / IDLE_TTL 的淘汰顺序
 * - timestamp：最后一次访问的时间戳，仅 IDLE_TTL 策略使用
 */
export type IMapProValue<K, V> = {
  key: K;
  value: V | undefined;
  pending: Promise<V> | undefined;
  prev: IMapProValue<K, V> | null;
  next: IMapProValue<K, V> | null;
  timestamp: number;
};

/**
 * 增强版 Map，支持自动初始化（同步/异步）、多种缓存淘汰策略。
 *
 * 内部结构：HashMap + 双向链表
 * - HashMap 提供 O(1) 查找
 * - 双向链表维护淘汰顺序（头部最新，尾部最旧）
 *
 * 类型约束：V 不能是 undefined，不能是 Promise 实例（可以是 null）
 */
export class MapPro<K, V extends NotPromise | null> {
  /** 核心存储：key → 链表节点 */
  private readonly map: Map<K, IMapProValue<K, V>> = new Map();
  /** 双向链表头节点（最新/最近访问） */
  private firstNode: IMapProValue<K, V> | null = null;
  /** 双向链表尾节点（最旧/最久未访问，优先淘汰） */
  private endNode: IMapProValue<K, V> | null = null;
  /** IDLE_TTL 策略下的定时清理器 */
  private timer: NodeJS.Timeout | null = null;
  private readonly opt: IMapProOptions<K, V>;

  constructor(opt: Partial<IMapProOptions<K, V>> = {}) {
    this.opt = { cacheSize: Infinity, cacheTime: 0, evictionPolicy: EMapProEvictionPolicy.NONE, ...opt };
    // 防御性修正：非法的 cacheSize 视为不限制
    if (Number.isNaN(this.opt.cacheSize) || this.opt.cacheSize <= 0) this.opt.cacheSize = Infinity;
    // 防御性修正：非法的 cacheTime 视为不启用
    if (!Number.isFinite(this.opt.cacheTime) || this.opt.cacheTime < 0) this.opt.cacheTime = 0;
  }

  /**
   * 获取 key 对应的完整节点对象（包含 value、pending 等元信息）
   * - 如果 key 已存在：根据策略更新访问记录，必要时触发 init
   * - 如果 key 不存在：创建节点（可传入初始 value），加入链表，触发淘汰检查，必要时触发 init
   */
  public getObj(key: K, value?: V) {
    const obj = this.map.get(key);
    const evictionPolicy = this.opt.evictionPolicy;

    if (obj) {
      // 已存在的节点：根据策略刷新访问记录
      if (evictionPolicy === EMapProEvictionPolicy.IDLE_TTL) {
        // IDLE_TTL：刷新时间戳 + 移到链表头部（延长存活）
        obj.timestamp = Date.now();
        this.moveNodeToFirst(obj);
      } else if (evictionPolicy === EMapProEvictionPolicy.LRU) {
        // LRU：移到链表头部（标记为最近使用）
        // 注意：FIFO 不移动，保持插入顺序
        this.moveNodeToFirst(obj);
      }
      // 如果 value 还没初始化（比如上次异步 init 失败了），重新尝试
      if (obj.value === undefined && this.opt.init) this.init(key, obj);
      return obj;
    }

    // key 不存在：创建节点
    const emptyObj: IMapProValue<K, V> = { key, value, pending: undefined, prev: null, next: null, timestamp: 0 };
    this.map.set(key, emptyObj);

    // IDLE_TTL：记录创建时间戳（TTL 从请求时算起）
    if (evictionPolicy === EMapProEvictionPolicy.IDLE_TTL) emptyObj.timestamp = Date.now();
    if (evictionPolicy !== EMapProEvictionPolicy.NONE) {
      // 新节点插入链表头部，并检查是否需要淘汰旧节点
      this.moveNodeToFirst(emptyObj);
      this.tryToDeleteNode();
    }
    // IDLE_TTL：首次插入时启动定时清理器
    if (evictionPolicy === EMapProEvictionPolicy.IDLE_TTL && !this.timer && this.opt.cacheTime > 0)
      this.timer = setInterval(this.timerFn.bind(this), this.opt.cacheTime);
    // 如果 value 为 undefined 且有 init 函数，触发自动初始化
    if (emptyObj.value === undefined && this.opt.init) this.init(key, emptyObj);
    return emptyObj;
  }

  /** 获取 key 对应的值，同步返回。若异步 init 尚未完成，返回 undefined */
  public get(key: K): V | undefined {
    return this.getObj(key).value;
  }

  /**
   * 异步获取 key 对应的值
   * - 如果 value 已就绪，直接返回
   * - 如果有 pending 的异步 init，等待其完成后返回
   * - 支持可选的回调函数
   */
  public async getAsync(key: K, callBack?: (value: V | undefined) => void) {
    const { value, pending } = this.getObj(key);
    const result = value ?? (await pending);
    callBack?.(result);
    return result;
  }

  /**
   * 手动触发 key 的初始化（也会被 getObj 在必要时自动调用）
   * - 如果已有 pending 的异步 init，直接返回该 Promise（去重，避免重复执行）
   * - 如果 value 已存在，直接返回 value
   * - 否则调用 opt.init 生成值，支持同步和异步
   */
  public init(key: K, obj = this.getObj(key)) {
    // 去重：已有 pending 的异步 init，直接复用
    if (obj.pending) return obj.pending;
    // 已有值，无需再初始化
    if (obj.value !== undefined) return obj.value;

    const pending = this.opt.init?.(key);
    if (pending instanceof Promise) {
      // 异步 init：设置 pending，完成后写入 value（需校验节点仍在 map 中）
      pending
        .then((value: V) => {
          if (value !== undefined && this.map.get(key) === obj) obj.value = value;
        })
        .catch(console.error)
        .finally(() => (obj.pending = undefined));
      obj.pending = pending;
      return pending;
    }
    // 同步 init：直接写入 value
    if (pending !== undefined) obj.value = pending;
    return obj.value;
  }

  /**
   * 将节点移到双向链表头部
   * 链表结构：firstNode ↔ ... ↔ endNode
   * 头部 = 最新/最近访问，尾部 = 最旧/最久未访问
   */
  private moveNodeToFirst(node: IMapProValue<K, V>) {
    // 已经是头节点，无需移动
    if (node === this.firstNode) return;

    // 1. 如果是尾节点，先把 endNode 前移
    if (node === this.endNode) this.endNode = node.prev;

    // 2. 将 node 从原位置断开（修复前后节点的指针）
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;

    // 3. 插入到链表头部
    node.prev = null;
    node.next = this.firstNode;
    if (this.firstNode) this.firstNode.prev = node;
    this.firstNode = node;

    // 4. 防御性处理：如果原本链表为空，同时设置 endNode
    if (!this.endNode) this.endNode = node;
  }

  /** 删除链表尾节点（即最旧/最久未访问的节点），同时从 map 中移除 */
  private deleteEndNode() {
    if (this.endNode) {
      this.opt.beforeDelete?.(this.endNode.key, this.endNode.value);
      this.map.delete(this.endNode.key);
      // 尾节点前移
      this.endNode = this.endNode.prev;
      if (this.endNode) this.endNode.next = null;
      else this.firstNode = null; // 链表已空
      if (this.firstNode) this.firstNode.prev = null;
    }
    // 如果 map 已清空，停止定时器
    if (this.map.size <= 0) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 根据淘汰策略尝试删除过期/超量的节点 */
  private tryToDeleteNode() {
    let node: IMapProValue<K, V> | null;
    switch (this.opt.evictionPolicy) {
      case EMapProEvictionPolicy.NONE:
        return;
      case EMapProEvictionPolicy.FIFO:
      case EMapProEvictionPolicy.LRU:
        // 超出 cacheSize 时，从尾部开始淘汰
        while (this.map.size > this.opt.cacheSize) this.deleteEndNode();
        return;
      case EMapProEvictionPolicy.IDLE_TTL:
        // 淘汰所有超过 cacheTime 未被访问的节点
        const expTime = Date.now() - this.opt.cacheTime;
        while ((node = this.endNode) && node.timestamp < expTime) this.deleteEndNode();
        return;
    }
  }

  /** IDLE_TTL 定时器回调：定期清理过期节点，map 清空时自动停止定时器 */
  private timerFn() {
    const { cacheTime, evictionPolicy } = this.opt;
    // 安全检查：策略不对或已无数据时，停止定时器
    if (cacheTime === 0 || this.map.size <= 0 || evictionPolicy !== EMapProEvictionPolicy.IDLE_TTL) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    const expTime = Date.now() - cacheTime;
    let node: IMapProValue<K, V> | null;
    while ((node = this.endNode) && node.timestamp < expTime) this.deleteEndNode();
  }

  /** 返回当前缓存的条目数 */
  public size() {
    return this.map.size;
  }

  /** 清空所有缓存，重置链表和定时器 */
  public clear() {
    this.map.clear();
    this.firstNode = null;
    this.endNode = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  /** 判断 key 是否存在（不会触发 init） */
  public has(key: K) {
    return this.map.has(key);
  }

  /** 手动设置 key-value，内部通过 getObj 维护链表和淘汰 */
  public set(key: K, value: V) {
    this.getObj(key, value);
    return this;
  }
}

// 测试用例
const mapPro = new MapPro<number, number>({
  async init(key) {
    console.log("开始初始化", key);
    await new Promise(resolve => setTimeout(resolve, 1000));
    return Math.random();
  },
});
async function getKey(key: number) {
  // return mapPro.get(key) || (await mapPro.init(key));
  const { value, pending } = mapPro.getObj(key);
  return value ?? (await pending);
}

Promise.all([getKey(1), getKey(1), getKey(1)])
  .then(console.log)
  .then(() => console.log(mapPro.get(1), mapPro));
