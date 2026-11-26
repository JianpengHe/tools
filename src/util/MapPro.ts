/**
 * "非 Promise" 守卫类型
 * 排除 Promise 实例与 undefined，允许其他任意类型（对象、基础类型、null）
 */
type NotPromise<V> =
  Extract<V, Promise<any> | undefined> extends never
    ? object | string | number | boolean | symbol | bigint | null
    : never;

/** 内部淘汰能力位掩码 */
const enum PolicyFlag {
  /** 按 cacheSize 淘汰（FIFO / LRU） */
  按容量淘汰 = 1 << 0,
  /** 访问或更新时移到队尾（LRU / IDLE_TTL） */
  命中移到队尾 = 1 << 1,
  /** 启用空闲时间淘汰与时间戳记录（IDLE_TTL） */
  空闲过期 = 1 << 2,
}

/** 缓存淘汰策略枚举（支持按位组合） */
export enum EMapProEvictionPolicy {
  /** 不淘汰 */
  NONE = 0,
  /** 先进先出：最早插入的最先被淘汰 */
  FIFO = PolicyFlag.按容量淘汰,
  /** 最近最少使用：最久没被访问的最先被淘汰 */
  LRU = PolicyFlag.按容量淘汰 | PolicyFlag.命中移到队尾,
  /** 空闲存活时间：超过 cacheTime 未被访问的会被定时器清除 */
  IDLE_TTL = PolicyFlag.空闲过期 | PolicyFlag.命中移到队尾,
}

type IMapProBaseOptions<K, V> = {
  /**
   * 自动初始化函数：调用 get/getAsync 时，若 key 对应的 value 为 undefined，
   * 会调用此函数生成初始值并缓存。支持同步和异步返回。
   */
  init?: (key: K) => V | Promise<V>;
  /** 节点被淘汰前的回调，可用于资源清理等 */
  beforeDelete?: (key: K, value: V) => void;
};

/** MapPro 配置项（基于 evictionPolicy 的判别联合类型） */
export type IMapProOptions<K, V> = IMapProBaseOptions<K, V> &
  (
    | {
        /** 缓存淘汰策略：不淘汰（默认） */
        readonly evictionPolicy?: EMapProEvictionPolicy.NONE;
      }
    | {
        /** 缓存淘汰策略：FIFO / LRU */
        readonly evictionPolicy: EMapProEvictionPolicy.FIFO | EMapProEvictionPolicy.LRU;
        /** 缓存最大数量，仅在 FIFO / LRU 策略下生效（默认 Infinity，即不限制） */
        cacheSize?: number;
      }
    | {
        /** 缓存淘汰策略：IDLE_TTL */
        readonly evictionPolicy: EMapProEvictionPolicy.IDLE_TTL;
        /** 缓存空闲存活时间（毫秒），仅在 IDLE_TTL 策略下生效（默认 Infinity，即永不过期） */
        cacheTime?: number;
        /** 是否启用 IDLE_TTL 后台定时清理器（默认 false，仅在 get/set 时被动清理过期节点） */
        enableTimer?: boolean;
      }
  );

type IMapProInternalOptions<K, V> = IMapProBaseOptions<K, V> & {
  readonly evictionPolicy: EMapProEvictionPolicy;
  cacheSize: number;
  cacheTime: number;
  enableTimer: boolean;
};

/**
 * 增强版 Map（直接继承原生 Map），支持自动初始化（同步/异步）、多种缓存淘汰策略。
 *
 * 核心原理：
 * - 主 Map（super）仅存储已就绪的 `K → V`，并利用 ES6 Map 原生“插入顺序”实现 O(1) 淘汰队列。
 * - 辅助 metaMap（`Map<K, Promise<V> | number>`）按需存储互斥的元状态：
 *   - 异步 init 进行中存 `Promise<V>`（不占主 Map 容量，也不会被误淘汰）
 *   - IDLE_TTL 存活期存 `number` 时间戳
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
 * 优势与设计取舍：
 * - 纯 ES6 Map 实现，彻底规避双向链表额外的指针对象开销与 GC 压力。
 * - IDLE_TTL 下元素时间戳自队首到队尾单调递增，配合 `nextExpireTime` 可在 O(1) 内跳过无效清理。
 * - 定时器默认关闭（`enableTimer: false`），靠 `has` / `get` / `set` 被动惰性清理，避免无谓唤醒事件循环。
 * - 故意不重写 `size` 与原生迭代器（`keys`/`values`/`entries`/`for...of`），保持纯只读无副作用；
 *   若需在遍历或读取 `size` 前确保无过期条目，可先显式调用 `clean()`。
 *
 * 类型约束：V 不能是 undefined，不能是 Promise 实例（可以是 null）
 */
