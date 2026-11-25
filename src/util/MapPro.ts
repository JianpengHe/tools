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
 * 排除 Promise 实例，允许其他任意类型（对象、基础类型、null）
 */
type NotPromise = (object | string | number | boolean | symbol | bigint) & {
  readonly [__promiseBrand]?: never;
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
    // IDLE_TTL：首次插入时启动懒重排定时器
    if (evictionPolicy === EMapProEvictionPolicy.IDLE_TTL && !this.timer && this.opt.cacheTime > 0) {
      this.scheduleTimer(this.opt.cacheTime);
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
      clearTimeout(this.timer);
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

  /** 启动单次过期清理定时器 */
  private scheduleTimer(delay: number) {
    this.timer = setTimeout(() => this.timerFn(), delay);
    this.timer.unref?.();
  }

  /** IDLE_TTL 定时器回调：清理过期节点，若仍有未过期节点则按队首剩余时间自动续期 */
  private timerFn() {
    this.timer = null;
    const { cacheTime, evictionPolicy } = this.opt;
    // 安全检查：策略不对或已无数据时，停止续期
    if (cacheTime <= 0 || this.map.size <= 0 || evictionPolicy !== EMapProEvictionPolicy.IDLE_TTL) {
      return;
    }
    this.cleanExpiredNodes();
    const firstNode = this.map.values().next().value;
    if (firstNode) {
      // +1 确保下次唤醒时满足严格小于 expTime，避免边界 0ms 空转一次
      const delay = Math.max(1, firstNode.timestamp + cacheTime - Date.now() + 1);
      this.scheduleTimer(delay);
    }
  }

  /** 返回当前缓存的条目数 */
  public size() {
    return this.map.size;
  }

  /** 清空所有缓存，重置定时器 */
  public clear() {
    this.map.clear();
    if (this.timer) clearTimeout(this.timer);
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

// 测试用例 / 使用示例
// if (typeof require !== "undefined" && require.main === module) {
(async () => {
  //     // 用例 1：异步 init 并发合并去重 (Singleflight)
  //     console.log("=== 用例 1: 异步 init 自动去重与并发合并 (Singleflight) ===");
  //     let initCount = 0;
  //     const asyncMap = new MapPro<number, number>({
  //       async init(key) {
  //         initCount++;
  //         console.log(`[init 触发] 开始为 key=${key} 初始化数据 (耗时 300ms)...`);
  //         await new Promise(resolve => setTimeout(resolve, 300));
  //         return Math.floor(Math.random() * 1000);
  //       },
  //     });

  //     // 并发 3 次请求同一个 key
  //     const [res1, res2, res3] = await Promise.all([asyncMap.getAsync(1), asyncMap.getAsync(1), asyncMap.getAsync(1)]);
  //     console.log(`并发读取完成: res1=${res1}, res2=${res2}, res3=${res3}`);
  //     console.log(`init 执行次数 (预期为 1): ${initCount}`);

  //     // 用例 2：LRU 策略 (容量限制 + 访问刷新队尾 + 淘汰队首)
  //     console.log("\n=== 用例 2: LRU 策略 (容量淘汰与访问刷新) ===");
  //     const lruMap = new MapPro<string, number>({
  //       evictionPolicy: EMapProEvictionPolicy.LRU,
  //       cacheSize: 2,
  //       beforeDelete: (k, v) => console.log(`[beforeDelete 回调] key=${k}, value=${v} 被淘汰`),
  //     });

  //     lruMap.set("a", 1);
  //     lruMap.set("b", 2);
  //     console.log("插入 a=1, b=2，当前 size:", lruMap.size());

  //     // 访问 a，使其成为最近使用（移到队尾），此时队首最老的是 b
  //     lruMap.get("a");
  //     console.log("读取 a（刷新 a 为最新使用）");

  //     // 插入 c，容量超出，应当淘汰最老未访问的 b
  //     lruMap.set("c", 3);
  //     console.log("插入 c=3，超出 cacheSize=2，触发淘汰");
  //     console.log(
  //       `当前包含: a? ${lruMap.has("a")} (预期 true), b? ${lruMap.has("b")} (预期 false), c? ${lruMap.has("c")} (预期 true)`,
  //     );

  //     // 用例 3：FIFO 策略 (先进先出，读取不影响淘汰顺序)
  //     console.log("\n=== 用例 3: FIFO 策略 (先进先出) ===");
  //     const fifoMap = new MapPro<string, number>({
  //       evictionPolicy: EMapProEvictionPolicy.FIFO,
  //       cacheSize: 2,
  //       beforeDelete: (k, v) => console.log(`[beforeDelete 回调] key=${k}, value=${v} 被淘汰`),
  //     });

  //     fifoMap.set("k1", 100);
  //     fifoMap.set("k2", 200);
  //     console.log("插入 k1=100, k2=200");

  //     // 读取 k1，在 FIFO 下不应改变淘汰顺序（k1 依然是最早插入的队首）
  //     fifoMap.get("k1");
  //     console.log("读取 k1（FIFO 下位置不变）");

  //     // 插入 k3，超出容量，淘汰最早的 k1
  //     fifoMap.set("k3", 300);
  //     console.log("插入 k3=300，超出 cacheSize=2，触发淘汰");
  //     console.log(
  //       `当前包含: k1? ${fifoMap.has("k1")} (预期 false), k2? ${fifoMap.has("k2")} (预期 true), k3? ${fifoMap.has("k3")} (预期 true)`,
  //     );

  //     // 用例 4：IDLE_TTL 策略 (空闲存活时间与访问续期)
  //     console.log("\n=== 用例 4: IDLE_TTL 策略 (空闲超时与访问续期) ===");
  //     const ttlMap = new MapPro<string, string>({
  //       evictionPolicy: EMapProEvictionPolicy.IDLE_TTL,
  //       cacheTime: 120, // 120ms 空闲超时
  //       beforeDelete: (k, v) => console.log(`[beforeDelete 回调] key=${k}, value=${v} 已超时被清理`),
  //     });

  //     ttlMap.set("item1", "val1");
  //     console.log("0ms: 插入 item1 (TTL: 120ms)");

  //     await new Promise(r => setTimeout(r, 60));
  //     // 60ms: 读取 item1 进行访问续期（延长至 60 + 120 = 180ms）
  //     ttlMap.get("item1");
  //     ttlMap.set("item2", "val2");
  //     console.log("60ms: 访问 item1 (续期至 180ms)，并插入 item2 (到期 180ms)");

  //     await new Promise(r => setTimeout(r, 70));
  //     // 130ms: 距最初插入过去了 130ms，但 item1 续期后未过期，item2 也未过期
  //     console.log(`130ms: item1? ${ttlMap.has("item1")} (预期 true), item2? ${ttlMap.has("item2")} (预期 true)`);

  //     await new Promise(r => setTimeout(r, 70));
  //     // 200ms: 距最后访问均超过 120ms，手动触发检查或等待清理
  //     ttlMap.getObj("check"); // 触发淘汰检查
  //     console.log(`200ms: item1? ${ttlMap.has("item1")} (预期 false), item2? ${ttlMap.has("item2")} (预期 false)`);
  //     ttlMap.clear();

  //     // 用例 5：4种淘汰策略压测（大量写入与淘汰下的耗时及内存统计汇总）
  //     // 运行提示：可使用 `node --expose-gc` 运行以获得更准确的堆内存增量统计
  console.log("\n=== 用例 5: 4种淘汰策略压测（写入 & 淘汰性能与内存汇总） ===");
  const TOTAL_OPS = 2000_000;
  const CACHE_SIZE = 10_000;
  const IDLE_CACHE_TIME = 10; // 1ms 空闲超时，确保压测期间能自然触发批量过期淘汰
  const SAMPLE_STEP = 10_000;

  type BenchRow = {
    策略: string;
    写入次数: number;
    淘汰次数: number;
    最终容量: number;
    "耗时(ms)": number;
    "吞吐(ops/s)": number;
    "堆增量(MB)": number;
    "峰值堆增量(MB)": number;
  };

  const benchConfigs: Array<{ name: string; policy: EMapProEvictionPolicy; cacheSize?: number; cacheTime?: number }> = [
    { name: "NONE", policy: EMapProEvictionPolicy.NONE },
    { name: "FIFO", policy: EMapProEvictionPolicy.FIFO, cacheSize: CACHE_SIZE },
    { name: "LRU", policy: EMapProEvictionPolicy.LRU, cacheSize: CACHE_SIZE },
    { name: "IDLE_TTL", policy: EMapProEvictionPolicy.IDLE_TTL, cacheTime: IDLE_CACHE_TIME },
  ];

  const toMB = (bytes: number) => Number((bytes / 1024 / 1024).toFixed(2));
  const benchSummary: BenchRow[] = [];

  for (const cfg of benchConfigs) {
    // 尽量在每轮测试前回收上一轮垃圾，减少跨用例内存干扰
    (globalThis as { gc?: () => void }).gc?.();
    await new Promise(r => setTimeout(r, 20));

    let evictedCount = 0;
    const map = new MapPro<number, string>({
      evictionPolicy: cfg.policy,
      cacheSize: cfg.cacheSize ?? Infinity,
      cacheTime: cfg.cacheTime ?? 0,
      beforeDelete: () => {
        evictedCount++;
      },
    });

    const baseHeap = process.memoryUsage().heapUsed;
    let peakHeap = baseHeap;
    const start = performance.now();

    for (let i = 0; i < TOTAL_OPS; i++) {
      // 构造一定比例的重复 key（仅在 LRU/IDLE_TTL 下会触发队尾移动）与新 key 写入
      const key = i % 5 === 0 ? i % CACHE_SIZE : i;
      map.set(key, `val_${i}`);

      if (i % SAMPLE_STEP === 0) {
        const curHeap = process.memoryUsage().heapUsed;
        if (curHeap > peakHeap) peakHeap = curHeap;
      }
    }

    const durationMs = performance.now() - start;
    const endHeap = process.memoryUsage().heapUsed;
    if (endHeap > peakHeap) peakHeap = endHeap;

    benchSummary.push({
      策略: cfg.name,
      写入次数: TOTAL_OPS,
      淘汰次数: evictedCount,
      最终容量: map.size(),
      "耗时(ms)": Number(durationMs.toFixed(2)),
      "吞吐(ops/s)": Math.round(TOTAL_OPS / (durationMs / 1000)),
      "堆增量(MB)": toMB(endHeap - baseHeap),
      "峰值堆增量(MB)": toMB(peakHeap - baseHeap),
    });

    map.clear();
  }

  console.table(benchSummary);

  console.log("\n=== 所有测试用例执行完成 ===");
})();
// }
