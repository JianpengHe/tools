import { IMysqlResult } from "./Mysql";

/**
 * 泛型 SQL 构建器入口类
 * 提供了常用的 SQL 操作（增删改查）的链式调用接口
 * @template TableInfo 表结构类型
 * @template Result 查询结果类型，默认为 IMysqlResult
 */
export class SQL<TableInfo extends Record<string, any>, Result = IMysqlResult> {
  /**
   * 表名
   */
  private tableName: string;

  /**
   * SQL 执行器函数
   */
  private executor: (sql: string, params: any[]) => Promise<any>;

  /**
   * 构造函数
   * @param tableName 表名
   * @param executor SQL 执行函数
   */
  constructor(tableName: string, executor: SQLClause<TableInfo, Result>["executor"]) {
    this.tableName = tableName;
    this.executor = executor;
  }

  /**
   * 创建更新语句
   * @param data 要更新的数据对象
   * @returns SQLClause 实例，可继续链式调用
   */
  public update(data: Partial<TableInfo>) {
    // 获取所有键名
    const keys = Object.keys(data);
    // 获取所有值
    const values = keys.map(key => data[key]);
    // 构建赋值表达式
    const assignments = keys.map(key => `${key} = ?`).join(", ");

    return new SQLClause<TableInfo, Result>(`UPDATE ${this.tableName} SET ${assignments}`, values, this.executor);
  }

  /**
   * 创建查询语句 - 指定字段查询
   * @template T 字段名类型
   * @param fields 要查询的字段名列表
   */
  public select<T extends keyof TableInfo>(
    ...fields: T[]
  ): SQLResultMapClause<TableInfo, Array<Required<Pick<TableInfo, T>>>>;

  /**
   * 创建查询语句 - 查询所有字段
   * @param field "*" 表示查询所有字段
   */
  public select(field: "*"): SQLResultMapClause<TableInfo, Array<Required<TableInfo>>>;

  /**
   * 创建查询语句 - 使用字符串指定字段
   * @param fields 要查询的字段名列表
   */
  public select(...fields: string[]): SQLResultMapClause<TableInfo, Array<TableInfo & Record<string, any>>>;

  /**
   * 创建查询语句 - 实现
   * @param fields 要查询的字段列表
   */
  public select(...fields: any[]) {
    return new SQLResultMapClause<TableInfo, any>(
      `SELECT ${fields.join(",")} FROM ${this.tableName}`,
      [],
      this.executor
    );
  }

  /**
   * 创建删除语句
   * @returns SQLClause 实例，可继续链式调用
   */
  public delete() {
    return new SQLClause<TableInfo, Result>(`DELETE FROM ${this.tableName}`, [], this.executor);
  }

  /**
   * 创建插入语句
   * @param data 要插入的数据对象
   * @param ignore 是否使用 INSERT IGNORE 语法，默认为 true
   * @returns SQLClause 实例，可继续链式调用
   */
  public insert(data: TableInfo, ignore = true) {
    const keys = Object.keys(data);
    const values = keys.map(key => data[key]);
    const placeholders = Array(keys.length).fill("?").join(", ");

    return new SQLClause<TableInfo, Result>(
      `INSERT${ignore ? " IGNORE" : ""} INTO ${this.tableName} (${keys.join(",")}) VALUES (${placeholders})`,
      values,
      this.executor
    );
  }

  /**
   * 创建插入或更新语句（MySQL 的 ON DUPLICATE KEY UPDATE 语法）
   * @param data 要插入或更新的数据对象
   * @returns SQLClause 实例，可继续链式调用
   */
  public insertUpdate(data: TableInfo) {
    const keys = Object.keys(data);
    const values = keys.map(key => data[key]);
    const updateExpr = keys.map(key => `${key} = VALUES(${key})`).join(", ");

    return new SQLClause<TableInfo, Result>(
      `INSERT INTO ${this.tableName} (${keys.join(",")}) VALUES (${Array(keys.length)
        .fill("?")
        .join(",")}) ON DUPLICATE KEY UPDATE ${updateExpr}`,
      values,
      this.executor
    );
  }
}