export class MapPro<K, V extends NotPromise<V>> extends Map<K, V> {
  /** 互斥元状态存储：异步 init 中的 Promise 或 IDLE_TTL 时间戳 */
  private readonly metaMap = new Map<K, Promise<V> | number>();
  /** IDLE_TTL 策略下的定时清理器 */
  private timer: NodeJS.Timeout | null = null;
  /** IDLE_TTL 策略下队首节点的最早到期时间戳（用于 O(1) 跳过无效清理） */
  private nextExpireTime = Infinity;
  private readonly opt: IMapProInternalOptions<K, V>;

  constructor(opt: IMapProOptions<K, V> = {}) {
    super();
    this.opt = {
      cacheSize: Infinity,
      cacheTime: Infinity,
      evictionPolicy: EMapProEvictionPolicy.NONE,
      enableTimer: false,
      ...opt,
    };
    const isValidPositiveIntOrInfinity = (v: number) => v === Infinity || (Number.isInteger(v) && v > 0);
    if (!isValidPositiveIntOrInfinity(this.opt.cacheSize))
      throw new RangeError(`cacheSize 必须为正整数或 Infinity，当前值: ${this.opt.cacheSize}`);

    if (!isValidPositiveIntOrInfinity(this.opt.cacheTime))
      throw new RangeError(`cacheTime 必须为正整数或 Infinity，当前值: ${this.opt.cacheTime}`);
  }

  /** 判断 key 是否存在（IDLE_TTL 模式下会先清理过期节点） */
  public override has(key: K): boolean {
    this.clean();
    return super.has(key);
  }

  /**
   * 同步获取 key 对应的值
   * - 命中：根据策略刷新队列顺序（LRU/IDLE_TTL 移到队尾）并返回值
   * - 未命中：若配置了 init，先触发 init；同步 init 直接返回结果，异步 init 返回 undefined
   */
  public override get(key: K): V | undefined {
    const evictionPolicy = this.opt.evictionPolicy;
    const hasIdleTtl = (evictionPolicy & PolicyFlag.空闲过期) !== 0 && Number.isFinite(this.opt.cacheTime);
    let now: number | undefined;
    if (this.nextExpireTime !== Infinity) {
      now = Date.now();
      this.clean(now);
    }

    const value = super.get(key);
    if (value !== undefined) {
      if (evictionPolicy & PolicyFlag.命中移到队尾) {
        super.delete(key);
        super.set(key, value);
      }
      if (hasIdleTtl) this.metaMap.set(key, now ?? Date.now());

      return value;
    }

    if (this.opt.init) {
      const res = this.init(key);
      return res instanceof Promise ? undefined : res;
    }
    return undefined;
  }

  /** 获取 key 当前正在进行中的异步 init Promise（若不存在则返回 undefined） */
  public getPending(key: K): Promise<V> | undefined {
    const meta = this.metaMap.get(key);
    return meta instanceof Promise ? meta : undefined;
  }

  /**
   * 异步获取 key 对应的值
   * - 如果 value 已就绪（或同步 init 成功），直接返回
   * - 如果有 pending 的异步 init，等待其完成后返回
   * - 支持可选的 Node 风格回调 `(err, value)`：传了 `callBack` 时错误通过第一参数返回，不再向外 reject
   */
  public async getAsync(key: K, callBack?: (err: unknown, value?: V) => void): Promise<V | undefined> {
    try {
      const value = this.get(key);
      const result = value !== undefined ? value : await this.getPending(key);
      callBack?.(null, result);
      return result;
    } catch (err) {
      if (callBack) {
        callBack(err);
        return undefined;
      }
      throw err;
    }
  }

