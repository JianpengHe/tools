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
 * 缓存节点，同时作为 Map 中的值对象
 * - key / value：缓存的键值
 * - pending：异步 init 返回的 Promise（用于去重，同一个 key 只会有一个 pending）
 * - timestamp：最后一次访问的时间戳，仅 IDLE_TTL 策略使用
 */
export type IMapProValue<K, V> = {
  key: K;
  value: V | undefined;
  pending: Promise<V> | undefined;
  timestamp: number;
};

/**
 * 增强版 Map，支持自动初始化（同步/异步）、多种缓存淘汰策略。
 *
 * 核心原理：利用 ES6 Map 原生保持“插入顺序（Insertion Order）”的特性实现 O(1) 淘汰队列。
 *
 * 设计口诀：
 * “最新在队尾，最老在队首；淘汰斩队首，见好就收手。”
 *
 * 淘汰策略生命周期对照表：
 * | 淘汰策略 | 创建（新 key） | 读取 / 更新已存在 key | 淘汰起点 | 终止淘汰条件 |
 * | :--- | :--- | :--- | :--- | :--- |
 * | NONE | 插入队尾 | 不做任何位移 | 不淘汰 | - |
 * | FIFO | 插入队尾 | 不做任何位移，保持原顺序 | 队首 | map.size <= cacheSize |
 * | LRU | 插入队尾 | 移到队尾（标记为最新） | 队首 | map.size <= cacheSize |
 * | IDLE_TTL | 插入队尾 + 记时间 | 移到队尾 + 刷新时间 | 队首 | 遇到首个 timestamp >= expTime 即 break |
 *
 * 优势：
 * - 纯 ES6 Map 实现，彻底规避双向链表额外的指针对象开销与 GC 压力。
 * - IDLE_TTL 下元素时间戳自队首到队尾单调递增，过期清理遇到首个未过期节点即可 break，无需全量扫描。
 *
 * 类型约束：V 不能是 undefined，不能是 Promise 实例（可以是 null）
 */
export class MapPro<K, V extends NotPromise | null> {
  /** 核心存储：key → 节点 */
  private readonly map: Map<K, IMapProValue<K, V>> = new Map();
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
   * - 如果 key 已存在：根据策略刷新访问记录（LRU/IDLE_TTL 移到队尾），若传入了 value 则更新，必要时触发 init
   * - 如果 key 不存在：创建节点（默认放队尾），触发淘汰检查（从队首淘汰），必要时触发 init
   */
  public getObj(key: K, value?: V) {
    const obj = this.map.get(key);
    const evictionPolicy = this.opt.evictionPolicy;

    if (obj) {
      if (value !== undefined) obj.value = value;
      /**
       * 将已存在的节点移到队尾标记为最新
       * - LRU：直接先删后插移到队尾
       * - IDLE_TTL：刷新时间戳并移到队尾
       * - FIFO / NONE：保持原位不动
       */
      if (evictionPolicy === EMapProEvictionPolicy.LRU || evictionPolicy === EMapProEvictionPolicy.IDLE_TTL) {
        if (evictionPolicy === EMapProEvictionPolicy.IDLE_TTL) obj.timestamp = Date.now();
        this.map.delete(key);
        this.map.set(key, obj);
      }
      // 如果 value 还没初始化（比如上次异步 init 失败了），重新尝试
      if (obj.value === undefined && this.opt.init) this.init(key, obj);
      return obj;
    }

    // key 不存在：创建节点（原生 Map 自动追加到队尾）
    const emptyObj: IMapProValue<K, V> = { key, value, pending: undefined, timestamp: 0 };
    if (evictionPolicy === EMapProEvictionPolicy.IDLE_TTL) emptyObj.timestamp = Date.now();
    this.map.set(key, emptyObj);

    if (evictionPolicy !== EMapProEvictionPolicy.NONE) {
      this.tryToDeleteNode();
    }
    // IDLE_TTL：首次插入时启动定时清理器
    if (evictionPolicy === EMapProEvictionPolicy.IDLE_TTL && !this.timer && this.opt.cacheTime > 0) {
      this.timer = setInterval(this.timerFn.bind(this), this.opt.cacheTime);
      this.timer.unref?.();
    }
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
    const result = value !== undefined ? value : await pending;
    callBack?.(result);
    return result;
  }

  /**
   * 手动触发 key 的初始化（也会被 getObj 在必要时自动调用）
   * - 如果已有 pending 的异步 init，直接返回该 Promise（去重，避免重复执行）
   * - 如果 value 已存在，直接返回 value
   * - 否则调用 opt.init 生成值，支持同步和异步
   */
  public init(key: K, obj = this.map.get(key) ?? this.getObj(key)) {
    // 去重：已有 pending 的异步 init，直接复用
    if (obj.pending) return obj.pending;
    // 已有值，无需再初始化
    if (obj.value !== undefined) return obj.value;

    const pending = this.opt.init?.(key);
    if (pending instanceof Promise) {
      // 异步 init：设置 pending，完成后写入 value（需校验节点仍在 map 中且未被手动 set）
      pending
        .then((value: V) => {
          if (value !== undefined && this.map.get(key) === obj && obj.value === undefined) obj.value = value;
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

  /** 删除指定 key 的节点并触发 beforeDelete 回调 */
  public delete(key: K) {
    const obj = this.map.get(key);
    if (!obj) return false;
    this.opt.beforeDelete?.(key, obj.value);
    this.map.delete(key);
    // 如果 map 已清空，停止定时器
    if (this.map.size <= 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return true;
  }

  /** FIFO / LRU 淘汰：从队首依次弹出最老节点，直到容量合规 */
  private evictToSize() {
    while (this.map.size > this.opt.cacheSize) {
      const entry = this.map.keys().next();
      if (entry.done) break;
      this.delete(entry.value);
    }
  }

  /** IDLE_TTL 淘汰：从队首遍历，遇到首个未过期节点即退出（无需全量扫描） */
  private cleanExpiredNodes() {
    if (this.opt.cacheTime <= 0) return;
    const expTime = Date.now() - this.opt.cacheTime;
    for (const [key, node] of this.map) {
      if (node.timestamp < expTime) {
        this.delete(key);
      } else {
        break; // 队首到队尾时间戳单调递增，遇到首个未过期节点可立即停止
      }
    }
  }

  /** 根据淘汰策略尝试删除过期/超量的节点 */
  private tryToDeleteNode() {
    switch (this.opt.evictionPolicy) {
      case EMapProEvictionPolicy.NONE:
        return;
      case EMapProEvictionPolicy.FIFO:
      case EMapProEvictionPolicy.LRU:
        return this.evictToSize();
      case EMapProEvictionPolicy.IDLE_TTL:
        return this.cleanExpiredNodes();
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
    this.cleanExpiredNodes();
  }

  /** 返回当前缓存的条目数 */
  public size() {
    return this.map.size;
  }

  /** 清空所有缓存，重置定时器 */
  public clear() {
    this.map.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  /** 判断 key 是否存在（不会触发 init） */
  public has(key: K) {
    return this.map.has(key);
  }

  /** 手动设置 key-value，内部通过 getObj 维护淘汰 */
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
