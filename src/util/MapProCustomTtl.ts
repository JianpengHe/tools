import { EMapProEvictionPolicy, IMapProBaseOptions, IMapProOptions, MapPro, NotPromise } from "./MapPro";

/**
 * 基于双平行数组与索引映射的最小过期时间堆（内部使用）
 *
 * 核心设计：
 * 1. 双平行数组：`keys[i]` 与 `expires[i]` 按下标一一对应，避免 `{ key, expireAt }` 包装对象分配与 GC 压力。
 * 2. 精确索引：`indexMap` 记录 `key -> 堆下标 i`（直接复用 MapPro 的 metaMap），
 *    实现 O(log N) 原地更新与任意节点精确删除，彻底消除“惰性删除”产生的幽灵节点。
 * 3. 二叉堆下标公式（0-based）：
 *    - 父节点：`parent = (i - 1) >> 1`
 *    - 左孩子：`left   = (i << 1) + 1`
 *    - 右孩子：`right  = left + 1`
 *    - 堆性质：任意父节点都满足 `expires[parent] <= expires[child]`，因此 `expires[0]` 永远是全局最小值（最早过期）。
 *
 * ---------------------------------------------------------------------------
 * 推导例子（以 expires 为例，演示上浮与下沉）：
 *
 * 【1. 插入上浮（siftUp）】
 * 假设当前堆（只需父 <= 子，不要求整体有序）：
 *   下标:   0   1   2   3   4   5
 *   数值: [10, 30, 20, 70, 80, 60]
 *
 * 现在插入新节点 15：
 *   - 第 1 步：尾插到下标 6 -> [10, 30, 20, 70, 80, 60, 15]
 *   - 第 2 步：算下标 6 的父节点 (6 - 1) >> 1 = 2（值 20）。15 < 20，20 向下拉到下标 6，空位上移到 2。
 *   - 第 3 步：算下标 2 的父节点 (2 - 1) >> 1 = 0（值 10）。15 >= 10，停止！将 15 放入下标 2。
 *   - 结果: [10, 30, 15, 70, 80, 60, 20]（中间 30, 70, 80, 60 原地未动）
 *
 * 【2. 弹出堆顶与下沉（pop / siftDown）】
 * 接着上面的堆 [10, 30, 15, 70, 80, 60, 20]，弹出最早过期的堆顶 10：
 *   - 第 1 步：取出堆顶 10；把数组末尾 20 挪到堆顶下标 0 -> [20, 30, 15, 70, 80, 60]
 *   - 第 2 步：20 下沉，看下标 0 的两个孩子 30(下标 1) 和 15(下标 2)，更小的是 15。
 *            20 > 15，将 15 向上拉到下标 0，空位下移到 2。
 *   - 第 3 步：看下标 2 的孩子 60(下标 5)。20 <= 60，停止！将 20 放入下标 2。
 *   - 结果: [15, 30, 20, 70, 80, 60]（次小值 15 自动浮到了堆顶）
 * ---------------------------------------------------------------------------
 */
class ExpireHeap<K> {
  /** 堆中存储的 key 数组，与 expires 下标严格对齐 */
  private readonly keys: K[] = [];
  /** 堆中存储的过期时间戳数组（毫秒），维护最小堆性质 */
  private readonly expires: number[] = [];

  /**
   * @param indexMap key 到堆下标的索引映射（默认新建，可传入 MapPro.metaMap 复用以节省内存）
   */
  constructor(private readonly indexMap: Map<K, unknown> = new Map()) {}

  /** 当前堆中元素数量 */
  public get size(): number {
    return this.keys.length;
  }

  /** 查看最早过期时间戳（空堆时返回 Infinity） */
  public peekExpireAt(): number {
    return this.expires.length > 0 ? this.expires[0] : Infinity;
  }

  /** 插入或更新指定 key 的过期时间戳，时间复杂度 O(log N) */
  public set(key: K, expireAt: number): void {
    const idx = this.indexMap.get(key);
    // 用 typeof === "number" 守卫：防止复用外部 metaMap 时把 pending Promise 误当下标
    if (typeof idx === "number") {
      const oldExpire = this.expires[idx];
      this.expires[idx] = expireAt;
      if (expireAt < oldExpire) this.siftUp(idx);
      else if (expireAt > oldExpire) this.siftDown(idx);
      return;
    }

    const newIdx = this.keys.length;
    this.keys.push(key);
    this.expires.push(expireAt);
    this.indexMap.set(key, newIdx);
    this.siftUp(newIdx);
  }

