import { EMysqlFieldType, IMysqlValue, Mysql } from "../node/Mysql";
const conversion: Record<number, "string" | "number" | "Date" | "Buffer"> = {
  // 字符串类型
  [EMysqlFieldType.string]: "string",
  [EMysqlFieldType.var_string]: "string",
  [EMysqlFieldType.varchar]: "string",
  [EMysqlFieldType.enum]: "string",
  [EMysqlFieldType.json]: "string",

  // 数字类型
  [EMysqlFieldType.tiny]: "number",
  [EMysqlFieldType.short]: "number",
  [EMysqlFieldType.year]: "number",
  [EMysqlFieldType.int24]: "number",
  [EMysqlFieldType.long]: "number",
  [EMysqlFieldType.longlong]: "number",
  [EMysqlFieldType.float]: "number",
  [EMysqlFieldType.double]: "number",
  [EMysqlFieldType.time]: "number",

  // 日期时间类型
  [EMysqlFieldType.date]: "Date",
  [EMysqlFieldType.datetime]: "Date",
  [EMysqlFieldType.timestamp]: "Date",

  // Buffer 类型
  [EMysqlFieldType.bit]: "Buffer",
  [EMysqlFieldType.set]: "Buffer",
  [EMysqlFieldType.decimal]: "Buffer",
  [EMysqlFieldType.newdecimal]: "Buffer",
  [EMysqlFieldType.tiny_blob]: "Buffer",
  [EMysqlFieldType.medium_blob]: "Buffer",
  [EMysqlFieldType.blob]: "Buffer",
  [EMysqlFieldType.long_blob]: "Buffer",
  [EMysqlFieldType.geometry]: "Buffer",
};

export const generateMysqlType = async (mysql: Mysql, dbName = mysql.dbName || mysql.connectInfo.database) => {
  const namespaceName = `DB_${dbName.replace(/^[a-z]/, a => a.toUpperCase())}`;
  let o = `export const database = '${dbName}'\n`;
  o += `export const mysql = new Mysql({ ...con, database })\n\n`;
  o += `export namespace ${namespaceName} = {\n`;
  const res = (await mysql.query("select * from information_schema.columns where TABLE_SCHEMA = ?", [
    dbName,
  ])) as Record<string, IMysqlValue>[];
  const tables = new Set<string>(res.map(({ TABLE_NAME }) => String(TABLE_NAME)));
  const columns = new Map<string, any>(res.map(v => [v.TABLE_NAME + "." + v.COLUMN_NAME, v]));

  for (const tableName of tables) {
    await new Promise<void>(r =>
      mysql.queryRaw({
        sql: `select * from ${tableName} where 1=0`,
        params: [],
        callback(_, { headerInfo }: any) {
          o += `  export type ${tableName} = {\n`;
          for (const { type, nameOrg } of headerInfo) {
            const { EXTRA, IS_NULLABLE, COLUMN_COMMENT } = columns.get(tableName + "." + nameOrg);
            if (COLUMN_COMMENT) o += `    /** ${COLUMN_COMMENT} */\n`;
            let tsType = conversion[type];
            tsType = tsType === "Date" && mysql.connectInfo.convertToTimestamp ? "number" : tsType;
            if (IS_NULLABLE === "YES") tsType += " | null";
            o += `    ${nameOrg}${IS_NULLABLE === "YES" || EXTRA === "auto_increment" ? "?" : ""}: ${tsType};\n`;
          }
          o += `  };\n`;
          r();
        },
      }),
    );
  }
  o += `};\n\n`;

  for (const tableName of tables) {
    o += `export const ${tableName} = new SQL<${namespaceName}.${tableName}>('${tableName}', mysql.query.bind(mysql))\n`;
  }
  return o;
};

/** 测试用例 */
// const mysql = new Mysql({
//   host: "localhost",
//   user: "root",
//   port: 3306,
//   password: "usbw",
//   database: "info",
// });

// generateMysqlType(mysql).then(console.log);