/**
 * SQL 子句类
 * 提供 WHERE、ORDER BY、LIMIT 等子句的构建和执行功能
 * @template TableInfo 表结构类型
 * @template Output 查询结果类型
 */
export class SQLClause<TableInfo extends Record<string, any>, Output> {
  /**
   * 基础 SQL 语句
   */
  protected baseSQL = "";

  /**
   * SQL 参数数组
   */
  protected params: any[] = [];

  /**
   * SQL 执行器函数
   */
  protected executor: (sql: string, params: any[]) => Promise<any>;

  /**
   * WHERE 子句信息
   */
  protected whereClause: { sql: string[]; params: any[] } = { sql: [], params: [] };

  /**
   * ORDER BY 子句信息
   */
  protected orderByClause: string[] = [];

  /**
   * LIMIT 子句信息
   */
  protected limitClause?: { sql: string; params?: any[] };

  /**
   * 构造函数
   * @param baseSQL 基础SQL语句
   * @param params SQL参数数组
   * @param executor SQL执行器函数
   */
  constructor(baseSQL: string, params: any[], executor: SQLClause<TableInfo, Output>["executor"]) {
    this.baseSQL = baseSQL;
    this.params = params;
    this.executor = executor;
  }

  /**
   * 添加WHERE条件 - 使用表字段名和操作符
   * @param field 字段名
   * @param op 操作符（如 =, >, <, LIKE 等）
   * @param params 参数值数组
   */
  public where<T extends keyof TableInfo>(field: T, op: string, params?: any[]): this;

  /**
   * 添加WHERE条件 - 使用自定义条件字符串
   * @param condition 条件字符串
   * @param params 参数值数组
   */
  public where(condition: string, params?: any[]): this;

  /**
   * 添加WHERE条件 - 使用对象指定多个等值条件
   * @param data 包含字段和值的对象
   */
  public where(data: Partial<TableInfo>): this;

  /**
   * 添加WHERE条件 - 实现
   */
  public where(...args: any[]): this {
    if (typeof args[0] === "object") {
      // 对象形式：{field1: value1, field2: value2}
      for (const key of Object.keys(args[0])) {
        this.whereClause.sql.push(`${key} = ?`);
        this.whereClause.params.push(args[0][key]);
      }
      return this;
    }

    // 条件字符串形式："field > ?"，[value]
    if (Array.isArray(args[args.length - 1])) this.whereClause.params.push(...args.pop());
    this.whereClause.sql.push(args.join(" "));
    return this;
  }

  /**
   * 添加LIMIT子句
   * @param sql LIMIT语句或数字
   * @param params LIMIT参数数组
   * @returns this 实例，可继续链式调用
   */
  public limit(sql: string | number, params?: any[]): this {
    this.limitClause = { sql: String(sql), params };
    return this;
  }

  /**
   * 执行SQL语句并返回结果
   * @param extParams 额外的参数数组
   * @param cacheMap 缓存Map，用于存储查询结果
   * @returns 查询结果的Promise
   */
  public async execute(extParams?: any[], cacheMap?: Map<string, any>): Promise<Output> {
    // 合并所有参数
    const allParams = [...this.params, ...(extParams || [])];
    // 生成最终SQL语句
    const sql = this.toString(allParams);

    // 如果提供了缓存Map，尝试使用缓存
    if (cacheMap) {
      const cacheKey = allParams.join(",") + "|" + sql;
      // 如果缓存中存在，返回缓存结果的深拷贝
      if (cacheMap.has(cacheKey)) return cacheMap.get(cacheKey).map(item => ({ ...item }));

      // 执行查询
      const res = await this.executor(sql, allParams);
      // 将结果存入缓存
      cacheMap.set(
        cacheKey,
        res.map(item => ({ ...item }))
      );
      return res;
    }

    // 无缓存时直接执行查询
    return this.executor(sql, allParams);
  }