  /** 弹出并返回最早过期的 key（空堆返回 undefined），时间复杂度 O(log N) */
  public pop(): K | undefined {
    if (this.keys.length === 0) return undefined;
    const topKey = this.keys[0];
    this.removeAt(0);
    return topKey;
  }

  /** 从堆中精确删除指定 key，时间复杂度 O(log N) */
  public delete(key: K): boolean {
    const idx = this.indexMap.get(key);
    if (typeof idx !== "number") return false;
    this.removeAt(idx);
    return true;
  }

  /** 清空堆中所有元素并从 indexMap 中移除对应 key（不误伤 indexMap 中其他类型的元数据） */
  public clear(): void {
    for (const key of this.keys) this.indexMap.delete(key);
    this.keys.length = 0;
    this.expires.length = 0;
  }

  /** 删除指定下标处的节点：用末尾元素填补空位，再按新旧值大小决定上浮或下沉 */
  private removeAt(idx: number): void {
    this.indexMap.delete(this.keys[idx]);
    const lastIdx = this.keys.length - 1;
    if (idx === lastIdx) {
      this.keys.pop();
      this.expires.pop();
      return;
    }

    const lastKey = this.keys.pop()!;
    const lastExpire = this.expires.pop()!;
    const oldExpire = this.expires[idx];
    this.keys[idx] = lastKey;
    this.expires[idx] = lastExpire;
    this.indexMap.set(lastKey, idx);

    if (lastExpire < oldExpire) this.siftUp(idx);
    else if (lastExpire > oldExpire) this.siftDown(idx);
  }

  /** 将指定下标节点向上调整，直到满足父节点 <= 当前节点 */
  private siftUp(idx: number): void {
    const key = this.keys[idx];
    const expire = this.expires[idx];
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (expire >= this.expires[parent]) break;
      const pKey = this.keys[parent];
      this.keys[idx] = pKey;
      this.expires[idx] = this.expires[parent];
      this.indexMap.set(pKey, idx);
      idx = parent;
    }
    this.keys[idx] = key;
    this.expires[idx] = expire;
    this.indexMap.set(key, idx);
  }

  /** 将指定下标节点向下调整，直到满足当前节点 <= 左右子节点 */
  private siftDown(idx: number): void {
    const key = this.keys[idx];
    const expire = this.expires[idx];
    const len = this.keys.length;
    const half = len >> 1;
    while (idx < half) {
      let child = (idx << 1) + 1;
      const right = child + 1;
      if (right < len && this.expires[right] < this.expires[child]) child = right;
      if (expire <= this.expires[child]) break;
      const cKey = this.keys[child];
      this.keys[idx] = cKey;
      this.expires[idx] = this.expires[child];
      this.indexMap.set(cKey, idx);
      idx = child;
    }
    this.keys[idx] = key;
    this.expires[idx] = expire;
    this.indexMap.set(key, idx);
  }
}

/** MapProCustomTtl 配置项 */
export type IMapProCustomTtlOptions<K, V> = Omit<IMapProBaseOptions<K, V>, "init"> & {
  /**
   * 自动初始化函数：支持通过第 2 参数 `setTtl(ttlMs)` 为当前 key 设置独立有效期（毫秒）。
   * 未调用 `setTtl` 时回退使用 `cacheTime`。
   */
  init?: (key: K, setTtl: (ttlMs: number) => void) => V | Promise<V>;
  /** 默认存活时间（毫秒，默认 Infinity 即永不过期） */
  cacheTime?: number;
  /** 最大缓存数量（默认 Infinity；设置有限正整数时按 LRU 淘汰） */
  cacheSize?: number;
  /** 是否启用后台定时清理器（默认 false，仅在 get/has/init/set 时被动清理） */
  enableTimer?: boolean;
};

/**
 * 支持“每条数据独立 TTL”的增强版 Map（继承自 MapPro）
 * - 基于内部 ExpireHeap（双平行数组最小堆 + 复用父类 metaMap 作索引）实现 O(log N) 过期调度
 * - 支持通过 `init(key, setTtl)` 或 `set(key, value, ttlMs)` 为每个 key 单独指定有效期
 * - 若同时配置了 `cacheSize`，容量满时自动按 LRU 淘汰
 */
