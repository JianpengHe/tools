import * as child_process from "child_process";
import * as os from "os";
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
