import { Buf } from "./node/Buf";
import { Mysql } from "./node/mysql";

(async () => {
  const mysql = new Mysql({ host: "127.0.0.1", port: 3306, user: "all", password: "root", database: "information_schema" });
  await mysql.handshake;

  // const ignoreDB = ["information_schema", "mysql", "performance_schema"];
  // const pid = await mysql.prepare(`SELECT TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,IS_NULLABLE,DATA_TYPE,COLUMN_COMMENT FROM information_schema.COLUMNS WHERE table_schema not in(${ignoreDB.map(a => "?").join(",")});`);
  const [result1, result2] = await Promise.all([
    new Promise(r => mysql.prepare(`SELECT * FROM INFO.student  LIMIT ?`).then(pid => mysql.execute(pid, [20]).then(r))),
    new Promise(r => mysql.prepare("UPDATE info.`student` SET `createTime` = ? WHERE `student`.`studentId` = ?").then(pid => mysql.execute(pid, ["2022-02-14 15:33:39", 172017001]).then(r))),
  ]);
  console.log("result1:", result1);
  console.log("result2:", result2);
})();
