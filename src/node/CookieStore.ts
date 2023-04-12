export type ICookieStore = {
  key: string;
  value: string;
  Expires?: number;
  Domain: string;
  Path: string;
  Secure?: boolean;
  /** 暂时没用 */
  HttpOnly?: boolean;
  /** 暂时没用 */
  SameSite?: "strict" | "lax" | "none";
};
export const getCookieStoreKeyHash = (cookieStore: ICookieStore) =>
  JSON.stringify({ key: cookieStore.key, Domain: cookieStore.Domain, Path: cookieStore.Path });
export class CookieStore {
  public cookieMap: Map<string, ICookieStore> = new Map();

  /** initCookie: 浏览器发送的cookie请求头，例如:a=1; t=6 */
  constructor(initUrl?: URL, initCookie?: string) {
    if (initUrl && initCookie) {
      initCookie
        .split(";")
        .map(a => a.trim())
        .filter(Boolean)
        .forEach(setCookie => this.set(initUrl, setCookie));
    }
  }
  public set(url: URL, setCookie: string) {
    const { host, pathname, protocol } = url;
    const configs = [...new URLSearchParams(setCookie.replace(/;/g, "&")).entries()];
    const [key, value] = configs.splice(0, 1)[0] || [];
    if (!key) {
      throw new Error("not key:" + setCookie);
    }
    const cookie: ICookieStore = {
      key,
      value,
      Domain: host,
      Path: pathname,
    };
    const configObj = configs.reduce(
      (obj, [config, configValue]) => ({ ...obj, [config.toLowerCase().trim()]: configValue.trim() }),
      {}
    ) as { [x: string]: string };
    /** 同时存在expires和max-age时，优先max-age */
    if (configObj.expires) {
      cookie.Expires = new Date(configObj.expires).getTime();
    }
    if (configObj["max-age"]) {
      cookie.Expires = new Date().getTime() + Number(configObj["max-age"] || 0) * 1000;
    }

    if (configObj.domain) {
      cookie.Domain = configObj.domain;
    }
    if (configObj.path) {
      cookie.Path = configObj.path;
    }

    cookie.Secure = "secure" in configObj;
    cookie.HttpOnly = "httponly" in configObj;
    if (configObj.samesite) {
      cookie.SameSite = configObj.samesite.toLowerCase() as any;
    }
    /** 非https，但拥有secure的要忽略【暂不实现】 */
    //if((cookie.Secure&&protocol!=="https:")||())
    this.cookieMap.set(getCookieStoreKeyHash(cookie), cookie);
    return this;
  }

  public getRaw(url: URL) {
    const { pathname, host, protocol } = url;
    return [...this.cookieMap.values()].filter(cookie => {
      const { Expires, Domain, Path, Secure } = cookie;
      if (Expires && Expires < new Date().getTime()) {
        /** 清理掉过期的cookie */
        this.cookieMap.delete(getCookieStoreKeyHash(cookie));
        return false;
      }

      if (Domain) {
        if (/^\./.test(Domain)) {
          if (host.length - host.lastIndexOf(Domain) !== Domain.length) {
            /** 不以Domain结尾 */
            // console.log("不以Domain结尾", host, Domain);
            return false;
          }
        } else if (Domain !== host) {
          // console.log("域名不一致", host, Domain);
          return false;
        }
      }

      /** 如果pathname不是Path开头的话 */
      if (pathname.indexOf(Path) !== 0) {
        // console.log("pathname不是Path开头", pathname, Path);
        return false;
      }

      if (Secure && protocol !== "https:") {
        // console.log("协议不是https", Secure, protocol);
        return false;
      }

      return true;
    });
  }

  public get(url: URL) {
    const uRLSearchParams = new URLSearchParams();
    for (const { key, value } of this.getRaw(url)) {
      uRLSearchParams.append(key, value);
    }
    return String(uRLSearchParams).replace(/&/g, "; ");
  }
}

// 测试用例
// 搭建服务器
// require("http")
//   .createServer((req, res) => {
//     switch (req.url) {
//       case "/cookie/set":
//         const now = new Date();
//         now.setFullYear(now.getFullYear() + 1);
//         res.writeHead(200, {
//           "set-cookie": [
//             `test=tt; expires=${now.toUTCString()}; Max-Age=604800; path=/; domain=.hejianpeng.com`,
//             `test1=tt1; expires=${now.toUTCString()}; path=/; domain=.hejianpeng.com`,
//             `test=tt2; expires=${now.toUTCString()}; domain=.hejianpeng.com`,
//             `test=tt3; expires=${now.toUTCString()}`,
//             `test=tt4; Secure`,
//           ],
//         });
//         break;
//       case "/cookie/get":
//         res.write(req.headers.cookie);
//         break;
//     }
//     res.end("");
//   })
//   .listen(80, () => {
//     const cookieStore = new CookieStore();
//     const url = new URL("http://t.hejianpeng.com/cookie/set");
//     require("http").get(url, { rejectUnauthorized: false }, res => {
//       res.headers["set-cookie"].forEach(str => cookieStore.set(url, str));
//       console.log(cookieStore.get(url));
//     });
//   });
