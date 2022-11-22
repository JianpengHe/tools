import * as child_process from "child_process";
import * as os from "os";
import * as net from "net";
import * as tls from "tls";
import * as crypto from "crypto";
import { afterExit } from "./afterExit";
import { Buf } from "./Buf";

export type IProxyWinOpt = {
  times?: number;
  status?:
    | "全部开启"
    | "全部禁用"
    | "使用代理服务器"
    | "使用自动脚本"
    | "使用脚本和代理"
    | "打开自动检测设置"
    | "打开自动检测并使用代理"
    | "打开自动检测并使用脚本";
  proxyIp?: string;
  noProxyIps?: string;
  pac?: string;
};

/** 查看/设置HTTP代理 */
export const setProxyWin = async (newOpt?: IProxyWinOpt) => {
  if (os.platform() !== "win32") {
    throw new Error("Microsoft Windows Only!");
  }
  const status = {
    0x0f: "全部开启",
    0x01: "全部禁用",
    0x03: "使用代理服务器",
    0x05: "使用自动脚本",
    0x07: "使用脚本和代理",
    0x09: "打开自动检测设置",
    0x0b: "打开自动检测并使用代理",
    0x0d: "打开自动检测并使用脚本",
  };
  const regPath = `"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections" /v DefaultConnectionSettings`;
  if (!newOpt) {
    const output: Required<IProxyWinOpt> = await new Promise((resolve, reject) => {
      child_process.exec(`REG QUERY ${regPath}`, (err, data) => {
        if (!err && data) {
          const buf = new Buf(
            Buffer.from(
              (String(data)
                .trim()
                .match(/REG_BINARY\s+([\dA-F]+)$/) || [])[1],
              "hex"
            )
          );
          if (buf.readUIntLE(4) !== 0x46) {
            reject(new Error("解析失败"));
            return;
          }
          resolve({
            times: buf.readUIntLE(4),
            status: status[buf.readUIntLE(4)],
            proxyIp: buf.readString(buf.readUIntLE(4)),
            noProxyIps: buf.readString(buf.readUIntLE(4)),
            pac: buf.readString(buf.readUIntLE(4)),
          });
        } else {
          reject(err || new Error("no data"));
        }
      });
    });
    return output;
  }
  const buf = new Buf();
  buf.writeUIntLE(0x46, 4);
  buf.writeUIntLE(newOpt.times ?? 0, 4);
  buf.writeUIntLE(Number((Object.entries(status).find(([_, value]) => value === newOpt?.status) || [])[0] || 1), 4);
  buf.writeStringPrefix(newOpt.proxyIp ?? "127.0.0.1:1080", len => {
    buf.writeUIntLE(len, 4);
    return undefined;
  });
  buf.writeStringPrefix(newOpt.noProxyIps ?? "127.0.0.1;<local>", len => {
    buf.writeUIntLE(len, 4);
    return undefined;
  });
  buf.writeStringPrefix(newOpt.pac ?? "", len => {
    buf.writeUIntLE(len, 4);
    return undefined;
  });
  buf.write(Buffer.alloc(32));
  await new Promise((resolve, reject) => {
    child_process.exec(`REG add ${regPath} /f /t REG_BINARY /d "${buf.buffer.toString("hex")}"`, (err, data) => {
      if (err || !data) {
        reject(err || new Error("no data"));
      } else {
        resolve(true);
      }
    });
  });
  const output: Required<IProxyWinOpt> = await setProxyWin();
  return output;
};

// (async () => {
//   console.log(
//     await setProxyWin({
//       proxyIp: "127.0.0.1:1080",
//       status: "使用自动脚本",
//       pac: "http://127.0.0.1:1080/pg_pac_script_config",
//     })
//   );
// })();

/** 设置DNS服务器 */
export const setDnsAddr = async (addr: string, autoReset = true) => {
  if (os.platform() !== "win32") {
    throw new Error("Microsoft Windows Only!");
  }
  const names = Object.entries(os.networkInterfaces())
    .map(([name, infos]) => {
      if (infos?.find(({ internal, family }) => !internal && family === "IPv4")) {
        return name;
      }
      return false;
    })
    .filter(a => a);
  if (autoReset) {
    afterExit(() => {
      child_process.execSync(
        names.map(name => `netsh interface ipv4 set dns name="${name}" source = dhcp`).join(" & ") +
          "& ipconfig/flushdns & netsh winsock reset"
      );
    });
  }

  await Promise.all(
    names.map(
      name =>
        new Promise((resolve, reject) =>
          child_process.exec(
            `netsh interface ipv4 set dns name="${name}" source=static addr=${addr} register=PRIMARY & ipconfig/flushdns`,
            err => {
              if (err) {
                reject(err);
                return;
              }
              // console.log("自动配置DNS", name);
              resolve(true);
            }
          )
        )
    )
  );
  return names;
};