  /**
   * 手动触发 key 的初始化（也会被 get 在未命中时自动调用）
   * - 如果 value 已存在，直接返回 value
   * - 如果已有 pending 的异步 init，直接返回该 Promise（去重，避免重复执行）
   * - 否则调用 opt.init 生成值，支持同步和异步
   */
  public init(key: K): V | Promise<V> | undefined {
    this.clean();

    if (super.has(key)) return this.get(key);

    const existingPending = this.getPending(key);
    if (existingPending) return existingPending;

    const pending = this.opt.init?.(key);
    if (pending instanceof Promise) {
      // 异步 init：暂存到 metaMap，完成后通过令牌校验再写入主 Map
      this.metaMap.set(key, pending);
      pending
        .then((value: V) => {
          if (value !== undefined && this.metaMap.get(key) === pending) {
            // 先移除 pending 令牌再写入，避免触发 set() 的 pending 写保护
            this.metaMap.delete(key);
            this.set(key, value);
          }
        })
        // 同步 get() 触发异步 init 时外层无 await，兜底捕获防止 UnhandledPromiseRejection
        .catch(console.error)
        .finally(() => {
          if (this.metaMap.get(key) === pending) this.metaMap.delete(key);
        });
      return pending;
    }
    if (pending !== undefined) this.set(key, pending);

    return pending;
  }

  /** 手动设置 key-value，自动维护淘汰队列与元数据 */
  public override set(key: K, value: V): this {
    if (this.getPending(key)) throw new Error("key 正在异步初始化中，禁止在 pending 期间调用 set");
    const evictionPolicy = this.opt.evictionPolicy;

    if (evictionPolicy === EMapProEvictionPolicy.NONE) {
      super.set(key, value);
      return this;
    }

    if (!(evictionPolicy & PolicyFlag.命中移到队尾)) {
      // 仅按容量淘汰（如 FIFO）：原地覆盖不移位，省去 delete
      super.set(key, value);
      this.evictToSize();
      return this;
    }

    const hasIdleTtl = (evictionPolicy & PolicyFlag.空闲过期) !== 0 && Number.isFinite(this.opt.cacheTime);
    const now = hasIdleTtl ? Date.now() : 0;
    // 先清理过期节点（若当前 key 已过期会先触发 beforeDelete），未过期则按普通覆盖处理不触发 beforeDelete
    if (hasIdleTtl) this.clean(now);

    // 需移到队尾的策略（LRU / IDLE_TTL）：直接 delete + set 省去 has 查询
    const existed = super.delete(key);
    super.set(key, value);

    if (hasIdleTtl) {
      this.metaMap.set(key, now);
      // 仅在无更早节点时初始化下界；队首被刷新/删除时保持下界不变，下次到期检查时会自动校准
      if (this.nextExpireTime === Infinity) this.nextExpireTime = now + this.opt.cacheTime;
      if (!existed && this.opt.enableTimer && !this.timer) {
        this.scheduleTimer(this.opt.cacheTime);
      }
    }
    if (!existed && evictionPolicy & PolicyFlag.按容量淘汰) this.evictToSize();

    return this;
  }

  /** 删除指定 key 的节点（含未完成的 pending）并触发 beforeDelete 回调 */
  public override delete(key: K): boolean {
    if (this.metaMap.size > 0) this.metaMap.delete(key);
    if (!super.has(key)) return false;
    const value = super.get(key)!;
    super.delete(key);
    if (this.size <= 0) {
      this.nextExpireTime = Infinity;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }
    // 先删节点再触发 beforeDelete，防止回调重入导致无限递归或误删回调中新写入的值
    this.opt.beforeDelete?.(key, value);
    return true;
  }

  /** FIFO / LRU 淘汰：从队首依次弹出最老节点，直到容量合规 */
  private evictToSize() {
    const cacheSize = this.opt.cacheSize;
    if (this.size <= cacheSize) return;
    const beforeDelete = this.opt.beforeDelete;
    const hasMeta = this.metaMap.size > 0;
    for (const [key, value] of this) {
      super.delete(key);
      if (hasMeta) this.metaMap.delete(key);
      beforeDelete?.(key, value);
      if (this.size <= cacheSize) break;
    }
  }