export class MapProCustomTtl<K, V extends NotPromise<V>> extends MapPro<K, V> {
  /** 维护所有有限 TTL 节点的最小过期时间堆（复用父类 metaMap 存储 key -> 堆下标） */
  private readonly expireHeap: ExpireHeap<K>;

  constructor(opt: IMapProCustomTtlOptions<K, V> = {}) {
    const cacheSize = opt.cacheSize ?? Infinity;
    // 复用父类完成参数校验、配置存储及可选的 LRU 容量淘汰（不启用父类统一 TTL 位掩码）
    super({
      evictionPolicy: cacheSize !== Infinity ? EMapProEvictionPolicy.LRU : EMapProEvictionPolicy.NONE,
      cacheSize,
      cacheTime: opt.cacheTime ?? Infinity,
      enableTimer: Boolean(opt.enableTimer),
      beforeDelete: opt.beforeDelete,
      init: opt.init as IMapProOptions<K, V>["init"],
    } as IMapProOptions<K, V>);

    this.expireHeap = new ExpireHeap<K>(this.metaMap);
  }

  /** 重写父类初始化调用：透传第 2 参数 `setTtl` 供业务动态指定当前 key 的有效期 */
  protected override invokeInit(key: K, setTtl: (ttlMs: number) => void): V | Promise<V> | undefined {
    return (this.opt.init as IMapProCustomTtlOptions<K, V>["init"])?.(key, setTtl);
  }

  /** 重写父类初始化写回：将 `setTtl` 捕获到的独立 TTL 透传给 `set` */
  protected override commitInit(key: K, value: V, ttlMs?: number): void {
    this.set(key, value, ttlMs);
  }