// setDnsAddr("114.114.114.114")

/** 占用端口的应用pid */
export const getOccupiedNetworkPortPids = async (
  port: number,
  host: string = "0.0.0.0",
  protocol: "TCP" | "UDP" = "TCP"
): Promise<number[]> => {
  if (os.platform() !== "win32") {
    throw new Error("Microsoft Windows Only!");
  }
  return await new Promise((resolve, reject) =>
    child_process.exec(`netstat -aon -p ${protocol}|findstr "${host}:${port}"`, (err, stdout) => {
      const pidInfo = String(stdout || "")
        .trim()
        .split("\n");
      const pids: number[] = [];
      if (pidInfo.length) {
        pidInfo.forEach(line => {
          const pid = (line.match(
            new RegExp(`^${protocol}\\s+${host.replace(/\./g, "\\.")}\\:${port}\\s+[^\\d]*(\\d+)$`)
          ) || [])[1];
          if (pid) {
            pids.push(Number(pid));
          }
        });
      }
      resolve(pids);
    })
  );
};

// getOccupiedNetworkPortPids(80,"127.0.0.1","TCP")

/** 通过通信端口，获取应用名称 */
export const getProcessNameByPort = (remotePort: number = 0, localPort: number = 0) =>
  new Promise(resolve =>
    child_process.exec(`netstat -aonp TCP |findstr ":${remotePort}"`, (err, data) => {
      if (err) {
        resolve("");
        return;
      }
      const pid = (String(data).match(
        new RegExp(
          `TCP\\s+\\d+\\.\\d+\\.\\d+\\.\\d+\\:${remotePort}\\s+\\d+\\.\\d+\\.\\d+\\.\\d+\\:${localPort}\\s+\\S+\\s+(\\d+)`
        )
      ) || [])[1];
      if (!pid) {
        resolve("");
        return;
      }
      child_process.exec(`tasklist /FI "PID eq ${pid}" /NH`, (err, data) =>
        resolve(
          (
            (!err &&
              (String(data)
                .trim()
                .match(new RegExp(`^(.+?)\\s+${pid}`)) || [])[1]) ||
            ""
          ).trim()
        )
      );
    })
  );

/** 使用Trojan代理协议 */
export const createTrojanSocket: (
  /** 传入由Trojan的“订阅内容”或trojan开头的URL */
  trojanTarget: string,
  outsideHost: string,
  outsidePort: number
) => Promise<net.Socket> = (trojanTarget, outsideHost, outsidePort) =>
  new Promise((resolve, reject) => {
    const reg = /^trojan\:/;
    if (!reg.test(trojanTarget)) {
      trojanTarget = String(Buffer.from(trojanTarget, "base64"));
    }
    if (!reg.test(trojanTarget)) {
      reject(new Error("转换协议失败"));
      return;
    }
    const { hostname, port, searchParams, username } = new URL(trojanTarget.replace(reg, "http:"));
    const sock = tls.connect({
      host: hostname,
      port: Number(port),
      // rejectUnauthorized: false,
      servername: searchParams.get("sni") || undefined,
    });
    const buf = new Buf();
    buf.writeStringPrefix(crypto.createHash("sha224").update(username).digest("hex"), () => {
      return undefined;
    });
    buf.write(Buffer.from([0x0d, 0x0a, 1, 3]));
    buf.writeStringPrefix(outsideHost, len => {
      buf.writeUIntBE(len, 1);
      return undefined;
    });
    buf.writeUIntBE(outsidePort, 2);
    buf.write(Buffer.from([0x0d, 0x0a]));
    sock.write(buf.buffer);
    resolve(sock);
  });

//测试用例
// const trojanTarget = "dHxxxxxx==";
// // const host = "2022.ip138.com";
// const host = "www.google.com";
// const port = 443;
// const req = require("https")
//   .request(
//     {
//       path: "/",
//       method: "get",
//       port,
//       host,
//       createConnection(_, oncreate) {
//         createTrojanSocket(trojanTarget, host, port).then(trojanSock => {
//           const httpsock = new tls.TLSSocket(trojanSock);
//           setTimeout(() => {
//             oncreate(null, httpsock);
//           }, 1000);
//         });
//       },
//     },
//     async res => {
//       const body: any = [];
//       for await (const chuck of res) {
//         body.push(chuck);
//       }
//       console.log(String(Buffer.concat(body)));
//     }
//   )
//   .end();