  /**
   * 清理已过期的节点（仅在 IDLE_TTL 且 cacheTime 为有限值时生效）
   * - 返回是否有过期节点被清理（`true` 表示至少清理了 1 个，`false` 表示无需清理）
   */
  public clean(now?: number): boolean {
    if (this.nextExpireTime === Infinity) return false;
    const curNow = now ?? Date.now();
    if (curNow < this.nextExpireTime) return false;
    const expTime = curNow - this.opt.cacheTime;
    const beforeDelete = this.opt.beforeDelete;
    let cleaned = false;
    // 循环前先重置为 Infinity，防止 beforeDelete 回调重入 get/has/set 时重复触发清理
    this.nextExpireTime = Infinity;
    for (const [key, value] of this) {
      const ts = this.metaMap.get(key);
      if (typeof ts !== "number") continue; // 跳过异常无时间戳节点，避免卡死后续过期清理
      if (ts < expTime) {
        cleaned = true;
        super.delete(key);
        this.metaMap.delete(key);
        beforeDelete?.(key, value);
      } else {
        this.nextExpireTime = ts + this.opt.cacheTime;
        break; // 队首到队尾时间戳单调递增，遇到首个未过期节点可立即停止
      }
    }
    if (this.size <= 0 && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return cleaned;
  }

  /** 启动单次过期清理定时器 */
  private scheduleTimer(delay: number) {
    // 截断至 32 位有符号整数上限，避免 Node.js TimeoutOverflowWarning
    this.timer = setTimeout(() => this.timerFn(), Math.min(delay, -1 >>> 1));
    this.timer.unref?.(); // 不阻塞进程正常退出
  }

  /** IDLE_TTL 定时器回调：清理过期节点，若仍有未过期节点则按队首剩余时间自动续期 */
  private timerFn() {
    this.timer = null;
    if (this.size <= 0) return;

    const now = Date.now();
    this.clean(now);
    if (this.nextExpireTime !== Infinity) {
      // +1ms 确保下次唤醒时满足严格小于 expTime，避免边界 0ms 空转
      const delay = Math.max(1, this.nextExpireTime - now + 1);
      this.scheduleTimer(delay);
    }
  }

  /** 清空所有缓存与元状态，重置定时器，并触发 beforeDelete 回调 */
  public override clear(): void {
    this.metaMap.clear();
    this.nextExpireTime = Infinity;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    const beforeDelete = this.opt.beforeDelete;
    if (beforeDelete && this.size > 0) {
      const entries = [...this.entries()];
      super.clear();
      for (const [key, value] of entries) beforeDelete(key, value);
      return;
    }
    super.clear();
  }
}

// 测试用例 / 使用示例

/** 用例 1：异步 init 并发合并去重 (Singleflight) */
// async function testAsyncInit(): Promise<void> {
//   console.log("=== 用例 1: 异步 init 自动去重与并发合并 (Singleflight) ===");
//   let initCount = 0;
//   const asyncMap = new MapPro<number, number>({
//     async init(key) {
//       initCount++;
//       console.log(`[init 触发] 开始为 key=${key} 初始化数据 (耗时 300ms)...`);
//       await new Promise(resolve => setTimeout(resolve, 300));
//       return Math.floor(Math.random() * 1000);
//     },
//   });
//   const getKey = async (key: number) => {
//     // return await asyncMap.getAsync(key);
//     /** 推荐写法 */
//     return asyncMap.get(key) ?? (await asyncMap.getPending(key));
//   };

//   // 并发 3 次请求同一个 key
//   const [res1, res2, res3] = await Promise.all([getKey(1), getKey(1), getKey(1)]);
//   console.log(`并发读取完成: res1=${res1}, res2=${res2}, res3=${res3}`);
//   console.log(`init 执行次数 (预期为 1): ${initCount}`);
// }

// /** 用例 2：LRU 策略 (容量限制 + 访问刷新队尾 + 淘汰队首) */
// function testLRU(): void {
//   console.log("\n=== 用例 2: LRU 策略 (容量淘汰与访问刷新) ===");
//   const lruMap = new MapPro<string, number>({
//     evictionPolicy: EMapProEvictionPolicy.LRU,
//     cacheSize: 2,
//     beforeDelete: (k, v) => console.log(`[beforeDelete 回调] key=${k}, value=${v} 被淘汰`),
//   });

//   lruMap.set("a", 1);
//   lruMap.set("b", 2);
//   console.log("插入 a=1, b=2，当前 size:", lruMap.size);

//   // 访问 a，使其成为最近使用（移到队尾），此时队首最老的是 b
//   lruMap.get("a");
//   console.log("读取 a（刷新 a 为最新使用）");

//   // 插入 c，容量超出，应当淘汰最老未访问的 b
//   lruMap.set("c", 3);
//   console.log("插入 c=3，超出 cacheSize=2，触发淘汰");
//   console.log(
//     `当前包含: a? ${lruMap.has("a")} (预期 true), b? ${lruMap.has("b")} (预期 false), c? ${lruMap.has("c")} (预期 true)`,
//   );
// }

// /** 用例 3：FIFO 策略 (先进先出，读取不影响淘汰顺序) */
// function testFIFO(): void {
//   console.log("\n=== 用例 3: FIFO 策略 (先进先出) ===");
//   const fifoMap = new MapPro<string, number>({
//     evictionPolicy: EMapProEvictionPolicy.FIFO,
//     cacheSize: 2,
//     beforeDelete: (k, v) => console.log(`[beforeDelete 回调] key=${k}, value=${v} 被淘汰`),
//   });

//   fifoMap.set("k1", 100);
//   fifoMap.set("k2", 200);
//   console.log("插入 k1=100, k2=200");

//   // 读取 k1，在 FIFO 下不应改变淘汰顺序（k1 依然是最早插入的队首）
//   fifoMap.get("k1");
//   console.log("读取 k1（FIFO 下位置不变）");

//   // 插入 k3，超出容量，淘汰最早的 k1
//   fifoMap.set("k3", 300);
//   console.log("插入 k3=300，超出 cacheSize=2，触发淘汰");
//   console.log(
//     `当前包含: k1? ${fifoMap.has("k1")} (预期 false), k2? ${fifoMap.has("k2")} (预期 true), k3? ${fifoMap.has("k3")} (预期 true)`,
//   );
// }

// /** 用例 4：IDLE_TTL 策略 (空闲存活时间与访问续期) */
// async function testIdleTTL(): Promise<void> {
//   console.log("\n=== 用例 4: IDLE_TTL 策略 (空闲超时与访问续期) ===");
//   const ttlMap = new MapPro<string, string>({
//     evictionPolicy: EMapProEvictionPolicy.IDLE_TTL,
//     cacheTime: 120, // 120ms 空闲超时
//     beforeDelete: (k, v) => console.log(`[beforeDelete 回调] key=${k}, value=${v} 已超时被清理`),
//   });

//   ttlMap.set("item1", "val1");
//   console.log("0ms: 插入 item1 (TTL: 120ms)");

//   await new Promise(r => setTimeout(r, 60));
//   // 60ms: 读取 item1 进行访问续期（延长至 60 + 120 = 180ms）
//   ttlMap.get("item1");
//   ttlMap.set("item2", "val2");
//   console.log("60ms: 访问 item1 (续期至 180ms)，并插入 item2 (到期 180ms)");

//   await new Promise(r => setTimeout(r, 70));
//   // 130ms: 距最初插入过去了 130ms，但 item1 续期后未过期，item2 也未过期
//   console.log(`130ms: item1? ${ttlMap.has("item1")} (预期 true), item2? ${ttlMap.has("item2")} (预期 true)`);

//   await new Promise(r => setTimeout(r, 70));
//   // 200ms: 距最后访问均超过 120ms，手动触发检查或等待清理
//   ttlMap.set("check", "v"); // 触发淘汰检查
//   console.log(`200ms: item1? ${ttlMap.has("item1")} (预期 false), item2? ${ttlMap.has("item2")} (预期 false)`);
//   ttlMap.clear();
// }

// /**
//  * 用例 5：4种淘汰策略压测（大量写入与淘汰下的耗时及内存统计汇总）
//  * 运行提示：可使用 `node --expose-gc` 运行以获得更准确的堆内存增量统计
//  */
// async function benchmarkEvictionPolicies(): Promise<void> {
//   console.log("\n=== 用例 5: 4种淘汰策略压测（写入 & 淘汰性能与内存汇总） ===");
//   const TOTAL_OPS = 2000_000;
//   const CACHE_SIZE = 10_000;
//   const IDLE_CACHE_TIME = 10; // 1ms 空闲超时，确保压测期间能自然触发批量过期淘汰
//   const SAMPLE_STEP = 10_000;

//   type BenchRow = {
//     策略: string;
//     写入次数: number;
//     淘汰次数: number;
//     最终容量: number;
//     "耗时(ms)": number;
//     "吞吐(ops/s)": number;
//     "堆增量(MB)": number;
//     "峰值堆增量(MB)": number;
//   };

//   const benchConfigs: Array<{ name: string; policy: EMapProEvictionPolicy; cacheSize?: number; cacheTime?: number }> = [
//     { name: "NONE", policy: EMapProEvictionPolicy.NONE },
//     { name: "FIFO", policy: EMapProEvictionPolicy.FIFO, cacheSize: CACHE_SIZE },
//     { name: "LRU", policy: EMapProEvictionPolicy.LRU, cacheSize: CACHE_SIZE },
//     { name: "IDLE_TTL", policy: EMapProEvictionPolicy.IDLE_TTL, cacheTime: IDLE_CACHE_TIME },
//   ];

//   const toMB = (bytes: number) => Number((bytes / 1024 / 1024).toFixed(2));
//   const benchSummary: BenchRow[] = [];

//   for (const cfg of benchConfigs) {
//     // 尽量在每轮测试前回收上一轮垃圾，减少跨用例内存干扰
//     (globalThis as { gc?: () => void }).gc?.();
//     await new Promise(r => setTimeout(r, 20));

//     let evictedCount = 0;
//     const map = new MapPro<number, string>({
//       evictionPolicy: cfg.policy,
//       cacheSize: cfg.cacheSize ?? Infinity,
//       cacheTime: cfg.cacheTime ?? Infinity,
//       beforeDelete: () => {
//         evictedCount++;
//       },
//     });

//     const baseHeap = process.memoryUsage().heapUsed;
//     let peakHeap = baseHeap;
//     const start = performance.now();

//     for (let i = 0; i < TOTAL_OPS; i++) {
//       // 构造一定比例的重复 key（仅在 LRU/IDLE_TTL 下会触发队尾移动）与新 key 写入
//       const key = i % 5 === 0 ? i % CACHE_SIZE : i;
//       map.set(key, `val_${i}`);

//       if (i % SAMPLE_STEP === 0) {
//         const curHeap = process.memoryUsage().heapUsed;
//         if (curHeap > peakHeap) peakHeap = curHeap;
//       }
//     }

//     const durationMs = performance.now() - start;
//     const endHeap = process.memoryUsage().heapUsed;
//     if (endHeap > peakHeap) peakHeap = endHeap;

//     benchSummary.push({
//       策略: cfg.name,
//       写入次数: TOTAL_OPS,
//       淘汰次数: evictedCount,
//       最终容量: map.size,
//       "耗时(ms)": Number(durationMs.toFixed(2)),
//       "吞吐(ops/s)": Math.round(TOTAL_OPS / (durationMs / 1000)),
//       "堆增量(MB)": toMB(endHeap - baseHeap),
//       "峰值堆增量(MB)": toMB(peakHeap - baseHeap),
//     });

//     map.clear();
//   }

//   console.table(benchSummary);
// }

// /** 运行全部测试用例 */
// (async () => {
//   await testAsyncInit();
//   testLRU();
//   testFIFO();
//   await testIdleTTL();
//   await benchmarkEvictionPolicies();
// })();