  /**
   * 支持Promise接口，使SQLClause实例可以像Promise一样使用
   * @param onfulfilled 成功回调
   * @param onrejected 失败回调
   * @returns Promise实例
   */
  public then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: Output) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: Error) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  /**
   * 生成完整SQL字符串
   * @param params 参数数组，默认使用实例的params
   * @returns 完整SQL字符串
   */
  public toString(params: any[] = [...this.params]): string {
    let sql = this.baseSQL;
    if (this.whereClause.sql.length) {
      sql += " WHERE " + this.whereClause.sql.join(" AND ");
      params.push(...this.whereClause.params);
    }
    if (this.orderByClause.length) sql += " ORDER BY " + this.orderByClause.join(", ");
    if (this.limitClause) {
      sql += " LIMIT " + this.limitClause.sql;
      if (this.limitClause.params) params.push(...this.limitClause.params);
    }
    return sql;
  }

  /**
   * 实现Symbol.toPrimitive接口，使实例可以被转换为字符串
   * @returns SQL字符串
   */
  [Symbol.toPrimitive](): string {
    return this.toString();
  }

  /**
   * 获取SQL字符串的getter
   * @returns 完整SQL字符串
   */
  public get sql(): string {
    return this.toString();
  }
}

/**
 * SQL结果映射子句类
 * 继承自SQLClause，提供关联查询功能
 * @template TableInfo 表结构类型
 * @template Output 查询结果类型数组
 */
export class SQLResultMapClause<
  TableInfo extends Record<string, any>,
  Output extends Record<string, any>[]
> extends SQLClause<TableInfo, Output> {
  /**
   * 关联子句信息数组
   */
  protected relateClause: { resObjKey: string; resultMap: SQLResultMapClause<any, any>; foreignKeys: any[] }[] = [];

  /**
   * 添加升序排序
   * @param fields 排序字段列表
   * @returns this 实例，可继续链式调用
   */
  public orderByAsc<T extends keyof TableInfo>(...fields: T[]): this;
  public orderByAsc(...fields: string[]) {
    this.orderByClause.push(fields.join(", ") + " ASC");
    return this;
  }

  /**
   * 添加降序排序
   * @param fields 排序字段列表
   * @returns this 实例，可继续链式调用
   */
  public orderByDesc<T extends keyof TableInfo>(...fields: T[]): this;
  public orderByDesc(...fields: string[]): this {
    this.orderByClause.push(fields.join(", ") + " DESC");
    return this;
  }

  public relate<
    Foreign extends Record<string, any>,
    ForeignOutput extends Record<string, any>,
    Key extends keyof TableInfo
  >(
    resultMap: SQLResultMapClause<Foreign, Array<ForeignOutput>>,
    foreignKey: Key
  ): SQLResultMapClause<
    Omit<TableInfo, Key> & { [K in Key]: ForeignOutput | undefined },
    Array<Omit<Output[0], Key> & { [K in Key]: ForeignOutput | undefined }>
  >;
  public relate<
    Foreign extends Record<string, any>,
    ForeignOutput extends Record<string, any>,
    Key extends keyof TableInfo,
    ResObjKey extends string
  >(
    resObjKey: ResObjKey,
    resultMap: SQLResultMapClause<Foreign, Array<ForeignOutput>>,
    ...foreignKeys: Key[]
  ): SQLResultMapClause<
    Omit<TableInfo, ResObjKey> & { [K in ResObjKey]: ForeignOutput | undefined },
    Array<Omit<Output[0], ResObjKey> & { [K in ResObjKey]: ForeignOutput | undefined }>
  >;

  /**
   * 添加关联查询
   * 支持两种调用方式：
   * 1. relate(resultMap, foreignKey) - 使用外键名作为结果对象键名
   * 2. relate(resObjKey, resultMap, ...foreignKeys) - 自定义结果对象键名和多个外键
   * @param args 参数列表
   * @returns this 实例，可继续链式调用
   */
  public relate(...args: any[]) {
    if (typeof args[0] === "string") {
      // 方式2：自定义结果对象键名
      const [resObjKey, resultMap, ...foreignKeys] = args;
      this.relateClause.push({ resObjKey, resultMap, foreignKeys });
      return this;
    }
    // 方式1：使用外键名作为结果对象键名
    this.relateClause.push({
      resObjKey: args[1],
      resultMap: args[0],
      foreignKeys: [args[1]],
    });
    return this;
  }

  /**
   * 执行SQL语句并处理关联查询
   * @param extParams 额外的参数数组
   * @param cacheMap 缓存Map，用于存储查询结果
   * @returns 包含关联数据的查询结果Promise
   */
  public async execute(extParams?: any[], cacheMap?: Map<string, any>): Promise<Output> {
    // 执行主查询
    const res = await super.execute(extParams, cacheMap);

    // 处理关联查询
    if (this.relateClause.length) {
      // 确保有缓存Map以提高性能
      cacheMap = cacheMap || new Map();

      // 遍历每一行结果
      for (const row of res) {
        // 处理每个关联子句
        for (const { resObjKey, resultMap, foreignKeys } of this.relateClause) {
          // 执行关联查询并将结果赋值给对应的属性
          row[resObjKey] = (
            await resultMap.limit(1).execute(
              foreignKeys.map(key => row[key]),
              cacheMap
            )
          )?.[0];
        }
      }
    }
    return res;
  }
}
/** 以下是测试用例 */
// import { Mysql } from "./Mysql";

