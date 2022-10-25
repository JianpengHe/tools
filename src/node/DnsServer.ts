import * as dns from "dns";
import * as os from "os";
import * as dgram from "dgram";
import * as child_process from "child_process";
process.on("uncaughtException", e => {
  console.error("DNS Server\t", e);
  process.exit(1000);
});
process.on("SIGINT", () => process.exit(1001));
process.on("SIGTERM", () => process.exit(1002));
export class DnsServer {
  public dnsServerIp = (dns.getServers() || [])[0];
  public udpServer = dgram.createSocket("udp4");
  public hostsMap: Map<string, string>;
  private udpServerHost: string;
  private parseHost(msg: Buffer) {
    let num = 0;
    let offset = 0;
    const host: string[] = [];
    while ((num = msg[offset++])) {
      host.push(String(msg.subarray(offset, (offset += num))));
    }
    return host.join(".");
  }
  private async onMessage(msg: Buffer, rinfo: dgram.RemoteInfo) {
    const host = this.parseHost(msg.subarray(12));

    const ip = this.hostsMap.get(host);
    if (ip) {
      console.log("DNS Server\t", "自定义\t", host);
      this.resolve(ip, msg, rinfo);
      return;
    }
    console.log("DNS Server\t", "转发\t", host);
    this.forward(msg, rinfo);
  }
  private resolve(ip: string, msg: Buffer, rinfo: dgram.RemoteInfo) {
    //响应
    msg[2] = 129;
    msg[3] = 128;
    msg[7] = 1;
    const buffer = Buffer.concat([
      msg,
      Buffer.from([192, 12, 0, 1, 0, 1, 0, 0, 0, 218, 0, 4].concat(ip.split(".").map(i => Number(i)))),
    ]);
    this.udpServer.send(buffer, rinfo.port, rinfo.address, err => {
      if (err) {
        console.log("DNS Server\t", err);
        this.udpServer.close();
      }
    });
  }
  private forward(msg: Buffer, rinfo: dgram.RemoteInfo) {
    const client = dgram.createSocket("udp4");
    client.on("error", err => {
      console.log("DNS Server\t", `client error:` + err.stack);
      client.close();
    });
    client.on("message", fMsg => {
      this.udpServer.send(fMsg, rinfo.port, rinfo.address, err => {
        err && console.log("DNS Server\t", err);
      });
      client.close();
    });
    client.send(msg, 53, this.dnsServerIp, err => {
      if (err) {
        console.log("DNS Server\t", err);
        client.close();
      }
    });
  }
  private killBindPort = (port: number) =>
    new Promise(r => {
      if (os.platform() === "win32") {
        child_process.exec(`netstat -aon|findstr "${this.udpServerHost}:${port}"`, (err, stdout) => {
          if (!err && String(stdout)) {
            const pidInfo = String(stdout).trim().split("\n");
            if (pidInfo.length) {
              pidInfo.forEach(line => {
                const pid = (line.match(
                  new RegExp(`^UDP\\s+${this.udpServerHost.replace(/\./g, "\\.")}\\:53\\s+[^\\d]*(\\d+)$`)
                ) || [])[1];
                if (pid) {
                  console.log("DNS Server\t", "杀死进程", "占用端口的进程pid:", pid);
                  process.kill(Number(pid));
                }
              });
            }
          }
          setTimeout(() => r(0), 1000);
        });
        this.udpServer.once("listening", () => {
          const addr = this.udpServer.address();
          console.log("DNS Server\t", "启动成功", `${addr.address}:${addr.port}`);
          const names = Object.entries(os.networkInterfaces())
            .map(([name, infos]) => {
              if (infos?.find(({ internal, family }) => !internal && family === "IPv4")) {
                return name;
              }
              return false;
            })
            .filter(a => a);
          names.forEach(name =>
            child_process.exec(
              `netsh interface ipv4 set dns name="${name}" source=static addr=${this.udpServerHost} register=PRIMARY & ipconfig/flushdns`,
              () => {
                console.log("DNS Server\t", "自动配置", name);
              }
            )
          );
          process.on("exit", function (code) {
            child_process.execSync(
              names.map(name => `netsh interface ipv4 set dns name="${name}" source = dhcp`).join(" & ") +
                "& ipconfig/flushdns & netsh winsock reset"
            );
          });
        });
        return;
      }
      r(0);
    });

  constructor(port: number = 53, host: string = "127.0.0.2") {
    if (this.dnsServerIp === host) {
      this.dnsServerIp = "119.29.29.29";
    }
    console.log("DNS Server\t", "远程地址", this.dnsServerIp);
    this.hostsMap = new Map();
    this.udpServerHost = host;
    this.killBindPort(port).then(() => {
      this.udpServer.bind(port, host);
      this.udpServer.on("message", this.onMessage.bind(this));
    });
  }

  public add(ip: string, host: string) {
    this.hostsMap.set(host, ip);
    return this.hostsMap;
  }
}

// new DnsServer().add("127.0.0.1", "tt.cn");
