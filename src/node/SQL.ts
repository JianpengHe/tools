import { IMysqlResult } from "./Mysql";

/** 泛型 SQL 构建器入口类 */
export class SQL<TableInfo extends Record<string, any>, Result = IMysqlResult> {
  private tableName: string;
  private executor: (sql: string, params: any[]) => Promise<any>;

  constructor(tableName: string, executor: SQLClause<TableInfo, Result>["executor"]) {
    this.tableName = tableName;
    this.executor = executor;
  }

  public update(data: Partial<TableInfo>) {
    const keys = Object.keys(data); //.sort();
    const values = keys.map(key => data[key]);
    const assignments = keys.map(key => `${key} = ?`).join(", ");

    return new SQLClause<TableInfo, Result>(`UPDATE ${this.tableName} SET ${assignments}`, values, this.executor);
  }

  public select<T extends keyof TableInfo>(
    ...fields: T[]
  ): SQLResultMapClause<TableInfo, Array<Required<Pick<TableInfo, T>>>>;
  public select(field: "*"): SQLResultMapClause<TableInfo, Array<Required<TableInfo>>>;
  public select(...fields: string[]): SQLResultMapClause<TableInfo, Array<TableInfo & Record<string, any>>>;
  public select(...fields: any[]) {
    return new SQLResultMapClause<TableInfo, any>(
      `SELECT ${fields.join(",")} FROM ${this.tableName}`,
      [],
      this.executor
    );
  }

  public delete() {
    return new SQLClause<TableInfo, Result>(`DELETE FROM ${this.tableName}`, [], this.executor);
  }

  public insert(data: TableInfo, ignore = true) {
    const keys = Object.keys(data); //.sort();
    const values = keys.map(key => data[key]);
    const placeholders = Array(keys.length).fill("?").join(", ");

    return new SQLClause<TableInfo, Result>(
      `INSERT${ignore ? " IGNORE" : ""} INTO ${this.tableName} (${keys.join(",")}) VALUES (${placeholders})`,
      values,
      this.executor
    );
  }

  public insertUpdate(data: TableInfo) {
    const keys = Object.keys(data); //.sort();
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

/** SQL 子句类 */
export class SQLClause<TableInfo extends Record<string, any>, Output> {
  protected baseSQL = "";
  protected params: any[] = [];
  protected executor: (sql: string, params: any[]) => Promise<any>;
  protected whereClause: { sql: string[]; parms: any[] } = { sql: [], parms: [] };
  protected orderByClause: string[] = [];
  protected limitClause?: { sql: string; params?: any[] };

  constructor(baseSQL: string, params: any[], executor: SQLClause<TableInfo, Output>["executor"]) {
    this.baseSQL = baseSQL;
    this.params = params;
    this.executor = executor;
  }

  public where<T extends keyof TableInfo>(field: T, op: string, params?: any[]): this;
  public where(condition: string, params?: any[]): this;
  public where(data: Partial<TableInfo>): this;
  public where(...args: any[]): this {
    if (typeof args[0] === "object") {
      for (const key of Object.keys(args[0])) {
        this.whereClause.sql.push(`${key} = ?`);
        this.whereClause.parms.push(args[0][key]);
      }
      return this;
    }

    if (Array.isArray(args[args.length - 1])) this.whereClause.parms.push(...args.pop());
    this.whereClause.sql.push(args.join(" "));
    return this;
  }
  public limit(sql: string | number, params?: any[]): this {
    this.limitClause = { sql: String(sql), params };
    return this;
  }

  public async execute(extParams?: any[], cacheMap?: Map<string, any>): Promise<Output> {
    const allParams = [...this.params, ...(extParams || [])];
    const sql = this.toString(allParams);
    if (cacheMap) {
      const cacheKey = allParams.join(",") + "|" + sql;
      if (cacheMap.has(cacheKey)) return cacheMap.get(cacheKey).map(item => ({ ...item })); //  structuredClone(res)
      const res = await this.executor(sql, allParams);
      cacheMap.set(
        cacheKey,
        res.map(item => ({ ...item }))
      );
      return res;
    }
    return this.executor(sql, allParams);
  }

  public then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: Output) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: Error) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  public toString(params: any[] = [...this.params]): string {
    let sql = this.baseSQL;
    if (this.whereClause.sql.length) {
      sql += " WHERE " + this.whereClause.sql.join(" AND ");
      params.push(...this.whereClause.parms);
    }
    if (this.orderByClause.length) sql += " ORDER BY " + this.orderByClause.join(", ");
    if (this.limitClause) {
      sql += " LIMIT " + this.limitClause.sql;
      if (this.limitClause.params) params.push(...this.limitClause.params);
    }
    return sql;
  }

  [Symbol.toPrimitive](): string {
    return this.toString();
  }

  public get sql(): string {
    return this.toString();
  }
}

export class SQLResultMapClause<
  TableInfo extends Record<string, any>,
  Output extends Record<string, any>[]
> extends SQLClause<TableInfo, Output> {
  protected relateClause: { resObjKey: string; resultMap: SQLResultMapClause<any, any>; foreignKeys: any[] }[] = [];

  public orderByAsc<T extends keyof TableInfo>(...fields: T[]): this;
  public orderByAsc(...fields: string[]) {
    this.orderByClause.push(fields.join(", ") + " ASC");
    return this;
  }

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

  public relate(...args: any[]) {
    if (typeof args[0] === "string") {
      const [resObjKey, resultMap, ...foreignKeys] = args;
      this.relateClause.push({ resObjKey, resultMap, foreignKeys });
      return this;
    }
    this.relateClause.push({
      resObjKey: args[1],
      resultMap: args[0],
      foreignKeys: [args[1]],
    });
    return this;
  }

  public async execute(extParams?: any[], cacheMap?: Map<string, any>): Promise<Output> {
    const res = await super.execute(extParams, cacheMap);
    if (this.relateClause.length) {
      cacheMap = cacheMap || new Map();
      for (const row of res) {
        for (const { resObjKey, resultMap, foreignKeys } of this.relateClause) {
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
// /** 打算通过2次查询，输出以下结构 */
// type a = {
//   studentId: number;
//   classId: number;
//   /** 学生姓名 */
//   name?: string;
//   age?: number;
//   createTime?: Date;
//   classes: {
//     classId: number;
//     name?: string;
//     chineseTeacher?: number;
//     mathTeacher?: number;
//     englishTeacher?: number;
//   };
// };