// const mysql = new Mysql({
//   host: "localhost",
//   user: "root",
//   port: 3306,
//   password: "usbw",
//   database: "info",
// });
// namespace DB_Info {
//   export type classes = {
//     classId: number;
//     name?: string;
//     chineseTeacher?: number;
//     mathTeacher?: number;
//     englishTeacher?: number;
//   };
//   export type student = {
//     studentId: number;
//     classId: number;
//     /** 学生姓名 */
//     name?: string;
//     age?: number;
//     createTime?: Date;
//   };
//   export type teacher = {
//     teacherId: number;
//     subject: string;
//     name?: string;
//   };
// }

// (async () => {
//   const classes = new SQL<DB_Info.classes>("classes", mysql.query.bind(mysql));
//   const student = new SQL<DB_Info.student>("student", mysql.query.bind(mysql));
//   const teacher = new SQL<DB_Info.teacher>("teacher", mysql.query.bind(mysql));
//   const classId = 99;
//   /** 测试用例 */
//   console.log(await classes.insert({ classId, name: "test", chineseTeacher: 0 }));
//   console.log(await classes.insertUpdate({ classId, name: "test2", chineseTeacher: 1 }));

//   console.log(
//     await classes
//       .select("name", "chineseTeacher", "englishTeacher")
//       .where("classId", ">?", [5])
//       .limit("?", [10])
//       .orderByAsc("chineseTeacher", "classId")
//       .orderByDesc("name")
//   );

//   console.log(await classes.update({ name: "test3" }).where({ classId }).limit(1));

//   console.log(await classes.select("*").orderByDesc("classId").limit(3));

//   console.log(await classes.delete().where({ classId }));

//   console.log((await classes.select("count(*) as count")).map(({ count }) => count));

//   console.log(
//     await student
//       .select("name", "classId")
//       .relate(
//         "classInfo",
//         classes
//           .select("name", "chineseTeacher")
//           .where("classId=?")
//           .relate(teacher.select("name").where("teacherId=?"), "chineseTeacher"),
//         "classId"
//       )
//       .orderByAsc("classId")
//       .limit(50)
//   );
// })();