  /** 设置 key-value，可通过第 3 参数指定该条目的独立过期毫秒数（不传则回退使用 cacheTime） */
  public override set(key: K, value: V, ttlMs?: number): this {
    const ttl = ttlMs ?? this.opt.cacheTime;
    const hasTtl = Number.isFinite(ttl) && ttl > 0;
    const now = hasTtl || this.nextExpireTime !== Infinity ? Date.now() : 0;
    // 先清理已过期节点（跳过 pending key，避免在即将抛错前触发无关的清理副作用）
    if (this.nextExpireTime !== Infinity && !this.getPending(key)) this.clean(now);
    // 委托父类完成 pending 写保护、主 Map 写入与可选的 LRU 容量淘汰
    super.set(key, value);

    if (hasTtl) {
      // 防止 beforeDelete 回调重入删除了刚写入的 key
      if (!super.has(key)) return this;
      const expireAt = now + ttl;
      const prevNextExpire = this.nextExpireTime;
      this.expireHeap.set(key, expireAt);
      this.nextExpireTime = this.expireHeap.peekExpireAt();
      // 新节点比当前最早到期时间更早时，立即重排后台定时器
      if (this.opt.enableTimer && expireAt < prevNextExpire) {
        this.scheduleTimer(ttl);
      }
    } else if (this.expireHeap.delete(key)) {
      // 由有限 TTL 覆盖为永不过期时，同步移出最小堆并在堆空时停止定时器
      this.nextExpireTime = this.expireHeap.peekExpireAt();
      if (this.nextExpireTime === Infinity && this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }
    return this;
  }

  /** 重写父类元状态删除（供 delete / evictToSize 复用）：同步移出最小堆并校准最早到期时间 */
  protected override deleteMeta(key: K): void {
    if (this.expireHeap.delete(key)) {
      this.nextExpireTime = this.expireHeap.peekExpireAt();
      if (this.nextExpireTime === Infinity && this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      return;
    }
    // 非堆索引（如 pending Promise）回退交由父类清理
    super.deleteMeta(key);
  }

  /** 重写父类过期清理循环：按最小堆堆顶顺序依次弹出所有已到期节点 */
  protected override cleanExpired(curNow: number): boolean {
    let cleaned = false;
    while (this.expireHeap.size > 0 && curNow >= this.expireHeap.peekExpireAt()) {
      const key = this.expireHeap.pop()!;
      super.delete(key); // MapPro.delete 会自动移除节点并触发 beforeDelete
      cleaned = true;
    }
    this.nextExpireTime = this.expireHeap.peekExpireAt();
    return cleaned;
  }

  /** 清空缓存与最小堆 */
  public override clear(): void {
    this.expireHeap.clear();
    super.clear();
  }
}

// 测试用例 / 使用示例

// /** 用例 1：每条数据独立 TTL（乱序过期 + 动态更新为永不过期） */
// async function testCustomTtl(): Promise<void> {
//   console.log("=== 用例 1: 独立 TTL (乱序过期与覆盖更新) ===");
//   const map = new MapProCustomTtl<string, string>({
//     cacheTime: 200, // 默认 TTL: 200ms
//     beforeDelete: (k, v) => console.log(`[beforeDelete 回调] key=${k}, value=${v} 已过期被清理`),
//   });
//
//   map.set("long", "长效数据", 180);
//   map.set("short", "短效数据", 50);
//   map.set("mid", "中效数据", 100);
//   map.set("perm", "永不过期", Infinity);
//   console.log("0ms: 插入 long(180ms), short(50ms), mid(100ms), perm(Infinity)");
//
//   await new Promise(r => setTimeout(r, 65));
//   console.log(
//     `65ms: short? ${map.has("short")} (预期 false), mid? ${map.has("mid")} (预期 true), long? ${map.has("long")} (预期 true)`,
//   );
//
//   await new Promise(r => setTimeout(r, 55));
//   console.log(
//     `120ms: mid? ${map.has("mid")} (预期 false), long? ${map.has("long")} (预期 true), perm? ${map.has("perm")} (预期 true)`,
//   );
//
//   // 将 long 覆盖为永不过期
//   map.set("long", "已转为永久", Infinity);
//   await new Promise(r => setTimeout(r, 100));
//   console.log(
//     `220ms: long=${map.get("long")} (预期 已转为永久), perm=${map.get("perm")} (预期 永不过期)`,
//   );
//   map.clear();
// }
//
// /** 用例 2：异步 init(key, setTtl) 并发去重 (Singleflight) + 动态设置 TTL */
// async function testAsyncInitWithCustomTtl(): Promise<void> {
//   console.log("\n=== 用例 2: 异步 init(key, setTtl) 并发合并与动态 TTL ===");
//   let initCount = 0;
//   const map = new MapProCustomTtl<string, string>({
//     cacheTime: 500,
//     async init(key, setTtl) {
//       initCount++;
//       console.log(`[init 触发] 正在加载 key=${key} (模拟耗时 50ms)...`);
//       await new Promise(r => setTimeout(r, 50));
//       // 根据查询结果动态决定该条缓存的有效期（如 DNS 记录 TTL / 证书剩余有效期）
//       setTtl(key === "fast" ? 60 : 300);
//       return `value_${key}`;
//     },
//   });
//
//   // 并发 3 次请求同一个 key，仅触发 1 次 init
//   const [r1, r2, r3] = await Promise.all([map.getAsync("fast"), map.getAsync("fast"), map.getAsync("fast")]);
//   console.log(`并发读取完成: r1=${r1}, r2=${r2}, r3=${r3}, init 执行次数=${initCount} (预期 1)`);
//
//   await new Promise(r => setTimeout(r, 80));
//   console.log(`80ms 后 fast 是否存在: ${map.has("fast")} (预期 false)`);
//   map.clear();
// }
//
// /** 用例 3：独立 TTL + LRU 容量淘汰（cacheSize）与 delete 同步维护最小堆 */
// async function testLruWithCustomTtl(): Promise<void> {
//   console.log("\n=== 用例 3: 独立 TTL + LRU 容量淘汰 ===");
//   const map = new MapProCustomTtl<string, number>({
//     cacheSize: 2,
//     beforeDelete: (k, v) => console.log(`[beforeDelete 回调] key=${k}, value=${v} 被移除`),
//   });
//
//   map.set("a", 1, 60);
//   map.set("b", 2, 200);
//   // 访问 a 刷新 LRU 顺序，此时最老的是 b
//   map.get("a");
//   // 插入 c 超出 cacheSize=2，应淘汰 b 并同步从最小堆移除
//   map.set("c", 3, 200);
//   console.log(
//     `LRU 淘汰后: a? ${map.has("a")} (预期 true), b? ${map.has("b")} (预期 false), c? ${map.has("c")} (预期 true)`,
//   );
//
//   // 手动删除堆顶 a，后续到时间不应重复触发 beforeDelete
//   map.delete("a");
//   await new Promise(r => setTimeout(r, 80));
//   console.log(`80ms 后: a? ${map.has("a")} (预期 false), c? ${map.has("c")} (预期 true)`);
//   map.clear();
// }
//
// /** 用例 4：enableTimer 后台定时清理与更早 TTL 自动重排 */
// async function testEnableTimer(): Promise<void> {
//   console.log("\n=== 用例 4: enableTimer 后台定时清理与定时器重排 ===");
//   const map = new MapProCustomTtl<string, string>({
//     enableTimer: true,
//     beforeDelete: (k, v) => console.log(`[定时器自动清理] key=${k}, value=${v}`),
//   });
//
//   map.set("later", "后过期", 150);
//   // 插入更早过期的 key，自动重排定时器到 50ms
//   map.set("sooner", "先过期", 50);
//
//   await new Promise(r => setTimeout(r, 80));
//   console.log(`80ms 后(未调用 clean): size=${map.size} (预期 1), sooner? ${map.has("sooner")} (预期 false)`);
//
//   await new Promise(r => setTimeout(r, 100));
//   console.log(`180ms 后(未调用 clean): size=${map.size} (预期 0)`);
// }
//
// /**
//  * 用例 5：独立 TTL 压测（大量写入、随机 TTL 与淘汰下的耗时及内存统计）
//  * 运行提示：可使用 `node --expose-gc` 运行以获得更准确的堆内存增量统计
//  */
// async function benchmarkCustomTtl(): Promise<void> {
//   console.log("\n=== 用例 5: MapProCustomTtl 压测（随机独立 TTL 写入与淘汰） ===");
//   const TOTAL_OPS = 500_000;
//   const CACHE_SIZE = 10_000;
//   const SAMPLE_STEP = 10_000;
//   const toMB = (bytes: number) => Number((bytes / 1024 / 1024).toFixed(2));
//
//   type BenchRow = {
//     模式: string;
//     写入次数: number;
//     淘汰次数: number;
//     最终容量: number;
//     "耗时(ms)": number;
//     "吞吐(ops/s)": number;
//     "堆增量(MB)": number;
//     "峰值堆增量(MB)": number;
//   };
//
//   const configs = [
//     { name: "CUSTOM_TTL", cacheSize: Infinity },
//     { name: "CUSTOM_TTL + LRU", cacheSize: CACHE_SIZE },
//   ];
//   const summary: BenchRow[] = [];
//
//   for (const cfg of configs) {
//     (globalThis as { gc?: () => void }).gc?.();
//     await new Promise(r => setTimeout(r, 20));
//
//     let evictedCount = 0;
//     const map = new MapProCustomTtl<number, string>({
//       cacheSize: cfg.cacheSize,
//       beforeDelete: () => {
//         evictedCount++;
//       },
//     });
//
//     const baseHeap = process.memoryUsage().heapUsed;
//     let peakHeap = baseHeap;
//     const start = performance.now();
//
//     for (let i = 0; i < TOTAL_OPS; i++) {
//       const key = i % 5 === 0 ? i % CACHE_SIZE : i;
//       // 随机分配 10ms ~ 50ms 的独立 TTL，触发堆上浮/下沉与批量过期
//       const ttl = 10 + (i % 41);
//       map.set(key, `val_${i}`, ttl);
//
//       if (i % SAMPLE_STEP === 0) {
//         const curHeap = process.memoryUsage().heapUsed;
//         if (curHeap > peakHeap) peakHeap = curHeap;
//       }
//     }
//
//     const durationMs = performance.now() - start;
//     const endHeap = process.memoryUsage().heapUsed;
//     if (endHeap > peakHeap) peakHeap = endHeap;
//
//     summary.push({
//       模式: cfg.name,
//       写入次数: TOTAL_OPS,
//       淘汰次数: evictedCount,
//       最终容量: map.size,
//       "耗时(ms)": Number(durationMs.toFixed(2)),
//       "吞吐(ops/s)": Math.round(TOTAL_OPS / (durationMs / 1000)),
//       "堆增量(MB)": toMB(endHeap - baseHeap),
//       "峰值堆增量(MB)": toMB(peakHeap - baseHeap),
//     });
//
//     map.clear();
//   }
//
//   console.table(summary);
// }
//
// /** 运行全部测试用例 */
// (async () => {
//   await testCustomTtl();
//   await testAsyncInitWithCustomTtl();
//   await testLruWithCustomTtl();
//   await testEnableTimer();
//   await benchmarkCustomTtl();
// })();
