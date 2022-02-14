import { Buf } from "./node/Buf";
import { Mysql } from "./node/mysql";

(async () => {
  const mysql = new Mysql({ host: "127.0.0.1", port: 3306, user: "all", password: "root", database: "information_schema" });
  await mysql.handshake;

  // const ignoreDB = ["information_schema", "mysql", "performance_schema"];
  // const pid = await mysql.prepare(`SELECT TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,IS_NULLABLE,DATA_TYPE,COLUMN_COMMENT FROM information_schema.COLUMNS WHERE table_schema not in(${ignoreDB.map(a => "?").join(",")});`);

  const pid = await mysql.prepare(`SELECT * FROM INFO.student  LIMIT ?`);
  console.log("result:", await mysql.execute(pid, [20]));

  // const pid = await mysql.prepare("UPDATE info.`student` SET `createTime` = '2022-02-14 15:33:35' WHERE `student`.`studentId` = ?;");
  // console.log("result:", await mysql.execute(pid, [172017001]));
})();
